import type { Attempt, Exam } from "@/types/omr";
import { summarizeAttemptScore } from "@/lib/premiumAnalytics";
import { safeScorePercent } from "@/lib/scoreUtils";

export interface ResolvedAttemptScore {
    earnedScore: number;
    totalScore: number;
    scorePercent: number;
    source: "questionResults" | "storedScore";
    gradedQuestionCount: number;
    ungradedQuestionCount: number;
}

export function resolveAttemptScore(attempt: Attempt, exam?: Exam | null): ResolvedAttemptScore {
    if (exam && exam.id === attempt.examId) {
        const summary = summarizeAttemptScore(exam, attempt);
        return {
            ...summary,
            source: "questionResults",
        };
    }

    return {
        earnedScore: attempt.score,
        totalScore: attempt.totalScore,
        scorePercent: safeScorePercent(attempt.score, attempt.totalScore),
        source: "storedScore",
        gradedQuestionCount: 0,
        ungradedQuestionCount: 0,
    };
}

export function buildAttemptScoreLookup(
    attempts: Attempt[],
    examById: Map<string, Exam>,
): Map<string, ResolvedAttemptScore> {
    return new Map(attempts.map(attempt => [
        attempt.id,
        resolveAttemptScore(attempt, examById.get(attempt.examId)),
    ]));
}

export function isRetakeAttempt(attempt: Attempt): boolean {
    return !!attempt.retake;
}

export function baseAttemptsOnly(attempts: Attempt[]): Attempt[] {
    return attempts.filter(attempt => !isRetakeAttempt(attempt));
}

export function retakeAttemptsOnly(attempts: Attempt[]): Attempt[] {
    return attempts.filter(isRetakeAttempt);
}

export function averageResolvedAttemptPercent(
    attempts: Attempt[],
    examById: Map<string, Exam>,
): number {
    if (attempts.length === 0) return 0;
    const lookup = buildAttemptScoreLookup(attempts, examById);
    const total = attempts.reduce((sum, attempt) => (
        sum + (lookup.get(attempt.id)?.scorePercent ?? 0)
    ), 0);
    return Math.round(total / attempts.length);
}
