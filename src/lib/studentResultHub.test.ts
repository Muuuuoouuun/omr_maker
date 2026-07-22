import { describe, expect, it, vi } from "vitest";
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
        expect(parseStudentResultView("report")).toBe("report");
        expect(parseStudentResultView("analytics")).toBe("analytics");
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

    it("falls back to matching guest ids without joining different guests", () => {
        expect(sameStudentAttempt(
            attempt({ guestId: "guest-1" }),
            attempt({ id: "same-guest", guestId: "guest-1" }),
        )).toBe(true);
        expect(sameStudentAttempt(
            attempt({ guestId: "guest-1" }),
            attempt({ id: "other-guest", guestId: "guest-2" }),
        )).toBe(false);
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

    it("orders attempts chronologically within original and retake groups", () => {
        const laterOriginal = attempt({ id: "original-later", studentId: "student-1", finishedAt: "2026-06-03T10:00:00.000Z" });
        const earlierOriginal = attempt({ id: "original-earlier", studentId: "student-1", finishedAt: "2026-06-01T10:00:00.000Z" });
        const laterRetake = attempt({
            id: "retake-later",
            studentId: "student-1",
            finishedAt: "2026-06-05T10:00:00.000Z",
            retake: { sourceAttemptId: "original-later", questionIds: [], mode: "wrong", createdAt: "2026-06-04T10:00:00.000Z" },
        });
        const earlierRetake = attempt({
            id: "retake-earlier",
            studentId: "student-1",
            finishedAt: "2026-06-04T10:00:00.000Z",
            retake: { sourceAttemptId: "original-earlier", questionIds: [], mode: "wrong", createdAt: "2026-06-03T10:00:00.000Z" },
        });

        expect(buildStudentAttemptSeries(laterOriginal, [laterRetake, laterOriginal, earlierRetake, earlierOriginal])
            .map(item => [item.attempt.id, item.ordinal]))
            .toEqual([
                ["original-earlier", 1],
                ["original-later", 2],
                ["retake-earlier", 1],
                ["retake-later", 2],
            ]);
    });

    it("uses safe score percentages and a null delta when a retake source is missing", () => {
        const original = attempt({ id: "original", studentId: "student-1", score: 3, totalScore: 6 });
        const orphanRetake = attempt({
            id: "orphan-retake",
            studentId: "student-1",
            score: 5,
            totalScore: 8,
            retake: { sourceAttemptId: "missing", questionIds: [], mode: "wrong", createdAt: "2026-06-02T10:00:00.000Z" },
        });

        expect(buildStudentAttemptSeries(original, [orphanRetake, original])).toEqual([
            expect.objectContaining({ attempt: original, scorePercent: 50, scoreDelta: null }),
            expect.objectContaining({ attempt: orphanRetake, scorePercent: 63, scoreDelta: null }),
        ]);
    });

    it("rounds fractional source deltas to one decimal place", async () => {
        vi.resetModules();
        vi.doMock("@/lib/scoreUtils", () => ({
            safeScorePercent: (score: number) => score,
        }));

        const original = attempt({ id: "original", studentId: "student-1", score: 60.01, totalScore: 10 });
        const retake = attempt({
            id: "retake",
            studentId: "student-1",
            score: 80.06,
            totalScore: 10,
            retake: { sourceAttemptId: "original", questionIds: [], mode: "wrong", createdAt: "2026-06-02T10:00:00.000Z" },
        });
        try {
            const { buildStudentAttemptSeries: buildSeriesWithFractionalScores } = await import("./studentResultHub");
            const [, result] = buildSeriesWithFractionalScores(original, [original, retake]);
            expect(result.scoreDelta).toBe(20.1);
        } finally {
            vi.doUnmock("@/lib/scoreUtils");
            vi.resetModules();
        }
    });
});
