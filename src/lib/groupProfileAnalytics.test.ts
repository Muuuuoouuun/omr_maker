import { describe, expect, it } from "vitest";
import type { Attempt, Exam } from "@/types/omr";
import type { RosterGroup, RosterStudent } from "@/lib/rosterStorage";
import { buildGroupProfileInsight } from "./groupProfileAnalytics";

const exam: Exam = {
    id: "exam-1",
    title: "6월 모의고사",
    createdAt: "2026-06-15T00:00:00.000Z",
    questions: [
        { id: 1, number: 1, answer: 2, score: 5, label: "어휘", tags: { concept: "문맥 어휘", unit: "독해" } },
        { id: 2, number: 2, answer: 4, score: 5, label: "문법", tags: { concept: "시제", unit: "문법", mistakeTypes: ["개념 혼동"] } },
        { id: 3, number: 3, answer: 1, score: 5, label: "문법", tags: { concept: "시제", unit: "문법", mistakeTypes: ["개념 혼동"] } },
    ],
};

const group: RosterGroup = {
    id: "class-a",
    name: "A반",
    count: 2,
    avgScore: 0,
    color: "#4f46e5",
};

const students: RosterStudent[] = [
    {
        id: "class-a::김학생",
        name: "김학생",
        email: "kim@example.com",
        group: "A반",
        avatar: "#111827",
        avgScore: 0,
        examsTaken: 0,
        lastActive: "기록 없음",
        trend: "flat",
        status: "idle",
    },
    {
        id: "class-b::김학생",
        name: "김학생",
        email: "kim-b@example.com",
        group: "B반",
        avatar: "#111827",
        avgScore: 0,
        examsTaken: 0,
        lastActive: "기록 없음",
        trend: "flat",
        status: "idle",
    },
];

function attempt(partial: Partial<Attempt>): Attempt {
    return {
        id: partial.id || "attempt-1",
        examId: partial.examId || exam.id,
        examTitle: partial.examTitle || exam.title,
        studentId: partial.studentId,
        studentName: partial.studentName || "김학생",
        groupId: partial.groupId,
        groupName: partial.groupName,
        startedAt: partial.startedAt || "2026-06-15T10:00:00.000Z",
        finishedAt: partial.finishedAt || "2026-06-15T10:30:00.000Z",
        score: partial.score ?? 0,
        totalScore: partial.totalScore ?? 15,
        answers: partial.answers || {},
        retake: partial.retake,
        status: partial.status || "completed",
    };
}

describe("group profile analytics", () => {
    it("summarizes class attempts by exam, weakness type, and at-risk students", () => {
        const insight = buildGroupProfileInsight(group, students, [
            attempt({
                id: "old-a",
                studentId: "class-a::김학생",
                groupName: "A반",
                finishedAt: "2026-06-14T10:30:00.000Z",
                answers: { 1: 2, 2: 1, 3: 0 },
            }),
            attempt({
                id: "new-a",
                studentId: "class-a::김학생",
                groupName: "A반",
                finishedAt: "2026-06-15T10:30:00.000Z",
                answers: { 1: 2, 2: 4, 3: 0 },
            }),
            attempt({
                id: "other-class",
                studentId: "class-b::김학생",
                groupName: "B반",
                finishedAt: "2026-06-15T11:00:00.000Z",
                answers: { 1: 0, 2: 0, 3: 0 },
            }),
        ], new Map([[exam.id, exam]]));

        expect(insight).toMatchObject({
            groupName: "A반",
            rosterStudentCount: 1,
            attemptCount: 2,
            retakeAttemptCount: 0,
            examCount: 1,
            activeStudentCount: 1,
            averageScore: 50,
            wrongQuestionCount: 1,
            unansweredQuestionCount: 2,
        });
        expect(insight.exams[0]).toMatchObject({
            examTitle: "6월 모의고사",
            attemptCount: 2,
            studentCount: 1,
            averageScore: 50,
            topWeakness: {
                title: "시제",
                basis: "같은 개념",
                wrongCount: 3,
                unansweredCount: 2,
                sourceAttemptId: "class:class-a",
                retakeQuestionIds: [2, 3],
                recommendedAction: "같은 개념 2문항 재추천",
            },
        });
        expect(insight.weaknessGroups[0]).toMatchObject({
            title: "시제",
            questionNumbers: [2, 3],
            wrongCount: 3,
            severity: "urgent",
            retakeMode: "similar",
            retakeConcepts: ["시제"],
        });
        expect(insight.weaknessGroups[0].reason).toContain("선택 반");
        expect(insight.studentsNeedingAttention[0]).toMatchObject({
            name: "김학생",
            attemptCount: 2,
            averageScore: 50,
            latestScore: 67,
        });
    });

    it("includes roster-matched class attempts even when the attempt group snapshot is missing", () => {
        const insight = buildGroupProfileInsight(group, students, [
            attempt({
                id: "legacy-class-key",
                studentId: "A반::김학생",
                studentName: "김학생",
                answers: { 1: 2, 2: 1, 3: 0 },
            }),
            attempt({
                id: "other-class-key",
                studentId: "class-b::김학생",
                studentName: "김학생",
                answers: { 1: 0, 2: 0, 3: 0 },
            }),
        ], new Map([[exam.id, exam]]));

        expect(insight).toMatchObject({
            groupId: "class-a",
            groupName: "A반",
            attemptCount: 1,
            retakeAttemptCount: 0,
            activeStudentCount: 1,
            wrongQuestionCount: 1,
            unansweredQuestionCount: 1,
        });
        expect(insight.exams[0]).toMatchObject({
            attemptCount: 1,
            studentCount: 1,
            topWeakness: {
                sourceAttemptId: "class:class-a",
                retakeQuestionIds: [2, 3],
            },
        });
        expect(insight.studentsNeedingAttention).toHaveLength(1);
        expect(insight.studentsNeedingAttention[0]).toMatchObject({
            key: "class-a::김학생",
            name: "김학생",
        });
    });

    it("keeps retake recovery attempts out of class averages and risk rows", () => {
        const insight = buildGroupProfileInsight(group, students, [
            attempt({
                id: "base",
                studentId: "class-a::김학생",
                groupName: "A반",
                finishedAt: "2026-06-15T10:30:00.000Z",
                answers: { 1: 2, 2: 1, 3: 0 },
            }),
            attempt({
                id: "retake",
                studentId: "class-a::김학생",
                groupName: "A반",
                finishedAt: "2026-06-15T11:00:00.000Z",
                answers: { 2: 4, 3: 1 },
                retake: {
                    sourceAttemptId: "base",
                    questionIds: [2, 3],
                    mode: "wrong",
                    createdAt: "2026-06-15T10:40:00.000Z",
                },
            }),
        ], new Map([[exam.id, exam]]));

        expect(insight).toMatchObject({
            attemptCount: 1,
            retakeAttemptCount: 1,
            averageScore: 33,
            wrongQuestionCount: 1,
            unansweredQuestionCount: 1,
        });
        expect(insight.exams[0]).toMatchObject({
            attemptCount: 1,
            averageScore: 33,
        });
        expect(insight.studentsNeedingAttention[0]).toMatchObject({
            attemptCount: 1,
            averageScore: 33,
            latestScore: 33,
        });
    });
});
