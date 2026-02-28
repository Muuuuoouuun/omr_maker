"use client";

import { useMemo, useState } from "react";
import { Exam, Attempt } from "@/types/omr";
import {
    BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer,
    Radar, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis
} from 'recharts';
import { AlertTriangle, CheckCircle, BarChart2 } from "lucide-react";

interface ExamAnalyticsTabProps {
    exams: Exam[];
    attempts: Attempt[];
}

export default function ExamAnalyticsTab({ exams, attempts }: ExamAnalyticsTabProps) {
    const [selectedExamId, setSelectedExamId] = useState<string>(exams.length > 0 ? exams[0].id : "");

    const selectedExam = useMemo(() => exams.find(e => e.id === selectedExamId), [exams, selectedExamId]);
    const examAttempts = useMemo(() => attempts.filter(a => a.examId === selectedExamId), [attempts, selectedExamId]);

    const examStats = useMemo(() => {
        if (!selectedExam || examAttempts.length === 0) return null;

        const scores = examAttempts.map(a => (a.score / a.totalScore) * 100);
        const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
        const maxScore = Math.max(...scores);
        const minScore = Math.min(...scores);

        return {
            avgScore: Math.round(avgScore),
            maxScore: Math.round(maxScore),
            minScore: Math.round(minScore),
            count: examAttempts.length
        };
    }, [selectedExam, examAttempts]);

    // Calculate Question Analytics
    const questionAnalytics = useMemo(() => {
        if (!selectedExam || examAttempts.length === 0) return [];

        return selectedExam.questions.map((q, qIndex) => {
            let correctCount = 0;
            examAttempts.forEach(attempt => {
                const answer = attempt.answers.find(a => a.questionId === q.id);
                if (answer && answer.isCorrect) correctCount++;
            });
            const correctRate = Math.round((correctCount / examAttempts.length) * 100);
            return {
                index: qIndex + 1,
                id: q.id,
                label: q.label || '일반',
                correctRate,
                wrongRate: 100 - correctRate
            };
        }).sort((a, b) => a.correctRate - b.correctRate); // Sort by hardest first
    }, [selectedExam, examAttempts]);

    // Calculate Label Analytics for Radar Chart
    const labelAnalytics = useMemo(() => {
        if (!selectedExam || examAttempts.length === 0) return [];

        const labelMap: Record<string, { totalPoints: number, earnedPoints: number }> = {};

        selectedExam.questions.forEach(q => {
            const label = q.label || '일반';
            if (!labelMap[label]) labelMap[label] = { totalPoints: 0, earnedPoints: 0 };

            labelMap[label].totalPoints += q.points * examAttempts.length;

            examAttempts.forEach(attempt => {
                const answer = attempt.answers.find(a => a.questionId === q.id);
                if (answer && answer.isCorrect) {
                    labelMap[label].earnedPoints += q.points;
                }
            });
        });

        return Object.entries(labelMap).map(([label, data]) => ({
            label,
            correctRate: Math.round((data.earnedPoints / data.totalPoints) * 100)
        }));
    }, [selectedExam, examAttempts]);

    if (exams.length === 0) {
        return <div className="text-center p-8 text-muted">등록된 시험이 없습니다.</div>;
    }

    return (
        <div className="fade-in-up" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            {/* Filter Section */}
            <div className="card" style={{ padding: '1.5rem', display: 'flex', alignItems: 'center', gap: '1rem', background: 'var(--surface)' }}>
                <span style={{ fontWeight: 600, color: 'var(--text)' }}>분석할 시험 선택:</span>
                <select
                    value={selectedExamId}
                    onChange={(e) => setSelectedExamId(e.target.value)}
                    style={{
                        padding: '0.75rem 1rem',
                        borderRadius: 'var(--radius-md)',
                        border: '1px solid var(--border)',
                        background: 'var(--background)',
                        color: 'var(--text)',
                        flex: 1,
                        maxWidth: '400px',
                        outline: 'none',
                        cursor: 'pointer'
                    }}
                >
                    {exams.map(exam => (
                        <option key={exam.id} value={exam.id}>{exam.title}</option>
                    ))}
                </select>
            </div>

            {examStats ? (
                <>
                    {/* Stats Summary */}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '1rem' }}>
                        {[
                            { label: '평균 점수', value: `${examStats.avgScore}점`, color: 'var(--primary)' },
                            { label: '최고 점수', value: `${examStats.maxScore}점`, color: 'var(--success)' },
                            { label: '최저 점수', value: `${examStats.minScore}점`, color: 'var(--warning)' },
                            { label: '응시 인원', value: `${examStats.count}명`, color: 'var(--text)' },
                        ].map((stat, i) => (
                            <div key={i} className="card" style={{ padding: '1.5rem', textAlign: 'center', borderTop: `4px solid ${stat.color}` }}>
                                <div style={{ fontSize: '0.9rem', color: 'var(--muted)', marginBottom: '0.5rem' }}>{stat.label}</div>
                                <div style={{ fontSize: '2rem', fontWeight: 800, color: stat.color }}>{stat.value}</div>
                            </div>
                        ))}
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem' }}>
                        {/* Radar Chart for labels */}
                        <div className="card" style={{ padding: '1.5rem' }}>
                            <h3 style={{ fontSize: '1.1rem', fontWeight: 700, marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                <BarChart2 size={18} color="var(--primary)" />
                                항목별(라벨) 정답률 분석
                            </h3>
                            {labelAnalytics.length > 0 ? (
                                <div style={{ height: '300px', width: '100%' }}>
                                    <ResponsiveContainer width="100%" height="100%">
                                        <RadarChart cx="50%" cy="50%" outerRadius="80%" data={labelAnalytics}>
                                            <PolarGrid stroke="var(--border)" />
                                            <PolarAngleAxis dataKey="label" tick={{ fill: 'var(--text)', fontSize: 12, fontWeight: 600 }} />
                                            <PolarRadiusAxis angle={30} domain={[0, 100]} tick={{ fill: 'var(--muted)' }} />
                                            <Radar name="정답률" dataKey="correctRate" stroke="var(--primary)" fill="var(--primary)" fillOpacity={0.4} />
                                            <RechartsTooltip cursor={{ fill: 'transparent' }} contentStyle={{ borderRadius: '8px', border: '1px solid var(--border)', boxShadow: '0 4px 12px rgba(0,0,0,0.1)', background: 'var(--background)' }} formatter={(value: number | string | undefined) => [`${value}%`, '정답률']} />
                                        </RadarChart>
                                    </ResponsiveContainer>
                                </div>
                            ) : (
                                <div style={{ height: '300px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)' }}>라벨이 지정된 문항이 없습니다.</div>
                            )}
                        </div>

                        {/* Top Hardest Questions */}
                        <div className="card" style={{ padding: '1.5rem' }}>
                            <h3 style={{ fontSize: '1.1rem', fontWeight: 700, marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                <AlertTriangle size={18} color="var(--error)" />
                                오답률이 가장 높은 문항 Top 3
                            </h3>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                                {questionAnalytics.slice(0, 3).map((q, i) => (
                                    <div key={i} style={{
                                        padding: '1rem',
                                        borderRadius: 'var(--radius-md)',
                                        background: 'rgba(239, 68, 68, 0.05)',
                                        borderLeft: '4px solid var(--error)',
                                        display: 'flex',
                                        justifyContent: 'space-between',
                                        alignItems: 'center'
                                    }}>
                                        <div>
                                            <div style={{ fontWeight: 700, fontSize: '1.1rem', color: 'var(--error)', marginBottom: '0.2rem' }}>
                                                {q.index}번 문항 ({q.label})
                                            </div>
                                            <div style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>
                                                정답률이 가장 낮습니다. 보충 설명이 필요합니다.
                                            </div>
                                        </div>
                                        <div style={{ textAlign: 'right' }}>
                                            <div style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>오답률 / 정답률</div>
                                            <div style={{ fontWeight: 800, fontSize: '1.2rem', color: 'var(--text)' }}>
                                                <span style={{ color: 'var(--error)' }}>{q.wrongRate}%</span> / {q.correctRate}%
                                            </div>
                                        </div>
                                    </div>
                                ))}
                                {questionAnalytics.length === 0 && (
                                    <div style={{ color: 'var(--muted)', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>데이터가 없습니다.</div>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* Detailed Question correct rate bar chart */}
                    <div className="card" style={{ padding: '1.5rem' }}>
                        <h3 style={{ fontSize: '1.1rem', fontWeight: 700, marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <CheckCircle size={18} color="var(--success)" />
                            문항별 상세 정답률
                        </h3>
                        <div style={{ height: '300px', width: '100%' }}>
                            <ResponsiveContainer width="100%" height="100%">
                                <BarChart data={questionAnalytics.sort((a, b) => a.index - b.index)}>
                                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
                                    <XAxis dataKey="index" tickFormatter={(v) => `${v}번`} tick={{ fill: 'var(--muted)' }} axisLine={false} tickLine={false} />
                                    <YAxis domain={[0, 100]} tick={{ fill: 'var(--muted)' }} axisLine={false} tickLine={false} />
                                    <RechartsTooltip
                                        cursor={{ fill: 'rgba(99, 102, 241, 0.05)' }}
                                        contentStyle={{ borderRadius: '8px', border: '1px solid var(--border)', boxShadow: '0 4px 12px rgba(0,0,0,0.05)', background: 'var(--background)' }}
                                        formatter={(value: number | string | undefined) => [`${value}%`, '정답률']}
                                        labelFormatter={(label) => `${label}번 문항`}
                                    />
                                    <Bar dataKey="correctRate" fill="var(--primary)" radius={[4, 4, 0, 0]} animationDuration={1500} />
                                </BarChart>
                            </ResponsiveContainer>
                        </div>
                    </div>
                </>
            ) : (
                <div className="card" style={{ padding: '3rem', textAlign: 'center', color: 'var(--muted)' }}>
                    아직 응시한 학생이 없습니다.
                </div>
            )}
        </div>
    );
}

