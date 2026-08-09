import { isExactMockupTeacherIdentity } from "@/lib/mockupAccount";
import {
    purgeLegacyCanonicalSurfaceMarkers,
    removeCanonicalSurfaceCachesForIdentity,
    type CanonicalSurfaceCacheStorage,
} from "@/lib/canonicalSurfaceCache";

export const TEACHER_SESSION_KEY = "omr_teacher_session";
export const LEGACY_TEACHER_TOKEN_KEY = "omr_teacher_token";
export const TEACHER_SESSION_IDENTITY_CHANGED_EVENT = "omr:teacher-session-identity-changed";

export const TEACHER_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const TEACHER_SESSION_EXPIRING_SOON_MS = 30 * 60 * 1000;
const DEFAULT_TEACHER_REDIRECT = "/teacher/dashboard";
const LEGACY_ORGANIZATION_ID_PATTERN = /^(?:default|teacher_[a-z0-9]{7,16})$/;
const PILOT_ORGANIZATION_ID_PATTERN = /^pilot_org_[a-f0-9]{24}$/;

export type TeacherMemberRole = "owner" | "admin" | "teacher" | "assistant" | "viewer";
export type TeacherPlanCeiling = "free" | "pro" | "academy";
const TEACHER_WRITE_ROLES = new Set<TeacherMemberRole>(["owner", "admin", "teacher", "assistant"]);

export function canTeacherRoleWrite(role: TeacherMemberRole | null | undefined): boolean {
    return !!role && TEACHER_WRITE_ROLES.has(role);
}

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

function normalizeOrganizationId(value: unknown, authority?: TeacherSessionAuthority): string | undefined {
    const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (authority === "mockup") return normalized || undefined;
    const pattern = authority === "account" ? PILOT_ORGANIZATION_ID_PATTERN : LEGACY_ORGANIZATION_ID_PATTERN;
    return pattern.test(normalized) ? normalized : undefined;
}

export type TeacherSessionAuthority = "account" | "legacy_account" | "bootstrap" | "mockup";

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
    /**
     * Signed server-cookie authority. Account-backed sessions are checked
     * against the private database generation on every protected request.
     * Bootstrap covers explicitly configured deployment/demo identities.
     */
    sessionAuthority?: TeacherSessionAuthority;
    accountSessionGeneration?: number;
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
    sessionAuthority?: TeacherSessionAuthority;
    accountSessionGeneration?: number;
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
    try {
        if (typeof window === "undefined") return null;
        return window.sessionStorage;
    } catch {
        return null;
    }
}

function getBrowserCanonicalCacheStorage(): CanonicalSurfaceCacheStorage | null {
    try {
        if (typeof window === "undefined") return null;
        return window.localStorage;
    } catch {
        return null;
    }
}

function resolveCanonicalCacheStorage(
    storage: CanonicalSurfaceCacheStorage | null | undefined,
): CanonicalSurfaceCacheStorage | null {
    return storage === undefined ? getBrowserCanonicalCacheStorage() : storage;
}

function sessionCacheIdentity(session: TeacherSession | null | undefined) {
    if (!session?.organizationId
        || !session.teacherId
        || !Number.isSafeInteger(session.accountSessionGeneration)
        || (session.accountSessionGeneration || 0) < 1) return null;
    return {
        organizationId: session.organizationId,
        accountId: session.teacherId,
        sessionGeneration: session.accountSessionGeneration as number,
    };
}

function sameSessionCacheIdentity(left: TeacherSession | null, right: TeacherSession | null): boolean {
    const leftIdentity = sessionCacheIdentity(left);
    const rightIdentity = sessionCacheIdentity(right);
    return !!leftIdentity
        && !!rightIdentity
        && leftIdentity.organizationId === rightIdentity.organizationId
        && leftIdentity.accountId === rightIdentity.accountId
        && leftIdentity.sessionGeneration === rightIdentity.sessionGeneration;
}

function sameSessionIdentity(left: TeacherSession | null, right: TeacherSession | null): boolean {
    if (!left || !right) return left === right;
    return left.organizationId === right.organizationId
        && left.teacherId === right.teacherId
        && left.accountSessionGeneration === right.accountSessionGeneration
        && left.sessionAuthority === right.sessionAuthority;
}

function notifyTeacherSessionIdentityChanged(
    previous: TeacherSession | null,
    current: TeacherSession | null,
): void {
    if (sameSessionIdentity(previous, current)) return;
    try {
        if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
        window.dispatchEvent(new Event(TEACHER_SESSION_IDENTITY_CHANGED_EVENT));
    } catch {
        // Session persistence remains authoritative when the browser event seam
        // is unavailable or a host-provided event target throws.
    }
}

function readStoredSessionForCacheCleanup(storage: TeacherSessionStorage): TeacherSession | null {
    try {
        return parseTeacherSession(storage.getItem(TEACHER_SESSION_KEY), Number.NEGATIVE_INFINITY);
    } catch {
        return null;
    }
}

