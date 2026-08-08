import { afterEach, describe, expect, it, vi } from "vitest";
import {
    deliverOperationalEvent,
    operationalEventSinkConfiguration,
    probeOperationalEventSink,
} from "./operationalEventSink.server";
import {
    buildOperationalErrorEvent,
    buildOperationalHeartbeatEvent,
} from "./reportError";
import * as operationalEvents from "./reportError";

const MAX_OPERATIONAL_EVENT_BYTES = 32 * 1024;
const EXACT_EVENT_ID = /^evt_[a-f0-9]{32}$/;

const configuredEnv = {
    NODE_ENV: "production",
    OMR_OPERATIONAL_SINK_URL: "https://ops.example.test/v1/events",
    OMR_OPERATIONAL_SINK_TOKEN: "ops_sink_token_0123456789_abcdef",
};

describe("operational event sink", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
        vi.useRealTimers();
    });

    it("exports the exact operational event ID contract", () => {
        expect(operationalEvents).toHaveProperty("SAFE_EVENT_ID");
        expect(String(Reflect.get(operationalEvents, "SAFE_EVENT_ID")))
            .toBe("/^evt_[a-f0-9]{32}$/");
    });

    it("builds a bounded runtime envelope with safe severity and caller correlation", () => {
        vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "0123456789012345678901234567890123456789");
        const event = buildOperationalErrorEvent(
            "student-submit",
            {
                code: "service_unavailable",
                name: "김학생",
                email: "student@example.com",
                cookie: "session=private-cookie",
                token: "private-token",
                answers: [1, 2, 3],
                rawBody: "private request body",
                pdf: "%PDF private content",
                databaseError: "private database detail",
            },
            {
                correlationId: "corr_01JABCDEF0123456789",
                now: new Date("2026-08-07T00:00:00.000Z"),
            },
        );

        expect(event).toMatchObject({
            event: "omr.runtime_error",
            severity: "error",
            correlationId: "corr_01JABCDEF0123456789",
            buildSha: "0123456789012345678901234567890123456789",
            timestamp: "2026-08-07T00:00:00.000Z",
        });
        expect(event.eventId).toMatch(/^evt_[a-f0-9]{32}$/);
        expect(event.eventId).not.toBe(event.correlationId);
        expect(JSON.stringify(event)).not.toMatch(
            /김학생|student@example\.com|private-cookie|private-token|answers|private request body|%PDF|private database detail/,
        );
        expect(JSON.stringify(event).length).toBeLessThan(32_000);
    });

    it.each(["info", "warning", "error", "critical"] as const)(
        "accepts the allowlisted %s severity",
        severity => {
            expect(buildOperationalErrorEvent("route-error", new Error("private"), { severity }))
                .toMatchObject({ severity });
        },
    );

    it.each([
        "A._:-09x",
        `Z${"a".repeat(127)}`,
        "corr.01JABC_DEF:0123-456789",
    ])("preserves a valid caller correlation ID: %s", correlationId => {
        const event = buildOperationalErrorEvent("route-error", new Error("private"), { correlationId });
        expect(event.correlationId).toBe(correlationId);
        expect(event.eventId).toMatch(/^evt_[a-f0-9]{32}$/);
        expect(event.eventId).not.toBe(correlationId);
    });

    it("chooses a distinct correlation fallback when caller correlation collides with event ID", () => {
        const uuid = "11111111-1111-4111-8111-111111111111" as `${string}-${string}-${string}-${string}-${string}`;
        vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(uuid);
        const collidingId = `evt_${uuid.replaceAll("-", "")}`;

        const event = buildOperationalErrorEvent("route-error", new Error("private"), {
            correlationId: collidingId,
        });

        expect(event.eventId).toBe(collidingId);
        expect(event.correlationId).toMatch(EXACT_EVENT_ID);
        expect(event.correlationId).not.toBe(event.eventId);
    });

    it.each([
        "A234567",
        `Z${"a".repeat(128)}`,
        ".corr_01JABCDEF0123456789",
        "corr/01JABCDEF0123456789",
        "corr 01JABCDEF0123456789",
        "상관관계_01JABCDEF0123456789",
        "corr_01JABCDEF0123456789\n",
        "",
        undefined,
    ])("replaces an invalid caller correlation ID: %j", correlationId => {
        const event = buildOperationalErrorEvent("route-error", new Error("private"), { correlationId });
        expect(event.correlationId).toMatch(/^evt_[a-f0-9]{32}$/);
        expect(event.correlationId).not.toBe(correlationId);
        expect(event.eventId).toMatch(/^evt_[a-f0-9]{32}$/);
        expect(event.eventId).not.toBe(event.correlationId);
    });

    it("ignores caller attempts to override protected envelope fields or inject context", () => {
        vi.stubEnv("GIT_SHA", "abcdef0123456789abcdef0123456789abcdef01");
        const options = {
            correlationId: "corr_01JABCDEF0123456789",
            severity: "fatal",
            event: "omr.attacker_event",
            eventId: "evt_attacker_controlled_event_id",
            buildSha: "attacker-build-sha",
            context: "feedback-save",
            email: "student@example.com",
            token: "private-token",
        } as never;

        const event = buildOperationalErrorEvent("route-error", new Error("private"), options);
        expect(event).toMatchObject({
            event: "omr.runtime_error",
            context: "route-error",
            severity: "error",
            correlationId: "corr_01JABCDEF0123456789",
            buildSha: "abcdef0123456789abcdef0123456789abcdef01",
        });
        expect(event.eventId).toMatch(/^evt_[a-f0-9]{32}$/);
        expect(event.eventId).not.toBe("evt_attacker_controlled_event_id");
        expect(event).not.toHaveProperty("email");
        expect(event).not.toHaveProperty("token");
        expect(JSON.stringify(event)).not.toMatch(/attacker|student@example\.com|private-token|fatal/);
    });

    it("assigns explicit informational and warning severity to job heartbeats", () => {
        const healthy = buildOperationalHeartbeatEvent("asset-gc", "ok");
        const degraded = buildOperationalHeartbeatEvent("asset-gc", "degraded");
        expect(healthy).toMatchObject({ event: "omr.job_heartbeat", severity: "info" });
        expect(degraded).toMatchObject({ event: "omr.job_heartbeat", severity: "warning" });
        for (const event of [healthy, degraded]) {
            expect(event.eventId).toMatch(EXACT_EVENT_ID);
            expect(event.correlationId).toMatch(EXACT_EVENT_ID);
            expect(event.eventId).not.toBe(event.correlationId);
        }
    });

    it("keeps bounded cleanup generation and sweep proof in the heartbeat", () => {
        expect(buildOperationalHeartbeatEvent("asset-gc", "ok", {
            claimed: 0,
            deleted: 0,
            failed: 0,
            batches: 1,
            claimAttempts: 1,
            nonemptyBatches: 0,
            runSequence: 20,
            applied: true,
            superseded: false,
            token: "private",
        }).metrics).toEqual({
            claimed: 0,
            deleted: 0,
            failed: 0,
            batches: 1,
            claimAttempts: 1,
            nonemptyBatches: 0,
            runSequence: 20,
            applied: 1,
            superseded: 0,
        });
    });

    it("fails configuration closed and requires HTTPS in production", () => {
        expect(operationalEventSinkConfiguration({})).toEqual({ status: "not_configured" });
        expect(operationalEventSinkConfiguration({
            ...configuredEnv,
            OMR_OPERATIONAL_SINK_URL: "http://ops.example.test/events",
        })).toEqual({ status: "invalid_configuration" });
        for (const url of [
            "https://127.0.0.1/events",
            "https://[::1]/events",
            "https://metadata.local/events",
        ]) {
            expect(operationalEventSinkConfiguration({
                ...configuredEnv,
                OMR_OPERATIONAL_SINK_URL: url,
            })).toEqual({ status: "invalid_configuration" });
        }
        expect(operationalEventSinkConfiguration(configuredEnv)).toMatchObject({
            status: "configured",
            url: "https://ops.example.test/v1/events",
        });
    });

    it("delivers one bounded redacted event without following redirects", async () => {
        const fetchImpl = vi.fn(async (...args: Parameters<typeof fetch>) => {
            void args;
            return new Response(null, { status: 202 });
        });
        const event = buildOperationalErrorEvent(
            "student-submit",
            { code: "service_unavailable", token: "never-send-this" },
            { now: new Date("2026-08-07T00:00:00.000Z") },
        );

        await expect(deliverOperationalEvent(event, configuredEnv, fetchImpl, 250))
            .resolves.toEqual({ status: "delivered" });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const [url, init] = fetchImpl.mock.calls[0];
        expect(url).toBe("https://ops.example.test/v1/events");
        expect(init).toMatchObject({
            method: "POST",
            cache: "no-store",
            credentials: "omit",
            redirect: "error",
        });
        expect(init?.headers).toMatchObject({
            authorization: "Bearer ops_sink_token_0123456789_abcdef",
            "content-type": "application/json",
            "x-omr-event-id": event.eventId,
        });
        expect(JSON.parse(String(init?.body))).toMatchObject({ eventId: event.eventId });
        expect((init?.headers as Record<string, string>)["x-omr-event-id"])
            .toBe(JSON.parse(String(init?.body)).eventId);
        expect(String(init?.body)).not.toContain("never-send-this");
    });

    it.each([
        "corr_01JABCDEF0123456789",
        "evt_ABCDEF0123456789ABCDEF0123456789",
        " evt_abcdef0123456789abcdef0123456789",
        "evt_abcdef0123456789abcdef0123456789 ",
        "evt_abcdef0123456789abcdef012345678",
        "event_unknown",
    ])("rejects malformed or spoofed event ID before serialization: %j", async eventId => {
        const fetchImpl = vi.fn(async (...args: Parameters<typeof fetch>) => {
            void args;
            return new Response(null, { status: 202 });
        });
        const toJSON = vi.fn(() => {
            throw new Error("invalid envelope must not be serialized");
        });
        const invalidEvent = Object.assign(
            { ...buildOperationalErrorEvent("route-error", new Error("private")), eventId },
            { toJSON },
        );

        await expect(deliverOperationalEvent(invalidEvent, configuredEnv, fetchImpl, 250))
            .resolves.toEqual({ status: "rejected" });
        expect(toJSON).not.toHaveBeenCalled();
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("serializes a plain snapshot instead of invoking an envelope toJSON override", async () => {
        const fetchImpl = vi.fn(async (...args: Parameters<typeof fetch>) => {
            void args;
            return new Response(null, { status: 202 });
        });
        const event = buildOperationalErrorEvent("route-error", new Error("private"));
        const toJSON = vi.fn(() => ({ ...event, eventId: "corr_01JABCDEF0123456789" }));
        const spoofedEvent = Object.assign({ ...event }, {
            toJSON,
        });

        await expect(deliverOperationalEvent(spoofedEvent, configuredEnv, fetchImpl, 250))
            .resolves.toEqual({ status: "delivered" });
        expect(toJSON).not.toHaveBeenCalled();
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const init = fetchImpl.mock.calls[0]?.[1];
        expect((init?.headers as Record<string, string>)["x-omr-event-id"]).toBe(event.eventId);
        expect(JSON.parse(String(init?.body))).toMatchObject({ eventId: event.eventId });
    });

    it("reads a stateful event ID getter exactly once and delivers the validated snapshot", async () => {
        const fetchImpl = vi.fn(async (...args: Parameters<typeof fetch>) => {
            void args;
            return new Response(null, { status: 202 });
        });
        const event = buildOperationalErrorEvent("route-error", new Error("private"));
        const statefulEvent = { ...event };
        let accesses = 0;
        Object.defineProperty(statefulEvent, "eventId", {
            enumerable: true,
            get() {
                accesses += 1;
                if (accesses === 1) return event.eventId;
                throw new Error("eventId read more than once");
            },
        });

        await expect(deliverOperationalEvent(statefulEvent, configuredEnv, fetchImpl, 250))
            .resolves.toEqual({ status: "delivered" });
        expect(accesses).toBe(1);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const init = fetchImpl.mock.calls[0]?.[1];
        const headerId = (init?.headers as Record<string, string>)["x-omr-event-id"];
        const bodyId = JSON.parse(String(init?.body)).eventId;
        expect(headerId).toBe(event.eventId);
        expect(bodyId).toBe(event.eventId);
        expect(headerId).toBe(bodyId);
    });

    it("rejects an event ID getter that throws on first access without fetching", async () => {
        const fetchImpl = vi.fn(async (...args: Parameters<typeof fetch>) => {
            void args;
            return new Response(null, { status: 202 });
        });
        const event = buildOperationalErrorEvent("route-error", new Error("private"));
        const unreadableEvent = { ...event };
        let accesses = 0;
        Object.defineProperty(unreadableEvent, "eventId", {
            enumerable: true,
            get() {
                accesses += 1;
                throw new Error("unreadable eventId");
            },
        });

        await expect(deliverOperationalEvent(unreadableEvent, configuredEnv, fetchImpl, 250))
            .resolves.toEqual({ status: "rejected" });
        expect(accesses).toBe(1);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("deep-snapshots runtime errors without invoking nested code or leaking hostile values", async () => {
        const fetchImpl = vi.fn(async (...args: Parameters<typeof fetch>) => {
            void args;
            return new Response(null, { status: 202 });
        });
        const errorToJSON = vi.fn(() => ({ token: "toJSON-token-secret" }));
        const countGetter = vi.fn(() => "getter-private-body");
        const proxyGet = vi.fn(() => {
            throw new Error("proxy-db-error-secret");
        });
        const proxiedStatus = new Proxy({ code: "service_unavailable" }, { get: proxyGet });
        const hostileError = {
            code: "service_unavailable",
            status: proxiedStatus,
            toJSON: errorToJSON,
            name: "김학생",
            email: "student@example.com",
            token: "private-token",
            rawBody: "private request body",
            pdf: "%PDF private content",
            databaseError: "private database detail",
        };
        Object.defineProperty(hostileError, "count", {
            enumerable: true,
            get: countGetter,
        });
        const contextToJSON = vi.fn(() => "context-secret");
        const contextGetter = vi.fn(() => ({ toJSON: contextToJSON }));
        const hostileEvent = {
            ...buildOperationalErrorEvent("route-error", new Error("private")),
            error: hostileError,
        };
        Object.defineProperty(hostileEvent, "context", {
            enumerable: true,
            get: contextGetter,
        });

        await expect(deliverOperationalEvent(hostileEvent as never, configuredEnv, fetchImpl, 250))
            .resolves.toEqual({ status: "delivered" });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(errorToJSON).not.toHaveBeenCalled();
        expect(countGetter).not.toHaveBeenCalled();
        expect(proxyGet).not.toHaveBeenCalled();
        expect(contextGetter).not.toHaveBeenCalled();
        expect(contextToJSON).not.toHaveBeenCalled();
        const body = String(fetchImpl.mock.calls[0]?.[1]?.body);
        expect(JSON.parse(body)).toMatchObject({
            context: "unknown",
            error: { code: "service_unavailable" },
        });
        expect(body).not.toMatch(
            /toJSON-token-secret|getter-private-body|proxy-db-error-secret|김학생|student@example\.com|private-token|private request body|%PDF|private database detail|context-secret/,
        );
    });

    it("preserves already-redacted built-in error diagnostics through delivery", async () => {
        const fetchImpl = vi.fn(async (...args: Parameters<typeof fetch>) => {
            void args;
            return new Response(null, { status: 202 });
        });
        const event = buildOperationalErrorEvent(
            "route-error",
            new TypeError("private student@example.com database path"),
        );

        expect(event.error).toEqual({ name: "TypeError", message: "[REDACTED]" });
        await expect(deliverOperationalEvent(event, configuredEnv, fetchImpl, 250))
            .resolves.toEqual({ status: "delivered" });
        const body = String(fetchImpl.mock.calls[0]?.[1]?.body);
        expect(JSON.parse(body).error).toEqual({ name: "TypeError", message: "[REDACTED]" });
        expect(body).not.toMatch(/student@example\.com|database path/);
    });

    it("preserves an exact normalized error without invoking proxy access or toJSON", async () => {
        const fetchImpl = vi.fn(async (...args: Parameters<typeof fetch>) => {
            void args;
            return new Response(null, { status: 202 });
        });
        const errorToJSON = vi.fn(() => ({ message: "toJSON-private-token" }));
        const proxyGet = vi.fn(() => {
            throw new Error("normalized-proxy-secret");
        });
        const normalizedError = new Proxy({
            name: "TypeError",
            message: "[REDACTED]",
            toJSON: errorToJSON,
        }, { get: proxyGet });
        const event = {
            ...buildOperationalErrorEvent("route-error", new Error("private")),
            error: normalizedError,
        };

        await expect(deliverOperationalEvent(event, configuredEnv, fetchImpl, 250))
            .resolves.toEqual({ status: "delivered" });
        expect(errorToJSON).not.toHaveBeenCalled();
        expect(proxyGet).not.toHaveBeenCalled();
        const body = String(fetchImpl.mock.calls[0]?.[1]?.body);
        expect(JSON.parse(body).error).toEqual({ name: "TypeError", message: "[REDACTED]" });
        expect(body).not.toMatch(/toJSON-private-token|normalized-proxy-secret/);
    });

    it.each([
        { name: "TypeError ", message: "[REDACTED]" },
        { name: "StudentEmailError", message: "[REDACTED]" },
        { name: "TypeError", message: "[REDACTED] " },
        { name: "TypeError", message: "student@example.com raw DB path" },
    ])("drops adversarial normalized-error near-match %#", async error => {
        const fetchImpl = vi.fn(async (...args: Parameters<typeof fetch>) => {
            void args;
            return new Response(null, { status: 202 });
        });
        const event = {
            ...buildOperationalErrorEvent("route-error", new Error("private")),
            error,
        };

        await expect(deliverOperationalEvent(event, configuredEnv, fetchImpl, 250))
            .resolves.toEqual({ status: "delivered" });
        const body = String(fetchImpl.mock.calls[0]?.[1]?.body);
        expect(JSON.parse(body).error).toEqual({});
        expect(body).not.toMatch(/StudentEmailError|student@example\.com|raw DB path/);
    });

    it("does not execute normalized-error accessors", async () => {
        const fetchImpl = vi.fn(async (...args: Parameters<typeof fetch>) => {
            void args;
            return new Response(null, { status: 202 });
        });
        const nameGetter = vi.fn(() => "TypeError");
        const errorToJSON = vi.fn(() => ({ message: "getter-toJSON-secret" }));
        const error = { message: "[REDACTED]", toJSON: errorToJSON };
        Object.defineProperty(error, "name", { enumerable: true, get: nameGetter });
        const event = {
            ...buildOperationalErrorEvent("route-error", new Error("private")),
            error,
        };

        await expect(deliverOperationalEvent(event, configuredEnv, fetchImpl, 250))
            .resolves.toEqual({ status: "delivered" });
        expect(nameGetter).not.toHaveBeenCalled();
        expect(errorToJSON).not.toHaveBeenCalled();
        const body = String(fetchImpl.mock.calls[0]?.[1]?.body);
        expect(JSON.parse(body).error).toEqual({});
        expect(body).not.toContain("getter-toJSON-secret");
    });

    it("deep-snapshots heartbeat metrics from exact numeric data descriptors", async () => {
        const fetchImpl = vi.fn(async (...args: Parameters<typeof fetch>) => {
            void args;
            return new Response(null, { status: 202 });
        });
        const metricsToJSON = vi.fn(() => ({ token: "metrics-token-secret" }));
        const claimedGetter = vi.fn(() => 99);
        const proxyGet = vi.fn(() => {
            throw new Error("metrics-proxy-secret");
        });
        const hostileMetrics = {
            deleted: 2,
            failed: Number.POSITIVE_INFINITY,
            batches: "3",
            unknown: 4,
            rawBody: "metrics-private-body",
            toJSON: metricsToJSON,
        };
        Object.defineProperty(hostileMetrics, "claimed", {
            enumerable: true,
            get: claimedGetter,
        });
        const metricsProxy = new Proxy(hostileMetrics, { get: proxyGet });
        const hostileEvent = {
            ...buildOperationalHeartbeatEvent("asset-gc", "degraded"),
            metrics: metricsProxy,
        };

        await expect(deliverOperationalEvent(hostileEvent as never, configuredEnv, fetchImpl, 250))
            .resolves.toEqual({ status: "delivered" });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(metricsToJSON).not.toHaveBeenCalled();
        expect(claimedGetter).not.toHaveBeenCalled();
        expect(proxyGet).not.toHaveBeenCalled();
        const body = String(fetchImpl.mock.calls[0]?.[1]?.body);
        expect(JSON.parse(body)).toMatchObject({ metrics: { deleted: 2 } });
        expect(JSON.parse(body).metrics).toEqual({ deleted: 2 });
        expect(body).not.toMatch(/metrics-token-secret|metrics-proxy-secret|metrics-private-body|Infinity|"3"/);
    });

    it("enforces the 32 KiB delivery bound using UTF-8 bytes", async () => {
        const fetchImpl = vi.fn(async (...args: Parameters<typeof fetch>) => {
            void args;
            return new Response(null, { status: 202 });
        });
        const encoder = new TextEncoder();
        const baseEvent = buildOperationalErrorEvent("route-error", new Error("private"));
        const emptyErrorBytes = encoder.encode(JSON.stringify({ ...baseEvent, error: "" })).byteLength;
        const underDigits = MAX_OPERATIONAL_EVENT_BYTES - emptyErrorBytes;
        const underEvent = { ...baseEvent, error: BigInt("1".repeat(underDigits)) };
        const overEvent = { ...baseEvent, error: BigInt("1".repeat(underDigits + 1)) };
        const underBytes = encoder.encode(JSON.stringify({ ...baseEvent, error: "1".repeat(underDigits) })).byteLength;
        const overBytes = encoder.encode(JSON.stringify({ ...baseEvent, error: "1".repeat(underDigits + 1) })).byteLength;

        expect(underBytes).toBe(MAX_OPERATIONAL_EVENT_BYTES);
        expect(overBytes).toBe(MAX_OPERATIONAL_EVENT_BYTES + 1);
        await expect(deliverOperationalEvent(underEvent, configuredEnv, fetchImpl, 250))
            .resolves.toEqual({ status: "delivered" });
        await expect(deliverOperationalEvent(overEvent, configuredEnv, fetchImpl, 250))
            .resolves.toEqual({ status: "failed" });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("reports rejection and timeout without exposing provider responses", async () => {
        await expect(deliverOperationalEvent(
            buildOperationalErrorEvent("route-error", new Error("private")),
            configuredEnv,
            async () => new Response("provider secret", { status: 429 }),
            250,
        )).resolves.toEqual({ status: "rejected" });

        vi.useFakeTimers();
        const pending = deliverOperationalEvent(
            buildOperationalErrorEvent("route-error", new Error("private")),
            configuredEnv,
            (_url, init) => new Promise((_resolve, reject) => {
                init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
            }),
            25,
        );
        await vi.advanceTimersByTimeAsync(110);
        await expect(pending).resolves.toEqual({ status: "timeout" });
    });

    it("uses a real delivery as the readiness probe", async () => {
        const fetchImpl = vi.fn(async (...args: Parameters<typeof fetch>) => {
            void args;
            return new Response(null, { status: 204 });
        });
        await expect(probeOperationalEventSink(configuredEnv, fetchImpl, 250))
            .resolves.toBe("ready");
        expect(fetchImpl).toHaveBeenCalledWith(
            "https://ops.example.test/v1/events",
            expect.objectContaining({
                method: "HEAD",
                body: undefined,
                redirect: "error",
            }),
        );
        expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({
            authorization: "Bearer ops_sink_token_0123456789_abcdef",
            "x-omr-probe": "readiness",
        });
    });
});
