export const RECENT_SCORE_TREND_LENGTH = 3;

type TrendAttempt = { finishedAt: string };

function finishedAtMs(attempt: TrendAttempt): number {
    const ms = new Date(attempt.finishedAt).getTime();
    return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

/**
 * Rounded score percents of the latest `count` attempts, ordered oldest → newest
 * so the rendered "이전 → 최근" arrows read in time order. Attempts with an
 * unparseable finish time are treated as the oldest.
 */
export function recentScoreTrend<T extends TrendAttempt>(
    attempts: readonly T[],
    scorePercentFor: (attempt: T) => number,
    count: number = RECENT_SCORE_TREND_LENGTH,
): number[] {
    if (count <= 0) return [];
    return attempts
        .map((attempt, index) => ({ attempt, index, ms: finishedAtMs(attempt) }))
        // Newest first; ties keep input order so the result is deterministic.
        .sort((a, b) => (b.ms - a.ms) || (a.index - b.index))
        .slice(0, count)
        .reverse()
        .map(({ attempt }) => Math.round(scorePercentFor(attempt)));
}
