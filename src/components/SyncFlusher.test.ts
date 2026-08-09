import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    cleanup: undefined as undefined | (() => void),
    currentStudentId: "student-a" as string | null,
    migrateLegacySubmissionReceipts: vi.fn(),
    pendingSubmissionReceiptIds: vi.fn(),
    legacySubmissionReceiptCleanupDelayMs: vi.fn(),
    flushPendingSubmissionReceipts: vi.fn(),
    flushPendingStudentQuestionsForStudent: vi.fn(),
    maintainSecureSubmissionOutbox: vi.fn(),
    replaySecureSubmissionsForOwner: vi.fn(),
    secureSubmissionOwnerFingerprint: vi.fn(),
    readSecureSubmissionRecoveryNotices: vi.fn(),
    acknowledgeSecureSubmissionRecoveryNotice: vi.fn(),
    toastAction: vi.fn(),
}));

vi.mock("react", () => ({
    useEffect: (effect: () => void | (() => void)) => {
        state.cleanup = effect() || undefined;
    },
}));

vi.mock("@/app/actions/studentExam", () => ({
    askAttemptQuestion: vi.fn(),
    submitAttempt: vi.fn(),
}));

vi.mock("@/app/actions/studentAttemptSession", () => ({
    checkpointDurableStudentAttemptSession: vi.fn(),
    resolveLegacyDurableStudentAttemptSessionScope: vi.fn(),
    submitDurableStudentAttemptSession: vi.fn(),
}));

vi.mock("@/lib/studentAttemptReceipt", () => ({
    flushPendingSubmissionReceipts: state.flushPendingSubmissionReceipts,
    isSubmissionReceiptStorageKey: () => false,
    legacySubmissionReceiptCleanupDelayMs: state.legacySubmissionReceiptCleanupDelayMs,
    migrateLegacySubmissionReceipts: state.migrateLegacySubmissionReceipts,
    pendingSubmissionReceiptIds: state.pendingSubmissionReceiptIds,
}));

vi.mock("@/lib/studentQuestionOutbox", () => ({
    flushPendingStudentQuestionsForStudent: state.flushPendingStudentQuestionsForStudent,
    isStudentQuestionOutboxStorageKey: () => false,
}));

vi.mock("@/lib/studentSecureSubmissionOutbox", () => ({
    acknowledgeSecureSubmissionRecoveryNotice: state.acknowledgeSecureSubmissionRecoveryNotice,
    maintainSecureSubmissionOutbox: state.maintainSecureSubmissionOutbox,
    readSecureSubmissionRecoveryNotices: state.readSecureSubmissionRecoveryNotices,
    replaySecureSubmissionsForOwner: state.replaySecureSubmissionsForOwner,
    secureSubmissionOwnerFingerprint: state.secureSubmissionOwnerFingerprint,
}));

vi.mock("@/components/Toast", () => ({
    toast: { action: state.toastAction },
}));

vi.mock("@/utils/storage", () => ({
    getSession: () => state.currentStudentId ? { studentId: state.currentStudentId } : null,
    STUDENT_SESSION_CHANGED_EVENT: "omr:student-session-changed",
}));

import SyncFlusher from "./SyncFlusher";

async function flushMicrotasks(): Promise<void> {
    for (let index = 0; index < 16; index += 1) await Promise.resolve();
}

