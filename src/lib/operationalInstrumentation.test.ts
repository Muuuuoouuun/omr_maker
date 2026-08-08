import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    rateLimit: vi.fn(),
    reportError: vi.fn(),
}));

vi.mock("@/lib/durableRateLimit", () => ({
    applyDurableRateLimitToSubjects: mocks.rateLimit,
}));

vi.mock("@/lib/reportServerError", () => ({
    reportServerError: mocks.reportError,
}));

import { POST } from "@/app/api/internal/operational-events/client/route";

function request(body: string, headers: Record<string, string> = {}): Request {
    return new Request("https://app.example.test/api/internal/operational-events/client", {
        method: "POST",
        headers: {
            host: "app.example.test",
            origin: "https://app.example.test",
            "content-type": "application/json",
            ...headers,
        },
        body,
    });
}

describe("global operational instrumentation", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.rateLimit.mockResolvedValue({ allowed: true, retryAfterMs: 0 });
        mocks.reportError.mockResolvedValue({ status: "scheduled" });
    });

    it("accepts only a bounded error kind and allowlisted name", async () => {
        const response = await POST(request(JSON.stringify({ kind: "error", name: "TypeError" })));
        expect(response.status).toBe(202);
        await expect(response.json()).resolves.toEqual({ status: "accepted" });
        expect(mocks.reportError).toHaveBeenCalledWith(
            "client-runtime-error",
            expect.objectContaining({ name: "TypeError" }),
        );
    });

    it.each([
        { kind: "error", name: "TypeError", message: "private student payload" },
        { kind: "error", name: "CustomPrivateError" },
        { kind: "other", name: "Error" },
        { kind: "error", name: "Error", severity: "critical" },
        { kind: "error", name: "Error", correlationId: "corr_01JABCDEF0123456789" },
        { kind: "error", name: "Error", eventId: "evt_attacker_controlled_event_id" },
        { kind: "error", name: "Error", email: "student@example.com", answers: [1, 2, 3] },
    ])("rejects attacker-controlled client payload fields", async body => {
        const response = await POST(request(JSON.stringify(body)));
        expect(response.status).toBe(400);
        expect(mocks.reportError).not.toHaveBeenCalled();
        expect(mocks.rateLimit).not.toHaveBeenCalled();
    });

    it("rejects cross-origin, oversized, and rate-limited reports", async () => {
        expect((await POST(request("{}", { origin: "https://evil.example" }))).status).toBe(403);
        expect((await POST(new Request("https://app.example.test/api/internal/operational-events/client", {
            method: "POST",
            headers: { host: "app.example.test", "content-type": "application/json" },
            body: JSON.stringify({ kind: "error", name: "Error" }),
        }))).status).toBe(403);
        expect((await POST(request("{}", { "content-length": "2048" }))).status).toBe(413);
        expect((await POST(request("x".repeat(2_048)))).status).toBe(413);
        expect(mocks.rateLimit).not.toHaveBeenCalled();
        mocks.rateLimit.mockResolvedValueOnce({ allowed: false, retryAfterMs: 60_000 });
        expect((await POST(request(JSON.stringify({ kind: "error", name: "Error" })))).status).toBe(429);
        expect(mocks.rateLimit).toHaveBeenCalledTimes(1);
        expect(mocks.rateLimit).toHaveBeenCalledWith(expect.objectContaining({
            subjects: ["unknown-client"],
            policy: { limit: 6, windowMs: 60_000 },
        }));
    });

    it("ships server and browser hooks without serializing client messages or paths", () => {
        const server = readFileSync(resolve(process.cwd(), "src/instrumentation.ts"), "utf8");
        const client = readFileSync(resolve(process.cwd(), "src/instrumentation-client.ts"), "utf8");
        expect(server).toContain("onRequestError");
        expect(server).toContain('reportServerError("server-request-error", error)');
        expect(client).toContain('let remainingReports = 3');
        expect(client).toContain('body: JSON.stringify({ kind, name: safeErrorName(value) })');
        expect(client).not.toMatch(/\.message|location\.|pathname|href/);
        expect(client).not.toContain("OMR_OPERATIONAL_SINK_TOKEN");
        for (const serverOnlyPath of [
            "src/lib/operationalEventSink.server.ts",
            "src/lib/reportServerError.ts",
        ]) {
            expect(readFileSync(resolve(process.cwd(), serverOnlyPath), "utf8"))
                .toContain('import "next/dist/compiled/server-only"');
        }
    });
});
