"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Activity, ArrowLeft, BarChart2, BookOpen, LoaderCircle, PenLine, RefreshCw, SearchX, Users } from "lucide-react";
import { Exam, Attempt } from "@/types/omr";
import StatusPill from "@/components/dashboard/StatusPill";
import TeacherHeader from "@/components/TeacherHeader";
import { toast } from "@/components/Toast";
import { loadTeacherAttempts } from "@/lib/teacherAttemptClient";
import { loadTeacherExamDetail } from "@/lib/teacherExamClient";
import { formatKoreanDateTime } from "@/lib/pure";
import { resolveAttemptScore, type ResolvedAttemptScore } from "@/lib/attemptScores";
import { serializeCsvRows } from "@/lib/csv";
import { getAttemptQuestionResults } from "@/lib/premiumAnalytics";
import { buildStudentResultHref } from "@/lib/studentResultHub";
import { awaySeverity, resolveAwayCount } from "@/lib/examAwayTracker";
import { buildDemoDashboardData, shouldUseDemoData } from "@/lib/demoData";
import { readTeacherSession } from "@/lib/teacherSession";

type SortKey = "name" | "percent" | "finishedAt";
type SortDir = "asc" | "desc";
type DetailLoadStatus = "loading" | "ready" | "not_found" | "error";

const DETAIL_LOAD_TIMEOUT_MS = 12_000;
const MOBILE_RESULT_BATCH_SIZE = 6;

function withDetailLoadTimeout<T>(operation: Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => {
            reject(new Error("Teacher exam detail load timed out"));
        }, DETAIL_LOAD_TIMEOUT_MS);

        operation.then(
            value => {
                window.clearTimeout(timer);
                resolve(value);
            },
            error => {
                window.clearTimeout(timer);
                reject(error);
            },
        );
    });
}

interface AttemptTableSummary {
    score: ResolvedAttemptScore;
    correctCount: number;
    wrongCount: number;
    unansweredCount: number;
    ungradedCount: number;
}

