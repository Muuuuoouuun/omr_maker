import { describe, expect, it, vi } from "vitest";
import {
    flushPendingStudentQuestions,
    pendingStudentQuestionNotesById,
    queuePendingStudentQuestion,
    readPendingStudentQuestions,
} from "./studentQuestionOutbox";

function memoryStorage(): Storage {
    const data = new Map<string, string>();
    return {
        get length() { return data.size; },
        clear() { data.clear(); },
        getItem(key) { return data.get(key) ?? null; },
        key(index) { return [...data.keys()][index] ?? null; },
        removeItem(key) { data.delete(key); },
        setItem(key, value) { data.set(key, value); },
    };
}

describe("student question outbox", () => {
    it("persists a normalized pending question before a server retry", () => {
        const storage = memoryStorage();

        expect(queuePendingStudentQuestion({
            attemptId: "attempt-1",
            questionId: 2,
            questionNumber: 2,
            body: "  이 풀이가 궁금해요.  ",
            queuedAt: "2026-07-28T12:00:00.000Z",
        }, storage)).toBe(true);

        expect(readPendingStudentQuestions("attempt-1", storage)).toEqual([{
            attemptId: "attempt-1",
            questionId: 2,
            questionNumber: 2,
            body: "이 풀이가 궁금해요.",
            queuedAt: "2026-07-28T12:00:00.000Z",
        }]);
        expect(pendingStudentQuestionNotesById("attempt-1", storage)[2]).toMatchObject({
            body: "이 풀이가 궁금해요.",
            status: "queued",
        });
    });

    it("retains only unacknowledged questions across reload when a later retry fails", async () => {
        const storage = memoryStorage();
        queuePendingStudentQuestion({
            attemptId: "attempt-1",
            questionId: 1,
            questionNumber: 1,
            body: "첫 질문",
            queuedAt: "2026-07-28T12:00:00.000Z",
        }, storage);
        queuePendingStudentQuestion({
            attemptId: "attempt-1",
            questionId: 2,
            questionNumber: 2,
            body: "둘째 질문",
            queuedAt: "2026-07-28T12:01:00.000Z",
        }, storage);
        const submit = vi.fn()
            .mockResolvedValueOnce({ status: "ok", attempt: { id: "attempt-1" } })
            .mockResolvedValueOnce({ status: "error" });

        await expect(flushPendingStudentQuestions("attempt-1", submit, storage))
            .resolves.toMatchObject({ status: "retryable_error" });
        expect(submit).toHaveBeenCalledTimes(2);
        expect(readPendingStudentQuestions("attempt-1", storage)).toEqual([
            expect.objectContaining({ questionId: 2, body: "둘째 질문" }),
        ]);
    });

    it("resends the full local union and clears it only after every server acknowledgement", async () => {
        const storage = memoryStorage();
        for (const [questionId, body] of [[1, "첫 질문"], [2, "둘째 질문"]] as const) {
            queuePendingStudentQuestion({
                attemptId: "attempt-1",
                questionId,
                questionNumber: questionId,
                body,
                queuedAt: `2026-07-28T12:0${questionId}:00.000Z`,
            }, storage);
        }
        const canonicalAttempt = { id: "attempt-1", studentQuestions: [{ questionId: 2 }] };
        const submit = vi.fn()
            .mockResolvedValueOnce({ status: "ok", attempt: { id: "attempt-1" } })
            .mockResolvedValueOnce({ status: "ok", attempt: canonicalAttempt });

        await expect(flushPendingStudentQuestions("attempt-1", submit, storage))
            .resolves.toEqual({ status: "sent", attempt: canonicalAttempt });
        expect(submit.mock.calls.map(([, input]) => input.body)).toEqual(["첫 질문", "둘째 질문"]);
        expect(readPendingStudentQuestions("attempt-1", storage)).toEqual([]);
    });
});
