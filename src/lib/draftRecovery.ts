import type { PdfDrawings } from "@/types/omr";

export function isPdfDrawings(value: unknown): value is PdfDrawings {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    return Object.values(value as Record<string, unknown>).every(paths =>
        Array.isArray(paths) && paths.every(path => typeof path === "string")
    );
}

export function drawingsHaveStrokes(drawings: PdfDrawings): boolean {
    return Object.values(drawings).some(paths => paths.length > 0);
}

export interface DraftDrawingsResolution {
    drawings: PdfDrawings | null;
    /**
     * True only when the draft expected handwriting (it referenced a stored record)
     * but neither the stored record nor an inline fallback could be recovered. The UI
     * uses this to warn that handwriting could not be restored while answers stay intact.
     */
    lost: boolean;
}

/**
 * Decide which handwriting to restore when resuming a saved draft.
 *
 * - `loaded`: the result of loading the IndexedDB `drawingsRef` record. `null`/invalid
 *   when the record was evicted by the browser or failed to load.
 * - `inlineFallback`: a legacy inline `draft.drawings` payload, if the draft predates
 *   IndexedDB spillover.
 * - `hadRef`: whether the draft referenced stored drawings. `drawingsRef` is only written
 *   when strokes existed at save time, so `hadRef` means "this draft had handwriting".
 *
 * Recovery preference: stored record → inline fallback → give up (and flag `lost`).
 */
export function resolveDraftDrawings(
    loaded: unknown,
    inlineFallback: unknown,
    hadRef: boolean,
): DraftDrawingsResolution {
    if (isPdfDrawings(loaded) && drawingsHaveStrokes(loaded)) {
        return { drawings: loaded, lost: false };
    }
    if (isPdfDrawings(inlineFallback) && drawingsHaveStrokes(inlineFallback)) {
        return { drawings: inlineFallback, lost: false };
    }
    return { drawings: null, lost: hadRef };
}
