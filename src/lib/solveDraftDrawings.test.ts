import { describe, expect, it, vi } from "vitest";
import type { PdfDrawings, StoredDataRef } from "@/types/omr";
import { saveChangedDraftDrawings } from "./solveDraftDrawings";
import { resolveDraftDrawings } from "./draftRecovery";

const oldRef: StoredDataRef = { store: "indexeddb", key: "draft:drawings" };

describe("changed draft handwriting persistence", () => {
    it("skips unchanged strokes before traversing the drawing payload", async () => {
        const drawings: PdfDrawings = {};
        Object.defineProperty(drawings, 1, {
            enumerable: true,
            get: () => { throw new Error("unchanged handwriting must not be traversed"); },
        });
        const save = vi.fn();
        expect(await saveChangedDraftDrawings({ drawings, lastPersistedDrawings: drawings, drawingsRef: oldRef, save }))
            .toEqual({ drawingsRef: oldRef, persistedDrawings: drawings });
        expect(save).not.toHaveBeenCalled();
    });

    it("compacts changed strokes and captures their identity before asynchronous persistence", async () => {
        const drawings: PdfDrawings = { 1: ["stroke-a"], 2: [] };
        let finishSave: (ref: StoredDataRef) => void = () => {};
        const save = vi.fn<(drawings: PdfDrawings) => Promise<StoredDataRef>>(
            () => new Promise<StoredDataRef>(resolve => { finishSave = resolve; }),
        );
        const pending = saveChangedDraftDrawings({ drawings, lastPersistedDrawings: null, drawingsRef: undefined, save });
        const payload = save.mock.calls[0]?.[0];
        expect(payload).toEqual({ 1: ["stroke-a"] });
        expect(payload).not.toBe(drawings);
        expect(payload?.[1]).not.toBe(drawings[1]);

        const nextDrawings = { ...drawings, 1: [...drawings[1], "stroke-b"] };
        finishSave(oldRef);
        const persisted = await pending;
        expect(persisted.persistedDrawings).toBe(drawings);
        expect(persisted.persistedDrawings).not.toBe(nextDrawings);
        expect(drawings).toEqual({ 1: ["stroke-a"], 2: [] });
    });

    it("removes the reference after the final stroke is erased so recovery does not revive it", async () => {
        const erased: PdfDrawings = { 1: [], 2: [] };
        const save = vi.fn();
        const result = await saveChangedDraftDrawings({
            drawings: erased,
            lastPersistedDrawings: { 1: ["erased stroke"] },
            drawingsRef: oldRef,
            save,
        });
        const savedDraft = JSON.parse(JSON.stringify({ answers: { 1: 2 }, drawingsRef: result.drawingsRef }));
        expect(savedDraft).toEqual({ answers: { 1: 2 } });
        expect(resolveDraftDrawings(undefined, undefined, !!savedDraft.drawingsRef)).toEqual({ drawings: null, lost: false });
        expect(result.persistedDrawings).toBe(erased);
        expect(save).not.toHaveBeenCalled();
    });

    it("leaves a failed write dirty for the next retry", async () => {
        const previous: PdfDrawings = { 1: ["old stroke"] };
        const drawings: PdfDrawings = { 1: ["old stroke", "new stroke"] };
        const save = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(oldRef);
        const input = { drawings, lastPersistedDrawings: previous, drawingsRef: oldRef, save };
        await expect(saveChangedDraftDrawings(input)).rejects.toThrow("Failed to save draft drawings");
        expect((await saveChangedDraftDrawings(input)).persistedDrawings).toBe(drawings);
        expect(save).toHaveBeenCalledTimes(2);
    });
});
