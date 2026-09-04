import { createClient } from "@supabase/supabase-js";
import { getSupabaseServerConfigFromEnv } from "@/lib/supabaseServerAdmin";

export interface SharedLoginRateLimitOptions {
    keys: string[];
    maxFailures: number;
    windowMs: number;
    lockoutMs: number;
}

interface RpcClient {
    rpc(name: string, params: Record<string, unknown>): PromiseLike<{
        data: unknown;
        error: { message?: string } | null;
    }>;
}

function cleanKeys(keys: string[]): string[] {
    return [...new Set(keys.map(key => key.trim()).filter(Boolean))].slice(0, 4);
}

function seconds(milliseconds: number): number {
    return Math.max(1, Math.ceil(milliseconds / 1000));
}

function serverClient(): RpcClient | null {
    const config = getSupabaseServerConfigFromEnv();
    if (!config) return null;
    return createClient(config.url, config.serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false },
    }) as unknown as RpcClient;
}

export async function checkSharedLoginRateLimitWithClient(
    client: RpcClient,
    options: SharedLoginRateLimitOptions,
): Promise<{ allowed: boolean; retryAfterMs: number } | null> {
    const keys = cleanKeys(options.keys);
    if (keys.length === 0) return null;
    const { data, error } = await client.rpc("omr_check_login_rate_limit_v1", {
        p_keys: keys,
        p_window_seconds: seconds(options.windowMs),
    });
    if (error || !data || typeof data !== "object" || Array.isArray(data)) return null;
    const row = data as { allowed?: unknown; retry_after_ms?: unknown };
    if (typeof row.allowed !== "boolean") return null;
    const retryAfterMs = Number(row.retry_after_ms);
    return {
        allowed: row.allowed,
        retryAfterMs: Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? Math.ceil(retryAfterMs) : 0,
    };
}

export async function recordSharedLoginFailureWithClient(
    client: RpcClient,
    options: SharedLoginRateLimitOptions,
): Promise<boolean> {
    const keys = cleanKeys(options.keys);
    if (keys.length === 0) return false;
    const { error } = await client.rpc("omr_record_login_failure_v1", {
        p_keys: keys,
        p_max_failures: options.maxFailures,
        p_window_seconds: seconds(options.windowMs),
        p_lockout_seconds: seconds(options.lockoutMs),
    });
    return !error;
}

export async function clearSharedLoginRateLimitWithClient(client: RpcClient, keys: string[]): Promise<boolean> {
    const normalizedKeys = cleanKeys(keys);
    if (normalizedKeys.length === 0) return false;
    const { error } = await client.rpc("omr_clear_login_rate_limit_v1", { p_keys: normalizedKeys });
    return !error;
}

export async function checkSharedLoginRateLimit(
    options: SharedLoginRateLimitOptions,
): Promise<{ allowed: boolean; retryAfterMs: number } | null> {
    const client = serverClient();
    if (!client) return null;
    return checkSharedLoginRateLimitWithClient(client, options);
}

export async function recordSharedLoginFailure(options: SharedLoginRateLimitOptions): Promise<boolean> {
    const client = serverClient();
    return client ? recordSharedLoginFailureWithClient(client, options) : false;
}

export async function clearSharedLoginRateLimit(keys: string[]): Promise<boolean> {
    const client = serverClient();
    return client ? clearSharedLoginRateLimitWithClient(client, keys) : false;
}
