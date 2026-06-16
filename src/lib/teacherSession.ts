export const TEACHER_SESSION_KEY = "omr_teacher_session";
export const LEGACY_TEACHER_TOKEN_KEY = "omr_teacher_token";

export const TEACHER_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const TEACHER_SESSION_EXPIRING_SOON_MS = 30 * 60 * 1000;
const DEFAULT_TEACHER_REDIRECT = "/teacher/dashboard";

export interface TeacherSession {
    schemaVersion: 1;
    role: "teacher";
    token: string;
    issuedAt: number;
    expiresAt: number;
}

export interface TeacherSessionStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

export type TeacherSessionDisplayLevel = "active" | "expiring" | "expired";

export interface TeacherSessionDisplay {
    label: string;
    detail: string;
    level: TeacherSessionDisplayLevel;
    remainingMs: number;
    isExpired: boolean;
}

function getBrowserSessionStorage(): TeacherSessionStorage | null {
    if (typeof window === "undefined") return null;
    return window.sessionStorage;
}

export function isTeacherToken(token: unknown): token is string {
    return typeof token === "string" && /^tkn_[a-z0-9]+_[a-f0-9]{32}$/i.test(token.trim());
}

export function createTeacherSession(token: string, now = Date.now()): TeacherSession {
    return {
        schemaVersion: 1,
        role: "teacher",
        token,
        issuedAt: now,
        expiresAt: now + TEACHER_SESSION_TTL_MS,
    };
}

export function isTeacherSessionActive(session: TeacherSession | null | undefined, now = Date.now()): session is TeacherSession {
    return !!session
        && session.schemaVersion === 1
        && session.role === "teacher"
        && isTeacherToken(session.token)
        && Number.isFinite(session.expiresAt)
        && session.expiresAt > now;
}

export function parseTeacherSession(raw: string | null | undefined, now = Date.now()): TeacherSession | null {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as Partial<TeacherSession>;
        const session: TeacherSession = {
            schemaVersion: parsed.schemaVersion === 1 ? 1 : 1,
            role: "teacher",
            token: typeof parsed.token === "string" ? parsed.token : "",
            issuedAt: typeof parsed.issuedAt === "number" ? parsed.issuedAt : 0,
            expiresAt: typeof parsed.expiresAt === "number" ? parsed.expiresAt : 0,
        };
        return isTeacherSessionActive(session, now) ? session : null;
    } catch {
        return null;
    }
}

export function readTeacherSession(storage: TeacherSessionStorage | null = getBrowserSessionStorage(), now = Date.now()): TeacherSession | null {
    if (!storage) return null;
    try {
        const rawSession = storage.getItem(TEACHER_SESSION_KEY);
        if (rawSession) {
            const session = parseTeacherSession(rawSession, now);
            if (session) return session;
            clearTeacherSession(storage);
            return null;
        }

        const legacyToken = storage.getItem(LEGACY_TEACHER_TOKEN_KEY);
        if (!isTeacherToken(legacyToken)) return null;
        const migratedSession = createTeacherSession(legacyToken, now);
        storage.setItem(TEACHER_SESSION_KEY, JSON.stringify(migratedSession));
        return migratedSession;
    } catch {
        return null;
    }
}

export function hasTeacherSession(storage: TeacherSessionStorage | null = getBrowserSessionStorage(), now = Date.now()): boolean {
    return !!readTeacherSession(storage, now);
}

export function saveTeacherSession(token: string, storage: TeacherSessionStorage | null = getBrowserSessionStorage(), now = Date.now()): boolean {
    if (!storage || !isTeacherToken(token)) return false;
    try {
        const session = createTeacherSession(token, now);
        storage.setItem(TEACHER_SESSION_KEY, JSON.stringify(session));
        storage.setItem(LEGACY_TEACHER_TOKEN_KEY, token);
        return true;
    } catch {
        return false;
    }
}

export function clearTeacherSession(storage: TeacherSessionStorage | null = getBrowserSessionStorage()): void {
    if (!storage) return;
    try {
        storage.removeItem(TEACHER_SESSION_KEY);
        storage.removeItem(LEGACY_TEACHER_TOKEN_KEY);
    } catch {
        // ignore storage failures
    }
}

export function teacherSessionRemainingMs(session: TeacherSession | null | undefined, now = Date.now()): number {
    if (!isTeacherSessionActive(session, now)) return 0;
    return Math.max(0, session.expiresAt - now);
}

export function formatTeacherSessionRemaining(remainingMs: number): string {
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) return "만료됨";
    const totalMinutes = Math.max(1, Math.ceil(remainingMs / 60000));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;

    if (hours <= 0) return `${totalMinutes}분 남음`;
    if (minutes === 0) return `${hours}시간 남음`;
    return `${hours}시간 ${minutes}분 남음`;
}

export function buildTeacherSessionDisplay(session: TeacherSession | null | undefined, now = Date.now()): TeacherSessionDisplay {
    const remainingMs = teacherSessionRemainingMs(session, now);
    const isExpired = remainingMs <= 0;
    const level: TeacherSessionDisplayLevel = isExpired
        ? "expired"
        : remainingMs <= TEACHER_SESSION_EXPIRING_SOON_MS
            ? "expiring"
            : "active";

    return {
        label: formatTeacherSessionRemaining(remainingMs),
        detail: session && !isExpired
            ? `만료 시각 ${new Date(session.expiresAt).toLocaleString('ko-KR')}`
            : "교사 세션이 없거나 만료되었습니다.",
        level,
        remainingMs,
        isExpired,
    };
}

export function normalizeTeacherRedirectPath(value: string | null | undefined): string {
    if (!value) return DEFAULT_TEACHER_REDIRECT;
    const trimmed = value.trim();
    if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return DEFAULT_TEACHER_REDIRECT;
    if (trimmed.startsWith("/teacher/") || trimmed === "/teacher" || trimmed === "/create" || trimmed.startsWith("/create?")) {
        return trimmed;
    }
    return DEFAULT_TEACHER_REDIRECT;
}
