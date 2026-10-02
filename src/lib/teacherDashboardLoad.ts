export interface DashboardRemoteItems<T> {
    items: T[];
    remoteError?: string;
}

export type DashboardDetailSampleStatus = "ready" | "partial" | "stale";
export type DashboardDetailLoadStatus = "idle" | "loading" | "ready" | "error";

export interface DashboardDetailSnapshot<T> {
    generation: number;
    items: T[];
    sampleStatus: DashboardDetailSampleStatus;
}

export function beginDashboardDetailBackgroundRetry<T>(input: {
    generation: number;
    snapshot: DashboardDetailSnapshot<T> | null;
}): {
    generation: number;
    items: T[] | null;
    loadStatus: DashboardDetailLoadStatus;
    sampleStatus: DashboardDetailSampleStatus;
} {
    return {
        generation: input.generation + 1,
        items: input.snapshot?.items ?? null,
        loadStatus: input.snapshot ? "ready" : "idle",
        sampleStatus: input.snapshot?.sampleStatus ?? "ready",
    };
}

export function resolveDashboardDetailRetryFailure<T>(input: {
    requestedGeneration: number;
    currentGeneration: number;
    snapshot: DashboardDetailSnapshot<T> | null;
    message: string;
}):
    | { kind: "obsolete" }
    | {
        kind: "cached";
        items: T[];
        loadStatus: "ready";
        sampleStatus: "stale";
        warning: string;
    }
    | {
        kind: "error";
        items: null;
        loadStatus: "error";
        sampleStatus: "ready";
        warning: string;
    } {
    if (input.requestedGeneration !== input.currentGeneration) return { kind: "obsolete" };
    if (input.snapshot) {
        return {
            kind: "cached",
            items: input.snapshot.items,
            loadStatus: "ready",
            sampleStatus: "stale",
            warning: input.message,
        };
    }
    return {
        kind: "error",
        items: null,
        loadStatus: "error",
        sampleStatus: "ready",
        warning: input.message,
    };
}

/**
 * A failed canonical read must not erase the last usable browser snapshot.
 * An authoritative empty response has no remoteError and is allowed to clear it.
 */
export function preferLocalDashboardItems<T>(
    result: DashboardRemoteItems<T>,
    localItems: T[],
): T[] {
    return result.remoteError ? localItems : result.items;
}
