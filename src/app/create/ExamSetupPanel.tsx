'use client';

import { useState } from 'react';
import { EXAM_SETUP_PRESETS, type ExamSetupPreset } from './examSetup';

type Props = {
    totalScore: number;
    targetTotalScore: number | '';
    onTargetTotalScore: (value: number | '') => void;
    pdfPageRange: string;
    onPdfPageRange: (value: string) => void;
    mappingWarning: string;
    mappingBusy: boolean;
    onPreset: (preset: ExamSetupPreset) => void;
    onMixedPoints: (numbers: string) => void;
};

export default function ExamSetupPanel(props: Props) {
    const [threePointNumbers, setThreePointNumbers] = useState('');
    const mismatch = props.targetTotalScore !== '' && Math.abs(props.totalScore - props.targetTotalScore) > 0.001;
    return (
        <section aria-label="시험 기준과 PDF 범위" style={{ margin: '0.85rem 0', padding: '0.8rem', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', background: 'var(--surface)', fontSize: '0.85rem', lineHeight: 1.6 }}>
            <div aria-live="polite" style={{ fontWeight: 800, color: mismatch ? 'var(--error)' : 'var(--foreground)' }}>
                설정 총점 {props.totalScore}점{props.targetTotalScore !== '' ? ` / 목표 ${props.targetTotalScore}점` : ''}
            </div>
            {mismatch && <p role="status">목표와 배점 합계가 다릅니다. 원본 시험지의 2점·3점 문항을 확인하세요.</p>}
            <details>
                <summary style={{ cursor: 'pointer', padding: '0.5rem 0', fontWeight: 700 }}>시험 기준·배점 설정</summary>
                <div style={{ display: 'grid', gap: '0.65rem' }}>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
                        {(Object.keys(EXAM_SETUP_PRESETS) as ExamSetupPreset[]).map(key => <button type="button" className="btn btn-secondary" style={{ wordBreak: 'keep-all', lineHeight: 1.5 }} key={key} disabled={props.mappingBusy} onClick={() => props.onPreset(key)}>{EXAM_SETUP_PRESETS[key].label} 기본 설정</button>)}
                    </div>
                    <p style={{ color: 'var(--muted)' }}>국어 45문항·목표 100점·80분 / 물리학Ⅰ 20문항·목표 50점·30분. 적용 전 변경 내용을 확인합니다. 3점 문항 번호는 원본마다 직접 지정하세요.</p>
                    <label>목표 총점
                        <input aria-label="목표 총점" type="number" min="1" max="10000" step="0.5" className="input-field" value={props.targetTotalScore} onChange={event => {
                            const value = event.target.value;
                            if (!value) props.onTargetTotalScore('');
                            else if (Number.isFinite(Number(value)) && Number(value) > 0 && Number(value) <= 10000) props.onTargetTotalScore(Number(value));
                        }} />
                    </label>
                    <label>3점 문항 번호
                        <input aria-label="3점 문항 번호" className="input-field" value={threePointNumbers} placeholder="예: 5,8,11-12" onChange={event => setThreePointNumbers(event.target.value)} />
                    </label>
                    <p style={{ color: 'var(--muted)' }}>입력한 문항은 3점, 나머지는 2점으로 설정합니다. 비워두면 모두 2점입니다. 정답과 하위 질문은 유지합니다.</p>
                    <button type="button" className="btn btn-secondary" disabled={props.mappingBusy} onClick={() => props.onMixedPoints(threePointNumbers)}>2·3점 배점 적용 확인</button>
                </div>
            </details>
            <details>
                <summary style={{ cursor: 'pointer', padding: '0.5rem 0', fontWeight: 700 }}>PDF 자동 매칭 범위{props.pdfPageRange ? ` · ${props.pdfPageRange}p` : ' · 전체'}</summary>
                <label>포함할 PDF 페이지
                    <input aria-label="PDF 포함 페이지" className="input-field" value={props.pdfPageRange} maxLength={512} disabled={props.mappingBusy} placeholder="전체 (예: 1-12,17-20)" onChange={event => props.onPdfPageRange(event.target.value)} />
                </label>
                <p style={{ color: 'var(--muted)' }}>PDF 파일의 실제 페이지 순서입니다. 선택과목이 함께 있으면 공통과 선택한 과목의 페이지만 포함하세요.</p>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', marginTop: '0.4rem' }}>
                    <button type="button" className="btn btn-secondary" disabled={props.mappingBusy} onClick={() => props.onPdfPageRange('1-16')}>화작 범위 예시</button>
                    <button type="button" className="btn btn-secondary" disabled={props.mappingBusy} onClick={() => props.onPdfPageRange('1-12,17-20')}>언매 범위 예시</button>
                    <button type="button" className="btn btn-secondary" disabled={props.mappingBusy} onClick={() => props.onPdfPageRange('')}>전체 페이지</button>
                </div>
                <p style={{ color: 'var(--muted)' }}>위 예시는 공통 1~12p·화작 13~16p·언매 17~20p인 20페이지 시험지용입니다. 다른 편집본은 범위를 수정하세요.</p>
            </details>
            {props.mappingWarning && <p role="alert" style={{ color: 'var(--error)', overflowWrap: 'anywhere' }}>{props.mappingWarning}</p>}
        </section>
    );
}
