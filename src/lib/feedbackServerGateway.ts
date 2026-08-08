import { createHash } from "node:crypto";
import {
    feedbackFromSupabaseRow,
    feedbackToSupabaseRow,
    studentVisibleAttemptFeedback,
    type SupabaseAttemptFeedbackRow,
} from "@/lib/feedbackPersistence";
import type { WorkspaceContext } from "@/lib/workspaceContext";
import type { AttemptFeedback, PdfDrawings } from "@/types/omr";
import {
    INITIAL_CAPACITY_EXCEEDED_ERROR,
    INITIAL_OPERATIONS_LIMITS,
} from "@/lib/initialOperationsPolicy";

// Leave 16 KiB below the database's 256 KiB receipt cap for JSON -> JSONB
// serialization differences and the server-owned response envelope.
export const FEEDBACK_METADATA_MAX_BYTES = 240 * 1024;
export const FEEDBACK_SUMMARY_MAX_BYTES = 32 * 1024;
export const FEEDBACK_COMMENT_MAX_BYTES = 4 * 1024;
export const FEEDBACK_COMMENT_MAX_COUNT = 500;
export const FEEDBACK_MARKUP_MAX_BYTES = 5 * 1024 * 1024;
export const FEEDBACK_MARKUP_MAX_PAGES = 500;
export const FEEDBACK_MARKUP_MAX_STROKES = 20_000;
export const FEEDBACK_MARKUP_MAX_PATH_LENGTH = 64 * 1024;

const STUDENT_FEEDBACK_LIST_COLUMNS = [
    "id",
    "organization_id",
    "attempt_id",
    "exam_id",
    "student_profile_id",
    "status",
    "notification_status",
    "notification_channel",
    "notified_at",
    "first_opened_at",
    "last_opened_at",
    "open_count",
    "returned_at",
    "created_at",
    "updated_at",
].join(", ");

interface GatewayResult<T> {
    data: T | null;
    error: { message?: string } | null;
}

