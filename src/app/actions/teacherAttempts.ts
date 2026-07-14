"use server";

import { cookies, headers } from "next/headers";
import {
    createSupabaseAdminClient,
    getSupabaseServerConfigFromEnv,
} from "@/lib/supabaseServerAdmin";
import {
    listTeacherAttemptsWithGateway,
    loadTeacherAttemptWithGateway,
    saveTeacherAttemptWithGateway,
    type TeacherAttemptGatewayClient,
} from "@/lib/teacherAttemptGateway";
import { isSameOriginServerActionRequest } from "@/lib/serverActionSecurity";
import {
    parseSignedTeacherSessionCookie,
    TEACHER_SERVER_SESSION_COOKIE,
} from "@/lib/teacherServerSession";
import { workspaceContextFromTeacherSession } from "@/lib/workspaceContext";
import type { Attempt } from "@/types/omr";

type TeacherAttemptActionContext = {
    client: TeacherAttemptGatewayClient;
    context: ReturnType<typeof workspaceContextFromTeacherSession>;
} | { status: "local_only" | "unauthorized" | "service_unavailable" };

async function actionContext(): Promise<TeacherAttemptActionContext> {
    const headerStore = await headers();
    if (!isSameOriginServerActionRequest(headerStore)) return { status: "unauthorized" };
    const cookieStore = await cookies();
    const session = parseSignedTeacherSessionCookie(cookieStore.get(TEACHER_SERVER_SESSION_COOKIE)?.value);
    if (!session) return { status: "unauthorized" };
    const config = getSupabaseServerConfigFromEnv();
    if (!config) return { status: process.env.NODE_ENV === "production" ? "service_unavailable" : "local_only" };
    return {
        client: createSupabaseAdminClient(config) as unknown as TeacherAttemptGatewayClient,
        context: workspaceContextFromTeacherSession(session),
    };
}

export async function listTeacherCanonicalAttempts(examId?: string): Promise<
    { status: "loaded"; attempts: Attempt[] }
    | { status: "local_only" | "unauthorized" | "service_unavailable"; error?: string }
> {
    try {
        const gateway = await actionContext();
        if ("status" in gateway) return gateway;
        return listTeacherAttemptsWithGateway(gateway.client, gateway.context, examId);
    } catch (error) {
        return { status: "service_unavailable", error: error instanceof Error ? error.message : "Attempt list failed" };
    }
}

export async function loadTeacherCanonicalAttempt(attemptId: string): Promise<
    { status: "loaded"; attempt: Attempt }
    | { status: "not_found" | "local_only" | "unauthorized" | "service_unavailable"; error?: string }
> {
    try {
        const gateway = await actionContext();
        if ("status" in gateway) return gateway;
        return loadTeacherAttemptWithGateway(gateway.client, attemptId, gateway.context);
    } catch (error) {
        return { status: "service_unavailable", error: error instanceof Error ? error.message : "Attempt load failed" };
    }
}

export async function saveTeacherCanonicalAttempt(attempt: Attempt): Promise<
    { status: "saved"; attempt: Attempt }
    | { status: "local_only" | "unauthorized" | "service_unavailable"; error?: string }
> {
    try {
        const gateway = await actionContext();
        if ("status" in gateway) return gateway;
        return saveTeacherAttemptWithGateway(gateway.client, attempt, gateway.context);
    } catch (error) {
        return { status: "service_unavailable", error: error instanceof Error ? error.message : "Attempt update failed" };
    }
}
