import { describe, expect, it } from "vitest";
import type { Attempt, Exam } from "@/types/omr";
import { buildTeacherDashboardMetrics } from "./teacherDashboardMetrics";

const exam: Exam = {
    id: "exam-1",
    title: "중간고사",
    createdAt: "2026-06-15T09:00:00.000Z",
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
        studentName: "김학생",
        startedAt: "2026-06-15T09:00:00.000Z",
        finishedAt: "2026-06-15T09:30:00.000Z",
        score: 10,
        totalScore: 10,
        answers: { 1: 1, 2: 1 },
        status: "completed",
        ...overrides,
    };
}

describe("teacher dashboard metrics", () => {
    it("uses resolved question scoring before stale stored attempt scores", () => {
        const metrics = buildTeacherDashboardMetrics([
            exam,
        ], [
            attempt({ score: 10, totalScore: 10, answers: { 1: 1, 2: 1 } }),
        ]);

        expect(metrics.avgScore).toBe(50);
        expect(metrics.trendData).toEqual([50]);
        expect(metrics.trendLabels).toEqual(["중간고사"]);
    });

    it("aggregates the trend by exam mean and labels points with exam titles", () => {
        const secondExam: Exam = { ...exam, id: "exam-2", title: "기말고사", createdAt: "2026-06-20T09:00:00.000Z" };
        const metrics = buildTeacherDashboardMetrics([
            exam,
            secondExam,
        ], [
            // exam-1: two students, 100% and 0% → mean 50%
            attempt({ id: "a1", examId: "exam-1", studentId: "s1", answers: { 1: 1, 2: 2 }, finishedAt: "2026-06-15T09:10:00.000Z" }),
            attempt({ id: "a2", examId: "exam-1", studentId: "s2", answers: { 1: 2, 2: 1 }, finishedAt: "2026-06-15T09:20:00.000Z" }),
            // exam-2: one student, 100%
            attempt({ id: "b1", examId: "exam-2", examTitle: "기말고사", studentId: "s1", answers: { 1: 1, 2: 2 }, finishedAt: "2026-06-20T09:15:00.000Z" }),
        ]);

        // One point per exam (ordered by exam createdAt), labelled by title.
        expect(metrics.trendData).toEqual([50, 100]);
        expect(metrics.trendLabels).toEqual(["중간고사", "기말고사"]);
    });

    it("keeps only the last N exams in the trend window", () => {
        const exams: Exam[] = Array.from({ length: 9 }, (_, i) => ({
            ...exam,
            id: `exam-${i}`,
            title: `시험 ${i}`,
            createdAt: `2026-06-${String(10 + i).padStart(2, "0")}T09:00:00.000Z`,
        }));
        const attempts = exams.map((e, i) => attempt({
            id: `att-${i}`,
            examId: e.id,
            examTitle: e.title,
            answers: { 1: 1, 2: 2 },
            finishedAt: `2026-06-${String(10 + i).padStart(2, "0")}T10:00:00.000Z`,
        }));

        const metrics = buildTeacherDashboardMetrics(exams, attempts);
        expect(metrics.trendData).toHaveLength(7);
        expect(metrics.trendLabels).toEqual(["시험 2", "시험 3", "시험 4", "시험 5", "시험 6", "시험 7", "시험 8"]);
    });

    it("separates same-name legacy students by class scope", () => {
        const metrics = buildTeacherDashboardMetrics([
            exam,
        ], [
            attempt({ id: "a", studentName: "김학생", groupId: "class-a", groupName: "A반" }),
            attempt({ id: "b", studentName: "김학생", groupId: "class-b", groupName: "B반" }),
        ]);

        expect(metrics.totalStudents).toBe(2);
    });

    it("uses roster student count for the overview total when a roster is available", () => {
        const metrics = buildTeacherDashboardMetrics([
            exam,
        ], [
            attempt({ id: "a", studentName: "김학생", studentId: "student-1" }),
        ], {
            rosterStudents: [
                { id: "student-1" },
                { id: "student-2" },
                { id: "student-2" },
            ],
        });

        expect(metrics.totalStudents).toBe(2);
    });

    it("falls back to stored scores for missing exams and keeps the latest trend window", () => {
        const metrics = buildTeacherDashboardMetrics([], [
            attempt({
                id: "old",
                examId: "missing-a",
                score: 8,
                totalScore: 10,
                finishedAt: "2026-06-15T09:00:00.000Z",
            }),
            attempt({
                id: "new",
                examId: "missing-b",
                score: 6,
                totalScore: 10,
                finishedAt: "2026-06-15T10:00:00.000Z",
            }),
        ], { trendLimit: 1 });

        expect(metrics.avgScore).toBe(70);
        // Missing exams sort by latest attempt; the window keeps the most recent one.
        expect(metrics.trendData).toEqual([60]);
        expect(metrics.trendLabels).toEqual(["중간고사"]);
        expect(metrics.activeExams).toBe(0);
    });

    it("does not let retake attempts skew overview average, trend, or participant count", () => {
        const metrics = buildTeacherDashboardMetrics([
            exam,
        ], [
            attempt({
                id: "base",
                studentName: "김학생",
                studentId: "student-1",
                answers: { 1: 1, 2: 1 },
                finishedAt: "2026-06-15T09:00:00.000Z",
            }),
            attempt({
                id: "retake",
                studentName: "김학생",
                studentId: "student-1",
                answers: { 2: 2 },
                finishedAt: "2026-06-15T10:00:00.000Z",
                retake: {
                    sourceAttemptId: "base",
                    questionIds: [2],
                    mode: "wrong",
                    createdAt: "2026-06-15T09:30:00.000Z",
                },
            }),
        ]);

        expect(metrics.avgScore).toBe(50);
        expect(metrics.trendData).toEqual([50]);
        expect(metrics.totalStudents).toBe(1);
    });
});
