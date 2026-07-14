import {
    examFromSupabaseRow,
    examQuestionRowsForExam,
    examToSupabaseRow,
    type SupabaseExamRow,
} from "@/lib/omrPersistence";
import { SUPABASE_EXAM_READ_COLUMNS } from "@/lib/supabaseReadColumns";
import { isRemoteAssetStoredDataRef } from "@/lib/remoteAssetContract.server";
import type { WorkspaceContext } from "@/lib/workspaceContext";
import type { Exam } from "@/types/omr";

export interface TeacherExamWriteClient {
    rpc(name: string, params: Record<string, unknown>): Promise<{
        data: unknown;
        error: { message?: string } | null;
    }>;
}

export interface TeacherExamGatewayClient extends TeacherExamWriteClient {
    from(table: "omr_exams"): {
        select(columns: string): {
            eq(column: string, value: string): {
                eq(column: string, value: string): {
                    maybeSingle(): Promise<{ data: unknown; error: { message?: string } | null }>;
                };
                order(column: string, options: { ascending: false }): Promise<{
                    data: unknown[] | null;
                    error: { message?: string } | null;
                }>;
            };
        };
    };
}

export type TeacherExamSaveResult =
    | { status: "saved"; exam: Exam }
    | { status: "invalid_exam" | "service_unavailable"; error?: string };

export type TeacherExamLoadResult =
    | { status: "loaded"; exam: Exam }
    | { status: "not_found" | "service_unavailable"; error?: string };

export type TeacherExamListResult =
    | { status: "loaded"; exams: Exam[] }
    | { status: "service_unavailable"; error?: string };

export type TeacherExamDeleteResult =
    | { status: "deleted"; examId: string }
    | { status: "not_found" | "service_unavailable"; error?: string };

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function remoteRefMatchesExam(exam: Exam, ref: unknown, expectedKind: "problem_pdf" | "answer_key_pdf"): boolean {
    if (!ref || (ref as { store?: unknown }).store !== "remote") return true;
    return isRemoteAssetStoredDataRef(ref)
        && ref.kind === expectedKind
        && ref.organizationId === exam.organizationId
        && ref.examId === exam.id;
}

export async function saveTeacherExamWithGateway(
    client: TeacherExamWriteClient,
    exam: Exam,
    context: WorkspaceContext,
): Promise<TeacherExamSaveResult> {
    const organizationId = clean(context.organizationId);
    const actorUserId = clean(context.actorUserId);
    if (
        !organizationId
        || !actorUserId
        || !clean(exam.id)
        || !clean(exam.title)
        || !Array.isArray(exam.questions)
        || exam.questions.length === 0
    ) {
        return { status: "invalid_exam" };
    }

    const scopedExam: Exam = {
        ...exam,
        organizationId,
        createdByUserId: actorUserId,
    };
    if (
        !remoteRefMatchesExam(scopedExam, scopedExam.pdfDataRef, "problem_pdf")
        || !remoteRefMatchesExam(scopedExam, scopedExam.answerKeyPdfRef, "answer_key_pdf")
    ) {
        return { status: "invalid_exam", error: "Remote asset scope does not match the exam" };
    }

    const result = await client.rpc("omr_save_exam_v1", {
        p_exam: examToSupabaseRow(scopedExam, context),
        p_questions: examQuestionRowsForExam(scopedExam, undefined, context),
    });
    if (result.error) {
        return { status: "service_unavailable", error: result.error.message || "Canonical exam save failed" };
    }
    return { status: "saved", exam: scopedExam };
}

export async function loadTeacherExamWithGateway(
    client: TeacherExamGatewayClient,
    examId: string,
    context: WorkspaceContext,
): Promise<TeacherExamLoadResult> {
    if (!clean(examId) || !clean(context.organizationId)) return { status: "not_found" };
    const result = await client
        .from("omr_exams")
        .select(SUPABASE_EXAM_READ_COLUMNS)
        .eq("organization_id", context.organizationId)
        .eq("id", examId.trim())
        .maybeSingle();
    if (result.error) return { status: "service_unavailable", error: result.error.message };
    if (!result.data) return { status: "not_found" };
    try {
        return { status: "loaded", exam: examFromSupabaseRow(result.data as SupabaseExamRow) };
    } catch {
        return { status: "service_unavailable", error: "Invalid canonical exam payload" };
    }
}

export async function listTeacherExamsWithGateway(
    client: TeacherExamGatewayClient,
    context: WorkspaceContext,
): Promise<TeacherExamListResult> {
    if (!clean(context.organizationId)) return { status: "service_unavailable" };
    const result = await client
        .from("omr_exams")
        .select(SUPABASE_EXAM_READ_COLUMNS)
        .eq("organization_id", context.organizationId)
        .order("updated_at", { ascending: false });
    if (result.error) return { status: "service_unavailable", error: result.error.message };
    const exams = (result.data || []).flatMap(row => {
        try {
            return [examFromSupabaseRow(row as SupabaseExamRow)];
        } catch {
            return [];
        }
    });
    return { status: "loaded", exams };
}

export async function deleteTeacherExamWithGateway(
    client: TeacherExamWriteClient,
    examId: string,
    context: WorkspaceContext,
): Promise<TeacherExamDeleteResult> {
    const normalizedExamId = clean(examId);
    const organizationId = clean(context.organizationId);
    if (!normalizedExamId || !organizationId) return { status: "not_found" };
    const result = await client.rpc("omr_delete_exam_v1", {
        p_organization_id: organizationId,
        p_exam_id: normalizedExamId,
    });
    if (result.error) return { status: "service_unavailable", error: result.error.message || "Canonical exam delete failed" };
    const deleted = !!(result.data && typeof result.data === "object" && (result.data as { deleted?: unknown }).deleted === true);
    return deleted ? { status: "deleted", examId: normalizedExamId } : { status: "not_found" };
}
