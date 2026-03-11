"use client";

import Link from "next/link";
import Image from "next/image";
import OMRPreview from "@/components/OMRPreview";
import dynamic from "next/dynamic";
import AnswerImportModal from "@/components/AnswerImportModal";
import DistributeModal from "@/components/DistributeModal";

const PDFViewer = dynamic(() => import("@/components/PDFViewer"), { ssr: false });
import { useState, useEffect } from "react";
import html2canvas from "html2canvas";
import { Question } from "@/types/omr";
import { ParsedAnswer, parsePdfCoordinatesWithGemini } from "@/services/answerParser";
import { useToast } from "@/components/ui/Toast";

export default function CreateOMRPage() {
    const toast = useToast();
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

    // Validation
    const [fastAnswer, setFastAnswer] = useState("");

    // Layout Sizing
    const [pdfWidth, setPdfWidth] = useState(600);
    const [sidebarWidth, setSidebarWidth] = useState(320);

    // PDF State
    const [pdfFile, setPdfFile] = useState<File | null>(null);
    const [answerKeyPdf, setAnswerKeyPdf] = useState<File | null>(null); // Teacher reference answer key
    const [activeViewTab, setActiveViewTab] = useState<'problem' | 'answer'>('problem');
    const [isDetectingLocation, setIsDetectingLocation] = useState(false);
    const [isSmartPdf, setIsSmartPdf] = useState(false);

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
            // "Click to Add": automatically create a new question at the clicked location
            setQuestionsCount(prev => prev + 1);
            setQuestions(prev => {
                const newId = prev.length > 0 ? Math.max(...prev.map(q => q.id)) + 1 : 1;
                const newNum = prev.length + 1;
                const newQ: Question = {
                    id: newId,
                    number: newNum,
                    pdfLocation: { page, x, y }
                };
                return [...prev, newQ];
            });
            toast.success("새로운 문항이 클릭한 위치에 추가되었습니다!");
            return;
        }

        // Update the selected question with PDF location and Auto-advance
        let nextSelectedId: number | null = null;
        let nextNumber: number | null = null;

        setQuestions(prev => {
            const mapped = prev.map(q =>
                q.id === selectedQuestionId
                    ? { ...q, pdfLocation: { page, x, y } }
                    : q
            );

            const currentIndex = mapped.findIndex(q => q.id === selectedQuestionId);
            if (currentIndex !== -1 && currentIndex < mapped.length - 1) {
                nextSelectedId = mapped[currentIndex + 1].id;
                nextNumber = mapped[currentIndex + 1].number;
            }
            return mapped;
        });

        if (nextSelectedId !== null) {
            setSelectedQuestionId(nextSelectedId);
            toast.info(`${nextNumber}번 문항으로 포커스가 이동했습니다.`);
        } else {
            setSelectedQuestionId(null);
            toast.success("모든 문항의 영역 지정이 완료되었습니다.");
        }
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

    const setScore = (score: number) => {
        if (selectedQuestionId === null) return;
        setQuestions(prev => prev.map(q =>
            q.id === selectedQuestionId
                ? { ...q, score: score }
                : q
        ));
    };

    const handleOMRAnswerClick = (qId: number, answer: number) => {
        setSelectedQuestionId(qId);
        setQuestions(prev => prev.map(q =>
            q.id === qId ? { ...q, answer: answer } : q
        ));
    };

    const handleAutoDetectLocations = async () => {
        if (!pdfFile) {
            toast.error("먼저 문제지 PDF를 왼쪽 상단에서 업로드해주세요.");
            return;
        }
        toast.info("텍스트 위치 탐색을 백그라운드에서 시작합니다. 잠시만 기다려주세요.");
        setIsDetectingLocation(true);
        try {
            const pdfjsLib = await import('pdfjs-dist');
            if (typeof window !== 'undefined' && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
                pdfjsLib.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;
            }
            const arrayBuffer = await pdfFile.arrayBuffer();
            const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

            const newQuestions = [...questions];
            let mappedCount = 0;

            for (let i = 1; i <= pdf.numPages; i++) {
                const page = await pdf.getPage(i);
                const viewport = page.getViewport({ scale: 1.0 });
                const textContent = await page.getTextContent();

                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const items = textContent.items.map((item: any) => ({
                    str: item.str.trim(),
                    x: item.transform[4] / viewport.width,
                    y: (viewport.height - item.transform[5]) / viewport.height
                }));

                items.forEach(item => {
                    const exactMatch = item.str.match(/^\[?(\d+)[\]\.\)]?$/);
                    // Match numbers with dots or parenthesis like "1.", "1)" or alone if confident.
                    // Text blocks sometimes separate numbers from content.
                    if (exactMatch) {
                        const qNum = parseInt(exactMatch[1], 10);
                        const qIndex = newQuestions.findIndex(q => q.number === qNum);
                        if (qIndex !== -1 && !newQuestions[qIndex].pdfLocation) {
                            newQuestions[qIndex] = { ...newQuestions[qIndex], pdfLocation: { page: i, x: item.x, y: Math.max(0, item.y - 0.02) } };
                            mappedCount++;
                        }
                    }
                });
            }

            setQuestions(newQuestions);
            toast.success(`총 ${pdf.numPages}페이지에서 ${mappedCount}개 문항의 위치를 자동으로 찾았습니다! \n매칭되지 않은 문항은 직접 클릭하여 지정해주세요.`);
        } catch (e) {
            console.error(e);
            toast.error("위치 자동 매칭 중 오류가 발생했습니다.");
        } finally {
            setIsDetectingLocation(false);
        }
    };

    const handleAIDetectLocations = async () => {
        if (!pdfFile) {
            toast.error("먼저 문제지 PDF를 왼쪽 상단에서 업로드해주세요.");
            return;
        }
        toast.info("AI 스마트 위치 인식을 백그라운드에서 시작합니다. (약 30초 소요 됨)");
        setIsDetectingLocation(true);
        try {
            const bboxes = await parsePdfCoordinatesWithGemini(pdfFile);

            const newQuestions = [...questions];
            let mappedCount = 0;

            bboxes.forEach(bbox => {
                const qIndex = newQuestions.findIndex(q => q.number === bbox.questionNum);
                if (qIndex !== -1) {
                    const pdfChoices: { [key: number]: { page: number, x: number, y: number, w: number, h: number } } = {};
                    if (bbox.choices) {
                        bbox.choices.forEach(c => {
                            pdfChoices[c.num] = {
                                page: bbox.page,
                                x: c.xmin,
                                y: c.ymin,
                                w: c.xmax - c.xmin,
                                h: c.ymax - c.ymin
                            };
                        });
                    }

                    newQuestions[qIndex] = {
                        ...newQuestions[qIndex],
                        pdfLocation: {
                            page: bbox.page,
                            x: bbox.xmin,
                            y: bbox.ymin,
                            w: bbox.xmax - bbox.xmin,
                            h: bbox.ymax - bbox.ymin
                        },
                        pdfChoices: Object.keys(pdfChoices).length > 0 ? pdfChoices : undefined
                    };
                    mappedCount++;
                }
            });

            setQuestions(newQuestions);
            setIsSmartPdf(true);
            toast.success(`AI가 총 ${mappedCount}개 문항의 스마트 영역을 성공적으로 매칭했습니다!`);
        } catch (error: unknown) {
            const e = error as Error;
            console.error(e);
            toast.error(e.message || "AI 위치 매칭 중 오류가 발생했습니다.");
        } finally {
            setIsDetectingLocation(false);
        }
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
                isSmartPdf,
                createdAt: new Date().toISOString()
            };

            localStorage.setItem(`omr_exam_${id}`, JSON.stringify(examData));
            const shareUrl = `${window.location.origin}/solve/${id}`;
            return shareUrl;
        } catch (e) {
            console.error(e);
            toast.error("배포 데이터 저장 실패: 파일 용량이 너무 큽니다. (LocalStorage 한계)");
            return "";
        }
    };

    const handleAnswerImport = (importedAnswers: ParsedAnswer[]) => {
        // Find max question number to auto-resize exam if needed
        const maxQ = Math.max(...importedAnswers.map(ans => ans.questionNum));
        if (maxQ > questionsCount) {
            if (confirm(`가져온 정답이 ${maxQ}번까지 있습니다. 문항 수를 늘리시겠습니까?`)) {
                setQuestionsCount(maxQ);
            }
        }

        setQuestions(prev => prev.map(q => {
            const match = importedAnswers.find(ans => ans.questionNum === q.number);
            if (match) {
                return {
                    ...q,
                    answer: match.answer,
                    ...(match.score ? { score: match.score } : {})
                };
            }
            return q;
        }));

        toast.success("정답 및 배점(있는 경우)이 적용되었습니다!");
    };

    const handleFastAnswerChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        // filter out non-1~5 digits
        const val = e.target.value.replace(/[^1-5]/g, '');
        setFastAnswer(val);

        setQuestions(prev => prev.map((q, i) => {
            if (i < val.length) {
                return { ...q, answer: parseInt(val[i]) };
            }
            return q;
        }));
    };

    const handleSaveDraft = async () => {
        setIsSaving(true);
        const fileToBase64 = (file: File): Promise<string> => {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result as string);
                reader.onerror = reject;
                reader.readAsDataURL(file);
            });
        };

        try {
            let pdfBase64 = "";
            let answerKeyBase64 = "";

            if (pdfFile) pdfBase64 = await fileToBase64(pdfFile);
            if (answerKeyPdf) answerKeyBase64 = await fileToBase64(answerKeyPdf);

            const id = Date.now().toString(36);
            const draftData = {
                id,
                title: title || "제목 없는 시험",
                questions,
                accessConfig: { type: 'draft' }, // specific draft config
                pdfData: pdfBase64,
                answerKeyPdf: answerKeyBase64,
                isSmartPdf,
                status: 'draft',
                createdAt: new Date().toISOString()
            };

            localStorage.setItem(`omr_exam_${id}`, JSON.stringify(draftData));
            toast.success("✅ 시험지가 임시 저장되었습니다.\n대시보드에서 불러와 이어서 편집하거나 배포할 수 있습니다.");
        } catch (e) {
            console.error(e);
            toast.error("저장 실패: 파일 용량이 너무 큽니다. (LocalStorage 한계)");
        } finally {
            setIsSaving(false);
        }
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
            toast.error("저장에 실패했습니다.");
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <div className="layout-main" style={{ background: '#f1f5f9', height: '100vh', overflow: 'hidden' }}>
            <header className="header" style={{ flexShrink: 0 }}>
                <div className="container header-content" style={{ maxWidth: '100%', padding: '0 2rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                        <Link href="/" className="logo" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', textDecoration: 'none' }}>
                            <Image src="/logo.png" alt="OMR Maker Logo" width={32} height={32} style={{ objectFit: 'contain' }} />
                            <span>OMR Maker</span>
                        </Link>
                        <span style={{ fontSize: '0.9rem', color: 'var(--muted)', background: 'rgba(0,0,0,0.05)', padding: '0.2rem 0.5rem', borderRadius: '4px' }}>
                            Smart Editor
                        </span>
                    </div>
                    <div style={{ display: 'flex', gap: '0.8rem', flexWrap: 'wrap' }}>
                        <label className="btn btn-secondary" style={{ cursor: 'pointer', background: 'white', border: '1px solid var(--border)', whiteSpace: 'nowrap', padding: '0.6rem 1rem', fontSize: '0.9rem' }}>
                            📄 문제지 업로드
                            <input id="pdf-upload-input" type="file" accept=".pdf" onChange={handleFileChange} style={{ display: 'none' }} />
                        </label>
                        <label className="btn btn-secondary" style={{ cursor: 'pointer', background: 'white', border: '1px solid var(--border)', whiteSpace: 'nowrap', padding: '0.6rem 1rem', fontSize: '0.9rem' }}>
                            📁 답지 업로드
                            <input type="file" accept=".pdf" onChange={(e) => {
                                if (e.target.files && e.target.files[0]) {
                                    setAnswerKeyPdf(e.target.files[0]);
                                }
                            }} style={{ display: 'none' }} />
                        </label>
                        <button
                            className="btn btn-primary"
                            onClick={handleSaveImage}
                            disabled={isSaving}
                            style={{ whiteSpace: 'nowrap', padding: '0.6rem 1rem', fontSize: '0.9rem' }}
                        >
                            {isSaving ? "저장 중..." : "이미지로 저장"}
                        </button>
                        <button
                            className="btn btn-secondary"
                            onClick={handleSaveDraft}
                            disabled={isSaving}
                            style={{ whiteSpace: 'nowrap', padding: '0.6rem 1rem', fontSize: '0.9rem' }}
                        >
                            {isSaving ? "저장 중..." : "💾 임시 저장"}
                        </button>
                        <button
                            className="btn btn-secondary"
                            style={{ background: '#6366f1', color: 'white', border: 'none', whiteSpace: 'nowrap', padding: '0.6rem 1rem', fontSize: '0.9rem' }}
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
                examTitle={title || "제목 없는 시험"}
            />

            <div className="split-layout" style={{ display: 'flex', flex: 1, height: 'calc(100vh - 4rem)', overflow: 'hidden' }}>

                {/* 1. PDF Viewer Area */}
                <div className="split-pane-pdf" style={{
                    width: `${pdfWidth}px`,
                    minWidth: '300px',
                    flexShrink: 0,
                    borderRight: '1px solid var(--border)',
                    background: '#222',
                    position: 'relative',
                    display: 'flex',
                    flexDirection: 'column',
                    overflow: 'hidden' // Force contain inside to avoid layout break
                }}>
                    {/* Tab Selection */}
                    {answerKeyPdf && (
                        <div style={{ display: 'flex', background: '#333', padding: '0.5rem', gap: '0.5rem', borderBottom: '1px solid #444', alignItems: 'center' }}>
                            <button
                                onClick={() => setActiveViewTab('problem')}
                                style={{
                                    flex: 1, padding: '0.5rem', borderRadius: '4px', border: 'none',
                                    background: activeViewTab === 'problem' ? '#6366f1' : '#444',
                                    color: 'white', fontSize: '0.85rem', fontWeight: 'bold', cursor: 'pointer', transition: '0.2s'
                                }}
                            >
                                📄 문제지 (PDF)
                            </button>
                            <button
                                onClick={() => setActiveViewTab('answer')}
                                style={{
                                    flex: 1, padding: '0.5rem', borderRadius: '4px', border: 'none',
                                    background: activeViewTab === 'answer' ? '#10b981' : '#444',
                                    color: 'white', fontSize: '0.85rem', fontWeight: 'bold', cursor: 'pointer', transition: '0.2s'
                                }}
                            >
                                📁 참고용 답지
                            </button>
                            <button
                                onClick={() => {
                                    if (answerKeyPdf) window.open(URL.createObjectURL(answerKeyPdf), '_blank');
                                }}
                                style={{
                                    padding: '0.5rem', borderRadius: '4px', border: '1px solid #555',
                                    background: 'transparent', color: '#ccc', fontSize: '0.8rem', cursor: 'pointer',
                                    whiteSpace: 'nowrap'
                                }}
                                title="답지를 새 웹 브라우저 탭에서 엽니다"
                            >
                                새 탭 열기
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
                                        w: q.pdfLocation!.w,
                                        h: q.pdfLocation!.h,
                                        label: q.number,
                                        color: selectedQuestionId === q.id ? '#6366f1' : '#ef4444',
                                        onClick: () => setSelectedQuestionId(q.id)
                                    }))
                                : []}
                        />
                    </div>
                </div>

                {/* Resizer 1 */}
                <div className="resizer"
                    style={{ width: '6px', background: 'var(--border)', cursor: 'col-resize', position: 'relative', zIndex: 10 }}
                    onMouseDown={(e) => {
                        e.preventDefault();
                        const startX = e.clientX;
                        const startWidth = pdfWidth;
                        const onMouseMove = (moveEvent: MouseEvent) => {
                            const newWidth = startWidth + (moveEvent.clientX - startX);
                            setPdfWidth(Math.max(200, Math.min(newWidth, window.innerWidth - 400)));
                        };
                        const onMouseUp = () => {
                            document.removeEventListener('mousemove', onMouseMove);
                            document.removeEventListener('mouseup', onMouseUp);
                        };
                        document.addEventListener('mousemove', onMouseMove);
                        document.addEventListener('mouseup', onMouseUp);
                    }}
                >
                    <div style={{ width: '2px', height: '20px', background: '#aaa', position: 'absolute', top: '50%', left: '2px', transform: 'translateY(-50%)', borderRadius: '2px' }} />
                </div>

                {/* 2. Settings Sidebar */}
                <aside className="glass-panel split-pane-settings" style={{
                    width: `${sidebarWidth}px`,
                    minWidth: '250px',
                    padding: '1.5rem',
                    flexShrink: 0,
                    overflowY: 'auto',
                    background: 'var(--surface)',
                    borderRight: '1px solid var(--border)',
                    borderRadius: 0
                }}>
                    <h2 style={{ fontSize: '1.25rem', marginBottom: '1.5rem', fontWeight: 600 }}>설정</h2>

                    <div style={{ marginBottom: '1.5rem' }}>
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

                    <div style={{ marginBottom: '1.5rem' }}>
                        <button
                            className="btn btn-secondary"
                            style={{ width: '100%', marginBottom: '0.5rem', border: '1px dashed #6366f1', color: '#6366f1', background: 'rgba(99, 102, 241, 0.05)' }}
                            onClick={() => setIsImportModalOpen(true)}
                        >
                            ⚡ 정답 인식 마법사 (답지 추출)
                        </button>

                        <button
                            className="btn btn-secondary"
                            style={{ width: '100%', marginBottom: '1rem', border: '1px solid #10b981', color: '#10b981', background: 'rgba(16, 185, 129, 0.05)' }}
                            onClick={handleAutoDetectLocations}
                        >
                            {isDetectingLocation ? <span className="animate-pulse">⏳ 텍스트 위치 찾는 중... (백그라운드 진행)</span> : "🎯 텍스트 기반 위치 찾기 (빠름)"}
                        </button>

                        <button
                            className="btn btn-secondary"
                            style={{ width: '100%', marginBottom: '1rem', border: '1px solid #f59e0b', color: '#d97706', background: 'rgba(245, 158, 11, 0.05)', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '0.8rem' }}
                            onClick={handleAIDetectLocations}
                        >
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontWeight: 'bold' }}>
                                <span>{isDetectingLocation ? <span className="animate-pulse">⏳ AI 스마트 위치 인식 중... (백그라운드 진행)</span> : "✨ AI 스마트 위치 인식 (정확함)"}</span>
                            </div>
                            {!isDetectingLocation && <span style={{ fontSize: '0.75rem', opacity: 0.8, marginTop: '0.3rem' }}>학생이 번호를 터치해 바로 마킹할 수 있게 됩니다.</span>}
                        </button>

                        <div style={{ marginBottom: '1rem', padding: '1rem', background: 'rgba(16, 185, 129, 0.05)', borderRadius: 'var(--radius-md)', border: '1px solid rgba(16, 185, 129, 0.2)' }}>
                            <label style={{ display: 'block', marginBottom: '0.4rem', fontSize: '0.9rem', fontWeight: 600, color: '#10b981' }}>
                                전체 문항 일괄 설정
                            </label>
                            <div style={{ display: 'flex', gap: '0.5rem' }}>
                                <button className="btn btn-secondary" style={{ flex: 1, padding: '0.4rem', fontSize: '0.8rem' }} onClick={() => {
                                    const score = prompt("모든 문항에 적용할 배점을 입력하세요 (예: 5)");
                                    if (score && !isNaN(parseFloat(score))) {
                                        setQuestions(prev => prev.map(q => ({ ...q, score: parseFloat(score) })));
                                        toast.success(`모든 문항의 배점이 ${score}점으로 변경되었습니다.`);
                                    }
                                }}>배점 일괄 변경</button>
                                <button className="btn btn-secondary" style={{ flex: 1, padding: '0.4rem', fontSize: '0.8rem' }} onClick={() => {
                                    if (confirm("모든 문항을 객관식으로 초기화하시겠습니까?")) {
                                        setQuestions(prev => prev.map(q => ({ ...q, type: 'objective' })));
                                        toast.success(`모든 문항이 객관식으로 변경되었습니다.`);
                                    }
                                }}>모두 객관식으로</button>
                            </div>
                        </div>

                        <div style={{ marginBottom: '1rem' }}>
                            <label style={{ display: 'block', marginBottom: '0.4rem', fontSize: '0.9rem', fontWeight: 600, color: 'var(--primary)' }}>
                                빠른 정답 입력 (연속 입력)
                            </label>
                            <input
                                type="text"
                                placeholder="예: 31251..."
                                value={fastAnswer}
                                onChange={handleFastAnswerChange}
                                className="input-field"
                                style={{ width: '100%', padding: '0.6rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', background: 'var(--background)', fontSize: '1rem', letterSpacing: '2px' }}
                            />
                            <div style={{ fontSize: '0.75rem', color: 'var(--muted)', marginTop: '0.3rem' }}>
                                1~5의 숫자를 입력하면 문항 순서대로 정답이 즉시 반영됩니다.
                            </div>
                        </div>
                    </div>

                    {/* Selected Question Detail Editor */}
                    <div style={{ marginBottom: '1.5rem', padding: '1rem', background: 'rgba(99, 102, 241, 0.05)', borderRadius: 'var(--radius-md)', border: '1px solid rgba(99, 102, 241, 0.2)' }}>
                        <h3 style={{ fontSize: '0.95rem', fontWeight: 600, marginBottom: '0.5rem', color: 'var(--primary)' }}>
                            {selectedQuestionId ? `문항 #${selectedQuestionId} 편집` : '문항을 선택하세요'}
                        </h3>

                        {selectedQuestionId ? (
                            <div className="animate-fade-in">
                                {/* Type Setting */}
                                <div style={{ marginBottom: '1rem' }}>
                                    <label style={{ display: 'block', marginBottom: '0.3rem', fontSize: '0.85rem' }}>문제 유형</label>
                                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                                        <button
                                            onClick={() => {
                                                setQuestions(prev => prev.map(q => q.id === selectedQuestionId ? { ...q, type: 'objective' } : q));
                                            }}
                                            className={`btn ${questions.find(q => q.id === selectedQuestionId)?.type !== 'subjective' ? 'btn-primary' : 'btn-secondary'}`}
                                            style={{ flex: 1, padding: '0.4rem', fontSize: '0.85rem' }}
                                        >
                                            객관식
                                        </button>
                                        <button
                                            onClick={() => {
                                                setQuestions(prev => prev.map(q => q.id === selectedQuestionId ? { ...q, type: 'subjective', answer: undefined } : q));
                                            }}
                                            className={`btn ${questions.find(q => q.id === selectedQuestionId)?.type === 'subjective' ? 'btn-primary' : 'btn-secondary'}`}
                                            style={{ flex: 1, padding: '0.4rem', fontSize: '0.85rem' }}
                                        >
                                            주관식
                                        </button>
                                    </div>
                                </div>

                                {/* Answer Setting */}
                                <div style={{ marginBottom: '1rem' }}>
                                    <label style={{ display: 'block', marginBottom: '0.3rem', fontSize: '0.85rem' }}>정답 설정</label>
                                    {questions.find(q => q.id === selectedQuestionId)?.type === 'subjective' ? (
                                        <input
                                            type="text"
                                            placeholder="주관식 정답 입력 (선택)"
                                            value={questions.find(q => q.id === selectedQuestionId)?.stringAnswer || ''}
                                            onChange={(e) => {
                                                setQuestions(prev => prev.map(q => q.id === selectedQuestionId ? { ...q, stringAnswer: e.target.value } : q));
                                            }}
                                            className="input-field"
                                            style={{ width: '100%', padding: '0.5rem', borderRadius: '4px', border: '1px solid var(--border)' }}
                                        />
                                    ) : (
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
                                    )}
                                </div>

                                {/* Dual Question Setting (Only for Objective) */}
                                {questions.find(q => q.id === selectedQuestionId)?.type !== 'subjective' && (
                                    <div style={{ marginBottom: '1rem', background: 'rgba(99, 102, 241, 0.05)', padding: '1rem', borderRadius: '8px', border: '1px solid rgba(99, 102, 241, 0.2)' }}>
                                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem', fontSize: '0.9rem', fontWeight: 600, cursor: 'pointer' }}>
                                            <input
                                                type="checkbox"
                                                checked={questions.find(q => q.id === selectedQuestionId)?.askReason || false}
                                                onChange={(e) => {
                                                    setQuestions(prev => prev.map(q => q.id === selectedQuestionId ? { ...q, askReason: e.target.checked } : q));
                                                }}
                                                style={{ width: '16px', height: '16px', accentColor: 'var(--primary)', cursor: 'pointer' }}
                                            />
                                            이중 문제 (사유 묻기) 활성화
                                        </label>

                                        {questions.find(q => q.id === selectedQuestionId)?.askReason && (
                                            <div className="animate-fade-in" style={{ marginTop: '0.5rem' }}>
                                                <input
                                                    type="text"
                                                    placeholder="모범 사유 입력 (선택)"
                                                    value={questions.find(q => q.id === selectedQuestionId)?.reasonStringAnswer || ''}
                                                    onChange={(e) => {
                                                        setQuestions(prev => prev.map(q => q.id === selectedQuestionId ? { ...q, reasonStringAnswer: e.target.value } : q));
                                                    }}
                                                    className="input-field"
                                                    style={{ width: '100%', padding: '0.5rem', borderRadius: '4px', border: '1px solid var(--border)', fontSize: '0.85rem' }}
                                                />
                                                <p style={{ fontSize: '0.75rem', color: 'var(--muted)', marginTop: '0.3rem' }}>* 학생이 선택한 답안에 대한 논리적 근거를 서술하도록 합니다.</p>
                                            </div>
                                        )}
                                    </div>
                                )}

                                {/* Score Setting */}
                                <div style={{ marginBottom: '1rem' }}>
                                    <label style={{ display: 'block', marginBottom: '0.3rem', fontSize: '0.85rem' }}>배점 (점수)</label>
                                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                                        {[2, 3, 4, 5].map(pts => {
                                            const currentQ = questions.find(q => q.id === selectedQuestionId);
                                            const isSelected = currentQ?.score === pts;
                                            return (
                                                <button
                                                    key={pts}
                                                    onClick={() => setScore(pts)}
                                                    style={{
                                                        padding: '4px 12px',
                                                        borderRadius: '12px',
                                                        border: isSelected ? '1px solid var(--primary)' : '1px solid var(--border)',
                                                        background: isSelected ? 'rgba(99, 102, 241, 0.1)' : 'white',
                                                        color: isSelected ? 'var(--primary)' : 'var(--muted)',
                                                        fontSize: '0.85rem', fontWeight: 'bold',
                                                        transition: 'all 0.2s',
                                                        cursor: 'pointer'
                                                    }}
                                                >
                                                    {pts}점
                                                </button>
                                            );
                                        })}
                                        <input
                                            type="number"
                                            placeholder="직접 입력"
                                            value={questions.find(q => q.id === selectedQuestionId)?.score || ''}
                                            onChange={(e) => {
                                                const val = parseFloat(e.target.value);
                                                if (!isNaN(val)) setScore(val);
                                            }}
                                            style={{ width: '70px', padding: '4px 8px', fontSize: '0.85rem', border: '1px solid var(--border)', borderRadius: '4px' }}
                                            min="0"
                                            step="0.5"
                                        />
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

                {/* Resizer 2 */}
                <div className="resizer"
                    style={{ width: '6px', background: 'var(--border)', cursor: 'col-resize', position: 'relative', zIndex: 10 }}
                    onMouseDown={(e) => {
                        e.preventDefault();
                        const startX = e.clientX;
                        const startWidth = sidebarWidth;
                        const onMouseMove = (moveEvent: MouseEvent) => {
                            const newWidth = startWidth + (moveEvent.clientX - startX);
                            setSidebarWidth(Math.max(250, Math.min(newWidth, 600)));
                        };
                        const onMouseUp = () => {
                            document.removeEventListener('mousemove', onMouseMove);
                            document.removeEventListener('mouseup', onMouseUp);
                        };
                        document.addEventListener('mousemove', onMouseMove);
                        document.addEventListener('mouseup', onMouseUp);
                    }}
                >
                    <div style={{ width: '2px', height: '20px', background: '#aaa', position: 'absolute', top: '50%', left: '2px', transform: 'translateY(-50%)', borderRadius: '2px' }} />
                </div>

                {/* 3. OMR Preview */}
                <main className="split-pane-main" style={{
                    flex: 1,
                    display: 'flex',
                    minWidth: '350px',
                    justifyContent: 'center',
                    overflowY: 'auto',
                    overflowX: 'hidden',
                    padding: '2rem',
                    background: '#e2e8f0'
                }}>
                    <div style={{ width: '100%', maxWidth: '1300px', height: 'fit-content' }}>
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

            </div >
        </div >
    );
}
