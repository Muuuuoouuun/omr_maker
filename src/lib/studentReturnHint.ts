/**
 * Opt-in "remember me on this device" hint for returning students (PO B-3).
 *
 * The signed server session stays fixed at 12h after login (decision B-1), so
 * "remembering" a student only means pre-filling the login form next time.
 * The hint holds the display name and class only — never a student number,
 * email, start code, invite token or server cookie value.
 */

export const STUDENT_RETURN_HINT_STORAGE_KEY = "omr_student_return_hint_v1";
export const STUDENT_RETURN_HINT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface StudentReturnHint {
    name: string;
    groupId: string;
    groupName: string;
    regionName?: string;
    savedAt: string;
}

export interface StudentReturnHintSource {
    name?: string;
    groupId?: string;
    groupName?: string;
    regionName?: string;
    isGuest?: boolean;
}

type HintStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStorage(): HintStorage | null {
    if (typeof window === "undefined") return null;
    try {
        return window.localStorage;
    } catch {
        return null;
    }
}

function cleanText(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

/** Whitelists the allowed fields; guests and incomplete identities get no hint. */
export function buildStudentReturnHint(
    source: StudentReturnHintSource,
    now: number = Date.now(),
): StudentReturnHint | null {
    if (source.isGuest) return null;
    const name = cleanText(source.name);
    const groupId = cleanText(source.groupId);
    const groupName = cleanText(source.groupName) || groupId;
    if (!name || !groupId) return null;
    const regionName = cleanText(source.regionName);
    return {
        name,
        groupId,
        groupName,
        ...(regionName ? { regionName } : {}),
        savedAt: new Date(now).toISOString(),
    };
}

export function parseStudentReturnHint(
    raw: string | null | undefined,
    now: number = Date.now(),
): StudentReturnHint | null {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as Record<string, unknown> | null;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
        const savedAtMs = Date.parse(cleanText(parsed.savedAt));
        if (!Number.isFinite(savedAtMs)) return null;
        const age = now - savedAtMs;
        if (age < 0 || age > STUDENT_RETURN_HINT_TTL_MS) return null;
        const hint = buildStudentReturnHint({
            name: cleanText(parsed.name),
            groupId: cleanText(parsed.groupId),
            groupName: cleanText(parsed.groupName),
            regionName: cleanText(parsed.regionName),
        }, savedAtMs);
        return hint;
    } catch {
        return null;
    }
}

export function readStudentReturnHint(
    storage: HintStorage | null = defaultStorage(),
    now: number = Date.now(),
): StudentReturnHint | null {
    if (!storage) return null;
    try {
        const raw = storage.getItem(STUDENT_RETURN_HINT_STORAGE_KEY);
        if (!raw) return null;
        const hint = parseStudentReturnHint(raw, now);
        // Expired or corrupt hints are dropped so they cannot linger.
        if (!hint) storage.removeItem(STUDENT_RETURN_HINT_STORAGE_KEY);
        return hint;
    } catch {
        return null;
    }
}

export function saveStudentReturnHint(
    source: StudentReturnHintSource,
    storage: HintStorage | null = defaultStorage(),
    now: number = Date.now(),
): boolean {
    if (!storage) return false;
    const hint = buildStudentReturnHint(source, now);
    try {
        if (!hint) {
            storage.removeItem(STUDENT_RETURN_HINT_STORAGE_KEY);
            return false;
        }
        storage.setItem(STUDENT_RETURN_HINT_STORAGE_KEY, JSON.stringify(hint));
        return true;
    } catch {
        return false;
    }
}

/**
 * Re-syncs an existing (opted-in) hint with the session that is about to be
 * cleared. Never creates a hint the student did not opt into.
 */
export function refreshStudentReturnHint(
    source: StudentReturnHintSource,
    storage: HintStorage | null = defaultStorage(),
    now: number = Date.now(),
): boolean {
    if (!readStudentReturnHint(storage, now)) return false;
    return saveStudentReturnHint(source, storage, now);
}

export function clearStudentReturnHint(storage: HintStorage | null = defaultStorage()): void {
    if (!storage) return;
    try {
        storage.removeItem(STUDENT_RETURN_HINT_STORAGE_KEY);
    } catch {
        // Blocked storage has nothing to clear.
    }
}