describe("SyncFlusher boot cleanup scheduling", () => {
    let setTimeoutSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.useFakeTimers();
        state.cleanup = undefined;
        state.currentStudentId = "student-a";
        state.migrateLegacySubmissionReceipts.mockReset();
        state.pendingSubmissionReceiptIds.mockReset().mockReturnValue([]);
        state.legacySubmissionReceiptCleanupDelayMs.mockReset().mockReturnValue(null);
        state.flushPendingSubmissionReceipts.mockReset().mockResolvedValue(0);
        state.flushPendingStudentQuestionsForStudent.mockReset()
            .mockResolvedValue({ status: "empty", sentCount: 0 });
        state.maintainSecureSubmissionOutbox.mockReset()
            .mockResolvedValue({ expiredCount: 0, invalidCount: 0 });
        state.replaySecureSubmissionsForOwner.mockReset()
            .mockResolvedValue({ status: "empty", submitted: [] });
        state.secureSubmissionOwnerFingerprint.mockReset()
            .mockResolvedValue("a".repeat(64));
        state.readSecureSubmissionRecoveryNotices.mockReset().mockResolvedValue([]);
        state.acknowledgeSecureSubmissionRecoveryNotice.mockReset().mockResolvedValue(true);
        state.toastAction.mockReset();
        setTimeoutSpy = vi.fn((handler: TimerHandler, delay?: number) => (
            globalThis.setTimeout(handler, delay) as unknown as number
        ));
        vi.stubGlobal("window", {
            localStorage: {},
            setTimeout: setTimeoutSpy,
            clearTimeout: (timer: number) => globalThis.clearTimeout(timer),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        });
        vi.stubGlobal("document", {
            visibilityState: "visible",
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        });
    });

    afterEach(() => {
        state.cleanup?.();
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it("backs off and retries when first-boot maintenance fails before a cleanup candidate exists", async () => {
        state.migrateLegacySubmissionReceipts
            .mockRejectedValueOnce(new Error("Web Lock, IndexedDB, or crypto unavailable"))
            .mockResolvedValueOnce(true);

        SyncFlusher();
        await flushMicrotasks();

        expect(state.migrateLegacySubmissionReceipts).toHaveBeenCalledTimes(1);
        expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 250);

        await vi.advanceTimersByTimeAsync(249);
        expect(state.migrateLegacySubmissionReceipts).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        await flushMicrotasks();

        expect(state.migrateLegacySubmissionReceipts).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
    });

    it("does not schedule a timer after successful maintenance without a cleanup candidate", async () => {
        state.migrateLegacySubmissionReceipts.mockResolvedValue(true);

        SyncFlusher();
        await flushMicrotasks();

        expect(state.migrateLegacySubmissionReceipts).toHaveBeenCalledOnce();
        expect(setTimeoutSpy).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it("automatically flushes the active student's questions on boot and online recovery", async () => {
        SyncFlusher();
        await flushMicrotasks();

        expect(state.flushPendingStudentQuestionsForStudent).toHaveBeenCalledTimes(1);
        expect(state.flushPendingStudentQuestionsForStudent).toHaveBeenLastCalledWith(
            "student-a",
            expect.any(Function),
        );

        const onlineListener = vi.mocked(window.addEventListener).mock.calls
            .find(([event]) => event === "online")?.[1] as EventListener;
        onlineListener(new Event("online"));
        await flushMicrotasks();

        expect(state.flushPendingStudentQuestionsForStudent).toHaveBeenCalledTimes(2);
    });

    it("re-reads the active identity on session changes and never flushes without a session", async () => {
        state.currentStudentId = null;
        SyncFlusher();
        await flushMicrotasks();
        expect(state.flushPendingStudentQuestionsForStudent).not.toHaveBeenCalled();

        state.currentStudentId = "student-b";
        const sessionListener = vi.mocked(window.addEventListener).mock.calls
            .find(([event]) => event === "omr:student-session-changed")?.[1] as EventListener;
        sessionListener(new Event("omr:student-session-changed"));
        await flushMicrotasks();

        expect(state.flushPendingStudentQuestionsForStudent).toHaveBeenCalledOnce();
        expect(state.flushPendingStudentQuestionsForStudent).toHaveBeenCalledWith(
            "student-b",
            expect.any(Function),
        );
    });

    it("maintains and replays the secure IndexedDB submission outbox on boot and online recovery", async () => {
        SyncFlusher();
        await flushMicrotasks();

        expect(state.maintainSecureSubmissionOutbox).toHaveBeenCalledOnce();
        expect(state.secureSubmissionOwnerFingerprint).toHaveBeenCalledWith("student-a");
        expect(state.replaySecureSubmissionsForOwner).toHaveBeenCalledWith(
            "a".repeat(64),
            expect.objectContaining({ resolveLegacyScope: expect.any(Function), checkpoint: expect.any(Function), submit: expect.any(Function) }),
        );

        const onlineListener = vi.mocked(window.addEventListener).mock.calls
            .find(([event]) => event === "online")?.[1] as EventListener;
        onlineListener(new Event("online"));
        await flushMicrotasks();
        expect(state.replaySecureSubmissionsForOwner).toHaveBeenCalledTimes(2);
    });

    it("shows and acknowledges persisted non-sensitive recovery notices", async () => {
        state.readSecureSubmissionRecoveryNotices.mockResolvedValueOnce([{
            id: "notice-1",
            kind: "expired",
            sessionId: "session-1",
            createdAt: "2026-08-07T12:00:00.000Z",
        }]);

        SyncFlusher();
        await flushMicrotasks();

        expect(state.toastAction).toHaveBeenCalledWith(
            "error",
            "제출 재시도 기한 만료",
            expect.stringContaining("선생님에게 문의"),
            expect.objectContaining({ actionLabel: "확인", onAction: expect.any(Function) }),
        );
        expect(state.acknowledgeSecureSubmissionRecoveryNotice).not.toHaveBeenCalled();
        const options = state.toastAction.mock.calls[0][3] as { onAction: () => void };
        options.onAction();
        await flushMicrotasks();
        expect(state.acknowledgeSecureSubmissionRecoveryNotice).toHaveBeenCalledWith("notice-1");
    });

    it("describes quarantined legacy answers honestly without claiming deletion", async () => {
        state.readSecureSubmissionRecoveryNotices.mockResolvedValueOnce([{
            id: "notice-legacy",
            kind: "legacy_recovery_required",
            sessionId: "session-legacy",
            createdAt: "2026-08-07T12:00:00.000Z",
        }]);
        SyncFlusher();
        await flushMicrotasks();
        expect(state.toastAction).toHaveBeenCalledWith(
            "error",
            "이전 제출 복구 필요",
            expect.stringContaining("답안은 보관 중"),
            expect.any(Object),
        );
        expect(state.toastAction.mock.calls.at(-1)?.[2]).not.toContain("정리했습니다");
    });
});
