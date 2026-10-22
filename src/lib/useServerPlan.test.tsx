// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getServerPlanSnapshot, type ServerPlanSnapshot } from "@/app/actions/premiumAccess";
import { useServerPlan } from "./useServerPlan";

vi.mock("@/app/actions/premiumAccess", () => ({ getServerPlanSnapshot: vi.fn() }));
const getSnapshot = vi.mocked(getServerPlanSnapshot);

function deferredSnapshot() {
    let resolve!: (value: ServerPlanSnapshot) => void;
    let reject!: (reason: Error) => void;
    const promise = new Promise<ServerPlanSnapshot>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function snapshot(plan: ServerPlanSnapshot["plan"]): ServerPlanSnapshot {
    return {
        authenticated: true,
        authoritative: true,
        plan,
        source: "supabase",
        limits: { exams: 5, students: 30, aiRecognition: 100 },
    };
}

beforeEach(() => { getSnapshot.mockReset(); });
afterEach(() => cleanup());

describe("server plan request lifecycle", () => {
    it("starts fail-closed and clears initial loading when the server responds", async () => {
        const initial = deferredSnapshot();
        getSnapshot.mockReturnValueOnce(initial.promise);
        const { result } = renderHook(useServerPlan);
        expect(result.current).toMatchObject({ plan: "free", loading: true });

        await act(async () => initial.resolve(snapshot("pro")));
        expect(result.current).toMatchObject({ plan: "pro", loading: false });
    });

    it("keeps the newest refresh result when an earlier request completes later", async () => {
        const initial = deferredSnapshot();
        const refreshed = deferredSnapshot();
        getSnapshot.mockReturnValueOnce(initial.promise).mockReturnValueOnce(refreshed.promise);
        const { result } = renderHook(useServerPlan);
        act(() => { void result.current.refresh(); });
        await act(async () => refreshed.resolve(snapshot("pro")));
        expect(result.current).toMatchObject({ plan: "pro", loading: false });

        await act(async () => initial.resolve(snapshot("free")));
        expect(result.current).toMatchObject({ plan: "pro", loading: false });
    });

    it("shows refresh loading and falls back to Free after an authoritative request fails", async () => {
        const refreshed = deferredSnapshot();
        getSnapshot.mockResolvedValueOnce(snapshot("pro")).mockReturnValueOnce(refreshed.promise);
        const { result } = renderHook(useServerPlan);
        await act(async () => undefined);
        expect(result.current.plan).toBe("pro");

        act(() => { void result.current.refresh(); });
        expect(result.current.loading).toBe(true);
        await act(async () => refreshed.reject(new Error("server unavailable")));
        expect(result.current).toMatchObject({
            plan: "free",
            loading: false,
            snapshot: { authoritative: false, error: "server unavailable" },
        });
    });

    it("does not expose stale failures or clear loading while the newest request is pending", async () => {
        const initial = deferredSnapshot();
        const refreshed = deferredSnapshot();
        getSnapshot.mockReturnValueOnce(initial.promise).mockReturnValueOnce(refreshed.promise);
        const { result } = renderHook(useServerPlan);
        act(() => { void result.current.refresh(); });

        await act(async () => initial.reject(new Error("stale request failure")));
        expect(result.current.loading).toBe(true);
        expect(result.current.snapshot.error).toBeUndefined();
        await act(async () => refreshed.resolve(snapshot("pro")));
        expect(result.current).toMatchObject({ plan: "pro", loading: false });
        expect(result.current.snapshot.error).toBeUndefined();
    });
});
