export interface Point {
    x: number;
    y: number;
}

/** Shortest distance from point (px,py) to segment (ax,ay)-(bx,by), same units. */
export function distanceToSegmentPx(
    px: number,
    py: number,
    ax: number,
    ay: number,
    bx: number,
    by: number,
): number {
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) {
        return Math.hypot(px - ax, py - ay);
    }
    let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t * dx;
    const cy = ay + t * dy;
    return Math.hypot(px - cx, py - cy);
}

/**
 * True if pointer (pointerX,pointerY) is within radiusPx of any segment of the
 * stroke polyline. Coordinates are in the same (px) space. Uses a bounding-box
 * early-out; a single-point stroke is treated as a dot.
 */
export function strokeHitTest(
    pointerX: number,
    pointerY: number,
    strokePointsPx: Point[],
    radiusPx: number,
): boolean {
    if (strokePointsPx.length === 0) return false;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const pt of strokePointsPx) {
        if (pt.x < minX) minX = pt.x;
        if (pt.y < minY) minY = pt.y;
        if (pt.x > maxX) maxX = pt.x;
        if (pt.y > maxY) maxY = pt.y;
    }
    if (
        pointerX < minX - radiusPx ||
        pointerX > maxX + radiusPx ||
        pointerY < minY - radiusPx ||
        pointerY > maxY + radiusPx
    ) {
        return false;
    }

    if (strokePointsPx.length === 1) {
        const only = strokePointsPx[0];
        return Math.hypot(pointerX - only.x, pointerY - only.y) <= radiusPx;
    }

    for (let i = 0; i < strokePointsPx.length - 1; i++) {
        const a = strokePointsPx[i];
        const b = strokePointsPx[i + 1];
        if (distanceToSegmentPx(pointerX, pointerY, a.x, a.y, b.x, b.y) <= radiusPx) {
            return true;
        }
    }
    return false;
}
