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

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function boundedIdentifier(value: unknown): boolean {
    return typeof value === "string" && value.trim().length > 0 && value.length <= 256;
}

function validScope(input: unknown): boolean {
    return isRecord(input) && [input.sessionId, input.organizationId, input.examId, input.ownerStudentId].every(boundedIdentifier);
}

export async function resolveLegacyStudentAttemptSessionScopeWithGateway(
    client: StudentAttemptSessionRpcClient,
    input: { sessionId: string; organizationId: string; ownerStudentId: string },
): Promise<
    | { status: "resolved"; examId: string }
    | { status: "targeted" | "not_found" | "invalid" | "service_unavailable" }
> {
    if (!isRecord(input)) return { status: "invalid" };
    const sessionId = clean(input.sessionId);
    const organizationId = clean(input.organizationId);
    const ownerStudentId = clean(input.ownerStudentId);
    if (!sessionId || sessionId.length > 256 || !organizationId || organizationId.length > 256
        || !ownerStudentId || ownerStudentId.length > 256) return { status: "invalid" };
    const result = await client.rpc("omr_resolve_legacy_attempt_session_scope_v1", {
        p_session_id: sessionId,
        p_organization_id: organizationId,
        p_owner_student_id: ownerStudentId,
    });
    if (result.error || !result.data || typeof result.data !== "object" || Array.isArray(result.data)) {
        return { status: "service_unavailable" };
    }
    const row = result.data as Record<string, unknown>;
    if (row.status === "targeted" && Object.keys(row).length === 1) return { status: "targeted" };
    if (row.status === "not_found" && Object.keys(row).length === 1) return { status: "not_found" };
    const examId = clean(row.examId);
    return row.status === "resolved" && examId && examId.length <= 256
        && Object.keys(row).every(key => key === "status" || key === "examId")
        ? { status: "resolved", examId }
        : { status: "service_unavailable" };
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
        && value.every(id => Number.isSafeInteger(id) && id > 0);
}

function validCas(value: number): boolean {
    return Number.isSafeInteger(value) && value >= 1;
}

function validLeaseTokenHash(value: string): boolean {
    return clean(value).length > 0 && clean(value).length <= 256;
}

