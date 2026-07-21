"use client";

import { useState, useMemo, useEffect } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { Exam, Attempt } from "@/types/omr";
import StatCard from "@/components/dashboard/StatCard";
import { TrendChartSkeleton } from "@/components/dashboard/DashboardLoadingSkeleton";
import ExamListBlock from "@/components/dashboard/ExamListBlock";
import ExamActionsMenu, { ExamActionKind } from "@/components/dashboard/ExamActionsMenu";
import { toast } from "@/components/Toast";
import { Users, BarChart3, PlusCircle, Activity, Bell, Download, MessageSquare, ArrowRight, CheckCircle2, CircleAlert } from "lucide-react";
import { copyStoredData } from "@/utils/blobStore";
import { secureRandomId } from "@/utils/ids";
import { deleteTeacherExamMutation, saveTeacherExamMutation } from "@/lib/teacherExamClient";
import { collectStudentQuestionInbox } from "@/lib/studentQuestions";
import { formatKoreanDate, formatKoreanDateTime } from "@/lib/pure";
import { safeRatePercent } from "@/lib/scoreUtils";
import { buildExamSummaryRows, splitExamSummaryRows } from "@/lib/dashboardSummary";
import { buildDashboardStatsCsv, type DashboardExportQuestionStat } from "@/lib/dashboardStatsExport";
import { buildAttemptScoreLookup } from "@/lib/attemptScores";
import { buildExamQuestionResultStats, buildExamQuestionPointBiserial } from "@/lib/premiumAnalytics";
import type { RosterGroup, RosterStudent } from "@/lib/rosterStorage";
import {
    authorizeAdvancedQuestionDesign,
    authorizeExamCreation,
    releaseExamCreationAuthorization,
} from "@/app/actions/premiumAccess";

const TrendChart = dynamic(
    () => import("@/components/dashboard/TrendChart"),
    { loading: () => <TrendChartSkeleton height={160} /> },
);

interface OverviewTabProps {
    exams: Exam[];
    attempts: Attempt[];
    stats: {
        totalStudents: number;
        avgScore: number;
        activeExams: number;
    };
    trendData: number[];
    trendLabels?: string[];
    rosterStudents?: RosterStudent[];
    rosterGroups?: RosterGroup[];
    onNavigateToExamAnalytics?: (examId: string) => void;
    onNavigateToStudentAnalytics?: () => void;
}

