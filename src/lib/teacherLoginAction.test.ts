import { beforeEach, describe, expect, it, vi } from "vitest";

const controls = vi.hoisted(() => ({
    identityMode: "provisioned_only" as "provisioned_only" | "self_service",
    provisionedAccount: null as null | Record<string, unknown>,
    legacyAccount: null as null | Record<string, unknown>,
    passwordMatches: false,
    verifier: vi.fn(),
    cookieSet: vi.fn(),
    bootstrap: vi.fn(),
    loginFailure: vi.fn(),
    loginSuccess: vi.fn(),
    durableLimit: vi.fn(),
    durableSubjects: vi.fn(),
}));

vi.mock("next/headers", () => ({
    headers: async () => new Headers({
        origin: "http://localhost:3003",
        host: "localhost:3003",
        "user-agent": "bounded-test-client",
    }),
    cookies: async () => ({ set: controls.cookieSet, get: vi.fn(), delete: vi.fn() }),
}));

vi.mock("@/lib/serverActionSecurity", () => ({
    isSameOriginServerActionRequest: () => true,
    SERVER_ACTION_ORIGIN_ERROR: "origin_error",
}));

vi.mock("@/lib/teacherAuth", () => ({
    inspectTeacherAuthConfig: () => ({ credentialCount: 1, ready: true, issues: [], warnings: [] }),
    mintTeacherToken: () => "tkn_action_0123456789abcdef0123456789abcdef",
    TEACHER_AUTH_DEPLOYMENT_CONFIG_ERROR: "deployment_error",
    TEACHER_AUTH_ERROR: "same_public_error",
    verifyTeacherLogin: () => ({ success: false }),
}));

vi.mock("@/lib/teacherAuthMessages", () => ({
    TEACHER_AUTH_SESSION_CONFIG_ERROR: "session_config_error",
    TEACHER_AUTH_SESSION_COOKIE_ERROR: "session_cookie_error",
    TEACHER_LOGIN_UNAVAILABLE_MESSAGE: "login_unavailable",
}));

vi.mock("@/lib/supabaseServerAdmin", () => ({
    getSupabaseServerConfigFromEnv: () => ({
        url: "https://example.supabase.co",
        serviceRoleKey: "service-role",
        backendTimeoutMs: 5_000,
    }),
    createSupabaseAdminClient: () => ({ rpc: vi.fn() }),
    bootstrapWorkspaceWithServiceRole: (...args: unknown[]) => {
        controls.bootstrap(...args);
        return Promise.resolve({ ok: true, skipped: false });
    },
}));

vi.mock("@/lib/teacherLoginRateLimit", () => ({
    buildTeacherLoginRateLimitKeys: () => ["identifier-hash"],
    buildTeacherLoginSafetyRateLimitKey: () => "global-safety-hash",
    checkTeacherLoginRateLimit: () => ({ allowed: true, retryAfterMs: 0 }),
    recordTeacherLoginFailure: (...args: unknown[]) => controls.loginFailure(...args),
    recordTeacherLoginSuccess: (...args: unknown[]) => controls.loginSuccess(...args),
    TEACHER_LOGIN_RATE_LIMIT_ERROR: "rate_limit_error",
    TEACHER_LOGIN_LOCKOUT_MS: 600_000,
    TEACHER_LOGIN_MAX_FAILURES: 5,
    TEACHER_LOGIN_WINDOW_MS: 600_000,
    TEACHER_LOGIN_GLOBAL_MAX_ATTEMPTS: 500,
}));

vi.mock("@/lib/durableRateLimit", () => ({
    applyDurableRateLimit: (...args: unknown[]) => controls.durableLimit(...args),
    applyDurableRateLimitToSubjects: (...args: unknown[]) => controls.durableSubjects(...args),
}));

vi.mock("@/lib/teacherAccountGateway", () => ({
    lookupProvisionedTeacherLogin: async () => controls.provisionedAccount,
    findActiveTeacherAccount: async () => controls.legacyAccount,
}));

vi.mock("@/lib/teacherAccountLifecycle", () => ({
    isTeacherBootstrapLoginEnabled: () => controls.identityMode === "self_service",
    verifyTeacherAccountPasswordConstantWorkAsync: async (...args: unknown[]) => {
        controls.verifier(...args);
        return controls.passwordMatches;
    },
}));

vi.mock("@/lib/teacherIdentityMode.server", () => ({
    resolveTeacherIdentityMode: () => controls.identityMode,
}));

vi.mock("@/lib/teacherServerSession", () => ({
    createSignedTeacherSessionCookie: () => "signed-cookie",
    resolveAuthorizedTeacherSessionCookie: async () => null,
    shouldUseSecureTeacherSessionCookie: () => false,
    TEACHER_SERVER_SESSION_COOKIE: "omr_teacher_server_session",
    TEACHER_SERVER_SESSION_MAX_AGE_SECONDS: 43_200,
}));

vi.mock("@/lib/workspaceContext", () => ({
    workspaceContextFromIdentity: (identity: unknown) => identity,
}));

import { startMockupTeacherSession, verifyTeacherPassword } from "@/app/actions/auth";

const provisionedAccount = {
    accountId: "teacher_0123456789abcdef",
    email: "owner@example.com",
    displayName: "원장님",
    passwordHash: "pbkdf2-sha256:120000:00112233445566778899aabbccddeeff:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    sessionGeneration: 7,
    organizationId: "pilot_org_0123456789abcdef01234567",
    organizationName: "정확한 학원",
    memberRole: "owner",
    plan: "pro",
    grantExpiresAt: "2026-08-09T00:00:00Z",
};

