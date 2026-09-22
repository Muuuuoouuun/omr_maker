// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { StudentConceptMastery, StudentConceptMasterySummary } from '@/lib/studentConceptMastery';
import StudentConceptMasteryPanel from './StudentConceptMasteryPanel';
import styles from './StudentConceptMasteryPanel.module.css';

afterEach(cleanup);
function group(concept: string, assessment: StudentConceptMastery['assessment'], correctRate: number): StudentConceptMastery {
    return { concept, assessment, correctRate, correctCount: 1, totalCount: 3, unansweredCount: 1, distinctQuestionCount: 3, attemptCount: 2, trendDelta: null, evidence: [{ examId: 'exam', examTitle: '시험 A', questionNumber: 7, attemptId: 'attempt/id', status: 'wrong', finishedAt: '', trapPoints: [] }] };
}
const summary: StudentConceptMasterySummary = { unmappedQuestionCount: 1, groups: [group('강한 개념', 'strength', 90), group('보완 A', 'weakness', 40), group('학습 개념', 'developing', 60), group('보완 B', 'weakness', 20), group('보완 C', 'weakness', 20)] };

describe('student concept filters', () => {
    it('prioritizes low-scoring actionable concepts stably without mutating the summary', () => {
        render(<StudentConceptMasteryPanel summary={summary} />);
        expect(screen.getAllByRole('article').map(item => item.getAttribute('aria-label'))).toEqual(['보완 B · 우선 보완', '보완 C · 우선 보완', '보완 A · 우선 보완', '학습 개념 · 학습 중', '강한 개념 · 강점']);
        expect(summary.groups[0].concept).toBe('강한 개념');
        expect(screen.getByRole('button', { name: '우선 보완 3' }).getAttribute('aria-pressed')).toBe('false');
    });
    it('keeps all groups in the document for print and handles a filter with no matches', () => {
        render(<StudentConceptMasteryPanel summary={summary} />);
        fireEvent.click(screen.getByRole('button', { name: '강점 1' }));
        expect(screen.getByRole('button', { name: '강점 1' }).getAttribute('aria-pressed')).toBe('true');
        expect(screen.getByRole('article', { name: '보완 A · 우선 보완', hidden: true }).classList.contains(styles.filtered)).toBe(true);
        fireEvent.click(screen.getByRole('button', { name: '판단 보류 0' }));
        expect(screen.getByText(/해당하는 개념이 없습니다/)).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: '전체 5' }));
        expect(document.querySelectorAll(`.${styles.filtered}`)).toHaveLength(0);
    });
    it('updates counts and evidence with props and provides canonical answer links', () => {
        const { rerender } = render(<StudentConceptMasteryPanel summary={summary} />);
        fireEvent.click(screen.getByRole('button', { name: '강점 1' }));
        rerender(<StudentConceptMasteryPanel summary={{ unmappedQuestionCount: 0, groups: [group('새 개념', 'strength', 100)] }} />);
        expect(screen.queryByText('강한 개념')).toBeNull();
        expect(screen.getByRole('button', { name: '전체 1' })).toBeTruthy();
        const toggle = screen.getByRole('button', { name: /새 개념 문항 근거 보기/ });
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        fireEvent.click(toggle);
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
        expect(screen.getByRole('link', { name: '시험 A · 7번 · 오답' }).getAttribute('href')).toBe('/teacher/attempt/attempt%2Fid?view=answers');
        rerender(<StudentConceptMasteryPanel summary={{ groups: [], unmappedQuestionCount: 0 }} />);
        expect(screen.getByText('분석 가능한 개념별 채점 기록이 없습니다.')).toBeTruthy();
        expect(screen.queryByRole('group')).toBeNull();
    });
    it('restores filtered groups and collapsed evidence in print', () => {
        const css = readFileSync('src/components/teacher/student-results/StudentConceptMasteryPanel.module.css', 'utf8');
        expect(css).toMatch(/@media print[\s\S]*\.filtered, \.collapsed\s*\{\s*display: block !important/);
    });
});