function DeleteExamConfirmDialog({
    exam,
    onCancel,
    onConfirm,
}: {
    exam: Exam;
    onCancel: () => void;
    onConfirm: () => void;
}) {
    return (
        <div
            role="presentation"
            onClick={onCancel}
            style={{
                position: 'fixed',
                inset: 0,
                zIndex: 1200,
                background: 'rgba(15,23,42,0.58)',
                backdropFilter: 'blur(8px)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '1rem',
            }}
        >
            <div
                role="dialog"
                aria-modal="true"
                aria-label="시험 삭제 확인"
                onClick={(e) => e.stopPropagation()}
                style={{
                    width: '100%',
                    maxWidth: 430,
                    background: 'var(--surface)',
                    color: 'var(--foreground)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-lg)',
                    boxShadow: '0 24px 60px rgba(0,0,0,0.28)',
                    padding: '1.5rem',
                }}
            >
                <h2 style={{ fontSize: '1.15rem', fontWeight: 800, marginBottom: '0.65rem' }}>
                    시험 삭제
                </h2>
                <p style={{ color: 'var(--muted)', lineHeight: 1.7, fontSize: '0.95rem', wordBreak: 'keep-all', marginBottom: '1.25rem' }}>
                    “{exam.title}” 시험을 삭제합니다. 학생 화면과 분석 목록에서 제거되며, 연결된 PDF 저장 데이터도 정리합니다.
                </p>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
                    <button
                        type="button"
                        onClick={onCancel}
                        style={{ padding: '0.7rem 1rem', background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', fontWeight: 700, fontSize: '0.9rem' }}
                    >
                        취소
                    </button>
                    <button
                        type="button"
                        onClick={onConfirm}
                        style={{ padding: '0.7rem 1rem', background: 'var(--error)', color: 'white', borderRadius: 'var(--radius-md)', fontWeight: 800, fontSize: '0.9rem' }}
                    >
                        삭제
                    </button>
                </div>
            </div>
        </div>
    );
}

export default function OverviewTab({ exams: examsProp, attempts, stats, trendData, trendLabels, rosterStudents = [], rosterGroups = [], onNavigateToExamAnalytics, onNavigateToStudentAnalytics }: OverviewTabProps) {
    const router = useRouter();
    const [activeTab, setActiveTab] = useState<'ongoing' | 'completed'>('ongoing');
    // Local copy so action handlers (archive/delete/duplicate) can update the table
    // without requiring the parent page to reload from localStorage.
    const [exams, setExams] = useState<Exam[]>(examsProp);
    const [deleteTarget, setDeleteTarget] = useState<Exam | null>(null);
    // Guards the "통계 CSV" button while the per-exam × per-question pass runs, and drives its
    // disabled/label state so a large workspace doesn't look unresponsive on click.
    const [isExportingStats, setIsExportingStats] = useState(false);

    // Sync when parent reloads data (initial mount / navigation).
    useEffect(() => { setExams(examsProp); }, [examsProp]);

    const handleExamAction = async (kind: ExamActionKind, examId: string) => {
        const target = exams.find(e => e.id === examId);
        if (!target) return;

        if (kind === 'edit') {
            router.push(`/create?edit=${encodeURIComponent(examId)}`);
            return;
        }

        if (kind === 'duplicate') {
            const newId = secureRandomId();
            let reserved = false;
            try {
                if (target.questions.some(question => (question.subQuestions?.length || 0) > 0)) {
                    const entitlement = await authorizeAdvancedQuestionDesign();
                    if (!entitlement.ok) throw new Error(entitlement.error || "하위 질문 복제는 Pro 기능입니다.");
                }
                const authorization = await authorizeExamCreation(newId);
                if (!authorization.ok) throw new Error(authorization.error || "월 시험 생성 한도에 도달했습니다.");
                reserved = true;
                const pdfDataRef = await copyStoredData(target.pdfDataRef, `exam:${newId}:problemPdf`) || target.pdfDataRef;
                const answerKeyPdfRef = await copyStoredData(target.answerKeyPdfRef, `exam:${newId}:answerKeyPdf`) || target.answerKeyPdfRef;
                const copy: Exam = {
                    ...target,
                    id: newId,
                    pdfDataRef,
                    answerKeyPdfRef,
                    title: target.title + ' (복사본)',
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    archived: false,
                };
                const result = await saveTeacherExamMutation(copy);
                if (!result.ok) throw new Error(result.error || "시험 서버에 저장하지 못했습니다.");
                reserved = false;
                setExams(prev => [copy, ...prev]);
                toast.success('시험 복제됨', `"${target.title}"의 복사본을 만들었습니다.`);
                if (result.localOnly) {
                    toast.info('개발 모드 로컬 저장', '복사본을 이 기기에 저장했습니다.');
                }
            } catch (error) {
                if (reserved) await releaseExamCreationAuthorization(newId);
                toast.error('복제 실패', error instanceof Error ? error.message : '저장 공간 또는 서버 플랜을 확인해주세요.');
            }
            return;
        }

        if (kind === 'archive') {
            const nextArchived = !target.archived;
            const updated: Exam = { ...target, archived: nextArchived, updatedAt: new Date().toISOString() };
            try {
                const result = await saveTeacherExamMutation(updated);
                if (!result.ok) throw new Error(result.error);
                setExams(prev => prev.map(e => e.id === examId ? updated : e));
                toast.success(nextArchived ? '시험 보관됨' : '보관 해제됨', target.title);
            } catch (error) {
                toast.error('보관 처리 실패', error instanceof Error ? error.message : '시험 서버에 저장하지 못했습니다.');
            }
            return;
        }

        if (kind === 'delete') {
            setDeleteTarget(target);
            return;
        }
    };

    const confirmDeleteExam = async () => {
        if (!deleteTarget) return;
        const target = deleteTarget;
        setDeleteTarget(null);
        try {
            const result = await deleteTeacherExamMutation(target.id);
            if (!result.ok) throw new Error(result.error);
            setExams(prev => prev.filter(e => e.id !== target.id));
            toast.success('시험 삭제됨', target.title);
        } catch (error) {
            toast.error('삭제 실패', error instanceof Error ? error.message : '시험 서버에서 삭제하지 못했습니다.');
        }
    };

    const examSummaryRows = useMemo(
        () => buildExamSummaryRows(exams, attempts, stats.totalStudents, { rosterStudents, rosterGroups }),
        [exams, attempts, stats.totalStudents, rosterStudents, rosterGroups]
    );
    const examSummaryGroups = useMemo(() => splitExamSummaryRows(examSummaryRows), [examSummaryRows]);

    const priorityBrief = useMemo(() => {
        const priorityExam = examSummaryGroups.ongoing
            .map(exam => ({
                ...exam,
                missingCount: Math.max(0, exam.total - exam.completedCount),
                participationRate: Math.min(100, safeRatePercent(exam.completedCount, exam.total)),
            }))
            .filter(exam => exam.missingCount > 0)
            .sort((a, b) => b.missingCount - a.missingCount || a.participationRate - b.participationRate)[0];

        if (priorityExam) {
            return {
                tone: "warning" as const,
                eyebrow: "오늘의 우선 조치",
                title: `${priorityExam.title} 미응시 ${priorityExam.missingCount}명부터 확인하세요`,
                detail: `현재 ${priorityExam.completedCount}/${priorityExam.total}명 응시 · 참여율 ${priorityExam.participationRate}%. 분석 화면에서 미응시 현황과 취약 문항을 이어서 확인할 수 있습니다.`,
                status: "영향도 높음",
                actionLabel: "미응시·문항 분석",
                onAction: () => onNavigateToExamAnalytics
                    ? onNavigateToExamAnalytics(priorityExam.id)
                    : router.push(`/teacher/dashboard?tab=exam&examId=${encodeURIComponent(priorityExam.id)}`),
            };
        }

        const latestExam = examSummaryRows[0];
        if (latestExam && stats.avgScore < 80) {
            return {
                tone: "warning" as const,
                eyebrow: "점수 점검 권장",
                title: `전체 평균 ${stats.avgScore.toFixed(1)}점 · 최근 시험 문항을 점검하세요`,
                detail: "오답률과 문항 변별도를 함께 확인하면 재지도할 문항을 빠르게 좁힐 수 있습니다.",
                status: "평균 80점 미만",
                actionLabel: "점수 원인 분석",
                onAction: () => onNavigateToExamAnalytics
                    ? onNavigateToExamAnalytics(latestExam.id)
                    : router.push(`/teacher/dashboard?tab=exam&examId=${encodeURIComponent(latestExam.id)}`),
            };
        }

        if (examSummaryRows.length > 0) {
            return {
                tone: "success" as const,
                eyebrow: "운영 상태 안정",
                title: "진행 시험의 응시 현황이 안정적입니다",
                detail: "이제 학생별 반복 오답과 재시험 개선 폭을 확인해 다음 수업 대상을 정해보세요.",
                status: "다음 단계 준비",
                actionLabel: "학생별 성취 보기",
                onAction: () => onNavigateToStudentAnalytics
                    ? onNavigateToStudentAnalytics()
                    : router.push("/teacher/dashboard?tab=student"),
            };
        }

        return {
            tone: "neutral" as const,
            eyebrow: "첫 분석 준비",
            title: "시험을 만들면 응시·점수·취약 문항이 연결됩니다",
            detail: "시험을 배포하고 첫 응시가 들어오면 우선 조치와 학생별 분석을 자동으로 구성합니다.",
            status: "데이터 대기",
            actionLabel: "첫 시험 만들기",
            onAction: () => router.push("/create"),
        };
    }, [examSummaryGroups.ongoing, examSummaryRows, onNavigateToExamAnalytics, onNavigateToStudentAnalytics, router, stats.avgScore]);

    const latestExamRow = examSummaryRows[0];
    const latestTrendScore = trendData.at(-1);
    const previousTrendScore = trendData.at(-2);
    const scoreDelta = latestTrendScore !== undefined && previousTrendScore !== undefined
        ? latestTrendScore - previousTrendScore
        : undefined;

    const questionInbox = useMemo(() => collectStudentQuestionInbox(attempts), [attempts]);
    const hasStudentQuestions = questionInbox.pending.length > 0 || questionInbox.answered.length > 0;

    const displayExams = activeTab === 'ongoing' ? examSummaryGroups.ongoing : examSummaryGroups.completed;

    const handleSendAlarm = (examTitle: string) => {
        toast.info(
            '카카오 알림 연동 전',
            `${examTitle} 미응시 학생 확인만 지원합니다. 실제 카카오 발송 채널이 연결되면 이 버튼에서 발송합니다.`
        );
    };

    const handleSendAllAlarms = () => {
        toast.info(
            '카카오 알림 연동 전',
            '진행 중인 시험의 미응시 학생 확인만 지원합니다. 실제 카카오 발송 채널이 연결되면 일괄 발송합니다.'
        );
    };

    const handleExportStatsCsv = async () => {
        if (isExportingStats) return;
        setIsExportingStats(true);
        try {
        // Computed lazily on click so the richer distribution/per-question math never
        // runs on every dashboard render.
        const examById = new Map(exams.map(exam => [exam.id, exam]));
        const scoreLookup = buildAttemptScoreLookup(attempts, examById);
        const scores = attempts
            .filter(attempt => !attempt.retake && attempt.status === "completed")
            .map(attempt => scoreLookup.get(attempt.id)?.scorePercent ?? 0);

        // Large workspaces (many exams and/or many attempts) make the per-exam ×
        // per-question pass below expensive enough to freeze the tab if run in one
        // synchronous block, so we yield to the main thread every few exams.
        const shouldChunk = exams.length > 50 || attempts.length > 2000;
        const EXAMS_PER_CHUNK = 5;

        const questionStats: DashboardExportQuestionStat[] = [];
        for (let i = 0; i < exams.length; i++) {
            const exam = exams[i];
            const examAttempts = attempts.filter(attempt => attempt.examId === exam.id && !attempt.retake);
            if (examAttempts.length > 0) {
                const pointBiserials = buildExamQuestionPointBiserial(exam, examAttempts);
                for (const stat of buildExamQuestionResultStats(exam, examAttempts)) {
                    if (stat.totalCount === 0) continue;
                    questionStats.push({
                        examTitle: exam.title,
                        questionNumber: stat.questionNumber,
                        correctRate: stat.correctRate,
                        pointBiserial: pointBiserials.get(stat.questionId) ?? null,
                    });
                }
            }

            if (shouldChunk && (i + 1) % EXAMS_PER_CHUNK === 0 && i + 1 < exams.length) {
                // Intentional yield to the main thread so "생성 중…" paints and the tab stays responsive.
                await new Promise<void>(resolve => window.setTimeout(resolve, 0));
            }
        }

        const csv = buildDashboardStatsCsv({ stats, trendData, examRows: examSummaryRows, scores, questionStats });
        const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `dashboard-stats-${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        window.setTimeout(() => URL.revokeObjectURL(url), 0);
        toast.success("통계 CSV 생성됨", "대시보드 요약과 시험별 통계를 내보냈습니다.");
        } finally {
            setIsExportingStats(false);
        }
    };

    return (
        <div className="bento-grid fade-in-up">
            <section className={`overview-action-brief is-${priorityBrief.tone}`} aria-labelledby="overview-priority-title">
                <span className="overview-action-brief-icon" aria-hidden="true">
                    {priorityBrief.tone === "success" ? <CheckCircle2 size={24} /> : <CircleAlert size={24} />}
                </span>
                <div className="overview-action-brief-copy">
                    <span>{priorityBrief.eyebrow}</span>
                    <h2 id="overview-priority-title">{priorityBrief.title}</h2>
                    <p>{priorityBrief.detail}</p>
                </div>
                <div className="overview-action-brief-next">
                    <span>{priorityBrief.status}</span>
                    <button type="button" onClick={priorityBrief.onAction}>
                        {priorityBrief.actionLabel}<ArrowRight size={16} />
                    </button>
                </div>
            </section>

            {/* 1. 자주 쓰는 빠른 작업 */}
            <div className="bento-card col-span-2" style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column' }}>
                <div style={{ marginBottom: '1.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <h3 style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--foreground)' }}>
                        빠른 작업 <span style={{ fontWeight: 400, color: 'var(--muted)', fontSize: '0.9rem' }}>자주 쓰는 기능 바로가기</span>
                    </h3>
                </div>
                <div className="overview-quick-actions-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1rem', flex: 1 }}>
                    <Link href="/create" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', padding: '1rem', background: 'rgba(56, 189, 248, 0.1)', borderRadius: 'var(--radius-lg)', color: '#0ea5e9', transition: 'all 0.2s' }} className="card-hover">
                        <PlusCircle size={24} />
                        <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>시험 제작</span>
                    </Link>
                    <Link href="/teacher/live" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', padding: '1rem', background: 'rgba(239, 68, 68, 0.1)', borderRadius: 'var(--radius-lg)', color: '#ef4444', transition: 'all 0.2s' }} className="card-hover">
                        <Activity size={24} />
                        <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>실시간 응시</span>
                    </Link>
                    <Link href="/teacher/users" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', padding: '1rem', background: 'rgba(34, 197, 94, 0.1)', borderRadius: 'var(--radius-lg)', color: '#22c55e', transition: 'all 0.2s' }} className="card-hover">
                        <Users size={24} />
                        <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>학생 관리</span>
                    </Link>
                    <Link href="/teacher/dashboard?tab=exam" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', padding: '1rem', background: 'rgba(245, 158, 11, 0.1)', borderRadius: 'var(--radius-lg)', color: '#f59e0b', transition: 'all 0.2s' }} className="card-hover">
                        <BarChart3 size={24} />
                        <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>시험 분석</span>
                    </Link>
                    <Link href="/teacher/settings" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', padding: '1rem', background: 'rgba(99, 102, 241, 0.1)', borderRadius: 'var(--radius-lg)', color: '#6366f1', transition: 'all 0.2s' }} className="card-hover">
                        <svg width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
                        <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>설정</span>
                    </Link>
                    <Link href="/teacher/billing" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', padding: '1rem', background: 'rgba(168, 85, 247, 0.1)', borderRadius: 'var(--radius-lg)', color: '#a855f7', transition: 'all 0.2s' }} className="card-hover">
                        <svg width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"></rect><line x1="2" y1="10" x2="22" y2="10"></line></svg>
                        <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>요금제</span>
                    </Link>
                </div>
            </div>

            {/* 1.5 Student question inbox — shown only when questions exist */}
            {hasStudentQuestions && (
                <div className="bento-card col-span-2" style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column' }}>
                    <div style={{ marginBottom: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem' }}>
                        <h3 style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--foreground)', display: 'inline-flex', alignItems: 'center', gap: '0.45rem' }}>
                            <MessageSquare size={18} style={{ color: '#0f766e' }} />
                            학생 질문
                        </h3>
                        <span style={{
                            background: questionInbox.pending.length > 0 ? 'rgba(15,118,110,0.12)' : 'var(--background)',
                            color: questionInbox.pending.length > 0 ? '#0f766e' : 'var(--muted)',
                            padding: '0.3rem 0.6rem',
                            borderRadius: 'var(--radius-full)',
                            fontSize: '0.75rem',
                            fontWeight: 700,
                            whiteSpace: 'nowrap',
                        }}>
                            대기 {questionInbox.pending.length} · 답변 {questionInbox.answered.length}
                        </span>
                    </div>
                    {questionInbox.pending.length === 0 ? (
                        <div style={{ color: 'var(--muted)', fontSize: '0.88rem', padding: '0.5rem 0' }}>
                            대기 중인 질문이 없습니다. 답변한 질문은 학생 리뷰 화면에 표시됩니다.
                        </div>
                    ) : (
                        <div style={{ display: 'grid', gap: '0.55rem', flex: 1 }}>
                            {questionInbox.pending.slice(0, 5).map(entry => (
                                <Link
                                    key={`${entry.attemptId}:${entry.note.questionId}`}
                                    href={`/teacher/attempt/${entry.attemptId}`}
                                    className="card-hover"
                                    style={{
                                        display: 'flex',
                                        alignItems: 'baseline',
                                        gap: '0.6rem',
                                        padding: '0.65rem 0.8rem',
                                        borderRadius: 'var(--radius-md)',
                                        border: '1px solid var(--border)',
                                        background: 'var(--background)',
                                        minWidth: 0,
                                    }}
                                >
                                    <span style={{ fontWeight: 800, fontSize: '0.82rem', color: 'var(--foreground)', whiteSpace: 'nowrap' }}>
                                        {entry.studentName}
                                    </span>
                                    <span style={{ color: 'var(--muted)', fontSize: '0.74rem', whiteSpace: 'nowrap' }}>
                                        {entry.examTitle} · {entry.note.questionNumber}번
                                    </span>
                                    <span style={{
                                        flex: 1,
                                        minWidth: 0,
                                        color: 'var(--foreground)',
                                        fontSize: '0.82rem',
                                        overflow: 'hidden',
                                        textOverflow: 'ellipsis',
                                        whiteSpace: 'nowrap',
                                    }}>
                                        {entry.note.body}
                                    </span>
                                    <span style={{ color: 'var(--muted)', fontSize: '0.7rem', whiteSpace: 'nowrap' }}>
                                        {formatKoreanDateTime(entry.note.createdAt)}
                                    </span>
                                </Link>
                            ))}
                            {questionInbox.pending.length > 5 && (
                                <div style={{ color: 'var(--muted)', fontSize: '0.76rem', fontWeight: 700 }}>
                                    외 {questionInbox.pending.length - 5}건 — 각 응시 상세에서 답변할 수 있습니다.
                                </div>
                            )}
                        </div>
                    )}
                </div>
            )}

            {/* 2. Score Trend */}
            <div className="bento-card col-span-2" style={{
                background: 'linear-gradient(135deg, var(--primary), var(--primary-dark))',
                color: 'white', border: 'none',
                position: 'relative', overflow: 'hidden'
            }}>
                <div style={{ marginBottom: '1.5rem', position: 'relative', zIndex: 1 }}>
                    <h3 style={{ fontSize: '1.25rem', fontWeight: 700 }}>평균 점수 추이</h3>
                    <p style={{ opacity: 0.8, fontSize: '0.95rem' }}>최근 7개 시험의 평균 점수 흐름</p>
                </div>

                <div style={{ position: 'absolute', top: '-20%', right: '-10%', width: '200px', height: '200px', background: 'radial-gradient(circle, rgba(255,255,255,0.2) 0%, transparent 70%)' }}></div>

                <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end', width: '100%' }}>
                    <TrendChart data={trendData} labels={trendLabels} color="white" height={160} />
                </div>
            </div>

            {/* 3. Project Summary (Currently Ongoing / Completed Exams) */}
            <div className="bento-card overview-exam-summary-card" style={{ gridColumn: 'span 4', overflow: 'hidden' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem' }}>
                        <h3 style={{ fontSize: '1.1rem', fontWeight: 700 }}>시험 요약</h3>
                        <div role="tablist" aria-label="시험 진행 상태" style={{ display: 'flex', gap: '1rem', fontSize: '0.9rem', color: 'var(--muted)', fontWeight: 600 }}>
                            <button
                                type="button"
                                role="tab"
                                aria-selected={activeTab === 'ongoing'}
                                onClick={() => setActiveTab('ongoing')}
                                style={{
                                    background: 'none',
                                    border: 'none',
                                    font: 'inherit',
                                    cursor: 'pointer',
                                    color: activeTab === 'ongoing' ? 'var(--primary)' : 'inherit',
                                    borderBottom: activeTab === 'ongoing' ? '2px solid var(--primary)' : '2px solid transparent',
                                    paddingBottom: '0.5rem',
                                    transition: 'all 0.2s'
                                }}>진행 중</button>
                            <button
                                type="button"
                                role="tab"
                                aria-selected={activeTab === 'completed'}
                                onClick={() => setActiveTab('completed')}
                                style={{
                                    background: 'none',
                                    border: 'none',
                                    font: 'inherit',
                                    cursor: 'pointer',
                                    color: activeTab === 'completed' ? 'var(--primary)' : 'inherit',
                                    borderBottom: activeTab === 'completed' ? '2px solid var(--primary)' : '2px solid transparent',
                                    paddingBottom: '0.5rem',
                                    transition: 'all 0.2s'
                                }}>완료</button>
                        </div>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '0.5rem', flexWrap: 'wrap' }}>
                        <button
                            type="button"
                            onClick={handleExportStatsCsv}
                            disabled={isExportingStats}
                            style={{
                                background: 'var(--surface)', color: 'var(--foreground)', padding: '0.6rem 1rem',
                                borderRadius: 'var(--radius-lg)', fontSize: '0.85rem', fontWeight: 700,
                                display: 'flex', alignItems: 'center', gap: '0.4rem',
                                transition: 'var(--transition-base)', border: '1px solid var(--border)',
                                opacity: isExportingStats ? 0.7 : 1,
                                cursor: isExportingStats ? 'not-allowed' : 'pointer',
                            }}
                            onMouseEnter={(e) => {
                                if (isExportingStats) return;
                                e.currentTarget.style.borderColor = 'var(--primary)';
                                e.currentTarget.style.color = 'var(--primary)';
                            }}
                            onMouseLeave={(e) => {
                                e.currentTarget.style.borderColor = 'var(--border)';
                                e.currentTarget.style.color = 'var(--foreground)';
                            }}
                        >
                            <Download size={15} />
                            {isExportingStats ? '생성 중…' : '통계 CSV'}
                        </button>

                        {/* Send All Alarms Button */}
                        {activeTab === 'ongoing' && displayExams.length > 0 && (
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
                            <Bell size={16} />
                            미응시자 전체 알람 발송
                        </button>
                        )}
                    </div>
                </div>

                <p className="overview-table-hint" aria-hidden="true">↔ 시험명을 고정한 채 좌우로 밀어 세부 항목을 확인하세요.</p>
                <div className="overview-exam-summary-scroll scroll-custom" role="region" aria-label="시험 요약 표, 좌우 스크롤 가능" tabIndex={0}>
                    <table className="overview-exam-summary-table">
                        <caption className="sr-only">시험별 생성일, 참여율, 응시 인원, 재시험, 상태 및 작업</caption>
                        <colgroup>
                            <col style={{ width: '220px' }} />
                            <col style={{ width: '115px' }} />
                            <col style={{ width: '190px' }} />
                            <col style={{ width: '135px' }} />
                            <col style={{ width: '85px' }} />
                            <col style={{ width: '120px' }} />
                            {activeTab === 'ongoing' && <col style={{ width: '130px' }} />}
                            <col style={{ width: '60px' }} />
                        </colgroup>
                        <thead>
                            <tr style={{ color: 'var(--muted)', fontSize: '0.85rem', borderBottom: '1px solid var(--border)' }}>
                                <th scope="col">시험명</th>
                                <th scope="col">생성일</th>
                                <th scope="col">참여율</th>
                                <th scope="col">응시 / 전체</th>
                                <th scope="col">재시험</th>
                                <th scope="col">상태</th>
                                {activeTab === 'ongoing' && <th scope="col" style={{ textAlign: 'right' }}>알림</th>}
                                <th scope="col" style={{ textAlign: 'right' }}>작업</th>
                            </tr>
                        </thead>
                        <tbody>
                            {displayExams.map((exam) => {
                                const participationRate = Math.min(100, safeRatePercent(exam.completedCount, exam.total));

                                const targetColor = participationRate > 70 ? 'var(--success)' : (participationRate > 30 ? 'var(--warning)' : 'var(--error)');
                                const isArchived = exam.archived;
                                const statusText = isArchived ? '보관됨' : participationRate === 100 ? '완료' : '진행 중';
                                const statusBg = isArchived ? 'rgba(100,116,139,0.12)' : participationRate === 100 ? 'rgba(16, 185, 129, 0.1)' : 'rgba(139, 92, 246, 0.1)';
                                const statusColor = isArchived ? 'var(--muted)' : participationRate === 100 ? 'var(--success)' : 'var(--accent)';

                                return (
                                    <tr
                                        key={exam.id}
                                        style={{ borderBottom: '1px solid var(--border)', transition: 'background 0.2s', opacity: isArchived ? 0.6 : 1 }}
                                        onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(99,102,241,0.06)'; }}
                                        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                                    >
                                        <td className="overview-exam-summary-title-cell" style={{ fontWeight: 600, fontSize: '0.95rem' }}>
                                            <button
                                                type="button"
                                                onClick={() => onNavigateToExamAnalytics && onNavigateToExamAnalytics(exam.id)}
                                                aria-label={`${exam.title} 분석 보기`}
                                                style={{ background: 'none', border: 'none', font: 'inherit', padding: 0, textAlign: 'left', color: 'inherit', cursor: 'pointer', transition: 'color 0.2s', textUnderlineOffset: '4px' }}
                                                onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--primary)'; e.currentTarget.style.textDecoration = 'underline'; }}
                                                onMouseLeave={(e) => { e.currentTarget.style.color = 'inherit'; e.currentTarget.style.textDecoration = 'none'; }}
                                            >
                                                {exam.title}
                                            </button>
                                            {isArchived && (
                                                <span style={{
                                                    marginLeft: '0.5rem',
                                                    display: 'inline-block',
                                                    padding: '0.15rem 0.5rem',
                                                    fontSize: '0.7rem',
                                                    fontWeight: 700,
                                                    background: 'rgba(100,116,139,0.15)',
                                                    color: 'var(--muted)',
                                                    borderRadius: 'var(--radius-full)',
                                                    verticalAlign: 'middle',
                                                }}>보관됨</span>
                                            )}
                                        </td>
                                        <td style={{ color: 'var(--muted)', fontSize: '0.9rem' }}>{formatKoreanDate(exam.createdAt)}</td>
                                        <td>
                                            <div className="overview-exam-summary-progress">
                                                <div style={{ flex: 1, height: '6px', background: 'var(--border)', borderRadius: 'var(--radius-full)', overflow: 'hidden' }}>
                                                    <div style={{ width: `${participationRate}%`, height: '100%', background: targetColor, borderRadius: 'var(--radius-full)', transition: 'width 1s ease-out' }}></div>
                                                </div>
                                                <span style={{ fontSize: '0.85rem', fontWeight: 600, color: targetColor, minWidth: '40px' }}>{participationRate}%</span>
                                            </div>
                                        </td>
                                        <td style={{ fontSize: '0.9rem', color: 'var(--muted)', fontWeight: 500 }}>
                                            <span style={{ color: 'var(--foreground)', fontWeight: 600 }}>{exam.completedCount}</span> / {exam.total}
                                        </td>
                                        <td>
                                            <span style={{
                                                padding: '0.25rem 0.6rem',
                                                borderRadius: 'var(--radius-full)',
                                                fontSize: '0.75rem',
                                                fontWeight: 800,
                                                background: exam.retakeCount > 0 ? 'color-mix(in srgb, #0f766e 8%, var(--surface))' : 'var(--background)',
                                                color: exam.retakeCount > 0 ? '#0f766e' : 'var(--muted)',
                                                border: exam.retakeCount > 0 ? '1px solid color-mix(in srgb, #0f766e 28%, transparent)' : '1px solid var(--border)',
                                                whiteSpace: 'nowrap',
                                            }}>
                                                {exam.retakeCount}건
                                            </span>
                                        </td>
                                        <td>
                                            <span style={{ background: statusBg, color: statusColor, padding: '0.3rem 0.6rem', borderRadius: 'var(--radius-full)', fontSize: '0.75rem', fontWeight: 700, textTransform: 'uppercase', whiteSpace: 'nowrap' }}>
                                                {statusText}
                                            </span>
                                        </td>
                                        {activeTab === 'ongoing' && (
                                            <td style={{ textAlign: 'right' }}>
                                                <button
                                                    onClick={() => handleSendAlarm(exam.title)}
                                                    style={{
                                                        background: 'var(--surface)', color: 'var(--foreground)', padding: '0.5rem 1rem',
                                                        borderRadius: 'var(--radius-md)', fontSize: '0.85rem', fontWeight: 600,
                                                        display: 'flex', alignItems: 'center', gap: '0.4rem', marginLeft: 'auto',
                                                        transition: 'var(--transition-base)', border: '1px solid var(--border)', whiteSpace: 'nowrap',
                                                    }}
                                                    onMouseEnter={(e) => {
                                                        e.currentTarget.style.borderColor = 'var(--primary)';
                                                        e.currentTarget.style.color = 'var(--primary)';
                                                    }}
                                                    onMouseLeave={(e) => {
                                                        e.currentTarget.style.borderColor = 'var(--border)';
                                                        e.currentTarget.style.color = 'var(--foreground)';
                                                    }}
                                                >
                                                    <Bell size={14} />
                                                    독려 알람
                                                </button>
                                            </td>
                                        )}
                                        <td style={{ textAlign: 'right' }}>
                                            <ExamActionsMenu
                                                exam={{ id: exam.id, title: exam.title, archived: isArchived }}
                                                onAction={handleExamAction}
                                            />
                                        </td>
                                    </tr>
                                );
                            })}
                            {displayExams.length === 0 && (
                                <tr>
                                    <td colSpan={activeTab === 'ongoing' ? 8 : 7} style={{ padding: '2rem 1rem', textAlign: 'center', color: 'var(--muted)', fontSize: '0.92rem', borderBottom: '1px solid var(--border)' }}>
                                        {activeTab === 'ongoing'
                                            ? '진행 중인 실제 시험이 없습니다. 새 시험을 출제하거나 배포하면 여기에 표시됩니다.'
                                            : '완료 또는 보관된 실제 시험이 없습니다.'}
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* 4. Statistics stacked vertically (col-span-1) + Exam list (col-span-3) */}
            <div className="overview-stats-stack" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', gridColumn: 'span 1', height: '100%' }}>
                <div style={{ flex: 1, display: 'flex', width: '100%', minHeight: 0 }}>
                    <StatCard
                        title="전체 학생"
                        value={stats.totalStudents}
                        icon={<Users size={28} color="var(--primary)" />}
                        detail={`${rosterGroups.length}개 그룹 · ${rosterStudents.length > 0 ? "등록 명단" : "응시 기록"} 기준`}
                        actionLabel="학생별 성취 보기"
                        actionAriaLabel={`${stats.totalStudents}명 학생별 성취 분석 보기`}
                        onAction={onNavigateToStudentAnalytics}
                    />
                </div>
                <div style={{ flex: 1, display: 'flex', width: '100%', minHeight: 0 }}>
                    <StatCard
                        title="평균 점수"
                        value={stats.avgScore}
                        icon={<BarChart3 size={28} color="var(--success)" />}
                        color="var(--success)"
                        detail="전체 완료 응시 기준"
                        trend={scoreDelta === undefined
                            ? (stats.avgScore >= 80 ? "현재 양호" : "점검 필요")
                            : `직전 대비 ${scoreDelta >= 0 ? "+" : ""}${scoreDelta.toFixed(1)}점`}
                        trendUp={scoreDelta === undefined ? stats.avgScore >= 80 : scoreDelta >= 0}
                        actionLabel="점수 원인 분석"
                        actionAriaLabel={`${stats.avgScore}점 평균 점수 원인 분석 보기`}
                        onAction={latestExamRow && onNavigateToExamAnalytics
                            ? () => onNavigateToExamAnalytics(latestExamRow.id)
                            : undefined}
                    />
                </div>
            </div>

            <div className="overview-recent-exams-card" style={{ gridColumn: 'span 3' }}>
                <ExamListBlock exams={exams} />
            </div>

            {deleteTarget && (
                <DeleteExamConfirmDialog
                    exam={deleteTarget}
                    onCancel={() => setDeleteTarget(null)}
                    onConfirm={confirmDeleteExam}
                />
            )}
        </div>
    );
}
