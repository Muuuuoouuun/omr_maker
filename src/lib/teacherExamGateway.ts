import { createHash } from "node:crypto";
import {
    examFromSupabaseRow,
    examQuestionRowsForExam,
    examToSupabaseRow,
    type SupabaseExamRow,
} from "@/lib/omrPersistence";
import { SUPABASE_EXAM_LIST_READ_COLUMNS, SUPABASE_EXAM_READ_COLUMNS } from "@/lib/supabaseReadColumns";
import { examFromSupabaseListRow } from "@/lib/supabaseListProjection";
import { isRemoteAssetStoredDataRef } from "@/lib/remoteAssetContract.server";
import {
    INITIAL_CAPACITY_EXCEEDED_ERROR,
    INITIAL_OPERATIONS_LIMITS,
} from "@/lib/initialOperationsPolicy";
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
            eq(column: string, value: string): TeacherExamSelectQuery;
        };
    };
}

interface TeacherExamSelectQuery {
    eq(column: string, value: string): TeacherExamSelectQuery;
    order(column: string, options: { ascending: boolean }): TeacherExamSelectQuery;
    limit(value: number): PromiseLike<{
        data: unknown[] | null;
        error: { message?: string } | null;
    }>;
    maybeSingle(): PromiseLike<{ data: unknown; error: { message?: string } | null }>;
}

export type TeacherExamSaveResult =
    | { status: "saved"; exam: Exam }
    | { status: "conflict"; currentRevision: number; serverUpdatedAt?: string }
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

function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    const record = value as Record<string, unknown>;
    const isRemoteAssetRef = record.store === "remote"
        && typeof record.key === "string"
        && typeof record.kind === "string";
    return `{${Object.entries(record)
        .filter(([key, item]) => item !== undefined && !(isRemoteAssetRef && key === "updatedAt"))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
        .join(",")}}`;
}

function examSaveMutationId(input: Record<string, unknown>): string {
    return `exam-save:${createHash("sha256").update(canonicalJson(input)).digest("hex")}`;
}

function nonNegativeRevision(value: unknown): number | null {
    return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function positiveRevision(value: unknown): number | null {
    const revision = nonNegativeRevision(value);
    return revision && revision > 0 ? revision : null;
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
    const expectedRevision = exam.revision === undefined ? 0 : nonNegativeRevision(exam.revision);
    if (expectedRevision === null) return { status: "invalid_exam", error: "Invalid canonical exam revision" };

    const scopedExam: Exam = {
        ...exam,
        organizationId,
        createdByUserId: actorUserId,
    };
    if (clean(scopedExam.pdfData) || clean(scopedExam.answerKeyPdf)) {
        return {
            status: "invalid_exam",
            error: "Inline PDF bodies are not accepted by the canonical gateway",
        };
    }
    if (
        (scopedExam.pdfDataRef && scopedExam.pdfDataRef.store !== "remote")
        || (scopedExam.answerKeyPdfRef && scopedExam.answerKeyPdfRef.store !== "remote")
    ) {
        return { status: "invalid_exam", error: "Canonical PDF refs must use remote storage" };
    }
    if (
        !remoteRefMatchesExam(scopedExam, scopedExam.pdfDataRef, "problem_pdf")
        || !remoteRefMatchesExam(scopedExam, scopedExam.answerKeyPdfRef, "answer_key_pdf")
    ) {
        return { status: "invalid_exam", error: "Remote asset scope does not match the exam" };
    }

    const teacherAssetIntentIds = [scopedExam.pdfDataRef, scopedExam.answerKeyPdfRef]
        .filter(isRemoteAssetStoredDataRef)
        .map(ref => ref.key);
    const canonicalExam = { ...scopedExam };
    delete canonicalExam.pdfData;
    delete canonicalExam.answerKeyPdf;
    const examRow = examToSupabaseRow(canonicalExam, context);
    const questionRows = examQuestionRowsForExam(
        scopedExam,
        scopedExam.updatedAt || scopedExam.createdAt,
        context,
    );
    const mutationExam: Partial<Exam> = { ...canonicalExam };
    delete mutationExam.createdAt;
    delete mutationExam.updatedAt;
    delete mutationExam.revision;
    const mutationId = examSaveMutationId({
        expectedRevision,
        exam: mutationExam,
        teacherAssetIntentIds,
        assetActorUserId: actorUserId,
    });
    const result = await client.rpc("omr_save_exam_v2", {
        p_exam: examRow,
        p_questions: questionRows,
        p_teacher_asset_intent_ids: teacherAssetIntentIds,
        p_asset_actor_user_id: actorUserId,
        p_expected_revision: expectedRevision,
        p_mutation_id: mutationId,
    });
    if (result.error) {
        return { status: "service_unavailable", error: result.error.message || "Canonical exam save failed" };
    }
    if (!result.data || typeof result.data !== "object") {
        return { status: "service_unavailable", error: "Invalid canonical exam save response" };
    }
    const response = result.data as Record<string, unknown>;
    if (response.status === "revision_conflict" || response.status === "mutation_conflict") {
        const currentRevision = nonNegativeRevision(response.currentRevision);
        if (currentRevision === null) {
            return { status: "service_unavailable", error: "Invalid canonical exam conflict response" };
        }
        return {
            status: "conflict",
            currentRevision,
            ...(clean(response.updatedAt) ? { serverUpdatedAt: clean(response.updatedAt) } : {}),
        };
    }
    const revision = positiveRevision(response.revision);
    const updatedAt = clean(response.updatedAt);
    const savedExam = response.exam;
    if (
        response.status !== "saved"
        || !revision
        || !updatedAt
        || !savedExam
        || typeof savedExam !== "object"
        || clean((savedExam as { id?: unknown }).id) !== scopedExam.id
        || !Array.isArray((savedExam as { questions?: unknown }).questions)
    ) {
        return { status: "service_unavailable", error: "Invalid canonical exam save response" };
    }
    return {
        status: "saved",
        exam: {
            ...scopedExam,
            ...(savedExam as Exam),
            organizationId,
            createdByUserId: actorUserId,
            revision,
            updatedAt,
        },
    };
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
        const row = result.data as SupabaseExamRow & { revision?: unknown };
        const revision = positiveRevision(row.revision);
        if (!revision) throw new Error("Invalid canonical exam revision");
        return {
            status: "loaded",
            exam: {
                ...examFromSupabaseRow(row),
                revision,
                updatedAt: row.updated_at,
            },
        };
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
        .select(SUPABASE_EXAM_LIST_READ_COLUMNS)
        .eq("organization_id", context.organizationId)
        .order("updated_at", { ascending: false })
        .order("id", { ascending: true })
        .limit(INITIAL_OPERATIONS_LIMITS.teacherExams + 1);
    if (result.error) return { status: "service_unavailable", error: result.error.message };
    if ((result.data?.length || 0) > INITIAL_OPERATIONS_LIMITS.teacherExams) {
        return { status: "service_unavailable", error: INITIAL_CAPACITY_EXCEEDED_ERROR };
    }
    const exams = (result.data || []).flatMap(row => {
        try {
            return [examFromSupabaseListRow(row)];
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
