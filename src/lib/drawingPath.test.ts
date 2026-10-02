import { describe, expect, it } from "vitest";
import { parseStoredDrawingPath } from "./drawingPath";

describe("stored drawing path compatibility", () => {
    it("parses the current normalized JSON stroke format", () => {
        expect(parseStoredDrawingPath(JSON.stringify({
            mode: "highlighter",
            color: "#facc15",
            width: 12,
            points: [{ x: 0.2, y: 0.3 }, { x: 0.4, y: 0.5 }],
        }))).toEqual({
            mode: "highlighter",
            color: "#facc15",
            width: 12,
            points: [{ x: 0.2, y: 0.3 }, { x: 0.4, y: 0.5 }],
        });
    });

    it("converts legacy SVG M/L fixture strokes into normalized page points", () => {
        const parsed = parseStoredDrawingPath("M 120 180 L 210 180 L 210 260");

        expect(parsed).not.toBeNull();
        expect(parsed?.mode).toBe("pen");
        expect(parsed?.points).toHaveLength(3);
        expect(parsed?.points[0].x).toBeCloseTo(120 / 595.28, 4);
        expect(parsed?.points[0].y).toBeCloseTo(180 / 841.89, 4);
        expect(parsed?.points[2].x).toBeCloseTo(210 / 595.28, 4);
        expect(parsed?.points[2].y).toBeCloseTo(260 / 841.89, 4);
    });

    it("rejects malformed or unsupported path payloads without throwing", () => {
        expect(parseStoredDrawingPath("not a path")).toBeNull();
        expect(parseStoredDrawingPath('{"points":[{"x":"bad","y":1}]}')).toBeNull();
        expect(parseStoredDrawingPath("M 10 20 C 30 40 50 60 70 80")).toBeNull();
    });
});
