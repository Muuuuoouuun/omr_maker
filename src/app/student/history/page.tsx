"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Attempt } from "@/types/omr";

export default function HistoryPage() {
    const [attempts, setAttempts] = useState<Attempt[]>([]);

    useEffect(() => {
        const data = localStorage.getItem('omr_attempts');
        if (data) {
            try {
                const parsed = JSON.parse(data);
                // Sort by latest first
                parsed.sort((a: Attempt, b: Attempt) => new Date(b.finishedAt).getTime() - new Date(a.finishedAt).getTime());
                setAttempts(parsed);
            } catch (e) {
                console.error("Failed to load history", e);
            }
        }
    }, []);

    return (
        <div className="layout-main" style={{ minHeight: '100vh', background: '#f8fafc' }}>
            <header className="header" style={{ background: 'white', borderBottom: '1px solid #e2e8f0' }}>
                <div className="container header-content">
                    <Link href="/" className="logo">OMR Maker</Link>
                    <nav>
                        <Link href="/student/history" className="nav-link" style={{ fontWeight: 'bold', color: 'var(--primary)' }}>
                            내 시험 기록
                        </Link>
                    </nav>
                </div>
            </header>

            <main className="container" style={{ padding: '2rem 1rem' }}>
                <h1 style={{ fontSize: '1.8rem', fontWeight: 700, marginBottom: '2rem', color: '#1e293b' }}>
                    📋 내 시험 기록
                </h1>

                {attempts.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: '4rem', color: '#64748b', background: 'white', borderRadius: '12px', boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1)' }}>
                        <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>📭</div>
                        <p style={{ fontSize: '1.2rem' }}>아직 응시한 시험이 없습니다.</p>
                        <Link href="/" className="btn btn-primary" style={{ marginTop: '1.5rem', display: 'inline-block' }}>
                            시험 응시하러 가기
                        </Link>
                    </div>
                ) : (
                    <div style={{ display: 'grid', gap: '1rem' }}>
                        {attempts.map((attempt) => (
                            <Link
                                key={attempt.id}
                                href={`/student/review/${attempt.id}`}
                                style={{
                                    textDecoration: 'none', color: 'inherit',
                                    display: 'block',
                                    background: 'white',
                                    padding: '1.5rem',
                                    borderRadius: '12px',
                                    border: '1px solid #e2e8f0',
                                    boxShadow: '0 2px 4px rgba(0,0,0,0.05)',
                                    transition: 'transform 0.2s',
                                    cursor: 'pointer'
                                }}
                                className="history-card"
                            >
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.5rem' }}>
                                    <h3 style={{ fontSize: '1.1rem', fontWeight: 600, color: '#0f172a' }}>{attempt.examTitle}</h3>
                                    <span style={{
                                        padding: '0.2rem 0.6rem', borderRadius: '999px', fontSize: '0.8rem', fontWeight: 600,
                                        background: attempt.score / attempt.totalScore >= 0.8 ? '#dcfce7' : attempt.score / attempt.totalScore >= 0.5 ? '#fef9c3' : '#fee2e2',
                                        color: attempt.score / attempt.totalScore >= 0.8 ? '#15803d' : attempt.score / attempt.totalScore >= 0.5 ? '#a16207' : '#b91c1c'
                                    }}>
                                        {attempt.score} / {attempt.totalScore} 점
                                    </span>
                                </div>
                                <div style={{ color: '#64748b', fontSize: '0.9rem' }}>
                                    응시일: {new Date(attempt.finishedAt).toLocaleString()}
                                </div>
                            </Link>
                        ))}
                    </div>
                )}
            </main>
        </div>
    );
}
