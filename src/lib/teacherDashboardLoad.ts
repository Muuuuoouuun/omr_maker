export interface DashboardRemoteItems<T> {
    items: T[];
    remoteError?: string;
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
