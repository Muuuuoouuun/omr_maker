import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    authorize: vi.fn(() => true),
    drain: vi.fn(),
    heartbeat: vi.fn(),
    reportError: vi.fn(),
    beginJobRun: vi.fn(),
    completeJobRun: vi.fn(),
}));

const BUILD_SHA = "0123456789abcdef0123456789abcdef01234567";

function persistedStatus(overrides: Record<string, unknown> = {}) {
    return {
        status: "healthy",
        lastAttemptAt: "2026-08-08T00:00:00.000Z",
        lastSuccessAt: "2026-08-08T00:00:00.000Z",
        deadCount: 0,
        buildSha: BUILD_SHA,
        failureCategory: null,
        latestStartedSequence: 20,
        latestCompletedSequence: 20,
        runSequence: 20,
        applied: true,
        superseded: false,
        ...overrides,
    };
}

vi.mock("@/lib/supabaseServerAdmin", () => ({
    getSupabaseServerConfigFromEnv: () => ({
        url: "https://db.example.test",
        serviceRoleKey: "service-role",
        backendTimeoutMs: 20_000,
    }),
    createSupabaseAdminClient: () => ({ mocked: true }),
}));

vi.mock("@/lib/remoteAssetCleanup.server", () => ({
    authorizeRemoteAssetCleanupRequest: mocks.authorize,
    drainRemoteAssetCleanupWithGateway: mocks.drain,
}));

vi.mock("@/lib/reportServerError", () => ({
    reportOperationalHeartbeat: mocks.heartbeat,
    reportServerError: mocks.reportError,
}));

vi.mock("@/lib/operationalJobStatusGateway.server", () => ({
    operationalRuntimeBuildSha: () => BUILD_SHA,
    beginOperationalJobRun: mocks.beginJobRun,
    completeOperationalJobRun: mocks.completeJobRun,
}));

import { GET } from "@/app/api/internal/asset-gc/route";

