import type { Attempt, Exam } from "@/types/omr";
import { studentScopeKeyForAttempt } from "@/lib/premiumAnalytics";
import { rosterGroupMatchesStudent, type RosterGroup, type RosterStudent } from "@/lib/rosterStorage";

export interface ExamSummaryOptions {
    rosterStudents?: RosterStudent[];
    rosterGroups?: RosterGroup[];
}

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

/**
 * Per-exam target headcount. When an exam is restricted to specific roster groups
 * (accessConfig.type === "group"), the denominator is the number of unique students in
 * those groups — not the global student count. Falls back to the global count for open
 * exams or when group membership can't be resolved from the roster.
 */
function resolveExamTargetCount(
    exam: Exam,
    totalStudents: number,
    rosterStudents: RosterStudent[],
    rosterGroups: RosterGroup[],
): number {
    const access = exam.accessConfig;
    if (!access || access.type !== "group" || !access.groupIds || access.groupIds.length === 0) {
        return totalStudents;
    }
    const selectedIds = new Set(access.groupIds.map(id => (id || "").trim()).filter(Boolean));
    if (selectedIds.size === 0) return totalStudents;

    const selectedGroups = rosterGroups.filter(group => selectedIds.has(group.id) || selectedIds.has(group.name));
    if (selectedGroups.length === 0) return totalStudents;

    const targetStudentIds = new Set<string>();
    for (const student of rosterStudents) {
        if (selectedGroups.some(group => rosterGroupMatchesStudent(group, student))) {
            targetStudentIds.add(student.id || `${student.name}::${student.group}`);
        }
    }
    // A resolved-but-empty membership most likely means legacy attempts aren't linked to
    // the roster by id; fall back to the global count rather than reporting a 0 target.
    return targetStudentIds.size > 0 ? targetStudentIds.size : totalStudents;
}

export function buildExamSummaryRows(
    exams: Exam[],
    attempts: Attempt[],
    totalStudents: number,
    options: ExamSummaryOptions = {},
): ExamSummaryRow[] {
    const rosterStudents = options.rosterStudents || [];
    const rosterGroups = options.rosterGroups || [];

    // Count UNIQUE students per exam so duplicate submissions by the same student don't
    // inflate participation. Attempts without a resolvable identity fall back to their id.
    const completedStudentsByExamId = new Map<string, Set<string>>();
    for (const attempt of attempts) {
        if (!attempt.examId || attempt.status !== "completed" || attempt.retake) continue;
        const key = studentScopeKeyForAttempt(attempt) || attempt.id;
        let set = completedStudentsByExamId.get(attempt.examId);
        if (!set) {
            set = new Set<string>();
            completedStudentsByExamId.set(attempt.examId, set);
        }
        set.add(key);
    }

    const retakesByExamId = attempts.reduce((acc, attempt) => {
        if (!attempt.examId || attempt.status !== "completed" || !attempt.retake) return acc;
        acc.set(attempt.examId, (acc.get(attempt.examId) || 0) + 1);
        return acc;
    }, new Map<string, number>());

    return exams.map(exam => {
        const completedCount = completedStudentsByExamId.get(exam.id)?.size || 0;
        const retakeCount = retakesByExamId.get(exam.id) || 0;
        const targetCount = resolveExamTargetCount(exam, totalStudents, rosterStudents, rosterGroups);
        const total = Math.max(0, targetCount, completedCount);
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
