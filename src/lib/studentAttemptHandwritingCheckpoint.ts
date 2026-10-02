import { parseStoredDrawingPath, type StoredDrawingPath } from "@/lib/drawingPath";
import type { PdfDrawings } from "@/types/omr";

// At the initial 100-student operating target, 64 KiB no more than every 20s
// caps continuous handwriting request bodies near 320 KiB/s. Answer snapshots
// keep their independent 5s cadence, and the final full archive uses Storage.
export const STUDENT_ATTEMPT_HANDWRITING_CHECKPOINT_MAX_BYTES = 64 * 1024;
export const STUDENT_ATTEMPT_HANDWRITING_CHECKPOINT_MS = 20_000;
const MAX_PAGES = 500;
const MAX_STROKES = 2_000;
const MAX_POINTS = 25_000;
const MAX_POINTS_PER_STROKE = 5_000;
const MAX_PATH_BYTES = 32 * 1024;
const SAFE_COLOR = /^#[0-9a-f]{3,8}$/i;

export interface StudentAttemptHandwritingCheckpoint {
    schemaVersion: 1;
    drawings: PdfDrawings;
    pageCount: number;
    strokeCount: number;
}

type ProgressBuildResult =
    | { status: "ready"; payload: Record<string, unknown> }
    | { status: "too_large"; payload: Record<string, unknown> };

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function byteLength(value: unknown): number {
    try {
        return new TextEncoder().encode(JSON.stringify(value)).byteLength;
    } catch {
        return Number.POSITIVE_INFINITY;
    }
}

function canonicalPath(parsed: StoredDrawingPath): string | null {
    if (
        parsed.points.length < 1
        || parsed.points.length > MAX_POINTS_PER_STROKE
        || parsed.points.some(point => (
            !Number.isFinite(point.x)
            || !Number.isFinite(point.y)
            || point.x < 0
            || point.x > 1
            || point.y < 0
            || point.y > 1
            || (point.p !== undefined && (!Number.isFinite(point.p) || point.p < 0 || point.p > 1))
        ))
        || (parsed.color !== undefined && !SAFE_COLOR.test(parsed.color))
        || (parsed.width !== undefined && (!Number.isFinite(parsed.width) || parsed.width < 0.5 || parsed.width > 100))
    ) return null;
    return JSON.stringify({
        mode: parsed.mode,
        ...(parsed.color ? { color: parsed.color } : {}),
        ...(parsed.width !== undefined ? { width: parsed.width } : {}),
        points: parsed.points.map(point => point.p === undefined
            ? { x: point.x, y: point.y }
            : { x: point.x, y: point.y, p: point.p }),
    });
}

/**
 * Accept only geometry the renderer itself understands, then re-serialize it.
 * This removes arbitrary strings/fields before a student payload can cross devices.
 */
export function canonicalStudentAttemptHandwritingCheckpoint(
    value: unknown,
): StudentAttemptHandwritingCheckpoint | null {
    if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.drawings)) return null;
    const entries = Object.entries(value.drawings);
    if (entries.length > MAX_PAGES) return null;

    const drawings: PdfDrawings = {};
    let strokeCount = 0;
    let pointCount = 0;
    const sorted = entries.sort(([left], [right]) => Number(left) - Number(right));
    for (const [rawPage, rawPaths] of sorted) {
        const page = Number(rawPage);
        if (!Number.isInteger(page) || page < 1 || page > 2_000 || String(page) !== rawPage || !Array.isArray(rawPaths)) {
            return null;
        }
        if (rawPaths.length === 0) continue;
        strokeCount += rawPaths.length;
        if (strokeCount > MAX_STROKES) return null;
        const paths: string[] = [];
        for (const rawPath of rawPaths) {
            if (typeof rawPath !== "string" || byteLength(rawPath) > MAX_PATH_BYTES) return null;
            const parsed = parseStoredDrawingPath(rawPath);
            if (!parsed) return null;
            pointCount += parsed.points.length;
            if (pointCount > MAX_POINTS) return null;
            const canonical = canonicalPath(parsed);
            if (!canonical) return null;
            paths.push(canonical);
        }
        drawings[page] = paths;
    }
    const checkpoint: StudentAttemptHandwritingCheckpoint = {
        schemaVersion: 1,
        drawings,
        pageCount: Object.keys(drawings).length,
        strokeCount,
    };
    return byteLength(checkpoint) <= STUDENT_ATTEMPT_HANDWRITING_CHECKPOINT_MAX_BYTES
        ? checkpoint
        : null;
}

export function buildStudentAttemptProgressPayload(
    currentQuestionId: number | null,
    drawings: PdfDrawings,
    includeHandwriting = true,
): ProgressBuildResult {
    const base = Number.isInteger(currentQuestionId) && Number(currentQuestionId) > 0
        ? { currentQuestionId }
        : {};
    if (!includeHandwriting) return { status: "ready", payload: base };
    const checkpoint = canonicalStudentAttemptHandwritingCheckpoint({ schemaVersion: 1, drawings });
    return checkpoint
        ? { status: "ready", payload: { ...base, handwritingCheckpoint: checkpoint } }
        : { status: "too_large", payload: base };
}

export function canonicalStudentAttemptProgressPayload(value: unknown): Record<string, unknown> | null {
    if (!isRecord(value) || byteLength(value) > 524_288) return null;
    const progress: Record<string, unknown> = {};
    if (value.currentQuestionId !== undefined) {
        if (!Number.isSafeInteger(value.currentQuestionId) || Number(value.currentQuestionId) < 1) return null;
        progress.currentQuestionId = Number(value.currentQuestionId);
    }
    if (value.handwritingCheckpoint !== undefined) {
        const checkpoint = canonicalStudentAttemptHandwritingCheckpoint(value.handwritingCheckpoint);
        if (!checkpoint) return null;
        progress.handwritingCheckpoint = checkpoint;
    }
    return progress;
}

export function handwritingCheckpointDrawings(value: unknown): PdfDrawings | null {
    return canonicalStudentAttemptHandwritingCheckpoint(value)?.drawings || null;
}
