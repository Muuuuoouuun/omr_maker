import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { TeacherAccountGatewayClient } from "./teacherAccountGateway";
import { MOCKUP_TEACHER_IDENTITY } from "./mockupAccount";
import * as teacherServerSession from "./teacherServerSession";

const TOKEN = "tkn_abc123_0123456789abcdef0123456789abcdef";
const ENV = {
    NODE_ENV: "production",
    TEACHER_SESSION_SECRET: "teacher-session-revocation-secret-at-least-32-bytes",
};
const SELF_SERVICE_ENV = {
    NODE_ENV: "development",
    OMR_TEACHER_IDENTITY_MODE: "self_service",
    TEACHER_SESSION_SECRET: ENV.TEACHER_SESSION_SECRET,
};

type SessionResolver = (
    rawCookie: string | null | undefined,
    options?: {
        env?: Record<string, string | undefined>;
        now?: number;
        accountClient?: TeacherAccountGatewayClient | null;
    },
) => Promise<ReturnType<typeof teacherServerSession.parseSignedTeacherSessionCookie>>;

function clientWith(data: unknown, error: { message?: string } | null = null) {
    return {
        rpc: vi.fn(async () => ({ data, error })),
    } satisfies TeacherAccountGatewayClient & { rpc: ReturnType<typeof vi.fn> };
}

