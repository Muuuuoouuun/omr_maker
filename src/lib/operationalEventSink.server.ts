import "next/dist/compiled/server-only";
import {
    redactOperationalError,
    SAFE_EVENT_ID,
    safeOperationalContext,
    safeOperationalCorrelationId,
    type OperationalEvent,
    type OperationalSeverity,
} from "./reportError";

type Env = Record<string, string | undefined>;
type FetchLike = typeof fetch;
const MAX_OPERATIONAL_EVENT_BYTES = 32 * 1024;

export type OperationalSinkDeliveryStatus =
    | "delivered"
    | "not_configured"
    | "invalid_configuration"
    | "rejected"
    | "timeout"
    | "failed";

export type OperationalSinkReadiness =
    | "ready"
    | "not_configured"
    | "invalid_configuration"
    | "probe_failed"
    | "probe_timeout";

type ResolvedSinkConfiguration = {
    status: "configured";
    url: string;
    token: string;
} | { status: "not_configured" | "invalid_configuration" };

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function isSafeEventId(value: unknown): value is string {
    return typeof value === "string" && value.match(SAFE_EVENT_ID)?.[0] === value;
}

function ownDataValue(value: unknown, key: string): unknown {
    if ((typeof value !== "object" || value === null) && typeof value !== "function") return undefined;
    try {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor && "value" in descriptor ? descriptor.value : undefined;
    } catch {
        return undefined;
    }
}

function snapshotBuildSha(value: unknown): string {
    return typeof value === "string" && (value === "unknown" || /^[a-f0-9]{7,40}$/.test(value))
        ? value
        : "unknown";
}

function snapshotTimestamp(value: unknown): string {
    if (typeof value !== "string") return "1970-01-01T00:00:00.000Z";
    try {
        return new Date(value).toISOString() === value ? value : "1970-01-01T00:00:00.000Z";
    } catch {
        return "1970-01-01T00:00:00.000Z";
    }
}

function snapshotSeverity(value: unknown): OperationalSeverity {
    return value === "info" || value === "warning" || value === "error" || value === "critical"
        ? value
        : "error";
}

function snapshotHeartbeatMetrics(value: unknown): Record<string, number> {
    const metrics: Record<string, number> = {};
    for (const key of ["claimed", "deleted", "failed", "batches"]) {
        const metric = ownDataValue(value, key);
        if (typeof metric === "number" && Number.isSafeInteger(metric) && metric >= 0) {
            metrics[key] = metric;
        }
    }
    return metrics;
}

function snapshotOperationalEvent(event: OperationalEvent, eventId: string): OperationalEvent | undefined {
    const eventName = ownDataValue(event, "event");
    if (eventName === "omr.runtime_error") {
        return {
            event: eventName,
            context: safeOperationalContext(ownDataValue(event, "context")),
            eventId,
            correlationId: safeOperationalCorrelationId(ownDataValue(event, "correlationId"), eventId),
            buildSha: snapshotBuildSha(ownDataValue(event, "buildSha")),
            severity: snapshotSeverity(ownDataValue(event, "severity")),
            timestamp: snapshotTimestamp(ownDataValue(event, "timestamp")),
            error: redactOperationalError(ownDataValue(event, "error")),
        };
    }
    if (eventName === "omr.job_heartbeat") {
        const status = ownDataValue(event, "status");
        if (status !== "ok" && status !== "degraded") return undefined;
        const job = ownDataValue(event, "job");
        return {
            event: eventName,
            job: job === "asset-gc" || job === "readiness" ? job : "unknown",
            status,
            severity: status === "ok" ? "info" : "warning",
            eventId,
            correlationId: safeOperationalCorrelationId(ownDataValue(event, "correlationId"), eventId),
            buildSha: snapshotBuildSha(ownDataValue(event, "buildSha")),
            timestamp: snapshotTimestamp(ownDataValue(event, "timestamp")),
            metrics: snapshotHeartbeatMetrics(ownDataValue(event, "metrics")),
        };
    }
    return undefined;
}

function isTransientSinkStatus(status: number): boolean {
    return status === 408 || status === 425 || status === 429 || status >= 500;
}

function isIpLiteral(hostname: string): boolean {
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return true;
    return hostname.includes(":") && /^[0-9a-f:.]+$/i.test(hostname);
}

