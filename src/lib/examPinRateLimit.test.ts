import { describe, expect, it } from "vitest";
import {
    buildExamPinRateLimitKey,
    checkExamPinRateLimit,
    EXAM_PIN_IDENTITY_MAX_FAILURES,
    EXAM_PIN_IP_MAX_FAILURES,
    EXAM_PIN_WINDOW_MS,
    recordExamPinFailure,
    recordExamPinSuccess,
} from "./examPinRateLimit";
import { InMemoryAtomicCounterStore } from "./rateLimitStore";

function keys(examId = "e1", owner = "guest:g1", ip?: string) {
    return buildExamPinRateLimitKey(examId, owner, ip);
}

describe("examPinRateLimit", () => {
    it("derives distinct identity keys per (exam, owner) and an ip key only when ip is present", () => {
        const withIp = keys("e1", "guest:g1", "1.2.3.4");
        expect(withIp.identityKey).toMatch(/^exam-pin:id:/);
        expect(withIp.ipKey).toMatch(/^exam-pin:ip:/);
        expect(keys("e1", "guest:g2", "1.2.3.4").identityKey).not.toBe(withIp.identityKey);
        expect(keys("e1", "guest:g1").ipKey).toBeUndefined();
    });

    it("allows a fresh identity and blocks it once the identity budget is exhausted", async () => {
        const store = new InMemoryAtomicCounterStore();
        const k = keys();
        expect((await checkExamPinRateLimit(k, store, 0)).allowed).toBe(true);
        for (let i = 0; i < EXAM_PIN_IDENTITY_MAX_FAILURES; i++) {
            await recordExamPinFailure(k, store, 0);
        }
        const blocked = await checkExamPinRateLimit(k, store, 0);
        expect(blocked.allowed).toBe(false);
        expect(blocked.retryAfterMs).toBe(EXAM_PIN_WINDOW_MS);
    });

    it("self-heals after the rolling window (no fixed lockout)", async () => {
        const store = new InMemoryAtomicCounterStore();
        const k = keys();
        for (let i = 0; i < EXAM_PIN_IDENTITY_MAX_FAILURES; i++) await recordExamPinFailure(k, store, 0);
        expect((await checkExamPinRateLimit(k, store, 0)).allowed).toBe(false);
        // Once the window elapses the counter is gone — the student is not locked out.
        expect((await checkExamPinRateLimit(k, store, EXAM_PIN_WINDOW_MS + 1)).allowed).toBe(true);
    });

    it("a correct PIN clears the identity budget", async () => {
        const store = new InMemoryAtomicCounterStore();
        const k = keys();
        for (let i = 0; i < EXAM_PIN_IDENTITY_MAX_FAILURES; i++) await recordExamPinFailure(k, store, 0);
        await recordExamPinSuccess(k, store);
        expect((await checkExamPinRateLimit(k, store, 0)).allowed).toBe(true);
    });

    it("one student's misses never lock the exam for a different student (no whole-exam lockout)", async () => {
        const store = new InMemoryAtomicCounterStore();
        const victim = keys("e1", "guest:g1", "9.9.9.9");
        const other = keys("e1", "guest:g2", "8.8.8.8");
        for (let i = 0; i < EXAM_PIN_IDENTITY_MAX_FAILURES + 5; i++) await recordExamPinFailure(victim, store, 0);
        expect((await checkExamPinRateLimit(victim, store, 0)).allowed).toBe(false);
        expect((await checkExamPinRateLimit(other, store, 0)).allowed).toBe(true);
    });

    it("throttles a single sweeping ip even when it mints a fresh identity each request", async () => {
        const store = new InMemoryAtomicCounterStore();
        // Attacker rotates the owner id every request but the ip is stable.
        for (let i = 0; i < EXAM_PIN_IP_MAX_FAILURES; i++) {
            await recordExamPinFailure(keys("e1", `guest:sweep-${i}`, "6.6.6.6"), store, 0);
        }
        // A brand-new identity from the same ip is still blocked by the ip tier.
        const fresh = keys("e1", "guest:sweep-new", "6.6.6.6");
        expect((await checkExamPinRateLimit(fresh, store, 0)).allowed).toBe(false);
    });
});
