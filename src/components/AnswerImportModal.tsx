"use client";

import { useState, useEffect } from 'react';
import { parseAnswerKeyPdf, ParsedAnswer } from '@/services/answerParser';

interface AnswerImportModalProps {
    isOpen: boolean;
    onClose: () => void;
    onApply: (answers: ParsedAnswer[]) => void;
    onUploadAnswerPdf?: (file: File) => void; // For reference-only PDF (teacher view only)
}

export default function AnswerImportModal({ isOpen, onClose, onApply, onUploadAnswerPdf }: AnswerImportModalProps) {
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

    const analyzeFile = async (targetFile: File, isAiMode: boolean) => {
        setIsProcessing(true);
        setError(null);
        setParsedData([]);

        try {
            let results;
            if (isAiMode) {
                const { parseAnswerKeyWithGemini } = await import('@/services/answerParser');
                results = await parseAnswerKeyWithGemini(targetFile);
            } else {
                results = await parseAnswerKeyPdf(targetFile);
            }

            if (results.length === 0) {
                setError(isAiMode
                    ? "AI가 정답을 찾지 못했습니다. 이미지가 선명한지 확인해주세요."
                    : "텍스트 정답을 찾을 수 없습니다. 'AI 인식' 모드를 사용보세요.");
            }
            setParsedData(results);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (err: any) {
            console.error(err);
            if (err.message && err.message.includes("GEMINI_API_KEY")) {
                setError("서버에 GEMINI_API_KEY가 설정되지 않았습니다.");
            } else {
                setError(`분석 실패: ${err.message || err.toString()}`);
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
            zIndex: 1000
        }}>
            <div style={{
                background: 'white',
                width: '600px',
                maxHeight: '80vh',
                borderRadius: '8px',
                display: 'flex', flexDirection: 'column',
                boxShadow: '0 4px 6px rgba(0,0,0,0.1)'
            }}>
                <header style={{ padding: '1.5rem', borderBottom: '1px solid #eee', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <h2 style={{ fontSize: '1.25rem', fontWeight: 600 }}>정답 PDF 불러오기</h2>
                    <button onClick={onClose} style={{ border: 'none', background: 'none', fontSize: '1.5rem', cursor: 'pointer' }}>&times;</button>
                </header>

                <div style={{ padding: '1.5rem', overflowY: 'auto', flex: 1 }}>
                    <div style={{ marginBottom: '1.5rem', textAlign: 'center', padding: '2rem', border: '2px dashed #ddd', borderRadius: '8px' }}>
                        <input type="file" accept=".pdf" onChange={handleFileChange} style={{ display: 'none' }} id="answer-pdf-upload" />
                        <label htmlFor="answer-pdf-upload" className="btn btn-primary" style={{ cursor: 'pointer', display: 'inline-block' }}>
                            {file ? "PDF 변경하기" : "PDF 업로드하여 정답 추출"}
                        </label>
                        {file && <p style={{ marginTop: '0.5rem', fontSize: '0.9rem', color: '#666' }}>{file.name}</p>}
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
                            🤖 AI(Gemini)로 정답 인식하기 <span style={{ fontSize: '0.7rem', color: '#ef4444', border: '1px solid #ef4444', padding: '1px 4px', borderRadius: '4px' }}>추천</span>
                        </label>
                    </div>

                    {isProcessing && (
                        <div style={{ textAlign: 'center', padding: '2rem 1rem', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem', background: 'rgba(99, 102, 241, 0.05)', borderRadius: '8px', marginBottom: '1.5rem', border: '1px solid rgba(99, 102, 241, 0.2)' }}>
                            <div style={{ fontWeight: 600, color: 'var(--primary)', fontSize: '1.05rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                <span className="animate-pulse">✨</span> AI가 이미지를 분석하고 정답을 추출 중입니다... <span className="animate-pulse">✨</span>
                            </div>
                            <div style={{ width: '80%', height: '8px', background: '#e2e8f0', borderRadius: '4px', overflow: 'hidden', boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.1)' }}>
                                <div className="ai-loading-bar" style={{ width: '100%', height: '100%' }}></div>
                            </div>
                            <div style={{ fontSize: '0.85rem', color: '#666' }}>최대 10~20초 정도 소요될 수 있습니다. 잠시만 기다려주세요!</div>
                        </div>
                    )}

                    {error && <div style={{ color: 'red', padding: '1rem', background: '#fff0f0', borderRadius: '4px' }}>{error}</div>}

                    {parsedData.length > 0 && (
                        <div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '1rem', alignItems: 'center' }}>
                                <h3 style={{ fontWeight: 600 }}>추출 결과 ({parsedData.length}문항)</h3>
                                <span style={{ fontSize: '0.8rem', color: '#666' }}>필요시 직접 수정하세요</span>
                            </div>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))', gap: '0.5rem' }}>
                                {parsedData.map((item, idx) => (
                                    <div key={idx} style={{ padding: '0.5rem', border: '1px solid #eee', borderRadius: '4px', textAlign: 'center' }}>
                                        <div style={{ fontSize: '0.8rem', color: '#666', marginBottom: '0.2rem' }}>
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

                <footer style={{ padding: '1.5rem', borderTop: '1px solid #eee', display: 'flex', justifyContent: 'space-between', gap: '0.5rem' }}>
                    <button
                        onClick={() => {
                            if (file && onUploadAnswerPdf) {
                                onUploadAnswerPdf(file);
                                onClose();
                            }
                        }}
                        className="btn btn-secondary"
                        disabled={!file || !onUploadAnswerPdf}
                        style={{ color: '#10b981', borderColor: '#10b981' }}
                        title="분석 없이 참고용으로 업로드 (학생에게는 제출 후 공개)"
                    >
                        📁 참고용 답지 업로드
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
