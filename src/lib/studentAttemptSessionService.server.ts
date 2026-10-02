import { evaluateExamAccess, verifyExamPin } from "@/lib/examAccess";
import { attemptOwnedBy, ownerStudentId } from "@/lib/studentExamCore";
import { buildServerAttempt } from "@/lib/studentExamServerGrading";
import { leaseTokenHash } from "@/lib/studentAttemptSessionCrypto.server";
import type {
    OpenStudentAttemptSessionGatewayInput,
    PreparedStudentAttemptSession,
    StudentAttemptSessionErrorStatus,
    StudentAttemptSessionMutationResult,
} from "@/lib/studentAttemptSessionGateway.server";
import type { StudentServerIdentity } from "@/lib/studentServerSession";
import type { Attempt, Exam, FocusLossEvent, QuestionTiming, RetakeMetadata } from "@/types/omr";

type OpenGateway = (
    input: OpenStudentAttemptSessionGatewayInput,
) => Promise<
    Exclude<StudentAttemptSessionMutationResult, { status: "active" }>
    | { status: "lease_conflict"; session: NonNullable<Extract<StudentAttemptSessionMutationResult, { session: unknown }>["session"]>; gradingSnapshot: Exam }
    | (Extract<StudentAttemptSessionMutationResult, { status: "active" }> & { gradingSnapshot: Exam })
>;

export function durableAttemptSessionIds(ticketId: string): { sessionId: string; attemptId: string } {
    const stableTicketId = ticketId.trim();
    return {
        sessionId: `session_${stableTicketId}`,
        attemptId: `attempt_${stableTicketId}`,
    };
}

export interface OpenStudentAttemptSessionServiceInput {
    exam: Exam;
    identity: StudentServerIdentity;
    input: {
        pin?: string;
        submissionId: string;
        leaseToken: string;
        currentLeaseToken?: string;
    };
    authorization?: {
        assignmentId?: string;
        assignmentRevision?: number;
        retake?: Pick<RetakeMetadata, "sourceAttemptId" | "mode" | "questionIds">;
    };
    secret: string;
    ids: { sessionId: string; attemptId: string };
    openGateway: OpenGateway;
}

export async function openStudentAttemptSessionService(
    params: OpenStudentAttemptSessionServiceInput,
): Promise<
    | { status: "active"; session: Extract<StudentAttemptSessionMutationResult, { session: unknown }>["session"]; leaseToken: string; gradingSnapshot: Exam }
    | { status: "lease_conflict"; session: Extract<StudentAttemptSessionMutationResult, { session: unknown }>["session"]; gradingSnapshot: Exam }
    | { status: "submitted"; session: Extract<StudentAttemptSessionMutationResult, { session: unknown }>["session"] }
    | { status: StudentAttemptSessionErrorStatus | "pin_required" | "login_required" | "group_denied" | "not_started" | "ended" | "archived" }
> {
    const { exam, identity, input } = params;
    if (!exam.organizationId || exam.organizationId !== identity.organizationId) return { status: "not_owned" };
    const access = evaluateExamAccess(exam, {
        pinVerified: verifyExamPin(exam, input.pin || ""),
        session: {
            groupId: identity.groupId,
            groupName: identity.groupName,
            isGuest: identity.kind === "guest",
            identityType: identity.identityType,
        },
    });
    if (access.status !== "allowed") return { status: access.status };

    const result = await params.openGateway({
        sessionId: params.ids.sessionId,
        organizationId: exam.organizationId,
        examId: exam.id,
        assignmentId: params.authorization?.assignmentId,
        assignmentRevision: params.authorization?.assignmentRevision,
        ownerStudentId: ownerStudentId(identity),
        studentName: identity.name,
        identityType: identity.identityType,
        submissionId: input.submissionId,
        attemptId: params.ids.attemptId,
        retake: params.authorization?.retake,
        examQuestionIds: exam.questions.map(question => question.id),
        examUpdatedAt: exam.updatedAt,
        gradingSnapshot: exam,
        durationSeconds: Math.max(60, Math.min(12 * 60 * 60, Math.round((exam.durationMin ?? 50) * 60))),
        examEndsAt: exam.endAt,
        newLeaseTokenHash: leaseTokenHash(input.leaseToken, params.secret),
        currentLeaseTokenHash: input.currentLeaseToken
            ? leaseTokenHash(input.currentLeaseToken, params.secret)
            : undefined,
    });
    if (result.status === "active") {
        return {
            ...result,
            leaseToken: result.leaseTokenRotated
                ? input.leaseToken
                : input.currentLeaseToken || input.leaseToken,
        };
    }
    return result;
}

