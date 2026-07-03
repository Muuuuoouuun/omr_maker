import { describe, expect, it } from "vitest";
import {
    buildExamPinRateLimitKey,
    checkExamPinRateLimit,
    recordExamPinFailure,
    recordExamPinSuccess,
    EXAM_PIN_GLOBAL_MAX_FAILURES,
    EXAM_PIN_LOCKOUT_MS,
    EXAM_PIN_MAX_FAILURES,
    EXAM_PIN_WINDOW_MS,
    type ExamPinRateLimitStore,
} from "./examPinRateLimit";

const T0 = 1_700_000_000_000;

describe("examPinRateLimit", () => {
    it("scopes the identity key to exam + owner and the global key to exam only", () => {
        const a = buildExamPinRateLimitKey("exam-1", "guest:g1");
        const b = buildExamPinRateLimitKey("exam-1", "guest:g2");
        const c = buildExamPinRateLimitKey("exam-2", "guest:g1");
        expect(a.identityKey).not.toBe(b.identityKey);
        expect(a.globalKey).toBe(b.globalKey);          // same exam → shared global counter
        expect(a.globalKey).not.toBe(c.globalKey);      // different exam → different global
        expect(buildExamPinRateLimitKey("exam-1", "GUEST:G1").identityKey).toBe(a.identityKey);
    });

    it("allows attempts below the per-identity threshold", () => {
        const store: ExamPinRateLimitStore = new Map();
        const keys = buildExamPinRateLimitKey("e1", "s1");
        for (let i = 0; i < EXAM_PIN_MAX_FAILURES - 1; i++) recordExamPinFailure(keys, store, T0 + i);
        expect(checkExamPinRateLimit(keys, store, T0 + 100)).toEqual({ allowed: true, retryAfterMs: 0 });
    });

    it("locks out one identity after max failures", () => {
        const store: ExamPinRateLimitStore = new Map();
        const keys = buildExamPinRateLimitKey("e1", "s1");
        for (let i = 0; i < EXAM_PIN_MAX_FAILURES; i++) recordExamPinFailure(keys, store, T0);
        const status = checkExamPinRateLimit(keys, store, T0 + 1000);
        expect(status.allowed).toBe(false);
        expect(status.retryAfterMs).toBe(EXAM_PIN_LOCKOUT_MS - 1000);
    });

    it("blocks a rotating-identity sweep via the global per-exam ceiling", () => {
        const store: ExamPinRateLimitStore = new Map();
        // Each request uses a fresh guest identity, so the per-identity limit
        // never trips — but the shared global counter does.
        for (let i = 0; i < EXAM_PIN_GLOBAL_MAX_FAILURES; i++) {
            const keys = buildExamPinRateLimitKey("e1", `guest:rotating-${i}`);
            expect(checkExamPinRateLimit(keys, store, T0).allowed).toBe(true);
            recordExamPinFailure(keys, store, T0);
        }
        // Next fresh identity is blocked by the global ceiling.
        const fresh = buildExamPinRateLimitKey("e1", "guest:rotating-next");
        expect(checkExamPinRateLimit(fresh, store, T0 + 1000).allowed).toBe(false);
        // A different exam is unaffected.
        expect(checkExamPinRateLimit(buildExamPinRateLimitKey("e2", "guest:x"), store, T0 + 1000).allowed).toBe(true);
    });

    it("success clears the identity budget but not the global sweep counter", () => {
        const store: ExamPinRateLimitStore = new Map();
        const keys = buildExamPinRateLimitKey("e1", "s1");
        recordExamPinFailure(keys, store, T0);
        recordExamPinSuccess(keys, store);
        expect(store.has(keys.identityKey)).toBe(false);
        expect(store.has(keys.globalKey)).toBe(true);
    });

    it("forgets stale per-identity failures outside the window", () => {
        const store: ExamPinRateLimitStore = new Map();
        const keys = buildExamPinRateLimitKey("e1", "s1");
        recordExamPinFailure(keys, store, T0);
        recordExamPinFailure(keys, store, T0 + EXAM_PIN_WINDOW_MS + 1);
        expect(store.get(keys.identityKey)?.failedCount).toBe(1);
    });
});
