"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import OMRCardView from "@/components/OMRCardView";
import ThemeToggle from "@/components/ThemeToggle";
import dynamic from "next/dynamic";
import { toast } from "@/components/Toast";
import { Clock, Save } from "lucide-react";
import { storedDataUrlToFile, saveJsonRecord } from "@/utils/blobStore";
import { verifyTeacherPassword } from "@/app/actions/auth";
import { getOrCreateGuestId, getSession, saveSession, type StudentSession } from "@/utils/storage";

const PDFViewer = dynamic(() => import("@/components/PDFViewer"), { ssr: false });
import { gradeAttempt } from "@/types/omr";
import type { Attempt, Exam, PdfDrawings, Question } from "@/types/omr";

const AUTOSAVE_INTERVAL_MS = 3000;

interface SolveDraft {
    answers: Record<number, number>;
    drawings: PdfDrawings;
    timeRemaining: number | null;
    startedAt: string;
    savedAt: string;
}

function isPdfDrawings(value: unknown): value is PdfDrawings {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    return Object.values(value as Record<string, unknown>).every(paths =>
        Array.isArray(paths) && paths.every(path => typeof path === "string")
    );
}

function compactDrawings(drawings: PdfDrawings): PdfDrawings {
    return Object.fromEntries(
        Object.entries(drawings).filter(([, paths]) => paths.length > 0)
    ) as PdfDrawings;
}

function hasDrawings(drawings: PdfDrawings): boolean {
    return Object.values(drawings).some(paths => paths.length > 0);
}

