import { useEffect } from "react";

/** Covers refresh/tab close. In-app navigation still needs its own recovery flow. */
export function useUnsavedChangesWarning(hasUnsavedChanges: boolean) {
    useEffect(() => {
        if (!hasUnsavedChanges) return;
        const onBeforeUnload = (event: BeforeUnloadEvent) => {
            event.preventDefault();
            event.returnValue = "";
        };
        window.addEventListener("beforeunload", onBeforeUnload);
        return () => window.removeEventListener("beforeunload", onBeforeUnload);
    }, [hasUnsavedChanges]);
}
