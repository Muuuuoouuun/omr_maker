import type {
    LoadTeacherIndividualAssignmentResult,
} from "@/lib/individualAssignmentGateway";
import type { Exam } from "@/types/omr";
import type { StudentAssignmentPreview, StudentAttemptSummary } from "@/lib/studentExamContract";
import { resolveAssignmentLifecycle } from "@/lib/assignmentLifecycle";

export interface ReviewOnlyCompletedAssignment {
    id: string;
    title: string;
    createdAt: string;
    lifecycle: "closed";
    reviewOnly: true;
    attemptId: string;
    answeredQuestionCount?: number;
}

/** Converts a device-local Exam into the same fail-closed lifecycle shape as a server preview. */
export function localStudentAssignmentPreview(exam: Exam, now: string): StudentAssignmentPreview {
    return {
        id: exam.id,
        title: exam.title,
        createdAt: exam.createdAt,
        ...(exam.updatedAt ? { updatedAt: exam.updatedAt } : {}),
        ...(typeof exam.durationMin === "number" ? { durationMin: exam.durationMin } : {}),
        ...(exam.startAt ? { startsAt: exam.startAt } : {}),
        ...(exam.endAt ? { endsAt: exam.endAt } : {}),
        ...(typeof exam.archived === "boolean" ? { archived: exam.archived } : {}),
        lifecycle: resolveAssignmentLifecycle({
            state: exam.archived ? "archived" : "open",
            startsAt: exam.startAt,
            endsAt: exam.endAt,
            now,
        }),
        access: {
            type: exam.accessConfig?.type === "targeted"
                ? "targeted"
                : exam.accessConfig?.type === "group"
                    ? "group"
                    : "public",
            entryCheck: "required",
        },
    };
}

/** Restores review navigation for completed base exams omitted from the active assignment list. */
export function buildMissingCompletedReviewAssignments(
    visibleExamIds: ReadonlySet<string>,
    attempts: readonly StudentAttemptSummary[],
): ReviewOnlyCompletedAssignment[] {
    const latestByExam = new Map<string, StudentAttemptSummary>();
    for (const attempt of attempts) {
        if (attempt.status !== "completed" || attempt.retakeSourceAttemptId || visibleExamIds.has(attempt.examId)) continue;
        const current = latestByExam.get(attempt.examId);
        const currentTime = current ? Date.parse(current.finishedAt) : Number.NEGATIVE_INFINITY;
        const candidateTime = Date.parse(attempt.finishedAt);
        if (
            !current
            || (Number.isFinite(candidateTime) ? candidateTime : Number.NEGATIVE_INFINITY) > currentTime
            || (candidateTime === currentTime && attempt.id > current.id)
        ) latestByExam.set(attempt.examId, attempt);
    }

    return [...latestByExam.values()]
        .sort((left, right) => right.finishedAt.localeCompare(left.finishedAt) || left.examId.localeCompare(right.examId))
        .map(attempt => ({
            id: attempt.examId,
            title: attempt.examTitle,
            createdAt: attempt.startedAt,
            lifecycle: "closed" as const,
            reviewOnly: true as const,
            attemptId: attempt.id,
            ...(attempt.answeredQuestionCount ? { answeredQuestionCount: attempt.answeredQuestionCount } : {}),
        }));
}

type AssignmentLike = Pick<StudentAssignmentPreview,
    "id" | "assignmentId" | "assignmentMode" | "retakeSourceAttemptId"
>;

/** A retake assignment is complete only when its own scoped retake is complete. */
export function findCompletedAttemptForAssignment(
    assignment: AssignmentLike,
    attempts: StudentAttemptSummary[],
): StudentAttemptSummary | undefined {
    if (assignment.assignmentMode === "retake") {
        if (!assignment.assignmentId || !assignment.retakeSourceAttemptId) return undefined;
        return attempts.find(attempt => (
            attempt.status === "completed"
            && attempt.assignmentId === assignment.assignmentId
            && attempt.retakeSourceAttemptId === assignment.retakeSourceAttemptId
        ));
    }
    if (assignment.assignmentId) {
        return attempts.find(attempt => (
            attempt.status === "completed"
            && attempt.assignmentId === assignment.assignmentId
            && !attempt.retakeSourceAttemptId
        ));
    }
    return attempts.find(attempt => (
        attempt.status === "completed"
        && attempt.examId === assignment.id
        && !attempt.retakeSourceAttemptId
    ));
}

export async function reloadLatestAssignmentAfterConflict(
    examId: string,
    load: (examId: string) => Promise<LoadTeacherIndividualAssignmentResult | { status: "local_only" }>,
): Promise<
    | { status: "loaded"; revision: number; mode: "base" | "retake"; targetStudentIds: string[] }
    | { status: "unavailable" }
> {
    const latest = await load(examId);
    if (latest.status !== "loaded") return { status: "unavailable" };
    return {
        status: "loaded",
        revision: latest.revision,
        mode: latest.mode,
        targetStudentIds: latest.targetStudentIds,
    };
}
