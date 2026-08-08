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

const configuredEnv = {
    NODE_ENV: "production",
    OMR_OPERATIONAL_SINK_URL: "https://ops.example.test/v1/events",
    OMR_OPERATIONAL_SINK_TOKEN: "ops_sink_token_0123456789_abcdef",
};

describe("operational event sink", () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.useRealTimers();
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
        expect(buildOperationalHeartbeatEvent("asset-gc", "ok"))
            .toMatchObject({ event: "omr.job_heartbeat", severity: "info" });
        expect(buildOperationalHeartbeatEvent("asset-gc", "degraded"))
            .toMatchObject({ event: "omr.job_heartbeat", severity: "warning" });
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
        expect(String(init?.body)).not.toContain("never-send-this");
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
