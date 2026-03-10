"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Attempt, Exam, Question } from "@/types/omr";
import dynamic from "next/dynamic";

const PDFViewer = dynamic(() => import("@/components/PDFViewer"), { ssr: false });

export default function ReviewPage() {
    const params = useParams();
    const router = useRouter();
    const id = params?.attemptId as string;

    const [attempt, setAttempt] = useState<Attempt | null>(null);
    const [exam, setExam] = useState<Exam | null>(null);
    const [pdfFile, setPdfFile] = useState<File | null>(null);
    const [filterWrong, setFilterWrong] = useState(false);
    const [pdfCurrentPage, setPdfCurrentPage] = useState<number | undefined>(undefined);

    useEffect(() => {
        if (id) {
            // Load Attempt
            const attemptsData = localStorage.getItem('omr_attempts');
            if (attemptsData) {
                const attempts: Attempt[] = JSON.parse(attemptsData);
                const found = attempts.find(a => a.id === id);
                if (found) {
                    setAttempt(found);
                    // Load Exam Data associated with this attempt
                    const examDataStr = localStorage.getItem(`omr_exam_${found.examId}`);
                    if (examDataStr) {
                        const parsedExam = JSON.parse(examDataStr);
                        setExam(parsedExam);

                        // Convert base64 pdfData to File
                        if (parsedExam.pdfData) {
                            fetch(parsedExam.pdfData)
                                .then(res => res.blob())
                                .then(blob => {
                                    const file = new File([blob], "problem.pdf", { type: "application/pdf" });
                                    setPdfFile(file);
                                })
                                .catch(err => console.error("Failed to load PDF", err));
                        }
                    }
                }
            }
        }
    }, [id]);

    if (!attempt || !exam) {
        return <div style={{ padding: '2rem', textAlign: 'center' }}>Loading...</div>;
    }

    const filteredQuestions = filterWrong
        ? exam.questions.filter(q => q.answer && attempt.answers[q.id] !== q.answer)
        : exam.questions;

    const markers = exam.questions.flatMap((q: Question) => {
        const qMarkers: { page: number; x: number; y: number; w?: number; h?: number; label: string | number; color?: string; type?: 'question' | 'choice'; onClick?: () => void }[] = [];
        const isCorrect = attempt.answers[q.id] === q.answer;
        const qColor = isCorrect ? '#16a34a' : '#ef4444';

        if (q.pdfLocation) {
            qMarkers.push({
                ...q.pdfLocation,
                label: q.number,
                type: 'question',
                color: qColor
            });
        }

        if (q.pdfChoices) {
            Object.entries(q.pdfChoices).forEach(([choiceStr, loc]) => {
                const choiceNum = parseInt(choiceStr, 10);
                let color = undefined;

                if (choiceNum === q.answer) {
                    color = '#16a34a'; // Green for correct answer
                } else if (choiceNum === attempt.answers[q.id]) {
                    color = '#ef4444'; // Red for wrong selection
                }

                if (color) {
                    qMarkers.push({
                        ...loc,
                        label: choiceNum,
                        type: 'choice',
                        color: color
                    });
                }
            });
        }
        return qMarkers;
    });

    const jumpToQuestion = (page?: number) => {
        if (page) setPdfCurrentPage(page);
    };

    return (
        <div className="layout-main" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
            <header className="header" style={{ padding: '1rem 1.5rem', display: 'flex', gap: '1rem', background: 'white', borderBottom: '1px solid #e2e8f0', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                    <button onClick={() => router.back()} style={{ border: 'none', background: 'none', fontSize: '1.2rem', cursor: 'pointer', color: '#64748b' }}>←</button>
                    <h1 style={{ fontSize: '1.25rem', fontWeight: 800, color: 'var(--primary)' }}>결과 리포트 - {attempt.examTitle}</h1>
                </div>
                <Link href="/student/dashboard" className="btn btn-secondary" style={{ fontSize: '0.9rem', padding: '0.4rem 1rem' }}>
                    대시보드로
                </Link>
            </header>

            <div className="split-layout" style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
                {/* PDF ViewerArea (Left) */}
                <div className="split-pane-pdf flex-1" style={{ borderRight: '1px solid #ddd', background: '#f8fafc', position: 'relative', display: 'flex', flexDirection: 'column' }}>
                    <PDFViewer
                        file={pdfFile}
                        onLoadSuccess={() => { }}
                        enableDrawing={false}
                        drawings={attempt.drawings}
                        forcePage={pdfCurrentPage}
                        markers={markers}
                        viewerMode="student"
                    />
                </div>

                {/* Score & Report (Right) */}
                <div className="split-pane-main w-[400px] min-w-[350px] max-w-[500px]" style={{ overflowY: 'auto', padding: '2rem', background: '#f8fafc' }}>

                    {/* Score Card */}
                    <div className="card-hover" style={{ background: 'white', padding: '2rem', borderRadius: '16px', boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1)', textAlign: 'center', marginBottom: '2rem' }}>
                        <h2 style={{ fontSize: '1.1rem', marginBottom: '0.5rem', fontWeight: 600, color: '#64748b' }}>내 점수</h2>
                        <div style={{ fontSize: '4rem', fontWeight: 800, color: 'var(--primary)', lineHeight: 1 }}>
                            {attempt.score}
                            <span style={{ fontSize: '1.5rem', color: '#cbd5e1', fontWeight: 500 }}> / {attempt.totalScore}</span>
                        </div>
                        <p style={{ color: '#94a3b8', marginTop: '1rem', fontSize: '0.85rem' }}>
                            {new Date(attempt.finishedAt).toLocaleString()} 제출 완료
                        </p>
                    </div>

                    {/* Filters */}
                    <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.5rem' }}>
                        <button
                            onClick={() => setFilterWrong(false)}
                            className={`btn ${!filterWrong ? 'btn-primary' : 'btn-secondary'}`}
                            style={{ flex: 1, borderRadius: '8px', padding: '0.5rem' }}
                        >
                            전체 ({exam.questions.length})
                        </button>
                        <button
                            onClick={() => setFilterWrong(true)}
                            className={`btn ${filterWrong ? 'btn-primary' : 'btn-secondary'}`}
                            style={{ flex: 1, borderRadius: '8px', padding: '0.5rem', background: filterWrong ? '#ef4444' : undefined, color: filterWrong ? 'white' : undefined }}
                        >
                            오답만 ({attempt.totalScore - attempt.score})
                        </button>
                    </div>

                    {/* Question List */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                        {filteredQuestions.map((q) => {
                            const userAns = attempt.answers[q.id];
                            const isCorrect = userAns === q.answer;
                            const isSkipped = userAns === undefined;

                            return (
                                <div
                                    key={q.id}
                                    onClick={() => jumpToQuestion(q.pdfLocation?.page)}
                                    className="card-hover"
                                    style={{
                                        background: 'white', padding: '1rem 1.25rem', borderRadius: '12px',
                                        borderLeft: `4px solid ${isCorrect ? '#10b981' : '#ef4444'}`,
                                        cursor: 'pointer',
                                        boxShadow: '0 2px 4px rgba(0,0,0,0.05)'
                                    }}
                                >
                                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                                        <span style={{ fontWeight: 700, fontSize: '1.1rem', color: '#1e293b' }}>
                                            문항 {q.number}
                                        </span>
                                        <span style={{
                                            fontWeight: 700, fontSize: '0.85rem',
                                            padding: '2px 8px', borderRadius: '12px',
                                            background: isCorrect ? '#d1fae5' : '#fee2e2',
                                            color: isCorrect ? '#047857' : '#b91c1c'
                                        }}>
                                            {isCorrect ? "정답" : "오답"}
                                        </span>
                                    </div>

                                    <div style={{ display: 'flex', gap: '1rem', fontSize: '0.9rem' }}>
                                        <div>
                                            <span style={{ color: '#64748b', marginRight: '0.5rem' }}>내 마킹:</span>
                                            <span style={{ fontWeight: 700, color: isCorrect ? '#0f172a' : '#ef4444' }}>
                                                {isSkipped ? '(미응답)' : userAns}
                                            </span>
                                        </div>
                                        {!isCorrect && q.answer && (
                                            <div>
                                                <span style={{ color: '#64748b', marginRight: '0.5rem' }}>정답:</span>
                                                <span style={{ fontWeight: 700, color: '#10b981' }}>{q.answer}</span>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            );
                        })}

                        {filterWrong && filteredQuestions.length === 0 && (
                            <div style={{ textAlign: 'center', padding: '3rem', color: '#94a3b8' }}>
                                🎉 틀린 문제가 없습니다!
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}
