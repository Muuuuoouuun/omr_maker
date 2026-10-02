"use server";

import { cookies, headers } from "next/headers";
import {
    createSupabaseAdminClient,
    getSupabaseServerConfigFromEnv,
} from "@/lib/supabaseServerAdmin";
import {
    listStudentAttemptsWithGateway,
    loadStudentAttemptWithGateway,
    type StudentAttemptReadGatewayClient,
} from "@/lib/studentAttemptReadGateway";
import type {
    StudentAttemptDetailResult,
    StudentAttemptListResult,
} from "@/lib/studentAttemptHistoryContract";
import { isSameOriginServerActionRequest } from "@/lib/serverActionSecurity";
import {
    resolveAuthorizedStudentSessionCookie,
    STUDENT_SERVER_SESSION_COOKIE,
    type StudentSessionValidationClient,
    type StudentServerSession,
} from "@/lib/studentServerSession";

type StudentAttemptActionContext = {
    client: StudentAttemptReadGatewayClient;
    session: StudentServerSession;
} | { status: "local_only" | "unauthorized" | "service_unavailable" };

async function actionContext(): Promise<StudentAttemptActionContext> {
    const headerStore = await headers();
    if (!isSameOriginServerActionRequest(headerStore)) return { status: "unauthorized" };
    const config = getSupabaseServerConfigFromEnv();
    if (!config) {
        return { status: process.env.NODE_ENV === "production" ? "service_unavailable" : "local_only" };
    }
    const client = createSupabaseAdminClient(config) as unknown as StudentAttemptReadGatewayClient
        & StudentSessionValidationClient;
    const cookieStore = await cookies();
    const validation = await resolveAuthorizedStudentSessionCookie(
        cookieStore.get(STUDENT_SERVER_SESSION_COOKIE)?.value,
        client,
    );
    if (validation.status === "service_unavailable") return { status: "service_unavailable" };
    if (validation.status !== "active") return { status: "unauthorized" };
    const session = validation.identity;
    return {
        client,
        session,
    };
}

export async function listStudentCanonicalAttempts(): Promise<StudentAttemptListResult> {
    try {
        const context = await actionContext();
        if ("status" in context) return context;
        return listStudentAttemptsWithGateway(context.client, context.session);
    } catch (error) {
        return {
            status: "service_unavailable",
            error: error instanceof Error ? error.message : "Student attempt list failed",
        };
    }
}

export async function loadStudentCanonicalAttempt(
    attemptId: string,
): Promise<StudentAttemptDetailResult> {
    try {
        const context = await actionContext();
        if ("status" in context) return context;
        return loadStudentAttemptWithGateway(context.client, attemptId, context.session);
    } catch (error) {
        return {
            status: "service_unavailable",
            error: error instanceof Error ? error.message : "Student attempt load failed",
        };
    }
}
