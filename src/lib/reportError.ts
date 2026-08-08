const REDACTED = "[REDACTED]";
const MAX_DEPTH = 5;
const MAX_KEYS = 40;
const MAX_ARRAY_ITEMS = 20;

export type OperationalSeverity = "info" | "warning" | "error" | "critical";

export const SAFE_CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
export const SAFE_EVENT_ID = /^evt_[a-f0-9]{32}$/;

const SAFE_OPERATIONAL_SEVERITIES = new Set<OperationalSeverity>([
    "info",
    "warning",
    "error",
    "critical",
]);
const SENSITIVE_CORRELATION_ID = /(?:AKIA[0-9A-Z]{16}|gh[pousr]_?[A-Za-z0-9]{36,}|sk_(?:live|test)_[A-Za-z0-9_-]{8,})/i;

const SAFE_RECORD_KEYS = new Set([
    "code",
    "status",
    "type",
    "category",
    "count",
    "retryCount",
    "httpStatus",
]);
const SAFE_DIAGNOSTIC_VALUES = new Set([
    "E_FAIL",
    "initial_capacity_exceeded",
    "service_unavailable",
    "unauthorized",
    "not_found",
    "timeout",
    "aborted",
]);
const SAFE_CONTEXTS = new Set([
    "asset-gc",
    "feedback-return",
    "feedback-read",
    "feedback-save",
    "global-error-boundary",
    "route-error-boundary",
    "route-error",
    "student-exam-open",
    "student-exam-read",
    "student-submit",
    "server-request-error",
    "client-runtime-error",
    "teacher-exam-read",
    "teacher-exam-save",
    "teacher-roster-read",
    "teacher-roster-save",
    "hostile",
]);
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
type EventOptions = {
    /** Preserved only when it is a bounded opaque identifier. */
    correlationId?: string;
    /** Preserved only when it is an operational severity. */
    severity?: OperationalSeverity;
    /** Ignored: deployment identifiers may contain credentials. */
    deploymentId?: string;
    now?: Date;
};

function ownDataValue(value: unknown, key: string): unknown {
    if ((typeof value !== "object" || value === null) && typeof value !== "function") return undefined;
    try {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor && "value" in descriptor ? descriptor.value : undefined;
    } catch {
        return undefined;
    }
}

function inheritedDataValue(value: object, key: string): unknown {
    const own = ownDataValue(value, key);
    if (own !== undefined) return own;
    try {
        return ownDataValue(Object.getPrototypeOf(value), key);
    } catch {
        return undefined;
    }
}

function safeDiagnosticString(value: unknown): string {
    return typeof value === "string" && SAFE_DIAGNOSTIC_VALUES.has(value)
        ? value
        : REDACTED;
}

function safeErrorName(value: unknown): string {
    return typeof value === "string" && SAFE_ERROR_NAMES.has(value) ? value : "Error";
}

function isErrorObject(value: object): boolean {
    try {
        return value instanceof Error;
    } catch {
        return false;
    }
}

function snapshotNormalizedError(value: object): { name: string; message: typeof REDACTED } | undefined {
    const name = ownDataValue(value, "name");
    const message = ownDataValue(value, "message");
    if (typeof name !== "string" || !SAFE_ERROR_NAMES.has(name) || message !== REDACTED) return undefined;
    return { name, message: REDACTED };
}

