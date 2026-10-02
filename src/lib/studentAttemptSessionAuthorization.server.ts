import type { IdentityType, RetakeMetadata } from "@/types/omr";
import type { StudentAttemptTicketClaims } from "@/lib/studentAttemptTicket";

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function normalizedIds(values: number[]): number[] {
    return [...new Set(values.filter(value => Number.isInteger(value) && value > 0))]
        .sort((left, right) => left - right);
}

export interface AuthorizeStudentAttemptSessionScopeInput {
    claims: StudentAttemptTicketClaims;
    organizationId: string;
    examId: string;
    ownerStudentId: string;
    identityType: IdentityType;
    requestedAssignmentId?: string;
    requestedAssignmentRevision?: number;
    requestedRetake?: Pick<RetakeMetadata, "sourceAttemptId" | "mode" | "questionIds">;
}

export type AuthorizedStudentAttemptSessionScope =
    | {
        status: "authorized";
        assignmentId?: string;
        assignmentRevision?: number;
        retake?: Pick<RetakeMetadata, "sourceAttemptId" | "mode" | "questionIds">;
    }
    | { status: "denied" };

/**
 * Turns signed attempt-ticket claims into the only scope accepted by durable
 * session open. Browser URL/query values can confirm the capability but can
 * never widen or replace it.
 */
export function authorizeStudentAttemptSessionScope(
    input: AuthorizeStudentAttemptSessionScopeInput,
): AuthorizedStudentAttemptSessionScope {
    const { claims } = input;
    if (
        clean(claims.organizationId) !== clean(input.organizationId)
        || clean(claims.examId) !== clean(input.examId)
        || clean(claims.studentId) !== clean(input.ownerStudentId)
        || claims.identityType !== input.identityType
    ) return { status: "denied" };

    const assignmentId = clean(claims.assignmentId);
    const assignmentRevision = Number(claims.assignmentRevision);
    const requestedAssignmentId = clean(input.requestedAssignmentId);
    const requestedAssignmentRevision = Number(input.requestedAssignmentRevision);
    if (
        Boolean(assignmentId) !== (Number.isSafeInteger(assignmentRevision) && assignmentRevision > 0)
        || requestedAssignmentId && requestedAssignmentId !== assignmentId
        || requestedAssignmentId && requestedAssignmentRevision !== assignmentRevision
        || !requestedAssignmentId && input.requestedAssignmentRevision !== undefined
    ) return { status: "denied" };

    const sourceAttemptId = clean(claims.retakeSourceAttemptId);
    const mode = claims.retakeMode;
    const requested = input.requestedRetake;
    if (requested) {
        if (!sourceAttemptId || !mode) return { status: "denied" };
        if (
            clean(requested.sourceAttemptId) !== sourceAttemptId
            || requested.mode !== mode
            || normalizedIds(requested.questionIds).join(",") !== normalizedIds(claims.allowedQuestionIds).join(",")
        ) return { status: "denied" };
    }

    if ((sourceAttemptId && !mode) || (!sourceAttemptId && mode)) return { status: "denied" };
    return {
        status: "authorized",
        ...(assignmentId ? { assignmentId } : {}),
        ...(assignmentId ? { assignmentRevision } : {}),
        ...(sourceAttemptId && mode
            ? {
                retake: {
                    sourceAttemptId,
                    mode,
                    questionIds: normalizedIds(claims.allowedQuestionIds),
                },
            }
            : {}),
    };
}
