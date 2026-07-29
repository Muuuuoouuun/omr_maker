import { useEffect, useRef } from "react";

export const DIALOG_FOCUSABLE_SELECTOR = [
    'button:not([disabled]):not([aria-disabled="true"])',
    'a[href]:not([aria-disabled="true"])',
    'input:not([disabled]):not([type="hidden"]):not([aria-disabled="true"])',
    'select:not([disabled]):not([aria-disabled="true"])',
    'textarea:not([disabled]):not([aria-disabled="true"])',
    '[tabindex]:not([tabindex="-1"]):not([disabled]):not([aria-disabled="true"])',
].join(", ");

export type DialogKeyAction = "close" | "wrap-first" | "wrap-last" | "none";

export interface DialogKeyState {
    key: string;
    shiftKey: boolean;
    atFirst: boolean;
    atLast: boolean;
}

/** Preferred API: key direction and focus boundaries are explicit. */
export function resolveDialogKeyAction(state: DialogKeyState): DialogKeyAction;
/**
 * @deprecated Legacy positional compatibility retained for the approved plan.
 * Prefer the object overload. With two arguments, `atLast=true` wraps forward
 * and `atLast=false` represents the legacy backward edge. With three arguments,
 * `atFirst` is explicit, so `(key, false, false)` returns `"none"`.
 */
export function resolveDialogKeyAction(
    key: string,
    atLast: boolean,
    atFirst?: boolean,
): DialogKeyAction;
export function resolveDialogKeyAction(
    stateOrKey: DialogKeyState | string,
    ...positional: [atLast?: boolean, atFirst?: boolean]
): DialogKeyAction {
    const [atLast = false, atFirst = false] = positional;
    if (typeof stateOrKey === "string") {
        if (stateOrKey === "Escape") return "close";
        if (stateOrKey !== "Tab") return "none";
        if (atLast) return "wrap-first";
        // The approved two-argument contract uses `false` for the backward edge;
        // three arguments provide the explicit atFirst value.
        if (positional.length === 1 || atFirst) return "wrap-last";
        return "none";
    }
    const state = stateOrKey;
    if (state.key === "Escape") return "close";
    if (state.key !== "Tab") return "none";
    if (!state.shiftKey && state.atLast) return "wrap-first";
    if (state.shiftKey && state.atFirst) return "wrap-last";
    return "none";
}

function isRenderedFocusable(element: HTMLElement): boolean {
    if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    const style = window.getComputedStyle(element);
    return element.tabIndex >= 0
        && style.display !== "none"
        && style.visibility !== "hidden"
        && element.getClientRects().length > 0;
}

function getFocusableElements(dialog: HTMLElement): HTMLElement[] {
    return Array.from(
        dialog.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE_SELECTOR),
    ).filter(isRenderedFocusable);
}

export function useDialogFocus(
    isOpen: boolean,
    onClose: () => void,
) {
    const dialogRef = useRef<HTMLDivElement>(null);
    const onCloseRef = useRef(onClose);

    useEffect(() => {
        onCloseRef.current = onClose;
    }, [onClose]);

    useEffect(() => {
        if (!isOpen) return;
        const dialog = dialogRef.current;
        if (!dialog) return;

        const activeElement = document.activeElement;
        const trigger = activeElement instanceof HTMLElement
            ? activeElement
            : null;
        const initialFocus = getFocusableElements(dialog)[0] ?? dialog;
        initialFocus.focus({ preventScroll: true });

        const handleKeyDown = (event: KeyboardEvent) => {
            const focusable = getFocusableElements(dialog);
            if (focusable.length === 0) {
                if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    onCloseRef.current();
                } else if (event.key === "Tab") {
                    event.preventDefault();
                    event.stopPropagation();
                    dialog.focus({ preventScroll: true });
                }
                return;
            }

            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            const action = resolveDialogKeyAction({
                key: event.key,
                shiftKey: event.shiftKey,
                atFirst: document.activeElement === first,
                atLast: document.activeElement === last,
            });

            if (action === "close") {
                event.preventDefault();
                event.stopPropagation();
                onCloseRef.current();
            } else if (action === "wrap-first") {
                event.preventDefault();
                event.stopPropagation();
                first.focus({ preventScroll: true });
            } else if (action === "wrap-last") {
                event.preventDefault();
                event.stopPropagation();
                last.focus({ preventScroll: true });
            }
        };

        dialog.addEventListener("keydown", handleKeyDown);
        return () => {
            dialog.removeEventListener("keydown", handleKeyDown);
            if (trigger?.isConnected) {
                trigger.focus({ preventScroll: true });
            }
        };
    }, [isOpen]);

    return dialogRef;
}
