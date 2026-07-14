import type { ExamSummaryRow } from "./dashboardSummary";
import { serializeCsvRows } from "./csv";
import { formatKoreanDate } from "./pure";
import { safeRatePercent } from "./scoreUtils";
import { computeMedian, computePassRate, computeStandardDeviation } from "./scoreDistribution";

export interface DashboardExportQuestionStat {
    examTitle: string;
    questionNumber: number;
    correctRate: number;
    /**
     * Point-biserial correlation between correctness and total score — the unified
     * discrimination index (the legacy upper/lower-third D column was removed).
     * null when there are too few respondents for a reliable value; rendered as "-".
     */
    pointBiserial: number | null;
}

export interface DashboardStatsExportInput {
    stats: {
        totalStudents: number;
        avgScore: number;
        activeExams: number;
    };
    trendData: number[];
    examRows: ExamSummaryRow[];
    /** Student score percentages feeding median/SD/pass-rate; falls back to trendData. */
    scores?: number[];
    /** Pass threshold (score percent) for the pass-rate row. Defaults to 60. */
    passThreshold?: number;
    /** Optional per-question correct-rate / discrimination rows. */
    questionStats?: DashboardExportQuestionStat[];
    exportedAt?: Date;
}

function examStatusLabel(row: ExamSummaryRow): string {
    if (row.archived) return "보관";
    if (row.isCompleted) return "완료";
    return "진행";
}

export function buildDashboardStatsCsvRows(input: DashboardStatsExportInput): unknown[][] {
    const exportedAt = input.exportedAt ?? new Date();
    const passThreshold = input.passThreshold ?? 60;
    // Prefer the raw student scores; fall back to the per-exam trend averages so the
    // distribution rows are still populated when only summary data is available.
    const distributionScores = input.scores && input.scores.length > 0 ? input.scores : input.trendData;

    const rows: unknown[][] = [
        ["OMR Maker 통계 내보내기"],
        ["내보내기 시각", exportedAt.toISOString()],
        [],
        ["요약 통계"],
        ["전체 학생", input.stats.totalStudents],
        ["평균 점수", Number(input.stats.avgScore.toFixed(1))],
        ["중앙값", computeMedian(distributionScores)],
        ["표준편차", computeStandardDeviation(distributionScores)],
        [`합격률(${passThreshold}점 이상, %)`, computePassRate(distributionScores, passThreshold)],
        ["진행 중 시험", input.stats.activeExams],
        ["전체 시험", input.examRows.length],
        [],
        ["최근 점수 추세"],
        ["순서", "평균 점수"],
    ];

    input.trendData.forEach((score, index) => {
        rows.push([index + 1, score]);
    });

    rows.push(
        [],
        ["시험별 통계"],
        ["상태", "시험명", "생성일", "참여자", "전체 대상", "참여율(%)", "재시험", "보관 여부"],
    );

    input.examRows.forEach(row => {
        rows.push([
            examStatusLabel(row),
            row.title,
            formatKoreanDate(row.createdAt),
            row.completedCount,
            row.total,
            safeRatePercent(row.completedCount, row.total),
            row.retakeCount,
            row.archived ? "Y" : "N",
        ]);
    });

    if (input.questionStats && input.questionStats.length > 0) {
        rows.push(
            [],
            ["문항별 통계"],
            ["시험명", "문항 번호", "정답률(%)", "변별도(점이연상관)"],
        );
        input.questionStats.forEach(stat => {
            rows.push([
                stat.examTitle,
                stat.questionNumber,
                stat.correctRate,
                stat.pointBiserial === null ? "-" : stat.pointBiserial,
            ]);
        });
    }

    return rows;
}

export function buildDashboardStatsCsv(input: DashboardStatsExportInput): string {
    return `${serializeCsvRows(buildDashboardStatsCsvRows(input))}\n`;
}
