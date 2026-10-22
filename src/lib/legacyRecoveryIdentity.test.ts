import { describe, expect, it, vi } from "vitest";
import { lookupProvisionedTeacherLogin, validateProvisionedTeacherSession } from "./teacherAccountGateway";
import { createTeacherSession, isTeacherSessionActive, parseTeacherSession } from "./teacherSession";
import { createSignedTeacherSessionCookie, resolveAuthorizedTeacherSessionCookie } from "./teacherServerSession";
import { workspaceContextFromTeacherSession } from "./workspaceContext";
import { readEffectiveWorkspacePlan } from "./effectiveWorkspacePlanGateway";
import { issueStudentCredentialBatch } from "./studentCredentialBatchGateway.server";

const now = Date.parse("2026-10-22T00:00:00Z");
const token = "tkn_abc123_0123456789abcdef0123456789abcdef";
const env = { NODE_ENV: "production", TEACHER_SESSION_SECRET: "legacy-recovery-test-secret-at-least-32-bytes" };
const identity = {
    teacherId: "teacher_0123456789abcdef", email: "recovery@example.com", displayName: "복구 원장",
    organizationId: "teacher_oldorg123", organizationName: "기존 학원", memberRole: "owner" as const,
    plan: "academy" as const, entitlementMode: "legacy_recovery" as const,
    sessionAuthority: "account" as const, accountSessionGeneration: 1,
};
const validated = {
    accountId: identity.teacherId, sessionGeneration: 1, organizationId: identity.organizationId,
    organizationName: identity.organizationName, memberRole: "owner", plan: "academy",
    entitlementMode: "legacy_recovery", grantExpiresAt: null,
};
const login = { ...validated, email: identity.email, displayName: identity.displayName,
    passwordHash: `pbkdf2-sha256:120000:${"a".repeat(32)}:${"b".repeat(64)}` };
const client = (data: unknown, error: { message: string } | null = null) => ({ rpc: vi.fn(async () => ({ data, error })) });

