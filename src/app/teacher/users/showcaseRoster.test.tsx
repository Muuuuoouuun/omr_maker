// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TeacherSession } from "@/lib/teacherSession";

const controls = vi.hoisted(() => ({
    session: null as TeacherSession | null,
    load: vi.fn(),
    save: vi.fn(),
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
        controls.save.mockResolvedValue({ status: "saved", revision: 1 });
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
    });
});
