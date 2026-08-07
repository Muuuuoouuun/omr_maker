import type {
    LoadTeacherIndividualAssignmentResult,
} from "@/lib/individualAssignmentGateway";
import type { StudentAssignmentPreview, StudentAttemptSummary } from "@/lib/studentExamContract";

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
