import type {
    MissingRequiredSubQuestion,
    Question,
    QuestionSubQuestion,
    QuestionSubQuestionTemplateId,
    SubQuestionAnswer,
    SubQuestionAnswers,
} from '@/types/omr';

export const MAX_SUB_QUESTIONS_PER_QUESTION = 2;
export const DEFAULT_SUB_QUESTION_MAX_LENGTH = 300;
export const MAX_SUB_QUESTION_LENGTH = 500;

export interface SubQuestionTemplate {
    id: Exclude<QuestionSubQuestionTemplateId, 'custom'>;
    label: string;
    prompt: string;
}

export const SUB_QUESTION_TEMPLATES: readonly SubQuestionTemplate[] = [
    { id: 'choice_reason', label: '선택 이유', prompt: '이 답을 고른 이유를 한 문장으로 쓰세요.' },
    { id: 'evidence', label: '근거 쓰기', prompt: '정답의 근거가 되는 부분을 쓰세요.' },
    { id: 'solution_process', label: '풀이 과정', prompt: '처음 세운 식이나 풀이 방향을 쓰세요.' },
    { id: 'context_detail', label: '본문 세부', prompt: '본문 근거를 바탕으로 답하세요.' },
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cleanText(value: unknown, maxLength: number): string {
    return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

export function normalizeSubQuestionMaxLength(value: unknown): number {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed)) return DEFAULT_SUB_QUESTION_MAX_LENGTH;
    return Math.max(1, Math.min(MAX_SUB_QUESTION_LENGTH, Math.floor(parsed)));
}

function templateId(value: unknown): QuestionSubQuestionTemplateId {
    return value === 'choice_reason' || value === 'evidence' || value === 'solution_process'
        || value === 'context_detail' || value === 'custom'
        ? value
        : 'custom';
}

/** Deterministic fallback ids make repeated sanitization stable for legacy/malformed payloads. */
export function normalizeQuestionSubQuestions(value: unknown, questionId: number): QuestionSubQuestion[] {
    if (!Array.isArray(value)) return [];
    const used = new Set<string>();
    const normalized: QuestionSubQuestion[] = [];
    for (let index = 0; index < value.length && normalized.length < MAX_SUB_QUESTIONS_PER_QUESTION; index += 1) {
        const candidate = value[index];
        if (!isRecord(candidate)) continue;
        const prompt = cleanText(candidate.prompt, MAX_SUB_QUESTION_LENGTH);
        if (!prompt) continue;
        const rawId = cleanText(candidate.id, 100);
        let id = rawId || `sq-${questionId}-${index + 1}`;
        let suffix = 2;
        while (used.has(id)) id = `${rawId || `sq-${questionId}-${index + 1}`}-${suffix++}`;
        used.add(id);
        const guide = cleanText(candidate.answerGuide, MAX_SUB_QUESTION_LENGTH);
        const note = cleanText(candidate.teacherNote, MAX_SUB_QUESTION_LENGTH);
        normalized.push({
            schemaVersion: 1,
            id,
            prompt,
            kind: 'free_text',
            templateId: templateId(candidate.templateId),
            required: candidate.required === true || undefined,
            maxLength: normalizeSubQuestionMaxLength(candidate.maxLength),
            answerGuide: guide || undefined,
            teacherNote: note || undefined,
        });
    }
    return normalized;
}

export function createSubQuestion(
    questionId: number,
    template: QuestionSubQuestionTemplateId = 'custom',
    idFactory: () => string = () => globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
): QuestionSubQuestion {
    const preset = SUB_QUESTION_TEMPLATES.find(item => item.id === template);
    return {
        schemaVersion: 1,
        id: `sq-${questionId}-${idFactory()}`,
        prompt: preset?.prompt || '',
        kind: 'free_text',
        templateId: preset?.id || 'custom',
        required: undefined,
        maxLength: DEFAULT_SUB_QUESTION_MAX_LENGTH,
    };
}