export default function ExamDetailPage() {
    const params = useParams();
    const id = params?.id as string;

    const [exam, setExam] = useState<Exam | null>(null);
    const [attempts, setAttempts] = useState<Attempt[]>([]);
    const [loadStatus, setLoadStatus] = useState<DetailLoadStatus>("loading");
    const [loadError, setLoadError] = useState("");
    const [retryNonce, setRetryNonce] = useState(0);
    const [sortKey, setSortKey] = useState<SortKey>("finishedAt");
    const [sortDir, setSortDir] = useState<SortDir>("desc");
    const [mobileResultLimit, setMobileResultLimit] = useState(MOBILE_RESULT_BATCH_SIZE);

    useEffect(() => {
        if (!id) return;

        let cancelled = false;
        const loadDetail = async () => {
            setLoadStatus("loading");
            setLoadError("");
            setExam(null);
            setAttempts([]);

            // Showcase exams are deterministic, display-only fixtures. Resolve them
            // only for the active showcase identity and only from the fixture's
            // explicit id allow-list; real teacher reads remain fail-closed.
            if (shouldUseDemoData(readTeacherSession())) {
                const demo = buildDemoDashboardData();
                const demoExam = demo.exams.find(candidate => candidate.id === id);
                if (cancelled) return;
                if (!demoExam) {
                    setLoadStatus("not_found");
                    return;
                }
                setExam(demoExam);
                setAttempts(demo.attempts.filter(attempt => attempt.examId === id));
                setLoadStatus("ready");
                return;
            }

            try {
                const [loadedExamResult, loadedAttempts] = await withDetailLoadTimeout(Promise.all([
                    loadTeacherExamDetail(id),
                    loadTeacherAttempts(),
                ]));
                if (cancelled) return;
                if (loadedExamResult.status === "not_found") {
                    setLoadStatus("not_found");
                    return;
                }
                if (loadedExamResult.status === "unauthorized") {
                    setLoadError("교사 인증을 다시 확인한 뒤 재시도해 주세요.");
                    setLoadStatus("error");
                    return;
                }
                if (loadedExamResult.status === "service_unavailable") {
                    setLoadError("시험 정보를 서버에서 확인하지 못했습니다. 네트워크 상태를 확인한 뒤 다시 시도해 주세요.");
                    setLoadStatus("error");
                    return;
                }
                if (loadedAttempts.remoteError) {
                    setLoadError("제출 기록을 서버에서 확인하지 못했습니다. 빈 제출 목록으로 표시하지 않고 다시 확인이 필요합니다.");
                    setLoadStatus("error");
                    return;
                }
                setExam(loadedExamResult.exam);
                setAttempts(loadedAttempts.items.filter(attempt => attempt.examId === id));
                setLoadStatus("ready");
            } catch (error) {
                if (cancelled) return;
                setLoadError(error instanceof Error && error.message.includes("timed out")
                    ? "응답 시간이 초과되었습니다. 네트워크 상태를 확인한 뒤 다시 시도해 주세요."
                    : "시험 데이터를 안전하게 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.");
                setLoadStatus("error");
            }
        };

        void loadDetail();
        return () => { cancelled = true; };
    }, [id, retryNonce]);

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
        setMobileResultLimit(MOBILE_RESULT_BATCH_SIZE);
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
                resolveAwayCount(a),
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

    const visibleLoadStatus: DetailLoadStatus = id ? loadStatus : "not_found";

    if (visibleLoadStatus === "loading") {
        return (
            <div className="layout-main teacher-exam-detail-page" style={{ minHeight: '100vh' }}>
                <TeacherHeader badge="시험 상세" />
                <main id="main-content" tabIndex={-1} className="container" style={{ padding: '4rem 1rem' }}>
                    <div role="status" aria-live="polite" style={{ display: 'grid', justifyItems: 'center', gap: '0.75rem', color: 'var(--muted)' }}>
                        <LoaderCircle className="animate-spin" size={28} aria-hidden="true" />
                        <strong style={{ color: 'var(--foreground)' }}>시험 정보를 확인하고 있습니다</strong>
                        <span style={{ fontSize: '0.88rem' }}>최대 12초 안에 결과를 안내합니다.</span>
                    </div>
                </main>
            </div>
        );
    }

    if (visibleLoadStatus !== "ready" || !exam) {
        const isNotFound = visibleLoadStatus === "not_found";
        return (
            <div className="layout-main teacher-exam-detail-page" style={{ minHeight: '100vh' }}>
                <TeacherHeader badge="시험 상세" />
                <main id="main-content" tabIndex={-1} className="container" style={{ padding: '4rem 1rem' }}>
                    <section
                        data-testid="exam-detail-unavailable"
                        className="bento-card"
                        style={{ maxWidth: 560, margin: '0 auto', padding: '2.25rem', textAlign: 'center' }}
                    >
                        <SearchX size={34} aria-hidden="true" style={{ color: 'var(--muted)', marginBottom: '0.9rem' }} />
                        <h1 style={{ fontSize: '1.35rem', marginBottom: '0.55rem' }}>
                            {isNotFound ? "시험을 찾을 수 없습니다" : "시험을 불러오지 못했습니다"}
                        </h1>
                        <p style={{ color: 'var(--muted)', lineHeight: 1.65, marginBottom: '1.4rem' }}>
                            {isNotFound
                                ? "삭제되었거나 현재 계정에 연결되지 않은 시험입니다. 대시보드에서 시험 목록을 다시 확인해 주세요."
                                : loadError}
                        </p>
                        <div style={{ display: 'flex', justifyContent: 'center', gap: '0.65rem', flexWrap: 'wrap' }}>
                            <Link href="/teacher/dashboard" className="btn btn-secondary" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
                                <ArrowLeft size={15} /> 대시보드로
                            </Link>
                            <button
                                type="button"
                                className="btn btn-primary"
                                onClick={() => setRetryNonce(value => value + 1)}
                                style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}
                            >
                                <RefreshCw size={15} /> 다시 시도
                            </button>
                        </div>
                    </section>
                </main>
            </div>
        );
    }

    const sortIndicator = (key: SortKey) => {
        if (sortKey !== key) return "";
        return sortDir === "asc" ? " ↑" : " ↓";
    };

    const sortAria = (key: SortKey): "none" | "ascending" | "descending" => {
        if (sortKey !== key) return "none";
        return sortDir === "asc" ? "ascending" : "descending";
    };

    const sortableHeader = (key: SortKey, label: string) => (
        <button
            type="button"
            onClick={() => handleSort(key)}
            style={{
                minHeight: 44,
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.25rem',
                border: 0,
                background: 'transparent',
                color: 'inherit',
                font: 'inherit',
                fontWeight: 700,
                cursor: 'pointer',
            }}
        >
            {label}<span aria-hidden="true">{sortIndicator(key)}</span>
        </button>
    );

    const assignedGroupCount = exam.accessConfig?.type === "group" ? (exam.accessConfig.groupIds?.length || 0) : 0;

    return (
        <div className="layout-main teacher-exam-detail-page" style={{ minHeight: '100vh' }}>
            <TeacherHeader badge="시험 상세" showDashboardLink={false} showLiveLink={false} />

            <div className="teacher-exam-context-bar">
                <div className="container teacher-exam-context-content">
                    <div className="teacher-exam-context-primary">
                        <Link
                            href="/teacher/dashboard"
                            aria-label="대시보드로 돌아가기"
                            className="teacher-exam-context-back"
                        >
                            <ArrowLeft size={14} />
                            <span>대시보드</span>
                        </Link>
                        <div className="teacher-exam-context-copy">
                            <span className="teacher-exam-context-eyebrow">시험 상세</span>
                            <h1 className="teacher-exam-context-title">{exam.title}</h1>
                            {assignedGroupCount > 0 && (
                                <Link
                                    href="/teacher/users?tab=groups"
                                    aria-label="배정된 반 명단 보기"
                                    title="이 시험이 배정된 반 목록을 확인합니다."
                                    className="teacher-exam-context-groups"
                                >
                                    <Users size={13} />
                                    배정 반 {assignedGroupCount}개
                                </Link>
                            )}
                        </div>
                    </div>
                    <div className="teacher-exam-context-actions">
                        <Link
                            href={`/teacher/dashboard?tab=exam&examId=${encodeURIComponent(exam.id)}`}
                            className="btn btn-secondary"
                        >
                            <BarChart2 size={14} />
                            분석 보기
                        </Link>
                        <Link href="/teacher/live" aria-label="실시간 모니터링" className="teacher-exam-live-link">
                            <StatusPill tone="success" icon={<Activity size={14} />} label="실시간" />
                        </Link>
                    </div>
                </div>
            </div>

            <main id="main-content" tabIndex={-1} className="container animate-fade-in" style={{ padding: '2rem 1rem' }}>

                {/* Stats Row */}
                <section className="exam-summary-rail" aria-label="시험 결과 요약">
                    <div><span>원시험 제출</span><strong>{stats.submitCount}</strong></div>
                    <div><span>원시험 평균</span><strong>{stats.avgPct}%</strong></div>
                    <div><span>원시험 최고</span><strong>{stats.maxPct}%</strong></div>
                    <div><span>재시험 제출</span><strong>{retakeAttempts.length}</strong></div>
                </section>

                <div className="teacher-exam-mobile-actions mobile-action-row" role="group" aria-label="시험 상세 작업">
                    <Link
                        href={`/teacher/dashboard?tab=exam&examId=${encodeURIComponent(exam.id)}`}
                        className="btn btn-primary"
                    >
                        <BarChart2 size={14} />
                        분석 보기
                    </Link>
                    <Link href="/teacher/live" aria-label="실시간 모니터링" className="btn btn-secondary">
                        <Activity size={14} />
                        실시간
                    </Link>
                </div>

                <section className="bento-card teacher-exam-explanation-card" style={{
                    marginBottom: '1.25rem',
                    padding: '1.15rem 1.25rem',
                    display: 'grid',
                    gridTemplateColumns: 'minmax(0, 1fr) auto',
                    gap: '1rem',
                    alignItems: 'center'
                }}>
                    <div style={{ minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', color: 'var(--foreground)', fontWeight: 900, marginBottom: '0.35rem' }}>
                            <BookOpen size={18} />
                            학생 공개 해설
                        </div>
                        <div style={{ color: 'var(--muted)', fontSize: '0.88rem', fontWeight: 700 }}>
                            {explanationStats.written}/{explanationStats.total}문항 작성됨
                            {explanationStats.missingNumbers.length > 0 && (
                                <span style={{ color: 'var(--muted)', fontWeight: 600 }}>
                                    {' '}· 미작성 {explanationStats.missingNumbers.slice(0, 8).join(', ')}번
                                    {explanationStats.missingNumbers.length > 8 ? ` 외 ${explanationStats.missingNumbers.length - 8}문항` : ''}
                                </span>
                            )}
                        </div>
                        <div style={{ marginTop: '0.7rem', height: 8, borderRadius: 999, background: 'var(--surface-muted)', overflow: 'hidden' }}>
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
                <section className="bento-card teacher-exam-results" style={{ padding: '0', overflow: 'hidden' }} aria-labelledby="teacher-exam-results-title">
                    <div className="teacher-exam-results-heading" style={{
                        padding: '1.25rem 1.5rem', borderBottom: '1px solid var(--border)',
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem',
                    }}>
                        <div>
                            <h2 id="teacher-exam-results-title" style={{ fontSize: '1.1rem', fontWeight: 700 }}>학생 결과</h2>
                            <p className="teacher-exam-results-count">총 {sortedAttempts.length}건</p>
                        </div>
                        <button
                            onClick={handleExportCSV}
                            className="btn btn-secondary"
                            style={{ fontSize: '0.85rem', padding: '0.4rem 0.9rem' }}
                            disabled={attempts.length === 0}
                        >
                            CSV 내보내기
                        </button>
                    </div>

                    <div className="teacher-exam-results-table" style={{ overflowX: 'auto' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
                            <thead className="teacher-exam-results-table-head" style={{ borderBottom: '1px solid var(--border)' }}>
                                <tr>
                                    <th
                                        aria-sort={sortAria("name")}
                                        style={{ padding: '0.35rem 1rem', textAlign: 'left', color: 'var(--muted)' }}
                                    >
                                        {sortableHeader("name", "학생")}
                                    </th>
                                    <th
                                        aria-sort={sortAria("percent")}
                                        style={{ padding: '0.35rem 1rem', textAlign: 'left', color: 'var(--muted)' }}
                                    >
                                        {sortableHeader("percent", "점수")}
                                    </th>
                                    <th
                                        aria-sort={sortAria("finishedAt")}
                                        style={{ padding: '0.35rem 1rem', textAlign: 'left', color: 'var(--muted)' }}
                                    >
                                        {sortableHeader("finishedAt", "제출 시각")}
                                    </th>
                                    <th style={{ padding: '1rem', textAlign: 'left', color: 'var(--muted)' }}>상태</th>
                                    <th style={{ padding: '1rem', textAlign: 'left', color: 'var(--muted)' }}>집중도/이탈</th>
                                    <th style={{ padding: '1rem', textAlign: 'right', color: 'var(--muted)' }}>작업</th>
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
                                        const awayCount = resolveAwayCount(attempt);
                                        return (
                                            <tr key={attempt.id} style={{ borderBottom: '1px solid var(--border)' }}>
                                                <td style={{ padding: '1rem', fontWeight: 600 }}>
                                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', flexWrap: 'wrap' }}>
                                                        <span>{attempt.studentName || 'Anonymous'}</span>
                                                        {attempt.handwritingArchived && (
                                                            <span className="tone-chip tone-primary" style={{ fontSize: '0.72rem', fontWeight: 800 }}>
                                                                필기 저장됨
                                                            </span>
                                                        )}
                                                        {attempt.retake && (
                                                            <StatusPill
                                                                tone="retake"
                                                                size="sm"
                                                                label={`재시험 ${attempt.retake.questionIds.length}문항`}
                                                            />
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
                                                    <StatusPill
                                                        tone={summary && (summary.wrongCount > 0 || summary.unansweredCount > 0) ? "grade" : "success"}
                                                        size="sm"
                                                        label={summary
                                                            ? `정 ${summary.correctCount} · 오 ${summary.wrongCount} · 미 ${summary.unansweredCount}`
                                                            : "Completed"}
                                                    />
                                                </td>
                                                <td style={{ padding: '1rem' }}>
                                                    {awayCount > 0 ? (
                                                        <span
                                                            className="away-severity-badge"
                                                            data-away-severity={awaySeverity(awayCount)}
                                                        >
                                                            화면 이탈 {awayCount}회
                                                        </span>
                                                    ) : (
                                                        <StatusPill tone="muted" size="sm" label="정상 (0회)" />
                                                    )}
                                                </td>
                                                <td style={{ padding: '1rem', textAlign: 'right' }}>
                                                    <Link
                                                        href={buildStudentResultHref(attempt.id, "answers")}
                                                        className="btn btn-secondary"
                                                        aria-label={`${attempt.studentName || '학생'} 결과 보기`}
                                                        style={{ padding: '0.45rem 0.8rem', fontSize: '0.8rem', minHeight: 44, whiteSpace: 'nowrap' }}
                                                    >
                                                        학생 결과 보기
                                                    </Link>
                                                </td>
                                            </tr>
                                        );
                                    })
                                )}
                            </tbody>
                        </table>
                    </div>

                    <div className="teacher-exam-mobile-results">
                        <label className="teacher-exam-mobile-sort" htmlFor="teacher-exam-mobile-sort">
                            <span>결과 정렬</span>
                            <select
                                id="teacher-exam-mobile-sort"
                                value={sortKey}
                                onChange={event => {
                                    const key = event.target.value as SortKey;
                                    setSortKey(key);
                                    setSortDir(key === "name" ? "asc" : "desc");
                                    setMobileResultLimit(MOBILE_RESULT_BATCH_SIZE);
                                }}
                            >
                                <option value="finishedAt">최근 제출순</option>
                                <option value="percent">높은 점수순</option>
                                <option value="name">이름순</option>
                            </select>
                        </label>

                        {sortedAttempts.length === 0 ? (
                            <div className="teacher-exam-mobile-empty">
                                <strong>아직 제출된 답안이 없습니다.</strong>
                                <span>학생이 시험을 제출하면 여기에 나타납니다.</span>
                            </div>
                        ) : (
                            <ul id="teacher-exam-mobile-result-list" aria-label="학생 결과 목록">
                                {sortedAttempts.slice(0, mobileResultLimit).map(attempt => {
                                    const summary = attemptSummaryById.get(attempt.id);
                                    const score = summary?.score ?? resolveAttemptScore(attempt, exam);
                                    const awayCount = resolveAwayCount(attempt);
                                    const studentName = attempt.studentName || "Anonymous";
                                    return (
                                        <li key={attempt.id} data-testid="teacher-exam-mobile-result-card">
                                            <div className="teacher-exam-mobile-result-primary">
                                                <div className="teacher-exam-mobile-result-name">
                                                    <strong>{studentName}</strong>
                                                    <span>{formatKoreanDateTime(attempt.finishedAt)}</span>
                                                </div>
                                                <div className="teacher-exam-mobile-result-score">
                                                    <strong>{Math.round(score.scorePercent * 10) / 10}%</strong>
                                                    <span>{score.earnedScore}/{score.totalScore}</span>
                                                </div>
                                            </div>
                                            <div className="teacher-exam-mobile-result-signals" aria-label={`${studentName} 제출 상태`}>
                                                {attempt.handwritingArchived && (
                                                    <span className="tone-chip tone-primary">필기 저장됨</span>
                                                )}
                                                {attempt.retake && (
                                                    <StatusPill
                                                        tone="retake"
                                                        size="sm"
                                                        label={`재시험 ${attempt.retake.questionIds.length}문항`}
                                                    />
                                                )}
                                                <StatusPill
                                                    tone={summary && (summary.wrongCount > 0 || summary.unansweredCount > 0) ? "grade" : "success"}
                                                    size="sm"
                                                    label={summary
                                                        ? `정 ${summary.correctCount} · 오 ${summary.wrongCount} · 미 ${summary.unansweredCount}`
                                                        : "완료"}
                                                />
                                                {awayCount > 0 ? (
                                                    <span className="away-severity-badge" data-away-severity={awaySeverity(awayCount)}>
                                                        화면 이탈 {awayCount}회
                                                    </span>
                                                ) : (
                                                    <StatusPill tone="muted" size="sm" label="이탈 0회" />
                                                )}
                                            </div>
                                            <Link
                                                href={buildStudentResultHref(attempt.id, "answers")}
                                                className="btn btn-secondary teacher-exam-mobile-result-link"
                                                aria-label={`${studentName} 결과 보기`}
                                            >
                                                학생 결과 보기
                                            </Link>
                                        </li>
                                    );
                                })}
                            </ul>
                        )}

                        {mobileResultLimit < sortedAttempts.length && (
                            <button
                                type="button"
                                className="btn btn-secondary teacher-exam-mobile-more"
                                aria-controls="teacher-exam-mobile-result-list"
                                onClick={() => setMobileResultLimit(limit => limit + MOBILE_RESULT_BATCH_SIZE)}
                            >
                                다음 {Math.min(MOBILE_RESULT_BATCH_SIZE, sortedAttempts.length - mobileResultLimit)}명 보기
                                <span>({sortedAttempts.length - mobileResultLimit}명 남음)</span>
                            </button>
                        )}
                    </div>
                </section>

            </main>
        </div>
    );
}
