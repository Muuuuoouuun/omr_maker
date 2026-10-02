import type { WorkspaceContext } from "@/lib/workspaceContext";
import {
    normalizeTeacherNotificationSummary,
    type TeacherNotificationSummary,
} from "@/lib/teacherNotificationSummary";

interface RpcResult {
    data: unknown;
    error: { message?: string } | null;
}

export interface TeacherNotificationSummaryGatewayClient {
    rpc(
        name: "omr_teacher_notification_summary_v1",
        params: { p_organization_id: string },
    ): Promise<RpcResult>;
}

export type TeacherNotificationSummaryGatewayResult =
    | { status: "loaded"; summary: TeacherNotificationSummary }
    | { status: "service_unavailable"; error?: string };

export async function loadTeacherNotificationSummaryWithGateway(
    client: TeacherNotificationSummaryGatewayClient,
    context: WorkspaceContext,
): Promise<TeacherNotificationSummaryGatewayResult> {
    const organizationId = context.organizationId.trim();
    if (!organizationId) return { status: "service_unavailable", error: "Missing organization scope" };

    try {
        const result = await client.rpc("omr_teacher_notification_summary_v1", {
            p_organization_id: organizationId,
        });
        if (result.error) return { status: "service_unavailable", error: result.error.message };
        const record = Array.isArray(result.data) ? result.data[0] : result.data;
        const summary = normalizeTeacherNotificationSummary(record);
        if (!summary) return { status: "service_unavailable", error: "Invalid notification summary" };
        return { status: "loaded", summary };
    } catch (error) {
        return {
            status: "service_unavailable",
            error: error instanceof Error ? error.message : "Notification summary failed",
        };
    }
}
