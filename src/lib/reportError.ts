const REDACTED = "[REDACTED]";
const MAX_DEPTH = 5;
const MAX_KEYS = 40;
const MAX_ARRAY_ITEMS = 20;

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
    /** Ignored: caller-controlled identifiers are never serialized. */
    correlationId?: string;
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

function generatedCorrelationId(): string {
    try {
        const uuid = globalThis.crypto?.randomUUID?.();
        if (uuid) return `req_${uuid}`;
    } catch {
        // Fall through to a non-identifying request code.
    }
    try {
        return `req_${Date.now().toString(36)}`;
    } catch {
        return "req_unknown";
    }
}

function safeContext(value: unknown): string {
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

function safeRuntimeBuildId(): string {
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
        return {
            event: "omr.runtime_error" as const,
            context: safeContext(context),
            correlationId: generatedCorrelationId(),
            build: safeRuntimeBuildId(),
            timestamp: safeTimestamp(ownDataValue(options, "now")),
            error: redactOperationalError(error),
        };
    } catch {
        return {
            event: "omr.runtime_error" as const,
            context: "unknown",
            correlationId: "req_unknown",
            build: "unknown",
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
    correlationId: string;
    build: string;
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
    return {
        event: "omr.job_heartbeat",
        job: SAFE_JOBS.has(job) ? job as OperationalHeartbeatEvent["job"] : "unknown",
        status,
        correlationId: generatedCorrelationId(),
        build: safeRuntimeBuildId(),
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
        now: ownDataValue(options, "now"),
    } as EventOptions;
    void emitOperationalErrorEvent(context, error, safeOptions);
}
