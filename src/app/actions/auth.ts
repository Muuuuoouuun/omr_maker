"use server";

import { cookies, headers } from "next/headers";
import { mintTeacherToken, TEACHER_AUTH_ERROR, verifyTeacherLogin, type TeacherLoginIdentity } from "@/lib/teacherAuth";
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
    shouldUseSecureTeacherSessionCookie,
    TEACHER_SERVER_SESSION_COOKIE,
    TEACHER_SERVER_SESSION_MAX_AGE_SECONDS,
} from "@/lib/teacherServerSession";
import { workspaceContextFromIdentity } from "@/lib/workspaceContext";

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
    const headerStore = await headers();
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
        recordTeacherLoginSuccess(rateLimitKeys);
        const token = mintTeacherToken();
        const serverSession = createSignedTeacherSessionCookie(token, result.teacher);
        if (serverSession) {
            const cookieStore = await cookies();
            cookieStore.set(TEACHER_SERVER_SESSION_COOKIE, serverSession, {
                httpOnly: true,
                sameSite: "lax",
                secure: shouldUseSecureTeacherSessionCookie(headerStore.get("host")),
                path: "/",
                maxAge: TEACHER_SERVER_SESSION_MAX_AGE_SECONDS,
            });
        }
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

export async function clearTeacherAuthSession(): Promise<{ success: true }> {
    const cookieStore = await cookies();
    cookieStore.delete(TEACHER_SERVER_SESSION_COOKIE);
    return { success: true };
}
