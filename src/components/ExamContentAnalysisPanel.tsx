"use client";

import { useEffect, useRef, useState } from 'react';
import { BrainCircuit, Loader2 } from 'lucide-react';
import { analyzeExamImages } from '@/app/actions/analyzeExam';
import { PremiumFeatureCard } from '@/components/PremiumFeatureGate';
import { applyReviewedExamContentAnalysis, validateExamContentAnalysis, type ExamContentAnalysisRow } from '@/lib/examContentAnalysis';
import { readStoredGeminiApiKey } from '@/lib/geminiApiKey';
import type { Question } from '@/types/omr';

interface Props {
    file: File | null;
    questions: Question[];
    enabled: boolean;
    onApply: (rows: ExamContentAnalysisRow[]) => void;
}
interface EditableRow {
    questionId: number;
    questionNumber: number;
    concepts: string;
    trapPoints: string;
    summary: string;
    unit: string;
    skill: string;
    selected: boolean;
}
const list = (value: string) => value.split('\n').map(item => item.trim()).filter(Boolean);
function editRow(row: ExamContentAnalysisRow): EditableRow {
    return { questionId: row.questionId, questionNumber: row.questionNumber, concepts: row.contentAnalysis.concepts.join('\n'), trapPoints: row.contentAnalysis.trapPoints.join('\n'), summary: row.contentAnalysis.summary, unit: row.tags.unit || '', skill: row.tags.skill || '', selected: true };
}

