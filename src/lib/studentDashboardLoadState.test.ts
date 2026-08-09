import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dashboardSource = readFileSync(
    join(process.cwd(), "src/app/student/dashboard/page.tsx"),
    "utf8",
);

describe("student dashboard load-state contract", () => {
    it("models the canonical load states independently from the student session", () => {
        expect(dashboardSource).toContain("CanonicalLoadState");
        expect(dashboardSource).toContain("resolveCanonicalLoad");
        expect(dashboardSource).toContain("myAttemptsResult.remoteFailed !== true");
        expect(dashboardSource).toContain('state: "loading"');
        expect(dashboardSource).toContain('myAttemptsResult.status !== "ok"');
        expect(dashboardSource).toContain('state === "error_without_cache"');
        expect(dashboardSource).toContain('state === "loaded_empty"');
        expect(dashboardSource).toContain('state === "loaded_data"');
    });

    it("renders status announcements and recovery actions before any success-only content", () => {
        expect(dashboardSource).toContain('data-testid="student-dashboard-loading"');
        expect(dashboardSource).toContain('role="status"');
        expect(dashboardSource).toContain('aria-live="polite"');
        expect(dashboardSource).toContain('data-testid="student-dashboard-error"');
        expect(dashboardSource).toContain('data-testid="student-dashboard-retry"');
        expect(dashboardSource).not.toContain('href="/?role=student"');
        expect(dashboardSource).toContain("선생님이 보낸 최신 초대 링크");
        expect(dashboardSource).toContain('href="/"');
        expect(dashboardSource).toContain('dataState.state === "loaded_empty"');
        expect(dashboardSource).toContain('dataState.state === "loaded_data"');
        expect(dashboardSource).toContain('data-testid="student-dashboard-degraded"');
    });

    it("uses only minimal attempt summaries before entry", () => {
        expect(dashboardSource).toContain("StudentAttemptSummary");
        expect(dashboardSource).not.toContain("attempt.studentQuestions");
        expect(dashboardSource).not.toContain("answeredQuestionKeys");
        expect(dashboardSource).not.toContain("newlyAnsweredKeys");
        expect(dashboardSource).toContain("answeredQuestionCount");
        expect(dashboardSource).toContain("latestAnsweredAt");
    });

    it("derives local lifecycle and restores missing completed exams as review-only cards", () => {
        expect(dashboardSource).toContain("localStudentAssignmentPreview");
        expect(dashboardSource).toContain("buildMissingCompletedReviewAssignments");
        expect(dashboardSource).toContain("loadObservedAt");
    });
});
