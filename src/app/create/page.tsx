"use client";

import Link from "next/link";
import OMRCardView from "@/components/OMRCardView";
import OMRPreview from "@/components/OMRPreview";
import dynamic from "next/dynamic";
import AnswerImportModal from "@/components/AnswerImportModal";
import DistributeModal from "@/components/DistributeModal";
import ThemeToggle from "@/components/ThemeToggle";
import { useSearchParams } from "next/navigation";
import { toast } from "@/components/Toast";
import { Undo2, Redo2 } from "lucide-react";

const PDFViewer = dynamic(() => import("@/components/PDFViewer"), { ssr: false });
import { Suspense, useState, useEffect, useRef, useCallback } from "react";
import html2canvas from "html2canvas";
import { Exam, Question } from "@/types/omr";
import { ParsedAnswer } from "@/services/answerParser";

// ─── Autosave + history constants ────────────────────────────────────
const DRAFT_KEY = "omr_exam_draft";
const AUTOSAVE_INTERVAL_MS = 2000;
const HISTORY_LIMIT = 20;

interface EditorDraft {
    title: string;
    questionsCount: number;
    columns: number;
    questions: Question[];
    defaultChoices: 4 | 5;
    durationMin: number | "";
    startAt: string;
    endAt: string;
    savedAt: string;
}

interface HistorySnapshot {
    title: string;
    questionsCount: number;
    columns: number;
    questions: Question[];
    defaultChoices: 4 | 5;
    durationMin: number | "";
    startAt: string;
    endAt: string;
}

function safeSetLocal(key: string, value: string): boolean {
    try {
        localStorage.setItem(key, value);
        return true;
    } catch {
        toast.error("저장 공간 부족", "오래된 시험을 정리하거나 용량을 확인하세요.");
        return false;
    }
}

export default function CreateOMRPage() {
    return (
        <Suspense fallback={<div style={{ minHeight: '100vh', background: 'var(--background)' }} />}>
            <CreateOMRPageInner />
        </Suspense>
    );
}

