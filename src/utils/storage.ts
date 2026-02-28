export const STORAGE_KEYS = {
    EXAMS: "omr_exams", // Prefix for individual exams? No, current logic scans omr_exam_ prefix.
    ATTEMPTS: "omr_attempts",
    STUDENT_SESSION: "omr_student_session",
    GUEST_ID: "omr_guest_id"
};

export interface StudentSession {
    name: string;
    groupId?: string; // Optional for guest
    groupName?: string;
    isGuest: boolean;
    guestId?: string; // specific UUID for guest
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

export function getSession(): StudentSession | null {
    if (typeof window === 'undefined') return null;
    const str = sessionStorage.getItem(STORAGE_KEYS.STUDENT_SESSION);
    return str ? JSON.parse(str) : null;
}

export function clearSession() {
    if (typeof window === 'undefined') return;
    sessionStorage.removeItem(STORAGE_KEYS.STUDENT_SESSION);
}

// Data Merging Logic
export function mergeGuestAttempts(guestId: string, realStudentName: string) {
    if (typeof window === 'undefined') return;

    const attemptsStr = localStorage.getItem(STORAGE_KEYS.ATTEMPTS);
    if (!attemptsStr) return;

    try {
        const allAttempts: any[] = JSON.parse(attemptsStr);
        let updated = false;

        const newAttempts = allAttempts.map(attempt => {
            // Include attempts that match the guestId OR strictly anonymous attempts from this device (if we want to be aggressive)
            // For now, let's assume we saved guestId in the attempt.
            if (attempt.guestId === guestId && attempt.studentName !== realStudentName) {
                updated = true;
                return {
                    ...attempt,
                    studentName: realStudentName,
                    // keep guestId for record or clear it? Keeping it is safer for now.
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
