import { createHash } from "node:crypto";
import {
    defaultAtomicCounterStore,
    type AtomicCounterStore,
} from "@/lib/rateLimitStore";

/**
 * Server-side brute-force guard for exam PINs. The PIN check itself is stateless
 * (threaded per request), so without a counter an attacker could sweep a 4-digit
 * space in minutes.
 *
 * This is a rolling-window counter over a shared atomic store — NOT a fixed
 * lockout. The previous design kept a whole-exam lockout: once ~60 wrong PINs
 * accumulated, the exam's PIN gate slammed shut for EVERY student for a fixed
 * period. That is a trivial denial-of-service against a whole class (one attacker
 * locks everyone out). We remove it. Instead we throttle two independent keys that
 * self-heal as their window rolls forward:
 *
 * - identity key (exam, requesting owner): one student's fat-fingering only ever
 *   throttles that student.
 * - ip key (exam, client ip): the identity-independent signal a fresh guest cookie
 *   cannot reset, which is what actually stops a scripted single-origin sweep.
 *
 * A classroom behind one NAT shares an ip, so the ip budget is set well above a
 * class's realistic miss volume but far below a brute-force sweep.
 */

export const EXAM_PIN_WINDOW_MS = 5 * 60 * 1000;
export const EXAM_PIN_IDENTITY_MAX_FAILURES = 5;
export const EXAM_PIN_IP_MAX_FAILURES = 30;

export interface ExamPinRateLimitKeys {
    identityKey: string;
    ipKey?: string;
}

export interface ExamPinRateLimitStatus {
    allowed: boolean;
    retryAfterMs: number;
}

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function hashPart(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Build the rate-limit keys for one PIN check. The ip key is omitted when no
 * client ip is available (e.g. tests, or a runtime that does not expose it) — the
 * identity budget still applies.
 */
export function buildExamPinRateLimitKey(
    examId: unknown,
    ownerId: unknown,
    clientIp?: unknown,
): ExamPinRateLimitKeys {
    const exam = clean(examId).toLowerCase() || "blank-exam";
    const owner = clean(ownerId).toLowerCase() || "unknown-owner";
    const ip = clean(clientIp).toLowerCase();
    return {
        identityKey: `exam-pin:id:${hashPart(`${exam}:${owner}`)}`,
        ...(ip ? { ipKey: `exam-pin:ip:${hashPart(`${exam}:${ip}`)}` } : {}),
    };
}

interface Tier {
    key: string;
    max: number;
}

function tiersFor(keys: ExamPinRateLimitKeys): Tier[] {
    const tiers: Tier[] = [{ key: keys.identityKey, max: EXAM_PIN_IDENTITY_MAX_FAILURES }];
    if (keys.ipKey) tiers.push({ key: keys.ipKey, max: EXAM_PIN_IP_MAX_FAILURES });
    return tiers;
}

/**
 * Gate check run BEFORE verifying the submitted PIN. Reads the current windows;
 * blocks while any tier is at/over its max, and reports how long until that
 * window rolls over (self-healing — no fixed lockout duration).
 */
export async function checkExamPinRateLimit(
    keys: ExamPinRateLimitKeys,
    store: AtomicCounterStore = defaultAtomicCounterStore,
    now = Date.now(),
): Promise<ExamPinRateLimitStatus> {
    let retryAfterMs = 0;
    for (const tier of tiersFor(keys)) {
        const state = await store.peek(tier.key, EXAM_PIN_WINDOW_MS, now);
        if (state && state.count >= tier.max) {
            retryAfterMs = Math.max(retryAfterMs, EXAM_PIN_WINDOW_MS - (now - state.firstAt));
        }
    }
    return { allowed: retryAfterMs <= 0, retryAfterMs };
}

/** Atomically record one wrong PIN against every active tier. */
export async function recordExamPinFailure(
    keys: ExamPinRateLimitKeys,
    store: AtomicCounterStore = defaultAtomicCounterStore,
    now = Date.now(),
): Promise<void> {
    for (const tier of tiersFor(keys)) {
        await store.increment(tier.key, EXAM_PIN_WINDOW_MS, now);
    }
}

/**
 * A correct PIN clears the identity budget so a student who mistyped then
 * corrected is not throttled. The ip counter is intentionally left in place: a
 * sweeping origin that occasionally guesses right must still burn down its ip
 * budget.
 */
export async function recordExamPinSuccess(
    keys: ExamPinRateLimitKeys,
    store: AtomicCounterStore = defaultAtomicCounterStore,
): Promise<void> {
    await store.reset(keys.identityKey);
}
