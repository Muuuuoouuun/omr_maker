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

    it("does not expose raw workspace, lookup, or client values in keys", () => {
        const keys = buildStudentLoginRateLimitKeys({ workspaceId: "secret-workspace", studentLookup: "student@example.com", clientFingerprint: "10.0.0.1" });
        expect(keys.join(" ")).not.toContain("secret-workspace");
        expect(keys.join(" ")).not.toContain("student@example.com");
        expect(keys.join(" ")).not.toContain("10.0.0.1");
    });
});
