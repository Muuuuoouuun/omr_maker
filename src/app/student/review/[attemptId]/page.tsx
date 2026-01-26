"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Attempt, Question, Exam } from "@/types/omr";

export default function ReviewPage() {
    const params = useParams();
    const router = useRouter();
    const id = params?.attemptId as string;

    const [attempt, setAttempt] = useState<Attempt | null>(null);
    const [exam, setExam] = useState<Exam | null>(null);
    const [filterWrong, setFilterWrong] = useState(false);

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
                    // Note: In real app, we fetch by examId. Here we rely on the exam saving key convention.
                    const examDataStr = localStorage.getItem(`omr_exam_${found.examId}`);
                    if (examDataStr) {
                        setExam(JSON.parse(examDataStr));
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

    return (
        <div className="layout-main" style={{ minHeight: '100vh', background: '#f8fafc' }}>
            <header className="header" style={{ background: 'white', borderBottom: '1px solid #e2e8f0' }}>
                <div className="container header-content">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                        <button onClick={() => router.back()} style={{ border: 'none', background: 'none', fontSize: '1.2rem', cursor: 'pointer' }}>←</button>
                        <span style={{ fontWeight: 600 }}>결과 리포트</span>
                    </div>
                    <Link href="/student/history" className="btn btn-secondary" style={{ fontSize: '0.9rem', padding: '0.4rem 1rem' }}>
                        목록으로
                    </Link>
                </div>
            </header>

            <main className="container" style={{ padding: '2rem 1rem', maxWidth: '800px', margin: '0 auto' }}>
                {/* Score Card */}
                <div style={{ background: 'white', padding: '2rem', borderRadius: '16px', boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1)', textAlign: 'center', marginBottom: '2rem' }}>
                    <h1 style={{ fontSize: '1.5rem', marginBottom: '0.5rem', fontWeight: 700 }}>{attempt.examTitle}</h1>
                    <div style={{ fontSize: '3.5rem', fontWeight: 800, color: 'var(--primary)', lineHeight: 1 }}>
                        {attempt.score}
                        <span style={{ fontSize: '1.5rem', color: '#94a3b8', fontWeight: 500 }}> / {attempt.totalScore}</span>
                    </div>
                    <p style={{ color: '#64748b', marginTop: '0.5rem' }}>
                        {new Date(attempt.finishedAt).toLocaleString()} 응시 완료
                    </p>
                </div>

                {/* Filters */}
                <div style={{ display: 'flex', gap: '1rem', marginBottom: '1.5rem', borderBottom: '1px solid #e2e8f0', paddingBottom: '1rem' }}>
                    <button
                        onClick={() => setFilterWrong(false)}
                        className={`btn ${!filterWrong ? 'btn-primary' : 'btn-secondary'}`}
                        style={{ borderRadius: '999px' }}
                    >
                        전체 문항 ({exam.questions.length})
                    </button>
                    <button
                        onClick={() => setFilterWrong(true)}
                        className={`btn ${filterWrong ? 'btn-primary' : 'btn-secondary'}`}
                        style={{ borderRadius: '999px', background: filterWrong ? '#ef4444' : undefined, color: filterWrong ? 'white' : undefined }}
                    >
                        🚨 오답만 보기 ({attempt.totalScore - attempt.score})
                    </button>
                </div>

                {/* Question List */}
                <div style={{ display: 'grid', gap: '1rem' }}>
                    {filteredQuestions.map((q) => {
                        const userAns = attempt.answers[q.id];
                        const isCorrect = userAns === q.answer;
                        const isSkipped = userAns === undefined;

                        return (
                            <div key={q.id} style={{
                                background: 'white', padding: '1.5rem', borderRadius: '12px',
                                border: '1px solid', borderColor: isCorrect ? '#e2e8f0' : '#fecaca',
                                position: 'relative'
                            }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '1rem' }}>
                                    <span style={{ fontWeight: 700, fontSize: '1.1rem', color: isCorrect ? '#0f172a' : '#ef4444' }}>
                                        문항 {q.number}
                                    </span>
                                    <span style={{
                                        fontWeight: 600, fontSize: '0.9rem',
                                        color: isCorrect ? '#16a34a' : '#dc2626'
                                    }}>
                                        {isCorrect ? "✅ 정답" : "❌ 오답"}
                                    </span>
                                </div>

                                <div style={{ display: 'flex', gap: '2rem', fontSize: '0.95rem' }}>
                                    <div>
                                        <span style={{ color: '#64748b', marginRight: '0.5rem' }}>내가 쓴 답:</span>
                                        <span style={{ fontWeight: 700, color: isCorrect ? '#0f172a' : '#ef4444' }}>
                                            {isSkipped ? '(미응답)' : userAns}
                                        </span>
                                    </div>
                                    {!isCorrect && q.answer && (
                                        <div>
                                            <span style={{ color: '#64748b', marginRight: '0.5rem' }}>정답:</span>
                                            <span style={{ fontWeight: 700, color: '#16a34a' }}>{q.answer}</span>
                                        </div>
                                    )}
                                </div>

                                {q.label && (
                                    <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem' }}>
                                        <span style={{ fontSize: '0.75rem', padding: '2px 8px', borderRadius: '4px', background: '#f1f5f9', color: '#64748b' }}>
                                            #{q.label}
                                        </span>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>

                {filterWrong && filteredQuestions.length === 0 && (
                    <div style={{ textAlign: 'center', padding: '3rem', color: '#64748b' }}>
                        🎉 틀린 문제가 없습니다!
                    </div>
                )}
            </main>
        </div>
    );
}
