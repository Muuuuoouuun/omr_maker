// @vitest-environment jsdom

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { act, cleanup, render as renderClient, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";

import AssignmentBlock from "@/components/dashboard/AssignmentBlock";
import type { AssignmentLifecycle } from "@/lib/assignmentLifecycle";
import type { StudentAssignmentPreview } from "@/lib/studentExamContract";

type SurfaceAssignment = StudentAssignmentPreview & {
    attemptId?: string;
    hasLocalDraft?: boolean;
    hasRemoteProgress?: boolean;
};

function assignment(
    id: string,
    lifecycle: AssignmentLifecycle,
    overrides: Partial<SurfaceAssignment> = {},
): SurfaceAssignment {
    const startsAt = lifecycle === "open" || lifecycle === "closed"
        ? "2026-08-08T23:00:00.000Z"
        : lifecycle === "invalid"
            ? "not-a-time"
            : "2026-08-09T01:00:00.000Z";
    const endsAt = lifecycle === "closed"
        ? SERVER_NOW
        : "2026-08-09T02:00:00.000Z";
    return {
        id,
        title: `${id} 시험`,
        createdAt: "2026-08-08T00:00:00.000Z",
        lifecycle,
        startsAt,
        endsAt,
        access: { type: "targeted", entryCheck: "required" },
        ...overrides,
    };
}

const SERVER_NOW = "2026-08-09T00:00:00.000Z";

function renderAssignments(exams: SurfaceAssignment[], type: "todo" | "done") {
    return renderToStaticMarkup(createElement(AssignmentBlock, {
        exams, type, serverNow: SERVER_NOW,
        serverClock: { serverNow: SERVER_NOW, requestStartedMonotonicMs: 0, receivedMonotonicMs: 0 },
    }));
}

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});

