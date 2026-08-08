"use server";

import { cookies, headers } from "next/headers";
import {
    createSupabaseAdminClient,
    getSupabaseServerConfigFromEnv,
} from "@/lib/supabaseServerAdmin";
import {
    saveTeacherExamWithGateway,
    loadTeacherExamWithGateway,
    listTeacherExamsWithGateway,
    deleteTeacherExamWithGateway,
    type TeacherExamGatewayClient,
    type TeacherExamSaveResult,
} from "@/lib/teacherExamGateway";
import {
    resolveAuthorizedTeacherSessionCookie,
    TEACHER_SERVER_SESSION_COOKIE,
} from "@/lib/teacherServerSession";
import { isTeacherMutationAuthorized } from "@/lib/teacherMutationAuthorization";
import { isSameOriginServerActionRequest } from "@/lib/serverActionSecurity";
import { workspaceContextFromTeacherSession } from "@/lib/workspaceContext";
import type { Exam } from "@/types/omr";
import { reportServerError } from "@/lib/reportServerError";
import { rotateExamEntryInviteWithGateway } from "@/lib/examEntryInviteGateway";

export type TeacherCanonicalExamSaveResult = TeacherExamSaveResult
    | { status: "local_only" | "unauthorized" }
    | { status: "plan_denied"; error: string };

export type TeacherCanonicalExamLoadResult =
    | { status: "loaded"; exam: Exam }
    | { status: "not_found" | "local_only" | "unauthorized" | "service_unavailable"; error?: string };

export type TeacherCanonicalExamListResult =
    | { status: "loaded"; exams: Exam[] }
    | { status: "local_only" | "unauthorized" | "service_unavailable"; error?: string };

export type TeacherExamEntryInviteResult =
    | { status: "issued"; token: string; expiresAt: string }
    | { status: "local_only" | "invalid_scope" | "unauthorized" | "service_unavailable" };

async function teacherGatewayContext(requireWrite = false): Promise<{
    client: TeacherExamGatewayClient;
    context: ReturnType<typeof workspaceContextFromTeacherSession>;
} | { status: "local_only" | "unauthorized" | "service_unavailable" }> {
    const headerStore = await headers();
    if (!isSameOriginServerActionRequest(headerStore)) return { status: "unauthorized" };
    const cookieStore = await cookies();
    const session = await resolveAuthorizedTeacherSessionCookie(cookieStore.get(TEACHER_SERVER_SESSION_COOKIE)?.value);
    if (!session) return { status: "unauthorized" };
    if (requireWrite && !isTeacherMutationAuthorized(session)) return { status: "unauthorized" };
    const config = getSupabaseServerConfigFromEnv();
    if (!config) {
        return { status: process.env.NODE_ENV === "production" ? "service_unavailable" : "local_only" };
    }
    return {
        client: createSupabaseAdminClient(config) as unknown as TeacherExamGatewayClient,
        context: workspaceContextFromTeacherSession(session),
    };
}

export async function saveTeacherCanonicalExam(
    exam: Exam,
): Promise<TeacherCanonicalExamSaveResult> {
    try {
        const headerStore = await headers();
        if (!isSameOriginServerActionRequest(headerStore)) return { status: "unauthorized" };
        const cookieStore = await cookies();
        const session = await resolveAuthorizedTeacherSessionCookie(
            cookieStore.get(TEACHER_SERVER_SESSION_COOKIE)?.value,
        );
        if (!session) return { status: "unauthorized" };
        if (!isTeacherMutationAuthorized(session)) return { status: "unauthorized" };

        const config = getSupabaseServerConfigFromEnv();
        if (!config) {
            return process.env.NODE_ENV === "production"
                ? { status: "service_unavailable", error: "Canonical exam gateway is not configured" }
                : { status: "local_only" };
        }
        const client = createSupabaseAdminClient(config) as unknown as TeacherExamGatewayClient;
        const context = workspaceContextFromTeacherSession(session);
        const result = await saveTeacherExamWithGateway(client, exam, context);
        const planDeniedByDatabase = result.status === "service_unavailable"
            && /plan (?:exam limit exceeded|entitlement required)/i.test(result.error || "");
        if (result.status === "service_unavailable" && !planDeniedByDatabase) {
            await reportServerError("teacher-exam-save", {
                status: result.status,
                code: "service_unavailable",
            });
        }
        if (
            planDeniedByDatabase
        ) {
            return { status: "plan_denied", error: "현재 플랜에서 시험을 저장할 수 없습니다." };
        }
        if (result.status === "service_unavailable") {
            return { status: "service_unavailable", error: "시험 저장 서비스를 사용할 수 없습니다." };
        }
        return result;
    } catch (error) {
        await reportServerError("teacher-exam-save", error);
        return {
            status: "service_unavailable",
            error: "시험 저장 서비스를 사용할 수 없습니다.",
        };
    }
}

