import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

interface DraftAutosaveScope {
    key: string;
    persist: (() => boolean) | null;
    revision: string;
    savedRevision: string | null;
    flushOnExit: boolean;
}

function persistScope(scope: DraftAutosaveScope) {
    if (!scope.persist || scope.savedRevision === scope.revision) return;
    // Failure must leave this revision pending, so a later exit can retry.
    if (scope.persist()) scope.savedRevision = scope.revision;
}

/**
 * Keep the configured idle debounce, but synchronously flush the last committed
 * metadata before a SPA unmount / editor-slot change, Back, or pagehide. This
 * persists only already-serialized assets; it is not a navigation blocker and
 * cannot serialize newly selected File objects during departure.
 */
export function useEditorDraftAutosave(input: {
    scopeKey: string;
    enabled: boolean;
    intervalMs: number;
    revision: string;
    flushOnExit: boolean;
    persist: () => boolean;
}) {
    const canPersist = input.enabled && Boolean(input.scopeKey) && input.intervalMs > 0;
    const scopeRef = useRef<DraftAutosaveScope | null>(null);
    // Layout cleanup owns the previous scope's callback and runs before the
    // next scope is adopted. Never read next-route state into a departing key.
    useLayoutEffect(() => {
        const scope: DraftAutosaveScope = {
            key: input.scopeKey, persist: null, revision: "", savedRevision: null, flushOnExit: false,
        };
        scopeRef.current = scope;
        return () => {
            if (scope.flushOnExit) persistScope(scope);
            scope.persist = null;
            if (scopeRef.current === scope) scopeRef.current = null;
        };
    }, [input.scopeKey]);
    useLayoutEffect(() => {
        const scope = scopeRef.current;
        if (!scope) return;
        scope.persist = canPersist ? input.persist : null;
        scope.revision = input.revision;
        scope.flushOnExit = canPersist && input.flushOnExit;
    });

    useEffect(() => {
        const scope = scopeRef.current;
        if (!canPersist || !scope) return;
        const handle = setTimeout(() => persistScope(scope), input.intervalMs);
        return () => clearTimeout(handle);
    }, [input.scopeKey, canPersist, input.intervalMs, input.revision, input.persist]);

    useEffect(() => {
        const scope = scopeRef.current;
        const flush = () => { if (scope?.flushOnExit) persistScope(scope); };
        window.addEventListener("popstate", flush);
        window.addEventListener("pagehide", flush);
        return () => {
            window.removeEventListener("popstate", flush);
            window.removeEventListener("pagehide", flush);
        };
    }, [input.scopeKey]);

    // A successful publish owns draft cleanup. Cancel its departure write
    // immediately rather than waiting for React to commit the clean state.
    return useCallback(() => {
        const scope = scopeRef.current;
        if (!scope || scope.key !== input.scopeKey) return;
        scope.persist = null;
        scope.flushOnExit = false;
    }, [input.scopeKey]);
}
