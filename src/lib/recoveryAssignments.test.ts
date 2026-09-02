import { describe, expect, it } from "vitest";
import type { Attempt, Exam } from "@/types/omr";
import { buildRecoveryAssignmentBatch, formatRecoveryAssignmentBundle } from "./recoveryAssignments";

const exam: Exam = {
    id: "exam-1",
    title: "9월 진단평가",
    createdAt: "2026-09-01T00:00:00.000Z",
    questions: Array.from({ length: 12 }, (_, index) => ({
        id: index + 1,
        number: index + 1,
        answer: 1,
        label: index < 6 ? "수와 연산" : "함수",
    })),
};

function attempt(overrides: Partial<Attempt> = {}): Attempt {
    return {
        id: "attempt-1",
        examId: exam.id,
        examTitle: exam.title,
        studentName: "김학생",
        studentId: "student-1",
        groupId: "group-a",
        groupName: "중3 A반",
        startedAt: "2026-09-01T01:00:00.000Z",
        finishedAt: "2026-09-01T01:30:00.000Z",
        score: 0,
        totalScore: 100,
        answers: Object.fromEntries(exam.questions.map(question => [question.id, 2])),
        status: "completed",
        ...overrides,
    };
}

describe("recovery assignment batch", () => {
    it("uses only the latest completed base attempt per student", () => {
        const older = attempt({ id: "older", finishedAt: "2026-09-01T01:20:00.000Z" });
        const latest = attempt({
            id: "latest",
            finishedAt: "2026-09-01T02:00:00.000Z",
            answers: { 1: 2, 2: 2, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1, 8: 1, 9: 1, 10: 1, 11: 1, 12: 1 },
        });
        const retake = attempt({
            id: "retake",
            retake: { sourceAttemptId: "latest", questionIds: [1, 2], mode: "wrong", createdAt: "2026-09-01T03:00:00.000Z" },
        });
        const inProgress = attempt({ id: "draft", studentId: "student-2", status: "in_progress" });

        const batch = buildRecoveryAssignmentBatch(exam, [older, latest, retake, inProgress]);

        expect(batch.studentCount).toBe(1);
        expect(batch.proposals).toHaveLength(1);
        expect(batch.proposals[0]).toMatchObject({
            attemptId: "latest",
            questionIds: [1, 2],
            questionNumbers: [1, 2],
            estimatedMinutes: 3,
        });
    });

    it("keeps assignments short and reports overflow and weak identity as exceptions", () => {
        const batch = buildRecoveryAssignmentBatch(exam, [attempt({ studentId: undefined })]);

        expect(batch).toMatchObject({
            candidateStudentCount: 1,
            candidateQuestionCount: 10,
            exceptionStudentCount: 1,
        });
        expect(batch.proposals[0]).toMatchObject({
            missedCount: 12,
            overflowCount: 2,
            needsIdentityReview: true,
            estimatedMinutes: 8,
        });
    });

    it("does not create an automatic task for a single miss", () => {
        const singleMiss = attempt({
            answers: { 1: 2, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1, 8: 1, 9: 1, 10: 1, 11: 1, 12: 1 },
        });

        const batch = buildRecoveryAssignmentBatch(exam, [singleMiss]);

        expect(batch.candidateStudentCount).toBe(0);
        expect(batch.noActionStudentCount).toBe(1);
    });

    it("formats only the teacher-selected student links", () => {
        const second = attempt({ id: "attempt-2", studentId: "student-2", studentName: "이학생" });
        const batch = buildRecoveryAssignmentBatch(exam, [attempt(), second], { maxQuestionsPerAssignment: 3 });
        const selected = new Set([batch.proposals[1].key]);

        expect(formatRecoveryAssignmentBundle(batch, selected, "https://omr.example.com/")).toBe(
            `[9월 진단평가] 오답 회복 과제\n\n이학생 · 중3 A반 · 3문항 · 약 3분\nhttps://omr.example.com/solve/exam-1?retakeFrom=attempt-2&questions=1%2C2%2C3&mode=wrong`,
        );
    });
});
