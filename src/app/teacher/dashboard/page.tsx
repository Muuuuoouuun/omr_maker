"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Exam, Attempt } from "@/types/omr";
import StatCard from "@/components/dashboard/StatCard";
import TrendChart from "@/components/dashboard/TrendChart";
import ExamListBlock from "@/components/dashboard/ExamListBlock";

export default function TeacherDashboard() {
    const [exams, setExams] = useState<Exam[]>([]);
    const [attempts, setAttempts] = useState<Attempt[]>([]);
    const [stats, setStats] = useState({
        totalStudents: 0,
        avgScore: 0,
        activeExams: 0
    });
    const [trendData, setTrendData] = useState<number[]>([]);

    useEffect(() => {
        // Load Data
        const loadedExams: Exam[] = [];
        const loadedAttempts: Attempt[] = [];

        // Scan localStorage for exams
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key?.startsWith("omr_exam_")) {
                try {
                    const val = JSON.parse(localStorage.getItem(key) || "");
                    loadedExams.push(val);
                } catch (e) { }
            }
        }
        // Load attempts
        const attemptsStr = localStorage.getItem("omr_attempts");
        if (attemptsStr) {
            try {
                loadedAttempts.push(...JSON.parse(attemptsStr));
            } catch (e) { }
        }

        // Sort exams by date
        loadedExams.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        setExams(loadedExams);
        setAttempts(loadedAttempts);

        // Calculate Stats
        const totalScore = loadedAttempts.reduce((acc, curr) => acc + (curr.score / curr.totalScore) * 100, 0);
        const avg = loadedAttempts.length > 0 ? Math.round(totalScore / loadedAttempts.length) : 0;

        setStats({
            totalStudents: new Set(loadedAttempts.map(a => a.studentName + a.id)).size, // Rough unique student count if names were unique
            avgScore: avg,
            activeExams: loadedExams.length
        });

        // Mock/Calculate Trend Data (Last 7 attempts scores)
        // In real app, aggregate by day. Here we just take last 10 scores
        const scores = loadedAttempts
            .sort((a, b) => new Date(a.finishedAt).getTime() - new Date(b.finishedAt).getTime())
            .map(a => Math.round((a.score / a.totalScore) * 100))
            .slice(-10); // Last 10

        // If not enough data, pad with mocks for visual
        if (scores.length < 5) {
            setTrendData([65, 78, 72, 85, 82, 90, avg || 80]);
        } else {
            setTrendData(scores);
        }

    }, []);

    return (
        <div className="layout-main">
            <header className="header">
                <div className="container header-content">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                        <Link href="/" className="logo">OMR Maker</Link>
                        <span style={{
                            fontSize: '0.75rem', fontWeight: 700,
                            background: 'rgba(99, 102, 241, 0.1)', color: 'var(--primary)',
                            padding: '4px 10px', borderRadius: 'var(--radius-full)',
                            border: '1px solid rgba(99, 102, 241, 0.2)'
                        }}>
                            TEACHER
                        </span>
                    </div>
                </div>
            </header>

            <main className="container animate-fade-in" style={{ paddingBottom: '4rem' }}>
                {/* Welcome Section */}
                <div style={{ margin: '3rem 0' }}>
                    <h1 className="title-gradient" style={{ fontSize: '2.5rem', marginBottom: '0.75rem', lineHeight: 1.2 }}>
                        Dashboard
                    </h1>
                    <p className="text-muted" style={{ fontSize: '1.1rem' }}>
                        Review your class performance and manage exams.
                    </p>
                </div>

                {/* Bento Grid */}
                <div className="bento-grid">

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

                        {/* Decorative bloom */}
                        <div style={{ position: 'absolute', top: '-20%', right: '-10%', width: '200px', height: '200px', background: 'radial-gradient(circle, rgba(255,255,255,0.2) 0%, transparent 70%)' }}></div>

                        <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end', width: '100%' }}>
                            <TrendChart data={trendData} color="white" height={140} />
                        </div>
                    </div>

                    {/* 2. Total Students */}
                    <StatCard
                        title="Total Students"
                        value={stats.totalStudents}
                        icon={<span style={{ fontSize: '2rem' }}>👥</span>}
                        trend="12%"
                        trendUp={true}
                    />

                    {/* 3. Average Score */}
                    <StatCard
                        title="Average Score"
                        value={`${stats.avgScore}`}
                        icon={<span style={{ fontSize: '2rem' }}>📊</span>}
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
                            marginBottom: '1rem', fontSize: '2rem', transition: 'all 0.3s'
                        }}>
                            +
                        </div>
                        <span style={{ fontWeight: 600, color: 'var(--primary)', fontSize: '1.1rem' }}>Create New Exam</span>
                    </Link>

                    {/* 5. Recent Exams List */}
                    <ExamListBlock exams={exams} />

                    {/* 6. Recent Activity Feed */}
                    <div className="bento-card col-span-2 row-span-2">
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem' }}>
                            <h3 style={{ fontSize: '1.25rem', fontWeight: 700 }}>Recent Activity</h3>
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
                                            fontSize: '1.2rem', border: '1px solid var(--border)'
                                        }}>
                                            👤
                                        </div>
                                        <div style={{ flex: 1 }}>
                                            <div style={{ fontSize: '0.95rem', marginBottom: '0.2rem' }}>
                                                <span style={{ fontWeight: 600 }}>Student</span> submitted
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
            </main>
        </div>
    );
}
