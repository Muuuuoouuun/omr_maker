import { describe, expect, it } from "vitest";
import { recentScoreTrend } from "./recentScoreTrend";

const attempt = (id: string, finishedAt: string, score: number) => ({ id, finishedAt, score });
const score = (a: { score: number }) => a.score;

describe("recentScoreTrend", () => {
    it("returns the latest three scores ordered oldest → newest", () => {
        const attempts = [
            attempt("d", "2026-09-04T00:00:00Z", 90),
            attempt("a", "2026-09-01T00:00:00Z", 40),
            attempt("c", "2026-09-03T00:00:00Z", 70),
            attempt("b", "2026-09-02T00:00:00Z", 55),
        ];
        expect(recentScoreTrend(attempts, score)).toEqual([55, 70, 90]);
    });

    it("rounds percents and handles fewer attempts than the window", () => {
        expect(recentScoreTrend([
            attempt("b", "2026-09-02T00:00:00Z", 66.6),
            attempt("a", "2026-09-01T00:00:00Z", 33.4),
        ], score)).toEqual([33, 67]);
        expect(recentScoreTrend([], score)).toEqual([]);
    });

    it("treats unparseable finish times as oldest and orders ties deterministically", () => {
        const attempts = [
            attempt("bad", "not-a-date", 10),
            attempt("x", "2026-09-01T00:00:00Z", 20),
            attempt("y", "2026-09-01T00:00:00Z", 30),
        ];
        expect(recentScoreTrend(attempts, score, 2)).toEqual([30, 20]);
        expect(recentScoreTrend(attempts, score)).toEqual([10, 30, 20]);
    });

    it("does not mutate the input", () => {
        const attempts = [attempt("b", "2026-09-02T00:00:00Z", 2), attempt("a", "2026-09-01T00:00:00Z", 1)];
        const copy = [...attempts];
        recentScoreTrend(attempts, score);
        expect(attempts).toEqual(copy);
    });
});
