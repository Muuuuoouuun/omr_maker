"use server";

import { cookies, headers } from "next/headers";
import {
    createSupabaseAdminClient,
    getSupabaseServerConfigFromEnv,
} from "@/lib/supabaseServerAdmin";
import {
    hashStudentStartCode,
    verifyStudentCredentials,
    type StudentCredentialClient,
} from "@/lib/studentCredentialVerifier";
import {
    createSignedStudentSessionCookie,
    shouldUseSecureStudentSessionCookie,
    STUDENT_SERVER_SESSION_COOKIE,
    STUDENT_SERVER_SESSION_MAX_AGE_SECONDS,
} from "@/lib/studentServerSession";
import { isSameOriginServerActionRequest } from "@/lib/serverActionSecurity";
import {
    parseSignedTeacherSessionCookie,
    TEACHER_SERVER_SESSION_COOKIE,
} from "@/lib/teacherServerSession";
import { workspaceContextFromTeacherSession } from "@/lib/workspaceContext";
import type { VerifiedStudentIdentity } from "@/lib/studentExamContract";

export type StudentServerLoginResult =
    | { success: true; student: VerifiedStudentIdentity }
    | { success: false; status: "invalid_credentials" | "credential_not_configured" | "service_unavailable" | "local_only" };

interface StudentCredentialUpdateClient {
    from(table: string): {
        upsert(values: Record<string, unknown>, options: { onConflict: string }): {
            select(columns: string): {
                maybeSingle(): PromiseLike<{
                    data: { student_profile_id?: string } | null;
                    error: { message?: string } | null;
                }>;
            };
        };
    };
}

function adminClient() {
    const config = getSupabaseServerConfigFromEnv();
    return config ? createSupabaseAdminClient(config) : null;
}

export async function loginStudentWithStartCode(input: {
    studentId: string;
    startCode: string;
    groupId?: string;
}): Promise<StudentServerLoginResult> {
    try {
        const headerStore = await headers();
        if (!isSameOriginServerActionRequest(headerStore)) {
            return { success: false, status: "service_unavailable" };
        }
        const client = adminClient();
        if (!client) {
            return {
                success: false,
                status: process.env.NODE_ENV === "production" ? "service_unavailable" : "local_only",
            };
        }

        const verified = await verifyStudentCredentials(client as unknown as StudentCredentialClient, input);
        if (verified.status !== "verified") {
            return { success: false, status: verified.status };
        }
        const signedCookie = createSignedStudentSessionCookie(verified.identity);
        if (!signedCookie) return { success: false, status: "service_unavailable" };

        const cookieStore = await cookies();
        cookieStore.set(STUDENT_SERVER_SESSION_COOKIE, signedCookie, {
            httpOnly: true,
            sameSite: "lax",
            secure: shouldUseSecureStudentSessionCookie(headerStore.get("host")),
            path: "/",
            maxAge: STUDENT_SERVER_SESSION_MAX_AGE_SECONDS,
        });
        return { success: true, student: verified.identity };
    } catch {
        return { success: false, status: "service_unavailable" };
    }
}

export async function logoutStudentServerSession(): Promise<{ success: true }> {
    const headerStore = await headers();
    if (isSameOriginServerActionRequest(headerStore)) {
        const cookieStore = await cookies();
        cookieStore.delete(STUDENT_SERVER_SESSION_COOKIE);
    }
    return { success: true };
}

export async function issueStudentStartCodeCredential(
    studentId: string,
    startCode: string,
): Promise<{ success: boolean; skipped?: boolean; error?: string }> {
    const headerStore = await headers();
    if (!isSameOriginServerActionRequest(headerStore)) {
        return { success: false, error: "요청 출처를 확인할 수 없습니다." };
    }
    const cookieStore = await cookies();
    const teacherSession = parseSignedTeacherSessionCookie(cookieStore.get(TEACHER_SERVER_SESSION_COOKIE)?.value);
    if (!teacherSession) return { success: false, error: "교사 로그인이 필요합니다." };

    try {
        const client = adminClient();
        if (!client) {
            return process.env.NODE_ENV === "production"
                ? { success: false, error: "서버 학생 인증 저장소가 연결되지 않았습니다." }
                : { success: false, skipped: true, error: "로컬 개발 모드에서는 브라우저에만 저장합니다." };
        }
        const context = workspaceContextFromTeacherSession(teacherSession);
        const hash = hashStudentStartCode(startCode);
        const result = await (client as unknown as StudentCredentialUpdateClient)
            .from("omr_student_start_credentials")
            .upsert({
                organization_id: context.organizationId,
                student_profile_id: studentId.trim(),
                start_code_hash: hash,
                updated_at: new Date().toISOString(),
            }, { onConflict: "organization_id,student_profile_id" })
            .select("student_profile_id")
            .maybeSingle();
        if (result.error) {
            return { success: false, error: result.error.message || "학생 시작 코드를 서버에 저장하지 못했습니다." };
        }
        if (!result.data?.student_profile_id) {
            return { success: false, error: "현재 조직의 학생 명단에서 해당 학생을 찾지 못했습니다." };
        }
        return { success: true };
    } catch {
        return { success: false, error: "학생 시작 코드를 서버에 저장하지 못했습니다." };
    }
}
