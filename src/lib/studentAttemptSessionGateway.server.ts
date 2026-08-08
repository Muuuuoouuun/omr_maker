import type { Attempt, Exam, IdentityType, RetakeMetadata, SubQuestionAnswers } from "@/types/omr";
import { attemptToSupabaseRow, questionResultRowsForAttempt } from "@/lib/omrPersistence";
import {
    STUDENT_ATTEMPT_LEASE_SECONDS,
    studentAttemptSessionStateFromRpc,
    type StudentAttemptSessionState,
} from "@/lib/studentAttemptSessionContract";
import { canonicalStudentAttemptProgressPayload } from "@/lib/studentAttemptHandwritingCheckpoint";

interface RpcResult {
    data: unknown;
    error: { message?: string } | null;
}

export interface StudentAttemptSessionRpcClient {
    rpc(name: string, params: Record<string, unknown>): Promise<RpcResult>;
}

export type StudentAttemptSessionErrorStatus =
    | "not_found"
    | "not_owned"
    | "not_active"
    | "expired"
    | "lease_conflict"
    | "revision_conflict"
    | "retake_denied"
    | "max_attempts"
    | "invalid"
    | "service_unavailable";

export type StudentAttemptSessionMutationResult =
    | { status: "active"; session: StudentAttemptSessionState; leaseTokenRotated?: boolean }
    | { status: "submitted"; session: StudentAttemptSessionState }
    | { status: StudentAttemptSessionErrorStatus };

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

const MAX_SESSION_ITEMS = 500;
const MAX_SUBMISSION_BYTES = 1_048_576;

function jsonSize(value: unknown): number {
    try {
        return new TextEncoder().encode(JSON.stringify(value)).byteLength;
    } catch {
        return Number.POSITIVE_INFINITY;
    }
}

function validQuestionIds(value: number[], allowEmpty = false): boolean {
    return Array.isArray(value)
        && (allowEmpty || value.length > 0)
        && value.length <= MAX_SESSION_ITEMS
        && new Set(value).size === value.length
        && value.every(id => Number.isInteger(id) && id > 0);
}

function validCas(value: number): boolean {
    return Number.isSafeInteger(value) && value >= 1;
}

function validLeaseTokenHash(value: string): boolean {
    return clean(value).length > 0 && clean(value).length <= 256;
}

function validOpenInput(input: OpenStudentAttemptSessionGatewayInput): boolean {
    const boundedStrings = [input.sessionId, input.organizationId, input.examId, input.ownerStudentId,
        input.submissionId, input.attemptId, input.newLeaseTokenHash];
    return boundedStrings.every(value => clean(value).length > 0 && clean(value).length <= 256)
        && clean(input.studentName).length > 0 && clean(input.studentName).length <= 300
        && validQuestionIds(input.examQuestionIds)
        && (!input.retake || (
            clean(input.retake.sourceAttemptId).length > 0
            && clean(input.retake.sourceAttemptId).length <= 256
            && validQuestionIds(input.retake.questionIds, input.retake.mode === "wrong")
        ))
        && Number.isInteger(input.durationSeconds)
        && input.durationSeconds > 0
        && input.durationSeconds <= 43_200
        && jsonSize(input.gradingSnapshot) <= MAX_SUBMISSION_BYTES;
}

function errorStatus(error: { message?: string } | null): StudentAttemptSessionErrorStatus {
    const message = clean(error?.message).toLowerCase();
    if (message.includes("revision conflict")) return "revision_conflict";
    if (message.includes("lease conflict")) return "lease_conflict";
    if (message.includes("not owned")) return "not_owned";
    if (message.includes("not active")) return "not_active";
    if (message.includes("expired") || message.includes("exam ended")) return "expired";
    if (message.includes("retake")) return "retake_denied";
    if (message.includes("max_attempts")) return "max_attempts";
    if (message.includes("invalid")) return "invalid";
    return "service_unavailable";
}

function parsedMutation(data: unknown): StudentAttemptSessionMutationResult {
    const session = studentAttemptSessionStateFromRpc(data);
    if (!session) return { status: "service_unavailable" };
    return session.status === "submitted"
        ? { status: "submitted", session }
        : session.status === "in_progress"
            ? { status: "active", session }
            : { status: "expired" };
}

