export type CanonicalLoadState<T> =
    | { readonly state: "loading" }
    | { readonly state: "loaded_empty"; readonly data: T }
    | { readonly state: "loaded_data"; readonly data: T }
    | {
        readonly state: "degraded_with_cache";
        readonly data: T;
        readonly staleAt: string;
        readonly error: "dependency_unavailable";
    }
    | { readonly state: "error_without_cache"; readonly error: "dependency_unavailable" };

export type CanonicalRemoteResult<T> =
    | { readonly state: "loading" }
    | { readonly ok: true; readonly data: T }
    | { readonly ok: false };

export interface CanonicalCache<T> {
    readonly data: T;
    readonly staleAt: string;
}

export interface CanonicalLoadInput<T> {
    readonly remote: CanonicalRemoteResult<T>;
    readonly cache: CanonicalCache<T> | null;
    /** Caller-supplied load time. The resolver never consults the local wall clock. */
    readonly now: string;
}

const UNAVAILABLE = Object.freeze({
    state: "error_without_cache",
    error: "dependency_unavailable",
} as const);

type ExactRecord = Readonly<Record<string, unknown>>;

function exactDataRecord(value: unknown, expectedKeys: readonly string[]): ExactRecord | null {
    if (typeof value !== "object" || value === null) return null;

    try {
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) return null;

        const keys = Reflect.ownKeys(value);
        if (keys.length !== expectedKeys.length || keys.some(key => typeof key !== "string")) return null;

        const sortedKeys = (keys as string[]).toSorted();
        const sortedExpected = [...expectedKeys].toSorted();
        for (let index = 0; index < sortedExpected.length; index += 1) {
            if (sortedKeys[index] !== sortedExpected[index]) return null;
        }

        const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
        for (const key of expectedKeys) {
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) return null;
            record[key] = descriptor.value;
        }
        return record;
    } catch {
        return null;
    }
}

function canonicalIsoInstant(value: unknown): value is string {
    if (typeof value !== "string" || value.length !== 24) return false;
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;

    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return false;
    try {
        return new Date(timestamp).toISOString() === value;
    } catch {
        return false;
    }
}

type ParsedRemote<T> =
    | { readonly kind: "loading" }
    | { readonly kind: "success"; readonly data: T }
    | { readonly kind: "failure" }
    | { readonly kind: "invalid" };

function parseRemote<T>(value: unknown): ParsedRemote<T> {
    const loading = exactDataRecord(value, ["state"]);
    if (loading) {
        return loading.state === "loading" ? { kind: "loading" } : { kind: "invalid" };
    }

    const failure = exactDataRecord(value, ["ok"]);
    if (failure) {
        return failure.ok === false ? { kind: "failure" } : { kind: "invalid" };
    }

    const success = exactDataRecord(value, ["ok", "data"]);
    if (success) {
        return success.ok === true
            ? { kind: "success", data: success.data as T }
            : { kind: "invalid" };
    }

    return { kind: "invalid" };
}

function parseCache<T>(value: unknown, now: string): CanonicalCache<T> | null {
    const cache = exactDataRecord(value, ["data", "staleAt"]);
    if (!cache || !canonicalIsoInstant(cache.staleAt)) return null;
    if (Date.parse(cache.staleAt) > Date.parse(now)) return null;
    return { data: cache.data as T, staleAt: cache.staleAt };
}

/**
 * Converts an explicit remote/cache observation into the shared UI load-state contract.
 * Data is passed through by identity; only the caller-provided predicate determines emptiness.
 */
export function resolveCanonicalLoad<T>(
    input: CanonicalLoadInput<T>,
    isEmpty: (data: T) => boolean,
): CanonicalLoadState<T> {
    if (typeof isEmpty !== "function") return UNAVAILABLE;

    const envelope = exactDataRecord(input, ["remote", "cache", "now"]);
    if (!envelope || !canonicalIsoInstant(envelope.now)) return UNAVAILABLE;

    const remote = parseRemote<T>(envelope.remote);
    if (remote.kind === "invalid") return UNAVAILABLE;
    if (remote.kind === "loading") return { state: "loading" };

    if (remote.kind === "success") {
        try {
            const empty = isEmpty(remote.data);
            if (empty === true) return { state: "loaded_empty", data: remote.data };
            if (empty === false) return { state: "loaded_data", data: remote.data };
            return UNAVAILABLE;
        } catch {
            return UNAVAILABLE;
        }
    }

    if (envelope.cache === null) return UNAVAILABLE;
    const cache = parseCache<T>(envelope.cache, envelope.now);
    if (!cache) return UNAVAILABLE;
    return {
        state: "degraded_with_cache",
        data: cache.data,
        staleAt: cache.staleAt,
        error: "dependency_unavailable",
    };
}
