import {
    studentAttemptRecordFromAttempt,
    studentAttemptReviewExamFromExam,
    type StudentAttemptDetailResult,
    type StudentAttemptListResult,
    type StudentAttemptReviewExam,
} from "@/lib/studentAttemptHistoryContract";
import type { StudentServerSession } from "@/lib/studentServerSession";
import {
    attemptFromSupabaseRow,
    examFromSupabaseRow,
    type SupabaseAttemptRow,
    type SupabaseExamRow,
} from "@/lib/omrPersistence";
import { SUPABASE_ATTEMPT_LIST_READ_COLUMNS, SUPABASE_ATTEMPT_READ_COLUMNS } from "@/lib/supabaseReadColumns";
import { attemptFromSupabaseListRow } from "@/lib/supabaseListProjection";
import {
    INITIAL_CAPACITY_EXCEEDED_ERROR,
    INITIAL_OPERATIONS_LIMITS,
} from "@/lib/initialOperationsPolicy";
import type { Attempt } from "@/types/omr";
import { isRemoteAssetStoredDataRef } from "@/lib/remoteAssetContract.server";

interface StudentAttemptReadResult<T> {
    data: T | null;
    error: { message?: string } | null;
}

interface StudentAttemptReadQuery {
    eq(column: string, value: string): StudentAttemptReadQuery;
    gt(column: string, value: string): StudentAttemptReadQuery;
    order(column: string, options: { ascending: boolean }): StudentAttemptReadQuery;
    limit(value: number): PromiseLike<StudentAttemptReadResult<unknown[]>>;
    maybeSingle(): PromiseLike<StudentAttemptReadResult<unknown>>;
}

export interface StudentAttemptReadGatewayClient {
    from(table: "omr_attempts" | "omr_exams"): {
        select(columns: string): StudentAttemptReadQuery;
    };
}

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function attemptMatchesSession(attempt: Attempt, session: StudentServerSession): boolean {
    if (
        clean(attempt.organizationId) !== clean(session.organizationId)
        || clean(attempt.studentProfileId) !== clean(session.studentId)
        || clean(attempt.studentId) !== clean(session.studentId)
        || attempt.status !== "completed"
    ) {
        return false;
    }
    const questionIds = new Set<number>();
    return Array.isArray(attempt.questionResults) && attempt.questionResults.every(result => {
        if (
            clean(result.attemptId) !== clean(attempt.id)
            || clean(result.examId) !== clean(attempt.examId)
            || clean(result.studentId) !== clean(session.studentId)
            || questionIds.has(result.questionId)
        ) {
            return false;
        }
        questionIds.add(result.questionId);
        return true;
    });
}

function parseScopedAttempt(row: unknown, session: StudentServerSession, listProjection = false): Attempt | null {
    try {
        const attempt = listProjection
            ? attemptFromSupabaseListRow(row)
            : attemptFromSupabaseRow(row as SupabaseAttemptRow);
        return attemptMatchesSession(attempt, session) ? attempt : null;
    } catch {
        return null;
    }
}

function fallbackReviewExam(attempt: Attempt): StudentAttemptReviewExam {
    return {
        id: attempt.examId,
        title: attempt.examTitle,
        createdAt: attempt.startedAt,
        questions: (attempt.questionResults || []).map(result => ({
            id: result.questionId,
            number: result.questionNumber,
            ...(result.pdfLocation ? { pdfLocation: result.pdfLocation } : {}),
            ...(result.pdfRegion ? { pdfRegion: result.pdfRegion } : {}),
        })),
    };
}

function ownedRemoteHandwritingRef(attempt: Attempt, session: StudentServerSession) {
    const candidate = attempt.handwriting?.strokesRef || attempt.drawingsRef;
    if (
        !isRemoteAssetStoredDataRef(candidate)
        || candidate.kind !== "attempt_handwriting"
        || candidate.organizationId !== session.organizationId
        || candidate.attemptId !== attempt.id
    ) return undefined;
    return candidate;
}

