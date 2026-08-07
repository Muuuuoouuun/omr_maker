import type { WorkspaceContext } from "@/lib/workspaceContext";
import {
    normalizeTeacherNotificationStateRows,
    validateTeacherNotificationIds,
    type TeacherNotificationState,
    type TeacherNotificationStateOperation,
} from "@/lib/teacherNotificationState";

interface RpcResult {
    data: unknown;
    error: { message?: string } | null;
}

export interface TeacherNotificationStateGatewayClient {
    rpc(name: string, params: Record<string, unknown>): Promise<RpcResult>;
}

export type TeacherNotificationStateLoadResult =
    | { status: "loaded"; states: TeacherNotificationState[] }
    | { status: "service_unavailable"; error?: string };

export type TeacherNotificationStateMutationResult =
    | { status: "saved"; states: TeacherNotificationState[] }
    | { status: "service_unavailable"; error?: string };

function cleanScope(value: unknown): string {
    const cleaned = typeof value === "string" ? value.trim() : "";
    return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(cleaned) ? cleaned : "";
}

function scope(context: WorkspaceContext): { organizationId: string; teacherUserId: string } | null {
    const organizationId = cleanScope(context.organizationId);
    const teacherUserId = cleanScope(context.actorUserId);
    return organizationId && teacherUserId ? { organizationId, teacherUserId } : null;
}

export async function loadTeacherNotificationStateWithGateway(
    client: TeacherNotificationStateGatewayClient,
    context: WorkspaceContext,
    notificationIds: string[],
): Promise<TeacherNotificationStateLoadResult> {
    const scoped = scope(context);
    const ids = validateTeacherNotificationIds(notificationIds);
    if (!scoped || !ids) return { status: "service_unavailable", error: "Invalid notification state scope" };
    if (ids.length === 0) return { status: "loaded", states: [] };
    try {
        const result = await client.rpc("omr_load_teacher_notification_state_v1", {
            p_organization_id: scoped.organizationId,
            p_teacher_user_id: scoped.teacherUserId,
            p_notification_ids: ids,
        });
        if (result.error) return { status: "service_unavailable", error: result.error.message };
        const states = normalizeTeacherNotificationStateRows(result.data, ids);
        return states
            ? { status: "loaded", states }
            : { status: "service_unavailable", error: "Invalid notification state payload" };
    } catch (error) {
        return {
            status: "service_unavailable",
            error: error instanceof Error ? error.message : "Notification state load failed",
        };
    }
}

export async function mutateTeacherNotificationStateWithGateway(
    client: TeacherNotificationStateGatewayClient,
    context: WorkspaceContext,
    operation: TeacherNotificationStateOperation,
    notificationIds: string[],
): Promise<TeacherNotificationStateMutationResult> {
    const scoped = scope(context);
    const ids = validateTeacherNotificationIds(notificationIds);
    if (!scoped || !ids || ids.length === 0 || !["mark_read", "dismiss"].includes(operation)) {
        return { status: "service_unavailable", error: "Invalid notification state mutation" };
    }
    try {
        const result = await client.rpc("omr_mutate_teacher_notification_state_v1", {
            p_organization_id: scoped.organizationId,
            p_teacher_user_id: scoped.teacherUserId,
            p_operation: operation,
            p_notification_ids: ids,
        });
        if (result.error) return { status: "service_unavailable", error: result.error.message };
        const states = normalizeTeacherNotificationStateRows(result.data, ids);
        return states && states.length === ids.length
            ? { status: "saved", states }
            : { status: "service_unavailable", error: "Invalid notification mutation payload" };
    } catch (error) {
        return {
            status: "service_unavailable",
            error: error instanceof Error ? error.message : "Notification state mutation failed",
        };
    }
}
