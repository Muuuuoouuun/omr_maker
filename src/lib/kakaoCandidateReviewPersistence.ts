import type { KakaoNotificationCandidate } from "@/lib/kakaoNotificationQueue";
import {
    buildKakaoCandidateMessagePreview,
    setKakaoCandidateReview,
    type KakaoCandidateReviewMap,
    type KakaoCandidateReviewRecord,
    type KakaoCandidateReviewStatus,
} from "@/lib/kakaoCandidateReview";

type Env = Record<string, string | undefined>;

export interface KakaoCandidateReviewPersistenceResult {
    localSaved: boolean;
    remoteSaved: boolean;
    reviews: KakaoCandidateReviewMap;
    record: KakaoCandidateReviewRecord;
    remoteError?: string;
}

export const KAKAO_DISPATCH_LOG_STORAGE_KEY = "omr_kakao_dispatch_logs";

export type KakaoDispatchStatus = "queued" | "sent" | "failed" | "cancelled" | "skipped";

export interface KakaoDispatchLog {
    id: string;
    reviewId: string;
    examId: string;
    channel: "kakao";
    provider: "simulation" | string;
    status: KakaoDispatchStatus;
    targetCount: number;
    studentIds: string[];
    studentNames: string[];
    messagePreview: string;
    providerMessageId?: string;
    errorMessage?: string;
    createdAt: string;
    sentAt?: string;
}

export interface KakaoDispatchStatusUpdate {
    now?: Date;
    providerMessageId?: string;
    errorMessage?: string;
}

export interface KakaoDispatchSummary {
    total: number;
    queued: number;
    sent: number;
    failed: number;
    cancelled: number;
    skipped: number;
    latestByReviewId: Record<string, KakaoDispatchLog>;
}

export interface SupabaseKakaoCandidateReviewRow {
    id: string;
    organization_id: string | null;
    exam_id: string;
    candidate_kind: KakaoNotificationCandidate["kind"];
    channel: "kakao";
    status: KakaoCandidateReviewStatus;
    title: string;
    target_count: number;
    student_ids: string[];
    student_names: string[];
    group_names: string[];
    region_names: string[];
    message_preview: string;
    reason: string | null;
    href: string | null;
    payload: {
        candidate: KakaoNotificationCandidate;
        review: KakaoCandidateReviewRecord;
    };
    reviewed_at: string;
    updated_at: string;
}

export interface SupabaseKakaoDispatchLogRow {
    id: string;
    organization_id: string | null;
    review_id: string;
    exam_id: string;
    channel: "kakao";
    provider: string | null;
    status: KakaoDispatchStatus;
    target_count: number;
    student_ids: string[];
    message_preview: string;
    provider_message_id: string | null;
    error_message: string | null;
    payload: {
        candidate: KakaoNotificationCandidate;
        review: KakaoCandidateReviewRecord;
        log: KakaoDispatchLog;
    };
    created_at: string;
    sent_at: string | null;
}

interface SupabaseConfig {
    url: string;
    publishableKey: string;
}

interface SupabaseQueryResult<T> {
    data: T | null;
    error: { message?: string } | null;
}

type SupabaseClientLike = {
    from(table: string): {
        upsert(row: unknown): Promise<SupabaseQueryResult<unknown>>;
    };
};

let supabaseClientPromise: Promise<SupabaseClientLike | null> | null = null;

function getSupabaseConfigFromEnv(env: Env): SupabaseConfig | null {
    const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
    const publishableKey = (
        env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
        env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    )?.trim();

    if (!url || !publishableKey) return null;
    return { url, publishableKey };
}

function getSupabaseConfig(): SupabaseConfig | null {
    return getSupabaseConfigFromEnv(process.env);
}

function isSupabaseConfigured(): boolean {
    return !!getSupabaseConfig();
}

function errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (error && typeof error === "object" && "message" in error) {
        return String((error as { message?: unknown }).message || "Unknown Supabase error");
    }
    return "Unknown Supabase error";
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function cleanStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return Array.from(new Set(value.map(clean).filter(Boolean))).sort((a, b) => a.localeCompare(b, "ko"));
}

function isDispatchStatus(value: unknown): value is KakaoDispatchStatus {
    return value === "queued" || value === "sent" || value === "failed" || value === "cancelled" || value === "skipped";
}

function normalizeDispatchLog(value: unknown): KakaoDispatchLog | null {
    if (!isRecord(value)) return null;
    const id = clean(value.id);
    const reviewId = clean(value.reviewId);
    const examId = clean(value.examId);
    const status = value.status;
    const createdAt = clean(value.createdAt);
    const messagePreview = clean(value.messagePreview);
    if (!id || !reviewId || !examId || !isDispatchStatus(status) || !createdAt || !messagePreview) return null;

    const sentAt = clean(value.sentAt);
    const providerMessageId = clean(value.providerMessageId);
    const errorText = clean(value.errorMessage);

    return {
        id,
        reviewId,
        examId,
        channel: "kakao",
        provider: clean(value.provider) || "simulation",
        status,
        targetCount: Math.max(0, Math.floor(Number(value.targetCount) || 0)),
        studentIds: cleanStringArray(value.studentIds),
        studentNames: cleanStringArray(value.studentNames),
        messagePreview,
        providerMessageId: providerMessageId || undefined,
        errorMessage: errorText || undefined,
        createdAt,
        sentAt: sentAt || undefined,
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
            console.warn("Supabase client unavailable for Kakao candidate reviews", error);
            return null;
        });

    return supabaseClientPromise;
}

export function kakaoCandidateReviewToSupabaseRow(
    record: KakaoCandidateReviewRecord,
    candidate: KakaoNotificationCandidate,
    updatedAt = record.updatedAt,
): SupabaseKakaoCandidateReviewRow {
    return {
        id: record.candidateId,
        organization_id: null,
        exam_id: record.examId,
        candidate_kind: record.kind,
        channel: "kakao",
        status: record.status,
        title: record.title,
        target_count: record.targetCount,
        student_ids: record.studentIds,
        student_names: record.studentNames,
        group_names: candidate.groupNames,
        region_names: candidate.regionNames,
        message_preview: buildKakaoCandidateMessagePreview(candidate),
        reason: candidate.reason || null,
        href: candidate.href || null,
        payload: {
            candidate,
            review: record,
        },
        reviewed_at: record.updatedAt,
        updated_at: updatedAt,
    };
}

export function kakaoCandidateReviewFromSupabaseRow(row: SupabaseKakaoCandidateReviewRow): KakaoCandidateReviewRecord {
    return {
        candidateId: row.id,
        status: row.status,
        channel: "kakao",
        kind: row.candidate_kind,
        examId: row.exam_id,
        title: row.title,
        targetCount: row.target_count,
        studentIds: row.student_ids,
        studentNames: row.student_names,
        updatedAt: row.reviewed_at || row.updated_at,
    };
}

export function parseKakaoDispatchLogs(raw: string | null | undefined): KakaoDispatchLog[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw) as unknown;
        const items = Array.isArray(parsed)
            ? parsed
            : isRecord(parsed)
                ? Object.values(parsed)
                : [];
        return items
            .map(normalizeDispatchLog)
            .filter((item): item is KakaoDispatchLog => !!item)
            .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    } catch {
        return [];
    }
}

export function readKakaoDispatchLogs(storage: Pick<Storage, "getItem">): KakaoDispatchLog[] {
    return parseKakaoDispatchLogs(storage.getItem(KAKAO_DISPATCH_LOG_STORAGE_KEY));
}

export function writeKakaoDispatchLogs(storage: Pick<Storage, "setItem">, logs: KakaoDispatchLog[]): boolean {
    try {
        storage.setItem(KAKAO_DISPATCH_LOG_STORAGE_KEY, JSON.stringify(logs));
        return true;
    } catch {
        return false;
    }
}

