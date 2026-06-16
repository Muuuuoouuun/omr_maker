import { describe, expect, it } from "vitest";
import { isTeacherToken } from "./teacherSession";
import {
    mintTeacherToken,
    resolveTeacherPassword,
    TEACHER_AUTH_ERROR,
    verifyTeacherPasswordValue,
} from "./teacherAuth";

describe("teacher auth", () => {
    it("uses the demo password outside production only when no env password is configured", () => {
        expect(resolveTeacherPassword({ NODE_ENV: "development", TEACHER_PASSWORD: undefined })).toBe("admin123");
        expect(resolveTeacherPassword({ NODE_ENV: "test", TEACHER_PASSWORD: undefined })).toBe("admin123");
        expect(resolveTeacherPassword({ NODE_ENV: "production", TEACHER_PASSWORD: undefined })).toBeNull();
    });

    it("prefers a configured teacher password and trims accidental whitespace", () => {
        expect(resolveTeacherPassword({ NODE_ENV: "production", TEACHER_PASSWORD: "  secret-pass  " })).toBe("secret-pass");
        expect(verifyTeacherPasswordValue("secret-pass", {
            NODE_ENV: "production",
            TEACHER_PASSWORD: "  secret-pass  ",
        })).toBe(true);
        expect(verifyTeacherPasswordValue("admin123", {
            NODE_ENV: "production",
            TEACHER_PASSWORD: "secret-pass",
        })).toBe(false);
    });

    it("rejects invalid password inputs without enabling production defaults", () => {
        expect(verifyTeacherPasswordValue(undefined, { NODE_ENV: "development" })).toBe(false);
        expect(verifyTeacherPasswordValue("admin123", { NODE_ENV: "production" })).toBe(false);
    });

    it("mints teacher session tokens compatible with session validation", () => {
        const firstToken = mintTeacherToken(1_000);
        const secondToken = mintTeacherToken(1_000);

        expect(firstToken).not.toBe(secondToken);
        expect(isTeacherToken(firstToken)).toBe(true);
        expect(firstToken).toMatch(/^tkn_rs_[a-f0-9]{32}$/);
        expect(isTeacherToken("tkn_rs_deadbeef")).toBe(false);
    });

    it("keeps a shared generic failure message", () => {
        expect(TEACHER_AUTH_ERROR).toBe("비밀번호가 올바르지 않습니다.");
    });
});