interface FeedbackSelectQuery {
    eq(column: string, value: string): FeedbackSelectQuery;
    maybeSingle(): Promise<GatewayResult<unknown>>;
    order(column: string, options: { ascending: boolean }): FeedbackSelectQuery;
    limit(value: number): Promise<GatewayResult<unknown[]>>;
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
    | FeedbackConflict
    | { status: "not_found" | "invalid_feedback" | "service_unavailable"; error?: string };

type FeedbackConflict = {
    status: "conflict";
    currentRevision: number;
    currentStatus?: string;
    serverUpdatedAt?: string;
};

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function teacherMutationIdentity(context: WorkspaceContext): {
    authority: "account" | "legacy_account";
    accountId: string;
    generation: number;
    actorUserId: string;
} | null {
    const authority = context.sessionAuthority;
    const accountId = clean(context.accountId);
    const actorUserId = clean(context.actorUserId);
    const generation = context.accountSessionGeneration;
    if ((authority !== "account" && authority !== "legacy_account")
        || !accountId || !actorUserId
        || !Number.isSafeInteger(generation) || (generation ?? 0) < 1) return null;
    return { authority, accountId, generation: generation as number, actorUserId };
}

function deterministicMutationId(prefix: "feedback-save" | "feedback-return", input: unknown): string {
    return `${prefix}:${createHash("sha256").update(JSON.stringify(input)).digest("hex")}`;
}

function mutationPayload(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function serializedByteLength(value: unknown): number {
    try {
        return Buffer.byteLength(JSON.stringify(value), "utf8");
    } catch {
        return Number.POSITIVE_INFINITY;
    }
}

function feedbackMutationWithinLimits(row: SupabaseAttemptFeedbackRow): boolean {
    const { markup_drawings: markupDrawings, ...metadata } = row;
    if (serializedByteLength(metadata) > FEEDBACK_METADATA_MAX_BYTES) return false;
    if (row.summary && Buffer.byteLength(row.summary, "utf8") > FEEDBACK_SUMMARY_MAX_BYTES) return false;
    if (!Array.isArray(row.question_comments) || row.question_comments.length > FEEDBACK_COMMENT_MAX_COUNT) return false;
    if (row.question_comments.some(comment => (
        !comment
        || typeof comment !== "object"
        || Buffer.byteLength(typeof comment.body === "string" ? comment.body : "", "utf8") > FEEDBACK_COMMENT_MAX_BYTES
    ))) return false;
    if (markupDrawings === undefined || markupDrawings === null) return true;

    const pages = Object.entries(markupDrawings);
    if (pages.length > FEEDBACK_MARKUP_MAX_PAGES) return false;
    let strokeCount = 0;
    for (const [page, paths] of pages) {
        if (!/^[1-9][0-9]{0,3}$/.test(page) || !Array.isArray(paths)) return false;
        strokeCount += paths.length;
        if (strokeCount > FEEDBACK_MARKUP_MAX_STROKES) return false;
        if (paths.some(path => (
            typeof path !== "string"
            || Buffer.byteLength(path, "utf8") > FEEDBACK_MARKUP_MAX_PATH_LENGTH
        ))) return false;
    }
    return serializedByteLength(markupDrawings) <= FEEDBACK_MARKUP_MAX_BYTES;
}

function conflictFromPayload(value: unknown): FeedbackConflict | null {
    const payload = mutationPayload(value);
    if (payload?.status !== "revision_conflict") return null;
    return {
        status: "conflict",
        currentRevision: typeof payload.currentRevision === "number" ? payload.currentRevision : 0,
        ...(clean(payload.currentStatus) ? { currentStatus: clean(payload.currentStatus) } : {}),
        ...(clean(payload.updatedAt) ? { serverUpdatedAt: clean(payload.updatedAt) } : {}),
    };
}

function envelopeFromMutationPayload(value: unknown): FeedbackEnvelope | null {
    const payload = mutationPayload(value);
    return envelopeFromRow(payload?.feedback);
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

function feedbackSummaryEnvelopeFromRow(
    row: unknown,
    organizationId: string,
    studentProfileId: string,
): FeedbackEnvelope | null {
    if (!row || typeof row !== "object" || Array.isArray(row)) return null;
    const record = row as Record<string, unknown>;
    const id = clean(record.id);
    const attemptId = clean(record.attempt_id);
    const examId = clean(record.exam_id);
    const organization = clean(record.organization_id);
    const student = clean(record.student_profile_id);
    const createdAt = clean(record.created_at);
    const updatedAt = clean(record.updated_at);
    if (
        !id || !attemptId || !examId || !createdAt || !updatedAt
        || organization !== organizationId
        || student !== studentProfileId
        || record.status !== "returned"
    ) {
        return null;
    }
    const notificationStatus = record.notification_status === "sent" || record.notification_status === "failed"
        || record.notification_status === "queued"
        ? record.notification_status
        : "not_queued";
    const notificationChannel = record.notification_channel === "kakao_candidate"
        ? "kakao_candidate"
        : "in_app";
    const openCount = typeof record.open_count === "number" && Number.isFinite(record.open_count)
        ? Math.max(0, Math.trunc(record.open_count))
        : 0;
    return {
        feedback: {
            id,
            attemptId,
            examId,
            organizationId: organization,
            studentProfileId: student,
            status: "returned",
            questionComments: [],
            downloadPolicy: {
                allowStudentDownload: false,
                allowAnnotatedPdfDownload: false,
                watermarkStudentName: true,
            },
            delivery: {
                notificationStatus,
                notificationChannel,
                ...(clean(record.notified_at) ? { notifiedAt: clean(record.notified_at) } : {}),
                ...(clean(record.first_opened_at) ? { firstOpenedAt: clean(record.first_opened_at) } : {}),
                ...(clean(record.last_opened_at) ? { lastOpenedAt: clean(record.last_opened_at) } : {}),
                openCount,
            },
            ...(clean(record.returned_at) ? { returnedAt: clean(record.returned_at) } : {}),
            createdAt,
            updatedAt,
        },
    };
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
    const identity = teacherMutationIdentity(context);
    if (!clean(context.organizationId) || !identity) return { status: "invalid_feedback" };
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
        updatedAt: feedback.updatedAt,
    };
    let row: SupabaseAttemptFeedbackRow;
    try {
        row = feedbackToSupabaseRow(scopedFeedback, context, markupDrawings);
    } catch {
        return { status: "invalid_feedback" };
    }
    if (!feedbackMutationWithinLimits(row)) return { status: "invalid_feedback" };
    const expectedRevision = Math.max(0, Math.floor(feedback.revision || 0));
    const mutationInput = {
        organizationId: context.organizationId,
        feedbackId: row.id,
        expectedRevision,
        feedback: {
            ...row,
            updated_at: undefined,
            payload: row.payload ? { ...row.payload, updatedAt: undefined } : row.payload,
        },
    };
    const result = await client.rpc("omr_save_feedback_v4", {
        p_session_authority: identity.authority,
        p_account_id: identity.accountId,
        p_session_generation: identity.generation,
        p_actor_user_id: identity.actorUserId,
        p_organization_id: context.organizationId,
        p_feedback: row,
        p_expected_revision: expectedRevision,
        p_mutation_id: deterministicMutationId("feedback-save", mutationInput),
    });
    if (result.error) return { status: "service_unavailable", error: result.error.message };
    const conflict = conflictFromPayload(result.data);
    if (conflict) return conflict;
    const item = envelopeFromMutationPayload(result.data);
    const validatedMarkupDrawings = normalizeDrawings(row.markup_drawings);
    return item
        ? {
            status: "saved",
            item: validatedMarkupDrawings && !item.markupDrawings
                ? { ...item, markupDrawings: validatedMarkupDrawings }
                : item,
        }
        : { status: "service_unavailable", error: "Feedback save returned no payload" };
}

export async function returnTeacherFeedbackWithGateway(
    client: FeedbackGatewayClient,
    feedback: AttemptFeedback,
    context: WorkspaceContext,
): Promise<FeedbackMutationResult<"returned">> {
    const normalizedId = clean(feedback.id);
    const identity = teacherMutationIdentity(context);
    if (!normalizedId || !clean(context.organizationId) || !identity) return { status: "not_found" };
    const expectedRevision = Math.max(0, Math.floor(feedback.revision || 0));
    const result = await client.rpc("omr_return_feedback_v4", {
        p_session_authority: identity.authority,
        p_account_id: identity.accountId,
        p_session_generation: identity.generation,
        p_actor_user_id: identity.actorUserId,
        p_organization_id: context.organizationId,
        p_feedback_id: normalizedId,
        p_expected_revision: expectedRevision,
        p_mutation_id: deterministicMutationId("feedback-return", {
            organizationId: context.organizationId,
            feedbackId: normalizedId,
            expectedRevision,
        }),
    });
    if (result.error) return { status: "service_unavailable", error: result.error.message };
    const conflict = conflictFromPayload(result.data);
    if (conflict) return conflict;
    const item = envelopeFromMutationPayload(result.data);
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
        .select(STUDENT_FEEDBACK_LIST_COLUMNS)
        .eq("organization_id", organization)
        .eq("student_profile_id", student)
        .eq("status", "returned")
        .order("updated_at", { ascending: false })
        .order("id", { ascending: true })
        .limit(INITIAL_OPERATIONS_LIMITS.studentFeedback + 1);
    if (result.error) return { status: "service_unavailable", error: result.error.message };
    if ((result.data?.length || 0) > INITIAL_OPERATIONS_LIMITS.studentFeedback) {
        return { status: "service_unavailable", error: INITIAL_CAPACITY_EXCEEDED_ERROR };
    }
    return {
        status: "loaded",
        items: (result.data || []).flatMap(row => {
            const item = feedbackSummaryEnvelopeFromRow(row, organization, student);
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
