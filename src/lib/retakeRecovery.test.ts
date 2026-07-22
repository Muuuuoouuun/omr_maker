import { describe, expect, it } from "vitest";
import type { Attempt, Exam } from "@/types/omr";
import {
    buildAttemptRetakeRecovery,
    buildExamRetakeRecoveries,
    buildSourceAttemptRecovery,
    summarizeRetakeRecoveries,
} from "./retakeRecovery";

const EXAM: Exam = {
    id: "e1",
    title: "중간고사",
    createdAt: "2026-06-01T00:00:00.000Z",
    questions: [
        { id: 1, number: 1, answer: 1, choices: 5, score: 10 },
        { id: 2, number: 2, answer: 2, choices: 5, score: 10 },
        { id: 3, number: 3, answer: 3, choices: 5, score: 10 },
        { id: 4, number: 4, answer: 4, choices: 5, score: 10 },
    ],
};

function attempt(partial: Partial<Attempt>): Attempt {
    return {
        id: "a1",
        examId: "e1",
        examTitle: "중간고사",
        studentName: "김학생",
        studentId: "s1",
        startedAt: "2026-06-01T10:00:00.000Z",
        finishedAt: "2026-06-01T11:00:00.000Z",
        score: 0,
        totalScore: 40,
        answers: {},
        status: "completed",
        ...partial,
    };
}

// Source: q1 correct, q2 wrong, q3 unanswered, q4 wrong.
const SOURCE = attempt({ id: "src-1", answers: { 1: 1, 2: 5, 3: 0, 4: 5 } });

describe("retake recovery", () => {
    it("counts recovered targets on a wrong-mode retake", () => {
        // Retake over the missed set {2,3,4}: q2/q3 now correct, q4 still wrong.
        const retake = attempt({
            id: "rt-1",
            answers: { 2: 2, 3: 3, 4: 1 },
            retake: { sourceAttemptId: "src-1", questionIds: [2, 3, 4], mode: "wrong", createdAt: "2026-06-02T00:00:00.000Z" },
            finishedAt: "2026-06-02T10:00:00.000Z",
        });

        const insight = buildAttemptRetakeRecovery(EXAM, retake, SOURCE);
        expect(insight).toMatchObject({
            questionCount: 3,
            targetCount: 3,
            recoveredCount: 2,
            regressedCount: 0,
            retakeCorrectCount: 2,
            recoveryRate: 67,
            mode: "wrong",
        });
    });

    it("detects regression on a full/custom retake", () => {
        // Custom retake over everything: q1 (was correct) now wrong, q2 recovered.
        const retake = attempt({
            id: "rt-2",
            answers: { 1: 5, 2: 2, 3: 0, 4: 5 },
            retake: { sourceAttemptId: "src-1", questionIds: [1, 2, 3, 4], mode: "custom", createdAt: "2026-06-02T00:00:00.000Z" },
        });

        const insight = buildAttemptRetakeRecovery(EXAM, retake, SOURCE);
        expect(insight).toMatchObject({
            targetCount: 3,
            recoveredCount: 1,
            regressedCount: 1,
            recoveryRate: 33,
        });
    });

    it("returns undefined rate when the scope had nothing to recover", () => {
        // Retake over q1 only, which was already correct in the source.
        const retake = attempt({
            id: "rt-3",
            answers: { 1: 1 },
            retake: { sourceAttemptId: "src-1", questionIds: [1], mode: "custom", createdAt: "2026-06-02T00:00:00.000Z" },
        });
        const insight = buildAttemptRetakeRecovery(EXAM, retake, SOURCE);
        expect(insight?.targetCount).toBe(0);
        expect(insight?.recoveryRate).toBeUndefined();
    });

    it("rejects mismatched exam/source pairs and pseudo sources", () => {
        const retake = attempt({
            id: "rt-4",
            retake: { sourceAttemptId: "exam:e1", questionIds: [2], mode: "wrong", createdAt: "x" },
        });
        expect(buildAttemptRetakeRecovery(EXAM, retake, SOURCE)).toBeNull();
        expect(buildAttemptRetakeRecovery(EXAM, attempt({ id: "no-retake" }), SOURCE)).toBeNull();
    });

    it("refuses to compare a retake against a different student's source attempt", () => {
        // Same source id, but the source belongs to a different studentId.
        const otherStudentSource = attempt({ id: "src-1", studentId: "s2", answers: { 2: 5 } });
        const retake = attempt({
            id: "rt-cross",
            studentId: "s1",
            answers: { 2: 2 },
            retake: { sourceAttemptId: "src-1", questionIds: [2], mode: "wrong", createdAt: "x" },
        });
        expect(buildAttemptRetakeRecovery(EXAM, retake, otherStudentSource)).toBeNull();
    });

    it("joins retakes to sources across an exam and aggregates", () => {
        const retakeA = attempt({
            id: "rt-a",
            answers: { 2: 2, 3: 3, 4: 1 },
            retake: { sourceAttemptId: "src-1", questionIds: [2, 3, 4], mode: "wrong", createdAt: "x" },
            finishedAt: "2026-06-03T10:00:00.000Z",
        });
        const orphan = attempt({
            id: "rt-orphan",
            retake: { sourceAttemptId: "exam:e1", questionIds: [2], mode: "similar", createdAt: "x" },
        });

        const insights = buildExamRetakeRecoveries(EXAM, [retakeA, orphan], [SOURCE, retakeA, orphan]);
        expect(insights).toHaveLength(1);

        const summary = summarizeRetakeRecoveries(insights);
        expect(summary).toMatchObject({
            retakeCount: 1,
            measuredCount: 1,
            targetCount: 3,
            recoveredCount: 2,
            recoveryRate: 67,
        });
    });

    it("summarizes empty input without a rate", () => {
        expect(summarizeRetakeRecoveries([])).toMatchObject({
            retakeCount: 0,
            measuredCount: 0,
            recoveryRate: undefined,
        });
    });
});

