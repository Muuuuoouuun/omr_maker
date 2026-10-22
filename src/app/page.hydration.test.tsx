// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureExamEntryInviteFragment, readExamEntryInviteHandoff } from "@/lib/examEntryInviteHandoff";

const mocks = vi.hoisted(() => ({
  directory: vi.fn(),
  refresh: vi.fn(),
  router: { push: vi.fn(), replace: vi.fn() },
}));
vi.mock("next/navigation", () => ({ useRouter: () => mocks.router }));
vi.mock("@/components/BrandLogo", () => ({ default: () => <span>OMR Maker</span> }));
vi.mock("@/components/ThemeToggle", () => ({ default: () => null }));
vi.mock("@/app/actions/auth", () => ({ startMockupTeacherSession: vi.fn(), verifyTeacherPassword: vi.fn() }));
vi.mock("@/app/actions/teacherAccount", () => ({
  confirmTeacherSignupEmail: vi.fn(), finishTeacherPasswordReset: vi.fn(),
  requestTeacherPasswordReset: vi.fn(), requestTeacherSignup: vi.fn(),
}));
vi.mock("@/app/actions/studentSession", () => ({
  issueGuestSession: vi.fn(), issueStudentSession: vi.fn(), loginStudentWithStartCode: vi.fn(),
  loadStudentLoginDirectory: mocks.directory, refreshStudentSession: mocks.refresh,
}));
import Home from "./page";

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState(null, "", "/?role=student&exam=exam-a");
  mocks.directory.mockResolvedValue({ status: "ok", groups: [{ id: "class-a", name: "A반", region: "서울" }] });
  mocks.refresh.mockResolvedValue({ ok: false });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("home browser-state hydration", () => {
  it("preserves a scoped invite handoff and loads its directory once", async () => {
    const token = "A".repeat(43);
    captureExamEntryInviteFragment({ examId: "exam-a", hash: `#invite=${token}`, pathname: "/solve/exam-a",
      search: "", storage: sessionStorage, replaceUrl: vi.fn() });
    render(<Home />);
    await waitFor(() => expect(mocks.directory).toHaveBeenCalledExactlyOnceWith({ examId: "exam-a", inviteToken: token }));
    expect(await screen.findByRole("option", { name: "A반 · 서울" })).toBeInTheDocument();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("keeps provisioned teacher recovery dominant over a stored student invite", async () => {
    const token = "B".repeat(43);
    captureExamEntryInviteFragment({ examId: "exam-a", hash: `#invite=${token}`, pathname: "/solve/exam-a",
      search: "", storage: sessionStorage, replaceUrl: vi.fn() });
    window.history.replaceState(null, "", "/?role=student&exam=exam-a&teacherResetToken=legacy-token");
    // jsdom reports its unimplemented full-document navigation to console.
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<Home />);
    await waitFor(() => expect(document.querySelector("[data-home-role]"))
      .toHaveAttribute("data-home-role", "teacher"));
    expect(mocks.directory).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(readExamEntryInviteHandoff(sessionStorage, "exam-a")).toBe(token);
  });

  it("keeps credential login usable when browser storage is blocked", async () => {
    window.history.replaceState(null, "", "/?role=student");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("Blocked", "SecurityError"); });
    render(<Home />);
    expect(await screen.findByLabelText("학생 로그인 ID")).toBeEnabled();
    expect(screen.getByRole("button", { name: "내 시험으로 이동" })).toBeEnabled();
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
  });
});
