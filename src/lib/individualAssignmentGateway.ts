import { createHash } from "node:crypto";
import { INITIAL_OPERATIONS_LIMITS } from "@/lib/initialOperationsPolicy";
import { canTeacherRoleWrite } from "@/lib/teacherSession";
import type { WorkspaceContext } from "@/lib/workspaceContext";

interface RpcResult {
    data: unknown;
    error: { message?: string } | null;
}

export interface IndividualAssignmentGatewayClient {
    rpc(name: string, params: Record<string, unknown>): Promise<RpcResult>;
}

export type IndividualAssignmentMode = "base" | "retake";

export interface SaveTeacherIndividualAssignmentInput {
    examId: string;
    targetStudentIds: string[];
    mode: IndividualAssignmentMode;
    expectedRevision: number;
}

export interface ClearTeacherIndividualAssignmentInput {
    examId: string;
    expectedRevision: number;
    accessType: "public" | "group";
    groupIds?: string[];
}

export type SaveTeacherIndividualAssignmentResult =
    | {
        status: "saved";
        assignmentId: string;
        revision: number;
        targetCount: number;
        mode: IndividualAssignmentMode;
        idempotent?: boolean;
    }
    | { status: "conflict"; currentRevision: number }
    | { status: "invalid_request" | "invalid_targets" | "retake_unavailable" | "plan_denied" | "active_sessions" | "unauthorized" | "service_unavailable" };

export type ClearTeacherIndividualAssignmentResult =
    | { status: "cleared"; revision: number; idempotent?: boolean }
    | { status: "conflict"; currentRevision: number }
    | { status: "invalid_request" | "active_sessions" | "unauthorized" | "service_unavailable" };

export type LoadTeacherIndividualAssignmentResult =
    | {
        status: "loaded";
        assignmentId: string;
        revision: number;
        mode: IndividualAssignmentMode;
        targetStudentIds: string[];
    }
    | { status: "not_found" | "unauthorized" | "service_unavailable" };

export type LoadTeacherIndividualAssignmentTargetCountsResult =
    | {
        status: "loaded";
        targetCounts: Record<string, number>;
        assignmentModes: Record<string, IndividualAssignmentMode>;
    }
    | { status: "invalid_request" | "unauthorized" | "service_unavailable" };

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function normalizedTargetIds(values: unknown): string[] {
    if (!Array.isArray(values)) return [];
    return [...new Set(values.map(clean).filter(id => id.length > 0 && id.length <= 256))]
        .sort((left, right) => left.localeCompare(right));
}

