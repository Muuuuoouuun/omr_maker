import { describe, expect, it } from 'vitest';
import { examFromSupabaseRow, examToSupabaseRow, sanitizeExamPayload } from './omrPersistence';
import type { Exam } from '@/types/omr';

const exam: Exam = {
    id: 'analysis-exam', title: '개념 분석 시험', createdAt: '2026-09-16T00:00:00.000Z',
    questions: [{ id: 1, number: 1, answer: 3, tags: { concept: '조건부 확률' },
        contentAnalysis: { concepts: ['조건부 확률'], trapPoints: ['조건의 방향'], summary: '조건에 따른 표본공간 판단', status: 'reviewed' },
    }],
};

describe('exam content analysis persistence', () => {
    it('round-trips reviewed metadata with the exam payload without changing grading', () => {
        const restored = examFromSupabaseRow(examToSupabaseRow(exam));
        expect(restored.questions[0]).toMatchObject(exam.questions[0]);
    });
    it.each([
        { status: 'reviewed', concepts: ['확률'], trapPoints: '실수', summary: '설명' },
        { status: 'reviewed', concepts: ['확률'], trapPoints: [], summary: 'x'.repeat(1001) },
        { status: 'unknown', concepts: ['확률'], trapPoints: [], summary: '설명' },
    ])('discards malformed metadata while retaining the question', contentAnalysis => {
        const restored = sanitizeExamPayload({ ...exam, questions: [{ ...exam.questions[0], contentAnalysis }] });
        expect(restored?.questions[0]).not.toHaveProperty('contentAnalysis');
        expect(restored?.questions[0].answer).toBe(3);
    });
});
