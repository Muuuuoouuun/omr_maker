import { describe, expect, it } from "vitest";
import {
    createSignedTeacherSessionCookie,
    parseSignedTeacherSessionCookie,
    resolveTeacherSessionSecret,
    shouldUseSecureTeacherSessionCookie,
    TEACHER_SERVER_SESSION_COOKIE,
    TEACHER_SERVER_SESSION_MAX_AGE_SECONDS,
} from "./teacherServerSession";

const TOKEN = "tkn_abc123_0123456789abcdef0123456789abcdef";
const env = { NODE_ENV: "production", TEACHER_SESSION_SECRET: "server-secret" };

describe("teacher server session", () => {
    it("resolves an explicit session secret and fails closed in production", () => {
        expect(resolveTeacherSessionSecret({
            NODE_ENV: "production",
            TEACHER_SESSION_SECRET: " session-secret ",
            TEACHER_PASSWORD: "password-secret",
        })).toBe("session-secret");
        // Production requires a dedicated secret: it must never fall back to a
        // credential value (password / accounts JSON) — that would let anyone
        // who learns the password forge a session cookie.
        expect(resolveTeacherSessionSecret({
            NODE_ENV: "production",
            TEACHER_PASSWORD: "password-secret",
        })).toBeNull();
        expect(resolveTeacherSessionSecret({
            NODE_ENV: "production",
            TEACHER_ACCOUNTS: "[{\"id\":\"a\"}]",
        })).toBeNull();
        // Non-production keeps the credential fallback for convenience.
        expect(resolveTeacherSessionSecret({
            NODE_ENV: "development",
            TEACHER_PASSWORD: "password-secret",
        })).toBe("password-secret");
        expect(resolveTeacherSessionSecret({ NODE_ENV: "development" })).toBe("dev-teacher-session-secret");
        expect(resolveTeacherSessionSecret({ NODE_ENV: "production" })).toBeNull();
    });

    it("signs and verifies a teacher session cookie with identity", () => {
        const cookie = createSignedTeacherSessionCookie(TOKEN, {
            teacherId: "teacher-a",
            email: "a@example.com",
            displayName: "A Teacher",
            organizationId: "teacher_sharedqa",
            organizationName: "OMR Maker 테스트",
            memberRole: "teacher",
            plan: "pro",
        }, env, 1000);

        expect(cookie).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
        expect(parseSignedTeacherSessionCookie(cookie, env, 1000)).toMatchObject({
            role: "teacher",
            token: TOKEN,
            teacherId: "teacher-a",
            email: "a@example.com",
            displayName: "A Teacher",
            organizationId: "teacher_sharedqa",
            organizationName: "OMR Maker 테스트",
            memberRole: "teacher",
            plan: "pro",
        });
    });

    it("rejects tampered, wrong-secret, and expired cookies", () => {
        const cookie = createSignedTeacherSessionCookie(TOKEN, { teacherId: "teacher-a" }, env, 1000);
        expect(cookie).toBeTruthy();
        const [payload, signature] = cookie!.split(".");

        expect(parseSignedTeacherSessionCookie(`${payload}x.${signature}`, env, 1000)).toBeNull();
        expect(parseSignedTeacherSessionCookie(cookie, { NODE_ENV: "production", TEACHER_SESSION_SECRET: "other" }, 1000)).toBeNull();
        expect(parseSignedTeacherSessionCookie(cookie, env, 1000 + TEACHER_SERVER_SESSION_MAX_AGE_SECONDS * 1000 + 1)).toBeNull();
    });

    it("keeps secure cookies for production domains while allowing localhost QA", () => {
        expect(shouldUseSecureTeacherSessionCookie("omr.example.com", env)).toBe(true);
        expect(shouldUseSecureTeacherSessionCookie("localhost:3004", env)).toBe(false);
        expect(shouldUseSecureTeacherSessionCookie("127.0.0.1:3004", env)).toBe(false);
        expect(shouldUseSecureTeacherSessionCookie("[::1]:3004", env)).toBe(false);
        expect(shouldUseSecureTeacherSessionCookie("omr.localhost:3004", env)).toBe(false);
        expect(shouldUseSecureTeacherSessionCookie("omr.example.com", { NODE_ENV: "development" })).toBe(false);
        // The insecure-cookie override is ignored in production so it can never
        // drop the Secure flag on a real production domain.
        expect(shouldUseSecureTeacherSessionCookie("omr.example.com", {
            NODE_ENV: "production",
            OMR_ALLOW_INSECURE_TEACHER_COOKIE_FOR_LOCAL_E2E: "true",
        })).toBe(true);
        // Non-production still honors it (and is insecure regardless).
        expect(shouldUseSecureTeacherSessionCookie("omr.example.com", {
            NODE_ENV: "development",
            OMR_ALLOW_INSECURE_TEACHER_COOKIE_FOR_LOCAL_E2E: "true",
        })).toBe(false);
    });

    it("exports the stable cookie name used by server guards", () => {
        expect(TEACHER_SERVER_SESSION_COOKIE).toBe("omr_teacher_server_session");
    });
});
