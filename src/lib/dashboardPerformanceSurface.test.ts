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

    it("renders useful loading shells and applies local data before remote refresh", () => {
        const dashboardPage = readProjectFile("src/app/teacher/dashboard/page.tsx");
        const loadingSkeleton = readProjectFile("src/components/dashboard/DashboardLoadingSkeleton.tsx");
        const mountEffect = dashboardPage.slice(
            dashboardPage.indexOf("useEffect(() => {", dashboardPage.indexOf("const loadDashboardData")),
        );

        expect(dashboardPage).toContain("fallback={<DashboardPageSkeleton />}");
        expect(dashboardPage).toContain("loading: () => <AnalyticsTabSkeleton />");
        expect(loadingSkeleton).toContain('aria-label="대시보드를 불러오는 중"');
        expect(loadingSkeleton).toContain('aria-label="분석 화면을 불러오는 중"');
        expect(mountEffect.indexOf("readLocalExams()")).toBeGreaterThanOrEqual(0);
        expect(mountEffect.indexOf("readLocalAttempts()")).toBeGreaterThanOrEqual(0);
        expect(mountEffect.indexOf("readLocalRosterSnapshot(localStorage)")).toBeGreaterThanOrEqual(0);
        expect(mountEffect.indexOf("readLocalExams()")).toBeLessThan(mountEffect.indexOf("void loadDashboardData"));
    });
});
