import { describe, expect, it } from "vitest";
import type { Attempt, Exam, QuestionResult } from "@/types/omr";
import {
    buildQuestionResultRepairPlan,
    repairAttemptQuestionResults,
} from "./analyticsDataRepair";

const exam: Exam = {
    id: "exam-1",
    title: "중간고사",
    createdAt: "2026-06-15T09:00:00.000Z",
    questions: [
        { id: 1, number: 1, answer: 1, score: 4, label: "문법", tags: { concept: "높임 표현" } },
        { id: 2, number: 2, answer: 2, score: 6, label: "독해", tags: { concept: "인과 추론" } },
    ],
};

function attempt(overrides: Partial<Attempt> = {}): Attempt {
    return {
        id: "attempt-1",
        examId: "exam-1",
        examTitle: "중간고사",
        studentName: "김학생",
        startedAt: "2026-06-15T09:00:00.000Z",
        finishedAt: "2026-06-15T09:30:00.000Z",
        score: 0,
        totalScore: 0,
        answers: { 1: 1, 2: 1 },
        status: "completed",
        ...overrides,
    };
}

function partialResult(): QuestionResult {
    return {
        schemaVersion: 1,
        attemptId: "attempt-partial",
        examId: "exam-1",
        examTitle: "중간고사",
        studentName: "김학생",
        questionId: 1,
        questionNumber: 1,
        score: 4,
        earnedScore: 4,
        selectedAnswer: 1,
        correctAnswer: 1,
        status: "correct",
        isCorrect: true,
        isWrong: false,
        isUnanswered: false,
        finishedAt: "2026-06-15T09:30:00.000Z",
    };
}

describe("analytics data repair", () => {
    it("backfills missing question result rows and normalizes score totals", () => {
        const item = repairAttemptQuestionResults(exam, attempt());

        expect(item).toMatchObject({
            attemptId: "attempt-1",
            expectedQuestionCount: 2,
            existingQuestionResultCount: 0,
            missingQuestionResultCount: 2,
        });
        expect(item?.repairedAttempt.questionResults).toHaveLength(2);
        expect(item?.repairedAttempt).toMatchObject({
            score: 4,
            totalScore: 10,
        });
        expect(item?.repairedAttempt.questionResults?.map(result => result.status)).toEqual(["correct", "wrong"]);
    });

    it("fills partial rows while preserving derived timing and metadata merge behavior", () => {
        const item = repairAttemptQuestionResults(exam, attempt({
            id: "attempt-partial",
            questionResults: [partialResult()],
        }));

        expect(item).toMatchObject({
            existingQuestionResultCount: 1,
            missingQuestionResultCount: 1,
        });
        expect(item?.repairedAttempt.questionResults).toHaveLength(2);
        expect(item?.repairedAttempt.questionResults?.[0]).toMatchObject({
            questionId: 1,
            concept: "높임 표현",
            status: "correct",
        });
        expect(item?.repairedAttempt.questionResults?.[1]).toMatchObject({
            questionId: 2,
            concept: "인과 추론",
            status: "wrong",
        });
    });

    it("repairs retake attempts against the retake question set only", () => {
        const item = repairAttemptQuestionResults(exam, attempt({
            id: "retake-attempt",
            answers: { 2: 2 },
            retake: {
                sourceAttemptId: "attempt-1",
                questionIds: [2],
                mode: "wrong",
                createdAt: "2026-06-15T10:00:00.000Z",
            },
        }));

        expect(item).toMatchObject({
            attemptId: "retake-attempt",
            expectedQuestionCount: 1,
            existingQuestionResultCount: 0,
            missingQuestionResultCount: 1,
        });
        expect(item?.repairedAttempt.questionResults).toHaveLength(1);
        expect(item?.repairedAttempt.questionResults?.[0]).toMatchObject({
            questionId: 2,
            status: "correct",
            retakeSourceAttemptId: "attempt-1",
            retakeMode: "wrong",
        });
        expect(item?.repairedAttempt).toMatchObject({
            score: 6,
            totalScore: 6,
        });
    });

    it("builds a repair plan and skips orphan or in-progress attempts", () => {
        const plan = buildQuestionResultRepairPlan([exam], [
            attempt({ id: "repairable" }),
            attempt({ id: "complete", questionResults: [partialResult(), { ...partialResult(), questionId: 2, questionNumber: 2 }] }),
            attempt({ id: "orphan", examId: "deleted-exam" }),
            attempt({ id: "draft", status: "in_progress" }),
        ]);

        expect(plan).toMatchObject({
            repairableCount: 1,
            repairedQuestionResultCount: 2,
            skippedOrphanAttemptCount: 1,
            skippedInProgressAttemptCount: 1,
        });
        expect(plan.items.map(item => item.attemptId)).toEqual(["repairable"]);
    });
});
