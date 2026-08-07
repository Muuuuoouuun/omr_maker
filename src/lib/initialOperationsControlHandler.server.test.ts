import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { handleInitialOperationsControlRequest } from "./initialOperationsControlHandler.server";
import { INITIAL_OPERATIONS_PRODUCTION_WORKLOAD_PATHS } from "./initialOperationsLoadGateway.server";
import type { InitialOperationsServerConfig } from "./initialOperationsControlPlane.server";

const BUILD = "a".repeat(40);
const RUN_ID = "run-20260807-live";
const SUFFIX = createHash("sha256").update(RUN_ID).digest("hex").slice(0, 16);
const LOAD_TOKEN = "load-secret-that-is-at-least-thirty-two-bytes";
const config: InitialOperationsServerConfig = {
    build: BUILD,
    stagingHost: "staging.omr.example",
    stagingSupabaseUrl: "https://stagingprojectref.supabase.co",
    databaseProjectRefHash: createHash("sha256").update("stagingprojectref").digest("hex"),
    serverInstanceId: "instance-a",
    loadToken: LOAD_TOKEN,
};

function request(path: string, options: { method?: string; actorId?: string; body?: unknown; token?: string } = {}) {
    const headers = new Headers({
        authorization: `Bearer ${options.token ?? LOAD_TOKEN}`,
        host: config.stagingHost,
        "x-omr-run-id": RUN_ID,
        "x-omr-run-challenge": "b".repeat(32),
        "x-omr-expected-build": BUILD,
        "x-omr-request-id": `${RUN_ID}:test:${path.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`,
        "x-omr-actor-id": options.actorId ?? `control_${SUFFIX}`,
    });
    if (options.body !== undefined) headers.set("content-type", "application/json");
    return new Request(`https://${config.stagingHost}${path}`, {
        method: options.method ?? "GET",
        headers,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
}

function gateway() {
    return {
        mutateFixture: vi.fn(async (action: "create" | "cleanup") => action === "create"
            ? { status: "created" as const, organizationId: `teacher_${SUFFIX}`, examId: `initial_ops_exam_${SUFFIX}` }
            : { status: "cleaned" as const, remaining: { sessions: 0, attempts: 0, assets: 0, objects: 0 } }),
        executeOperation: vi.fn(async () => ({ status: "ok" as const, revision: 2 })),
        collectDatabase: vi.fn(async () => ({
            status: "ok" as const,
            kind: "databaseWindow" as const,
            instrumentation: "pg_stat_statements",
            counters: { deadlocks: 0, lockTimeouts: 0 },
            rows: [{ fingerprint: "checkpoint", calls: 1, maximumExecutionMs: 2 }],
            attemptInventory: [],
        })),
    };
}

describe("initial-operations internal control handler", () => {
    it("serves an attested contract and hides the surface when staging config is disabled", async () => {
        const missing = await handleInitialOperationsControlRequest(
            request("/api/internal/initial-operations/contract"),
            { kind: "contract" },
            { config: null, gateway: gateway() },
        );
        expect(missing.status).toBe(404);

        const response = await handleInitialOperationsControlRequest(
            request("/api/internal/initial-operations/contract"),
            { kind: "contract" },
            { config, gateway: gateway() },
        );
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({
            environment: "staging",
            appOrigin: `https://${config.stagingHost}`,
            storageOrigin: config.stagingSupabaseUrl,
            databaseProjectRefHash: config.databaseProjectRefHash,
            controlPlaneVersion: 2,
            productionWorkloadPaths: INITIAL_OPERATIONS_PRODUCTION_WORKLOAD_PATHS,
        });
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.get("x-omr-build")).toBe(BUILD);
    });

    it("rejects unauthorized, oversized, foreign-scope, and unsupported mutations before the gateway", async () => {
        const backend = gateway();
        const unauthorized = await handleInitialOperationsControlRequest(
            request("/api/internal/initial-operations/fixture", { method: "POST", token: "x".repeat(40), body: {} }),
            { kind: "fixture" },
            { config, gateway: backend, memoryUsage: () => ({ rss: 123_456 } as NodeJS.MemoryUsage), now: () => 456_789 },
        );
        expect(unauthorized.status).toBe(401);

        const foreign = await handleInitialOperationsControlRequest(
            request("/api/internal/initial-operations/fixture", {
                method: "POST",
                body: { action: "create", fixture: { organizationId: "default", examId: "prod-exam" } },
            }),
            { kind: "fixture" },
            { config, gateway: backend },
        );
        expect(foreign.status).toBe(400);

        const oversized = request("/api/internal/initial-operations/fixture", {
            method: "POST",
            body: { action: "create", padding: "x".repeat(70_000) },
        });
        const tooLarge = await handleInitialOperationsControlRequest(oversized, { kind: "fixture" }, { config, gateway: backend });
        expect(tooLarge.status).toBe(413);
        expect(backend.mutateFixture).not.toHaveBeenCalled();
    });

    it("runs fixture, operation, RSS, and database collectors with run-scoped data only", async () => {
        const backend = gateway();
        const fixture = { organizationId: `teacher_${SUFFIX}`, examId: `initial_ops_exam_${SUFFIX}` };
        const created = await handleInitialOperationsControlRequest(
            request("/api/internal/initial-operations/fixture", { method: "POST", body: { action: "create", fixture } }),
            { kind: "fixture" },
            { config, gateway: backend },
        );
        expect(created.status).toBe(200);
        expect(backend.mutateFixture).toHaveBeenCalledWith("create", expect.objectContaining({ runId: RUN_ID }), fixture);

        const operation = await handleInitialOperationsControlRequest(
            request("/api/internal/initial-operations/operations/checkpoint", {
                method: "POST",
                actorId: `student_${SUFFIX}_001`,
                body: { fixture, revision: 1 },
            }),
            { kind: "operation", operation: "checkpoint" },
            { config, gateway: backend, memoryUsage: () => ({ rss: 123_456 } as NodeJS.MemoryUsage), now: () => 456_789 },
        );
        expect(operation.status).toBe(200);
        expect(backend.executeOperation).toHaveBeenCalledWith("checkpoint", expect.objectContaining({ actorId: `student_${SUFFIX}_001` }), expect.objectContaining({ revision: 1 }));
        expect(operation.headers.get("x-omr-rss-bytes")).toBe("123456");
        expect(operation.headers.get("x-omr-rss-captured-at-ms")).toBe("456789");

        backend.executeOperation.mockClear();
        const inPathRss = await handleInitialOperationsControlRequest(
            request("/api/internal/initial-operations/operations/instance-rss-read", {
                actorId: `collector_${SUFFIX}`,
            }),
            { kind: "operation", operation: "instance-rss-read" },
            { config, gateway: backend, memoryUsage: () => ({ rss: 123_456 } as NodeJS.MemoryUsage), now: () => 456_789 },
        );
        await expect(inPathRss.json()).resolves.toMatchObject({
            kind: "rss", serverInstanceId: "instance-a", rssBytes: 123_456,
        });
        expect(backend.executeOperation).not.toHaveBeenCalled();

        const rss = await handleInitialOperationsControlRequest(
            request("/api/internal/initial-operations/metrics/rss", { actorId: `collector_${SUFFIX}` }),
            { kind: "rss" },
            { config, gateway: backend, memoryUsage: () => ({ rss: 123_456 } as NodeJS.MemoryUsage), now: () => 456_789 },
        );
        await expect(rss.json()).resolves.toMatchObject({
            kind: "rss",
            source: "server",
            runId: RUN_ID,
            serverInstanceId: "instance-a",
            build: BUILD,
            rssBytes: 123_456,
        });

        const database = await handleInitialOperationsControlRequest(
            request("/api/internal/initial-operations/metrics/database?phase=after", { actorId: `collector_${SUFFIX}` }),
            { kind: "database" },
            { config, gateway: backend },
        );
        expect(database.status).toBe(200);
        expect(backend.collectDatabase).toHaveBeenCalledWith("after", expect.objectContaining({ runId: RUN_ID }));
    });

    it("returns 503 instead of 200 for an unknown gateway status", async () => {
        const backend = gateway();
        backend.executeOperation.mockResolvedValueOnce({ status: "mystery" } as never);
        const response = await handleInitialOperationsControlRequest(
            request("/api/internal/initial-operations/operations/checkpoint", {
                method: "POST",
                actorId: `student_${SUFFIX}_001`,
                body: { revision: 1 },
            }),
            { kind: "operation", operation: "checkpoint" },
            { config, gateway: backend },
        );

        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toEqual({ status: "mystery" });
    });
});
