import type {
    Attempt,
    Exam,
    FocusLossEvent,
    IdentityType,
    Question,
    QuestionResultStatus,
    QuestionTiming,
    StoredDataRef,
} from "@/types/omr";

export interface StudentExamAccessInput {
    examId: string;
    assignmentId?: string;
    pin?: string;
    questionIds?: number[];
    retake?: {
        sourceAttemptId: string;
        mode: "wrong" | "similar" | "custom";
        questionIds: number[];
    };
    student: {
        studentId: string;
        studentName: string;
        identityType: IdentityType;
        groupId?: string;
        groupName?: string;
        guestId?: string;
    };
}

export interface VerifiedStudentIdentity {
    organizationId: string;
    studentId: string;
    studentName: string;
    identityType: "temporary" | "registered";
    groupId?: string;
    groupName?: string;
}

export type StudentExamAccessResult =
    | { status: "allowed"; exam: StudentSolveExam; ticket: string }
    | { status: "pin_required" | "pin_rate_limited" | "login_required" | "group_denied" | "not_started" | "ended" | "archived"; at?: string }
    | { status: "invalid_questions" | "unsupported_retake" }
    | { status: "not_found" | "service_unavailable" | "misconfigured" | "local_only" };

export type StudentExamPreviewResult =
    | { status: "available"; exam: StudentExamPreview }
    | { status: "not_found" | "service_unavailable" | "misconfigured" | "local_only" };

export interface StudentExamPreview {
    id: string;
    title: string;
    createdAt: string;
    updatedAt?: string;
    durationMin?: number;
    startAt?: string;
    endAt?: string;
    archived?: boolean;
    questionCount: number;
    access: {
        type: "public" | "group" | "targeted";
        requiresPin: boolean;
    };
}

/** Minimal dashboard row. Full exam content and access checks load only on entry. */
export interface StudentAssignmentPreview {
    id: string;
    /** Opaque server assignment scope. Student ids are never embedded here or in the URL. */
    assignmentId?: string;
    assignmentMode?: "base" | "retake";
    retakeSourceAttemptId?: string;
    retakeQuestionIds?: number[];
    title: string;
    createdAt: string;
    updatedAt?: string;
    durationMin?: number;
    startAt?: string;
    endAt?: string;
    archived?: boolean;
    access: {
        type: "public" | "group" | "targeted";
        entryCheck: "required";
    };
}

/**
 * Minimal pre-entry submission row for the student dashboard.
 * Ownership is enforced by the server query and is intentionally not repeated
 * client-side. Answer/review/authoring/telemetry/artifact data is detail-only.
 */
export interface StudentAttemptSummary {
    id: string;
    examId: string;
    assignmentId?: string;
    examTitle: string;
    status: "completed" | "in_progress";
    score: number;
    totalScore: number;
    startedAt: string;
    finishedAt: string;
    retakeSourceAttemptId?: string;
    answeredQuestionCount?: number;
    latestAnsweredAt?: string;
}

function answeredQuestionSummary(value: unknown): Pick<StudentAttemptSummary, "answeredQuestionCount" | "latestAnsweredAt"> {
    if (!Array.isArray(value)) return {};
    let answeredQuestionCount = 0;
    let latestAnsweredAt = "";
    for (const item of value) {
        if (!item || typeof item !== "object") continue;
        const note = item as { status?: unknown; answer?: unknown };
        if (note.status !== "answered") continue;
        answeredQuestionCount += 1;
        if (!note.answer || typeof note.answer !== "object") continue;
        const createdAt = (note.answer as { createdAt?: unknown }).createdAt;
        if (
            typeof createdAt === "string"
            && createdAt.length <= 40
            && /^\d{4}-\d{2}-\d{2}T/.test(createdAt)
            && Number.isFinite(Date.parse(createdAt))
            && (!latestAnsweredAt || createdAt > latestAnsweredAt)
        ) latestAnsweredAt = createdAt;
    }
    return answeredQuestionCount > 0
        ? {
            answeredQuestionCount,
            ...(latestAnsweredAt ? { latestAnsweredAt } : {}),
        }
        : {};
}

export function answeredQuestionSummaryFromListValue(value: unknown) {
    return answeredQuestionSummary(value);
}

export function studentAttemptSummaryFromAttempt(attempt: Attempt): StudentAttemptSummary {
    return {
        id: attempt.id,
        examId: attempt.examId,
        ...(attempt.assignmentId ? { assignmentId: attempt.assignmentId } : {}),
        examTitle: attempt.examTitle,
        status: attempt.status,
        score: attempt.score,
        totalScore: attempt.totalScore,
        startedAt: attempt.startedAt,
        finishedAt: attempt.finishedAt,
        ...(attempt.retake?.sourceAttemptId
            ? { retakeSourceAttemptId: attempt.retake.sourceAttemptId }
            : {}),
        ...answeredQuestionSummary(attempt.studentQuestions),
    };
}

