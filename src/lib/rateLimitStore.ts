/**
 * Atomic counter store for rate limiting. The PIN guard used to keep its state in
 * a per-process Map, so on a serverless deployment each instance had its own
 * counter and a sweep spread across instances slipped past the limit. This
 * abstraction lets the limiter run against a shared, atomic backing store instead.
 *
 * The single required primitive is an atomic `increment`: read the window, roll it
 * if expired, add one, and return the new count — as one indivisible step so two
 * concurrent failures can never both read the pre-increment count and under-count.
 */

export interface RateWindowState {
    count: number;
    firstAt: number;
}

export interface AtomicCounterStore {
    /** Atomically bump `key` within a rolling `windowMs` window; returns the new state. */
    increment(key: string, windowMs: number, now: number): Promise<RateWindowState>;
    /** Current state without mutating; an expired window reads as null. */
    peek(key: string, windowMs: number, now: number): Promise<RateWindowState | null>;
    /** Drop a key (e.g. clear a budget after a successful check). */
    reset(key: string): Promise<void>;
}

function isExpired(state: RateWindowState, windowMs: number, now: number): boolean {
    return now - state.firstAt >= windowMs;
}

/**
 * Default store. A JavaScript event loop runs one turn at a time, so the
 * read-modify-write below is atomic within a single process. It is NOT shared
 * across serverless instances — see SupabaseAtomicCounterStore for the durable,
 * cross-instance implementation.
 */
export class InMemoryAtomicCounterStore implements AtomicCounterStore {
    private readonly states = new Map<string, RateWindowState>();

    async increment(key: string, windowMs: number, now: number): Promise<RateWindowState> {
        const current = this.states.get(key);
        const base = current && !isExpired(current, windowMs, now) ? current : { count: 0, firstAt: now };
        const next: RateWindowState = { count: base.count + 1, firstAt: base.firstAt };
        this.states.set(key, next);
        return next;
    }

    async peek(key: string, windowMs: number, now: number): Promise<RateWindowState | null> {
        const current = this.states.get(key);
        if (!current) return null;
        if (isExpired(current, windowMs, now)) {
            this.states.delete(key);
            return null;
        }
        return current;
    }

    async reset(key: string): Promise<void> {
        this.states.delete(key);
    }
}

/** Process-wide default so all callers share one counter within an instance. */
export const defaultAtomicCounterStore: AtomicCounterStore = new InMemoryAtomicCounterStore();

interface RpcClientLike {
    rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message?: string } | null }>;
}

function toState(data: unknown): RateWindowState | null {
    if (!data || typeof data !== "object") return null;
    const record = data as Record<string, unknown>;
    const count = Number(record.count);
    const firstAt = Number(record.first_at ?? record.firstAt);
    if (!Number.isFinite(count) || !Number.isFinite(firstAt)) return null;
    return { count, firstAt };
}

/**
 * Durable, cross-instance store backed by the `omr_rate_limit_hit` /
 * `omr_rate_limit_peek` RPCs (see supabase/schema.sql). The RPC performs the
 * increment inside a single statement (`insert … on conflict do update`) so the
 * atomicity guarantee holds across serverless instances.
 *
 * NOTE: requires a live service-role Supabase connection and the RPCs to be
 * deployed — exercised here against a mock client; live verification pending.
 */
export class SupabaseAtomicCounterStore implements AtomicCounterStore {
    constructor(private readonly client: RpcClientLike) {}

    async increment(key: string, windowMs: number, now: number): Promise<RateWindowState> {
        const { data, error } = await this.client.rpc("omr_rate_limit_hit", {
            p_key: key,
            p_window_ms: windowMs,
            p_now: now,
        });
        if (error) throw new Error(error.message || "rate-limit increment failed");
        return toState(data) ?? { count: 1, firstAt: now };
    }

    async peek(key: string, windowMs: number, now: number): Promise<RateWindowState | null> {
        const { data, error } = await this.client.rpc("omr_rate_limit_peek", {
            p_key: key,
            p_window_ms: windowMs,
            p_now: now,
        });
        if (error) throw new Error(error.message || "rate-limit peek failed");
        return toState(data);
    }

    async reset(key: string): Promise<void> {
        const { error } = await this.client.rpc("omr_rate_limit_reset", { p_key: key });
        if (error) throw new Error(error.message || "rate-limit reset failed");
    }
}