function purgeReplacedSessionCache(
    previous: TeacherSession | null,
    next: TeacherSession | null,
    storage: CanonicalSurfaceCacheStorage | null,
): void {
    if (!storage) return;
    purgeLegacyCanonicalSurfaceMarkers(storage);
    const previousIdentity = sessionCacheIdentity(previous);
    if (previousIdentity && !sameSessionCacheIdentity(previous, next)) {
        removeCanonicalSurfaceCachesForIdentity(storage, previousIdentity);
    }
}

export function isTeacherToken(token: unknown): token is string {
    return typeof token === "string" && /^tkn_[a-z0-9]+_[a-f0-9]{32}$/i.test(token.trim());
}

export function createTeacherSession(token: string, now = Date.now(), identity?: TeacherSessionIdentity): TeacherSession {
    const accountSessionGeneration = Number.isSafeInteger(identity?.accountSessionGeneration)
        && (identity?.accountSessionGeneration || 0) >= 1
        ? identity?.accountSessionGeneration
        : undefined;
    const sessionAuthority: TeacherSessionAuthority = identity?.sessionAuthority
        || (accountSessionGeneration ? "legacy_account" : "bootstrap");
    return {
        schemaVersion: 1,
        role: "teacher",
        token,
        teacherId: identity?.teacherId?.trim() || undefined,
        email: identity?.email?.trim() || undefined,
        displayName: identity?.displayName?.trim() || undefined,
        organizationId: normalizeOrganizationId(identity?.organizationId, sessionAuthority),
        organizationName: identity?.organizationName?.trim() || undefined,
        memberRole: normalizeMemberRole(identity?.memberRole),
        plan: normalizePlan(identity?.plan),
        sessionAuthority,
        accountSessionGeneration,
        issuedAt: now,
        expiresAt: now + TEACHER_SESSION_TTL_MS,
    };
}

export function isTeacherSessionActive(session: TeacherSession | null | undefined, now = Date.now()): session is TeacherSession {
    const baseActive = !!session
        && session.schemaVersion === 1
        && session.role === "teacher"
        && isTeacherToken(session.token)
        && Number.isFinite(session.expiresAt)
        && session.expiresAt > now;
    if (!baseActive) return false;
    if (session.sessionAuthority === "account") {
        return /^teacher_[a-f0-9]{16}$/.test(session.teacherId || "")
            && PILOT_ORGANIZATION_ID_PATTERN.test(session.organizationId || "")
            && !!session.organizationName?.trim()
            && session.memberRole === "owner"
            && !!session.plan
            && Number.isSafeInteger(session.accountSessionGeneration)
            && (session.accountSessionGeneration || 0) >= 1;
    }
    if (session.sessionAuthority === "mockup") return isExactMockupTeacherIdentity(session);
    return session.sessionAuthority === "legacy_account" || session.sessionAuthority === "bootstrap";
}

export function parseTeacherSession(raw: string | null | undefined, now = Date.now()): TeacherSession | null {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as Partial<TeacherSession>;
        const sessionAuthority = parsed.sessionAuthority === "account"
            || parsed.sessionAuthority === "legacy_account"
            || parsed.sessionAuthority === "bootstrap"
            || parsed.sessionAuthority === "mockup"
            ? parsed.sessionAuthority
            : undefined;
        if (sessionAuthority === "mockup" && !isExactMockupTeacherIdentity(parsed)) return null;
        const session: TeacherSession = {
            schemaVersion: parsed.schemaVersion === 1 ? 1 : 1,
            role: "teacher",
            token: typeof parsed.token === "string" ? parsed.token : "",
            teacherId: typeof parsed.teacherId === "string" ? parsed.teacherId.trim() || undefined : undefined,
            email: typeof parsed.email === "string" ? parsed.email.trim() || undefined : undefined,
            displayName: typeof parsed.displayName === "string" ? parsed.displayName.trim() || undefined : undefined,
            organizationId: normalizeOrganizationId(parsed.organizationId, sessionAuthority),
            organizationName: typeof parsed.organizationName === "string" ? parsed.organizationName.trim() || undefined : undefined,
            memberRole: normalizeMemberRole(parsed.memberRole),
            plan: normalizePlan(parsed.plan),
            sessionAuthority,
            accountSessionGeneration: Number.isSafeInteger(parsed.accountSessionGeneration)
                && (parsed.accountSessionGeneration || 0) >= 1
                ? parsed.accountSessionGeneration
                : undefined,
            issuedAt: typeof parsed.issuedAt === "number" ? parsed.issuedAt : 0,
            expiresAt: typeof parsed.expiresAt === "number" ? parsed.expiresAt : 0,
        };
        return isTeacherSessionActive(session, now) ? session : null;
    } catch {
        return null;
    }
}

