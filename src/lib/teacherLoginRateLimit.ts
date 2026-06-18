import { createHash } from "node:crypto";

export const TEACHER_LOGIN_RATE_LIMIT_ERROR = "로그인 시도가 많습니다. 잠시 후 다시 시도해주세요.";
export const TEACHER_LOGIN_MAX_FAILURES = 5;
export const TEACHER_LOGIN_WINDOW_MS = 10 * 60 * 1000;
export const TEACHER_LOGIN_LOCKOUT_MS = 10 * 60 * 1000;

export interface TeacherLoginRateLimitState {
    failedCount: number;
    firstFailedAt: number;
    lockedUntil?: number;
}

export interface TeacherLoginRateLimitStatus {
    allowed: boolean;
    retryAfterMs: number;
}

export type TeacherLoginRateLimitStore = Map<string, TeacherLoginRateLimitState>;

const defaultTeacherLoginRateLimitStore: TeacherLoginRateLimitStore = new Map();

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function normalizePart(value: unknown, fallback: string): string {
    return clean(value).toLowerCase() || fallback;
}

function hashPart(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
}

function activeState(
    key: string,
    store: TeacherLoginRateLimitStore,
    now: number,
): TeacherLoginRateLimitState | null {
    const state = store.get(key);
    if (!state) return null;
    if (state.lockedUntil && state.lockedUntil > now) return state;
    if (now - state.firstFailedAt >= TEACHER_LOGIN_WINDOW_MS) {
        store.delete(key);
        return null;
    }
    return state;
}

export function buildTeacherLoginRateLimitKeys(
    identifier: unknown,
    clientFingerprint: unknown,
): string[] {
    const normalizedIdentifier = normalizePart(identifier, "blank-identifier");
    const normalizedClient = normalizePart(clientFingerprint, "unknown-client");

    return [
        `teacher-login:identifier-client:${hashPart(`${normalizedIdentifier}:${normalizedClient}`)}`,
        `teacher-login:client:${hashPart(normalizedClient)}`,
    ];
}

export function checkTeacherLoginRateLimit(
    keys: string[],
    store: TeacherLoginRateLimitStore = defaultTeacherLoginRateLimitStore,
    now = Date.now(),
): TeacherLoginRateLimitStatus {
    for (const key of keys) {
        const state = activeState(key, store, now);
        if (state?.lockedUntil && state.lockedUntil > now) {
            return {
                allowed: false,
                retryAfterMs: state.lockedUntil - now,
            };
        }
    }

    return { allowed: true, retryAfterMs: 0 };
}

export function recordTeacherLoginFailure(
    keys: string[],
    store: TeacherLoginRateLimitStore = defaultTeacherLoginRateLimitStore,
    now = Date.now(),
): void {
    for (const key of keys) {
        const current = activeState(key, store, now);
        const nextCount = (current?.failedCount || 0) + 1;
        store.set(key, {
            failedCount: nextCount,
            firstFailedAt: current?.firstFailedAt || now,
            lockedUntil: nextCount >= TEACHER_LOGIN_MAX_FAILURES ? now + TEACHER_LOGIN_LOCKOUT_MS : undefined,
        });
    }
}

export function recordTeacherLoginSuccess(
    keys: string[],
    store: TeacherLoginRateLimitStore = defaultTeacherLoginRateLimitStore,
): void {
    for (const key of keys) {
        store.delete(key);
    }
}
