// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => {
    const router = { push: vi.fn(), replace: vi.fn() };
    return { ...router, router, refresh: vi.fn(), login: vi.fn() };
});
vi.mock("next/navigation", () => ({ useRouter: () => mocks.router }));
vi.mock("@/components/TeacherIdentityModeProvider", () => ({ useTeacherIdentityMode: () => "provisioned" }));
vi.mock("@/app/actions/auth", () => ({ startMockupTeacherSession: vi.fn(), verifyTeacherPassword: vi.fn() }));
vi.mock("@/app/actions/teacherAccount", () => ({
    confirmTeacherSignupEmail: vi.fn(), finishTeacherPasswordReset: vi.fn(),
    requestTeacherPasswordReset: vi.fn(), requestTeacherSignup: vi.fn(),
}));
vi.mock("@/app/actions/studentSession", () => ({
    refreshStudentSession: mocks.refresh, loginStudentWithStartCode: mocks.login,
    issueGuestSession: vi.fn(), issueStudentSession: vi.fn(), loadStudentLoginDirectory: vi.fn(),
}));
import Home from "./page";
import { getSession } from "@/utils/storage";

beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    window.history.replaceState(null, "", "/?role=student");
    mocks.push.mockReset();
    mocks.replace.mockReset();
    mocks.refresh.mockReset().mockResolvedValue({ ok: false, status: "unauthenticated" });
    mocks.login.mockReset().mockResolvedValue({ ok: true, status: "ok", identity: {
        studentId: "student-1", name: "김학생", groupId: "class-1", groupName: "A반",
    } });
});
afterEach(cleanup);

describe("bare student entry", () => {
    it("keeps direct login available after a guest exam in another scoped class", async () => {
        mocks.refresh.mockResolvedValue({ ok: true, status: "ok", canLoginWithCurrentScope: true, session: {
            studentId: "guest:guest-1", name: "게스트", guestId: "guest-1", isGuest: true,
            identityType: "guest", groupId: "foreign-class", groupName: "다른 반",
        } });
        render(<Home />);
        await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
        expect(await screen.findByLabelText("학생 로그인 ID")).toBeVisible();
        expect(screen.queryByLabelText("이름")).not.toBeInTheDocument();
        expect(screen.queryByText("다른 반")).not.toBeInTheDocument();
    });

    it("stores the authenticated identity and opens the student's own exam list", async () => {
        render(<Home />);
        fireEvent.change(await screen.findByLabelText("학생 로그인 ID"), { target: { value: "student-1" } });
        fireEvent.change(screen.getByLabelText("시작 코드"), { target: { value: "ABC234" } });
        fireEvent.click(screen.getByRole("button", { name: "내 시험으로 이동" }));
        await waitFor(() => expect(mocks.push).toHaveBeenCalledWith("/student/dashboard"));
        expect(getSession()).toMatchObject({ studentId: "student-1", groupId: "class-1", identityType: "registered", isGuest: false });
    });

    it("restores a signed student session directly to the safe requested page", async () => {
        window.history.replaceState(null, "", "/?role=student&next=%2Fstudent%2Fhistory");
        mocks.refresh.mockResolvedValue({ ok: true, status: "ok", session: {
            studentId: "student-1", name: "김학생", groupId: "class-1", groupName: "A반",
            isGuest: false, identityType: "registered",
        } });
        render(<Home />);
        await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/student/history"));
        expect(getSession()).toMatchObject({ studentId: "student-1", identityType: "registered" });
    });
});
