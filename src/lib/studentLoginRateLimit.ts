import { createHash } from "node:crypto";

export const STUDENT_LOGIN_RATE_LIMIT_ERROR = "학생 로그인 시도가 많습니다. 10분 후 다시 시도해주세요.";
export const STUDENT_LOGIN_MAX_FAILURES = 5;
export const STUDENT_LOGIN_WINDOW_MS = 10 * 60 * 1000;
export const STUDENT_LOGIN_LOCKOUT_MS = 10 * 60 * 1000;

export interface StudentLoginRateLimitState {
    failedCount: number;
    firstFailedAt: number;
    lockedUntil?: number;
}

export type StudentLoginRateLimitStore = Map<string, StudentLoginRateLimitState>;

const defaultStore: StudentLoginRateLimitStore = new Map();

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function hash(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
}

function activeState(key: string, store: StudentLoginRateLimitStore, now: number): StudentLoginRateLimitState | null {
    const state = store.get(key);
    if (!state) return null;
    if (state.lockedUntil && state.lockedUntil > now) return state;
    if (now - state.firstFailedAt >= STUDENT_LOGIN_WINDOW_MS) {
        store.delete(key);
        return null;
    }
    return state;
}

export function buildStudentLoginRateLimitKeys(params: {
    workspaceId: unknown;
    studentLookup: unknown;
    clientFingerprint: unknown;
}): string[] {
    const workspace = clean(params.workspaceId) || "unknown-workspace";
    const lookup = clean(params.studentLookup) || "blank-lookup";
    const client = clean(params.clientFingerprint) || "unknown-client";
    return [
        `student-login:identity-client:${hash(`${workspace}:${lookup}:${client}`)}`,
        `student-login:client:${hash(`${workspace}:${client}`)}`,
    ];
}

export function checkStudentLoginRateLimit(
    keys: string[],
    store: StudentLoginRateLimitStore = defaultStore,
    now = Date.now(),
): { allowed: boolean; retryAfterMs: number } {
    for (const key of keys) {
        const state = activeState(key, store, now);
        if (state?.lockedUntil && state.lockedUntil > now) {
            return { allowed: false, retryAfterMs: state.lockedUntil - now };
        }
    }
    return { allowed: true, retryAfterMs: 0 };
}

export function recordStudentLoginFailure(
    keys: string[],
    store: StudentLoginRateLimitStore = defaultStore,
    now = Date.now(),
): void {
    for (const key of keys) {
        const current = activeState(key, store, now);
        const failedCount = (current?.failedCount || 0) + 1;
        store.set(key, {
            failedCount,
            firstFailedAt: current?.firstFailedAt || now,
            lockedUntil: failedCount >= STUDENT_LOGIN_MAX_FAILURES ? now + STUDENT_LOGIN_LOCKOUT_MS : undefined,
        });
    }
}

export function recordStudentLoginSuccess(
    keys: string[],
    store: StudentLoginRateLimitStore = defaultStore,
): void {
    for (const key of keys) store.delete(key);
}
