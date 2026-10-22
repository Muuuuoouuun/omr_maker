// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TeacherSession } from "@/lib/teacherSession";

const controls = vi.hoisted(() => ({
    session: null as TeacherSession | null,
    load: vi.fn(),
    save: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
}));
vi.mock("next/navigation", () => ({
    useSearchParams: () => new URLSearchParams(window.location.search),
    usePathname: () => window.location.pathname,
}));
vi.mock("next/dynamic", async () => {
    const { lazy } = await import("react");
    return { default: lazy };
});
vi.mock("@/components/TeacherHeader", () => ({ default: () => null }));
vi.mock("@/components/Toast", () => ({ toast: { success: controls.success, error: controls.error, info: vi.fn(), action: vi.fn() } }));
vi.mock("@/lib/teacherSession", async importOriginal => ({
    ...await importOriginal<typeof import("@/lib/teacherSession")>(),
    readTeacherSession: () => controls.session,
}));
vi.mock("@/lib/useServerPlan", () => ({ useServerPlan: () => ({ plan: "academy" }) }));
vi.mock("@/app/actions/teacherRoster", () => ({
    loadTeacherCanonicalRoster: controls.load,
    saveTeacherCanonicalRoster: controls.save,
}));
vi.mock("@/app/actions/studentAuth", () => ({ issueStudentCredentialBatch: vi.fn() }));
vi.mock("@/lib/teacherAttemptClient", () => ({
    loadTeacherAttemptSummaries: async () => ({ items: [] }),
    resolveTeacherAttemptCollectionCompleteness: () => "ready",
}));
vi.mock("@/lib/teacherExamClient", () => ({ loadTeacherExams: async () => ({ items: [] }) }));

import ManageUsersPage from "./page";

