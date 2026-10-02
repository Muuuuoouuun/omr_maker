import { applyDurableRateLimitToSubjects } from "@/lib/durableRateLimit";
import { reportServerError } from "@/lib/reportServerError";
import { isSameOriginServerActionRequest } from "@/lib/serverActionSecurity";

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };
const CLIENT_EVENT_POLICY = { limit: 6, windowMs: 60_000 };
const GLOBAL_EVENT_POLICY = { limit: 120, windowMs: 60_000 };
const SAFE_ERROR_NAMES = new Set([
    "Error",
    "TypeError",
    "RangeError",
    "ReferenceError",
    "SyntaxError",
    "URIError",
    "AggregateError",
    "AbortError",
    "TimeoutError",
]);

function clientSubject(headers: Headers): string {
    return headers.get("x-forwarded-for")?.split(",")[0]?.trim()
        || headers.get("x-real-ip")?.trim()
        || "unknown-client";
}

function acceptedBody(value: unknown): { kind: "error" | "unhandledrejection"; name: string } | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    if (row.kind !== "error" && row.kind !== "unhandledrejection") return null;
    if (typeof row.name !== "string" || !SAFE_ERROR_NAMES.has(row.name)) return null;
    if (Object.keys(row).some(key => key !== "kind" && key !== "name")) return null;
    return { kind: row.kind, name: row.name };
}

async function readBoundedBody(request: Request, maxBytes: number): Promise<string | null> {
    if (!request.body) return "";
    const reader = request.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let text = "";
    try {
        while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > maxBytes) {
                await reader.cancel();
                return null;
            }
            text += decoder.decode(chunk.value, { stream: true });
        }
        return text + decoder.decode();
    } finally {
        reader.releaseLock();
    }
}

export async function POST(request: Request): Promise<Response> {
    if (!request.headers.get("origin") || !isSameOriginServerActionRequest(request.headers)) {
        return Response.json({ status: "rejected" }, { status: 403, headers: NO_STORE_HEADERS });
    }
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
        return Response.json({ status: "rejected" }, { status: 415, headers: NO_STORE_HEADERS });
    }
    const declaredBytes = Number(request.headers.get("content-length") || 0);
    if (!Number.isFinite(declaredBytes) || declaredBytes < 0 || declaredBytes > 1_024) {
        return Response.json({ status: "rejected" }, { status: 413, headers: NO_STORE_HEADERS });
    }

    let body: { kind: "error" | "unhandledrejection"; name: string } | null;
    try {
        const text = await readBoundedBody(request, 1_024);
        if (text === null) {
            return Response.json({ status: "rejected" }, { status: 413, headers: NO_STORE_HEADERS });
        }
        body = acceptedBody(JSON.parse(text));
    } catch {
        body = null;
    }
    if (!body) {
        return Response.json({ status: "rejected" }, { status: 400, headers: NO_STORE_HEADERS });
    }

    const clientRateLimit = await applyDurableRateLimitToSubjects({
        namespace: "client-runtime-error",
        subjects: [clientSubject(request.headers)],
        operation: "consume",
        policy: CLIENT_EVENT_POLICY,
    });
    if (!clientRateLimit.allowed) {
        return Response.json({ status: "rate_limited" }, { status: 429, headers: NO_STORE_HEADERS });
    }
    const globalRateLimit = await applyDurableRateLimitToSubjects({
        namespace: "client-runtime-error",
        subjects: ["global"],
        operation: "consume",
        policy: GLOBAL_EVENT_POLICY,
    });
    if (!globalRateLimit.allowed) {
        return Response.json({ status: "rate_limited" }, { status: 429, headers: NO_STORE_HEADERS });
    }

    try {
        const error = new Error("client runtime failure");
        error.name = body.name;
        await reportServerError("client-runtime-error", error);
        return Response.json({ status: "accepted" }, { status: 202, headers: NO_STORE_HEADERS });
    } catch {
        return Response.json({ status: "rejected" }, { status: 400, headers: NO_STORE_HEADERS });
    }
}
