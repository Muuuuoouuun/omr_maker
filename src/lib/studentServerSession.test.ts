import { describe, expect, it } from "vitest";
import {
    createSignedStudentSessionCookie,
    parseSignedStudentSessionCookie,
    shouldUseSecureStudentSessionCookie,
    STUDENT_SERVER_SESSION_MAX_AGE_SECONDS,
} from "./studentServerSession";

const env = { NODE_ENV: "production", STUDENT_SESSION_SECRET: "student-session-test-secret" };
const identity = {
    organizationId: "org-1",
    studentId: "student-1",
    studentName: "김학생",
    identityType: "registered" as const,
    groupId: "class-a",
    groupName: "A반",
};

describe("student server session", () => {
    it("round-trips a signed organization and class-bound identity", () => {
        const cookie = createSignedStudentSessionCookie(identity, env, 1_000);
        expect(cookie).toBeTruthy();
        expect(parseSignedStudentSessionCookie(cookie, env, 2_000)).toMatchObject(identity);
    });

    it("rejects tampering, wrong secrets, future sessions, and expiry", () => {
        const cookie = createSignedStudentSessionCookie(identity, env, 1_000)!;
        const [payload, signature] = cookie.split(".");
        expect(parseSignedStudentSessionCookie(`${payload}x.${signature}`, env, 2_000)).toBeNull();
        expect(parseSignedStudentSessionCookie(cookie, { ...env, STUDENT_SESSION_SECRET: "wrong" }, 2_000)).toBeNull();
        expect(parseSignedStudentSessionCookie(cookie, env, 1_000 + STUDENT_SERVER_SESSION_MAX_AGE_SECONDS * 1000 + 1)).toBeNull();

        const futureCookie = createSignedStudentSessionCookie(identity, env, 100_000)!;
        expect(parseSignedStudentSessionCookie(futureCookie, env, 1_000)).toBeNull();
    });

    it("fails closed without an explicit production secret and uses secure cookies off localhost", () => {
        expect(createSignedStudentSessionCookie(identity, { NODE_ENV: "production" }, 1_000)).toBeNull();
        expect(shouldUseSecureStudentSessionCookie("omr.example.com", env)).toBe(true);
        expect(shouldUseSecureStudentSessionCookie("localhost:3003", env)).toBe(false);
    });
});
