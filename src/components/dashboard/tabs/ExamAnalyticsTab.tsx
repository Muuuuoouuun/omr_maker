"use client";

import { useMemo, useState, useEffect } from "react";
import { Exam, Attempt } from "@/types/omr";
import {
    BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer,
    Radar, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Legend
} from 'recharts';
import { AlertTriangle, CheckCircle, BarChart2, Download, ChevronUp, ChevronDown, List } from "lucide-react";

interface ExamAnalyticsTabProps {
    exams: Exam[];
    attempts: Attempt[];
    initialExamId?: string;
}

export default function ExamAnalyticsTab({ exams, attempts, initialExamId }: ExamAnalyticsTabProps) {
    const [selectedExamId, setSelectedExamId] = useState<string>(initialExamId || (exams.length > 0 ? exams[0].id : ""));

    // Sync initialExamId if parent changes it
    useEffect(() => {
        if (initialExamId) {
            setSelectedExamId(initialExamId);
        }
    }, [initialExamId]);

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
            const optionCounts: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };

            examAttempts.forEach(attempt => {
                const selectedAns = attempt.answers[q.id];
                if (selectedAns !== undefined) {
                    if (selectedAns === q.answer) correctCount++;
                    if (optionCounts[selectedAns] !== undefined) {
                        optionCounts[selectedAns]++;
                    } else {
                        optionCounts[selectedAns] = 1; // dynamically add other options if they exist
                    }
                }
            });
            const correctRate = Math.round((correctCount / examAttempts.length) * 100);

            const optionRates = Object.entries(optionCounts).map(([opt, count]) => ({
                option: parseInt(opt),
                count,
                rate: Math.round((count / examAttempts.length) * 100)
            }));

            return {
                index: qIndex + 1,
                id: q.id,
                label: q.label || '일반',
                correctRate,
                wrongRate: 100 - correctRate,
                optionRates,
                answer: q.answer
            };
        }).sort((a: any, b: any) => a.correctRate - b.correctRate); // Sort by hardest first
    }, [selectedExam, examAttempts]);

    // Calculate Label Analytics for Radar Chart
    const labelAnalytics = useMemo(() => {
        if (!selectedExam || examAttempts.length === 0) return [];

        const labelMap: Record<string, { totalPoints: number, earnedPoints: number }> = {};

        selectedExam.questions.forEach(q => {
            const label = q.label || '일반';
            if (!labelMap[label]) labelMap[label] = { totalPoints: 0, earnedPoints: 0 };

            labelMap[label].totalPoints += (q.score || 5) * examAttempts.length;

            examAttempts.forEach(attempt => {
                const selectedAns = attempt.answers[q.id];
                if (selectedAns !== undefined && selectedAns === q.answer) {
                    labelMap[label].earnedPoints += (q.score || 5);
                }
            });
        });

        return Object.entries(labelMap).map(([label, data]) => ({
            label,
            correctRate: Math.round((data.earnedPoints / data.totalPoints) * 100)
        }));
    }, [selectedExam, examAttempts]);

    const examLabels = useMemo(() => {
        if (!selectedExam) return [];
        return Array.from(new Set(selectedExam.questions.map(q => q.label || '일반')));
    }, [selectedExam]);

    const studentScores = useMemo(() => {
        if (!selectedExam || examAttempts.length === 0) return [];
        return examAttempts.map(attempt => {
            const labelScores: Record<string, { earned: number, total: number }> = {};
            examLabels.forEach(l => labelScores[l] = { earned: 0, total: 0 });

            selectedExam.questions.forEach(q => {
                const label = q.label || '일반';
                const score = q.score || 5;
                labelScores[label].total += score;
                const selectedAns = attempt.answers[q.id];
                if (selectedAns !== undefined && selectedAns === q.answer) {
                    labelScores[label].earned += score;
                }
            });

            const scorePercentage = Math.round((attempt.score / attempt.totalScore) * 100);

            return {
                studentName: attempt.studentName,
                totalScore: attempt.score,
                scorePercentage,
                labelScores,
                attempt
            };
        });
    }, [selectedExam, examAttempts, examLabels]);

    const [sortField, setSortField] = useState<'name' | 'score'>('score');
    const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

    const sortedStudentScores = useMemo(() => {
        return [...studentScores].sort((a, b) => {
            if (sortField === 'score') {
                return sortDir === 'asc' ? a.totalScore - b.totalScore : b.totalScore - a.totalScore;
            } else {
                return sortDir === 'asc' ? a.studentName.localeCompare(b.studentName) : b.studentName.localeCompare(a.studentName);
            }
        });
    }, [studentScores, sortField, sortDir]);

    const handleSort = (field: 'name' | 'score') => {
        if (sortField === field) {
            setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
        } else {
            setSortField(field);
            setSortDir('desc');
        }
    };

    const handleExportCSV = (student: typeof studentScores[0]) => {
        if (!selectedExam) return;

        // CSV header
        let csvContent = "문항 번호,라벨(장르),배점,학생 선택,정답,정오\n";

        selectedExam.questions.forEach((q, i) => {
            const selectedAns = student.attempt.answers[q.id];
            const isCorrect = (selectedAns !== undefined && selectedAns === q.answer);
            const score = q.score || 5;
            csvContent += `${q.number || i + 1},${q.label || '일반'},${score},${selectedAns || '-'},${q.answer || 1},${isCorrect ? 'O' : 'X'}\n`;
        });

        csvContent += "\n장르별 통계\n장르,획득 점수,만점\n";
        Object.entries(student.labelScores).forEach(([label, data]) => {
            csvContent += `${label},${data.earned},${data.total}\n`;
        });

        const blob = new Blob(["\uFEFF" + csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.setAttribute("href", url);
        link.setAttribute("download", `${student.studentName}_${selectedExam.title}_분석.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

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
                                        <RadarChart cx="50%" cy="50%" outerRadius="80%" data={labelAnalytics} startAngle={90} endAngle={-270}>
                                            <PolarGrid stroke="var(--border)" />
                                            <PolarAngleAxis dataKey="label" tick={{ fill: 'var(--text)', fontSize: 13, fontWeight: 700 }} />
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
                                            <div style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>오답률</div>
                                            <div style={{ fontWeight: 800, fontSize: '1.2rem', color: 'var(--error)' }}>
                                                {q.wrongRate}%
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
                        <div style={{ height: '300px', width: '100%', marginBottom: '2rem' }}>
                            <ResponsiveContainer width="100%" height="100%">
                                <BarChart data={questionAnalytics.sort((a: any, b: any) => a.index - b.index)}>
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

                        {/* Option Selection Rates Table */}
                        <h4 style={{ fontSize: '1.05rem', fontWeight: 700, marginTop: '1rem', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <List size={16} color="var(--primary)" />
                            세부사항: 문항별 선택률
                        </h4>
                        <div style={{ overflowX: 'auto' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', minWidth: '600px' }}>
                                <thead>
                                    <tr style={{ background: 'var(--surface)', color: 'var(--muted)', fontSize: '0.85rem' }}>
                                        <th style={{ padding: '0.75rem 1rem', borderRadius: 'var(--radius-md) 0 0 var(--radius-md)' }}>문항</th>
                                        <th style={{ padding: '0.75rem 1rem' }}>정답률</th>
                                        <th style={{ padding: '0.75rem 1rem', textAlign: 'center' }}>선지 1</th>
                                        <th style={{ padding: '0.75rem 1rem', textAlign: 'center' }}>선지 2</th>
                                        <th style={{ padding: '0.75rem 1rem', textAlign: 'center' }}>선지 3</th>
                                        <th style={{ padding: '0.75rem 1rem', textAlign: 'center' }}>선지 4</th>
                                        <th style={{ padding: '0.75rem 1rem', textAlign: 'center', borderRadius: '0 var(--radius-md) var(--radius-md) 0' }}>선지 5</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {questionAnalytics.sort((a: any, b: any) => a.index - b.index).map((q, i) => {
                                        const optMap = q.optionRates.reduce((acc: any, curr: any) => { acc[curr.option] = curr.rate; return acc; }, {});
                                        return (
                                            <tr key={i} style={{ borderBottom: '1px solid var(--border)' }} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                                                <td style={{ padding: '0.75rem 1rem', fontWeight: 600 }}>{q.index}번 <span style={{ fontSize: '0.75rem', color: 'var(--muted)', fontWeight: 400 }}>({q.label})</span></td>
                                                <td style={{ padding: '0.75rem 1rem', fontWeight: 600, color: q.correctRate < 40 ? 'var(--error)' : 'var(--text)' }}>
                                                    {q.correctRate}%
                                                </td>
                                                {[1, 2, 3, 4, 5].map(optNum => (
                                                    <td key={optNum} style={{ padding: '0.75rem 1rem', textAlign: 'center' }}>
                                                        <span style={{
                                                            display: 'inline-block', minWidth: '40px', padding: '0.2rem 0.4rem', borderRadius: '4px',
                                                            background: q.answer === optNum ? 'rgba(34, 197, 94, 0.1)' : 'transparent',
                                                            color: q.answer === optNum ? 'var(--success)' : 'var(--muted)',
                                                            fontWeight: q.answer === optNum ? 700 : 400
                                                        }}>
                                                            {optMap[optNum] || 0}%
                                                        </span>
                                                    </td>
                                                ))}
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </div>

                    {/* Student Scores Section */}
                    <div className="card" style={{ padding: '1.5rem', marginTop: '1.5rem' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
                            <h3 style={{ fontSize: '1.1rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                <AlertTriangle size={18} color="var(--primary)" style={{ visibility: 'hidden' }} />
                                학생별 점수 및 성취도 (장르별)
                            </h3>
                        </div>

                        <div style={{ overflowX: 'auto', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border)' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', minWidth: '800px' }}>
                                <thead style={{ background: 'var(--surface)' }}>
                                    <tr>
                                        <th
                                            onClick={() => handleSort('name')}
                                            style={{ padding: '1rem', fontSize: '0.85rem', color: 'var(--muted)', cursor: 'pointer', transition: 'color 0.2s' }}
                                            className="hover:text-primary"
                                        >
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                                학생 이름 {sortField === 'name' ? (sortDir === 'asc' ? <ChevronUp size={14} /> : <ChevronDown size={14} />) : ''}
                                            </div>
                                        </th>
                                        <th
                                            onClick={() => handleSort('score')}
                                            style={{ padding: '1rem', fontSize: '0.85rem', color: 'var(--muted)', cursor: 'pointer', transition: 'color 0.2s' }}
                                            className="hover:text-primary"
                                        >
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                                총점 {sortField === 'score' ? (sortDir === 'asc' ? <ChevronUp size={14} /> : <ChevronDown size={14} />) : ''}
                                            </div>
                                        </th>
                                        {/* Dynamic Label Columns */}
                                        {examLabels.map(label => (
                                            <th key={label} style={{ padding: '1rem', fontSize: '0.85rem', color: 'var(--muted)' }}>
                                                {label}
                                            </th>
                                        ))}
                                        <th style={{ padding: '1rem', fontSize: '0.85rem', color: 'var(--muted)', textAlign: 'right' }}>데이터 출력</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {sortedStudentScores.map((student, i) => (
                                        <tr key={i} style={{ borderTop: '1px solid var(--border)' }} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                                            <td style={{ padding: '1rem', fontWeight: 600 }}>{student.studentName}</td>
                                            <td style={{ padding: '1rem' }}>
                                                <div style={{ fontWeight: 800, color: student.scorePercentage >= 80 ? 'var(--success)' : (student.scorePercentage < 50 ? 'var(--error)' : 'var(--text)') }}>
                                                    {student.totalScore}점 <span style={{ fontSize: '0.8rem', color: 'var(--muted)', fontWeight: 400 }}>({student.scorePercentage}%)</span>
                                                </div>
                                            </td>
                                            {/* Dynamic Label Columns */}
                                            {examLabels.map(label => {
                                                const ls = student.labelScores[label];
                                                const rate = ls.total > 0 ? Math.round((ls.earned / ls.total) * 100) : 0;
                                                return (
                                                    <td key={label} style={{ padding: '1rem' }}>
                                                        <div style={{ fontSize: '0.9rem', fontWeight: 600 }}>{ls.earned} / {ls.total}</div>
                                                        <div style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>정답률 {rate}%</div>
                                                    </td>
                                                );
                                            })}
                                            <td style={{ padding: '1rem', textAlign: 'right' }}>
                                                <button
                                                    onClick={() => handleExportCSV(student)}
                                                    style={{
                                                        background: 'var(--surface)', color: 'var(--foreground)', padding: '0.4rem 0.8rem',
                                                        borderRadius: 'var(--radius-md)', fontSize: '0.75rem', fontWeight: 600,
                                                        display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
                                                        border: '1px solid var(--border)', transition: 'all 0.2s'
                                                    }}
                                                    className="hover:border-primary hover:text-primary"
                                                >
                                                    <Download size={14} />
                                                    정오표(CSV)
                                                </button>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
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

