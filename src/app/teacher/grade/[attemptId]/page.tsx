"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { Exam, Attempt } from "@/types/omr";
import { useToast } from "@/components/ui/Toast";

export default function GradeAttemptPage() {
    const params = useParams();
    const router = useRouter();
    const toast = useToast();
    const attemptId = params?.attemptId as string;

    const [attempt, setAttempt] = useState<Attempt | null>(null);
    const [exam, setExam] = useState<Exam | null>(null);

    // Editing State
    const [scores, setScores] = useState<Record<number, number>>({});

    useEffect(() => {
        if (!attemptId) return;

        // Load Attempt
        const attemptsStr = localStorage.getItem("omr_attempts");
        if (attemptsStr) {
            const allAttempts: Attempt[] = JSON.parse(attemptsStr);
            const foundAttempt = allAttempts.find(a => a.id === attemptId);
            if (foundAttempt) {
                setAttempt(foundAttempt);
                setScores(foundAttempt.subjectiveScores || {});

                // Load Exam
                const examData = localStorage.getItem(`omr_exam_${foundAttempt.examId}`);
                if (examData) {
                    setExam(JSON.parse(examData));
                }
            }
        }
    }, [attemptId]);

    const handleScoreChange = (qId: number, score: number) => {
        setScores(prev => ({
            ...prev,
            [qId]: score
        }));
    };

    const handleSave = () => {
        if (!attempt || !exam) return;

        const allAttemptsStr = localStorage.getItem("omr_attempts");
        if (!allAttemptsStr) return;

        let allAttempts: Attempt[] = JSON.parse(allAttemptsStr);

        let additionalScore = 0;
        Object.values(scores).forEach(s => additionalScore += s);

        // Recalculate original score (objective)
        let objectiveScore = 0;
        exam.questions.forEach(q => {
            if (q.type !== 'subjective' && q.answer && attempt.answers[q.id] === q.answer) {
                objectiveScore++;
            }
        });

        const newTotalScore = objectiveScore + additionalScore;

        allAttempts = allAttempts.map(a => {
            if (a.id === attemptId) {
                return {
                    ...a,
                    score: newTotalScore,
                    subjectiveScores: scores,
                    status: 'completed'
                };
            }
            return a;
        });

        localStorage.setItem("omr_attempts", JSON.stringify(allAttempts));
        toast.success("채점이 저장되었습니다.");
        router.back();
    };

    if (!attempt || !exam) return <div style={{ padding: '2rem' }}>Loading...</div>;

    const subjectiveQuestions = exam.questions.filter(q => q.type === 'subjective' || q.askReason);

    return (
        <div className="layout-main" style={{ background: '#f8fafc', minHeight: '100vh' }}>
            <header className="header" style={{ borderBottom: '1px solid var(--border)' }}>
                <div className="container header-content">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                        <button onClick={() => router.back()} style={{ fontSize: '1.2rem' }}>←</button>
                        <span style={{ fontWeight: 700 }}>주관식 (및 사유) 채점: {attempt.studentName}</span>
                    </div>
                    <button onClick={handleSave} className="btn btn-primary" style={{ padding: '0.5rem 1rem' }}>
                        채점 완료 및 저장
                    </button>
                </div>
            </header>

            <main className="container animate-fade-in" style={{ padding: '2rem 1rem', maxWidth: '800px' }}>
                <div className="bento-card" style={{ padding: '2rem' }}>
                    <h2 style={{ fontSize: '1.2rem', fontWeight: 700, marginBottom: '1.5rem' }}>주관식 및 이중 문제 사유 목록</h2>

                    {subjectiveQuestions.length === 0 ? (
                        <p style={{ color: 'var(--muted)' }}>이 시험에는 채점이 필요한 주관식/이중 문항이 없습니다.</p>
                    ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
                            {subjectiveQuestions.map(q => {
                                const isDual = q.type !== 'subjective' && q.askReason;
                                const studentAnswer = attempt.stringAnswers?.[q.id] || '(미응답)';
                                const correctAnswer = isDual ? q.reasonStringAnswer : q.stringAnswer;
                                const currentScore = scores[q.id] ?? 0;

                                return (
                                    <div key={q.id} style={{ border: '1px solid var(--border)', padding: '1.5rem', borderRadius: '8px' }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                                            <h3 style={{ fontSize: '1.1rem', fontWeight: 700 }}>
                                                문항 {q.number} {isDual && <span style={{ fontSize: '0.8rem', color: 'var(--warning)', background: 'rgba(234, 179, 8, 0.1)', padding: '2px 6px', borderRadius: '4px', marginLeft: '8px' }}>이중 문제 (사유)</span>}
                                            </h3>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                                <span style={{ fontSize: '0.9rem', color: 'var(--muted)' }}>점수 부여 (0 또는 1):</span>
                                                <input
                                                    type="number"
                                                    min="0"
                                                    max="1"
                                                    value={currentScore}
                                                    onChange={(e) => handleScoreChange(q.id, Number(e.target.value))}
                                                    style={{ width: '60px', padding: '0.3rem', borderRadius: '4px', border: '1px solid var(--border)', textAlign: 'center' }}
                                                />
                                            </div>
                                        </div>

                                        {isDual && (
                                            <div style={{ marginBottom: '1rem', fontSize: '0.85rem', color: 'var(--foreground)' }}>
                                                객관식 마킹: <strong>{attempt.answers[q.id] || '미응답'}</strong> (정답: <strong>{q.answer}</strong>)
                                            </div>
                                        )}

                                        <div style={{ display: 'flex', gap: '2rem', background: '#f1f5f9', padding: '1rem', borderRadius: '4px' }}>
                                            <div style={{ flex: 1 }}>
                                                <div style={{ fontSize: '0.8rem', color: 'var(--muted)', marginBottom: '0.3rem' }}>학생 제출 {isDual ? '사유' : '답안'}</div>
                                                <div style={{ fontSize: '1rem', fontWeight: 600 }}>{studentAnswer}</div>
                                            </div>
                                            <div style={{ flex: 1, borderLeft: '1px solid #cbd5e1', paddingLeft: '1.5rem' }}>
                                                <div style={{ fontSize: '0.8rem', color: 'var(--muted)', marginBottom: '0.3rem' }}>모범 {isDual ? '사유' : '정답'}</div>
                                                <div style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--success)' }}>{correctAnswer || '(등록된 정답 없음)'}</div>
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            </main>
        </div>
    );
}
