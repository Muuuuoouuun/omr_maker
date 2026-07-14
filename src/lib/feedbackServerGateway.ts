import {
    feedbackFromSupabaseRow,
    feedbackToSupabaseRow,
    studentVisibleAttemptFeedback,
    type SupabaseAttemptFeedbackRow,
} from "@/lib/feedbackPersistence";
import type { WorkspaceContext } from "@/lib/workspaceContext";
import type { AttemptFeedback, PdfDrawings } from "@/types/omr";

interface GatewayResult<T> {
    data: T | null;
    error: { message?: string } | null;
}

interface FeedbackSelectQuery {
    eq(column: string, value: string): FeedbackSelectQuery;
    maybeSingle(): Promise<GatewayResult<unknown>>;
    order(column: string, options: { ascending: false }): Promise<GatewayResult<unknown[]>>;
}

export interface FeedbackGatewayClient {
    from(table: "omr_attempt_feedback"): {
        select(columns: string): FeedbackSelectQuery;
    };
    rpc(name: string, args: Record<string, unknown>): Promise<GatewayResult<unknown>>;
}

export interface FeedbackEnvelope {
    feedback: AttemptFeedback;
    markupDrawings?: PdfDrawings;
}

export type FeedbackLoadResult =
    | { status: "loaded"; item: FeedbackEnvelope }
    | { status: "not_found" | "service_unavailable"; error?: string };

export type FeedbackListResult =
    | { status: "loaded"; items: FeedbackEnvelope[] }
    | { status: "service_unavailable"; error?: string };

export type FeedbackMutationResult<Success extends "saved" | "returned" | "opened"> =
    | { status: Success; item: FeedbackEnvelope }
    | { status: "not_found" | "invalid_feedback" | "service_unavailable"; error?: string };

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function normalizeDrawings(value: unknown): PdfDrawings | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const normalized: PdfDrawings = {};
    for (const [page, paths] of Object.entries(value)) {
        const pageNumber = Number(page);
        if (!Number.isFinite(pageNumber) || !Array.isArray(paths)) continue;
        const safePaths = paths.filter((path): path is string => typeof path === "string" && path.length > 0);
        if (safePaths.length) normalized[pageNumber] = safePaths;
    }
    return Object.keys(normalized).length ? normalized : undefined;
}

function envelopeFromRow(row: unknown, studentProfileId?: string): FeedbackEnvelope | null {
    if (!row || typeof row !== "object") return null;
    try {
        const typedRow = row as SupabaseAttemptFeedbackRow;
        const feedback = feedbackFromSupabaseRow(typedRow);
        const visible = studentProfileId
            ? studentVisibleAttemptFeedback(feedback, studentProfileId)
            : feedback;
        if (!visible) return null;
        const markupDrawings = normalizeDrawings(typedRow.markup_drawings);
        return { feedback: visible, ...(markupDrawings ? { markupDrawings } : {}) };
    } catch {
        return null;
    }
}

export async function loadTeacherFeedbackWithGateway(
    client: FeedbackGatewayClient,
    attemptId: string,
    context: WorkspaceContext,
): Promise<FeedbackLoadResult> {
    const normalizedAttemptId = clean(attemptId);
    if (!normalizedAttemptId || !clean(context.organizationId)) return { status: "not_found" };
    const result = await client
        .from("omr_attempt_feedback")
        .select("*")
        .eq("organization_id", context.organizationId)
        .eq("attempt_id", normalizedAttemptId)
        .maybeSingle();
    if (result.error) return { status: "service_unavailable", error: result.error.message };
    const item = envelopeFromRow(result.data);
    return item ? { status: "loaded", item } : { status: "not_found" };
}

