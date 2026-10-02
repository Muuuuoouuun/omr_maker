import { createHmac } from "node:crypto";
import { createSupabaseAdminClient, getSupabaseServerConfigFromEnv } from "./supabaseServerAdmin";

export type DurableRateLimitOperation = "check" | "consume" | "failure" | "success" | "refund";

export interface DurableRateLimitPolicy {
    limit: number;
    windowMs: number;
    lockoutMs?: number;
}

export interface DurableRateLimitDecision {
    allowed: boolean;
    retryAfterMs: number;
}

export interface DurableRateLimitRpcClient {
    rpc(name: "omr_consume_rate_limit_v1", params: Record<string, unknown>): Promise<{
        data: unknown;
        error: { message?: string } | null;
    }>;
}

export interface DurableRateLimitInput {
    namespace: string;
    subject: string;
    operation: DurableRateLimitOperation;
    policy: DurableRateLimitPolicy;
}

export interface DurableRateLimitSubjectsInput extends Omit<DurableRateLimitInput, "subject"> {
    subjects: string[];
}

interface InMemoryRateLimitState {
    count: number;
    windowStartedAt: number;
    lockedUntil?: number;
    expiresAt: number;
}

export interface InMemoryDurableRateLimitStore {
    entries: Map<string, InMemoryRateLimitState>;
    maxEntries: number;
}

export interface DurableRateLimitOptions {
    env?: Record<string, string | undefined>;
    client?: DurableRateLimitRpcClient | null;
    store?: InMemoryDurableRateLimitStore;
    now?: number;
}

const LOCAL_HASH_SECRET = "omr-local-rate-limit-fallback-v1";
const FAIL_CLOSED_RETRY_MS = 60_000;
const DEFAULT_LOCAL_MAX_ENTRIES = 4_096;
const defaultLocalStore = createInMemoryDurableRateLimitStore();

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function safePolicy(policy: DurableRateLimitPolicy): DurableRateLimitPolicy | null {
    const limit = Math.floor(policy.limit);
    const windowMs = Math.floor(policy.windowMs);
    const lockoutMs = Math.floor(policy.lockoutMs || 0);
    if (!Number.isFinite(limit) || limit < 1 || limit > 10_000) return null;
    if (!Number.isFinite(windowMs) || windowMs < 1_000 || windowMs > 86_400_000) return null;
    if (!Number.isFinite(lockoutMs) || lockoutMs < 0 || lockoutMs > 604_800_000) return null;
    return { limit, windowMs, lockoutMs };
}

function isProduction(env: Record<string, string | undefined>): boolean {
    return env.NODE_ENV === "production";
}

function retryAfter(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0
        ? Math.min(Math.floor(value), 604_800_000)
        : 0;
}

export function hashRateLimitBucket(secret: string, namespace: string, subject: string): string {
    const key = clean(secret);
    if (!key) throw new Error("OMR_RATE_LIMIT_HASH_SECRET is required");
    return createHmac("sha256", key)
        .update(`${clean(namespace)}\u0000${clean(subject)}`, "utf8")
        .digest("hex");
}

export function createInMemoryDurableRateLimitStore(maxEntries = DEFAULT_LOCAL_MAX_ENTRIES): InMemoryDurableRateLimitStore {
    return {
        entries: new Map(),
        maxEntries: Math.max(1, Math.floor(maxEntries) || DEFAULT_LOCAL_MAX_ENTRIES),
    };
}

function pruneExpired(store: InMemoryDurableRateLimitStore, now: number): void {
    for (const [bucket, state] of store.entries) {
        if (state.expiresAt <= now) store.entries.delete(bucket);
    }
}

function makeRoomForNewBucket(store: InMemoryDurableRateLimitStore): void {
    while (store.entries.size >= store.maxEntries) {
        let oldestBucket: string | undefined;
        let oldestExpiry = Number.POSITIVE_INFINITY;
        for (const [bucket, state] of store.entries) {
            if (state.expiresAt < oldestExpiry) {
                oldestBucket = bucket;
                oldestExpiry = state.expiresAt;
            }
        }
        if (!oldestBucket) return;
        store.entries.delete(oldestBucket);
    }
}

