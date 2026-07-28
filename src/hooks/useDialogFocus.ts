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

export function resolveDialogKeyAction(
    key: string,
    atLast: boolean,
    atFirst?: boolean,
): DialogKeyAction;
export function resolveDialogKeyAction(state: DialogKeyState): DialogKeyAction;
export function resolveDialogKeyAction(
    stateOrKey: DialogKeyState | string,
    atLast = false,
    atFirst = false,
): DialogKeyAction {
    if (typeof stateOrKey === "string") {
        if (stateOrKey === "Escape") return "close";
        if (stateOrKey !== "Tab") return "none";
        if (atLast) return "wrap-first";
        if (atFirst) return "wrap-last";
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
    return style.display !== "none"
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
                    onCloseRef.current();
                } else if (event.key === "Tab") {
                    event.preventDefault();
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
                onCloseRef.current();
            } else if (action === "wrap-first") {
                event.preventDefault();
                first.focus({ preventScroll: true });
            } else if (action === "wrap-last") {
                event.preventDefault();
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
