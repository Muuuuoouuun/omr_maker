export const SETTINGS_STORAGE_KEY = "omr_settings";

export function resolveGeminiApiKey(personalKey?: string | null, serverKey?: string | null): string {
    const personal = personalKey?.trim();
    if (personal) return personal;
    return serverKey?.trim() || "";
}

export function extractGeminiApiKeyFromSettings(rawSettings: string | null | undefined): string {
    if (!rawSettings) return "";

    try {
        const parsed = JSON.parse(rawSettings) as { api?: { geminiKey?: unknown } };
        return typeof parsed.api?.geminiKey === "string" ? parsed.api.geminiKey.trim() : "";
    } catch {
        return "";
    }
}

export function readStoredGeminiApiKey(): string {
    if (typeof window === "undefined") return "";
    return extractGeminiApiKeyFromSettings(window.localStorage.getItem(SETTINGS_STORAGE_KEY));
}

export function maskGeminiApiKey(key: string): string {
    const trimmed = key.trim();
    if (!trimmed) return "";
    if (trimmed.length <= 11) return trimmed;
    return `${trimmed.slice(0, 8)}${"•".repeat(Math.max(0, trimmed.length - 11))}${trimmed.slice(-3)}`;
}
