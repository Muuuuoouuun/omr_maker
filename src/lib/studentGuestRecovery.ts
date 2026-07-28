import { withBrowserStorageLock } from "@/lib/browserStorageLock";

const ATTEMPTS_KEY = "omr_attempts";
const PENDING_KEY = "omr_pending_guest_merge";

interface PendingGuestMerge {
    guestId: string;
    queuedAt: string;
}

interface UnverifiedRecoveryBase {
    guestId: string;
    queuedAt: string;
    rawPendingStorage: string;
    rawAttemptStorage: string;
}

export type GuestRecoveryState =
    | UnverifiedRecoveryBase & {
        status: "unverified";
        attemptIds: string[];
        attempts: Record<string, unknown>[];
        canRetryDbClaim: true;
    }
    | {
        status: "marker_corrupt";
        guestId: "";
        queuedAt: "";
        rawPendingStorage: string;
        byteLength: number;
        canRetryDbClaim: false;
    }
    | UnverifiedRecoveryBase & {
        status: "attempt_store_corrupt";
        byteLength: number;
        canRetryDbClaim: false;
    };

function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function parsePendingGuestMerge(raw: string): PendingGuestMerge | null {
    try {
        const parsed = record(JSON.parse(raw));
        const guestId = clean(parsed?.guestId);
        if (!parsed || !guestId) return null;
        return { guestId, queuedAt: clean(parsed.queuedAt) };
    } catch {
        return null;
    }
}

function isGuestRecoveryAttempt(attempt: Record<string, unknown>, guestId: string): boolean {
    const studentId = clean(attempt.studentId);
    return clean(attempt.id).length > 0
        && (clean(attempt.guestId) === guestId || studentId === `guest:${guestId}`)
        && (attempt.identityType === "guest" || studentId === `guest:${guestId}`);
}

export function readGuestRecoveryState(storage: Storage): GuestRecoveryState | null {
    const rawPendingStorage = storage.getItem(PENDING_KEY);
    if (!rawPendingStorage) return null;
    const pending = parsePendingGuestMerge(rawPendingStorage);
    if (!pending) {
        return {
            status: "marker_corrupt",
            guestId: "",
            queuedAt: "",
            rawPendingStorage,
            byteLength: new TextEncoder().encode(rawPendingStorage).length,
            canRetryDbClaim: false,
        };
    }
    const rawAttemptStorage = storage.getItem(ATTEMPTS_KEY) ?? "[]";
    try {
        const parsed = JSON.parse(rawAttemptStorage);
        if (!Array.isArray(parsed)) throw new Error("attempt storage is not an array");
        const all = parsed.map(record);
        if (all.some(item => !item)) throw new Error("attempt storage contains an invalid record");
        const attempts = (all as Record<string, unknown>[])
            .filter(attempt => isGuestRecoveryAttempt(attempt, pending.guestId));
        return {
            status: "unverified",
            guestId: pending.guestId,
            queuedAt: pending.queuedAt,
            rawPendingStorage,
            rawAttemptStorage,
            attemptIds: attempts.map(attempt => clean(attempt.id)),
            attempts,
            canRetryDbClaim: true,
        };
    } catch {
        return {
            status: "attempt_store_corrupt",
            guestId: pending.guestId,
            queuedAt: pending.queuedAt,
            rawPendingStorage,
            rawAttemptStorage,
            byteLength: new TextEncoder().encode(rawAttemptStorage).length,
            canRetryDbClaim: false,
        };
    }
}

export function buildGuestRecoveryExport(state: GuestRecoveryState): string {
    const header = {
        verification: "unverified_local_only",
        status: state.status,
        guestId: state.guestId,
        queuedAt: state.queuedAt,
        exportedAt: new Date().toISOString(),
        ...(state.status === "unverified" ? { attempts: state.attempts } : { byteLength: state.byteLength }),
    };
    const json = JSON.stringify(header);
    if (state.status === "marker_corrupt") return `${json}\n${state.rawPendingStorage}`;
    if (state.status === "attempt_store_corrupt") return `${json}\n${state.rawAttemptStorage}`;
    return json;
}

export function clearGuestRecoveryMarker(storage: Storage): void {
    storage.removeItem(PENDING_KEY);
}

export type GuestRecoveryMutationResult =
    | { status: "discarded" }
    | { status: "quarantined" }
    | { status: "stale" }
    | { status: "blocked" }
    | { status: "failed" };

export async function discardGuestRecovery(
    state: GuestRecoveryState,
    storage: Storage,
    options: { quarantineWholeAttemptStore?: boolean } = {},
): Promise<GuestRecoveryMutationResult> {
    try {
        return await withBrowserStorageLock("attempt-index", () => {
            if (state.status === "marker_corrupt") {
                if (storage.getItem(PENDING_KEY) !== state.rawPendingStorage) return { status: "stale" };
                storage.removeItem(PENDING_KEY);
                return { status: "discarded" };
            }
            if (state.status === "attempt_store_corrupt") {
                if (!options.quarantineWholeAttemptStore || storage.getItem("omr_attempts_quarantine") !== null) {
                    return { status: "blocked" };
                }
                if (
                    storage.getItem(ATTEMPTS_KEY) !== state.rawAttemptStorage
                    || storage.getItem(PENDING_KEY) !== state.rawPendingStorage
                ) return { status: "stale" };
                storage.setItem("omr_attempts_quarantine", state.rawAttemptStorage);
                storage.removeItem(ATTEMPTS_KEY);
                storage.removeItem(PENDING_KEY);
                return { status: "quarantined" };
            }
            if (storage.getItem(PENDING_KEY) !== state.rawPendingStorage) return { status: "stale" };
            const parsed = JSON.parse(storage.getItem(ATTEMPTS_KEY) ?? "[]");
            if (!Array.isArray(parsed)) return { status: "stale" };
            const remaining = parsed.filter(value => {
                const attempt = record(value);
                return !attempt || !isGuestRecoveryAttempt(attempt, state.guestId);
            });
            if (remaining.length > 0) storage.setItem(ATTEMPTS_KEY, JSON.stringify(remaining));
            else storage.removeItem(ATTEMPTS_KEY);
            storage.removeItem(PENDING_KEY);
            return { status: "discarded" };
        });
    } catch {
        return { status: "failed" };
    }
}
