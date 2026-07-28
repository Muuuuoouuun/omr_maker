import { describe, expect, it, vi } from "vitest";
import {
    flushPendingStudentQuestions,
    pendingStudentQuestionNotesById,
    queuePendingStudentQuestion,
    readPendingStudentQuestions,
    readStudentQuestionOutboxQuarantine,
    STUDENT_QUESTION_OUTBOX_LIMIT,
    type StudentQuestionOutboxLock,
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

function serializedLock(): {
    lock: StudentQuestionOutboxLock;
    names: string[];
} {
    let tail = Promise.resolve();
    const names: string[] = [];
    return {
        names,
        lock: async <T>(name: string, operation: () => Promise<T> | T) => {
            names.push(name);
            const prior = tail;
            let release!: () => void;
            tail = new Promise<void>(resolve => { release = resolve; });
            await prior;
            try {
                await Promise.resolve();
                return await operation();
            } finally {
                release();
            }
        },
    };
}

describe("student question outbox", () => {
    it("persists a normalized pending question before a server retry", async () => {
        const storage = memoryStorage();

        await expect(queuePendingStudentQuestion({
            attemptId: "attempt-1",
            questionId: 2,
            questionNumber: 2,
            body: "  이 풀이가 궁금해요.  ",
            queuedAt: "2026-07-28T12:00:00.000Z",
        }, storage)).resolves.toEqual({ status: "queued" });

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
        await queuePendingStudentQuestion({
            attemptId: "attempt-1",
            questionId: 1,
            questionNumber: 1,
            body: "첫 질문",
            queuedAt: "2026-07-28T12:00:00.000Z",
        }, storage);
        await queuePendingStudentQuestion({
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
            await queuePendingStudentQuestion({
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

    it("serializes multi-tab queue and acknowledgement mutations through the browser lock", async () => {
        const storage = memoryStorage();
        const { lock, names } = serializedLock();
        await Promise.all([
            queuePendingStudentQuestion({
                attemptId: "attempt-1",
                questionId: 1,
                questionNumber: 1,
                body: "첫 탭",
                queuedAt: "2026-07-28T12:00:00.000Z",
            }, storage, lock),
            queuePendingStudentQuestion({
                attemptId: "attempt-1",
                questionId: 2,
                questionNumber: 2,
                body: "둘째 탭",
                queuedAt: "2026-07-28T12:00:01.000Z",
            }, storage, lock),
        ]);

        let releaseSubmit!: () => void;
        const submitGate = new Promise<void>(resolve => { releaseSubmit = resolve; });
        const flush = flushPendingStudentQuestions(
            "attempt-1",
            async () => {
                await submitGate;
                return { status: "ok", attempt: { id: "attempt-1" } };
            },
            storage,
            lock,
        );
        await vi.waitFor(() => expect(names.length).toBeGreaterThanOrEqual(3));
        await queuePendingStudentQuestion({
            attemptId: "attempt-1",
            questionId: 1,
            questionNumber: 1,
            body: "첫 탭에서 수정",
            queuedAt: "2026-07-28T12:00:02.000Z",
        }, storage, lock);
        releaseSubmit();
        await flush;

        expect(new Set(names)).toEqual(new Set(["student-question-outbox"]));
        expect(readPendingStudentQuestions("attempt-1", storage)).toEqual([
            expect.objectContaining({ questionId: 1, body: "첫 탭에서 수정" }),
        ]);
    });

    it("quarantines malformed metadata without copying sensitive raw text or overwriting prior metadata", async () => {
        const storage = memoryStorage();
        storage.setItem("omr_pending_student_questions_v1", '{"body":"PIN 1234 비밀 질문"');
        storage.setItem("omr_pending_student_questions_quarantine_v1", JSON.stringify([{
            reason: "prior",
            detectedAt: "2026-07-27T00:00:00.000Z",
            byteLength: 5,
        }]));

        await expect(queuePendingStudentQuestion({
            attemptId: "attempt-1",
            questionId: 1,
            questionNumber: 1,
            body: "새 질문",
            queuedAt: "2026-07-28T12:00:00.000Z",
        }, storage)).resolves.toEqual({ status: "queued" });

        const quarantine = readStudentQuestionOutboxQuarantine(storage);
        expect(quarantine).toHaveLength(2);
        expect(quarantine[0]).toMatchObject({ reason: "prior" });
        expect(JSON.stringify(quarantine)).not.toContain("1234");
        expect(JSON.stringify(quarantine)).not.toContain("비밀 질문");
    });

    it("returns an explicit capacity failure without dropping the oldest pending question", async () => {
        const storage = memoryStorage();
        for (let index = 0; index < STUDENT_QUESTION_OUTBOX_LIMIT; index += 1) {
            await expect(queuePendingStudentQuestion({
                attemptId: "attempt-1",
                questionId: index,
                questionNumber: index,
                body: `질문 ${index}`,
                queuedAt: new Date(Date.UTC(2026, 6, 28, 0, 0, index)).toISOString(),
            }, storage)).resolves.toEqual({ status: "queued" });
        }

        await expect(queuePendingStudentQuestion({
            attemptId: "attempt-2",
            questionId: 999,
            questionNumber: 999,
            body: "용량 초과 질문",
            queuedAt: "2026-07-28T13:00:00.000Z",
        }, storage)).resolves.toEqual({ status: "capacity_exceeded" });
        expect(readPendingStudentQuestions("attempt-1", storage)).toHaveLength(STUDENT_QUESTION_OUTBOX_LIMIT);
        expect(readPendingStudentQuestions("attempt-1", storage)[0]).toMatchObject({ questionId: 0 });
    });
});
