import { describe, expect, it } from "vitest";
import {
    buildScoreBuckets,
    computeGroupScoreSummary,
    computeMedian,
    computePassRate,
    computePointBiserialCorrelation,
    computeRankPercentile,
    computeScoreDistribution,
    computeStandardDeviation,
} from "./scoreDistribution";

describe("score distribution math", () => {
    it("computes median for odd and even counts", () => {
        expect(computeMedian([10, 90, 50])).toBe(50);
        expect(computeMedian([10, 20, 30, 40])).toBe(25);
        expect(computeMedian([])).toBe(0);
    });

    it("computes population standard deviation rounded to one decimal", () => {
        // mean 50, deviations ±10 → variance 100 → sd 10
        expect(computeStandardDeviation([40, 60, 40, 60])).toBe(10);
        expect(computeStandardDeviation([70])).toBe(0);
        expect(computeStandardDeviation([])).toBe(0);
    });

    it("computes pass rate against the threshold", () => {
        expect(computePassRate([50, 60, 70, 80])).toBe(75);
        expect(computePassRate([10, 20], 60)).toBe(0);
        expect(computePassRate([90, 95], 90)).toBe(100);
        expect(computePassRate([])).toBe(0);
    });

    it("buckets scores 0-10…90-100 and puts 100 in the last bucket", () => {
        const buckets = buildScoreBuckets([0, 5, 10, 55, 90, 100]);
        expect(buckets).toHaveLength(10);
        expect(buckets[0]).toMatchObject({ label: "0-10", count: 2 }); // 0, 5
        expect(buckets[1]).toMatchObject({ label: "10-20", count: 1 }); // 10
        expect(buckets[5]).toMatchObject({ label: "50-60", count: 1 }); // 55
        expect(buckets[9]).toMatchObject({ label: "90-100", count: 2 }); // 90, 100
    });

    it("clamps out-of-range scores into the edge buckets", () => {
        const buckets = buildScoreBuckets([-20, 130]);
        expect(buckets[0].count).toBe(1);
        expect(buckets[9].count).toBe(1);
    });

    it("summarizes a full distribution", () => {
        const summary = computeScoreDistribution([40, 60, 40, 60]);
        expect(summary).toMatchObject({
            count: 4,
            mean: 50,
            median: 50,
            standardDeviation: 10,
            min: 40,
            max: 60,
        });
        expect(summary.buckets[4].count).toBe(2); // 40-50 holds the two 40s
        expect(summary.buckets[6].count).toBe(2); // 60-70 holds the two 60s
    });

    it("returns a zeroed summary for empty input", () => {
        const summary = computeScoreDistribution([]);
        expect(summary.count).toBe(0);
        expect(summary.buckets).toHaveLength(10);
        expect(summary.buckets.every(bucket => bucket.count === 0)).toBe(true);
    });
});

describe("computeGroupScoreSummary", () => {
    it("summarizes min/median/average/max per group, sorted by average desc", () => {
        const summary = computeGroupScoreSummary([
            { groupKey: "b", groupName: "B반", scores: [50, 60, 70] },
            { groupKey: "a", groupName: "A반", scores: [80, 90, 100] },
        ]);

        expect(summary).toEqual([
            { groupKey: "a", groupName: "A반", count: 3, min: 80, median: 90, average: 90, max: 100 },
            { groupKey: "b", groupName: "B반", count: 3, min: 50, median: 60, average: 60, max: 70 },
        ]);
    });

    it("drops groups with zero attempts instead of returning a zeroed row", () => {
        const summary = computeGroupScoreSummary([
            { groupKey: "a", groupName: "A반", scores: [70] },
            { groupKey: "empty", groupName: "빈 반", scores: [] },
        ]);

        expect(summary).toHaveLength(1);
        expect(summary[0].groupKey).toBe("a");
    });

    it("returns an empty array when every group is empty", () => {
        expect(computeGroupScoreSummary([])).toEqual([]);
        expect(computeGroupScoreSummary([{ groupKey: "a", groupName: "A반", scores: [] }])).toEqual([]);
    });

    it("breaks average ties by Korean-locale group name", () => {
        const summary = computeGroupScoreSummary([
            { groupKey: "z", groupName: "다반", scores: [70] },
            { groupKey: "y", groupName: "가반", scores: [70] },
        ]);
        expect(summary.map(g => g.groupName)).toEqual(["가반", "다반"]);
    });
});

describe("computeRankPercentile", () => {
    it("hides the percentile for solo submissions (totalStudents < 2)", () => {
        expect(computeRankPercentile(1, 1)).toBeNull();
        expect(computeRankPercentile(1, 0)).toBeNull();
    });

    it("computes a top-N% percentile for 2+ participants", () => {
        expect(computeRankPercentile(1, 5)).toBe(20);
        expect(computeRankPercentile(5, 5)).toBe(100);
        expect(computeRankPercentile(1, 2)).toBe(50);
    });

    it("floors at 1% even for very large fields", () => {
        expect(computeRankPercentile(1, 1000)).toBe(1);
    });
});

describe("computePointBiserialCorrelation", () => {
    it("returns null below the minimum sample size", () => {
        const samples = [
            { correct: true, score: 90 },
            { correct: false, score: 10 },
        ];
        expect(computePointBiserialCorrelation(samples, 5)).toBeNull();
    });

    it("returns 1 for perfectly separated groups", () => {
        // Both correct respondents score 100, both incorrect respondents score 0 — the
        // strongest possible discrimination signal.
        const samples = [
            { correct: true, score: 100 },
            { correct: true, score: 100 },
            { correct: false, score: 0 },
            { correct: false, score: 0 },
            { correct: false, score: 0 },
        ];
        expect(computePointBiserialCorrelation(samples)).toBe(1);
    });

    it("returns null when every respondent lands in the same correctness group", () => {
        const allCorrect = Array.from({ length: 6 }, (_, i) => ({ correct: true, score: 50 + i }));
        expect(computePointBiserialCorrelation(allCorrect)).toBeNull();

        const allIncorrect = Array.from({ length: 6 }, (_, i) => ({ correct: false, score: 50 + i }));
        expect(computePointBiserialCorrelation(allIncorrect)).toBeNull();
    });

    it("returns null when scores have zero variance (correlation is undefined)", () => {
        const samples = [
            { correct: true, score: 70 },
            { correct: true, score: 70 },
            { correct: false, score: 70 },
            { correct: false, score: 70 },
            { correct: false, score: 70 },
        ];
        expect(computePointBiserialCorrelation(samples)).toBeNull();
    });

    it("computes a hand-verified positive correlation for a realistic mixed sample", () => {
        // 5 respondents: correct group scores {90, 80, 70} (mean 80), incorrect group
        // scores {50, 40} (mean 45). p=0.6, q=0.4, population sd of all 5 scores ≈ 18.547.
        // r = ((80-45)/18.547) * sqrt(0.6*0.4) ≈ 0.92.
        const samples = [
            { correct: true, score: 90 },
            { correct: true, score: 80 },
            { correct: true, score: 70 },
            { correct: false, score: 50 },
            { correct: false, score: 40 },
        ];
        expect(computePointBiserialCorrelation(samples)).toBe(0.92);
    });
});
