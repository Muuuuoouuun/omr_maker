import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Attempt } from "@/types/omr";

const actionMocks = vi.hoisted(() => ({
    answer: vi.fn(),
    review: vi.fn(),
    finish: vi.fn(),
    list: vi.fn(),
    summaries: vi.fn(),
    load: vi.fn(),
}));
const persistenceMocks = vi.hoisted(() => ({
    saveLocalAttempt: vi.fn(async (attempt: unknown) => attempt !== undefined),
    saveLocalAttempts: vi.fn(async () => true),
    loadAttempt: vi.fn(),
    loadAttempts: vi.fn(),
    readLocalAttempts: vi.fn((): Attempt[] => []),
}));

vi.mock("@/app/actions/teacherAttempts", () => ({
    answerTeacherCanonicalAttemptQuestion: actionMocks.answer,
    setTeacherCanonicalSubquestionReview: actionMocks.review,
    forceFinishTeacherCanonicalAttempts: actionMocks.finish,
    listTeacherCanonicalAttemptSummaries: actionMocks.summaries,
    listTeacherCanonicalAttempts: actionMocks.list,
    loadTeacherCanonicalAttempt: actionMocks.load,
}));
vi.mock("@/lib/omrPersistence", () => persistenceMocks);

import {
    answerTeacherAttemptQuestion,
    forceFinishTeacherAttempts,
    loadTeacherAttemptSummaries,
    loadTeacherAttempts,
    setTeacherAttemptSubquestionReview,
} from "./teacherAttemptClient";
import * as teacherAttemptClient from "./teacherAttemptClient";

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
    persistenceMocks.loadAttempts.mockResolvedValue({ items: [], remoteLoaded: false });
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

describe("teacher attempt read fallback", () => {
    it("preserves not-found, authorization, and transport failures for the detail surface", async () => {
        const loadDetail = (teacherAttemptClient as Record<string, unknown>).loadTeacherAttemptDetail;
        expect(loadDetail).toBeTypeOf("function");
        if (typeof loadDetail !== "function") return;

        actionMocks.load.mockResolvedValueOnce({ status: "not_found" });
        await expect(loadDetail("missing")).resolves.toEqual({ status: "not_found" });

        actionMocks.load.mockResolvedValueOnce({ status: "unauthorized" });
        await expect(loadDetail("attempt-queue")).resolves.toEqual({
            status: "unauthorized",
            error: "Teacher server session is missing",
        });

        actionMocks.load.mockResolvedValueOnce({ status: "service_unavailable", error: "gateway offline" });
        await expect(loadDetail("attempt-queue")).resolves.toEqual({
            status: "service_unavailable",
            error: "gateway offline",
        });
    });

    it("loads common workspace rows through the lightweight summary action", async () => {
        const summary = { ...baseAttempt, detailLevel: "summary" as const, answers: {} };
        actionMocks.summaries.mockResolvedValue({ status: "loaded", attempts: [summary] });

        await expect(loadTeacherAttemptSummaries()).resolves.toMatchObject({
            items: [{ id: baseAttempt.id, detailLevel: "summary", answers: {} }],
            remoteLoaded: true,
        });
        expect(actionMocks.summaries).toHaveBeenCalledTimes(1);
        expect(actionMocks.list).not.toHaveBeenCalled();
    });

    it("propagates partial page metadata without turning usable recent rows into a transport failure", async () => {
        const summary = { ...baseAttempt, detailLevel: "summary" as const, answers: {} };
        actionMocks.summaries.mockResolvedValue({
            status: "loaded",
            attempts: [summary],
            page: {
                partial: true,
                hasMore: true,
                itemCount: 1,
                nextCursor: { finishedAt: summary.finishedAt, id: summary.id },
            },
        });

        await expect(loadTeacherAttemptSummaries()).resolves.toMatchObject({
            items: [{ id: baseAttempt.id }],
            remoteLoaded: true,
            remoteSynced: false,
            remotePartial: true,
            remoteHasMore: true,
            remoteItemCount: 1,
            remoteNextCursor: { finishedAt: summary.finishedAt, id: summary.id },
        });
    });

    it("fails closed instead of returning prior-account cache when the authenticated server read fails", async () => {
        actionMocks.list.mockResolvedValue({ status: "service_unavailable", error: "offline" });
        persistenceMocks.readLocalAttempts.mockReturnValue([{ ...baseAttempt, id: "prior-account" }]);

        await expect(loadTeacherAttempts()).resolves.toMatchObject({
            items: [],
            remoteLoaded: false,
            remoteError: "offline",
        });
        expect(persistenceMocks.readLocalAttempts).not.toHaveBeenCalled();
    });

    it("keeps the explicitly local-only development flow", async () => {
        actionMocks.list.mockResolvedValue({ status: "local_only" });
        persistenceMocks.loadAttempts.mockResolvedValue({
            items: [{ ...baseAttempt, id: "local-development" }],
            remoteLoaded: false,
        });

        await expect(loadTeacherAttempts()).resolves.toMatchObject({
            items: [{ id: "local-development" }],
            remoteLoaded: false,
        });
        expect(persistenceMocks.loadAttempts).toHaveBeenCalledTimes(1);
    });

    it("does not let a workspace summary mutate full attempt caches", async () => {
        const full = { ...baseAttempt, subQuestionAnswers: baseAttempt.subQuestionAnswers };
        const summary = { ...baseAttempt, subQuestionAnswers: undefined, score: 5 };
        actionMocks.list.mockResolvedValue({ status: "loaded", attempts: [summary] });
        persistenceMocks.readLocalAttempts.mockReturnValue([full]);

        await expect(loadTeacherAttempts()).resolves.toMatchObject({ items: [summary], remoteLoaded: true });
        expect(persistenceMocks.saveLocalAttempts).not.toHaveBeenCalled();
        expect(persistenceMocks.readLocalAttempts).not.toHaveBeenCalled();
    });

    it("does not let an exam-scoped summary mutate full attempt caches", async () => {
        const full = { ...baseAttempt, subQuestionAnswers: baseAttempt.subQuestionAnswers };
        const summary = { ...baseAttempt, subQuestionAnswers: undefined, score: 5 };
        actionMocks.list.mockResolvedValue({ status: "loaded", attempts: [summary] });
        persistenceMocks.readLocalAttempts.mockReturnValue([full]);

        await loadTeacherAttempts("exam-1");
        expect(persistenceMocks.saveLocalAttempt).not.toHaveBeenCalled();
        expect(persistenceMocks.readLocalAttempts).not.toHaveBeenCalled();
    });

    it("does not cache a fresh attempt summary as full detail", async () => {
        const summary = { ...baseAttempt, subQuestionAnswers: undefined, score: 5 };
        actionMocks.list.mockResolvedValue({ status: "loaded", attempts: [summary] });
        persistenceMocks.readLocalAttempts.mockReturnValue([]);

        await loadTeacherAttempts();
        expect(persistenceMocks.saveLocalAttempts).not.toHaveBeenCalled();
    });
});