function normalizeAnswer(value: unknown, maxLength: number, nowIso?: string): SubQuestionAnswer | null {
    if (!isRecord(value)) return null;
    const body = cleanText(value.body, maxLength);
    if (!body) return null;
    const answeredAt = cleanText(value.answeredAt, 64) || nowIso;
    return {
        schemaVersion: 1,
        body,
        answeredAt,
        reviewStatus: 'needs_review',
    };
}

/** Accept only answers to prompts present in the trusted exam and clamp every body. */
export function sanitizeSubQuestionAnswersForQuestions(
    questions: Question[],
    value: unknown,
    nowIso?: string,
): SubQuestionAnswers {
    if (!isRecord(value)) return {};
    const result: SubQuestionAnswers = {};
    for (const question of questions) {
        const rawAnswers = value[String(question.id)];
        if (!isRecord(rawAnswers)) continue;
        const subAnswers: Record<string, SubQuestionAnswer> = {};
        for (const subQuestion of normalizeQuestionSubQuestions(question.subQuestions, question.id)) {
            const answer = normalizeAnswer(rawAnswers[subQuestion.id], subQuestion.maxLength || DEFAULT_SUB_QUESTION_MAX_LENGTH, nowIso);
            if (answer) subAnswers[subQuestion.id] = answer;
        }
        if (Object.keys(subAnswers).length > 0) result[question.id] = subAnswers;
    }
    return result;
}

export function findMissingRequiredSubQuestions(
    questions: Question[],
    answers: SubQuestionAnswers | undefined,
): MissingRequiredSubQuestion[] {
    return questions.flatMap(question => normalizeQuestionSubQuestions(question.subQuestions, question.id)
        .filter(subQuestion => subQuestion.required && !answers?.[question.id]?.[subQuestion.id]?.body.trim())
        .map(subQuestion => ({ questionId: question.id, subQuestionId: subQuestion.id })));
}

export function estimateSubQuestionSeconds(questions: Question[]): number {
    return questions.reduce((total, question) => total + normalizeQuestionSubQuestions(question.subQuestions, question.id)
        .reduce((sum, subQuestion) => sum + 20 + Math.ceil((subQuestion.maxLength || DEFAULT_SUB_QUESTION_MAX_LENGTH) / 8), 0), 0);
}

export interface BulkSubQuestionResult {
    questions: Question[];
    applied: number;
    duplicateSkipped: number;
    limitSkipped: number;
}

export function addSubQuestionToTargets(
    questions: Question[],
    targetIds: ReadonlySet<number>,
    source: QuestionSubQuestion,
    idFactory?: () => string,
): BulkSubQuestionResult {
    let applied = 0;
    let duplicateSkipped = 0;
    let limitSkipped = 0;
    const normalizedPrompt = source.prompt.trim();
    const next = questions.map(question => {
        if (!targetIds.has(question.id)) return question;
        const existing = normalizeQuestionSubQuestions(question.subQuestions, question.id);
        if (existing.some(item => item.prompt.trim() === normalizedPrompt && item.templateId === source.templateId)) {
            duplicateSkipped += 1;
            return question;
        }
        if (existing.length >= MAX_SUB_QUESTIONS_PER_QUESTION) {
            limitSkipped += 1;
            return question;
        }
        const created = { ...source, id: createSubQuestion(question.id, source.templateId, idFactory).id };
        applied += 1;
        return { ...question, subQuestions: [...existing, created] };
    });
    return { questions: next, applied, duplicateSkipped, limitSkipped };
}

export function requiredSubQuestionProgress(questions: Question[], answers: SubQuestionAnswers | undefined) {
    const required = questions.flatMap(question => normalizeQuestionSubQuestions(question.subQuestions, question.id)
        .filter(subQuestion => subQuestion.required)
        .map(subQuestion => ({ questionId: question.id, subQuestionId: subQuestion.id })));
    const completed = required.filter(item => !!answers?.[item.questionId]?.[item.subQuestionId]?.body.trim()).length;
    return { completed, total: required.length };
}
