// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const controls = vi.hoisted(() => ({
    router: { push: vi.fn(), replace: vi.fn() },
    issueGuest: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => controls.router }));
vi.mock("@/components/BrandLogo", () => ({ default: () => null }));
vi.mock("@/components/ThemeToggle", () => ({ default: () => null }));
vi.mock("@/app/actions/auth", () => ({ startMockupTeacherSession: vi.fn(), verifyTeacherPassword: vi.fn() }));
vi.mock("@/app/actions/teacherAccount", () => ({
    confirmTeacherSignupEmail: vi.fn(), finishTeacherPasswordReset: vi.fn(),
    requestTeacherPasswordReset: vi.fn(), requestTeacherSignup: vi.fn(),
}));
vi.mock("@/app/actions/studentSession", () => ({
    issueGuestSession: controls.issueGuest,
    issueStudentSession: vi.fn(),
    loadStudentLoginDirectory: vi.fn(),
    refreshStudentSession: async () => ({ ok: false, status: "unauthenticated" }),
}));

import HomePage from "./page";

describe("production student alternate entry feedback", () => {
    beforeEach(() => {
        vi.stubEnv("NODE_ENV", "production");
        window.history.replaceState({}, "", "/?role=student");
        localStorage.clear();
        sessionStorage.clear();
        vi.clearAllMocks();
        controls.issueGuest.mockResolvedValue({ ok: false, status: "error" });
    });
    afterEach(() => { cleanup(); vi.unstubAllEnvs(); });

    it("shows the missing class code error when the student account form is hidden", async () => {
        render(<HomePage />);
        await screen.findByRole("heading", { name: "학습 시작" });
        fireEvent.click(screen.getByText("다른 방법으로 참여"));
        fireEvent.click(screen.getByRole("button", { name: "반 코드로 게스트 시험보기" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("반 코드를 입력해주세요.");
        expect(controls.issueGuest).not.toHaveBeenCalled();
        expect(controls.router.push).not.toHaveBeenCalled();
    });

    it("shows a failed guest session error without pretending to be signed in", async () => {
        render(<HomePage />);
        await screen.findByRole("heading", { name: "학습 시작" });
        fireEvent.click(screen.getByText("다른 방법으로 참여"));
        fireEvent.click(screen.getByRole("button", { name: "코드 없이 게스트로 계속하기" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("게스트 세션을 안전하게 시작하지 못했습니다.");
        expect(controls.router.push).not.toHaveBeenCalled();
        expect(sessionStorage.getItem("omr_student_session")).toBeNull();
    });
});
