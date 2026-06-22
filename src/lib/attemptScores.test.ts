import { describe, expect, it } from "vitest";
import type { Attempt, Exam } from "@/types/omr";
import {
    averageResolvedAttemptPercent,
    baseAttemptsOnly,
    buildAttemptScoreLookup,
    resolveAttemptScore,
    retakeAttemptsOnly,
} from "./attemptScores";

const exam: Exam = {
    id: "exam-1",
    title: "중간고사",
    createdAt: "2026-06-15T10:00:00.000Z",
    questions: [
        { id: 1, number: 1, answer: 1, score: 5 },
        { id: 2, number: 2, answer: 2, score: 5 },
    ],
};

function attempt(overrides: Partial<Attempt> = {}): Attempt {
    return {
        id: "attempt-1",
        examId: "exam-1",
        examTitle: "중간고사",
        studentName: "학생",
        startedAt: "2026-06-15T10:00:00.000Z",
        finishedAt: "2026-06-15T10:10:00.000Z",
        score: 10,
        totalScore: 10,
        answers: { 1: 1, 2: 1 },
        status: "completed",
        ...overrides,
    };
}

describe("attempt score resolution", () => {
    it("uses current exam/question grading before stale stored totals", () => {
        const resolved = resolveAttemptScore(attempt({ score: 10, totalScore: 10 }), exam);

        expect(resolved).toMatchObject({
            earnedScore: 5,
            totalScore: 10,
            scorePercent: 50,
            source: "questionResults",
        });
    });

    it("falls back to stored score when the exam is unavailable", () => {
        expect(resolveAttemptScore(attempt({ score: 7, totalScore: 10 }), null)).toMatchObject({
            earnedScore: 7,
            totalScore: 10,
            scorePercent: 70,
            source: "storedScore",
        });
    });

    it("builds reusable lookup maps and averages resolved percentages", () => {
        const attempts = [
            attempt({ id: "a1", answers: { 1: 1, 2: 2 }, score: 0 }),
            attempt({ id: "a2", answers: { 1: 1, 2: 1 }, score: 10 }),
        ];
        const examById = new Map([[exam.id, exam]]);

        const lookup = buildAttemptScoreLookup(attempts, examById);

        expect(lookup.get("a1")?.scorePercent).toBe(100);
        expect(lookup.get("a2")?.scorePercent).toBe(50);
        expect(averageResolvedAttemptPercent(attempts, examById)).toBe(75);
    });

    it("splits original attempts from retake attempts for student-facing aggregates", () => {
        const original = attempt({ id: "base" });
        const retake = attempt({
            id: "retake",
            retake: {
                sourceAttemptId: "base",
                questionIds: [2],
                mode: "wrong",
                createdAt: "2026-06-15T10:20:00.000Z",
            },
        });

        expect(baseAttemptsOnly([original, retake]).map(item => item.id)).toEqual(["base"]);
        expect(retakeAttemptsOnly([original, retake]).map(item => item.id)).toEqual(["retake"]);
    });
});
