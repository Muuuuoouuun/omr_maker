import { describe, expect, it } from "vitest";
import {
    buildScoreBuckets,
    computeMedian,
    computePassRate,
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
