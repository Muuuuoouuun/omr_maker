import type { Question } from "@/types/omr";
import type { PdfTextLocatorItem } from "./pdfQuestionDetection";

export interface PdfPageTextItems {
    page: number;
    items: PdfTextLocatorItem[];
}

export interface DetectedPassageGroup {
    startQuestion: number;
    endQuestion: number;
    page: number;
    y: number;
    text: string;
    source: string;
}

interface TextLine {
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
    const lines: Array<{ y: number; items: PdfTextLocatorItem[] }> = [];

    for (const item of [...items].sort((a, b) => a.y - b.y || a.x - b.x)) {
        const line = lines.find(candidate => Math.abs(candidate.y - item.y) <= LINE_Y_THRESHOLD);
        if (line) {
            line.items.push(item);
            line.y = line.items.reduce((sum, current) => sum + current.y, 0) / line.items.length;
        } else {
            lines.push({ y: item.y, items: [item] });
        }
    }

    return lines
        .map(line => ({
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

    const cueWindow = normalized.slice(Math.max(0, match.index || 0), Math.min(normalized.length, (match.index || 0) + 120));
    if (!PASSAGE_CUE_PATTERN.test(cueWindow)) return null;

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
