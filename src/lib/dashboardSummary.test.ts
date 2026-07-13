import { describe, expect, it } from "vitest";
import type { Attempt, Exam } from "@/types/omr";
import type { RosterGroup, RosterStudent } from "@/lib/rosterStorage";
import { buildExamSummaryRows, splitExamSummaryRows } from "./dashboardSummary";

function rosterStudent(id: string, group: string): RosterStudent {
    return {
        id,
        name: id,
        email: "",
        group,
        avatar: "",
        avgScore: 0,
        examsTaken: 0,
        lastActive: "",
        trend: "flat",
        status: "active",
    };
}

function rosterGroup(id: string, name: string): RosterGroup {
    return { id, name, count: 0, avgScore: 0, color: "#000000" };
}

function exam(overrides: Partial<Exam>): Exam {
    return {
        id: "exam-1",
        title: "중간고사",
        createdAt: "2026-06-15T09:00:00.000Z",
        questions: [],
        ...overrides,
    };
}

function attempt(overrides: Partial<Attempt>): Attempt {
    return {
        id: "attempt-1",
        examId: "exam-1",
        examTitle: "중간고사",
        studentName: "김학생",
        startedAt: "2026-06-15T09:00:00.000Z",
        finishedAt: "2026-06-15T09:30:00.000Z",
        score: 80,
        totalScore: 100,
        answers: {},
        status: "completed",
        ...overrides,
    };
}

describe("dashboard summary rows", () => {
    it("builds rows only from real exams and completed attempts", () => {
        const rows = buildExamSummaryRows([
            exam({ id: "exam-a", title: "A", createdAt: "2026-06-14T00:00:00.000Z" }),
            exam({ id: "exam-b", title: "B", createdAt: "2026-06-15T00:00:00.000Z" }),
        ], [
            attempt({ id: "a1", examId: "exam-a", status: "completed" }),
            attempt({ id: "a2", examId: "exam-a", status: "in_progress" }),
            attempt({ id: "other", examId: "missing", status: "completed" }),
        ], 3);

        expect(rows.map(row => row.id)).toEqual(["exam-b", "exam-a"]);
        expect(rows.find(row => row.id === "exam-a")).toMatchObject({
            completedCount: 1,
            total: 3,
            isCompleted: false,
        });
        expect(rows.some(row => row.id.startsWith("mock"))).toBe(false);
    });

    it("splits archived and fully participated exams into completed", () => {
        const rows = buildExamSummaryRows([
            exam({ id: "ongoing", title: "진행", archived: false }),
            exam({ id: "done", title: "완료", archived: false }),
            exam({ id: "archived", title: "보관", archived: true }),
        ], [
            attempt({ id: "done-1", examId: "done" }),
            attempt({ id: "archived-1", examId: "archived" }),
        ], 1);

        expect(splitExamSummaryRows(rows)).toMatchObject({
            ongoing: [{ id: "ongoing" }],
            completed: [{ id: "done" }, { id: "archived" }],
        });
    });

    it("keeps retakes out of original participation while reporting retake volume", () => {
        const rows = buildExamSummaryRows([
            exam({ id: "exam-a", title: "A" }),
        ], [
            attempt({ id: "base", examId: "exam-a", studentName: "김학생" }),
            attempt({
                id: "retake",
                examId: "exam-a",
                studentName: "김학생",
                retake: {
                    sourceAttemptId: "base",
                    questionIds: [2],
                    mode: "wrong",
                    createdAt: "2026-06-15T10:00:00.000Z",
                },
            }),
        ], 2);

        expect(rows[0]).toMatchObject({
            completedCount: 1,
            retakeCount: 1,
            total: 2,
            isCompleted: false,
        });
    });

    it("counts each student once even with duplicate submissions", () => {
        const rows = buildExamSummaryRows([
            exam({ id: "exam-a", title: "A" }),
        ], [
            attempt({ id: "s1a", examId: "exam-a", studentId: "student-1", studentName: "김학생" }),
            attempt({ id: "s1b", examId: "exam-a", studentId: "student-1", studentName: "김학생" }),
            attempt({ id: "s2", examId: "exam-a", studentId: "student-2", studentName: "이학생" }),
        ], 5);

        // student-1 submitted twice but only counts once.
        expect(rows[0]).toMatchObject({ completedCount: 2, total: 5 });
    });

    it("uses the assigned group size as the participation target for group-restricted exams", () => {
        const rosterGroups = [rosterGroup("g1", "A반"), rosterGroup("g2", "B반")];
        const rosterStudents = [
            rosterStudent("s1", "A반"),
            rosterStudent("s2", "A반"),
            rosterStudent("s3", "B반"),
        ];

        const rows = buildExamSummaryRows([
            exam({ id: "exam-a", title: "A", accessConfig: { type: "group", groupIds: ["g1"] } }),
            exam({ id: "exam-open", title: "Open" }),
        ], [
            attempt({ id: "a1", examId: "exam-a", studentId: "s1" }),
        ], 20, { rosterStudents, rosterGroups });

        // exam-a is limited to A반 (2 students), so the target is 2 — not the global 20.
        expect(rows.find(row => row.id === "exam-a")).toMatchObject({ completedCount: 1, total: 2 });
        // The open exam keeps the global student count.
        expect(rows.find(row => row.id === "exam-open")).toMatchObject({ total: 20 });
    });

    it("falls back to the global count when group membership cannot be resolved", () => {
        const rows = buildExamSummaryRows([
            exam({ id: "exam-a", title: "A", accessConfig: { type: "group", groupIds: ["unknown-group"] } }),
        ], [
            attempt({ id: "a1", examId: "exam-a", studentId: "s1" }),
        ], 8, { rosterStudents: [rosterStudent("s1", "A반")], rosterGroups: [rosterGroup("g1", "A반")] });

        expect(rows[0]).toMatchObject({ total: 8 });
    });
});
