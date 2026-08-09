import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import AssignmentBlock from "@/components/dashboard/AssignmentBlock";
import type { AssignmentLifecycle } from "@/lib/assignmentLifecycle";
import type { StudentAssignmentPreview } from "@/lib/studentExamContract";

type SurfaceAssignment = StudentAssignmentPreview & {
    attemptId?: string;
    hasLocalDraft?: boolean;
};

function assignment(
    id: string,
    lifecycle: AssignmentLifecycle,
    overrides: Partial<SurfaceAssignment> = {},
): SurfaceAssignment {
    return {
        id,
        title: `${id} 시험`,
        createdAt: "2026-08-08T00:00:00.000Z",
        lifecycle,
        startsAt: "2026-08-09T01:00:00.000Z",
        endsAt: "2026-08-09T02:00:00.000Z",
        access: { type: "targeted", entryCheck: "required" },
        ...overrides,
    };
}

function render(exams: SurfaceAssignment[], type: "todo" | "done") {
    return renderToStaticMarkup(createElement(AssignmentBlock, { exams, type }));
}

describe("assignment lifecycle dashboard surface", () => {
    it("renders a scheduled assignment with a deterministic Korean opening time and no solve link", () => {
        const html = render([assignment("scheduled", "scheduled")], "todo");

        expect(html).toContain("예정");
        expect(html).toMatch(/2026.*8.*9.*10:00/);
        expect(html).toContain('aria-disabled="true"');
        expect(html).not.toContain('href="/solve/scheduled');
    });

    it("renders only open assignments as solve links and distinguishes a local draft", () => {
        const html = render([
            assignment("fresh", "open"),
            assignment("draft", "open", { hasLocalDraft: true }),
        ], "todo");

        expect(html).toContain("응시 가능");
        expect(html).toContain('href="/solve/fresh"');
        expect(html).toContain('href="/solve/draft"');
        expect(html).toContain("시작");
        expect(html).toContain("계속 풀기");
    });

    it("fails closed for closed, invalid, missing, and malformed lifecycle values", () => {
        const html = render([
            assignment("closed", "closed"),
            assignment("invalid", "invalid"),
            assignment("missing", undefined as never),
            assignment("malformed", "unexpected" as never),
        ], "todo");

        expect(html).toContain("마감");
        expect(html).toContain("확인 필요");
        expect(html.match(/aria-disabled="true"/g)).toHaveLength(4);
        expect(html).not.toContain('href="/solve/');
    });

    it("keeps completion independent and exposes review, never solve, for completed open and closed cards", () => {
        const html = render([
            assignment("open-done", "open", { attemptId: "attempt-open" }),
            assignment("closed-done", "closed", { attemptId: "attempt-closed" }),
        ], "done");

        expect(html).toContain("응시 가능");
        expect(html).toContain("마감");
        expect(html).toContain("완료");
        expect(html).toContain('href="/student/review/attempt-open"');
        expect(html).toContain('href="/student/review/attempt-closed"');
        expect(html).not.toContain('href="/solve/');
    });

    it("keeps the server action as the final exam-entry authorization boundary", () => {
        const dashboard = readFileSync("src/app/student/dashboard/page.tsx", "utf8");
        const action = readFileSync("src/app/actions/studentExam.ts", "utf8");

        expect(dashboard).toContain("hasLocalDraftFor");
        expect(dashboard).toContain("findCompletedAttemptForAssignment");
        expect(action).toContain("resolveAuthorizedStudentSessionCookie");
        expect(action).toContain("resolveStudentTargetedAssignmentWithGateway");
        expect(action).toContain("evaluateDurableGatedAccess");
    });
});
