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
 * guest identity (and their attempt history) survives repeated logins and
 * direct exam-link entries; only the display name is refreshed when provided.
 * The guestId itself is always server-generated (never client-supplied).
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

export async function issueStudentSession(identity: {
    studentId: string; name: string; groupId?: string; groupName?: string; regionId?: string; regionName?: string;
}): Promise<{ ok: boolean }> {
    if (!identity.studentId.trim() || !identity.name.trim()) return { ok: false };
    return setSessionCookie({ kind: "student", ...identity, identityType: "temporary" });
}

/**
 * Logout must clear the httpOnly server cookie too — otherwise the next person
 * on a shared device inherits the previous student/guest server identity.
 */
export async function clearStudentServerSession(): Promise<{ ok: boolean }> {
    const cookieStore = await cookies();
    cookieStore.delete(STUDENT_SERVER_SESSION_COOKIE);
    return { ok: true };
}
