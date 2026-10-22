// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import NotificationBell from "./NotificationBell";

const mocks = vi.hoisted(() => ({ load: vi.fn(), mutate: vi.fn(), localRead: vi.fn(() => []) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/app/actions/teacherNotifications", () => ({
    loadTeacherNotificationSummary: mocks.load, mutateTeacherNotificationState: mocks.mutate,
}));
vi.mock("@/lib/omrPersistence", () => ({ readLocalAttempts: mocks.localRead, readLocalExams: mocks.localRead }));
vi.mock("@/lib/rosterStorage", () => ({
    readRosterGroups: mocks.localRead, readRosterInvites: mocks.localRead, readRosterStudents: mocks.localRead,
}));

function loaded() {
    return { status: "loaded", summary: {
        scopeKey: `scope_${"A".repeat(32)}`, recentCompletedAttemptCount: 2,
        queuedStudentQuestionCount: 0, recentEventVersion: "a".repeat(32), queuedEventVersion: "none",
        notificationStates: [],
    } };
}

describe("notification transport failure recovery", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.load.mockReset();
        localStorage.clear();
    });
    afterEach(() => { cleanup(); vi.restoreAllMocks(); });

    it("handles a rejected refresh through the existing unavailable state and recovers on the next refresh", async () => {
        mocks.load.mockRejectedValueOnce(new TypeError("Load failed")).mockResolvedValue(loaded());
        const getItem = vi.spyOn(Storage.prototype, "getItem");
        const setItem = vi.spyOn(Storage.prototype, "setItem");
        render(<NotificationBell />);
        await waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(1));
        fireEvent.click(screen.getByRole("button", { name: "알림 받기" }));
        expect(await screen.findByText("알림 동기화 확인 불가")).toBeTruthy();
        expect(screen.getByText(/이전 계정의 알림은 표시하지 않습니다/)).toBeTruthy();
        fireEvent(document, new Event("visibilitychange"));
        expect(await screen.findByText("최근 시험 제출")).toBeTruthy();
        expect(screen.queryByText("알림 동기화 확인 불가")).toBeNull();
        expect(mocks.localRead).not.toHaveBeenCalled();
        expect(getItem).not.toHaveBeenCalled();
        expect(setItem).not.toHaveBeenCalled();
    });

    it("does not let an older rejected request replace a newer canonical refresh", async () => {
        let rejectOlder: (error: Error) => void = () => {};
        mocks.load.mockImplementationOnce(() => new Promise((_, reject) => { rejectOlder = reject; }))
            .mockResolvedValue(loaded());
        render(<NotificationBell />);
        await waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(1));
        fireEvent(document, new Event("visibilitychange"));
        await waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(2));
        fireEvent.click(screen.getByRole("button", { name: "알림 (읽지 않음 1개)" }));
        expect(await screen.findByText("최근 시험 제출")).toBeTruthy();
        await act(async () => { rejectOlder(new TypeError("Load failed")); });
        expect(screen.queryByText("알림 동기화 확인 불가")).toBeNull();
        expect(screen.getByText("최근 시험 제출")).toBeTruthy();
        expect(mocks.localRead).not.toHaveBeenCalled();
    });

    it("settles a rejected in-flight refresh after unmount without reading or persisting notification data", async () => {
        let rejectPending: (error: Error) => void = () => {};
        mocks.load.mockImplementationOnce(() => new Promise((_, reject) => { rejectPending = reject; }));
        const setItem = vi.spyOn(Storage.prototype, "setItem");
        const view = render(<NotificationBell />);
        await waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(1));
        view.unmount();
        await act(async () => { rejectPending(new TypeError("Load failed")); });
        expect(mocks.localRead).not.toHaveBeenCalled();
        expect(setItem).not.toHaveBeenCalled();
    });
});
