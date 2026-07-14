import { describe, expect, it } from "vitest";
import {
    AI_ACTION_MAX_REQUESTS,
    AI_ACTION_WINDOW_MS,
    AI_ACTION_RATE_LIMIT_ERROR,
    AI_ACTION_UNAUTHORIZED_ERROR,
    authorizeTeacherAiActionRequest,
    buildAiActionRateLimitKey,
    consumeAiActionRateLimit,
    type AiActionRateLimitStore,
} from "./aiActionSecurity";
import { SERVER_ACTION_ORIGIN_ERROR } from "./serverActionSecurity";
import { createSignedTeacherSessionCookie } from "./teacherServerSession";

describe("AI action security", () => {
    const teacherToken = "tkn_abc123_0123456789abcdef0123456789abcdef";

    it("builds stable, non-plaintext keys per teacher and client", () => {
        const first = buildAiActionRateLimitKey("Teacher-A", "203.0.113.4");
        expect(first).toBe(buildAiActionRateLimitKey("teacher-a", "203.0.113.4"));
        expect(first).not.toContain("teacher-a");
        expect(first).not.toContain("203.0.113.4");
        expect(first).not.toBe(buildAiActionRateLimitKey("teacher-b", "203.0.113.4"));
    });

    it("blocks requests over the fixed-window allowance", () => {
        const store: AiActionRateLimitStore = new Map();
        const key = buildAiActionRateLimitKey("teacher-a", "client-a");

        for (let request = 0; request < AI_ACTION_MAX_REQUESTS; request += 1) {
            expect(consumeAiActionRateLimit(key, store, 1_000).allowed).toBe(true);
        }

        expect(consumeAiActionRateLimit(key, store, 1_000)).toEqual({
            allowed: false,
            retryAfterMs: AI_ACTION_WINDOW_MS,
        });
    });

    it("starts a fresh allowance after the window expires", () => {
        const store: AiActionRateLimitStore = new Map();
        const key = buildAiActionRateLimitKey("teacher-a", "client-a");
        for (let request = 0; request < AI_ACTION_MAX_REQUESTS; request += 1) {
            consumeAiActionRateLimit(key, store, 1_000);
        }

        expect(consumeAiActionRateLimit(key, store, 1_000 + AI_ACTION_WINDOW_MS)).toEqual({
            allowed: true,
            retryAfterMs: 0,
        });
    });

    it("rejects cross-origin and unsigned requests before consuming AI quota", () => {
        const env = { NODE_ENV: "production", TEACHER_SESSION_SECRET: "test-secret" };
        const cookie = createSignedTeacherSessionCookie(teacherToken, { teacherId: "teacher-a" }, env, 1_000);
        const store: AiActionRateLimitStore = new Map();

        expect(authorizeTeacherAiActionRequest(
            new Headers({ host: "app.example.com", origin: "https://evil.example.com" }),
            cookie,
            env,
            store,
            1_000,
        )).toEqual({ allowed: false, error: SERVER_ACTION_ORIGIN_ERROR });
        expect(authorizeTeacherAiActionRequest(
            new Headers({ host: "app.example.com", origin: "https://app.example.com" }),
            null,
            env,
            store,
            1_000,
        )).toEqual({ allowed: false, error: AI_ACTION_UNAUTHORIZED_ERROR });
        expect(store.size).toBe(0);
    });

    it("authorizes a signed same-origin teacher and enforces the request limit", () => {
        const env = { NODE_ENV: "production", TEACHER_SESSION_SECRET: "test-secret" };
        const cookie = createSignedTeacherSessionCookie(teacherToken, { teacherId: "teacher-a" }, env, 1_000);
        const headers = new Headers({
            host: "app.example.com",
            origin: "https://app.example.com",
            "x-forwarded-for": "203.0.113.4",
        });
        const store: AiActionRateLimitStore = new Map();

        for (let request = 0; request < AI_ACTION_MAX_REQUESTS; request += 1) {
            expect(authorizeTeacherAiActionRequest(headers, cookie, env, store, 1_000)).toEqual({
                allowed: true,
            });
        }

        expect(authorizeTeacherAiActionRequest(headers, cookie, env, store, 1_000)).toEqual({
            allowed: false,
            error: AI_ACTION_RATE_LIMIT_ERROR,
            retryAfterMs: AI_ACTION_WINDOW_MS,
        });
    });
});
