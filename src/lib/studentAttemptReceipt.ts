import type { ServerGradedAttemptReceipt } from "@/lib/studentExamContract";
import type { IdentityType, QuestionResult } from "@/types/omr";

export interface StudentReceiptCacheIdentity {
    examTitle: string;
    studentName: string;
    studentId?: string;
    groupId?: string;
    groupName?: string;
    identityType?: IdentityType;
}

/**
 * Converts the deliberately answer-key-free server receipt into the local review shape.
 * This is a cache projection only: all grading fields come from the server receipt.
 */
export function localResultCacheFromServerReceipt(
    receipt: ServerGradedAttemptReceipt,
    identity: StudentReceiptCacheIdentity,
): { answers: Record<number, number>; questionResults: QuestionResult[] } {
    const answers: Record<number, number> = {};
    const questionResults = receipt.questionResults.map(result => {
        if (typeof result.selectedAnswer === "number") {
            answers[result.questionId] = result.selectedAnswer;
        }
        return {
            schemaVersion: 1 as const,
            attemptId: receipt.attemptId,
            examId: receipt.examId,
            examTitle: identity.examTitle,
            studentName: identity.studentName,
            studentId: identity.studentId,
            groupId: identity.groupId,
            groupName: identity.groupName,
            identityType: identity.identityType,
            questionId: result.questionId,
            questionNumber: result.questionNumber,
            score: result.score,
            earnedScore: result.earnedScore,
            selectedAnswer: result.selectedAnswer,
            status: result.status,
            isCorrect: result.status === "correct",
            isWrong: result.status === "wrong",
            isUnanswered: result.status === "unanswered",
            finishedAt: receipt.finishedAt,
        } satisfies QuestionResult;
    });
    return { answers, questionResults };
}
