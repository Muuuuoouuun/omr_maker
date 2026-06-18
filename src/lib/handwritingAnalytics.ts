import type { PdfDrawings, Question, QuestionDrawingSummary, QuestionPdfRegion } from "@/types/omr";

interface DrawingPoint {
    x: number;
    y: number;
}

interface ParsedDrawingPath {
    mode: string;
    points: DrawingPoint[];
}

interface LocatedQuestion {
    question: Question;
    x: number;
    y: number;
}

interface ColumnCluster {
    centerX: number;
    items: LocatedQuestion[];
}

const REGION_PADDING = 0.015;
const COLUMN_CLUSTER_THRESHOLD = 0.18;
const ROW_CLUSTER_THRESHOLD = 0.065;
const DEFAULT_ROW_GAP = 0.28;
const MIN_ROW_GAP = 0.16;
const MAX_ROW_GAP = 0.42;
const MIN_REGION_HEIGHT = 0.12;
const PAGE_EDGE_PADDING_X = 0.035;
const COLUMN_GUTTER_PADDING = 0.012;
const QUESTION_SIDE_PADDING = 0.018;
const QUESTION_TOP_PADDING = 0.004;
const QUESTION_BOTTOM_PADDING = 0.006;
const SINGLE_COLUMN_BREAK_LEFT = 0.42;
const SINGLE_COLUMN_BREAK_RIGHT = 0.58;
const TWO_COLUMN_PAGE_BREAK_X = 0.5;
const LOWER_LAST_ROW_Y = 0.35;
const MID_PAGE_LAST_ROW_Y = 0.5;
const PAGE_CONTENT_BOTTOM = 0.925;
const LAST_ROW_GAP_MULTIPLIER = 1.55;
const MIN_LAST_ROW_EXTENSION = 0.26;
const MIN_MID_PAGE_LAST_ROW_EXTENSION = 0.41;
const MIN_TOP_SINGLE_ROW_EXTENSION = 0.6;

function isFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

function clamp(value: number, min = 0, max = 1): number {
    return Math.min(max, Math.max(min, value));
}

function median(values: number[]): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) return sorted[middle];
    return (sorted[middle - 1] + sorted[middle]) / 2;
}

function sanitizeRegion(region: QuestionPdfRegion): QuestionPdfRegion {
    const x = clamp(region.x);
    const y = clamp(region.y);
    const width = clamp(region.width, 0, 1 - x);
    const height = clamp(region.height, 0, 1 - y);

    return {
        page: region.page,
        x,
        y,
        width,
        height,
    };
}

function expandRegion(region: QuestionPdfRegion, padding = REGION_PADDING): QuestionPdfRegion {
    const x = clamp(region.x - padding);
    const y = clamp(region.y - padding);
    const right = clamp(region.x + region.width + padding);
    const bottom = clamp(region.y + region.height + padding);

    return {
        page: region.page,
        x,
        y,
        width: Math.max(0, right - x),
        height: Math.max(0, bottom - y),
    };
}

function isPoint(value: unknown): value is DrawingPoint {
    if (!value || typeof value !== "object") return false;
    const point = value as Partial<DrawingPoint>;
    return isFiniteNumber(point.x) && isFiniteNumber(point.y);
}

function parseDrawingPath(serialized: string): ParsedDrawingPath | null {
    try {
        const parsed = JSON.parse(serialized) as {
            mode?: unknown;
            points?: unknown;
        };
        if (!Array.isArray(parsed.points)) return null;

        const points = parsed.points
            .filter(isPoint)
            .map(point => ({ x: clamp(point.x), y: clamp(point.y) }));
        if (points.length === 0) return null;

        return {
            mode: typeof parsed.mode === "string" ? parsed.mode : "pen",
            points,
        };
    } catch {
        return null;
    }
}

function pathBounds(path: ParsedDrawingPath): QuestionPdfRegion {
    const xs = path.points.map(point => point.x);
    const ys = path.points.map(point => point.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);

    return {
        page: 0,
        x: minX,
        y: minY,
        width: Math.max(0, maxX - minX),
        height: Math.max(0, maxY - minY),
    };
}

function pointInRegion(point: DrawingPoint, region: QuestionPdfRegion): boolean {
    return (
        point.x >= region.x &&
        point.x <= region.x + region.width &&
        point.y >= region.y &&
        point.y <= region.y + region.height
    );
}

function regionsIntersect(a: QuestionPdfRegion, b: QuestionPdfRegion): boolean {
    return (
        a.x <= b.x + b.width &&
        a.x + a.width >= b.x &&
        a.y <= b.y + b.height &&
        a.y + a.height >= b.y
    );
}

