import type { Attempt, IdentityType } from "@/types/omr";

export const STORAGE_KEYS = {
    EXAMS: "omr_exams", // Prefix for individual exams? No, current logic scans omr_exam_ prefix.
    ATTEMPTS: "omr_attempts",
    STUDENT_SESSION: "omr_student_session",
    GUEST_ID: "omr_guest_id"
};

export interface StudentSession {
    studentId: string;
    name: string;
    groupId?: string; // Optional for guest
    groupName?: string;
    isGuest: boolean;
    identityType: IdentityType;
    guestId?: string; // specific UUID for guest
    loginId?: string;
}

// Stable local identifier for a class-issued temporary student identity.
// DB-backed implementations should replace this with student_profiles.id.
export function studentIdFor(name: string, groupId: string): string {
    return `${groupId}::${name.trim()}`;
}

// Helper to generate UUID-like string
export function generateId(): string {
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

export function getOrCreateGuestId(): string {
    if (typeof window === 'undefined') return "";
    let id = localStorage.getItem(STORAGE_KEYS.GUEST_ID);
    if (!id) {
        id = generateId();
        localStorage.setItem(STORAGE_KEYS.GUEST_ID, id);
    }
    return id;
}

export function saveSession(session: StudentSession) {
    if (typeof window === 'undefined') return;
    sessionStorage.setItem(STORAGE_KEYS.STUDENT_SESSION, JSON.stringify(session));
}

function normalizeSession(raw: Partial<StudentSession> | null): StudentSession | null {
    if (!raw || !raw.name) return null;
    const isGuest = !!raw.isGuest || !!raw.guestId;
    const studentId = raw.studentId
        || (isGuest && raw.guestId ? `guest:${raw.guestId}` : undefined)
        || (raw.groupId ? studentIdFor(raw.name, raw.groupId) : undefined);
    if (!studentId) return null;

    return {
        ...raw,
        studentId,
        name: raw.name,
        isGuest,
        identityType: raw.identityType || (isGuest ? 'guest' : 'temporary'),
    };
}

export function getSession(): StudentSession | null {
    if (typeof window === 'undefined') return null;
    const str = sessionStorage.getItem(STORAGE_KEYS.STUDENT_SESSION);
    if (!str) return null;
    try {
        return normalizeSession(JSON.parse(str));
    } catch {
        return null;
    }
}

export function clearSession() {
    if (typeof window === 'undefined') return;
    sessionStorage.removeItem(STORAGE_KEYS.STUDENT_SESSION);
}

export function attemptBelongsToSession(attempt: Attempt, session: StudentSession): boolean {
    if (session.isGuest || session.identityType === 'guest') {
        return !!session.guestId && attempt.guestId === session.guestId;
    }

    if (attempt.studentId && attempt.studentId === session.studentId) return true;

    // Legacy fallback for attempts created before canonical studentId was saved.
    if (session.loginId && attempt.studentId === session.loginId) return true;
    if (!attempt.studentId && attempt.studentName === session.name) {
        if (!session.groupName && !session.groupId) return true;
        return !attempt.groupName || attempt.groupName === session.groupName || attempt.groupId === session.groupId;
    }

    return false;
}

export function attemptMatchesStudentProfile(
    attempt: Attempt,
    student: { id: string; name: string; group?: string; groupName?: string },
): boolean {
    if (attempt.studentId && attempt.studentId === student.id) return true;
    if (attempt.studentName !== student.name) return false;

    const profileGroup = student.group || student.groupName;
    if (!profileGroup) return true;
    return !attempt.groupName || attempt.groupName === profileGroup;
}

// Data Merging Logic
export function mergeGuestAttempts(
    guestId: string,
    target: {
        studentId: string;
        name: string;
        groupId?: string;
        groupName?: string;
        identityType?: IdentityType;
    } | string,
) {
    if (typeof window === 'undefined') return;

    const attemptsStr = localStorage.getItem(STORAGE_KEYS.ATTEMPTS);
    if (!attemptsStr) return;

    try {
        const targetProfile = typeof target === 'string'
            ? { studentId: target, name: target, identityType: 'temporary' as const }
            : target;

        const allAttempts: Attempt[] = JSON.parse(attemptsStr);
        let updated = false;
        const mergedAt = new Date().toISOString();

        const newAttempts = allAttempts.map(attempt => {
            // Include attempts that match the guestId OR strictly anonymous attempts from this device (if we want to be aggressive)
            // For now, let's assume we saved guestId in the attempt.
            if (attempt.guestId === guestId) {
                updated = true;
                return {
                    ...attempt,
                    studentId: targetProfile.studentId,
                    studentName: targetProfile.name,
                    groupId: targetProfile.groupId,
                    groupName: targetProfile.groupName,
                    identityType: targetProfile.identityType || 'temporary',
                    mergedFromGuestId: attempt.mergedFromGuestId || guestId,
                    mergedAt,
                };
            }
            return attempt;
        });

        if (updated) {
            localStorage.setItem(STORAGE_KEYS.ATTEMPTS, JSON.stringify(newAttempts));
        }
    } catch (e) {
        console.error("Failed to merge attempts", e);
    }
}