export async function loadTeacherCanonicalExam(examId: string): Promise<TeacherCanonicalExamLoadResult> {
    try {
        const gateway = await teacherGatewayContext();
        if ("status" in gateway) return gateway;
        const result = await loadTeacherExamWithGateway(gateway.client, examId, gateway.context);
        if (result.status === "service_unavailable") {
            await reportServerError("teacher-exam-read", { status: result.status, code: "service_unavailable" });
            return { status: result.status, error: "시험을 불러올 수 없습니다." };
        }
        return result;
    } catch (error) {
        await reportServerError("teacher-exam-read", error);
        return { status: "service_unavailable", error: "시험을 불러올 수 없습니다." };
    }
}

export async function listTeacherCanonicalExams(): Promise<TeacherCanonicalExamListResult> {
    try {
        const gateway = await teacherGatewayContext();
        if ("status" in gateway) return gateway;
        const result = await listTeacherExamsWithGateway(gateway.client, gateway.context);
        if (result.status === "loaded") return result;
        await reportServerError("teacher-exam-read", { status: result.status, code: "service_unavailable" });
        return { status: "service_unavailable", error: "시험 목록을 불러올 수 없습니다." };
    } catch (error) {
        await reportServerError("teacher-exam-read", error);
        return { status: "service_unavailable", error: "시험 목록을 불러올 수 없습니다." };
    }
}

export async function deleteTeacherCanonicalExam(examId: string): Promise<
    { status: "deleted"; examId: string }
    | { status: "not_found" | "local_only" | "unauthorized" | "service_unavailable"; error?: string }
> {
    try {
        const gateway = await teacherGatewayContext(true);
        if ("status" in gateway) return gateway;
        const result = await deleteTeacherExamWithGateway(gateway.client, examId, gateway.context);
        if (result.status === "service_unavailable") {
            await reportServerError("teacher-exam-save", { status: result.status, code: "service_unavailable" });
            return { status: result.status, error: "시험을 삭제할 수 없습니다." };
        }
        return result;
    } catch (error) {
        await reportServerError("teacher-exam-save", error);
        return { status: "service_unavailable", error: "시험을 삭제할 수 없습니다." };
    }
}

/**
 * Rotate a short-lived, exam-scoped entry capability. The database rechecks
 * teacher membership, exam ownership and current group scope atomically; this
 * boundary returns the raw bearer exactly once and never logs it.
 */
export async function rotateTeacherExamEntryInvite(
    examId: string,
    requestedTtlMs?: number,
): Promise<TeacherExamEntryInviteResult> {
    try {
        const gateway = await teacherGatewayContext(true);
        if ("status" in gateway) return gateway;
        const result = await rotateExamEntryInviteWithGateway(
            gateway.client,
            gateway.context,
            examId,
            requestedTtlMs,
        );
        if (result.status === "service_unavailable") {
            await reportServerError("teacher-exam-entry-invite", {
                status: result.status,
                code: "service_unavailable",
            });
        }
        return result;
    } catch {
        await reportServerError("teacher-exam-entry-invite", {
            status: "service_unavailable",
            code: "unexpected_failure",
        });
        return { status: "service_unavailable" };
    }
}
