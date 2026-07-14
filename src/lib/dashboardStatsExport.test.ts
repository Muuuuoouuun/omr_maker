import { describe, expect, it } from "vitest";
import { parseCsvRows } from "./csv";
import { buildDashboardStatsCsv, buildDashboardStatsCsvRows } from "./dashboardStatsExport";

describe("dashboard stats export", () => {
    const input = {
        stats: {
            totalStudents: 12,
            avgScore: 82.345,
            activeExams: 2,
        },
        trendData: [70, 82.3],
        examRows: [
            {
                id: "exam-a",
                title: "중간, 모의고사",
                createdAt: "2026-06-18T09:00:00.000Z",
                completedCount: 6,
                retakeCount: 1,
                total: 12,
                archived: false,
                isCompleted: false,
            },
            {
                id: "exam-b",
                title: "기말",
                createdAt: "2026-06-17T09:00:00.000Z",
                completedCount: 12,
                retakeCount: 0,
                total: 12,
                archived: true,
                isCompleted: true,
            },
        ],
        exportedAt: new Date("2026-06-18T10:00:00.000Z"),
    };

    it("builds dashboard summary, trend, and exam rows", () => {
        expect(buildDashboardStatsCsvRows(input)).toContainEqual(["평균 점수", 82.3]);
        expect(buildDashboardStatsCsvRows(input)).toContainEqual(["순서", "평균 점수"]);
        // Distribution rows fall back to trendData [70, 82.3] when no raw scores are supplied.
        expect(buildDashboardStatsCsvRows(input)).toContainEqual(["중앙값", 76.2]);
        expect(buildDashboardStatsCsvRows(input)).toContainEqual(["표준편차", 6.1]);
        expect(buildDashboardStatsCsvRows(input)).toContainEqual(["합격률(60점 이상, %)", 100]);
        expect(buildDashboardStatsCsvRows(input)).toContainEqual([
            "진행",
            "중간, 모의고사",
            "2026. 6. 18.",
            6,
            12,
            50,
            1,
            "N",
        ]);
        expect(buildDashboardStatsCsvRows(input)).toContainEqual([
            "보관",
            "기말",
            "2026. 6. 17.",
            12,
            12,
            100,
            0,
            "Y",
        ]);
    });

    it("uses raw student scores and appends per-question stats when provided", () => {
        const rows = buildDashboardStatsCsvRows({
            ...input,
            scores: [40, 60, 80, 100], // median 70, sd ~21.2, pass-rate 75
            passThreshold: 70,
            questionStats: [
                { examTitle: "중간, 모의고사", questionNumber: 1, correctRate: 82, pointBiserial: 0.34 },
                // null = too few respondents for a reliable index → rendered as "-".
                { examTitle: "중간, 모의고사", questionNumber: 2, correctRate: 35, pointBiserial: null },
            ],
        });

        expect(rows).toContainEqual(["중앙값", 70]);
        expect(rows).toContainEqual(["표준편차", 22.4]);
        expect(rows).toContainEqual(["합격률(70점 이상, %)", 50]);
        expect(rows).toContainEqual(["문항별 통계"]);
        expect(rows).toContainEqual(["시험명", "문항 번호", "정답률(%)", "변별도(점이연상관)"]);
        expect(rows).toContainEqual(["중간, 모의고사", 1, 82, 0.34]);
        expect(rows).toContainEqual(["중간, 모의고사", 2, 35, "-"]);
    });

    it("serializes to spreadsheet-safe CSV", () => {
        const rows = parseCsvRows(buildDashboardStatsCsv(input));

        expect(rows[0]).toEqual(["OMR Maker 통계 내보내기"]);
        expect(rows).toContainEqual(["내보내기 시각", "2026-06-18T10:00:00.000Z"]);
        expect(rows).toContainEqual(["진행", "중간, 모의고사", "2026. 6. 18.", "6", "12", "50", "1", "N"]);
    });
});
