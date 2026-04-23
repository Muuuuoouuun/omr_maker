import type { Attempt, Exam } from "@/types/omr";

export const STORAGE_KEYS = {
    EXAM_PREFIX: "omr_exam_",
    EXAMS: "omr_exams", // Legacy aggregate key, kept for compatibility.
    ATTEMPTS: "omr_attempts",
    STUDENT_SESSION: "omr_student_session",
    GUEST_ID: "omr_guest_id"
} as const;

export interface StudentSession {
    name: string;
    studentId?: string;
    groupId?: string; // Optional for guest
    groupName?: string;
    isGuest?: boolean;
    guestId?: string; // specific UUID for guest
}

// Helper to generate UUID-like string
export function generateId(): string {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
        return crypto.randomUUID();
    }
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function safeParseJson<T>(raw: string | null, fallback: T): T {
    if (!raw) return fallback;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return fallback;
    }
}

function readLocalJson<T>(key: string, fallback: T): T {
    if (typeof window === "undefined") return fallback;
    return safeParseJson(localStorage.getItem(key), fallback);
}

function writeLocalJson<T>(key: string, value: T): boolean {
    if (typeof window === "undefined") return false;
    try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
    } catch {
        return false;
    }
}

function isExam(value: unknown): value is Exam {
    return isRecord(value)
        && typeof value.id === "string"
        && typeof value.title === "string"
        && Array.isArray(value.questions);
}

function isAttempt(value: unknown): value is Attempt {
    return isRecord(value)
        && typeof value.id === "string"
        && typeof value.examId === "string"
        && typeof value.examTitle === "string"
        && typeof value.studentName === "string"
        && typeof value.startedAt === "string"
        && typeof value.finishedAt === "string"
        && typeof value.score === "number"
        && typeof value.totalScore === "number"
        && isRecord(value.answers)
        && (value.status === "completed" || value.status === "in_progress");
}

export function examStorageKey(examId: string): string {
    return `${STORAGE_KEYS.EXAM_PREFIX}${examId}`;
}

export function loadExam(examId: string): Exam | null {
    const parsed = readLocalJson<unknown>(examStorageKey(examId), null);
    return isExam(parsed) ? parsed : null;
}

export function loadAllExams(): Exam[] {
    if (typeof window === "undefined") return [];
    const exams: Exam[] = [];
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key?.startsWith(STORAGE_KEYS.EXAM_PREFIX)) continue;
        const parsed = readLocalJson<unknown>(key, null);
        if (isExam(parsed)) exams.push(parsed);
    }
    return exams;
}

export function saveExam(exam: Exam): boolean {
    return writeLocalJson(examStorageKey(exam.id), exam);
}

export function loadAttempts(): Attempt[] {
    const parsed = readLocalJson<unknown>(STORAGE_KEYS.ATTEMPTS, []);
    return Array.isArray(parsed) ? parsed.filter(isAttempt) : [];
}

export function saveAttempts(attempts: Attempt[]): boolean {
    return writeLocalJson(STORAGE_KEYS.ATTEMPTS, attempts);
}

export function appendAttempt(attempt: Attempt): boolean {
    return saveAttempts([...loadAttempts(), attempt]);
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
    const parsed = safeParseJson<unknown>(str, null);
    if (!isRecord(parsed) || typeof parsed.name !== "string") return null;
    const session: StudentSession = { name: parsed.name };
    if (typeof parsed.studentId === "string") session.studentId = parsed.studentId;
    if (typeof parsed.groupId === "string") session.groupId = parsed.groupId;
    if (typeof parsed.groupName === "string") session.groupName = parsed.groupName;
    if (typeof parsed.guestId === "string") session.guestId = parsed.guestId;
    if (typeof parsed.isGuest === "boolean") session.isGuest = parsed.isGuest;
    return session;
}

export function clearSession() {
    if (typeof window === 'undefined') return;
    sessionStorage.removeItem(STORAGE_KEYS.STUDENT_SESSION);
}

function normalizeName(name: string): string {
    return name.trim().toLocaleLowerCase();
}

export function makeStudentId(name: string, groupId: string): string {
    return `${groupId}::${name.trim()}`;
}

export function studentIdentityKeyFromAttempt(attempt: Attempt): string {
    if (attempt.studentId) return `student:${attempt.studentId}`;
    if (attempt.guestId) return `guest:${attempt.guestId}`;
    return `name:${normalizeName(attempt.studentName)}`;
}

export function studentIdentityKeyFromSession(session: StudentSession): string {
    if (session.isGuest && session.guestId) return `guest:${session.guestId}`;
    if (session.studentId) return `student:${session.studentId}`;
    if (session.groupId) return `legacy:${session.groupId}:${normalizeName(session.name)}`;
    return `name:${normalizeName(session.name)}`;
}

export function attemptMatchesSession(attempt: Attempt, session: StudentSession): boolean {
    if (session.isGuest) {
        return !!session.guestId && attempt.guestId === session.guestId;
    }

    if (session.studentId && attempt.studentId === session.studentId) return true;
    if (!attempt.studentId && normalizeName(attempt.studentName) === normalizeName(session.name)) {
        return !session.groupId || !attempt.guestId;
    }
    return false;
}

export function scorePercent(attempt: Pick<Attempt, "score" | "totalScore">): number {
    if (!attempt.totalScore || attempt.totalScore <= 0) return 0;
    return (attempt.score / attempt.totalScore) * 100;
}

// Data Merging Logic
export function mergeGuestAttempts(guestId: string, realStudentName: string, realStudentId?: string) {
    if (typeof window === 'undefined') return;

    const allAttempts = loadAttempts();
    let updated = false;

    const newAttempts = allAttempts.map(attempt => {
        if (attempt.guestId !== guestId) return attempt;
        updated = true;
        return {
            ...attempt,
            studentName: realStudentName,
            studentId: realStudentId ?? attempt.studentId,
        };
    });

    if (updated && !saveAttempts(newAttempts)) {
        console.error("Failed to merge attempts");
    }
}
