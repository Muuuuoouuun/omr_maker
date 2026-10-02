import { INITIAL_OPERATIONS_LIMITS } from "@/lib/initialOperationsPolicy";
import { resolveAssignmentLifecycle } from "@/lib/assignmentLifecycle";
import type { StudentAssignmentPreview } from "@/lib/studentExamContract";
import { ownerStudentId } from "@/lib/studentExamCore";
import type { StudentServerIdentity } from "@/lib/studentServerSession";

interface RpcResult {
    data: unknown;
    error: { message?: string } | null;
}

export interface StudentTargetedAssignmentGatewayClient {
    rpc(name: string, params: Record<string, unknown>): Promise<RpcResult>;
}

export type ResolvedStudentTargetedAssignment =
    | {
        status: "authorized";
        assignmentId: string;
        assignmentRevision: number;
        examId: string;
        mode: "base";
        questionIds: number[];
    }
    | {
        status: "authorized";
        assignmentId: string;
        assignmentRevision: number;
        examId: string;
        mode: "retake";
        sourceAttemptId: string;
        questionIds: number[];
    }
    | { status: "denied" | "service_unavailable" };

export type StudentAssignmentListGatewayResult =
    | { status: "loaded"; assignments: StudentAssignmentPreview[]; serverNow: string }
    | { status: "capacity_exceeded" | "service_unavailable" };

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function record(value: unknown): Record<string, unknown> | null {
    const candidate = Array.isArray(value) ? value[0] : value;
    return candidate && typeof candidate === "object" && !Array.isArray(candidate)
        ? candidate as Record<string, unknown>
        : null;
}

function questionIds(value: unknown): number[] {
    if (!Array.isArray(value)) return [];
    return [...new Set(value
        .map(item => typeof item === "number" ? item : Number(item))
        .filter(item => Number.isSafeInteger(item) && item > 0))]
        .sort((left, right) => left - right);
}

function optionalString(value: unknown): string | undefined {
    return clean(value) || undefined;
}

