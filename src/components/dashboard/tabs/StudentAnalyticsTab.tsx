"use client";

import { useMemo, useState } from "react";
import { Exam, Attempt } from "@/types/omr";
import {
    LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip,
    ResponsiveContainer, Legend
} from 'recharts';
import { TrendingUp, Search } from "lucide-react";

interface StudentAnalyticsTabProps {
    exams: Exam[];
    attempts: Attempt[];
}

export default function StudentAnalyticsTab({ exams, attempts }: StudentAnalyticsTabProps) {
    // Extract unique students
    const students = useMemo(() => {
        const studentMap = new Map<string, string>();
        attempts.forEach(a => {
            if (!studentMap.has(a.studentName)) {
                studentMap.set(a.studentName, a.studentName);
            }
        });
        return Array.from(studentMap.values()).sort();
    }, [attempts]);

    const [selectedStudent, setSelectedStudent] = useState<string>(students.length > 0 ? students[0] : "");
    const [excludedExamIds, setExcludedExamIds] = useState<Set<string>>(new Set());
    const [searchQuery, setSearchQuery] = useState<string>("");

    const filteredStudents = useMemo(() => {
        if (!searchQuery.trim()) return students;
        return students.filter(name => name.toLowerCase().includes(searchQuery.toLowerCase()));
    }, [students, searchQuery]);

    const toggleExamExclusion = (examId: string) => {
        const newSet = new Set(excludedExamIds);
        if (newSet.has(examId)) {
            newSet.delete(examId);
        } else {
            newSet.add(examId);
        }
        setExcludedExamIds(newSet);
    };

    const studentAttempts = useMemo(() => {
        if (!selectedStudent) return [];
        return attempts
            .filter(a => a.studentName === selectedStudent)
            .sort((a, b) => new Date(a.finishedAt).getTime() - new Date(b.finishedAt).getTime());
    }, [attempts, selectedStudent]);

    // Data for Chart
    const trendData = useMemo(() => {
        return studentAttempts
            .filter(a => !excludedExamIds.has(a.examId))
            .map(attempt => {
                // Find all attempts for this exam to calculate average
                const allAttemptsForExam = attempts.filter(a => a.examId === attempt.examId);
                const avgScore = allAttemptsForExam.length > 0
                    ? allAttemptsForExam.reduce((sum, a) => sum + (a.score / a.totalScore) * 100, 0) / allAttemptsForExam.length
                    : 0;

                return {
                    date: new Date(attempt.finishedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
                    examTitle: attempt.examTitle,
                    examId: attempt.examId,
                    studentScore: Math.round((attempt.score / attempt.totalScore) * 100),
                    avgScore: Math.round(avgScore),
                };
            });
    }, [studentAttempts, attempts, excludedExamIds]);

    // Data for Detailed Table
    const detailedAnalysis = useMemo(() => {
        return studentAttempts.map(attempt => {
            const exam = exams.find(e => e.id === attempt.examId);

            // Calculate rank
            const examAttempts = attempts.filter(a => a.examId === attempt.examId)
                .sort((a, b) => b.score - a.score);
            let rank = 1;
            const totalStudents = examAttempts.length;

            // To handle ties properly, find first index with same score
            const studentScore = attempt.score;
            rank = examAttempts.findIndex(a => a.score === studentScore) + 1;

            // Calculate strengths and weaknesses based on labels
            const labelStats: Record<string, { correct: number, total: number }> = {};

            if (exam && attempt.answers && exam.questions) {
                exam.questions.forEach(q => {
                    const label = q.label || '일반/종합';
                    if (!labelStats[label]) labelStats[label] = { correct: 0, total: 0 };

                    labelStats[label].total += 1;
                    if (attempt.answers[q.id] === q.answer) {
                        labelStats[label].correct += 1;
                    }
                });
            }

            let strongPoint = '';
            let weakPoint = '';
            let highestRate = -1;
            let lowestRate = 2; // rate goes up to 1

            Object.entries(labelStats).forEach(([label, stats]) => {
                if (stats.total > 0) {
                    const rate = stats.correct / stats.total;
                    if (rate > highestRate) {
                        highestRate = rate;
                        strongPoint = label;
                    }
                    if (rate < lowestRate) {
                        lowestRate = rate;
                        weakPoint = label;
                    }
                }
            });

            if (highestRate === lowestRate) {
                if (highestRate >= 0.8) weakPoint = '비교적 양호';
                else if (highestRate <= 0.4) strongPoint = '기초 필요';
                else if (Object.keys(labelStats).length === 1) {
                    strongPoint = '균형';
                    weakPoint = '균형';
                }
            }

            return {
                attemptId: attempt.id,
                examTitle: attempt.examTitle,
                score: attempt.score,
                totalScore: attempt.totalScore,
                scoreRate: Math.round((attempt.score / attempt.totalScore) * 100),
                rank,
                totalStudents,
                strongPoint,
                weakPoint,
                date: new Date(attempt.finishedAt).toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' })
            };
        }).reverse(); // Latest at the top
    }, [studentAttempts, attempts, exams]);

    if (students.length === 0) {
        return <div className="text-center p-8 text-muted">아직 응시 기록이 있는 학생이 없습니다.</div>;
    }

    // fallback when a student is not active
    if (!selectedStudent && students.length > 0) {
        setSelectedStudent(students[0]);
    }

    return (
        <div className="fade-in-up" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            {/* Filter Section */}
            <div className="card" style={{ padding: '1.5rem', display: 'flex', alignItems: 'center', gap: '1rem', background: 'var(--surface)', flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 600, color: 'var(--text)', whiteSpace: 'nowrap' }}>분석할 학생 선택:</span>

                <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                    <Search size={18} style={{ position: 'absolute', left: '12px', color: 'var(--muted)' }} />
                    <input
                        type="text"
                        placeholder="이름 검색..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        style={{
                            padding: '0.75rem 1rem 0.75rem 2.5rem',
                            borderRadius: 'var(--radius-md)',
                            border: '1px solid var(--border)',
                            background: 'var(--background)',
                            color: 'var(--text)',
                            width: '180px',
                            outline: 'none',
                            transition: 'border-color 0.2s'
                        }}
                    />
                </div>

                <select
                    value={selectedStudent}
                    onChange={(e) => setSelectedStudent(e.target.value)}
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
                    {filteredStudents.length > 0 ? (
                        filteredStudents.map(name => (
                            <option key={name} value={name}>{name}</option>
                        ))
                    ) : (
                        <option value="" disabled>검색 결과가 없습니다.</option>
                    )}
                </select>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 5fr) minmax(0, 3fr)', gap: '1.5rem' }}>
                {/* Left side: Chart */}
                <div className="card" style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column' }}>
                    <div style={{ marginBottom: '1.5rem' }}>
                        <h3 style={{ fontSize: '1.25rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                            <TrendingUp size={20} color="var(--primary)" />
                            {selectedStudent} 학생 성취도 추이
                        </h3>
                        <p style={{ color: 'var(--muted)', fontSize: '0.9rem' }}>
                            응시한 시험들의 점수 추이 및 전체 학생의 시험 평균을 같이 비교합니다.
                        </p>
                    </div>

                    <div style={{ flex: 1, minHeight: '350px', width: '100%' }}>
                        {trendData.length > 0 ? (
                            <ResponsiveContainer width="100%" height="100%">
                                <LineChart data={trendData} margin={{ top: 20, right: 30, left: 0, bottom: 20 }}>
                                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
                                    <XAxis dataKey="examTitle" tick={{ fill: 'var(--muted)', fontSize: 12 }} axisLine={false} tickLine={false} />
                                    <YAxis domain={[0, 100]} tick={{ fill: 'var(--muted)' }} axisLine={false} tickLine={false} />
                                    <RechartsTooltip
                                        contentStyle={{ borderRadius: '8px', border: '1px solid var(--border)', boxShadow: '0 4px 12px rgba(0,0,0,0.05)', background: 'var(--background)' }}
                                        labelStyle={{ fontWeight: 'bold', color: 'var(--text)', marginBottom: '8px' }}
                                    />
                                    <Legend wrapperStyle={{ paddingTop: '20px' }} />
                                    <Line
                                        name="내 점수"
                                        type="monotone"
                                        dataKey="studentScore"
                                        stroke="var(--primary)"
                                        strokeWidth={3}
                                        dot={{ r: 5, strokeWidth: 2, fill: 'var(--background)' }}
                                        activeDot={{ r: 7 }}
                                        animationDuration={1500}
                                    />
                                    <Line
                                        name="이번 시험 전체 평균"
                                        type="monotone"
                                        dataKey="avgScore"
                                        stroke="var(--warning)"
                                        strokeWidth={2}
                                        strokeDasharray="5 5"
                                        dot={{ r: 4, strokeWidth: 0, fill: 'var(--muted)' }}
                                        animationDuration={1500}
                                    />
                                </LineChart>
                            </ResponsiveContainer>
                        ) : (
                            <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)' }}>
                                표시할 데이터가 없습니다. (모든 시험 목록이 제외됨)
                            </div>
                        )}
                    </div>
                </div>

                {/* Right side: Exam List & Unattempted Exams */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', maxHeight: '500px' }}>

                    {/* Unattempted Exams & Alarm Saturation feature */}
                    <div className="card" style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column' }}>
                        <h3 style={{ fontSize: '1.1rem', fontWeight: 700, marginBottom: '0.5rem', color: 'var(--error)' }}>
                            미응시 시험 ({exams.filter(e => !studentAttempts.some(a => a.examId === e.id)).length})
                        </h3>
                        <p style={{ fontSize: '0.85rem', color: 'var(--muted)', marginBottom: '1rem' }}>
                            학생이 응시하지 않은 시험 목록입니다. 알림 포화 기능을 설정할 수 있습니다.
                        </p>

                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', overflowY: 'auto', maxHeight: '150px' }}>
                            {exams.filter(e => !studentAttempts.some(a => a.examId === e.id)).length === 0 ? (
                                <div style={{ fontSize: '0.9rem', color: 'var(--muted)', padding: '1rem', textAlign: 'center', background: 'var(--background)', borderRadius: 'var(--radius-md)' }}>
                                    모든 시험을 완료했습니다! 🎉
                                </div>
                            ) : (
                                exams.filter(e => !studentAttempts.some(a => a.examId === e.id)).map(exam => (
                                    <div key={exam.id} style={{
                                        display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.75rem',
                                        borderRadius: 'var(--radius-md)', background: 'rgba(239, 68, 68, 0.05)', border: '1px solid rgba(239, 68, 68, 0.2)'
                                    }}>
                                        <div>
                                            <div style={{ fontWeight: 600, fontSize: '0.9rem', color: 'var(--foreground)' }}>{exam.title}</div>
                                            <div style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>배포일: {new Date(exam.createdAt).toLocaleDateString()}</div>
                                        </div>
                                        <button
                                            onClick={() => alert(`[${selectedStudent}] 학생의 "${exam.title}" 시험에 대한 [알림 포화 모드]가 활성화되었습니다.\n\n해당 학생이 시험을 완료할 때까지 5분에 한 번씩 푸시 알림이 전송됩니다.`)}
                                            style={{
                                                background: 'var(--error)', color: 'white', padding: '0.4rem 0.8rem',
                                                borderRadius: 'var(--radius-md)', fontSize: '0.75rem', fontWeight: 700,
                                                transition: 'all 0.2s', boxShadow: '0 2px 4px rgba(239, 68, 68, 0.2)'
                                            }}
                                            className="card-hover"
                                        >
                                            알림 포화 (5분 간격)
                                        </button>
                                    </div>
                                ))
                            )}
                        </div>
                    </div>

                    <div className="card" style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', flex: 1 }}>
                        <h3 style={{ fontSize: '1.1rem', fontWeight: 700, marginBottom: '0.5rem' }}>응시 기록 ({studentAttempts.length})</h3>
                        <p style={{ fontSize: '0.85rem', color: 'var(--muted)', marginBottom: '1.5rem' }}>차트에서 제외할 시험의 체크를 해제하세요.</p>

                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', overflowY: 'auto', flex: 1 }}>
                            {studentAttempts.map(attempt => {
                                const isExcluded = excludedExamIds.has(attempt.examId);
                                const scoreRate = Math.round((attempt.score / attempt.totalScore) * 100);

                                return (
                                    <label
                                        key={attempt.id}
                                        style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '0.75rem',
                                            padding: '0.75rem',
                                            borderRadius: 'var(--radius-md)',
                                            background: isExcluded ? 'transparent' : 'var(--surface)',
                                            border: `1px solid ${isExcluded ? 'var(--border)' : 'var(--primary)'}`,
                                            opacity: isExcluded ? 0.6 : 1,
                                            cursor: 'pointer',
                                            transition: 'all 0.2s'
                                        }}
                                        className="card-hover"
                                    >
                                        <input
                                            type="checkbox"
                                            checked={!isExcluded}
                                            onChange={() => toggleExamExclusion(attempt.examId)}
                                            style={{ accentColor: 'var(--primary)', width: '16px', height: '16px', cursor: 'pointer' }}
                                        />
                                        <div style={{ flex: 1, overflow: 'hidden' }}>
                                            <div style={{ fontWeight: 600, fontSize: '0.9rem', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>{attempt.examTitle}</div>
                                            <div style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>{new Date(attempt.finishedAt).toLocaleDateString()}</div>
                                        </div>
                                        <div style={{ fontWeight: 800, fontSize: '1.1rem', color: scoreRate >= 80 ? 'var(--success)' : (scoreRate < 50 ? 'var(--error)' : 'var(--text)') }}>
                                            {scoreRate}점
                                        </div>
                                    </label>
                                );
                            })}
                        </div>
                    </div>
                </div>
            </div>

            {/* Detailed Table Section */}
            <div className="card" style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column' }}>
                <h3 style={{ fontSize: '1.25rem', fontWeight: 700, marginBottom: '0.5rem' }}>
                    세부 시험 분석 내역
                </h3>
                <p style={{ color: 'var(--muted)', fontSize: '0.9rem', marginBottom: '1.5rem' }}>
                    각 시험별 등수 및 문항 라벨에 따른 강점/약점 유형을 요약하여 보여줍니다.
                </p>

                <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', minWidth: '700px' }}>
                        <thead>
                            <tr style={{ borderBottom: '2px solid var(--border)', color: 'var(--muted)', fontSize: '0.9rem' }}>
                                <th style={{ padding: '1rem 0.5rem', fontWeight: 600 }}>시험명</th>
                                <th style={{ padding: '1rem 0.5rem', fontWeight: 600 }}>점수</th>
                                <th style={{ padding: '1rem 0.5rem', fontWeight: 600 }}>전체 등수</th>
                                <th style={{ padding: '1rem 0.5rem', fontWeight: 600 }}>강점 유형</th>
                                <th style={{ padding: '1rem 0.5rem', fontWeight: 600 }}>약점 유형</th>
                                <th style={{ padding: '1rem 0.5rem', fontWeight: 600 }}>응시일</th>
                            </tr>
                        </thead>
                        <tbody>
                            {detailedAnalysis.length === 0 ? (
                                <tr>
                                    <td colSpan={6} style={{ textAlign: 'center', padding: '2rem', color: 'var(--muted)' }}>
                                        기록이 없습니다.
                                    </td>
                                </tr>
                            ) : (
                                detailedAnalysis.map((detail) => (
                                    <tr key={detail.attemptId} className="card-hover" style={{ borderBottom: '1px solid var(--border)' }}>
                                        <td style={{ padding: '1rem 0.5rem', fontWeight: 600, color: 'var(--foreground)' }}>
                                            {detail.examTitle}
                                        </td>
                                        <td style={{ padding: '1rem 0.5rem', fontWeight: 700, color: detail.scoreRate >= 80 ? 'var(--success)' : (detail.scoreRate < 50 ? 'var(--error)' : 'inherit') }}>
                                            {detail.score} <span style={{ fontSize: '0.8rem', color: 'var(--muted)', fontWeight: 400 }}>/ {detail.totalScore}</span>
                                        </td>
                                        <td style={{ padding: '1rem 0.5rem', fontWeight: 600 }}>
                                            {detail.rank} <span style={{ fontSize: '0.8rem', color: 'var(--muted)', fontWeight: 400 }}>/ {detail.totalStudents}명</span>
                                        </td>
                                        <td style={{ padding: '1rem 0.5rem' }}>
                                            {detail.strongPoint ?
                                                <span style={{ background: 'rgba(16, 185, 129, 0.1)', color: 'var(--success)', padding: '4px 8px', borderRadius: '4px', fontSize: '0.85rem', fontWeight: 600 }}>
                                                    {detail.strongPoint}
                                                </span>
                                                : <span style={{ color: 'var(--muted)' }}>-</span>
                                            }
                                        </td>
                                        <td style={{ padding: '1rem 0.5rem' }}>
                                            {detail.weakPoint ?
                                                <span style={{ background: 'rgba(239, 68, 68, 0.1)', color: 'var(--error)', padding: '4px 8px', borderRadius: '4px', fontSize: '0.85rem', fontWeight: 600 }}>
                                                    {detail.weakPoint}
                                                </span>
                                                : <span style={{ color: 'var(--muted)' }}>-</span>
                                            }
                                        </td>
                                        <td style={{ padding: '1rem 0.5rem', fontSize: '0.85rem', color: 'var(--muted)' }}>
                                            {detail.date}
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
}
