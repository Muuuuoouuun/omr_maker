// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Exam } from "@/types/omr";

const controls = vi.hoisted(() => ({
    allowDemo: false,
    loadExams: vi.fn(),
    loadExam: vi.fn(),
    saveExam: vi.fn(),
    loadSummaries: vi.fn(),
    loadAttempts: vi.fn(),
    loadSessions: vi.fn(),
    loadRoster: vi.fn(),
    finishAttempts: vi.fn(),
    finishSessions: vi.fn(),
}));

vi.mock("next/link", () => ({
    default: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props}>{children}</a>,
}));
vi.mock("@/components/TeacherHeader", () => ({ default: () => null }));
vi.mock("@/components/Toast", () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/demoData", () => ({ shouldUseDemoData: () => controls.allowDemo }));
vi.mock("@/lib/teacherSession", () => ({ readTeacherSession: () => null }));
vi.mock("@/lib/teacherAttemptClient", () => ({
    loadTeacherAttemptSummaries: controls.loadSummaries,
    loadTeacherAttempts: controls.loadAttempts,
    loadTeacherActiveAttemptSessions: controls.loadSessions,
    forceFinishTeacherAttempts: controls.finishAttempts,
    forceFinishTeacherAttemptSessions: controls.finishSessions,
}));
vi.mock("@/lib/teacherExamClient", () => ({
    loadTeacherExams: controls.loadExams,
    loadTeacherExam: controls.loadExam,
    saveTeacherExamMutation: controls.saveExam,
}));
vi.mock("@/lib/teacherRosterClient", () => ({ loadTeacherRosterSnapshot: controls.loadRoster }));

import LiveResultsPage from "./page";

const readyAttempts = { items: [], remoteLoaded: true };
const unauthorizedAttempts = { items: [], remoteLoaded: false, remoteError: "Teacher server session is missing" };

function realExam(): Exam {
    return {
        id: "live-exam",
        title: "실제 시험",
        questions: [{ id: 1, number: 1, choices: 5 }],
        createdAt: new Date(Date.now() - 60_000).toISOString(),
        startAt: new Date(Date.now() - 60_000).toISOString(),
        endAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
}

async function renderReady() {
    await act(async () => { render(<LiveResultsPage />); });
}

function openConfirmation() {
    const trigger = within(screen.getByRole("region", { name: "실시간 시험 작업" }))
        .getByRole("button", { name: "종료 처리" });
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "응시 종료 처리 확인" });
    return { trigger, dialog };
}

describe("teacher live demo confirmation lifecycle", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        for (const control of Object.values(controls)) {
            if (vi.isMockFunction(control)) control.mockReset();
        }
        controls.allowDemo = false;
        controls.loadExams.mockResolvedValue({ items: [realExam()], remoteLoaded: true });
        controls.loadSummaries.mockResolvedValue(readyAttempts);
        controls.loadAttempts.mockResolvedValue(readyAttempts);
        controls.loadSessions.mockResolvedValue({ items: [], remoteLoaded: true });
        controls.loadRoster.mockResolvedValue({ students: [], groups: [], remoteLoaded: true });
        controls.loadExam.mockResolvedValue(realExam());
        controls.saveExam.mockResolvedValue({ ok: true });
        // jsdom has no layout. Rendered focusable controls still need rectangles
        // so the real dialog focus hook exercises its browser visibility guard.
        const rect = new DOMRect(0, 0, 1, 1);
        const rectangles: DOMRectList = {
            0: rect,
            length: 1,
            item: index => index === 0 ? rect : null,
            [Symbol.iterator]: () => [rect][Symbol.iterator](),
        };
        vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue(rectangles);
    });

    afterEach(() => {
        cleanup();
        vi.restoreAllMocks();
        vi.useRealTimers();
    });

    it("keeps a demo confirmation and keyboard focus intact across refresh intervals without canonical detail reads", async () => {
        controls.allowDemo = true;
        controls.loadExams.mockResolvedValue(unauthorizedAttempts);
        controls.loadSummaries.mockResolvedValue(unauthorizedAttempts);
        controls.loadRoster.mockResolvedValue({ students: [], groups: [], remoteError: "unauthorized" });
        controls.loadAttempts.mockResolvedValue(unauthorizedAttempts);
        controls.loadSessions.mockResolvedValue(unauthorizedAttempts);
        await renderReady();

        const { trigger, dialog } = openConfirmation();
        const cancel = within(dialog).getByRole("button", { name: "취소" });
        const confirm = within(dialog).getByRole("button", { name: "지금 종료" });
        expect(cancel).toHaveFocus();

        await act(async () => { await vi.advanceTimersByTimeAsync(6_500); });
        expect(dialog).toBeInTheDocument();
        expect(cancel).toHaveFocus();
        expect(controls.loadAttempts).not.toHaveBeenCalled();
        expect(controls.loadSessions).not.toHaveBeenCalled();
        fireEvent.keyDown(cancel, { key: "Tab", shiftKey: true });
        expect(confirm).toHaveFocus();
        fireEvent.keyDown(confirm, { key: "Tab" });
        expect(cancel).toHaveFocus();
        fireEvent.keyDown(cancel, { key: "Escape" });
        expect(dialog).not.toBeInTheDocument();
        expect(trigger).toHaveFocus();
    });

    it("continues polling real details and closes the real confirmation on an authorization failure", async () => {
        controls.loadAttempts.mockResolvedValueOnce(readyAttempts).mockResolvedValue(unauthorizedAttempts);
        await renderReady();
        expect(controls.loadAttempts).toHaveBeenCalledTimes(1);
        const { trigger, dialog } = openConfirmation();

        await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
        expect(controls.loadAttempts).toHaveBeenCalledTimes(2);
        expect(controls.loadSessions).toHaveBeenCalledTimes(2);
        expect(dialog).not.toBeInTheDocument();
        expect(trigger).toBeDisabled();
    });

    it("fences a pending real response when a catalog refresh switches to demo mode", async () => {
        controls.allowDemo = true;
        controls.loadExams.mockResolvedValueOnce({ items: [realExam()], remoteLoaded: true })
            .mockResolvedValue(unauthorizedAttempts);
        let resolvePending: (result: typeof unauthorizedAttempts) => void = () => {};
        const pending = new Promise<typeof unauthorizedAttempts>(resolve => { resolvePending = resolve; });
        controls.loadAttempts.mockResolvedValueOnce(readyAttempts).mockReturnValueOnce(pending);
        await renderReady();
        await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
        expect(controls.loadAttempts).toHaveBeenCalledTimes(2);

        await act(async () => {
            fireEvent.click(within(screen.getByRole("region", { name: "실시간 시험 작업" }))
                .getByRole("button", { name: "+5분 연장" }));
        });
        expect(screen.getByRole("status", { name: "데모 실시간 데이터 안내" })).toBeInTheDocument();
        const { dialog } = openConfirmation();
        await act(async () => { resolvePending(unauthorizedAttempts); });
        await act(async () => { await vi.advanceTimersByTimeAsync(6_500); });

        expect(dialog).toBeInTheDocument();
        expect(within(dialog).getByRole("button", { name: "취소" })).toHaveFocus();
        expect(controls.loadAttempts).toHaveBeenCalledTimes(2);
        expect(controls.loadSessions).toHaveBeenCalledTimes(2);
    });
});
