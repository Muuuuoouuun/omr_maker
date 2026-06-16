import type { Attempt, Exam } from "@/types/omr";
import { buildAttemptScoreLookup } from "@/lib/attemptScores";
import { studentScopeKeyForAttempt } from "@/lib/premiumAnalytics";

export interface TeacherDashboardMetrics {
    totalStudents: number;
    avgScore: number;
    activeExams: number;
    trendData: number[];
}

export interface TeacherDashboardMetricsOptions {
    trendLimit?: number;
    rosterStudents?: { id: string }[];
}

function timestamp(value: string | undefined): number {
    const time = new Date(value || "").getTime();
    return Number.isFinite(time) ? time : 0;
}

export function buildTeacherDashboardMetrics(
    exams: Exam[],
    attempts: Attempt[],
    options: TeacherDashboardMetricsOptions = {},
): TeacherDashboardMetrics {
    const trendLimit = options.trendLimit ?? 10;
    const examById = new Map(exams.map(exam => [exam.id, exam]));
    const scoreByAttemptId = buildAttemptScoreLookup(attempts, examById);
    const baseAttempts = attempts.filter(attempt => !attempt.retake);
    const scorePercentForAttempt = (attempt: Attempt): number => (
        scoreByAttemptId.get(attempt.id)?.scorePercent ?? 0
    );

    const avgScore = baseAttempts.length > 0
        ? Math.round(baseAttempts.reduce((sum, attempt) => sum + scorePercentForAttempt(attempt), 0) / baseAttempts.length)
        : 0;

    const attemptStudentCount = new Set(
        baseAttempts
            .map(studentScopeKeyForAttempt)
            .filter(Boolean)
    ).size;
    const rosterStudentCount = new Set(
        (options.rosterStudents || []).map(student => student.id).filter(Boolean)
    ).size;
    const totalStudents = rosterStudentCount > 0 ? rosterStudentCount : attemptStudentCount;

    const trendData = [...baseAttempts]
        .sort((a, b) => timestamp(a.finishedAt) - timestamp(b.finishedAt))
        .map(scorePercentForAttempt)
        .slice(-trendLimit);

    return {
        totalStudents,
        avgScore,
        activeExams: exams.length,
        trendData,
    };
}
