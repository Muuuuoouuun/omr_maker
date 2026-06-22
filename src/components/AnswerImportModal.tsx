"use client";

import { useState, useEffect, useId } from 'react';
import { parseAnswerKeyPdf, ParsedAnswer } from '@/services/answerParser';
import { readStoredGeminiApiKey } from '@/lib/geminiApiKey';
import type { AiAnswerRecognitionMode } from '@/lib/aiAnswerModelRouting';
import { BrainCircuit, FileText, FolderOpen, RefreshCw, UploadCloud, X } from 'lucide-react';
import {
    evaluatePlanLimit,
    getCurrentPlan,
    getPlanLabel,
    incrementAiRecognitionUsage,
    PLAN_BY_KEY,
    readAiRecognitionUsage,
} from '@/utils/plans';

interface AnswerImportModalProps {
    isOpen: boolean;
    onClose: () => void;
    onApply: (answers: ParsedAnswer[]) => void;
    onUploadAnswerPdf?: (file: File) => void; // For reference-only PDF (teacher view only)
}

export default function AnswerImportModal({ isOpen, onClose, onApply, onUploadAnswerPdf }: AnswerImportModalProps) {
    const titleId = useId();
    const [file, setFile] = useState<File | null>(null);
    const [parsedData, setParsedData] = useState<ParsedAnswer[]>([]);
    const [isProcessing, setIsProcessing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [useAI, setUseAI] = useState(false);

    // Use effect to re-analyze when AI mode is toggled if file exists
    useEffect(() => {
        if (file) {
            analyzeFile(file, useAI);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [useAI]);

    const analyzeFile = async (
        targetFile: File,
        isAiMode: boolean,
        recognitionMode: AiAnswerRecognitionMode = "default",
    ) => {
        setIsProcessing(true);
        setError(null);
        setParsedData([]);

        try {
            let results;
            if (isAiMode) {
                const plan = getCurrentPlan();
                const limit = evaluatePlanLimit(plan, "aiRecognition", readAiRecognitionUsage(), 1);
                if (!limit.allowed) {
                    const upgradeName = limit.upgradeTarget ? PLAN_BY_KEY[limit.upgradeTarget].name : "상위";
                    setError(`${getPlanLabel(plan)} 플랜의 AI 정답 인식 한도(${limit.limit}회)를 모두 사용했습니다. ${upgradeName} 플랜에서 계속 사용할 수 있습니다.`);
                    return;
                }
                const { parseAnswerKeyWithGemini } = await import('@/services/answerParser');
                results = await parseAnswerKeyWithGemini(targetFile, readStoredGeminiApiKey(), { recognitionMode });
            } else {
                results = await parseAnswerKeyPdf(targetFile);
            }

            if (results.length === 0) {
                setError(isAiMode
                    ? "AI가 정답을 찾지 못했습니다. 이미지가 선명한지 확인해주세요."
                    : "텍스트 정답을 찾을 수 없습니다. 'AI 인식' 모드를 사용보세요.");
            }
            if (isAiMode && results.length > 0) {
                incrementAiRecognitionUsage();
            }
            setParsedData(results);
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err || "");
            if (message.includes("Gemini API key") || message.includes("GEMINI_API_KEY") || message.includes("Gemini API 키")) {
                setError("개인설정 > API 키에서 Gemini API 키를 저장한 뒤 다시 시도해주세요.");
            } else {
                setError(`분석 실패: ${message || "처리 중 오류가 발생했습니다."}`);
            }
        } finally {
            setIsProcessing(false);
        }
    };

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files[0]) {
            const selectedFile = e.target.files[0];
            setFile(selectedFile);
            analyzeFile(selectedFile, useAI);
        }
    };

    const handleAnswerChange = (idx: number, newVal: string) => {
        const numVal = parseInt(newVal, 10);
        setParsedData(prev => {
            const next = [...prev];
            next[idx] = { ...next[idx], answer: numVal };
            return next;
        });
    };

    const handleApply = () => {
        if (parsedData.length > 0) {
            onApply(parsedData);
        }
        if (file && onUploadAnswerPdf) {
            onUploadAnswerPdf(file);
        }
        onClose();
    };

    if (!isOpen) return null;

    return (
        <div style={{
            position: 'fixed', inset: 0,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 1000,
            padding: '1rem'
        }}>
            <div
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                style={{
                background: 'var(--surface)',
                color: 'var(--foreground)',
                width: '600px',
                maxWidth: '100%',
                maxHeight: '80vh',
                borderRadius: '8px',
                display: 'flex', flexDirection: 'column',
                border: '1px solid var(--border)',
                boxShadow: '0 24px 48px rgba(0,0,0,0.22)'
            }}>
                <header style={{ padding: '1.5rem', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <h2 id={titleId} style={{ fontSize: '1.25rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <FileText size={20} />
                        정답 PDF 불러오기
                    </h2>
                    <button onClick={onClose} aria-label="정답 PDF 모달 닫기" style={{ border: 'none', background: 'none', color: 'var(--muted)', cursor: 'pointer', width: 44, height: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                        <X size={20} />
                    </button>
                </header>

                <div style={{ padding: '1.5rem', overflowY: 'auto', flex: 1 }}>
                    <div style={{ marginBottom: '1.5rem', textAlign: 'center', padding: '2rem', border: '2px dashed var(--border)', borderRadius: '8px', background: 'var(--background)' }}>
                        <input type="file" accept=".pdf" onChange={handleFileChange} style={{ display: 'none' }} id="answer-pdf-upload" />
                        <label htmlFor="answer-pdf-upload" className="btn btn-primary" style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
                            <UploadCloud size={17} />
                            {file ? "PDF 변경하기" : "PDF 업로드하여 정답 추출"}
                        </label>
                        {file && <p style={{ marginTop: '0.5rem', fontSize: '0.9rem', color: 'var(--muted)' }}>{file.name}</p>}
                    </div>

                    <div style={{ marginBottom: '1.5rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}>
                        <input
                            type="checkbox"
                            id="use-ai-mode"
                            checked={useAI}
                            onChange={(e) => setUseAI(e.target.checked)}
                            style={{ width: '1.2rem', height: '1.2rem' }}
                        />
                        <label htmlFor="use-ai-mode" style={{ fontWeight: 500, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                            <BrainCircuit size={17} />
                            AI(Gemini)로 정답 인식하기 <span style={{ fontSize: '0.7rem', color: '#ef4444', border: '1px solid #ef4444', padding: '1px 4px', borderRadius: '4px' }}>추천</span>
                        </label>
                    </div>

                    {isProcessing && (
                        <div style={{ textAlign: 'center', padding: '2rem 1rem', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem', background: 'rgba(99, 102, 241, 0.05)', borderRadius: '8px', marginBottom: '1.5rem', border: '1px solid rgba(99, 102, 241, 0.2)' }}>
                            <div style={{ fontWeight: 600, color: 'var(--primary)', fontSize: '1.05rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                <BrainCircuit size={18} className="animate-pulse" />
                                AI가 이미지를 분석하고 정답을 추출 중입니다...
                            </div>
                            <div style={{ width: '80%', height: '8px', background: '#e2e8f0', borderRadius: '4px', overflow: 'hidden', boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.1)' }}>
                                <div className="ai-loading-bar" style={{ width: '100%', height: '100%' }}></div>
                            </div>
                            <div style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>최대 10~20초 정도 소요될 수 있습니다.</div>
                        </div>
                    )}

                    {error && <div role="alert" style={{ color: '#b91c1c', padding: '1rem', background: '#fef2f2', borderRadius: '4px', border: '1px solid #fecaca' }}>{error}</div>}

                    {parsedData.length > 0 && (
                        <div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '1rem', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                                <h3 style={{ fontWeight: 600 }}>추출 결과 ({parsedData.length}문항)</h3>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                                    {useAI && file && (
                                        <button
                                            type="button"
                                            onClick={() => analyzeFile(file, true, "rerecognition")}
                                            className="btn btn-secondary"
                                            disabled={isProcessing}
                                            style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', padding: '0.45rem 0.65rem', fontSize: '0.82rem' }}
                                            title="정답 이미지 다시 인식"
                                        >
                                            <RefreshCw size={14} />
                                            재인식
                                        </button>
                                    )}
                                    <span style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>필요시 직접 수정하세요</span>
                                </div>
                            </div>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))', gap: '0.5rem' }}>
                                {parsedData.map((item, idx) => (
                                    <div key={idx} style={{ padding: '0.5rem', border: '1px solid var(--border)', borderRadius: '4px', textAlign: 'center', background: 'var(--surface)' }}>
                                        <div style={{ fontSize: '0.8rem', color: 'var(--muted)', marginBottom: '0.2rem' }}>
                                            문항 {item.questionNum}
                                            {item.score && <span style={{ color: '#10b981', marginLeft: '4px' }}>({item.score}점)</span>}
                                        </div>
                                        <select
                                            value={item.answer}
                                            onChange={(e) => handleAnswerChange(idx, e.target.value)}
                                            style={{ padding: '0.2rem', borderRadius: '4px', border: '1px solid #ccc', fontWeight: 'bold' }}
                                        >
                                            <option value={1}>①</option>
                                            <option value={2}>②</option>
                                            <option value={3}>③</option>
                                            <option value={4}>④</option>
                                            <option value={5}>⑤</option>
                                        </select>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>

                <footer style={{ padding: '1.5rem', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' }}>
                    <button
                        onClick={() => {
                            if (file && onUploadAnswerPdf) {
                                onUploadAnswerPdf(file);
                                onClose();
                            }
                        }}
                        className="btn btn-secondary"
                        disabled={!file || !onUploadAnswerPdf}
                        style={{ color: '#0f766e', borderColor: '#0f766e', display: 'inline-flex', alignItems: 'center', gap: '0.45rem' }}
                        title="분석 없이 참고용으로 업로드 (학생에게는 제출 후 공개)"
                    >
                        <FolderOpen size={17} />
                        참고용 답지 업로드
                    </button>
                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                        <button onClick={onClose} className="btn btn-secondary">취소</button>
                        <button
                            onClick={handleApply}
                            className="btn btn-primary"
                            disabled={!file}
                        >
                            적용하기
                        </button>
                    </div>
                </footer>
            </div>
        </div>
    );
}
