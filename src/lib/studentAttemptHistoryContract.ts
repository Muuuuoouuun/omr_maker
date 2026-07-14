import type {
    ServerGradedQuestionReceipt,
    StudentSolveQuestion,
} from "@/lib/studentExamContract";
import type {
    Attempt,
    Exam,
    FocusLossEvent,
    IdentityType,
    QuestionTiming,
    RetakeMetadata,
} from "@/types/omr";

export interface StudentAttemptRecord {
    id: string;
    examId: string;
    examTitle: string;
    studentId: string;
    studentName: string;
    identityType: IdentityType;
    groupId?: string;
    groupName?: string;
    startedAt: string;
    finishedAt: string;
    score: number;
    totalScore: number;
    status: "completed";
    autoSubmitted?: boolean;
    tabFociLostCount?: number;
    questionTimings?: QuestionTiming[];
    focusLossEvents?: FocusLossEvent[];
    retake?: RetakeMetadata;
    questionResults: ServerGradedQuestionReceipt[];
}

export interface StudentAttemptReviewExam {
    id: string;
    title: string;
    createdAt: string;
    questions: StudentSolveQuestion[];
    pdfData?: string;
}

export interface StudentAttemptDetail {
    attempt: StudentAttemptRecord;
    exam: StudentAttemptReviewExam;
}

export type StudentAttemptListResult =
    | { status: "loaded"; attempts: StudentAttemptRecord[] }
    | { status: "local_only" | "unauthorized" | "service_unavailable"; error?: string };

export type StudentAttemptDetailResult =
    | { status: "loaded"; detail: StudentAttemptDetail }
    | { status: "not_found" | "local_only" | "unauthorized" | "service_unavailable"; error?: string };

function safeQuestionResult(result: NonNullable<Attempt["questionResults"]>[number]): ServerGradedQuestionReceipt {
    return {
        questionId: result.questionId,
        questionNumber: result.questionNumber,
        ...(typeof result.selectedAnswer === "number" ? { selectedAnswer: result.selectedAnswer } : {}),
        score: result.score,
        earnedScore: result.earnedScore,
        status: result.status,
    };
}

export function studentAttemptRecordFromAttempt(attempt: Attempt): StudentAttemptRecord | null {
    if (
        attempt.status !== "completed"
        || !attempt.studentId?.trim()
        || !attempt.studentName.trim()
        || !attempt.identityType
        || !Array.isArray(attempt.questionResults)
    ) {
        return null;
    }
    return {
        id: attempt.id,
        examId: attempt.examId,
        examTitle: attempt.examTitle,
        studentId: attempt.studentId,
        studentName: attempt.studentName,
        identityType: attempt.identityType,
        ...(attempt.groupId ? { groupId: attempt.groupId } : {}),
        ...(attempt.groupName ? { groupName: attempt.groupName } : {}),
        startedAt: attempt.startedAt,
        finishedAt: attempt.finishedAt,
        score: attempt.score,
        totalScore: attempt.totalScore,
        status: "completed",
        ...(typeof attempt.autoSubmitted === "boolean" ? { autoSubmitted: attempt.autoSubmitted } : {}),
        ...(typeof attempt.tabFociLostCount === "number" ? { tabFociLostCount: attempt.tabFociLostCount } : {}),
        ...(attempt.questionTimings ? { questionTimings: attempt.questionTimings } : {}),
        ...(attempt.focusLossEvents ? { focusLossEvents: attempt.focusLossEvents } : {}),
        ...(attempt.retake ? { retake: attempt.retake } : {}),
        questionResults: attempt.questionResults.map(safeQuestionResult),
    };
}

export function attemptFromStudentAttemptRecord(record: StudentAttemptRecord): Attempt {
    const answers: Record<number, number> = {};
    const questionResults = record.questionResults.map(result => {
        if (typeof result.selectedAnswer === "number") answers[result.questionId] = result.selectedAnswer;
        return {
            schemaVersion: 1 as const,
            attemptId: record.id,
            examId: record.examId,
            examTitle: record.examTitle,
            studentName: record.studentName,
            studentId: record.studentId,
            groupId: record.groupId,
            groupName: record.groupName,
            identityType: record.identityType,
            questionId: result.questionId,
            questionNumber: result.questionNumber,
            score: result.score,
            earnedScore: result.earnedScore,
            selectedAnswer: result.selectedAnswer,
            status: result.status,
            isCorrect: result.status === "correct",
            isWrong: result.status === "wrong",
            isUnanswered: result.status === "unanswered",
            finishedAt: record.finishedAt,
        };
    });
    return {
        id: record.id,
        examId: record.examId,
        examTitle: record.examTitle,
        studentName: record.studentName,
        studentId: record.studentId,
        groupId: record.groupId,
        groupName: record.groupName,
        identityType: record.identityType,
        startedAt: record.startedAt,
        finishedAt: record.finishedAt,
        score: record.score,
        totalScore: record.totalScore,
        answers,
        questionResults,
        status: "completed",
        autoSubmitted: record.autoSubmitted,
        tabFociLostCount: record.tabFociLostCount,
        questionTimings: record.questionTimings,
        focusLossEvents: record.focusLossEvents,
        retake: record.retake,
    };
}

export function studentAttemptReviewExamFromExam(exam: Exam): StudentAttemptReviewExam {
    return {
        id: exam.id,
        title: exam.title,
        createdAt: exam.createdAt,
        questions: exam.questions.map(question => ({
            id: question.id,
            number: question.number,
            ...(question.choices ? { choices: question.choices } : {}),
            ...(question.pdfLocation ? { pdfLocation: question.pdfLocation } : {}),
            ...(question.pdfRegion ? { pdfRegion: question.pdfRegion } : {}),
        })),
        ...(exam.pdfData ? { pdfData: exam.pdfData } : {}),
    };
}

export function examFromStudentAttemptReviewExam(exam: StudentAttemptReviewExam): Exam {
    return {
        id: exam.id,
        title: exam.title,
        createdAt: exam.createdAt,
        questions: exam.questions.map(question => ({ ...question })),
        pdfData: exam.pdfData,
    };
}
