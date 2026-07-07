import type { ExamSummaryRow } from "./dashboardSummary";
import { serializeCsvRows } from "./csv";
import { formatKoreanDate } from "./pure";
import { safeRatePercent } from "./scoreUtils";

export interface DashboardStatsExportInput {
    stats: {
        totalStudents: number;
        avgScore: number;
        activeExams: number;
    };
    trendData: number[];
    examRows: ExamSummaryRow[];
    exportedAt?: Date;
}

function examStatusLabel(row: ExamSummaryRow): string {
    if (row.archived) return "보관";
    if (row.isCompleted) return "완료";
    return "진행";
}

export function buildDashboardStatsCsvRows(input: DashboardStatsExportInput): unknown[][] {
    const exportedAt = input.exportedAt ?? new Date();
    const rows: unknown[][] = [
        ["OMR Maker 통계 내보내기"],
        ["내보내기 시각", exportedAt.toISOString()],
        [],
        ["요약 통계"],
        ["전체 학생", input.stats.totalStudents],
        ["평균 점수", Number(input.stats.avgScore.toFixed(1))],
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

    return rows;
}

export function buildDashboardStatsCsv(input: DashboardStatsExportInput): string {
    return `${serializeCsvRows(buildDashboardStatsCsvRows(input))}\n`;
}