function nonNegativeInteger(value: unknown): number | null {
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function positiveInteger(value: unknown): number | null {
    const parsed = nonNegativeInteger(value);
    return parsed !== null && parsed >= 1 ? parsed : null;
}

function record(value: unknown): Record<string, unknown> | null {
    const candidate = Array.isArray(value) ? value[0] : value;
    return candidate && typeof candidate === "object" && !Array.isArray(candidate)
        ? candidate as Record<string, unknown>
        : null;
}

function mutationId(input: {
    organizationId: string;
    actorUserId: string;
    examId: string;
    targetStudentIds: string[];
    mode: IndividualAssignmentMode;
    expectedRevision: number;
}): string {
    const digest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    return `assignment:${digest}`;
}

function clearMutationId(input: {
    organizationId: string;
    actorUserId: string;
    examId: string;
    expectedRevision: number;
    accessType: "public" | "group";
    groupIds: string[];
}): string {
    const digest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    return `assignment-clear:${digest}`;
}

function validContext(context: WorkspaceContext): context is WorkspaceContext & {
    actorUserId: string;
    accountId: string;
    accountSessionGeneration: number;
    sessionAuthority: "account" | "legacy_account";
    memberRole: NonNullable<WorkspaceContext["memberRole"]>;
} {
    return !!clean(context.organizationId)
        && !!clean(context.actorUserId)
        && !!clean(context.accountId)
        && (context.sessionAuthority === "account" || context.sessionAuthority === "legacy_account")
        && Number.isSafeInteger(context.accountSessionGeneration)
        && (context.accountSessionGeneration ?? 0) >= 1
        && !!context.memberRole
        && canTeacherRoleWrite(context.memberRole);
}

export async function saveTeacherIndividualAssignmentWithGateway(
    client: IndividualAssignmentGatewayClient,
    context: WorkspaceContext,
    input: SaveTeacherIndividualAssignmentInput,
): Promise<SaveTeacherIndividualAssignmentResult> {
    if (!validContext(context)) return { status: "unauthorized" };
    const examId = clean(input.examId);
    const targetStudentIds = normalizedTargetIds(input.targetStudentIds);
    const expectedRevision = nonNegativeInteger(input.expectedRevision);
    if (
        !examId || examId.length > 256
        || targetStudentIds.length < 1
        || targetStudentIds.length > INITIAL_OPERATIONS_LIMITS.activeStudents
        || targetStudentIds.length !== new Set(input.targetStudentIds.map(clean).filter(Boolean)).size
        || (input.mode !== "base" && input.mode !== "retake")
        || expectedRevision === null
    ) return { status: "invalid_request" };

    const normalized = {
        organizationId: clean(context.organizationId),
        actorUserId: clean(context.actorUserId),
        examId,
        targetStudentIds,
        mode: input.mode,
        expectedRevision,
    };
    const response = await client.rpc("omr_assign_students_v2", {
        p_session_authority: context.sessionAuthority,
        p_account_id: clean(context.accountId),
        p_session_generation: context.accountSessionGeneration,
        p_organization_id: normalized.organizationId,
        p_actor_user_id: normalized.actorUserId,
        p_actor_role: context.memberRole,
        p_exam_id: examId,
        p_target_student_ids: targetStudentIds,
        p_mode: input.mode,
        p_expected_revision: expectedRevision,
        p_mutation_id: mutationId(normalized),
    });
    if (response.error) return { status: "service_unavailable" };
    const payload = record(response.data);
    if (!payload) return { status: "service_unavailable" };
    if (payload.status === "revision_conflict") {
        const currentRevision = nonNegativeInteger(payload.currentRevision);
        return currentRevision === null
            ? { status: "service_unavailable" }
            : { status: "conflict", currentRevision };
    }
    if (payload.status === "invalid_targets") return { status: "invalid_targets" };
    if (payload.status === "retake_unavailable") return { status: "retake_unavailable" };
    if (payload.status === "plan_denied") return { status: "plan_denied" };
    if (payload.status === "active_sessions") return { status: "active_sessions" };
    if (payload.status === "unauthorized") return { status: "unauthorized" };
    const assignmentId = clean(payload.assignmentId);
    const revision = positiveInteger(payload.revision);
    const targetCount = positiveInteger(payload.targetCount);
    const mode = payload.mode;
    if (payload.status !== "saved" || !assignmentId || !revision || !targetCount || (mode !== "base" && mode !== "retake")) {
        return { status: "service_unavailable" };
    }
    return {
        status: "saved",
        assignmentId,
        revision,
        targetCount,
        mode,
        ...(payload.idempotent === true ? { idempotent: true } : {}),
    };
}

export async function clearTeacherIndividualAssignmentWithGateway(
    client: IndividualAssignmentGatewayClient,
    context: WorkspaceContext,
    input: ClearTeacherIndividualAssignmentInput,
): Promise<ClearTeacherIndividualAssignmentResult> {
    if (!validContext(context)) return { status: "unauthorized" };
    const examId = clean(input.examId);
    const expectedRevision = nonNegativeInteger(input.expectedRevision);
    const groupIds = normalizedTargetIds(input.groupIds || []);
    if (
        !examId || examId.length > 256 || expectedRevision === null
        || (input.accessType !== "public" && input.accessType !== "group")
        || (input.accessType === "group" && groupIds.length < 1)
        || (input.accessType === "public" && groupIds.length > 0)
        || groupIds.length > INITIAL_OPERATIONS_LIMITS.activeStudents
    ) return { status: "invalid_request" };
    const normalized = {
        organizationId: clean(context.organizationId),
        actorUserId: clean(context.actorUserId),
        examId,
        expectedRevision,
        accessType: input.accessType,
        groupIds,
    };
    const response = await client.rpc("omr_clear_student_assignment_v2", {
        p_session_authority: context.sessionAuthority,
        p_account_id: clean(context.accountId),
        p_session_generation: context.accountSessionGeneration,
        p_organization_id: normalized.organizationId,
        p_actor_user_id: normalized.actorUserId,
        p_actor_role: context.memberRole,
        p_exam_id: examId,
        p_expected_revision: expectedRevision,
        p_access_type: input.accessType,
        p_group_ids: groupIds,
        p_mutation_id: clearMutationId(normalized),
    });
    if (response.error) return { status: "service_unavailable" };
    const payload = record(response.data);
    if (!payload) return { status: "service_unavailable" };
    if (payload.status === "revision_conflict") {
        const currentRevision = nonNegativeInteger(payload.currentRevision);
        return currentRevision === null ? { status: "service_unavailable" } : { status: "conflict", currentRevision };
    }
    if (payload.status === "active_sessions") return { status: "active_sessions" };
    if (payload.status === "invalid_request" || payload.status === "invalid_groups" || payload.status === "not_found" || payload.status === "mutation_conflict") {
        return { status: "invalid_request" };
    }
    if (payload.status === "unauthorized") return { status: "unauthorized" };
    const revision = positiveInteger(payload.revision);
    if (payload.status !== "cleared" || !revision) return { status: "service_unavailable" };
    return { status: "cleared", revision, ...(payload.idempotent === true ? { idempotent: true } : {}) };
}

export async function loadTeacherIndividualAssignmentWithGateway(
    client: IndividualAssignmentGatewayClient,
    context: WorkspaceContext,
    examIdInput: string,
): Promise<LoadTeacherIndividualAssignmentResult> {
    if (!validContext(context)) return { status: "unauthorized" };
    const examId = clean(examIdInput);
    if (!examId || examId.length > 256) return { status: "not_found" };
    const response = await client.rpc("omr_load_teacher_student_assignment_v1", {
        p_organization_id: clean(context.organizationId),
        p_actor_user_id: clean(context.actorUserId),
        p_actor_role: context.memberRole,
        p_exam_id: examId,
    });
    if (response.error) return { status: "service_unavailable" };
    const payload = record(response.data);
    if (!payload || payload.status === "not_found") return { status: "not_found" };
    if (payload.status === "unauthorized") return { status: "unauthorized" };
    const assignmentId = clean(payload.assignmentId);
    const revision = positiveInteger(payload.revision);
    const mode = payload.mode;
    const targetStudentIds = normalizedTargetIds(payload.targetStudentIds);
    if (
        payload.status !== "loaded" || !assignmentId || !revision
        || (mode !== "base" && mode !== "retake")
        || targetStudentIds.length < 1
        || targetStudentIds.length > INITIAL_OPERATIONS_LIMITS.activeStudents
    ) return { status: "service_unavailable" };
    return { status: "loaded", assignmentId, revision, mode, targetStudentIds };
}

export async function loadTeacherIndividualAssignmentTargetCountsWithGateway(
    client: IndividualAssignmentGatewayClient,
    context: WorkspaceContext,
    examIdsInput: string[],
): Promise<LoadTeacherIndividualAssignmentTargetCountsResult> {
    if (!validContext(context)) return { status: "unauthorized" };
    if (!Array.isArray(examIdsInput)) return { status: "invalid_request" };
    const examIds = [...new Set(examIdsInput.map(clean).filter(Boolean))].sort();
    if (
        examIds.length !== new Set(examIdsInput.map(clean).filter(Boolean)).size
        || examIds.length > INITIAL_OPERATIONS_LIMITS.activeStudents
        || examIds.some(examId => examId.length > 256)
    ) return { status: "invalid_request" };
    if (examIds.length === 0) return { status: "loaded", targetCounts: {}, assignmentModes: {} };

    const targetCounts: Record<string, number> = {};
    const assignmentModes: Record<string, IndividualAssignmentMode> = {};
    // Keep database pressure bounded even when an early-operation workspace has
    // accumulated many targeted exams.
    const batchSize = 8;
    for (let index = 0; index < examIds.length; index += batchSize) {
        const batch = examIds.slice(index, index + batchSize);
        const results = await Promise.all(batch.map(examId => (
            loadTeacherIndividualAssignmentWithGateway(client, context, examId)
        )));
        for (let offset = 0; offset < results.length; offset += 1) {
            const result = results[offset];
            if (result.status === "unauthorized") return { status: "unauthorized" };
            if (result.status !== "loaded") return { status: "service_unavailable" };
            targetCounts[batch[offset]] = result.targetStudentIds.length;
            assignmentModes[batch[offset]] = result.mode;
        }
    }
    return { status: "loaded", targetCounts, assignmentModes };
}
