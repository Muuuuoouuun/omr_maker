import { invalidateQuestionAnalysisForPdfChange } from "@/lib/examContentAnalysis";
import type { Question } from '@/types/omr';

export const EXAM_SETUP_PRESETS = {
    korean: { label: '국어 모의고사', count: 45, total: 100, minutes: 80 },
    physics: { label: '물리학Ⅰ 모의고사', count: 20, total: 50, minutes: 30 },
} as const;
export type ExamSetupPreset = keyof typeof EXAM_SETUP_PRESETS;

/** Empty means all; malformed/out-of-bounds ranges must never silently select all. */
export function parseNumberSelection(input: string, maximum: number): number[] {
    if (!input.trim()) return Array.from({ length: maximum }, (_, index) => index + 1);
    const selected = new Set<number>();
    for (const segment of input.split(',')) {
        const match = segment.trim().match(/^(\d+)(?:\s*[-~–]\s*(\d+))?$/);
        if (!match) throw new Error('번호 또는 범위를 쉼표로 구분하세요. 예: 1-12,17-20');
        const start = Number(match[1]);
        const end = Number(match[2] ?? match[1]);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > maximum) {
            throw new Error(`1~${maximum} 안의 오름차순 범위를 입력하세요.`);
        }
        for (let number = start; number <= end; number++) selected.add(number);
    }
    return [...selected].sort((a, b) => a - b);
}

export function applyMixedPointScores(questions: Question[], threePointNumbers: number[]): Question[] {
    const threePoint = new Set(threePointNumbers);
    return questions.map(question => ({ ...question, score: threePoint.has(question.number) ? 3 : 2 }));
}

export function applyExamSetupPreset(questions: Question[], preset: ExamSetupPreset): Question[] {
    const { count } = EXAM_SETUP_PRESETS[preset];
    const nextId = Math.max(0, ...questions.map(question => question.id)) + 1;
    return Array.from({ length: count }, (_, index) => {
        const existing = questions[index];
        return existing
            ? { ...existing, number: index + 1, choices: 5 as const, score: 2 }
            : { id: nextId + index, number: index + 1, choices: 5 as const, score: 2 };
    });
}

export function duplicateQuestionPages(candidates: Map<number, Set<number>>): string[] {
    return [...candidates.entries()]
        .filter(([, pages]) => pages.size > 1)
        .sort(([a], [b]) => a - b)
        .map(([number, pages]) => `${number}번 (${[...pages].sort((a, b) => a - b).join(', ')}p)`);
}

/** Ignore low-confidence page numbers and indented lists inside the passage. */
export function ambiguousQuestionPages(
    candidates: Map<number, import('@/lib/pdfQuestionDetection').DetectedQuestionPlacement[]>,
    best: Map<number, import('@/lib/pdfQuestionDetection').DetectedQuestionPlacement>,
): string[] {
    const questionMargins = [...best.values()].map(candidate => candidate.location.x);
    const pages = new Map<number, Set<number>>();
    for (const [number, placements] of candidates) {
        const selected = best.get(number);
        if (!selected) continue;
        pages.set(number, new Set(placements.filter(candidate => (
            candidate.location.score >= selected.location.score - 20
            && questionMargins.some(margin => Math.abs(margin - candidate.location.x) <= 0.02)
        )).map(candidate => candidate.page)));
    }
    return duplicateQuestionPages(pages);
}

export function questionIdentity(questions: Question[]): string {
    return JSON.stringify(questions.map(question => [question.id, question.number]));
}

/** Apply asynchronous PDF results without rolling back edits made while scanning. */
export function mergeQuestionPdfPlacements(latest: Question[], original: Question[], matched: Question[]): Question[] {
    if (questionIdentity(latest) !== questionIdentity(original)) return latest;
    const beforeById = new Map(original.map(question => [question.id, question]));
    const mappedById = new Map(matched.map(question => [question.id, question]));
    return latest.map(question => {
        const before = beforeById.get(question.id);
        const next = mappedById.get(question.id);
        if (!before || !next || next.number !== question.number) return question;
        // Respect a manual region edit made after the scan started.
        if (JSON.stringify([question.pdfLocation,question.pdfRegion,question.passagePdfRegions])
            !== JSON.stringify([before.pdfLocation,before.pdfRegion,before.passagePdfRegions])) return question;
        const updated: Question = {
            ...question,
            pdfLocation: next.pdfLocation,
            pdfRegion: next.pdfRegion,
            passagePdfRegions: next.passagePdfRegions,
            tags: next.tags?.source && question.tags?.source === before.tags?.source
                ? { ...question.tags, source: next.tags.source } : question.tags,
        };
        return questionPdfSourceChanged(question, updated) ? invalidateQuestionAnalysisForPdfChange(updated) : updated;
    });
}

export function questionPdfSourceChanged(before: Question, after: Question): boolean {
    return JSON.stringify([before.pdfLocation,before.pdfRegion,before.passagePdfRegions])
        !== JSON.stringify([after.pdfLocation,after.pdfRegion,after.passagePdfRegions]);
}

export function invalidateChangedPdfAnalyses(before: Question[], after: Question[]): Question[] {
    const originals = new Map(before.map(question => [question.id, question]));
    return after.map(question => {
        const original = originals.get(question.id);
        return original && questionPdfSourceChanged(original, question)
            ? invalidateQuestionAnalysisForPdfChange(question) : question;
    });
}
