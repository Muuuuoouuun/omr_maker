import { describe, expect, it, vi } from "vitest";
import { deliverOperationalEvent } from "./operationalEventSink.server";
import { buildOperationalErrorEvent } from "./reportError";

const configuredEnv = {
    NODE_ENV: "production",
    OMR_OPERATIONAL_SINK_URL: "https://ops.example.test/v1/events",
    OMR_OPERATIONAL_SINK_TOKEN: "ops_sink_token_0123456789_abcdef",
};

// Regression: ISSUE-OPS-001 — one transient sink response dropped the only central error event.
// Found by /qa on 2026-08-07.
// Report: docs/initial-ops-user-journey-audit-2026-08-07.md
describe("operational event sink transient retry", () => {
    it("retries one transient response with the same bounded event identity", async () => {
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(new Response(null, { status: 503 }))
            .mockResolvedValueOnce(new Response(null, { status: 202 }));
        const event = buildOperationalErrorEvent("student-submit", { code: "service_unavailable" });

        await expect(deliverOperationalEvent(event, configuredEnv, fetchImpl, 250))
            .resolves.toEqual({ status: "delivered" });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        const firstHeaders = fetchImpl.mock.calls[0]?.[1]?.headers as Record<string, string>;
        const secondHeaders = fetchImpl.mock.calls[1]?.[1]?.headers as Record<string, string>;
        expect(firstHeaders["x-omr-event-id"]).toBe(event.correlationId);
        expect(secondHeaders["x-omr-event-id"]).toBe(event.correlationId);
        expect(fetchImpl.mock.calls[0]?.[1]?.body).toBe(fetchImpl.mock.calls[1]?.[1]?.body);
    });

    it("does not retry a permanent client rejection", async () => {
        const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 400 }));

        await expect(deliverOperationalEvent(
            buildOperationalErrorEvent("route-error", { code: "service_unavailable" }),
            configuredEnv,
            fetchImpl,
            250,
        )).resolves.toEqual({ status: "rejected" });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
});
