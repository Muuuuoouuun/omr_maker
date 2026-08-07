import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

const RUN_ID = "run-20260807-live";
const BUILD = "a".repeat(40);
const SUFFIX = createHash("sha256").update(RUN_ID).digest("hex").slice(0, 16);

describe("initial-operations HTTP provider collectors", () => {
    it("collects bounded DB before/after and repeated per-instance RSS with full provenance headers", async () => {
        const { createInitialOperationsCollectors } = await import("./initial-operations-http-collectors.mjs");
        const calls: Array<{ url: string; headers: Headers; signal: AbortSignal | null }> = [];
        let rssBytes = 100;
        const fetchImpl = async (input: URL | RequestInfo, init: RequestInit = {}) => {
            const url = input.toString();
            const headers = new Headers(init.headers);
            calls.push({ url, headers, signal: init.signal instanceof AbortSignal ? init.signal : null });
            const body = url.includes("/operations/instance-rss-read")
                ? { kind: "rss", source: "server", runId: RUN_ID, serverInstanceId: "instance-a", build: BUILD, capturedAtMs: Date.now(), rssBytes: rssBytes += 1 }
                : { status: "ok", kind: "databaseWindow", phase: url.includes("before") ? "before" : "after", instrumentation: "pg_stat_statements", counters: { deadlocks: 0, lockTimeouts: 0 }, rows: [], attemptInventory: [] };
            const raw = JSON.stringify(body);
            const response = new Response(raw, {
                status: 200,
                headers: {
                    "content-type": "application/json",
                    "content-length": String(Buffer.byteLength(raw)),
                    "cache-control": "no-store",
                    "x-omr-build": BUILD,
                    "x-omr-instance-id": "instance-a",
                },
            });
            Object.defineProperties(response, { url: { value: url }, redirected: { value: false } });
            return response;
        };
        const collectors = await createInitialOperationsCollectors({
            runId: RUN_ID,
            runChallenge: "b".repeat(32),
        }, { fetchImpl, intervalMs: 5 });
        const input = { config: { baseUrl: "https://staging.omr.example", expectedBuild: BUILD, loadToken: "l".repeat(40) } };
        await collectors.database.start(input);
        await collectors.rss.start(input);
        await new Promise(resolve => setTimeout(resolve, 14));
        const rss = await collectors.rss.stop(input);
        const database = await collectors.database.stop(input);

        expect(rss.length).toBeGreaterThanOrEqual(2);
        expect(database).toHaveLength(2);
        expect(calls.some(call => call.url.endsWith("?phase=before"))).toBe(true);
        expect(calls.some(call => call.url.endsWith("?phase=after"))).toBe(true);
        expect(calls.some(call => call.url.endsWith("/api/internal/initial-operations/operations/instance-rss-read"))).toBe(true);
        for (const call of calls) {
            expect(call.url.startsWith("https://staging.omr.example/api/internal/initial-operations/")).toBe(true);
            expect(call.headers.get("x-omr-run-id")).toBe(RUN_ID);
            expect(call.headers.get("x-omr-run-challenge")).toBe("b".repeat(32));
            expect(call.headers.get("x-omr-expected-build")).toBe(BUILD);
            expect(call.headers.get("x-omr-actor-id")).toBe(`collector_${SUFFIX}`);
            expect(call.signal).toBeInstanceOf(AbortSignal);
        }
        expect(JSON.stringify({ rss, database })).not.toContain("l".repeat(40));
    });

    it("captures a periodic RSS rejection and reports a sanitized failure from stop", async () => {
        const { createInitialOperationsCollectors } = await import("./initial-operations-http-collectors.mjs");
        let rssCalls = 0;
        const collectors = await createInitialOperationsCollectors({
            runId: RUN_ID,
            runChallenge: "b".repeat(32),
        }, {
            intervalMs: 2,
            fetchImpl: async (input: URL | RequestInfo) => {
                const url = input.toString();
                rssCalls += 1;
                if (rssCalls > 1) throw new Error("secret provider detail");
                const raw = JSON.stringify({
                    kind: "rss", source: "server", runId: RUN_ID,
                    serverInstanceId: "instance-a", build: BUILD,
                    capturedAtMs: Date.now(), rssBytes: 100,
                });
                const response = new Response(raw, {
                    status: 200,
                    headers: {
                        "content-type": "application/json", "content-length": String(Buffer.byteLength(raw)),
                        "cache-control": "no-store", "x-omr-build": BUILD, "x-omr-instance-id": "instance-a",
                    },
                });
                Object.defineProperties(response, { url: { value: url }, redirected: { value: false } });
                return response;
            },
        });
        const input = { config: { baseUrl: "https://staging.omr.example", expectedBuild: BUILD, loadToken: "l".repeat(40) } };
        await collectors.rss.start(input);
        await new Promise(resolve => setTimeout(resolve, 8));

        await expect(collectors.rss.stop(input)).rejects.toThrow("Provider RSS collection failed");
    });

    it("rejects RSS evidence whose body instance is not the serving operation instance", async () => {
        const { createInitialOperationsCollectors } = await import("./initial-operations-http-collectors.mjs");
        const collectors = await createInitialOperationsCollectors({
            runId: RUN_ID,
            runChallenge: "b".repeat(32),
        }, {
            fetchImpl: async (input: URL | RequestInfo) => {
                const raw = JSON.stringify({
                    kind: "rss", source: "server", runId: RUN_ID,
                    serverInstanceId: "instance-body", build: BUILD,
                    capturedAtMs: Date.now(), rssBytes: 100,
                });
                const response = new Response(raw, {
                    status: 200,
                    headers: {
                        "content-type": "application/json", "content-length": String(Buffer.byteLength(raw)),
                        "cache-control": "no-store", "x-omr-build": BUILD, "x-omr-instance-id": "instance-header",
                    },
                });
                Object.defineProperties(response, { url: { value: input.toString() }, redirected: { value: false } });
                return response;
            },
        });

        await expect(collectors.rss.start({
            config: { baseUrl: "https://staging.omr.example", expectedBuild: BUILD, loadToken: "l".repeat(40) },
        })).rejects.toThrow("Provider RSS collection failed");
    });

    it("fails closed on a redirected, mixed-build, oversized, or unavailable provider response", async () => {
        const { createInitialOperationsCollectors } = await import("./initial-operations-http-collectors.mjs");
        const invalid = await createInitialOperationsCollectors({
            runId: RUN_ID,
            runChallenge: "b".repeat(32),
        }, {
            fetchImpl: async (input: URL | RequestInfo) => {
                const raw = JSON.stringify({ status: "ok" });
                const response = new Response(raw, {
                    status: 200,
                    headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(raw)), "cache-control": "no-store", "x-omr-build": "c".repeat(40), "x-omr-instance-id": "foreign" },
                });
                Object.defineProperties(response, { url: { value: input.toString() }, redirected: { value: false } });
                return response;
            },
        });
        await expect(invalid.database.start({ config: { baseUrl: "https://staging.omr.example", expectedBuild: BUILD, loadToken: "l".repeat(40) } }))
            .rejects.toThrow(/provenance|provider/i);
    });
});
