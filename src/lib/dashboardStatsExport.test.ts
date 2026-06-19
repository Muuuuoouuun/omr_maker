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

    it("serializes to spreadsheet-safe CSV", () => {
        const rows = parseCsvRows(buildDashboardStatsCsv(input));

        expect(rows[0]).toEqual(["OMR Maker 통계 내보내기"]);
        expect(rows).toContainEqual(["내보내기 시각", "2026-06-18T10:00:00.000Z"]);
        expect(rows).toContainEqual(["진행", "중간, 모의고사", "2026. 6. 18.", "6", "12", "50", "1", "N"]);
    });
});
