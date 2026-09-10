import { describe, expect, it, vi } from "vitest";
import {
    beginTeacherPasswordReset,
    beginTeacherSignup,
    completeTeacherPasswordReset,
    findActiveTeacherAccount,
    lookupProvisionedTeacherLogin,
    probeProvisionedTeacherCanary,
    validateProvisionedTeacherSession,
    verifyTeacherEmail,
    type TeacherAccountGatewayClient,
} from "./teacherAccountGateway";

function clientWith(dataByRpc: Record<string, unknown>): TeacherAccountGatewayClient & { rpc: ReturnType<typeof vi.fn> } {
    return {
        rpc: vi.fn(async (name: string) => ({ data: dataByRpc[name], error: null })),
    };
}

describe("teacher account service-role gateway", () => {
    it("passes only hashes and bounded account metadata to signup persistence", async () => {
        const client = clientWith({ omr_begin_teacher_signup_v1: true });
        await expect(beginTeacherSignup(client, {
            accountId: "teacher_0123456789abcdef",
            tokenId: "teacher_token_0123456789abcdefghijklmn",
            email: "teacher@example.com",
            displayName: "김선생",
            passwordHash: "pbkdf2-sha256:120000:00112233445566778899aabbccddeeff:" + "a".repeat(64),
            tokenHash: "b".repeat(64),
            expiresAt: new Date("2026-08-08T00:00:00.000Z"),
        })).resolves.toEqual({ status: "created" });
        const params = client.rpc.mock.calls[0][1];
        expect(params).not.toHaveProperty("password");
        expect(params).not.toHaveProperty("token");
        expect(params).toMatchObject({
            p_email: "teacher@example.com",
            p_password_hash: expect.stringMatching(/^pbkdf2-sha256:/),
            p_token_hash: "b".repeat(64),
        });
    });

    it("keeps reset lookup generic and consumes reset/verification tokens through RPCs", async () => {
        const client = clientWith({
            omr_begin_teacher_password_reset_v1: false,
            omr_complete_teacher_password_reset_v1: true,
            omr_verify_teacher_email_v1: true,
        });
        await expect(beginTeacherPasswordReset(client, {
            tokenId: "teacher_token_0123456789abcdefghijklmn",
            email: "missing@example.com",
            tokenHash: "b".repeat(64),
            expiresAt: new Date("2026-08-08T00:00:00.000Z"),
        })).resolves.toEqual({ status: "accepted", deliveryRequired: false });
        await expect(completeTeacherPasswordReset(client, {
            tokenHash: "c".repeat(64),
            passwordHash: "pbkdf2-sha256:120000:00112233445566778899aabbccddeeff:" + "d".repeat(64),
        })).resolves.toEqual({ status: "completed" });
        await expect(verifyTeacherEmail(client, "e".repeat(64))).resolves.toEqual({ status: "verified" });
    });

    it("returns only active normalized database accounts for login", async () => {
        const client = clientWith({
            omr_lookup_teacher_account_v1: {
                id: "teacher_0123456789abcdef",
                email: "teacher@example.com",
                display_name: "김선생",
                password_hash: "pbkdf2-sha256:120000:00112233445566778899aabbccddeeff:" + "a".repeat(64),
                status: "active",
                session_generation: 1,
            },
        });
        await expect(findActiveTeacherAccount(client, " Teacher@Example.com ")).resolves.toMatchObject({
            id: "teacher_0123456789abcdef",
            email: "teacher@example.com",
            displayName: "김선생",
            status: "active",
            sessionGeneration: 1,
        });
        expect(client.rpc).toHaveBeenCalledWith("omr_lookup_teacher_account_v1", {
            p_identifier: "teacher@example.com",
        });
        await expect(findActiveTeacherAccount(clientWith({
            omr_lookup_teacher_account_v1: [{
                id: "teacher_0123456789abcdef",
                email: "teacher@example.com",
                display_name: "김선생",
                password_hash: "pbkdf2-sha256:120000:00112233445566778899aabbccddeeff:" + "a".repeat(64),
                status: "active",
                session_generation: 1,
            }],
        }), "teacher@example.com")).resolves.toBeNull();
    });
});

