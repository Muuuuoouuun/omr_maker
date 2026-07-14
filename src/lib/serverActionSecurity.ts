export const SERVER_ACTION_ORIGIN_ERROR = "요청 출처를 확인할 수 없습니다. 페이지를 새로고침한 뒤 다시 시도해주세요.";

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function firstHeaderValue(value: string | null | undefined): string {
    return clean(value).split(",")[0]?.trim() || "";
}

function normalizeHost(value: string): string {
    return value.toLowerCase().replace(/\.$/, "");
}

function requestHost(headerStore: Headers): string {
    return normalizeHost(
        firstHeaderValue(headerStore.get("host"))
        || firstHeaderValue(headerStore.get("x-forwarded-host")),
    );
}

export function isSameOriginServerActionRequest(headerStore: Headers): boolean {
    const origin = firstHeaderValue(headerStore.get("origin"));
    if (!origin) return true;

    let originUrl: URL;
    try {
        originUrl = new URL(origin);
    } catch {
        return false;
    }

    const host = requestHost(headerStore);
    if (!host) return false;

    return normalizeHost(originUrl.host) === host;
}