export async function listStudentAttemptsWithGateway(
    client: StudentAttemptReadGatewayClient,
    session: StudentServerSession,
): Promise<StudentAttemptListResult> {
    const rows: unknown[] = [];
    const ceiling = INITIAL_OPERATIONS_LIMITS.studentAttempts;
    const pageSize = INITIAL_OPERATIONS_LIMITS.listPageSize;
    let cursorId = "";
    while (rows.length <= ceiling) {
        const requestSize = Math.min(pageSize, (ceiling + 1) - rows.length);
        let query = client
            .from("omr_attempts")
            .select(SUPABASE_ATTEMPT_LIST_READ_COLUMNS)
            .eq("organization_id", session.organizationId)
            .eq("student_profile_id", session.studentId)
            .eq("student_id", session.studentId)
            .eq("status", "completed");
        if (cursorId) query = query.gt("id", cursorId);
        const result = await query
            .order("id", { ascending: true })
            .limit(requestSize);
        if (result.error) return { status: "service_unavailable", error: result.error.message };
        const page = result.data || [];
        if (page.length === 0) break;
        const pageIds = page.map(row => {
            const record = row as { id?: unknown; payload?: { id?: unknown } };
            return clean(record.id) || clean(record.payload?.id);
        });
        if (
            pageIds.some(id => !id || (cursorId && id <= cursorId))
            || pageIds.some((id, index) => index > 0 && id <= pageIds[index - 1])
        ) {
            return { status: "service_unavailable", error: "Invalid canonical attempt pagination" };
        }
        rows.push(...page);
        if (rows.length > ceiling) {
            return { status: "service_unavailable", error: INITIAL_CAPACITY_EXCEEDED_ERROR };
        }
        cursorId = pageIds[pageIds.length - 1];
        if (page.length < requestSize) break;
    }

    const attempts = [];
    for (const row of rows) {
        const attempt = parseScopedAttempt(row, session, true);
        const safeAttempt = attempt ? studentAttemptRecordFromAttempt(attempt) : null;
        if (!safeAttempt) {
            return { status: "service_unavailable", error: "Invalid scoped student attempt" };
        }
        attempts.push(safeAttempt);
    }
    attempts.sort((left, right) => {
        const byFinishedAt = Date.parse(right.finishedAt) - Date.parse(left.finishedAt);
        return byFinishedAt || left.id.localeCompare(right.id);
    });
    return { status: "loaded", attempts };
}

export async function loadStudentAttemptWithGateway(
    client: StudentAttemptReadGatewayClient,
    attemptId: string,
    session: StudentServerSession,
): Promise<StudentAttemptDetailResult> {
    const normalizedAttemptId = clean(attemptId);
    if (!normalizedAttemptId) return { status: "not_found" };
    const attemptResult = await client
        .from("omr_attempts")
        .select(SUPABASE_ATTEMPT_READ_COLUMNS)
        .eq("organization_id", session.organizationId)
        .eq("student_profile_id", session.studentId)
        .eq("student_id", session.studentId)
        .eq("status", "completed")
        .eq("id", normalizedAttemptId)
        .maybeSingle();
    if (attemptResult.error) return { status: "service_unavailable", error: attemptResult.error.message };
    if (!attemptResult.data) return { status: "not_found" };

    const attempt = parseScopedAttempt(attemptResult.data, session);
    const safeAttempt = attempt ? studentAttemptRecordFromAttempt(attempt) : null;
    if (!attempt || !safeAttempt) {
        return { status: "service_unavailable", error: "Invalid scoped student attempt" };
    }

    const examResult = await client
        .from("omr_exams")
        .select("id, organization_id, payload")
        .eq("organization_id", session.organizationId)
        .eq("id", attempt.examId)
        .maybeSingle();
    if (examResult.error) return { status: "service_unavailable", error: examResult.error.message };

    let reviewExam = fallbackReviewExam(attempt);
    if (examResult.data) {
        try {
            const exam = examFromSupabaseRow(examResult.data as SupabaseExamRow);
            if (clean(exam.organizationId) !== clean(session.organizationId) || clean(exam.id) !== clean(attempt.examId)) {
                return { status: "service_unavailable", error: "Invalid scoped review exam" };
            }
            const attemptedQuestionIds = new Set(safeAttempt.questionResults.map(result => result.questionId));
            reviewExam = studentAttemptReviewExamFromExam({
                ...exam,
                questions: exam.questions.filter(question => attemptedQuestionIds.has(question.id)),
            });
        } catch {
            return { status: "service_unavailable", error: "Invalid canonical review exam" };
        }
    }

    const handwritingRef = ownedRemoteHandwritingRef(attempt, session);
    return {
        status: "loaded",
        detail: {
            attempt: safeAttempt,
            exam: reviewExam,
            ...(handwritingRef ? { handwritingRef } : {}),
        },
    };
}
