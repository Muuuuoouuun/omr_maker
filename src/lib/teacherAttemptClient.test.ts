import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Attempt } from "@/types/omr";

const actionMocks = vi.hoisted(() => ({
    answer: vi.fn(),
    review: vi.fn(),
    finish: vi.fn(),
    list: vi.fn(),
    load: vi.fn(),
}));
const persistenceMocks = vi.hoisted(() => ({
    saveLocalAttempt: vi.fn(async (attempt: unknown) => attempt !== undefined),
    saveLocalAttempts: vi.fn(async () => true),
    loadAttempt: vi.fn(),
    loadAttempts: vi.fn(),
    readLocalAttempts: vi.fn(() => []),
}));

vi.mock("@/app/actions/teacherAttempts", () => ({
    answerTeacherCanonicalAttemptQuestion: actionMocks.answer,
    setTeacherCanonicalSubquestionReview: actionMocks.review,
    forceFinishTeacherCanonicalAttempts: actionMocks.finish,
    listTeacherCanonicalAttempts: actionMocks.list,
    loadTeacherCanonicalAttempt: actionMocks.load,
}));
vi.mock("@/lib/omrPersistence", () => persistenceMocks);

import {
    answerTeacherAttemptQuestion,
    forceFinishTeacherAttempts,
    setTeacherAttemptSubquestionReview,
} from "./teacherAttemptClient";

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(accept => { resolve = accept; });
    return { promise, resolve };
}

function serialWebLocks() {
    const tails = new Map<string, Promise<void>>();
    return {
        request: async <T>(_name: string, _options: object, operation: () => Promise<T>) => {
            const prior = tails.get(_name) || Promise.resolve();
            let release!: () => void;
            const current = new Promise<void>(done => { release = done; });
            tails.set(_name, prior.then(() => current));
            await prior;
            try {
                return await operation();
            } finally {
                release();
            }
        },
    };
}

const baseAttempt: Attempt = {
    id: "attempt-queue",
    examId: "exam-1",
    examTitle: "시험",
    organizationId: "org-1",
    studentName: "학생",
    startedAt: "2026-07-14T00:00:00.000Z",
    finishedAt: "2026-07-14T00:00:00.000Z",
    score: 0,
    totalScore: 10,
    answers: {},
    status: "in_progress",
    studentQuestions: [
        { questionId: 1, questionNumber: 1, body: "질문", createdAt: "2026-07-14T00:01:00.000Z", status: "queued" },
    ],
    subQuestionAnswers: {
        1: {
            reason: { schemaVersion: 1, body: "답", reviewStatus: "needs_review" },
        },
    },
};

beforeEach(() => {
    vi.clearAllMocks();
    persistenceMocks.saveLocalAttempt.mockResolvedValue(true);
    persistenceMocks.readLocalAttempts.mockReturnValue([]);
    vi.stubGlobal("navigator", { locks: serialWebLocks() });
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("teacher attempt mutation serialization", () => {
    it("serializes different purpose mutations for one attempt through the shared cross-tab lock", async () => {
        const first = deferred<{
            status: "saved";
            attempt: Attempt;
        }>();
        const second = deferred<{
            status: "saved";
            attempt: Attempt;
        }>();
        actionMocks.answer.mockReturnValue(first.promise);
        actionMocks.review.mockReturnValue(second.promise);
        const answered = {
            ...baseAttempt,
            studentQuestions: [{
                ...baseAttempt.studentQuestions![0],
                status: "answered" as const,
                answer: { body: "첫 답변", createdAt: "2026-07-14T00:02:00.000Z", teacherName: "서버 교사" },
            }],
        };
        const reviewed = {
            ...answered,
            subQuestionAnswers: {
                1: {
                    reason: {
                        ...baseAttempt.subQuestionAnswers![1].reason,
                        reviewStatus: "reviewed" as const,
                        reviewedBy: "서버 교사",
                    },
                },
            },
        };

        const answerPromise = answerTeacherAttemptQuestion(baseAttempt, 1, "첫 답변");
        const reviewPromise = setTeacherAttemptSubquestionReview(baseAttempt, 1, "reason", "reviewed");
        await vi.waitFor(() => expect(actionMocks.answer).toHaveBeenCalledTimes(1));
        expect(actionMocks.review).not.toHaveBeenCalled();

        first.resolve({ status: "saved", attempt: answered });
        await answerPromise;
        await vi.waitFor(() => expect(actionMocks.review).toHaveBeenCalledTimes(1));
        second.resolve({ status: "saved", attempt: reviewed });
        await reviewPromise;

        expect(persistenceMocks.saveLocalAttempt.mock.calls.map(call => call[0])).toEqual([
            answered,
            reviewed,
        ]);
    });

    it("keeps answer remote success when the local cache lock rejects", async () => {
        const canonical = {
            ...baseAttempt,
            studentQuestions: [{
                ...baseAttempt.studentQuestions![0],
                status: "answered" as const,
                answer: { body: "서버 답변", createdAt: "2026-07-14T00:02:00.000Z", teacherName: "서버 교사" },
            }],
        };
        actionMocks.answer.mockResolvedValue({ status: "saved", attempt: canonical });
        persistenceMocks.saveLocalAttempt.mockRejectedValueOnce(new Error("cache lock denied"));

        await expect(answerTeacherAttemptQuestion(baseAttempt, 1, "서버 답변")).resolves.toMatchObject({
            remoteSaved: true,
            localCacheSaved: false,
            localSaved: false,
            cacheWarning: "cache lock denied",
            attempt: canonical,
        });
        expect(actionMocks.answer).toHaveBeenCalledTimes(1);
    });

    it("keeps review remote success when the local cache lock rejects", async () => {
        const canonical = {
            ...baseAttempt,
            subQuestionAnswers: {
                1: {
                    reason: {
                        ...baseAttempt.subQuestionAnswers![1].reason,
                        reviewStatus: "reviewed" as const,
                        reviewedBy: "서버 교사",
                    },
                },
            },
        };
        actionMocks.review.mockResolvedValue({ status: "saved", attempt: canonical });
        persistenceMocks.saveLocalAttempt.mockRejectedValueOnce(new Error("cache lock denied"));

        await expect(setTeacherAttemptSubquestionReview(
            baseAttempt,
            1,
            "reason",
            "reviewed",
        )).resolves.toMatchObject({
            remoteSaved: true,
            localCacheSaved: false,
            localSaved: false,
            cacheWarning: "cache lock denied",
            attempt: canonical,
        });
        expect(actionMocks.review).toHaveBeenCalledTimes(1);
    });

    it("uses all-settled cache writes after a successful remote force-finish batch", async () => {
        const second = { ...baseAttempt, id: "attempt-queue-2" };
        const completed = [
            { ...baseAttempt, status: "completed" as const },
            { ...second, status: "completed" as const },
        ];
        actionMocks.finish.mockResolvedValue({ status: "saved", attempts: completed });
        persistenceMocks.saveLocalAttempt
            .mockRejectedValueOnce(new Error("first cache lock denied"))
            .mockResolvedValueOnce(true);

        await expect(forceFinishTeacherAttempts(
            [baseAttempt, second],
            "2026-07-14T00:10:00.000Z",
        )).resolves.toMatchObject({
            remoteSaved: true,
            localCacheSaved: false,
            localSaved: false,
            cacheWarning: "first cache lock denied",
            attempts: completed,
        });
        expect(persistenceMocks.saveLocalAttempt).toHaveBeenCalledTimes(2);
        expect(actionMocks.finish).toHaveBeenCalledTimes(1);
    });
});
