export interface PdfTextLocatorItem {
    str: string;
    x: number;
    y: number;
    width?: number;
    height?: number;
}

export interface DetectedQuestionLocation {
    questionNumber: number;
    x: number;
    y: number;
    score: number;
    text: string;
}

export interface DetectedQuestionPlacement {
    page: number;
    location: DetectedQuestionLocation;
}

interface NormalizedTextItem extends PdfTextLocatorItem {
    index: number;
    str: string;
    x: number;
    y: number;
    width: number;
    height: number;
}

interface TextLine {
    y: number;
    items: NormalizedTextItem[];
}

interface QuestionTokenMatch {
    questionNumber: number;
    kind: "q_prefixed" | "inline" | "punctuated" | "bare";
    body: string;
}

const LINE_Y_THRESHOLD = 0.008;
const MIN_QUESTION_SCORE = 60;
const QUESTION_ANCHOR_Y_OFFSET = 0.015;
const HEADER_Y_LIMIT = 0.14;
const HEADER_KEYWORD_PATTERN = /(과학탐구\s*영역|물리학|화학|생명과학|지구과학|선택|교시|문제지|홀수형|짝수형)/;
const RIGHT_COLUMN_X = 0.48;

function clamp(value: number, min = 0, max = 1): number {
    return Math.min(max, Math.max(min, value));
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

function normalizeText(value: string): string {
    return value
        .replace(/[０-９]/g, digit => String.fromCharCode(digit.charCodeAt(0) - 0xfee0))
        .replace(/[Ｑｑ]/g, "Q")
        .replace(/[．。]/g, ".")
        .replace(/[（]/g, "(")
        .replace(/[）]/g, ")")
        .replace(/[］]/g, "]")
        .replace(/\s+/g, " ")
        .trim();
}

function hasMeaningfulText(value: string): boolean {
    return /[가-힣A-Za-z]/.test(value);
}

function matchQuestionToken(raw: string): QuestionTokenMatch | null {
    const text = normalizeText(raw);
    if (!text) return null;

    const qPrefixedInline = text.match(/^Q\s*\[?\s*(\d{1,3})\s*[\]\.)]\s*(.+)$/i);
    if (qPrefixedInline) {
        return {
            questionNumber: Number(qPrefixedInline[1]),
            kind: "q_prefixed",
            body: qPrefixedInline[2].trim(),
        };
    }

    const inline = text.match(/^(?:Q\s*)?\[?\s*(\d{1,3})\s*[\]\.)]\s*(?=[가-힣A-Za-z㉠-㉻(（「『<〈《])(.+)$/i);
    if (inline) {
        return {
            questionNumber: Number(inline[1]),
            kind: "inline",
            body: inline[2].trim(),
        };
    }

    const parenthesized = text.match(/^(?:Q\s*)?[\(（]\s*(\d{1,3})\s*[\)）]\s*(.*)$/i);
    if (parenthesized) {
        const body = parenthesized[2].trim();
        return {
            questionNumber: Number(parenthesized[1]),
            kind: body ? "inline" : "punctuated",
            body,
        };
    }

    const punctuated = text.match(/^(?:Q\s*)?\[?\s*(\d{1,3})\s*[\]\.)]\s*$/i);
    if (punctuated) {
        return {
            questionNumber: Number(punctuated[1]),
            kind: "punctuated",
            body: "",
        };
    }

    const bare = text.match(/^(?:Q\s*)?(\d{1,3})$/i);
    if (bare) {
        return {
            questionNumber: Number(bare[1]),
            kind: "bare",
            body: "",
        };
    }

    return null;
}

function normalizeItems(items: PdfTextLocatorItem[]): NormalizedTextItem[] {
    return items
        .map((item, index) => ({
            index,
            str: normalizeText(item.str || ""),
            x: clamp(item.x),
            y: clamp(item.y),
            width: clamp(isFiniteNumber(item.width) ? item.width : 0, 0, 1),
            height: clamp(isFiniteNumber(item.height) ? item.height : 0.01, 0.001, 1),
        }))
        .filter(item => item.str);
}

