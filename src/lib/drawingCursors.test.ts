import { describe, expect, it } from "vitest";
import { buildHighlighterCursor, buildPenCursor } from "./drawingCursors";

describe("buildPenCursor", () => {
    it("embeds the color with # encoded as %23", () => {
        const cursor = buildPenCursor("#ef4444");
        expect(cursor).toContain("%23ef4444");
        expect(cursor).not.toContain("#ef4444");
    });

    it("is an SVG data URI with a hotspot and a keyword fallback", () => {
        const cursor = buildPenCursor("#111827");
        expect(cursor).toContain("data:image/svg+xml,");
        expect(cursor.trim().endsWith(", crosshair")).toBe(true);
        // hotspot: `url(...) X Y, crosshair`
        expect(cursor).toMatch(/\)\s+\d+\s+\d+,\s*crosshair$/);
    });

    it("contains no raw angle brackets (fully URL-encoded)", () => {
        const cursor = buildPenCursor("#16a34a");
        expect(cursor).not.toContain("<");
        expect(cursor).not.toContain(">");
    });

    it("renders 7% smaller than the 32px design size", () => {
        const cursor = buildPenCursor("#111827");
        expect(cursor).toContain("width='29.76'");
        expect(cursor).toContain("height='29.76'");
        expect(cursor).not.toContain("width='32'");
    });
});

describe("buildHighlighterCursor", () => {
    it("is an SVG data URI with a keyword fallback and no raw #", () => {
        const cursor = buildHighlighterCursor();
        expect(cursor).toContain("data:image/svg+xml,");
        expect(cursor.trim().endsWith(", crosshair")).toBe(true);
        expect(cursor).not.toContain("#");
    });

    it("renders 7% smaller than the 32px design size", () => {
        const cursor = buildHighlighterCursor();
        expect(cursor).toContain("width='29.76'");
        expect(cursor).not.toContain("width='32'");
    });
});
