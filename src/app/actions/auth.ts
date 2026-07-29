"use server";

import { cookies, headers } from "next/headers";
import {
    inspectTeacherAuthConfig,
    mintTeacherToken,
    TEACHER_AUTH_DEPLOYMENT_CONFIG_ERROR,
    TEACHER_AUTH_ERROR,
    verifyTeacherLogin,
    type TeacherLoginIdentity,
} from "@/lib/teacherAuth";
import {
    TEACHER_AUTH_SESSION_CONFIG_ERROR,
    TEACHER_AUTH_SESSION_COOKIE_ERROR,
} from "@/lib/teacherAuthMessages";
import { bootstrapWorkspaceWithServiceRole } from "@/lib/supabaseServerAdmin";
import {
    buildTeacherLoginRateLimitKeys,
    checkTeacherLoginRateLimit,
    recordTeacherLoginFailure,
    recordTeacherLoginSuccess,
    TEACHER_LOGIN_RATE_LIMIT_ERROR,
} from "@/lib/teacherLoginRateLimit";
import {
    createSignedTeacherSessionCookie,
    parseSignedTeacherSessionCookie,
    shouldUseSecureTeacherSessionCookie,
    TEACHER_SERVER_SESSION_COOKIE,
    TEACHER_SERVER_SESSION_MAX_AGE_SECONDS,
} from "@/lib/teacherServerSession";
import { isSameOriginServerActionRequest, SERVER_ACTION_ORIGIN_ERROR } from "@/lib/serverActionSecurity";
import { buildDeploymentReadiness, type DeploymentReadinessSummary } from "@/lib/deploymentReadiness";
import { workspaceContextFromIdentity } from "@/lib/workspaceContext";
import { probeSupabaseDeploymentWithServiceRole } from "@/lib/supabaseReadinessProbe";
import { isMockupTeacherIdentity, MOCKUP_TEACHER_IDENTITY } from "@/lib/mockupAccount";
import { consumeTeacherDeploymentReadinessRateLimit } from "@/lib/deploymentReadinessActionSecurity";

function clientFingerprintFromHeaders(headerStore: Headers): string {
    const forwardedFor = headerStore.get("x-forwarded-for")?.split(",")[0]?.trim();
    return forwardedFor
        || headerStore.get("x-real-ip")?.trim()
        || headerStore.get("user-agent")?.trim()
        || "unknown-client";
}

/**
 * Server action to verify teacher credentials securely without exposing them to client-side code bundles.
 */
export async function verifyTeacherPassword(
    identifier: string,
    password: string,
): Promise<{ success: boolean; token?: string; teacher?: TeacherLoginIdentity; error?: string }> {
    const authConfig = inspectTeacherAuthConfig();
    if (authConfig.credentialCount === 0) {
        return {
            success: false,
            error: TEACHER_AUTH_DEPLOYMENT_CONFIG_ERROR,
        };
    }

    const headerStore = await headers();
    if (!isSameOriginServerActionRequest(headerStore)) {
        return {
            success: false,
            error: SERVER_ACTION_ORIGIN_ERROR,
        };
    }

    const rateLimitKeys = buildTeacherLoginRateLimitKeys(identifier, clientFingerprintFromHeaders(headerStore));
    const rateLimit = checkTeacherLoginRateLimit(rateLimitKeys);
    if (!rateLimit.allowed) {
        return {
            success: false,
            error: TEACHER_LOGIN_RATE_LIMIT_ERROR,
        };
    }

    const result = verifyTeacherLogin(identifier, password);
    if (result.success && result.teacher) {
        const token = mintTeacherToken();
        const serverSession = createSignedTeacherSessionCookie(token, result.teacher);
        if (!serverSession) {
            return {
                success: false,
                error: TEACHER_AUTH_SESSION_CONFIG_ERROR,
            };
        }

        try {
            const cookieStore = await cookies();
            cookieStore.set(TEACHER_SERVER_SESSION_COOKIE, serverSession, {
                httpOnly: true,
                sameSite: "lax",
                secure: shouldUseSecureTeacherSessionCookie(headerStore.get("host")),
                path: "/",
                maxAge: TEACHER_SERVER_SESSION_MAX_AGE_SECONDS,
            });
        } catch (error) {
            console.error("Teacher session cookie write failed", error);
            return {
                success: false,
                error: TEACHER_AUTH_SESSION_COOKIE_ERROR,
            };
        }

        recordTeacherLoginSuccess(rateLimitKeys);
        const bootstrapResult = await bootstrapWorkspaceWithServiceRole(workspaceContextFromIdentity(result.teacher));
        if (!bootstrapResult.ok && !bootstrapResult.skipped) {
            console.warn("Teacher workspace bootstrap failed", bootstrapResult.error);
        }

        return {
            success: true,
            token,
            teacher: result.teacher,
        };
    }

    recordTeacherLoginFailure(rateLimitKeys);
    return {
        success: false,
        error: TEACHER_AUTH_ERROR,
    };
}