function redactValueUnsafe(value: unknown, depth: number, seen: WeakSet<object>, allowDiagnostic = false): unknown {
    if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") {
        return value;
    }
    if (typeof value === "string") return allowDiagnostic ? safeDiagnosticString(value) : REDACTED;
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "function" || typeof value === "symbol") return "[UNSUPPORTED]";
    if (depth >= MAX_DEPTH) return "[TRUNCATED]";
    if (typeof value !== "object") return REDACTED;
    if (seen.has(value)) return "[CIRCULAR]";
    seen.add(value);

    const normalizedError = snapshotNormalizedError(value);
    if (normalizedError) return normalizedError;

    if (isErrorObject(value)) {
        return {
            name: safeErrorName(inheritedDataValue(value, "name")),
            message: safeDiagnosticString(ownDataValue(value, "message")),
        };
    }

    let isArray = false;
    try {
        isArray = Array.isArray(value);
    } catch {
        return "[UNREADABLE]";
    }
    if (isArray) {
        const output: unknown[] = [];
        for (let index = 0; index < Math.min((value as unknown[]).length, MAX_ARRAY_ITEMS); index += 1) {
            output.push(redactValue((value as unknown[])[index], depth + 1, seen));
        }
        return output;
    }

    let descriptors: Record<string, PropertyDescriptor>;
    try {
        descriptors = Object.getOwnPropertyDescriptors(value);
    } catch {
        return "[UNREADABLE]";
    }
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(descriptors).slice(0, MAX_KEYS)) {
        if (!SAFE_RECORD_KEYS.has(key)) continue;
        const descriptor = descriptors[key];
        if (!("value" in descriptor)) continue;
        output[key] = redactValue(descriptor.value, depth + 1, seen, true);
    }
    return output;
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>, allowDiagnostic = false): unknown {
    try {
        return redactValueUnsafe(value, depth, seen, allowDiagnostic);
    } catch {
        return "[UNREADABLE]";
    }
}

export function redactOperationalError(error: unknown): unknown {
    return redactValue(error, 0, new WeakSet());
}

let fallbackIdSequence = 0;

function randomHex32(): string {
    try {
        const uuid = globalThis.crypto?.randomUUID?.();
        const hex = uuid?.replaceAll("-", "").toLowerCase();
        if (hex && /^[a-f0-9]{32}$/.test(hex)) return hex;
    } catch {
        // Fall through to getRandomValues.
    }
    try {
        const bytes = new Uint8Array(16);
        globalThis.crypto?.getRandomValues?.(bytes);
        const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
        if (/[1-9a-f]/.test(hex)) return hex;
    } catch {
        // Fall through to a non-identifying process-local code.
    }
    fallbackIdSequence = (fallbackIdSequence + 1) >>> 0;
    try {
        const randomPrefix = Array.from({ length: 3 }, () => Math.floor(Math.random() * 0x1_0000_0000)
            .toString(16)
            .padStart(8, "0"))
            .join("");
        return `${randomPrefix}${fallbackIdSequence.toString(16).padStart(8, "0")}`;
    } catch {
        return fallbackIdSequence.toString(16).padStart(32, "0");
    }
}

function generatedOperationalId(excluded?: string): string {
    const candidate = `evt_${randomHex32()}`;
    if (candidate !== excluded) return candidate;
    const replacement = candidate.endsWith("0") ? "1" : "0";
    return `${candidate.slice(0, -1)}${replacement}`;
}

export function safeOperationalCorrelationId(value: unknown, eventId: string): string {
    if (typeof value === "string") {
        const match = value.match(SAFE_CORRELATION_ID)?.[0];
        if (match === value && value !== eventId && !SENSITIVE_CORRELATION_ID.test(value)) return value;
    }
    return generatedOperationalId(eventId);
}

function safeSeverity(value: unknown, fallback: OperationalSeverity): OperationalSeverity {
    return typeof value === "string" && SAFE_OPERATIONAL_SEVERITIES.has(value as OperationalSeverity)
        ? value as OperationalSeverity
        : fallback;
}

export function safeOperationalContext(value: unknown): string {
    return typeof value === "string" && SAFE_CONTEXTS.has(value) ? value : "unknown";
}

function safeTimestamp(value: unknown): string {
    try {
        if (value instanceof Date) return value.toISOString();
    } catch {
        // Use a fresh timestamp below.
    }
    try {
        return new Date().toISOString();
    } catch {
        return "1970-01-01T00:00:00.000Z";
    }
}

