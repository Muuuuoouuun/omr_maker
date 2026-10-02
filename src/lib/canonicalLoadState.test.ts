import { describe, expect, it, vi } from "vitest";

type LoadState<T> =
    | { state: "loading" }
    | { state: "loaded_empty"; data: T }
    | { state: "loaded_data"; data: T }
    | { state: "degraded_with_cache"; data: T; staleAt: string; error: "dependency_unavailable" }
    | { state: "error_without_cache"; error: "dependency_unavailable" };

type Subject = {
    resolveCanonicalLoad?: <T>(input: unknown, isEmpty: (data: T) => boolean) => LoadState<T>;
};

async function subject(): Promise<Subject> {
    try {
        return await import("./canonicalLoadState") as Subject;
    } catch {
        return {};
    }
}

const now = "2026-08-09T12:00:00.000Z";
const staleAt = "2026-08-09T11:59:00.000Z";
const unavailable = { state: "error_without_cache", error: "dependency_unavailable" } as const;

describe("canonical load state", () => {
    it("represents an explicit loading transition", async () => {
        const loadState = await subject();
        expect(loadState.resolveCanonicalLoad).toBeTypeOf("function");
        expect(loadState.resolveCanonicalLoad?.(
            { remote: { state: "loading" }, cache: null, now },
            () => false,
        )).toEqual({ state: "loading" });
    });

    it("uses the required predicate to distinguish loaded empty data", async () => {
        const loadState = await subject();
        const data = Object.freeze({ rows: Object.freeze([]) });
        const isEmpty = vi.fn((value: typeof data) => value.rows.length === 0);

        const result = loadState.resolveCanonicalLoad?.(
            { remote: { ok: true, data }, cache: null, now },
            isEmpty,
        );

        expect(result).toEqual({ state: "loaded_empty", data });
        expect(isEmpty).toHaveBeenCalledOnce();
        expect(isEmpty).toHaveBeenCalledWith(data);
    });

    it.each([
        [0, false],
        ["", false],
        [false, false],
        [{}, false],
    ])("never guesses emptiness from the truthiness of %j", async (data, empty) => {
        const loadState = await subject();
        expect(loadState.resolveCanonicalLoad?.(
            { remote: { ok: true, data }, cache: null, now },
            () => empty,
        )).toEqual({ state: "loaded_data", data });
    });

    it("preserves the exact immutable remote data reference", async () => {
        const loadState = await subject();
        const data = Object.freeze([Object.freeze({ id: "student-1" })]);

        const result = loadState.resolveCanonicalLoad?.(
            { remote: Object.freeze({ ok: true, data }), cache: null, now },
            (value: readonly { readonly id: string }[]) => value.length === 0,
        );

        expect(result).toEqual({ state: "loaded_data", data });
        expect(result && "data" in result ? result.data : null).toBe(data);
    });

    it("uses a valid cache envelope when the remote dependency fails", async () => {
        const loadState = await subject();
        const data = Object.freeze([Object.freeze({ id: "student-1" })]);

        const result = loadState.resolveCanonicalLoad?.(
            {
                remote: { ok: false },
                cache: Object.freeze({ data, staleAt }),
                now,
            },
            (value: readonly { readonly id: string }[]) => value.length === 0,
        );

        expect(result).toEqual({
            state: "degraded_with_cache",
            data,
            staleAt,
            error: "dependency_unavailable",
        });
        expect(result && "data" in result ? result.data : null).toBe(data);
    });

    it("fails closed when the remote dependency fails without cache", async () => {
        const loadState = await subject();
        expect(loadState.resolveCanonicalLoad?.(
            { remote: { ok: false }, cache: null, now },
            () => false,
        )).toEqual(unavailable);
    });

    it.each([
        ["missing staleAt", { data: [] }],
        ["non-string staleAt", { data: [], staleAt: 1 }],
        ["blank staleAt", { data: [], staleAt: "" }],
        ["non-canonical staleAt", { data: [], staleAt: "2026-08-09 11:59:00Z" }],
        ["impossible staleAt", { data: [], staleAt: "2026-02-30T11:59:00.000Z" }],
        ["future staleAt", { data: [], staleAt: "2026-08-09T12:00:00.001Z" }],
        ["extra cache field", { data: [], staleAt, source: "local" }],
    ])("rejects a %s cache envelope", async (_label, cache) => {
        const loadState = await subject();
        expect(loadState.resolveCanonicalLoad?.(
            { remote: { ok: false }, cache, now },
            (value: unknown[]) => value.length === 0,
        )).toEqual(unavailable);
    });

    it.each([
        ["missing now", { remote: { ok: false }, cache: null }],
        ["invalid now", { remote: { ok: false }, cache: null, now: "today" }],
        ["extra top-level field", { remote: { ok: false }, cache: null, now, retry: true }],
        ["ambiguous remote result", { remote: { ok: true, data: [], error: "failure" }, cache: null, now }],
        ["unknown remote state", { remote: { state: "ready" }, cache: null, now }],
        ["non-record input", null],
    ])("fails closed for %s", async (_label, input) => {
        const loadState = await subject();
        expect(loadState.resolveCanonicalLoad?.(input, () => false)).toEqual(unavailable);
    });

    it("does not invoke accessors while validating untrusted wrappers", async () => {
        const loadState = await subject();
        const getter = vi.fn(() => ({ ok: false }));
        const input = Object.defineProperties({}, {
            remote: { enumerable: true, get: getter },
            cache: { enumerable: true, value: null },
            now: { enumerable: true, value: now },
        });

        expect(loadState.resolveCanonicalLoad?.(input, () => false)).toEqual(unavailable);
        expect(getter).not.toHaveBeenCalled();
    });

    it.each([
        ["throws", () => { throw new Error("bad predicate"); }],
        ["returns a truthy non-boolean", () => "yes"],
    ])("returns a stable error when isEmpty %s", async (_label, isEmpty) => {
        const loadState = await subject();
        expect(loadState.resolveCanonicalLoad?.(
            { remote: { ok: true, data: [] }, cache: null, now },
            isEmpty as never,
        )).toEqual(unavailable);
    });
});
