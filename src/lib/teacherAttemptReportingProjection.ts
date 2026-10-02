import { buildExamSummaryRows, type ExamSummaryRow } from "@/lib/dashboardSummary";
import { buildTeacherDashboardMetrics, type TeacherDashboardMetrics } from "@/lib/teacherDashboardMetrics";
import type { RosterGroup, RosterStudent } from "@/lib/rosterStorage";
import type {
    TeacherAttemptAggregate,
    TeacherAttemptExportRow,
} from "@/lib/teacherAttemptReportingGateway";
import type { Attempt, Exam } from "@/types/omr";

export interface TeacherAttemptReportingProjectionInput {
    exams: Exam[];
    aggregate: TeacherAttemptAggregate;
    rows: TeacherAttemptExportRow[];
    rosterStudents?: RosterStudent[];
    rosterGroups?: RosterGroup[];
    individualAssignmentTargetCounts?: ReadonlyMap<string, number>;
    individualAssignmentModes?: ReadonlyMap<string, "base" | "retake">;
}

export interface TeacherAttemptReportingProjection {
    stats: TeacherDashboardMetrics;
    attempts: Attempt[];
    examRows: ExamSummaryRow[];
    scores: number[];
}

function reportingAttempt(row: TeacherAttemptExportRow, examTitle: string): Attempt {
    return {
        id: row.attemptId,
        examId: row.examId,
        examTitle,
        studentName: "익명 응시자",
        studentId: `report:${row.studentScopeHash}`,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        score: row.scorePercent,
        totalScore: 100,
        answers: {},
        status: "completed",
        ...(row.handwritingArchived ? { handwritingArchived: true } : {}),
        drawingStrokeCount: row.handwritingStrokeCount,
        ...(row.isRetake ? {
            retake: {
                sourceAttemptId: "redacted",
                questionIds: [],
                mode: "custom" as const,
                createdAt: row.finishedAt,
            },
        } : {}),
    };
}

export function buildTeacherAttemptReportingProjection(
    input: TeacherAttemptReportingProjectionInput,
): TeacherAttemptReportingProjection {
    const titleByExamId = new Map(input.exams.map(exam => [exam.id, exam.title]));
    const attempts = input.rows.map(row => reportingAttempt(
        row,
        titleByExamId.get(row.examId) || row.examId,
    ));
    const derived = buildTeacherDashboardMetrics(input.exams, attempts, {
        rosterStudents: input.rosterStudents,
    });
    const rosterStudentCount = new Set(
        (input.rosterStudents || []).map(student => student.id).filter(Boolean),
    ).size;
    const stats = {
        ...derived,
        totalStudents: rosterStudentCount || input.aggregate.distinctStudentCount,
        avgScore: input.aggregate.averageScorePercent,
    };
    const examRows = buildExamSummaryRows(
        input.exams,
        attempts,
        stats.totalStudents,
        {
            rosterStudents: input.rosterStudents,
            rosterGroups: input.rosterGroups,
            individualAssignmentTargetCounts: input.individualAssignmentTargetCounts,
            individualAssignmentModes: input.individualAssignmentModes,
        },
    );
    return {
        stats,
        attempts,
        examRows,
        scores: input.rows
            .filter(row => !row.isRetake)
            .map(row => row.scorePercent),
    };
}
