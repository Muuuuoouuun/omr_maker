import { describe, expect, it, vi } from "vitest";

import {
    evaluateAssetGcReadiness,
    readOperationalJobStatus,
    recordOperationalJobStatus,
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
        });

        await expect(readOperationalJobStatus(client, "asset_gc")).resolves.toEqual({
            status: "healthy",
            lastAttemptAt: "2026-08-08T00:00:00.000Z",
            lastSuccessAt: "2026-08-08T00:00:00.000Z",
            deadCount: 0,
            buildSha: BUILD_SHA,
            failureCategory: null,
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
        ]) {
            await expect(readOperationalJobStatus(clientWithResult(malformed), "asset_gc"))
                .rejects.toThrow("Operational job status read failed");
        }
    });

    it("records only a bounded attempt through the canonical RPC", async () => {
        const client = clientWithResult(true);
        await expect(recordOperationalJobStatus(client, {
            jobKey: "asset_gc",
            status: "failed",
            attemptedAt: "2026-08-08T00:00:00.000Z",
            deadCount: 1,
            buildSha: BUILD_SHA,
            failureCategory: "cleanup_failed",
        })).resolves.toBeUndefined();
        expect(client.rpc).toHaveBeenCalledWith("omr_record_operational_job_status_v1", {
            p_job_key: "asset_gc",
            p_status: "failed",
            p_attempted_at: "2026-08-08T00:00:00.000Z",
            p_dead_count: 1,
            p_build_sha: BUILD_SHA,
            p_failure_category: "cleanup_failed",
        });
    });

    it("rejects malformed build SHA and failure category before calling the RPC", async () => {
        for (const input of [
            { status: "healthy", buildSha: "short", failureCategory: null },
            { status: "failed", buildSha: BUILD_SHA, failureCategory: "student@example.com" },
        ] as const) {
            const client = clientWithResult(true);
            await expect(recordOperationalJobStatus(client, {
                jobKey: "asset_gc",
                attemptedAt: NOW.toISOString(),
                deadCount: 0,
                ...input,
            })).rejects.toThrow("Invalid operational job status");
            expect(client.rpc).not.toHaveBeenCalled();
        }
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
});
