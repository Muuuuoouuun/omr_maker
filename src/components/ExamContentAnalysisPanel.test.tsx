// @vitest-environment jsdom
import React, { useState } from 'react';
import type { Question } from '@/types/omr';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ExamContentAnalysisPanel from './ExamContentAnalysisPanel';
import type { ExamContentAnalysisRow } from '@/lib/examContentAnalysis';
import { applyReviewedExamContentAnalysis } from '@/lib/examContentAnalysis';

const mocks = vi.hoisted(() => ({ analyze: vi.fn(), render: vi.fn() }));
vi.mock('@/app/actions/analyzeExam', () => ({ analyzeExamImages: mocks.analyze }));
vi.mock('@/services/examAnalysisPdf.client', () => ({ renderExamAnalysisPages: mocks.render }));
const questions = [{ id: 1, number: 1 }];
const file = new File(['pdf'], 'exam.pdf', { type: 'application/pdf' });
const result: ExamContentAnalysisRow[] = [{ questionId: 1, questionNumber: 1, tags: { unit: '대수', concept: '방정식' }, contentAnalysis: { concepts: ['방정식'], trapPoints: ['부호'], summary: '방정식의 해를 구한다.', status: 'draft' } }];
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); mocks.render.mockResolvedValue(['data:image/jpeg;base64,x']); mocks.analyze.mockResolvedValue(result); });

describe('exam content review', () => {
    it('opens and closes analysis settings with a matching accessible state', () => {
        render(<ExamContentAnalysisPanel file={file} questions={questions} enabled onApply={vi.fn()} />);
        const header = screen.getByText('시험지 개념·함정 분석').closest('summary')!;
        const panel = header.parentElement!;
        expect(header.getAttribute('aria-expanded')).toBe('false');
        fireEvent.click(header);
        expect(header.getAttribute('aria-expanded')).toBe('true');
        expect(panel.hasAttribute('open')).toBe(true);
        expect(screen.getByText('분석 설정 접기')).toBeTruthy();
        fireEvent.click(header);
        expect(panel.hasAttribute('open')).toBe(false);
        expect(screen.getByText('분석 설정 펼치기')).toBeTruthy();
    });
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
    it('reads the current personal key on every analysis request', async () => {
        localStorage.setItem('omr_settings', JSON.stringify({ api: { geminiKey: 'personal-one' } }));
        render(<ExamContentAnalysisPanel file={file} questions={questions} enabled onApply={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: '선택한 페이지 분석' }));
        await screen.findByLabelText('1번 개념');
        expect(mocks.analyze).toHaveBeenLastCalledWith(expect.any(Array), questions, 'personal-one');
        localStorage.setItem('omr_settings', JSON.stringify({ api: { geminiKey: 'personal-two' } }));
        fireEvent.click(screen.getByRole('button', { name: '선택한 페이지 분석' }));
        await waitFor(() => expect(mocks.analyze).toHaveBeenLastCalledWith(expect.any(Array), questions, 'personal-two'));
    });
    it('does not silently consume shared quota when settings storage is unavailable', async () => {
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('blocked', 'SecurityError'); });
        render(<ExamContentAnalysisPanel file={file} questions={questions} enabled onApply={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: '선택한 페이지 분석' }));
        expect((await screen.findByRole('alert')).textContent).toContain('저장된 개인 API 키 설정을 읽을 수 없습니다');
        expect(mocks.analyze).not.toHaveBeenCalled();
        expect(mocks.render).not.toHaveBeenCalled();
    });
    it('retains apply feedback across the parent update, then clears it on unrelated edits', async () => {
        function Parent() {
            const [current, setCurrent] = useState<Question[]>(questions);
            return <>
                <button onClick={() => setCurrent(items => items.map(item => ({ ...item, answer: 2 })))}>다른 문항 편집</button>
                <ExamContentAnalysisPanel file={file} questions={current} enabled onApply={rows => {
                    setCurrent(items => applyReviewedExamContentAnalysis(items, rows));
                }} />
            </>;
        }
        render(<Parent />);
        fireEvent.click(screen.getByRole('button', { name: '선택한 페이지 분석' }));
        await screen.findByLabelText('1번 개념');
        fireEvent.click(screen.getByRole('button', { name: '선택한 문항 검토 완료·적용' }));
        expect(screen.getByRole('status').textContent).toContain('1문항의 검토한 분석을 적용했습니다');
        expect(screen.queryByLabelText('1번 개념')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: '다른 문항 편집' }));
        expect(screen.queryByRole('status')).toBeNull();
    });

    it('reuses an existing concept as representative without dropping draft concepts', async () => {
        const onApply = vi.fn();
        render(<ExamContentAnalysisPanel file={file} questions={[{ id: 1, number: 1, tags: { concept: '일차방정식' } }]} enabled onApply={onApply} />);
        fireEvent.click(screen.getByRole('button', { name: '선택한 페이지 분석' }));
        const representative = await screen.findByLabelText('1번 대표 개념');
        fireEvent.change(representative, { target: { value: '일차방정식' } });
        expect((screen.getByLabelText('1번 개념') as HTMLTextAreaElement).value).toBe('일차방정식\n방정식');
        fireEvent.click(screen.getByRole('button', { name: '선택한 문항 검토 완료·적용' }));
        expect(onApply).toHaveBeenCalledWith([expect.objectContaining({ tags: expect.objectContaining({ concept: '일차방정식' }), contentAnalysis: expect.objectContaining({ concepts: ['일차방정식', '방정식'] }) })]);
    });
    it('keeps representative selection synchronized with edited concepts and prevents silent truncation', async () => {
        render(<ExamContentAnalysisPanel file={file} questions={[{ id: 1, number: 1, tags: { concept: '등록 개념' } }]} enabled onApply={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: '선택한 페이지 분석' }));
        const field = await screen.findByLabelText('1번 개념');
        fireEvent.change(field, { target: { value: 'A\nB\nC\nD\nE\nF\nG\nH' } });
        const representative = screen.getByLabelText('1번 대표 개념') as HTMLSelectElement;
        expect(representative.value).toBe('A');
        fireEvent.change(representative, { target: { value: '등록 개념' } });
        expect(screen.getByRole('alert').textContent).toContain('최대 8개');
        expect((field as HTMLTextAreaElement).value.split('\n')).toHaveLength(8);
        fireEvent.change(representative, { target: { value: 'H' } });
        expect((field as HTMLTextAreaElement).value).toBe('H\nA\nB\nC\nD\nE\nF\nG');
    });

});
