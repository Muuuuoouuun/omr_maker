// @vitest-environment jsdom
import React, { useState } from 'react';
import type { Question } from '@/types/omr';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ExamContentAnalysisPanel from './ExamContentAnalysisPanel';
import type { ExamContentAnalysisRow } from '@/lib/examContentAnalysis';
import { applyReviewedExamContentAnalysis, discardDraftExamContentAnalysis, invalidateQuestionAnalysisForPdfChange } from '@/lib/examContentAnalysis';
import { examFromSupabaseRow, examToSupabaseRow } from '@/lib/omrPersistence';
import { validateExamDraft } from '@/lib/examValidation';

const mocks = vi.hoisted(() => ({ analyze: vi.fn(), render: vi.fn() }));
vi.mock('@/app/actions/analyzeExam', () => ({ analyzeExamImages: mocks.analyze }));
vi.mock('@/services/examAnalysisPdf.client', () => ({ renderExamAnalysisPages: mocks.render }));
const questions = [{ id: 1, number: 1 }];
const file = new File(['pdf'], 'exam.pdf', { type: 'application/pdf' });
const result: ExamContentAnalysisRow[] = [{ questionId: 1, questionNumber: 1, tags: { unit: '대수', concept: '방정식' }, contentAnalysis: { concepts: ['방정식'], trapPoints: ['부호'], summary: '방정식의 해를 구한다.', status: 'draft' } }];
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); mocks.render.mockResolvedValue(['data:image/jpeg;base64,x']); mocks.analyze.mockResolvedValue(result); });

