import type {
    Attempt,
    AttemptFeedback,
    FeedbackDeliveryReceipt,
    FeedbackDownloadPolicy,
    FeedbackMarkup,
    PdfDrawings,
    QuestionFeedbackComment,
} from "@/types/omr";
import { loadJsonRecord, saveJsonRecord } from "@/utils/blobStore";
import {
    getSupabaseConfig,
    isSupabaseConfigured,
    type PersistenceResult,
} from "@/lib/omrPersistence";
import {
    readActiveWorkspaceContext,
    workspaceBootstrapRows,
    type WorkspaceContext,
} from "@/lib/workspaceContext";

const FEEDBACK_KEY = "omr_attempt_feedback";

export interface SupabaseAttemptFeedbackRow {
    id: string;
    organization_id: string;
    attempt_id: string;
    exam_id: string;
    student_profile_id: string | null;
    teacher_user_id: string | null;
    status: AttemptFeedback["status"];
    summary: string | null;
    question_comments: QuestionFeedbackComment[];
    markup: FeedbackMarkup | null;
    markup_drawings?: PdfDrawings | null;
    download_policy: FeedbackDownloadPolicy;
    notification_status: FeedbackDeliveryReceipt["notificationStatus"];
    notification_channel: FeedbackDeliveryReceipt["notificationChannel"];
    notified_at: string | null;
    first_opened_at: string | null;
    last_opened_at: string | null;
    open_count: number;
    returned_at: string | null;
    payload: AttemptFeedback;
    created_at: string;
    updated_at: string;
}

interface SupabaseQueryResult<T> {
    data: T | null;
    error: { message?: string } | null;
}

type SupabaseSelectQuery = {
    eq(column: string, value: string): SupabaseSelectQuery;
    maybeSingle(): Promise<SupabaseQueryResult<unknown>>;
    order(column: string, options?: { ascending?: boolean }): Promise<SupabaseQueryResult<unknown[]>>;
};

type SupabaseClientLike = {
    from(table: string): {
        select(columns?: string): SupabaseSelectQuery;
        upsert(row: unknown): Promise<SupabaseQueryResult<unknown>>;
    };
};

let supabaseClientPromise: Promise<SupabaseClientLike | null> | null = null;

export const DEFAULT_FEEDBACK_DOWNLOAD_POLICY: FeedbackDownloadPolicy = {
    allowStudentDownload: false,
    allowAnnotatedPdfDownload: false,
    watermarkStudentName: true,
};

export const DEFAULT_FEEDBACK_DELIVERY: FeedbackDeliveryReceipt = {
    notificationStatus: "not_queued",
    notificationChannel: "in_app",
    openCount: 0,
};

function hasBrowserStorage(): boolean {
    return typeof window !== "undefined" && !!window.localStorage;
}

