import { describe, expect, it } from "vitest";
import {
    authorizeRemoteAssetCleanupRequest,
    drainRemoteAssetCleanupWithGateway,
    isRemoteAssetCleanupScheduled,
    runRemoteAssetCleanupWithGateway,
} from "./remoteAssetCleanup.server";

describe("remote asset cleanup service", () => {
    it("fails closed unless the schedule flag, strong CRON_SECRET, and bearer token all match", () => {
        const secret = "s".repeat(48);
        expect(isRemoteAssetCleanupScheduled({ CRON_SECRET: secret, OMR_ASSET_GC_SCHEDULED: "1" })).toBe(true);
        expect(isRemoteAssetCleanupScheduled({ CRON_SECRET: secret })).toBe(false);
        expect(isRemoteAssetCleanupScheduled({ CRON_SECRET: "short", OMR_ASSET_GC_SCHEDULED: "1" })).toBe(false);
        expect(authorizeRemoteAssetCleanupRequest(new Headers({ authorization: `Bearer ${secret}` }), {
            CRON_SECRET: secret,
            OMR_ASSET_GC_SCHEDULED: "1",
        })).toBe(true);
        expect(authorizeRemoteAssetCleanupRequest(new Headers({ authorization: "Bearer wrong" }), {
            CRON_SECRET: secret,
            OMR_ASSET_GC_SCHEDULED: "1",
        })).toBe(false);
    });

    it("claims a bounded batch and acknowledges only objects Storage actually removed", async () => {
        const rpcCalls: Array<{ name: string; params: Record<string, unknown> }> = [];
        const removed: string[] = [];
        const jobs = [
            {
                id: "cleanup-1",
                attempts: 1,
                storage_bucket: "omr-private-assets",
                object_path: "organizations/org-1/exams/exam-1/problem/asset-1.pdf",
            },
            {
                id: "cleanup-2",
                attempts: 1,
                storage_bucket: "omr-private-assets",
                object_path: "organizations/org-1/exams/exam-1/answer-key/asset-2.pdf",
            },
        ];
        const client = {
            async rpc(name: string, params: Record<string, unknown>) {
                rpcCalls.push({ name, params });
                return { data: name === "omr_claim_remote_asset_cleanup_v1" ? jobs : true, error: null };
            },
            storage: {
                from: () => ({
                    async remove(paths: string[]) {
                        removed.push(...paths);
                        return paths[0].includes("asset-2")
                            ? { data: null, error: { message: "storage down" } }
                            : { data: {}, error: null };
                    },
                }),
            },
        };

        await expect(runRemoteAssetCleanupWithGateway(client as never, {
            workerId: "worker-1",
            batchSize: 10_000,
        })).resolves.toEqual({ claimed: 2, deleted: 1, failed: 1 });
        expect(rpcCalls[0]).toEqual({
            name: "omr_claim_remote_asset_cleanup_v1",
            params: { p_worker_id: "worker-1", p_limit: 25 },
        });
        expect(removed).toEqual(jobs.map(job => job.object_path));
        expect(rpcCalls.map(call => call.name)).toEqual([
            "omr_claim_remote_asset_cleanup_v1",
            "omr_authorize_remote_asset_cleanup_delete_v1",
            "omr_authorize_remote_asset_cleanup_delete_v1",
            "omr_ack_remote_asset_cleanup_v1",
            "omr_fail_remote_asset_cleanup_v1",
        ]);
        const failedCall = rpcCalls.find(call => call.name === "omr_fail_remote_asset_cleanup_v1");
        expect(failedCall?.params).not.toHaveProperty("p_error_message");
        expect(failedCall?.params).toHaveProperty("p_error", "storage_delete_failed");
    });

    it("revalidates a leased deterministic path before Storage removal", async () => {
        const calls: Array<{ name: string; params?: Record<string, unknown> }> = [];
        let removed = false;
        const client = {
            async rpc(name: string, params?: Record<string, unknown>) {
                calls.push({ name, params });
                if (name === "omr_claim_remote_asset_cleanup_v1") {
                    return {
                        data: [{
                            id: "cleanup-handwriting",
                            attempts: 3,
                            storage_bucket: "omr-private-assets",
                            object_path: "organizations/org-1/attempts/attempt-1/handwriting/asset_handwriting_same.json",
                        }],
                        error: null,
                    };
                }
                if (name === "omr_authorize_remote_asset_cleanup_delete_v1") {
                    return { data: false, error: null };
                }
                return { data: true, error: null };
            },
            storage: { from: () => ({
                async remove() {
                    removed = true;
                    return { data: {}, error: null };
                },
            }) },
        };

        await expect(runRemoteAssetCleanupWithGateway(client as never, {
            workerId: "worker-1",
        })).resolves.toEqual({ claimed: 1, deleted: 0, failed: 1 });
        expect(removed).toBe(false);
        expect(calls).toEqual([
            {
                name: "omr_claim_remote_asset_cleanup_v1",
                params: { p_worker_id: "worker-1", p_limit: 20 },
            },
            {
                name: "omr_authorize_remote_asset_cleanup_delete_v1",
                params: {
                    p_cleanup_id: "cleanup-handwriting",
                    p_worker_id: "worker-1",
                    p_expected_attempt: 3,
                },
            },
        ]);
    });

    it("treats a monotonic generation above the retry quota as a valid lease fence", async () => {
        const calls: Array<{ name: string; params?: Record<string, unknown> }> = [];
        const client = {
            async rpc(name: string, params?: Record<string, unknown>) {
                calls.push({ name, params });
                if (name === "omr_claim_remote_asset_cleanup_v1") {
                    return {
                        data: [{
                            id: "cleanup-requeued",
                            attempts: 42,
                            storage_bucket: "omr-private-assets",
                            object_path: "organizations/org-1/exams/exam-1/problem/requeued.pdf",
                        }],
                        error: null,
                    };
                }
                return { data: true, error: null };
            },
            storage: { from: () => ({ remove: async () => ({ data: {}, error: null }) }) },
        };

        await expect(runRemoteAssetCleanupWithGateway(client as never, {
            workerId: "worker-1",
        })).resolves.toEqual({ claimed: 1, deleted: 1, failed: 0 });
        expect(calls[1]?.params).toMatchObject({ p_expected_attempt: 42 });
        expect(calls[2]?.params).toMatchObject({ p_expected_attempt: 42 });
    });

    it("fails an unsafe claimed path without sending it to Storage", async () => {
        const calls: string[] = [];
        const client = {
            async rpc(name: string) {
                calls.push(name);
                return {
                    data: name === "omr_claim_remote_asset_cleanup_v1"
                        ? [{ id: "cleanup-1", attempts: 1, storage_bucket: "omr-private-assets", object_path: "../escape.pdf" }]
                        : {},
                    error: null,
                };
            },
            storage: { from: () => ({ remove: async () => { throw new Error("must not remove"); } }) },
        };
        await expect(runRemoteAssetCleanupWithGateway(client as never, {
            workerId: "worker-1",
        })).resolves.toEqual({ claimed: 1, deleted: 0, failed: 1 });
        expect(calls).toEqual(["omr_claim_remote_asset_cleanup_v1", "omr_fail_remote_asset_cleanup_v1"]);
    });

    it("isolates per-job throws and treats a false acknowledgement as a failed job", async () => {
        const jobs = ["throws", "ack-false", "ok"].map((suffix, index) => ({
            id: `cleanup-${index + 1}`,
            attempts: 1,
            storage_bucket: "omr-private-assets",
            object_path: `organizations/org-1/exams/exam-1/problem/${suffix}.pdf`,
        }));
        const failures: Array<Record<string, unknown>> = [];
        const client = {
            async rpc(name: string, params: Record<string, unknown>) {
                if (name === "omr_claim_remote_asset_cleanup_v1") return { data: jobs, error: null };
                if (name === "omr_ack_remote_asset_cleanup_v1") {
                    return { data: params.p_cleanup_id !== "cleanup-2", error: null };
                }
                if (name === "omr_authorize_remote_asset_cleanup_delete_v1") {
                    return { data: true, error: null };
                }
                failures.push(params);
                return { data: true, error: null };
            },
            storage: { from: () => ({
                async remove(paths: string[]) {
                    if (paths[0].includes("throws")) throw new Error("transient storage throw");
                    return { data: {}, error: null };
                },
            }) },
        };

        await expect(runRemoteAssetCleanupWithGateway(client as never, {
            workerId: "worker-1",
            batchSize: 3,
        })).resolves.toEqual({ claimed: 3, deleted: 1, failed: 2 });
        expect(failures).toEqual([
            expect.objectContaining({ p_cleanup_id: "cleanup-1", p_error: "storage_delete_failed" }),
            expect.objectContaining({ p_cleanup_id: "cleanup-2", p_error: "ack_failed" }),
        ]);
        expect(failures.every(params => !Object.hasOwn(params, "p_error_code"))).toBe(true);
    });

    it("drains multiple bounded batches and stops as soon as the queue is empty", async () => {
        let claims = 0;
        const client = {
            async rpc(name: string) {
                if (name === "omr_claim_remote_asset_cleanup_v1") {
                    claims += 1;
                    const jobs = claims <= 2
                        ? [{
                            id: `cleanup-${claims}`,
                            attempts: 1,
                            storage_bucket: "omr-private-assets",
                            object_path: `organizations/org-1/exams/exam-1/problem/asset-${claims}.pdf`,
                        }]
                        : [];
                    return { data: jobs, error: null };
                }
                return { data: true, error: null };
            },
            storage: { from: () => ({ remove: async () => ({ data: {}, error: null }) }) },
        };

        await expect(drainRemoteAssetCleanupWithGateway(client as never, {
            workerId: "worker-1",
            batchSize: 1,
            maxBatches: 24,
        })).resolves.toEqual({
            claimed: 2,
            deleted: 2,
            failed: 0,
            batches: 3,
            claimAttempts: 3,
            nonemptyBatches: 2,
        });
        expect(claims).toBe(3);
    });

    it("does not start a batch that cannot finish inside the route budget", async () => {
        let now = 1_000;
        let claims = 0;
        const client = {
            async rpc(name: string) {
                if (name === "omr_claim_remote_asset_cleanup_v1") {
                    claims += 1;
                    now += 31_000;
                    return {
                        data: [{
                            id: `cleanup-${claims}`,
                            attempts: 1,
                            storage_bucket: "omr-private-assets",
                            object_path: `organizations/org-1/exams/exam-1/problem/asset-${claims}.pdf`,
                        }],
                        error: null,
                    };
                }
                return { data: true, error: null };
            },
            storage: { from: () => ({ remove: async () => ({ data: {}, error: null }) }) },
        };

        await expect(drainRemoteAssetCleanupWithGateway(client as never, {
            workerId: "worker-1",
            batchSize: 1,
            maxBatches: 4,
            deadlineAtMs: 56_000,
            minimumBatchBudgetMs: 30_000,
            now: () => now,
        })).resolves.toEqual({
            claimed: 1,
            deleted: 1,
            failed: 0,
            batches: 1,
            claimAttempts: 1,
            nonemptyBatches: 1,
        });
        expect(claims).toBe(1);
    });
});
