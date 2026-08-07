import { afterEach, describe, expect, it, vi } from "vitest";
import {
    deliverOperationalEvent,
    operationalEventSinkConfiguration,
    probeOperationalEventSink,
} from "./operationalEventSink.server";
import { buildOperationalErrorEvent } from "./reportError";

const configuredEnv = {
    NODE_ENV: "production",
    OMR_OPERATIONAL_SINK_URL: "https://ops.example.test/v1/events",
    OMR_OPERATIONAL_SINK_TOKEN: "ops_sink_token_0123456789_abcdef",
};

describe("operational event sink", () => {
    afterEach(() => vi.useRealTimers());

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
        const fetchImpl = vi.fn(async (
            _input: Parameters<typeof fetch>[0],
            _init?: Parameters<typeof fetch>[1],
        ) => new Response(null, { status: 202 }));
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
        const fetchImpl = vi.fn(async (
            _input: Parameters<typeof fetch>[0],
            _init?: Parameters<typeof fetch>[1],
        ) => new Response(null, { status: 204 }));
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
