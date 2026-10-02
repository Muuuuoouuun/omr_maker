import { describe, expect, it } from "vitest";
import {
    buildStudentLoginRateLimitKeys,
    checkStudentLoginRateLimit,
    recordStudentLoginFailure,
    recordStudentLoginSuccess,
    STUDENT_LOGIN_LOCKOUT_MS,
    STUDENT_LOGIN_MAX_FAILURES,
    type StudentLoginRateLimitStore,
} from "./studentLoginRateLimit";

describe("student login rate limit", () => {
    it("locks both identity and client tiers after repeated failures", () => {
        const store: StudentLoginRateLimitStore = new Map();
        const keys = buildStudentLoginRateLimitKeys({ workspaceId: "w1", studentLookup: "s1", clientFingerprint: "client-a" });
        for (let index = 0; index < STUDENT_LOGIN_MAX_FAILURES; index += 1) {
            recordStudentLoginFailure(keys, store, 1_000 + index);
        }
        expect(checkStudentLoginRateLimit(keys, store, 2_000).allowed).toBe(false);
        expect(checkStudentLoginRateLimit(keys, store, 1_000 + STUDENT_LOGIN_LOCKOUT_MS + 10).allowed).toBe(true);
    });

    it("clears the current identity budget after a successful login", () => {
        const store: StudentLoginRateLimitStore = new Map();
        const keys = buildStudentLoginRateLimitKeys({ workspaceId: "w1", studentLookup: "s1", clientFingerprint: "client-a" });
        recordStudentLoginFailure(keys, store, 1_000);
        recordStudentLoginSuccess(keys, store);
        expect(store.size).toBe(0);
    });

    it("locks one student lookup even when the client fingerprint rotates", () => {
        const store: StudentLoginRateLimitStore = new Map();
        for (let attempt = 0; attempt < STUDENT_LOGIN_MAX_FAILURES; attempt += 1) {
            recordStudentLoginFailure(buildStudentLoginRateLimitKeys({
                workspaceId: "w1",
                studentLookup: "s1",
                clientFingerprint: `rotating-client-${attempt}`,
            }), store, 1_000 + attempt);
        }

        expect(checkStudentLoginRateLimit(buildStudentLoginRateLimitKeys({
            workspaceId: "w1",
            studentLookup: "s1",
            clientFingerprint: "fresh-client",
        }), store, 2_000).allowed).toBe(false);
    });

    it("does not share a five-attempt budget across different students behind one NAT", () => {
        const firstStudent = new Set(buildStudentLoginRateLimitKeys({
            workspaceId: "w1",
            studentLookup: "student-1",
            clientFingerprint: "academy-nat",
        }));
        const secondStudent = buildStudentLoginRateLimitKeys({
            workspaceId: "w1",
            studentLookup: "student-2",
            clientFingerprint: "academy-nat",
        });

        expect(secondStudent.filter(key => firstStudent.has(key))).toEqual([]);
    });

    it("does not expose raw workspace, lookup, or client values in keys", () => {
        const keys = buildStudentLoginRateLimitKeys({ workspaceId: "secret-workspace", studentLookup: "student@example.com", clientFingerprint: "10.0.0.1" });
        expect(keys).toHaveLength(1);
        expect(keys[0]).toMatch(/^student-login:identity:[a-f0-9]{64}$/);
        expect(keys.join(" ")).not.toContain("secret-workspace");
        expect(keys.join(" ")).not.toContain("student@example.com");
        expect(keys.join(" ")).not.toContain("10.0.0.1");
    });
});
