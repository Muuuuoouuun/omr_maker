import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const teacherDashboard = source("src/app/teacher/dashboard/page.tsx");
const teacherUsers = source("src/app/teacher/users/page.tsx");
const distributeModal = source("src/components/DistributeModal.tsx");
const studentDashboard = source("src/app/student/dashboard/page.tsx");
const groupsTab = source("src/components/teacher/users/GroupsTab.tsx");

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
        expect(teacherDashboard).toContain("저장된 데이터를 읽기 전용으로 표시 중");
        expect(teacherDashboard).toContain("마지막 저장");
        expect(teacherDashboard).toContain('dashboardLoadState.state === "loaded_empty"');
        expect(teacherDashboard).toContain("첫 시험 만들기");
        expect(teacherDashboard).toContain('data-testid="canonical-dashboard-retry"');
        expect(teacherDashboard).toMatch(/dashboardHasRenderableData\s*&&\s*!isMockupAccount[\s\S]*dashboard-analysis-actions/);
        expect(teacherDashboard).toContain("dashboardAllowsMutations");
        expect(teacherDashboard).toContain("(isMockupAccount || dashboardAllowsMutations) && <Link");
        expect(teacherDashboard).toContain("(isMockupAccount || dashboardAllowsAnalysis) && <>");
        expect(teacherDashboard).toMatch(/dashboardAllowsAnalysis[\s\S]*analyticsDataHealth\.kind/);
        expect(teacherDashboard).toMatch(/dashboardAllowsAnalysis[\s\S]*dashboard-analysis-actions/);
        expect(teacherDashboard).toContain("readTeacherDashboardDegradedCache");
        expect(teacherDashboard).toContain("cacheFreshTeacherDashboardOptional");
        expect(teacherDashboard).not.toContain("TEACHER_DASHBOARD_CACHE_STALE_AT_KEY");
    });

    it("keeps a degraded teacher roster read-only while retaining view and retry affordances", () => {
        expect(teacherUsers).toContain('"canonical-error-no-cache"');
        expect(teacherUsers).toContain('data-testid="canonical-degraded-cache"');
        expect(teacherUsers).toContain("저장된 데이터를 읽기 전용으로 표시 중");
        expect(teacherUsers).toContain("마지막 저장");
        expect(teacherUsers).toContain("첫 학생 추가");
        expect(teacherUsers).toContain('data-testid="canonical-roster-retry"');
        expect(teacherUsers).toContain("rosterMutationsDisabled");
        expect(teacherUsers).toMatch(/rosterAllowsMutations\s*=\s*[^;]*loaded_empty[^;]*loaded_data/);
        expect(teacherUsers).toContain("rosterMutationsDisabled = !rosterAllowsMutations");
        expect(teacherUsers).toContain('capability="degraded_read_only"');
        expect(teacherUsers).toContain('capability="fresh_mutable"');
        expect(teacherUsers).toContain("읽기 전용");
        expect(teacherUsers).toContain("응시 분석 데이터 미표시");
        expect(teacherUsers).toMatch(/handleExportCsv[\s\S]*rosterMutationsDisabled/);
        expect(teacherUsers.match(/onClick=\{handleExportCsv\} disabled=\{rosterMutationsDisabled\}/g)?.length).toBe(2);
        expect(teacherUsers).toContain("readTeacherRosterDegradedCache");
        expect(teacherUsers).not.toContain("omr_teacher_roster_cache_stale_at_v1");
        const studentViewControl = groupsTab.indexOf('aria-label={`${g.name} 학생 보기`}');
        expect(studentViewControl).toBeGreaterThan(0);
        const studentViewButton = groupsTab.lastIndexOf("<button", studentViewControl);
        expect(groupsTab.slice(studentViewButton - 40, studentViewButton)).not.toContain("!readOnly");
    });

    it("blocks distribution and onboarding while the target roster is loading, unavailable, or degraded", () => {
        expect(distributeModal).toContain('data-testid="canonical-error-no-cache"');
        expect(distributeModal).toContain('data-testid="canonical-degraded-cache"');
        expect(distributeModal).toContain('data-testid="canonical-distribution-roster-retry"');
        expect(distributeModal).toContain("distributionRosterReadOnly");
        expect(distributeModal).toMatch(/distributionRosterReadOnly\s*=\s*[^;]*loaded_empty[^;]*loaded_data/);
        expect(distributeModal).toMatch(/disabled=\{[^}]*distributionRosterReadOnly/);
        expect(distributeModal).toContain("읽기 전용");
        expect(distributeModal).toContain("inviteLifecycleBlocksIssuance");
        expect(distributeModal).toMatch(/canonical-degraded-cache[\s\S]*!visibleShareUrl/);
        expect(distributeModal).toContain("disabled={isInviteRevoking || distributionRosterReadOnly}");
        expect(distributeModal).toContain("readTeacherRosterDegradedCache");
        expect(distributeModal).not.toContain("omr_teacher_roster_cache_stale_at_v1");
    });

    it("keeps degraded student cache review-only without solve or onboarding actions", () => {
        expect(studentDashboard).toContain('data-testid="student-dashboard-error"');
        expect(studentDashboard).toContain('data-testid="student-dashboard-degraded"');
        expect(studentDashboard).toContain("저장된 데이터를 읽기 전용으로 표시 중");
        expect(studentDashboard).toContain("마지막 저장");
        expect(studentDashboard).toContain('dataState.state === "loaded_empty"');
        expect(studentDashboard).toContain('dataState.state === "loaded_data"');
        expect(studentDashboard).toContain('href="/"');
        expect(studentDashboard).toContain("로그인 안내");
        expect(studentDashboard).toContain("dashboardReadOnly");
        expect(studentDashboard).toContain('readOnly={dashboardReadOnly}');
        expect(studentDashboard).toContain("읽기 전용");
        expect(studentDashboard).toMatch(/!dashboardReadOnly\s*&&[^\n]*<StudentGuestRecoveryPanel/);
    });
});
