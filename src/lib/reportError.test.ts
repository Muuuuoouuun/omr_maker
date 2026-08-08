import { afterEach, describe, expect, it, vi } from "vitest";
import {
    buildOperationalErrorEvent,
    redactOperationalError,
    reportError,
} from "./reportError";

describe("structured operational errors", () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });

    it("recursively redacts credentials, identity, cookies, tokens, and raw payloads", () => {
        const serialized = JSON.stringify(redactOperationalError({
            password: "secret-password",
            token: "secret-token",
            cookie: "session=secret-cookie",
            studentName: "김학생",
            email: "student@example.com",
            payload: { answers: [1, 2, 3] },
            code: "initial_capacity_exceeded",
            rawMessage: "database failed for 김학생 with password hunter2",
            nested: { authorization: "Bearer private" },
            count: 2,
        }));

        for (const secret of [
            "secret-password",
            "secret-token",
            "secret-cookie",
            "김학생",
            "student@example.com",
            "answers",
            "Bearer private",
            "hunter2",
        ]) expect(serialized).not.toContain(secret);
        expect(serialized).toContain("initial_capacity_exceeded");
        expect(serialized).toContain('"count":2');
    });

    it("builds a stable bounded event while preserving safe caller correlation", () => {
        vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "ABC123DEF456");
        const event = buildOperationalErrorEvent("student-submit", new Error("failed for student@example.com"), {
            correlationId: "req_1234",
            deploymentId: "dpl_456",
            now: new Date("2026-08-06T01:02:03.000Z"),
        });
        expect(event).toMatchObject({
            event: "omr.runtime_error",
            context: "student-submit",
            eventId: expect.stringMatching(/^evt_[a-f0-9]{32}$/),
            correlationId: "req_1234",
            buildSha: "abc123def456",
            severity: "error",
            timestamp: "2026-08-06T01:02:03.000Z",
            error: { name: "Error" },
        });
        expect(event.eventId).not.toBe(event.correlationId);
        expect(event).not.toHaveProperty("deploymentId");
        expect(JSON.stringify(event)).not.toMatch(/student@example\.com|dpl_456/);
    });

    it("emits exactly one JSON line", () => {
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
        reportError("route-error", { password: "private", code: "E_FAIL" }, { correlationId: "req_fixed" });
        expect(consoleError).toHaveBeenCalledTimes(1);
        expect(consoleError).toHaveBeenCalledWith(expect.any(String));
        const line = String(consoleError.mock.calls[0][0]);
        expect(line).not.toContain("\n");
        expect(JSON.parse(line)).toMatchObject({
            event: "omr.runtime_error",
            context: "route-error",
            correlationId: "req_fixed",
            error: { code: "E_FAIL" },
        });
    });

    it("never logs token-shaped values, attacker-controlled keys, or unbounded keys", () => {
        const hugeKey = "x".repeat(1_000_000);
        const serialized = JSON.stringify(redactOperationalError({
            message: "sk_live_SUPERSECRET123",
            "student@example.com": 1,
            [hugeKey]: 2,
            code: "initial_capacity_exceeded",
        }));
        expect(serialized).not.toContain("SUPERSECRET");
        expect(serialized).not.toContain("student@example.com");
        expect(serialized.length).toBeLessThan(1_000);
        expect(serialized).toContain("initial_capacity_exceeded");
    });

    it("cannot throw while reporting hostile getters or proxies", () => {
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const hostile = Object.defineProperty({}, "code", {
            enumerable: true,
            get() { throw new Error("getter-boom"); },
        });
        expect(() => reportError("hostile", hostile, { correlationId: "req_hostile" })).not.toThrow();
        expect(consoleError).toHaveBeenCalledTimes(1);
        expect(String(consoleError.mock.calls[0][0])).not.toContain("getter-boom");
    });

    it("cannot throw or serialize secrets from hostile Error fields and option proxies", () => {
        const hostileError = new Error("safe constructor message");
        Object.defineProperties(hostileError, {
            name: { get() { throw new Error("error-name-secret"); } },
            message: { get() { throw new Error("error-message-secret"); } },
        });
        const hostileOptions = new Proxy({}, {
            get() { throw new Error("option-getter-secret"); },
            ownKeys() { throw new Error("option-ownkeys-secret"); },
        });

        let event: unknown;
        expect(() => {
            event = buildOperationalErrorEvent(
                "sk_live_context_secret",
                hostileError,
                hostileOptions as never,
            );
        }).not.toThrow();
        const serialized = JSON.stringify(event);
        expect(serialized).not.toMatch(/error-name-secret|error-message-secret|option-getter-secret|option-ownkeys-secret|sk_live_context_secret/);
        expect(event).toMatchObject({
            event: "omr.runtime_error",
            context: "unknown",
            error: { name: "Error", message: "[REDACTED]" },
        });
    });

    it("strictly sanitizes attacker-controlled context and diagnostic identifiers", () => {
        const event = buildOperationalErrorEvent(
            "Bearer private-context-token",
            Object.assign(new Error("sk_live_message_secret"), { name: "sk_live_error_name_secret" }),
            {
                correlationId: "req_sk_live_correlation_secret",
                deploymentId: "dpl_token_deployment_secret",
                now: new Date("2026-08-06T01:02:03.000Z"),
            },
        );
        const serialized = JSON.stringify(event);
        expect(serialized).not.toMatch(/private-context-token|live_message_secret|live_error_name_secret|live_correlation_secret|deployment_secret/);
        expect(event).toMatchObject({
            context: "unknown",
            correlationId: expect.stringMatching(/^evt_[a-f0-9]{32}$/),
            error: { name: "Error", message: "[REDACTED]" },
        });
        expect(event).not.toHaveProperty("deploymentId");
    });

    it.each([
        ["AWS-shaped", "AKIAIOSFODNN7EXAMPLE"],
        ["GitHub-shaped", "ghp1234567890abcdefghijklmnopqrstuvwxyz"],
    ])("never serializes %s caller identifiers", (_label, credential) => {
        const event = buildOperationalErrorEvent("route-error-boundary", new Error("timeout"), {
            correlationId: `req_${credential}`,
            deploymentId: `dpl_${credential}`,
            now: new Date("2026-08-06T01:02:03.000Z"),
        });
        const serialized = JSON.stringify(event);

        expect(serialized).not.toContain(credential);
        expect(event.correlationId).toMatch(/^evt_[a-f0-9]{32}$/);
        expect(event).not.toHaveProperty("deploymentId");
    });

    it("preserves a generic safe opaque caller identifier", () => {
        const correlationId = "req_Qx9Lm2Np7Vr4Ws8Yt6Za3Bc5De1Fg0Hi";
        const event = buildOperationalErrorEvent("route-error-boundary", new Error("timeout"), {
            correlationId,
            now: new Date("2026-08-06T01:02:03.000Z"),
        });

        expect(event.correlationId).toBe(correlationId);
        expect(event.eventId).not.toBe(correlationId);
    });

    it("does not serialize an internally sourced deployment credential", () => {
        vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_AKIAIOSFODNN7EXAMPLE");
        vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "");
        vi.stubEnv("GIT_SHA", "");
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

        reportError("route-error-boundary", new Error("timeout"));

        const line = String(consoleError.mock.calls[0]?.[0]);
        expect(line).not.toContain("AKIAIOSFODNN7EXAMPLE");
        expect(JSON.parse(line)).not.toHaveProperty("deploymentId");
        expect(JSON.parse(line)).toMatchObject({ buildSha: "unknown" });
    });

    it("retains only allowlisted built-in error names as useful diagnostics", () => {
        expect(buildOperationalErrorEvent("route-error-boundary", new TypeError("private detail")))
            .toMatchObject({ error: { name: "TypeError", message: "[REDACTED]" } });
    });

    it("remains nonthrowing when both primary and fallback console sinks throw", () => {
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => {
            throw new Error("console-sink-secret");
        });

        expect(() => reportError("route-error-boundary", new Error("runtime-secret"))).not.toThrow();
        expect(consoleError).toHaveBeenCalledTimes(2);
    });
});
