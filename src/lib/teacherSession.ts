export const TEACHER_SESSION_KEY = "omr_teacher_session";
export const LEGACY_TEACHER_TOKEN_KEY = "omr_teacher_token";

export const TEACHER_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const TEACHER_SESSION_EXPIRING_SOON_MS = 30 * 60 * 1000;
const DEFAULT_TEACHER_REDIRECT = "/teacher/dashboard";
const ORGANIZATION_ID_PATTERN = /^(?:default|teacher_[a-z0-9]{7,16})$/;

export type TeacherMemberRole = "owner" | "admin" | "teacher" | "assistant" | "viewer";
export type TeacherPlanCeiling = "free" | "pro" | "academy";

function normalizeMemberRole(value: unknown): TeacherMemberRole | undefined {
    return typeof value === "string" && ["owner", "admin", "teacher", "assistant", "viewer"].includes(value.trim())
        ? value.trim() as TeacherMemberRole
        : undefined;
}

function normalizePlan(value: unknown): TeacherPlanCeiling | undefined {
    return typeof value === "string" && ["free", "pro", "academy"].includes(value.trim())
        ? value.trim() as TeacherPlanCeiling
        : undefined;
}

function normalizeOrganizationId(value: unknown): string | undefined {
    const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
    return ORGANIZATION_ID_PATTERN.test(normalized) ? normalized : undefined;
}

export interface TeacherSession {
    schemaVersion: 1;
    role: "teacher";
    token: string;
    teacherId?: string;
    email?: string;
    displayName?: string;
    organizationId?: string;
    organizationName?: string;
    memberRole?: TeacherMemberRole;
    plan?: TeacherPlanCeiling;
    issuedAt: number;
    expiresAt: number;
}

export interface TeacherSessionIdentity {
    teacherId: string;
    email?: string;
    displayName?: string;
    organizationId?: string;
    organizationName?: string;
    memberRole?: TeacherMemberRole;
    plan?: TeacherPlanCeiling;
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
    actorLabel: string;
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

export function createTeacherSession(token: string, now = Date.now(), identity?: TeacherSessionIdentity): TeacherSession {
    return {
        schemaVersion: 1,
        role: "teacher",
        token,
        teacherId: identity?.teacherId?.trim() || undefined,
        email: identity?.email?.trim() || undefined,
        displayName: identity?.displayName?.trim() || undefined,
        organizationId: normalizeOrganizationId(identity?.organizationId),
        organizationName: identity?.organizationName?.trim() || undefined,
        memberRole: normalizeMemberRole(identity?.memberRole),
        plan: normalizePlan(identity?.plan),
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
            teacherId: typeof parsed.teacherId === "string" ? parsed.teacherId.trim() || undefined : undefined,
            email: typeof parsed.email === "string" ? parsed.email.trim() || undefined : undefined,
            displayName: typeof parsed.displayName === "string" ? parsed.displayName.trim() || undefined : undefined,
            organizationId: normalizeOrganizationId(parsed.organizationId),
            organizationName: typeof parsed.organizationName === "string" ? parsed.organizationName.trim() || undefined : undefined,
            memberRole: normalizeMemberRole(parsed.memberRole),
            plan: normalizePlan(parsed.plan),
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

export function saveTeacherSessionWithIdentity(
    token: string,
    identity: TeacherSessionIdentity | undefined,
    storage: TeacherSessionStorage | null = getBrowserSessionStorage(),
    now = Date.now(),
): boolean {
    if (!storage || !isTeacherToken(token)) return false;
    try {
        const session = createTeacherSession(token, now, identity);
        storage.setItem(TEACHER_SESSION_KEY, JSON.stringify(session));
        storage.setItem(LEGACY_TEACHER_TOKEN_KEY, token);
        return true;
    } catch {
        return false;
    }
}

export function saveTeacherSessionSnapshot(
    session: TeacherSession | null | undefined,
    storage: TeacherSessionStorage | null = getBrowserSessionStorage(),
    now = Date.now(),
): boolean {
    if (!storage || !isTeacherSessionActive(session, now)) return false;
    try {
        storage.setItem(TEACHER_SESSION_KEY, JSON.stringify(session));
        storage.setItem(LEGACY_TEACHER_TOKEN_KEY, session.token);
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

    const actorLabel = session?.displayName || session?.email || session?.teacherId || "교사";

    return {
        label: formatTeacherSessionRemaining(remainingMs),
        actorLabel,
        detail: session && !isExpired
            ? `${actorLabel} · 만료 시각 ${new Date(session.expiresAt).toLocaleString('ko-KR')}`
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