describe("remote asset cleanup route behavior", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.authorize.mockReturnValue(true);
        mocks.drain.mockResolvedValue({
            claimed: 2, deleted: 2, failed: 0, batches: 1, claimAttempts: 1, nonemptyBatches: 1,
        });
        mocks.heartbeat.mockResolvedValue({ status: "delivered" });
        mocks.reportError.mockResolvedValue({ status: "delivered" });
        mocks.beginJobRun.mockResolvedValue({ runSequence: 20 });
        mocks.completeJobRun.mockResolvedValue(persistedStatus());
    });

    it("returns success only after a clean run and delivered heartbeat", async () => {
        const response = await GET(new Request("https://app.example.test/api/internal/asset-gc"));
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({
            status: "ok",
            observability: "ready",
            claimed: 2,
            deleted: 2,
            failed: 0,
            batches: 1,
            claimAttempts: 1,
            nonemptyBatches: 1,
            runSequence: 20,
            applied: true,
            superseded: false,
            durableStatus: "healthy",
            deadCount: 0,
        });
        expect(mocks.heartbeat).toHaveBeenCalledWith("asset-gc", "ok", {
            claimed: 2,
            deleted: 2,
            failed: 0,
            batches: 1,
            claimAttempts: 1,
            nonemptyBatches: 1,
            runSequence: 20,
            applied: true,
            superseded: false,
        });
        expect(mocks.beginJobRun).toHaveBeenCalledWith(expect.anything(), {
            jobKey: "asset_gc",
            buildSha: BUILD_SHA,
        });
        expect(mocks.beginJobRun.mock.invocationCallOrder[0])
            .toBeLessThan(mocks.drain.mock.invocationCallOrder[0]);
        expect(mocks.completeJobRun).toHaveBeenCalledWith(expect.anything(), {
            jobKey: "asset_gc",
            runSequence: 20,
            status: "healthy",
            buildSha: "0123456789abcdef0123456789abcdef01234567",
            failureCategory: null,
        });
    });

    it("keeps a clean GC run successful while exposing degraded telemetry", async () => {
        mocks.drain.mockResolvedValue({
            claimed: 0, deleted: 0, failed: 0, batches: 1, claimAttempts: 1, nonemptyBatches: 0,
        });
        mocks.heartbeat.mockResolvedValue({ status: "rejected" });
        const response = await GET(new Request("https://app.example.test/api/internal/asset-gc"));
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({
            status: "ok",
            observability: "degraded",
            claimed: 0,
            deleted: 0,
            failed: 0,
            batches: 1,
            claimAttempts: 1,
            nonemptyBatches: 0,
            runSequence: 20,
            applied: true,
            superseded: false,
            durableStatus: "healthy",
            deadCount: 0,
        });
        expect(mocks.completeJobRun).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ status: "healthy" }),
        );
    });

    it("returns a redacted 503 for partial cleanup failure", async () => {
        const cleanup = {
            claimed: 2, deleted: 1, failed: 1, batches: 1, claimAttempts: 1, nonemptyBatches: 1,
        };
        const heartbeat = { status: "delivered" };
        mocks.drain.mockResolvedValue(cleanup);
        mocks.heartbeat.mockResolvedValue(heartbeat);
        mocks.completeJobRun.mockResolvedValue(persistedStatus({
            status: "failed",
            lastSuccessAt: null,
            failureCategory: "cleanup_failed",
        }));
        const response = await GET(new Request("https://app.example.test/api/internal/asset-gc"));
        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toEqual({ status: "unavailable" });
        expect(mocks.heartbeat).toHaveBeenCalledWith(
            "asset-gc",
            cleanup.failed > 0 ? "degraded" : "ok",
            expect.objectContaining(cleanup),
        );
        expect(mocks.completeJobRun).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                status: "failed",
                failureCategory: "cleanup_failed",
            }),
        );
    });

    it("does not let a newer healthy row mask this invocation's cleanup failure", async () => {
        const cleanup = {
            claimed: 2, deleted: 1, failed: 1, batches: 1, claimAttempts: 1, nonemptyBatches: 1,
        };
        mocks.drain.mockResolvedValue(cleanup);
        mocks.completeJobRun.mockResolvedValue(persistedStatus({
            latestStartedSequence: 21,
            latestCompletedSequence: 21,
            applied: false,
            superseded: true,
        }));

        const response = await GET(new Request("https://app.example.test/api/internal/asset-gc"));

        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toEqual({ status: "unavailable" });
        expect(mocks.heartbeat).toHaveBeenCalledWith(
            "asset-gc", "degraded", expect.objectContaining(cleanup),
        );
    });

    it("returns 503 when a clean batch reveals a pre-existing durable dead backlog", async () => {
        const cleanup = {
            claimed: 0, deleted: 0, failed: 0, batches: 1, claimAttempts: 1, nonemptyBatches: 0,
        };
        mocks.drain.mockResolvedValue(cleanup);
        mocks.completeJobRun.mockResolvedValue(persistedStatus({
            status: "failed",
            deadCount: 1,
            failureCategory: "dead_backlog",
        }));

        const response = await GET(new Request("https://app.example.test/api/internal/asset-gc"));

        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toEqual({ status: "unavailable" });
        expect(mocks.heartbeat).toHaveBeenCalledWith(
            "asset-gc", "degraded", expect.objectContaining(cleanup),
        );
    });

    it("fails the route closed when authoritative persistence is unavailable", async () => {
        mocks.completeJobRun.mockRejectedValue(new Error("database unavailable"));

        const response = await GET(new Request("https://app.example.test/api/internal/asset-gc"));

        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toEqual({ status: "unavailable" });
        expect(mocks.reportError).toHaveBeenCalledWith("asset-gc", expect.any(Error));
        expect(mocks.heartbeat).not.toHaveBeenCalled();
    });

    it("reports thrown cleanup failures and never returns the raw error", async () => {
        mocks.drain.mockRejectedValue(new Error("private object path and provider token"));
        const response = await GET(new Request("https://app.example.test/api/internal/asset-gc"));
        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toEqual({ status: "unavailable" });
        expect(mocks.reportError).toHaveBeenCalledWith("asset-gc", expect.any(Error));
        expect(mocks.completeJobRun).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                status: "failed",
                failureCategory: "cleanup_exception",
            }),
        );
    });

    it("does not turn a persisted successful cleanup into failure when the event sink throws", async () => {
        mocks.heartbeat.mockRejectedValue(new Error("sink unavailable"));
        const response = await GET(new Request("https://app.example.test/api/internal/asset-gc"));
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
            status: "ok",
            observability: "degraded",
        });
        expect(mocks.completeJobRun).toHaveBeenCalledTimes(1);
        expect(mocks.completeJobRun).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ status: "healthy" }),
        );
    });

    it("does not run cleanup when the DB generation cannot begin", async () => {
        mocks.beginJobRun.mockRejectedValue(new Error("database unavailable"));

        const response = await GET(new Request("https://app.example.test/api/internal/asset-gc"));

        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toEqual({ status: "unavailable" });
        expect(mocks.drain).not.toHaveBeenCalled();
        expect(mocks.completeJobRun).not.toHaveBeenCalled();
        expect(mocks.reportError).toHaveBeenCalledWith("asset-gc", expect.any(Error));
    });

    it("returns an authoritative superseded healthy generation without masking proof", async () => {
        mocks.completeJobRun.mockResolvedValue(persistedStatus({
            latestStartedSequence: 21,
            latestCompletedSequence: 21,
            runSequence: 20,
            applied: false,
            superseded: true,
        }));

        const response = await GET(new Request("https://app.example.test/api/internal/asset-gc"));

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
            status: "ok",
            runSequence: 20,
            applied: false,
            superseded: true,
            durableStatus: "healthy",
        });
    });
});