function resolveConfiguration(env: Env): ResolvedSinkConfiguration {
    const rawUrl = clean(env.OMR_OPERATIONAL_SINK_URL);
    const token = clean(env.OMR_OPERATIONAL_SINK_TOKEN);
    if (!rawUrl && !token) return { status: "not_configured" };
    if (!rawUrl || token.length < 32 || token.length > 512 || /\s/.test(token)) {
        return { status: "invalid_configuration" };
    }
    try {
        const url = new URL(rawUrl);
        const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
        const localDevelopment = env.NODE_ENV !== "production"
            && url.protocol === "http:"
            && (hostname === "127.0.0.1" || hostname === "localhost");
        if (
            (url.protocol !== "https:" && !localDevelopment)
            || (env.NODE_ENV === "production" && (
                isIpLiteral(hostname)
                || hostname === "localhost"
                || hostname.endsWith(".localhost")
                || hostname.endsWith(".local")
            ))
            || !!url.username
            || !!url.password
            || !!url.hash
        ) return { status: "invalid_configuration" };
        return { status: "configured", url: url.toString(), token };
    } catch {
        return { status: "invalid_configuration" };
    }
}

export function operationalEventSinkConfiguration(env: Env = process.env):
    { status: "configured"; url: string } | { status: "not_configured" | "invalid_configuration" } {
    const configuration = resolveConfiguration(env);
    return configuration.status === "configured"
        ? { status: "configured", url: configuration.url }
        : configuration;
}

export async function deliverOperationalEvent(
    event: OperationalEvent,
    env: Env = process.env,
    fetchImpl: FetchLike = fetch,
    timeoutMs = 1_500,
): Promise<{ status: OperationalSinkDeliveryStatus }> {
    const configuration = resolveConfiguration(env);
    if (configuration.status !== "configured") return { status: configuration.status };

    let eventId: string;
    let eventSnapshot: OperationalEvent;
    try {
        const eventIdSnapshot = event.eventId;
        if (!isSafeEventId(eventIdSnapshot)) return { status: "rejected" };
        eventId = eventIdSnapshot;
        const snapshot = snapshotOperationalEvent(event, eventId);
        if (!snapshot) return { status: "rejected" };
        eventSnapshot = snapshot;
    } catch {
        return { status: "rejected" };
    }

    let body: string;
    try {
        body = JSON.stringify(eventSnapshot);
        if (new TextEncoder().encode(body).byteLength > MAX_OPERATIONAL_EVENT_BYTES) {
            return { status: "failed" };
        }
        const serializedEvent = JSON.parse(body) as unknown;
        if (
            typeof serializedEvent !== "object"
            || serializedEvent === null
            || Reflect.get(serializedEvent, "eventId") !== eventId
        ) return { status: "rejected" };
    } catch {
        return { status: "failed" };
    }

    const controller = new AbortController();
    const boundedTimeoutMs = Math.max(100, Math.min(5_000, Math.trunc(timeoutMs)));
    const timer = setTimeout(() => controller.abort(new DOMException("Sink delivery timed out", "TimeoutError")), boundedTimeoutMs);
    try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                const response = await fetchImpl(configuration.url, {
                    method: "POST",
                    headers: {
                        authorization: `Bearer ${configuration.token}`,
                        "content-type": "application/json",
                        "user-agent": "omr-maker-operational-events/1",
                        "x-omr-event-id": eventId,
                    },
                    body,
                    cache: "no-store",
                    credentials: "omit",
                    redirect: "error",
                    signal: controller.signal,
                });
                if (response.ok) return { status: "delivered" };
                if (attempt === 0 && isTransientSinkStatus(response.status)) continue;
                return { status: "rejected" };
            } catch {
                if (controller.signal.aborted) return { status: "timeout" };
                if (attempt === 0) continue;
                return { status: "failed" };
            }
        }
        return { status: "failed" };
    } catch {
        return { status: controller.signal.aborted ? "timeout" : "failed" };
    } finally {
        clearTimeout(timer);
    }
}

export async function probeOperationalEventSink(
    env: Env = process.env,
    fetchImpl: FetchLike = fetch,
    timeoutMs = 1_500,
): Promise<OperationalSinkReadiness> {
    const configuration = resolveConfiguration(env);
    if (configuration.status !== "configured") return configuration.status;
    const controller = new AbortController();
    const boundedTimeoutMs = Math.max(100, Math.min(5_000, Math.trunc(timeoutMs)));
    const timer = setTimeout(() => controller.abort(new DOMException("Sink probe timed out", "TimeoutError")), boundedTimeoutMs);
    try {
        const response = await fetchImpl(configuration.url, {
            method: "HEAD",
            headers: {
                authorization: `Bearer ${configuration.token}`,
                "user-agent": "omr-maker-operational-events/1",
                "x-omr-probe": "readiness",
            },
            body: undefined,
            cache: "no-store",
            credentials: "omit",
            redirect: "error",
            signal: controller.signal,
        });
        return response.ok ? "ready" : "probe_failed";
    } catch {
        return controller.signal.aborted ? "probe_timeout" : "probe_failed";
    } finally {
        clearTimeout(timer);
    }
}
