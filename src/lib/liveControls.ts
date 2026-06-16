import type { Attempt, Exam } from "@/types/omr";
import { buildQuestionResults, summarizeAttemptScore } from "@/lib/premiumAnalytics";

export function forceCompleteLiveAttempt(
    attempt: Attempt,
    exam: Exam | undefined,
    finishedAt: string,
): Attempt {
    if (exam && exam.id === attempt.examId) {
        const completedAttempt: Attempt = {
            ...attempt,
            finishedAt,
            status: "completed",
            autoSubmitted: true,
        };
        const questionResults = buildQuestionResults(exam, completedAttempt);
        const scoreSummary = summarizeAttemptScore(exam, { ...completedAttempt, questionResults });

        return {
            ...completedAttempt,
            score: scoreSummary.earnedScore,
            totalScore: scoreSummary.totalScore,
            questionResults,
        };
    }

    return {
        ...attempt,
        finishedAt,
        status: "completed",
        autoSubmitted: true,
    };
}

export function liveAttemptsNeedingForceFinish(attempts: Attempt[]): Attempt[] {
    return attempts.filter(attempt => attempt.status === "in_progress");
}
