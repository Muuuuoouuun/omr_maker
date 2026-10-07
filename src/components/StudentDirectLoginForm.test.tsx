// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const login = vi.hoisted(() => vi.fn());
vi.mock("@/app/actions/studentSession", () => ({ loginStudentWithStartCode: login }));
import StudentDirectLoginForm from "./StudentDirectLoginForm";

const identity = { studentId: "student-1", name: "김학생", groupId: "class-1", groupName: "A반" };
beforeEach(() => login.mockReset().mockResolvedValue({ ok: true, status: "ok", identity }));
afterEach(cleanup);
function setup() {
    const onSignedIn = vi.fn();
    render(<StudentDirectLoginForm onSignedIn={onSignedIn} rememberDevice={false} onRememberDeviceChange={vi.fn()} />);
    return onSignedIn;
}
function fillCredentials() {
    fireEvent.change(screen.getByLabelText("학생 로그인 ID"), { target: { value: "student-1" } });
    fireEvent.change(screen.getByLabelText("시작 코드"), { target: { value: "abc234" } });
}
describe("student direct login form", () => {
    it("clears entered credentials when a returning device belongs to another student", () => {
        const forget = vi.fn();
        render(<StudentDirectLoginForm onSignedIn={vi.fn()} rememberDevice returnHintName="김학생" onForgetDevice={forget} onRememberDeviceChange={vi.fn()} />);
        fillCredentials();
        expect(screen.getByRole("status")).toHaveTextContent("김학생님, 다시 오셨네요.");
        fireEvent.click(screen.getByRole("button", { name: "다른 학생이에요" }));
        expect(forget).toHaveBeenCalledOnce();
        expect(screen.getByLabelText("학생 로그인 ID")).toHaveValue("");
        expect(screen.getByLabelText("시작 코드")).toHaveValue("");
        expect(login).not.toHaveBeenCalled();
    });

    it("validates empty input without a server request", async () => {
        setup();
        fireEvent.click(screen.getByRole("button", { name: "내 시험으로 이동" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("학생 로그인 ID와 시작 코드를 입력해주세요.");
        expect(login).not.toHaveBeenCalled();
    });
    it("uses the teacher-issued ID and code and continues after authentication", async () => {
        const onSignedIn = setup();
        fillCredentials();
        expect(screen.getByLabelText("시작 코드")).toHaveAttribute("type", "password");
        fireEvent.click(screen.getByRole("button", { name: "내 시험으로 이동" }));
        await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith(expect.objectContaining({ identity })));
        expect(login).toHaveBeenCalledWith({ studentId: "student-1", startCode: "ABC234", groupId: undefined, guestAttemptIds: [] });
        expect(screen.getByLabelText("시작 코드")).toHaveValue("");
    });
    it("reports invalid credentials and does not continue", async () => {
        login.mockResolvedValue({ ok: false, status: "invalid_credentials" });
        const onSignedIn = setup();
        fillCredentials();
        fireEvent.click(screen.getByRole("button", { name: "내 시험으로 이동" }));
        expect(await screen.findByRole("alert")).toHaveTextContent("학생 로그인 ID와 시작 코드를 확인해주세요.");
        expect(onSignedIn).not.toHaveBeenCalled();
    });
    it("offers only authenticated classes and rechecks the selected class", async () => {
        login.mockResolvedValueOnce({ ok: false, status: "group_required", groups: [{ id: "class-1", name: "A반" }, { id: "class-2", name: "B반" }] });
        const onSignedIn = setup();
        fillCredentials();
        fireEvent.click(screen.getByRole("button", { name: "내 시험으로 이동" }));
        const selector = await screen.findByLabelText("내 반 선택");
        expect(onSignedIn).not.toHaveBeenCalled();
        fireEvent.change(selector, { target: { value: "class-2" } });
        fireEvent.click(screen.getByRole("button", { name: "내 시험으로 이동" }));
        await waitFor(() => expect(login).toHaveBeenLastCalledWith(expect.objectContaining({ groupId: "class-2" })));
        await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1));
    });
    it("disables repeated submission while credentials are being checked", async () => {
        let finish!: (value: unknown) => void;
        login.mockReturnValue(new Promise(resolve => { finish = resolve; }));
        setup();
        fillCredentials();
        fireEvent.click(screen.getByRole("button", { name: "내 시험으로 이동" }));
        expect(screen.getByRole("button", { name: "계정 확인 중…" })).toBeDisabled();
        finish({ ok: false, status: "error" });
        expect(await screen.findByRole("alert")).toHaveTextContent("학생 인증 서버에 연결하지 못했습니다.");
    });
});
