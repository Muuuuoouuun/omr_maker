"use client";

import Link from "next/link";
import OMRPreview from "@/components/OMRPreview";
import dynamic from "next/dynamic";
import AnswerImportModal from "@/components/AnswerImportModal";
import DistributeModal from "@/components/DistributeModal";

const PDFViewer = dynamic(() => import("@/components/PDFViewer"), { ssr: false });
import { useState, useEffect } from "react";
import html2canvas from "html2canvas";
import { Question } from "@/types/omr";

export default function CreateOMRPage() {
    // UI State
    const [isSaving, setIsSaving] = useState(false);
    const [isImportModalOpen, setIsImportModalOpen] = useState(false);
    const [isDistributeModalOpen, setIsDistributeModalOpen] = useState(false);

    // OMR Data State
    const [title, setTitle] = useState("기말고사 OMR");
    const [questionsCount, setQuestionsCount] = useState(20);
    const [columns, setColumns] = useState(2);
    const [questions, setQuestions] = useState<Question[]>([]);

    // Interaction State
    const [selectedQuestionId, setSelectedQuestionId] = useState<number | null>(null);
    const [customLabel, setCustomLabel] = useState("");

    // PDF State
    const [pdfFile, setPdfFile] = useState<File | null>(null);
    const [answerKeyPdf, setAnswerKeyPdf] = useState<File | null>(null); // Teacher reference answer key
    const [activeViewTab, setActiveViewTab] = useState<'problem' | 'answer'>('problem');

    // Initialize questions when count changes
    useEffect(() => {
        // Reuse existing questions if possible to keep data
        setQuestions(prev => {
            const newQuestions: Question[] = [];
            for (let i = 0; i < questionsCount; i++) {
                if (i < prev.length) {
                    newQuestions.push(prev[i]);
                } else {
                    newQuestions.push({
                        id: i + 1,
                        number: i + 1,
                    });
                }
            }
            return newQuestions;
        });
    }, [questionsCount]);

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files[0]) {
            setPdfFile(e.target.files[0]);
        }
    };

    const handleFileDrop = (file: File) => {
        setPdfFile(file);
    };

    const handlePdfPageClick = (page: number, x: number, y: number) => {
        if (selectedQuestionId === null) {
            alert("먼저 연결할 문항을 OMR에서 선택해주세요!");
            return;
        }

        // Update the selected question with PDF location
        setQuestions(prev => prev.map(q =>
            q.id === selectedQuestionId
                ? { ...q, pdfLocation: { page, x, y } }
                : q
        ));
    };

    const toggleLabel = (label: string) => {
        if (selectedQuestionId === null) return;
        setQuestions(prev => prev.map(q => {
            if (q.id !== selectedQuestionId) return q;
            return { ...q, label: label === q.label ? undefined : label };
        }));
    };

    const setAnswer = (answer: number) => {
        if (selectedQuestionId === null) return;
        setQuestions(prev => prev.map(q =>
            q.id === selectedQuestionId
                ? { ...q, answer: answer }
                : q
        ));
    };

    const handleOMRAnswerClick = (qId: number, answer: number) => {
        setSelectedQuestionId(qId);
        setQuestions(prev => prev.map(q =>
            q.id === qId ? { ...q, answer: answer } : q
        ));
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handleShareConfig = async (accessConfig: any) => {
        const fileToBase64 = (file: File): Promise<string> => {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result as string);
                reader.onerror = reject;
                reader.readAsDataURL(file);
            });
        };

        try {
            // Convert both PDFs to base64
            let pdfBase64 = "";
            if (pdfFile) {
                pdfBase64 = await fileToBase64(pdfFile);
            }

            let answerKeyBase64 = "";
            if (answerKeyPdf) {
                answerKeyBase64 = await fileToBase64(answerKeyPdf);
            }

            // Save to LocalStorage and generate ID
            const id = Date.now().toString(36);
            const examData = {
                id,
                title,
                questions,
                accessConfig,
                pdfData: pdfBase64, // Problem PDF
                answerKeyPdf: answerKeyBase64, // Reference Key
                createdAt: new Date().toISOString()
            };

            localStorage.setItem(`omr_exam_${id}`, JSON.stringify(examData));
            const shareUrl = `${window.location.origin}/solve/${id}`;
            return shareUrl;
        } catch (e) {
            console.error(e);
            alert("배포 데이터 저장 실패: 파일 용량이 너무 큽니다. (LocalStorage 한계)");
            return "";
        }
    };

    const handleAnswerImport = (importedAnswers: Record<number, number>) => {
        // Find max question number to auto-resize exam if needed
        const maxQ = Math.max(...Object.keys(importedAnswers).map(Number));
        if (maxQ > questionsCount) {
            if (confirm(`가져온 정답이 ${maxQ}번까지 있습니다. 문항 수를 늘리시겠습니까?`)) {
                setQuestionsCount(maxQ);
            }
        }

        setQuestions(prev => prev.map(q => {
            if (importedAnswers[q.number]) {
                return { ...q, answer: importedAnswers[q.number] };
            }
            return q;
        }));

        alert("정답이 적용되었습니다!");
    };

    const handleSaveImage = async () => {
        const element = document.getElementById("omr-preview");
        if (!element) return;

        setIsSaving(true);
        try {
            const canvas = await html2canvas(element, { scale: 2 });
            const dataUrl = canvas.toDataURL("image/png");

            const link = document.createElement("a");
            link.href = dataUrl;
            link.download = "omr_sheet.png";
            link.click();
        } catch (err) {
            console.error("Save failed:", err);
            alert("저장에 실패했습니다.");
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <div className="layout-main" style={{ background: '#f1f5f9', height: '100vh', overflow: 'hidden' }}>
            <header className="header" style={{ flexShrink: 0 }}>
                <div className="container header-content" style={{ maxWidth: '100%', padding: '0 2rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                        <Link href="/" className="logo">OMR Maker</Link>
                        <span style={{ fontSize: '0.9rem', color: 'var(--muted)', background: 'rgba(0,0,0,0.05)', padding: '0.2rem 0.5rem', borderRadius: '4px' }}>
                            Smart Editor
                        </span>
                    </div>
                    <div style={{ display: 'flex', gap: '1rem' }}>
                        <label className="btn btn-secondary" style={{ cursor: 'pointer' }}>
                            📄 PDF 업로드
                            <input id="pdf-upload-input" type="file" accept=".pdf" onChange={handleFileChange} style={{ display: 'none' }} />
                        </label>
                        <button
                            className="btn btn-primary"
                            onClick={handleSaveImage}
                            disabled={isSaving}
                        >
                            {isSaving ? "저장 중..." : "이미지로 저장"}
                        </button>
                        <button
                            className="btn btn-secondary"
                            style={{ background: '#6366f1', color: 'white', border: 'none' }}
                            onClick={() => setIsDistributeModalOpen(true)}
                        >
                            🚀 배포하기
                        </button>
                    </div>
                </div>
            </header>

            <AnswerImportModal
                isOpen={isImportModalOpen}
                onClose={() => setIsImportModalOpen(false)}
                onApply={handleAnswerImport}
                onUploadAnswerPdf={(file) => {
                    setAnswerKeyPdf(file);
                    setActiveViewTab('answer'); // Switch to answer tab when uploaded
                }}
            />

            <DistributeModal
                isOpen={isDistributeModalOpen}
                onClose={() => setIsDistributeModalOpen(false)}
                onSaveAndShare={handleShareConfig}
            />

            <div style={{ display: 'flex', flex: 1, height: 'calc(100vh - 4rem)', overflow: 'hidden' }}>

                {/* 1. PDF Viewer Area */}
                <div style={{ flex: 1, borderRight: '1px solid var(--border)', background: '#222', position: 'relative', display: 'flex', flexDirection: 'column' }}>
                    {/* Tab Selection (only if answer key exists) */}
                    {answerKeyPdf && (
                        <div style={{ display: 'flex', background: '#333', padding: '0.5rem', gap: '0.5rem', borderBottom: '1px solid #444' }}>
                            <button
                                onClick={() => setActiveViewTab('problem')}
                                style={{
                                    flex: 1, padding: '0.5rem', borderRadius: '4px', border: 'none',
                                    background: activeViewTab === 'problem' ? '#6366f1' : '#444',
                                    color: 'white', fontSize: '0.85rem', fontWeight: 'bold', cursor: 'pointer'
                                }}
                            >
                                📄 문제지 (PDF)
                            </button>
                            <button
                                onClick={() => setActiveViewTab('answer')}
                                style={{
                                    flex: 1, padding: '0.5rem', borderRadius: '4px', border: 'none',
                                    background: activeViewTab === 'answer' ? '#10b981' : '#444',
                                    color: 'white', fontSize: '0.85rem', fontWeight: 'bold', cursor: 'pointer'
                                }}
                            >
                                📁 참고용 답지
                            </button>
                        </div>
                    )}

                    <div style={{ flex: 1, position: 'relative' }}>
                        <PDFViewer
                            file={activeViewTab === 'problem' ? pdfFile : answerKeyPdf}
                            onLoadSuccess={(pages) => console.log(`PDF loaded: ${pages} pages`)}
                            onPageClick={activeViewTab === 'problem' ? handlePdfPageClick : undefined}
                            onFileDrop={activeViewTab === 'problem' ? handleFileDrop : setAnswerKeyPdf}
                            markers={activeViewTab === 'problem'
                                ? questions
                                    .filter(q => q.pdfLocation)
                                    .map(q => ({
                                        page: q.pdfLocation!.page,
                                        x: q.pdfLocation!.x,
                                        y: q.pdfLocation!.y,
                                        label: q.number,
                                        color: selectedQuestionId === q.id ? '#6366f1' : '#ef4444',
                                        onClick: () => setSelectedQuestionId(q.id)
                                    }))
                                : []}
                        />
                    </div>
                </div>

                {/* 2. Settings Sidebar */}
                <aside className="glass-panel" style={{
                    width: '320px',
                    padding: '1.5rem',
                    flexShrink: 0,
                    overflowY: 'auto',
                    background: 'var(--surface)',
                    borderRight: '1px solid var(--border)',
                    borderRadius: 0
                }}>
                    <h2 style={{ fontSize: '1.25rem', marginBottom: '1.5rem', fontWeight: 600 }}>설정</h2>

                    <div style={{ marginBottom: '1.5rem' }}>
                        <button
                            className="btn btn-secondary"
                            style={{ width: '100%', marginBottom: '1rem', border: '1px dashed #6366f1', color: '#6366f1', background: 'rgba(99, 102, 241, 0.05)' }}
                            onClick={() => setIsImportModalOpen(true)}
                        >
                            ⚡ 정답 PDF 자동 인식
                        </button>

                        {answerKeyPdf && (
                            <div style={{ marginBottom: '1rem', padding: '0.8rem', background: '#f0fdf4', borderRadius: 'var(--radius-md)', border: '1px solid #bbf7d0', fontSize: '0.85rem' }}>
                                <div style={{ color: '#166534', fontWeight: 'bold', marginBottom: '0.2rem' }}>✅ 참고용 답지 등록됨</div>
                                <div style={{ color: '#15803d', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{answerKeyPdf.name}</div>
                                <button
                                    onClick={() => window.open(URL.createObjectURL(answerKeyPdf), '_blank')}
                                    style={{ marginTop: '0.4rem', color: '#166534', textDecoration: 'underline', background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: '0.75rem' }}
                                >
                                    파일 보기
                                </button>
                            </div>
                        )}

                        <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.9rem', fontWeight: 500 }}>시험 제목</label>
                        <input
                            type="text"
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            className="input-field"
                            style={{ width: '100%', padding: '0.6rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', background: 'var(--background)' }}
                        />
                    </div>

                    <div style={{ marginBottom: '1.5rem' }}>
                        <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.9rem', fontWeight: 500 }}>문항 수: {questionsCount}</label>
                        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                            {[20, 25, 30, 40, 50].map(count => (
                                <button
                                    key={count}
                                    className={`btn ${questionsCount === count ? 'btn-primary' : 'btn-secondary'}`}
                                    style={{ flex: 1, minWidth: '60px', padding: '0.5rem' }}
                                    onClick={() => setQuestionsCount(count)}
                                >
                                    {count}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Selected Question Detail Editor */}
                    <div style={{ marginBottom: '1.5rem', padding: '1rem', background: 'rgba(99, 102, 241, 0.05)', borderRadius: 'var(--radius-md)', border: '1px solid rgba(99, 102, 241, 0.2)' }}>
                        <h3 style={{ fontSize: '0.95rem', fontWeight: 600, marginBottom: '0.5rem', color: 'var(--primary)' }}>
                            {selectedQuestionId ? `문항 #${selectedQuestionId} 편집` : '문항을 선택하세요'}
                        </h3>

                        {selectedQuestionId ? (
                            <div className="animate-fade-in">
                                {/* Answer Setting */}
                                <div style={{ marginBottom: '1rem' }}>
                                    <label style={{ display: 'block', marginBottom: '0.3rem', fontSize: '0.85rem' }}>정답 설정</label>
                                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                                        {[1, 2, 3, 4, 5].map(num => {
                                            const currentQ = questions.find(q => q.id === selectedQuestionId);
                                            const isSelected = currentQ?.answer === num;
                                            return (
                                                <button
                                                    key={num}
                                                    onClick={() => setAnswer(num)}
                                                    style={{
                                                        width: '30px', height: '30px',
                                                        borderRadius: '50%',
                                                        border: isSelected ? 'none' : '1px solid var(--muted)',
                                                        background: isSelected ? 'var(--primary)' : 'white',
                                                        color: isSelected ? 'white' : 'var(--foreground)',
                                                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                        fontSize: '0.85rem', fontWeight: 'bold',
                                                        transition: 'all 0.2s',
                                                        cursor: 'pointer'
                                                    }}
                                                >
                                                    {num}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>

                                {/* Label Setting */}
                                <div style={{ marginBottom: '1rem' }}>
                                    <label style={{ display: 'block', marginBottom: '0.3rem', fontSize: '0.85rem' }}>라벨 (클릭하여 선택)</label>
                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '0.5rem' }}>
                                        {['문법', '독해', '어휘', '듣기', '추론'].map(tag => {
                                            const currentQ = questions.find(q => q.id === selectedQuestionId);
                                            const isActive = currentQ?.label === tag;
                                            return (
                                                <button
                                                    key={tag}
                                                    onClick={() => toggleLabel(tag)}
                                                    style={{
                                                        fontSize: '0.8rem', padding: '4px 10px', borderRadius: '12px',
                                                        border: isActive ? '1px solid var(--primary)' : '1px solid var(--border)',
                                                        background: isActive ? 'rgba(99, 102, 241, 0.1)' : 'white',
                                                        color: isActive ? 'var(--primary)' : 'var(--muted)',
                                                        cursor: 'pointer',
                                                        transition: 'all 0.2s'
                                                    }}
                                                >
                                                    {tag}
                                                </button>
                                            );
                                        })}
                                    </div>
                                    <div style={{ display: 'flex', gap: '0.3rem' }}>
                                        <input
                                            type="text"
                                            placeholder="+ 직접 입력"
                                            value={customLabel}
                                            onChange={(e) => setCustomLabel(e.target.value)}
                                            onKeyDown={(e) => {
                                                if (e.key === 'Enter' && customLabel.trim()) {
                                                    toggleLabel(customLabel.trim());
                                                    setCustomLabel("");
                                                }
                                            }}
                                            className="input-field"
                                            style={{ flex: 1, padding: '0.3rem 0.6rem', fontSize: '0.8rem', border: '1px solid var(--border)', borderRadius: '4px' }}
                                        />
                                        <button
                                            className="btn btn-secondary"
                                            style={{ padding: '0.3rem 0.6rem', fontSize: '0.8rem' }}
                                            onClick={() => {
                                                if (customLabel.trim()) {
                                                    toggleLabel(customLabel.trim());
                                                    setCustomLabel("");
                                                }
                                            }}
                                        >
                                            추가
                                        </button>
                                    </div>
                                </div>
                                <div style={{ fontSize: '0.8rem', color: 'var(--muted)', borderTop: '1px solid rgba(0,0,0,0.05)', paddingTop: '0.5rem' }}>
                                    {questions.find(q => q.id === selectedQuestionId)?.pdfLocation
                                        ? <span style={{ color: 'var(--success)' }}>✅ PDF 문제 연결됨</span>
                                        : "⚠️ PDF에서 문제 위치를 클릭하여 연결하세요."}
                                </div>
                            </div>
                        ) : (
                            <p style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>
                                우측 미리보기에서 문항을 클릭하면 상세 편집 및 PDF 연결이 가능합니다.
                            </p>
                        )}
                    </div>

                    <div style={{ marginBottom: '1.5rem' }}>
                        <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.9rem', fontWeight: 500 }}>레이아웃</label>
                        <div style={{ display: 'flex', gap: '0.5rem' }}>
                            <button
                                className={`btn ${columns === 2 ? 'btn-primary' : 'btn-secondary'}`}
                                style={{ flex: 1 }}
                                onClick={() => setColumns(2)}
                            >
                                2단
                            </button>
                            <button
                                className={`btn ${columns === 3 ? 'btn-primary' : 'btn-secondary'}`}
                                style={{ flex: 1 }}
                                onClick={() => setColumns(3)}
                            >
                                3단
                            </button>
                        </div>
                    </div>

                    <button className="btn btn-secondary" style={{ width: '100%' }} onClick={() => typeof window !== 'undefined' && window.print()}>
                        인쇄하기
                    </button>
                </aside>

                {/* 3. OMR Preview */}
                <main style={{
                    flex: 1,
                    display: 'flex',
                    justifyContent: 'center',
                    overflowY: 'auto',
                    padding: '2rem',
                    background: '#e2e8f0'
                }}>
                    <div style={{ transform: 'scale(0.8)', transformOrigin: 'top center', height: 'fit-content' }}>
                        <OMRPreview
                            title={title}
                            questions={questions}
                            columns={columns}
                            selectedQuestionId={selectedQuestionId}
                            onQuestionClick={setSelectedQuestionId}
                            onAnswerClick={handleOMRAnswerClick}
                        />
                    </div>
                </main>

            </div>
        </div>
    );
}
