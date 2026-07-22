import { describe, expect, it } from "vitest";
import type { Attempt } from "@/types/omr";
import {
    buildStudentAttemptSeries,
    buildStudentResultHref,
    parseStudentResultView,
    sameStudentAttempt,
} from "./studentResultHub";

function attempt(partial: Partial<Attempt>): Attempt {
    return {
        id: "attempt-1",
        examId: "exam-1",
        examTitle: "중간고사",
        studentName: "김학생",
        startedAt: "2026-06-01T09:00:00.000Z",
        finishedAt: "2026-06-01T10:00:00.000Z",
        score: 0,
        totalScore: 100,
        answers: {},
        status: "completed",
        ...partial,
    };
}

describe("student result hub", () => {
    it("defaults missing or invalid views to answers while retaining handwriting", () => {
        expect(parseStudentResultView()).toBe("answers");
        expect(parseStudentResultView("unexpected")).toBe("answers");
        expect(parseStudentResultView("handwriting")).toBe("handwriting");
    });

    it("builds canonical result links with encoded attempt ids", () => {
        expect(buildStudentResultHref("attempt/a", "analytics")).toBe("/teacher/attempt/attempt%2Fa?view=analytics");
    });

    it("matches stable student identifiers across profile and legacy id fields", () => {
        expect(sameStudentAttempt(
            attempt({ studentProfileId: " profile-1 " }),
            attempt({ id: "attempt-2", studentId: "profile-1" }),
        )).toBe(true);
    });

    it("only uses the legacy name fallback within the same non-empty group", () => {
        const grouped = attempt({ studentName: " 김학생 ", groupId: "group-1" });
        expect(sameStudentAttempt(grouped, attempt({ id: "same-group", studentName: "김학생", groupName: "group-1" }))).toBe(true);
        expect(sameStudentAttempt(grouped, attempt({ id: "other-group", studentName: "김학생", groupId: "group-2" }))).toBe(false);
        expect(sameStudentAttempt(
            attempt({ studentName: "김학생" }),
            attempt({ id: "bare-name", studentName: "김학생" }),
        )).toBe(false);
    });

    it("builds an ordered same-student series with retake score deltas", () => {
        const original = attempt({ id: "original", studentId: "student-1", score: 60, finishedAt: "2026-06-01T10:00:00.000Z" });
        const retake = attempt({
            id: "retake",
            studentProfileId: "student-1",
            score: 80,
            finishedAt: "2026-06-03T10:00:00.000Z",
            retake: { sourceAttemptId: "original", questionIds: [1, 2], mode: "wrong", createdAt: "2026-06-02T10:00:00.000Z" },
        });
        const otherExam = attempt({ id: "other-exam", examId: "exam-2", studentId: "student-1" });
        const otherStudent = attempt({ id: "other-student", studentId: "student-2" });

        expect(buildStudentAttemptSeries(retake, [retake, otherExam, original, otherStudent])).toEqual([
            expect.objectContaining({ attempt: original, kind: "original", ordinal: 1, scorePercent: 60, scoreDelta: null }),
            expect.objectContaining({ attempt: retake, kind: "retake", ordinal: 1, scorePercent: 80, scoreDelta: 20 }),
        ]);
    });
});
