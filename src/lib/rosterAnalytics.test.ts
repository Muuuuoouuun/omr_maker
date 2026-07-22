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

    it("assigns a studentProfileId attempt only to the exact roster student", () => {
        const now = Date.parse("2026-06-15T12:00:00.000Z");
        const sameNameStudents: RosterStudent[] = [
            { ...student, id: "profile-a" },
            { ...student, id: "profile-b", email: "b@example.com" },
        ];
        const exact = attempt("profile-exact", { 1: 1, 2: 2 }, "2026-06-15T10:00:00.000Z", {
            studentProfileId: "profile-b",
            studentId: undefined,
        });

        const indexed = buildRosterPerformanceMap(sameNameStudents, [exact], new Map([[exam.id, exam]]), now);

        expect(indexed.get("profile-a")?.attempts).toEqual([]);
        expect(indexed.get("profile-b")?.attempts.map(item => item.id)).toEqual(["profile-exact"]);
    });

    it("assigns conflicting canonical and legacy ids only to the canonical roster student", () => {
        const canonical = { ...student, id: "profile-a" };
        const legacy = { ...student, id: "profile-b", email: "legacy@example.com" };
        const conflicting = attempt("conflicting-ids", { 1: 1 }, "2026-06-15T10:00:00.000Z", {
            studentProfileId: canonical.id,
            studentId: legacy.id,
        });

        const indexed = buildRosterPerformanceMap(
            [canonical, legacy],
            [conflicting],
            new Map([[exam.id, exam]]),
        );

        expect(indexed.get(canonical.id)?.attempts.map(item => item.id)).toEqual(["conflicting-ids"]);
        expect(indexed.get(legacy.id)?.attempts).toEqual([]);
    });

    it("drops a canonical-id attempt when only its conflicting legacy roster student exists", () => {
        const legacy = { ...student, id: "profile-b" };
        const conflicting = attempt("missing-canonical", { 1: 1 }, "2026-06-15T10:00:00.000Z", {
            studentProfileId: "profile-a",
            studentId: legacy.id,
        });

        const indexed = buildRosterPerformanceMap(
            [legacy],
            [conflicting],
            new Map([[exam.id, exam]]),
        );

        expect(indexed.get(legacy.id)?.attempts).toEqual([]);
    });

    it("does not fall back to a matching name when a stable id misses the roster", () => {
        const unmatchedStable = attempt("stable-miss", { 1: 1 }, "2026-06-15T10:00:00.000Z", {
            studentProfileId: "missing-profile",
            studentId: undefined,
        });

        const indexed = buildRosterPerformanceMap([student], [unmatchedStable], new Map([[exam.id, exam]]));

        expect(indexed.get(student.id)?.attempts).toEqual([]);
    });

    it("excludes a legacy attempt when duplicate roster students both match", () => {
        const duplicate = { ...student, id: "duplicate", email: "duplicate@example.com" };
        const legacy = attempt("ambiguous", { 1: 1 }, "2026-06-15T10:00:00.000Z", {
            studentId: undefined,
        });

        const indexed = buildRosterPerformanceMap([student, duplicate], [legacy], new Map([[exam.id, exam]]));

        expect(indexed.get(student.id)?.attempts).toEqual([]);
        expect(indexed.get(duplicate.id)?.attempts).toEqual([]);
    });

    it("includes a legacy name-and-group attempt when exactly one roster student matches", () => {
        const other = { ...student, id: "other", name: "이학생", email: "other@example.com" };
        const legacy = attempt("unique-legacy", { 1: 1 }, "2026-06-15T10:00:00.000Z", {
            studentId: undefined,
        });

        const indexed = buildRosterPerformanceMap([student, other], [legacy], new Map([[exam.id, exam]]));

        expect(indexed.get(student.id)?.attempts.map(item => item.id)).toEqual(["unique-legacy"]);
        expect(indexed.get(other.id)?.attempts).toEqual([]);
    });

    it("keeps each indexed attempt bucket sorted newest first", () => {
        const oldAttempt = attempt("old-indexed", { 1: 1 }, "2026-06-14T10:00:00.000Z");
        const newAttempt = attempt("new-indexed", { 1: 1, 2: 2 }, "2026-06-15T10:00:00.000Z");

        const indexed = buildRosterPerformanceMap(
            [student],
            [oldAttempt, newAttempt],
            new Map([[exam.id, exam]]),
            Date.parse("2026-06-15T12:00:00.000Z"),
        );

        expect(indexed.get(student.id)?.attempts.map(item => item.id)).toEqual(["new-indexed", "old-indexed"]);
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
