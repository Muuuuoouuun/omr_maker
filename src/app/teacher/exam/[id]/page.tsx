"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { BookOpen, PenLine } from "lucide-react";
import { Exam, Attempt } from "@/types/omr";
import StatCard from "@/components/dashboard/StatCard";
import { toast } from "@/components/Toast";
import { loadAttempts, loadExam } from "@/lib/omrPersistence";
import { formatKoreanDateTime } from "@/lib/pure";
import { resolveAttemptScore, type ResolvedAttemptScore } from "@/lib/attemptScores";
import { serializeCsvRows } from "@/lib/csv";
import { getAttemptQuestionResults } from "@/lib/premiumAnalytics";

type SortKey = "name" | "percent" | "finishedAt";
type SortDir = "asc" | "desc";

interface AttemptTableSummary {
    score: ResolvedAttemptScore;
    correctCount: number;
    wrongCount: number;
    unansweredCount: number;
    ungradedCount: number;
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

    const attemptSummaryById = useMemo(() => {
        const summaries = new Map<string, AttemptTableSummary>();
        if (!exam) return summaries;

        for (const attempt of attempts) {
            const score = resolveAttemptScore(attempt, exam);
            const counts = getAttemptQuestionResults(exam, attempt).reduce((acc, result) => {
                if (result.status === "correct") acc.correctCount += 1;
                if (result.status === "wrong") acc.wrongCount += 1;
                if (result.status === "unanswered") acc.unansweredCount += 1;
                if (result.status === "ungraded") acc.ungradedCount += 1;
                return acc;
            }, { correctCount: 0, wrongCount: 0, unansweredCount: 0, ungradedCount: 0 });
            summaries.set(attempt.id, { score, ...counts });
        }

        return summaries;
    }, [attempts, exam]);

    const baseAttempts = useMemo(() => attempts.filter(attempt => !attempt.retake), [attempts]);
    const retakeAttempts = useMemo(() => attempts.filter(attempt => !!attempt.retake), [attempts]);

    // Correct avg: percent-based, not raw score. Retakes stay visible, but don't skew original exam stats.
    const stats = useMemo(() => {
        if (baseAttempts.length === 0) {
            return { avgPct: 0, maxPct: 0, submitCount: 0 };
        }
        const percents = baseAttempts.map(attempt => attemptSummaryById.get(attempt.id)?.score.scorePercent ?? 0);
        const avg = percents.reduce((s, v) => s + v, 0) / percents.length;
        const max = Math.max(...percents);
        return {
            avgPct: Math.round(avg * 10) / 10,
            maxPct: Math.round(max * 10) / 10,
            submitCount: baseAttempts.length,
        };
    }, [attemptSummaryById, baseAttempts]);

    const explanationStats = useMemo(() => {
        if (!exam) return { written: 0, total: 0, missingNumbers: [] as number[] };
        const missingNumbers = exam.questions
            .filter(question => !question.explanation?.trim())
            .map(question => question.number)
            .sort((a, b) => a - b);
        return {
            written: exam.questions.length - missingNumbers.length,
            total: exam.questions.length,
            missingNumbers,
        };
    }, [exam]);

    const sortedAttempts = useMemo(() => {
        const arr = [...attempts];
        const mult = sortDir === "asc" ? 1 : -1;
        arr.sort((a, b) => {
            if (sortKey === "name") {
                return (a.studentName || "").localeCompare(b.studentName || "", "ko") * mult;
            }
            if (sortKey === "percent") {
                return ((attemptSummaryById.get(a.id)?.score.scorePercent ?? 0) - (attemptSummaryById.get(b.id)?.score.scorePercent ?? 0)) * mult;
            }
            // finishedAt
            return (new Date(a.finishedAt).getTime() - new Date(b.finishedAt).getTime()) * mult;
        });
        return arr;
    }, [attempts, sortKey, sortDir, attemptSummaryById]);

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
        const rows = sortedAttempts.map(a => {
            const summary = attemptSummaryById.get(a.id);
            const score = summary?.score ?? resolveAttemptScore(a, exam);
            return [
                a.studentName || "Anonymous",
                a.retake ? "retake" : "original",
                a.retake?.sourceAttemptId || "",
                a.retake?.questionIds.length || 0,
                score.earnedScore,
                score.totalScore,
                (Math.round(score.scorePercent * 10) / 10).toString(),
                summary?.correctCount ?? 0,
                summary?.wrongCount ?? 0,
                summary?.unansweredCount ?? 0,
                score.source,
                a.finishedAt,
                a.tabFociLostCount ?? 0,
            ];
        });
        const csv = serializeCsvRows([
            ["name", "attemptKind", "retakeSourceAttemptId", "retakeQuestionCount", "score", "total", "percent", "correctCount", "wrongCount", "unansweredCount", "scoreSource", "finishedAt", "fociLostCount"],
            ...rows,
        ]);
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
                <div className="bento-grid" style={{ marginBottom: '2rem', gridTemplateColumns: 'repeat(4, 1fr)', gridAutoRows: 'auto' }}>
                    <StatCard title="원시험 제출" value={stats.submitCount} icon={<span>📝</span>} />
                    <StatCard title="원시험 평균" value={`${stats.avgPct}%`} icon={<span>📊</span>} color="var(--primary)" />
                    <StatCard title="원시험 최고" value={`${stats.maxPct}%`} icon={<span>🏆</span>} color="var(--warning)" />
                    <StatCard title="재시험 제출" value={retakeAttempts.length} icon={<span>↻</span>} color="#0f766e" />
                </div>

