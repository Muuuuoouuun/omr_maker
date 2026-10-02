/**
 * One-shot, tab-scoped "the student just chose to open this exam" marker.
 *
 * The solve page asks "학생으로 시험 보기?" before entry so a shared link opened
 * on someone else's logged-in device is not silently attributed to them. When
 * the student already made that choice one screen earlier (the dashboard
 * "시작" button, or a login whose `next=` is the exam), the question is pure
 * friction. This marker carries that choice across the navigation:
 *
 * - sessionStorage, so it never leaves the tab and never appears in a URL that
 *   could be copied or shared;
 * - bound to examId, studentId and the assignment scope, so it cannot be
 *   replayed onto another exam or another login;
 * - short-lived (120s) and consumed on the first read, success or not.
 *
 * It only skips the confirmation dialog. Access is still re-validated on entry
 * (openStudentExam on the server, evaluateExamAccess locally).
 */

export const SOLVE_ENTRY_INTENT_STORAGE_KEY = "omr_solve_entry_intent_v1";
export const SOLVE_ENTRY_INTENT_TTL_MS = 120_000;

interface SessionStorageLike {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

export interface SolveEntryTarget {
    examId: string;
    assignmentId?: string | null;
    studentId: string;
}

interface StoredSolveEntryIntent {
    examId: string;
    assignmentId?: string;
    studentId: string;
    createdAt: number;
}

interface IntentOptions {
    storage?: SessionStorageLike | null;
    now?: number;
}

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function defaultStorage(): SessionStorageLike | null {
    try {
        return typeof window === "undefined" ? null : window.sessionStorage;
    } catch {
        return null;
    }
}

function resolveStorage(options?: IntentOptions): SessionStorageLike | null {
    return options && "storage" in options ? options.storage ?? null : defaultStorage();
}

function nowOf(options?: IntentOptions): number {
    return Number.isFinite(options?.now) ? Number(options?.now) : Date.now();
}

export function recordSolveEntryIntent(target: SolveEntryTarget, options?: IntentOptions): boolean {
    const examId = clean(target.examId);
    const studentId = clean(target.studentId);
    const assignmentId = clean(target.assignmentId);
    const storage = resolveStorage(options);
    if (!storage || !examId || !studentId) return false;
    const intent: StoredSolveEntryIntent = {
        examId,
        ...(assignmentId ? { assignmentId } : {}),
        studentId,
        createdAt: nowOf(options),
    };
    try {
        storage.setItem(SOLVE_ENTRY_INTENT_STORAGE_KEY, JSON.stringify(intent));
        return true;
    } catch {
        return false;
    }
}

/**
 * Records an intent for a post-login redirect. Only `/solve/{examId}` targets
 * qualify; the assignment scope is taken from the same `assignment` query
 * parameter the solve page reads.
 */
export function recordSolveEntryIntentForPath(
    nextPath: string,
    studentId: string,
    options?: IntentOptions,
): boolean {
    if (typeof nextPath !== "string" || !nextPath.startsWith("/solve/")) return false;
    let url: URL;
    try {
        url = new URL(nextPath, "https://omr.invalid");
    } catch {
        return false;
    }
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length !== 2 || segments[0] !== "solve") return false;
    let examId: string;
    try {
        examId = decodeURIComponent(segments[1]);
    } catch {
        return false;
    }
    return recordSolveEntryIntent({
        examId,
        assignmentId: url.searchParams.get("assignment"),
        studentId,
    }, options);
}

function readStored(storage: SessionStorageLike): StoredSolveEntryIntent | null {
    try {
        const value = JSON.parse(storage.getItem(SOLVE_ENTRY_INTENT_STORAGE_KEY) || "null") as Partial<StoredSolveEntryIntent> | null;
        const examId = clean(value?.examId);
        const studentId = clean(value?.studentId);
        const assignmentId = clean(value?.assignmentId) || undefined;
        const createdAt = Number(value?.createdAt);
        if (!examId || !studentId || !Number.isFinite(createdAt)) return null;
        return { examId, studentId, assignmentId, createdAt };
    } catch {
        return null;
    }
}

function matches(intent: StoredSolveEntryIntent, target: SolveEntryTarget, now: number): boolean {
    const age = now - intent.createdAt;
    if (age < 0 || age > SOLVE_ENTRY_INTENT_TTL_MS) return false;
    return intent.examId === clean(target.examId)
        && intent.studentId === clean(target.studentId)
        && (intent.assignmentId || "") === clean(target.assignmentId);
}

/** Non-consuming check, used to avoid flashing the dialog while entry starts. */
export function hasSolveEntryIntent(target: SolveEntryTarget, options?: IntentOptions): boolean {
    const storage = resolveStorage(options);
    if (!storage) return false;
    const intent = readStored(storage);
    return !!intent && matches(intent, target, nowOf(options));
}

/** Reads and always removes the intent; true only for a fresh, matching one. */
export function consumeSolveEntryIntent(target: SolveEntryTarget, options?: IntentOptions): boolean {
    const storage = resolveStorage(options);
    if (!storage) return false;
    const intent = readStored(storage);
    try {
        storage.removeItem(SOLVE_ENTRY_INTENT_STORAGE_KEY);
    } catch {
        // A storage that cannot forget the intent must not honour it either.
        return false;
    }
    return !!intent && matches(intent, target, nowOf(options));
}
