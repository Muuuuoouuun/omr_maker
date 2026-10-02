"use server";

import { createHmac } from "node:crypto";
import { cookies, headers } from "next/headers";
import { createSupabaseAdminClient, getSupabaseServerConfigFromEnv } from "@/lib/supabaseServerAdmin";
import { isSameOriginServerActionRequest } from "@/lib/serverActionSecurity";
import {
    resolveAuthorizedTeacherSessionCookie,
    resolveTeacherSessionSecret,
    TEACHER_SERVER_SESSION_COOKIE,
} from "@/lib/teacherServerSession";
import { workspaceContextFromTeacherSession } from "@/lib/workspaceContext";
import type { ScopedTeacherNotificationSummary } from "@/lib/teacherNotificationSummary";
import {
    loadTeacherNotificationSummaryWithGateway,
    type TeacherNotificationSummaryGatewayClient,
} from "@/lib/teacherNotificationSummaryGateway";
import { notificationsFromTeacherSummary } from "@/lib/teacherNotificationSummary";
import {
    validateTeacherNotificationIds,
    type TeacherNotificationState,
    type TeacherNotificationStateOperation,
} from "@/lib/teacherNotificationState";
import {
    loadTeacherNotificationStateWithGateway,
    mutateTeacherNotificationStateWithGateway,
    type TeacherNotificationStateGatewayClient,
} from "@/lib/teacherNotificationStateGateway";
import { isTeacherMutationAuthorized } from "@/lib/teacherMutationAuthorization";

type NotificationClient = TeacherNotificationSummaryGatewayClient & TeacherNotificationStateGatewayClient;
type NotificationActionContext = {
    client: NotificationClient;
    context: ReturnType<typeof workspaceContextFromTeacherSession>;
} | { status: "local_only" | "unauthorized" | "service_unavailable" };

async function notificationActionContext(requireWrite = false): Promise<NotificationActionContext> {
    const headerStore = await headers();
    if (!isSameOriginServerActionRequest(headerStore)) return { status: "unauthorized" };
    const cookieStore = await cookies();
    const session = await resolveAuthorizedTeacherSessionCookie(
        cookieStore.get(TEACHER_SERVER_SESSION_COOKIE)?.value,
    );
    if (!session) return { status: "unauthorized" };
    if (requireWrite && !isTeacherMutationAuthorized(session)) return { status: "unauthorized" };
    const context = workspaceContextFromTeacherSession(session);
    const config = getSupabaseServerConfigFromEnv();
    if (!config) {
        return { status: process.env.NODE_ENV === "production" ? "service_unavailable" : "local_only" };
    }
    if (!context.actorUserId) return { status: "service_unavailable" };
    return {
        client: createSupabaseAdminClient(config) as unknown as NotificationClient,
        context,
    };
}

export async function loadTeacherNotificationSummary(): Promise<
    { status: "loaded"; summary: ScopedTeacherNotificationSummary }
    | { status: "local_only" | "unauthorized" | "service_unavailable" }
> {
    try {
        const gateway = await notificationActionContext();
        if ("status" in gateway) return gateway;
        const { client, context } = gateway;
        const result = await loadTeacherNotificationSummaryWithGateway(
            client,
            context,
        );
        if (result.status !== "loaded") return { status: "service_unavailable" };
        const notificationIds = notificationsFromTeacherSummary(result.summary).map(notification => notification.id);
        const state = await loadTeacherNotificationStateWithGateway(client, context, notificationIds);
        if (state.status !== "loaded") return { status: "service_unavailable" };
        const secret = resolveTeacherSessionSecret();
        if (!secret) return { status: "service_unavailable" };
        const scopeKey = `scope_${createHmac("sha256", secret)
            .update(`teacher-notifications:${context.organizationId}:${context.actorUserId}`, "utf8")
            .digest("base64url")}`;
        return {
            status: "loaded",
            summary: { ...result.summary, scopeKey, notificationStates: state.states },
        };
    } catch {
        return { status: "service_unavailable" };
    }
}

export interface TeacherNotificationStateMutationInput {
    operation: TeacherNotificationStateOperation;
    notificationIds: string[];
}

export type TeacherNotificationStateMutationActionResult =
    | { status: "saved"; states: TeacherNotificationState[] }
    | { status: "local_only" | "unauthorized" | "service_unavailable" | "invalid_request" | "stale" };

export async function mutateTeacherNotificationState(
    input: TeacherNotificationStateMutationInput,
): Promise<TeacherNotificationStateMutationActionResult> {
    try {
        const operation = input?.operation;
        const notificationIds = validateTeacherNotificationIds(input?.notificationIds);
        if (!notificationIds || notificationIds.length === 0 || !["mark_read", "dismiss"].includes(operation)) {
            return { status: "invalid_request" };
        }
        const gateway = await notificationActionContext(true);
        if ("status" in gateway) return gateway;
        const summary = await loadTeacherNotificationSummaryWithGateway(gateway.client, gateway.context);
        if (summary.status !== "loaded") return { status: "service_unavailable" };
        const currentIds = new Set(
            notificationsFromTeacherSummary(summary.summary).map(notification => notification.id),
        );
        if (notificationIds.some(notificationId => !currentIds.has(notificationId))) {
            return { status: "stale" };
        }
        const result = await mutateTeacherNotificationStateWithGateway(
            gateway.client,
            gateway.context,
            operation,
            notificationIds,
        );
        return result.status === "saved"
            ? result
            : { status: "service_unavailable" };
    } catch {
        return { status: "service_unavailable" };
    }
}