function safeRuntimeBuildSha(): string {
    try {
        for (const value of [process.env.VERCEL_GIT_COMMIT_SHA, process.env.GIT_SHA]) {
            const candidate = typeof value === "string" ? value.trim() : "";
            if (/^[a-f0-9]{7,40}$/i.test(candidate)) return candidate.toLowerCase();
        }
    } catch {
        // Browser bundles and hostile runtimes may not expose process.env.
    }
    return "unknown";
}

export function buildOperationalErrorEvent(
    context: string,
    error: unknown,
    options: EventOptions = {},
) {
    try {
        const eventId = generatedOperationalId();
        return {
            event: "omr.runtime_error" as const,
            context: safeOperationalContext(context),
            eventId,
            correlationId: safeOperationalCorrelationId(ownDataValue(options, "correlationId"), eventId),
            buildSha: safeRuntimeBuildSha(),
            severity: safeSeverity(ownDataValue(options, "severity"), "error"),
            timestamp: safeTimestamp(ownDataValue(options, "now")),
            error: redactOperationalError(error),
        };
    } catch {
        return {
            event: "omr.runtime_error" as const,
            context: "unknown",
            eventId: "evt_00000000000000000000000000000000",
            correlationId: "evt_00000000000000000000000000000001",
            buildSha: "unknown",
            severity: "error" as const,
            timestamp: "1970-01-01T00:00:00.000Z",
            error: "[UNREADABLE]",
        };
    }
}

export type OperationalErrorEvent = ReturnType<typeof buildOperationalErrorEvent>;

const SAFE_JOBS = new Set(["asset-gc", "readiness"]);

export type OperationalHeartbeatEvent = {
    event: "omr.job_heartbeat";
    job: "asset-gc" | "readiness" | "unknown";
    status: "ok" | "degraded";
    severity: "info" | "warning";
    eventId: string;
    correlationId: string;
    buildSha: string;
    timestamp: string;
    metrics: Record<string, number>;
};

export type OperationalEvent = OperationalErrorEvent | OperationalHeartbeatEvent;

export function buildOperationalHeartbeatEvent(
    job: string,
    status: "ok" | "degraded",
    metrics: Record<string, unknown> = {},
    now = new Date(),
): OperationalHeartbeatEvent {
    const boundedMetrics: Record<string, number> = {};
    for (const key of ["claimed", "deleted", "failed", "batches"]) {
        const value = metrics[key];
        if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
            boundedMetrics[key] = value;
        }
    }
    const eventId = generatedOperationalId();
    return {
        event: "omr.job_heartbeat",
        job: SAFE_JOBS.has(job) ? job as OperationalHeartbeatEvent["job"] : "unknown",
        status,
        severity: status === "ok" ? "info" : "warning",
        eventId,
        correlationId: generatedOperationalId(eventId),
        buildSha: safeRuntimeBuildSha(),
        timestamp: safeTimestamp(now),
        metrics: boundedMetrics,
    };
}

export function emitOperationalErrorEvent(
    context: string,
    error: unknown,
    options: EventOptions = {},
): OperationalErrorEvent {
    const event = buildOperationalErrorEvent(context, error, options);
    try {
        console.error(JSON.stringify(event));
        return event;
    } catch {
        // The logging sink is outside our trust boundary too.
    }
    try {
        console.error('{"event":"omr.runtime_error","context":"reporting_failure","error":"[UNREADABLE]"}');
    } catch {
        // Reporting must never replace the original application failure.
    }
    return event;
}

/** Single structured console funnel. Server delivery lives in reportServerError. */
export function reportError(context: string, error: unknown, options: EventOptions = {}): void {
    const safeOptions = {
        correlationId: ownDataValue(options, "correlationId"),
        severity: ownDataValue(options, "severity"),
        now: ownDataValue(options, "now"),
    } as EventOptions;
    void emitOperationalErrorEvent(context, error, safeOptions);
}
