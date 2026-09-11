// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const rpc = vi.hoisted(() => vi.fn());
vi.mock("@/components/TeacherHeader", () => ({ default: () => null }));
vi.mock("@/app/actions/remediation", () => ({ manageRemediation: rpc }));
import RemediationPage from "./page";
const fixture = { sourceAttemptId: "source", examId: "exam", examTitle: "수학", studentName: "학생", className: "A반", assigneeName: "교사",
    dueAt: "2026-09-12T14:59:00.000Z", revision: 3, state: "awaiting_review", targetCount: 2, correctedCount: 2, submittedCount: 2,
    evidenceKey: "a".repeat(32), note: "", canManage: true };
describe("remediation teacher flow", () => {
    beforeEach(() => { rpc.mockReset(); rpc.mockImplementation(async command => command.op === "load"
        ? { status: "loaded", dashboard: { cases: [fixture], candidates: [], hasMore: false, canAssign: true, planEnabled: true } }
        : { status: "saved" }); });
    afterEach(cleanup);
    it("requires evidence and an explicit teacher check before confirmation", async () => {
        render(<RemediationPage />);
        const button = await screen.findByRole("button", { name: "교사 확인 완료" }) as HTMLButtonElement;
        expect(button.disabled).toBe(true);
        fireEvent.change(screen.getByLabelText("확인 근거 또는 보류 사유"), { target: { value: "유사 문항 풀이를 확인함" } });
        expect(button.disabled).toBe(true);
        fireEvent.click(screen.getByLabelText("별도 문항 풀이 또는 설명을 직접 확인했습니다."));
        expect(button.disabled).toBe(false);
        fireEvent.click(button);
        await waitFor(() => expect(rpc).toHaveBeenCalledWith({ op: "confirm", sourceAttemptId: "source", expectedRevision: 3,
            evidenceKey: "a".repeat(32), note: "유사 문항 풀이를 확인함" }));
        await screen.findByText("저장했습니다. 최신 제출 근거로 목록을 갱신했습니다.");
    });
    it("keeps a service failure distinct from an empty list and allows retry", async () => {
        rpc.mockResolvedValueOnce({ status: "error", error: "서버 연결을 확인해주세요.", code: "service_unavailable" });
        render(<RemediationPage />);
        expect(await screen.findByRole("alert")).toBeTruthy();
        expect(screen.queryByText(/아직 배정된 보강이 없습니다/)).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
        await screen.findByRole("button", { name: "교사 확인 완료" });
    });
    it("removes the previous snapshot and surfaces conflict after a stale save", async () => {
        rpc.mockImplementation(async command => command.op === "load"
            ? { status: "loaded", dashboard: { cases: [fixture], candidates: [], hasMore: false, canAssign: true, planEnabled: true } }
            : { status: "error", code: "conflict", error: "새 제출로 상태가 바뀌었습니다." });
        render(<RemediationPage />);
        await screen.findByRole("button", { name: "교사 확인 완료" });
        fireEvent.change(screen.getByLabelText("확인 근거 또는 보류 사유"), { target: { value: "다음 수업에 확인 예정" } });
        fireEvent.click(screen.getByRole("button", { name: "사유 남기고 보류" }));
        await screen.findByText("새 제출로 상태가 바뀌었습니다.");
        expect(rpc.mock.calls.filter(([command]) => command.op === "load")).toHaveLength(2);
    });
});
