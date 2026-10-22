import { describe, expect, it } from "vitest";
import type { Attempt, Exam } from "@/types/omr";
import { classifyTeacherLiveExamPhase, selectTeacherLiveExamId, type TeacherLiveExamPhase } from "./teacherLiveExamState";

type SelectionExam = Pick<Exam, "id" | "archived" | "startAt" | "endAt">;
type SelectionAttempt = Pick<Attempt, "examId" | "status">;
const now = Date.parse("2026-10-21T03:00:00.000Z");

/** The previous stable-sort selector, retained as a behavioral reference. */
function selectByStableSort(exams: readonly SelectionExam[], attempts: readonly SelectionAttempt[], currentId = ""): string {
    if (exams.some(exam => exam.id === currentId)) return currentId;
    const rank: Record<TeacherLiveExamPhase, number> = { live: 0, scheduled: 1, ready: 2, completed: 3 };
    return [...exams].sort((left, right) => (
        rank[classifyTeacherLiveExamPhase(left, attempts.filter(attempt => attempt.examId === left.id), now)]
        - rank[classifyTeacherLiveExamPhase(right, attempts.filter(attempt => attempt.examId === right.id), now)]
    ))[0]?.id || "";
}

describe("teacher live exam selection", () => {
    it("preserves time-window precedence and stable first-row ties across mixed catalogs", () => {
        const variants = [
            {},
            { archived: true },
            { startAt: "2026-10-22T03:00:00.000Z" },
            { startAt: "2026-10-20T03:00:00.000Z" },
            { endAt: "2026-10-20T03:00:00.000Z" },
            { endAt: "2026-10-22T03:00:00.000Z" },
            { startAt: "invalid", endAt: "invalid" },
        ];
        for (let seed = 0; seed < 100; seed += 1) {
            const exams = Array.from({ length: 20 }, (_, index) => ({
                id: `exam-${index}`,
                ...variants[(index * 3 + seed) % variants.length],
            }));
            const attempts: SelectionAttempt[] = Array.from({ length: 65 }, (_, index) => ({
                examId: `exam-${(index * 11 + seed) % 25}`,
                status: (index + seed) % 4 === 0 ? "in_progress" : "completed",
            }));
            for (const catalog of [exams, [...exams].reverse()]) {
                for (const currentId of ["", "missing", "exam-7"]) {
                    expect(selectTeacherLiveExamId(catalog, attempts, currentId, now))
                        .toBe(selectByStableSort(catalog, attempts, currentId));
                }
            }
        }
    });

    it("preserves input arrays and handles empty catalogs and attempts", () => {
        const exams = Object.freeze([{ id: "first" }, { id: "second" }]);
        const attempts = Object.freeze([{ examId: "second", status: "in_progress" as const }]);
        expect(selectTeacherLiveExamId([], attempts, "missing", now)).toBe("");
        expect(selectTeacherLiveExamId(exams, [], "missing", now)).toBe("first");
        expect(selectTeacherLiveExamId(exams, attempts, "missing", now)).toBe("second");
        expect(exams.map(exam => exam.id)).toEqual(["first", "second"]);
    });

    it("keeps a valid explicit selection without inspecting attempts", () => {
        const attempts = [{
            get examId(): string { throw new Error("the current selection needs no attempt scan"); },
            status: "in_progress" as const,
        }];
        expect(selectTeacherLiveExamId([], attempts, "chosen", now)).toBe("");
        expect(selectTeacherLiveExamId([{ id: "chosen", archived: true }, { id: "live" }], attempts, "chosen", now))
            .toBe("chosen");
    });

    it("reads each active attempt's exam id at most once for large catalogs", () => {
        let idReads = 0;
        const exams = Array.from({ length: 200 }, (_, index) => ({ id: `exam-${index}` }));
        const attempts = Array.from({ length: 2000 }, (_, index) => ({
            get examId() { idReads += 1; return `exam-${index % exams.length}`; },
            status: index % 2 ? "completed" as const : "in_progress" as const,
        }));
        const expected = selectByStableSort(exams, attempts);
        const legacyReads = idReads;
        idReads = 0;
        expect(selectTeacherLiveExamId(exams, attempts, "", now)).toBe(expected);
        expect(legacyReads).toBeGreaterThan(100_000);
        expect(idReads).toBeLessThanOrEqual(attempts.length);
    });
});
