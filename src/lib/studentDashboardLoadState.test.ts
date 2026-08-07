import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dashboardSource = readFileSync(
    join(process.cwd(), "src/app/student/dashboard/page.tsx"),
    "utf8",
);

describe("student dashboard load-state contract", () => {
    it("models loading, ready, and error independently from the student session", () => {
        expect(dashboardSource).toContain('type DashboardDataState = "loading" | "ready" | "error"');
        expect(dashboardSource).toContain('useState<DashboardDataState>("loading")');
        expect(dashboardSource).toContain('myAttemptsResult.status !== "ok"');
        expect(dashboardSource).toContain('setDataState("error")');
        expect(dashboardSource).toContain('setDataState("ready")');
    });

    it("renders status announcements and recovery actions before any success-only content", () => {
        expect(dashboardSource).toContain('data-testid="student-dashboard-loading"');
        expect(dashboardSource).toContain('role="status"');
        expect(dashboardSource).toContain('aria-live="polite"');
        expect(dashboardSource).toContain('data-testid="student-dashboard-error"');
        expect(dashboardSource).toContain('data-testid="student-dashboard-retry"');
        expect(dashboardSource).toContain('href="/?role=student"');
        expect(dashboardSource).toContain('href="/"');
        expect(dashboardSource).toMatch(/dataState === "ready"\s*&&\s*\(/);
    });
});