function buildTextLines(items: NormalizedTextItem[]): TextLine[] {
    const lines: TextLine[] = [];

    for (const item of [...items].sort((a, b) => a.y - b.y || a.x - b.x)) {
        const threshold = Math.max(LINE_Y_THRESHOLD, item.height * 0.75);
        const line = lines.find(candidate => Math.abs(candidate.y - item.y) <= threshold);
        if (line) {
            line.items.push(item);
            line.y = line.items.reduce((sum, current) => sum + current.y, 0) / line.items.length;
        } else {
            lines.push({ y: item.y, items: [item] });
        }
    }

    return lines
        .map(line => ({ ...line, items: [...line.items].sort((a, b) => a.x - b.x || a.index - b.index) }))
        .sort((a, b) => a.y - b.y);
}

function lineText(line: TextLine): string {
    return line.items.map(item => item.str).join(" ").trim();
}

function isSameColumnBand(a: number, b: number): boolean {
    return (a < RIGHT_COLUMN_X && b < RIGHT_COLUMN_X) || (a >= RIGHT_COLUMN_X && b >= RIGHT_COLUMN_X);
}

function lineItemsInSameColumn(line: TextLine, item: NormalizedTextItem): NormalizedTextItem[] {
    return line.items.filter(other => isSameColumnBand(other.x, item.x));
}

function countOptionLikeNumbers(line: TextLine): number {
    return line.items.filter(item => {
        const match = matchQuestionToken(item.str);
        return !!match
            && match.kind !== "inline"
            && match.kind !== "q_prefixed"
            && match.questionNumber >= 1
            && match.questionNumber <= 5;
    }).length;
}

function isNumericHeavy(value: string): boolean {
    const compact = value.replace(/\s/g, "");
    if (compact.length < 3) return false;
    const meaningful = (compact.match(/[가-힣A-Za-z]/g) || []).length;
    const digits = (compact.match(/\d/g) || []).length;
    return meaningful === 0 && digits >= Math.max(2, compact.length * 0.35);
}

function isLikelyPageHeader(
    item: NormalizedTextItem,
    currentLineText: string,
    continuationText: string,
): boolean {
    if (item.y > HEADER_Y_LIMIT) return false;

    const compactLine = currentLineText.replace(/\s/g, "");
    if (HEADER_KEYWORD_PATTERN.test(compactLine)) return true;

    const compactContinuation = continuationText.replace(/\s/g, "");
    const shortParentheticalSubject = /^\(?[가-힣A-Za-z]+(?:Ⅰ|Ⅱ|Ⅲ|Ⅳ|Ⅴ|I|II|III|IV|V|1|2)\)?$/.test(compactContinuation)
        && compactContinuation.length <= 16;
    return item.x < 0.25 && shortParentheticalSubject;
}

function findContinuationText(line: TextLine, item: NormalizedTextItem, lines: TextLine[]): string {
    const sameLineAfter = lineItemsInSameColumn(line, item)
        .filter(other => other.index !== item.index && other.x >= item.x + Math.max(item.width, 0.008) - 0.004)
        .map(other => other.str)
        .join(" ");
    if (sameLineAfter.trim()) return sameLineAfter;

    const nextLine = lines.find(candidate => {
        if (candidate.y <= line.y || candidate.y - line.y > 0.045) return false;
        const sameColumnItems = lineItemsInSameColumn(candidate, item);
        if (sameColumnItems.length === 0) return false;
        return Math.abs(Math.min(...sameColumnItems.map(other => other.x)) - item.x) <= 0.08;
    });
    return nextLine ? lineText(nextLine) : "";
}

