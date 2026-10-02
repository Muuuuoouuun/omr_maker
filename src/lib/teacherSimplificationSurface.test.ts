import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const rootDir = process.cwd();

function read(relativePath: string): string {
    return readFileSync(path.join(rootDir, relativePath), "utf8");
}

describe("teacher surface simplification regressions", () => {
    it("moves secondary teacher header controls into an accessible account menu", () => {
        const header = read("src/components/TeacherHeader.tsx");

        expect(header).not.toContain("<StatusPill");
        expect(header).toContain('aria-expanded={accountMenuOpen}');
        expect(header).toContain('aria-controls="teacher-account-menu"');
        expect(header).toContain('id="teacher-account-menu"');
        expect(header).toContain('role="menu"');
        expect(header).toContain('if (event.key === "Escape")');
        expect(header).toContain('window.addEventListener("mousedown", handlePointerDown)');
        expect(header).toContain("accountMenuTriggerRef.current?.focus");
        expect(header).toContain('<TeacherSessionChip compact />');
        expect(header).toContain('href="/teacher/settings"');
        expect(header).toContain('href="/teacher/billing"');
        expect(header).toContain('<ThemeToggle size="small" role="menuitem" />');
        expect(header).toContain('<TeacherLogoutButton size="small" role="menuitem" />');
        expect(header).toContain('event.key === "ArrowDown"');
        expect(header).toContain('event.key === "ArrowUp"');
        expect(header).toContain('event.key === "Home"');
        expect(header).toContain('event.key === "End"');
        expect(header).toContain('event.key === "Tab"');
        expect(header).toMatch(/if \(event\.key === "Tab"\)[\s\S]*?event\.preventDefault\(\);[\s\S]*?closeAccountMenu\(true\);/);
        expect(header).toContain("onBlur={(event) =>");
        expect(header).toContain('querySelectorAll<HTMLElement>(\'[role="menuitem"]\')');
    });

    it("keeps only search, notifications, and account directly visible on phones", () => {
        const header = read("src/components/TeacherHeader.tsx");

        expect(header).toContain("teacher-header-live-action");
        expect(header).toMatch(/@media \(max-width: 640px\)[\s\S]*\.teacher-header-live-action\s*\{\s*display:\s*none/);
        expect(header).toContain('href="/teacher/dashboard"');
        expect(header).toContain('href="/teacher/live"');
        expect(header).toMatch(/minHeight:\s*44/);
    });

    it("shows one onboarding action instead of empty dashboard analytics", () => {
        const dashboard = read("src/app/teacher/dashboard/page.tsx");

        expect(dashboard).toContain("isRealDashboardEmpty");
        expect(dashboard).toContain("dashboardHasRenderableData");
        expect(dashboard).toContain("isDashboardResolving");
        expect(dashboard).toContain("isDashboardResolving ? (");
        expect(dashboard).toContain(") : isDashboardUnavailable ? (");
        expect(dashboard).toContain('data-testid="canonical-error-no-cache"');
        expect(dashboard).toContain("dashboard-empty-onboarding");
        expect(dashboard).toContain("첫 시험 만들기");
        expect(dashboard).toContain('!isRealDashboardEmpty && teacherDataCapability === "fresh_mutable" && renderTabs()');
        expect(dashboard).toMatch(/function isDashboardSnapshotEmpty[\s\S]*snapshot\.rosterGroups\.length === 0/);
        expect(dashboard).toContain("&& isDashboardLoadDataEmpty(dashboardLoadState.data)");
        expect(dashboard).toContain('options.notifyOnError === true');
        expect(dashboard).toContain('notifyOnSuccess: true, notifyOnError: true');
    });

    it("preserves roster analysis except for an empty student tab", () => {
        const users = read("src/app/teacher/users/page.tsx");

        expect(users).toContain('className="teacher-users-analysis"');
        expect(users).toContain("명단 분석");
        expect(users).toContain('(tab !== "students" || showStudentListControls) && (');
        expect(users).toContain("hasStudentRosterData");
        expect(users).toContain("showStudentListControls");
        expect(users).toContain("showStudentListControls &&");
        expect(users).toContain("!showStudentListControls &&");
    });
});
