import type { Question, QuestionPdfRegion } from "@/types/omr";
import type { PdfTextLocatorItem } from "./pdfQuestionDetection";

export interface PdfPageTextItems {
    page: number;
    items: PdfTextLocatorItem[];
}

export interface DetectedPassageGroup {
    startQuestion: number;
    endQuestion: number;
    page: number;
    x?: number;
    y: number;
    text: string;
    source: string;
}

interface TextLine {
    x: number;
    y: number;
    text: string;
}

const LINE_Y_THRESHOLD = 0.006;
const RANGE_PATTERN = /(?:\[|\(|\s|^)*(\d{1,3})\s*[~～∼-]\s*(\d{1,3})(?:\s*[\]\)]|\s|$)/;
const PASSAGE_CUE_PATTERN = /(다음|글|읽고|물음|답하시오|발표|대화|자료|초고|비평문|기사|방송|작문|화상 회의|소식지|담화|시사)/;
const MAX_GROUP_SPAN = 12;

function normalizeText(value: string): string {
    return value
        .replace(/[∼～]/g, "~")
        .replace(/\s+/g, " ")
        .trim();
}

function buildLines(items: PdfTextLocatorItem[]): TextLine[] {
    const lines: Array<{ y: number; column: 0 | 1; items: PdfTextLocatorItem[] }> = [];

    for (const item of [...items].sort((a, b) => a.y - b.y || a.x - b.x)) {
        const column = item.x >= 0.5 ? 1 : 0;
        const line = lines.find(candidate => (
            candidate.column === column
            && Math.abs(candidate.y - item.y) <= LINE_Y_THRESHOLD
        ));
        if (line) {
            line.items.push(item);
            line.y = line.items.reduce((sum, current) => sum + current.y, 0) / line.items.length;
        } else {
            lines.push({ y: item.y, column, items: [item] });
        }
    }

    return lines
        .map(line => ({
            x: Math.min(...line.items.map(item => item.x)),
            y: line.y,
            text: normalizeText(line.items
                .sort((a, b) => a.x - b.x)
                .map(item => item.str)
                .join(" ")),
        }))
        .filter(line => line.text)
        .sort((a, b) => a.y - b.y);
}

function parsePassageRange(text: string): { start: number; end: number } | null {
    const normalized = normalizeText(text);
    const match = normalized.match(RANGE_PATTERN);
    if (!match) return null;

    const start = Number(match[1]);
    const end = Number(match[2]);
    if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
    if (start <= 0 || end < start || end - start > MAX_GROUP_SPAN) return null;

    const cueWindow = normalized.slice(Math.max(0, match.index || 0));
    const explicitlyBracketed = /^\s*\[\s*\d{1,3}\s*[~～∼-]\s*\d{1,3}\s*\]/.test(normalized);
    if (!explicitlyBracketed && !PASSAGE_CUE_PATTERN.test(cueWindow)) return null;

    return { start, end };
}

function sourceLabel(index: number, start: number, end: number): string {
    return `지문 ${String(index).padStart(2, "0")} (${start}-${end}번)`;
}

export function detectPassageGroupsFromPdfText(
    pages: PdfPageTextItems[],
    expectedQuestionNumbers: Iterable<number>,
): DetectedPassageGroup[] {
    const expected = new Set(expectedQuestionNumbers);
    const byRange = new Map<string, Omit<DetectedPassageGroup, "source">>();

    for (const page of pages) {
        for (const line of buildLines(page.items)) {
            const range = parsePassageRange(line.text);
            if (!range) continue;

            const hasExpectedQuestion = Array.from(
                { length: range.end - range.start + 1 },
                (_, index) => range.start + index,
            ).some(questionNumber => expected.has(questionNumber));
            if (!hasExpectedQuestion) continue;

            const key = `${range.start}-${range.end}`;
            const current = byRange.get(key);
            if (!current || page.page < current.page || (page.page === current.page && line.y < current.y)) {
                byRange.set(key, {
                    startQuestion: range.start,
                    endQuestion: range.end,
                    page: page.page,
                    x: line.x,
                    y: line.y,
                    text: line.text,
                });
            }
        }
    }

    return [...byRange.values()]
        .sort((a, b) => a.startQuestion - b.startQuestion || a.page - b.page || a.y - b.y)
        .map((group, index) => ({
            ...group,
            source: sourceLabel(index + 1, group.startQuestion, group.endQuestion),
        }));
}

