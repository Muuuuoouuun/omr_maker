"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Attempt } from "@/types/omr";

type PeriodFilter = "all" | "30d" | "7d";
type SortMode = "recent" | "high" | "low";

const PAGE_SIZE = 10;

function pct(a: Attempt): number {
    if (!a.totalScore || a.totalScore <= 0) return 0;
    return (a.score / a.totalScore) * 100;
}

function badgeForPct(p: number): { bg: string; color: string } {
    if (p >= 80) return { bg: '#dcfce7', color: '#15803d' };
    if (p >= 60) return { bg: '#fef9c3', color: '#a16207' };
    return { bg: '#fee2e2', color: '#b91c1c' };
}

export default function HistoryPage() {
    const [attempts, setAttempts] = useState<Attempt[]>([]);
    const [period, setPeriod] = useState<PeriodFilter>("all");
    const [sortMode, setSortMode] = useState<SortMode>("recent");
    const [page, setPage] = useState(1);

    useEffect(() => {
        const data = localStorage.getItem('omr_attempts');
        if (data) {
            try {
                const parsed = JSON.parse(data);
                // eslint-disable-next-line react-hooks/set-state-in-effect
                setAttempts(parsed);
            } catch (e) {
                console.error("Failed to load history", e);
            }
        }
    }, []);

    // Summary uses all attempts regardless of filters.
    const summary = useMemo(() => {
        if (attempts.length === 0) {
            return { total: 0, avgPct: 0, bestPct: 0, trend: [] as number[] };
        }
        const pcts = attempts.map(pct);
        const avg = pcts.reduce((s, v) => s + v, 0) / pcts.length;
        const best = Math.max(...pcts);
        const sortedByDate = [...attempts].sort(
            (a, b) => new Date(b.finishedAt).getTime() - new Date(a.finishedAt).getTime()
        );
        const trend = sortedByDate.slice(0, 3).map(pct);
        return {
            total: attempts.length,
            avgPct: Math.round(avg),
            bestPct: Math.round(best),
            trend: trend.map(v => Math.round(v)),
        };
    }, [attempts]);

    // Apply period filter + sort.
    const visibleAttempts = useMemo(() => {
        const now = Date.now();
        const cutoff =
            period === "7d" ? now - 7 * 24 * 60 * 60 * 1000
                : period === "30d" ? now - 30 * 24 * 60 * 60 * 1000
                    : 0;
        const filtered = attempts.filter(a =>
            cutoff === 0 || new Date(a.finishedAt).getTime() >= cutoff
        );
        const sorted = [...filtered];
        if (sortMode === "recent") {
            sorted.sort((a, b) => new Date(b.finishedAt).getTime() - new Date(a.finishedAt).getTime());
        } else if (sortMode === "high") {
            sorted.sort((a, b) => pct(b) - pct(a));
        } else {
            sorted.sort((a, b) => pct(a) - pct(b));
        }
        return sorted;
    }, [attempts, period, sortMode]);

    // Reset pagination when filters change.
    useEffect(() => {
        setPage(1);
    }, [period, sortMode]);

    const totalPages = Math.max(1, Math.ceil(visibleAttempts.length / PAGE_SIZE));
    const pageItems = visibleAttempts.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

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
                <h1 style={{ fontSize: '1.8rem', fontWeight: 700, marginBottom: '1.5rem', color: '#1e293b' }}>
                    내 시험 기록
                </h1>

                {attempts.length === 0 ? (
                    <div style={{ textAlign: 'center', padding: '4rem', color: '#64748b', background: 'white', borderRadius: '12px', boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1)' }}>
                        <p style={{ fontSize: '1.2rem' }}>아직 응시한 시험이 없습니다.</p>
                        <Link href="/" className="btn btn-primary" style={{ marginTop: '1.5rem', display: 'inline-block' }}>
                            시험 응시하러 가기
                        </Link>
                    </div>
                ) : (
                    <>
                        {/* Summary row */}
                        <div style={{
                            display: 'grid',
                            gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                            gap: '0.9rem',
                            marginBottom: '1.5rem',
                        }}>
                            <div className="bento-card" style={{ padding: '1rem 1.1rem', background: 'white', borderRadius: '12px', border: '1px solid #e2e8f0' }}>
                                <div style={{ fontSize: '0.75rem', color: '#64748b', fontWeight: 600, marginBottom: '0.25rem' }}>총 응시</div>
                                <div style={{ fontSize: '1.5rem', fontWeight: 800, color: '#0f172a' }}>{summary.total}회</div>
                            </div>
                            <div className="bento-card" style={{ padding: '1rem 1.1rem', background: 'white', borderRadius: '12px', border: '1px solid #e2e8f0' }}>
                                <div style={{ fontSize: '0.75rem', color: '#64748b', fontWeight: 600, marginBottom: '0.25rem' }}>평균 점수</div>
                                <div style={{ fontSize: '1.5rem', fontWeight: 800, color: 'var(--primary)' }}>{summary.avgPct}%</div>
                            </div>
                            <div className="bento-card" style={{ padding: '1rem 1.1rem', background: 'white', borderRadius: '12px', border: '1px solid #e2e8f0' }}>
                                <div style={{ fontSize: '0.75rem', color: '#64748b', fontWeight: 600, marginBottom: '0.25rem' }}>최고 점수</div>
                                <div style={{ fontSize: '1.5rem', fontWeight: 800, color: '#16a34a' }}>{summary.bestPct}%</div>
                            </div>
                            <div className="bento-card" style={{ padding: '1rem 1.1rem', background: 'white', borderRadius: '12px', border: '1px solid #e2e8f0' }}>
                                <div style={{ fontSize: '0.75rem', color: '#64748b', fontWeight: 600, marginBottom: '0.25rem' }}>최근 추이 (최근 3회)</div>
                                <div style={{ fontSize: '0.95rem', fontWeight: 700, color: '#0f172a' }}>
                                    {summary.trend.length > 0
                                        ? summary.trend.map(v => `${v}%`).join(' → ')
                                        : '-'}
                                </div>
                            </div>
                        </div>

                        {/* Filter controls */}
                        <div style={{
                            background: 'white', padding: '0.85rem 1rem',
                            borderRadius: '12px', border: '1px solid #e2e8f0',
                            display: 'flex', flexWrap: 'wrap', gap: '1rem',
                            alignItems: 'center', marginBottom: '1rem',
                        }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                <label style={{ fontSize: '0.8rem', fontWeight: 600, color: '#64748b' }}>기간</label>
                                <select
                                    value={period}
                                    onChange={(e) => setPeriod(e.target.value as PeriodFilter)}
                                    style={{
                                        padding: '0.4rem 0.6rem', borderRadius: '8px',
                                        border: '1px solid #e2e8f0', fontSize: '0.85rem', background: 'white',
                                    }}
                                >
                                    <option value="all">전체</option>
                                    <option value="30d">최근 30일</option>
                                    <option value="7d">최근 7일</option>
                                </select>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                <label style={{ fontSize: '0.8rem', fontWeight: 600, color: '#64748b' }}>정렬</label>
                                <select
                                    value={sortMode}
                                    onChange={(e) => setSortMode(e.target.value as SortMode)}
                                    style={{
                                        padding: '0.4rem 0.6rem', borderRadius: '8px',
                                        border: '1px solid #e2e8f0', fontSize: '0.85rem', background: 'white',
                                    }}
                                >
                                    <option value="recent">최신순</option>
                                    <option value="high">점수 높은순</option>
                                    <option value="low">점수 낮은순</option>
                                </select>
                            </div>
                            <div style={{ marginLeft: 'auto', fontSize: '0.8rem', color: '#94a3b8' }}>
                                총 {visibleAttempts.length}건
                            </div>
                        </div>

                        {visibleAttempts.length === 0 ? (
                            <div style={{ textAlign: 'center', padding: '3rem', color: '#64748b', background: 'white', borderRadius: '12px', border: '1px solid #e2e8f0' }}>
                                선택한 기간에 해당하는 응시 기록이 없습니다.
                            </div>
                        ) : (
                            <div style={{ display: 'grid', gap: '1rem' }}>
                                {pageItems.map((attempt) => {
                                    const p = pct(attempt);
                                    const badge = badgeForPct(p);
                                    return (
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
                                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.5rem', gap: '0.75rem' }}>
                                                <h3 style={{ fontSize: '1.1rem', fontWeight: 600, color: '#0f172a' }}>{attempt.examTitle}</h3>
                                                <span
                                                    className="badge"
                                                    style={{
                                                        padding: '0.2rem 0.6rem', borderRadius: '999px',
                                                        fontSize: '0.8rem', fontWeight: 700,
                                                        background: badge.bg, color: badge.color,
                                                        whiteSpace: 'nowrap',
                                                    }}
                                                >
                                                    {Math.round(p)}%
                                                </span>
                                            </div>
                                            <div style={{ color: '#64748b', fontSize: '0.9rem', display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                                                <span>응시일: {new Date(attempt.finishedAt).toLocaleString()}</span>
                                                <span style={{ color: '#94a3b8' }}>·</span>
                                                <span>{attempt.score} / {attempt.totalScore} 점</span>
                                            </div>
                                        </Link>
                                    );
                                })}
                            </div>
                        )}

                        {/* Pagination (only if >= 10 total filtered attempts) */}
                        {visibleAttempts.length >= PAGE_SIZE && totalPages > 1 && (
                            <div style={{
                                marginTop: '1.5rem', display: 'flex', justifyContent: 'center',
                                alignItems: 'center', gap: '0.75rem',
                            }}>
                                <button
                                    className="btn btn-secondary"
                                    disabled={page <= 1}
                                    onClick={() => setPage(p => Math.max(1, p - 1))}
                                    style={{ fontSize: '0.85rem', opacity: page <= 1 ? 0.5 : 1 }}
                                >
                                    이전
                                </button>
                                <span style={{ fontSize: '0.9rem', color: '#475569', fontWeight: 600 }}>
                                    {page} / {totalPages}
                                </span>
                                <button
                                    className="btn btn-secondary"
                                    disabled={page >= totalPages}
                                    onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                                    style={{ fontSize: '0.85rem', opacity: page >= totalPages ? 0.5 : 1 }}
                                >
                                    다음
                                </button>
                            </div>
                        )}
                    </>
                )}
            </main>
        </div>
    );
}
