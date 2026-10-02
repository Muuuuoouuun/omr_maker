import { describe, expect, it, vi } from "vitest";

import {
    beginOperationalJobRun,
    completeOperationalJobRun,
    evaluateAssetGcReadiness,
    readOperationalJobStatus,
} from "./operationalJobStatusGateway.server";

const BUILD_SHA = "0123456789abcdef0123456789abcdef01234567";
const NOW = new Date("2026-08-08T12:00:00.000Z");

function clientWithResult(data: unknown, error: { message?: string } | null = null) {
    return {
        rpc: vi.fn(async () => ({ data, error })),
    };
}

describe("operational job status gateway", () => {
    it("reads the bounded asset GC status from the service-role RPC", async () => {
        const client = clientWithResult({
            status: "healthy",
            lastAttemptAt: "2026-08-08T00:00:00.000Z",
            lastSuccessAt: "2026-08-08T00:00:00.000Z",
            deadCount: 0,
            buildSha: BUILD_SHA,
            failureCategory: null,
            latestStartedSequence: 19,
            latestCompletedSequence: 19,
        });

        await expect(readOperationalJobStatus(client, "asset_gc")).resolves.toEqual({
            status: "healthy",
            lastAttemptAt: "2026-08-08T00:00:00.000Z",
            lastSuccessAt: "2026-08-08T00:00:00.000Z",
            deadCount: 0,
            buildSha: BUILD_SHA,
            failureCategory: null,
            latestStartedSequence: 19,
            latestCompletedSequence: 19,
        });
        expect(client.rpc).toHaveBeenCalledWith("omr_read_operational_job_status_v1", {
            p_job_key: "asset_gc",
        });
    });

    it("returns null for no row and fails closed on RPC or malformed rows", async () => {
        await expect(readOperationalJobStatus(clientWithResult(null), "asset_gc")).resolves.toBeNull();
        await expect(readOperationalJobStatus(
            clientWithResult(null, { message: "private database detail" }),
            "asset_gc",
        )).rejects.toThrow("Operational job status read failed");

        for (const malformed of [
            { status: "healthy", lastAttemptAt: NOW.toISOString(), lastSuccessAt: NOW.toISOString(), deadCount: 0, buildSha: "short", failureCategory: null },
            { status: "failed", lastAttemptAt: NOW.toISOString(), lastSuccessAt: null, deadCount: 0, buildSha: BUILD_SHA, failureCategory: "Raw Student@example.com" },
            { status: "healthy", lastAttemptAt: NOW.toISOString(), lastSuccessAt: null, deadCount: 0, buildSha: BUILD_SHA, failureCategory: null },
            {
                status: "healthy",
                lastAttemptAt: NOW.toISOString(),
                lastSuccessAt: NOW.toISOString(),
                deadCount: 0,
                buildSha: BUILD_SHA,
                failureCategory: null,
                latestStartedSequence: 20,
                latestCompletedSequence: 19,
            },
        ]) {
            await expect(readOperationalJobStatus(clientWithResult(malformed), "asset_gc"))
                .rejects.toThrow("Operational job status read failed");
        }
    });

    it("begins a DB-issued positive generation before cleanup", async () => {
        const client = clientWithResult({ admitted: true, busy: false, runSequence: 20 });
        await expect(beginOperationalJobRun(client, {
            jobKey: "asset_gc",
            buildSha: BUILD_SHA,
        })).resolves.toEqual({ admitted: true, busy: false, runSequence: 20 });
        expect(client.rpc).toHaveBeenCalledWith("omr_begin_operational_job_run_v1", {
            p_job_key: "asset_gc",
            p_build_sha: BUILD_SHA,
        });
    });

    it("returns an explicit busy result without inventing a sequence", async () => {
        const client = clientWithResult({ admitted: false, busy: true, runSequence: null });
        await expect(beginOperationalJobRun(client, {
            jobKey: "asset_gc",
            buildSha: BUILD_SHA,
        })).resolves.toEqual({ admitted: false, busy: true, runSequence: null });
    });

    it("rejects a malformed or non-positive begin result", async () => {
        for (const result of [
            null,
            { admitted: true, busy: false, runSequence: 0 },
            { admitted: true, busy: true, runSequence: 20 },
            { admitted: false, busy: true, runSequence: 20 },
            { admitted: false, busy: false, runSequence: null },
        ]) {
            await expect(beginOperationalJobRun(clientWithResult(result), {
                jobKey: "asset_gc",
                buildSha: BUILD_SHA,
            })).rejects.toThrow("Operational job run begin failed");
        }
    });

    it("returns the authoritative bounded completion and supersession result", async () => {
        const persisted = {
            status: "failed",
            lastAttemptAt: "2026-08-08T00:00:00.000Z",
            lastSuccessAt: "2026-08-07T00:00:00.000Z",
            deadCount: 2,
            buildSha: BUILD_SHA,
            failureCategory: "dead_backlog",
            latestStartedSequence: 21,
            latestCompletedSequence: 21,
            runSequence: 20,
            applied: false,
            superseded: true,
            duplicate: false,
        };
        const client = clientWithResult(persisted);
        await expect(completeOperationalJobRun(client, {
            jobKey: "asset_gc",
            runSequence: 20,
            status: "healthy",
            buildSha: BUILD_SHA,
            failureCategory: null,
        })).resolves.toEqual(persisted);
        expect(client.rpc).toHaveBeenCalledWith("omr_complete_operational_job_run_v1", {
            p_job_key: "asset_gc",
            p_run_sequence: 20,
            p_status: "healthy",
            p_build_sha: BUILD_SHA,
            p_failure_category: null,
        });
    });

    it("returns an explicit idempotent duplicate completion", async () => {
        const duplicate = {
            status: "healthy",
            lastAttemptAt: "2026-08-08T00:00:00.000Z",
            lastSuccessAt: "2026-08-08T00:00:00.000Z",
            deadCount: 0,
            buildSha: BUILD_SHA,
            failureCategory: null,
            latestStartedSequence: 20,
            latestCompletedSequence: 20,
            runSequence: 20,
            applied: false,
            superseded: false,
            duplicate: true,
        };
        await expect(completeOperationalJobRun(clientWithResult(duplicate), {
            jobKey: "asset_gc",
            runSequence: 20,
            status: "healthy",
            buildSha: BUILD_SHA,
            failureCategory: null,
        })).resolves.toEqual(duplicate);
    });

    it("rejects a completion result without exactly one terminal disposition", async () => {
        const base = {
            status: "healthy",
            lastAttemptAt: "2026-08-08T00:00:00.000Z",
            lastSuccessAt: "2026-08-08T00:00:00.000Z",
            deadCount: 0,
            buildSha: BUILD_SHA,
            failureCategory: null,
            latestStartedSequence: 20,
            latestCompletedSequence: 20,
            runSequence: 20,
        };
        for (const dispositions of [
            { applied: false, superseded: false, duplicate: false },
            { applied: true, superseded: false, duplicate: true },
            { applied: false, superseded: true, duplicate: true },
        ]) {
            await expect(completeOperationalJobRun(clientWithResult({ ...base, ...dispositions }), {
                jobKey: "asset_gc",
                runSequence: 20,
                status: "healthy",
                buildSha: BUILD_SHA,
                failureCategory: null,
            })).rejects.toThrow("Operational job run completion failed");
        }
    });

    it("fails closed when the completion RPC does not return an authoritative status", async () => {
        await expect(completeOperationalJobRun(clientWithResult(true), {
            jobKey: "asset_gc",
            runSequence: 20,
            status: "healthy",
            buildSha: BUILD_SHA,
            failureCategory: null,
        })).rejects.toThrow("Operational job run completion failed");
    });

    it("rejects malformed build SHA and failure category before calling the RPC", async () => {
        for (const input of [
            { status: "healthy", buildSha: "short", failureCategory: null },
            { status: "failed", buildSha: BUILD_SHA, failureCategory: "student@example.com" },
        ] as const) {
            const client = clientWithResult(true);
            await expect(completeOperationalJobRun(client, {
                jobKey: "asset_gc",
                runSequence: 20,
                ...input,
            })).rejects.toThrow("Invalid operational job status");
            expect(client.rpc).not.toHaveBeenCalled();
        }
        await expect(completeOperationalJobRun(clientWithResult(true), {
            jobKey: "asset_gc",
            runSequence: 0,
            status: "healthy",
            buildSha: BUILD_SHA,
            failureCategory: null,
        })).rejects.toThrow("Invalid operational job status");
    });

    it("accepts the exact 30-hour boundary and rejects one millisecond older", () => {
        const base = {
            now: NOW,
            status: "healthy" as const,
            lastAttemptAt: NOW.toISOString(),
            deadCount: 0,
            buildSha: BUILD_SHA,
            expectedBuildSha: BUILD_SHA,
            failureCategory: null,
            latestStartedSequence: 19,
            latestCompletedSequence: 19,
        };
        expect(evaluateAssetGcReadiness({
            ...base,
            lastSuccessAt: new Date(NOW.getTime() - 30 * 60 * 60 * 1_000).toISOString(),
        })).toBe("ready");
        expect(evaluateAssetGcReadiness({
            ...base,
            lastSuccessAt: new Date(NOW.getTime() - 30 * 60 * 60 * 1_000 - 1).toISOString(),
        })).toBe("stale");
    });

    it("rejects dead items, a failure after prior success, and a mismatched build", () => {
        const base = {
            now: NOW,
            lastAttemptAt: NOW.toISOString(),
            lastSuccessAt: NOW.toISOString(),
            buildSha: BUILD_SHA,
            expectedBuildSha: BUILD_SHA,
            latestStartedSequence: 19,
            latestCompletedSequence: 19,
        };
        expect(evaluateAssetGcReadiness({
            ...base,
            status: "healthy",
            deadCount: 1,
            failureCategory: null,
        })).toBe("dead_items");
        expect(evaluateAssetGcReadiness({
            ...base,
            status: "failed",
            deadCount: 0,
            failureCategory: "cleanup_failed",
        })).toBe("failed");
        expect(evaluateAssetGcReadiness({
            ...base,
            status: "healthy",
            deadCount: 0,
            failureCategory: null,
            expectedBuildSha: "f".repeat(40),
        })).toBe("build_mismatch");
    });

    it("rejects an in-flight latest generation even after a prior successful run", () => {
        expect(evaluateAssetGcReadiness({
            now: NOW,
            status: "failed",
            lastAttemptAt: NOW.toISOString(),
            lastSuccessAt: NOW.toISOString(),
            deadCount: 0,
            buildSha: BUILD_SHA,
            expectedBuildSha: BUILD_SHA,
            failureCategory: "run_incomplete",
            latestStartedSequence: 20,
            latestCompletedSequence: 19,
        })).toBe("incomplete");
    });
});
