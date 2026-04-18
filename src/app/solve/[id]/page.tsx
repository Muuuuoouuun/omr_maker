"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import OMRCardView from "@/components/OMRCardView";
import ThemeToggle from "@/components/ThemeToggle";
import dynamic from "next/dynamic";

const PDFViewer = dynamic(() => import("@/components/PDFViewer"), { ssr: false });
import { Question } from "@/types/omr";

export default function SolvePage() {
    const params = useParams();
    const id = params?.id as string;

    const [examData, setExamData] = useState<{ title: string; questions: Question[]; accessConfig?: { type: string; groupIds: string[] } } | null>(null);
    const [studentAnswers, setStudentAnswers] = useState<Record<number, number>>({});
    const [drawings, setDrawings] = useState<Record<number, string[]>>({});
    const [pdfFile, setPdfFile] = useState<File | null>(null);

    const [user, setUser] = useState<{ name: string; isGuest?: boolean; guestId?: string } | null>(null);

    // Navigation State
    const [currentQuestionId, setCurrentQuestionId] = useState<number | null>(null);
    const [pdfCurrentPage, setPdfCurrentPage] = useState<number | undefined>(undefined);

    // Teacher Mode State
    const [isTeacherMode, setIsTeacherMode] = useState(false);
    const [activeTab, setActiveTab] = useState<'problem' | 'answer'>('problem');
    const [answerFile, setAnswerFile] = useState<File | null>(null);

    // Layout State
    const [isOMRCollapsed, setIsOMRCollapsed] = useState(false);

    useEffect(() => {
        const sessionStr = sessionStorage.getItem("omr_student_session");
        if (sessionStr) setUser(JSON.parse(sessionStr));

        const loadExam = async () => {
            if (!id) return;
            const data = localStorage.getItem(`omr_exam_${id}`);
            if (!data) {
                alert("유효하지 않은 시험 ID이거나 데이터가 없습니다.");
                return;
            }
            try {
                const parsed = JSON.parse(data);
                setExamData(parsed);

                if (parsed.pdfData) {
                    try {
                        const fetchRes = await fetch(parsed.pdfData);
                        const blob = await fetchRes.blob();
                        const file = new File([blob], "problem.pdf", { type: "application/pdf" });
                        setPdfFile(file);
                    } catch (err) {
                        console.error("Failed to load problem PDF", err);
                    }
                }

                if (parsed.answerKeyPdf) {
                    try {
                        const fetchRes = await fetch(parsed.answerKeyPdf);
                        const blob = await fetchRes.blob();
                        const file = new File([blob], "answer_key.pdf", { type: "application/pdf" });
                        setAnswerFile(file);
                    } catch (err) {
                        console.error("Failed to load answer key PDF", err);
                    }
                }
            } catch (err) {
                alert("시험 데이터 로드 실패");
                console.error(err);
            }
        };

        loadExam();
    }, [id]);

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

    const handleSubmit = () => {
        if (!confirm("정말 제출하시겠습니까? (현재는 로컬에만 저장됩니다)")) return;
        if (!examData) return;

        let submitter = user;
        if (!submitter) {
            if (examData.accessConfig?.type === 'public') {
                const name = prompt("이름을 입력해주세요 (게스트 제출):");
                if (!name) return;
                const guestId = Math.random().toString(36).substring(2, 15);
                submitter = { name, isGuest: true, guestId };
                sessionStorage.setItem("omr_student_session", JSON.stringify({ ...submitter, groupName: 'Guest' }));
                localStorage.setItem("omr_guest_id", guestId);
            } else {
                alert("로그인이 필요한 시험입니다.");
                window.location.href = "/";
                return;
            }
        }

        let correctCount = 0;
        let totalCount = 0;
        examData.questions.forEach(q => {
            if (q.answer) {
                totalCount++;
                if (studentAnswers[q.id] === q.answer) correctCount++;
            }
        });

        const attemptId = Date.now().toString();
        const attemptData = {
            id: attemptId,
            examId: id,
            examTitle: examData.title,
            studentName: submitter.name,
            guestId: submitter.guestId,
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            score: correctCount,
            totalScore: totalCount,
            answers: studentAnswers,
            drawings: drawings,
            status: 'completed'
        };

        const history = JSON.parse(localStorage.getItem('omr_attempts') || '[]');
        history.push(attemptData);
        localStorage.setItem('omr_attempts', JSON.stringify(history));

        alert(`제출 완료! 점수: ${correctCount}/${totalCount}`);
        window.location.href = `/student/review/${attemptId}`;
    };

    const toggleTeacherMode = (checked: boolean) => {
        if (checked) {
            const password = prompt("선생님 비밀번호를 입력하세요 (기본: admin123)");
            if (password === "admin123") {
                setIsTeacherMode(true);
            } else {
                alert("비밀번호가 틀렸습니다.");
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
        <div className="layout-main" style={{
            background: 'var(--background)',
            height: '100vh',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column'
        }}>
            {/* Header */}
            <header className="header" style={{
                flexShrink: 0,
                height: 'auto',
                padding: '0.75rem 1.5rem'
            }}>
                <div className="container header-content" style={{ gap: '1rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', minWidth: 0, flex: 1 }}>
                        <Link href="/" className="logo" style={{ fontSize: '1.15rem', flexShrink: 0 }}>OMR Maker</Link>
                        <div style={{
                            height: '22px',
                            width: '1px',
                            background: 'var(--border)',
                            flexShrink: 0
                        }} />
                        <span style={{
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

                    {/* Progress indicator */}
                    <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.75rem',
                        padding: '0.35rem 0.85rem',
                        background: 'var(--background)',
                        border: '1px solid var(--border)',
                        borderRadius: 'var(--radius-full)',
                        flexShrink: 0
                    }}>
                        <div style={{
                            width: '90px',
                            height: '4px',
                            background: 'var(--border)',
                            borderRadius: 'var(--radius-full)',
                            overflow: 'hidden'
                        }}>
                            <div style={{
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

                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexShrink: 0 }}>
                        <label style={{
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
                            <div style={{
                                display: 'flex',
                                background: 'var(--background)',
                                border: '1px solid var(--border)',
                                borderRadius: 'var(--radius-full)',
                                padding: '3px'
                            }}>
                                <button
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
                            <label className="btn btn-secondary" style={{
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
                            className="btn btn-secondary"
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

                        <button className="btn btn-primary" style={{ padding: '0.5rem 1rem', fontSize: '0.85rem' }} onClick={handleSubmit}>
                            제출하기
                        </button>
                        <ThemeToggle size="small" />
                    </div>
                </div>
            </header>

            {/* Body */}
            <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
                {/* PDF Area (Left, larger) */}
                <div style={{
                    flex: 1,
                    borderRight: '1px solid var(--border)',
                    background: '#2a2d31',
                    position: 'relative',
                    display: 'flex',
                    flexDirection: 'column',
                    minWidth: 0
                }}>
                    {isTeacherMode && activeTab === 'answer' && !answerFile && (
                        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10, pointerEvents: 'none' }}>
                            <label className="btn btn-primary" style={{ pointerEvents: 'auto', cursor: 'pointer', boxShadow: '0 4px 10px rgba(0,0,0,0.3)' }}>
                                해설/정답 PDF 업로드
                                <input type="file" accept=".pdf" onChange={(e) => e.target.files && setAnswerFile(e.target.files[0])} style={{ display: 'none' }} />
                            </label>
                        </div>
                    )}

                    {isTeacherMode && activeTab === 'problem' && !pdfFile && (
                        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10, pointerEvents: 'none' }}>
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
                                    optionsCount: 5,
                                }))
                            : []}
                    />
                </div>

                {/* OMR Sheet (Right, responsive card view) */}
                <div style={{
                    width: isOMRCollapsed ? '0' : '440px',
                    maxWidth: isOMRCollapsed ? '0' : '40vw',
                    flexShrink: 0,
                    transition: 'width 0.3s, max-width 0.3s',
                    overflow: 'hidden',
                    background: 'var(--background)',
                    display: 'flex',
                    flexDirection: 'column'
                }}>
                    <div style={{ flex: 1, overflowY: 'auto' }} className="scroll-custom">
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
        </div>
    );
}
