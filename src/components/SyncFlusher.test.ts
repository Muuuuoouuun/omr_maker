import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    cleanup: undefined as undefined | (() => void),
    migrateLegacySubmissionReceipts: vi.fn(),
    pendingSubmissionReceiptIds: vi.fn(),
    legacySubmissionReceiptCleanupDelayMs: vi.fn(),
    flushPendingSubmissionReceipts: vi.fn(),
}));

vi.mock("react", () => ({
    useEffect: (effect: () => void | (() => void)) => {
        state.cleanup = effect() || undefined;
    },
}));

vi.mock("@/app/actions/studentExam", () => ({
    submitAttempt: vi.fn(),
}));

vi.mock("@/lib/studentAttemptReceipt", () => ({
    flushPendingSubmissionReceipts: state.flushPendingSubmissionReceipts,
    isSubmissionReceiptStorageKey: () => false,
    legacySubmissionReceiptCleanupDelayMs: state.legacySubmissionReceiptCleanupDelayMs,
    migrateLegacySubmissionReceipts: state.migrateLegacySubmissionReceipts,
    pendingSubmissionReceiptIds: state.pendingSubmissionReceiptIds,
}));

import SyncFlusher from "./SyncFlusher";

async function flushMicrotasks(): Promise<void> {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

describe("SyncFlusher boot cleanup scheduling", () => {
    let setTimeoutSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.useFakeTimers();
        state.cleanup = undefined;
        state.migrateLegacySubmissionReceipts.mockReset();
        state.pendingSubmissionReceiptIds.mockReset().mockReturnValue([]);
        state.legacySubmissionReceiptCleanupDelayMs.mockReset().mockReturnValue(null);
        state.flushPendingSubmissionReceipts.mockReset().mockResolvedValue(0);
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
});
