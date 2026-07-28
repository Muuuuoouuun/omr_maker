import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
    migrateLegacySubmissionReceipts,
    pendingSubmissionReceiptIds,
    SUBMISSION_RECEIPT_ENTRY_PREFIX,
    SUBMISSION_RECEIPT_REQUEST_PREFIX,
} from "./studentAttemptReceipt";
import { maintainAndFlushPendingSubmissionReceipts } from "./studentSubmissionFlush";

function createStorage(initial: Record<string, string> = {}): Storage {
    const data = new Map(Object.entries(initial));
    return {
        get length() { return data.size; },
        clear() { data.clear(); },
        getItem(key) { return data.get(key) ?? null; },
        key(index) { return [...data.keys()][index] ?? null; },
        removeItem(key) { data.delete(key); },
        setItem(key, value) { data.set(key, value); },
    } as Storage;
}

beforeEach(() => {
    vi.stubGlobal("navigator", {
        locks: {
            request: async (
                _name: string,
                _options: object,
                operation: () => Promise<unknown> | unknown,
            ) => operation(),
        },
    });
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("submission replay boot maintenance", () => {
    it("maintains malformed legacy PIN data before discovering that there is nothing to replay", async () => {
        const raw = '{"requests":{"attempt-pin":{"pin":"TOP-SECRET-2468"';
        const storage = createStorage({
            omr_student_submission_receipts_v1: raw,
        });
        vi.stubGlobal("window", { localStorage: storage });
        const flushPendingReceipts = vi.fn(async () => 0);

        await maintainAndFlushPendingSubmissionReceipts(
            flushPendingReceipts,
            {
                migrateLegacySubmissionReceipts,
                pendingSubmissionReceiptIds,
                legacySubmissionReceiptCleanupDelayMs: () => null,
            },
        );

        expect(flushPendingReceipts).not.toHaveBeenCalled();
        expect(pendingSubmissionReceiptIds({ automaticOnly: true })).toEqual([]);
        const maintenanceMetadata = [...Array(storage.length)]
            .flatMap((_, index) => {
                const key = storage.key(index) || "";
                if (key === "omr_student_submission_receipts_v1") return [];
                return [key, storage.getItem(key) || ""];
            })
            .join("");
        expect(maintenanceMetadata).toContain('"sourceKind":"legacy"');
        expect(maintenanceMetadata).not.toContain("TOP-SECRET-2468");
    });

    it("migrates a valid legacy pending request before replaying it", async () => {
        const attemptId = "attempt-boot-replay";
        const storage = createStorage({
            omr_student_submission_receipts_v1: JSON.stringify({
                receipts: {
                    [attemptId]: {
                        attemptId,
                        status: "pending",
                        updatedAt: "2026-07-28T00:00:00.000Z",
                    },
                },
                requests: {
                    [attemptId]: {
                        attemptId,
                        input: {
                            examId: "exam-1",
                            submissionId: "submission-boot-replay",
                            answers: {},
                            startedAt: "2026-07-28T00:00:00.000Z",
                        },
                    },
                },
            }),
        });
        vi.stubGlobal("window", { localStorage: storage });
        const flushPendingReceipts = vi.fn(async () => {
            expect(storage.getItem(
                `${SUBMISSION_RECEIPT_ENTRY_PREFIX}${encodeURIComponent(attemptId)}`,
            )).not.toBeNull();
            expect(storage.getItem(
                `${SUBMISSION_RECEIPT_REQUEST_PREFIX}${encodeURIComponent(attemptId)}`,
            )).not.toBeNull();
            return 0;
        });

        await maintainAndFlushPendingSubmissionReceipts(
            flushPendingReceipts,
            {
                migrateLegacySubmissionReceipts,
                pendingSubmissionReceiptIds,
                legacySubmissionReceiptCleanupDelayMs: () => null,
            },
        );

        expect(flushPendingReceipts).toHaveBeenCalledOnce();
    });

    it("continues discovery and replay when legacy maintenance rejects", async () => {
        const calls: string[] = [];
        const flushPendingReceipts = vi.fn(async () => {
            calls.push("flush");
            return 0;
        });

        await expect(maintainAndFlushPendingSubmissionReceipts(
            flushPendingReceipts,
            {
                migrateLegacySubmissionReceipts: async () => {
                    calls.push("maintenance");
                    throw new Error("storage lock unavailable");
                },
                pendingSubmissionReceiptIds: () => {
                    calls.push("pending");
                    return ["attempt-existing-v2"];
                },
                legacySubmissionReceiptCleanupDelayMs: () => {
                    calls.push("cleanup-delay");
                    return 25;
                },
            },
        )).resolves.toBe(25);

        expect(calls).toEqual([
            "maintenance",
            "cleanup-delay",
            "pending",
            "flush",
        ]);
    });

    it("contains replay failures and still returns the cleanup follow-up delay", async () => {
        await expect(maintainAndFlushPendingSubmissionReceipts(
            async () => {
                throw new Error("offline");
            },
            {
                migrateLegacySubmissionReceipts: async () => true,
                pendingSubmissionReceiptIds: () => ["attempt-pending"],
                legacySubmissionReceiptCleanupDelayMs: () => 40,
            },
        )).resolves.toBe(40);
    });

    it("still discovers and replays pending work if cleanup scheduling cannot be read", async () => {
        const flushPendingReceipts = vi.fn(async () => 0);

        await expect(maintainAndFlushPendingSubmissionReceipts(
            flushPendingReceipts,
            {
                migrateLegacySubmissionReceipts: async () => true,
                pendingSubmissionReceiptIds: () => ["attempt-pending"],
                legacySubmissionReceiptCleanupDelayMs: () => {
                    throw new Error("bad clock");
                },
            },
        )).resolves.toBeNull();

        expect(flushPendingReceipts).toHaveBeenCalledOnce();
    });
});
