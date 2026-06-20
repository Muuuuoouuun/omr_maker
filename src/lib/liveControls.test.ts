import { describe, expect, it } from "vitest";
import type { Attempt, Exam } from "@/types/omr";
import { forceCompleteLiveAttempt, liveAttemptsNeedingForceFinish } from "./liveControls";

const exam: Exam = {
    id: "exam-1",
    title: "Live Control",
    createdAt: "2026-06-16T10:00:00.000Z",
    questions: [
        { id: 1, number: 1, answer: 2, score: 4 },
        { id: 2, number: 2, answer: 3, score: 6 },
    ],
};

function attempt(partial: Partial<Attempt> = {}): Attempt {
    return {
        id: "attempt-1",
        examId: exam.id,
        examTitle: exam.title,
        studentName: "김학생",
        startedAt: "2026-06-16T10:00:00.000Z",
        finishedAt: "2026-06-16T10:05:00.000Z",
        score: 0,
        totalScore: 10,
        answers: { 1: 2 },
        status: "in_progress",
        ...partial,
    };
}

describe("live controls", () => {
    it("force-completes an in-progress attempt using exam scoring", () => {
        const completed = forceCompleteLiveAttempt(
            attempt(),
            exam,
            "2026-06-16T10:20:00.000Z",
        );

        expect(completed).toMatchObject({
            finishedAt: "2026-06-16T10:20:00.000Z",
            score: 4,
            totalScore: 10,
            status: "completed",
            autoSubmitted: true,
        });
        expect(completed.questionResults?.map(result => ({
            questionId: result.questionId,
            status: result.status,
        }))).toEqual([
            { questionId: 1, status: "correct" },
            { questionId: 2, status: "unanswered" },
        ]);
    });

    it("force-completes retake attempts without treating unassigned questions as missing", () => {
        const completed = forceCompleteLiveAttempt(
            attempt({
                id: "retake-attempt",
                answers: { 2: 3 },
                retake: {
                    sourceAttemptId: "attempt-1",
                    questionIds: [2],
                    mode: "wrong",
                    createdAt: "2026-06-16T10:10:00.000Z",
                },
            }),
            exam,
            "2026-06-16T10:20:00.000Z",
        );

        expect(completed).toMatchObject({
            score: 6,
            totalScore: 6,
            status: "completed",
            autoSubmitted: true,
        });
        expect(completed.questionResults?.map(result => ({
            questionId: result.questionId,
            status: result.status,
        }))).toEqual([
            { questionId: 2, status: "correct" },
        ]);
    });

    it("only selects attempts that are still in progress", () => {
        expect(liveAttemptsNeedingForceFinish([
            attempt({ id: "in-progress", status: "in_progress" }),
            attempt({ id: "done", status: "completed" }),
        ]).map(item => item.id)).toEqual(["in-progress"]);
    });
});
