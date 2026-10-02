export const DEFAULT_SITE_ORIGIN = "https://omr-maker-eight.vercel.app";

function normalizeSiteOrigin(value: string | undefined): string | null {
    const trimmed = value?.trim();
    if (!trimmed) return null;

    try {
        const url = new URL(trimmed);
        return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
    } catch {
        return null;
    }
}

export function resolveSiteOrigin(): string {
    return normalizeSiteOrigin(process.env.NEXT_PUBLIC_SHARE_BASE_URL) || DEFAULT_SITE_ORIGIN;
}