describe("provisioned teacher account gateway", () => {
    const now = Date.parse("2026-08-08T00:00:00Z");
    const valid = {
        accountId: "teacher_0123456789abcdef",
        email: "teacher@example.com",
        displayName: "김선생",
        passwordHash: "pbkdf2-sha256:120000:00112233445566778899aabbccddeeff:" + "a".repeat(64),
        sessionGeneration: 3,
        organizationId: "pilot_org_0123456789abcdef01234567",
        organizationName: "파일럿 학원",
        memberRole: "owner",
        plan: "pro",
        grantExpiresAt: "2026-08-31T15:00:00.000000Z",
    };

    it("accepts only an exact getter-free provisioned login envelope", async () => {
        const client = clientWith({ omr_lookup_provisioned_teacher_login_v1: valid });
        await expect(lookupProvisionedTeacherLogin(client, " Teacher@Example.com ", now)).resolves.toEqual(valid);
        expect(client.rpc).toHaveBeenCalledWith("omr_lookup_provisioned_teacher_login_v1", {
            p_identifier: "teacher@example.com",
        });
        expect(client.rpc).toHaveBeenCalledTimes(1);
        await expect(lookupProvisionedTeacherLogin(clientWith({
            omr_lookup_provisioned_teacher_login_v1: { ...valid, unexpected: true },
        }), "teacher@example.com", now)).resolves.toBeNull();
        await expect(lookupProvisionedTeacherLogin(clientWith({
            omr_lookup_provisioned_teacher_login_v1: [valid],
        }), "teacher@example.com", now)).resolves.toBeNull();

        const getter = Object.defineProperty({ ...valid }, "email", { enumerable: true, get: () => "attacker@example.com" });
        await expect(lookupProvisionedTeacherLogin(clientWith({ omr_lookup_provisioned_teacher_login_v1: getter }), "x", now))
            .resolves.toBeNull();
        await expect(lookupProvisionedTeacherLogin(clientWith({
            omr_lookup_provisioned_teacher_login_v1: { ...valid, grantExpiresAt: "2026-08-01T00:00:00.000000Z" },
        }), "teacher@example.com", Date.parse("2026-08-08T00:00:00Z"))).resolves.toBeNull();
    });

    it("returns current request-time organization and plan only for an exact signed binding", async () => {
        const result = {
            accountId: valid.accountId,
            sessionGeneration: 3,
            organizationId: valid.organizationId,
            organizationName: valid.organizationName,
            memberRole: "owner",
            plan: "free",
            grantExpiresAt: null,
        };
        const client = clientWith({ omr_validate_provisioned_teacher_session_v1: result });
        await expect(validateProvisionedTeacherSession(client, valid.accountId, 3, valid.organizationId))
            .resolves.toEqual(result);
        expect(client.rpc).toHaveBeenCalledWith("omr_validate_provisioned_teacher_session_v1", {
            p_account_id: valid.accountId,
            p_session_generation: 3,
            p_organization_id: valid.organizationId,
        });
        expect(client.rpc).toHaveBeenCalledTimes(1);
        await expect(validateProvisionedTeacherSession(client, valid.accountId, 3, "teacher_legacy1"))
            .resolves.toBeNull();
    });

    it("accepts only the exact one-call canary envelope", async () => {
        const client = clientWith({ omr_probe_provisioned_teacher_canary_v1: { ready: true } });
        await expect(probeProvisionedTeacherCanary(client, valid.accountId)).resolves.toBe(true);
        expect(client.rpc).toHaveBeenCalledTimes(1);
        expect(client.rpc).toHaveBeenCalledWith("omr_probe_provisioned_teacher_canary_v1", {
            p_account_id: valid.accountId,
        });
        for (const data of [
            { ready: false }, { ready: true, accountId: valid.accountId }, [{ ready: true }], null,
        ]) {
            await expect(probeProvisionedTeacherCanary(
                clientWith({ omr_probe_provisioned_teacher_canary_v1: data }), valid.accountId,
            )).resolves.toBe(false);
        }
        const getter = Object.defineProperty({}, "ready", { enumerable: true, get: () => true });
        await expect(probeProvisionedTeacherCanary(
            clientWith({ omr_probe_provisioned_teacher_canary_v1: getter }), valid.accountId,
        )).resolves.toBe(false);
        const invalid = clientWith({ omr_probe_provisioned_teacher_canary_v1: { ready: true } });
        await expect(probeProvisionedTeacherCanary(invalid, "teacher_bad")).resolves.toBe(false);
        expect(invalid.rpc).not.toHaveBeenCalled();
    });
});
