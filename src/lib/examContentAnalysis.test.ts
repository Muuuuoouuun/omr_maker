import { describe, expect, it } from 'vitest';
import type { Question } from '@/types/omr';
import { applyExamContentAnalysis, applyReviewedExamContentAnalysis, discardDraftExamContentAnalysis, invalidateQuestionAnalysisForPdfChange, normalizeQuestionContentAnalysis, validateExamAnalysisQuestions, validateExamContentAnalysis } from './examContentAnalysis';
import { validateExamDraft } from './examValidation';
import { examFromSupabaseRow, examToSupabaseRow } from './omrPersistence';

const questions = [{ id: 42, number: 3 }, { id: 5, number: 8 }];
const row = { questionId: 42, questionNumber: 3, tags: { unit: '함수', skill: '그래프 해석' }, contentAnalysis: { concepts: ['일차함수'], trapPoints: ['축의 단위'], summary: '기울기 해석', status: 'reviewed' as const } };
describe('exam content analysis trust boundaries', () => {
    it('requires re-review after source changes without losing original analysis or grading settings', () => {
        const original: Question = { ...questions[0], answer: 4, score: 3, tags: { concept: '일차함수', unit: '교사 단원', source: '지문 1' }, contentAnalysis: row.contentAnalysis };
        const changed = invalidateQuestionAnalysisForPdfChange(original);
        expect(changed).toMatchObject({ answer: 4, score: 3, tags: { unit: '교사 단원', source: '지문 1' }, contentAnalysis: { ...row.contentAnalysis, status: 'draft' } });
        expect(changed.tags).not.toHaveProperty('concept');
        expect(original.tags?.concept).toBe('일차함수');
        const blocked = validateExamDraft({ title: '선택과목 변경', questions: [changed] });
        expect(blocked.isPublishable).toBe(false);
        expect(blocked.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'analysis_review_required', questionIds: [42] })]));
        const reviewed = applyReviewedExamContentAnalysis([changed], [row]);
        expect(validateExamDraft({ title: '다시 검토한 시험', questions: reviewed }).isPublishable).toBe(true);
        expect(reviewed[0].tags?.concept).toBe('일차함수');
    });
    it('preserves a manually changed concept and leaves questions without AI analysis untouched', () => {
        const manual = { ...questions[0], tags: { concept: '교사가 직접 수정' }, contentAnalysis: row.contentAnalysis };
        expect(invalidateQuestionAnalysisForPdfChange(manual).tags?.concept).toBe('교사가 직접 수정');
        expect(invalidateQuestionAnalysisForPdfChange(questions[1])).toBe(questions[1]);
    });
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
    it('clears reviewed fields without leaving stale classifications or altering grading', () => {
        const original: Question[] = [{ ...questions[0], answer: 4, score: 5, tags: { unit: '옛 단원', skill: '옛 역량', concept: '옛 개념', subject: '수학', difficulty: 'hard' } }, questions[1]];
        const updated = applyReviewedExamContentAnalysis(original, [{ ...row, tags: {} }]);
        expect(updated[0]).toMatchObject({ answer: 4, score: 5, tags: { subject: '수학', difficulty: 'hard', concept: '일차함수' }, contentAnalysis: { status: 'reviewed' } });
        expect(updated[0].tags).not.toHaveProperty('unit');
        expect(updated[0].tags).not.toHaveProperty('skill');
        expect(updated[1]).toBe(original[1]);
        expect(original[0].tags?.unit).toBe('옛 단원');
        expect(() => applyReviewedExamContentAnalysis(original, [{ ...row, contentAnalysis: { ...row.contentAnalysis, status: 'draft' } }])).toThrow();
    });
});


describe('discarding draft analysis and classification provenance', () => {
    it('removes only pending analysis and its matching representative concept without changing grading or manual tags', () => {
        const draft: Question = { id: 1, number: 1, answer: 3, score: 5,
            tags: { concept: '일차함수', unit: '수동 단원', skill: '수동 역량', subject: '수학' },
            contentAnalysis: { ...row.contentAnalysis, status: 'draft' } };
        const manual: Question = { ...draft, id: 2, number: 2, tags: { concept: '직접 수정' } };
        const reviewed: Question = { ...draft, id: 3, number: 3, contentAnalysis: row.contentAnalysis };
        const updated = discardDraftExamContentAnalysis([draft, manual, reviewed, questions[1]]);
        expect(updated[0]).not.toHaveProperty('contentAnalysis');
        expect(updated[0]).toMatchObject({ answer: 3, score: 5, tags: { unit: '수동 단원', skill: '수동 역량', subject: '수학' } });
        expect(updated[0].tags).not.toHaveProperty('concept');
        expect(updated[1].tags?.concept).toBe('직접 수정');
        expect(updated[2]).toBe(reviewed);
        expect(updated[3]).toBe(questions[1]);
        expect(draft.contentAnalysis?.status).toBe('draft');
        expect(draft.tags?.concept).toBe('일차함수');
        expect(validateExamDraft({ title: '기본 시험', questions: updated.slice(0, 3) }).isPublishable).toBe(true);
    });

    it('round trips applied unit/skill provenance and clears stale automatic tags when the PDF changes', () => {
        const reviewed = applyReviewedExamContentAnalysis([{ ...questions[0], answer: 4, score: 3, tags: { source: '수동 출처' } }], [row]);
        const restored = examFromSupabaseRow(JSON.parse(JSON.stringify(examToSupabaseRow({ id: 'analysis-provenance', title: '분석 출처', createdAt: '2026-10-21T00:00:00.000Z', questions: reviewed }))));
        expect(restored.questions[0].contentAnalysis?.appliedTags).toEqual({ unit: '함수', skill: '그래프 해석' });
        const invalidated = invalidateQuestionAnalysisForPdfChange(restored.questions[0]);
        expect(invalidated.tags).toEqual({ source: '수동 출처' });
        expect(invalidated.contentAnalysis?.status).toBe('draft');
        expect(discardDraftExamContentAnalysis([invalidated])[0]).not.toHaveProperty('contentAnalysis');
        expect(restored.questions[0].tags).toMatchObject({ unit: '함수', skill: '그래프 해석' });
    });

    it('preserves independently edited tags while removing matching applied tags on both invalidate and discard', () => {
        const reviewed = applyReviewedExamContentAnalysis([questions[0]], [row])[0];
        const edited = { ...reviewed, tags: { ...reviewed.tags, unit: '교사가 새로 수정한 단원', concept: '직접 개념' } };
        for (const cleaned of [invalidateQuestionAnalysisForPdfChange(edited), discardDraftExamContentAnalysis([{ ...edited, contentAnalysis: { ...edited.contentAnalysis!, status: 'draft' } }])[0]]) {
            expect(cleaned.tags).toEqual({ unit: '교사가 새로 수정한 단원', concept: '직접 개념' });
        }
        expect(normalizeQuestionContentAnalysis({ ...row.contentAnalysis, appliedTags: { unit: 'x'.repeat(121) } })).toBeUndefined();
    });
});
