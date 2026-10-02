// @vitest-environment jsdom
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDialogFocus } from "./useDialogFocus";

function Dialog({ selector, onClose = () => {}, disabled = false, hidden = false }: {
    selector?: string; onClose?: () => void; disabled?: boolean; hidden?: boolean;
}) {
    const ref = useDialogFocus(true, onClose, selector);
    return <div ref={ref} role="dialog" tabIndex={-1}>
        <button>Delete</button>
        <button data-restore disabled={disabled} hidden={hidden}>Restore</button>
    </div>;
}
beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(() => [{ width: 10, height: 10 }] as unknown as DOMRectList);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("dialog rendered focus", () => {
    it("preserves the default caller's first focus and restores its connected trigger", () => {
        const trigger = document.createElement("button");
        document.body.append(trigger);
        trigger.focus();
        const view = render(<Dialog />);
        expect(screen.getByRole("button", { name: "Delete" })).toHaveFocus();
        view.unmount();
        expect(trigger).toHaveFocus();
        trigger.remove();
    });

    it("focuses a safe preferred action without changing Tab order or Escape semantics", () => {
        const onClose = vi.fn();
        render(<Dialog selector="[data-restore]" onClose={onClose} />);
        const restore = screen.getByRole("button", { name: "Restore" });
        const discard = screen.getByRole("button", { name: "Delete" });
        expect(restore).toHaveFocus();
        fireEvent.keyDown(restore, { key: "Tab" });
        expect(discard).toHaveFocus();
        fireEvent.keyDown(discard, { key: "Tab", shiftKey: true });
        expect(restore).toHaveFocus();
        fireEvent.keyDown(restore, { key: "Escape" });
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it.each([
        { selector: "[missing]" },
        { selector: "[invalid" },
        { selector: "[data-restore]", disabled: true },
        { selector: "[data-restore]", hidden: true },
    ])("falls back to the first usable button for an unavailable preference %j", props => {
        render(<Dialog {...props} />);
        expect(screen.getByRole("button", { name: "Delete" })).toHaveFocus();
    });

    it("uses the newest close callback and does not refocus during an ordinary rerender", () => {
        const oldClose = vi.fn();
        const newClose = vi.fn();
        const view = render(<Dialog selector="[data-restore]" onClose={oldClose} />);
        const discard = screen.getByRole("button", { name: "Delete" });
        discard.focus();
        view.rerender(<Dialog selector="[data-restore]" onClose={newClose} />);
        expect(discard).toHaveFocus();
        fireEvent.keyDown(discard, { key: "Escape" });
        expect(oldClose).not.toHaveBeenCalled();
        expect(newClose).toHaveBeenCalledTimes(1);
    });
});
