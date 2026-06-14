import { describe, expect, it } from "vitest";
import type { Attempt, Exam } from "@/types/omr";
import {
    buildRetakeQuestionIds,
    buildStudentWeaknessGroups,
    buildSimilarQuestionGroups,
    summarizeAttemptBehavior,
} from "./premiumAnalytics";

const exam: Exam = {
    id: "exam-1",
    title: "국어 문학/문법",
    createdAt: "2026-06-14T10:00:00.000Z",
    questions: [
        {
            id: 1,
            number: 1,
            answer: 2,
            label: "문법",
            tags: { unit: "문법", concept: "높임 표현", source: "높임 표현", expectedTimeSec: 60 },
        },
        {
            id: 2,
            number: 2,
            answer: 4,
            label: "문학",
            tags: { unit: "현대시", concept: "화자의 정서", source: "님의 침묵", expectedTimeSec: 90 },
        },
        {
            id: 3,
            number: 3,
            answer: 1,
            label: "문학",
            tags: { unit: "현대시", concept: "화자의 정서", source: "님의 침묵", expectedTimeSec: 80 },
        },
        {
            id: 4,
            number: 4,
            answer: 3,
            label: "독서",
            tags: { unit: "사회", concept: "인과 추론", source: "경제 지문", expectedTimeSec: 75 },
        },
    ],
};

const attempt: Attempt = {
    id: "attempt-1",
    examId: "exam-1",
    examTitle: "국어 문학/문법",
    studentName: "김학생",
    startedAt: "2026-06-14T10:00:00.000Z",
    finishedAt: "2026-06-14T10:05:00.000Z",
    score: 50,
    totalScore: 100,
    answers: {
        1: 2,
        2: 1,
        4: 0,
    },
    status: "completed",
    tabFociLostCount: 2,
    focusLossEvents: [
        { at: "2026-06-14T10:02:00.000Z", questionId: 2, questionNumber: 2, count: 1, reason: "hidden" },
        { at: "2026-06-14T10:03:00.000Z", questionId: 4, questionNumber: 4, count: 2, reason: "blur" },
    ],
    questionTimings: [
        { questionId: 1, questionNumber: 1, totalTimeSec: 45, visitCount: 1, revisitCount: 0, answerChangeCount: 1 },
        { questionId: 2, questionNumber: 2, totalTimeSec: 132, visitCount: 3, revisitCount: 2, answerChangeCount: 2 },
        { questionId: 4, questionNumber: 4, totalTimeSec: 18, visitCount: 1, revisitCount: 0, answerChangeCount: 0 },
    ],
};

describe("premium analytics", () => {
    it("builds a retake set from wrong and unanswered questions only", () => {
        expect(buildRetakeQuestionIds(exam, attempt)).toEqual([2, 3, 4]);
    });

    it("groups a student's wrong questions by teacher labels and deep tags", () => {
        expect(buildStudentWeaknessGroups(exam, attempt)).toEqual([
            {
                key: "source:님의 침묵",
                title: "님의 침묵",
                basis: "같은 지문/작품",
                questionIds: [2, 3],
                questionNumbers: [2, 3],
                wrongCount: 2,
                totalCount: 2,
                wrongRate: 100,
                labels: ["문학"],
                concepts: ["화자의 정서"],
                recommendedAction: "같은 지문/작품 2문항 재시험",
            },
            {
                key: "concept:인과 추론",
                title: "인과 추론",
                basis: "같은 개념",
                questionIds: [4],
                questionNumbers: [4],
                wrongCount: 1,
                totalCount: 1,
                wrongRate: 100,
                labels: ["독서"],
                concepts: ["인과 추론"],
                recommendedAction: "같은 개념 1문항 재시험",
            },
        ]);
    });

    it("sorts similar question groups by class-wide wrong pressure", () => {
        const secondAttempt: Attempt = {
            ...attempt,
            id: "attempt-2",
            studentName: "이학생",
            answers: { 1: 3, 2: 4, 3: 2, 4: 3 },
            score: 50,
        };

        expect(buildSimilarQuestionGroups(exam, [attempt, secondAttempt]).slice(0, 2)).toMatchObject([
            {
                title: "님의 침묵",
                basis: "같은 지문/작품",
                questionNumbers: [2, 3],
                wrongCount: 3,
                totalCount: 4,
                wrongRate: 75,
            },
            {
                title: "높임 표현",
                basis: "같은 지문/작품",
                questionNumbers: [1],
                wrongCount: 1,
                totalCount: 2,
                wrongRate: 50,
            },
        ]);
    });

    it("summarizes time, revisit, and focus-loss signals for an attempt", () => {
        expect(summarizeAttemptBehavior(attempt)).toEqual({
            totalTrackedTimeSec: 195,
            averageTimeSec: 65,
            slowQuestionNumbers: [2],
            rushedQuestionNumbers: [4],
            revisitedQuestionNumbers: [2],
            focusLossCount: 2,
            focusLossQuestionNumbers: [2, 4],
        });
    });
});
