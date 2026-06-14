"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Exam, Attempt } from "@/types/omr";
import StatCard from "@/components/dashboard/StatCard";
import { toast } from "@/components/Toast";
import { loadAttempts, loadExam } from "@/lib/omrPersistence";
import { formatKoreanDateTime } from "@/lib/pure";

type SortKey = "name" | "percent" | "finishedAt";
type SortDir = "asc" | "desc";

function percent(a: Attempt): number {
    if (!a.totalScore || a.totalScore <= 0) return 0;
    return (a.score / a.totalScore) * 100;
}

function csvEscape(val: string | number): string {
    const s = String(val ?? "");
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
        return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
}

export default function ExamDetailPage() {
    const params = useParams();
    const router = useRouter();
    const id = params?.id as string;

    const [exam, setExam] = useState<Exam | null>(null);
    const [attempts, setAttempts] = useState<Attempt[]>([]);
    const [sortKey, setSortKey] = useState<SortKey>("finishedAt");
    const [sortDir, setSortDir] = useState<SortDir>("desc");

    useEffect(() => {
        if (!id) return;

        let cancelled = false;
        const loadDetail = async () => {
            const [loadedExam, loadedAttempts] = await Promise.all([
                loadExam(id),
                loadAttempts(),
            ]);
            if (cancelled) return;
            if (loadedExam) setExam(loadedExam);
            setAttempts(loadedAttempts.items.filter(a => a.examId === id));
        };

        void loadDetail();
        return () => { cancelled = true; };
    }, [id]);

    // Correct avg: percent-based, not raw score.
    const stats = useMemo(() => {
        if (attempts.length === 0) {
            return { avgPct: 0, maxPct: 0, submitCount: 0 };
        }
        const percents = attempts.map(percent);
        const avg = percents.reduce((s, v) => s + v, 0) / percents.length;
        const max = Math.max(...percents);
        return {
            avgPct: Math.round(avg * 10) / 10,
            maxPct: Math.round(max * 10) / 10,
            submitCount: attempts.length,
        };
    }, [attempts]);

    const sortedAttempts = useMemo(() => {
        const arr = [...attempts];
        const mult = sortDir === "asc" ? 1 : -1;
        arr.sort((a, b) => {
            if (sortKey === "name") {
                return (a.studentName || "").localeCompare(b.studentName || "", "ko") * mult;
            }
            if (sortKey === "percent") {
                return (percent(a) - percent(b)) * mult;
            }
            // finishedAt
            return (new Date(a.finishedAt).getTime() - new Date(b.finishedAt).getTime()) * mult;
        });
        return arr;
    }, [attempts, sortKey, sortDir]);

    const handleSort = (key: SortKey) => {
        if (key === sortKey) {
            setSortDir(d => (d === "asc" ? "desc" : "asc"));
        } else {
            setSortKey(key);
            setSortDir(key === "name" ? "asc" : "desc");
        }
    };

    const handleExportCSV = () => {
        if (sortedAttempts.length === 0) {
            toast.info("내보낼 제출이 없습니다.");
            return;
        }
        const header = ["name", "score", "total", "percent", "finishedAt", "fociLostCount"];
        const rows = sortedAttempts.map(a => [
            a.studentName || "Anonymous",
            a.score,
            a.totalScore,
            (Math.round(percent(a) * 10) / 10).toString(),
            a.finishedAt,
            a.tabFociLostCount ?? 0,
        ].map(csvEscape).join(","));
        const csv = [header.join(","), ...rows].join("\n");
        // BOM for Excel-friendly Korean.
        const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        const safeTitle = (exam?.title || "exam").replace(/[^a-zA-Z0-9가-힣_\-]/g, "_");
        link.download = `${safeTitle}_attempts.csv`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        toast.success("CSV 내보내기 완료", `${sortedAttempts.length}건`);
    };

    if (!exam) return <div style={{ padding: '2rem' }}>Loading...</div>;

    const sortIndicator = (key: SortKey) => {
        if (sortKey !== key) return "";
        return sortDir === "asc" ? " ↑" : " ↓";
    };

    return (
        <div className="layout-main" style={{ background: '#f8fafc', minHeight: '100vh' }}>
            <header className="header" style={{ borderBottom: '1px solid var(--border)' }}>
                <div className="container header-content">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                        <button onClick={() => router.back()} style={{ fontSize: '1.2rem' }}>←</button>
                        <span style={{ fontWeight: 700 }}>{exam.title}</span>
                    </div>
                </div>
            </header>

            <main className="container animate-fade-in" style={{ padding: '2rem 1rem' }}>

                {/* Stats Row */}
                <div className="bento-grid" style={{ marginBottom: '2rem', gridTemplateColumns: 'repeat(3, 1fr)', gridAutoRows: 'auto' }}>
                    <StatCard title="Submissions" value={stats.submitCount} icon={<span>📝</span>} />
                    <StatCard title="Average %" value={`${stats.avgPct}%`} icon={<span>📊</span>} color="var(--primary)" />
                    <StatCard title="Highest %" value={`${stats.maxPct}%`} icon={<span>🏆</span>} color="var(--warning)" />
                </div>

                {/* Students Table */}
                <div className="bento-card" style={{ padding: '0', overflow: 'hidden' }}>
                    <div style={{
                        padding: '1.25rem 1.5rem', borderBottom: '1px solid var(--border)',
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem',
                    }}>
                        <h3 style={{ fontSize: '1.1rem', fontWeight: 700 }}>Student Results</h3>
                        <button
                            onClick={handleExportCSV}
                            className="btn btn-secondary"
                            style={{ fontSize: '0.85rem', padding: '0.4rem 0.9rem' }}
                            disabled={attempts.length === 0}
                        >
                            CSV 내보내기
                        </button>
                    </div>

                    <div style={{ overflowX: 'auto' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
                            <thead style={{ background: '#f8fafc', borderBottom: '1px solid var(--border)' }}>
                                <tr>
                                    <th
                                        onClick={() => handleSort("name")}
                                        style={{ padding: '1rem', textAlign: 'left', color: 'var(--muted)', cursor: 'pointer', userSelect: 'none' }}
                                    >
                                        Student{sortIndicator("name")}
                                    </th>
                                    <th
                                        onClick={() => handleSort("percent")}
                                        style={{ padding: '1rem', textAlign: 'left', color: 'var(--muted)', cursor: 'pointer', userSelect: 'none' }}
                                    >
                                        Score{sortIndicator("percent")}
                                    </th>
                                    <th
                                        onClick={() => handleSort("finishedAt")}
                                        style={{ padding: '1rem', textAlign: 'left', color: 'var(--muted)', cursor: 'pointer', userSelect: 'none' }}
                                    >
                                        Time{sortIndicator("finishedAt")}
                                    </th>
                                    <th style={{ padding: '1rem', textAlign: 'left', color: 'var(--muted)' }}>Status</th>
                                    <th style={{ padding: '1rem', textAlign: 'left', color: 'var(--muted)' }}>집중도/이탈</th>
                                    <th style={{ padding: '1rem', textAlign: 'right', color: 'var(--muted)' }}>Action</th>
                                </tr>
                            </thead>
                            <tbody>
                                {sortedAttempts.length === 0 ? (
                                    <tr>
                                        <td colSpan={6} style={{ padding: '3rem', textAlign: 'center', color: 'var(--muted)' }}>
                                            <div style={{ fontWeight: 600, marginBottom: '0.4rem' }}>아직 제출된 답안이 없습니다.</div>
                                            <div style={{ fontSize: '0.85rem' }}>학생이 시험을 제출하면 여기에 나타납니다.</div>
                                        </td>
                                    </tr>
                                ) : (
                                    sortedAttempts.map(attempt => {
                                        const p = percent(attempt);
                                        return (
                                            <tr key={attempt.id} style={{ borderBottom: '1px solid var(--border)' }}>
                                                <td style={{ padding: '1rem', fontWeight: 600 }}>{attempt.studentName || 'Anonymous'}</td>
                                                <td style={{ padding: '1rem' }}>
                                                    <span style={{ fontWeight: 700, color: 'var(--foreground)' }}>{Math.round(p * 10) / 10}%</span>
                                                    <span style={{ color: 'var(--muted)', fontSize: '0.8rem' }}> ({attempt.score}/{attempt.totalScore})</span>
                                                </td>
                                                <td style={{ padding: '1rem', color: 'var(--muted)' }}>
                                                    {formatKoreanDateTime(attempt.finishedAt)}
                                                </td>
                                                <td style={{ padding: '1rem' }}>
                                                    <span style={{
                                                        padding: '2px 8px', borderRadius: '4px', fontSize: '0.8rem', fontWeight: 600,
                                                        background: '#dcfce7', color: '#166534'
                                                    }}>
                                                        Completed
                                                    </span>
                                                </td>
                                                <td style={{ padding: '1rem' }}>
                                                    {attempt.tabFociLostCount && attempt.tabFociLostCount > 0 ? (
                                                        <span style={{
                                                            padding: '2px 8px', borderRadius: '4px', fontSize: '0.8rem', fontWeight: 600,
                                                            background: '#fee2e2', color: '#991b1b', display: 'inline-flex', alignItems: 'center', gap: '4px'
                                                        }}>
                                                            ⚠️ {attempt.tabFociLostCount}회 이탈
                                                        </span>
                                                    ) : (
                                                        <span style={{
                                                            padding: '2px 8px', borderRadius: '4px', fontSize: '0.8rem', fontWeight: 600,
                                                            background: '#f1f5f9', color: '#475569'
                                                        }}>
                                                            정상 (0회)
                                                        </span>
                                                    )}
                                                </td>
                                                <td style={{ padding: '1rem', textAlign: 'right' }}>
                                                    <Link
                                                        href={`/teacher/attempt/${attempt.id}`}
                                                        className="btn btn-secondary"
                                                        style={{ padding: '0.3rem 0.8rem', fontSize: '0.8rem' }}
                                                    >
                                                        {attempt.handwritingArchived ? "필기 보기" : "OMR 보기"}
                                                    </Link>
                                                </td>
                                            </tr>
                                        );
                                    })
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>

            </main>
        </div>
    );
}
