import type { Question, QuestionContentAnalysis } from '@/types/omr';

export const MAX_EXAM_ANALYSIS_PAGES = 4;

export function validateExamAnalysisPageRange(start: number, end: number): void {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
        || start < 1 || end < start || end - start >= MAX_EXAM_ANALYSIS_PAGES) {
        throw new Error(`한 번에 최대 ${MAX_EXAM_ANALYSIS_PAGES}쪽까지 분석할 수 있습니다. 페이지 범위를 확인해 주세요.`);
    }
}

export interface ExamContentAnalysisRow {
    questionId: number;
    questionNumber: number;
    tags: { unit?: string; concept?: string; skill?: string };
    contentAnalysis: QuestionContentAnalysis;
}
export type ExamAnalysisQuestion = Pick<Question, 'id' | 'number'>;

/** Unmapped questions remain eligible; mapped questions must belong to the selected pages. */
export function examAnalysisQuestionsForRange(questions: Question[], start: number, end: number): ExamAnalysisQuestion[] {
    validateExamAnalysisPageRange(start, end);
    return questions.filter(question => {
        const page = question.pdfRegion?.page ?? question.pdfLocation?.page;
        return page === undefined || (page >= start && page <= end);
    }).map(({ id, number }) => ({ id, number }));
}

/** Keep the old analysis for re-review, but do not carry its representative concept into new-source analytics. */
export function invalidateQuestionAnalysisForPdfChange(question: Question): Question {
    if (!question.contentAnalysis) return question;
    return { ...question, tags: withoutAppliedAnalysisTags(question), contentAnalysis: { ...question.contentAnalysis, status: 'draft' } };
}

function withoutAppliedAnalysisTags(question: Question): Question['tags'] {
    const tags = { ...question.tags };
    const analysis = question.contentAnalysis;
    if (!analysis) return tags;
    if (tags.concept?.trim() === analysis.concepts[0]?.trim()) delete tags.concept;
    for (const key of ['unit', 'skill'] as const) {
        const applied = analysis.appliedTags?.[key];
        if (applied !== undefined && tags[key] === applied) delete tags[key];
    }
    return tags;
}

/**
 * Removing stale drafts is available on every plan and never invokes AI.
 * Remove only classifications still matching their applied analysis values.
 * Independently edited tags and legacy unit/skill without provenance remain.
 * Reviewed analysis on other questions is never changed.
 */
export function discardDraftExamContentAnalysis(questions: Question[]): Question[] {
    return questions.map(question => {
        if (question.contentAnalysis?.status !== 'draft') return question;
        const { contentAnalysis: _analysis, ...rest } = question;
        void _analysis;
        return { ...rest, tags: withoutAppliedAnalysisTags(question) };
    });
}

function invalid(): never { throw new Error('시험지 분석 형식이 올바르지 않습니다.'); }
function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
    return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
    if (typeof value !== 'string' || !value.trim() || value.length > max) return invalid();
    return value.trim();
}
function texts(value: unknown, maxItems: number): string[] {
    if (!Array.isArray(value) || value.length > maxItems) return invalid();
    return [...new Set(value.map(item => text(item, 200)))];
}
export function validateExamAnalysisQuestions(value: unknown): ExamAnalysisQuestion[] {
    if (!Array.isArray(value) || !value.length || value.length > 200) return invalid();
    const ids = new Set<number>();
    const numbers = new Set<number>();
    return value.map(item => {
        const row = record(item);
        if (!Number.isSafeInteger(row.id) || !Number.isSafeInteger(row.number)
            || (row.id as number) < 0 || (row.number as number) < 1
            || ids.has(row.id as number) || numbers.has(row.number as number)) return invalid();
        ids.add(row.id as number); numbers.add(row.number as number);
        return { id: row.id as number, number: row.number as number };
    });
}
/** Unknown, duplicate or misaligned rows fail closed; omitted/unreadable questions stay untouched. */
export function validateExamContentAnalysis(value: unknown, questions: ExamAnalysisQuestion[]): ExamContentAnalysisRow[] {
    const known = new Map(validateExamAnalysisQuestions(questions).map(q => [q.id, q.number]));
    if (!Array.isArray(value) || value.length > questions.length) return invalid();
    const seen = new Set<number>();
    return value.map(item => {
        const row = record(item);
        if (typeof row.questionId !== 'number' || !known.has(row.questionId)
            || known.get(row.questionId) !== row.questionNumber || seen.has(row.questionId)) return invalid();
        seen.add(row.questionId);
        const analysis = record(row.contentAnalysis);
        const concepts = texts(analysis.concepts, 8);
        if (!concepts.length) return invalid();
        const tags = row.tags === undefined ? {} : record(row.tags);
        return {
            questionId: row.questionId,
            questionNumber: row.questionNumber as number,
            tags: {
                ...(tags.unit !== undefined ? { unit: text(tags.unit, 120) } : {}),
                concept: concepts[0],
                ...(tags.skill !== undefined ? { skill: text(tags.skill, 120) } : {}),
            },
            contentAnalysis: {
                concepts, trapPoints: texts(analysis.trapPoints, 8),
                summary: text(analysis.summary, 1000), status: 'draft',
            },
        };
    });
}
/** Never overwrite reviewed analysis or teacher-authored tags during generation. */
export function applyExamContentAnalysis(questions: Question[], rows: ExamContentAnalysisRow[]): Question[] {
    const validated = validateExamContentAnalysis(rows, questions);
    const byId = new Map(validated.map(row => [row.questionId, row]));
    return questions.map(question => {
        const row = byId.get(question.id);
        if (!row || question.contentAnalysis?.status === 'reviewed') return question;
        return { ...question, contentAnalysis: row.contentAnalysis };
    });
}

/** Apply an explicit teacher review, including removal of cleared unit/skill fields. */
export function applyReviewedExamContentAnalysis(questions: Question[], rows: ExamContentAnalysisRow[]): Question[] {
    if (rows.some(row => row.contentAnalysis.status !== 'reviewed')) return invalid();
    const validated = validateExamContentAnalysis(rows, questions);
    const byId = new Map(validated.map(row => [row.questionId, row]));
    return questions.map(question => {
        const row = byId.get(question.id);
        if (!row) return question;
        const tags = { ...question.tags };
        delete tags.unit;
        delete tags.concept;
        delete tags.skill;
        return {
            ...question,
            tags: { ...tags, ...row.tags },
            contentAnalysis: {
                ...row.contentAnalysis, status: 'reviewed',
                appliedTags: { ...(row.tags.unit ? { unit: row.tags.unit } : {}), ...(row.tags.skill ? { skill: row.tags.skill } : {}) },
            },
        };
    });
}

/** Persistence boundary: discard malformed metadata rather than trusting stored AI output. */
export function normalizeQuestionContentAnalysis(value: unknown): QuestionContentAnalysis | undefined {
    try {
        const row = record(value);
        if (row.status !== 'draft' && row.status !== 'reviewed') return undefined;
        const concepts = texts(row.concepts, 8);
        if (!concepts.length) return undefined;
        const appliedTags = row.appliedTags === undefined ? undefined : record(row.appliedTags);
        return {
            concepts, trapPoints: texts(row.trapPoints, 8), summary: text(row.summary, 1000), status: row.status,
            ...(appliedTags ? { appliedTags: {
                ...(appliedTags.unit !== undefined ? { unit: text(appliedTags.unit, 120) } : {}),
                ...(appliedTags.skill !== undefined ? { skill: text(appliedTags.skill, 120) } : {}),
            } } : {}),
        };
    } catch { return undefined; }
}
