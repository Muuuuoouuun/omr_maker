import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const rootDir = process.cwd();

function readProjectFile(filePath: string): string {
    return readFileSync(path.join(rootDir, filePath), "utf8");
}

describe("dashboard loading performance surface", () => {
    it("keeps chart-heavy analytics out of the dashboard entry module", () => {
        const dashboardPage = readProjectFile("src/app/teacher/dashboard/page.tsx");
        const overviewTab = readProjectFile("src/components/dashboard/tabs/OverviewTab.tsx");

        expect(dashboardPage).not.toMatch(/^import ExamAnalyticsTab/m);
        expect(dashboardPage).not.toMatch(/^import StudentAnalyticsTab/m);
        expect(dashboardPage).toContain('() => import("@/components/dashboard/tabs/ExamAnalyticsTab")');
        expect(dashboardPage).toContain('() => import("@/components/dashboard/tabs/StudentAnalyticsTab")');
        expect(overviewTab).not.toMatch(/^import TrendChart from/m);
        expect(overviewTab).toContain('() => import("@/components/dashboard/TrendChart")');
    });

    it("filters unfinished attempts before building submitted exam analytics", () => {
        const examAnalyticsTab = readProjectFile("src/components/dashboard/tabs/ExamAnalyticsTab.tsx");
        const studentAnalyticsTab = readProjectFile("src/components/dashboard/tabs/StudentAnalyticsTab.tsx");

        expect(examAnalyticsTab).toContain("completedAttemptsOnly(");
        expect(examAnalyticsTab.indexOf("completedAttemptsOnly("))
            .toBeLessThan(examAnalyticsTab.indexOf("buildRegionalLearningScopes({"));
        expect(studentAnalyticsTab).toContain('attempts.filter(attempt => attempt.status === "completed")');
        expect(studentAnalyticsTab.indexOf('attempts.filter(attempt => attempt.status === "completed")'))
            .toBeLessThan(studentAnalyticsTab.indexOf("buildStudentAnalyticsRegionalScopes({"));
    });

    it("loads the dense attempt report only when its tab is opened", () => {
        const attemptPage = readProjectFile("src/app/teacher/attempt/[attemptId]/page.tsx");

        expect(attemptPage).not.toContain('import ReportPanel from "@/components/teacher/student-results/ReportPanel";');
        expect(attemptPage).toContain('() => import("@/components/teacher/student-results/ReportPanel")');
    });

    it("builds per-student weakness only on the student workspace and once per student bucket", () => {
        const examAnalyticsTab = readProjectFile("src/components/dashboard/tabs/ExamAnalyticsTab.tsx");
        const weaknessBlock = examAnalyticsTab.slice(
            examAnalyticsTab.indexOf("const studentWeaknessByAttemptId"),
            examAnalyticsTab.indexOf("const scopedWeaknessGroups"),
        );

        expect(weaknessBlock).toContain('activeWorkspaceView !== "students"');
        expect(weaknessBlock).toContain("attemptsByStudentKey");
        expect(weaknessBlock.match(/buildLearningRecommendations/g)).toHaveLength(1);
    });

    it("fails closed instead of publishing partial roster analytics", () => {
        const usersPage = readProjectFile("src/app/teacher/users/page.tsx");

        expect(usersPage).toContain("isCompleteTeacherAttemptCollection(");
        expect(usersPage).toContain("setAllAttempts(attemptAnalyticsComplete ? attemptResult.items : [])");
        expect(usersPage).toContain("const attemptAnalyticsComplete = isDemoSession || isCompleteTeacherAttemptCollection(attemptResult)");
        expect(usersPage).toContain('setAttemptAnalyticsStatus(attemptAnalyticsComplete ? "ready" : "unavailable")');
        expect(usersPage).toContain("응시 분석을 일시 중단");
        expect(usersPage).toContain('attemptAnalyticsStatus === "ready"');
        expect(usersPage).toContain("응시 분석 데이터 미표시");
        expect(usersPage).toContain('attemptAnalyticsAvailable ? `${s.avgScore}` : "—"');
    });

    it("renders useful loading shells and applies local data before remote refresh", () => {
        const dashboardPage = readProjectFile("src/app/teacher/dashboard/page.tsx");
        const loadingSkeleton = readProjectFile("src/components/dashboard/DashboardLoadingSkeleton.tsx");
        const localFirstLoad = dashboardPage.slice(
            dashboardPage.indexOf("const loadDashboardData"),
            dashboardPage.indexOf("const loadDetailedAttempts", dashboardPage.indexOf("const loadDashboardData")),
        );

        expect(dashboardPage).toContain("fallback={<DashboardPageSkeleton />}");
        expect(dashboardPage).toContain("loading: () => <AnalyticsTabSkeleton />");
        expect(loadingSkeleton).toContain('aria-label="대시보드를 불러오는 중"');
        expect(loadingSkeleton).toContain('aria-label="분석 화면을 불러오는 중"');
        expect(localFirstLoad.indexOf("readLocalExams()")).toBeGreaterThanOrEqual(0);
        expect(localFirstLoad.indexOf("readLocalAttempts()")).toBeGreaterThanOrEqual(0);
        expect(localFirstLoad.indexOf("readLocalRosterSnapshot(localStorage)")).toBeGreaterThanOrEqual(0);
        expect(localFirstLoad.indexOf("readLocalExams()")).toBeLessThan(localFirstLoad.indexOf("await Promise.all"));
    });
});
