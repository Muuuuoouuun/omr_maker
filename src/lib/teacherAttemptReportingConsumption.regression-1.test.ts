import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
    return readFileSync(join(process.cwd(), path), "utf8");
}

describe("exact attempt reporting consumers", () => {
    it("does not build the dashboard CSV from the recent 2,000-row detail projection", () => {
        const overview = source("src/components/dashboard/tabs/OverviewTab.tsx");
        expect(overview).toContain("loadTeacherAttemptExportDataset");
        expect(overview).toContain("buildTeacherAttemptReportingProjection");
        const exportHandler = overview.slice(
            overview.indexOf("const handleExportStatsCsv"),
            overview.indexOf("return (", overview.indexOf("const handleExportStatsCsv")),
        );
        expect(exportHandler).toContain("reportingDataset.aggregate.completedAttemptCount");
        expect(exportHandler).not.toContain("buildTeacherDashboardMetrics(exams, detailedAttempts");
        expect(exportHandler).not.toContain("buildExamSummaryRows(\n                exams,\n                detailedAttempts");
    });

    it("uses exact aggregate totals for dashboard, billing, and data readiness", () => {
        const dashboard = source("src/app/teacher/dashboard/page.tsx");
        const billing = source("src/app/teacher/billing/page.tsx");
        const settings = source("src/app/teacher/settings/page.tsx");
        expect(dashboard).toContain("loadTeacherAttemptAggregate");
        expect(dashboard).toContain("averageScorePercent");
        expect(billing).toContain("periodAttemptCount");
        expect(billing).toContain("periodHandwritingArchiveCount");
        expect(settings).toContain("aggregate.totalAttemptCount");
    });

    it("keeps the exam detail total and CSV off the recent 2,000-row projection", () => {
        const detail = source("src/app/teacher/exam/[id]/page.tsx");
        expect(detail).toContain("loadTeacherAttemptAggregate");
        expect(detail).toContain("loadTeacherAttemptExportDataset");
        expect(detail).toContain("completedBaseAttemptCount");
        expect(detail).toContain("최근 제출");

        const exportHandler = detail.slice(
            detail.indexOf("const handleExportCSV"),
            detail.indexOf("const visibleLoadStatus"),
        );
        expect(exportHandler).toContain("reportingDataset.rows");
        expect(exportHandler).not.toContain("sortedAttempts.map");
    });
});
