import { describe, expect, it } from "vitest";
import {
    DIALOG_FOCUSABLE_SELECTOR,
    resolveDialogKeyAction,
} from "./useDialogFocus";

describe("dialog focus contract", () => {
    it("selects enabled interactive controls and explicit tab stops", () => {
        expect(DIALOG_FOCUSABLE_SELECTOR).toContain("button:not([disabled])");
        expect(DIALOG_FOCUSABLE_SELECTOR).toContain("a[href]");
        expect(DIALOG_FOCUSABLE_SELECTOR).toContain('input:not([disabled]):not([type="hidden"])');
        expect(DIALOG_FOCUSABLE_SELECTOR).toContain("select:not([disabled])");
        expect(DIALOG_FOCUSABLE_SELECTOR).toContain("textarea:not([disabled])");
        expect(DIALOG_FOCUSABLE_SELECTOR).toContain('[tabindex]:not([tabindex="-1"])');
    });

    it("closes on Escape", () => {
        expect(resolveDialogKeyAction({
            key: "Escape",
            shiftKey: false,
            atFirst: false,
            atLast: false,
        })).toBe("close");
    });

    it("wraps forward from the last control to the first control", () => {
        expect(resolveDialogKeyAction({
            key: "Tab",
            shiftKey: false,
            atFirst: false,
            atLast: true,
        })).toBe("wrap-first");
    });

    it("wraps backward from the first control to the last control", () => {
        expect(resolveDialogKeyAction({
            key: "Tab",
            shiftKey: true,
            atFirst: true,
            atLast: false,
        })).toBe("wrap-last");
    });

    it("leaves ordinary keys and interior Tab navigation to the browser", () => {
        expect(resolveDialogKeyAction({
            key: "Enter",
            shiftKey: false,
            atFirst: false,
            atLast: false,
        })).toBe("none");
        expect(resolveDialogKeyAction({
            key: "Tab",
            shiftKey: false,
            atFirst: true,
            atLast: false,
        })).toBe("none");
        expect(resolveDialogKeyAction({
            key: "Tab",
            shiftKey: true,
            atFirst: false,
            atLast: true,
        })).toBe("none");
    });

    it("supports the approved positional key-action contract", () => {
        expect(resolveDialogKeyAction("Escape", false)).toBe("close");
        expect(resolveDialogKeyAction("Tab", true)).toBe("wrap-first");
        expect(resolveDialogKeyAction("Tab", false)).toBe("wrap-last");
        expect(resolveDialogKeyAction("Tab", false, true)).toBe("wrap-last");
        expect(resolveDialogKeyAction("Tab", false, false)).toBe("none");
        expect(resolveDialogKeyAction("Enter", true, true)).toBe("none");
    });
});