/**
 * Starts the public showcase workspace without touching a configured teacher
 * account or bootstrapping a real Supabase workspace. The signed session is
 * still required so the regular teacher route guard stays intact.
 */
export async function startMockupTeacherSession(): Promise<{
    success: boolean;
    token?: string;
    teacher?: TeacherLoginIdentity;
    error?: string;
}> {
    const headerStore = await headers();
    if (!isSameOriginServerActionRequest(headerStore)) {
        return { success: false, error: SERVER_ACTION_ORIGIN_ERROR };
    }

    const token = mintTeacherToken();
    const serverSession = createSignedTeacherSessionCookie(token, MOCKUP_TEACHER_IDENTITY);
    if (!serverSession) {
        return { success: false, error: TEACHER_AUTH_SESSION_CONFIG_ERROR };
    }

    try {
        const cookieStore = await cookies();
        cookieStore.set(TEACHER_SERVER_SESSION_COOKIE, serverSession, {
            httpOnly: true,
            sameSite: "lax",
            secure: shouldUseSecureTeacherSessionCookie(headerStore.get("host")),
            path: "/",
            maxAge: TEACHER_SERVER_SESSION_MAX_AGE_SECONDS,
        });
    } catch (error) {
        console.error("Mockup teacher session cookie write failed", error);
        return { success: false, error: TEACHER_AUTH_SESSION_COOKIE_ERROR };
    }

    return {
        success: true,
        token,
        teacher: MOCKUP_TEACHER_IDENTITY,
    };
}

export async function clearTeacherAuthSession(): Promise<{ success: true }> {
    const headerStore = await headers();
    if (!isSameOriginServerActionRequest(headerStore)) {
        return { success: true };
    }

    const cookieStore = await cookies();
    cookieStore.delete(TEACHER_SERVER_SESSION_COOKIE);
    return { success: true };
}

export async function getTeacherDeploymentReadiness(): Promise<DeploymentReadinessSummary> {
    const blockedSummary = (): DeploymentReadinessSummary => ({
        label: "배포 상태 확인 불가",
        detail: "인증된 교사 세션에서만 배포 상태를 확인할 수 있습니다.",
        credentialCount: 0,
        readyCount: 0,
        totalCount: 1,
        checks: [{
            key: "deployment_readiness_access",
            label: "배포 상태 접근",
            detail: "요청 권한을 확인한 뒤 다시 시도하세요.",
            tone: "error",
        }],
    });

    const headerStore = await headers();
    if (!isSameOriginServerActionRequest(headerStore)) return blockedSummary();

    const cookieStore = await cookies();
    const session = parseSignedTeacherSessionCookie(
        cookieStore.get(TEACHER_SERVER_SESSION_COOKIE)?.value,
    );
    if (!session || isMockupTeacherIdentity(session)) return blockedSummary();
    if (!consumeTeacherDeploymentReadinessRateLimit(session)) return blockedSummary();

    const databaseProbe = await probeSupabaseDeploymentWithServiceRole();
    return buildDeploymentReadiness(process.env, databaseProbe);
}
