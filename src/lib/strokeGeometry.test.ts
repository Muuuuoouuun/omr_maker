import { describe, expect, it } from "vitest";
import { distanceToSegmentPx, strokeHitTest, type Point } from "./strokeGeometry";

describe("distanceToSegmentPx", () => {
    it("returns 0 for a point on the segment", () => {
        expect(distanceToSegmentPx(5, 0, 0, 0, 10, 0)).toBe(0);
    });

    it("returns perpendicular distance to the segment body", () => {
        expect(distanceToSegmentPx(5, 3, 0, 0, 10, 0)).toBeCloseTo(3);
    });

    it("clamps to the nearest endpoint when beyond the segment", () => {
        // point is left of A(0,0); nearest is A, distance = 4
        expect(distanceToSegmentPx(-4, 0, 0, 0, 10, 0)).toBeCloseTo(4);
    });

    it("handles a zero-length segment as distance to the point", () => {
        expect(distanceToSegmentPx(3, 4, 0, 0, 0, 0)).toBeCloseTo(5);
    });
});

describe("strokeHitTest", () => {
    const line: Point[] = [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
    ];

    it("hits when pointer is within radius of a segment", () => {
        expect(strokeHitTest(50, 4, line, 6)).toBe(true);
    });

    it("misses when pointer is outside radius", () => {
        expect(strokeHitTest(50, 20, line, 6)).toBe(false);
    });

    it("early-outs via bounding box for far points", () => {
        expect(strokeHitTest(1000, 1000, line, 6)).toBe(false);
    });

    it("treats a single-point stroke as a dot", () => {
        expect(strokeHitTest(2, 0, [{ x: 0, y: 0 }], 3)).toBe(true);
        expect(strokeHitTest(10, 0, [{ x: 0, y: 0 }], 3)).toBe(false);
    });

    it("returns false for an empty stroke", () => {
        expect(strokeHitTest(0, 0, [], 5)).toBe(false);
    });
});
