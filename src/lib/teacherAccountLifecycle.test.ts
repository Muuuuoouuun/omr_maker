import { describe, expect, it } from "vitest";
import {
    createTeacherAccountToken,
    hashTeacherAccountToken,
    hashTeacherAccountPassword,
    hashTeacherAccountPasswordAsync,
    isTeacherBootstrapLoginEnabled,
    normalizeTeacherAccountEmail,
    validateTeacherSignupInput,
    verifyTeacherAccountPassword,
    verifyTeacherAccountPasswordConstantWork,
    verifyTeacherAccountPasswordConstantWorkAsync,
} from "./teacherAccountLifecycle";

describe("teacher account lifecycle policy", () => {
    it("limits environment credentials to explicit production bootstrap mode", () => {
        expect(isTeacherBootstrapLoginEnabled({ NODE_ENV: "development" })).toBe(true);
        expect(isTeacherBootstrapLoginEnabled({ NODE_ENV: "production" })).toBe(false);
        expect(isTeacherBootstrapLoginEnabled({
            NODE_ENV: "production",
            OMR_ALLOW_TEACHER_BOOTSTRAP_LOGIN: "true",
        })).toBe(true);
    });

    it("normalizes email and validates bounded signup inputs", () => {
        expect(normalizeTeacherAccountEmail(" Teacher@Example.COM ")).toBe("teacher@example.com");
        expect(validateTeacherSignupInput({
            email: " Teacher@Example.COM ",
            displayName: " 김 선생 ",
            password: "safe-password-123",
        })).toEqual({
            ok: true,
            value: {
                email: "teacher@example.com",
                displayName: "김 선생",
                password: "safe-password-123",
            },
        });
        for (const input of [
            { email: "not-email", displayName: "김", password: "safe-password-123" },
            { email: "a@example.com", displayName: "", password: "safe-password-123" },
            { email: "a@example.com", displayName: "김", password: "short" },
            { email: `${"a".repeat(245)}@example.com`, displayName: "김", password: "safe-password-123" },
            { email: "a@example.com", displayName: "김", password: "x".repeat(129) },
        ]) {
            expect(validateTeacherSignupInput(input)).toMatchObject({ ok: false });
        }
    });

    it("stores a PBKDF2 password hash and verifies without retaining plaintext", () => {
        const passwordHash = hashTeacherAccountPassword(
            "safe-password-123",
            Buffer.from("00112233445566778899aabbccddeeff", "hex"),
        );
        expect(passwordHash).toMatch(/^pbkdf2-sha256:120000:[a-f0-9]{32}:[a-f0-9]{64}$/);
        expect(passwordHash).not.toContain("safe-password-123");
        expect(verifyTeacherAccountPassword("safe-password-123", passwordHash)).toBe(true);
        expect(verifyTeacherAccountPassword("wrong-password", passwordHash)).toBe(false);
        expect(verifyTeacherAccountPassword("safe-password-123", "broken")).toBe(false);
    });

    it("uses a valid fixed-cost dummy hash when an account hash is absent or malformed", () => {
        expect(verifyTeacherAccountPasswordConstantWork("candidate-password", undefined)).toBe(false);
        expect(verifyTeacherAccountPasswordConstantWork("candidate-password", "broken")).toBe(false);
        expect(verifyTeacherAccountPasswordConstantWork(
            "safe-password-123",
            hashTeacherAccountPassword(
                "safe-password-123",
                Buffer.from("00112233445566778899aabbccddeeff", "hex"),
            ),
        )).toBe(true);
    });

    it("offers asynchronous PBKDF2 for request paths so concurrent logins do not block the event loop", async () => {
        const passwordHash = await hashTeacherAccountPasswordAsync(
            "safe-password-123",
            Buffer.from("00112233445566778899aabbccddeeff", "hex"),
        );
        await expect(verifyTeacherAccountPasswordConstantWorkAsync(
            "safe-password-123",
            passwordHash,
        )).resolves.toBe(true);
        await expect(verifyTeacherAccountPasswordConstantWorkAsync(
            "candidate-password",
            undefined,
        )).resolves.toBe(false);
    });

    it("creates an opaque one-time token while exposing only its digest for persistence", () => {
        const token = createTeacherAccountToken(
            "password_reset",
            1_000,
            () => Buffer.alloc(32, 7),
        );
        expect(token.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
        expect(token.tokenHash).toMatch(/^[a-f0-9]{64}$/);
        expect(token.tokenHash).toBe(hashTeacherAccountToken(token.token));
        expect(token.tokenHash).not.toContain(token.token);
        expect(token.purpose).toBe("password_reset");
        expect(token.expiresAt).toBe(1_000 + 30 * 60 * 1_000);
    });
});
