export type DrawingPathMode = "pen" | "highlighter" | "eraser";

export interface DrawingPathPoint {
    x: number;
    y: number;
    p?: number;
}

export interface StoredDrawingPath {
    mode: DrawingPathMode;
    color?: string;
    width?: number;
    points: DrawingPathPoint[];
}

const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;
const PATH_TOKEN = /[ML]|[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g;

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNormalizedPoint(value: unknown): value is DrawingPathPoint {
    if (!isRecord(value) || typeof value.x !== "number" || typeof value.y !== "number") return false;
    if (!Number.isFinite(value.x) || !Number.isFinite(value.y)) return false;
    if (value.x < 0 || value.x > 1 || value.y < 0 || value.y > 1) return false;
    return value.p === undefined || (typeof value.p === "number" && Number.isFinite(value.p));
}

function parseJsonDrawingPath(path: string): StoredDrawingPath | null {
    try {
        const parsed: unknown = JSON.parse(path);
        if (!isRecord(parsed) || !Array.isArray(parsed.points) || parsed.points.length === 0) return null;
        if (!parsed.points.every(isNormalizedPoint)) return null;
        return {
            mode: parsed.mode === "highlighter" || parsed.mode === "eraser" || parsed.mode === "pen" ? parsed.mode : "pen",
            color: typeof parsed.color === "string" && parsed.color.trim() ? parsed.color : undefined,
            width: typeof parsed.width === "number" && Number.isFinite(parsed.width) ? Math.max(0.5, parsed.width) : undefined,
            points: parsed.points.map(point => point.p === undefined ? { x: point.x, y: point.y } : { x: point.x, y: point.y, p: point.p }),
        };
    } catch {
        return null;
    }
}

function parseLegacySvgPolyline(path: string): StoredDrawingPath | null {
    const tokens: string[] = [];
    let lastIndex = 0;
    for (const match of path.matchAll(PATH_TOKEN)) {
        if (!/^[\s,]*$/.test(path.slice(lastIndex, match.index))) return null;
        tokens.push(match[0]);
        lastIndex = (match.index || 0) + match[0].length;
    }
    if (!/^[\s,]*$/.test(path.slice(lastIndex)) || tokens.length < 6 || tokens[0] !== "M") return null;

    const points: DrawingPathPoint[] = [];
    let index = 1;
    const readPoint = (): DrawingPathPoint | null => {
        const x = Number(tokens[index++]);
        const y = Number(tokens[index++]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        return { x: x / A4_WIDTH, y: y / A4_HEIGHT };
    };

    const firstPoint = readPoint();
    if (!firstPoint) return null;
    points.push(firstPoint);
    while (index < tokens.length) {
        if (tokens[index++] !== "L") return null;
        const point = readPoint();
        if (!point) return null;
        points.push(point);
    }

    return points.length > 1 ? { mode: "pen", points } : null;
}

/**
 * Parse modern normalized JSON strokes and legacy A4 SVG M/L polylines.
 * Invalid or unsupported data is ignored so historical annotations never break rendering.
 */
export function parseStoredDrawingPath(path: string): StoredDrawingPath | null {
    if (typeof path !== "string" || !path.trim()) return null;
    return path.trimStart().startsWith("{") ? parseJsonDrawingPath(path) : parseLegacySvgPolyline(path);
}