export type StudentSolveQuestion = Pick<
    Question,
    "id" | "number" | "choices" | "pdfLocation" | "pdfRegion" | "passagePdfRegions"
>;

export interface StudentSolveExam {
    id: string;
    title: string;
    questions: StudentSolveQuestion[];
    createdAt: string;
    updatedAt?: string;
    durationMin?: number;
    startAt?: string;
    endAt?: string;
    archived?: boolean;
    pdfData?: string;
    pdfDataRef?: StoredDataRef;
    access: {
        type: "public" | "group" | "targeted";
        requiresPin: boolean;
    };
}

export interface StudentAttemptSubmission {
    ticket: string;
    answers: Record<number, number>;
    autoSubmitted?: boolean;
    questionTimings?: QuestionTiming[];
    focusLossEvents?: FocusLossEvent[];
    tabFociLostCount?: number;
}

export interface ServerGradedAttemptReceipt {
    attemptId: string;
    examId: string;
    score: number;
    totalScore: number;
    correctCount: number;
    incorrectCount: number;
    unansweredCount: number;
    ungradedCount: number;
    finishedAt: string;
    /**
     * Server-authoritative review data for this student's issued question set.
     * Deliberately excludes correctAnswer and all answer-key/explanation metadata.
     */
    questionResults: ServerGradedQuestionReceipt[];
}

export interface ServerGradedQuestionReceipt {
    questionId: number;
    questionNumber: number;
    selectedAnswer?: number;
    score: number;
    earnedScore: number;
    status: QuestionResultStatus;
}

function studentQuestion(question: Question): StudentSolveQuestion {
    return {
        id: question.id,
        number: question.number,
        ...(question.choices ? { choices: question.choices } : {}),
        ...(question.pdfLocation ? { pdfLocation: question.pdfLocation } : {}),
        ...(question.pdfRegion ? { pdfRegion: question.pdfRegion } : {}),
        ...(question.passagePdfRegions?.length ? { passagePdfRegions: question.passagePdfRegions } : {}),
    };
}

export function studentSolveExamFromExam(exam: Exam): StudentSolveExam {
    return {
        id: exam.id,
        title: exam.title,
        questions: exam.questions.map(studentQuestion),
        createdAt: exam.createdAt,
        ...(exam.updatedAt ? { updatedAt: exam.updatedAt } : {}),
        ...(typeof exam.durationMin === "number" ? { durationMin: exam.durationMin } : {}),
        ...(exam.startAt ? { startAt: exam.startAt } : {}),
        ...(exam.endAt ? { endAt: exam.endAt } : {}),
        ...(typeof exam.archived === "boolean" ? { archived: exam.archived } : {}),
        ...(exam.pdfData ? { pdfData: exam.pdfData } : {}),
        ...(exam.pdfDataRef ? { pdfDataRef: exam.pdfDataRef } : {}),
        access: {
            type: exam.accessConfig?.type === "targeted" ? "targeted" : exam.accessConfig?.type === "group" ? "group" : "public",
            requiresPin: !!exam.accessConfig?.pin?.trim(),
        },
    };
}

export function studentExamPreviewFromExam(exam: Exam): StudentExamPreview {
    return {
        id: exam.id,
        title: exam.title,
        createdAt: exam.createdAt,
        ...(exam.updatedAt ? { updatedAt: exam.updatedAt } : {}),
        ...(typeof exam.durationMin === "number" ? { durationMin: exam.durationMin } : {}),
        ...(exam.startAt ? { startAt: exam.startAt } : {}),
        ...(exam.endAt ? { endAt: exam.endAt } : {}),
        ...(typeof exam.archived === "boolean" ? { archived: exam.archived } : {}),
        questionCount: exam.questions.length,
        access: {
            type: exam.accessConfig?.type === "targeted" ? "targeted" : exam.accessConfig?.type === "group" ? "group" : "public",
            requiresPin: !!exam.accessConfig?.pin?.trim(),
        },
    };
}

export function clientExamFromStudentExamPreview(exam: StudentExamPreview): Exam {
    return {
        id: exam.id,
        title: exam.title,
        questions: [],
        createdAt: exam.createdAt,
        updatedAt: exam.updatedAt,
        durationMin: exam.durationMin,
        startAt: exam.startAt,
        endAt: exam.endAt,
        archived: exam.archived,
        accessConfig: { type: exam.access.type },
    };
}

export function clientExamFromStudentSolveExam(exam: StudentSolveExam): Exam {
    return {
        id: exam.id,
        title: exam.title,
        questions: exam.questions.map(question => ({ ...question })),
        createdAt: exam.createdAt,
        updatedAt: exam.updatedAt,
        durationMin: exam.durationMin,
        startAt: exam.startAt,
        endAt: exam.endAt,
        archived: exam.archived,
        pdfData: exam.pdfData,
        pdfDataRef: exam.pdfDataRef,
        accessConfig: { type: exam.access.type },
    };
}
