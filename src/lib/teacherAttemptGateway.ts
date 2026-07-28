import {
    attemptFromSupabaseRow,
    examFromSupabaseRow,
    questionResultRowsForAttempt,
    type SupabaseAttemptRow,
    type SupabaseExamRow,
} from "@/lib/omrPersistence";
import {
    SUPABASE_ATTEMPT_READ_COLUMNS,
    SUPABASE_EXAM_READ_COLUMNS,
} from "@/lib/supabaseReadColumns";
import { gradeTeacherForcedAttemptOnServer } from "@/lib/serverAttemptGrading";
import { STUDENT_QUESTION_MAX_LENGTH } from "@/lib/studentQuestions";
import { canTeacherRoleWrite } from "@/lib/teacherSession";
import type { WorkspaceContext } from "@/lib/workspaceContext";
import type { Attempt, SubQuestionReviewStatus } from "@/types/omr";

interface AttemptQueryResult<T> {
    data: T | null;
    error: { message?: string } | null;
}

interface AttemptSelectQuery {
    eq(column: string, value: string): AttemptSelectQuery;
    in(column: string, values: string[]): AttemptSelectQuery;
    order(column: string, options: { ascending: boolean }): Promise<AttemptQueryResult<unknown[]>>;
    maybeSingle(): Promise<AttemptQueryResult<unknown>>;
}

export interface TeacherAttemptGatewayClient {
    from(table: "omr_attempts" | "omr_exams"): {
        select(columns: string): AttemptSelectQuery;
    };
    rpc(
        name:
            | "omr_answer_attempt_question_v1"
            | "omr_set_subquestion_review_v1"
            | "omr_force_finish_attempts_v1",
        args: Record<string, unknown>,
    ): Promise<AttemptQueryResult<Array<{ payload: Attempt }> | { payload: Attempt }>>;
}

export type TeacherAttemptListResult =
    | { status: "loaded"; attempts: Attempt[] }
    | { status: "service_unavailable"; error?: string };

export type TeacherAttemptLoadResult =
    | { status: "loaded"; attempt: Attempt }
    | { status: "not_found" | "service_unavailable"; error?: string };

export type TeacherAttemptMutationResult =
    | { status: "saved"; attempt: Attempt }
    | { status: "invalid_request" | "forbidden" | "not_found"; error?: string }
    | { status: "service_unavailable"; error?: string };

export type TeacherAttemptBatchMutationResult =
    | { status: "saved"; attempts: Attempt[] }
    | { status: "invalid_request" | "forbidden" | "not_found"; error?: string }
    | { status: "service_unavailable"; error?: string };

export interface AnswerTeacherAttemptQuestionInput {
    attemptId: string;
    questionId: string | number;
    answer: string;
}

export interface SetTeacherAttemptSubquestionReviewInput {
    attemptId: string;
    questionId: string | number;
    subquestionId: string;
    status: SubQuestionReviewStatus;
}

export interface ForceFinishTeacherAttemptsInput {
    attemptIds: string[];
    finishedAt: string;
}

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function mutationContextIsAuthorized(context: WorkspaceContext): boolean {
    return !!clean(context.organizationId)
        && !!clean(context.actorUserId)
        && !!clean(context.actorLabel)
        && canTeacherRoleWrite(context.memberRole);
}

function actorRpcArgs(context: WorkspaceContext) {
    return {
        p_actor_user_id: clean(context.actorUserId),
        p_member_role: context.memberRole,
        p_actor_label: clean(context.actorLabel),
    };
}

function attemptFromMutationResult(
    result: AttemptQueryResult<Array<{ payload: Attempt }> | { payload: Attempt }>,
): TeacherAttemptMutationResult {
    if (result.error) return { status: "service_unavailable", error: result.error.message };
    const record = Array.isArray(result.data) ? result.data[0] : result.data;
    if (!record?.payload) return { status: "not_found" };
    try {
        return { status: "saved", attempt: attemptFromSupabaseRow(record) };
    } catch {
        return { status: "service_unavailable", error: "Invalid canonical attempt payload" };
    }
}

