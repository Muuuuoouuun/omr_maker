import type { Attempt, Exam, IdentityType } from "@/types/omr";
import { readLocalAttempts, sortByNewestActivity } from "@/lib/omrPersistence";

export const STORAGE_KEYS = {
    EXAM_PREFIX: "omr_exam_",
    EXAMS: "omr_exams", // Legacy aggregate key, kept for compatibility.
    ATTEMPTS: "omr_attempts",
    STUDENT_SESSION: "omr_student_session",
    STUDENT_SESSION_BACKUP: "omr_student_session_backup",
    GUEST_ID: "omr_guest_id",
    PENDING_GUEST_MERGE: "omr_pending_guest_merge",
} as const;

export interface StudentSession {
    studentId: string;
    name: string;
    groupId?: string; // Optional for guest
    groupName?: string;
    regionId?: string;
    regionName?: string;
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
    const payload = JSON.stringify(session);
    try {
        sessionStorage.setItem(STORAGE_KEYS.STUDENT_SESSION, payload);
    } catch {
        // Session storage can be blocked in some embedded/private modes.
    }
    try {
        localStorage.setItem(STORAGE_KEYS.STUDENT_SESSION_BACKUP, payload);
    } catch {
        // Keep the in-tab session even if persistent storage is unavailable.
    }
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
        regionId: normalizeIdentityText(raw.regionId) || undefined,
        regionName: normalizeIdentityText(raw.regionName) || undefined,
        isGuest,
        identityType: raw.identityType || (isGuest ? 'guest' : 'temporary'),
    };
}

export function getSession(): StudentSession | null {
    if (typeof window === 'undefined') return null;
    try {
        const rawSession = sessionStorage.getItem(STORAGE_KEYS.STUDENT_SESSION);
        if (rawSession) return normalizeSession(JSON.parse(rawSession));
    } catch {
        // Fall through to the persistent same-device backup.
    }

    try {
        const rawBackup = localStorage.getItem(STORAGE_KEYS.STUDENT_SESSION_BACKUP);
        if (!rawBackup) return null;
        const restored = normalizeSession(JSON.parse(rawBackup));
        if (restored) {
            try {
                sessionStorage.setItem(STORAGE_KEYS.STUDENT_SESSION, JSON.stringify(restored));
            } catch {
                // A readable backup is enough for this request.
            }
        }
        return restored;
    } catch {
        return null;
    }
}

export function clearSession() {
    if (typeof window === 'undefined') return;
    try {
        sessionStorage.removeItem(STORAGE_KEYS.STUDENT_SESSION);
    } catch {
        // ignore
    }
    try {
        localStorage.removeItem(STORAGE_KEYS.STUDENT_SESSION_BACKUP);
    } catch {
        // ignore
    }
}

export interface PendingGuestMerge {
    guestId: string;
    queuedAt: string;
}

export interface GuestMergeTarget {
    studentId: string;
    name: string;
    groupId?: string;
    groupName?: string;
    regionId?: string;
    regionName?: string;
    identityType?: IdentityType;
}

export interface GuestMergePreview {
    guestId: string;
    mergeableCount: number;
    alreadyLinkedCount: number;
    latestFinishedAt?: string;
    examTitles: string[];
    attemptIds: string[];
}

export function queueGuestMerge(guestId: string): boolean {
    if (typeof window === 'undefined' || !guestId) return false;
    try {
        const payload: PendingGuestMerge = {
            guestId,
            queuedAt: new Date().toISOString(),
        };
        localStorage.setItem(STORAGE_KEYS.PENDING_GUEST_MERGE, JSON.stringify(payload));
        return true;
    } catch {
        return false;
    }
}

export function readPendingGuestMerge(): PendingGuestMerge | null {
    if (typeof window === 'undefined') return null;
    try {
        const raw = localStorage.getItem(STORAGE_KEYS.PENDING_GUEST_MERGE);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<PendingGuestMerge>;
        if (!parsed.guestId) return null;
        return {
            guestId: parsed.guestId,
            queuedAt: parsed.queuedAt || new Date().toISOString(),
        };
    } catch {
        return null;
    }
}

export function consumePendingGuestMerge(): PendingGuestMerge | null {
    if (typeof window === 'undefined') return null;
    try {
        const pending = readPendingGuestMerge();
        if (!pending) return null;
        localStorage.removeItem(STORAGE_KEYS.PENDING_GUEST_MERGE);
        return pending;
    } catch {
        localStorage.removeItem(STORAGE_KEYS.PENDING_GUEST_MERGE);
        return null;
    }
}

export function readStoredGuestId(): string {
    if (typeof window === 'undefined') return "";
    try {
        return localStorage.getItem(STORAGE_KEYS.GUEST_ID)?.trim() || "";
    } catch {
        return "";
    }
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
        if (!attempt.groupName && !attempt.groupId) return false;
        return attempt.groupName === session.groupName || attempt.groupId === session.groupId;
    }

    return false;
}

function normalizeIdentityText(value: string | undefined): string {
    return value?.trim() || "";
}

function splitScopedStudentId(value: string | undefined): { groupKey: string; name: string } | null {
    const normalized = normalizeIdentityText(value);
    const separatorIndex = normalized.indexOf("::");
    if (separatorIndex <= 0) return null;

    const groupKey = normalized.slice(0, separatorIndex).trim();
    const name = normalized.slice(separatorIndex + 2).trim();
    if (!groupKey || !name) return null;
    return { groupKey, name };
}

