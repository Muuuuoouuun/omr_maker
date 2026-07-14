import { describe, expect, it } from 'vitest';
import type { Question } from '@/types/omr';
import {
    addSubQuestionToTargets,
    createSubQuestion,
    estimateSubQuestionSeconds,
    findMissingRequiredSubQuestions,
    normalizeQuestionSubQuestions,
    sanitizeSubQuestionAnswersForQuestions,
} from './subQuestions';

const questions: Question[] = [{
    id: 1,
    number: 1,
    answer: 2,
    subQuestions: [{
        schemaVersion: 1,
        id: 'reason',
        prompt: '왜 이 답을 골랐나요?',
        kind: 'free_text',
        required: true,
        maxLength: 20,
        answerGuide: '근거를 확인',
    }],
}];

describe('sub-question helpers', () => {
    it('normalizes malformed prompts with deterministic unique ids and caps at two', () => {
        const normalized = normalizeQuestionSubQuestions([
            { prompt: ' 첫 질문 ', id: 'same', maxLength: 900 },
            { prompt: '둘째 질문', id: 'same', required: true },
            { prompt: '셋째 질문' },
        ], 7);
        expect(normalized).toHaveLength(2);
        expect(normalized.map(item => item.id)).toEqual(['same', 'same-2']);
        expect(normalized[0].maxLength).toBe(500);
        expect(normalized[1].required).toBe(true);
    });

    it('accepts only trusted prompt ids, trims bodies, and resets untrusted review state', () => {
        const answers = sanitizeSubQuestionAnswersForQuestions(questions, {
            1: {
                reason: { body: ' 123456789012345678901234 ', reviewStatus: 'reviewed' },
                injected: { body: 'do not store' },
            },
            99: { other: { body: 'do not store' } },
        }, '2026-07-14T00:00:00.000Z');
        expect(answers).toEqual({
            1: {
                reason: {
                    schemaVersion: 1,
                    body: '12345678901234567890',
                    answeredAt: '2026-07-14T00:00:00.000Z',
                    reviewStatus: 'needs_review',
                },
            },
        });
    });

    it('finds required gaps and estimates added solve time', () => {
        expect(findMissingRequiredSubQuestions(questions, undefined)).toEqual([{ questionId: 1, subQuestionId: 'reason' }]);
        expect(findMissingRequiredSubQuestions(questions, { 1: { reason: { schemaVersion: 1, body: '근거', reviewStatus: 'needs_review' } } })).toEqual([]);
        expect(estimateSubQuestionSeconds(questions)).toBeGreaterThan(0);
    });

    it('bulk-adds without overwriting, reporting duplicate and limit skips', () => {
        const source = createSubQuestion(1, 'choice_reason', () => 'seed');
        const full: Question = { id: 3, number: 3, subQuestions: [
            createSubQuestion(3, 'evidence', () => 'a'),
            createSubQuestion(3, 'solution_process', () => 'b'),
        ] };
        const result = addSubQuestionToTargets([
            { id: 1, number: 1, subQuestions: [source] },
            { id: 2, number: 2 },
            full,
        ], new Set([1, 2, 3]), source, () => 'copy');
        expect(result).toMatchObject({ applied: 1, duplicateSkipped: 1, limitSkipped: 1 });
        expect(result.questions[2].subQuestions).toHaveLength(2);
    });
});
