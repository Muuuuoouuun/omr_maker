export interface SubmissionFlushMaintenanceDependencies {
    migrateLegacySubmissionReceipts: () => Promise<unknown>;
    pendingSubmissionReceiptIds: (options: { automaticOnly?: boolean }) => string[];
    legacySubmissionReceiptCleanupDelayMs: () => number | null;
}

/**
 * Runs the awaited receipt maintenance pass before looking for replay work.
 * This is best-effort boot maintenance: storage and replay failures must not
 * escape as unhandled background rejections.
 */
export async function maintainAndFlushPendingSubmissionReceipts(
    flushPendingReceipts: () => Promise<unknown>,
    dependencies: SubmissionFlushMaintenanceDependencies,
): Promise<number | null> {
    try {
        await dependencies.migrateLegacySubmissionReceipts();
    } catch {
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
    return cleanupDelayMs;
}
