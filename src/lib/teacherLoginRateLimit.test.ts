import { describe, expect, it } from "vitest";
import {
    buildTeacherLoginRateLimitKeys,
    checkTeacherLoginRateLimit,
    recordTeacherLoginFailure,
    recordTeacherLoginSuccess,
    TEACHER_LOGIN_LOCKOUT_MS,
    TEACHER_LOGIN_MAX_FAILURES,
    TEACHER_LOGIN_WINDOW_MS,
    type TeacherLoginRateLimitStore,
} from "./teacherLoginRateLimit";

describe("teacher login rate limit", () => {
    it("builds hashed keys without storing raw identifiers or client fingerprints", () => {
        const keys = buildTeacherLoginRateLimitKeys("Director@School.test", "203.0.113.9");

        expect(keys).toHaveLength(1);
        expect(keys[0]).toMatch(/^teacher-login:identifier:[a-f0-9]{64}$/);
        expect(keys.join(" ")).not.toContain("Director");
        expect(keys.join(" ")).not.toContain("203.0.113.9");
    });

    it("locks one teacher identifier even when the client fingerprint rotates", () => {
        const store: TeacherLoginRateLimitStore = new Map();
        for (let attempt = 0; attempt < TEACHER_LOGIN_MAX_FAILURES; attempt += 1) {
            recordTeacherLoginFailure(
                buildTeacherLoginRateLimitKeys("admin", `rotating-client-${attempt}`),
                store,
                1_000 + attempt,
            );
        }

        expect(checkTeacherLoginRateLimit(
            buildTeacherLoginRateLimitKeys("admin", "fresh-client"),
            store,
            2_000,
        ).allowed).toBe(false);
    });

    it("does not share a five-attempt budget across different teachers behind one NAT", () => {
        const firstTeacher = new Set(buildTeacherLoginRateLimitKeys("teacher-a", "academy-nat"));
        const secondTeacher = buildTeacherLoginRateLimitKeys("teacher-b", "academy-nat");

        expect(secondTeacher.filter(key => firstTeacher.has(key))).toEqual([]);
    });

    it("allows the first failures and then locks the same identifier/client window", () => {
        const store: TeacherLoginRateLimitStore = new Map();
        const keys = buildTeacherLoginRateLimitKeys("admin", "client-a");
        const now = 1_000;

        for (let attempt = 0; attempt < TEACHER_LOGIN_MAX_FAILURES; attempt++) {
            expect(checkTeacherLoginRateLimit(keys, store, now + attempt).allowed).toBe(true);
            recordTeacherLoginFailure(keys, store, now + attempt);
        }

        const blocked = checkTeacherLoginRateLimit(keys, store, now + TEACHER_LOGIN_MAX_FAILURES);
        expect(blocked.allowed).toBe(false);
        expect(blocked.retryAfterMs).toBeGreaterThan(0);
    });

    it("clears failed attempts after a successful login", () => {
        const store: TeacherLoginRateLimitStore = new Map();
        const keys = buildTeacherLoginRateLimitKeys("admin", "client-a");

        recordTeacherLoginFailure(keys, store, 1_000);
        expect(store.size).toBe(1);

        recordTeacherLoginSuccess(keys, store);
        expect(store.size).toBe(0);
        expect(checkTeacherLoginRateLimit(keys, store, 2_000).allowed).toBe(true);
    });

    it("allows attempts again after the lockout expires", () => {
        const store: TeacherLoginRateLimitStore = new Map();
        const keys = buildTeacherLoginRateLimitKeys("admin", "client-a");

        for (let attempt = 0; attempt < TEACHER_LOGIN_MAX_FAILURES; attempt++) {
            recordTeacherLoginFailure(keys, store, 1_000 + attempt);
        }

        const finalFailureAt = 1_000 + TEACHER_LOGIN_MAX_FAILURES - 1;
        expect(checkTeacherLoginRateLimit(keys, store, 2_000).allowed).toBe(false);
        expect(checkTeacherLoginRateLimit(keys, store, finalFailureAt + TEACHER_LOGIN_LOCKOUT_MS + 1).allowed).toBe(true);
    });

    it("starts a fresh window when old failures age out", () => {
        const store: TeacherLoginRateLimitStore = new Map();
        const keys = buildTeacherLoginRateLimitKeys("admin", "client-a");

        recordTeacherLoginFailure(keys, store, 1_000);
        expect(checkTeacherLoginRateLimit(keys, store, 1_000 + TEACHER_LOGIN_WINDOW_MS + 1).allowed).toBe(true);
        expect(store.size).toBe(0);
    });
});
