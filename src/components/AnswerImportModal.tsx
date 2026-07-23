"use client";

import { useState, useEffect, useId, useRef } from 'react';
import type { ParsedAnswer } from '@/services/answerParser';
import { readStoredGeminiApiKey } from '@/lib/geminiApiKey';
import type { AiAnswerRecognitionMode } from '@/lib/aiAnswerModelRouting';
import { BrainCircuit, FileText, FolderOpen, RefreshCw, UploadCloud, X } from 'lucide-react';
import {
    incrementAiRecognitionUsage,
} from '@/utils/plans';

interface AnswerImportModalProps {
    isOpen: boolean;
    onClose: () => void;
    onApply: (answers: ParsedAnswer[]) => void;
    onUploadAnswerPdf?: (file: File) => void; // For reference-only PDF (teacher view only)
    expectedQuestionCount?: number;
}

const LOW_CONFIDENCE_THRESHOLD = 0.65;
type AnswerRecognitionCache = { text?: ParsedAnswer[]; ai?: ParsedAnswer[] };

export function takeSelectedAnswerPdf(
    input: Pick<HTMLInputElement, "files" | "value">,
): File | null {
    const selectedFile = input.files?.[0] ?? null;
    input.value = "";
    return selectedFile;
}

export function validateImportedAnswers(
    expectedQuestionCount: number | undefined,
    parsedData: ParsedAnswer[],
    reviewedQuestions: ReadonlySet<number>,
): string | null {
    const unreviewedLowConfidence = parsedData.filter(
        item => item.confidence < LOW_CONFIDENCE_THRESHOLD && !reviewedQuestions.has(item.questionNum),
    );
    if (unreviewedLowConfidence.length > 0) {
        return `신뢰도가 낮은 ${unreviewedLowConfidence.length}개 문항을 확인해주세요.`;
    }

    if (Number.isInteger(expectedQuestionCount) && (expectedQuestionCount || 0) > 0) {
        const recognizedNumbers = new Set(parsedData.map(item => item.questionNum));
        const missing = Array.from(
            { length: expectedQuestionCount || 0 },
            (_, index) => index + 1,
        ).filter(questionNum => !recognizedNumbers.has(questionNum));
        if (missing.length > 0) {
            const preview = missing.slice(0, 12).join(", ");
            const remainder = missing.length > 12 ? ` 외 ${missing.length - 12}개` : "";
            return `누락된 문항(${preview}번${remainder})의 정답을 확인해주세요.`;
        }
    }
    return null;
}

