import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function readProjectFile(path: string): string {
    return readFileSync(join(process.cwd(), path), "utf8");
}

describe("teacher attempt summary surfaces", () => {
    it.each([
        "src/app/teacher/live/page.tsx",
        "src/app/teacher/billing/page.tsx",
        "src/app/teacher/settings/page.tsx",
        "src/app/teacher/users/page.tsx",
    ])("uses the lightweight loader for the common list in %s", path => {
        const source = readProjectFile(path);
        expect(source).toContain("loadTeacherAttemptSummaries");
    });

    it("keeps the initial dashboard bounded and delegates rich rows to explicit detail/snapshot actions", () => {
        const dashboard = readProjectFile("src/app/teacher/dashboard/page.tsx");
        const cacheProjection = readProjectFile("src/lib/teacherDashboardCanonicalCache.ts");
        const loadStart = dashboard.indexOf("const loadDashboardData = useCallback");
        const loadEnd = dashboard.indexOf("// Initial dashboard load", loadStart);
        const freshLoad = dashboard.slice(loadStart, loadEnd);
        const projectionStart = cacheProjection.indexOf("export function toTeacherDashboardCacheProjection");
        const projectionEnd = cacheProjection.indexOf("export function cacheFreshTeacherDashboardOptional", projectionStart);
        const projection = cacheProjection.slice(projectionStart, projectionEnd);

        expect(freshLoad).toContain("loadTeacherAttemptSummaries(),");
        expect(freshLoad).not.toContain("loadTeacherAttempts(),");
        expect(freshLoad).toContain("applyDashboardSnapshot(nextState.data)");
        expect(freshLoad).toContain("cacheFreshTeacherDashboardOptional(");
        expect(projection).not.toMatch(/\b(?:questions|answers|drawings|studentQuestions|feedback)\s*:/);
    });

    it("keeps rich attempt lists explicit on detail, review, CSV, and analytics paths", () => {
        const dashboard = readProjectFile("src/app/teacher/dashboard/page.tsx");
        const overview = readProjectFile("src/components/dashboard/tabs/OverviewTab.tsx");
        const examDetail = readProjectFile("src/app/teacher/exam/[id]/page.tsx");
        const attemptDetail = readProjectFile("src/app/teacher/attempt/[attemptId]/page.tsx");

        expect(dashboard).toContain("loadTeacherAttempts");
        expect(overview).toContain("onLoadDetailedAttempts");
        expect(examDetail).toContain("loadTeacherAttempts(id)");
        expect(attemptDetail).toContain("loadTeacherAttempt(");
    });

    it("loads rich dashboard analytics behind a loading/error boundary", () => {
        const dashboard = readProjectFile("src/app/teacher/dashboard/page.tsx");
        expect(dashboard).toContain("analyticsSnapshotStatus");
        expect(dashboard).toContain("loadDetailedAttempts");
        expect(dashboard).toContain("analyticsAttempts");
        expect(dashboard).toContain("loadTeacherAnalyticsSnapshots");
        expect(dashboard).toContain("공식 분석 데이터를 불러오지 못했습니다");
    });

    it("refreshes the selected live exam immediately and blocks answer-dependent actions until rich rows arrive", () => {
        const live = readProjectFile("src/app/teacher/live/page.tsx");
        expect(live).toContain("selectedAttemptDetailsReady");
        expect(live).toMatch(/useEffect\(\(\) => \{[\s\S]*?void refreshSelectedAttempts\(\);[\s\S]*?\}, \[refreshSelectedAttempts/);
        expect(live).toContain("!isDemoLive && !selectedAttemptDetailsReady");
        expect(live).toContain("loadSelectedAttemptDetails(nextSelectedExamId, true)");
    });

    it("loads bounded server profile analytics only when a profile or group report is opened", () => {
        const users = readProjectFile("src/app/teacher/users/page.tsx");
        expect(users).toContain('await import("@/app/actions/teacherRosterProfiles")');
        expect(users).toContain("loadTeacherCanonicalRosterProfile({ kind: \"student\"");
        expect(users).toContain("loadTeacherCanonicalRosterProfile({ kind: \"group\"");
        expect(users).not.toContain("ensureDetailedAttempts");
    });
});