function CreateOMRPageInner() {
    const searchParams = useSearchParams();
    const editId = searchParams?.get('edit') || null;
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
    const [previewMode, setPreviewMode] = useState<'modern' | 'paper'>('modern');

    // PDF State
    const [pdfFile, setPdfFile] = useState<File | null>(null);
    const [answerKeyPdf, setAnswerKeyPdf] = useState<File | null>(null); // Teacher reference answer key
    const [activeViewTab, setActiveViewTab] = useState<'problem' | 'answer'>('problem');
    const [isDetectingLocation, setIsDetectingLocation] = useState(false);

    // Schedule fields
    const [durationMin, setDurationMin] = useState<number | "">(50);
    const [startAt, setStartAt] = useState<string>(""); // datetime-local string
    const [endAt, setEndAt] = useState<string>(""); // datetime-local string

    // Exam-level default choice count (4 or 5)
    const [defaultChoices, setDefaultChoices] = useState<4 | 5>(5);

    // Edit mode: load existing exam snapshot + carry through on save.
    const [loadedExam, setLoadedExam] = useState<Exam | null>(null);

    // Undo/Redo + autosave refs
    const historyRef = useRef<HistorySnapshot[]>([]);
    const redoRef = useRef<HistorySnapshot[]>([]);
    const suppressHistoryRef = useRef(false);
    const hasHydratedRef = useRef(false);
    const draftPromptedRef = useRef(false);
    const lastSnapshotRef = useRef<HistorySnapshot | null>(null);

    // Helpers to convert ISO <-> datetime-local ("YYYY-MM-DDTHH:mm")
    const isoToLocalInput = (iso?: string): string => {
        if (!iso) return "";
        const d = new Date(iso);
        if (isNaN(d.getTime())) return "";
        const pad = (n: number) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };
    const localInputToIso = (v: string): string | undefined => {
        if (!v) return undefined;
        const d = new Date(v);
        if (isNaN(d.getTime())) return undefined;
        return d.toISOString();
    };

    // Load exam from localStorage when ?edit=<id> is present.
    useEffect(() => {
        if (!editId) return;
        if (typeof window === 'undefined') return;
        try {
            const raw = localStorage.getItem(`omr_exam_${editId}`);
            if (!raw) {
                toast.error('시험을 찾을 수 없습니다', editId);
                return;
            }
            const parsed = JSON.parse(raw) as Exam;
            setLoadedExam(parsed);
            if (parsed.title) setTitle(parsed.title);
            if (Array.isArray(parsed.questions) && parsed.questions.length > 0) {
                setQuestionsCount(parsed.questions.length);
                setQuestions(parsed.questions);
            }
            if (typeof parsed.durationMin === 'number') setDurationMin(parsed.durationMin);
            if (parsed.startAt) setStartAt(isoToLocalInput(parsed.startAt));
            if (parsed.endAt) setEndAt(isoToLocalInput(parsed.endAt));
            toast.info('편집 모드', `"${parsed.title}"을(를) 불러왔습니다.`);
        } catch {
            toast.error('시험 불러오기 실패');
        }
    }, [editId]);

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
                        choices: defaultChoices,
                    });
                }
            }
            return newQuestions;
        });
    }, [questionsCount, defaultChoices]);

    // ─── Draft restore on mount (non-edit mode only) ─────────────────
    useEffect(() => {
        if (draftPromptedRef.current) return;
        if (typeof window === "undefined") return;
        if (editId) return; // Skip draft prompt while editing an existing exam
        draftPromptedRef.current = true;

        const raw = localStorage.getItem(DRAFT_KEY);
        if (!raw) return;
        let draft: EditorDraft | null = null;
        try { draft = JSON.parse(raw) as EditorDraft; } catch { return; }
        if (!draft || !Array.isArray(draft.questions)) return;

        const snap = draft;
        toast.info("이전 작업 복원 가능", "저장된 임시 초안이 있습니다.");
        // Native confirm used so the flow stays synchronous without adding a modal.
        // Short timeout lets the toast render before the blocking prompt.
        setTimeout(() => {
            const choice = window.confirm("저장된 임시 초안을 복원하시겠습니까?\n(취소하면 초안은 삭제됩니다.)");
            if (choice) {
                suppressHistoryRef.current = true;
                setTitle(snap.title ?? "기말고사 OMR");
                setQuestionsCount(snap.questionsCount ?? 20);
                setColumns(snap.columns ?? 2);
                setQuestions(snap.questions ?? []);
                setDefaultChoices(snap.defaultChoices === 4 ? 4 : 5);
                setDurationMin(snap.durationMin === "" ? "" : (snap.durationMin ?? 50));
                setStartAt(snap.startAt ?? "");
                setEndAt(snap.endAt ?? "");
                toast.success("초안 복원 완료");
            } else {
                try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
                toast.info("초안 삭제", "임시 저장된 초안을 삭제했습니다.");
            }
        }, 350);
    }, [editId]);

    // Mark hydration so autosave doesn't fire with defaults before restore runs
    useEffect(() => {
        hasHydratedRef.current = true;
    }, []);

    // ─── Autosave draft every 2s when editor state changes ───────────
    useEffect(() => {
        if (!hasHydratedRef.current) return;
        if (editId) return; // editing flow uses its own save path
        const handle = setTimeout(() => {
            const draft: EditorDraft = {
                title, questionsCount, columns, questions,
                defaultChoices, durationMin, startAt, endAt,
                savedAt: new Date().toISOString(),
            };
            safeSetLocal(DRAFT_KEY, JSON.stringify(draft));
        }, AUTOSAVE_INTERVAL_MS);
        return () => clearTimeout(handle);
    }, [editId, title, questionsCount, columns, questions, defaultChoices, durationMin, startAt, endAt]);

    // ─── History snapshotting (push PREVIOUS state onto undo stack) ──
    const snapshotCurrent = useCallback((): HistorySnapshot => ({
        title, questionsCount, columns, questions,
        defaultChoices, durationMin, startAt, endAt,
    }), [title, questionsCount, columns, questions, defaultChoices, durationMin, startAt, endAt]);

    useEffect(() => {
        if (!hasHydratedRef.current) return;
        if (suppressHistoryRef.current) {
            suppressHistoryRef.current = false;
            lastSnapshotRef.current = snapshotCurrent();
            return;
        }
        if (lastSnapshotRef.current) {
            historyRef.current.push(lastSnapshotRef.current);
            if (historyRef.current.length > HISTORY_LIMIT) historyRef.current.shift();
            redoRef.current = []; // new edit clears redo stack
        }
        lastSnapshotRef.current = snapshotCurrent();
    }, [title, questionsCount, columns, questions, defaultChoices, durationMin, startAt, endAt, snapshotCurrent]);

    const applySnapshot = useCallback((snap: HistorySnapshot) => {
        suppressHistoryRef.current = true;
        setTitle(snap.title);
        setQuestionsCount(snap.questionsCount);
        setColumns(snap.columns);
        setQuestions(snap.questions);
        setDefaultChoices(snap.defaultChoices);
        setDurationMin(snap.durationMin);
        setStartAt(snap.startAt);
        setEndAt(snap.endAt);
    }, []);

    const undo = useCallback(() => {
        const prev = historyRef.current.pop();
        if (!prev) { toast.info("되돌릴 내용이 없습니다"); return; }
        redoRef.current.push(snapshotCurrent());
        if (redoRef.current.length > HISTORY_LIMIT) redoRef.current.shift();
        applySnapshot(prev);
    }, [applySnapshot, snapshotCurrent]);

    const redo = useCallback(() => {
        const next = redoRef.current.pop();
        if (!next) { toast.info("다시 실행할 내용이 없습니다"); return; }
        historyRef.current.push(snapshotCurrent());
        if (historyRef.current.length > HISTORY_LIMIT) historyRef.current.shift();
        applySnapshot(next);
    }, [applySnapshot, snapshotCurrent]);

    // Ctrl+Z / Cmd+Z to undo, Ctrl+Shift+Z / Cmd+Shift+Z (or Ctrl+Y) to redo
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            const isMod = e.ctrlKey || e.metaKey;
            if (!isMod) return;
            const tgt = e.target as HTMLElement | null;
            const tag = tgt?.tagName;
            const inText = tag === 'INPUT' || tag === 'TEXTAREA' || tgt?.isContentEditable;
            const key = e.key.toLowerCase();
            if (key === 'z' && !e.shiftKey) {
                if (inText) return;
                e.preventDefault();
                undo();
            } else if ((key === 'z' && e.shiftKey) || key === 'y') {
                if (inText) return;
                e.preventDefault();
                redo();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [undo, redo]);

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
            toast.info("문항 먼저 선택", "연결할 문항을 OMR에서 선택해주세요.");
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

    // Guard: reducing question count may destroy answered questions.
    const handleQuestionCountChange = (newCount: number) => {
        if (newCount < questionsCount) {
            const losing = questions.slice(newCount).filter(q => typeof q.answer === 'number').length;
            if (losing > 0) {
                const ok = window.confirm(`${losing}개 문항이 삭제됩니다. 계속하시겠습니까?`);
                if (!ok) return;
            }
        }
        setQuestionsCount(newCount);
    };

    // Guard: switching 5→4 may invalidate answers of 5.
    const handleDefaultChoicesChange = (next: 4 | 5) => {
        if (next === 4 && defaultChoices === 5) {
            const losing = questions.filter(q => q.answer === 5).length;
            if (losing > 0) {
                const ok = window.confirm(`${losing}개 문항이 삭제됩니다. 계속하시겠습니까?`);
                if (!ok) return;
                setQuestions(prev => prev.map(q => q.answer === 5 ? { ...q, answer: undefined } : q));
            }
        }
        setDefaultChoices(next);
        setQuestions(prev => prev.map(q => ({ ...q, choices: next })));
    };

    const handleAutoDetectLocations = async () => {
        if (!pdfFile) {
            toast.info("문제지 필요", "먼저 문제지 PDF를 왼쪽 상단에서 업로드해주세요.");
            return;
        }
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
            toast.success("위치 자동 매칭 완료", `총 ${pdf.numPages}페이지에서 ${mappedCount}개 문항의 위치를 찾았습니다.`);
        } catch (e) {
            console.error(e);
            toast.error("자동 매칭 실패", "위치 자동 매칭 중 오류가 발생했습니다.");
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

            // Editing? Reuse the existing ID and preserve createdAt; otherwise mint a new one.
            const id = loadedExam?.id || Date.now().toString(36);
            const createdAt = loadedExam?.createdAt || new Date().toISOString();

            const examData = {
                ...(loadedExam || {}),
                id,
                title,
                questions,
                accessConfig,
                pdfData: pdfBase64, // Problem PDF
                answerKeyPdf: answerKeyBase64, // Reference Key
                createdAt,
                updatedAt: new Date().toISOString(),
                durationMin: typeof durationMin === 'number' ? durationMin : undefined,
                startAt: localInputToIso(startAt),
                endAt: localInputToIso(endAt),
                archived: loadedExam?.archived || false,
            };

            const ok = safeSetLocal(`omr_exam_${id}`, JSON.stringify(examData));
            if (!ok) return "";
            // Clear the autosave draft now that the exam is published.
            try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
            const shareUrl = `${window.location.origin}/solve/${id}`;
            toast.success("배포 준비 완료", "공유 링크가 생성되었습니다.");
            return shareUrl;
        } catch (e) {
            console.error(e);
            toast.error("배포 저장 실패", "파일 용량이 너무 큽니다. (LocalStorage 한계)");
            return "";
        }
    };

    const handleAnswerImport = (importedAnswers: ParsedAnswer[]) => {
        // Find max question number to auto-resize exam if needed
        const maxQ = Math.max(...importedAnswers.map(ans => ans.questionNum));
        if (maxQ > questionsCount) {
            if (window.confirm(`가져온 정답이 ${maxQ}번까지 있습니다. 문항 수를 늘리시겠습니까?`)) {
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

        toast.success("정답 적용됨", "정답 및 배점(있는 경우)이 적용되었습니다.");
    };

    const handleFastAnswerChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        // Accept 1-4 when defaultChoices is 4, else 1-5.
        const maxDigit = defaultChoices;
        const digitRegex = new RegExp(`[^1-${maxDigit}]`, 'g');
        const val = e.target.value.replace(digitRegex, '');
        setFastAnswer(val);

        setQuestions(prev => prev.map((q, i) => {
            if (i < val.length) {
                return { ...q, answer: parseInt(val[i]) };
            }
            return q;
        }));
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
            toast.success("이미지 저장 완료");
        } catch (err) {
            console.error("Save failed:", err);
            toast.error("이미지 저장 실패");
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <div className="layout-main" style={{ background: 'var(--background)', height: '100vh', overflow: 'hidden' }}>
            <header className="header" style={{ flexShrink: 0 }}>
                <div className="container header-content" style={{ maxWidth: '100%', padding: '0 2rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                        <Link href="/" className="logo" style={{ textDecoration: 'none' }}>
                            OMR Maker
                        </Link>
                        <span className="badge badge-primary" style={{ fontSize: '0.68rem' }}>
                            Smart Editor
                        </span>
                    </div>
                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                        <button
                            type="button"
                            onClick={undo}
                            aria-label="되돌리기 (Ctrl+Z)"
                            title="되돌리기 (Ctrl+Z)"
                            className="btn btn-secondary"
                            style={{ padding: '0.55rem 0.65rem', fontSize: '0.85rem', display: 'flex', alignItems: 'center' }}
                        >
                            <Undo2 size={16} />
                        </button>
                        <button
                            type="button"
                            onClick={redo}
                            aria-label="다시 실행 (Ctrl+Shift+Z)"
                            title="다시 실행 (Ctrl+Shift+Z)"
                            className="btn btn-secondary"
                            style={{ padding: '0.55rem 0.65rem', fontSize: '0.85rem', display: 'flex', alignItems: 'center' }}
                        >
                            <Redo2 size={16} />
                        </button>
                        <label className="btn btn-secondary" style={{ cursor: 'pointer', padding: '0.55rem 1rem', fontSize: '0.85rem' }}>
                            문제지 업로드
                            <input id="pdf-upload-input" type="file" accept=".pdf" onChange={handleFileChange} style={{ display: 'none' }} />
                        </label>
                        <label className="btn btn-secondary" style={{ cursor: 'pointer', padding: '0.55rem 1rem', fontSize: '0.85rem' }}>
                            답지 업로드
                            <input type="file" accept=".pdf" onChange={(e) => {
                                if (e.target.files && e.target.files[0]) {
                                    setAnswerKeyPdf(e.target.files[0]);
                                }
                            }} style={{ display: 'none' }} />
                        </label>
                        <button
                            className="btn btn-secondary"
                            style={{ padding: '0.55rem 1rem', fontSize: '0.85rem' }}
                            onClick={handleSaveImage}
                            disabled={isSaving}
                        >
                            {isSaving ? "저장 중..." : "이미지 저장"}
                        </button>
                        <button
                            className="btn btn-primary"
                            style={{ padding: '0.55rem 1.1rem', fontSize: '0.85rem' }}
                            onClick={() => setIsDistributeModalOpen(true)}
                        >
                            배포하기
                        </button>
                        <ThemeToggle size="small" />
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
                <div style={{
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
                                        label: q.number,
                                        color: selectedQuestionId === q.id ? '#6366f1' : '#ef4444',
                                        onClick: () => setSelectedQuestionId(q.id)
                                    }))
                                : []}
                        />
                    </div>
                </div>

                {/* Resizer 1 */}
                <div
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
                <aside className="glass-panel" style={{
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
                            <div style={{ marginBottom: '1rem', padding: '0.8rem', background: 'rgba(16, 185, 129, 0.08)', borderRadius: 'var(--radius-md)', border: '1px solid rgba(16, 185, 129, 0.25)', fontSize: '0.85rem' }}>
                                <div style={{ color: 'var(--success)', fontWeight: 700, marginBottom: '0.2rem' }}>✓ 참고용 답지 등록됨</div>
                                <div style={{ color: 'var(--success)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 0.85 }}>{answerKeyPdf.name}</div>
                                <button
                                    onClick={() => window.open(URL.createObjectURL(answerKeyPdf), '_blank')}
                                    style={{ marginTop: '0.4rem', color: 'var(--success)', textDecoration: 'underline', background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: '0.75rem' }}
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
                                    onClick={() => handleQuestionCountChange(count)}
                                >
                                    {count}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div style={{ marginBottom: '1.5rem' }}>
                        <label style={{ display: 'block', marginBottom: '0.5rem', fontSize: '0.9rem', fontWeight: 500 }}>기본 선택지 수</label>
                        <div style={{ display: 'flex', gap: '0.5rem' }}>
                            <button
                                className={`btn ${defaultChoices === 4 ? 'btn-primary' : 'btn-secondary'}`}
                                style={{ flex: 1 }}
                                onClick={() => handleDefaultChoicesChange(4)}
                            >
                                4지선다
                            </button>
                            <button
                                className={`btn ${defaultChoices === 5 ? 'btn-primary' : 'btn-secondary'}`}
                                style={{ flex: 1 }}
                                onClick={() => handleDefaultChoicesChange(5)}
                            >
                                5지선다
                            </button>
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
                            disabled={isDetectingLocation || !pdfFile}
                        >
                            {isDetectingLocation ? "⏳ 위치 찾는 중..." : "🎯 PDF 문제 위치 자동 매칭"}
                        </button>

                        <div style={{ marginBottom: '1rem' }}>
                            <label style={{ display: 'block', marginBottom: '0.4rem', fontSize: '0.9rem', fontWeight: 600, color: 'var(--primary)' }}>
                                빠른 정답 입력 (연속 입력)
                            </label>
                            <input
                                type="text"
                                placeholder={defaultChoices === 4 ? "예: 3124..." : "예: 31251..."}
                                value={fastAnswer}
                                onChange={handleFastAnswerChange}
                                className="input-field"
                                style={{ width: '100%', padding: '0.6rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', background: 'var(--background)', fontSize: '1rem', letterSpacing: '2px' }}
                            />
                            <div style={{ fontSize: '0.75rem', color: 'var(--muted)', marginTop: '0.3rem' }}>
                                {`1~${defaultChoices}의 숫자를 입력하면 문항 순서대로 정답이 즉시 반영됩니다.`}
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
                                {/* Answer Setting */}
                                <div style={{ marginBottom: '1rem' }}>
                                    <label style={{ display: 'block', marginBottom: '0.3rem', fontSize: '0.85rem' }}>정답 설정</label>
                                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                                        {Array.from({ length: defaultChoices }, (_, i) => i + 1).map(num => {
                                            const currentQ = questions.find(q => q.id === selectedQuestionId);
                                            const isSelected = currentQ?.answer === num;
                                            return (
                                                <button
                                                    key={num}
                                                    onClick={() => setAnswer(num)}
                                                    style={{
                                                        width: '30px', height: '30px',
                                                        borderRadius: '50%',
                                                        border: isSelected ? 'none' : '1px solid var(--border)',
                                                        background: isSelected ? 'var(--primary)' : 'var(--surface)',
                                                        color: isSelected ? 'white' : 'var(--foreground)',
                                                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                        fontSize: '0.85rem', fontWeight: 700,
                                                        transition: 'all 0.2s',
                                                        cursor: 'pointer',
                                                        flexShrink: 0,
                                                    }}
                                                >
                                                    {num}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>

                                {/* Score Setting */}
                                <div style={{ marginBottom: '1rem' }}>
                                    <label style={{ display: 'block', marginBottom: '0.3rem', fontSize: '0.85rem' }}>배점 (점수)</label>
                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', alignItems: 'center' }}>
                                        {[2, 3, 4, 5].map(pts => {
                                            const currentQ = questions.find(q => q.id === selectedQuestionId);
                                            const isSelected = currentQ?.score === pts;
                                            return (
                                                <button
                                                    key={pts}
                                                    onClick={() => setScore(pts)}
                                                    style={{
                                                        padding: '4px 10px',
                                                        borderRadius: '12px',
                                                        border: isSelected ? '1px solid var(--primary)' : '1px solid var(--border)',
                                                        background: isSelected ? 'rgba(99, 102, 241, 0.1)' : 'var(--surface)',
                                                        color: isSelected ? 'var(--primary)' : 'var(--muted)',
                                                        fontSize: '0.8rem', fontWeight: 700,
                                                        transition: 'all 0.2s',
                                                        cursor: 'pointer',
                                                        whiteSpace: 'nowrap',
                                                        flexShrink: 0,
                                                    }}
                                                >
                                                    {pts}점
                                                </button>
                                            );
                                        })}
                                        <input
                                            type="number"
                                            placeholder="직접"
                                            value={questions.find(q => q.id === selectedQuestionId)?.score || ''}
                                            onChange={(e) => {
                                                const val = parseFloat(e.target.value);
                                                if (!isNaN(val)) setScore(val);
                                            }}
                                            style={{ width: '60px', minWidth: '55px', padding: '4px 6px', fontSize: '0.8rem', border: '1px solid var(--border)', borderRadius: '12px', background: 'var(--surface)', color: 'var(--foreground)' }}
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
                                                        background: isActive ? 'rgba(99, 102, 241, 0.1)' : 'var(--surface)',
                                                        color: isActive ? 'var(--primary)' : 'var(--muted)',
                                                        cursor: 'pointer',
                                                        transition: 'all 0.2s',
                                                        whiteSpace: 'nowrap',
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

                    <div style={{ marginBottom: '1.5rem', padding: '1rem', background: 'rgba(99, 102, 241, 0.04)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)' }}>
                        <h3 style={{ fontSize: '0.95rem', fontWeight: 700, marginBottom: '0.75rem', color: 'var(--foreground)' }}>
                            일정 설정
                            {loadedExam && (
                                <span style={{ marginLeft: 8, fontSize: '0.7rem', fontWeight: 700, color: 'var(--primary)', background: 'rgba(99,102,241,0.1)', padding: '2px 8px', borderRadius: 'var(--radius-full)' }}>
                                    편집 중
                                </span>
                            )}
                        </h3>

                        <div style={{ marginBottom: '0.75rem' }}>
                            <label style={{ display: 'block', marginBottom: '0.3rem', fontSize: '0.82rem', fontWeight: 500 }}>시험 시간(분)</label>
                            <input
                                type="number"
                                min={1}
                                value={durationMin}
                                onChange={(e) => {
                                    const v = e.target.value;
                                    setDurationMin(v === "" ? "" : Math.max(1, parseInt(v, 10) || 0));
                                }}
                                className="input-field"
                                style={{ width: '100%', padding: '0.5rem 0.6rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', background: 'var(--background)', fontSize: '0.9rem' }}
                            />
                        </div>

                        <div style={{ marginBottom: '0.75rem' }}>
                            <label style={{ display: 'block', marginBottom: '0.3rem', fontSize: '0.82rem', fontWeight: 500 }}>시작 시각</label>
                            <input
                                type="datetime-local"
                                value={startAt}
                                onChange={(e) => setStartAt(e.target.value)}
                                className="input-field"
                                style={{ width: '100%', padding: '0.5rem 0.6rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', background: 'var(--background)', fontSize: '0.85rem' }}
                            />
                        </div>

                        <div>
                            <label style={{ display: 'block', marginBottom: '0.3rem', fontSize: '0.82rem', fontWeight: 500 }}>종료 시각</label>
                            <input
                                type="datetime-local"
                                value={endAt}
                                onChange={(e) => setEndAt(e.target.value)}
                                className="input-field"
                                style={{ width: '100%', padding: '0.5rem 0.6rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', background: 'var(--background)', fontSize: '0.85rem' }}
                            />
                        </div>

                        <p style={{ marginTop: '0.5rem', fontSize: '0.75rem', color: 'var(--muted)' }}>
                            배포 시 함께 저장됩니다. 비워두면 제한 없이 응시할 수 있습니다.
                        </p>
                    </div>

                    <button className="btn btn-secondary" style={{ width: '100%' }} onClick={() => typeof window !== 'undefined' && window.print()}>
                        인쇄하기
                    </button>
                </aside>

                {/* Resizer 2 */}
                <div
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
                <main style={{
                    flex: 1,
                    display: 'flex',
                    flexDirection: 'column',
                    minWidth: '350px',
                    overflow: 'hidden',
                    background: 'var(--background)',
                }}>
                    {/* Preview mode toggle */}
                    <div style={{
                        padding: '0.75rem 1.25rem',
                        borderBottom: '1px solid var(--border)',
                        background: 'var(--surface)',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        flexShrink: 0,
                    }}>
                        <span style={{ fontSize: '0.82rem', fontWeight: 700, color: 'var(--foreground)', letterSpacing: '-0.01em' }}>
                            OMR 미리보기
                        </span>
                        <div style={{
                            display: 'flex',
                            background: 'var(--background)',
                            border: '1px solid var(--border)',
                            borderRadius: 'var(--radius-full)',
                            padding: '3px',
                        }}>
                            <button
                                onClick={() => setPreviewMode('modern')}
                                style={{
                                    padding: '0.3rem 0.9rem',
                                    fontSize: '0.78rem',
                                    borderRadius: 'var(--radius-full)',
                                    border: 'none',
                                    background: previewMode === 'modern' ? 'var(--primary)' : 'transparent',
                                    color: previewMode === 'modern' ? 'white' : 'var(--muted)',
                                    fontWeight: 700,
                                    cursor: 'pointer',
                                    transition: 'all 0.2s',
                                }}
                            >
                                카드뷰
                            </button>
                            <button
                                onClick={() => setPreviewMode('paper')}
                                style={{
                                    padding: '0.3rem 0.9rem',
                                    fontSize: '0.78rem',
                                    borderRadius: 'var(--radius-full)',
                                    border: 'none',
                                    background: previewMode === 'paper' ? 'var(--primary)' : 'transparent',
                                    color: previewMode === 'paper' ? 'white' : 'var(--muted)',
                                    fontWeight: 700,
                                    cursor: 'pointer',
                                    transition: 'all 0.2s',
                                }}
                            >
                                인쇄용 (A4)
                            </button>
                        </div>
                    </div>

                    <div style={{
                        flex: 1,
                        overflowY: 'auto',
                        overflowX: 'auto',
                        padding: previewMode === 'paper' ? '2rem' : '0',
                        display: 'flex',
                        justifyContent: 'center',
                        background: previewMode === 'paper' ? '#e2e8f0' : 'transparent',
                    }} className="scroll-custom">
                        {previewMode === 'modern' ? (
                            <OMRCardView
                                title={title}
                                questions={questions}
                                mode="editor"
                                selectedQuestionId={selectedQuestionId}
                                onQuestionClick={setSelectedQuestionId}
                                onAnswerClick={handleOMRAnswerClick}
                                showMeta={true}
                            />
                        ) : (
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
                        )}
                    </div>
                </main>

            </div >
        </div >
    );
}
