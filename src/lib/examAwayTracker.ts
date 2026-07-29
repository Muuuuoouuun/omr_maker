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

interface AwayCountSource {
    focusLossEvents?: unknown;
    tabFociLostCount?: unknown;
}

function nonnegativeSafeInteger(value: unknown): number {
    return typeof value === "number"
        && Number.isSafeInteger(value)
        && value >= 0
        ? value
        : 0;
}

function isValidAwayEvent(value: unknown): value is { count: number } {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const event = value as Record<string, unknown>;
    return typeof event.at === "string"
        && Number.isFinite(new Date(event.at).getTime())
        && (event.reason === "blur" || event.reason === "hidden")
        && nonnegativeSafeInteger(event.count) === event.count;
}

/**
 * Resolve one factual away count across legacy and sanitized attempt payloads.
 *
 * Server sanitization may remove one malformed event while preserving the
 * already-recorded cumulative count. Taking the safe maximum prevents that
 * cleanup from lowering the count shown to teachers or students.
 */
export function resolveAwayCount(source: AwayCountSource): number {
    const events = Array.isArray(source.focusLossEvents)
        ? source.focusLossEvents.filter(isValidAwayEvent)
        : [];
    const cumulativeEventCount = events.reduce(
        (maximum, event) => Math.max(maximum, nonnegativeSafeInteger(event.count)),
        0,
    );

    return Math.max(
        events.length,
        cumulativeEventCount,
        nonnegativeSafeInteger(source.tabFociLostCount),
    );
}

export function awaySeverity(count: number): "neutral" | "attention" {
    return count >= 3 ? "attention" : "neutral";
}
