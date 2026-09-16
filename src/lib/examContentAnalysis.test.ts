import { describe, expect, it } from 'vitest';
import { applyExamContentAnalysis, normalizeQuestionContentAnalysis, validateExamAnalysisQuestions, validateExamContentAnalysis } from './examContentAnalysis';

const questions = [{ id: 42, number: 3 }, { id: 5, number: 8 }];
const row = { questionId: 42, questionNumber: 3, tags: { unit: '함수', skill: '그래프 해석' }, contentAnalysis: { concepts: ['일차함수'], trapPoints: ['축의 단위'], summary: '기울기 해석', status: 'reviewed' as const } };
describe('exam content analysis trust boundaries', () => {
    it('preserves explicit identity, allows missing questions and always creates drafts', () => {
        expect(validateExamContentAnalysis([row], questions)[0]).toMatchObject({ questionId: 42, questionNumber: 3, contentAnalysis: { status: 'draft' } });
        expect(validateExamContentAnalysis([], questions)).toEqual([]);
    });
    it('rejects unknown, shifted and duplicate question identities', () => {
        for (const value of [[{ ...row, questionId: 99 }], [{ ...row, questionNumber: 8 }], [row, row]]) {
            expect(() => validateExamContentAnalysis(value, questions)).toThrow();
        }
        expect(() => validateExamAnalysisQuestions([{ id: 1, number: 1 }, { id: 2, number: 1 }])).toThrow();
    });
    it('rejects unbounded text, empty concepts and malformed lists', () => {
        for (const contentAnalysis of [{ ...row.contentAnalysis, concepts: [] }, { ...row.contentAnalysis, summary: 'x'.repeat(1001) }, { ...row.contentAnalysis, trapPoints: 'wrong' }]) {
            expect(() => validateExamContentAnalysis([{ ...row, contentAnalysis }], questions)).toThrow();
            expect(normalizeQuestionContentAnalysis(contentAnalysis)).toBeUndefined();
        }
    });
    it('does not turn unreviewed AI concepts into diagnostic tags or overwrite reviewed content', () => {
        const tagged = [{ ...questions[0], tags: { concept: '교사 개념' } }];
        const result = applyExamContentAnalysis(tagged, [row]);
        expect(result[0].tags).toEqual(tagged[0].tags);
        expect(result[0].contentAnalysis?.status).toBe('draft');
        const reviewed = [{ ...tagged[0], contentAnalysis: row.contentAnalysis }];
        expect(applyExamContentAnalysis(reviewed, [row])[0]).toBe(reviewed[0]);
    });
    it('normalizes bounded reviewed metadata but rejects arbitrary status', () => {
        expect(normalizeQuestionContentAnalysis(row.contentAnalysis)).toEqual(row.contentAnalysis);
        expect(normalizeQuestionContentAnalysis({ ...row.contentAnalysis, status: 'published' })).toBeUndefined();
    });
});
