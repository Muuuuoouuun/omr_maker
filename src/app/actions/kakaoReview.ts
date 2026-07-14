"use server";

import { cookies, headers } from "next/headers";
import { createSupabaseAdminClient, getSupabaseServerConfigFromEnv } from "@/lib/supabaseServerAdmin";
import { isSameOriginServerActionRequest } from "@/lib/serverActionSecurity";
import { parseSignedTeacherSessionCookie, TEACHER_SERVER_SESSION_COOKIE } from "@/lib/teacherServerSession";
import { workspaceContextFromTeacherSession } from "@/lib/workspaceContext";

type Result = { status: "saved" } | { status: "local_only" | "unauthorized" | "service_unavailable"; error?: string };
type QueryResult = { data: unknown; error: { message?: string } | null };
interface SelectQuery {
    eq(column: string, value: string): SelectQuery;
    maybeSingle(): Promise<QueryResult>;
}
type Client = { from(table: string): { select(columns: string): SelectQuery; upsert(row: unknown): Promise<QueryResult> } };
type Context = { client: Client; workspace: ReturnType<typeof workspaceContextFromTeacherSession> } | { status: "local_only" | "unauthorized" | "service_unavailable" };

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

async function context(): Promise<Context> {
    const config = getSupabaseServerConfigFromEnv();
    if (!config) return { status: process.env.NODE_ENV === "production" ? "service_unavailable" as const : "local_only" as const };
    const headerStore = await headers();
    if (!isSameOriginServerActionRequest(headerStore)) return { status: "unauthorized" as const };
    const session = parseSignedTeacherSessionCookie((await cookies()).get(TEACHER_SERVER_SESSION_COOKIE)?.value);
    if (!session) return { status: "unauthorized" as const };
    return { client: createSupabaseAdminClient(config) as unknown as Client, workspace: workspaceContextFromTeacherSession(session) };
}

async function verifyScopedRow(
    client: Client,
    table: string,
    idColumn: string,
    id: string,
    organizationId: string,
    extraFilters: Record<string, string> = {},
): Promise<boolean> {
    if (!clean(id) || !clean(organizationId)) return false;
    let query = client.from(table).select(idColumn).eq("organization_id", organizationId).eq(idColumn, id);
    for (const [column, value] of Object.entries(extraFilters)) query = query.eq(column, value);
    const result = await query.maybeSingle();
    if (result.error) throw new Error(result.error.message || "Scope verification failed");
    return !!result.data;
}

async function canUpsertScopedId(
    client: Client,
    table: string,
    id: string,
    organizationId: string,
): Promise<boolean> {
    if (!clean(id) || !clean(organizationId)) return false;
    const result = await client.from(table).select("organization_id").eq("id", id).maybeSingle();
    if (result.error) throw new Error(result.error.message || "Target scope verification failed");
    if (!result.data) return true;
    return typeof result.data === "object"
        && clean((result.data as { organization_id?: unknown }).organization_id) === organizationId;
}

export async function saveTeacherKakaoReview(row: Record<string, unknown>): Promise<Result> {
    try {
        const gateway = await context();
        if ("status" in gateway) return gateway;
        const reviewId = clean(row.id);
        const examId = clean(row.exam_id);
        const [examScoped, targetScoped] = await Promise.all([
            verifyScopedRow(gateway.client, "omr_exams", "id", examId, gateway.workspace.organizationId),
            canUpsertScopedId(gateway.client, "omr_kakao_candidate_reviews", reviewId, gateway.workspace.organizationId),
        ]);
        if (!examScoped || !targetScoped) return { status: "unauthorized" };
        const result = await gateway.client.from("omr_kakao_candidate_reviews").upsert({
            ...row,
            id: reviewId,
            exam_id: examId,
            organization_id: gateway.workspace.organizationId,
            reviewed_by_user_id: gateway.workspace.actorUserId || null,
        });
        return result.error ? { status: "service_unavailable" } : { status: "saved" };
    } catch {
        return { status: "service_unavailable" };
    }
}

export async function saveTeacherKakaoDispatch(row: Record<string, unknown>): Promise<Result> {
    try {
        const gateway = await context();
        if ("status" in gateway) return gateway;
        const dispatchId = clean(row.id);
        const examId = clean(row.exam_id);
        const reviewId = clean(row.review_id);
        const [examScoped, reviewScoped, targetScoped] = await Promise.all([
            verifyScopedRow(gateway.client, "omr_exams", "id", examId, gateway.workspace.organizationId),
            verifyScopedRow(
                gateway.client,
                "omr_kakao_candidate_reviews",
                "id",
                reviewId,
                gateway.workspace.organizationId,
                { exam_id: examId },
            ),
            canUpsertScopedId(gateway.client, "omr_kakao_dispatch_logs", dispatchId, gateway.workspace.organizationId),
        ]);
        if (!examScoped || !reviewScoped || !targetScoped) return { status: "unauthorized" };
        const result = await gateway.client.from("omr_kakao_dispatch_logs").upsert({
            ...row,
            id: dispatchId,
            review_id: reviewId,
            exam_id: examId,
            organization_id: gateway.workspace.organizationId,
        });
        return result.error ? { status: "service_unavailable" } : { status: "saved" };
    } catch {
        return { status: "service_unavailable" };
    }
}
