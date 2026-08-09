import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function readProjectFile(path: string): string {
    return readFileSync(join(process.cwd(), path), "utf8");
}

describe("teacher dashboard detailed attempt cache", () => {
    it("keeps degraded rendering outside the detailed-attempt callback graph", () => {
        const dashboard = readProjectFile("src/app/teacher/dashboard/page.tsx");
        const loaderStart = dashboard.indexOf("const loadDetailedAttempts = useCallback");
        const loaderEnd = dashboard.indexOf("useEffect(() =>", loaderStart);
        const loaderBlock = dashboard.slice(loaderStart, loaderEnd);
        const degradedStart = dashboard.indexOf("!isMockupAccount && isDashboardDegraded && degradedDashboardData");
        const freshStart = dashboard.indexOf("activeTab === 'overview' && !isMockupAccount && !isDashboardDegraded", degradedStart);
        expect(degradedStart).toBeGreaterThan(-1);
        expect(freshStart).toBeGreaterThan(degradedStart);
        const degradedBranch = dashboard.slice(degradedStart, freshStart);

        expect(loaderBlock).toMatch(/if \(dashboardLiveOperationRef\.current\.loadState !== "loaded_data"\) return \[\];[\s\S]*loadTeacherAttempts\(\)/);
        expect(degradedBranch).not.toContain("onLoadDetailedAttempts");
        expect(degradedBranch).not.toContain("onNavigateToExamAnalytics");
        expect(degradedBranch).not.toContain("onNavigateToStudentAnalytics");
        expect(dashboard).toMatch(/isDashboardDegraded[\s\S]*data-testid="canonical-degraded-cache"[\s\S]*마지막 저장[\s\S]*다시 시도/);
    });

    it("uses a synchronously updated live load-state fence for detail and repair continuations", () => {
        const dashboard = readProjectFile("src/app/teacher/dashboard/page.tsx");
        const loaderStart = dashboard.indexOf("const loadDetailedAttempts = useCallback");
        const loaderEnd = dashboard.indexOf("useEffect(() =>", loaderStart);
        const loaderBlock = dashboard.slice(loaderStart, loaderEnd);
        const repairStart = dashboard.indexOf("const handleRepairAnalyticsData");
        const repairEnd = dashboard.indexOf("const syncTone", repairStart);
        const repairBlock = dashboard.slice(repairStart, repairEnd);

        expect(dashboard).toContain("dashboardLiveOperationRef");
        expect(dashboard).toMatch(/const setDashboardLoadState = useCallback[\s\S]*dashboardLiveOperationRef\.current =/);
        expect(loaderBlock).toMatch(/const detailIsCurrent = \(\) => canContinueTeacherDashboardDetail\([\s\S]*dashboardLiveOperationRef\.current/);
        expect(loaderBlock).toMatch(/await activeLoad\.promise;[\s\S]*if \(!detailIsCurrent\(\)\) return \[\]/);
        expect(repairBlock).toMatch(/const repairIsCurrent = \(\) => canContinueTeacherDashboardRepair\([\s\S]*dashboardLiveOperationRef\.current/);
        expect(repairBlock).toMatch(/await saveLocalAttemptIfCurrent[\s\S]*if \(!repairIsCurrent\(\)\) return/);
        expect(repairBlock).toContain("() => repairIsCurrent()");
    });

    it("wires repair continuations and cleanup to an exact token plus permanent capability epoch", () => {
        const dashboard = readProjectFile("src/app/teacher/dashboard/page.tsx");
        const loadStateStart = dashboard.indexOf("const setDashboardLoadState = useCallback");
        const loadStateEnd = dashboard.indexOf("const [degradedDashboardData", loadStateStart);
        const loadStateBlock = dashboard.slice(loadStateStart, loadStateEnd);
        const repairStart = dashboard.indexOf("const handleRepairAnalyticsData");
        const repairEnd = dashboard.indexOf("const syncTone", repairStart);
        const repairBlock = dashboard.slice(repairStart, repairEnd);

        expect(dashboard).toContain("teacherDashboardRepairOperationRef");
        expect(loadStateBlock).toContain('dashboardLiveOperationRef.current.loadState === "loaded_data"');
        expect(loadStateBlock).toContain('next.state !== "loaded_data"');
        expect(loadStateBlock).toContain("invalidateTeacherDashboardRepairCapability(");
        expect(repairBlock).toContain("beginTeacherDashboardRepairOperation(");
        expect(repairBlock).toContain("canContinueTeacherDashboardRepairOperation(");
        expect(repairBlock).toContain("canReleaseTeacherDashboardRepairOperation(");
        expect(repairBlock).toMatch(/finally \{[\s\S]*canReleaseTeacherDashboardRepairOperation\([\s\S]*repairOperation[\s\S]*teacherDashboardRepairOperationRef\.current/);
    });

    it("invalidates detailed attempts when the fresh attempt snapshot changes", () => {
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
        expect(dashboard).toContain("sameTeacherLoadIdentity");
        expect(dashboard).toContain("requestedLoadIdentity");
        expect(dashboard).toContain("resetDetailedAttemptsForDashboardRequest");
        expect(dashboard).toMatch(/detailedAttemptStatus === "idle"[\s\S]*return/);
    });

    it("clears visible and detailed state immediately when the complete teacher identity changes", () => {
        const dashboard = readProjectFile("src/app/teacher/dashboard/page.tsx");
        expect(dashboard).toContain("beginTeacherDashboardIdentityLoad");
        expect(dashboard).toContain("clearDashboardVisibleState");
        expect(dashboard).toMatch(/identityChanged[\s\S]*clearDashboardVisibleState\(\)[\s\S]*invalidateDetailedAttempts\(\)/);
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

    it("publishes usable stale detail rows through the shared completeness policy", () => {
        const dashboard = readProjectFile("src/app/teacher/dashboard/page.tsx");
        const loaderStart = dashboard.indexOf("const loadDetailedAttempts = useCallback");
        const loaderEnd = dashboard.indexOf("useEffect(() =>", loaderStart);
        const loaderBlock = dashboard.slice(loaderStart, loaderEnd);

        expect(loaderBlock).toContain("resolveTeacherAttemptCollectionCompleteness(result)");
        expect(loaderBlock).toContain('if (completeness === "error")');
        expect(loaderBlock).not.toContain("if (result.remoteError) throw");
        expect(loaderBlock).toContain("setDetailedAttempts(result.items)");
    });

    it("does not replace a retained retry snapshot with the loading skeleton", () => {
        const dashboard = readProjectFile("src/app/teacher/dashboard/page.tsx");
        const loaderStart = dashboard.indexOf("const loadDetailedAttempts = useCallback");
        const loaderEnd = dashboard.indexOf("useEffect(() =>", loaderStart);
        const loaderBlock = dashboard.slice(loaderStart, loaderEnd);

        expect(loaderBlock).toMatch(/if \(!detailedAttemptCacheRef\.current\) \{\s*setDetailedAttemptStatus\("loading"\);\s*\}/);
    });

    it("offers an actionable retry for stale or partial detail rows and hides it for ready data", () => {
        const dashboard = readProjectFile("src/app/teacher/dashboard/page.tsx");
        const retryStart = dashboard.indexOf("const retryDetailedAttempts = useCallback");
        const retryEnd = dashboard.indexOf("const loadDetailedAttempts = useCallback", retryStart);
        const retryBlock = dashboard.slice(retryStart, retryEnd);
        const invalidationStart = dashboard.indexOf("const invalidateDetailedAttempts = useCallback");
        const invalidationBlock = dashboard.slice(invalidationStart, retryStart);

        expect(retryStart).toBeGreaterThan(-1);
        expect(retryBlock).toContain("beginDashboardDetailBackgroundRetry");
        expect(retryBlock).toContain("snapshot: detailedAttemptCacheRef.current");
        expect(retryBlock).not.toContain("setDetailedAttempts(null)");
        expect(invalidationBlock).toContain("detailedAttemptGenerationRef.current + 1");
        expect(invalidationBlock).toContain("detailedAttemptCacheRef.current = null");
        expect(invalidationBlock).toContain("setDetailedAttempts(null)");
        expect(invalidationBlock).toContain("setDetailedAttemptGeneration(nextGeneration)");
        expect(dashboard).toContain("resolveDashboardDetailRetryFailure");
        expect(dashboard).toContain('failure.kind === "cached"');
        expect(dashboard).toContain("setDetailedAttemptWarning(failure.warning)");
        expect(dashboard).toContain('detailedAttemptSampleStatus !== "ready"');
        expect(dashboard).toContain("onClick={retryDetailedAttempts}");
        expect(dashboard).toContain("최신 데이터 다시 불러오기");
        expect(dashboard).toMatch(/detailedAttemptSampleStatus !== "ready"[\s\S]*onClick=\{retryDetailedAttempts\}/);
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
