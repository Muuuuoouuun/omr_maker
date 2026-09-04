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
import { bootstrapWorkspaceWithServiceRole, verifySupabaseAuthAccessToken } from "@/lib/supabaseServerAdmin";
import {
    buildTeacherLoginRateLimitKeys,
    checkTeacherLoginRateLimit,
    recordTeacherLoginFailure,
    recordTeacherLoginSuccess,
    TEACHER_LOGIN_RATE_LIMIT_ERROR,
    TEACHER_LOGIN_LOCKOUT_MS,
    TEACHER_LOGIN_MAX_FAILURES,
    TEACHER_LOGIN_WINDOW_MS,
} from "@/lib/teacherLoginRateLimit";
import {
    checkSharedLoginRateLimit,
    clearSharedLoginRateLimit,
    recordSharedLoginFailure,
} from "@/lib/sharedLoginRateLimit";
import {
    createSignedTeacherSessionCookie,
    shouldUseSecureTeacherSessionCookie,
    TEACHER_SERVER_SESSION_COOKIE,
    TEACHER_SERVER_SESSION_MAX_AGE_SECONDS,
} from "@/lib/teacherServerSession";
import { isSameOriginServerActionRequest, SERVER_ACTION_ORIGIN_ERROR } from "@/lib/serverActionSecurity";
import { buildDeploymentReadiness, type DeploymentReadinessSummary } from "@/lib/deploymentReadiness";
import { workspaceContextFromIdentity } from "@/lib/workspaceContext";
import { probeSupabaseDeploymentWithServiceRole } from "@/lib/supabaseReadinessProbe";
import { MOCKUP_TEACHER_IDENTITY } from "@/lib/mockupAccount";

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
    if (!authConfig.ready) {
        return {
            success: false,
            error: authConfig.issues[0]?.detail || TEACHER_AUTH_DEPLOYMENT_CONFIG_ERROR,
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
    const sharedRateLimitOptions = {
        keys: rateLimitKeys,
        maxFailures: TEACHER_LOGIN_MAX_FAILURES,
        windowMs: TEACHER_LOGIN_WINDOW_MS,
        lockoutMs: TEACHER_LOGIN_LOCKOUT_MS,
    };
    const rateLimit = await checkSharedLoginRateLimit(sharedRateLimitOptions)
        ?? checkTeacherLoginRateLimit(rateLimitKeys);
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

        await clearSharedLoginRateLimit(rateLimitKeys);
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

    await recordSharedLoginFailure(sharedRateLimitOptions);
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

export async function startSupabaseTeacherSession(accessToken: string): Promise<{
    success: boolean;
    token?: string;
    teacher?: TeacherLoginIdentity;
    error?: string;
}> {
    const headerStore = await headers();
    if (!isSameOriginServerActionRequest(headerStore)) {
        return { success: false, error: SERVER_ACTION_ORIGIN_ERROR };
    }

    const verified = await verifySupabaseAuthAccessToken(accessToken);
    if (!verified.user) return { success: false, error: verified.error || "교사 계정을 확인하지 못했습니다." };

    const teacher: TeacherLoginIdentity = {
        teacherId: verified.user.id,
        email: verified.user.email,
        displayName: verified.user.displayName,
        plan: "free",
        memberRole: "owner",
    };
    const bootstrapResult = await bootstrapWorkspaceWithServiceRole(workspaceContextFromIdentity(teacher));
    if (!bootstrapResult.ok) {
        return { success: false, error: bootstrapResult.error || "학원 워크스페이스를 준비하지 못했습니다." };
    }

    const token = mintTeacherToken();
    const serverSession = createSignedTeacherSessionCookie(token, teacher);
    if (!serverSession) return { success: false, error: TEACHER_AUTH_SESSION_CONFIG_ERROR };

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
        console.error("Supabase teacher session cookie write failed", error);
        return { success: false, error: TEACHER_AUTH_SESSION_COOKIE_ERROR };
    }

    return { success: true, token, teacher };
}

export async function clearTeacherAuthSession(): Promise<{ success: boolean; error?: string }> {
    const headerStore = await headers();
    if (!isSameOriginServerActionRequest(headerStore)) {
        return { success: false, error: SERVER_ACTION_ORIGIN_ERROR };
    }

    try {
        const cookieStore = await cookies();
        cookieStore.delete(TEACHER_SERVER_SESSION_COOKIE);
        return { success: true };
    } catch (error) {
        console.error("Teacher session cookie delete failed", error);
        return { success: false, error: "교사 세션을 종료하지 못했습니다. 연결을 확인한 뒤 다시 시도해주세요." };
    }
}

export async function getTeacherDeploymentReadiness(): Promise<DeploymentReadinessSummary> {
    const databaseProbe = await probeSupabaseDeploymentWithServiceRole();
    return buildDeploymentReadiness(process.env, databaseProbe);
}
