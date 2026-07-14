"use server";

import { cookies, headers } from "next/headers";
import { createSupabaseAdminClient, getSupabaseServerConfigFromEnv } from "@/lib/supabaseServerAdmin";
import { isSameOriginServerActionRequest } from "@/lib/serverActionSecurity";
import { parseSignedTeacherSessionCookie, TEACHER_SERVER_SESSION_COOKIE } from "@/lib/teacherServerSession";
import { workspaceContextFromTeacherSession } from "@/lib/workspaceContext";

type Result = { status: "saved" } | { status: "local_only" | "unauthorized" | "service_unavailable"; error?: string };
type QueryResult = { data: unknown; error: { message?: string } | null };
type Client = { from(table: string): { select(columns: string): { eq(column: string, value: string): { eq(column: string, value: string): { maybeSingle(): Promise<QueryResult> } } }; upsert(row: unknown): Promise<QueryResult> } };
type Context = { client: Client; workspace: ReturnType<typeof workspaceContextFromTeacherSession> } | { status: "local_only" | "unauthorized" | "service_unavailable" };

async function context(): Promise<Context> {
    const config = getSupabaseServerConfigFromEnv();
    if (!config) return { status: process.env.NODE_ENV === "production" ? "service_unavailable" as const : "local_only" as const };
    const headerStore = await headers();
    if (!isSameOriginServerActionRequest(headerStore)) return { status: "unauthorized" as const };
    const session = parseSignedTeacherSessionCookie((await cookies()).get(TEACHER_SERVER_SESSION_COOKIE)?.value);
    if (!session) return { status: "unauthorized" as const };
    return { client: createSupabaseAdminClient(config) as unknown as Client, workspace: workspaceContextFromTeacherSession(session) };
}

async function verifyScopedRow(client: Client, table: string, idColumn: string, id: string, organizationId: string): Promise<boolean> {
    const result = await client.from(table).select(idColumn).eq("organization_id", organizationId).eq(idColumn, id).maybeSingle();
    if (result.error) throw new Error(result.error.message || "Scope verification failed");
    return !!result.data;
}

export async function saveTeacherKakaoReview(row: Record<string, unknown>): Promise<Result> {
    try {
        const gateway = await context();
        if ("status" in gateway) return gateway;
        const examId = typeof row.exam_id === "string" ? row.exam_id : "";
        if (!await verifyScopedRow(gateway.client, "omr_exams", "id", examId, gateway.workspace.organizationId)) return { status: "unauthorized" };
        const result = await gateway.client.from("omr_kakao_candidate_reviews").upsert({ ...row, organization_id: gateway.workspace.organizationId, reviewed_by_user_id: gateway.workspace.actorUserId || null });
        return result.error ? { status: "service_unavailable", error: result.error.message } : { status: "saved" };
    } catch (error) {
        return { status: "service_unavailable", error: error instanceof Error ? error.message : "Review save failed" };
    }
}

export async function saveTeacherKakaoDispatch(row: Record<string, unknown>): Promise<Result> {
    try {
        const gateway = await context();
        if ("status" in gateway) return gateway;
        const examId = typeof row.exam_id === "string" ? row.exam_id : "";
        const reviewId = typeof row.review_id === "string" ? row.review_id : "";
        if (!await verifyScopedRow(gateway.client, "omr_exams", "id", examId, gateway.workspace.organizationId)
            || !await verifyScopedRow(gateway.client, "omr_kakao_candidate_reviews", "id", reviewId, gateway.workspace.organizationId)) return { status: "unauthorized" };
        const result = await gateway.client.from("omr_kakao_dispatch_logs").upsert({ ...row, organization_id: gateway.workspace.organizationId });
        return result.error ? { status: "service_unavailable", error: result.error.message } : { status: "saved" };
    } catch (error) {
        return { status: "service_unavailable", error: error instanceof Error ? error.message : "Dispatch save failed" };
    }
}