export function readTeacherSession(
    storage: TeacherSessionStorage | null = getBrowserSessionStorage(),
    now = Date.now(),
    cacheStorage?: CanonicalSurfaceCacheStorage | null,
): TeacherSession | null {
    if (!storage) return null;
    const resolvedCacheStorage = resolveCanonicalCacheStorage(cacheStorage);
    try {
        const rawSession = storage.getItem(TEACHER_SESSION_KEY);
        if (rawSession) {
            const session = parseTeacherSession(rawSession, now);
            if (session) {
                if (resolvedCacheStorage) purgeLegacyCanonicalSurfaceMarkers(resolvedCacheStorage);
                return session;
            }
            clearTeacherSession(storage, resolvedCacheStorage);
            return null;
        }

        const legacyToken = storage.getItem(LEGACY_TEACHER_TOKEN_KEY);
        if (!isTeacherToken(legacyToken)) return null;
        const migratedSession = createTeacherSession(legacyToken, now);
        storage.setItem(TEACHER_SESSION_KEY, JSON.stringify(migratedSession));
        if (resolvedCacheStorage) purgeLegacyCanonicalSurfaceMarkers(resolvedCacheStorage);
        return migratedSession;
    } catch {
        return null;
    }
}

export function hasTeacherSession(storage: TeacherSessionStorage | null = getBrowserSessionStorage(), now = Date.now()): boolean {
    return !!readTeacherSession(storage, now);
}

export function saveTeacherSession(
    token: string,
    storage: TeacherSessionStorage | null = getBrowserSessionStorage(),
    now = Date.now(),
    cacheStorage?: CanonicalSurfaceCacheStorage | null,
): boolean {
    if (!storage || !isTeacherToken(token)) return false;
    const previous = readStoredSessionForCacheCleanup(storage);
    try {
        const session = createTeacherSession(token, now);
        purgeReplacedSessionCache(previous, session, resolveCanonicalCacheStorage(cacheStorage));
        storage.setItem(TEACHER_SESSION_KEY, JSON.stringify(session));
        storage.setItem(LEGACY_TEACHER_TOKEN_KEY, token);
        return true;
    } catch {
        return false;
    } finally {
        notifyTeacherSessionIdentityChanged(previous, readStoredSessionForCacheCleanup(storage));
    }
}

export function saveTeacherSessionWithIdentity(
    token: string,
    identity: TeacherSessionIdentity | undefined,
    storage: TeacherSessionStorage | null = getBrowserSessionStorage(),
    now = Date.now(),
    cacheStorage?: CanonicalSurfaceCacheStorage | null,
): boolean {
    if (!storage || !isTeacherToken(token)) return false;
    const previous = readStoredSessionForCacheCleanup(storage);
    try {
        const session = createTeacherSession(token, now, identity);
        purgeReplacedSessionCache(previous, session, resolveCanonicalCacheStorage(cacheStorage));
        storage.setItem(TEACHER_SESSION_KEY, JSON.stringify(session));
        storage.setItem(LEGACY_TEACHER_TOKEN_KEY, token);
        return true;
    } catch {
        return false;
    } finally {
        notifyTeacherSessionIdentityChanged(previous, readStoredSessionForCacheCleanup(storage));
    }
}

export function saveTeacherSessionSnapshot(
    session: TeacherSession | null | undefined,
    storage: TeacherSessionStorage | null = getBrowserSessionStorage(),
    now = Date.now(),
    cacheStorage?: CanonicalSurfaceCacheStorage | null,
): boolean {
    if (!storage || !isTeacherSessionActive(session, now)) return false;
    const previous = readStoredSessionForCacheCleanup(storage);
    try {
        purgeReplacedSessionCache(previous, session, resolveCanonicalCacheStorage(cacheStorage));
        storage.setItem(TEACHER_SESSION_KEY, JSON.stringify(session));
        storage.setItem(LEGACY_TEACHER_TOKEN_KEY, session.token);
        return true;
    } catch {
        return false;
    } finally {
        notifyTeacherSessionIdentityChanged(previous, readStoredSessionForCacheCleanup(storage));
    }
}

export function clearTeacherSession(
    storage: TeacherSessionStorage | null = getBrowserSessionStorage(),
    cacheStorage?: CanonicalSurfaceCacheStorage | null,
): void {
    const resolvedCacheStorage = resolveCanonicalCacheStorage(cacheStorage);
    const previous = storage ? readStoredSessionForCacheCleanup(storage) : null;
    if (storage) {
        for (const key of [TEACHER_SESSION_KEY, LEGACY_TEACHER_TOKEN_KEY]) {
            try {
                storage.removeItem(key);
            } catch {
                // Keep attempting the other exact session key.
            }
        }
    }
    try {
        purgeReplacedSessionCache(previous, null, resolvedCacheStorage);
    } finally {
        notifyTeacherSessionIdentityChanged(
            previous,
            storage ? readStoredSessionForCacheCleanup(storage) : null,
        );
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
