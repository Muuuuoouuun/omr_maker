import type { PdfDrawings, StoredDataRef } from "@/types/omr";

export async function saveChangedDraftDrawings({
    drawings,
    lastPersistedDrawings,
    drawingsRef,
    save,
}: {
    drawings: PdfDrawings | undefined;
    lastPersistedDrawings: PdfDrawings | null;
    drawingsRef: StoredDataRef | undefined;
    save: (drawings: PdfDrawings) => Promise<StoredDataRef | undefined>;
}): Promise<{ drawingsRef: StoredDataRef | undefined; persistedDrawings: PdfDrawings | null }> {
    // Timer and answer changes retain this immutable reference. Check it before
    // traversing or copying a potentially large handwriting payload.
    if (!drawings || drawings === lastPersistedDrawings) {
        return { drawingsRef, persistedDrawings: lastPersistedDrawings };
    }
    const compacted = Object.fromEntries(
        Object.entries(drawings)
            .filter(([, paths]) => paths.length > 0)
            .map(([page, paths]) => [page, [...paths]]),
    ) as PdfDrawings;
    // Erasing the final stroke must also clear the old reference, otherwise
    // resuming the draft restores handwriting the student already removed.
    if (Object.keys(compacted).length === 0) {
        return { drawingsRef: undefined, persistedDrawings: drawings };
    }
    const nextRef = await save(compacted);
    if (!nextRef) throw new Error("Failed to save draft drawings");
    return { drawingsRef: nextRef, persistedDrawings: drawings };
}