export function createKakaoDispatchLog(
    record: KakaoCandidateReviewRecord,
    candidate: KakaoNotificationCandidate,
    status: KakaoDispatchStatus = "queued",
    now = new Date(),
): KakaoDispatchLog {
    const createdAt = now.toISOString();
    return {
        id: `kakao:dispatch:${record.candidateId}:${createdAt}`,
        reviewId: record.candidateId,
        examId: record.examId,
        channel: "kakao",
        provider: "simulation",
        status,
        targetCount: record.targetCount,
        studentIds: record.studentIds,
        studentNames: record.studentNames,
        messagePreview: buildKakaoCandidateMessagePreview(candidate),
        createdAt,
        sentAt: status === "sent" ? createdAt : undefined,
    };
}

export function summarizeKakaoDispatchLogs(
    logs: KakaoDispatchLog[],
    reviewIds: string[] = [],
): KakaoDispatchSummary {
    const reviewIdSet = new Set(reviewIds);
    const scopedLogs = reviewIdSet.size > 0 ? logs.filter(log => reviewIdSet.has(log.reviewId)) : logs;
    const latestByReviewId: Record<string, KakaoDispatchLog> = {};
    for (const log of scopedLogs) {
        const current = latestByReviewId[log.reviewId];
        if (!current || Date.parse(log.createdAt) > Date.parse(current.createdAt)) {
            latestByReviewId[log.reviewId] = log;
        }
    }

    return {
        total: scopedLogs.length,
        queued: scopedLogs.filter(log => log.status === "queued").length,
        sent: scopedLogs.filter(log => log.status === "sent").length,
        failed: scopedLogs.filter(log => log.status === "failed").length,
        cancelled: scopedLogs.filter(log => log.status === "cancelled").length,
        skipped: scopedLogs.filter(log => log.status === "skipped").length,
        latestByReviewId,
    };
}

export function updateKakaoDispatchLogStatus(
    storage: Pick<Storage, "getItem" | "setItem">,
    logId: string,
    status: KakaoDispatchStatus,
    options: KakaoDispatchStatusUpdate = {},
): { logs: KakaoDispatchLog[]; log: KakaoDispatchLog | null } {
    const now = options.now || new Date();
    const logs = readKakaoDispatchLogs(storage);
    const target = logs.find(log => log.id === logId);
    if (!target) return { logs, log: null };

    const updatedAt = now.toISOString();
    const nextLog: KakaoDispatchLog = {
        ...target,
        status,
        providerMessageId: options.providerMessageId || target.providerMessageId,
        errorMessage: status === "failed"
            ? options.errorMessage || target.errorMessage || "시뮬레이션 실패 기록"
            : status === "cancelled"
                ? options.errorMessage || target.errorMessage || "교사가 발송을 취소함"
                : undefined,
        sentAt: status === "sent" ? updatedAt : target.sentAt,
    };
    const nextLogs = logs
        .map(log => log.id === logId ? nextLog : log)
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    writeKakaoDispatchLogs(storage, nextLogs);
    return { logs: nextLogs, log: nextLog };
}

export function kakaoDispatchLogToSupabaseRow(
    log: KakaoDispatchLog,
    record: KakaoCandidateReviewRecord,
    candidate: KakaoNotificationCandidate,
): SupabaseKakaoDispatchLogRow {
    return {
        id: log.id,
        organization_id: null,
        review_id: record.candidateId,
        exam_id: record.examId,
        channel: "kakao",
        provider: log.provider || null,
        status: log.status,
        target_count: log.targetCount,
        student_ids: log.studentIds,
        message_preview: log.messagePreview,
        provider_message_id: log.providerMessageId || null,
        error_message: log.errorMessage || null,
        payload: {
            candidate,
            review: record,
            log,
        },
        created_at: log.createdAt,
        sent_at: log.sentAt || null,
    };
}

