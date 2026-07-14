"use server";

import { cookies, headers } from "next/headers";
import { randomUUID } from "node:crypto";
import {
    createSignedStudentSessionCookie,
    parseSignedStudentSessionCookie,
    STUDENT_SERVER_SESSION_COOKIE,
    STUDENT_SERVER_SESSION_MAX_AGE_SECONDS,
    type StudentIdentityInput,
} from "@/lib/studentServerSession";
import { shouldUseSecureTeacherSessionCookie } from "@/lib/teacherServerSession";
import { resolveStudentServerMode } from "@/lib/studentServerAccess";
import {
    createSupabaseAdminClient,
    getSupabaseServerConfigFromEnv,
    type SupabaseAdminReadClientLike,
} from "@/lib/supabaseServerAdmin";
import { loadStudentRosterSnapshot } from "@/lib/studentRosterSource";
import {
    verifyStudentLogin,
    type StudentLoginRequest,
    type StudentVerificationReason,
} from "@/lib/studentRosterVerification";

async function setSessionCookie(input: StudentIdentityInput): Promise<{ ok: boolean }> {
    const value = createSignedStudentSessionCookie(input);
    if (!value) return { ok: false };
    const headerStore = await headers();
    const cookieStore = await cookies();
    cookieStore.set(STUDENT_SERVER_SESSION_COOKIE, value, {
        httpOnly: true,
        sameSite: "lax",
        secure: shouldUseSecureTeacherSessionCookie(headerStore.get("host")),
        path: "/",
        maxAge: STUDENT_SERVER_SESSION_MAX_AGE_SECONDS,
    });
    return { ok: true };
}

/**
 * Ensure a server-signed guest session. A valid guest cookie is reused so the
 * guest identity (and their attempt history) survives repeated logins and direct
 * exam-link entries; only the display name is refreshed when provided. The guestId
 * is ALWAYS server-generated — never client-supplied — so a guest cannot pick its
 * own identity.
 */
export async function issueGuestSession(name?: string): Promise<{ ok: boolean; guestId?: string }> {
    const trimmedName = name?.trim();
    const cookieStore = await cookies();
    const existing = parseSignedStudentSessionCookie(cookieStore.get(STUDENT_SERVER_SESSION_COOKIE)?.value);
    if (existing?.kind === "guest" && existing.guestId) {
        if (!trimmedName || trimmedName === existing.name) {
            return { ok: true, guestId: existing.guestId };
        }
        const refreshed = await setSessionCookie({
            kind: "guest", guestId: existing.guestId, name: trimmedName, identityType: "guest",
        });
        return { ok: refreshed.ok, guestId: refreshed.ok ? existing.guestId : undefined };
    }
    const guestId = randomUUID();
    const result = await setSessionCookie({
        kind: "guest", guestId, name: trimmedName || "Guest Student", identityType: "guest",
    });
    return { ok: result.ok, guestId: result.ok ? guestId : undefined };
}

export interface IssueStudentSessionRequest extends StudentLoginRequest {
    /** Organization whose roster the login is verified against (from the exam/class link). */
    organizationId: string;
}

export type IssueStudentSessionResult =
    | { ok: true; issuedCode?: string }
    | { ok: false; reason: StudentVerificationReason | "roster_unavailable" };

/**
 * Issue a student (temporary) session ONLY after server-side roster + start-code
 * verification. The previous design signed whatever studentId/groupId the client
 * sent, letting anyone impersonate any student in any group. Here the identity is
 * built by the server from the trusted roster snapshot; a login that matches no
 * roster profile (or fails the start-code check) never produces a signed session.
 *
 * Fails closed: without the service role there is no trusted roster to verify
 * against, so no student session is issued (production or otherwise).
 */
export async function issueStudentSession(
    request: IssueStudentSessionRequest,
): Promise<IssueStudentSessionResult> {
    const organizationId = request.organizationId?.trim();
    if (!organizationId) return { ok: false, reason: "roster_unavailable" };

    // No trusted server roster source → refuse rather than trust the client.
    if (resolveStudentServerMode() !== "service_role") {
        return { ok: false, reason: "roster_unavailable" };
    }
    const config = getSupabaseServerConfigFromEnv();
    if (!config) return { ok: false, reason: "roster_unavailable" };

    try {
        const admin = createSupabaseAdminClient(config) as unknown as SupabaseAdminReadClientLike;
        const snapshot = await loadStudentRosterSnapshot(admin, organizationId);
        const verification = verifyStudentLogin(request, snapshot);
        if (!verification.ok) return { ok: false, reason: verification.reason };

        const signed = await setSessionCookie(verification.identity);
        if (!signed.ok) return { ok: false, reason: "roster_unavailable" };
        return { ok: true, issuedCode: verification.issuedCode };
    } catch (error) {
        console.error("issueStudentSession failed", error);
        return { ok: false, reason: "roster_unavailable" };
    }
}

/**
 * Logout must clear the httpOnly server cookie too — otherwise the next person on
 * a shared device inherits the previous student/guest server identity.
 */
export async function clearStudentServerSession(): Promise<{ ok: boolean }> {
    const cookieStore = await cookies();
    cookieStore.delete(STUDENT_SERVER_SESSION_COOKIE);
    return { ok: true };
}