export default function SolvePage() {
    const params = useParams();
    const router = useRouter();
    const id = params?.id as string;

    const [examData, setExamData] = useState<Exam | null>(null);
    const [studentAnswers, setStudentAnswers] = useState<Record<number, number>>({});
    const [drawings, setDrawings] = useState<PdfDrawings>({});
    const [pdfFile, setPdfFile] = useState<File | null>(null);

    const [user, setUser] = useState<StudentSession | null>(() => getSession());

    // Navigation State
    const [currentQuestionId, setCurrentQuestionId] = useState<number | null>(null);
    const [pdfCurrentPage, setPdfCurrentPage] = useState<number | undefined>(undefined);

    // Teacher Mode State
    const [isTeacherMode, setIsTeacherMode] = useState(false);
    const [activeTab, setActiveTab] = useState<'problem' | 'answer'>('problem');
    const [answerFile, setAnswerFile] = useState<File | null>(null);

    // Layout State
    const [isOMRCollapsed, setIsOMRCollapsed] = useState(false);

    // Timer + autosave State
    const [startedAt, setStartedAt] = useState(() => new Date().toISOString());
    const [timeRemaining, setTimeRemaining] = useState<number | null>(null); // seconds
    const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
    const [hasResumed, setHasResumed] = useState(false);
    const submittedRef = useRef(false);
    const latestDraftRef = useRef<SolveDraft | null>(null);
    const autosaveErrorShownRef = useRef(false);
    
    // Focus Warning States (Anti-cheat)
    const [tabFociLostCount, setTabFociLostCount] = useState(0);
    const [showFocusWarning, setShowFocusWarning] = useState(false);

    // Stable per-device student/guest id
    const [persistId] = useState(() => {
        if (typeof window === "undefined") return "";
        let pid = localStorage.getItem("omr_student_pid");
        if (!pid) {
            pid = `pid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
            localStorage.setItem("omr_student_pid", pid);
        }
        return pid;
    });

    // Anti-cheat Window Focus/Visibility Monitoring
    useEffect(() => {
        if (submittedRef.current) return;

        let isFocused = true;

        const triggerWarning = () => {
            if (submittedRef.current) return;
            setTabFociLostCount(c => {
                const nextCount = c + 1;
                setShowFocusWarning(true);
                return nextCount;
            });
        };

        const handleWindowBlur = () => {
            if (isFocused) {
                isFocused = false;
                triggerWarning();
            }
        };

        const handleWindowFocus = () => {
            isFocused = true;
        };

        const handleVisibilityChange = () => {
            if (document.visibilityState === "hidden" && isFocused) {
                isFocused = false;
                triggerWarning();
            } else if (document.visibilityState === "visible") {
                isFocused = true;
            }
        };

        window.addEventListener("blur", handleWindowBlur);
        window.addEventListener("focus", handleWindowFocus);
        document.addEventListener("visibilitychange", handleVisibilityChange);

        return () => {
            window.removeEventListener("blur", handleWindowBlur);
            window.removeEventListener("focus", handleWindowFocus);
            document.removeEventListener("visibilitychange", handleVisibilityChange);
        };
    }, []);

    const draftOwnerKey = user?.studentId || user?.guestId || persistId;
    const DRAFT_KEY = id && draftOwnerKey ? `omr_draft_${id}_${draftOwnerKey}` : "";
    const LEGACY_DRAFT_KEY = id ? `omr_draft_${id}` : "";

    useEffect(() => {
        const currentSession = getSession();
        if (currentSession) setUser(currentSession);

        const loadExam = async () => {
            if (!id) return;
            const data = localStorage.getItem(`omr_exam_${id}`);
            if (!data) {
                toast.error("시험을 찾을 수 없음", "유효하지 않은 시험 ID입니다.");
                return;
            }
            try {
                const parsed = JSON.parse(data);
                setExamData(parsed);

                // Enforce schedule window (startAt/endAt)
                const now = Date.now();
                if (parsed.startAt && new Date(parsed.startAt).getTime() > now) {
                    toast.info("아직 응시 시작 전입니다", `${new Date(parsed.startAt).toLocaleString('ko-KR')}에 시작합니다.`);
                }
                if (parsed.endAt && new Date(parsed.endAt).getTime() < now) {
                    toast.error("응시 기간 종료", "이 시험의 응시 가능 기간이 지났습니다.");
                }

                // Initialize timer from duration
                if (parsed.durationMin && typeof parsed.durationMin === "number") {
                    setTimeRemaining(parsed.durationMin * 60);
                }

                // Restore draft (autosave) if present
                try {
                    const ownerKey = currentSession?.studentId || currentSession?.guestId || persistId;
                    const scopedDraftKey = ownerKey ? `omr_draft_${id}_${ownerKey}` : "";
                    const draftStr = (scopedDraftKey ? localStorage.getItem(scopedDraftKey) : null)
                        || localStorage.getItem(`omr_draft_${id}`);
                    if (draftStr) {
                        const draft = JSON.parse(draftStr);
                        if (draft.answers && typeof draft.answers === "object") {
                            setStudentAnswers(draft.answers);
                        }
                        if (isPdfDrawings(draft.drawings)) {
                            setDrawings(draft.drawings);
                        }
                        if (typeof draft.timeRemaining === "number") {
                            setTimeRemaining(draft.timeRemaining);
                        }
                        if (typeof draft.startedAt === "string") {
                            setStartedAt(draft.startedAt);
                        }
                        setHasResumed(true);
                    }
                } catch {
                    // ignore bad draft
                }

                const problemPdf = await storedDataUrlToFile("problem.pdf", parsed.pdfData, parsed.pdfDataRef);
                if (problemPdf) setPdfFile(problemPdf);

                const answerPdf = await storedDataUrlToFile("answer_key.pdf", parsed.answerKeyPdf, parsed.answerKeyPdfRef);
                if (answerPdf) setAnswerFile(answerPdf);
            } catch (err) {
                alert("시험 데이터 로드 실패");
                console.error(err);
            }
        };

        loadExam();
    }, [id, persistId]);

    // Show resume banner once after initial load
    useEffect(() => {
        if (hasResumed) {
            toast.info("임시저장 복원됨", "이전에 풀던 답안을 불러왔습니다.");
        }
    }, [hasResumed]);

    // Tick timer every second when examData has duration. Auto-submit at 0.
    useEffect(() => {
        if (timeRemaining === null || submittedRef.current) return;
        if (timeRemaining <= 0) {
            submittedRef.current = true;
            handleSubmitInternal(true);
            return;
        }
        const id = setTimeout(() => setTimeRemaining(t => (t === null ? null : t - 1)), 1000);
        return () => clearTimeout(id);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [timeRemaining]);

    useEffect(() => {
        latestDraftRef.current = {
            answers: studentAnswers,
            drawings: compactDrawings(drawings),
            timeRemaining,
            startedAt,
            savedAt: new Date().toISOString(),
        };
    }, [studentAnswers, drawings, timeRemaining, startedAt]);

    // Autosave draft every 3s. Keep this interval independent from the ticking timer.
    useEffect(() => {
        if (!DRAFT_KEY) return;
        const saveDraft = () => {
            if (submittedRef.current || !latestDraftRef.current) return;
            const savedAt = new Date().toISOString();
            try {
                localStorage.setItem(DRAFT_KEY, JSON.stringify({
                    ...latestDraftRef.current,
                    savedAt,
                }));
                autosaveErrorShownRef.current = false;
                setLastSavedAt(new Date(savedAt));
            } catch {
                if (!autosaveErrorShownRef.current) {
                    autosaveErrorShownRef.current = true;
                    toast.error("Autosave failed", "Unable to save answers and handwriting.");
                }
                // quota exceeded: keep the first error visible without spamming toasts
            }
        };

        const handleVisibilityChange = () => {
            if (document.visibilityState === "hidden") saveDraft();
        };

        const intervalId = window.setInterval(saveDraft, AUTOSAVE_INTERVAL_MS);
        window.addEventListener("pagehide", saveDraft);
        window.addEventListener("visibilitychange", handleVisibilityChange);

        return () => {
            window.clearInterval(intervalId);
            window.removeEventListener("pagehide", saveDraft);
            window.removeEventListener("visibilitychange", handleVisibilityChange);
        };
    }, [DRAFT_KEY]);

    // Warn on tab close if there are unsaved answers
    useEffect(() => {
        const onBeforeUnload = (e: BeforeUnloadEvent) => {
            if (submittedRef.current) return;
            if (Object.keys(studentAnswers).length === 0 && !hasDrawings(drawings)) return;
            e.preventDefault();
            e.returnValue = "";
        };
        window.addEventListener("beforeunload", onBeforeUnload);
        return () => window.removeEventListener("beforeunload", onBeforeUnload);
    }, [studentAnswers, drawings]);

    const handleAnswerClick = (qId: number, optionIndex: number) => {
        setStudentAnswers(prev => ({ ...prev, [qId]: optionIndex }));
        setCurrentQuestionId(qId);
    };

    const handleQuestionClick = (qId: number) => {
        setCurrentQuestionId(qId);
        if (examData) {
            const q = examData.questions.find(q => q.id === qId);
            if (q?.pdfLocation?.page) setPdfCurrentPage(q.pdfLocation.page);
        }
    };

    const handleDrawingsChange = (page: number, newPaths: string[]) => {
        setDrawings(prev => ({ ...prev, [page]: newPaths }));
    };

    const handleSubmitInternal = async (autoSubmitted = false) => {
        if (!examData) return;
        if (submittedRef.current && !autoSubmitted) return;

        let submitter = user;
        if (!submitter) {
            if (examData.accessConfig?.type === 'public') {
                const name = window.prompt("이름을 입력해주세요 (게스트 제출):");
                if (!name) return;
                const guestId = getOrCreateGuestId();
                submitter = {
                    studentId: `guest:${guestId}`,
                    name,
                    isGuest: true,
                    identityType: 'guest',
                    guestId,
                    groupName: 'Guest',
                };
                saveSession(submitter);
                setUser(submitter);
                localStorage.setItem("omr_guest_id", guestId);
            } else {
                toast.error("로그인 필요", "이 시험은 로그인이 필요합니다.");
                router.push("/");
                return;
            }
        }

        submittedRef.current = true;

        // Use weighted grading from types/omr.ts
        const graded = gradeAttempt(examData.questions, studentAnswers);

        const attemptId = Date.now().toString();
        const activeDrawings = compactDrawings(drawings);
        
        let drawingsRef = undefined;
        if (hasDrawings(activeDrawings)) {
            try {
                const stored = await saveJsonRecord(`attempt:${attemptId}:drawings`, activeDrawings);
                drawingsRef = stored;
            } catch (e) {
                console.error("Failed to save drawings to IndexedDB", e);
            }
        }

        const attemptData: Attempt = {
            id: attemptId,
            examId: id,
            examTitle: examData.title,
            studentName: submitter.name,
            studentId: submitter.studentId || submitter.guestId || persistId,
            groupId: submitter.groupId,
            groupName: submitter.groupName,
            identityType: submitter.identityType || (submitter.isGuest ? 'guest' : 'temporary'),
            guestId: submitter.guestId,
            startedAt,
            finishedAt: new Date().toISOString(),
            score: graded.earnedScore,
            totalScore: graded.totalScore,
            answers: studentAnswers,
            drawings: undefined, // Omit from localStorage to protect quota limit
            drawingsRef,
            status: 'completed' as const,
            autoSubmitted,
            tabFociLostCount,
        };

        try {
            const history = JSON.parse(localStorage.getItem('omr_attempts') || '[]');
            history.push(attemptData);
            localStorage.setItem('omr_attempts', JSON.stringify(history));
            // Clean up draft
            try { localStorage.removeItem(DRAFT_KEY); } catch {}
            try { localStorage.removeItem(LEGACY_DRAFT_KEY); } catch {}
        } catch {
            toast.error("저장 공간 부족", "브라우저 저장소가 가득 찼습니다. 관리자에게 문의하세요.");
            return;
        }

        if (autoSubmitted) {
            toast.info("시간 종료", "답안이 자동으로 제출되었습니다.");
        }
        router.push(`/student/review/${attemptId}`);
    };

    const handleSubmit = () => {
        if (!examData) return;
        const totalQ = examData.questions.length;
        const answeredCount = Object.keys(studentAnswers).length;
        const unanswered = totalQ - answeredCount;
        const message = unanswered > 0
            ? `미답변 ${unanswered}문항이 있습니다. 정말 제출하시겠습니까?`
            : `모든 답변을 완료했습니다. 제출하시겠습니까?`;
        if (!window.confirm(message)) return;
        handleSubmitInternal(false);
    };

    const toggleTeacherMode = async (checked: boolean) => {
        if (checked) {
            const password = prompt("선생님 비밀번호를 입력하세요 (기본: admin123)");
            if (!password) {
                setIsTeacherMode(false);
                return;
            }
            try {
                const res = await verifyTeacherPassword(password);
                if (res.success && res.token) {
                    setIsTeacherMode(true);
                    sessionStorage.setItem("omr_teacher_token", res.token);
                } else {
                    alert(res.error || "비밀번호가 틀렸습니다.");
                    setIsTeacherMode(false);
                }
            } catch {
                alert("인증 오류가 발생했습니다.");
                setIsTeacherMode(false);
            }
        } else {
            setIsTeacherMode(false);
        }
    };

    if (!examData) {
        return (
            <div style={{ padding: '2rem', textAlign: 'center' }}>
                <h2>시험을 불러오는 중...</h2>
                <Link href="/" className="btn btn-secondary">홈으로 돌아가기</Link>
            </div>
        );
    }

    const answeredCount = Object.keys(studentAnswers).length;
    const totalQuestions = examData.questions.length;
    const progress = totalQuestions > 0 ? (answeredCount / totalQuestions) * 100 : 0;

    return (
        <div className="layout-main solve-page" style={{
            background: 'var(--background)',
            height: '100vh',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column'
        }}>
            {/* Header */}
            <header className="header solve-header" style={{
                flexShrink: 0,
                height: 'auto',
                padding: '0.75rem 1.5rem'
            }}>
                <div className="container header-content solve-header-content" style={{ gap: '1rem' }}>
                    <div className="solve-title-group" style={{ display: 'flex', alignItems: 'center', gap: '1rem', minWidth: 0, flex: 1 }}>
                        <Link href="/" className="logo solve-brand" style={{ fontSize: '1.15rem', flexShrink: 0 }}>OMR Maker</Link>
                        <div className="solve-divider" style={{
                            height: '22px',
                            width: '1px',
                            background: 'var(--border)',
                            flexShrink: 0
                        }} />
                        <span className="solve-title" style={{
                            fontSize: '0.9rem',
                            fontWeight: 700,
                            color: 'var(--foreground)',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap'
                        }}>
                            {examData.title}
                        </span>
                    </div>

                    {/* Timer */}
                    {timeRemaining !== null && (
                        (() => {
                            const mm = Math.floor(Math.max(0, timeRemaining) / 60).toString().padStart(2, "0");
                            const ss = (Math.max(0, timeRemaining) % 60).toString().padStart(2, "0");
                            const isCritical = timeRemaining <= 300; // last 5 min
                            return (
                                <div className="solve-timer" style={{
                                    display: 'flex', alignItems: 'center', gap: '0.4rem',
                                    padding: '0.35rem 0.75rem',
                                    background: isCritical ? 'rgba(239,68,68,0.1)' : 'var(--background)',
                                    border: `1px solid ${isCritical ? 'rgba(239,68,68,0.3)' : 'var(--border)'}`,
                                    borderRadius: 'var(--radius-full)',
                                    color: isCritical ? '#ef4444' : 'var(--foreground)',
                                    flexShrink: 0,
                                    animation: isCritical ? 'pulse 1.5s ease-in-out infinite' : undefined
                                }}>
                                    <Clock size={13} />
                                    <span style={{ fontSize: '0.82rem', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                                        {mm}:{ss}
                                    </span>
                                </div>
                            );
                        })()
                    )}

                    {/* Progress indicator */}
                    <div className="solve-progress" style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.75rem',
                        padding: '0.35rem 0.85rem',
                        background: 'var(--background)',
                        border: '1px solid var(--border)',
                        borderRadius: 'var(--radius-full)',
                        flexShrink: 0
                    }}>
                        <div className="solve-progress-bar" style={{
                            width: '90px',
                            height: '4px',
                            background: 'var(--border)',
                            borderRadius: 'var(--radius-full)',
                            overflow: 'hidden'
                        }}>
                            <div className="solve-progress-fill" style={{
                                width: `${progress}%`,
                                height: '100%',
                                background: 'linear-gradient(90deg, var(--primary), var(--secondary))',
                                transition: 'width 0.3s'
                            }} />
                        </div>
                        <span style={{
                            fontSize: '0.82rem',
                            fontWeight: 700,
                            color: 'var(--foreground)',
                            fontVariantNumeric: 'tabular-nums'
                        }}>
                            {answeredCount}/{totalQuestions}
                        </span>
                    </div>

                    {/* Autosave indicator */}
                    {lastSavedAt && (
                        <span
                            className="solve-autosave"
                            title={`마지막 저장: ${lastSavedAt.toLocaleTimeString('ko-KR')}`}
                            style={{
                                display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
                                fontSize: '0.72rem', color: 'var(--muted)', fontWeight: 600, flexShrink: 0
                            }}>
                            <Save size={11} /> 저장됨
                        </span>
                    )}

                    <div className="solve-controls" style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexShrink: 0 }}>
                        <label className="solve-teacher-toggle" style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.4rem',
                            fontSize: '0.78rem',
                            cursor: 'pointer',
                            background: 'var(--background)',
                            border: '1px solid var(--border)',
                            padding: '0.35rem 0.7rem',
                            borderRadius: 'var(--radius-full)',
                            fontWeight: 600,
                            color: 'var(--muted)'
                        }}>
                            <input
                                type="checkbox"
                                checked={isTeacherMode}
                                onChange={(e) => toggleTeacherMode(e.target.checked)}
                                style={{ margin: 0 }}
                            />
                            선생님 모드
                        </label>

                        {isTeacherMode ? (
                            <div className="solve-tab-toggle" style={{
                                display: 'flex',
                                background: 'var(--background)',
                                border: '1px solid var(--border)',
                                borderRadius: 'var(--radius-full)',
                                padding: '3px'
                            }}>
                                <button
                                    className="solve-tab-button"
                                    onClick={() => setActiveTab('problem')}
                                    style={{
                                        padding: '0.3rem 0.8rem',
                                        fontSize: '0.78rem',
                                        borderRadius: 'var(--radius-full)',
                                        border: 'none',
                                        background: activeTab === 'problem' ? 'var(--primary)' : 'transparent',
                                        color: activeTab === 'problem' ? 'white' : 'var(--muted)',
                                        fontWeight: 700,
                                        cursor: 'pointer',
                                        transition: 'all 0.2s'
                                    }}
                                >
                                    문제지
                                </button>
                                <button
                                    className="solve-tab-button"
                                    onClick={() => setActiveTab('answer')}
                                    style={{
                                        padding: '0.3rem 0.8rem',
                                        fontSize: '0.78rem',
                                        borderRadius: 'var(--radius-full)',
                                        border: 'none',
                                        background: activeTab === 'answer' ? 'var(--primary)' : 'transparent',
                                        color: activeTab === 'answer' ? 'white' : 'var(--muted)',
                                        fontWeight: 700,
                                        cursor: 'pointer',
                                        transition: 'all 0.2s'
                                    }}
                                >
                                    정답/해설
                                </button>
                            </div>
                        ) : (
                            <label className="btn btn-secondary solve-pdf-button" style={{
                                cursor: 'pointer',
                                fontSize: '0.8rem',
                                padding: '0.45rem 0.85rem'
                            }}>
                                PDF 열기
                                <input id="pdf-upload-input" type="file" accept=".pdf" onChange={(e) => e.target.files && setPdfFile(e.target.files[0])} style={{ display: 'none' }} />
                            </label>
                        )}

                        <button
                            onClick={() => setIsOMRCollapsed(!isOMRCollapsed)}
                            className="btn btn-secondary solve-collapse-button"
                            style={{
                                padding: '0.45rem 0.75rem',
                                fontSize: '0.8rem',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.35rem'
                            }}
                            title={isOMRCollapsed ? '답안지 펼치기' : '답안지 접기'}
                        >
                            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                                <path d={isOMRCollapsed ? "M9 4L5 7L9 10" : "M5 4L9 7L5 10"} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                            </svg>
                        </button>

                        <button className="btn btn-primary solve-submit-button" style={{ padding: '0.5rem 1rem', fontSize: '0.85rem' }} onClick={handleSubmit}>
                            제출하기
                        </button>
                        <ThemeToggle size="small" />
                    </div>
                </div>
            </header>

            {/* Body */}
            <div className="solve-body" style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
                {/* PDF Area (Left, larger) */}
                <div className="solve-pdf-pane" style={{
                    flex: 1,
                    borderRight: '1px solid var(--border)',
                    background: '#2a2d31',
                    position: 'relative',
                    display: 'flex',
                    flexDirection: 'column',
                    minWidth: 0
                }}>
                    {isTeacherMode && activeTab === 'answer' && !answerFile && (
                        <div className="solve-upload-overlay" style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10, pointerEvents: 'none' }}>
                            <label className="btn btn-primary" style={{ pointerEvents: 'auto', cursor: 'pointer', boxShadow: '0 4px 10px rgba(0,0,0,0.3)' }}>
                                해설/정답 PDF 업로드
                                <input type="file" accept=".pdf" onChange={(e) => e.target.files && setAnswerFile(e.target.files[0])} style={{ display: 'none' }} />
                            </label>
                        </div>
                    )}

                    {isTeacherMode && activeTab === 'problem' && !pdfFile && (
                        <div className="solve-upload-overlay" style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10, pointerEvents: 'none' }}>
                            <label className="btn btn-secondary" style={{ pointerEvents: 'auto', cursor: 'pointer', boxShadow: '0 4px 10px rgba(0,0,0,0.3)' }}>
                                문제지 PDF 업로드
                                <input type="file" accept=".pdf" onChange={(e) => e.target.files && setPdfFile(e.target.files[0])} style={{ display: 'none' }} />
                            </label>
                        </div>
                    )}

                    <PDFViewer
                        file={activeTab === 'problem' ? pdfFile : answerFile}
                        onLoadSuccess={() => { }}
                        onFileDrop={activeTab === 'problem' ? setPdfFile : setAnswerFile}
                        enableDrawing={true}
                        drawings={drawings}
                        onDrawingsChange={handleDrawingsChange}
                        forcePage={activeTab === 'problem' ? pdfCurrentPage : undefined}
                        markers={(activeTab === 'problem' && examData.questions)
                            ? examData.questions
                                .filter((q: Question) => q.pdfLocation)
                                .map((q: Question) => ({
                                    page: q.pdfLocation!.page,
                                    x: q.pdfLocation!.x,
                                    y: q.pdfLocation!.y,
                                    label: q.number,
                                    color: currentQuestionId === q.id ? '#6366f1' : '#ef4444',
                                    onClick: () => handleQuestionClick(q.id),
                                    questionId: q.id,
                                    currentAnswer: studentAnswers[q.id],
                                    onAnswer: (opt: number) => handleAnswerClick(q.id, opt),
                                    optionsCount: q.choices || 5,
                                }))
                            : []}
                    />
                </div>

                {/* OMR Sheet (Right, responsive card view) */}
                <div className={`solve-omr-pane ${isOMRCollapsed ? 'is-collapsed' : ''}`} style={{
                    width: isOMRCollapsed ? '0' : '440px',
                    maxWidth: isOMRCollapsed ? '0' : '40vw',
                    flexShrink: 0,
                    transition: 'width 0.3s, max-width 0.3s',
                    overflow: 'hidden',
                    background: 'var(--background)',
                    display: 'flex',
                    flexDirection: 'column'
                }}>
                    <div style={{ flex: 1, overflowY: 'auto' }} className="scroll-custom solve-omr-scroll">
                        <OMRCardView
                            title={examData.title}
                            questions={examData.questions}
                            userAnswers={studentAnswers}
                            selectedQuestionId={currentQuestionId}
                            onAnswerClick={handleAnswerClick}
                            onQuestionClick={handleQuestionClick}
                            mode="solve"
                        />
                    </div>
                </div>
            </div>

            {/* Focus warning overlay modal (Anti-cheat) */}
            {showFocusWarning && (
                <div style={{
                    position: 'fixed',
                    inset: 0,
                    backgroundColor: 'rgba(15, 23, 42, 0.85)',
                    backdropFilter: 'blur(8px)',
                    zIndex: 9999,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: '1.5rem'
                }}>
                    <div style={{
                        background: 'var(--background, white)',
                        border: '2px solid #ef4444',
                        borderRadius: '16px',
                        padding: '2.5rem 2rem',
                        maxWidth: '480px',
                        width: '100%',
                        textAlign: 'center',
                        boxShadow: '0 25px 50px -12px rgba(239, 68, 68, 0.25)'
                    }}>
                        <div style={{
                            fontSize: '3.5rem',
                            marginBottom: '1rem',
                            animation: 'pulse 2s infinite'
                        }}>
                            ⚠️
                        </div>
                        <h2 style={{
                            fontSize: '1.4rem',
                            fontWeight: 800,
                            color: '#ef4444',
                            marginBottom: '0.75rem'
                        }}>
                            시험 이탈 경고!
                        </h2>
                        <p style={{
                            fontSize: '0.95rem',
                            color: 'var(--foreground)',
                            lineHeight: 1.6,
                            marginBottom: '1.5rem'
                        }}>
                            시험 도중 다른 탭으로 이동하거나 브라우저 화면 포커스를 이탈한 내역이 감지되었습니다.<br />
                            <strong style={{ color: '#ef4444' }}>이탈 기록은 선생님의 감독 대시보드에 실시간으로 기록됩니다.</strong>
                        </p>
                        <div style={{
                            background: 'rgba(239, 68, 68, 0.1)',
                            border: '1px solid rgba(239, 68, 68, 0.2)',
                            borderRadius: '8px',
                            padding: '0.75rem',
                            marginBottom: '2rem',
                            fontSize: '0.9rem',
                            fontWeight: 700,
                            color: '#ef4444'
                        }}>
                            현재 이탈 횟수: <span style={{ fontSize: '1.1rem' }}>{tabFociLostCount}</span>회
                        </div>
                        <button
                            onClick={() => setShowFocusWarning(false)}
                            style={{
                                background: '#ef4444',
                                color: 'white',
                                border: 'none',
                                borderRadius: '8px',
                                padding: '0.75rem 2rem',
                                fontWeight: 700,
                                fontSize: '0.95rem',
                                cursor: 'pointer',
                                transition: 'background 0.2s',
                                width: '100%'
                            }}
                            onMouseOver={(e) => e.currentTarget.style.background = '#dc2626'}
                            onMouseOut={(e) => e.currentTarget.style.background = '#ef4444'}
                        >
                            시험으로 돌아가기
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
