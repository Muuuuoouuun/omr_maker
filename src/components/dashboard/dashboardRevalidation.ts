import {
    ATTEMPTS_STORAGE_KEY,
    DELETED_EXAMS_STORAGE_KEY,
    EXAM_STORAGE_KEY_PREFIX,
    SOLVE_DRAFT_STORAGE_KEY_PREFIX,
} from "@/lib/omrPersistence";
import { ROSTER_STORAGE_KEYS } from "@/lib/rosterStorage";
import { ROSTER_TOMBSTONE_STORAGE_KEY } from "@/lib/rosterPersistence";
import { STORAGE_KEYS } from "@/utils/storage";

/**
 * Cross-tab / refocus dashboard revalidation helpers.
 *
 * The dashboards read exams/attempts/roster from localStorage (plus remote sync)
 * once on mount, so a submission or roster edit in ANOTHER tab left them stale
 * until a manual reload. The page components listen to window "storage",
 * "focus" and document "visibilitychange" events and re-run their existing load
 * functions — these pure helpers decide (a) whether a storage key is relevant to
 * the dashboard and (b) whether enough time has passed to refresh again (with a
 * trailing slot so a burst arriving mid-window still lands one refresh at the
 * window boundary instead of being dropped).
 */

/** Refresh at most once per window to avoid thrash on event bursts. */
export const DASHBOARD_REVALIDATE_MIN_INTERVAL_MS = 10_000;

const TEACHER_DASHBOARD_KEYS = new Set<string>([
    ATTEMPTS_STORAGE_KEY,
    DELETED_EXAMS_STORAGE_KEY,
    ROSTER_STORAGE_KEYS.students,
    ROSTER_STORAGE_KEYS.groups,
    ROSTER_STORAGE_KEYS.invites,
    ROSTER_TOMBSTONE_STORAGE_KEY,
]);

const STUDENT_DASHBOARD_KEYS = new Set<string>([
    ATTEMPTS_STORAGE_KEY,
    DELETED_EXAMS_STORAGE_KEY,
    STORAGE_KEYS.STUDENT_SESSION_BACKUP,
    STORAGE_KEYS.PENDING_GUEST_MERGE,
]);

/**
 * True when a cross-tab StorageEvent key affects the teacher dashboard
 * (exams, attempts, roster). A null key means localStorage.clear() — always relevant.
 */
export function isTeacherDashboardStorageKey(key: string | null): boolean {
    if (key === null) return true;
    return TEACHER_DASHBOARD_KEYS.has(key) || key.startsWith(EXAM_STORAGE_KEY_PREFIX);
}

/**
 * True when a cross-tab StorageEvent key affects the student dashboard
 * (exams, attempts, solve drafts, the persistent session backup, queued guest
 * merges). A null key means localStorage.clear() — always relevant.
 */
export function isStudentDashboardStorageKey(key: string | null): boolean {
    if (key === null) return true;
    return STUDENT_DASHBOARD_KEYS.has(key)
        || key.startsWith(EXAM_STORAGE_KEY_PREFIX)
        || key.startsWith(SOLVE_DRAFT_STORAGE_KEY_PREFIX);
}

export type RevalidationDecision =
    | { kind: "refresh" }
    | { kind: "schedule"; delayMs: number }
    | { kind: "ignore" };

export interface DashboardRevalidationGate {
    /**
     * Decide what to do with a trigger (storage event / focus / visibility):
     * - "refresh": refresh now (window elapsed; the gate records the refresh).
     * - "schedule": first trigger inside a closed window — run one trailing
     *   refresh after `delayMs`, then call `confirmScheduledRefresh()`.
     * - "ignore": a trailing refresh is already scheduled; coalesce into it.
     */
    decide(): RevalidationDecision;
    /** Record that the scheduled trailing refresh ran (opens the next window). */
    confirmScheduledRefresh(): void;
    /** Drop a pending trailing slot (e.g. the timer was cleared on unmount). */
    cancelScheduled(): void;
}

/**
 * Throttle gate for dashboard revalidation. Created "hot": the mount load counts
 * as the first refresh, so a focus event fired right after mount does not
 * double-load.
 */
export function createDashboardRevalidationGate(options: {
    minIntervalMs?: number;
    now?: () => number;
} = {}): DashboardRevalidationGate {
    const minIntervalMs = options.minIntervalMs ?? DASHBOARD_REVALIDATE_MIN_INTERVAL_MS;
    const now = options.now ?? Date.now;
    let lastRefreshAt = now();
    let scheduled = false;

    return {
        decide() {
            if (scheduled) return { kind: "ignore" };
            const elapsed = now() - lastRefreshAt;
            if (elapsed >= minIntervalMs) {
                lastRefreshAt = now();
                return { kind: "refresh" };
            }
            scheduled = true;
            return { kind: "schedule", delayMs: minIntervalMs - elapsed };
        },
        confirmScheduledRefresh() {
            scheduled = false;
            lastRefreshAt = now();
        },
        cancelScheduled() {
            scheduled = false;
        },
    };
}
