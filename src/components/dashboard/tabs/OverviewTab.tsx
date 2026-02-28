"use client";

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
}

export default function OverviewTab({ exams, attempts, stats, trendData }: OverviewTabProps) {
    return (
        <div className="bento-grid fade-in-up">
            {/* 1. Score Trend (Main Feature) */}
            <div className="bento-card col-span-2 row-span-1" style={{
                background: 'linear-gradient(135deg, var(--primary), var(--primary-dark))',
                color: 'white', border: 'none',
                position: 'relative', overflow: 'hidden'
            }}>
                <div style={{ marginBottom: '1.5rem', position: 'relative', zIndex: 1 }}>
                    <h3 style={{ fontSize: '1.25rem', fontWeight: 700 }}>Avg. Score Trend</h3>
                    <p style={{ opacity: 0.8, fontSize: '0.95rem' }}>Last 7 exams performance</p>
                </div>

                <div style={{ position: 'absolute', top: '-20%', right: '-10%', width: '200px', height: '200px', background: 'radial-gradient(circle, rgba(255,255,255,0.2) 0%, transparent 70%)' }}></div>

                <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end', width: '100%' }}>
                    <TrendChart data={trendData} color="white" height={140} />
                </div>
            </div>

            {/* 2. Total Students */}
            <StatCard
                title="Total Students"
                value={stats.totalStudents}
                icon={<Users size={32} color="var(--primary)" />}
                trend="12%"
                trendUp={true}
            />

            {/* 3. Average Score */}
            <StatCard
                title="Average Score"
                value={`${stats.avgScore}`}
                icon={<BarChart3 size={32} color="var(--success)" />}
                color="var(--success)"
                trend={stats.avgScore > 80 ? 'Good' : 'Needs Focus'}
                trendUp={stats.avgScore > 80}
            />

            {/* 4. Active Exams */}
            <Link href="/create" className="bento-card col-span-1 card-hover" style={{
                justifyContent: 'center', alignItems: 'center',
                border: '2px dashed var(--border)', boxShadow: 'none',
                background: 'transparent'
            }}>
                <div style={{
                    width: '60px', height: '60px', borderRadius: '50%',
                    background: 'rgba(99, 102, 241, 0.1)', color: 'var(--primary)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    marginBottom: '1rem', transition: 'all 0.3s'
                }}>
                    <PlusCircle size={32} />
                </div>
                <span style={{ fontWeight: 600, color: 'var(--primary)', fontSize: '1.1rem' }}>Create New Exam</span>
            </Link>

            {/* 5. Recent Exams List */}
            <ExamListBlock exams={exams} />

            {/* 6. Recent Activity Feed */}
            <div className="bento-card col-span-2 row-span-2">
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem' }}>
                    <h3 style={{ fontSize: '1.25rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <Activity size={20} color="var(--primary)" />
                        Recent Activity
                    </h3>
                    <button className="text-muted" style={{ fontSize: '0.85rem', fontWeight: 500 }}>View All</button>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0', overflowY: 'auto' }}>
                    {attempts.length === 0 ? (
                        <div style={{ color: 'var(--muted)', textAlign: 'center', padding: '2rem', background: 'var(--background)', borderRadius: 'var(--radius-lg)' }}>
                            No activity yet
                        </div>
                    ) : (
                        attempts.sort((a, b) => new Date(b.finishedAt).getTime() - new Date(a.finishedAt).getTime()).slice(0, 7).map((attempt, idx) => (
                            <div key={idx} style={{
                                display: 'flex', gap: '1rem', alignItems: 'center', padding: '1rem 0',
                                borderBottom: idx !== 6 ? '1px solid var(--border)' : 'none',
                                transition: 'background 0.2s'
                            }}>
                                <div style={{
                                    width: '40px', height: '40px', borderRadius: '50%',
                                    background: 'var(--background)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                                    color: 'var(--text)', border: '1px solid var(--border)'
                                }}>
                                    {attempt.studentName.charAt(0)}
                                </div>
                                <div style={{ flex: 1 }}>
                                    <div style={{ fontSize: '0.95rem', marginBottom: '0.2rem' }}>
                                        <span style={{ fontWeight: 600 }}>{attempt.studentName}</span> submitted
                                        <span style={{ fontWeight: 600, color: 'var(--primary)' }}> {attempt.examTitle}</span>
                                    </div>
                                    <div style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>
                                        {new Date(attempt.finishedAt).toLocaleString()}
                                    </div>
                                </div>
                                <div style={{
                                    fontWeight: 700, fontSize: '1.1rem',
                                    color: (attempt.score / attempt.totalScore) > 0.8 ? 'var(--success)' : 'var(--warning)'
                                }}>
                                    {Math.round((attempt.score / attempt.totalScore) * 100)}점
                                </div>
                            </div>
                        ))
                    )}
                </div>
            </div>
        </div>
    );
}
