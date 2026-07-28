import { afterEach, describe, expect, it, vi } from "vitest";
import {
    SUBMISSION_RECEIPT_REQUEST_PREFIX,
} from "./studentAttemptReceipt";
import { persistStudentSubmissionDisposition } from "./studentSubmissionDurability";

function storageThatFailsRequestWrites(): Storage {
    const data = new Map<string, string>([["omr_draft_exam_student_base", JSON.stringify({
        submissionId: "submission-large",
        answers: { 1: 2 },
        drawings: "x".repeat(100_000),
    })]]);
    return {
        get length() { return data.size; },
        clear() { data.clear(); },
        getItem(key) { return data.get(key) ?? null; },
        key(index) { return [...data.keys()][index] ?? null; },
        removeItem(key) { data.delete(key); },
        setItem(key, value) {
            if (key.startsWith(SUBMISSION_RECEIPT_REQUEST_PREFIX)) throw new Error("quota");
            data.set(key, value);
        },
    } as Storage;
}

afterEach(() => vi.unstubAllGlobals());

describe("student submission durability gate", () => {
    it("reports non-durable when a large pending replay request cannot be queued", async () => {
        const localStorage = storageThatFailsRequestWrites();
        vi.stubGlobal("window", { localStorage });

        const result = await persistStudentSubmissionDisposition({
            attemptId: "attempt-local",
            receiptStatus: "pending",
            input: {
                examId: "exam-1",
                submissionId: "submission-large",
                answers: { 1: 2 },
                startedAt: "2026-07-28T00:00:00.000Z",
                drawings: { 1: ["x".repeat(100_000)] },
            },
        });

        expect(result).toEqual({
            durable: false,
            error: "제출 재시도 정보를 저장하지 못했습니다. 브라우저 저장 공간을 확보한 뒤 다시 제출해주세요.",
        });
        expect(localStorage.getItem("omr_draft_exam_student_base")).toContain("submission-large");
    });

    it("marks a PIN replay as pending without storing the PIN itself", async () => {
        const data = new Map<string, string>();
        const localStorage = {
            get length() { return data.size; },
            clear() { data.clear(); },
            getItem(key: string) { return data.get(key) ?? null; },
            key(index: number) { return [...data.keys()][index] ?? null; },
            removeItem(key: string) { data.delete(key); },
            setItem(key: string, value: string) { data.set(key, value); },
        } as Storage;
        vi.stubGlobal("window", { localStorage });

        expect(await persistStudentSubmissionDisposition({
            attemptId: "attempt-pin",
            receiptStatus: "pending",
            input: {
                examId: "exam-1",
                submissionId: "submission-pin",
                answers: {},
                startedAt: "2026-07-28T00:00:00.000Z",
            },
            requiresPin: true,
        })).toEqual({ durable: true });
        expect([...data.values()].join("")).not.toContain("2468");
    });
});
