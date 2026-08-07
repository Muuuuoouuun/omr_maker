import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    authorize: vi.fn(() => true),
    drain: vi.fn(),
    heartbeat: vi.fn(),
    reportError: vi.fn(),
}));

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

import { GET } from "@/app/api/internal/asset-gc/route";

describe("remote asset cleanup route behavior", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.authorize.mockReturnValue(true);
        mocks.drain.mockResolvedValue({ claimed: 2, deleted: 2, failed: 0, batches: 1 });
        mocks.heartbeat.mockResolvedValue({ status: "delivered" });
        mocks.reportError.mockResolvedValue({ status: "delivered" });
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
        });
        expect(mocks.heartbeat).toHaveBeenCalledWith("asset-gc", "ok", {
            claimed: 2,
            deleted: 2,
            failed: 0,
            batches: 1,
        });
    });

    it("keeps a clean GC run successful while exposing degraded telemetry", async () => {
        mocks.drain.mockResolvedValue({ claimed: 0, deleted: 0, failed: 0, batches: 1 });
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
        });
    });

    it("returns a redacted 503 for partial cleanup failure", async () => {
        const cleanup = { claimed: 2, deleted: 1, failed: 1, batches: 1 };
        const heartbeat = { status: "delivered" };
        mocks.drain.mockResolvedValue(cleanup);
        mocks.heartbeat.mockResolvedValue(heartbeat);
        const response = await GET(new Request("https://app.example.test/api/internal/asset-gc"));
        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toEqual({ status: "unavailable" });
        expect(mocks.heartbeat).toHaveBeenCalledWith(
            "asset-gc",
            cleanup.failed > 0 ? "degraded" : "ok",
            cleanup,
        );
    });

    it("reports thrown cleanup failures and never returns the raw error", async () => {
        mocks.drain.mockRejectedValue(new Error("private object path and provider token"));
        const response = await GET(new Request("https://app.example.test/api/internal/asset-gc"));
        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toEqual({ status: "unavailable" });
        expect(mocks.reportError).toHaveBeenCalledWith("asset-gc", expect.any(Error));
    });
});
