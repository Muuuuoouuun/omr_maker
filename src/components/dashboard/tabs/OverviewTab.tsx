"use client";

import { useState } from "react";
import Link from "next/link";
import { Exam, Attempt } from "@/types/omr";
import StatCard from "@/components/dashboard/StatCard";
import TrendChart from "@/components/dashboard/TrendChart";
import ExamListBlock from "@/components/dashboard/ExamListBlock";
import { Users, BarChart3, PlusCircle, Activity } from "lucide-react";

interface OverviewTabProps {
    exams: Exam[];
    attempts: Attempt[];
    stats: {
        totalStudents: number;
        avgScore: number;
        activeExams: number;
    };
    trendData: number[];
    onNavigateToExamAnalytics?: (examId: string) => void;
}

export default function OverviewTab({ exams, attempts, stats, trendData, onNavigateToExamAnalytics }: OverviewTabProps) {
    const [activeTab, setActiveTab] = useState<'ongoing' | 'completed'>('ongoing');

    // Create dummy data mixed with real data for presentation
    const ongoingExams = [
        ...exams.slice(0, 2).map((e, idx) => ({ ...e, completedCount: attempts.filter(a => a.examId === e.id).length, total: stats.totalStudents > 0 ? stats.totalStudents : 30 + idx * 5 })),
        // Mock ongoing exams
        { id: 'mock-1', title: 'Midterm English Test', createdAt: new Date(Date.now() - 86400000 * 2).toISOString(), completedCount: 12, total: 35 },
        { id: 'mock-2', title: 'Chapter 4 Mathematics', createdAt: new Date(Date.now() - 86400000 * 5).toISOString(), completedCount: 28, total: 32 },
        { id: 'mock-3', title: 'Science Pop Quiz', createdAt: new Date(Date.now() - 86400000 * 1).toISOString(), completedCount: 5, total: 30 }
    ].slice(0, 5);

    const completedExams = [
        // Mock completed exams
        { id: 'comp-1', title: 'History Final Exam', createdAt: new Date(Date.now() - 86400000 * 30).toISOString(), completedCount: 35, total: 35 },
        { id: 'comp-2', title: 'Biology Chapter 1', createdAt: new Date(Date.now() - 86400000 * 15).toISOString(), completedCount: 30, total: 30 },
        { id: 'comp-3', title: 'Literature Essay Submission', createdAt: new Date(Date.now() - 86400000 * 10).toISOString(), completedCount: 32, total: 32 }
    ];

    const displayExams = activeTab === 'ongoing' ? ongoingExams : completedExams;

    const handleSendAlarm = (examTitle: string) => {
        alert(`[${examTitle}] 미응시 학생들에게 개별 알림을 전송했습니다.\n\n- 시험 시작 하루 전 자동 알림 기능 (활성화됨)\n- 선생님 수동 푸시 알림 (전송됨)`);
    };

    const handleSendAllAlarms = () => {
        alert("선생님이 배포한 '모든' 진행중인 시험의 미응시 학생들에게 일괄 알림을 전송했습니다.");
    };

    return (
        <div className="bento-grid fade-in-up">
            {/* 1. Quick Actions (New Section from UI image) */}
            <div className="bento-card col-span-2" style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column' }}>
                <div style={{ marginBottom: '1.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <h3 style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--foreground)' }}>
                        Quick Action <span style={{ fontWeight: 400, color: 'var(--muted)', fontSize: '0.9rem' }}>Do Some Quickly</span>
                    </h3>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1rem', flex: 1 }}>
                    <Link href="/create" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', padding: '1rem', background: 'rgba(56, 189, 248, 0.1)', borderRadius: 'var(--radius-lg)', color: '#0ea5e9', transition: 'all 0.2s' }} className="card-hover">
                        <PlusCircle size={24} />
                        <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>Create Exam</span>
                    </Link>
                    <button style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', padding: '1rem', background: 'rgba(239, 68, 68, 0.1)', borderRadius: 'var(--radius-lg)', color: '#ef4444', transition: 'all 0.2s' }} className="card-hover">
                        <Activity size={24} />
                        <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>Live Results</span>
                    </button>
                    <button style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', padding: '1rem', background: 'rgba(34, 197, 94, 0.1)', borderRadius: 'var(--radius-lg)', color: '#22c55e', transition: 'all 0.2s' }} className="card-hover">
                        <Users size={24} />
                        <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>Manage Users</span>
                    </button>
                    <button style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', padding: '1rem', background: 'rgba(245, 158, 11, 0.1)', borderRadius: 'var(--radius-lg)', color: '#f59e0b', transition: 'all 0.2s' }} className="card-hover">
                        <BarChart3 size={24} />
                        <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>Analytics</span>
                    </button>
                    <button onClick={() => alert("Setting features coming soon")} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', padding: '1rem', background: 'rgba(99, 102, 241, 0.1)', borderRadius: 'var(--radius-lg)', color: '#6366f1', transition: 'all 0.2s' }} className="card-hover">
                        <svg width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
                        <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>Settings</span>
                    </button>
                    <button onClick={() => alert("Invoice & Billing features coming soon")} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', padding: '1rem', background: 'rgba(168, 85, 247, 0.1)', borderRadius: 'var(--radius-lg)', color: '#a855f7', transition: 'all 0.2s' }} className="card-hover">
                        <svg width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"></rect><line x1="2" y1="10" x2="22" y2="10"></line></svg>
                        <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>Billing</span>
                    </button>
                </div>
            </div>

            {/* 2. Score Trend */}
            <div className="bento-card col-span-2" style={{
                background: 'linear-gradient(135deg, var(--primary), var(--primary-dark))',
                color: 'white', border: 'none',
                position: 'relative', overflow: 'hidden'
            }}>
                <div style={{ marginBottom: '1.5rem', position: 'relative', zIndex: 1 }}>
                    <h3 style={{ fontSize: '1.25rem', fontWeight: 700 }}>Avg. Score Trend</h3>
                    <p style={{ opacity: 0.8, fontSize: '0.95rem' }}>Overview of last 7 exams performance</p>
                </div>

                <div style={{ position: 'absolute', top: '-20%', right: '-10%', width: '200px', height: '200px', background: 'radial-gradient(circle, rgba(255,255,255,0.2) 0%, transparent 70%)' }}></div>

                <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end', width: '100%' }}>
                    <TrendChart data={trendData} color="white" height={160} />
                </div>
            </div>

            {/* 3. Project Summary (Currently Ongoing / Completed Exams) */}
            <div className="bento-card" style={{ gridColumn: 'span 4', overflowX: 'auto' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem' }}>
                        <h3 style={{ fontSize: '1.1rem', fontWeight: 700 }}>Exam Summary</h3>
                        <div style={{ display: 'flex', gap: '1rem', fontSize: '0.9rem', color: 'var(--muted)', fontWeight: 600 }}>
                            <span
                                onClick={() => setActiveTab('ongoing')}
                                style={{
                                    cursor: 'pointer',
                                    color: activeTab === 'ongoing' ? 'var(--primary)' : 'inherit',
                                    borderBottom: activeTab === 'ongoing' ? '2px solid var(--primary)' : '2px solid transparent',
                                    paddingBottom: '0.5rem',
                                    transition: 'all 0.2s'
                                }}>Ongoing</span>
                            <span
                                onClick={() => setActiveTab('completed')}
                                style={{
                                    cursor: 'pointer',
                                    color: activeTab === 'completed' ? 'var(--primary)' : 'inherit',
                                    borderBottom: activeTab === 'completed' ? '2px solid var(--primary)' : '2px solid transparent',
                                    paddingBottom: '0.5rem',
                                    transition: 'all 0.2s'
                                }}>Completed</span>
                        </div>
                    </div>

                    {/* Send All Alarms Button */}
                    {activeTab === 'ongoing' && (
                        <button
                            onClick={handleSendAllAlarms}
                            style={{
                                background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', padding: '0.6rem 1.2rem',
                                borderRadius: 'var(--radius-lg)', fontSize: '0.85rem', fontWeight: 700,
                                display: 'flex', alignItems: 'center', gap: '0.4rem',
                                transition: 'var(--transition-base)', border: '1px solid rgba(239, 68, 68, 0.2)'
                            }}
                            className="card-hover"
                        >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path></svg>
                            미응시자 전체 알람 발송
                        </button>
                    )}
                </div>

                <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', minWidth: '800px' }}>
                    <thead>
                        <tr style={{ color: 'var(--muted)', fontSize: '0.85rem', borderBottom: '1px solid var(--border)' }}>
                            <th style={{ padding: '1rem 0' }}>Exam Title</th>
                            <th style={{ padding: '1rem 0' }}>Created At</th>
                            <th style={{ padding: '1rem 0' }}>Progress (Participation)</th>
                            <th style={{ padding: '1rem 0' }}>Participants / Total</th>
                            <th style={{ padding: '1rem 0' }}>Status</th>
                            {activeTab === 'ongoing' && <th style={{ padding: '1rem 0', textAlign: 'right' }}>Action</th>}
                        </tr>
                    </thead>
                    <tbody>
                        {displayExams.map((exam) => {
                            const participationRate = Math.min(100, Math.round((exam.completedCount / exam.total) * 100));

                            const targetColor = participationRate > 70 ? 'var(--success)' : (participationRate > 30 ? 'var(--warning)' : 'var(--error)');
                            const statusText = participationRate === 100 ? 'Completed' : 'In Progress';
                            const statusBg = participationRate === 100 ? 'rgba(16, 185, 129, 0.1)' : 'rgba(139, 92, 246, 0.1)';
                            const statusColor = participationRate === 100 ? 'var(--success)' : 'var(--accent)';

                            return (
                                <tr key={exam.id} style={{ borderBottom: '1px solid var(--border)', transition: 'background 0.2s' }} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                                    <td style={{ padding: '1.2rem 0', fontWeight: 600, fontSize: '0.95rem' }}>
                                        <span
                                            onClick={() => onNavigateToExamAnalytics && onNavigateToExamAnalytics(exam.id)}
                                            style={{ cursor: 'pointer', transition: 'color 0.2s' }}
                                            className="hover:text-primary hover:underline hover:underline-offset-4"
                                        >
                                            {exam.title}
                                        </span>
                                    </td>
                                    <td style={{ padding: '1.2rem 0', color: 'var(--muted)', fontSize: '0.9rem' }}>{new Date(exam.createdAt).toLocaleDateString()}</td>
                                    <td style={{ padding: '1.2rem 0', display: 'flex', alignItems: 'center', gap: '1rem', height: '100%' }}>
                                        <div style={{ flex: 1, height: '6px', background: 'var(--border)', borderRadius: 'var(--radius-full)', overflow: 'hidden' }}>
                                            <div style={{ width: `${participationRate}%`, height: '100%', background: targetColor, borderRadius: 'var(--radius-full)', transition: 'width 1s ease-out' }}></div>
                                        </div>
                                        <span style={{ fontSize: '0.85rem', fontWeight: 600, color: targetColor, minWidth: '40px' }}>{participationRate}%</span>
                                    </td>
                                    <td style={{ padding: '1.2rem 0', fontSize: '0.9rem', color: 'var(--muted)', fontWeight: 500 }}>
                                        <span style={{ color: 'var(--foreground)', fontWeight: 600 }}>{exam.completedCount}</span> / {exam.total}
                                    </td>
                                    <td style={{ padding: '1.2rem 0' }}>
                                        <span style={{ background: statusBg, color: statusColor, padding: '0.3rem 0.6rem', borderRadius: 'var(--radius-full)', fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase' }}>
                                            {statusText}
                                        </span>
                                    </td>
                                    {activeTab === 'ongoing' && (
                                        <td style={{ padding: '1.2rem 0', textAlign: 'right' }}>
                                            <button
                                                onClick={() => handleSendAlarm(exam.title)}
                                                style={{
                                                    background: 'var(--surface)', color: 'var(--foreground)', padding: '0.5rem 1rem',
                                                    borderRadius: 'var(--radius-md)', fontSize: '0.85rem', fontWeight: 600,
                                                    display: 'flex', alignItems: 'center', gap: '0.4rem', marginLeft: 'auto',
                                                    transition: 'var(--transition-base)', border: '1px solid var(--border)'
                                                }}
                                                className="hover:border-primary hover:text-primary"
                                            >
                                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
                                                독려 알람
                                            </button>
                                        </td>
                                    )}
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>

            {/* 4. Statistics Small Cards Base */}
            <StatCard
                title="Total Students"
                value={stats.totalStudents}
                icon={<Users size={32} color="var(--primary)" />}
                trend="12%"
                trendUp={true}
            />

            <StatCard
                title="Average Score"
                value={stats.avgScore.toFixed(1)}
                icon={<BarChart3 size={32} color="var(--success)" />}
                color="var(--success)"
                trend={stats.avgScore > 80 ? 'Good' : 'Needs Focus'}
                trendUp={stats.avgScore > 80}
            />

            <ExamListBlock exams={exams} />
        </div>
    );
}
