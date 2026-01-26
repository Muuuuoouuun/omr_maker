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

    const [isAuthorized, setIsAuthorized] = useState(false);
    const [selectedGroupId, setSelectedGroupId] = useState("");
    const [availableGroups, setAvailableGroups] = useState<any[]>([]);

    // Navigation State
    const [currentQuestionId, setCurrentQuestionId] = useState<number | null>(null);
    const [pdfCurrentPage, setPdfCurrentPage] = useState<number | undefined>(undefined);

    // Teacher Mode State
    const [isTeacherMode, setIsTeacherMode] = useState(false);
    const [activeTab, setActiveTab] = useState<'problem' | 'answer'>('problem');
    const [answerFile, setAnswerFile] = useState<File | null>(null);

    useEffect(() => {
        const loadExam = async () => {
            if (id) {
                const data = localStorage.getItem(`omr_exam_${id}`);
                if (data) {
                    try {
                        const parsed = JSON.parse(data);
                        setExamData(parsed);

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
                        if (parsed.accessConfig?.type === 'group') {
                            setIsAuthorized(false);
                            // Load groups for selection (Simulation of "User's Groups")
                            const groups = localStorage.getItem('omr_groups');
                            if (groups) {
                                setAvailableGroups(JSON.parse(groups));
                            }
                        } else {
                            setIsAuthorized(true);
                        }
                    } catch (e) {
                        alert("시험 데이터 로드 실패");
                    }
                } else {
                    alert("유효하지 않은 시험 ID이거나 데이터가 없습니다.");
                }
            }
        };

        loadExam();
    }, [id]);

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

    const handleSubmit = () => {
        if (!confirm("정말 제출하시겠습니까? (현재는 로컬에만 저장됩니다)")) return;

        if (!examData) return;

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
            studentName: "Student", // In real app, from auth
            startedAt: new Date().toISOString(), // Mock start time
            finishedAt: new Date().toISOString(),
            score: correctCount,
            totalScore: totalCount,
            answers: studentAnswers,
            drawings: drawings, // Save drawings
            status: 'completed'
        };

        // Save to Local Storage (List of attempts)
        const history = JSON.parse(localStorage.getItem('omr_attempts') || '[]');
        history.push(attemptData);
        localStorage.setItem('omr_attempts', JSON.stringify(history));

        alert(`제출 완료! 점수: ${correctCount}/${totalCount}`);
        window.location.href = `/student/review/${attemptId}`;
    };

    const checkGroupAccess = () => {
        if (!examData?.accessConfig?.groupIds) return;

        if (examData.accessConfig.groupIds.includes(selectedGroupId)) {
            setIsAuthorized(true);
        } else {
            alert("이 시험에 접근 권한이 없는 그룹입니다.");
        }
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
        <div className="layout-main" style={{ background: '#f1f5f9', height: '100vh', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <header className="header" style={{ flexShrink: 0, justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                    <div className="logo" style={{ fontSize: '1.2rem' }}>Answer Mode</div>
                    <span style={{ fontSize: '0.9rem', color: '#666' }}>ID: {id}</span>
                </div>
                <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.85rem', cursor: 'pointer', background: 'rgba(0,0,0,0.05)', padding: '0.3rem 0.6rem', borderRadius: '4px' }}>
                        <input type="checkbox" checked={isTeacherMode} onChange={(e) => toggleTeacherMode(e.target.checked)} />
                        선생님 모드
                    </label>

                    {/* Teacher Mode Specific Controls */}
                    {isTeacherMode ? (
                        <div style={{ display: 'flex', background: '#e2e8f0', borderRadius: '4px', padding: '2px' }}>
                            <button
                                onClick={() => setActiveTab('problem')}
                                style={{ padding: '0.3rem 0.8rem', fontSize: '0.85rem', borderRadius: '4px', border: 'none', background: activeTab === 'problem' ? 'white' : 'transparent', fontWeight: activeTab === 'problem' ? 'bold' : 'normal', cursor: 'pointer' }}
                            >
                                문제지
                            </button>
                            <button
                                onClick={() => setActiveTab('answer')}
                                style={{ padding: '0.3rem 0.8rem', fontSize: '0.85rem', borderRadius: '4px', border: 'none', background: activeTab === 'answer' ? 'white' : 'transparent', fontWeight: activeTab === 'answer' ? 'bold' : 'normal', cursor: 'pointer' }}
                            >
                                정답/해설
                            </button>
                        </div>
                    ) : (
                        <label className="btn btn-secondary" style={{ cursor: 'pointer', fontSize: '0.85rem' }}>
                            📄 문제지(PDF) 열기
                            <input id="pdf-upload-input" type="file" accept=".pdf" onChange={(e) => e.target.files && setPdfFile(e.target.files[0])} style={{ display: 'none' }} />
                        </label>
                    )}

                    <button className="btn btn-primary" onClick={handleSubmit}>
                        ✅ 제출하기
                    </button>
                </div>
            </header>

            <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
                {/* PDF ViewerArea (Left) */}
                <div style={{ flex: 1, borderRight: '1px solid #ddd', background: '#222', position: 'relative', display: 'flex', flexDirection: 'column' }}>
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
                            ? examData.questions
                                .filter((q: Question) => q.pdfLocation)
                                .map((q: Question) => ({
                                    page: q.pdfLocation!.page,
                                    x: q.pdfLocation!.x,
                                    y: q.pdfLocation!.y,
                                    label: q.number,
                                    color: currentQuestionId === q.id ? '#6366f1' : '#ef4444',
                                    onClick: () => handleQuestionClick(q.id)
                                }))
                            : []}
                    />
                </div>

                {/* OMR Sheet (Right) */}
                <div style={{ flex: 1, display: 'flex', justifyContent: 'center', overflowY: 'auto', padding: '2rem', background: '#e2e8f0' }}>
                    <div style={{ transform: 'scale(0.9)', transformOrigin: 'top center', height: 'fit-content' }}>
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
        </div>
    );
}
