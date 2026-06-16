import type { Attempt } from "@/types/omr";

function clampPercent(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(100, value));
}

export function safeScorePercent(score: number | undefined, totalScore: number | undefined): number {
    if (!Number.isFinite(score) || !Number.isFinite(totalScore) || !totalScore || totalScore <= 0) return 0;
    return clampPercent(Math.round(((score || 0) / totalScore) * 100));
}

export function averageAttemptPercent(attempts: Attempt[]): number {
    if (attempts.length === 0) return 0;
    const total = attempts.reduce((sum, attempt) => (
        sum + safeScorePercent(attempt.score, attempt.totalScore)
    ), 0);
    return Math.round(total / attempts.length);
}

export function safeRatePercent(numerator: number | undefined, denominator: number | undefined): number {
    if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || !denominator || denominator <= 0) return 0;
    return clampPercent(Math.round(((numerator || 0) / denominator) * 100));
}
