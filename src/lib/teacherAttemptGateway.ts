import {
    attemptFromSupabaseRow,
    attemptToSupabaseRow,
    questionResultRowsForAttempt,
    type SupabaseAttemptRow,
} from "@/lib/omrPersistence";
import type { WorkspaceContext } from "@/lib/workspaceContext";
import type { Attempt } from "@/types/omr";

interface AttemptQueryResult<T> {
    data: T | null;
    error: { message?: string } | null;
}

export interface TeacherAttemptGatewayClient {
    from(table: "omr_attempts"): {
        select(columns: string): {
            eq(column: string, value: string): {
                eq(column: string, value: string): {
                    maybeSingle(): Promise<AttemptQueryResult<unknown>>;
                };
                order(column: string, options: { ascending: false }): Promise<AttemptQueryResult<unknown[]>>;
            };
        };
    };
    rpc(name: "omr_teacher_update_attempt_v1", args: {
        p_organization_id: string;
        p_attempt: SupabaseAttemptRow;
        p_question_results: ReturnType<typeof questionResultRowsForAttempt>;
    }): Promise<AttemptQueryResult<Array<{ payload: Attempt }> | { payload: Attempt }>>;
}

export type TeacherAttemptListResult =
    | { status: "loaded"; attempts: Attempt[] }
    | { status: "service_unavailable"; error?: string };

export type TeacherAttemptLoadResult =
    | { status: "loaded"; attempt: Attempt }
    | { status: "not_found" | "service_unavailable"; error?: string };

export type TeacherAttemptSaveResult =
    | { status: "saved"; attempt: Attempt }
    | { status: "service_unavailable"; error?: string };

export async function saveTeacherAttemptWithGateway(
    client: TeacherAttemptGatewayClient,
    attempt: Attempt,
    context: WorkspaceContext,
): Promise<TeacherAttemptSaveResult> {
    const scopedAttempt: Attempt = {
        ...attempt,
        organizationId: context.organizationId,
    };
    const result = await client.rpc("omr_teacher_update_attempt_v1", {
        p_organization_id: context.organizationId,
        p_attempt: attemptToSupabaseRow(scopedAttempt, context),
        p_question_results: questionResultRowsForAttempt(scopedAttempt, undefined, context),
    });
    if (result.error) return { status: "service_unavailable", error: result.error.message };
    const record = Array.isArray(result.data) ? result.data[0] : result.data;
    if (!record?.payload) return { status: "service_unavailable", error: "Attempt update returned no payload" };
    try {
        return { status: "saved", attempt: attemptFromSupabaseRow(record) };
    } catch {
        return { status: "service_unavailable", error: "Invalid canonical attempt payload" };
    }
}

export async function listTeacherAttemptsWithGateway(
    client: TeacherAttemptGatewayClient,
    context: WorkspaceContext,
): Promise<TeacherAttemptListResult> {
    const result = await client
        .from("omr_attempts")
        .select("*")
        .eq("organization_id", context.organizationId)
        .order("finished_at", { ascending: false });
    if (result.error) return { status: "service_unavailable", error: result.error.message };
    const attempts = (result.data || []).flatMap(row => {
        try {
            return [attemptFromSupabaseRow(row as SupabaseAttemptRow)];
        } catch {
            return [];
        }
    });
    return { status: "loaded", attempts };
}

export async function loadTeacherAttemptWithGateway(
    client: TeacherAttemptGatewayClient,
    attemptId: string,
    context: WorkspaceContext,
): Promise<TeacherAttemptLoadResult> {
    if (!attemptId.trim()) return { status: "not_found" };
    const result = await client
        .from("omr_attempts")
        .select("*")
        .eq("organization_id", context.organizationId)
        .eq("id", attemptId.trim())
        .maybeSingle();
    if (result.error) return { status: "service_unavailable", error: result.error.message };
    if (!result.data) return { status: "not_found" };
    try {
        return { status: "loaded", attempt: attemptFromSupabaseRow(result.data as SupabaseAttemptRow) };
    } catch {
        return { status: "service_unavailable", error: "Invalid canonical attempt payload" };
    }
}
