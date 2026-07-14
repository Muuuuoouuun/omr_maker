"use server";

import { cookies, headers } from "next/headers";
import {
    createSupabaseAdminClient,
    getSupabaseServerConfigFromEnv,
} from "@/lib/supabaseServerAdmin";
import {
    saveTeacherExamWithGateway,
    loadTeacherExamWithGateway,
    listTeacherExamsWithGateway,
    deleteTeacherExamWithGateway,
    type TeacherExamGatewayClient,
    type TeacherExamSaveResult,
} from "@/lib/teacherExamGateway";
import {
    parseSignedTeacherSessionCookie,
    TEACHER_SERVER_SESSION_COOKIE,
} from "@/lib/teacherServerSession";
import { isSameOriginServerActionRequest } from "@/lib/serverActionSecurity";
import { workspaceContextFromTeacherSession } from "@/lib/workspaceContext";
import type { Exam } from "@/types/omr";

export type TeacherCanonicalExamSaveResult = TeacherExamSaveResult
    | { status: "local_only" | "unauthorized" };

export type TeacherCanonicalExamLoadResult =
    | { status: "loaded"; exam: Exam }
    | { status: "not_found" | "local_only" | "unauthorized" | "service_unavailable"; error?: string };

export type TeacherCanonicalExamListResult =
    | { status: "loaded"; exams: Exam[] }
    | { status: "local_only" | "unauthorized" | "service_unavailable"; error?: string };

async function teacherGatewayContext(): Promise<{
    client: TeacherExamGatewayClient;
    context: ReturnType<typeof workspaceContextFromTeacherSession>;
} | { status: "local_only" | "unauthorized" | "service_unavailable" }> {
    const headerStore = await headers();
    if (!isSameOriginServerActionRequest(headerStore)) return { status: "unauthorized" };
    const cookieStore = await cookies();
    const session = parseSignedTeacherSessionCookie(cookieStore.get(TEACHER_SERVER_SESSION_COOKIE)?.value);
    if (!session) return { status: "unauthorized" };
    const config = getSupabaseServerConfigFromEnv();
    if (!config) {
        return { status: process.env.NODE_ENV === "production" ? "service_unavailable" : "local_only" };
    }
    return {
        client: createSupabaseAdminClient(config) as unknown as TeacherExamGatewayClient,
        context: workspaceContextFromTeacherSession(session),
    };
}

export async function saveTeacherCanonicalExam(
    exam: Exam,
): Promise<TeacherCanonicalExamSaveResult> {
    try {
        const headerStore = await headers();
        if (!isSameOriginServerActionRequest(headerStore)) return { status: "unauthorized" };
        const cookieStore = await cookies();
        const session = parseSignedTeacherSessionCookie(
            cookieStore.get(TEACHER_SERVER_SESSION_COOKIE)?.value,
        );
        if (!session) return { status: "unauthorized" };

        const config = getSupabaseServerConfigFromEnv();
        if (!config) {
            return process.env.NODE_ENV === "production"
                ? { status: "service_unavailable", error: "Canonical exam gateway is not configured" }
                : { status: "local_only" };
        }
        return saveTeacherExamWithGateway(
            createSupabaseAdminClient(config) as unknown as TeacherExamGatewayClient,
            exam,
            workspaceContextFromTeacherSession(session),
        );
    } catch (error) {
        return {
            status: "service_unavailable",
            error: error instanceof Error ? error.message : "Canonical exam save failed",
        };
    }
}

export async function loadTeacherCanonicalExam(examId: string): Promise<TeacherCanonicalExamLoadResult> {
    try {
        const gateway = await teacherGatewayContext();
        if ("status" in gateway) return gateway;
        return loadTeacherExamWithGateway(gateway.client, examId, gateway.context);
    } catch (error) {
        return { status: "service_unavailable", error: error instanceof Error ? error.message : "Exam load failed" };
    }
}

export async function listTeacherCanonicalExams(): Promise<TeacherCanonicalExamListResult> {
    try {
        const gateway = await teacherGatewayContext();
        if ("status" in gateway) return gateway;
        const result = await listTeacherExamsWithGateway(gateway.client, gateway.context);
        return result.status === "loaded" ? result : { status: "service_unavailable", error: result.error };
    } catch (error) {
        return { status: "service_unavailable", error: error instanceof Error ? error.message : "Exam list failed" };
    }
}

export async function deleteTeacherCanonicalExam(examId: string): Promise<
    { status: "deleted"; examId: string }
    | { status: "not_found" | "local_only" | "unauthorized" | "service_unavailable"; error?: string }
> {
    try {
        const gateway = await teacherGatewayContext();
        if ("status" in gateway) return gateway;
        return deleteTeacherExamWithGateway(gateway.client, examId, gateway.context);
    } catch (error) {
        return { status: "service_unavailable", error: error instanceof Error ? error.message : "Exam delete failed" };
    }
}
