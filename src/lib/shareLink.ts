export interface ShareBaseUrlOptions {
    envBaseUrl?: string | null;
    origin?: string | null;
    inviteToken?: string | null;
}

function normalizeBaseUrl(value: string | null | undefined): string | null {
    const trimmed = (value || "").trim();
    if (!trimmed) return null;
    if (!/^https?:\/\//i.test(trimmed)) return null;
    return trimmed.replace(/\/+$/, "");
}

function isLoopbackOrigin(origin: string): boolean {
    try {
        const { hostname } = new URL(origin);
        return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
    } catch {
        return false;
    }
}

export function resolveShareBaseUrl(options: ShareBaseUrlOptions = {}): string {
    const envBase = normalizeBaseUrl(
        options.envBaseUrl !== undefined ? options.envBaseUrl : process.env.NEXT_PUBLIC_SHARE_BASE_URL,
    );
    if (envBase) return envBase;
    const origin = normalizeBaseUrl(
        options.origin !== undefined ? options.origin : typeof window !== "undefined" ? window.location.origin : null,
    );
    return origin || "";
}

export function buildSolveShareUrl(examId: string, options: ShareBaseUrlOptions = {}): string {
    const path = `/solve/${encodeURIComponent(examId)}`;
    const invite = options.inviteToken?.trim() || "";
    const query = /^[A-Za-z0-9_-]{43}$/.test(invite)
        ? `#invite=${encodeURIComponent(invite)}`
        : "";
    return `${resolveShareBaseUrl(options)}${path}${query}`;
}

export function isShareUrlReachableByStudents(shareUrl: string): boolean {
    return !isLoopbackOrigin(shareUrl);
}