describe("teacher login action identity binding", () => {
    beforeEach(() => {
        controls.identityMode = "provisioned_only";
        controls.provisionedAccount = null;
        controls.legacyAccount = null;
        controls.passwordMatches = false;
        controls.verifier.mockClear();
        controls.cookieSet.mockClear();
        controls.bootstrap.mockClear();
        controls.loginFailure.mockClear();
        controls.loginSuccess.mockClear();
        controls.durableLimit.mockReset().mockResolvedValue({ allowed: true, retryAfterMs: 0 });
        controls.durableSubjects.mockReset().mockResolvedValue({ allowed: true, retryAfterMs: 0 });
    });

    it.each(["global", "identifier"])("reports %s limiter outages as unavailable before checking credentials", async stage => {
        const limiter = stage === "global" ? controls.durableLimit : controls.durableSubjects;
        limiter.mockResolvedValue({ allowed: false, retryAfterMs: 60_000, reason: "unavailable" });
        await expect(verifyTeacherPassword("owner@example.com", "correct-password"))
            .resolves.toEqual({ success: false, error: "login_unavailable" });
        expect(controls.verifier).not.toHaveBeenCalled();
        expect(controls.cookieSet).not.toHaveBeenCalled();
        expect(controls.loginFailure).not.toHaveBeenCalled();
    });

    it("keeps actual login throttling distinct from an outage", async () => {
        controls.durableLimit.mockResolvedValue({ allowed: false, retryAfterMs: 60_000 });
        await expect(verifyTeacherPassword("owner@example.com", "correct-password"))
            .resolves.toEqual({ success: false, error: "rate_limit_error" });
        expect(controls.verifier).not.toHaveBeenCalled();
    });

    it("returns and persists the exact provisioned account tenant/session without bootstrap", async () => {
        controls.provisionedAccount = provisionedAccount;
        controls.passwordMatches = true;

        await expect(verifyTeacherPassword("owner@example.com", "correct-password"))
            .resolves.toMatchObject({
                success: true,
                teacher: {
                    teacherId: provisionedAccount.accountId,
                    organizationId: provisionedAccount.organizationId,
                    organizationName: provisionedAccount.organizationName,
                    memberRole: "owner",
                    plan: "pro",
                },
                session: {
                    teacherId: provisionedAccount.accountId,
                    organizationId: provisionedAccount.organizationId,
                    sessionAuthority: "account",
                    accountSessionGeneration: 7,
                },
            });
        expect(controls.verifier).toHaveBeenCalledOnce();
        expect(controls.cookieSet).toHaveBeenCalledOnce();
        expect(controls.bootstrap).not.toHaveBeenCalled();
        expect(controls.loginSuccess).toHaveBeenCalledOnce();
    });

    it("returns one exact client-safe showcase snapshot without workspace bootstrap", async () => {
        await expect(startMockupTeacherSession()).resolves.toMatchObject({
            success: true,
            teacher: {
                teacherId: "omr-showcase",
                email: "demo@omrmaker.kr",
                displayName: "김하늘 선생님",
                plan: "academy",
            },
            session: {
                teacherId: "omr-showcase",
                email: "demo@omrmaker.kr",
                displayName: "김하늘 선생님",
                plan: "academy",
                sessionAuthority: "mockup",
            },
        });
        expect(controls.cookieSet).toHaveBeenCalledOnce();
        expect(controls.bootstrap).not.toHaveBeenCalled();
    });

    it("keeps all provisioned candidate failures non-enumerating and constant-work", async () => {
        const candidates: Array<{ label: string; account: Record<string, unknown> | null; passwordMatches: boolean }> = [
            { label: "unknown", account: null, passwordMatches: false },
            { label: "disabled", account: null, passwordMatches: false },
            { label: "ambiguous graph", account: null, passwordMatches: false },
            { label: "malformed envelope", account: null, passwordMatches: false },
            { label: "RPC error", account: null, passwordMatches: false },
            { label: "wrong password", account: provisionedAccount, passwordMatches: false },
        ];

        for (const candidate of candidates) {
            controls.provisionedAccount = candidate.account;
            controls.passwordMatches = candidate.passwordMatches;
            controls.verifier.mockClear();
            controls.cookieSet.mockClear();
            controls.bootstrap.mockClear();
            controls.loginFailure.mockClear();

            const result = await verifyTeacherPassword(`${candidate.label}@example.com`, "attempt");

            expect(result, candidate.label).toEqual({ success: false, error: "same_public_error" });
            expect(controls.verifier, candidate.label).toHaveBeenCalledOnce();
            expect(controls.cookieSet, candidate.label).not.toHaveBeenCalled();
            expect(controls.bootstrap, candidate.label).not.toHaveBeenCalled();
            expect(controls.loginFailure, candidate.label).toHaveBeenCalledOnce();
        }
    });

    it("preserves self-service legacy-account login and workspace bootstrap", async () => {
        controls.identityMode = "self_service";
        controls.legacyAccount = {
            id: "teacher_legacy00000001",
            email: "legacy@example.com",
            displayName: "레거시 교사",
            passwordHash: provisionedAccount.passwordHash,
            status: "active",
            sessionGeneration: 4,
        };
        controls.passwordMatches = true;

        await expect(verifyTeacherPassword("legacy@example.com", "correct-password"))
            .resolves.toMatchObject({
                success: true,
                teacher: { teacherId: "teacher_legacy00000001", plan: "free" },
                session: {
                    teacherId: "teacher_legacy00000001",
                    sessionAuthority: "legacy_account",
                    accountSessionGeneration: 4,
                },
            });
        expect(controls.verifier).toHaveBeenCalledOnce();
        expect(controls.cookieSet).toHaveBeenCalledOnce();
        expect(controls.bootstrap).toHaveBeenCalledOnce();
    });
});
