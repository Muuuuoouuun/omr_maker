export interface SubmissionFlushMaintenanceDependencies {
    migrateLegacySubmissionReceipts: () => Promise<unknown>;
    pendingSubmissionReceiptIds: (options: { automaticOnly?: boolean }) => string[];
    legacySubmissionReceiptCleanupDelayMs: () => number | null;
}

export interface SubmissionFlushMaintenanceResult {
    cleanupDelayMs: number | null;
    maintenanceFailed: boolean;
}

const CLEANUP_FAILURE_INITIAL_BACKOFF_MS = 250;
const CLEANUP_FAILURE_MAX_BACKOFF_MS = 30_000;

/**
 * If maintenance failed, use a bounded deterministic delay even before a
 * cleanup candidate exists so boot-time lock or crypto failures are retried.
 */
export function cleanupFollowUpDelayMs(
    cleanupDelayMs: number | null,
    maintenanceFailed: boolean,
    consecutiveMaintenanceFailures: number,
): number | null {
    if (!maintenanceFailed || (cleanupDelayMs !== null && cleanupDelayMs > 0)) {
        return cleanupDelayMs;
    }
    const exponent = Math.max(0, consecutiveMaintenanceFailures - 1);
    return Math.min(
        CLEANUP_FAILURE_MAX_BACKOFF_MS,
        CLEANUP_FAILURE_INITIAL_BACKOFF_MS * 2 ** exponent,
    );
}

/**
 * Runs the awaited receipt maintenance pass before looking for replay work.
 * This is best-effort boot maintenance: storage and replay failures must not
 * escape as unhandled background rejections.
 */
export async function maintainAndFlushPendingSubmissionReceipts(
    flushPendingReceipts: () => Promise<unknown>,
    dependencies: SubmissionFlushMaintenanceDependencies,
): Promise<SubmissionFlushMaintenanceResult> {
    let maintenanceFailed = false;
    try {
        maintenanceFailed = await dependencies.migrateLegacySubmissionReceipts() === false;
    } catch {
        maintenanceFailed = true;
        // Existing v2 receipts can still be replayed if legacy maintenance is
        // temporarily blocked by storage or lock failures.
    }

    let cleanupDelayMs: number | null = null;
    try {
        cleanupDelayMs = dependencies.legacySubmissionReceiptCleanupDelayMs();
    } catch {
        // Cleanup can still be retried by the ordinary app lifecycle events.
    }

    try {
        if (dependencies.pendingSubmissionReceiptIds({ automaticOnly: true }).length > 0) {
            await flushPendingReceipts();
        }
    } catch {
        // Online/visibility/session events and the cleanup timer retry this
        // best-effort background work.
    }
    return { cleanupDelayMs, maintenanceFailed };
}