export interface OpenStudentAttemptSessionGatewayInput {
    sessionId: string;
    organizationId: string;
    examId: string;
    assignmentId?: string;
    ownerStudentId: string;
    studentName: string;
    identityType: IdentityType;
    submissionId: string;
    attemptId: string;
    retake?: Pick<RetakeMetadata, "sourceAttemptId" | "mode" | "questionIds">;
    examQuestionIds: number[];
    examUpdatedAt?: string;
    gradingSnapshot: Exam;
    durationSeconds: number;
    examEndsAt?: string;
    newLeaseTokenHash: string;
    currentLeaseTokenHash?: string;
}

export async function openStudentAttemptSessionWithGateway(
    client: StudentAttemptSessionRpcClient,
    input: OpenStudentAttemptSessionGatewayInput,
): Promise<
    | (Extract<StudentAttemptSessionMutationResult, { status: "active" }> & { gradingSnapshot: Exam })
    | { status: "lease_conflict"; session: StudentAttemptSessionState; gradingSnapshot: Exam }
    | Exclude<StudentAttemptSessionMutationResult, { status: "active" }>
> {
    if (!validOpenInput(input)) return { status: "invalid" };
    const result = await client.rpc("omr_open_attempt_session_v2", {
        p_session_id: input.sessionId,
        p_organization_id: input.organizationId,
        p_exam_id: input.examId,
        p_assignment_id: input.assignmentId || "",
        p_owner_student_id: input.ownerStudentId,
        p_student_name: input.studentName,
        p_identity_type: input.identityType,
        p_submission_id: input.submissionId,
        p_attempt_id: input.attemptId,
        p_retake_source_attempt_id: input.retake?.sourceAttemptId || "",
        p_retake_mode: input.retake?.mode || "",
        p_requested_question_ids: input.retake?.questionIds || [],
        p_exam_question_ids: input.examQuestionIds,
        p_exam_updated_at: input.examUpdatedAt || null,
        p_grading_snapshot: input.gradingSnapshot,
        p_duration_seconds: input.durationSeconds,
        p_exam_ends_at: input.examEndsAt || null,
        p_new_lease_token_hash: input.newLeaseTokenHash,
        p_current_lease_token_hash: input.currentLeaseTokenHash || "",
        p_lease_seconds: STUDENT_ATTEMPT_LEASE_SECONDS,
    });
    if (result.error) return { status: errorStatus(result.error) };
    const session = studentAttemptSessionStateFromRpc(result.data);
    if (!session) return { status: "service_unavailable" };
    const row = Array.isArray(result.data) ? result.data[0] : result.data;
    const gradingSnapshot = row && typeof row === "object"
        ? (row as { grading_snapshot?: unknown }).grading_snapshot
        : null;
    if (!gradingSnapshot || typeof gradingSnapshot !== "object" || Array.isArray(gradingSnapshot)) {
        return { status: "service_unavailable" };
    }
    const acquired = !!(row && typeof row === "object" && (row as { lease_acquired?: unknown }).lease_acquired === true);
    if (session.status === "in_progress" && !acquired) {
        return { status: "lease_conflict", session, gradingSnapshot: gradingSnapshot as Exam };
    }
    const parsed = parsedMutation(result.data);
    if (parsed.status === "active") {
        const rotated = !!(row && typeof row === "object"
            && (row as { lease_token_rotated?: unknown }).lease_token_rotated === true);
        return { ...parsed, leaseTokenRotated: rotated, gradingSnapshot: gradingSnapshot as Exam };
    }
    return parsed;
}

export interface CheckpointStudentAttemptSessionGatewayInput {
    sessionId: string;
    organizationId: string;
    ownerStudentId: string;
    expectedRevision: number;
    expectedLeaseEpoch: number;
    leaseTokenHash: string;
    answers: Record<number, number>;
    subQuestionAnswers: SubQuestionAnswers;
    progressPayload: Record<string, unknown>;
    finalCheckpoint?: boolean;
}

export async function checkpointStudentAttemptSessionWithGateway(
    client: StudentAttemptSessionRpcClient,
    input: CheckpointStudentAttemptSessionGatewayInput,
): Promise<StudentAttemptSessionMutationResult> {
    const progressPayload = canonicalStudentAttemptProgressPayload(input.progressPayload);
    if (
        !Number.isSafeInteger(input.expectedRevision)
        || input.expectedRevision < 1
        || !Number.isSafeInteger(input.expectedLeaseEpoch)
        || input.expectedLeaseEpoch < 1
        || Object.keys(input.answers).length > MAX_SESSION_ITEMS
        || Object.keys(input.subQuestionAnswers).length > MAX_SESSION_ITEMS
        || jsonSize(input.answers) > 65_536
        || jsonSize(input.subQuestionAnswers) > 524_288
        || !progressPayload
    ) return { status: "invalid" };
    const result = await client.rpc("omr_checkpoint_attempt_session_v1", {
        p_session_id: input.sessionId,
        p_organization_id: input.organizationId,
        p_owner_student_id: input.ownerStudentId,
        p_expected_revision: input.expectedRevision,
        p_expected_lease_epoch: input.expectedLeaseEpoch,
        p_lease_token_hash: input.leaseTokenHash,
        p_answers: input.answers,
        p_sub_question_answers: input.subQuestionAnswers,
        p_progress_payload: progressPayload,
        p_lease_seconds: STUDENT_ATTEMPT_LEASE_SECONDS,
        p_final_checkpoint: input.finalCheckpoint === true,
    });
    return result.error ? { status: errorStatus(result.error) } : parsedMutation(result.data);
}

