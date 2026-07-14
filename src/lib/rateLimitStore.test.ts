import { describe, expect, it, vi } from "vitest";
import {
    InMemoryAtomicCounterStore,
    SupabaseAtomicCounterStore,
} from "./rateLimitStore";

const WINDOW = 1000;

describe("InMemoryAtomicCounterStore", () => {
    it("increments within a window and rolls over after it expires", async () => {
        const store = new InMemoryAtomicCounterStore();
        expect(await store.increment("k", WINDOW, 0)).toEqual({ count: 1, firstAt: 0 });
        expect(await store.increment("k", WINDOW, 200)).toEqual({ count: 2, firstAt: 0 });
        // window elapsed → fresh window
        expect(await store.increment("k", WINDOW, 1200)).toEqual({ count: 1, firstAt: 1200 });
    });

    it("peek reflects the live count and clears an expired window", async () => {
        const store = new InMemoryAtomicCounterStore();
        await store.increment("k", WINDOW, 0);
        expect(await store.peek("k", WINDOW, 100)).toEqual({ count: 1, firstAt: 0 });
        expect(await store.peek("k", WINDOW, 5000)).toBeNull();   // expired
        expect(await store.peek("missing", WINDOW, 0)).toBeNull();
    });

    it("increments are atomic under concurrency (no lost updates)", async () => {
        const store = new InMemoryAtomicCounterStore();
        const results = await Promise.all(
            Array.from({ length: 50 }, () => store.increment("k", WINDOW, 0)),
        );
        expect(Math.max(...results.map(r => r.count))).toBe(50);
        expect(await store.peek("k", WINDOW, 0)).toEqual({ count: 50, firstAt: 0 });
    });

    it("reset drops the key", async () => {
        const store = new InMemoryAtomicCounterStore();
        await store.increment("k", WINDOW, 0);
        await store.reset("k");
        expect(await store.peek("k", WINDOW, 0)).toBeNull();
    });
});

describe("SupabaseAtomicCounterStore", () => {
    it("delegates the atomic increment to the shared RPC", async () => {
        const rpc = vi.fn().mockResolvedValue({ data: { count: 3, first_at: 10 }, error: null });
        const store = new SupabaseAtomicCounterStore({ rpc });
        expect(await store.increment("k", WINDOW, 10)).toEqual({ count: 3, firstAt: 10 });
        expect(rpc).toHaveBeenCalledWith("omr_rate_limit_hit", { p_key: "k", p_window_ms: WINDOW, p_now: 10 });
    });

    it("surfaces RPC errors instead of silently allowing the request", async () => {
        const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } });
        const store = new SupabaseAtomicCounterStore({ rpc });
        await expect(store.increment("k", WINDOW, 0)).rejects.toThrow("boom");
    });
});
