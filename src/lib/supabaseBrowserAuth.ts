import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export interface SupabaseBrowserAuthConfig {
    url: string;
    publishableKey: string;
}

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

export function getSupabaseBrowserAuthConfig(): SupabaseBrowserAuthConfig | null {
    const url = clean(process.env.NEXT_PUBLIC_SUPABASE_URL);
    const publishableKey = clean(process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)
        || clean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
    return url && publishableKey ? { url, publishableKey } : null;
}

export function createSupabaseBrowserAuthClient(): SupabaseClient | null {
    const config = getSupabaseBrowserAuthConfig();
    if (!config) return null;
    return createClient(config.url, config.publishableKey, {
        auth: {
            flowType: "pkce",
            detectSessionInUrl: true,
            persistSession: true,
            autoRefreshToken: true,
        },
    });
}