                <section className="bento-card" style={{
                    marginBottom: '1.25rem',
                    padding: '1.15rem 1.25rem',
                    display: 'grid',
                    gridTemplateColumns: 'minmax(0, 1fr) auto',
                    gap: '1rem',
                    alignItems: 'center'
                }}>
                    <div style={{ minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', color: '#0f172a', fontWeight: 900, marginBottom: '0.35rem' }}>
                            <BookOpen size={18} />
                            학생 공개 해설
                        </div>
                        <div style={{ color: '#475569', fontSize: '0.88rem', fontWeight: 700 }}>
                            {explanationStats.written}/{explanationStats.total}문항 작성됨
                            {explanationStats.missingNumbers.length > 0 && (
                                <span style={{ color: '#64748b', fontWeight: 600 }}>
                                    {' '}· 미작성 {explanationStats.missingNumbers.slice(0, 8).join(', ')}번
                                    {explanationStats.missingNumbers.length > 8 ? ` 외 ${explanationStats.missingNumbers.length - 8}문항` : ''}
                                </span>
                            )}
                        </div>
                        <div style={{ marginTop: '0.7rem', height: 8, borderRadius: 999, background: '#e2e8f0', overflow: 'hidden' }}>
                            <div style={{
                                width: `${explanationStats.total > 0 ? Math.round((explanationStats.written / explanationStats.total) * 100) : 0}%`,
                                height: '100%',
                                borderRadius: 999,
                                background: 'linear-gradient(135deg, var(--primary), var(--primary-dark))'
                            }} />
                        </div>
                    </div>
                    <Link
                        href={`/create?edit=${exam.id}`}
                        className="btn btn-primary"
                        style={{ fontSize: '0.85rem', padding: '0.5rem 0.95rem', display: 'inline-flex', alignItems: 'center', gap: '0.4rem', whiteSpace: 'nowrap' }}
                    >
                        <PenLine size={15} />
                        해설 작성
                    </Link>
                </section>

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
                                        const summary = attemptSummaryById.get(attempt.id);
                                        const score = summary?.score ?? resolveAttemptScore(attempt, exam);
                                        const p = score.scorePercent;
                                        return (
                                            <tr key={attempt.id} style={{ borderBottom: '1px solid var(--border)' }}>
                                                <td style={{ padding: '1rem', fontWeight: 600 }}>
                                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', flexWrap: 'wrap' }}>
                                                        <span>{attempt.studentName || 'Anonymous'}</span>
                                                        {attempt.retake && (
                                                            <span style={{
                                                                padding: '0.16rem 0.45rem',
                                                                borderRadius: '999px',
                                                                background: '#f0fdfa',
                                                                color: '#0f766e',
                                                                border: '1px solid #99f6e4',
                                                                fontSize: '0.72rem',
                                                                fontWeight: 800,
                                                                whiteSpace: 'nowrap',
                                                            }}>
                                                                재시험 {attempt.retake.questionIds.length}문항
                                                            </span>
                                                        )}
                                                    </div>
                                                </td>
                                                <td style={{ padding: '1rem' }}>
                                                    <span style={{ fontWeight: 700, color: 'var(--foreground)' }}>{Math.round(p * 10) / 10}%</span>
                                                    <span style={{ color: 'var(--muted)', fontSize: '0.8rem' }}> ({score.earnedScore}/{score.totalScore})</span>
                                                </td>
                                                <td style={{ padding: '1rem', color: 'var(--muted)' }}>
                                                    {formatKoreanDateTime(attempt.finishedAt)}
                                                </td>
                                                <td style={{ padding: '1rem' }}>
                                                    <span style={{
                                                        padding: '2px 8px', borderRadius: '4px', fontSize: '0.8rem', fontWeight: 600,
                                                        background: summary && (summary.wrongCount > 0 || summary.unansweredCount > 0) ? '#fef2f2' : '#dcfce7',
                                                        color: summary && (summary.wrongCount > 0 || summary.unansweredCount > 0) ? '#991b1b' : '#166534'
                                                    }}>
                                                        {summary
                                                            ? `정 ${summary.correctCount} · 오 ${summary.wrongCount} · 미 ${summary.unansweredCount}`
                                                            : "Completed"}
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
