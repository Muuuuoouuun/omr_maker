import { describe, expect, it } from "vitest";
import {
    createSignedStudentSessionCookie,
    parseSignedStudentSessionCookie,
    resolveStudentSessionSecret,
    type StudentIdentityInput,
} from "./studentServerSession";

const GUEST: StudentIdentityInput = { kind: "guest", guestId: "g-123", name: "Guest Student", identityType: "guest" };
const STUDENT: StudentIdentityInput = {
    kind: "student", studentId: "grp1::김철수", name: "김철수",
    organizationId: "teacher_abc", groupId: "grp1", groupName: "1반", identityType: "temporary",
};
const ENV = { STUDENT_SESSION_SECRET: "test-secret", NODE_ENV: "test" } as Record<string, string>;

describe("studentServerSession", () => {
    it("resolves the dedicated secret, falls back only outside production", () => {
        expect(resolveStudentSessionSecret({ STUDENT_SESSION_SECRET: " s " })).toBe("s");
        expect(resolveStudentSessionSecret({ NODE_ENV: "development" })).toBe("dev-student-session-secret");
        expect(resolveStudentSessionSecret({ NODE_ENV: "production" })).toBeNull();
    });

    it("round-trips a guest identity", () => {
        const now = 1_000_000;
        const cookie = createSignedStudentSessionCookie(GUEST, ENV, now)!;
        const parsed = parseSignedStudentSessionCookie(cookie, ENV, now + 1000);
        expect(parsed).toMatchObject({ kind: "guest", guestId: "g-123", identityType: "guest" });
    });

    it("round-trips a student identity", () => {
        const now = 1_000_000;
        const cookie = createSignedStudentSessionCookie(STUDENT, ENV, now)!;
        const parsed = parseSignedStudentSessionCookie(cookie, ENV, now + 1000);
        expect(parsed).toMatchObject({
            kind: "student",
            studentId: "grp1::김철수",
            organizationId: "teacher_abc",
            groupId: "grp1",
        });
    });

    it("rejects a tampered signature", () => {
        const cookie = createSignedStudentSessionCookie(GUEST, ENV, 1000)!;
        const [payload] = cookie.split(".");
        expect(parseSignedStudentSessionCookie(`${payload}.deadbeef`, ENV, 2000)).toBeNull();
    });

    it("rejects a same-length forged signature", () => {
        const cookie = createSignedStudentSessionCookie(GUEST, ENV, 1000)!;
        const [payload, sig] = cookie.split(".");
        const forged = sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A");
        expect(parseSignedStudentSessionCookie(`${payload}.${forged}`, ENV, 2000)).toBeNull();
    });

    it("rejects a cookie parsed with a different secret", () => {
        const cookie = createSignedStudentSessionCookie(GUEST, ENV, 1000)!;
        expect(parseSignedStudentSessionCookie(cookie, { STUDENT_SESSION_SECRET: "other", NODE_ENV: "test" }, 2000)).toBeNull();
    });

    it("rejects a malformed cookie string", () => {
        expect(parseSignedStudentSessionCookie("not-a-valid-cookie", ENV, 2000)).toBeNull();
    });

    it("rejects an expired session", () => {
        const now = 1_000_000;
        const cookie = createSignedStudentSessionCookie(GUEST, ENV, now)!;
        const past = now + 31 * 24 * 60 * 60 * 1000; // > 30d TTL
        expect(parseSignedStudentSessionCookie(cookie, ENV, past)).toBeNull();
    });
});
