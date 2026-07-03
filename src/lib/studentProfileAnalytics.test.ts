import { describe, expect, it } from "vitest";
import type { Attempt, Exam } from "@/types/omr";
import type { RosterStudent } from "@/lib/rosterStorage";
import { buildStudentProfileInsight } from "./studentProfileAnalytics";

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

const student: RosterStudent = {
    id: "class-a::김학생",
    name: "김학생",
    email: "student@example.com",
    group: "A반",
    avatar: "#111827",
    avgScore: 0,
    examsTaken: 0,
    lastActive: "기록 없음",
    trend: "flat",
    status: "idle",
};

function attempt(partial: Partial<Attempt>): Attempt {
    return {
        id: partial.id || "attempt-1",
        examId: partial.examId || exam.id,
        examTitle: partial.examTitle || exam.title,
        studentId: partial.studentId,
        studentName: partial.studentName || student.name,
        groupId: partial.groupId,
        groupName: partial.groupName || student.group,
        startedAt: partial.startedAt || "2026-06-15T10:00:00.000Z",
        finishedAt: partial.finishedAt || "2026-06-15T10:30:00.000Z",
        score: partial.score ?? 0,
        totalScore: partial.totalScore ?? 15,
        answers: partial.answers || {},
        drawingsRef: partial.drawingsRef,
        handwritingArchived: partial.handwritingArchived,
        drawingPageCount: partial.drawingPageCount,
        questionDrawings: partial.questionDrawings,
        questionTimings: partial.questionTimings,
        focusLossEvents: partial.focusLossEvents,
        tabFociLostCount: partial.tabFociLostCount,
        retake: partial.retake,
        status: partial.status || "completed",
    };
}

describe("student profile analytics", () => {
    it("builds student detail insight from attempts, weaknesses, and handwriting archives", () => {
        const insight = buildStudentProfileInsight(student, [
            attempt({
                id: "old",
                studentId: student.id,
                finishedAt: "2026-06-14T10:30:00.000Z",
                answers: { 1: 2, 2: 1, 3: 0 },
            }),
            attempt({
                id: "new",
                studentId: student.id,
                finishedAt: "2026-06-15T10:30:00.000Z",
                answers: { 1: 2, 2: 4, 3: 0 },
                handwritingArchived: true,
                drawingsRef: { store: "indexeddb", key: "drawing-new" },
                questionDrawings: [{ questionId: 3, questionNumber: 3, page: 1, strokeCount: 12 }],
                questionTimings: [
                    { questionId: 2, questionNumber: 2, totalTimeSec: 30, visitCount: 1, revisitCount: 0, answerChangeCount: 1 },
                    { questionId: 3, questionNumber: 3, totalTimeSec: 90, visitCount: 2, revisitCount: 1, answerChangeCount: 0 },
                ],
                focusLossEvents: [
                    { at: "2026-06-15T10:20:00.000Z", questionId: 3, questionNumber: 3, count: 1, reason: "hidden" },
                ],
            }),
            attempt({
                id: "other-class",
                studentId: undefined,
                groupName: "B반",
                finishedAt: "2026-06-15T11:00:00.000Z",
                answers: { 1: 0, 2: 0, 3: 0 },
            }),
        ], new Map([[exam.id, exam]]));

        expect(insight.attempts.map(item => item.id)).toEqual(["new", "old"]);
        expect(insight.averageScore).toBe(50);
        expect(insight.latestScore).toBe(67);
        expect(insight.bestScore).toBe(67);
        expect(insight.trendDelta).toBe(34);
        expect(insight.averageElapsedTimeSec).toBe(1800);
        expect(insight.averageQuestionTimeSec).toBe(60);
        expect(insight.totalTrackedTimeSec).toBe(120);
        expect(insight.focusLossCount).toBe(1);
        expect(insight.wrongQuestionCount).toBe(1);
        expect(insight.unansweredQuestionCount).toBe(2);
        expect(insight.handwritingArchiveCount).toBe(1);
        expect(insight.baseAttemptCount).toBe(2);
        expect(insight.retakeAttemptCount).toBe(0);
        expect(insight.attempts[0]).toMatchObject({
            handwritingArchived: true,
            handwritingLabel: "1문항",
            unansweredQuestionNumbers: [3],
            elapsedTimeSec: 1800,
            averageQuestionTimeSec: 60,
            slowQuestionNumbers: [3],
            revisitedQuestionNumbers: [3],
            answerChangedQuestionNumbers: [2],
            focusLossCount: 1,
            isRetake: false,
        });
        expect(insight.mostMissedQuestions[0]).toMatchObject({
            examTitle: "6월 모의고사",
            questionNumber: 3,
            wrongCount: 2,
            totalCount: 2,
            wrongRate: 100,
            averageTimeSec: 90,
        });
        expect(insight.tagStats.find(stat => stat.title === "문법")).toMatchObject({
            totalCount: 4,
            correctCount: 1,
            wrongCount: 3,
            unansweredCount: 2,
            wrongRate: 75,
            averageTimeSec: 60,
        });
        expect(insight.weaknessGroups[0]).toMatchObject({
            examTitle: "6월 모의고사",
            title: "시제",
            basis: "같은 개념",
            wrongCount: 3,
            unansweredCount: 2,
            questionNumbers: [2, 3],
            severity: "urgent",
            sourceAttemptId: "student:class-a::김학생",
            retakeMode: "similar",
            retakeQuestionIds: [2, 3],
            retakeConcepts: ["시제"],
            recommendedAction: "같은 개념 2문항 재추천",
        });
        expect(insight.weaknessGroups[0].reason).toContain("선택 학생");
    });

    it("keeps retake recovery records visible without inflating original score metrics", () => {
        const insight = buildStudentProfileInsight(student, [
            attempt({
                id: "base",
                studentId: student.id,
                finishedAt: "2026-06-15T10:30:00.000Z",
                answers: { 1: 2, 2: 1, 3: 0 },
            }),
            attempt({
                id: "retake",
                studentId: student.id,
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

        expect(insight.averageScore).toBe(33);
        expect(insight.latestScore).toBe(33);
        expect(insight.bestScore).toBe(33);
        expect(insight.baseAttemptCount).toBe(1);
        expect(insight.retakeAttemptCount).toBe(1);
        expect(insight.attempts.map(item => ({
            id: item.id,
            isRetake: item.isRetake,
            retakeQuestionCount: item.retakeQuestionCount,
        }))).toEqual([
            { id: "retake", isRetake: true, retakeQuestionCount: 2 },
            { id: "base", isRetake: false, retakeQuestionCount: 0 },
        ]);
        expect(insight.wrongQuestionCount).toBe(1);
        expect(insight.unansweredQuestionCount).toBe(1);
    });
});
