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

export interface GroupScoreInput {
    groupKey: string;
    groupName: string;
    scores: number[];
}

export interface GroupScoreSummary {
    groupKey: string;
    groupName: string;
    count: number;
    min: number;
    median: number;
    average: number;
    max: number;
}

/**
 * Per-group min/median/average/max score summary for the "반별 점수 비교" range-bar card.
 * Groups with zero attempts are dropped so callers can render an empty state instead of a
 * zeroed-out row; sorted by average score (desc) so the strongest class leads.
 */
export function computeGroupScoreSummary(groups: GroupScoreInput[]): GroupScoreSummary[] {
    return groups
        .map(group => {
            const distribution = computeScoreDistribution(group.scores);
            return {
                groupKey: group.groupKey,
                groupName: group.groupName,
                count: distribution.count,
                min: distribution.min,
                median: distribution.median,
                average: distribution.mean,
                max: distribution.max,
            };
        })
        .filter(summary => summary.count > 0)
        .sort((a, b) => b.average - a.average || a.groupName.localeCompare(b.groupName, "ko"));
}

/**
 * Percentile label for a 1-based rank among totalStudents. Returns null when there are
 * fewer than 2 participants — "상위 100%" is meaningless (and misleading) for a lone entry,
 * so callers should show the rank by itself instead.
 */
export function computeRankPercentile(rank: number, totalStudents: number): number | null {
    if (!Number.isFinite(rank) || !Number.isFinite(totalStudents) || totalStudents < 2) return null;
    return Math.max(1, Math.round((rank / totalStudents) * 100));
}

export interface PointBiserialSample {
    /** Whether this respondent answered the item correctly. */
    correct: boolean;
    /** The continuous variable to correlate against — typically total attempt score. */
    score: number;
}

/**
 * Point-biserial correlation between a binary variable (item correctness) and a continuous
 * variable (total score) — a more statistically grounded discrimination index than the
 * upper/lower-third split. Returns null when there are fewer than minSamples respondents,
 * when every respondent landed in the same correctness group, or when the scores have zero
 * variance (correlation is undefined in all three cases).
 */
export function computePointBiserialCorrelation(samples: PointBiserialSample[], minSamples = 5): number | null {
    if (samples.length < minSamples) return null;

    const correctScores = samples.filter(sample => sample.correct).map(sample => sample.score);
    const incorrectScores = samples.filter(sample => !sample.correct).map(sample => sample.score);
    if (correctScores.length === 0 || incorrectScores.length === 0) return null;

    const n = samples.length;
    const allScores = samples.map(sample => sample.score);
    const meanAll = allScores.reduce((sum, value) => sum + value, 0) / n;
    const variance = allScores.reduce((sum, value) => sum + (value - meanAll) ** 2, 0) / n;
    const standardDeviation = Math.sqrt(variance);
    if (standardDeviation === 0) return null;

    const meanCorrect = correctScores.reduce((sum, value) => sum + value, 0) / correctScores.length;
    const meanIncorrect = incorrectScores.reduce((sum, value) => sum + value, 0) / incorrectScores.length;
    const proportionCorrect = correctScores.length / n;
    const proportionIncorrect = incorrectScores.length / n;

    const correlation = ((meanCorrect - meanIncorrect) / standardDeviation)
        * Math.sqrt(proportionCorrect * proportionIncorrect);
    return roundTo(correlation, 2);
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
