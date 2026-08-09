import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const teacherDashboard = source("src/app/teacher/dashboard/page.tsx");
const teacherUsers = source("src/app/teacher/users/page.tsx");
const distributeModal = source("src/components/DistributeModal.tsx");
const studentDashboard = source("src/app/student/dashboard/page.tsx");

describe("canonical load-state surfaces", () => {
    it.each([
        ["teacher dashboard", teacherDashboard],
        ["teacher users", teacherUsers],
        ["distribution roster", distributeModal],
        ["student dashboard", studentDashboard],
    ])("routes %s through the shared resolver", (_label, page) => {
        expect(page).toContain("@/lib/canonicalLoadState");
        expect(page).toContain("resolveCanonicalLoad");
        expect(page).toContain('state: "loading"');
        expect(page).toContain('state === "error_without_cache"');
    });

    it("keeps teacher dashboard failure distinct from successful empty onboarding", () => {
        expect(teacherDashboard).toContain('data-testid="canonical-error-no-cache"');
        expect(teacherDashboard).toContain('data-testid="canonical-degraded-cache"');
        expect(teacherDashboard).toContain("저장된 데이터를 표시 중");
        expect(teacherDashboard).toContain("마지막 저장");
        expect(teacherDashboard).toContain('dashboardLoadState.state === "loaded_empty"');
        expect(teacherDashboard).toContain("첫 시험 만들기");
        expect(teacherDashboard).toContain('data-testid="canonical-dashboard-retry"');
        expect(teacherDashboard).toMatch(/dashboardHasRenderableData\s*&&\s*!isMockupAccount[\s\S]*dashboard-analysis-actions/);
    });

    it("blocks roster mutations and onboarding only when canonical roster data is unavailable", () => {
        expect(teacherUsers).toContain('"canonical-error-no-cache"');
        expect(teacherUsers).toContain('data-testid="canonical-degraded-cache"');
        expect(teacherUsers).toContain("저장된 데이터를 표시 중");
        expect(teacherUsers).toContain("마지막 저장");
        expect(teacherUsers).toContain("첫 학생 추가");
        expect(teacherUsers).toContain('data-testid="canonical-roster-retry"');
        expect(teacherUsers).toContain("rosterMutationsDisabled");
        expect(teacherUsers).toContain("응시 분석 데이터 미표시");
    });

    it("blocks all distribution while the target roster has no canonical or cached truth", () => {
        expect(distributeModal).toContain('data-testid="canonical-error-no-cache"');
        expect(distributeModal).toContain('data-testid="canonical-degraded-cache"');
        expect(distributeModal).toContain('data-testid="canonical-distribution-roster-retry"');
        expect(distributeModal).toContain("distributionRosterUnavailable");
        expect(distributeModal).toMatch(/disabled=\{[^}]*distributionRosterUnavailable/);
        expect(distributeModal.match(/if \(isRosterLoading \|\| distributionRosterUnavailable\)/g)).toHaveLength(2);
        expect(distributeModal).toContain("inviteLifecycleBlocksIssuance");
    });

    it("keeps student recovery links and canonical success content separated", () => {
        expect(studentDashboard).toContain('data-testid="student-dashboard-error"');
        expect(studentDashboard).toContain('data-testid="student-dashboard-degraded"');
        expect(studentDashboard).toContain("저장된 데이터를 표시 중");
        expect(studentDashboard).toContain("마지막 저장");
        expect(studentDashboard).toContain('dataState.state === "loaded_empty"');
        expect(studentDashboard).toContain('dataState.state === "loaded_data"');
        expect(studentDashboard).toContain('href="/"');
        expect(studentDashboard).toContain("로그인 안내");
    });
});
