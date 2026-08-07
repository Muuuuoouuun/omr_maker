import { describe, expect, it } from "vitest";
import type { Exam } from "@/types/omr";
import type { TeacherAttemptAggregate, TeacherAttemptExportRow } from "./teacherAttemptReportingGateway";
import { buildTeacherAttemptReportingProjection } from "./teacherAttemptReportingProjection";

const exams: Exam[] = [{
    id: "exam-1",
    title: "=위험한 시험명",
    questions: [],
    createdAt: "2026-08-01T00:00:00.000Z",
}];

const aggregate: TeacherAttemptAggregate = {
    totalAttemptCount: 4,
    completedAttemptCount: 3,
    inProgressAttemptCount: 1,
    baseAttemptCount: 3,
    completedBaseAttemptCount: 2,
    distinctStudentCount: 2,
    completedBaseScorePercentSum: 154.6,
    averageScorePercent: 77.3,
    periodAttemptCount: 0,
    periodHandwritingArchiveCount: 0,
    periodHandwritingQuestionCount: 0,
    periodHandwritingStrokeCount: 0,
    snapshotAt: "2026-08-07T01:00:00.000Z",
};

function row(id: string, hash: string, scorePercent: number, isRetake = false): TeacherAttemptExportRow {
    return {
        attemptId: id,
        examId: "exam-1",
        studentScopeHash: hash,
        status: "completed",
        scorePercent,
        isRetake,
        handwritingArchived: false,
        handwritingQuestionCount: 0,
        handwritingStrokeCount: 0,
        startedAt: "2026-08-07T00:00:00.000Z",
        finishedAt: "2026-08-07T00:10:00.000Z",
    };
}

describe("teacher attempt reporting projection", () => {
    it("builds exact CSV/dashboard primitives from pseudonymous completed rows", () => {
        const projection = buildTeacherAttemptReportingProjection({
            exams,
            aggregate,
            rows: [
                row("attempt-1", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 90),
                row("attempt-2", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 70),
                row("attempt-3", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", 100, true),
            ],
        });

        expect(projection.stats).toMatchObject({
            totalStudents: 2,
            avgScore: 77.3,
            activeExams: 1,
        });
        expect(projection.examRows[0]).toMatchObject({
            title: "=위험한 시험명",
            completedCount: 1,
            retakeCount: 1,
        });
        expect(projection.scores).toEqual([90, 70]);
        expect(projection.attempts).toHaveLength(3);
        expect(projection.attempts[0]).toMatchObject({
            studentId: "report:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            studentName: "익명 응시자",
        });
    });
});