export async function takeoverStudentAttemptSessionWithGateway(
    client: StudentAttemptSessionRpcClient,
    input: Pick<CheckpointStudentAttemptSessionGatewayInput,
        "sessionId" | "organizationId" | "ownerStudentId" | "expectedRevision" | "expectedLeaseEpoch"
    > & { newLeaseTokenHash: string },
): Promise<StudentAttemptSessionMutationResult> {
    if (
        !validCas(input.expectedRevision)
        || !validCas(input.expectedLeaseEpoch)
        || !validLeaseTokenHash(input.newLeaseTokenHash)
    ) return { status: "invalid" };
    const result = await client.rpc("omr_takeover_attempt_session_v1", {
        p_session_id: input.sessionId,
        p_organization_id: input.organizationId,
        p_owner_student_id: input.ownerStudentId,
        p_expected_revision: input.expectedRevision,
        p_expected_lease_epoch: input.expectedLeaseEpoch,
        p_new_lease_token_hash: input.newLeaseTokenHash,
        p_lease_seconds: STUDENT_ATTEMPT_LEASE_SECONDS,
    });
    return result.error ? { status: errorStatus(result.error) } : parsedMutation(result.data);
}

export interface StudentAttemptSessionHeartbeat {
    status: "active" | "submitted" | StudentAttemptSessionErrorStatus;
    revision?: number;
    leaseEpoch?: number;
    deadlineAt?: string;
    serverNow?: string;
    submittedAttemptId?: string;
}

export async function heartbeatStudentAttemptSessionWithGateway(
    client: StudentAttemptSessionRpcClient,
    input: Pick<CheckpointStudentAttemptSessionGatewayInput,
        "sessionId" | "organizationId" | "ownerStudentId" | "expectedLeaseEpoch" | "leaseTokenHash"
    >,
): Promise<StudentAttemptSessionHeartbeat> {
    if (!validCas(input.expectedLeaseEpoch) || !validLeaseTokenHash(input.leaseTokenHash)) {
        return { status: "invalid" };
    }
    const result = await client.rpc("omr_heartbeat_attempt_session_v1", {
        p_session_id: input.sessionId,
        p_organization_id: input.organizationId,
        p_owner_student_id: input.ownerStudentId,
        p_expected_lease_epoch: input.expectedLeaseEpoch,
        p_lease_token_hash: input.leaseTokenHash,
        p_lease_seconds: STUDENT_ATTEMPT_LEASE_SECONDS,
    });
    if (result.error) return { status: errorStatus(result.error) };
    const row = Array.isArray(result.data) ? result.data[0] : result.data;
    if (!row || typeof row !== "object") return { status: "service_unavailable" };
    const record = row as Record<string, unknown>;
    const status = record.status === "submitted" ? "submitted" : record.status === "in_progress" ? "active" : "expired";
    return {
        status,
        revision: Number(record.revision),
        leaseEpoch: Number(record.lease_epoch),
        deadlineAt: clean(record.deadline_at) || undefined,
        serverNow: clean(record.server_now) || undefined,
        submittedAttemptId: clean(record.submitted_attempt_id) || undefined,
    };
}

export interface PreparedStudentAttemptSession {
    sessionId: string;
    status: "in_progress" | "submitted";
    revision: number;
    leaseEpoch: number;
    startedAt: string;
    deadlineAt: string;
    serverNow: string;
    answers: Record<number, number>;
    subQuestionAnswers: SubQuestionAnswers;
    allowedQuestionIds: number[];
    gradingSnapshot: Exam;
    submissionId: string;
    attemptId: string;
    assignmentId?: string;
    retake?: Pick<RetakeMetadata, "sourceAttemptId" | "mode">;
    progressPayload: Record<string, unknown>;
    submittedAttemptId?: string;
}

