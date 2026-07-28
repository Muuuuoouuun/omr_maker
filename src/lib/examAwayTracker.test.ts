import { describe, expect, it } from "vitest";
import {
    EXAM_AWAY_THRESHOLD_MS,
    awaySeverity,
    beginAwaySession,
    finishAwaySession,
    flushAwaySession,
} from "./examAwayTracker";

describe("exam away tracker", () => {
    it("starts one away session and deduplicates later begin signals", () => {
        const first = beginAwaySession(null, 1_000);

        expect(first).toEqual({ startedAt: 1_000 });
        expect(beginAwaySession(first, 1_050)).toBe(first);
    });

    it("finishes an absent session without counting time away", () => {
        expect(finishAwaySession(null, 3_000)).toEqual({
            count: 0,
            durationMs: 0,
        });
    });

    it("clamps a clock rollback to zero duration", () => {
        expect(finishAwaySession({ startedAt: 3_000 }, 2_000)).toEqual({
            count: 0,
            durationMs: 0,
        });
    });

    it("drops an away session one millisecond shorter than two seconds", () => {
        expect(EXAM_AWAY_THRESHOLD_MS).toBe(2_000);
        expect(finishAwaySession({ startedAt: 1_000 }, 2_999)).toEqual({
            count: 0,
            durationMs: 1_999,
        });
    });

    it("counts a two-second away session exactly once", () => {
        expect(finishAwaySession({ startedAt: 1_000 }, 3_000)).toEqual({
            count: 1,
            durationMs: 2_000,
        });
    });

    it("flushes with the same threshold behavior as finishing", () => {
        expect(flushAwaySession).toBe(finishAwaySession);
        expect(flushAwaySession({ startedAt: 1_000 }, 3_500)).toEqual({
            count: 1,
            durationMs: 2_500,
        });
    });

    it("uses attention severity from the third recorded event", () => {
        expect(awaySeverity(0)).toBe("neutral");
        expect(awaySeverity(1)).toBe("neutral");
        expect(awaySeverity(2)).toBe("neutral");
        expect(awaySeverity(3)).toBe("attention");
    });
});