export async function answerTeacherAttemptQuestionWithGateway(
    client: TeacherAttemptGatewayClient,
    input: AnswerTeacherAttemptQuestionInput,
    context: WorkspaceContext,
): Promise<TeacherAttemptMutationResult> {
    if (!mutationContextIsAuthorized(context)) return { status: "forbidden" };
    const attemptId = clean(input.attemptId);
    const questionId = String(input.questionId).trim();
    const answer = clean(input.answer);
    if (
        !attemptId
        || !/^\d+$/.test(questionId)
        || !answer
        || answer.length > STUDENT_QUESTION_MAX_LENGTH
    ) {
        return { status: "invalid_request" };
    }
    return attemptFromMutationResult(await client.rpc("omr_answer_attempt_question_v1", {
        p_organization_id: context.organizationId,
        p_attempt_id: attemptId,
        p_question_id: questionId,
        p_answer: answer,
        ...actorRpcArgs(context),
    }));
}

export async function setTeacherAttemptSubquestionReviewWithGateway(
    client: TeacherAttemptGatewayClient,
    input: SetTeacherAttemptSubquestionReviewInput,
    context: WorkspaceContext,
): Promise<TeacherAttemptMutationResult> {
    if (!mutationContextIsAuthorized(context)) return { status: "forbidden" };
    const attemptId = clean(input.attemptId);
    const questionId = String(input.questionId).trim();
    const subquestionId = clean(input.subquestionId);
    if (
        !attemptId
        || !/^\d+$/.test(questionId)
        || !subquestionId
        || subquestionId.length > 100
        || subquestionId.includes(":")
        || (input.status !== "reviewed" && input.status !== "needs_review")
    ) {
        return { status: "invalid_request" };
    }
    return attemptFromMutationResult(await client.rpc("omr_set_subquestion_review_v1", {
        p_organization_id: context.organizationId,
        p_attempt_id: attemptId,
        p_subquestion_id: `${questionId}:${subquestionId}`,
        p_status: input.status,
        ...actorRpcArgs(context),
    }));
}