const PASSAGE_COLUMN_LEFT = [0.045, 0.515] as const;
const PASSAGE_COLUMN_WIDTH = 0.44;
const PASSAGE_PAGE_TOP = 0.055;
const PASSAGE_PAGE_BOTTOM = 0.955;
const PASSAGE_START_PADDING = 0.008;
const PASSAGE_END_PADDING = 0.012;

function columnIndex(x: number | undefined): 0 | 1 {
    return typeof x === "number" && x >= 0.5 ? 1 : 0;
}

function readingSegment(page: number, x: number | undefined): number {
    return (page - 1) * 2 + columnIndex(x);
}

function rounded(value: number): number {
    return Math.round(value * 1_000) / 1_000;
}

function passageRegionsForGroup(
    group: DetectedPassageGroup,
    questions: Question[],
): QuestionPdfRegion[] {
    const startSegment = readingSegment(group.page, group.x);
    const firstQuestion = questions
        .filter(question => question.number >= group.startQuestion && question.number <= group.endQuestion)
        .map(question => ({ question, location: question.pdfLocation || question.pdfRegion }))
        .filter((entry): entry is typeof entry & { location: NonNullable<typeof entry.location> } => !!entry.location)
        .filter(entry => readingSegment(entry.location.page, entry.location.x) >= startSegment)
        .sort((a, b) => (
            readingSegment(a.location.page, a.location.x) - readingSegment(b.location.page, b.location.x)
            || a.location.y - b.location.y
        ))[0];

    const endSegment = firstQuestion
        ? readingSegment(firstQuestion.location.page, firstQuestion.location.x)
        : startSegment;
    const regions = [];

    for (let segment = startSegment; segment <= endSegment; segment += 1) {
        const page = Math.floor(segment / 2) + 1;
        const column = (segment % 2) as 0 | 1;
        const top = segment === startSegment
            ? Math.max(PASSAGE_PAGE_TOP, group.y - PASSAGE_START_PADDING)
            : PASSAGE_PAGE_TOP;
        const bottom = segment === endSegment && firstQuestion
            ? Math.min(PASSAGE_PAGE_BOTTOM, firstQuestion.location.y - PASSAGE_END_PADDING)
            : PASSAGE_PAGE_BOTTOM;
        if (bottom <= top + 0.02) continue;
        regions.push({
            page,
            x: PASSAGE_COLUMN_LEFT[column],
            y: rounded(top),
            width: PASSAGE_COLUMN_WIDTH,
            height: rounded(bottom - top),
        });
    }

    return regions;
}

/**
 * Preserve the common reading material separately from each question crop.
 * A passage may cross both columns and multiple pages, so one shared region
 * list is attached to every member question instead of stretching a question
 * rectangle over unrelated content.
 */
export function attachInferredPassageRegions(
    questions: Question[],
    groups: DetectedPassageGroup[],
    options: { overwriteExisting?: boolean } = {},
): Question[] {
    if (groups.length === 0) return questions;

    const groupRegions = groups.map(group => ({
        group,
        regions: passageRegionsForGroup(group, questions),
    }));

    return questions.map(question => {
        const match = groupRegions.find(({ group }) => (
            question.number >= group.startQuestion && question.number <= group.endQuestion
        ));
        if (!match || match.regions.length === 0) return question;
        if (!options.overwriteExisting && question.passagePdfRegions?.length) return question;
        return { ...question, passagePdfRegions: match.regions };
    });
}

export function selectPassageGroupsForQuestions(
    groups: DetectedPassageGroup[],
    questions: Question[],
): DetectedPassageGroup[] {
    const filtered = groups.filter(group => {
        const memberPages = questions
            .filter(question => (
                question.number >= group.startQuestion &&
                question.number <= group.endQuestion
            ))
            .map(question => question.pdfLocation?.page || question.pdfRegion?.page)
            .filter((page): page is number => typeof page === "number" && Number.isFinite(page));
        if (memberPages.length === 0) return true;
        return group.page <= Math.max(...memberPages);
    });

    return filtered.map((group, index) => ({
        ...group,
        source: sourceLabel(index + 1, group.startQuestion, group.endQuestion),
    }));
}

export function attachInferredPassageSources(
    questions: Question[],
    groups: DetectedPassageGroup[],
    options: { overwriteExisting?: boolean } = {},
): Question[] {
    if (groups.length === 0) return questions;

    return questions.map(question => {
        const group = groups.find(candidate => (
            question.number >= candidate.startQuestion &&
            question.number <= candidate.endQuestion
        ));
        if (!group) return question;
        if (!options.overwriteExisting && question.tags?.source) return question;

        return {
            ...question,
            tags: {
                ...question.tags,
                source: group.source,
            },
        };
    });
}
