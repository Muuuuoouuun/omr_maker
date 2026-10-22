// @vitest-environment jsdom
import React from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot, type Root } from "react-dom/client";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import StudentGuestRecoveryPanel from "./StudentGuestRecoveryPanel";

const mocks = vi.hoisted(() => ({ retry: vi.fn(), session: vi.fn(), merge: vi.fn() }));
vi.mock("@/app/actions/studentSession", () => ({ retryGuestServerClaims: mocks.retry }));
vi.mock("@/utils/storage", () => ({
    getSession: mocks.session,
    mergeGuestAttempts: mocks.merge,
    STUDENT_SESSION_CHANGED_EVENT: "omr:student-session-changed",
}));

const attempt = { id: "guest-attempt", guestId: "guest-one", studentId: "guest:guest-one", identityType: "guest" };
function notifyStorageChange(key: string) {
    act(() => { window.dispatchEvent(new StorageEvent("storage", { key, storageArea: localStorage })); });
}

describe("guest recovery browser store", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        localStorage.clear();
        localStorage.setItem("omr_pending_guest_merge", JSON.stringify({ guestId: "guest-one", queuedAt: "2026-10-17T00:00:00Z" }));
        localStorage.setItem("omr_attempts", JSON.stringify([attempt]));
        mocks.session.mockReturnValue({ studentId: "student-one", name: "학생", isGuest: false });
        mocks.retry.mockResolvedValue({ status: "error", error: "서버 연결 실패" });
        vi.stubGlobal("navigator", {
            locks: { request: async (_name: string, _options: object, operation: () => Promise<unknown>) => operation() },
        });
    });
    afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

    it("hydrates the server's empty snapshot before displaying local recovery records", async () => {
        const markup = renderToString(<StudentGuestRecoveryPanel />);
        expect(markup).toBe("");
        const container = document.createElement("div");
        container.innerHTML = markup;
        document.body.append(container);
        const consoleError = vi.spyOn(console, "error");
        let root: Root | undefined;
        try {
            await act(async () => { root = hydrateRoot(container, <StudentGuestRecoveryPanel />); });
            expect(screen.getByText(/서버 소유권 확인 대기 1건/)).toBeTruthy();
            expect(consoleError).not.toHaveBeenCalled();
            expect(mocks.retry).not.toHaveBeenCalled();
        } finally {
            await act(async () => { root?.unmount(); });
            container.remove();
        }
    });

    it("updates cached recovery state when another tab changes or clears local records", () => {
        render(<StudentGuestRecoveryPanel />);
        expect(screen.getByText(/서버 소유권 확인 대기 1건/)).toBeTruthy();
        localStorage.setItem("omr_attempts", JSON.stringify([attempt, { ...attempt, id: "second-attempt" }]));
        notifyStorageChange("omr_attempts");
        expect(screen.getByText(/서버 소유권 확인 대기 2건/)).toBeTruthy();
        localStorage.setItem("omr_pending_guest_merge", "{broken");
        notifyStorageChange("omr_pending_guest_merge");
        expect(screen.getByText(/복구 표식 손상 감지/)).toBeTruthy();
        localStorage.removeItem("omr_pending_guest_merge");
        notifyStorageChange("omr_pending_guest_merge");
        expect(screen.queryByRole("region", { name: "미검증 로컬 기록 복구" })).toBeNull();
    });

    it("keeps unverified local records separate when the server cannot acknowledge them", async () => {
        render(<StudentGuestRecoveryPanel />);
        fireEvent.click(screen.getByRole("button", { name: "서버 소유 기록 다시 확인" }));
        await screen.findByText(/서버가 소유권을 확인한 기록이 없습니다/);
        expect(mocks.retry).toHaveBeenCalledExactlyOnceWith(["guest-attempt"]);
        expect(mocks.merge).not.toHaveBeenCalled();
        expect(JSON.parse(localStorage.getItem("omr_attempts")!)).toEqual([attempt]);
        expect(screen.getByText(/서버 소유권 확인 대기 1건/)).toBeTruthy();
    });

    it("refreshes the same tab after an explicitly confirmed discard", async () => {
        vi.spyOn(window, "confirm").mockReturnValue(true);
        render(<StudentGuestRecoveryPanel />);
        fireEvent.click(screen.getByRole("button", { name: "로컬 기록 폐기" }));
        await waitFor(() => expect(screen.queryByRole("region", { name: "미검증 로컬 기록 복구" })).toBeNull());
        expect(localStorage.getItem("omr_pending_guest_merge")).toBeNull();
        expect(localStorage.getItem("omr_attempts")).toBeNull();
    });
});
