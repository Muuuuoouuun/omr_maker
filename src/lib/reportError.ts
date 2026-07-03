/**
 * Single funnel for unexpected runtime errors. Today it only structures the
 * console output; when an error-tracking SDK (Sentry 등) is added, this is the
 * one place to wire it — every boundary and catch that matters already calls
 * through here.
 */
export function reportError(context: string, error: unknown): void {
    console.error(`[omr:${context}]`, error);
    // Error-tracking hook point:
    // Sentry.captureException(error, { tags: { context } });
}