function getBrowserStorage(): Storage | null {
    return hasBrowserStorage() ? window.localStorage : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function scopedValue(value: unknown): string | null {
    return stringValue(value) || null;
}

function numberValue(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanValue(value: unknown, fallback = false): boolean {
    return typeof value === "boolean" ? value : fallback;
}

function isoValue(value: unknown): string | undefined {
    const text = stringValue(value);
    if (!text) return undefined;
    const time = Date.parse(text);
    return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function readJsonArray(raw: string | null): unknown[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function normalizePdfDrawings(value: unknown): PdfDrawings | null {
    if (!isRecord(value)) return null;
    const drawings: PdfDrawings = {};
    for (const [page, paths] of Object.entries(value)) {
        const pageNumber = Number(page);
        if (!Number.isFinite(pageNumber) || !Array.isArray(paths)) continue;
        const normalizedPaths = paths.filter((path): path is string => typeof path === "string" && path.length > 0);
        if (normalizedPaths.length > 0) drawings[pageNumber] = normalizedPaths;
    }
    return Object.keys(drawings).length > 0 ? drawings : null;
}

function hasDrawings(drawings?: PdfDrawings): boolean {
    return !!drawings && Object.values(drawings).some(paths => paths.length > 0);
}

function drawingPageCount(drawings?: PdfDrawings): number {
    if (!drawings) return 0;
    return Object.values(drawings).filter(paths => paths.length > 0).length;
}

function drawingStrokeCount(drawings?: PdfDrawings): number {
    if (!drawings) return 0;
    return Object.values(drawings).reduce((sum, paths) => sum + paths.length, 0);
}

export function mergePdfDrawings(...layers: Array<PdfDrawings | null | undefined>): PdfDrawings {
    const merged: PdfDrawings = {};
    for (const layer of layers) {
        if (!layer) continue;
        for (const [page, paths] of Object.entries(layer)) {
            if (!paths.length) continue;
            const pageNumber = Number(page);
            if (!Number.isFinite(pageNumber)) continue;
            merged[pageNumber] = [...(merged[pageNumber] || []), ...paths];
        }
    }
    return merged;
}

export function normalizeFeedbackDownloadPolicy(value: unknown): FeedbackDownloadPolicy {
    if (!isRecord(value)) return { ...DEFAULT_FEEDBACK_DOWNLOAD_POLICY };
    return {
        allowStudentDownload: booleanValue(value.allowStudentDownload),
        allowAnnotatedPdfDownload: booleanValue(value.allowAnnotatedPdfDownload),
        expiresAt: isoValue(value.expiresAt),
        watermarkStudentName: booleanValue(value.watermarkStudentName, true),
    };
}

export function normalizeFeedbackDelivery(value: unknown): FeedbackDeliveryReceipt {
    if (!isRecord(value)) return { ...DEFAULT_FEEDBACK_DELIVERY };
    const notificationStatus = stringValue(value.notificationStatus);
    const notificationChannel = stringValue(value.notificationChannel);
    return {
        notificationStatus: notificationStatus === "queued" || notificationStatus === "sent" || notificationStatus === "failed"
            ? notificationStatus
            : "not_queued",
        notificationChannel: notificationChannel === "kakao_candidate" ? "kakao_candidate" : "in_app",
        notifiedAt: isoValue(value.notifiedAt),
        firstOpenedAt: isoValue(value.firstOpenedAt),
        lastOpenedAt: isoValue(value.lastOpenedAt),
        openCount: Math.max(0, Math.floor(numberValue(value.openCount) || 0)),
    };
}

function normalizeQuestionComment(value: unknown): QuestionFeedbackComment | null {
    if (!isRecord(value)) return null;
    const questionId = numberValue(value.questionId);
    const questionNumber = numberValue(value.questionNumber);
    const body = stringValue(value.body);
    if (questionId === undefined || questionNumber === undefined || !body) return null;
    const visibility = value.visibility === "teacher_only" ? "teacher_only" : "student_visible";
    return {
        id: stringValue(value.id) || `comment:${questionId}:${Date.now()}`,
        questionId,
        questionNumber,
        body,
        visibility,
    };
}

function normalizeFeedbackMarkup(value: unknown): FeedbackMarkup | undefined {
    if (!isRecord(value)) return undefined;
    const pageCount = Math.max(0, Math.floor(numberValue(value.pageCount) || 0));
    const strokeCount = Math.max(0, Math.floor(numberValue(value.strokeCount) || 0));
    const storage = value.storage === "supabase_storage" ? "supabase_storage" : "indexeddb";
    const strokesRef = isRecord(value.strokesRef) && value.strokesRef.store === "indexeddb" && typeof value.strokesRef.key === "string"
        ? {
            store: "indexeddb" as const,
            key: value.strokesRef.key,
            name: stringValue(value.strokesRef.name),
            mimeType: stringValue(value.strokesRef.mimeType),
            size: numberValue(value.strokesRef.size),
            updatedAt: isoValue(value.strokesRef.updatedAt),
        }
        : undefined;

    return {
        schemaVersion: 1,
        strokesRef,
        pageCount,
        strokeCount,
        storage,
    };
}

export function sanitizeAttemptFeedbackPayload(value: unknown): AttemptFeedback | null {
    if (!isRecord(value)) return null;
    const id = stringValue(value.id);
    const attemptId = stringValue(value.attemptId);
    const examId = stringValue(value.examId);
    const createdAt = isoValue(value.createdAt);
    const updatedAt = isoValue(value.updatedAt);
    if (!id || !attemptId || !examId || !createdAt || !updatedAt) return null;

    const status = value.status === "returned" || value.status === "archived" ? value.status : "draft";
    const questionComments = Array.isArray(value.questionComments)
        ? value.questionComments.map(normalizeQuestionComment).filter((item): item is QuestionFeedbackComment => !!item)
        : [];

    return {
        id,
        attemptId,
        examId,
        organizationId: stringValue(value.organizationId),
        studentProfileId: stringValue(value.studentProfileId),
        teacherUserId: stringValue(value.teacherUserId),
        status,
        summary: stringValue(value.summary),
        questionComments,
        markup: normalizeFeedbackMarkup(value.markup),
        downloadPolicy: normalizeFeedbackDownloadPolicy(value.downloadPolicy),
        delivery: normalizeFeedbackDelivery(value.delivery),
        returnedAt: isoValue(value.returnedAt),
        createdAt,
        updatedAt,
    };
}

export function createAttemptFeedbackDraft(
    attempt: Pick<Attempt, "id" | "examId" | "organizationId" | "studentProfileId" | "studentId">,
    now = new Date().toISOString(),
): AttemptFeedback {
    return {
        id: `feedback:${attempt.id}`,
        attemptId: attempt.id,
        examId: attempt.examId,
        organizationId: attempt.organizationId,
        studentProfileId: attempt.studentProfileId || attempt.studentId,
        status: "draft",
        questionComments: [],
        downloadPolicy: { ...DEFAULT_FEEDBACK_DOWNLOAD_POLICY },
        delivery: { ...DEFAULT_FEEDBACK_DELIVERY },
        createdAt: now,
        updatedAt: now,
    };
}

function activePersistenceContext(): WorkspaceContext {
    return readActiveWorkspaceContext();
}

function feedbackWithPersistenceContext(
    feedback: AttemptFeedback,
    context = activePersistenceContext(),
): AttemptFeedback {
    const organizationId = scopedValue(feedback.organizationId) || context.organizationId;
    const teacherUserId = scopedValue(feedback.teacherUserId) || scopedValue(context.actorUserId) || undefined;
    return {
        ...feedback,
        organizationId,
        ...(teacherUserId ? { teacherUserId } : {}),
    };
}

export function feedbackToSupabaseRow(
    feedback: AttemptFeedback,
    context = activePersistenceContext(),
    markupDrawings?: PdfDrawings | null,
): SupabaseAttemptFeedbackRow {
    const scopedFeedback = feedbackWithPersistenceContext(feedback, context);
    const normalized = sanitizeAttemptFeedbackPayload(scopedFeedback);
    if (!normalized) throw new Error("Invalid feedback payload");

    const downloadPolicy = normalizeFeedbackDownloadPolicy(normalized.downloadPolicy);
    const delivery = normalizeFeedbackDelivery(normalized.delivery);
    const row: SupabaseAttemptFeedbackRow = {
        id: normalized.id,
        organization_id: scopedValue(normalized.organizationId) || context.organizationId,
        attempt_id: normalized.attemptId,
        exam_id: normalized.examId,
        student_profile_id: scopedValue(normalized.studentProfileId),
        teacher_user_id: scopedValue(normalized.teacherUserId),
        status: normalized.status,
        summary: scopedValue(normalized.summary),
        question_comments: normalized.questionComments,
        markup: normalized.markup || null,
        download_policy: downloadPolicy,
        notification_status: delivery.notificationStatus,
        notification_channel: delivery.notificationChannel,
        notified_at: delivery.notifiedAt || null,
        first_opened_at: delivery.firstOpenedAt || null,
        last_opened_at: delivery.lastOpenedAt || null,
        open_count: delivery.openCount,
        returned_at: normalized.returnedAt || null,
        payload: {
            ...normalized,
            organizationId: scopedValue(normalized.organizationId) || context.organizationId,
            downloadPolicy,
            delivery,
        },
        created_at: normalized.createdAt,
        updated_at: normalized.updatedAt,
    };

    if (markupDrawings !== undefined) {
        row.markup_drawings = normalizePdfDrawings(markupDrawings) || null;
    }

    return row;
}

export function feedbackFromSupabaseRow(row: SupabaseAttemptFeedbackRow | { payload: AttemptFeedback }): AttemptFeedback {
    if (!("organization_id" in row)) {
        const feedback = sanitizeAttemptFeedbackPayload(row.payload);
        if (!feedback) throw new Error("Invalid feedback payload");
        return feedback;
    }

    const payload = sanitizeAttemptFeedbackPayload(row.payload);
    const fallback = sanitizeAttemptFeedbackPayload({
        id: row.id,
        attemptId: row.attempt_id,
        examId: row.exam_id,
        organizationId: row.organization_id,
        studentProfileId: row.student_profile_id || undefined,
        teacherUserId: row.teacher_user_id || undefined,
        status: row.status,
        summary: row.summary || undefined,
        questionComments: row.question_comments,
        markup: row.markup || undefined,
        downloadPolicy: row.download_policy,
        delivery: {
            notificationStatus: row.notification_status,
            notificationChannel: row.notification_channel,
            notifiedAt: row.notified_at || undefined,
            firstOpenedAt: row.first_opened_at || undefined,
            lastOpenedAt: row.last_opened_at || undefined,
            openCount: row.open_count,
        },
        returnedAt: row.returned_at || undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    });
    const feedback = payload || fallback;
    if (!feedback) throw new Error("Invalid feedback row");

    return {
        ...feedback,
        organizationId: row.organization_id || feedback.organizationId,
        studentProfileId: row.student_profile_id || feedback.studentProfileId,
        teacherUserId: row.teacher_user_id || feedback.teacherUserId,
        status: row.status || feedback.status,
        summary: row.summary || feedback.summary,
        questionComments: Array.isArray(row.question_comments) ? row.question_comments : feedback.questionComments,
        markup: row.markup || feedback.markup,
        downloadPolicy: normalizeFeedbackDownloadPolicy(row.download_policy || feedback.downloadPolicy),
        delivery: normalizeFeedbackDelivery({
            ...feedback.delivery,
            notificationStatus: row.notification_status,
            notificationChannel: row.notification_channel,
            notifiedAt: row.notified_at || undefined,
            firstOpenedAt: row.first_opened_at || undefined,
            lastOpenedAt: row.last_opened_at || undefined,
            openCount: row.open_count,
        }),
        returnedAt: row.returned_at || feedback.returnedAt,
        createdAt: row.created_at || feedback.createdAt,
        updatedAt: row.updated_at || feedback.updatedAt,
    };
}

async function getSupabaseClient(): Promise<SupabaseClientLike | null> {
    const config = getSupabaseConfig();
    if (!config) return null;
    if (supabaseClientPromise) return supabaseClientPromise;

    supabaseClientPromise = import("@supabase/supabase-js")
        .then((supabaseModule: unknown) => {
            const { createClient } = supabaseModule as {
                createClient: (url: string, key: string, options: unknown) => SupabaseClientLike;
            };

            return createClient(config.url, config.publishableKey, {
                auth: {
                    persistSession: false,
                    autoRefreshToken: false,
                },
            });
        })
        .catch(error => {
            console.warn("Supabase feedback client unavailable", error);
            return null;
        });

    return supabaseClientPromise;
}

async function getAvailableSupabaseClient(): Promise<SupabaseClientLike | null> {
    const client = await getSupabaseClient();
    if (!client && isSupabaseConfigured()) {
        throw new Error("Supabase client unavailable");
    }
    return client;
}

async function upsertRemoteWorkspaceBootstrap(
    client: SupabaseClientLike,
    context: WorkspaceContext,
): Promise<void> {
    const rows = workspaceBootstrapRows(context);
    const organizationResult = await client.from("omr_organizations").upsert(rows.organization);
    if (organizationResult.error) {
        throw new Error(organizationResult.error.message || "Failed to bootstrap Supabase organization");
    }

    if (rows.userProfile) {
        const userResult = await client.from("omr_user_profiles").upsert(rows.userProfile);
        if (userResult.error) {
            throw new Error(userResult.error.message || "Failed to bootstrap Supabase user profile");
        }
    }

    if (rows.member) {
        const memberResult = await client.from("omr_organization_members").upsert(rows.member);
        if (memberResult.error) {
            throw new Error(memberResult.error.message || "Failed to bootstrap Supabase organization member");
        }
    }

    if (rows.teacherProfile) {
        const teacherResult = await client.from("omr_teacher_profiles").upsert(rows.teacherProfile);
        if (teacherResult.error) {
            throw new Error(teacherResult.error.message || "Failed to bootstrap Supabase teacher profile");
        }
    }
}

function errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (error && typeof error === "object" && "message" in error) {
        return String((error as { message?: unknown }).message || "Unknown Supabase error");
    }
    return "Unknown Supabase error";
}

function feedbackActivityTime(feedback: AttemptFeedback): number {
    return Date.parse(feedback.updatedAt || feedback.returnedAt || feedback.createdAt || "") || 0;
}

function newestFeedback(first: AttemptFeedback | null, second: AttemptFeedback | null): AttemptFeedback | null {
    if (!first) return second;
    if (!second) return first;
    return feedbackActivityTime(second) > feedbackActivityTime(first) ? second : first;
}

function mergeFeedbackItems(localItems: AttemptFeedback[], remoteItems: AttemptFeedback[]): AttemptFeedback[] {
    const byId = new Map<string, AttemptFeedback>();
    for (const item of [...localItems, ...remoteItems]) {
        const previous = byId.get(item.id);
        if (!previous || feedbackActivityTime(item) > feedbackActivityTime(previous)) {
            byId.set(item.id, item);
        }
    }
    return Array.from(byId.values()).sort((a, b) => feedbackActivityTime(b) - feedbackActivityTime(a));
}

async function hydrateRemoteFeedbackRow(row: SupabaseAttemptFeedbackRow): Promise<AttemptFeedback> {
    const feedback = feedbackFromSupabaseRow(row);
    const drawings = normalizePdfDrawings(row.markup_drawings);
    if (!drawings) return feedback;
    return withMarkupRef(feedback, drawings);
}

async function fetchRemoteFeedbackById(id: string): Promise<AttemptFeedback | null> {
    const client = await getAvailableSupabaseClient();
    if (!client) return null;

    const { data, error } = await client
        .from("omr_attempt_feedback")
        .select("*")
        .eq("id", id)
        .maybeSingle();

    if (error) throw new Error(error.message || "Failed to load feedback from Supabase");
    if (!data) return null;
    return hydrateRemoteFeedbackRow(data as SupabaseAttemptFeedbackRow);
}

async function fetchRemoteFeedbackByAttemptId(attemptId: string): Promise<AttemptFeedback | null> {
    const client = await getAvailableSupabaseClient();
    if (!client) return null;

    const { data, error } = await client
        .from("omr_attempt_feedback")
        .select("*")
        .eq("attempt_id", attemptId)
        .maybeSingle();

    if (error) throw new Error(error.message || "Failed to load feedback from Supabase");
    if (!data) return null;
    return hydrateRemoteFeedbackRow(data as SupabaseAttemptFeedbackRow);
}

async function fetchRemoteReturnedFeedbackForStudent(studentProfileId: string): Promise<AttemptFeedback[]> {
    const client = await getAvailableSupabaseClient();
    if (!client) return [];

    const { data, error } = await client
        .from("omr_attempt_feedback")
        .select("*")
        .eq("student_profile_id", studentProfileId)
        .eq("status", "returned")
        .order("updated_at", { ascending: false });

    if (error) throw new Error(error.message || "Failed to load returned feedback from Supabase");
    const rows = (data || []) as SupabaseAttemptFeedbackRow[];
    const hydrated = await Promise.all(rows.map(row => hydrateRemoteFeedbackRow(row).catch(() => null)));
    return hydrated.filter((feedback): feedback is AttemptFeedback => !!feedback);
}

async function upsertRemoteFeedback(feedback: AttemptFeedback, markupDrawings?: PdfDrawings | null): Promise<void> {
    const client = await getAvailableSupabaseClient();
    if (!client) return;
    const context = activePersistenceContext();
    const scopedFeedback = feedbackWithPersistenceContext(feedback, context);
    await upsertRemoteWorkspaceBootstrap(client, context);

    const { error } = await client
        .from("omr_attempt_feedback")
        .upsert(feedbackToSupabaseRow(scopedFeedback, context, markupDrawings));
    if (error) throw new Error(error.message || "Failed to save feedback to Supabase");
}

export function readLocalAttemptFeedback(storage: Pick<Storage, "getItem"> | null = getBrowserStorage()): AttemptFeedback[] {
    if (!storage) return [];
    return readJsonArray(storage.getItem(FEEDBACK_KEY))
        .map(sanitizeAttemptFeedbackPayload)
        .filter((feedback): feedback is AttemptFeedback => !!feedback)
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
}

export function saveLocalAttemptFeedback(
    feedback: AttemptFeedback,
    storage: Pick<Storage, "getItem" | "setItem"> | null = getBrowserStorage(),
): boolean {
    if (!storage) return false;
    const normalized = sanitizeAttemptFeedbackPayload(feedback);
    if (!normalized) return false;
    try {
        const next = readLocalAttemptFeedback(storage).filter(item => item.id !== normalized.id);
        next.push(normalized);
        storage.setItem(FEEDBACK_KEY, JSON.stringify(next.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))));
        return true;
    } catch {
        return false;
    }
}

export function loadLocalAttemptFeedback(
    attemptId: string,
    storage: Pick<Storage, "getItem"> | null = getBrowserStorage(),
): AttemptFeedback | null {
    return readLocalAttemptFeedback(storage)
        .find(feedback => feedback.attemptId === attemptId && feedback.status !== "archived") || null;
}

export function loadLocalReturnedAttemptFeedback(
    attemptId: string,
    storage: Pick<Storage, "getItem"> | null = getBrowserStorage(),
): AttemptFeedback | null {
    return readLocalAttemptFeedback(storage)
        .find(feedback => feedback.attemptId === attemptId && feedback.status === "returned") || null;
}

async function withMarkupRef(feedback: AttemptFeedback, drawings?: PdfDrawings): Promise<AttemptFeedback> {
    if (!hasDrawings(drawings)) return feedback;
    const ref = await saveJsonRecord(`feedback:${feedback.id}:markup`, drawings);
    if (!ref) return feedback;
    return {
        ...feedback,
        markup: {
            schemaVersion: 1,
            strokesRef: ref,
            pageCount: drawingPageCount(drawings),
            strokeCount: drawingStrokeCount(drawings),
            storage: "indexeddb",
        },
    };
}

export async function loadAttemptFeedback(attemptId: string): Promise<AttemptFeedback | null> {
    const local = loadLocalAttemptFeedback(attemptId);
    if (!isSupabaseConfigured()) return local;

    try {
        const remote = await fetchRemoteFeedbackByAttemptId(attemptId);
        if (remote) saveLocalAttemptFeedback(remote);
        if (local && (!remote || feedbackActivityTime(local) > feedbackActivityTime(remote))) {
            void upsertRemoteFeedback(local).catch(error => console.warn("Failed to sync local feedback", error));
        }
        return newestFeedback(local, remote);
    } catch (error) {
        console.warn("Failed to load remote feedback", error);
        return local;
    }
}

export async function loadReturnedAttemptFeedback(attemptId: string): Promise<AttemptFeedback | null> {
    const local = loadLocalReturnedAttemptFeedback(attemptId);
    if (!isSupabaseConfigured()) return local;

    try {
        const remote = await fetchRemoteFeedbackByAttemptId(attemptId);
        const returnedRemote = remote?.status === "returned" ? remote : null;
        if (returnedRemote) saveLocalAttemptFeedback(returnedRemote);
        return newestFeedback(local, returnedRemote);
    } catch (error) {
        console.warn("Failed to load remote returned feedback", error);
        return local;
    }
}

export async function loadReturnedFeedbackForStudent(studentProfileId: string): Promise<AttemptFeedback[]> {
    const normalizedStudentId = scopedValue(studentProfileId);
    if (!normalizedStudentId) return [];

    const local = readLocalAttemptFeedback()
        .filter(feedback => feedback.status === "returned" && feedback.studentProfileId === normalizedStudentId);
    if (!isSupabaseConfigured()) return local;

    try {
        const remote = await fetchRemoteReturnedFeedbackForStudent(normalizedStudentId);
        for (const feedback of remote) saveLocalAttemptFeedback(feedback);
        return mergeFeedbackItems(local, remote);
    } catch (error) {
        console.warn("Failed to load remote student feedback", error);
        return local;
    }
}

export async function saveAttemptFeedbackDraft(
    feedback: AttemptFeedback,
    markup?: PdfDrawings,
): Promise<PersistenceResult> {
    const now = new Date().toISOString();
    const next = await withMarkupRef({
        ...feedback,
        status: "draft",
        downloadPolicy: normalizeFeedbackDownloadPolicy(feedback.downloadPolicy),
        delivery: normalizeFeedbackDelivery(feedback.delivery),
        returnedAt: undefined,
        updatedAt: now,
    }, markup);
    const localSaved = saveLocalAttemptFeedback(next);
    if (!isSupabaseConfigured()) return { localSaved, remoteSaved: false };

    try {
        await upsertRemoteFeedback(next, markup);
        return { localSaved, remoteSaved: true };
    } catch (error) {
        return { localSaved, remoteSaved: false, remoteError: errorMessage(error) };
    }
}

export async function returnAttemptFeedback(feedbackId: string): Promise<PersistenceResult> {
    const current = readLocalAttemptFeedback().find(feedback => feedback.id === feedbackId)
        || (isSupabaseConfigured() ? await fetchRemoteFeedbackById(feedbackId).catch(() => null) : null);
    if (!current) return { localSaved: false, remoteSaved: false, remoteError: "Feedback draft not found" };
    const now = new Date().toISOString();
    const next: AttemptFeedback = {
        ...current,
        status: "returned",
        returnedAt: current.returnedAt || now,
        updatedAt: now,
        delivery: {
            ...normalizeFeedbackDelivery(current.delivery),
            notificationStatus: "queued",
            notificationChannel: "in_app",
            notifiedAt: current.delivery.notifiedAt || now,
        },
    };
    const localSaved = saveLocalAttemptFeedback(next);
    if (!isSupabaseConfigured()) return { localSaved, remoteSaved: false };

    try {
        await upsertRemoteFeedback(next, await loadFeedbackMarkupDrawings(next));
        return { localSaved, remoteSaved: true };
    } catch (error) {
        return { localSaved, remoteSaved: false, remoteError: errorMessage(error) };
    }
}

export async function markFeedbackOpened(feedbackId: string): Promise<PersistenceResult> {
    const current = readLocalAttemptFeedback().find(feedback => feedback.id === feedbackId)
        || (isSupabaseConfigured() ? await fetchRemoteFeedbackById(feedbackId).catch(() => null) : null);
    if (!current || current.status !== "returned") {
        return { localSaved: false, remoteSaved: false, remoteError: "Returned feedback not found" };
    }
    const now = new Date().toISOString();
    const delivery = normalizeFeedbackDelivery(current.delivery);
    const next: AttemptFeedback = {
        ...current,
        updatedAt: now,
        delivery: {
            ...delivery,
            notificationStatus: "sent",
            firstOpenedAt: delivery.firstOpenedAt || now,
            lastOpenedAt: now,
            openCount: delivery.openCount + 1,
        },
    };
    const localSaved = saveLocalAttemptFeedback(next);
    if (!isSupabaseConfigured()) return { localSaved, remoteSaved: false };

    try {
        await upsertRemoteFeedback(next);
        return { localSaved, remoteSaved: true };
    } catch (error) {
        return { localSaved, remoteSaved: false, remoteError: errorMessage(error) };
    }
}

export async function updateFeedbackDownloadPolicy(
    feedbackId: string,
    policy: FeedbackDownloadPolicy,
): Promise<PersistenceResult> {
    const current = readLocalAttemptFeedback().find(feedback => feedback.id === feedbackId)
        || (isSupabaseConfigured() ? await fetchRemoteFeedbackById(feedbackId).catch(() => null) : null);
    if (!current) return { localSaved: false, remoteSaved: false, remoteError: "Feedback not found" };
    const next: AttemptFeedback = {
        ...current,
        downloadPolicy: normalizeFeedbackDownloadPolicy(policy),
        updatedAt: new Date().toISOString(),
    };
    const localSaved = saveLocalAttemptFeedback(next);
    if (!isSupabaseConfigured()) return { localSaved, remoteSaved: false };

    try {
        await upsertRemoteFeedback(next);
        return { localSaved, remoteSaved: true };
    } catch (error) {
        return { localSaved, remoteSaved: false, remoteError: errorMessage(error) };
    }
}

export function canDownloadReturnedFeedback(feedback: AttemptFeedback | null | undefined, now = new Date()): boolean {
    if (!feedback || feedback.status !== "returned") return false;
    if (!feedback.downloadPolicy.allowStudentDownload) return false;
    if (!feedback.downloadPolicy.expiresAt) return true;
    return Date.parse(feedback.downloadPolicy.expiresAt) >= now.getTime();
}

export async function createReturnedFeedbackDownloadUrl(feedbackId: string): Promise<{ url?: string; error?: string }> {
    const feedback = readLocalAttemptFeedback().find(item => item.id === feedbackId);
    if (!feedback || !canDownloadReturnedFeedback(feedback)) return { error: "Download is not allowed for this feedback" };
    const blob = new Blob([buildFeedbackDownloadText(feedback)], { type: "text/plain;charset=utf-8" });
    return { url: URL.createObjectURL(blob) };
}

export function buildFeedbackDownloadText(feedback: AttemptFeedback): string {
    const comments = feedback.questionComments
        .filter(comment => comment.visibility === "student_visible")
        .map(comment => `${comment.questionNumber}. ${comment.body}`)
        .join("\n");
    return [
        "OMR Feedback",
        `Attempt: ${feedback.attemptId}`,
        `Returned: ${feedback.returnedAt || ""}`,
        "",
        feedback.summary || "",
        "",
        comments,
    ].join("\n").trim();
}

export async function loadFeedbackMarkupDrawings(feedback: AttemptFeedback | null | undefined): Promise<PdfDrawings | null> {
    return loadJsonRecord<PdfDrawings>(feedback?.markup?.strokesRef);
}
