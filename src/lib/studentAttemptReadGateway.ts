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
import { SUPABASE_ATTEMPT_READ_COLUMNS } from "@/lib/supabaseReadColumns";
import type { Attempt } from "@/types/omr";

interface StudentAttemptReadResult<T> {
    data: T | null;
    error: { message?: string } | null;
}

interface StudentAttemptReadQuery {
    eq(column: string, value: string): StudentAttemptReadQuery;
    order(column: string, options: { ascending: false }): PromiseLike<StudentAttemptReadResult<unknown[]>>;
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

function parseScopedAttempt(row: unknown, session: StudentServerSession): Attempt | null {
    try {
        const attempt = attemptFromSupabaseRow(row as SupabaseAttemptRow);
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

export async function listStudentAttemptsWithGateway(
    client: StudentAttemptReadGatewayClient,
    session: StudentServerSession,
): Promise<StudentAttemptListResult> {
    const result = await client
        .from("omr_attempts")
        .select(SUPABASE_ATTEMPT_READ_COLUMNS)
        .eq("organization_id", session.organizationId)
        .eq("student_profile_id", session.studentId)
        .eq("student_id", session.studentId)
        .eq("status", "completed")
        .order("finished_at", { ascending: false });
    if (result.error) return { status: "service_unavailable", error: result.error.message };

    const attempts = [];
    for (const row of result.data || []) {
        const attempt = parseScopedAttempt(row, session);
        const safeAttempt = attempt ? studentAttemptRecordFromAttempt(attempt) : null;
        if (!safeAttempt) {
            return { status: "service_unavailable", error: "Invalid scoped student attempt" };
        }
        attempts.push(safeAttempt);
    }
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

    return {
        status: "loaded",
        detail: { attempt: safeAttempt, exam: reviewExam },
    };
}
