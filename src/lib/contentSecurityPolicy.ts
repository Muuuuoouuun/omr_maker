type PolicyEnvironment = Record<string, string | undefined>;

/** Only the configured Storage project is reachable from the browser. */
export function browserConnectionSources(env: PolicyEnvironment): string[] {
    const sources = new Set(["'self'", "data:", "blob:"]);
    // Match the server gateway that issues the signed Storage upload URLs.
    const raw = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
    if (raw) {
        try {
            const url = new URL(raw.trim());
            if (url.protocol === "https:" && !url.username && !url.password) {
                sources.add(url.origin);
                sources.add(`wss://${url.host}`);
                if (/^[a-z0-9-]+\.supabase\.co$/.test(url.hostname)) {
                    sources.add(`https://${url.hostname.replace('.supabase.co', '.storage.supabase.co')}`);
                }
            }
        } catch { /* Invalid configuration never broadens network access. */ }
    }
    return [...sources];
}

export function contentSecurityPolicy(env: PolicyEnvironment, nonce?: string): string {
    const production = env.NODE_ENV === "production";
    const scripts = production
        ? `script-src 'self'${nonce ? ` 'nonce-${nonce}' 'strict-dynamic'` : ""}`
        : "script-src 'self' 'unsafe-inline' 'unsafe-eval'";
    return [
        "default-src 'self'", "base-uri 'self'", "object-src 'none'",
        "frame-ancestors 'none'", "form-action 'self'", scripts,
        // React component style attributes require this; script execution does not.
        "style-src 'self' 'unsafe-inline'",
        `connect-src ${browserConnectionSources(env).join(' ')}`,
        "img-src 'self' data: blob:", "font-src 'self' data:",
        "worker-src 'self' blob:", "frame-src 'self' blob:",
        "media-src 'self' data: blob:", "manifest-src 'self'",
    ].join('; ');
}
