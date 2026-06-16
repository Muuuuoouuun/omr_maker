import { describe, expect, it } from "vitest";
import type { Attempt, Exam } from "@/types/omr";
import { buildLiveQuestionHeatmap, buildRealQuestionHeatmap } from "./liveAnalytics";

const exam: Exam = {
    id: "exam-1",
    title: "실시간 테스트",
    createdAt: "2026-06-15T10:00:00.000Z",
    questions: [
        { id: 1, number: 1, answer: 1 },
        { id: 2, number: 2, answer: 2 },
        { id: 3, number: 3 },
    ],
};

function attempt(id: string, answers: Record<number, number>): Attempt {
    return {
        id,
        examId: exam.id,
        examTitle: exam.title,
        studentName: id,
        startedAt: "2026-06-15T10:00:00.000Z",
        finishedAt: "2026-06-15T10:30:00.000Z",
        score: 0,
        totalScore: 100,
        answers,
        status: "completed",
    };
}

describe("live analytics", () => {
    it("builds question heatmap from normalized question results", () => {
        const heatmap = buildRealQuestionHeatmap(exam, [
            attempt("a", { 1: 1, 2: 2 }),
            attempt("b", { 1: 2, 2: 2 }),
            attempt("c", { 1: 1 }),
        ]);

        expect(heatmap).toEqual([
            { questionId: 1, q: 1, correct: 2, total: 3 },
            { questionId: 2, q: 2, correct: 2, total: 3 },
            { questionId: 3, q: 3, correct: 0, total: 0 },
        ]);
    });

    it("ignores in-progress attempts", () => {
        const inProgress = { ...attempt("draft", { 1: 1 }), status: "in_progress" as const };

        expect(buildRealQuestionHeatmap(exam, [inProgress])[0]).toMatchObject({
            correct: 0,
            total: 0,
        });
    });

    it("does not synthesize production heatmap data before submissions arrive", () => {
        const heatmap = buildLiveQuestionHeatmap({
            examId: exam.id,
            sourceExam: exam,
            questions: exam.questions.map(question => ({ id: question.id, answer: question.answer })),
            totalQuestionCount: exam.questions.length,
            submittedAttempts: [],
            submittedDisplayCount: 0,
            allowSynthetic: false,
        });

        expect(heatmap).toEqual([
            { questionId: 1, q: 1, correct: 0, total: 0 },
            { questionId: 2, q: 2, correct: 0, total: 0 },
            { questionId: 3, q: 3, correct: 0, total: 0 },
        ]);
    });

    it("keeps ungraded real questions empty instead of replacing them with demo baselines", () => {
        const heatmap = buildLiveQuestionHeatmap({
            examId: exam.id,
            sourceExam: exam,
            questions: exam.questions.map(question => ({ id: question.id, answer: question.answer })),
            totalQuestionCount: exam.questions.length,
            submittedAttempts: [
                attempt("a", { 1: 1, 2: 2 }),
                attempt("b", { 1: 2, 2: 2 }),
            ],
            submittedDisplayCount: 8,
            allowSynthetic: true,
        });

        expect(heatmap[2]).toEqual({ questionId: 3, q: 3, correct: 0, total: 0 });
    });

    it("uses synthetic heatmap data only for explicit demo displays with submitted students", () => {
        const heatmap = buildLiveQuestionHeatmap({
            examId: exam.id,
            questions: exam.questions.map(question => ({ id: question.id, answer: question.answer })),
            totalQuestionCount: exam.questions.length,
            submittedAttempts: [],
            submittedDisplayCount: 5,
            allowSynthetic: true,
        });

        expect(heatmap).toHaveLength(3);
        expect(heatmap.every(cell => cell.total === 5)).toBe(true);
        expect(heatmap.some(cell => cell.correct > 0)).toBe(true);
    });
});
