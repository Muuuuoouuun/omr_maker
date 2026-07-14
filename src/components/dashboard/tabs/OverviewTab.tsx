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
import { Users, BarChart3, PlusCircle, Activity, Bell, CreditCard, Download, Settings } from "lucide-react";
import { copyStoredData } from "@/utils/blobStore";
import { secureRandomId } from "@/utils/ids";
import { deleteTeacherExamMutation, saveTeacherExamMutation } from "@/lib/teacherExamClient";
import { formatKoreanDate } from "@/lib/pure";
import { safeRatePercent } from "@/lib/scoreUtils";
import { buildExamSummaryRows, splitExamSummaryRows } from "@/lib/dashboardSummary";
import { buildDashboardStatsCsv } from "@/lib/dashboardStatsExport";

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
    onNavigateToExamAnalytics?: (examId: string) => void;
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

export default function OverviewTab({ exams: examsProp, attempts, stats, trendData, onNavigateToExamAnalytics }: OverviewTabProps) {
    const router = useRouter();
    const [activeTab, setActiveTab] = useState<'ongoing' | 'completed'>('ongoing');
    // Local copy so action handlers (archive/delete/duplicate) can update the table
    // without requiring the parent page to reload from localStorage.
    const [exams, setExams] = useState<Exam[]>(examsProp);
    const [deleteTarget, setDeleteTarget] = useState<Exam | null>(null);

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
            try {
                const result = await saveTeacherExamMutation(copy);
                if (!result.ok) throw new Error(result.error);
                setExams(prev => [copy, ...prev]);
                toast.success('시험 복제됨', `"${target.title}"의 복사본을 만들었습니다.`);
            } catch (error) {
                toast.error('복제 실패', error instanceof Error ? error.message : '시험 서버에 저장하지 못했습니다.');
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
        () => buildExamSummaryRows(exams, attempts, stats.totalStudents),
        [exams, attempts, stats.totalStudents]
    );
    const examSummaryGroups = useMemo(() => splitExamSummaryRows(examSummaryRows), [examSummaryRows]);

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

    const handleExportStatsCsv = () => {
        const csv = buildDashboardStatsCsv({ stats, trendData, examRows: examSummaryRows });
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
    };

    return (
        <div className="bento-grid fade-in-up">
            {/* 1. 자주 쓰는 빠른 작업 */}
            <div className="bento-card col-span-2" style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column' }}>
                <div style={{ marginBottom: '1.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <h3 style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--foreground)' }}>
                        빠른 작업 <span style={{ fontWeight: 500, color: 'var(--muted)', fontSize: '0.86rem' }}>자주 쓰는 기능</span>
                    </h3>
                </div>
                <div className="overview-quick-actions-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1rem', flex: 1 }}>
                    <Link href="/create" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', padding: '1rem', background: 'rgba(56, 189, 248, 0.1)', borderRadius: 'var(--radius-lg)', color: '#0ea5e9', transition: 'all 0.2s' }} className="card-hover">
                        <PlusCircle size={24} />
                        <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>시험 출제</span>
                    </Link>
                    <Link href="/teacher/live" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', padding: '1rem', background: 'rgba(239, 68, 68, 0.1)', borderRadius: 'var(--radius-lg)', color: '#ef4444', transition: 'all 0.2s' }} className="card-hover">
                        <Activity size={24} />
                        <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>실시간 결과</span>
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
                        <Settings size={24} />
                        <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>설정</span>
                    </Link>
                    <Link href="/teacher/billing" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', padding: '1rem', background: 'rgba(168, 85, 247, 0.1)', borderRadius: 'var(--radius-lg)', color: '#a855f7', transition: 'all 0.2s' }} className="card-hover">
                        <CreditCard size={24} />
                        <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>결제 관리</span>
                    </Link>
                </div>
            </div>

            {/* 2. Score Trend */}
            <div className="bento-card col-span-2" style={{
                background: 'linear-gradient(135deg, var(--primary), var(--primary-dark))',
                color: 'white', border: 'none',
                position: 'relative', overflow: 'hidden'
            }}>
                <div style={{ marginBottom: '1.5rem', position: 'relative', zIndex: 1 }}>
                    <h3 style={{ fontSize: '1.25rem', fontWeight: 700 }}>평균 점수 추이</h3>
                    <p style={{ opacity: 0.8, fontSize: '0.95rem' }}>최근 7개 시험의 성취도 흐름</p>
                </div>

                <div style={{ position: 'absolute', top: '-20%', right: '-10%', width: '200px', height: '200px', background: 'radial-gradient(circle, rgba(255,255,255,0.2) 0%, transparent 70%)' }}></div>

                <div style={{ flex: 1, display: 'flex', alignItems: 'flex-end', width: '100%' }}>
                    <TrendChart data={trendData} color="white" height={160} />
                </div>
            </div>

            {/* 3. Project Summary (Currently Ongoing / Completed Exams) */}
            <div className="bento-card overview-exam-summary-card" style={{ gridColumn: 'span 4', overflow: 'hidden' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', marginBottom: '1.5rem', flexWrap: 'wrap' }}>
                    <div className="overview-summary-heading">
                        <h3 style={{ fontSize: '1.1rem', fontWeight: 700 }}>시험 요약</h3>
                        <div className="overview-section-tabs" role="tablist" aria-label="시험 상태">
                            <button
                                type="button"
                                role="tab"
                                aria-selected={activeTab === 'ongoing'}
                                onClick={() => setActiveTab('ongoing')}
                                className="overview-section-tab"
                            >진행 중</button>
                            <button
                                type="button"
                                role="tab"
                                aria-selected={activeTab === 'completed'}
                                onClick={() => setActiveTab('completed')}
                                className="overview-section-tab"
                            >완료·보관</button>
                        </div>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '0.5rem', flexWrap: 'wrap' }}>
                        <button
                            type="button"
                            onClick={handleExportStatsCsv}
                            style={{
                                background: 'var(--surface)', color: 'var(--foreground)', padding: '0.6rem 1rem',
                                borderRadius: 'var(--radius-lg)', fontSize: '0.85rem', fontWeight: 700,
                                display: 'flex', alignItems: 'center', gap: '0.4rem',
                                transition: 'var(--transition-base)', border: '1px solid var(--border)'
                            }}
                            className="hover:border-primary hover:text-primary"
                        >
                            <Download size={15} />
                            통계 CSV
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
                                    <tr key={exam.id} style={{ borderBottom: '1px solid var(--border)', transition: 'background 0.2s', opacity: isArchived ? 0.6 : 1 }} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                                        <td className="overview-exam-summary-title-cell" style={{ fontWeight: 600, fontSize: '0.95rem' }}>
                                            <button
                                                type="button"
                                                onClick={() => onNavigateToExamAnalytics && onNavigateToExamAnalytics(exam.id)}
                                                className="overview-exam-title-button"
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
                                                background: exam.retakeCount > 0 ? '#f0fdfa' : 'var(--background)',
                                                color: exam.retakeCount > 0 ? '#0f766e' : 'var(--muted)',
                                                border: exam.retakeCount > 0 ? '1px solid #99f6e4' : '1px solid var(--border)',
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
                                                    className="hover:border-primary hover:text-primary"
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
                    />
                </div>
                <div style={{ flex: 1, display: 'flex', width: '100%', minHeight: 0 }}>
                    <StatCard
                        title="평균 점수"
                        value={stats.avgScore}
                        icon={<BarChart3 size={28} color="var(--success)" />}
                        color="var(--success)"
                        trend={stats.avgScore > 80 ? '양호' : '점검 필요'}
                        trendUp={stats.avgScore > 80}
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
