import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    queuePendingSubmissionReceipt,
    retryPendingSubmissionReceipt,
} from "./studentAttemptReceipt";

function createStorage(): Storage {
    const data = new Map<string, string>();
    return {
        get length() { return data.size; },
        clear() { data.clear(); },
        getItem(key) { return data.get(key) ?? null; },
        key(index) { return [...data.keys()][index] ?? null; },
        removeItem(key) { data.delete(key); },
        setItem(key, value) { data.set(key, value); },
    } as Storage;
}

const successfulLock = async (
    _name: string,
    _options: object,
    operation: () => Promise<unknown> | unknown,
) => operation();

beforeEach(() => {
    vi.stubGlobal("navigator", { locks: { request: successfulLock } });
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("pending submission retry lock failures", () => {
    it("returns retry feedback when Web Lock acquisition rejects", async () => {
        const storage = createStorage();
        vi.stubGlobal("window", { localStorage: storage });
        await queuePendingSubmissionReceipt({
            attemptId: "attempt-lock-rejected",
            input: {
                examId: "exam-1",
                submissionId: "submission-lock-rejected",
                answers: {},
                startedAt: "2026-07-28T00:00:00.000Z",
            },
        });
        vi.stubGlobal("navigator", {
            locks: { request: async () => { throw new Error("lock denied"); } },
        });
        const submit = vi.fn(async () => ({ status: "ok" }));

        await expect(retryPendingSubmissionReceipt("attempt-lock-rejected", {
            submitSignedSessionAttempt: submit,
        })).resolves.toMatchObject({
            status: "pending",
            error: expect.stringContaining("서버에 아직 반영하지 못했습니다"),
        });

        expect(submit).not.toHaveBeenCalled();
    });

    it("returns retry feedback when the IndexedDB lease lock cannot open", async () => {
        const storage = createStorage();
        vi.stubGlobal("window", { localStorage: storage });
        await queuePendingSubmissionReceipt({
            attemptId: "attempt-idb-lock-rejected",
            input: {
                examId: "exam-1",
                submissionId: "submission-idb-lock-rejected",
                answers: {},
                startedAt: "2026-07-28T00:00:00.000Z",
            },
        });
        vi.stubGlobal("navigator", {});
        const submit = vi.fn(async () => ({ status: "ok" }));

        await expect(retryPendingSubmissionReceipt("attempt-idb-lock-rejected", {
            submitSignedSessionAttempt: submit,
        })).resolves.toMatchObject({
            status: "pending",
            error: expect.stringContaining("서버에 아직 반영하지 못했습니다"),
        });

        expect(submit).not.toHaveBeenCalled();
    });
});
