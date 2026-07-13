import type { Attempt, Exam } from "@/types/omr";
import { buildAttemptScoreLookup } from "@/lib/attemptScores";
import { studentScopeKeyForAttempt } from "@/lib/premiumAnalytics";

export interface TeacherDashboardMetrics {
    totalStudents: number;
    avgScore: number;
    activeExams: number;
    trendData: number[];
    /** Exam titles aligned 1:1 with trendData, used as chart/tooltip labels. */
    trendLabels: string[];
}

export interface TeacherDashboardMetricsOptions {
    trendLimit?: number;
    rosterStudents?: { id: string }[];
}

function timestamp(value: string | undefined): number {
    const time = new Date(value || "").getTime();
    return Number.isFinite(time) ? time : 0;
}

interface ExamTrendPoint {
    examId: string;
    label: string;
    sortTime: number;
    scoreSum: number;
    count: number;
}

export function buildTeacherDashboardMetrics(
    exams: Exam[],
    attempts: Attempt[],
    options: TeacherDashboardMetricsOptions = {},
): TeacherDashboardMetrics {
    // trendLimit is now the number of recent EXAMS shown in the score trend (default 7),
    // not the number of individual attempts.
    const trendLimit = options.trendLimit ?? 7;
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

    // Aggregate per-exam mean scorePercent so the "평균 점수 추이" chart plots one point
    // per exam (matching its "최근 7개 시험" label) instead of individual attempt scores.
    const trendByExam = new Map<string, ExamTrendPoint>();
    for (const attempt of baseAttempts) {
        const examId = attempt.examId;
        if (!examId) continue;
        const exam = examById.get(examId);
        const finished = timestamp(attempt.finishedAt);
        const point = trendByExam.get(examId);
        if (point) {
            point.scoreSum += scorePercentForAttempt(attempt);
            point.count += 1;
            // For missing exams the exam date is unknown; track the latest activity instead.
            if (!exam && finished > point.sortTime) point.sortTime = finished;
        } else {
            trendByExam.set(examId, {
                examId,
                label: exam?.title || attempt.examTitle || examId,
                sortTime: exam ? timestamp(exam.createdAt) : finished,
                scoreSum: scorePercentForAttempt(attempt),
                count: 1,
            });
        }
    }

    const orderedTrend = Array.from(trendByExam.values())
        .sort((a, b) => a.sortTime - b.sortTime)
        .slice(-trendLimit);
    const trendData = orderedTrend.map(point => Math.round(point.scoreSum / point.count));
    const trendLabels = orderedTrend.map(point => point.label);

    return {
        totalStudents,
        avgScore,
        activeExams: exams.length,
        trendData,
        trendLabels,
    };
}
