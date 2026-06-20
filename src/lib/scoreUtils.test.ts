import { describe, expect, it } from "vitest";
import type { Attempt } from "@/types/omr";
import { averageAttemptPercent, safeRatePercent, safeScorePercent } from "./scoreUtils";

function attempt(score: number, totalScore: number): Attempt {
    return {
        id: `${score}-${totalScore}`,
        examId: "exam",
        examTitle: "시험",
        studentName: "학생",
        startedAt: "2026-06-15T10:00:00.000Z",
        finishedAt: "2026-06-15T10:10:00.000Z",
        score,
        totalScore,
        answers: {},
        status: "completed",
    };
}

describe("score utils", () => {
    it("returns rounded score percentages for valid scores", () => {
        expect(safeScorePercent(8, 12)).toBe(67);
        expect(safeScorePercent(10, 10)).toBe(100);
    });

    it("protects charts from invalid totals and non-finite values", () => {
        expect(safeScorePercent(5, 0)).toBe(0);
        expect(safeScorePercent(Number.NaN, 10)).toBe(0);
        expect(safeScorePercent(5, Number.POSITIVE_INFINITY)).toBe(0);
    });

    it("clamps score percentages into the chartable 0-100 range", () => {
        expect(safeScorePercent(15, 10)).toBe(100);
        expect(safeScorePercent(-2, 10)).toBe(0);
    });

    it("averages attempts using safe percentages", () => {
        expect(averageAttemptPercent([
            attempt(8, 10),
            attempt(0, 0),
            attempt(5, 10),
        ])).toBe(43);
    });

    it("returns safe general rates", () => {
        expect(safeRatePercent(2, 3)).toBe(67);
        expect(safeRatePercent(2, 0)).toBe(0);
        expect(safeRatePercent(5, 3)).toBe(100);
        expect(safeRatePercent(-1, 3)).toBe(0);
    });
});