describe("operator-backed legacy recovery identity", () => {
    it("preserves the original organization and new owner across login, signed refresh and workspace", async () => {
        expect(await lookupProvisionedTeacherLogin(client(login), identity.email, now)).toEqual(login);
        const session = createTeacherSession(token, now, identity);
        expect(parseTeacherSession(JSON.stringify(session), now)).toEqual(session);
        expect(workspaceContextFromTeacherSession(session, now)).toMatchObject({
            organizationId: identity.organizationId, actorUserId: identity.teacherId,
            accountId: identity.teacherId, entitlementMode: "legacy_recovery",
        });
        const cookie = createSignedTeacherSessionCookie(token, identity, env, now);
        const authoritative = client(validated);
        expect(await resolveAuthorizedTeacherSessionCookie(cookie, { env, now, accountClient: authoritative }))
            .toMatchObject({ ...identity });
        expect(authoritative.rpc).toHaveBeenCalledWith("omr_validate_provisioned_teacher_session_v1", {
            p_account_id: identity.teacherId, p_session_generation: 1, p_organization_id: identity.organizationId,
        });
    });

    it("requires explicit recovery mode, owner, Academy, canonical account and legacy organization", async () => {
        for (const patch of [
            { entitlementMode: undefined }, { entitlementMode: "permanent_demo" }, { entitlementMode: "unknown" },
            { memberRole: "teacher" }, { plan: "pro" }, { organizationId: "default" },
            { organizationId: `demo_org_${"a".repeat(24)}` }, { teacherId: "teacher_oldadmin" },
            { sessionAuthority: "legacy_account" }, { sessionAuthority: "bootstrap" },
        ]) {
            const session = { ...createTeacherSession(token, now, identity), ...patch };
            expect(isTeacherSessionActive(session as ReturnType<typeof createTeacherSession>, now)).toBe(false);
            expect(parseTeacherSession(JSON.stringify(session), now)).toBeNull();
        }
        for (const patch of [
            { entitlementMode: undefined }, { entitlementMode: "permanent_demo" }, { memberRole: "teacher" },
            { plan: "free" }, { grantExpiresAt: "2099-01-01T00:00:00Z" }, { organizationId: "default" },
            { accountId: "teacher_oldadmin" }, { extra: true },
        ]) expect(await lookupProvisionedTeacherLogin(client({ ...login, ...patch }), identity.email, now)).toBeNull();
        const rpc = client(validated);
        expect(await validateProvisionedTeacherSession(rpc, identity.teacherId, 1, identity.organizationId, now)).toBeNull();
        expect(rpc.rpc).not.toHaveBeenCalled();
    });

    it("denies revoked, mismatched and unavailable recovery despite a valid signed Academy cookie", async () => {
        const cookie = createSignedTeacherSessionCookie(token, identity, env, now);
        for (const data of [null, false, { ...validated, entitlementMode: undefined },
            { ...validated, accountId: "teacher_ffffffffffffffff" }, { ...validated, sessionGeneration: 2 },
            { ...validated, organizationId: "teacher_otherorg" }]) {
            expect(await resolveAuthorizedTeacherSessionCookie(cookie, { env, now, accountClient: client(data) })).toBeNull();
        }
        expect(await resolveAuthorizedTeacherSessionCookie(cookie, { env, now, accountClient: client(null, { message: "unavailable" }) })).toBeNull();
    });

    it("accepts only an explicit permanent Academy plan response and never nominal Academy", async () => {
        const plan = { organizationId: identity.organizationId, plan: "academy", grantId: null, expiresAt: null,
            entitlementMode: "legacy_recovery" };
        expect(await readEffectiveWorkspacePlan(client(plan), identity.organizationId, now))
            .toEqual({ authoritative: true, plan: "academy", entitlementMode: "legacy_recovery" });
        for (const data of [null, { ...plan, entitlementMode: undefined }, { ...plan, plan: "pro" },
            { ...plan, grantId: `pilot_grant_${"a".repeat(24)}` }, { ...plan, expiresAt: "2099-01-01T00:00:00Z" }]) {
            expect(await readEffectiveWorkspacePlan(client(data), identity.organizationId, now))
                .toEqual({ authoritative: false, plan: "free" });
        }
    });

    it("issues student credentials for explicit recovered identity while rejecting missing mode before hashing", async () => {
        const input = { sessionAuthority: "account", accountId: identity.teacherId, accountSessionGeneration: 1,
            organizationId: identity.organizationId, actorUserId: identity.teacherId,
            entitlementMode: "legacy_recovery", studentIds: ["student-1"], idempotencyKey: `batch_${"a".repeat(32)}` };
        const deps = { generateCode: vi.fn(() => "AB2CD3"), hashCode: vi.fn(async () => login.passwordHash),
            generateIdempotencyKey: () => input.idempotencyKey, hashConcurrency: 1 };
        const rpc = client({ status: "issued", count: 1, studentIds: ["student-1"] });
        expect(await issueStudentCredentialBatch({ ...input, entitlementMode: undefined }, rpc, deps))
            .toEqual({ status: "rejected", error: "invalid_input" });
        expect(deps.hashCode).not.toHaveBeenCalled();
        expect(rpc.rpc).not.toHaveBeenCalled();
        expect(await issueStudentCredentialBatch(input, rpc, deps)).toMatchObject({ status: "issued" });
        expect(rpc.rpc).toHaveBeenCalledWith("omr_issue_student_start_code_batch_v1", expect.objectContaining({
            p_organization_id: identity.organizationId, p_account_id: identity.teacherId, p_actor_user_id: identity.teacherId,
        }));
        expect(await issueStudentCredentialBatch(input, client({ status: "unauthorized" }), deps))
            .toEqual({ status: "rejected", error: "forbidden" });
    });
});