describe("showcase roster mutation controls", () => {
    beforeEach(() => {
        localStorage.clear();
        sessionStorage.clear();
        window.history.replaceState({}, "", "/teacher/users?tab=groups");
        vi.clearAllMocks();
        controls.session = { teacherId: "omr-showcase" } as TeacherSession;
        controls.load.mockResolvedValue({
            status: "loaded", revision: 0,
            snapshot: { students: [], groups: [], invites: [] },
            meta: { organizationId: "org-qa", loadedAt: new Date().toISOString(), rawCount: 0, parsedCount: 0 },
        });
        controls.save.mockImplementation(async snapshot => ({ status: "saved", revision: 1, snapshot }));
    });
    afterEach(cleanup);

    it("keeps public demo groups visible without offering writes or promising a real roster", async () => {
        render(<ManageUsersPage />);
        expect(await screen.findByRole("heading", { name: "3학년 A반" })).toBeVisible();
        expect(screen.queryAllByRole("button", { name: "새 반 만들기" })).toHaveLength(0);
        expect(screen.queryAllByRole("button", { name: "CSV 업로드" })).toHaveLength(0);
        expect(screen.getByRole("status", { name: "데모 명단 안내" })).toHaveTextContent("읽기 전용");
        expect(screen.getByRole("status", { name: "데모 명단 안내" })).not.toHaveTextContent("실제 명단으로 전환");
        expect(controls.load).not.toHaveBeenCalled();
        expect(controls.save).not.toHaveBeenCalled();
        expect(screen.getAllByText("77점").length).toBeGreaterThan(0);
        fireEvent.click(screen.getByRole("button", { name: "3학년 A반 학생 보기" }));
        expect(await screen.findByPlaceholderText("이름, 이메일, 반, 지역 검색")).toHaveValue("3학년 A반");
        expect(screen.queryAllByRole("button", { name: "학생 추가" })).toHaveLength(0);
    });

    it("allows an authenticated teacher to create the first group in a fresh empty roster", async () => {
        controls.session = {
            teacherId: "teacher-qa", organizationId: "org-qa", accountSessionGeneration: 1,
            memberRole: "owner",
        } as TeacherSession;
        render(<ManageUsersPage />);
        const buttons = await screen.findAllByRole("button", { name: "새 반 만들기" });
        fireEvent.click(buttons[0]);
        fireEvent.change(screen.getByRole("textbox", { name: "반 이름" }), { target: { value: "QA 첫 반" } });
        fireEvent.click(screen.getByRole("button", { name: "만들기" }));
        await waitFor(() => expect(controls.save).toHaveBeenCalled());
        expect(await screen.findByRole("heading", { name: "QA 첫 반" })).toBeVisible();
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    });

    async function startGroupSave() {
        controls.session = {
            teacherId: "teacher-qa", organizationId: "org-qa", accountSessionGeneration: 1,
            memberRole: "owner",
        } as TeacherSession;
        render(<ManageUsersPage />);
        fireEvent.click((await screen.findAllByRole("button", { name: "새 반 만들기" }))[0]);
        fireEvent.change(screen.getByRole("textbox", { name: "반 이름" }), { target: { value: "저장 대기 반" } });
        fireEvent.click(screen.getByRole("button", { name: "만들기" }));
        await waitFor(() => expect(controls.save).toHaveBeenCalledTimes(1));
    }

    it("waits for durable group save before success and closing, and guards duplicate submits and unload", async () => {
        let finish!: (value: unknown) => void;
        controls.save.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        await startGroupSave();
        expect(screen.getByRole("dialog", { name: "새 반 만들기" })).toBeVisible();
        expect(screen.getByRole("button", { name: "저장 중…" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "모달 닫기" })).toBeDisabled();
        expect(controls.success).not.toHaveBeenCalled();
        fireEvent.submit(screen.getByRole("textbox", { name: "반 이름" }).closest("form")!);
        fireEvent.click(screen.getByRole("button", { name: "취소" }));
        expect(controls.save).toHaveBeenCalledTimes(1);
        const unload = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(unload);
        expect(unload.defaultPrevented).toBe(true);
        await act(async () => finish({ status: "saved", revision: 1, snapshot: controls.save.mock.calls[0][0] }));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(controls.success).toHaveBeenCalledWith("반 생성됨", expect.any(String));
        const afterSave = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(afterSave);
        expect(afterSave.defaultPrevented).toBe(false);
    });

    it.each(["conflict", "network"])("retains group input and permits retry after %s failure without success", async failure => {
        if (failure === "conflict") controls.save.mockResolvedValueOnce({ status: "conflict" });
        else controls.save.mockRejectedValueOnce(new Error("network unavailable"));
        await startGroupSave();
        await waitFor(() => expect(screen.getByRole("button", { name: "만들기" })).toBeEnabled());
        expect(screen.getByRole("textbox", { name: "반 이름" })).toHaveValue("저장 대기 반");
        expect(controls.success).not.toHaveBeenCalled();
        expect(controls.error).toHaveBeenCalled();
        expect(screen.queryByRole("heading", { name: "저장 대기 반" })).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "만들기" }));
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        expect(controls.save).toHaveBeenCalledTimes(2);
        expect(controls.success).toHaveBeenCalledTimes(1);
    });

    it("continues to accept a persisted local-only development save", async () => {
        controls.save.mockResolvedValueOnce({ status: "local_only" });
        await startGroupSave();
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        expect(controls.success).toHaveBeenCalledTimes(1);
        expect(screen.getByRole("heading", { name: "저장 대기 반" })).toBeVisible();
    });

    it("does not publish success or retain the old form when identity changes during save", async () => {
        let finish!: (value: unknown) => void;
        controls.save.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        await startGroupSave();
        controls.session = null;
        await act(async () => {
            window.dispatchEvent(new Event("omr:teacher-session-identity-changed"));
            finish({ status: "saved", revision: 1, snapshot: controls.save.mock.calls[0][0] });
        });
        expect(controls.success).not.toHaveBeenCalled();
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    function useExistingGroup() {
        controls.session = {
            teacherId: "teacher-qa", organizationId: "org-qa", accountSessionGeneration: 1,
            memberRole: "owner",
        } as TeacherSession;
        controls.load.mockResolvedValue({
            status: "loaded", revision: 0,
            snapshot: { students: [], groups: [{ id: "qa-group", name: "기존 반", region: "서울", color: "#4f46e5", count: 0, avgScore: 0 }], invites: [] },
            meta: { organizationId: "org-qa", loadedAt: new Date().toISOString(), rawCount: 1, parsedCount: 1 },
        });
    }

    it("waits for a group edit to save before closing and reporting success", async () => {
        useExistingGroup();
        let finish!: (value: unknown) => void;
        controls.save.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        render(<ManageUsersPage />);
        fireEvent.click(await screen.findByRole("button", { name: "기존 반 편집" }));
        fireEvent.change(screen.getByRole("textbox", { name: "반 이름" }), { target: { value: "수정한 반" } });
        fireEvent.click(screen.getByRole("button", { name: "저장" }));
        await waitFor(() => expect(controls.save).toHaveBeenCalledTimes(1));
        expect(screen.getByRole("dialog", { name: "반 편집" })).toBeVisible();
        expect(controls.success).not.toHaveBeenCalled();
        await act(async () => finish({ status: "saved", revision: 1, snapshot: controls.save.mock.calls[0][0] }));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(controls.success).toHaveBeenCalledWith("반 정보 저장됨", expect.any(String));
    });

    it("retains student fields after a rejected save and closes only after a successful retry", async () => {
        useExistingGroup();
        let finish!: (value: unknown) => void;
        controls.save.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
        render(<ManageUsersPage />);
        fireEvent.click(await screen.findByRole("button", { name: "기존 반 학생 추가" }));
        fireEvent.change(screen.getByRole("textbox", { name: "학생 이름" }), { target: { value: "검증 학생" } });
        fireEvent.change(screen.getByRole("textbox", { name: "학생 이메일" }), { target: { value: "student-qa@example.invalid" } });
        fireEvent.click(screen.getByRole("button", { name: "추가" }));
        await waitFor(() => expect(controls.save).toHaveBeenCalledTimes(1));
        expect(screen.getByRole("button", { name: "저장 중…" })).toBeDisabled();
        expect(screen.getByRole("dialog", { name: "학생 추가" })).toBeVisible();
        expect(controls.success).not.toHaveBeenCalled();
        await act(async () => finish({ status: "service_unavailable" }));
        expect(screen.getByRole("textbox", { name: "학생 이름" })).toHaveValue("검증 학생");
        expect(screen.getByRole("textbox", { name: "학생 이메일" })).toHaveValue("student-qa@example.invalid");
        expect(controls.success).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole("button", { name: "추가" }));
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        expect(controls.save).toHaveBeenCalledTimes(2);
        expect(controls.success).toHaveBeenCalledWith("학생 추가됨", expect.any(String));
    });
});