function inMemoryDecision(
    bucket: string,
    operation: DurableRateLimitOperation,
    policy: DurableRateLimitPolicy,
    store: InMemoryDurableRateLimitStore,
    now: number,
): DurableRateLimitDecision {
    pruneExpired(store, now);
    const current = store.entries.get(bucket);
    const inWindow = current && now - current.windowStartedAt < policy.windowMs;
    const state = inWindow ? current : undefined;
    if (current && !state) store.entries.delete(bucket);

    if (operation === "success") {
        store.entries.delete(bucket);
        return { allowed: true, retryAfterMs: 0 };
    }

    if (operation === "refund") {
        if (!state || state.count <= 1) {
            store.entries.delete(bucket);
        } else {
            store.entries.set(bucket, { ...state, count: state.count - 1 });
        }
        return { allowed: true, retryAfterMs: 0 };
    }

    if (state?.lockedUntil && state.lockedUntil > now) {
        return { allowed: false, retryAfterMs: state.lockedUntil - now };
    }

    if (operation === "check") {
        if (state && !policy.lockoutMs && state.count >= policy.limit) {
            return { allowed: false, retryAfterMs: Math.max(0, policy.windowMs - (now - state.windowStartedAt)) };
        }
        return { allowed: true, retryAfterMs: 0 };
    }

    if (operation === "consume") {
        if (state && state.count >= policy.limit) {
            return { allowed: false, retryAfterMs: Math.max(0, policy.windowMs - (now - state.windowStartedAt)) };
        }
        const count = (state?.count || 0) + 1;
        if (!state) makeRoomForNewBucket(store);
        store.entries.set(bucket, {
            count,
            windowStartedAt: state?.windowStartedAt || now,
            expiresAt: (state?.windowStartedAt || now) + policy.windowMs,
        });
        return { allowed: true, retryAfterMs: 0 };
    }

    const count = (state?.count || 0) + 1;
    const lockedUntil = policy.lockoutMs && count >= policy.limit ? now + policy.lockoutMs : undefined;
    if (!state) makeRoomForNewBucket(store);
    store.entries.set(bucket, {
        count,
        windowStartedAt: state?.windowStartedAt || now,
        lockedUntil,
        expiresAt: Math.max((state?.windowStartedAt || now) + policy.windowMs, lockedUntil || 0),
    });
    return { allowed: !lockedUntil, retryAfterMs: lockedUntil ? policy.lockoutMs || 0 : 0 };
}

function rpcDecision(data: unknown): DurableRateLimitDecision | null {
    const payload = Array.isArray(data) ? data[0] : data;
    if (!payload || typeof payload !== "object") return null;
    const value = payload as { allowed?: unknown; retry_after_ms?: unknown };
    if (typeof value.allowed !== "boolean") return null;
    return { allowed: value.allowed, retryAfterMs: retryAfter(value.retry_after_ms) };
}

function configuredRpcClient(env: Record<string, string | undefined>): DurableRateLimitRpcClient | null {
    const config = getSupabaseServerConfigFromEnv(env);
    if (!config) return null;
    return createSupabaseAdminClient(config) as unknown as DurableRateLimitRpcClient;
}

/**
 * Performs one serialized rate-limit transition. Production always uses the
 * service-role RPC; development can use a bounded, process-local fallback.
 */
export async function applyDurableRateLimit(
    input: DurableRateLimitInput,
    options: DurableRateLimitOptions = {},
): Promise<DurableRateLimitDecision> {
    const env = options.env || process.env;
    const policy = safePolicy(input.policy);
    const namespace = clean(input.namespace);
    const subject = clean(input.subject);
    if (!policy || !namespace || !subject) return { allowed: false, retryAfterMs: FAIL_CLOSED_RETRY_MS };

    const secret = clean(env.OMR_RATE_LIMIT_HASH_SECRET);
    const production = isProduction(env);
    if (production && Buffer.byteLength(secret, "utf8") < 32) {
        return { allowed: false, retryAfterMs: FAIL_CLOSED_RETRY_MS };
    }

    const bucket = hashRateLimitBucket(secret || LOCAL_HASH_SECRET, namespace, subject);
    const client = options.client === undefined ? configuredRpcClient(env) : options.client;
    if (client) {
        try {
            const result = await client.rpc("omr_consume_rate_limit_v1", {
                p_bucket_hash: bucket,
                p_operation: input.operation,
                p_limit: policy.limit,
                p_window_seconds: Math.max(1, Math.ceil(policy.windowMs / 1_000)),
                p_lockout_seconds: Math.max(0, Math.ceil((policy.lockoutMs || 0) / 1_000)),
            });
            const decision = result.error ? null : rpcDecision(result.data);
            if (decision) return decision;
        } catch {
            // The caller receives a closed decision in production. Never log a
            // bucket or caller-controlled subject from this boundary.
        }
    }

    if (production) return { allowed: false, retryAfterMs: FAIL_CLOSED_RETRY_MS };
    return inMemoryDecision(bucket, input.operation, policy, options.store || defaultLocalStore, options.now ?? Date.now());
}

/** Applies the strictest result across independent, already non-plaintext subjects. */
export async function applyDurableRateLimitToSubjects(
    input: DurableRateLimitSubjectsInput,
    options: DurableRateLimitOptions = {},
): Promise<DurableRateLimitDecision> {
    for (const subject of [...new Set(input.subjects.filter(Boolean))]) {
        const decision = await applyDurableRateLimit({
            namespace: input.namespace,
            subject,
            operation: input.operation,
            policy: input.policy,
        }, options);
        if (!decision.allowed) return decision;
    }
    return { allowed: true, retryAfterMs: 0 };
}
