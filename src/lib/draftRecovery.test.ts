import { describe, expect, it } from "vitest";
import { isPdfDrawings, drawingsHaveStrokes, resolveDraftDrawings } from "@/lib/draftRecovery";

describe("isPdfDrawings", () => {
    it("accepts a page→strokes map", () => {
        expect(isPdfDrawings({ 1: ["a", "b"], 2: [] })).toBe(true);
        expect(isPdfDrawings({})).toBe(true);
    });

    it("rejects non-objects, arrays, and non-string strokes", () => {
        expect(isPdfDrawings(null)).toBe(false);
        expect(isPdfDrawings(undefined)).toBe(false);
        expect(isPdfDrawings([])).toBe(false);
        expect(isPdfDrawings({ 1: [1, 2] })).toBe(false);
        expect(isPdfDrawings({ 1: "stroke" })).toBe(false);
    });
});

describe("drawingsHaveStrokes", () => {
    it("is true only when at least one page has strokes", () => {
        expect(drawingsHaveStrokes({ 1: ["a"] })).toBe(true);
        expect(drawingsHaveStrokes({ 1: [], 2: [] })).toBe(false);
        expect(drawingsHaveStrokes({})).toBe(false);
    });
});

describe("resolveDraftDrawings", () => {
    const strokes = { 1: ["path-a"] };

    it("restores the stored IndexedDB record when it has strokes", () => {
        expect(resolveDraftDrawings(strokes, undefined, true)).toEqual({ drawings: strokes, lost: false });
    });

    it("falls back to the inline draft when the stored record is missing", () => {
        const inline = { 2: ["path-b"] };
        expect(resolveDraftDrawings(null, inline, true)).toEqual({ drawings: inline, lost: false });
    });

    it("prefers the stored record over the inline fallback", () => {
        const inline = { 2: ["path-b"] };
        expect(resolveDraftDrawings(strokes, inline, true)).toEqual({ drawings: strokes, lost: false });
    });

    it("flags loss when a referenced record could not be recovered", () => {
        expect(resolveDraftDrawings(null, undefined, true)).toEqual({ drawings: null, lost: true });
        // Evicted record loads as empty: strokes are still gone, so this counts as loss.
        expect(resolveDraftDrawings({}, undefined, true)).toEqual({ drawings: null, lost: true });
    });

    it("does not flag loss when the draft never had handwriting", () => {
        expect(resolveDraftDrawings(null, undefined, false)).toEqual({ drawings: null, lost: false });
        expect(resolveDraftDrawings({}, {}, false)).toEqual({ drawings: null, lost: false });
    });

    it("ignores invalid payloads", () => {
        expect(resolveDraftDrawings({ 1: [42] }, "nope", true)).toEqual({ drawings: null, lost: true });
    });
});