function optionalNumber(value: unknown): number | undefined {
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function rpcScope(identity: StudentServerIdentity) {
    return {
        p_organization_id: clean(identity.organizationId),
        p_owner_student_id: ownerStudentId(identity),
        p_identity_type: identity.identityType,
        p_group_id: clean(identity.groupId),
        p_group_name: clean(identity.groupName),
    };
}

export async function listStudentAssignmentsWithGateway(
    client: StudentTargetedAssignmentGatewayClient,
    identity: StudentServerIdentity,
): Promise<StudentAssignmentListGatewayResult> {
    const scope = rpcScope(identity);
    if (!scope.p_organization_id || !scope.p_owner_student_id) return { status: "service_unavailable" };
    const response = await client.rpc("omr_list_student_assignments_v2", scope);
    const envelope = record(response.data);
    if (response.error || !envelope || !Array.isArray(envelope.assignments)) return { status: "service_unavailable" };
    if (envelope.assignments.length > INITIAL_OPERATIONS_LIMITS.teacherExams) return { status: "capacity_exceeded" };
    const serverNow = clean(envelope.serverNow);
    if (resolveAssignmentLifecycle({ state: "open", now: serverNow }) === "invalid") {
        return { status: "service_unavailable" };
    }
    try {
        const assignments = envelope.assignments.map(value => {
            if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid assignment row");
            const row = value as Record<string, unknown>;
            const id = clean(row.id);
            const title = clean(row.title);
            const createdAt = clean(row.created_at);
            const assignmentId = clean(row.assignment_id);
            const assignmentRevision = Number(row.assignment_revision);
            const validAssignmentRevision = Number.isSafeInteger(assignmentRevision) && assignmentRevision > 0;
            const assignmentMode = row.assignment_mode === "retake" ? "retake" : row.assignment_mode === "base" ? "base" : undefined;
            const accessType = row.access_type;
            if (
                !id || !title || !createdAt
                || typeof row.archived !== "boolean"
                || (accessType !== "public" && accessType !== "group" && accessType !== "targeted")
                || (accessType === "targeted" && (!assignmentId || !assignmentMode || !validAssignmentRevision))
                || (accessType !== "targeted" && (assignmentId || row.assignment_revision !== null && row.assignment_revision !== undefined))
            ) {
                throw new Error("invalid assignment row");
            }
            const lifecycle = resolveAssignmentLifecycle({
                state: row.archived ? "archived" : "open",
                startsAt: row.start_at,
                endsAt: row.end_at,
                now: serverNow,
            });
            if (lifecycle === "invalid") throw new Error("invalid assignment lifecycle");
            const retakeQuestionIds = questionIds(row.retake_question_ids);
            const retakeSourceAttemptId = clean(row.retake_source_attempt_id);
            if (assignmentMode === "retake" && (!retakeSourceAttemptId || retakeQuestionIds.length < 1)) {
                throw new Error("invalid retake assignment row");
            }
            return {
                id,
                ...(assignmentId ? { assignmentId } : {}),
                ...(assignmentId ? { assignmentRevision } : {}),
                ...(assignmentMode ? { assignmentMode } : {}),
                ...(retakeSourceAttemptId ? { retakeSourceAttemptId } : {}),
                ...(retakeQuestionIds.length ? { retakeQuestionIds } : {}),
                title,
                createdAt,
                ...(optionalString(row.updated_at) ? { updatedAt: optionalString(row.updated_at) } : {}),
                ...(optionalNumber(row.duration_min) !== undefined ? { durationMin: optionalNumber(row.duration_min) } : {}),
                lifecycle,
                ...(typeof row.start_at === "string" ? { startsAt: row.start_at } : {}),
                ...(typeof row.end_at === "string" ? { endsAt: row.end_at } : {}),
                archived: row.archived,
                access: { type: accessType, entryCheck: "required" as const },
            } satisfies StudentAssignmentPreview;
        });
        return { status: "loaded", assignments, serverNow };
    } catch {
        return { status: "service_unavailable" };
    }
}

export async function resolveStudentTargetedAssignmentWithGateway(
    client: StudentTargetedAssignmentGatewayClient,
    identity: StudentServerIdentity,
    assignmentIdInput: string,
    assignmentRevisionInput: number,
    examIdInput: string,
): Promise<ResolvedStudentTargetedAssignment> {
    if (identity.kind !== "student" || identity.identityType === "guest") return { status: "denied" };
    const assignmentId = clean(assignmentIdInput);
    const assignmentRevision = Number(assignmentRevisionInput);
    const examId = clean(examIdInput);
    const scope = rpcScope(identity);
    if (!assignmentId || assignmentId.length > 256 || !Number.isSafeInteger(assignmentRevision) || assignmentRevision < 1 || !examId || examId.length > 256 || !scope.p_organization_id || !scope.p_owner_student_id) {
        return { status: "denied" };
    }
    const response = await client.rpc("omr_resolve_student_assignment_v2", {
        ...scope,
        p_assignment_id: assignmentId,
        p_assignment_revision: assignmentRevision,
        p_exam_id: examId,
    });
    if (response.error) return { status: "service_unavailable" };
    const payload = record(response.data);
    if (!payload || payload.status !== "authorized") return { status: "denied" };
    const resolvedAssignmentId = clean(payload.assignmentId);
    const resolvedAssignmentRevision = Number(payload.assignmentRevision);
    const resolvedExamId = clean(payload.examId);
    const mode = payload.mode;
    const resolvedQuestionIds = questionIds(payload.questionIds);
    if (resolvedAssignmentId !== assignmentId || resolvedAssignmentRevision !== assignmentRevision || resolvedExamId !== examId || (mode !== "base" && mode !== "retake")) {
        return { status: "service_unavailable" };
    }
    if (mode === "retake") {
        const sourceAttemptId = clean(payload.sourceAttemptId);
        if (!sourceAttemptId || resolvedQuestionIds.length < 1) return { status: "service_unavailable" };
        return {
            status: "authorized",
            assignmentId,
            assignmentRevision,
            examId,
            mode,
            sourceAttemptId,
            questionIds: resolvedQuestionIds,
        };
    }
    return { status: "authorized", assignmentId, assignmentRevision, examId, mode, questionIds: [] };
}
