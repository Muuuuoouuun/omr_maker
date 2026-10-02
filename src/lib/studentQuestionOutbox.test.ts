import { describe, expect, it, vi } from "vitest";
import {
    flushPendingStudentQuestions,
    flushPendingStudentQuestionsForStudent,
    pendingStudentQuestionNotesById,
    queuePendingStudentQuestion,
    readPendingStudentQuestions,
    readStudentQuestionOutboxQuarantine,
    STUDENT_QUESTION_OUTBOX_LIMIT,
    type StudentQuestionOutboxLock,
} from "./studentQuestionOutbox";
import type { StudentQuestionInput } from "./studentQuestions";

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
    const tails = new Map<string, Promise<void>>();
    const names: string[] = [];
    return {
        names,
        lock: async <T>(name: string, operation: () => Promise<T> | T) => {
            names.push(name);
            const prior = tails.get(name) || Promise.resolve();
            let release!: () => void;
            const next = new Promise<void>(resolve => { release = resolve; });
            tails.set(name, prior.then(() => next));
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
    it("uses the stable queued timestamp as the client mutation id on every retry", async () => {
        const storage = memoryStorage();
        await queuePendingStudentQuestion({
            attemptId: "attempt-student-a",
            ownerStudentId: "student-a",
            questionId: 1,
            questionNumber: 1,
            body: "재시도 질문",
            queuedAt: "2026-08-07T12:00:00.000Z",
        }, storage);
        const seenMutationIds: unknown[] = [];
        const submit = vi.fn(async (_attemptId: string, question: StudentQuestionInput) => {
            seenMutationIds.push(question.clientMutationId);
            return { status: "error" };
        });

        await flushPendingStudentQuestions("attempt-student-a", submit, storage);
        await flushPendingStudentQuestions("attempt-student-a", submit, storage);

        expect(seenMutationIds).toEqual([
            "2026-08-07T12:00:00.000Z",
            "2026-08-07T12:00:00.000Z",
        ]);
    });

    it("automatically flushes only the active student's scoped questions", async () => {
        const storage = memoryStorage();
        await queuePendingStudentQuestion({
            attemptId: "attempt-student-a",
            ownerStudentId: "student-a",
            questionId: 1,
            questionNumber: 1,
            body: "A 학생 질문",
            queuedAt: "2026-07-28T12:00:00.000Z",
        }, storage);
        await queuePendingStudentQuestion({
            attemptId: "attempt-student-b",
            ownerStudentId: "student-b",
            questionId: 2,
            questionNumber: 2,
            body: "B 학생 질문",
            queuedAt: "2026-07-28T12:01:00.000Z",
        }, storage);
        const submit = vi.fn(async (attemptId: string) => ({
            status: "ok",
            attempt: { id: attemptId },
        }));

        await expect(flushPendingStudentQuestionsForStudent("student-a", submit, storage))
            .resolves.toEqual({ status: "sent", sentCount: 1 });

        expect(submit).toHaveBeenCalledOnce();
        expect(submit).toHaveBeenCalledWith("attempt-student-a", expect.objectContaining({
            body: "A 학생 질문",
        }));
        expect(readPendingStudentQuestions("attempt-student-a", storage)).toEqual([]);
        expect(readPendingStudentQuestions("attempt-student-b", storage)).toEqual([
            expect.objectContaining({ ownerStudentId: "student-b", body: "B 학생 질문" }),
        ]);
    });

    it("does not automatically send legacy unscoped questions under a different active session", async () => {
        const storage = memoryStorage();
        await queuePendingStudentQuestion({
            attemptId: "attempt-legacy",
            questionId: 1,
            questionNumber: 1,
            body: "소유자 정보가 없는 기존 질문",
            queuedAt: "2026-07-28T12:00:00.000Z",
        }, storage);
        const submit = vi.fn();

        await expect(flushPendingStudentQuestionsForStudent("student-b", submit, storage))
            .resolves.toEqual({ status: "empty", sentCount: 0 });

        expect(submit).not.toHaveBeenCalled();
        expect(readPendingStudentQuestions("attempt-legacy", storage)).toHaveLength(1);
    });

    it("serializes concurrent automatic flushes so one queued question is acknowledged once", async () => {
        const storage = memoryStorage();
        const { lock } = serializedLock();
        await queuePendingStudentQuestion({
            attemptId: "attempt-student-a",
            ownerStudentId: "student-a",
            questionId: 1,
            questionNumber: 1,
            body: "한 번만 전송할 질문",
            queuedAt: "2026-07-28T12:00:00.000Z",
        }, storage, lock);
        let releaseSubmit!: () => void;
        const submitGate = new Promise<void>(resolve => { releaseSubmit = resolve; });
        const submit = vi.fn(async (attemptId: string) => {
            await submitGate;
            return { status: "ok", attempt: { id: attemptId } };
        });

        const first = flushPendingStudentQuestionsForStudent("student-a", submit, storage, lock);
        const second = flushPendingStudentQuestionsForStudent("student-a", submit, storage, lock);
        await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
        releaseSubmit();

        await expect(Promise.all([first, second])).resolves.toEqual([
            { status: "sent", sentCount: 1 },
            { status: "empty", sentCount: 0 },
        ]);
        expect(submit).toHaveBeenCalledOnce();
    });

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
