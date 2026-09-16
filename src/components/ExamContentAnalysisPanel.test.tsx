// @vitest-environment jsdom
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ExamContentAnalysisPanel from './ExamContentAnalysisPanel';
import type { ExamContentAnalysisRow } from '@/lib/examContentAnalysis';

const mocks = vi.hoisted(() => ({ analyze: vi.fn(), render: vi.fn() }));
vi.mock('@/app/actions/analyzeExam', () => ({ analyzeExamImages: mocks.analyze }));
vi.mock('@/services/examAnalysisPdf.client', () => ({ renderExamAnalysisPages: mocks.render }));
const questions = [{ id: 1, number: 1 }];
const file = new File(['pdf'], 'exam.pdf', { type: 'application/pdf' });
const result: ExamContentAnalysisRow[] = [{ questionId: 1, questionNumber: 1, tags: { unit: '대수', concept: '방정식' }, contentAnalysis: { concepts: ['방정식'], trapPoints: ['부호'], summary: '방정식의 해를 구한다.', status: 'draft' } }];
afterEach(cleanup);
beforeEach(() => { vi.clearAllMocks(); mocks.render.mockResolvedValue(['data:image/jpeg;base64,x']); mocks.analyze.mockResolvedValue(result); });

describe('exam content review', () => {
    it('locks analysis for free plans', () => {
        render(<ExamContentAnalysisPanel file={file} questions={questions} enabled={false} onApply={vi.fn()} />);
        expect(screen.getByRole('link', { name: '플랜 보기' }).getAttribute('href')).toBe('/teacher/billing');
        expect(screen.queryByRole('button', { name: '선택한 페이지 분석' })).toBeNull();
    });
    it('requires explicit review and applies edited concepts', async () => {
        const onApply = vi.fn();
        render(<ExamContentAnalysisPanel file={file} questions={questions} enabled onApply={onApply} />);
        fireEvent.click(screen.getByRole('button', { name: '선택한 페이지 분석' }));
        const field = await screen.findByLabelText('1번 개념');
        expect(onApply).not.toHaveBeenCalled();
        fireEvent.change(field, { target: { value: '일차방정식\n등식' } });
        fireEvent.click(screen.getByRole('button', { name: '선택한 문항 검토 완료·적용' }));
        expect(onApply).toHaveBeenCalledWith([expect.objectContaining({ tags: expect.objectContaining({ concept: '일차방정식' }), contentAnalysis: expect.objectContaining({ concepts: ['일차방정식', '등식'], status: 'reviewed' }) })]);
    });
    it('discards late AI results after the PDF changes', async () => {
        let resolve!: (rows: ExamContentAnalysisRow[]) => void;
        mocks.analyze.mockReturnValue(new Promise<ExamContentAnalysisRow[]>(done => { resolve = done; }));
        const onApply = vi.fn();
        const { rerender } = render(<ExamContentAnalysisPanel file={file} questions={questions} enabled onApply={onApply} />);
        fireEvent.click(screen.getByRole('button', { name: '선택한 페이지 분석' }));
        await waitFor(() => expect(mocks.analyze).toHaveBeenCalledOnce());
        rerender(<ExamContentAnalysisPanel file={new File(['new'], 'new.pdf')} questions={questions} enabled onApply={onApply} />);
        await act(async () => resolve(result));
        expect(screen.queryByLabelText('1번 개념')).toBeNull();
        expect(onApply).not.toHaveBeenCalled();
    });
});
