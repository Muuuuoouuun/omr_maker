// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useUnsavedChangesWarning } from "./useUnsavedChangesWarning";

afterEach(cleanup);

function closeTab() {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
}

describe("unsaved exam departure warning", () => {
    it("does not interrupt a fresh unchanged exam", () => {
        renderHook(() => useUnsavedChangesWarning(false));
        expect(closeTab()).toBe(false);
    });
    it("protects a changed new exam and clears the listener when it becomes clean", () => {
        const view = renderHook(({ dirty }) => useUnsavedChangesWarning(dirty), { initialProps: { dirty: false } });
        view.rerender({ dirty: true });
        expect(closeTab()).toBe(true);
        view.rerender({ dirty: false });
        expect(closeTab()).toBe(false);
    });
    it("removes the warning on unmount so other routes are not trapped", () => {
        const view = renderHook(() => useUnsavedChangesWarning(true));
        expect(closeTab()).toBe(true);
        view.unmount();
        expect(closeTab()).toBe(false);
    });
});
