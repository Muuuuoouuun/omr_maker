import { describe, expect, it } from "vitest";
import { mergeListProjectionsForCache } from "./listProjectionCache";

type CacheItem = { id: string } & Record<string, unknown>;

describe("mergeListProjectionsForCache", () => {
    it("preserves redacted question bodies while accepting authoritative state and timestamps", () => {
        const existing: CacheItem = {
            id: "attempt-1",
            studentQuestions: [{
                questionId: 7,
                questionNumber: 7,
                body: "학생 원문",
                createdAt: "old-created",
                status: "queued",
                answer: { body: "교사 답변", createdAt: "old-answer", teacherName: "담당 교사" },
            }],
        };
        const summary: CacheItem = {
            id: "attempt-1",
            studentQuestions: [{
                questionId: 7,
                questionNumber: 7,
                body: "",
                createdAt: "new-created",
                status: "answered",
                answer: { body: "", createdAt: "new-answer" },
            }],
        };

        expect(mergeListProjectionsForCache([summary], [existing])).toEqual([{
            id: "attempt-1",
            studentQuestions: [{
                questionId: 7,
                questionNumber: 7,
                body: "학생 원문",
                createdAt: "new-created",
                status: "answered",
                answer: { body: "교사 답변", createdAt: "new-answer", teacherName: "담당 교사" },
            }],
        }]);
    });

    it("clears authoritative false or removed fields while preserving deliberately absent detail fields", () => {
        const existing: CacheItem = {
            id: "exam-1",
            archived: true,
            startAt: "2026-08-06T00:00:00.000Z",
            pdfDataRef: { store: "remote", key: "old-problem" },
            answerKeyPdfRef: { store: "remote", key: "detail-only-answer" },
        };
        const summary: CacheItem = {
            id: "exam-1",
            archived: false,
            startAt: undefined,
            pdfDataRef: undefined,
        };

        expect(mergeListProjectionsForCache([summary], [existing])).toEqual([{
            id: "exam-1",
            archived: false,
            startAt: undefined,
            pdfDataRef: undefined,
            answerKeyPdfRef: { store: "remote", key: "detail-only-answer" },
        }]);
    });
});
