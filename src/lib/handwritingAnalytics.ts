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

function isFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

function clamp(value: number, min = 0, max = 1): number {
    return Math.min(max, Math.max(min, value));
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
        sortedColumns.forEach((column, columnIndex) => {
            const previousColumn = sortedColumns[columnIndex - 1];
            const nextColumn = sortedColumns[columnIndex + 1];
            const left = previousColumn ? (previousColumn.centerX + column.centerX) / 2 : 0;
            const right = nextColumn ? (column.centerX + nextColumn.centerX) / 2 : 1;
            const items = [...column.items].sort((a, b) => a.y - b.y);

            items.forEach((item, rowIndex) => {
                const previousRow = items[rowIndex - 1];
                const nextRow = items[rowIndex + 1];
                const top = previousRow ? (previousRow.y + item.y) / 2 : 0;
                const bottom = nextRow ? (item.y + nextRow.y) / 2 : 1;

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
