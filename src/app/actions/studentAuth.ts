"use server";

import { cookies, headers } from "next/headers";
import {
    createSupabaseAdminClient,
    getSupabaseServerConfigFromEnv,
} from "@/lib/supabaseServerAdmin";
import {
    STUDENT_SERVER_SESSION_COOKIE,
} from "@/lib/studentServerSession";
import {
    issueStudentCredentialBatch as issueStudentCredentialBatchWithGateway,
    validateCredentialBatch,
    validateCredentialBatchIdempotencyKey,
    type IssueStudentCredentialBatchResult,
    type StudentCredentialBatchGatewayClient,
} from "@/lib/studentCredentialBatchGateway.server";
import { isSameOriginServerActionRequest } from "@/lib/serverActionSecurity";
import {
    resolveAuthorizedTeacherSessionCookie,
    TEACHER_SERVER_SESSION_COOKIE,
} from "@/lib/teacherServerSession";
import { workspaceContextFromTeacherSession } from "@/lib/workspaceContext";
import { canTeacherRoleWrite } from "@/lib/teacherSession";

function adminClient() {
    const config = getSupabaseServerConfigFromEnv();
    return config ? createSupabaseAdminClient(config) : null;
}

export async function logoutStudentServerSession(): Promise<{ success: true }> {
    const headerStore = await headers();
    if (isSameOriginServerActionRequest(headerStore)) {
        const cookieStore = await cookies();
        cookieStore.delete(STUDENT_SERVER_SESSION_COOKIE);
    }
    return { success: true };
}

export async function issueStudentStartCredential(
    studentId: string,
    idempotencyKey: string,
): Promise<
    | { success: true; startCode: string }
    | { success: false; status: "error" | "outcome_unknown" | "replayed_without_credentials"; error: string }
> {
    const result = await issueAuthorizedStudentCredentialBatch([studentId], idempotencyKey);
    if (result.status === "issued" && result.credentials.length === 1) {
        return { success: true, startCode: result.credentials[0].startCode };
    }
    if (result.status === "rejected" && result.error === "forbidden") {
        return { success: false, status: "error", error: "학생 시작 코드를 발급할 권한이 없습니다." };
    }
    if (result.status === "already_applied") {
        return {
            success: false,
            status: "replayed_without_credentials",
            error: "발급은 완료됐지만 보안상 시작 코드를 다시 표시할 수 없습니다. 새 코드를 발급해주세요.",
        };
    }
    if (result.status === "outcome_unknown") {
        return {
            success: false,
            status: "outcome_unknown",
            error: "발급 결과를 확인할 수 없습니다. 동일 요청으로 상태를 다시 확인해주세요.",
        };
    }
    return { success: false, status: "error", error: "학생 시작 코드를 서버에 저장하지 못했습니다." };
}

export async function issueStudentCredentialBatch(
    studentIds: unknown,
    idempotencyKey: unknown,
): Promise<IssueStudentCredentialBatchResult> {
    if (!validateCredentialBatchIdempotencyKey(idempotencyKey)) {
        return { status: "rejected", error: "invalid_input" };
    }
    return issueAuthorizedStudentCredentialBatch(studentIds, idempotencyKey);
}

async function issueAuthorizedStudentCredentialBatch(
    studentIds: unknown,
    idempotencyKey?: unknown,
): Promise<IssueStudentCredentialBatchResult> {
    const headerStore = await headers();
    if (!isSameOriginServerActionRequest(headerStore)) {
        return { status: "rejected", error: "forbidden" };
    }
    const cookieStore = await cookies();
    const teacherSession = await resolveAuthorizedTeacherSessionCookie(cookieStore.get(TEACHER_SERVER_SESSION_COOKIE)?.value);
    if (!teacherSession) return { status: "rejected", error: "forbidden" };
    if (!canTeacherRoleWrite(teacherSession.memberRole)) {
        return { status: "rejected", error: "forbidden" };
    }
    const batch = validateCredentialBatch(studentIds);
    if (!batch.ok) return { status: "rejected", error: batch.error };

    try {
        const client = adminClient();
        if (!client) {
            return { status: "unavailable", error: "dependency_unavailable" };
        }
        const context = workspaceContextFromTeacherSession(teacherSession);
        return await issueStudentCredentialBatchWithGateway({
            sessionAuthority: context.sessionAuthority,
            accountId: context.accountId,
            accountSessionGeneration: context.accountSessionGeneration,
            organizationId: context.organizationId,
            actorUserId: context.actorUserId,
            studentIds: batch.studentIds,
            idempotencyKey,
        }, client as unknown as StudentCredentialBatchGatewayClient);
    } catch {
        return { status: "unavailable", error: "dependency_unavailable" };
    }
}
