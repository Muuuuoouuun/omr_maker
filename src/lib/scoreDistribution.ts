/**
 * Shared score-distribution math for the teacher analytics dashboard.
 *
 * Kept framework-free so both the CSV export (dashboardStatsExport) and the
 * histogram/stat cards (ExamAnalyticsTab) draw from the same rounding rules.
 * All inputs are score percentages (0–100).
 */

export interface ScoreBucket {
    /** Display label, e.g. "0-10" … "90-100". */
    label: string;
    /** Inclusive lower bound. */
    min: number;
    /** Upper bound (exclusive except for the final 90–100 bucket). */
    max: number;
    count: number;
}

export interface ScoreDistributionSummary {
    count: number;
    mean: number;
    median: number;
    /** Population standard deviation. */
    standardDeviation: number;
    min: number;
    max: number;
    buckets: ScoreBucket[];
}

const BUCKET_COUNT = 10;
const BUCKET_SIZE = 10;

function roundTo(value: number, decimals = 1): number {
    if (!Number.isFinite(value)) return 0;
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
}

function sanitizeScores(scores: number[]): number[] {
    return scores.filter(score => Number.isFinite(score));
}

export function computeMedian(scores: number[]): number {
    const values = sanitizeScores(scores).slice().sort((a, b) => a - b);
    if (values.length === 0) return 0;
    const mid = Math.floor(values.length / 2);
    const median = values.length % 2 === 0
        ? (values[mid - 1] + values[mid]) / 2
        : values[mid];
    return roundTo(median);
}

export function computeStandardDeviation(scores: number[]): number {
    const values = sanitizeScores(scores);
    if (values.length === 0) return 0;
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
    return roundTo(Math.sqrt(variance));
}

/** Share of scores at or above the pass threshold, as a 0–100 percentage. */
export function computePassRate(scores: number[], passThreshold = 60): number {
    const values = sanitizeScores(scores);
    if (values.length === 0) return 0;
    const passed = values.filter(score => score >= passThreshold).length;
    return Math.round((passed / values.length) * 100);
}

export function buildScoreBuckets(scores: number[]): ScoreBucket[] {
    const buckets: ScoreBucket[] = Array.from({ length: BUCKET_COUNT }, (_, i) => ({
        label: `${i * BUCKET_SIZE}-${i === BUCKET_COUNT - 1 ? 100 : (i + 1) * BUCKET_SIZE}`,
        min: i * BUCKET_SIZE,
        max: i === BUCKET_COUNT - 1 ? 100 : (i + 1) * BUCKET_SIZE,
        count: 0,
    }));

    for (const score of sanitizeScores(scores)) {
        const clamped = Math.max(0, Math.min(100, score));
        const index = Math.min(BUCKET_COUNT - 1, Math.floor(clamped / BUCKET_SIZE));
        buckets[index].count += 1;
    }

    return buckets;
}

export function computeScoreDistribution(scores: number[]): ScoreDistributionSummary {
    const values = sanitizeScores(scores);
    if (values.length === 0) {
        return {
            count: 0,
            mean: 0,
            median: 0,
            standardDeviation: 0,
            min: 0,
            max: 0,
            buckets: buildScoreBuckets([]),
        };
    }

    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    return {
        count: values.length,
        mean: roundTo(mean),
        median: computeMedian(values),
        standardDeviation: computeStandardDeviation(values),
        min: roundTo(values.reduce((lo, value) => Math.min(lo, value), values[0])),
        max: roundTo(values.reduce((hi, value) => Math.max(hi, value), values[0])),
        buckets: buildScoreBuckets(values),
    };
}
