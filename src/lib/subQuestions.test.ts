import { describe, expect, it } from 'vitest';
import type { Question, SubQuestionAnswers } from '@/types/omr';
import {
    addSubQuestionToTargets,
    createSubQuestion,
    estimateSubQuestionSeconds,
    findMissingRequiredSubQuestions,
    normalizeQuestionSubQuestions,
    requiredSubQuestionProgress,
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
    it.each(['__proto__', 'constructor', 'prototype'])('preserves imported prompt %s through save/restore without prototype mutation', id => {
        const imported = [{ ...questions[0], subQuestions: [{ ...questions[0].subQuestions![0], id }] }];
        const payload = JSON.parse(JSON.stringify({ 1: Object.fromEntries([[id, { body: '직접 쓴 근거' }]]) }));
        const sanitized = sanitizeSubQuestionAnswersForQuestions(imported, payload);
        expect(Object.getPrototypeOf(sanitized[1])).toBe(Object.prototype);
        expect(Object.hasOwn(sanitized[1], id)).toBe(true);
        const restored = JSON.parse(JSON.stringify(sanitized));
        expect(restored[1][id].body).toBe('직접 쓴 근거');
        expect(findMissingRequiredSubQuestions(imported, restored)).toEqual([]);
        expect(requiredSubQuestionProgress(imported, restored)).toEqual({ completed: 1, total: 1 });
    });

    it('does not accept inherited answers as completed required responses', () => {
        const inheritedPrompt = { 1: Object.create({ reason: { body: '상속 값' } }) };
        const inheritedQuestion = Object.create({ 1: { reason: { body: '상속 값' } } });
        for (const value of [inheritedPrompt, inheritedQuestion]) {
            expect(sanitizeSubQuestionAnswersForQuestions(questions, value)).toEqual({});
            expect(findMissingRequiredSubQuestions(questions, value)).toEqual([{ questionId: 1, subQuestionId: 'reason' }]);
            expect(requiredSubQuestionProgress(questions, value)).toEqual({ completed: 0, total: 1 });
        }
    });

    it.each([null, {}, { body: 42 }, { body: ['근거'] }, { body: '   ' }])('keeps damaged saved response incomplete without crashing (%j)', answer => {
        const restored = { 1: { reason: answer } } as unknown as SubQuestionAnswers;
        expect(findMissingRequiredSubQuestions(questions, restored)).toEqual([{ questionId: 1, subQuestionId: 'reason' }]);
        expect(requiredSubQuestionProgress(questions, restored)).toEqual({ completed: 0, total: 1 });
    });

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
