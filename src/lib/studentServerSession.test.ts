import { describe, expect, it } from "vitest";
import {
    createSignedStudentSessionCookie,
    parseSignedStudentSessionCookie,
    resolveStudentSessionSecret,
    shouldUseSecureStudentSessionCookie,
    STUDENT_SERVER_SESSION_MAX_AGE_SECONDS,
    type StudentIdentityInput,
} from "./studentServerSession";

const GUEST: StudentIdentityInput = { kind: "guest", guestId: "g-123", name: "Guest Student", identityType: "guest" };
const STUDENT: StudentIdentityInput = {
    kind: "student", studentId: "grp1::김철수", name: "김철수",
    organizationId: "teacher_abc", groupId: "grp1", groupName: "1반", identityType: "temporary",
};
const ENV = { STUDENT_SESSION_SECRET: "test-secret", NODE_ENV: "test" } as Record<string, string>;
const productionEnv = { NODE_ENV: "production", STUDENT_SESSION_SECRET: "student-session-test-secret" };
const registeredIdentity = {
    organizationId: "org-1",
    studentId: "student-1",
    studentName: "김학생",
    identityType: "registered" as const,
    groupId: "class-a",
    groupName: "A반",
};

describe("studentServerSession", () => {
    it("resolves the dedicated secret, the attempt-secret fallback, and fails closed in production", () => {
        expect(resolveStudentSessionSecret({ STUDENT_SESSION_SECRET: " s " })).toBe("s");
        expect(resolveStudentSessionSecret({ STUDENT_ATTEMPT_SECRET: " attempt " })).toBe("attempt");
        expect(resolveStudentSessionSecret({ NODE_ENV: "development" })).toBe("dev-student-session-secret");
        expect(resolveStudentSessionSecret({ NODE_ENV: "production" })).toBeNull();
    });

    it("round-trips guest, temporary, and registered identities", () => {
        const now = 1_000_000;
        expect(parseSignedStudentSessionCookie(
            createSignedStudentSessionCookie(GUEST, ENV, now),
            ENV,
            now + 1_000,
        )).toMatchObject({ kind: "guest", guestId: "g-123", identityType: "guest" });
        expect(parseSignedStudentSessionCookie(
            createSignedStudentSessionCookie(STUDENT, ENV, now),
            ENV,
            now + 1_000,
        )).toMatchObject({ kind: "student", studentId: "grp1::김철수", organizationId: "teacher_abc" });
        expect(parseSignedStudentSessionCookie(
            createSignedStudentSessionCookie(registeredIdentity, productionEnv, now),
            productionEnv,
            now + 1_000,
        )).toMatchObject(registeredIdentity);
    });

    it("rejects tampering, wrong secrets, malformed cookies, future sessions, and expiry", () => {
        const cookie = createSignedStudentSessionCookie(GUEST, ENV, 1_000)!;
        const [payload, signature] = cookie.split(".");
        const forged = signature.slice(0, -1) + (signature.endsWith("A") ? "B" : "A");

        expect(parseSignedStudentSessionCookie(`${payload}.deadbeef`, ENV, 2_000)).toBeNull();
        expect(parseSignedStudentSessionCookie(`${payload}.${forged}`, ENV, 2_000)).toBeNull();
        expect(parseSignedStudentSessionCookie(cookie, { ...ENV, STUDENT_SESSION_SECRET: "wrong" }, 2_000)).toBeNull();
        expect(parseSignedStudentSessionCookie("not-a-valid-cookie", ENV, 2_000)).toBeNull();
        expect(parseSignedStudentSessionCookie(
            cookie,
            ENV,
            1_000 + STUDENT_SERVER_SESSION_MAX_AGE_SECONDS * 1_000 + 1,
        )).toBeNull();

        const futureCookie = createSignedStudentSessionCookie(registeredIdentity, productionEnv, 100_000)!;
        expect(parseSignedStudentSessionCookie(futureCookie, productionEnv, 1_000)).toBeNull();
    });

    it("fails closed without an explicit production secret and uses secure cookies off localhost", () => {
        expect(createSignedStudentSessionCookie(registeredIdentity, { NODE_ENV: "production" }, 1_000)).toBeNull();
        expect(shouldUseSecureStudentSessionCookie("omr.example.com", productionEnv)).toBe(true);
        expect(shouldUseSecureStudentSessionCookie("localhost:3003", productionEnv)).toBe(false);
    });
});