function scoreQuestionCandidate(
    match: QuestionTokenMatch,
    item: NormalizedTextItem,
    line: TextLine,
    lines: TextLine[],
): number {
    if (match.kind === "q_prefixed") {
        if (item.y < 0.045 || item.y > 0.96) return 50;
        return item.x > 0.92 ? 90 : 125;
    }

    const currentLineText = lineText(line);
    const sameColumnItems = lineItemsInSameColumn(line, item);
    const lineStartX = Math.min(...sameColumnItems.map(other => other.x));
    const nearLineStart = item.x <= lineStartX + 0.025;
    const precedingText = sameColumnItems
        .filter(other => other.index !== item.index && other.x < item.x - 0.004)
        .map(other => other.str)
        .join(" ");
    const continuationText = `${match.body} ${findContinuationText(line, item, lines)}`.trim();

    let score = match.kind === "inline" ? 95 : match.kind === "punctuated" ? 72 : 42;

    if (nearLineStart) score += 24;
    else score -= 32;

    if (hasMeaningfulText(precedingText)) score -= 28;

    if (hasMeaningfulText(continuationText)) score += match.kind === "inline" ? 8 : 28;
    else score -= 24;

    if (item.y < 0.045 || item.y > 0.96) score -= 75;
    else if (item.y > 0.9) score -= 35;

    if (item.x > 0.92) score -= 20;
    if (isNumericHeavy(currentLineText)) score -= 32;
    if (countOptionLikeNumbers(line) >= 3) score -= 55;
    if (isLikelyPageHeader(item, currentLineText, continuationText)) score -= 95;

    return score;
}

export function isBetterDetectedQuestionLocation(next: DetectedQuestionLocation, current: DetectedQuestionLocation | undefined): boolean {
    if (!current) return true;
    if (next.score > current.score + 4) return true;
    if (current.score > next.score + 4) return false;
    if (next.y < current.y - 0.02) return true;
    if (Math.abs(next.y - current.y) <= 0.02 && next.x < current.x) return true;
    return false;
}

export function isBetterDetectedQuestionPlacement(next: DetectedQuestionPlacement, current: DetectedQuestionPlacement | undefined): boolean {
    if (!current) return true;
    if (next.page < current.page && next.location.score >= current.location.score - 20) return true;
    if (current.page < next.page && current.location.score >= next.location.score - 20) return false;
    if (next.page !== current.page) return next.location.score > current.location.score;
    return isBetterDetectedQuestionLocation(next.location, current.location);
}

export function findMissingExpectedQuestionNumbers(
    expectedQuestionNumbers: Iterable<number>,
    matchedQuestionNumbers: Iterable<number>,
): number[] {
    const matched = new Set(matchedQuestionNumbers);
    return [...new Set(expectedQuestionNumbers)].filter(questionNumber => !matched.has(questionNumber));
}

export function detectQuestionLocationsFromText(
    items: PdfTextLocatorItem[],
    expectedQuestionNumbers: Iterable<number>,
): Map<number, DetectedQuestionLocation> {
    const expected = new Set(expectedQuestionNumbers);
    const normalizedItems = normalizeItems(items);
    const lines = buildTextLines(normalizedItems);
    const lineByItemIndex = new Map<number, TextLine>();

    for (const line of lines) {
        line.items.forEach(item => lineByItemIndex.set(item.index, line));
    }

    const detected = new Map<number, DetectedQuestionLocation>();

    for (const item of normalizedItems) {
        const match = matchQuestionToken(item.str);
        if (!match || !expected.has(match.questionNumber)) continue;

        const line = lineByItemIndex.get(item.index);
        if (!line) continue;

        const score = scoreQuestionCandidate(match, item, line, lines);
        if (score < MIN_QUESTION_SCORE) continue;

        const candidate: DetectedQuestionLocation = {
            questionNumber: match.questionNumber,
            x: item.x,
            y: Math.max(0, item.y - QUESTION_ANCHOR_Y_OFFSET),
            score,
            text: lineText(line),
        };

        if (isBetterDetectedQuestionLocation(candidate, detected.get(candidate.questionNumber))) {
            detected.set(candidate.questionNumber, candidate);
        }
    }

    return detected;
}