export async function prepareStudentAttemptSessionSubmitWithGateway(
    client: StudentAttemptSessionRpcClient,
    input: Pick<CheckpointStudentAttemptSessionGatewayInput,
        "sessionId" | "organizationId" | "ownerStudentId" | "expectedRevision" | "expectedLeaseEpoch" | "leaseTokenHash"
    >,
): Promise<{ status: "prepared"; session: PreparedStudentAttemptSession } | { status: StudentAttemptSessionErrorStatus }> {
    if (
        !validCas(input.expectedRevision)
        || !validCas(input.expectedLeaseEpoch)
        || !validLeaseTokenHash(input.leaseTokenHash)
    ) return { status: "invalid" };
    const result = await client.rpc("omr_prepare_attempt_session_submit_v1", {
        p_session_id: input.sessionId,
        p_organization_id: input.organizationId,
        p_owner_student_id: input.ownerStudentId,
        p_expected_revision: input.expectedRevision,
        p_expected_lease_epoch: input.expectedLeaseEpoch,
        p_lease_token_hash: input.leaseTokenHash,
    });
    if (result.error) return { status: errorStatus(result.error) };
    const row = Array.isArray(result.data) ? result.data[0] : result.data;
    if (!row || typeof row !== "object") return { status: "service_unavailable" };
    const record = row as Record<string, unknown>;
    const base = studentAttemptSessionStateFromRpc(record);
    if (base?.status === "expired") return { status: "expired" };
    const gradingSnapshot = record.grading_snapshot;
    const submissionId = clean(record.submission_id);
    const attemptId = clean(record.attempt_id);
    if (!base || !gradingSnapshot || typeof gradingSnapshot !== "object" || !submissionId || !attemptId) {
        return { status: "service_unavailable" };
    }
    return {
        status: "prepared",
        session: {
            ...base,
            status: base.status === "submitted" ? "submitted" : "in_progress",
            gradingSnapshot: gradingSnapshot as Exam,
            submissionId,
            attemptId,
            ...(clean(record.assignment_id) ? { assignmentId: clean(record.assignment_id) } : {}),
            ...(clean(record.retake_source_attempt_id) && clean(record.retake_mode)
                ? {
                    retake: {
                        sourceAttemptId: clean(record.retake_source_attempt_id),
                        mode: clean(record.retake_mode) as RetakeMetadata["mode"],
                    },
                }
                : {}),
            progressPayload: record.progress_payload && typeof record.progress_payload === "object"
                ? record.progress_payload as Record<string, unknown>
                : {},
        },
    };
}

export async function commitStudentAttemptSessionSubmitWithGateway(
    client: StudentAttemptSessionRpcClient,
    input: Pick<CheckpointStudentAttemptSessionGatewayInput,
        "sessionId" | "organizationId" | "ownerStudentId" | "expectedRevision" | "expectedLeaseEpoch" | "leaseTokenHash"
    > & { attempt: Attempt },
): Promise<{ status: "submitted"; attempt: Attempt } | { status: StudentAttemptSessionErrorStatus }> {
    if (
        !validCas(input.expectedRevision)
        || !validCas(input.expectedLeaseEpoch)
        || !validLeaseTokenHash(input.leaseTokenHash)
    ) return { status: "invalid" };
    const attemptRow = attemptToSupabaseRow(input.attempt);
    const questionResults = questionResultRowsForAttempt(input.attempt);
    if (
        questionResults.length > MAX_SESSION_ITEMS
        || jsonSize(attemptRow) > MAX_SUBMISSION_BYTES
        || jsonSize(questionResults) > MAX_SUBMISSION_BYTES
    ) return { status: "invalid" };
    const result = await client.rpc("omr_commit_attempt_session_submit_v1", {
        p_session_id: input.sessionId,
        p_organization_id: input.organizationId,
        p_owner_student_id: input.ownerStudentId,
        p_expected_revision: input.expectedRevision,
        p_expected_lease_epoch: input.expectedLeaseEpoch,
        p_lease_token_hash: input.leaseTokenHash,
        p_attempt: attemptRow,
        p_question_results: questionResults,
    });
    if (result.error) return { status: errorStatus(result.error) };
    const row = Array.isArray(result.data) ? result.data[0] : result.data;
    if (row && typeof row === "object" && (row as { result_status?: unknown }).result_status === "expired") {
        return { status: "expired" };
    }
    const payload = row && typeof row === "object" && "payload" in row
        ? (row as { payload?: unknown }).payload
        : null;
    return payload && typeof payload === "object"
        ? { status: "submitted", attempt: payload as Attempt }
        : { status: "service_unavailable" };
}