export function attemptMatchesStudentProfile(
    attempt: Attempt,
    student: { id: string; name: string; group?: string; groupName?: string; region?: string },
): boolean {
    const profileId = normalizeIdentityText(student.id);
    const profileName = normalizeIdentityText(student.name);
    const profileGroup = normalizeIdentityText(student.group || student.groupName);
    const profileRegion = normalizeIdentityText(student.region);
    const profileScoped = splitScopedStudentId(profileId);
    const profileGroupKeys = new Set(
        [profileGroup, profileScoped?.groupKey]
            .map(normalizeIdentityText)
            .filter(Boolean)
    );

    const attemptStudentId = normalizeIdentityText(attempt.studentId);
    if (attemptStudentId && attemptStudentId === profileId) return true;

    const attemptScoped = splitScopedStudentId(attemptStudentId);
    const attemptName = normalizeIdentityText(attempt.studentName) || attemptScoped?.name || "";
    if (attemptName !== profileName && attemptScoped?.name !== profileName) return false;

    const attemptRegion = normalizeIdentityText(attempt.regionName) || normalizeIdentityText(attempt.regionId);
    if (profileRegion && attemptRegion && profileRegion !== attemptRegion) return false;

    if (profileGroupKeys.size === 0) return true;

    const attemptGroupKeys = new Set(
        [attempt.groupId, attempt.groupName, attemptScoped?.groupKey]
            .map(normalizeIdentityText)
            .filter(Boolean)
    );
    if (attemptGroupKeys.size === 0) return false;

    return [...attemptGroupKeys].some(key => profileGroupKeys.has(key));
}

function normalizeMergeTarget(target: GuestMergeTarget | string): GuestMergeTarget {
    return typeof target === 'string'
        ? { studentId: target, name: target, identityType: 'temporary' }
        : target;
}

function isGuestAttemptMergeable(attempt: Attempt, guestId: string, target?: GuestMergeTarget): boolean {
    if (!guestId || attempt.guestId !== guestId) return false;
    if (target && attempt.studentId === target.studentId) return false;

    const alreadyLinkedToStudent = !!attempt.mergedFromGuestId
        && attempt.identityType !== 'guest'
        && !!attempt.studentId
        && !attempt.studentId.startsWith("guest:");
    return !alreadyLinkedToStudent;
}

export function previewGuestMerge(guestId: string, target?: GuestMergeTarget | string): GuestMergePreview {
    if (typeof window === 'undefined' || !guestId) {
        return { guestId, mergeableCount: 0, alreadyLinkedCount: 0, examTitles: [], attemptIds: [] };
    }

    const targetProfile = target ? normalizeMergeTarget(target) : undefined;
    const matching = readLocalAttempts().filter(attempt => attempt.guestId === guestId);
    const mergeable = matching.filter(attempt => isGuestAttemptMergeable(attempt, guestId, targetProfile));
    const sortedMergeable = sortByNewestActivity(mergeable);
    const examTitles = Array.from(new Set(sortedMergeable.map(attempt => attempt.examTitle || attempt.examId).filter(Boolean))).slice(0, 4);

    return {
        guestId,
        mergeableCount: mergeable.length,
        alreadyLinkedCount: matching.length - mergeable.length,
        latestFinishedAt: sortedMergeable[0]?.finishedAt || sortedMergeable[0]?.startedAt,
        examTitles,
        attemptIds: sortedMergeable.map(attempt => attempt.id),
    };
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
export function mergeGuestAttempts(
    guestId: string,
    target: GuestMergeTarget | string,
) {
    if (typeof window === 'undefined') return 0;

    const allAttempts = readLocalAttempts();
    if (allAttempts.length === 0) return 0;

    try {
        const targetProfile = normalizeMergeTarget(target);

        let updated = false;
        let mergedCount = 0;
        const mergedAt = new Date().toISOString();

        const newAttempts = allAttempts.map(attempt => {
            if (isGuestAttemptMergeable(attempt, guestId, targetProfile)) {
                updated = true;
                mergedCount += 1;
                return {
                    ...attempt,
                    studentId: targetProfile.studentId,
                    studentName: targetProfile.name,
                    groupId: targetProfile.groupId,
                    groupName: targetProfile.groupName,
                    regionId: targetProfile.regionId,
                    regionName: targetProfile.regionName,
                    identityType: targetProfile.identityType || 'temporary',
                    mergedFromGuestId: attempt.mergedFromGuestId || guestId,
                    mergedAt,
                    questionResults: attempt.questionResults?.map(result => ({
                        ...result,
                        studentName: targetProfile.name,
                        studentId: targetProfile.studentId,
                        groupId: targetProfile.groupId,
                        groupName: targetProfile.groupName,
                        regionId: targetProfile.regionId,
                        regionName: targetProfile.regionName,
                        identityType: targetProfile.identityType || 'temporary',
                    })),
                };
            }
            return attempt;
        });

        if (updated) {
            localStorage.setItem(STORAGE_KEYS.ATTEMPTS, JSON.stringify(sortByNewestActivity(newAttempts)));
        }
        return mergedCount;
    } catch (e) {
        console.error("Failed to merge attempts", e);
        return 0;
    }
}