export default function ExamContentAnalysisPanel({ file, questions, enabled, onApply }: Props) {
    const [start, setStart] = useState(1);
    const [end, setEnd] = useState(1);
    const [rows, setRows] = useState<EditableRow[]>([]);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState('');
    const [error, setError] = useState('');
    const generation = useRef(0);
    const acceptedContext = useRef<{ file: File | null; questions: Question[] } | null>(null);
    const pendingApply = useRef<{ file: File | null; questions: string } | null>(null);
    useEffect(() => {
        const isOwnAppliedUpdate = enabled && pendingApply.current?.file === file
            && pendingApply.current.questions === JSON.stringify(questions);
        pendingApply.current = null;
        generation.current++;
        acceptedContext.current = null;
        // A PDF replacement or question edit invalidates pending AI work and its review.
        setRows([]);
        setBusy(false);
        setError('');
        if (!isOwnAppliedUpdate) setMessage('');
        const cancelGeneration = () => { generation.current++; };
        return cancelGeneration;
    }, [file, questions, enabled]);

    if (!enabled) return <PremiumFeatureCard title="시험지 개념·함정 분석" description="문제지 PDF의 문항별 개념과 함정 포인트를 분석하고, 검토한 내용을 학생의 강점·약점 분석에 활용합니다." style={{ marginBottom: '1rem' }} />;

    async function analyze() {
        if (!file || busy) return;
        const token = ++generation.current;
        const isCurrent = () => generation.current === token;
        setBusy(true); setError(''); setMessage('선택한 PDF 페이지를 준비하고 있습니다.'); setRows([]);
        acceptedContext.current = null;
        try {
            let personalApiKey: string;
            try { personalApiKey = readStoredGeminiApiKey(); } catch {
                throw new Error('저장된 개인 API 키 설정을 읽을 수 없습니다. 브라우저 저장소 설정을 확인한 뒤 다시 시도해 주세요.');
            }
            const { renderExamAnalysisPages } = await import('@/services/examAnalysisPdf.client');
            const images = await renderExamAnalysisPages(file, start, end, isCurrent);
            if (!isCurrent()) return;
            setMessage('문항별 개념과 함정 포인트를 분석하고 있습니다.');
            const result = await analyzeExamImages(images, questions.map(({ id, number }) => ({ id, number })), personalApiKey);
            if (!isCurrent()) return;
            acceptedContext.current = { file, questions };
            setRows(result.map(editRow));
            setMessage(result.length ? `${start}~${end}쪽에서 ${result.length}문항을 찾았습니다. 번호와 내용을 확인한 뒤 적용하세요. 기존 분석은 선택한 문항만 교체합니다.` : '이 범위에서 분석 가능한 문항을 찾지 못했습니다. 페이지와 문항 수를 확인해 주세요.');
        } catch (cause) {
            if (isCurrent()) { setError(cause instanceof Error ? cause.message : '분석에 실패했습니다. 다시 시도해 주세요.'); setMessage(''); }
        } finally { if (isCurrent()) setBusy(false); }
    }
    function apply() {
        if (acceptedContext.current?.file !== file || acceptedContext.current?.questions !== questions) return;
        try {
            const selected = rows.filter(row => row.selected);
            if (!selected.length) throw new Error('적용할 문항을 선택해 주세요.');
            const validated = validateExamContentAnalysis(selected.map(row => ({ questionId: row.questionId, questionNumber: row.questionNumber, tags: { ...(row.unit.trim() ? { unit: row.unit.trim() } : {}), ...(row.skill.trim() ? { skill: row.skill.trim() } : {}) }, contentAnalysis: { concepts: list(row.concepts), trapPoints: list(row.trapPoints), summary: row.summary.trim(), status: 'draft' } })), questions);
            const reviewed = validated.map(row => ({ ...row, contentAnalysis: { ...row.contentAnalysis, status: 'reviewed' as const } }));
            pendingApply.current = { file, questions: JSON.stringify(applyReviewedExamContentAnalysis(questions, reviewed)) };
            onApply(reviewed);
            setRows([]); setError(''); setMessage(`${validated.length}문항의 검토한 분석을 적용했습니다. 시험을 저장하면 함께 보관됩니다.`);
        } catch { pendingApply.current = null; setError('선택한 문항의 개념과 요약을 입력해 주세요. 개념·함정은 각각 최대 8개(각 200자), 요약은 1,000자까지 가능합니다.'); }
    }
    function patch(id: number, update: Partial<EditableRow>) { setRows(current => current.map(row => row.questionId === id ? { ...row, ...update } : row)); }
    const saved = questions.filter(question => question.contentAnalysis);
    return <details className="card" aria-label="시험지 개념·함정 분석" style={{ padding: '1rem', marginBottom: '1rem' }}>
        <summary style={{ cursor: 'pointer', fontWeight: 700 }}>시험지 개념·함정 분석 <span className="hint">Pro · {saved.length ? `${saved.length}문항 저장됨` : '펼치기'}</span></summary>
        <p className="hint" style={{ margin: '0.6rem 0', lineHeight: 1.6 }}>업로드한 문제지에서 개념과 함정 포인트를 AI 초안으로 만듭니다. 검토한 분석의 첫 번째 개념을 대표 개념으로 사용해 학생별 누적 강점·약점을 비교합니다.</p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'end', flexWrap: 'wrap' }}>
            <label style={{ flex: 1 }}>시작 쪽<input aria-label="분석 시작 쪽" className="input-field" type="number" min={1} value={start} disabled={busy} onChange={event => setStart(Number(event.target.value))} /></label>
            <label style={{ flex: 1 }}>끝 쪽<input aria-label="분석 끝 쪽" className="input-field" type="number" min={start} max={start + 3} value={end} disabled={busy} onChange={event => setEnd(Number(event.target.value))} /></label>
        </div>
        <p className="hint" style={{ margin: '0.4rem 0' }}>한 번에 최대 4쪽 · 선택한 페이지만 AI 분석 서비스로 전송됩니다. 설정에 저장된 개인 API 키가 있으면 해당 키를 사용하며, 없으면 공용 AI 이용량을 사용합니다.</p>
        <button type="button" className="btn btn-secondary" onClick={analyze} disabled={!file || busy}>{busy ? <Loader2 size={16} className="animate-spin" /> : <BrainCircuit size={16} />}{busy ? '분석 중' : '선택한 페이지 분석'}</button>
        {busy ? <button type="button" className="btn btn-secondary" onClick={() => { generation.current++; setBusy(false); setMessage('분석 결과 수신을 취소했습니다.'); }}>취소</button> : null}
        {!file ? <p className="hint">먼저 문제지 PDF를 업로드해 주세요.</p> : null}
        {saved.length ? <p className="hint">PDF를 교체해도 저장된 분석은 자동 갱신되지 않습니다. 새 문제지와 일치하는지 검토하거나 다시 분석해 주세요.</p> : null}
        {saved.length && !busy ? <button type="button" className="btn btn-secondary" style={{ marginTop: 8 }} onClick={() => { acceptedContext.current = { file, questions }; setRows(saved.map(question => editRow({ questionId: question.id, questionNumber: question.number, tags: question.tags || {}, contentAnalysis: question.contentAnalysis! }))); setError(''); setMessage('저장된 분석을 검토하고 수정할 수 있습니다.'); }}>저장된 분석 검토 ({saved.length}문항)</button> : null}
        {message ? <p role="status" className="hint" style={{ marginTop: 8 }}>{message}</p> : null}
        {error ? <p role="alert" style={{ color: 'var(--danger)', marginTop: 8 }}>{error}</p> : null}
        {rows.length ? <div style={{ marginTop: 12 }}>
            <p className="hint">AI 결과는 틀릴 수 있습니다. 아래 함정은 문제의 잠재적 함정이며 학생이 실제로 범한 실수로 단정하지 않습니다.</p>
            {rows.map(row => <details key={row.questionId} open style={{ borderTop: '1px solid var(--border)', padding: '0.75rem 0' }}>
                <summary style={{ cursor: 'pointer', fontWeight: 700 }}>{row.questionNumber}번 · 검토 대기</summary>
                <label style={{ display: 'block', margin: '0.5rem 0' }}><input type="checkbox" checked={row.selected} onChange={event => patch(row.questionId, { selected: event.target.checked })} /> 이 문항 적용</label>
                <label>개념 (한 줄에 하나)<textarea className="input-field" aria-label={`${row.questionNumber}번 개념`} rows={2} value={row.concepts} onChange={event => patch(row.questionId, { concepts: event.target.value })} /></label>
                <label>단원<input className="input-field" aria-label={`${row.questionNumber}번 단원`} maxLength={120} value={row.unit} onChange={event => patch(row.questionId, { unit: event.target.value })} /></label>
                <label>평가 역량<input className="input-field" aria-label={`${row.questionNumber}번 평가 역량`} maxLength={120} value={row.skill} onChange={event => patch(row.questionId, { skill: event.target.value })} /></label>
                <label>함정 포인트 (한 줄에 하나)<textarea className="input-field" aria-label={`${row.questionNumber}번 함정 포인트`} rows={2} value={row.trapPoints} onChange={event => patch(row.questionId, { trapPoints: event.target.value })} /></label>
                <label>출제 의도·요약<textarea className="input-field" aria-label={`${row.questionNumber}번 출제 의도`} rows={3} maxLength={1000} value={row.summary} onChange={event => patch(row.questionId, { summary: event.target.value })} /></label>
            </details>)}
            <button type="button" className="btn btn-primary" onClick={apply} disabled={!rows.some(row => row.selected)}>선택한 문항 검토 완료·적용</button>
            <button type="button" className="btn btn-secondary" onClick={() => { setRows([]); setMessage('초안을 닫았습니다.'); }}>초안 닫기</button>
        </div> : null}
    </details>;
}