function validOpenInput(input: OpenStudentAttemptSessionGatewayInput): boolean {
    if (!isRecord(input)) return false;
    const boundedStrings = [input.sessionId, input.organizationId, input.examId, input.ownerStudentId,
        input.submissionId, input.attemptId, input.newLeaseTokenHash];
    return boundedStrings.every(value => clean(value).length > 0 && clean(value).length <= 256)
        && validAssignmentGeneration(input)
        && clean(input.studentName).length > 0 && clean(input.studentName).length <= 300
        && ["guest", "temporary", "registered"].includes(input.identityType)
        && (input.currentLeaseTokenHash === undefined || validLeaseTokenHash(input.currentLeaseTokenHash))
        && validQuestionIds(input.examQuestionIds)
        && (!input.retake || (
            ["wrong", "similar", "custom"].includes(input.retake.mode)
            && clean(input.retake.sourceAttemptId).length > 0
            && clean(input.retake.sourceAttemptId).length <= 256
            && validQuestionIds(input.retake.questionIds, input.retake.mode === "wrong")
        ))
        && Number.isInteger(input.durationSeconds)
        && input.durationSeconds > 0
        && input.durationSeconds <= 43_200
        && isRecord(input.gradingSnapshot) && input.gradingSnapshot.id === input.examId
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
    assignmentRevision?: number;
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
    const result = await client.rpc("omr_open_attempt_session_v3", {
        p_session_id: input.sessionId,
        p_organization_id: input.organizationId,
        p_exam_id: input.examId,
        p_assignment_id: input.assignmentId || "",
        p_assignment_revision: input.assignmentRevision || null,
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
    examId: string;
    ownerStudentId: string;
    assignmentId?: string;
    assignmentRevision?: number;
    expectedRevision: number;
    expectedLeaseEpoch: number;
    leaseTokenHash: string;
    answers: Record<number, number>;
    subQuestionAnswers: SubQuestionAnswers;
    progressPayload: Record<string, unknown>;
    finalCheckpoint?: boolean;
}

function validAssignmentGeneration(input: { assignmentId?: string; assignmentRevision?: number }): boolean {
    if (input.assignmentId !== undefined && (typeof input.assignmentId !== "string" || input.assignmentId.length > 256)) return false;
    const assignmentId = clean(input.assignmentId);
    return assignmentId
        ? validCas(input.assignmentRevision as number)
        : input.assignmentRevision === undefined;
}

function validAnswerKey(value: string): boolean {
    return /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
}

function validAnswers(value: unknown): boolean {
    return isRecord(value)
        && Object.keys(value).length <= MAX_SESSION_ITEMS
        && jsonSize(value) <= 65_536
        && Object.entries(value).every(([key, answer]) => validAnswerKey(key)
            && Number.isInteger(answer) && Number(answer) >= 1 && Number(answer) <= 5);
}

/** A student can save response text, never impersonate a teacher's review. */
function studentSubQuestionAnswers(value: unknown): SubQuestionAnswers | null {
    if (!isRecord(value) || Object.keys(value).length > MAX_SESSION_ITEMS || jsonSize(value) > 524_288) return null;
    const parents: [string, SubQuestionAnswers[number]][] = [];
    for (const [questionId, rawAnswers] of Object.entries(value)) {
        if (!validAnswerKey(questionId) || !isRecord(rawAnswers) || Object.keys(rawAnswers).length > 10) return null;
        const responses: [string, SubQuestionAnswers[number][string]][] = [];
        for (const [subQuestionId, rawAnswer] of Object.entries(rawAnswers)) {
            // Normalization can append a uniqueness suffix to a 100-character imported ID.
            if (!subQuestionId.trim() || subQuestionId.length > 256 || !isRecord(rawAnswer)
                || rawAnswer.schemaVersion !== 1 || typeof rawAnswer.body !== "string" || rawAnswer.body.length > 2_000
                || (rawAnswer.answeredAt !== undefined && (typeof rawAnswer.answeredAt !== "string"
                    || rawAnswer.answeredAt.length > 64 || !Number.isFinite(Date.parse(rawAnswer.answeredAt))))) return null;
            responses.push([subQuestionId, {
                schemaVersion: 1,
                body: rawAnswer.body,
                reviewStatus: "needs_review",
                ...(typeof rawAnswer.answeredAt === "string" ? { answeredAt: rawAnswer.answeredAt } : {}),
            }]);
        }
        // Preserve legacy/imported IDs such as __proto__ as own data properties.
        parents.push([questionId, Object.fromEntries(responses)]);
    }
    return Object.fromEntries(parents);
}

export async function checkpointStudentAttemptSessionWithGateway(
    client: StudentAttemptSessionRpcClient,
    input: CheckpointStudentAttemptSessionGatewayInput,
): Promise<StudentAttemptSessionMutationResult> {
    if (!validScope(input) || !validCas(input.expectedRevision) || !validCas(input.expectedLeaseEpoch)
        || !validLeaseTokenHash(input.leaseTokenHash) || !validAssignmentGeneration(input)
        || !validAnswers(input.answers)) return { status: "invalid" };
    const subQuestionAnswers = studentSubQuestionAnswers(input.subQuestionAnswers);
    const progressPayload = canonicalStudentAttemptProgressPayload(input.progressPayload);
    if (!subQuestionAnswers || !progressPayload) return { status: "invalid" };
    const result = await client.rpc("omr_checkpoint_attempt_session_v2", {
        p_session_id: input.sessionId,
        p_organization_id: input.organizationId,
        p_exam_id: input.examId,
        p_owner_student_id: input.ownerStudentId,
        p_assignment_id: input.assignmentId || "",
        p_assignment_revision: input.assignmentRevision || null,
        p_expected_revision: input.expectedRevision,
        p_expected_lease_epoch: input.expectedLeaseEpoch,
        p_lease_token_hash: input.leaseTokenHash,
        p_answers: input.answers,
        p_sub_question_answers: subQuestionAnswers,
        p_progress_payload: progressPayload,
        p_lease_seconds: STUDENT_ATTEMPT_LEASE_SECONDS,
        p_final_checkpoint: input.finalCheckpoint === true,
    });
    return result.error ? { status: errorStatus(result.error) } : parsedMutation(result.data);
}

export async function takeoverStudentAttemptSessionWithGateway(
    client: StudentAttemptSessionRpcClient,
    input: Pick<CheckpointStudentAttemptSessionGatewayInput,
        "sessionId" | "organizationId" | "examId" | "ownerStudentId" | "assignmentId" | "assignmentRevision" | "expectedRevision" | "expectedLeaseEpoch"
    > & { newLeaseTokenHash: string },
): Promise<StudentAttemptSessionMutationResult> {
    if (
        !validScope(input)
        || !validCas(input.expectedRevision)
        || !validCas(input.expectedLeaseEpoch)
        || !validLeaseTokenHash(input.newLeaseTokenHash)
        || !validAssignmentGeneration(input)
    ) return { status: "invalid" };
    const result = await client.rpc("omr_takeover_attempt_session_v2", {
        p_session_id: input.sessionId,
        p_organization_id: input.organizationId,
        p_exam_id: input.examId,
        p_owner_student_id: input.ownerStudentId,
        p_assignment_id: input.assignmentId || "",
        p_assignment_revision: input.assignmentRevision || null,
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
        "sessionId" | "organizationId" | "examId" | "ownerStudentId" | "assignmentId" | "assignmentRevision" | "expectedLeaseEpoch" | "leaseTokenHash"
    >,
): Promise<StudentAttemptSessionHeartbeat> {
    if (!validScope(input) || !validCas(input.expectedLeaseEpoch) || !validLeaseTokenHash(input.leaseTokenHash) || !validAssignmentGeneration(input)) {
        return { status: "invalid" };
    }
    const result = await client.rpc("omr_heartbeat_attempt_session_v2", {
        p_session_id: input.sessionId,
        p_organization_id: input.organizationId,
        p_exam_id: input.examId,
        p_owner_student_id: input.ownerStudentId,
        p_assignment_id: input.assignmentId || "",
        p_assignment_revision: input.assignmentRevision || null,
        p_expected_lease_epoch: input.expectedLeaseEpoch,
        p_lease_token_hash: input.leaseTokenHash,
        p_lease_seconds: STUDENT_ATTEMPT_LEASE_SECONDS,
    });
    if (result.error) return { status: errorStatus(result.error) };
    const row = Array.isArray(result.data) ? result.data[0] : result.data;
    if (!isRecord(row)
        || !["in_progress", "submitted", "expired"].includes(String(row.status))
        || !validCas(row.revision as number) || !validCas(row.lease_epoch as number)
        || !Number.isFinite(Date.parse(clean(row.deadline_at))) || !Number.isFinite(Date.parse(clean(row.server_now)))
        || (row.status === "submitted" && !boundedIdentifier(row.submitted_attempt_id))) {
        return { status: "service_unavailable" };
    }
    const record = row;
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
    gradingSnapshot?: Exam;
    submissionId?: string;
    attemptId?: string;
    assignmentId?: string;
    assignmentRevision?: number;
    retake?: Pick<RetakeMetadata, "sourceAttemptId" | "mode">;
    progressPayload: Record<string, unknown>;
    submittedAttemptId?: string;
}

export async function prepareStudentAttemptSessionSubmitWithGateway(
    client: StudentAttemptSessionRpcClient,
    input: Pick<CheckpointStudentAttemptSessionGatewayInput,
        "sessionId" | "organizationId" | "examId" | "ownerStudentId" | "assignmentId" | "assignmentRevision" | "expectedRevision" | "expectedLeaseEpoch" | "leaseTokenHash"
    >,
): Promise<{ status: "prepared"; session: PreparedStudentAttemptSession } | { status: StudentAttemptSessionErrorStatus }> {
    if (
        !validScope(input)
        || !validCas(input.expectedRevision)
        || !validCas(input.expectedLeaseEpoch)
        || !validLeaseTokenHash(input.leaseTokenHash)
        || !validAssignmentGeneration(input)
    ) return { status: "invalid" };
    const result = await client.rpc("omr_prepare_attempt_session_submit_v2", {
        p_session_id: input.sessionId,
        p_organization_id: input.organizationId,
        p_exam_id: input.examId,
        p_owner_student_id: input.ownerStudentId,
        p_assignment_id: input.assignmentId || "",
        p_assignment_revision: input.assignmentRevision || null,
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
    if (base?.status === "submitted") {
        return base.submittedAttemptId
            ? { status: "prepared", session: { ...base, status: "submitted", progressPayload: {} } }
            : { status: "service_unavailable" };
    }
    const gradingSnapshot = record.grading_snapshot;
    const submissionId = clean(record.submission_id);
    const attemptId = clean(record.attempt_id);
    const assignmentId = clean(record.assignment_id);
    const assignmentRevision = Number(record.assignment_revision);
    const validAssignmentRevision = Number.isSafeInteger(assignmentRevision) && assignmentRevision > 0;
    if (
        !base || !gradingSnapshot || typeof gradingSnapshot !== "object" || !submissionId || !attemptId
        || Boolean(assignmentId) !== validAssignmentRevision
    ) {
        return { status: "service_unavailable" };
    }
    return {
        status: "prepared",
        session: {
            ...base,
            status: "in_progress",
            gradingSnapshot: gradingSnapshot as Exam,
            submissionId,
            attemptId,
            ...(assignmentId ? { assignmentId, assignmentRevision } : {}),
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
        "sessionId" | "organizationId" | "examId" | "ownerStudentId" | "assignmentId" | "assignmentRevision" | "expectedRevision" | "expectedLeaseEpoch" | "leaseTokenHash"
    > & { attempt: Attempt },
): Promise<{ status: "submitted"; attempt: Attempt } | { status: StudentAttemptSessionErrorStatus }> {
    if (
        !validScope(input)
        || !validCas(input.expectedRevision)
        || !validCas(input.expectedLeaseEpoch)
        || !validLeaseTokenHash(input.leaseTokenHash)
        || !validAssignmentGeneration(input)
    ) return { status: "invalid" };
    const attemptRow = attemptToSupabaseRow(input.attempt);
    const questionResults = questionResultRowsForAttempt(input.attempt);
    if (
        questionResults.length > MAX_SESSION_ITEMS
        || jsonSize(attemptRow) > MAX_SUBMISSION_BYTES
        || jsonSize(questionResults) > MAX_SUBMISSION_BYTES
    ) return { status: "invalid" };
    const result = await client.rpc("omr_commit_attempt_session_submit_v2", {
        p_session_id: input.sessionId,
        p_organization_id: input.organizationId,
        p_exam_id: input.examId,
        p_owner_student_id: input.ownerStudentId,
        p_assignment_id: input.assignmentId || "",
        p_assignment_revision: input.assignmentRevision || null,
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
