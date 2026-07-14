import { describe, expect, it } from "vitest";
import type { Attempt, Exam } from "@/types/omr";
import type { RosterGroup, RosterStudent } from "@/lib/rosterStorage";
import {
    applyRosterPerformance,
    buildRosterPerformanceMap,
    buildRosterStudentPerformance,
    recomputeRosterGroupsFromStudents,
} from "./rosterAnalytics";

const exam: Exam = {
    id: "exam-1",
    title: "기말",
    createdAt: "2026-06-15T00:00:00.000Z",
    questions: [
        { id: 1, number: 1, answer: 1, score: 5 },
        { id: 2, number: 2, answer: 2, score: 5 },
    ],
};

const student: RosterStudent = {
    id: "g1::김학생",
    name: "김학생",
    email: "student@example.com",
    group: "A반",
    avatar: "#000",
    avgScore: 0,
    examsTaken: 0,
    lastActive: "기록 없음",
    trend: "flat",
    status: "idle",
};

function attempt(id: string, answers: Record<number, number>, finishedAt: string, overrides: Partial<Attempt> = {}): Attempt {
    return {
        id,
        examId: exam.id,
        examTitle: exam.title,
        studentId: student.id,
        studentName: student.name,
        groupName: student.group,
        startedAt: finishedAt,
        finishedAt,
        score: 0,
        totalScore: 10,
        answers,
        status: "completed",
        ...overrides,
    };
}