describe("teacher account session revocation", () => {
    it("rejects an otherwise valid signed cookie when its account generation is stale", async () => {
        const resolveAuthorizedTeacherSessionCookie = (
            teacherServerSession as typeof teacherServerSession & {
                resolveAuthorizedTeacherSessionCookie?: SessionResolver;
            }
        ).resolveAuthorizedTeacherSessionCookie;
        expect(resolveAuthorizedTeacherSessionCookie).toBeTypeOf("function");
        if (!resolveAuthorizedTeacherSessionCookie) return;

        const cookie = teacherServerSession.createSignedTeacherSessionCookie(TOKEN, {
            teacherId: "teacher_0123456789abcdef",
            email: "teacher@example.com",
            displayName: "김선생",
            accountSessionGeneration: 7,
        }, SELF_SERVICE_ENV, 1_000);
        const client = clientWith(false);

        await expect(resolveAuthorizedTeacherSessionCookie(cookie, {
            env: SELF_SERVICE_ENV,
            now: 1_000,
            accountClient: client,
        })).resolves.toBeNull();
        expect(client.rpc).toHaveBeenCalledWith("omr_validate_teacher_session_v1", {
            p_account_id: "teacher_0123456789abcdef",
            p_session_generation: 7,
        });
    });

    it("accepts only an active account at the exact generation and fails closed on gateway outage", async () => {
        const resolveAuthorizedTeacherSessionCookie = (
            teacherServerSession as typeof teacherServerSession & {
                resolveAuthorizedTeacherSessionCookie?: SessionResolver;
            }
        ).resolveAuthorizedTeacherSessionCookie;
        expect(resolveAuthorizedTeacherSessionCookie).toBeTypeOf("function");
        if (!resolveAuthorizedTeacherSessionCookie) return;

        const cookie = teacherServerSession.createSignedTeacherSessionCookie(TOKEN, {
            teacherId: "teacher_0123456789abcdef",
            accountSessionGeneration: 3,
        }, SELF_SERVICE_ENV, 1_000);
        const activeClient = clientWith(true);
        const outageClient = clientWith(null, { message: "database unavailable" });

        await expect(resolveAuthorizedTeacherSessionCookie(cookie, {
            env: SELF_SERVICE_ENV,
            now: 1_000,
            accountClient: activeClient,
        })).resolves.toMatchObject({
            teacherId: "teacher_0123456789abcdef",
            accountSessionGeneration: 3,
            sessionAuthority: "legacy_account",
        });
        await expect(resolveAuthorizedTeacherSessionCookie(cookie, {
            env: SELF_SERVICE_ENV,
            now: 1_000,
            accountClient: outageClient,
        })).resolves.toBeNull();
        await expect(resolveAuthorizedTeacherSessionCookie(cookie, {
            env: SELF_SERVICE_ENV,
            now: 1_000,
            accountClient: null,
        })).resolves.toBeNull();
    });

    it("keeps explicitly bootstrap and demo sessions independent of the account RPC", async () => {
        const resolveAuthorizedTeacherSessionCookie = (
            teacherServerSession as typeof teacherServerSession & {
                resolveAuthorizedTeacherSessionCookie?: SessionResolver;
            }
        ).resolveAuthorizedTeacherSessionCookie;
        expect(resolveAuthorizedTeacherSessionCookie).toBeTypeOf("function");
        if (!resolveAuthorizedTeacherSessionCookie) return;

        const cookie = teacherServerSession.createSignedTeacherSessionCookie(TOKEN, {
            teacherId: "deployment-fixture",
            email: "fixture@example.com",
            displayName: "Fixture",
        }, SELF_SERVICE_ENV, 1_000);
        const client = clientWith(false);

        await expect(resolveAuthorizedTeacherSessionCookie(cookie, {
            env: SELF_SERVICE_ENV,
            now: 1_000,
            accountClient: client,
        })).resolves.toMatchObject({
            teacherId: "deployment-fixture",
            sessionAuthority: "bootstrap",
        });
        expect(client.rpc).not.toHaveBeenCalled();
    });

    it("rejects pre-generation legacy cookies instead of preserving a 12-hour bypass", async () => {
        const resolveAuthorizedTeacherSessionCookie = (
            teacherServerSession as typeof teacherServerSession & {
                resolveAuthorizedTeacherSessionCookie?: SessionResolver;
            }
        ).resolveAuthorizedTeacherSessionCookie;
        expect(resolveAuthorizedTeacherSessionCookie).toBeTypeOf("function");
        if (!resolveAuthorizedTeacherSessionCookie) return;

        const currentCookie = teacherServerSession.createSignedTeacherSessionCookie(TOKEN, {
            teacherId: "teacher_0123456789abcdef",
        }, SELF_SERVICE_ENV, 1_000)!;
        const [encodedPayload] = currentCookie.split(".");
        const legacyPayload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
        delete legacyPayload.sessionAuthority;
        delete legacyPayload.accountSessionGeneration;
        const legacyEncodedPayload = Buffer.from(JSON.stringify(legacyPayload), "utf8").toString("base64url");
        const legacySignature = createHmac("sha256", ENV.TEACHER_SESSION_SECRET)
            .update(legacyEncodedPayload, "utf8")
            .digest("base64url");

        await expect(resolveAuthorizedTeacherSessionCookie(
            `${legacyEncodedPayload}.${legacySignature}`,
            { env: SELF_SERVICE_ENV, now: 1_000, accountClient: clientWith(true) },
        )).resolves.toBeNull();
    });

    it("revokes pre-cutover bootstrap and legacy-account cookies in provisioned-only mode", async () => {
        const bootstrapCookie = teacherServerSession.createSignedTeacherSessionCookie(TOKEN, {
            teacherId: "deployment-fixture",
            email: "fixture@example.com",
            displayName: "Fixture",
        }, ENV, 1_000);
        const legacyAccountCookie = teacherServerSession.createSignedTeacherSessionCookie(TOKEN, {
            teacherId: "teacher_0123456789abcdef",
            accountSessionGeneration: 3,
            sessionAuthority: "legacy_account",
        }, ENV, 1_000);
        const client = clientWith(true);

        await expect(teacherServerSession.resolveAuthorizedTeacherSessionCookie(
            bootstrapCookie,
            { env: ENV, now: 1_000, accountClient: client },
        )).resolves.toBeNull();
        await expect(teacherServerSession.resolveAuthorizedTeacherSessionCookie(
            legacyAccountCookie,
            { env: ENV, now: 1_000, accountClient: client },
        )).resolves.toBeNull();
        expect(client.rpc).not.toHaveBeenCalled();
    });

    it("accepts only the exact signed showcase authority in provisioned-only mode", async () => {
        const exact = teacherServerSession.createSignedTeacherSessionCookie(TOKEN, {
            ...MOCKUP_TEACHER_IDENTITY,
            sessionAuthority: "mockup" as never,
        }, ENV, 1_000);
        const bootstrapLookalike = teacherServerSession.createSignedTeacherSessionCookie(TOKEN, {
            ...MOCKUP_TEACHER_IDENTITY,
            sessionAuthority: "bootstrap",
        }, ENV, 1_000);
        const wrongId = teacherServerSession.createSignedTeacherSessionCookie(TOKEN, {
            ...MOCKUP_TEACHER_IDENTITY,
            teacherId: "omr-showcase-copy",
            sessionAuthority: "mockup" as never,
        }, ENV, 1_000);
        const roleEscalation = teacherServerSession.createSignedTeacherSessionCookie(TOKEN, {
            ...MOCKUP_TEACHER_IDENTITY,
            memberRole: "owner",
            sessionAuthority: "mockup" as never,
        }, ENV, 1_000);
        const tenantEscalation = teacherServerSession.createSignedTeacherSessionCookie(TOKEN, {
            ...MOCKUP_TEACHER_IDENTITY,
            organizationId: "pilot_org_0123456789abcdef01234567",
            organizationName: "Injected",
            sessionAuthority: "mockup" as never,
        }, ENV, 1_000);
        const wrongEmail = teacherServerSession.createSignedTeacherSessionCookie(TOKEN, {
            ...MOCKUP_TEACHER_IDENTITY,
            email: "attacker@example.com",
            sessionAuthority: "mockup" as never,
        }, ENV, 1_000);
        const wrongDisplay = teacherServerSession.createSignedTeacherSessionCookie(TOKEN, {
            ...MOCKUP_TEACHER_IDENTITY,
            displayName: "Injected",
            sessionAuthority: "mockup" as never,
        }, ENV, 1_000);
        const wrongPlan = teacherServerSession.createSignedTeacherSessionCookie(TOKEN, {
            ...MOCKUP_TEACHER_IDENTITY,
            plan: "free",
            sessionAuthority: "mockup" as never,
        }, ENV, 1_000);
        const generationEscalation = teacherServerSession.createSignedTeacherSessionCookie(TOKEN, {
            ...MOCKUP_TEACHER_IDENTITY,
            accountSessionGeneration: 1,
            sessionAuthority: "mockup" as never,
        }, ENV, 1_000);
        const client = clientWith(true);

        await expect(teacherServerSession.resolveAuthorizedTeacherSessionCookie(
            exact, { env: ENV, now: 1_000, accountClient: client },
        )).resolves.toBeNull();
        await expect(teacherServerSession.resolveAuthorizedTeacherSessionCookie(
            exact, { env: ENV, now: 1_000, accountClient: client, allowMockup: true },
        )).resolves.toMatchObject({
            ...MOCKUP_TEACHER_IDENTITY,
            sessionAuthority: "mockup",
        });
        for (const cookie of [
            bootstrapLookalike, wrongId, roleEscalation, tenantEscalation,
            wrongEmail, wrongDisplay, wrongPlan, generationEscalation,
        ]) {
            await expect(teacherServerSession.resolveAuthorizedTeacherSessionCookie(
                cookie, { env: ENV, now: 1_000, accountClient: client, allowMockup: true },
            )).resolves.toBeNull();
        }
        expect(client.rpc).not.toHaveBeenCalled();
    });

    it("rejects a provisioned account cookie when the server is explicitly self-service", async () => {
        const cookie = teacherServerSession.createSignedTeacherSessionCookie(TOKEN, {
            teacherId: "teacher_0123456789abcdef",
            organizationId: "pilot_org_0123456789abcdef01234567",
            organizationName: "Provisioned",
            memberRole: "owner",
            plan: "pro",
            accountSessionGeneration: 3,
            sessionAuthority: "account",
        }, SELF_SERVICE_ENV, 1_000);
        const client = clientWith({
            accountId: "teacher_0123456789abcdef",
            sessionGeneration: 3,
            organizationId: "pilot_org_0123456789abcdef01234567",
            organizationName: "Provisioned",
            memberRole: "owner",
            plan: "pro",
            grantExpiresAt: "2026-08-09T00:00:00Z",
        });

        await expect(teacherServerSession.resolveAuthorizedTeacherSessionCookie(
            cookie,
            { env: SELF_SERVICE_ENV, now: 1_000, accountClient: client },
        )).resolves.toBeNull();
        expect(client.rpc).not.toHaveBeenCalled();
    });

    it("overrides stale signed account plan and organization name with request-time database truth", async () => {
        const organizationId = "pilot_org_0123456789abcdef01234567";
        const cookie = teacherServerSession.createSignedTeacherSessionCookie(TOKEN, {
            teacherId: "teacher_0123456789abcdef",
            organizationId,
            organizationName: "오래된 이름",
            memberRole: "owner",
            plan: "pro",
            sessionAuthority: "account",
            accountSessionGeneration: 3,
        }, ENV, 1_000);
        const client = clientWith({
            accountId: "teacher_0123456789abcdef",
            sessionGeneration: 3,
            organizationId,
            organizationName: "현재 이름",
            memberRole: "owner",
            plan: "free",
            grantExpiresAt: null,
        });

        await expect(teacherServerSession.resolveAuthorizedTeacherSessionCookie(cookie, {
            env: ENV,
            now: 1_000,
            accountClient: client,
        })).resolves.toMatchObject({ organizationId, organizationName: "현재 이름", plan: "free" });
        expect(client.rpc).toHaveBeenCalledWith("omr_validate_provisioned_teacher_session_v1", {
            p_account_id: "teacher_0123456789abcdef",
            p_session_generation: 3,
            p_organization_id: organizationId,
        });
    });
});