export interface SubmitStudentAttemptSessionServiceInput {
    identity: StudentServerIdentity;
    sessionId: string;
    examId: string;
    assignmentId?: string;
    assignmentRevision?: number;
    expectedRevision: number;
    expectedLeaseEpoch: number;
    leaseToken: string;
    secret: string;
    autoSubmitted?: boolean;
    questionTimings?: QuestionTiming[];
    focusLossEvents?: FocusLossEvent[];
    tabFociLostCount?: number;
    finishedAt?: string;
    prepareGateway: (input: {
        sessionId: string;
        organizationId: string;
        examId: string;
        ownerStudentId: string;
        assignmentId?: string;
        assignmentRevision?: number;
        expectedRevision: number;
        expectedLeaseEpoch: number;
        leaseTokenHash: string;
    }) => Promise<
        { status: "prepared"; session: PreparedStudentAttemptSession }
        | { status: StudentAttemptSessionErrorStatus }
    >;
    commitGateway: (input: {
        sessionId: string;
        organizationId: string;
        examId: string;
        ownerStudentId: string;
        assignmentId?: string;
        assignmentRevision?: number;
        expectedRevision: number;
        expectedLeaseEpoch: number;
        leaseTokenHash: string;
        attempt: Attempt;
        questionResults: NonNullable<Attempt["questionResults"]>;
    }) => Promise<{ status: "submitted"; attempt: Attempt } | { status: StudentAttemptSessionErrorStatus }>;
    loadSubmittedAttempt?: (attemptId: string) => Promise<Attempt | null>;
}

export async function submitStudentAttemptSessionService(
    params: SubmitStudentAttemptSessionServiceInput,
): Promise<{ status: "submitted"; attempt: Attempt } | { status: StudentAttemptSessionErrorStatus }> {
    const organizationId = params.identity.organizationId || "";
    const studentId = ownerStudentId(params.identity);
    if (!organizationId || !studentId) return { status: "not_owned" };
    const hashedLease = leaseTokenHash(params.leaseToken, params.secret);
    const prepared = await params.prepareGateway({
        sessionId: params.sessionId,
        organizationId,
        examId: params.examId,
        ownerStudentId: studentId,
        assignmentId: params.assignmentId,
        assignmentRevision: params.assignmentRevision,
        expectedRevision: params.expectedRevision,
        expectedLeaseEpoch: params.expectedLeaseEpoch,
        leaseTokenHash: hashedLease,
    });
    if (prepared.status !== "prepared") return prepared;
    const session = prepared.session;
    if (session.status === "submitted") {
        if (!session.submittedAttemptId || !params.loadSubmittedAttempt) return { status: "not_active" };
        const stored = await params.loadSubmittedAttempt(session.submittedAttemptId);
        return stored && stored.id === session.submittedAttemptId && attemptOwnedBy(stored, params.identity)
            ? { status: "submitted", attempt: stored }
            : { status: "service_unavailable" };
    }

    const finishedAt = params.finishedAt || new Date().toISOString();
    if (!session.gradingSnapshot || !session.submissionId || !session.attemptId) {
        return { status: "service_unavailable" };
    }
    const retake: RetakeMetadata | undefined = session.retake
        ? {
            ...session.retake,
            questionIds: session.allowedQuestionIds,
            createdAt: finishedAt,
        }
        : undefined;
    const attempt = buildServerAttempt({
        examId: session.gradingSnapshot.id,
        submissionId: session.submissionId,
        answers: session.answers,
        subQuestionAnswers: session.subQuestionAnswers,
        startedAt: session.startedAt,
        autoSubmitted: params.autoSubmitted,
        questionTimings: params.questionTimings,
        focusLossEvents: params.focusLossEvents,
        tabFociLostCount: params.tabFociLostCount,
        retake,
    }, session.gradingSnapshot, params.identity, session.attemptId, finishedAt, {}, {
        assignmentId: session.assignmentId,
        assignmentRevision: session.assignmentRevision,
    });
    return params.commitGateway({
        sessionId: params.sessionId,
        organizationId,
        examId: params.examId,
        ownerStudentId: studentId,
        assignmentId: session.assignmentId,
        assignmentRevision: session.assignmentRevision,
        expectedRevision: session.revision,
        expectedLeaseEpoch: session.leaseEpoch,
        leaseTokenHash: hashedLease,
        attempt,
        questionResults: attempt.questionResults || [],
    });
}