export async function saveTeacherFeedbackWithGateway(
    client: FeedbackGatewayClient,
    feedback: AttemptFeedback,
    context: WorkspaceContext,
    markupDrawings?: PdfDrawings,
): Promise<FeedbackMutationResult<"saved">> {
    if (!clean(context.organizationId) || !clean(context.actorUserId)) return { status: "invalid_feedback" };
    const now = new Date().toISOString();
    const scopedFeedback: AttemptFeedback = {
        ...feedback,
        organizationId: context.organizationId,
        teacherUserId: context.actorUserId,
        status: "draft",
        returnedAt: undefined,
        delivery: {
            notificationStatus: "not_queued",
            notificationChannel: "in_app",
            openCount: 0,
        },
        updatedAt: now,
    };
    let row: SupabaseAttemptFeedbackRow;
    try {
        row = feedbackToSupabaseRow(scopedFeedback, context, markupDrawings);
    } catch {
        return { status: "invalid_feedback" };
    }
    const result = await client.rpc("omr_save_feedback_v1", {
        p_organization_id: context.organizationId,
        p_feedback: row,
    });
    if (result.error) return { status: "service_unavailable", error: result.error.message };
    const item = envelopeFromRow(result.data);
    return item
        ? { status: "saved", item }
        : { status: "service_unavailable", error: "Feedback save returned no payload" };
}

export async function returnTeacherFeedbackWithGateway(
    client: FeedbackGatewayClient,
    feedbackId: string,
    context: WorkspaceContext,
): Promise<FeedbackMutationResult<"returned">> {
    const normalizedId = clean(feedbackId);
    if (!normalizedId || !clean(context.organizationId)) return { status: "not_found" };
    const result = await client.rpc("omr_return_feedback_v1", {
        p_organization_id: context.organizationId,
        p_feedback_id: normalizedId,
        p_returned_at: new Date().toISOString(),
    });
    if (result.error) return { status: "service_unavailable", error: result.error.message };
    const item = envelopeFromRow(result.data);
    return item ? { status: "returned", item } : { status: "not_found" };
}

export async function listStudentFeedbackWithGateway(
    client: FeedbackGatewayClient,
    organizationId: string,
    studentProfileId: string,
): Promise<FeedbackListResult> {
    const organization = clean(organizationId);
    const student = clean(studentProfileId);
    if (!organization || !student) return { status: "loaded", items: [] };
    const result = await client
        .from("omr_attempt_feedback")
        .select("*")
        .eq("organization_id", organization)
        .eq("student_profile_id", student)
        .eq("status", "returned")
        .order("updated_at", { ascending: false });
    if (result.error) return { status: "service_unavailable", error: result.error.message };
    return {
        status: "loaded",
        items: (result.data || []).flatMap(row => {
            const item = envelopeFromRow(row, student);
            return item ? [item] : [];
        }),
    };
}

export async function loadStudentFeedbackWithGateway(
    client: FeedbackGatewayClient,
    attemptId: string,
    organizationId: string,
    studentProfileId: string,
): Promise<FeedbackLoadResult> {
    const organization = clean(organizationId);
    const student = clean(studentProfileId);
    const attempt = clean(attemptId);
    if (!organization || !student || !attempt) return { status: "not_found" };
    const result = await client
        .from("omr_attempt_feedback")
        .select("*")
        .eq("organization_id", organization)
        .eq("student_profile_id", student)
        .eq("attempt_id", attempt)
        .eq("status", "returned")
        .maybeSingle();
    if (result.error) return { status: "service_unavailable", error: result.error.message };
    const item = envelopeFromRow(result.data, student);
    return item ? { status: "loaded", item } : { status: "not_found" };
}

export async function markStudentFeedbackOpenedWithGateway(
    client: FeedbackGatewayClient,
    feedbackId: string,
    organizationId: string,
    studentProfileId: string,
): Promise<FeedbackMutationResult<"opened">> {
    const organization = clean(organizationId);
    const student = clean(studentProfileId);
    const feedback = clean(feedbackId);
    if (!organization || !student || !feedback) return { status: "not_found" };
    const result = await client.rpc("omr_mark_feedback_opened_v2", {
        p_organization_id: organization,
        p_student_profile_id: student,
        p_feedback_id: feedback,
        p_opened_at: new Date().toISOString(),
    });
    if (result.error) return { status: "service_unavailable", error: result.error.message };
    const item = envelopeFromRow(result.data, student);
    return item ? { status: "opened", item } : { status: "not_found" };
}
