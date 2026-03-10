"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import OMRPreview from "@/components/OMRPreview";
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

    const [user, setUser] = useState<{ name: string; isGuest?: boolean; guestId?: string; teacherName?: string; age?: string } | null>(null);

    // Guest Registration State
    const [showGuestModal, setShowGuestModal] = useState(false);
    const [guestName, setGuestName] = useState("");
    const [guestTeacher, setGuestTeacher] = useState("");
    const [guestAge, setGuestAge] = useState("");

    // Navigation State
    const [currentQuestionId, setCurrentQuestionId] = useState<number | null>(null);
    const [pdfCurrentPage, setPdfCurrentPage] = useState<number | undefined>(undefined);

    // Teacher Mode State
    const [isTeacherMode, setIsTeacherMode] = useState(false);
    const [activeTab, setActiveTab] = useState<'problem' | 'answer'>('problem');
    const [answerFile, setAnswerFile] = useState<File | null>(null);

    // Timer State
    const [timeLeft, setTimeLeft] = useState<number | null>(null);
    const [isTimeUp, setIsTimeUp] = useState(false);

    useEffect(() => {
        // Load User Session
        const sessionStr = sessionStorage.getItem("omr_student_session");
        if (sessionStr) {
            setUser(JSON.parse(sessionStr));
        }

        const loadExam = async () => {
            if (id) {
                const data = localStorage.getItem(`omr_exam_${id}`);
                if (data) {
                    try {
                        const parsed = JSON.parse(data);
                        setExamData(parsed);

                        if (parsed.accessConfig?.timeLimit) {
                            setTimeLeft(parsed.accessConfig.timeLimit * 60);
                        }

                        // Convert base64 pdfData (Problem PDF) back to File
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

                        // Convert base64 answerKeyPdf back to File
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

                        // Check Access Control
                        // Load groups for selection (Simulation of "User's Groups")
                        if (parsed.accessConfig?.type === 'group') {
                            const groups = localStorage.getItem('omr_groups');
                            if (groups) {
                                // Logic removed
                            }
                        }
                    } catch (err) {
                        alert("시험 데이터 로드 실패");
                        console.error(err);
                    }
                } else {
                    alert("유효하지 않은 시험 ID이거나 데이터가 없습니다.");
                }
            }
        };

        loadExam();
    }, [id]);

    // Timer Effect
    useEffect(() => {
        if (timeLeft === null || isTeacherMode || isTimeUp) return;

        if (timeLeft <= 0) {
            setIsTimeUp(true);
            alert("⏰ 제한 시간이 종료되었습니다! (자동 제출 기능은 게스트 이름 확인 후 구현됩니다)");
            // In a fully authenticated environment, we would call handleSubmit() here automatically.
            return;
        }

        const timer = setInterval(() => {
            setTimeLeft(prev => prev !== null ? prev - 1 : null);
        }, 1000);

        return () => clearInterval(timer);
    }, [timeLeft, isTeacherMode, isTimeUp]);

    const formatTime = (seconds: number) => {
        const m = Math.floor(seconds / 60);
        const s = seconds % 60;
        return `${m}:${s.toString().padStart(2, '0')}`;
    };

    const handleAnswerClick = (qId: number, optionIndex: number) => {
        setStudentAnswers(prev => ({
            ...prev,
            [qId]: optionIndex
        }));
        // Auto-select question when answering
        handleQuestionClick(qId);
    };

    const handleQuestionClick = (qId: number) => {
        setCurrentQuestionId(qId);
        if (examData) {
            const q = examData.questions.find(q => q.id === qId);
            if (q?.pdfLocation?.page) {
                setPdfCurrentPage(q.pdfLocation.page);
            }
        }
    };

    const handleDrawingsChange = (page: number, newPaths: string[]) => {
        setDrawings(prev => ({
            ...prev,
            [page]: newPaths
        }));
    };



    // ... (intermediate code) ...

    const handleSubmit = () => {
        if (!examData) return;

        // Ensure User
        const submitter = user;
        if (!submitter) {
            // Guest Flow for Public Exams
            if (examData.accessConfig?.type === 'public') {
                setShowGuestModal(true);
                return;
            } else {
                alert("로그인이 필요한 시험입니다.");
                window.location.href = "/";
                return;
            }
        }

        executeSubmit(submitter);
    };

    const handleGuestSubmit = () => {
        if (!guestName.trim()) { alert("이름을 입력해주세요."); return; }
        if (!guestTeacher.trim()) { alert("담당 선생님 이름을 입력해주세요."); return; }

        const guestId = Math.random().toString(36).substring(2, 15);
        const submitter = { name: guestName, teacherName: guestTeacher, age: guestAge, isGuest: true, guestId };

        // Save session for continuity
        sessionStorage.setItem("omr_student_session", JSON.stringify({ ...submitter, groupName: 'Guest' }));
        localStorage.setItem("omr_guest_id", guestId);
        setUser(submitter);
        setShowGuestModal(false);

        executeSubmit(submitter);
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const executeSubmit = (submitter: any) => {
        if (!examData) return;
        if (!confirm("정말 제출하시겠습니까? (현재는 로컬에만 저장됩니다)")) return;

        // Calculate Score
        let correctCount = 0;
        let totalCount = 0;

        examData.questions.forEach(q => {
            if (q.answer) {
                totalCount++;
                if (studentAnswers[q.id] === q.answer) {
                    correctCount++;
                }
            }
        });

        const attemptId = Date.now().toString();
        const attemptData = {
            id: attemptId,
            examId: id,
            examTitle: examData.title,
            studentName: submitter.name,
            guestId: submitter.guestId, // Track Guest ID
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            score: correctCount,
            totalScore: totalCount,
            answers: studentAnswers,
            drawings: drawings,
            status: 'completed'
        };

        // Save to Local Storage (List of attempts)
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

    return (
        <div className="app-container" style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: 'var(--background)' }}>
            <header className="header fade-in-down" style={{ padding: '1rem 1.5rem', display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', height: 'auto', minHeight: '4rem', background: 'var(--surface)', borderBottom: '1px solid var(--border)', gap: '1rem' }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '1rem' }}>
                    <h1 style={{ fontSize: '1.25rem', fontWeight: 800, color: 'var(--primary)' }}>Answer Mode</h1>
                    <span style={{ fontSize: '0.85rem', color: 'var(--muted)', background: 'var(--background)', padding: '0.3rem 0.6rem', borderRadius: '4px' }}>
                        ID: {id}
                    </span>
                    {timeLeft !== null && !isTeacherMode && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: timeLeft < 60 ? '#fee2e2' : '#e0e7ff', color: timeLeft < 60 ? '#dc2626' : '#4338ca', padding: '0.3rem 0.8rem', borderRadius: '20px', fontWeight: 'bold', fontSize: '0.9rem', border: `1px solid ${timeLeft < 60 ? '#fca5a5' : '#a5b4fc'}` }}>
                            ⏱️ {formatTime(timeLeft)}
                        </div>
                    )}
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem', color: 'var(--muted)', cursor: 'pointer', background: 'var(--background)', padding: '0.3rem 0.6rem', borderRadius: '4px', whiteSpace: 'nowrap' }}>
                        <input type="checkbox" checked={isTeacherMode} onChange={(e) => toggleTeacherMode(e.target.checked)} />
                        선생님 모드
                    </label>

                    {/* Teacher Mode Specific Controls */}
                    {isTeacherMode ? (
                        <div style={{ display: 'flex', background: 'var(--background)', border: '1px solid var(--border)', borderRadius: '4px', padding: '2px' }}>
                            <button
                                onClick={() => setActiveTab('problem')}
                                style={{ padding: '0.3rem 0.8rem', fontSize: '0.85rem', borderRadius: '4px', border: 'none', background: activeTab === 'problem' ? 'var(--surface)' : 'transparent', color: activeTab === 'problem' ? 'var(--primary)' : 'var(--muted)', fontWeight: activeTab === 'problem' ? 'bold' : 'normal', cursor: 'pointer' }}
                            >
                                문제지
                            </button>
                            <button
                                onClick={() => setActiveTab('answer')}
                                style={{ padding: '0.3rem 0.8rem', fontSize: '0.85rem', borderRadius: '4px', border: 'none', background: activeTab === 'answer' ? 'var(--surface)' : 'transparent', color: activeTab === 'answer' ? 'var(--primary)' : 'var(--muted)', fontWeight: activeTab === 'answer' ? 'bold' : 'normal', cursor: 'pointer' }}
                            >
                                정답/해설
                            </button>
                        </div>
                    ) : null}
                </div>

                <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
                    <button className="btn btn-primary" onClick={handleSubmit} style={{ whiteSpace: 'nowrap' }}>
                        ✅ 제출하기
                    </button>
                </div>
            </header>

            <div className="split-layout" style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
                {/* PDF ViewerArea (Left) */}
                <div className="split-pane-pdf" style={{ flex: 1, borderRight: '1px solid #ddd', background: isTeacherMode ? '#222' : '#f8fafc', position: 'relative', display: 'flex', flexDirection: 'column' }}>
                    {/* Tab Context specific toolbar */}
                    {isTeacherMode && activeTab === 'answer' && !answerFile && (
                        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10, pointerEvents: 'none' }}>
                            <label className="btn btn-primary" style={{ pointerEvents: 'auto', cursor: 'pointer', boxShadow: '0 4px 10px rgba(0,0,0,0.3)' }}>
                                📁 해설/정답 PDF 업로드
                                <input type="file" accept=".pdf" onChange={(e) => e.target.files && setAnswerFile(e.target.files[0])} style={{ display: 'none' }} />
                            </label>
                        </div>
                    )}

                    {isTeacherMode && activeTab === 'problem' && !pdfFile && (
                        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10, pointerEvents: 'none' }}>
                            <label className="btn btn-secondary" style={{ pointerEvents: 'auto', cursor: 'pointer', boxShadow: '0 4px 10px rgba(0,0,0,0.3)' }}>
                                📄 문제지 PDF 업로드
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
                            ? examData.questions.flatMap((q: Question) => {
                                const qMarkers: { page: number; x: number; y: number; w?: number; h?: number; label: string | number; color?: string; type?: 'question' | 'choice'; onClick?: () => void }[] = [];
                                if (q.pdfLocation) {
                                    qMarkers.push({
                                        page: q.pdfLocation.page,
                                        x: q.pdfLocation.x,
                                        y: q.pdfLocation.y,
                                        w: q.pdfLocation.w,
                                        h: q.pdfLocation.h,
                                        label: q.number,
                                        type: 'question',
                                        color: currentQuestionId === q.id ? '#6366f1' : '#ef4444',
                                        onClick: () => handleQuestionClick(q.id)
                                    });
                                }
                                if (q.pdfChoices) {
                                    Object.entries(q.pdfChoices).forEach(([choiceStr, loc]) => {
                                        const choiceNum = parseInt(choiceStr, 10);
                                        const isSelected = studentAnswers[q.id] === choiceNum;
                                        qMarkers.push({
                                            page: loc.page,
                                            x: loc.x,
                                            y: loc.y,
                                            w: loc.w,
                                            h: loc.h,
                                            label: choiceNum,
                                            type: 'choice',
                                            // Provide color only if selected so viewer highlights it
                                            color: isSelected ? '#3b82f6' : undefined,
                                            onClick: () => handleAnswerClick(q.id, choiceNum)
                                        });
                                    });
                                }
                                return qMarkers;
                            })
                            : []}
                        viewerMode={isTeacherMode ? 'teacher' : 'student'}
                    />
                </div>

                {/* OMR Sheet (Right) */}
                <div className="split-pane-main" style={{ flex: 1, display: 'flex', justifyContent: 'center', overflowY: 'auto', overflowX: 'hidden', padding: '2rem', background: '#e2e8f0' }}>
                    <div style={{ width: '100%', maxWidth: '900px', height: 'fit-content' }}>
                        <OMRPreview
                            title={examData.title}
                            questions={examData.questions}
                            mode="solve"
                            userAnswers={studentAnswers}
                            selectedQuestionId={currentQuestionId}
                            onAnswerClick={handleAnswerClick}
                            onQuestionClick={handleQuestionClick}
                        />
                    </div>
                </div>
            </div>

            {/* Guest Registration Modal */}
            {showGuestModal && (
                <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
                    <div style={{ width: '90%', maxWidth: '400px', background: 'var(--surface)', padding: '2rem', borderRadius: 'var(--radius-xl)', boxShadow: 'var(--shadow-xl)' }}>
                        <h2 style={{ fontSize: '1.25rem', fontWeight: 700, marginBottom: '1.5rem', color: 'var(--primary)' }}>비회원(게스트) 정보 입력</h2>

                        <div style={{ marginBottom: '1rem' }}>
                            <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.5rem' }}>이름 (필수)</label>
                            <input type="text" className="input-field" value={guestName} onChange={(e) => setGuestName(e.target.value)} placeholder="학생 이름" />
                        </div>
                        <div style={{ marginBottom: '1rem' }}>
                            <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.5rem' }}>담당 선생님 (필수)</label>
                            <input type="text" className="input-field" value={guestTeacher} onChange={(e) => setGuestTeacher(e.target.value)} placeholder="선생님 이름" />
                        </div>
                        <div style={{ marginBottom: '1.5rem' }}>
                            <label style={{ display: 'block', fontSize: '0.85rem', fontWeight: 600, marginBottom: '0.5rem' }}>나이 (선택사항)</label>
                            <input type="number" className="input-field" value={guestAge} onChange={(e) => setGuestAge(e.target.value)} placeholder="예: 15" />
                        </div>

                        <div style={{ display: 'flex', gap: '0.8rem', justifyContent: 'flex-end', marginTop: '1rem' }}>
                            <button className="btn btn-secondary" onClick={() => setShowGuestModal(false)}>취소</button>
                            <button className="btn btn-primary" onClick={handleGuestSubmit}>제출하기</button>
                        </div>
                    </div>
                </div>
            )}
        </div >
    );
}
