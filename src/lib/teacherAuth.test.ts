import { pbkdf2Sync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isTeacherToken } from "./teacherSession";
import {
    inspectTeacherAuthConfig,
    mintTeacherToken,
    resolveTeacherCredentials,
    resolveTeacherPassword,
    TEACHER_AUTH_DEPLOYMENT_CONFIG_ERROR,
    TEACHER_AUTH_ERROR,
    verifyTeacherLogin,
    verifyTeacherPasswordValue,
} from "./teacherAuth";

function teacherPasswordHash(password: string, saltHex = "00112233445566778899aabbccddeeff"): string {
    const iterations = 1_000;
    const hashHex = pbkdf2Sync(password, Buffer.from(saltHex, "hex"), iterations, 32, "sha256").toString("hex");
    return `pbkdf2-sha256:${iterations}:${saltHex}:${hashHex}`;
}

describe("teacher auth", () => {
    it("uses the demo password outside production only when no env password is configured", () => {
        expect(resolveTeacherPassword({ NODE_ENV: "development", TEACHER_PASSWORD: undefined })).toBe("admin123");
        expect(resolveTeacherPassword({ NODE_ENV: "test", TEACHER_PASSWORD: undefined })).toBe("admin123");
        expect(resolveTeacherPassword({ NODE_ENV: "production", TEACHER_PASSWORD: undefined })).toBeNull();
        expect(resolveTeacherPassword({ NODE_ENV: "development", TEACHER_PASSWORD_HASH: teacherPasswordHash("dev-secret") })).toBeNull();
        expect(resolveTeacherCredentials({ NODE_ENV: "development" })).toEqual([{
            id: "admin",
            email: "admin@example.com",
            name: "Demo Admin",
            password: "admin123",
        }]);
        expect(resolveTeacherCredentials({ NODE_ENV: "production" })).toEqual([]);
    });

    it("prefers configured teacher credentials and trims accidental whitespace", () => {
        expect(resolveTeacherPassword({ NODE_ENV: "production", TEACHER_PASSWORD: "  secret-pass  " })).toBe("secret-pass");
        expect(resolveTeacherCredentials({
            NODE_ENV: "production",
            TEACHER_LOGIN_ID: " director ",
            TEACHER_EMAIL: " Director@School.test ",
            TEACHER_NAME: " 김선생 ",
            TEACHER_PASSWORD: "  secret-pass  ",
        })).toEqual([{
            id: "director",
            email: "director@school.test",
            name: "김선생",
            password: "secret-pass",
        }]);
        expect(verifyTeacherPasswordValue("secret-pass", {
            NODE_ENV: "production",
            TEACHER_PASSWORD: "  secret-pass  ",
        })).toBe(true);
        expect(verifyTeacherPasswordValue("admin123", {
            NODE_ENV: "production",
            TEACHER_PASSWORD: "secret-pass",
        })).toBe(false);
    });

    it("supports a hashed single-teacher password without treating the hash as plaintext", () => {
        const passwordHash = teacherPasswordHash("secret-pass");
        const env = {
            NODE_ENV: "production",
            TEACHER_LOGIN_ID: "director",
            TEACHER_EMAIL: "Director@School.test",
            TEACHER_NAME: "김선생",
            TEACHER_PASSWORD_HASH: ` ${passwordHash} `,
        };

        expect(resolveTeacherPassword(env)).toBeNull();
        expect(resolveTeacherCredentials(env)).toEqual([{
            id: "director",
            email: "director@school.test",
            name: "김선생",
            passwordHash,
        }]);
        expect(verifyTeacherPasswordValue("secret-pass", env)).toBe(true);
        expect(verifyTeacherPasswordValue("wrong", env)).toBe(false);
        expect(verifyTeacherLogin("director", "secret-pass", env)).toMatchObject({
            success: true,
            teacher: { teacherId: "director" },
        });
        expect(verifyTeacherLogin("director", "wrong", env)).toEqual({ success: false });
    });

    it("supports OMR_TEACHER_PASSWORD_HASH for single-teacher env config", () => {
        const env = {
            NODE_ENV: "production",
            OMR_TEACHER_PASSWORD_HASH: teacherPasswordHash("omr-secret", "11112222333344445555666677778888"),
        };

        expect(verifyTeacherLogin("admin", "omr-secret", env)).toMatchObject({
            success: true,
            teacher: { teacherId: "admin" },
        });
    });

    it("verifies teacher id or email without revealing which side failed", () => {
        const env = {
            NODE_ENV: "production",
            TEACHER_LOGIN_ID: "director",
            TEACHER_EMAIL: "director@school.test",
            TEACHER_NAME: "김선생",
            TEACHER_PASSWORD: "secret-pass",
        };

        expect(verifyTeacherLogin("director", "secret-pass", env)).toEqual({
            success: true,
            teacher: {
                teacherId: "director",
                email: "director@school.test",
                displayName: "김선생",
            },
        });
        expect(verifyTeacherLogin("DIRECTOR@SCHOOL.TEST", "secret-pass", env)).toMatchObject({ success: true });
        expect(verifyTeacherLogin("director", "wrong", env)).toEqual({ success: false });
        expect(verifyTeacherLogin("unknown", "secret-pass", env)).toEqual({ success: false });
    });

    it("supports multiple teacher accounts from JSON env", () => {
        const env = {
            NODE_ENV: "production",
            TEACHER_ACCOUNTS: JSON.stringify([
                { id: "teacher-a", email: "a@example.com", name: "A Teacher", password: "pass-a" },
                { id: "teacher-b", email: "b@example.com", name: "B Teacher", password: "pass-b" },
            ]),
        };

        expect(resolveTeacherCredentials(env).map(item => item.id)).toEqual(["teacher-a", "teacher-b"]);
        expect(verifyTeacherLogin("b@example.com", "pass-b", env)).toMatchObject({
            success: true,
            teacher: { teacherId: "teacher-b", displayName: "B Teacher" },
        });
        expect(verifyTeacherLogin("teacher-a", "pass-b", env)).toEqual({ success: false });
    });

    it("binds a plan to each teacher account from JSON env and returns it on login", () => {
        const env = {
            NODE_ENV: "production",
            TEACHER_ACCOUNTS: JSON.stringify([
                { id: "admin", email: "admin@omr.test", name: "관리자", password: "admin1234", plan: "academy" },
                { id: "test1", email: "t1@omr.test", name: "테스트1", password: "test1234", plan: "free" },
                { id: "test2", email: "t2@omr.test", name: "테스트2", password: "test1234", plan: "pro" },
            ]),
        };

        expect(resolveTeacherCredentials(env).map(item => [item.id, item.plan])).toEqual([
            ["admin", "academy"],
            ["test1", "free"],
            ["test2", "pro"],
        ]);
        expect(verifyTeacherLogin("test2", "test1234", env)).toMatchObject({
            success: true,
            teacher: { teacherId: "test2", plan: "pro" },
        });
        expect(verifyTeacherLogin("admin", "admin1234", env).teacher?.plan).toBe("academy");
    });

    it("normalizes legacy 'school' plan to academy and ignores invalid or missing plan values", () => {
        const env = {
            NODE_ENV: "production",
            TEACHER_ACCOUNTS: JSON.stringify([
                { id: "legacy", password: "pass", plan: "school" },
                { id: "bogus", password: "pass", plan: "ultra" },
                { id: "none", password: "pass" },
            ]),
        };

        const creds = resolveTeacherCredentials(env);
        expect(creds.find(item => item.id === "legacy")?.plan).toBe("academy");
        expect(creds.find(item => item.id === "bogus")?.plan).toBeUndefined();
        expect(creds.find(item => item.id === "none")?.plan).toBeUndefined();
    });

    it("binds a plan to a single teacher via the TEACHER_PLAN env", () => {
        const env = {
            NODE_ENV: "production",
            TEACHER_LOGIN_ID: "solo",
            TEACHER_PASSWORD: "pass",
            TEACHER_PLAN: "pro",
        };

        expect(resolveTeacherCredentials(env)[0]?.plan).toBe("pro");
        expect(verifyTeacherLogin("solo", "pass", env)).toMatchObject({
            success: true,
            teacher: { teacherId: "solo", plan: "pro" },
        });
    });

    it("supports passwordHash and password_hash in multi-teacher JSON env", () => {
        const env = {
            NODE_ENV: "production",
            TEACHER_ACCOUNTS: JSON.stringify([
                { id: "teacher-a", email: "a@example.com", name: "A Teacher", passwordHash: teacherPasswordHash("pass-a") },
                { id: "teacher-b", email: "b@example.com", name: "B Teacher", password_hash: teacherPasswordHash("pass-b", "abcdefabcdefabcdefabcdefabcdefab") },
            ]),
        };

        expect(resolveTeacherCredentials(env).map(item => ({ id: item.id, hasHash: !!item.passwordHash, hasPassword: !!item.password }))).toEqual([
            { id: "teacher-a", hasHash: true, hasPassword: false },
            { id: "teacher-b", hasHash: true, hasPassword: false },
        ]);
        expect(verifyTeacherLogin("teacher-a", "pass-a", env)).toMatchObject({
            success: true,
            teacher: { teacherId: "teacher-a" },
        });
        expect(verifyTeacherLogin("b@example.com", "pass-b", env)).toMatchObject({
            success: true,
            teacher: { teacherId: "teacher-b" },
        });
        expect(verifyTeacherLogin("teacher-a", "pass-b", env)).toEqual({ success: false });
    });

    it("reports production deployment auth readiness without relying on Supabase", () => {
        expect(inspectTeacherAuthConfig({
            NODE_ENV: "production",
            NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
        })).toMatchObject({
            ready: false,
            credentialCount: 0,
            issues: [
                expect.objectContaining({
                    key: "missing-production-teacher-account",
                    detail: expect.stringContaining("TEACHER_ACCOUNTS"),
                }),
            ],
        });

        expect(inspectTeacherAuthConfig({
            NODE_ENV: "production",
            TEACHER_LOGIN_ID: "director",
            TEACHER_PASSWORD: "secret-pass",
        })).toMatchObject({
            ready: true,
            credentialCount: 1,
            issues: [],
            warnings: [
                expect.objectContaining({ key: "plaintext-production-teacher-password" }),
            ],
        });

        expect(inspectTeacherAuthConfig({
            NODE_ENV: "production",
            TEACHER_LOGIN_ID: "director",
            TEACHER_PASSWORD_HASH: teacherPasswordHash("secret-pass"),
        })).toMatchObject({
            ready: true,
            credentialCount: 1,
            issues: [],
            warnings: [],
        });
    });

    it("flags malformed or empty multi-teacher account configuration", () => {
        expect(inspectTeacherAuthConfig({
            NODE_ENV: "production",
            TEACHER_ACCOUNTS: "not-json",
        })).toMatchObject({
            ready: false,
            credentialCount: 0,
            issues: expect.arrayContaining([
                expect.objectContaining({ key: "invalid-teacher-accounts-json" }),
                expect.objectContaining({ key: "missing-production-teacher-account" }),
            ]),
        });

        expect(inspectTeacherAuthConfig({
            NODE_ENV: "production",
            TEACHER_ACCOUNTS: JSON.stringify([{ id: "teacher-a" }]),
        })).toMatchObject({
            ready: false,
            credentialCount: 0,
            issues: expect.arrayContaining([
                expect.objectContaining({ key: "empty-teacher-accounts" }),
                expect.objectContaining({ key: "missing-production-teacher-account" }),
            ]),
        });
    });

    it("flags malformed teacher password hashes before they can look deployable", () => {
        expect(inspectTeacherAuthConfig({
            NODE_ENV: "production",
            TEACHER_PASSWORD_HASH: "pbkdf2-sha256:not-a-number:salt:hash",
        })).toMatchObject({
            ready: false,
            credentialCount: 0,
            issues: expect.arrayContaining([
                expect.objectContaining({ key: "invalid-teacher-password-hash" }),
                expect.objectContaining({ key: "missing-production-teacher-account" }),
            ]),
        });

        expect(inspectTeacherAuthConfig({
            NODE_ENV: "production",
            TEACHER_ACCOUNTS: JSON.stringify([{ id: "teacher-a", passwordHash: "bcrypt:abc" }]),
        })).toMatchObject({
            ready: false,
            credentialCount: 0,
            issues: expect.arrayContaining([
                expect.objectContaining({ key: "empty-teacher-accounts" }),
                expect.objectContaining({ key: "invalid-teacher-password-hash" }),
                expect.objectContaining({ key: "missing-production-teacher-account" }),
            ]),
        });
    });

    it("flags duplicate teacher ids or emails before they can shadow each other", () => {
        expect(inspectTeacherAuthConfig({
            NODE_ENV: "production",
            TEACHER_ACCOUNTS: JSON.stringify([
                { id: "teacher-a", email: "shared@example.com", password: "pass-a" },
                { id: "teacher-a", email: "b@example.com", password: "pass-b" },
                { id: "teacher-c", email: "shared@example.com", password: "pass-c" },
            ]),
        })).toMatchObject({
            ready: false,
            credentialCount: 3,
            issues: [
                expect.objectContaining({
                    key: "duplicate-teacher-identifier",
                    detail: expect.stringContaining("teacher-a"),
                }),
            ],
        });
    });

    it("rejects invalid password inputs without enabling production defaults", () => {
        expect(verifyTeacherPasswordValue(undefined, { NODE_ENV: "development" })).toBe(false);
        expect(verifyTeacherPasswordValue("admin123", { NODE_ENV: "production" })).toBe(false);
        expect(verifyTeacherLogin(undefined, "admin123", { NODE_ENV: "development" })).toEqual({ success: false });
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
        expect(TEACHER_AUTH_ERROR).toBe("아이디 또는 비밀번호가 올바르지 않습니다.");
        expect(TEACHER_AUTH_DEPLOYMENT_CONFIG_ERROR).toBe("배포 환경에 교사 계정이 설정되어 있지 않습니다.");
    });
});
