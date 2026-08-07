import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readProjectFile(path: string): string {
    return readFileSync(resolve(process.cwd(), path), "utf8");
}

function expectSourceOrder(source: string, selectors: string[]) {
    const positions = selectors.map(selector => source.indexOf(selector));
    expect(positions.every(position => position >= 0), `missing selector in source: ${selectors.join(", ")}`).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
}

describe("student mobile reading order", () => {
    it("keeps dashboard and history task order in the DOM instead of CSS order", () => {
        const dashboard = readProjectFile("src/app/student/dashboard/page.tsx");
        const history = readProjectFile("src/app/student/history/page.tsx");
        const css = readProjectFile("src/app/globals.css");

        expectSourceOrder(dashboard, [
            "student-dashboard-primary-task",
            "student-dashboard-history-action",
            "student-dashboard-secondary-status",
            "student-dashboard-completed-task",
        ]);
        expectSourceOrder(history, [
            "student-history-record-list",
            "history-summary-rail",
            "student-history-toolbar",
        ]);
        expect(css).not.toMatch(/\.student-dashboard-(?:task-flow|primary-task|history-action|secondary-status|completed-task)[^{]*{[^}]*\border\s*:/);
        expect(css).not.toMatch(/\.student-history-(?:ready-flow|record-list|toolbar|pagination)[^{]*{[^}]*\border\s*:/);
    });

    it("keeps review workbench before retake and support without display contents or order", () => {
        const review = readProjectFile("src/app/student/review/[attemptId]/page.tsx");
        const css = readProjectFile("src/app/globals.css");

        expectSourceOrder(review, [
            'className="student-review-summary"',
            'className="student-review-content">',
            'className="student-review-secondary"',
            "student-review-next-action",
            'aria-label="학생 질문/해설 지원"',
        ]);
        expect(css).not.toMatch(/\.student-review-sidebar\s*{[^}]*display:\s*contents/);
        expect(css).not.toMatch(/\.student-review-(?:summary|secondary|score-card|stat-grid|content|side-card|next-action|feedback-card)\s*{\s*order\s*:/);
    });
});
