// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const controls = vi.hoisted(() => ({ load: vi.fn(), resolve: vi.fn(), push: vi.fn() }));
vi.mock("@/app/actions/remediation", () => ({ loadStudentRemediation: controls.load, resolveStudentRemediationRetake: controls.resolve }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: controls.push }) }));
import StudentRemediationPage from "./page";

const item = { sourceAttemptId: "source-1", examId: "exam-1", examTitle: "수학 오답", state: "assigned", dueAt: "2026-09-20T14:59:00Z",
    correctedCount: 0, targetCount: 2 };
const href = "/solve/exam-1?assignment=target-1&assignmentRevision=8&retakeFrom=source-1&questions=1%2C2&mode=wrong";
describe("student remediation entry", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        controls.load.mockResolvedValue({ status: "loaded", cases: [item] });
        controls.resolve.mockResolvedValue({ status: "ready", href });
    });
    afterEach(cleanup);
    it("opens only the server-checked link, retaining a separate review link", async () => {
        render(<StudentRemediationPage />);
        fireEvent.click(await screen.findByRole("button", { name: "배정 확인 후 다시 풀기" }));
        await waitFor(() => expect(controls.push).toHaveBeenCalledExactlyOnceWith(href));
        expect(controls.resolve).toHaveBeenCalledExactlyOnceWith("source-1");
        expect(screen.getByRole("link", { name: "원시험 오답 복습 →" }).getAttribute("href")).toBe("/student/review/source-1");
    });
    it("explains missing assignment without navigating and allows a fresh check", async () => {
        controls.resolve.mockResolvedValueOnce({ status: "blocked", code: "assignment_required" });
        render(<StudentRemediationPage />);
        fireEvent.click(await screen.findByRole("button", { name: "배정 확인 후 다시 풀기" }));
        await screen.findByText(/아직 이 오답의 개별 재시험이 배정되지/);
        expect(controls.push).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "배정 확인 후 다시 풀기" }));
        await waitFor(() => expect(controls.push).toHaveBeenCalledWith(href));
    });
    it("shows connection failure instead of entering with a stale/local link", async () => {
        controls.resolve.mockRejectedValue(new Error("offline"));
        render(<StudentRemediationPage />);
        fireEvent.click(await screen.findByRole("button", { name: "배정 확인 후 다시 풀기" }));
        await screen.findByText(/재시험 배정을 확인하지 못했습니다/);
        expect(controls.push).not.toHaveBeenCalled();
    });
    it("prevents duplicate clicks and discards a response after list refresh", async () => {
        let finish!: (value: unknown) => void;
        controls.resolve.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        render(<StudentRemediationPage />);
        const button = await screen.findByRole("button", { name: "배정 확인 후 다시 풀기" });
        fireEvent.click(button); fireEvent.click(button);
        expect(controls.resolve).toHaveBeenCalledTimes(1);
        expect((screen.getByRole("button", { name: "배정 확인 중…" }) as HTMLButtonElement).disabled).toBe(true);
        controls.load.mockResolvedValueOnce({ status: "loaded", cases: [{ ...item, state: "paused" }] });
        fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
        await screen.findByText("보류");
        await act(async () => finish({ status: "ready", href }));
        expect(controls.push).not.toHaveBeenCalled();
    });
    it.each(["paused", "handoff", "awaiting_review", "confirmed"])("does not offer entry for %s", async state => {
        controls.load.mockResolvedValueOnce({ status: "loaded", cases: [{ ...item, state }] });
        render(<StudentRemediationPage />);
        await screen.findByText("수학 오답");
        expect(screen.queryByRole("button", { name: "배정 확인 후 다시 풀기" })).toBeNull();
        if (state === "awaiting_review") expect(screen.getByText(/풀이를 설명하고 확인을 받아주세요/)).toBeTruthy();
    });
});