function pathIntersectsRegion(path: ParsedDrawingPath, region: QuestionPdfRegion): boolean {
    const paddedRegion = expandRegion(region);
    if (path.points.some(point => pointInRegion(point, paddedRegion))) return true;
    return regionsIntersect(pathBounds(path), paddedRegion);
}

function addToColumn(columns: ColumnCluster[], item: LocatedQuestion) {
    const closest = [...columns]
        .sort((a, b) => Math.abs(a.centerX - item.x) - Math.abs(b.centerX - item.x))[0];

    if (closest && Math.abs(closest.centerX - item.x) <= COLUMN_CLUSTER_THRESHOLD) {
        closest.items.push(item);
        closest.centerX = closest.items.reduce((sum, current) => sum + current.x, 0) / closest.items.length;
        return;
    }

    columns.push({ centerX: item.x, items: [item] });
}

function estimateTypicalRowGap(pageItems: LocatedQuestion[]): number {
    const rowCenters: number[] = [];

    for (const item of [...pageItems].sort((a, b) => a.y - b.y)) {
        const lastIndex = rowCenters.length - 1;
        const lastCenter = rowCenters[lastIndex];
        if (lastCenter !== undefined && Math.abs(lastCenter - item.y) <= ROW_CLUSTER_THRESHOLD) {
            rowCenters[lastIndex] = (lastCenter + item.y) / 2;
        } else {
            rowCenters.push(item.y);
        }
    }

    const gaps = rowCenters
        .slice(1)
        .map((center, index) => center - rowCenters[index])
        .filter(gap => gap > ROW_CLUSTER_THRESHOLD);
    const typicalGap = median(gaps) ?? DEFAULT_ROW_GAP;
    return clamp(typicalGap, MIN_ROW_GAP, MAX_ROW_GAP);
}

function bottomWithMinimumHeight(top: number, bottom: number): number {
    return clamp(Math.max(bottom, top + MIN_REGION_HEIGHT), 0, 1);
}

function inferColumnBounds(sortedColumns: ColumnCluster[], columnIndex: number): { left: number; right: number } {
    const column = sortedColumns[columnIndex];
    const previousColumn = sortedColumns[columnIndex - 1];
    const nextColumn = sortedColumns[columnIndex + 1];
    const markerLeft = Math.min(...column.items.map(item => item.x)) - QUESTION_SIDE_PADDING;

    if (
        sortedColumns.length === 2 &&
        sortedColumns[0].centerX < SINGLE_COLUMN_BREAK_LEFT &&
        sortedColumns[1].centerX >= SINGLE_COLUMN_BREAK_RIGHT - 0.1
    ) {
        return columnIndex === 0
            ? {
                left: clamp(markerLeft, PAGE_EDGE_PADDING_X, TWO_COLUMN_PAGE_BREAK_X - COLUMN_GUTTER_PADDING - 0.08),
                right: TWO_COLUMN_PAGE_BREAK_X - COLUMN_GUTTER_PADDING,
            }
            : {
                left: clamp(markerLeft, TWO_COLUMN_PAGE_BREAK_X + COLUMN_GUTTER_PADDING, 1 - PAGE_EDGE_PADDING_X - 0.08),
                right: 1 - PAGE_EDGE_PADDING_X,
            };
    }

    if (sortedColumns.length === 1) {
        if (column.centerX <= SINGLE_COLUMN_BREAK_LEFT) {
            return {
                left: clamp(markerLeft, PAGE_EDGE_PADDING_X, 0.5 - COLUMN_GUTTER_PADDING - 0.08),
                right: 0.5 - COLUMN_GUTTER_PADDING,
            };
        }
        if (column.centerX >= SINGLE_COLUMN_BREAK_RIGHT) {
            return {
                left: clamp(markerLeft, 0.5 + COLUMN_GUTTER_PADDING, 1 - PAGE_EDGE_PADDING_X - 0.08),
                right: 1 - PAGE_EDGE_PADDING_X,
            };
        }
        return {
            left: clamp(markerLeft, PAGE_EDGE_PADDING_X, 1 - PAGE_EDGE_PADDING_X - 0.08),
            right: 1 - PAGE_EDGE_PADDING_X,
        };
    }

    const columnBoundaryLeft = previousColumn
        ? (previousColumn.centerX + column.centerX) / 2 + COLUMN_GUTTER_PADDING
        : PAGE_EDGE_PADDING_X;
    const right = nextColumn
        ? (column.centerX + nextColumn.centerX) / 2 - COLUMN_GUTTER_PADDING
        : 1 - PAGE_EDGE_PADDING_X;
    const left = Math.max(columnBoundaryLeft, markerLeft);

    return {
        left: clamp(left, PAGE_EDGE_PADDING_X, 1 - PAGE_EDGE_PADDING_X),
        right: clamp(Math.max(right, left + 0.08), PAGE_EDGE_PADDING_X, 1 - PAGE_EDGE_PADDING_X),
    };
}

