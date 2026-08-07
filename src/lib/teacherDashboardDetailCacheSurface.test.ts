import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function readProjectFile(path: string): string {
    return readFileSync(join(process.cwd(), path), "utf8");
}

describe("teacher dashboard detailed attempt cache", () => {
    it("invalidates detailed attempts when the lightweight summary snapshot changes", () => {
        const dashboard = readProjectFile("src/app/teacher/dashboard/page.tsx");

        expect(dashboard).toContain("buildAttemptSummarySignal");
        expect(dashboard).toContain("attemptSummarySignalRef");
        expect(dashboard).toContain("detailedAttemptGenerationRef");
        expect(dashboard).toContain("invalidateDetailedAttempts");
        expect(dashboard).toMatch(/previousSummarySignal !== null[\s\S]*previousSummarySignal !== nextSummarySignal[\s\S]*invalidateDetailedAttempts/);
    });

    it("fences stale detail requests and reloads an open analytics tab for the new summary generation", () => {
        const dashboard = readProjectFile("src/app/teacher/dashboard/page.tsx");

        expect(dashboard).toContain("requestedGeneration !== detailedAttemptGenerationRef.current");
        expect(dashboard).toContain("detailedAttemptGeneration");
        expect(dashboard).toMatch(/useEffect\(\(\) => \{[\s\S]*activeTab === "overview"[\s\S]*loadDetailedAttempts\(\)[\s\S]*detailedAttemptGeneration/);
    });

    it("keeps the generation cache aligned after local analytics repair", () => {
        const dashboard = readProjectFile("src/app/teacher/dashboard/page.tsx");
        const repairBlock = dashboard.slice(
            dashboard.indexOf("const handleRepairAnalyticsData"),
            dashboard.indexOf("const syncTone"),
        );

        expect(repairBlock).toContain("detailedAttemptCacheRef.current = {");
        expect(repairBlock).toContain("generation: detailedAttemptGenerationRef.current");
    });

    it("turns a failed CSV detail load into a retryable user-visible error", () => {
        const overview = readProjectFile("src/components/dashboard/tabs/OverviewTab.tsx");

        expect(overview).toContain("exportStatsError");
        expect(overview).toContain('toast.error("통계 CSV 생성 실패"');
        expect(overview).toContain("error instanceof Error ? error.message");
        expect(overview).toContain("CSV 다시 시도");
        expect(overview).toMatch(/catch \(error\) \{[\s\S]*setExportStatsError[\s\S]*toast\.error[\s\S]*\} finally \{[\s\S]*setIsExportingStats\(false\)/);
    });

    it("builds exact CSV totals from one canonical export and omits partial rich analytics", () => {
        const overview = readProjectFile("src/components/dashboard/tabs/OverviewTab.tsx");

        expect(overview).toContain("loadTeacherAttemptExportDataset()");
        expect(overview).toContain("buildTeacherAttemptReportingProjection({");
        expect(overview).toContain("aggregate: reportingDataset.aggregate");
        expect(overview).toContain("rows: reportingDataset.rows");
        expect(overview).toContain("stats: exportMetrics");
        expect(overview).toContain("trendData: exportMetrics.trendData");
        expect(overview).toContain("examRows: exportExamRows");
        expect(overview).toContain("hasCompleteRichCoverage");
        expect(overview).toContain("? groupBaseAttemptsByExam(detailedAttempts)");
        expect(overview).toContain(": new Map<string, Attempt[]>()");
    });
});
