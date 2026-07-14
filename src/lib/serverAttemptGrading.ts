import { buildQuestionResults } from "@/lib/premiumAnalytics";
import type { StudentAttemptTicketClaims } from "@/lib/studentAttemptTicket";
import type {
    ServerGradedAttemptReceipt,
    StudentAttemptSubmission,
} from "@/lib/studentExamContract";
import {
    gradeAttempt,
    questionChoiceCount,
    type Attempt,
    type Exam,
    type FocusLossEvent,
    type QuestionTiming,
} from "@/types/omr";

export const SERVER_ATTEMPT_SUBMISSION_GRACE_MS = 30 * 1000;

export type ServerAttemptGradeError =
    | "ticket_exam_mismatch"
    | "ticket_organization_mismatch"
    | "exam_archived"
    | "exam_not_started"
    | "exam_ended"
    | "duration_expired"
    | "no_allowed_questions"
    | "unexpected_question"
    | "invalid_answer";

export type ServerAttemptGradeResult =
    | { ok: true; attempt: Attempt; receipt: ServerGradedAttemptReceipt }
    | { ok: false; error: ServerAttemptGradeError };

export function serverGradedAttemptReceiptFromAttempt(
    attempt: Attempt,
): ServerGradedAttemptReceipt {
    const questionResults = (attempt.questionResults || []).map(result => ({
        questionId: result.questionId,
        questionNumber: result.questionNumber,
        ...(typeof result.selectedAnswer === "number" ? { selectedAnswer: result.selectedAnswer } : {}),
        score: result.score,
        earnedScore: result.earnedScore,
        status: result.status,
    }));
    return {
        attemptId: attempt.id,
        examId: attempt.examId,
        score: attempt.score,
        totalScore: attempt.totalScore,
        correctCount: questionResults.filter(row => row.status === "correct").length,
        incorrectCount: questionResults.filter(row => row.status === "wrong").length,
        unansweredCount: questionResults.filter(row => row.status === "unanswered").length,
        ungradedCount: questionResults.filter(row => row.status === "ungraded").length,
        finishedAt: attempt.finishedAt,
        questionResults,
    };
}

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function validDateMs(value: string | undefined): number | null {
    if (!value) return null;
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : null;
}

function sanitizeQuestionTimings(
    values: QuestionTiming[] | undefined,
    allowedQuestionIds: Set<number>,
): QuestionTiming[] | undefined {
    if (!Array.isArray(values)) return undefined;
    const sanitized = values.filter(value =>
        allowedQuestionIds.has(value.questionId)
        && Number.isFinite(value.totalTimeSec)
        && value.totalTimeSec >= 0
        && Number.isInteger(value.visitCount)
        && value.visitCount >= 0
        && Number.isInteger(value.revisitCount)
        && value.revisitCount >= 0
        && Number.isInteger(value.answerChangeCount)
        && value.answerChangeCount >= 0
    );
    return sanitized.length > 0 ? sanitized : undefined;
}

function sanitizeFocusLossEvents(values: FocusLossEvent[] | undefined): FocusLossEvent[] | undefined {
    if (!Array.isArray(values)) return undefined;
    const sanitized = values.filter(value =>
        (value.reason === "blur" || value.reason === "hidden")
        && Number.isInteger(value.count)
        && value.count >= 0
        && Number.isFinite(new Date(value.at).getTime())
    );
    return sanitized.length > 0 ? sanitized : undefined;
}

export function gradeStudentAttemptOnServer(
    exam: Exam,
    ticket: StudentAttemptTicketClaims,
    submission: StudentAttemptSubmission,
    now = Date.now(),
): ServerAttemptGradeResult {
    if (clean(exam.id) !== clean(ticket.examId)) {
        return { ok: false, error: "ticket_exam_mismatch" };
    }
    if (!clean(exam.organizationId) || clean(exam.organizationId) !== clean(ticket.organizationId)) {
        return { ok: false, error: "ticket_organization_mismatch" };
    }
    if (exam.archived) return { ok: false, error: "exam_archived" };

    const startsAt = validDateMs(exam.startAt);
    if (startsAt !== null && startsAt > now) return { ok: false, error: "exam_not_started" };
    const endsAt = validDateMs(exam.endAt);
    if (endsAt !== null && endsAt + SERVER_ATTEMPT_SUBMISSION_GRACE_MS < now) {
        return { ok: false, error: "exam_ended" };
    }
    if (
        typeof exam.durationMin === "number"
        && exam.durationMin > 0
        && ticket.issuedAt + exam.durationMin * 60 * 1000 + SERVER_ATTEMPT_SUBMISSION_GRACE_MS < now
    ) {
        return { ok: false, error: "duration_expired" };
    }

    const allowedQuestionIds = new Set(ticket.allowedQuestionIds);
    const activeQuestions = exam.questions.filter(question => allowedQuestionIds.has(question.id));
    if (activeQuestions.length === 0 || activeQuestions.length !== allowedQuestionIds.size) {
        return { ok: false, error: "no_allowed_questions" };
    }

    const sanitizedAnswers: Record<number, number> = {};
    for (const [rawQuestionId, rawAnswer] of Object.entries(submission.answers || {})) {
        const questionId = Number(rawQuestionId);
        if (!Number.isInteger(questionId) || !allowedQuestionIds.has(questionId)) {
            return { ok: false, error: "unexpected_question" };
        }
        const question = activeQuestions.find(candidate => candidate.id === questionId);
        if (!question || !Number.isInteger(rawAnswer) || rawAnswer < 1 || rawAnswer > questionChoiceCount(question)) {
            return { ok: false, error: "invalid_answer" };
        }
        sanitizedAnswers[questionId] = rawAnswer;
    }

    const graded = gradeAttempt(activeQuestions, sanitizedAnswers);
    const finishedAt = new Date(now).toISOString();
    const attempt: Attempt = {
        id: `attempt_${ticket.ticketId}`,
        examId: exam.id,
        examTitle: exam.title,
        organizationId: ticket.organizationId,
        classId: ticket.groupId,
        assignmentId: ticket.assignmentId,
        studentProfileId: ticket.identityType === "registered" ? ticket.studentId : undefined,
        studentName: ticket.studentName,
        studentId: ticket.studentId,
        groupId: ticket.groupId,
        groupName: ticket.groupName,
        identityType: ticket.identityType,
        guestId: ticket.guestId,
        startedAt: new Date(ticket.issuedAt).toISOString(),
        finishedAt,
        score: graded.earnedScore,
        totalScore: graded.totalScore,
        answers: sanitizedAnswers,
        status: "completed",
        autoSubmitted: !!submission.autoSubmitted,
        tabFociLostCount: Number.isInteger(submission.tabFociLostCount) && (submission.tabFociLostCount || 0) >= 0
            ? submission.tabFociLostCount
            : undefined,
        questionTimings: sanitizeQuestionTimings(submission.questionTimings, allowedQuestionIds),
        focusLossEvents: sanitizeFocusLossEvents(submission.focusLossEvents),
    };
    attempt.questionResults = buildQuestionResults(
        { ...exam, questions: activeQuestions },
        attempt,
    );

    return {
        ok: true,
        attempt,
        receipt: serverGradedAttemptReceiptFromAttempt(attempt),
    };
}
