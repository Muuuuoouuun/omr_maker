"use server";

import { cookies, headers } from "next/headers";
import { randomUUID } from "node:crypto";
import {
    createSignedStudentSessionCookie,
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

export async function issueGuestSession(name?: string): Promise<{ ok: boolean; guestId?: string }> {
    const guestId = randomUUID();
    const result = await setSessionCookie({
        kind: "guest", guestId, name: name?.trim() || "Guest Student", identityType: "guest",
    });
    return { ok: result.ok, guestId: result.ok ? guestId : undefined };
}

export async function issueStudentSession(identity: {
    studentId: string; name: string; groupId?: string; groupName?: string; regionId?: string; regionName?: string;
}): Promise<{ ok: boolean }> {
    if (!identity.studentId.trim() || !identity.name.trim()) return { ok: false };
    return setSessionCookie({ kind: "student", ...identity, identityType: "temporary" });
}
