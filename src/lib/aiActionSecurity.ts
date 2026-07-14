import { createHash } from "node:crypto";
import { isSameOriginServerActionRequest, SERVER_ACTION_ORIGIN_ERROR } from "./serverActionSecurity";
import { parseSignedTeacherSessionCookie } from "./teacherServerSession";

export const AI_ACTION_UNAUTHORIZED_ERROR = "교사 로그인이 필요한 기능입니다. 다시 로그인해주세요.";
export const AI_ACTION_RATE_LIMIT_ERROR = "AI 분석 요청이 많습니다. 잠시 후 다시 시도해주세요.";
export const AI_ACTION_MAX_REQUESTS = 6;
export const AI_ACTION_WINDOW_MS = 60 * 1000;

export interface AiActionRateLimitState {
    count: number;
    windowStartedAt: number;
}

export interface AiActionRateLimitStatus {
    allowed: boolean;
    retryAfterMs: number;
}

export interface AiActionAuthorizationStatus {
    allowed: boolean;
    error?: string;
    retryAfterMs?: number;
}

export type AiActionRateLimitStore = Map<string, AiActionRateLimitState>;

const defaultAiActionRateLimitStore: AiActionRateLimitStore = new Map();

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function hash(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
}

export function buildAiActionRateLimitKey(
    teacherId: unknown,
    clientFingerprint: unknown,
): string {
    const normalizedTeacher = clean(teacherId).toLowerCase() || "unknown-teacher";
    const normalizedClient = clean(clientFingerprint).toLowerCase() || "unknown-client";
    return `ai-answer:${hash(`${normalizedTeacher}:${normalizedClient}`)}`;
}

export function consumeAiActionRateLimit(
    key: string,
    store: AiActionRateLimitStore = defaultAiActionRateLimitStore,
    now = Date.now(),
): AiActionRateLimitStatus {
    const current = store.get(key);
    if (!current || now - current.windowStartedAt >= AI_ACTION_WINDOW_MS) {
        store.set(key, { count: 1, windowStartedAt: now });
        return { allowed: true, retryAfterMs: 0 };
    }

    if (current.count >= AI_ACTION_MAX_REQUESTS) {
        return {
            allowed: false,
            retryAfterMs: Math.max(0, AI_ACTION_WINDOW_MS - (now - current.windowStartedAt)),
        };
    }

    store.set(key, { ...current, count: current.count + 1 });
    return { allowed: true, retryAfterMs: 0 };
}

function clientFingerprintFromHeaders(headerStore: Headers): string {
    return headerStore.get("x-forwarded-for")?.split(",")[0]?.trim()
        || headerStore.get("x-real-ip")?.trim()
        || headerStore.get("user-agent")?.trim()
        || "unknown-client";
}

export function authorizeTeacherAiActionRequest(
    headerStore: Headers,
    rawSessionCookie: string | null | undefined,
    env: Record<string, string | undefined> = process.env,
    store: AiActionRateLimitStore = defaultAiActionRateLimitStore,
    now = Date.now(),
): AiActionAuthorizationStatus {
    if (!isSameOriginServerActionRequest(headerStore)) {
        return { allowed: false, error: SERVER_ACTION_ORIGIN_ERROR };
    }

    const session = parseSignedTeacherSessionCookie(rawSessionCookie, env, now);
    if (!session) {
        return { allowed: false, error: AI_ACTION_UNAUTHORIZED_ERROR };
    }

    const limitKey = buildAiActionRateLimitKey(
        session.teacherId || session.email || session.displayName,
        clientFingerprintFromHeaders(headerStore),
    );
    const rateLimit = consumeAiActionRateLimit(limitKey, store, now);
    if (!rateLimit.allowed) {
        return {
            allowed: false,
            error: AI_ACTION_RATE_LIMIT_ERROR,
            retryAfterMs: rateLimit.retryAfterMs,
        };
    }

    return { allowed: true };
}