describe("roster analytics", () => {
    it("derives student averages, attempt count, activity, and trend from attempts", () => {
        const now = Date.parse("2026-06-15T12:00:00.000Z");
        const performance = buildRosterStudentPerformance(student, [
            attempt("old", { 1: 1, 2: 1 }, "2026-06-14T12:00:00.000Z"),
            attempt("new", { 1: 1, 2: 2 }, "2026-06-15T10:00:00.000Z"),
        ], new Map([[exam.id, exam]]), now);

        expect(performance.avgScore).toBe(75);
        expect(performance.examsTaken).toBe(2);
        expect(performance.lastActive).toBe("2시간 전");
        expect(performance.trend).toBe("up");
        expect(performance.status).toBe("active");
    });

    it("keeps retakes out of roster averages and exam counts while preserving activity", () => {
        const now = Date.parse("2026-06-15T12:00:00.000Z");
        const performance = buildRosterStudentPerformance(student, [
            attempt("base", { 1: 1, 2: 1 }, "2026-06-14T12:00:00.000Z"),
            attempt("retake", { 2: 2 }, "2026-06-15T10:00:00.000Z", {
                retake: {
                    sourceAttemptId: "base",
                    questionIds: [2],
                    mode: "wrong",
                    createdAt: "2026-06-14T12:30:00.000Z",
                },
            }),
        ], new Map([[exam.id, exam]]), now);

        expect(performance.avgScore).toBe(50);
        expect(performance.examsTaken).toBe(1);
        expect(performance.lastActive).toBe("2시간 전");
        expect(performance.trend).toBe("flat");
        expect(performance.attempts.map(item => item.id)).toEqual(["retake", "base"]);
    });

    it("keeps roster fallback values when no attempts exist", () => {
        const fallback = { ...student, avgScore: 82, examsTaken: 3, lastActive: "어제", status: "active" as const };

        expect(buildRosterStudentPerformance(fallback, [], new Map(), Date.now())).toMatchObject({
            avgScore: 82,
            examsTaken: 3,
            lastActive: "어제",
            status: "active",
        });
    });

    it("indexes attempts without changing exact-id or legacy name/group matching", () => {
        const now = Date.parse("2026-06-15T12:00:00.000Z");
        const regionalStudents: RosterStudent[] = [
            { ...student, id: "g-seoul::김학생", region: "서울" },
            { ...student, id: "g-busan::김학생", email: "busan@example.com", region: "부산" },
            { ...student, id: " g-seoul::이학생 ", name: "이학생", email: "lee@example.com", region: "서울" },
        ];
        const attempts: Attempt[] = [
            attempt("exact", { 1: 1, 2: 2 }, "2026-06-15T10:00:00.000Z", {
                studentId: regionalStudents[0].id,
                studentName: "과거이름",
                regionName: "부산",
            }),
            attempt("legacy-busan", { 1: 1, 2: 1 }, "2026-06-14T10:00:00.000Z", {
                studentId: undefined,
                studentName: "김학생",
                groupName: "A반",
                regionName: "부산",
            }),
            attempt("scoped-name", { 1: 1, 2: 2 }, "2026-06-13T10:00:00.000Z", {
                studentId: "g-seoul::이학생",
                studentName: "과거이름",
                groupName: "다른반",
                regionName: "서울",
            }),
            attempt("legacy-scoped-name", { 1: 1, 2: 1 }, "2026-06-13T09:00:00.000Z", {
                studentId: "legacy-group::이학생",
                studentName: undefined,
                groupName: "A반",
                regionName: "서울",
            }),
            attempt("unrelated", { 1: 1, 2: 2 }, "2026-06-12T10:00:00.000Z", {
                studentId: "other::박학생",
                studentName: "박학생",
            }),
        ];
        const examById = new Map([[exam.id, exam]]);

        const indexed = buildRosterPerformanceMap(regionalStudents, attempts, examById, now);
        for (const profile of regionalStudents) {
            expect(indexed.get(profile.id)).toEqual(
                buildRosterStudentPerformance(profile, attempts, examById, now),
            );
        }
    });

    it("applies performance and recomputes group averages from students with attempts", () => {
        const performance = new Map([
            [student.id, { avgScore: 75, examsTaken: 2, lastActive: "방금 전", trend: "up" as const, status: "active" as const, attempts: [] }],
        ]);
        const applied = applyRosterPerformance([student], performance);
        const groups: RosterGroup[] = [{ id: "g1", name: "A반", count: 0, avgScore: 0, color: "#000" }];

        expect(applied[0].avgScore).toBe(75);
        expect(recomputeRosterGroupsFromStudents(applied, groups)[0]).toMatchObject({
            count: 1,
            avgScore: 75,
        });
    });

    it("recomputes same-name class groups separately by region", () => {
        const regionalStudents: RosterStudent[] = [
            { ...student, id: "서울/A반::김학생", group: "A반", region: "서울", avgScore: 80, examsTaken: 2 },
            { ...student, id: "부산/A반::김학생", group: "A반", region: "부산", avgScore: 60, examsTaken: 1 },
        ];
        const groups: RosterGroup[] = [
            { id: "g-seoul", name: "A반", region: "서울", count: 0, avgScore: 0, color: "#000" },
            { id: "g-busan", name: "A반", region: "부산", count: 0, avgScore: 0, color: "#111" },
        ];

        expect(recomputeRosterGroupsFromStudents(regionalStudents, groups)).toEqual([
            expect.objectContaining({ id: "g-seoul", count: 1, avgScore: 80 }),
            expect.objectContaining({ id: "g-busan", count: 1, avgScore: 60 }),
        ]);
    });

    it("keeps legacy id-scoped students while indexing modern group membership", () => {
        const legacyStudent: RosterStudent = {
            ...student,
            id: "legacy-group::구학생",
            name: "구학생",
            group: "",
            avgScore: 90,
            examsTaken: 1,
        };
        const modernStudent: RosterStudent = {
            ...student,
            id: "modern::신학생",
            name: "신학생",
            group: "현대반",
            avgScore: 70,
            examsTaken: 1,
        };
        const groups: RosterGroup[] = [
            { id: "legacy-group", name: "구반", count: 0, avgScore: 0, color: "#000" },
            { id: "modern-group", name: "현대반", count: 0, avgScore: 0, color: "#111" },
        ];

        expect(recomputeRosterGroupsFromStudents([legacyStudent, modernStudent], groups)).toEqual([
            expect.objectContaining({ id: "legacy-group", count: 1, avgScore: 90 }),
            expect.objectContaining({ id: "modern-group", count: 1, avgScore: 70 }),
        ]);
    });
});