describe("assignment lifecycle dashboard surface", () => {
    it("renders a scheduled assignment with a deterministic Korean opening time and no solve link", () => {
        const html = renderAssignments([assignment("scheduled", "scheduled")], "todo");

        expect(html).toContain("예정");
        expect(html).toMatch(/2026.*8.*9.*10:00/);
        expect(html).toContain('aria-disabled="true"');
        expect(html).not.toContain('href="/solve/scheduled');
    });

    it("renders only open assignments as solve links and distinguishes a local draft", () => {
        const html = renderAssignments([
            assignment("fresh", "open"),
            assignment("draft", "open", { hasLocalDraft: true }),
            assignment("remote-progress", "open", { hasRemoteProgress: true }),
        ], "todo");

        expect(html).toContain("응시 가능");
        expect(html).toContain('href="/solve/fresh"');
        expect(html).toContain('href="/solve/draft"');
        expect(html).toContain('href="/solve/remote-progress"');
        expect(html).toContain("시작");
        expect(html.match(/계속 풀기/g)).toHaveLength(2);
    });

    it("fails closed for closed, invalid, missing, and malformed lifecycle values", () => {
        const html = renderAssignments([
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
        const html = renderAssignments([
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

    it("advances scheduled to open to closed on the authoritative boundary timer", () => {
        vi.useFakeTimers();
        vi.setSystemTime("2035-01-01T00:00:00.000Z");
        const timed = assignment("timed", "scheduled", {
            startsAt: "2026-08-09T00:00:01.000Z",
            endsAt: "2026-08-09T00:00:02.000Z",
        });
        renderClient(createElement(AssignmentBlock, {
            exams: [timed], type: "todo", serverNow: SERVER_NOW,
            serverClock: { serverNow: SERVER_NOW, requestStartedMonotonicMs: 0, receivedMonotonicMs: 0 },
        }));

        expect(screen.getByText("예정", { exact: true })).toBeVisible();
        act(() => { vi.advanceTimersByTime(1_000); });
        expect(screen.getByText("응시 가능", { exact: true })).toBeVisible();
        expect(screen.getByRole("link", { name: "시작" })).toBeVisible();
        act(() => { vi.advanceTimersByTime(1_000); });
        expect(screen.getAllByText("마감", { exact: true })[0]).toBeVisible();
        expect(screen.queryByRole("link", { name: "시작" })).not.toBeInTheDocument();
    });

    it("does not reverse a closed lifecycle after OS clock rollback or an older serverNow rerender", () => {
        vi.useFakeTimers();
        vi.setSystemTime("2035-01-01T00:00:00.000Z");
        const timed = assignment("monotonic", "scheduled", {
            startsAt: "2026-08-09T00:00:01.000Z",
            endsAt: "2026-08-09T00:00:02.000Z",
        });
        const view = renderClient(createElement(AssignmentBlock, {
            exams: [timed], type: "todo", serverNow: SERVER_NOW,
            serverClock: { serverNow: SERVER_NOW, requestStartedMonotonicMs: 0, receivedMonotonicMs: 0 },
        }));
        act(() => { vi.advanceTimersByTime(1_000); });
        act(() => { vi.advanceTimersByTime(1_000); });
        expect(screen.getAllByText("마감", { exact: true })[0]).toBeVisible();

        vi.setSystemTime("2034-01-01T00:00:00.000Z");
        view.rerender(createElement(AssignmentBlock, {
            exams: [timed],
            type: "todo",
            serverNow: "2026-08-08T23:59:00.000Z",
            serverClock: {
                serverNow: "2026-08-08T23:59:00.000Z",
                requestStartedMonotonicMs: 0,
                receivedMonotonicMs: 0,
            },
        }));
        expect(screen.getAllByText("마감", { exact: true })[0]).toBeVisible();
    });

    it("never enables a near-end assignment when request transit uncertainty crosses the close boundary", () => {
        vi.useFakeTimers();
        const nearEnd = assignment("near-end", "open", {
            startsAt: "2026-08-08T23:59:00.000Z",
            endsAt: "2026-08-09T00:00:00.250Z",
        });
        renderClient(createElement(AssignmentBlock, {
            exams: [nearEnd], type: "todo", serverNow: SERVER_NOW,
            serverClock: { serverNow: SERVER_NOW, requestStartedMonotonicMs: 100, receivedMonotonicMs: 500 },
        }));
        expect(screen.queryByRole("link", { name: "시작" })).not.toBeInTheDocument();
        expect(screen.getAllByText("확인 필요", { exact: true })[0]).toBeVisible();
    });

    it("disables solve after visibility sleep until a fresh authoritative receipt arrives", () => {
        const refresh = vi.fn();
        renderClient(createElement(AssignmentBlock, {
            exams: [assignment("visible-open", "open")], type: "todo", serverNow: SERVER_NOW,
            serverClock: { serverNow: SERVER_NOW, requestStartedMonotonicMs: 100, receivedMonotonicMs: 100 },
            onClockRefresh: refresh,
        }));
        expect(screen.getByRole("link", { name: "시작" })).toBeVisible();
        act(() => {
            Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
            document.dispatchEvent(new Event("visibilitychange"));
        });
        expect(screen.queryByRole("link", { name: "시작" })).not.toBeInTheDocument();
        act(() => {
            Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
            document.dispatchEvent(new Event("visibilitychange"));
            window.dispatchEvent(new Event("pageshow"));
        });
        expect(refresh).toHaveBeenCalled();
        expect(screen.queryByRole("link", { name: "시작" })).not.toBeInTheDocument();
    });

    it("keeps the server action as the final exam-entry authorization boundary", () => {
        const dashboard = readFileSync("src/app/student/dashboard/page.tsx", "utf8");
        const action = readFileSync("src/app/actions/studentExam.ts", "utf8");

        expect(dashboard).toContain("hasLocalDraftFor");
        expect(dashboard).toContain("findCompletedAttemptForAssignment");
        expect(action).toContain("resolveAuthorizedStudentSessionCookie");
        expect(action).toContain("resolveStudentTargetedAssignmentWithGateway");
        expect(action).toContain("evaluateDurableGatedAccess");
        expect(action).toContain("listStudentAssignmentsWithGateway(ctx.admin, ctx.identity)");
        expect(action).toContain("serverNow: assignmentList.serverNow");
        expect(dashboard).toContain("serverNow={assignmentServerNow}");
        expect(dashboard).toContain("studentAssignmentDraftStorageKey");
        expect(action).toContain("assignmentRevision");
        expect(readFileSync("src/app/solve/[id]/page.tsx", "utf8"))
            .toContain("studentAssignmentDraftStorageKey");
        expect(readFileSync("src/components/dashboard/AssignmentBlock.tsx", "utf8"))
            .toContain('query.set("assignmentRevision", String(exam.assignmentRevision))');
    });
});
