// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEditorDraftAutosave } from "./useEditorDraftAutosave";

beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); });
function input(persist: () => boolean = vi.fn(() => true)) {
    return { scopeKey: "scoped-new", enabled: true, intervalMs: 30_000, revision: "first", flushOnExit: true, persist };
}

describe("committed draft departure flush", () => {
    it("keeps the idle interval and only flushes the latest committed callback on SPA unmount", () => {
        const previous = input();
        const view = renderHook(useEditorDraftAutosave, { initialProps: previous });
        act(() => vi.advanceTimersByTime(13_000));
        expect(previous.persist).not.toHaveBeenCalled();
        const latest = { ...previous, revision: "latest", persist: vi.fn(() => true) };
        view.rerender(latest);
        view.unmount();
        expect(previous.persist).not.toHaveBeenCalled();
        expect(latest.persist).toHaveBeenCalledTimes(1);
        act(() => vi.advanceTimersByTime(60_000));
        expect(latest.persist).toHaveBeenCalledTimes(1);
    });

    it("flushes each departing scope under its own callback before adopting the next scope", () => {
        const first = input();
        const view = renderHook(useEditorDraftAutosave, { initialProps: first });
        const next = { ...first, scopeKey: "scoped-exam-2", revision: "other", persist: vi.fn(() => true) };
        view.rerender(next);
        expect(first.persist).toHaveBeenCalledTimes(1);
        expect(next.persist).not.toHaveBeenCalled();
        view.unmount();
        expect(next.persist).toHaveBeenCalledTimes(1);
    });

    it("flushes Back and pagehide without repeated writes or replacing browser history", () => {
        const state = input();
        const pushState = vi.spyOn(window.history, "pushState");
        const replaceState = vi.spyOn(window.history, "replaceState");
        const view = renderHook(useEditorDraftAutosave, { initialProps: state });
        window.dispatchEvent(new PopStateEvent("popstate"));
        window.dispatchEvent(new Event("pagehide"));
        view.unmount();
        expect(state.persist).toHaveBeenCalledTimes(1);
        expect(pushState).not.toHaveBeenCalled();
        expect(replaceState).not.toHaveBeenCalled();
        pushState.mockRestore();
        replaceState.mockRestore();
    });

    it("keeps a failed revision pending and retries it on departure", () => {
        const persist = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
        const view = renderHook(useEditorDraftAutosave, { initialProps: input(persist) });
        act(() => vi.advanceTimersByTime(30_000));
        expect(persist).toHaveBeenCalledTimes(1);
        view.unmount();
        expect(persist).toHaveBeenCalledTimes(2);
    });

    it.each([{ enabled: false }, { intervalMs: 0 }, { scopeKey: "" }])("never writes disabled, restore-pending, or unscoped departure state %j", override => {
        const state = { ...input(), ...override };
        const view = renderHook(useEditorDraftAutosave, { initialProps: state });
        act(() => vi.advanceTimersByTime(60_000));
        window.dispatchEvent(new PopStateEvent("popstate"));
        view.unmount();
        expect(state.persist).not.toHaveBeenCalled();
        const clean = { ...input(), flushOnExit: false };
        renderHook(useEditorDraftAutosave, { initialProps: clean }).unmount();
        expect(clean.persist).not.toHaveBeenCalled();
    });

    it("cancels pending writes when publish assumes cleanup ownership", () => {
        const state = input();
        const view = renderHook(useEditorDraftAutosave, { initialProps: state });
        act(() => view.result.current());
        act(() => vi.advanceTimersByTime(30_000));
        window.dispatchEvent(new PopStateEvent("popstate"));
        view.unmount();
        expect(state.persist).not.toHaveBeenCalled();
    });
});
