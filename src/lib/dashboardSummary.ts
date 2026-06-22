import type { Attempt, Exam } from "@/types/omr";

export interface ExamSummaryRow {
    id: string;
    title: string;
    createdAt: string;
    completedCount: number;
    retakeCount: number;
    total: number;
    archived: boolean;
    isCompleted: boolean;
}

export interface ExamSummaryGroups {
    ongoing: ExamSummaryRow[];
    completed: ExamSummaryRow[];
}

function activityTime(row: ExamSummaryRow): number {
    const time = new Date(row.createdAt).getTime();
    return Number.isFinite(time) ? time : 0;
}

export function buildExamSummaryRows(exams: Exam[], attempts: Attempt[], totalStudents: number): ExamSummaryRow[] {
    const completedByExamId = attempts.reduce((acc, attempt) => {
        if (!attempt.examId || attempt.status !== "completed" || attempt.retake) return acc;
        acc.set(attempt.examId, (acc.get(attempt.examId) || 0) + 1);
        return acc;
    }, new Map<string, number>());

    const retakesByExamId = attempts.reduce((acc, attempt) => {
        if (!attempt.examId || attempt.status !== "completed" || !attempt.retake) return acc;
        acc.set(attempt.examId, (acc.get(attempt.examId) || 0) + 1);
        return acc;
    }, new Map<string, number>());

    return exams.map(exam => {
        const completedCount = completedByExamId.get(exam.id) || 0;
        const retakeCount = retakesByExamId.get(exam.id) || 0;
        const total = Math.max(0, totalStudents, completedCount);
        const isCompleted = total > 0 && completedCount >= total;
        return {
            id: exam.id,
            title: exam.title,
            createdAt: exam.createdAt,
            completedCount,
            retakeCount,
            total,
            archived: !!exam.archived,
            isCompleted,
        };
    }).sort((a, b) => activityTime(b) - activityTime(a));
}

export function splitExamSummaryRows(rows: ExamSummaryRow[]): ExamSummaryGroups {
    return {
        ongoing: rows.filter(row => !row.archived && !row.isCompleted),
        completed: rows.filter(row => row.archived || row.isCompleted),
    };
}