describe("buildSourceAttemptRecovery", () => {
    it("marks source misses recovered by any retake of that attempt", () => {
        // Retake 1 recovers q2; retake 2 recovers q3; q4 stays wrong everywhere.
        const retake1 = attempt({
            id: "rt-1",
            answers: { 2: 2, 3: 0, 4: 5 },
            retake: { sourceAttemptId: "src-1", questionIds: [2, 3, 4], mode: "wrong", createdAt: "x" },
        });
        const retake2 = attempt({
            id: "rt-2",
            answers: { 3: 3, 4: 1 },
            retake: { sourceAttemptId: "src-1", questionIds: [3, 4], mode: "custom", createdAt: "x" },
        });

        const summary = buildSourceAttemptRecovery(EXAM, SOURCE, [SOURCE, retake1, retake2]);
        expect(summary).toEqual({
            retakeCount: 2,
            recoveredQuestionIds: [2, 3],
            unrecoveredQuestionIds: [4],
        });
    });

    it("ignores retakes of other attempts and other owners", () => {
        const unrelated = attempt({
            id: "rt-x",
            answers: { 2: 2 },
            retake: { sourceAttemptId: "src-999", questionIds: [2], mode: "wrong", createdAt: "x" },
        });
        const otherOwner = attempt({
            id: "rt-y",
            studentId: "s2",
            answers: { 2: 2 },
            retake: { sourceAttemptId: "src-1", questionIds: [2], mode: "wrong", createdAt: "x" },
        });

        const summary = buildSourceAttemptRecovery(EXAM, SOURCE, [unrelated, otherOwner]);
        expect(summary).toEqual({
            retakeCount: 0,
            recoveredQuestionIds: [],
            unrecoveredQuestionIds: [2, 3, 4],
        });
    });

    it("reports no recovery when the attempt had no misses", () => {
        const perfect = attempt({ id: "src-2", answers: { 1: 1, 2: 2, 3: 3, 4: 4 } });
        const summary = buildSourceAttemptRecovery(EXAM, perfect, []);
        expect(summary).toEqual({
            retakeCount: 0,
            recoveredQuestionIds: [],
            unrecoveredQuestionIds: [],
        });
    });
});