function inferRowTop(item: LocatedQuestion): number {
    return clamp(item.y - QUESTION_TOP_PADDING, 0, item.y);
}

function inferRowBottom(
    item: LocatedQuestion,
    nextRow: LocatedQuestion | undefined,
    typicalGap: number,
    top: number,
): number {
    const lastRowMinimumExtension = item.y < MID_PAGE_LAST_ROW_Y
        ? MIN_MID_PAGE_LAST_ROW_EXTENSION
        : MIN_LAST_ROW_EXTENSION;
    const bottom = nextRow
        ? nextRow.y - QUESTION_BOTTOM_PADDING
        : item.y >= LOWER_LAST_ROW_Y
            ? Math.min(
                PAGE_CONTENT_BOTTOM,
                item.y + Math.max(typicalGap * LAST_ROW_GAP_MULTIPLIER, lastRowMinimumExtension),
            )
            : Math.min(PAGE_CONTENT_BOTTOM, item.y + Math.max(typicalGap * LAST_ROW_GAP_MULTIPLIER, MIN_TOP_SINGLE_ROW_EXTENSION));
    return bottomWithMinimumHeight(top, bottom);
}

export function inferQuestionPdfRegions(questions: Question[]): Map<number, QuestionPdfRegion> {
    const regions = new Map<number, QuestionPdfRegion>();
    const byPage = new Map<number, LocatedQuestion[]>();

    for (const question of questions) {
        if (question.pdfRegion) {
            regions.set(question.id, sanitizeRegion(question.pdfRegion));
            continue;
        }

        if (!question.pdfLocation) continue;
        const pageItems = byPage.get(question.pdfLocation.page) || [];
        pageItems.push({
            question,
            x: clamp(question.pdfLocation.x),
            y: clamp(question.pdfLocation.y),
        });
        byPage.set(question.pdfLocation.page, pageItems);
    }

    for (const [page, pageItems] of byPage.entries()) {
        const columns: ColumnCluster[] = [];
        for (const item of [...pageItems].sort((a, b) => a.x - b.x)) {
            addToColumn(columns, item);
        }

        const sortedColumns = columns.sort((a, b) => a.centerX - b.centerX);
        const typicalRowGap = estimateTypicalRowGap(pageItems);
        sortedColumns.forEach((column, columnIndex) => {
            const { left, right } = inferColumnBounds(sortedColumns, columnIndex);
            const items = [...column.items].sort((a, b) => a.y - b.y);

            items.forEach((item, rowIndex) => {
                const nextRow = items[rowIndex + 1];
                const top = inferRowTop(item);
                const bottom = inferRowBottom(item, nextRow, typicalRowGap, top);

                regions.set(item.question.id, sanitizeRegion({
                    page,
                    x: left,
                    y: top,
                    width: right - left,
                    height: bottom - top,
                }));
            });
        });
    }

    return regions;
}

export function attachInferredQuestionPdfRegions(
    questions: Question[],
    options: { overwriteExisting?: boolean } = {},
): Question[] {
    const regionSource = options.overwriteExisting
        ? questions.map(question => question.pdfLocation
            ? { ...question, pdfRegion: undefined }
            : question
        )
        : questions;
    const regionsByQuestionId = inferQuestionPdfRegions(regionSource);

    return questions.map(question => {
        const region = regionsByQuestionId.get(question.id);
        if (!region) return question;
        if (!options.overwriteExisting && question.pdfRegion) return question;
        return { ...question, pdfRegion: region };
    });
}

export function summarizeQuestionDrawings(questions: Question[], drawings: PdfDrawings): QuestionDrawingSummary[] {
    const regionsByQuestionId = inferQuestionPdfRegions(questions);
    const pathsByPage = new Map<number, ParsedDrawingPath[]>();

    for (const [pageRaw, serializedPaths] of Object.entries(drawings)) {
        const page = Number(pageRaw);
        if (!Number.isFinite(page)) continue;

        const parsedPaths = serializedPaths
            .map(parseDrawingPath)
            .filter((path): path is ParsedDrawingPath => !!path && path.mode !== "eraser");
        if (parsedPaths.length > 0) pathsByPage.set(page, parsedPaths);
    }

    return questions
        .map(question => {
            const region = regionsByQuestionId.get(question.id);
            if (!region) return null;
            const pagePaths = pathsByPage.get(region.page) || [];
            const strokeCount = pagePaths.filter(path => pathIntersectsRegion(path, region)).length;
            if (strokeCount <= 0) return null;

            return {
                questionId: question.id,
                questionNumber: question.number,
                page: region.page,
                strokeCount,
            };
        })
        .filter((summary): summary is QuestionDrawingSummary => !!summary)
        .sort((a, b) => a.questionNumber - b.questionNumber);
}
