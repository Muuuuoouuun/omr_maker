import { describe, expect, it } from "vitest";
import type { Attempt, Exam } from "@/types/omr";
import { buildQuestionResults } from "./premiumAnalytics";
import { buildCanonicalQuestionResultEvidence } from "./canonicalQuestionResultManifest";
import {
    averageResolvedAttemptPercent,
    baseAttemptsOnly,
    buildAttemptScoreLookup,
    groupBaseAttemptsByExam,
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
    it("labels current-exam grading as legacy-derived when stored rows are absent", () => {
        const resolved = resolveAttemptScore(attempt({ score: 10, totalScore: 10 }), exam);

        expect(resolved).toMatchObject({
            earnedScore: 5,
            totalScore: 10,
            scorePercent: 50,
            source: "legacy_derived_current_exam",
        });
    });

    it("reports canonical and stored-total provenance truthfully", () => {
        const canonicalAttempt = attempt({ score: 5, totalScore: 10 });
        canonicalAttempt.questionResults = buildQuestionResults(exam, canonicalAttempt);
        Object.assign(canonicalAttempt, buildCanonicalQuestionResultEvidence(canonicalAttempt, canonicalAttempt.questionResults));

        expect(resolveAttemptScore(canonicalAttempt, exam).source).toBe("canonical_submission");
        expect(resolveAttemptScore(attempt({ questionResults: [] }), exam)).toMatchObject({
            earnedScore: 10,
            totalScore: 10,
            source: "stored_totals_only",
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

    it("uses canonical stored totals for lightweight summaries without answer detail", () => {
        const summary = {
            ...attempt({ score: 8, totalScore: 10, answers: {} }),
            detailLevel: "summary" as const,
        };

        expect(resolveAttemptScore(summary, exam)).toMatchObject({
            earnedScore: 8,
            totalScore: 10,
            scorePercent: 80,
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

    it("indexes original attempts by exam in one pass for dashboard exports", () => {
        const first = attempt({ id: "base-1", examId: "exam-1" });
        const second = attempt({ id: "base-2", examId: "exam-2" });
        const retake = attempt({
            id: "retake-1",
            examId: "exam-1",
            retake: {
                sourceAttemptId: "base-1",
                questionIds: [2],
                mode: "wrong",
                createdAt: "2026-06-15T10:20:00.000Z",
            },
        });

        const grouped = groupBaseAttemptsByExam([first, retake, second]);

        expect(grouped.get("exam-1")).toEqual([first]);
        expect(grouped.get("exam-2")).toEqual([second]);
        expect(grouped.has("missing")).toBe(false);
    });
});