export function kakaoDispatchLogFromSupabaseRow(row: SupabaseKakaoDispatchLogRow): KakaoDispatchLog {
    const log = row.payload?.log;
    return {
        id: row.id,
        reviewId: row.review_id,
        examId: row.exam_id,
        channel: "kakao",
        provider: row.provider || log?.provider || "simulation",
        status: row.status,
        targetCount: row.target_count,
        studentIds: row.student_ids,
        studentNames: log?.studentNames || [],
        messagePreview: row.message_preview,
        providerMessageId: row.provider_message_id || undefined,
        errorMessage: row.error_message || undefined,
        createdAt: row.created_at,
        sentAt: row.sent_at || undefined,
    };
}

export async function syncKakaoCandidateReviewRecord(
    record: KakaoCandidateReviewRecord,
    candidate: KakaoNotificationCandidate,
): Promise<{ remoteSaved: boolean; remoteError?: string }> {
    if (!isSupabaseConfigured()) return { remoteSaved: false };

    try {
        const client = await getSupabaseClient();
        if (!client) throw new Error("Supabase client unavailable");
        const { error } = await client
            .from("omr_kakao_candidate_reviews")
            .upsert(kakaoCandidateReviewToSupabaseRow(record, candidate));
        if (error) throw new Error(error.message || "Failed to save Kakao candidate review to Supabase");
        return { remoteSaved: true };
    } catch (error) {
        return { remoteSaved: false, remoteError: errorMessage(error) };
    }
}

export async function syncKakaoDispatchLog(
    log: KakaoDispatchLog,
    record: KakaoCandidateReviewRecord,
    candidate: KakaoNotificationCandidate,
): Promise<{ remoteSaved: boolean; remoteError?: string }> {
    if (!isSupabaseConfigured()) return { remoteSaved: false };

    try {
        const client = await getSupabaseClient();
        if (!client) throw new Error("Supabase client unavailable");
        const { error } = await client
            .from("omr_kakao_dispatch_logs")
            .upsert(kakaoDispatchLogToSupabaseRow(log, record, candidate));
        if (error) throw new Error(error.message || "Failed to save Kakao dispatch log to Supabase");
        return { remoteSaved: true };
    } catch (error) {
        return { remoteSaved: false, remoteError: errorMessage(error) };
    }
}

export async function saveKakaoCandidateReview(
    storage: Pick<Storage, "getItem" | "setItem">,
    candidate: KakaoNotificationCandidate,
    status: KakaoCandidateReviewStatus,
    now = new Date(),
): Promise<KakaoCandidateReviewPersistenceResult> {
    const reviews = setKakaoCandidateReview(storage, candidate, status, now);
    const record = reviews[candidate.id];
    const remote = await syncKakaoCandidateReviewRecord(record, candidate);

    return {
        localSaved: true,
        remoteSaved: remote.remoteSaved,
        remoteError: remote.remoteError,
        reviews,
        record,
    };
}

export async function queueKakaoDispatchSimulation(
    storage: Pick<Storage, "getItem" | "setItem">,
    record: KakaoCandidateReviewRecord,
    candidate: KakaoNotificationCandidate,
    now = new Date(),
): Promise<{
    localSaved: boolean;
    remoteSaved: boolean;
    logs: KakaoDispatchLog[];
    log: KakaoDispatchLog;
    remoteError?: string;
}> {
    const log = createKakaoDispatchLog(record, candidate, "queued", now);
    const logs = [log, ...readKakaoDispatchLogs(storage)].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    writeKakaoDispatchLogs(storage, logs);
    const remote = await syncKakaoDispatchLog(log, record, candidate);

    return {
        localSaved: true,
        remoteSaved: remote.remoteSaved,
        remoteError: remote.remoteError,
        logs,
        log,
    };
}
