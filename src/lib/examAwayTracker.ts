export const EXAM_AWAY_THRESHOLD_MS = 2_000;

export interface AwaySession {
    startedAt: number;
}

export interface AwaySessionResult {
    count: 0 | 1;
    durationMs: number;
}

export function beginAwaySession(
    current: AwaySession | null,
    now: number,
): AwaySession {
    return current ?? { startedAt: now };
}

export function finishAwaySession(
    current: AwaySession | null,
    now: number,
): AwaySessionResult {
    if (!current) {
        return { count: 0, durationMs: 0 };
    }

    const durationMs = Math.max(0, now - current.startedAt);
    return {
        count: durationMs >= EXAM_AWAY_THRESHOLD_MS ? 1 : 0,
        durationMs,
    };
}

export const flushAwaySession = finishAwaySession;

export function awaySeverity(count: number): "neutral" | "attention" {
    return count >= 3 ? "attention" : "neutral";
}