export async function forceFinishTeacherAttemptsWithGateway(
    client: TeacherAttemptGatewayClient,
    input: ForceFinishTeacherAttemptsInput,
    context: WorkspaceContext,
): Promise<TeacherAttemptBatchMutationResult> {
    if (!mutationContextIsAuthorized(context)) return { status: "forbidden" };
    const attemptIds = [...new Set((input.attemptIds || []).map(clean).filter(Boolean))];
    const finishedAt = clean(input.finishedAt);
    if (
        attemptIds.length === 0
        || attemptIds.length > 100
        || !Number.isFinite(Date.parse(finishedAt))
    ) {
        return { status: "invalid_request" };
    }
    const attemptResult = await client
        .from("omr_attempts")
        .select(SUPABASE_ATTEMPT_READ_COLUMNS)
        .eq("organization_id", context.organizationId)
        .in("id", attemptIds)
        .order("id", { ascending: true });
    if (attemptResult.error) {
        return { status: "service_unavailable", error: attemptResult.error.message };
    }
    const storedAttempts = (attemptResult.data || []).flatMap(row => {
        try {
            const record = row as SupabaseAttemptRow;
            return [{
                attempt: attemptFromSupabaseRow(record),
            }];
        } catch {
            return [];
        }
    });
    if (
        storedAttempts.length !== attemptIds.length
        || new Set(storedAttempts.map(item => item.attempt.id)).size !== attemptIds.length
        || storedAttempts.some(item => !attemptIds.includes(item.attempt.id))
    ) {
        return { status: "not_found" };
    }

    const examIds = [...new Set(storedAttempts.map(item => clean(item.attempt.examId)).filter(Boolean))];
    const examResult = await client
        .from("omr_exams")
        .select(SUPABASE_EXAM_READ_COLUMNS)
        .eq("organization_id", context.organizationId)
        .in("id", examIds)
        .order("id", { ascending: true });
    if (examResult.error) {
        return { status: "service_unavailable", error: examResult.error.message };
    }
    const examsById = new Map((examResult.data || []).flatMap(row => {
        try {
            const record = row as SupabaseExamRow;
            const exam = examFromSupabaseRow(record);
            const updatedAt = clean(record.updated_at);
            return updatedAt ? [[exam.id, { exam, updatedAt }] as const] : [];
        } catch {
            return [];
        }
    }));
    if (examsById.size !== examIds.length) return { status: "not_found" };

    const gradingByAttemptId = new Map<string, Record<string, unknown>>();
    for (const stored of storedAttempts) {
        const canonicalExam = examsById.get(stored.attempt.examId);
        if (!canonicalExam) return { status: "not_found" };
        const graded = gradeTeacherForcedAttemptOnServer(
            canonicalExam.exam,
            stored.attempt,
            finishedAt,
        );
        if (!graded.ok) {
            return { status: "service_unavailable", error: graded.error };
        }
        const questionResultRows = questionResultRowsForAttempt(
            graded.attempt,
            finishedAt,
            context,
        );
        if (questionResultRows.length !== (graded.attempt.questionResults || []).length) {
            return { status: "service_unavailable", error: "Invalid canonical grading rows" };
        }
        gradingByAttemptId.set(stored.attempt.id, {
            attempt_id: stored.attempt.id,
            expected_answers: stored.attempt.answers || {},
            expected_retake_question_ids: stored.attempt.retake?.questionIds || [],
            expected_exam_updated_at: canonicalExam.updatedAt,
            score: graded.attempt.score,
            total_score: graded.attempt.totalScore,
            question_results: graded.attempt.questionResults || [],
            question_result_rows: questionResultRows,
        });
    }
    const gradings = attemptIds.map(attemptId => gradingByAttemptId.get(attemptId));
    if (gradings.some(grading => !grading)) {
        return { status: "service_unavailable", error: "Missing canonical grading" };
    }

    const result = await client.rpc("omr_force_finish_attempts_v1", {
        p_organization_id: context.organizationId,
        p_attempt_ids: attemptIds,
        p_finished_at: finishedAt,
        ...actorRpcArgs(context),
        p_gradings: gradings,
    });
    if (result.error) return { status: "service_unavailable", error: result.error.message };
    const records = Array.isArray(result.data) ? result.data : result.data ? [result.data] : [];
    if (records.length !== attemptIds.length) return { status: "not_found" };
    try {
        const attempts = records.map(record => attemptFromSupabaseRow(record));
        if (
            attempts.some(item => clean(item.organizationId) !== clean(context.organizationId))
            || attempts.some(item => item.status !== "completed")
            || attempts.some((item, index) => item.id !== attemptIds[index])
        ) {
            return { status: "service_unavailable", error: "Invalid canonical attempt scope" };
        }
        return { status: "saved", attempts };
    } catch {
        return { status: "service_unavailable", error: "Invalid canonical attempt payload" };
    }
}

export async function listTeacherAttemptsWithGateway(
    client: TeacherAttemptGatewayClient,
    context: WorkspaceContext,
    examId?: string,
): Promise<TeacherAttemptListResult> {
    let query = client
        .from("omr_attempts")
        .select(SUPABASE_ATTEMPT_READ_COLUMNS)
        .eq("organization_id", context.organizationId);
    if (examId?.trim()) query = query.eq("exam_id", examId.trim());
    const result = await query.order("finished_at", { ascending: false });
    if (result.error) return { status: "service_unavailable", error: result.error.message };
    const attempts = (result.data || []).flatMap(row => {
        try {
            return [attemptFromSupabaseRow(row as SupabaseAttemptRow)];
        } catch {
            return [];
        }
    });
    return { status: "loaded", attempts };
}

export async function loadTeacherAttemptWithGateway(
    client: TeacherAttemptGatewayClient,
    attemptId: string,
    context: WorkspaceContext,
): Promise<TeacherAttemptLoadResult> {
    if (!attemptId.trim()) return { status: "not_found" };
    const result = await client
        .from("omr_attempts")
        .select(SUPABASE_ATTEMPT_READ_COLUMNS)
        .eq("organization_id", context.organizationId)
        .eq("id", attemptId.trim())
        .maybeSingle();
    if (result.error) return { status: "service_unavailable", error: result.error.message };
    if (!result.data) return { status: "not_found" };
    try {
        return { status: "loaded", attempt: attemptFromSupabaseRow(result.data as SupabaseAttemptRow) };
    } catch {
        return { status: "service_unavailable", error: "Invalid canonical attempt payload" };
    }
}
