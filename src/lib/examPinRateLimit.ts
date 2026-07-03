import { createHash } from "node:crypto";

/**
 * Server-side brute-force guard for exam PINs. The PIN check itself is
 * stateless (threaded per request), so without this an attacker could sweep a
 * 4-digit space in minutes. Mirrors teacherLoginRateLimit: in-process store,
 * injectable for tests. Same serverless caveat applies — per-instance memory,
 * reset on cold start; still removes the trivial single-origin sweep.
 */

export const EXAM_PIN_MAX_FAILURES = 5;
export const EXAM_PIN_WINDOW_MS = 5 * 60 * 1000;
export const EXAM_PIN_LOCKOUT_MS = 5 * 60 * 1000;

/**
 * Identity-independent ceiling per exam. A guest can mint a fresh guestId per
 * request (issueGuestSession) and reset its per-identity budget, so a
 * per-identity limit alone lets a script sweep the PIN space. This global
 * per-exam counter caps total wrong PINs regardless of identity. It is set far
 * above a real class's fat-finger volume (a 30-student class rarely exceeds a
 * handful of misses each) but well below a brute-force sweep (thousands).
 *
 * Caveat (tracked for B/C): this is in-process memory — per serverless instance
 * and reset on cold start. It removes the trivial single-origin sweep; a
 * durable cross-instance counter (Redis/DB) is the real fix.
 */
export const EXAM_PIN_GLOBAL_MAX_FAILURES = 60;
export const EXAM_PIN_GLOBAL_WINDOW_MS = 10 * 60 * 1000;
export const EXAM_PIN_GLOBAL_LOCKOUT_MS = 10 * 60 * 1000;

export interface ExamPinRateLimitState {
    failedCount: number;
    firstFailedAt: number;
    lockedUntil?: number;
}

export interface ExamPinRateLimitStatus {
    allowed: boolean;
    retryAfterMs: number;
}

export type ExamPinRateLimitStore = Map<string, ExamPinRateLimitState>;

const defaultExamPinRateLimitStore: ExamPinRateLimitStore = new Map();

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function hashPart(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
}

interface RateTier {
    windowMs: number;
    maxFailures: number;
    lockoutMs: number;
}

const PER_IDENTITY_TIER: RateTier = {
    windowMs: EXAM_PIN_WINDOW_MS,
    maxFailures: EXAM_PIN_MAX_FAILURES,
    lockoutMs: EXAM_PIN_LOCKOUT_MS,
};
const GLOBAL_TIER: RateTier = {
    windowMs: EXAM_PIN_GLOBAL_WINDOW_MS,
    maxFailures: EXAM_PIN_GLOBAL_MAX_FAILURES,
    lockoutMs: EXAM_PIN_GLOBAL_LOCKOUT_MS,
};

function stateWithin(key: string, store: ExamPinRateLimitStore, windowMs: number, now: number): ExamPinRateLimitState | null {
    const state = store.get(key);
    if (!state) return null;
    if (state.lockedUntil && state.lockedUntil > now) return state;
    if (now - state.firstFailedAt >= windowMs) {
        store.delete(key);
        return null;
    }
    return state;
}

/**
 * Two rate-limit keys per PIN check:
 * - identity key: (exam, requesting identity) — so one student's misses cannot
 *   lock the exam for the whole class.
 * - global key: (exam) — an identity-independent ceiling a fresh guest cookie
 *   cannot reset, blocking scripted brute-force sweeps.
 */
export function buildExamPinRateLimitKey(examId: unknown, ownerId: unknown): { identityKey: string; globalKey: string } {
    const exam = clean(examId).toLowerCase() || "blank-exam";
    const owner = clean(ownerId).toLowerCase() || "unknown-owner";
    return {
        identityKey: `exam-pin:id:${hashPart(`${exam}:${owner}`)}`,
        globalKey: `exam-pin:exam:${hashPart(exam)}`,
    };
}

export function checkExamPinRateLimit(
    keys: { identityKey: string; globalKey: string },
    store: ExamPinRateLimitStore = defaultExamPinRateLimitStore,
    now = Date.now(),
): ExamPinRateLimitStatus {
    for (const [key, tier] of [[keys.identityKey, PER_IDENTITY_TIER], [keys.globalKey, GLOBAL_TIER]] as const) {
        const state = stateWithin(key, store, tier.windowMs, now);
        if (state?.lockedUntil && state.lockedUntil > now) {
            return { allowed: false, retryAfterMs: state.lockedUntil - now };
        }
    }
    return { allowed: true, retryAfterMs: 0 };
}

function recordFailure(key: string, tier: RateTier, store: ExamPinRateLimitStore, now: number): void {
    const current = stateWithin(key, store, tier.windowMs, now);
    const nextCount = (current?.failedCount || 0) + 1;
    store.set(key, {
        failedCount: nextCount,
        firstFailedAt: current?.firstFailedAt || now,
        lockedUntil: nextCount >= tier.maxFailures ? now + tier.lockoutMs : undefined,
    });
}

export function recordExamPinFailure(
    keys: { identityKey: string; globalKey: string },
    store: ExamPinRateLimitStore = defaultExamPinRateLimitStore,
    now = Date.now(),
): void {
    recordFailure(keys.identityKey, PER_IDENTITY_TIER, store, now);
    recordFailure(keys.globalKey, GLOBAL_TIER, store, now);
}

/** Success clears only the identity budget; the global sweep counter persists. */
export function recordExamPinSuccess(
    keys: { identityKey: string; globalKey: string },
    store: ExamPinRateLimitStore = defaultExamPinRateLimitStore,
): void {
    store.delete(keys.identityKey);
}