describe('exam content review', () => {
    it.each([[0, 1], [3, 2], [1, 5], [1.5, 2]])('rejects invalid range %s–%s without rendering or spending AI usage', (start, end) => {
        render(<ExamContentAnalysisPanel file={file} questions={questions} enabled onApply={vi.fn()} />);
        fireEvent.change(screen.getByLabelText('분석 시작 쪽'), { target: { value: start } });
        fireEvent.change(screen.getByLabelText('분석 끝 쪽'), { target: { value: end } });
        fireEvent.click(screen.getByRole('button', { name: '선택한 페이지 분석' }));
        expect(screen.getByRole('alert').textContent).toContain('페이지 범위');
        expect(mocks.render).not.toHaveBeenCalled();
        expect(mocks.analyze).not.toHaveBeenCalled();
    });
    it('ignores a late result after stopping without implying that provider usage was refunded', async () => {
        let resolve!: (rows: ExamContentAnalysisRow[]) => void;
        mocks.analyze.mockReturnValue(new Promise<ExamContentAnalysisRow[]>(done => { resolve = done; }));
        const onApply = vi.fn();
        render(<ExamContentAnalysisPanel file={file} questions={questions} enabled onApply={onApply} />);
        fireEvent.click(screen.getByRole('button', { name: '선택한 페이지 분석' }));
        await waitFor(() => expect(mocks.analyze).toHaveBeenCalledOnce());
        fireEvent.click(screen.getByRole('button', { name: '결과 받기 중단' }));
        expect(screen.getByRole('status').textContent).toContain('AI 이용량은 사용될 수 있습니다');
        await act(async () => resolve(result));
        expect(screen.queryByLabelText('1번 개념')).toBeNull();
        expect(onApply).not.toHaveBeenCalled();
    });
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
    it('retains apply feedback across parent updates and score/answer edits', async () => {
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
        expect(screen.getByRole('status').textContent).toContain('1문항의 검토한 분석을 적용했습니다');
    });

    it('preserves edited AI drafts across grading edits and applies without overwriting those edits', async () => {
        function Parent() {
            const [current, setCurrent] = useState<Question[]>(questions);
            return <>
                <button onClick={() => setCurrent(items => items.map(item => ({ ...item, answer: 4, score: 3 })))}>배점 수정</button>
                <output data-testid="saved-question">{JSON.stringify(current[0])}</output>
                <ExamContentAnalysisPanel file={file} questions={current} enabled onApply={rows => setCurrent(items => applyReviewedExamContentAnalysis(items, rows))} />
            </>;
        }
        render(<Parent />);
        fireEvent.click(screen.getByRole('button', { name: '선택한 페이지 분석' }));
        fireEvent.change(await screen.findByLabelText('1번 개념'), { target: { value: '교사 수정 개념' } });
        fireEvent.click(screen.getByRole('button', { name: '배점 수정' }));
        expect((screen.getByLabelText('1번 개념') as HTMLTextAreaElement).value).toBe('교사 수정 개념');
        fireEvent.click(screen.getByRole('button', { name: '선택한 문항 검토 완료·적용' }));
        expect(JSON.parse(screen.getByTestId('saved-question').textContent!)).toMatchObject({ answer: 4, score: 3, contentAnalysis: { concepts: ['교사 수정 개념'], status: 'reviewed' } });
    });

    it('limits analysis to mapped pages and refuses the other elective before spending usage', async () => {
        const mapped: Question[] = [{ id: 1, number: 35, pdfLocation: { page: 13, x: 0.1, y: 0.2 } }];
        const { rerender } = render(<ExamContentAnalysisPanel file={file} questions={mapped} enabled onApply={vi.fn()} />);
        fireEvent.change(screen.getByLabelText('분석 시작 쪽'), { target: { value: 17 } });
        fireEvent.change(screen.getByLabelText('분석 끝 쪽'), { target: { value: 20 } });
        fireEvent.click(screen.getByRole('button', { name: '선택한 페이지 분석' }));
        expect(screen.getByRole('alert').textContent).toContain('연결된 문항이 없습니다');
        expect(mocks.analyze).not.toHaveBeenCalled();
        expect(mocks.render).not.toHaveBeenCalled();
        rerender(<ExamContentAnalysisPanel file={file} questions={[{ ...mapped[0], pdfLocation: { page: 17, x: 0.1, y: 0.2 } }, { id: 2, number: 1, pdfLocation: { page: 1, x: 0.1, y: 0.2 } }]} enabled onApply={vi.fn()} />);
        mocks.analyze.mockResolvedValue([]);
        fireEvent.click(screen.getByRole('button', { name: '선택한 페이지 분석' }));
        await waitFor(() => expect(mocks.analyze).toHaveBeenCalledWith(expect.any(Array), [{ id: 1, number: 35 }], expect.any(String)));
    });

    it('closes a draft with an explanation when question numbering changes', async () => {
        const onApply = vi.fn();
        const { rerender } = render(<ExamContentAnalysisPanel file={file} questions={questions} enabled onApply={onApply} />);
        fireEvent.click(screen.getByRole('button', { name: '선택한 페이지 분석' }));
        await screen.findByLabelText('1번 개념');
        rerender(<ExamContentAnalysisPanel file={file} questions={[{ id: 1, number: 2 }]} enabled onApply={onApply} />);
        expect(screen.queryByLabelText('1번 개념')).toBeNull();
        expect(screen.getByRole('status').textContent).toContain('분석 초안을 닫았습니다');
        expect(onApply).not.toHaveBeenCalled();
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


describe('restored analysis without a paid-plan dependency', () => {
    it.each([false, true])('allows enabled=%s to cancel or confirm excluding stale analysis and then publish without AI', enabled => {
        const changed = invalidateQuestionAnalysisForPdfChange({
            id: 1, number: 1, answer: 3, score: 5,
            tags: { concept: '직접 수정한 개념', unit: '수동 단원', skill: '수동 역량' },
            contentAnalysis: { ...result[0].contentAnalysis, status: 'reviewed' },
        });
        const restored = examFromSupabaseRow(JSON.parse(JSON.stringify(examToSupabaseRow({
            id: 'restored-exam', title: '복원 시험', createdAt: '2026-10-21T00:00:00.000Z', questions: [changed],
        }))));
        function Parent() {
            const [current, setCurrent] = useState(restored.questions);
            return <>
                <output data-testid="restored-questions">{JSON.stringify(current)}</output>
                <output data-testid="publishable">{String(validateExamDraft({ title: restored.title, questions: current }).isPublishable)}</output>
                <ExamContentAnalysisPanel file={file} questions={current} enabled={enabled}
                    onApply={rows => setCurrent(items => applyReviewedExamContentAnalysis(items, rows))}
                    onDiscardDraftAnalysis={() => setCurrent(discardDraftExamContentAnalysis)} />
            </>;
        }
        render(<Parent />);
        expect(screen.getByTestId('publishable').textContent).toBe('false');
        fireEvent.click(screen.getByRole('button', { name: '검토 대기 분석 제외 (1문항)' }));
        expect(screen.getByRole('group', { name: '검토 대기 분석 제외 확인' })).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: '취소' }));
        expect(screen.getByTestId('publishable').textContent).toBe('false');
        fireEvent.click(screen.getByRole('button', { name: '검토 대기 분석 제외 (1문항)' }));
        fireEvent.click(screen.getByRole('button', { name: '확인하고 제외' }));
        expect(screen.getByTestId('publishable').textContent).toBe('true');
        const saved = JSON.parse(screen.getByTestId('restored-questions').textContent!)[0];
        expect(saved).not.toHaveProperty('contentAnalysis');
        expect(saved).toMatchObject({ answer: 3, score: 5, tags: changed.tags });
        expect(screen.getByText('검토 대기 분석 1문항을 제외했습니다. 시험을 저장하면 반영됩니다.').getAttribute('role')).toBe('status');
        expect(mocks.analyze).not.toHaveBeenCalled();
        expect(mocks.render).not.toHaveBeenCalled();
        if (!enabled) expect(screen.queryByRole('button', { name: '선택한 페이지 분석' })).toBeNull();
    });

    it('keeps the discard route available after a Pro to Free downgrade', () => {
        const pending = [{ id: 1, number: 1, contentAnalysis: result[0].contentAnalysis }];
        const discard = vi.fn();
        const { rerender } = render(<ExamContentAnalysisPanel file={file} questions={pending} enabled onApply={vi.fn()} onDiscardDraftAnalysis={discard} />);
        rerender(<ExamContentAnalysisPanel file={file} questions={pending} enabled={false} onApply={vi.fn()} onDiscardDraftAnalysis={discard} />);
        expect(screen.queryByRole('button', { name: '선택한 페이지 분석' })).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: '검토 대기 분석 제외 (1문항)' }));
        fireEvent.click(screen.getByRole('button', { name: '확인하고 제외' }));
        expect(discard).toHaveBeenCalledOnce();
        expect(mocks.analyze).not.toHaveBeenCalled();
    });
});