export default function AnswerImportModal({
    isOpen,
    onClose,
    onApply,
    onUploadAnswerPdf,
    expectedQuestionCount,
}: AnswerImportModalProps) {
    const titleId = useId();
    const analysisRunRef = useRef(0);
    const analysisCacheRef = useRef<WeakMap<File, AnswerRecognitionCache>>(new WeakMap());
    const [file, setFile] = useState<File | null>(null);
    const [parsedData, setParsedData] = useState<ParsedAnswer[]>([]);
    const [isProcessing, setIsProcessing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [useAI, setUseAI] = useState(false);
    const [reviewedQuestions, setReviewedQuestions] = useState<Set<number>>(() => new Set());

    const expectedNumbers = Number.isInteger(expectedQuestionCount) && (expectedQuestionCount || 0) > 0
        ? Array.from({ length: expectedQuestionCount || 0 }, (_, index) => index + 1)
        : [];
    const recognizedNumbers = new Set(parsedData.map(item => item.questionNum));
    const missingQuestionNumbers = expectedNumbers.filter(questionNum => !recognizedNumbers.has(questionNum));
    const lowConfidenceData = parsedData.filter(item => item.confidence < LOW_CONFIDENCE_THRESHOLD);
    const unreviewedLowConfidence = lowConfidenceData.filter(item => !reviewedQuestions.has(item.questionNum));

    // Use effect to re-analyze when AI mode is toggled if file exists
    useEffect(() => {
        if (file) {
            void analyzeFile(file, useAI);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [useAI]);

    useEffect(() => () => {
        analysisRunRef.current += 1;
    }, []);

    const analyzeFile = async (
        targetFile: File,
        isAiMode: boolean,
        recognitionMode: AiAnswerRecognitionMode = "default",
    ) => {
        const analysisRun = ++analysisRunRef.current;
        const cacheKey = isAiMode ? "ai" : "text";
        setIsProcessing(true);
        setError(null);
        setParsedData([]);
        setReviewedQuestions(new Set());

        try {
            const cachedResults = recognitionMode === "default"
                ? analysisCacheRef.current.get(targetFile)?.[cacheKey]
                : undefined;
            if (cachedResults !== undefined) {
                if (cachedResults.length === 0) {
                    setError(isAiMode
                        ? "AI가 정답을 찾지 못했습니다. 이미지가 선명한지 확인해주세요."
                        : "텍스트 정답을 찾을 수 없습니다. 'AI 인식' 모드를 사용해보세요.");
                }
                setParsedData(cachedResults.map(item => ({ ...item })));
                return;
            }

            let results;
            if (isAiMode) {
                const { parseAnswerKeyWithGemini } = await import('@/services/answerParser');
                // Shared-key quota is enforced atomically by the server action.
                // A personal key is the teacher's own cost and bypasses platform quota.
                results = await parseAnswerKeyWithGemini(targetFile, readStoredGeminiApiKey(), { recognitionMode });
            } else {
                const { parseAnswerKeyPdf } = await import('@/services/answerParser');
                results = await parseAnswerKeyPdf(targetFile);
            }

            if (analysisRun !== analysisRunRef.current) return;

            if (results.length === 0) {
                setError(isAiMode
                    ? "AI가 정답을 찾지 못했습니다. 이미지가 선명한지 확인해주세요."
                    : "텍스트 정답을 찾을 수 없습니다. 'AI 인식' 모드를 사용해보세요.");
            }
            if (isAiMode && results.length > 0) {
                incrementAiRecognitionUsage();
            }
            const currentCache = analysisCacheRef.current.get(targetFile) || {};
            if (!isAiMode || results.length > 0) {
                currentCache[cacheKey] = results.map(item => ({ ...item }));
                analysisCacheRef.current.set(targetFile, currentCache);
            }
            setParsedData(results);
        } catch (err: unknown) {
            if (analysisRun !== analysisRunRef.current) return;
            const message = err instanceof Error ? err.message : String(err || "");
            if (message.includes("Gemini API key") || message.includes("GEMINI_API_KEY") || message.includes("Gemini API 키")) {
                setError("개인설정 > API 키에서 Gemini API 키를 저장한 뒤 다시 시도해주세요.");
            } else {
                setError(`분석 실패: ${message || "처리 중 오류가 발생했습니다."}`);
            }
        } finally {
            if (analysisRun === analysisRunRef.current) setIsProcessing(false);
        }
    };

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const selectedFile = takeSelectedAnswerPdf(e.currentTarget);
        if (!selectedFile) return;
        setFile(selectedFile);
        void analyzeFile(selectedFile, useAI);
    };

    const handleAnswerChange = (idx: number, newVal: string) => {
        const numVal = parseInt(newVal, 10);
        if (!Number.isInteger(numVal) || numVal < 1 || numVal > 5) return;
        setParsedData(prev => {
            const next = [...prev];
            next[idx] = { ...next[idx], answer: numVal };
            return next;
        });
        setReviewedQuestions(prev => new Set(prev).add(parsedData[idx].questionNum));
    };

    const handleApply = () => {
        const validationError = validateImportedAnswers(
            expectedQuestionCount,
            parsedData,
            reviewedQuestions,
        );
        if (validationError) {
            setError(validationError);
            return;
        }
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
                                {useAI ? "AI가 이미지를 분석하고 정답을 추출 중입니다..." : "PDF 텍스트에서 정답을 추출 중입니다..."}
                            </div>
                            <div style={{ width: '80%', height: '8px', background: '#e2e8f0', borderRadius: '4px', overflow: 'hidden', boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.1)' }}>
                                <div className="ai-loading-bar" style={{ width: '100%', height: '100%' }}></div>
                            </div>
                            <div style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>{useAI ? "보통 10~20초 정도 소요되며, 지연 요청은 자동으로 중단됩니다." : "여러 페이지를 동시에 확인하고 있습니다."}</div>
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
                            <div
                                aria-live="polite"
                                style={{
                                    marginBottom: '1rem',
                                    padding: '0.75rem',
                                    borderRadius: '6px',
                                    border: `1px solid ${unreviewedLowConfidence.length > 0 ? '#f59e0b' : 'var(--border)'}`,
                                    background: unreviewedLowConfidence.length > 0 ? '#fffbeb' : 'var(--background)',
                                    color: unreviewedLowConfidence.length > 0 ? '#92400e' : 'var(--foreground)',
                                    fontSize: '0.84rem',
                                    lineHeight: 1.5,
                                }}
                            >
                                <strong>
                                    {expectedNumbers.length > 0
                                        ? `${expectedNumbers.length}문항 중 ${expectedNumbers.length - missingQuestionNumbers.length}문항 인식`
                                        : `${parsedData.length}문항 인식`}
                                </strong>
                                {missingQuestionNumbers.length > 0 && (
                                    <div>
                                        누락 확인: {missingQuestionNumbers.slice(0, 12).join(', ')}번
                                        {missingQuestionNumbers.length > 12 ? ` 외 ${missingQuestionNumbers.length - 12}개` : ''}
                                    </div>
                                )}
                                {unreviewedLowConfidence.length > 0 && (
                                    <div>신뢰도가 낮은 {unreviewedLowConfidence.length}개 문항은 답을 확인한 뒤 ‘검토 완료’를 선택해주세요.</div>
                                )}
                            </div>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))', gap: '0.5rem' }}>
                                {parsedData.map((item, idx) => (
                                    <div
                                        key={item.questionNum}
                                        style={{
                                            padding: '0.5rem',
                                            border: `1px solid ${item.confidence < LOW_CONFIDENCE_THRESHOLD ? '#f59e0b' : 'var(--border)'}`,
                                            borderRadius: '4px',
                                            textAlign: 'center',
                                            background: item.confidence < LOW_CONFIDENCE_THRESHOLD ? '#fffbeb' : 'var(--surface)',
                                        }}
                                    >
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
                                        <div style={{ marginTop: '0.3rem', fontSize: '0.7rem', color: item.confidence < LOW_CONFIDENCE_THRESHOLD ? '#b45309' : 'var(--muted)' }}>
                                            신뢰도 {Math.round(item.confidence * 100)}%
                                        </div>
                                        {item.confidence < LOW_CONFIDENCE_THRESHOLD && (
                                            <label style={{ marginTop: '0.3rem', display: 'inline-flex', alignItems: 'center', gap: '0.25rem', color: '#92400e', fontSize: '0.72rem', cursor: 'pointer' }}>
                                                <input
                                                    type="checkbox"
                                                    checked={reviewedQuestions.has(item.questionNum)}
                                                    onChange={(event) => setReviewedQuestions(prev => {
                                                        const next = new Set(prev);
                                                        if (event.target.checked) next.add(item.questionNum);
                                                        else next.delete(item.questionNum);
                                                        return next;
                                                    })}
                                                />
                                                검토 완료
                                            </label>
                                        )}
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
                            disabled={!file || parsedData.length === 0 || missingQuestionNumbers.length > 0 || unreviewedLowConfidence.length > 0 || isProcessing}
                        >
                            적용하기
                        </button>
                    </div>
                </footer>
            </div>
        </div>
    );
}
