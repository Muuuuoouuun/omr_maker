import { parseStudentCodes, STUDENT_CODES_STORAGE_KEY } from "@/lib/studentCodes";

interface LegacyStudentCodeStorage {
    getItem(key: string): string | null;
    removeItem(key: string): void;
}

function scrub(storage: LegacyStudentCodeStorage): void {
    try {
        storage.removeItem(STUDENT_CODES_STORAGE_KEY);
    } catch {
        // The caller still receives no credential material when storage is unavailable.
    }
}

export function loadLocalStudentCodes(
    storage: LegacyStudentCodeStorage,
    nodeEnv: string | undefined,
): Record<string, string> {
    if (nodeEnv === "production") {
        scrub(storage);
        return {};
    }

    try {
        const raw = storage.getItem(STUDENT_CODES_STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            scrub(storage);
            return {};
        }
        return parseStudentCodes(raw);
    } catch {
        scrub(storage);
        return {};
    }
}

export function loadTeacherLocalStudentCodes(
    storage: LegacyStudentCodeStorage,
    nodeEnv: string | undefined,
): Record<string, string> {
    return loadLocalStudentCodes(storage, nodeEnv);
}
