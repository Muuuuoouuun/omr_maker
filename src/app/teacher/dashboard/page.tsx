"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import BrandLogo from "@/components/BrandLogo";
import { Exam, Attempt, type PlanKey } from "@/types/omr";
import OverviewTab from "@/components/dashboard/tabs/OverviewTab";
import ExamAnalyticsTab from "@/components/dashboard/tabs/ExamAnalyticsTab";
import StudentAnalyticsTab from "@/components/dashboard/tabs/StudentAnalyticsTab";
import { Activity, AlertTriangle, BarChart2, CheckCircle2, CloudOff, Database, GraduationCap, LayoutDashboard, RefreshCw } from "lucide-react";
import ThemeToggle from "@/components/ThemeToggle";
import TeacherLogoutButton from "@/components/TeacherLogoutButton";
import NotificationBell from "@/components/NotificationBell";
import TeacherSessionChip from "@/components/TeacherSessionChip";
import { toast } from "@/components/Toast";
import { buildDemoDashboardData, shouldUseDemoData } from "@/lib/demoData";
import { buildQuestionResultRepairPlan } from "@/lib/analyticsDataRepair";
import { loadAttempts, loadExams, saveAttempt } from "@/lib/omrPersistence";
import { summarizeAnalyticsDataHealth, summarizePersistenceHealth, type PersistenceHealth } from "@/lib/persistenceHealth";
import { loadRosterSnapshot } from "@/lib/rosterPersistence";
import type { RosterGroup, RosterStudent } from "@/lib/rosterStorage";
import { buildTeacherDashboardMetrics } from "@/lib/teacherDashboardMetrics";
import { getCurrentPlan } from "@/utils/plans";

type TabType = 'overview' | 'exam' | 'student';
type DashboardDataMode = "real" | "demo";
type DashboardAnalysisActionKey = "create" | "exam" | "student" | "repair" | "refresh";
interface DashboardAnalysisAction {
    key: DashboardAnalysisActionKey;
    label: string;
    detail: string;
    tone: "primary" | "warning" | "muted";
}
type DashboardLoadOptions = {
    isCancelled?: () => boolean;
    notifyOnSuccess?: boolean;
    notifyOnError?: boolean;
};

function normalizeDashboardTab(value: string | null): TabType {
    return value === "exam" || value === "student" || value === "overview" ? value : "overview";
}

// Wrap the inner component so useSearchParams is inside a Suspense boundary
// (required by Next 16 to avoid deopting the whole page to client-only rendering).
export default function TeacherDashboardPage() {
    return (
        <Suspense fallback={<div style={{ minHeight: '100vh' }} />}>
            <TeacherDashboard />
        </Suspense>
    );
}

function TeacherDashboard() {
    const searchParams = useSearchParams();
    const initialTab = normalizeDashboardTab(searchParams.get('tab'));
    const initialExamId = searchParams.get('examId') || undefined;
    const [activeTab, setActiveTab] = useState<TabType>(initialTab);
    const [selectedExamIdForAnalytics, setSelectedExamIdForAnalytics] = useState<string | undefined>(initialExamId);
    const [exams, setExams] = useState<Exam[]>([]);
    const [attempts, setAttempts] = useState<Attempt[]>([]);
    const [rosterStudents, setRosterStudents] = useState<RosterStudent[]>([]);
    const [rosterGroups, setRosterGroups] = useState<RosterGroup[]>([]);
    const [stats, setStats] = useState({
        totalStudents: 0,
        avgScore: 0,
        activeExams: 0
    });
    const [trendData, setTrendData] = useState<number[]>([]);
    const [dataMode, setDataMode] = useState<DashboardDataMode>("real");
    const [currentPlan] = useState<PlanKey>(() => getCurrentPlan());
    const [syncStatus, setSyncStatus] = useState<PersistenceHealth>(() => summarizePersistenceHealth([]));
    const [isRefreshingDashboardData, setIsRefreshingDashboardData] = useState(false);
    const [isRepairingAnalyticsData, setIsRepairingAnalyticsData] = useState(false);
    const analyticsDataHealth = useMemo(
        () => dataMode === "demo"
            ? summarizeAnalyticsDataHealth([], [])
            : summarizeAnalyticsDataHealth(exams, attempts),
        [attempts, dataMode, exams],
    );
    const questionResultRepairPlan = useMemo(
        () => dataMode === "demo"
            ? buildQuestionResultRepairPlan([], [])
            : buildQuestionResultRepairPlan(exams, attempts),
        [attempts, dataMode, exams],
    );

    const loadDashboardData = useCallback(async (options: DashboardLoadOptions = {}) => {
        const [examResult, attemptResult, rosterResult] = await Promise.all([
            loadExams(),
            loadAttempts(),
            loadRosterSnapshot(localStorage),
        ]);
        if (options.isCancelled?.()) return;

        const loadedExams = [...examResult.items];
        const loadedAttempts = [...attemptResult.items];
        const loadedRosterStudents = [...rosterResult.students];
        const loadedRosterGroups = [...rosterResult.groups];
        const nextSyncStatus = summarizePersistenceHealth([examResult, attemptResult, rosterResult]);
        setSyncStatus(nextSyncStatus);
        if (nextSyncStatus.kind === "error" && options.notifyOnError !== false) {
            toast.info(
                "로컬 데이터 기준으로 표시 중",
                "Supabase 동기화가 일부 지연되고 있어 시험·제출·명단은 다음 로드 때 다시 재시도합니다."
            );
        }

        // Seed demo data only when the DB is completely empty AND only in development.
        // Prevents the "[예시]" mock exams from appearing in production.
        const shouldSeedDemo = shouldUseDemoData() && loadedExams.length === 0 && loadedAttempts.length === 0;
        if (shouldSeedDemo) {
            const demo = buildDemoDashboardData();
            loadedExams.push(...demo.exams);
            loadedAttempts.push(...demo.attempts);
        }
        setDataMode(shouldSeedDemo ? "demo" : "real");

        // Sort exams by date
        loadedExams.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        setExams(loadedExams);
        setAttempts(loadedAttempts);
        setRosterStudents(loadedRosterStudents);
        setRosterGroups(loadedRosterGroups);

        const metrics = buildTeacherDashboardMetrics(loadedExams, loadedAttempts, {
            rosterStudents: shouldSeedDemo ? undefined : loadedRosterStudents,
        });

        setStats({
            totalStudents: metrics.totalStudents,
            avgScore: metrics.avgScore,
            activeExams: metrics.activeExams
        });

        if (metrics.trendData.length === 0 && shouldSeedDemo) {
            // Development-only fallback keeps the chart visually useful on a blank local workspace.
            setTrendData([65, 78, 72, 85, 82, 90, metrics.avgScore || 80]);
        } else {
            setTrendData(metrics.trendData);
        }

        if (options.notifyOnSuccess && nextSyncStatus.kind !== "error") {
            toast.success("동기화 확인 완료", nextSyncStatus.detail);
        }
    }, []);

    useEffect(() => {
        let cancelled = false;
        void loadDashboardData({ isCancelled: () => cancelled });
        return () => { cancelled = true; };
    }, [loadDashboardData]);

    useEffect(() => {
        const nextTab = normalizeDashboardTab(searchParams.get('tab'));
        const nextExamId = searchParams.get('examId') || undefined;
        setActiveTab(nextTab);
        setSelectedExamIdForAnalytics(nextExamId);
    }, [searchParams]);

    const handleNavigateToExamAnalytics = (examId: string) => {
        setSelectedExamIdForAnalytics(examId);
        setActiveTab('exam');
    };

    const handleRefreshDashboardData = async () => {
        if (isRefreshingDashboardData) return;
        setIsRefreshingDashboardData(true);
        setSyncStatus(summarizePersistenceHealth([]));
        try {
            await loadDashboardData({ notifyOnSuccess: true });
        } catch {
            toast.error("동기화 확인 실패", "데이터를 다시 읽지 못했습니다. 네트워크와 저장소 상태를 확인해주세요.");
        } finally {
            setIsRefreshingDashboardData(false);
        }
    };

    const handleRepairAnalyticsData = async () => {
        if (questionResultRepairPlan.repairableCount === 0) {
            toast.info("복구할 문항 결과 없음", "현재 자동 복구 가능한 제출이 없습니다.");
            return;
        }

        setIsRepairingAnalyticsData(true);
        try {
            const repairedAttempts: Attempt[] = [];
            let failedCount = 0;
            for (const item of questionResultRepairPlan.items) {
                const result = await saveAttempt(item.repairedAttempt);
                if (result.localSaved || result.remoteSaved) {
                    repairedAttempts.push(item.repairedAttempt);
                } else {
                    failedCount += 1;
                }
            }

            if (repairedAttempts.length > 0) {
                const repairedById = new Map(repairedAttempts.map(attempt => [attempt.id, attempt]));
                setAttempts(prev => prev.map(attempt => repairedById.get(attempt.id) || attempt));
            }

            if (failedCount > 0) {
                toast.error("일부 복구 실패", `${failedCount}건은 저장하지 못했습니다. 저장소 권한과 용량을 확인하세요.`);
            } else {
                toast.success(
                    "문항 결과 복구 완료",
                    `${repairedAttempts.length}개 제출, ${questionResultRepairPlan.repairedQuestionResultCount}개 문항 결과를 정리했습니다.`
                );
            }
        } finally {
            setIsRepairingAnalyticsData(false);
        }
    };

    const syncTone = {
        checking: {
            icon: RefreshCw,
            background: 'rgba(99,102,241,0.1)',
            border: 'rgba(99,102,241,0.22)',
            color: 'var(--primary)',
        },
        local: {
            icon: CloudOff,
            background: 'rgba(100,116,139,0.1)',
            border: 'rgba(100,116,139,0.22)',
            color: 'var(--muted)',
        },
        synced: {
            icon: CheckCircle2,
            background: 'rgba(16,185,129,0.1)',
            border: 'rgba(16,185,129,0.24)',
            color: 'var(--success)',
        },
        pending: {
            icon: RefreshCw,
            background: 'rgba(245,158,11,0.12)',
            border: 'rgba(245,158,11,0.26)',
            color: 'var(--warning)',
        },
        error: {
            icon: AlertTriangle,
            background: 'rgba(239,68,68,0.1)',
            border: 'rgba(239,68,68,0.24)',
            color: 'var(--error)',
        },
    }[syncStatus.kind];
    const SyncIcon = syncTone.icon;

    const dataHealthTone = {
        empty: {
            icon: Database,
            background: 'rgba(100,116,139,0.1)',
            border: 'rgba(100,116,139,0.22)',
            color: 'var(--muted)',
        },
        ready: {
            icon: CheckCircle2,
            background: 'rgba(16,185,129,0.1)',
            border: 'rgba(16,185,129,0.24)',
            color: 'var(--success)',
        },
        attention: {
            icon: AlertTriangle,
            background: 'rgba(245,158,11,0.12)',
            border: 'rgba(245,158,11,0.26)',
            color: 'var(--warning)',
        },
        blocked: {
            icon: AlertTriangle,
            background: 'rgba(239,68,68,0.1)',
            border: 'rgba(239,68,68,0.24)',
            color: 'var(--error)',
        },
    }[analyticsDataHealth.kind];
    const DataHealthIcon = dataHealthTone.icon;
    const dashboardAnalysisActions = useMemo<DashboardAnalysisAction[]>(() => {
        const actions: DashboardAnalysisAction[] = [];

        if (dataMode === "demo" || analyticsDataHealth.kind === "empty") {
            actions.push({
                key: "create",
                label: "시험 출제하기",
                detail: "실제 시험을 만들면 예시 데이터 대신 실데이터 분석으로 전환됩니다.",
                tone: "primary",
            });
            actions.push({
                key: "refresh",
                label: "데이터 다시 확인",
                detail: "저장소와 Supabase 동기화 상태를 다시 읽습니다.",
                tone: "muted",
            });
            return actions;
        }

        if (questionResultRepairPlan.repairableCount > 0) {
            actions.push({
                key: "repair",
                label: "문항 결과 복구",
                detail: `${questionResultRepairPlan.repairableCount}개 제출의 오답/유형 분석 행을 채웁니다.`,
                tone: "warning",
            });
        }

        if (analyticsDataHealth.issues.some(issue => issue.key === "missing-answers" || issue.key === "untagged-questions" || issue.key === "region-missing" || issue.key === "pdf-unlinked")) {
            actions.push({
                key: "create",
                label: "시험 메타 보강",
                detail: "정답, 유형 태그, PDF 영역을 보강해 재추천 품질을 높입니다.",
                tone: "muted",
            });
        }

        actions.push({
            key: "exam",
            label: "시험 분석 보기",
            detail: "시험별 오답, 유형, 반별 약점 매트릭스를 확인합니다.",
            tone: "primary",
        });
        actions.push({
            key: "student",
            label: "학생 성취도 보기",
            detail: "학생별 원시험/재시험 흐름과 반복 약점을 확인합니다.",
            tone: "primary",
        });

        return actions;
    }, [analyticsDataHealth.issues, analyticsDataHealth.kind, dataMode, questionResultRepairPlan.repairableCount]);

    // Tab Navigation Component
    const renderTabs = () => (
        <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(160px, 100%), 1fr))',
            gap: '0.5rem',
            marginBottom: '2rem',
            background: 'var(--surface)', padding: '0.5rem', borderRadius: 'var(--radius-lg)',
            border: '1px solid var(--border)',
            boxShadow: '0 4px 6px rgba(0,0,0,0.02)'
        }}>
            <button
                onClick={() => setActiveTab('overview')}
                style={{
                    display: 'flex', alignItems: 'center', gap: '0.5rem',
                    padding: '0.75rem 1.5rem', borderRadius: 'var(--radius-md)',
                    background: activeTab === 'overview' ? 'var(--primary)' : 'transparent',
                    color: activeTab === 'overview' ? 'white' : 'var(--muted)',
                    fontWeight: activeTab === 'overview' ? 700 : 500,
                    transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
                    justifyContent: 'center',
                    whiteSpace: 'nowrap',
                    minWidth: 0,
                }}
            >
                <LayoutDashboard size={18} />
                대시보드 요약
            </button>
            <button
                onClick={() => setActiveTab('exam')}
                style={{
                    display: 'flex', alignItems: 'center', gap: '0.5rem',
                    padding: '0.75rem 1.5rem', borderRadius: 'var(--radius-md)',
                    background: activeTab === 'exam' ? 'var(--primary)' : 'transparent',
                    color: activeTab === 'exam' ? 'white' : 'var(--muted)',
                    fontWeight: activeTab === 'exam' ? 700 : 500,
                    transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
                    justifyContent: 'center',
                    whiteSpace: 'nowrap',
                    minWidth: 0,
                }}
            >
                <BarChart2 size={18} />
                시험 분석
            </button>
            <button
                onClick={() => setActiveTab('student')}
                style={{
                    display: 'flex', alignItems: 'center', gap: '0.5rem',
                    padding: '0.75rem 1.5rem', borderRadius: 'var(--radius-md)',
                    background: activeTab === 'student' ? 'var(--primary)' : 'transparent',
                    color: activeTab === 'student' ? 'white' : 'var(--muted)',
                    fontWeight: activeTab === 'student' ? 700 : 500,
                    transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
                    justifyContent: 'center',
                    whiteSpace: 'nowrap',
                    minWidth: 0,
                }}
            >
                <GraduationCap size={18} />
                학생 성취도
            </button>
        </div>
    );

    return (
        <div className="layout-main">
            <header className="header teacher-header">
                <div className="container header-content">
                    <div className="teacher-header-brand" style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                        <BrandLogo />
                        <span style={{
                            fontSize: '0.75rem', fontWeight: 700,
                            background: 'rgba(99, 102, 241, 0.1)', color: 'var(--primary)',
                            padding: '4px 10px', borderRadius: 'var(--radius-full)',
                            border: '1px solid rgba(99, 102, 241, 0.2)'
                        }}>
                            TEACHER
                        </span>
                    </div>
                    <div className="teacher-header-actions" style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
                        <Link href="/teacher/live" style={{
                            display: 'inline-flex', alignItems: 'center', gap: '0.35rem',
                            fontSize: '0.82rem', fontWeight: 700,
                            color: 'var(--success)',
                            padding: '0.45rem 0.85rem', borderRadius: 'var(--radius-full)',
                            border: '1px solid rgba(16,185,129,0.28)',
                            background: 'rgba(16,185,129,0.08)',
                            minHeight: '2.75rem',
                        }} className="nav-link-live" aria-label="실시간 모니터링">
                            <Activity size={14} />
                            <span>Live</span>
                        </Link>
                        <TeacherSessionChip />
                        <NotificationBell />
                        <TeacherLogoutButton />
                        <ThemeToggle />
                    </div>
                </div>
            </header>

            <main className="container animate-fade-in" style={{ paddingBottom: '4rem' }}>
                {/* Welcome Section */}
                <div style={{ margin: '3rem 0', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: '1rem', flexWrap: 'wrap' }}>
                    <div style={{ minWidth: 0 }}>
                        <h1 style={{ fontSize: '2.5rem', marginBottom: '0.75rem', lineHeight: 1.2, fontWeight: 800, letterSpacing: '-0.02em', color: 'var(--foreground)' }}>
                            분석 센터
                        </h1>
                        <p className="text-muted" style={{ fontSize: '1.1rem' }}>
                            방대한 리포트와 시험 통계를 한 번에 관리하세요.
                        </p>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                        <div
                            aria-label="데이터 동기화 상태"
                            title={syncStatus.error || syncStatus.detail}
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.6rem',
                                padding: '0.65rem 0.85rem',
                                borderRadius: 'var(--radius-full)',
                                border: `1px solid ${syncTone.border}`,
                                background: syncTone.background,
                                color: syncTone.color,
                                minWidth: 0,
                            }}
                        >
                            <SyncIcon size={17} />
                            <span style={{ display: 'grid', gap: 2, minWidth: 0 }}>
                                <span style={{ fontSize: '0.8rem', fontWeight: 800, lineHeight: 1.1, whiteSpace: 'nowrap' }}>
                                    {syncStatus.label}
                                </span>
                                <span style={{ fontSize: '0.72rem', color: 'var(--muted)', lineHeight: 1.1, whiteSpace: 'nowrap' }}>
                                    {syncStatus.detail}
                                </span>
                            </span>
                            <button
                                type="button"
                                onClick={handleRefreshDashboardData}
                                disabled={isRefreshingDashboardData}
                                aria-label="동기화 다시 확인"
                                title="로컬과 Supabase 데이터를 다시 확인합니다"
                                style={{
                                    width: 28,
                                    height: 28,
                                    borderRadius: 'var(--radius-full)',
                                    border: `1px solid ${syncTone.border}`,
                                    background: 'var(--surface)',
                                    color: syncTone.color,
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    cursor: isRefreshingDashboardData ? 'wait' : 'pointer',
                                    flexShrink: 0,
                                }}
                            >
                                <RefreshCw size={14} className={isRefreshingDashboardData ? "animate-spin" : undefined} />
                            </button>
                        </div>
                        <div
                            aria-label="분석 데이터 상태"
                            title={analyticsDataHealth.issues[0]?.detail || analyticsDataHealth.detail}
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.6rem',
                                padding: '0.65rem 0.85rem',
                                borderRadius: 'var(--radius-full)',
                                border: `1px solid ${dataHealthTone.border}`,
                                background: dataHealthTone.background,
                                color: dataHealthTone.color,
                                minWidth: 0,
                            }}
                        >
                            <DataHealthIcon size={17} />
                            <span style={{ display: 'grid', gap: 2, minWidth: 0 }}>
                                <span style={{ fontSize: '0.8rem', fontWeight: 800, lineHeight: 1.1, whiteSpace: 'nowrap' }}>
                                    {analyticsDataHealth.label}
                                </span>
                                <span style={{ fontSize: '0.72rem', color: 'var(--muted)', lineHeight: 1.1, whiteSpace: 'nowrap' }}>
                                    {analyticsDataHealth.score}점 · {analyticsDataHealth.detail}
                                </span>
                            </span>
                        </div>
                        {activeTab !== 'overview' && (
                            <Link href="/create" style={{
                                padding: '0.75rem 1.5rem', background: 'var(--primary)',
                                color: 'white', borderRadius: 'var(--radius-full)',
                                fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem',
                                boxShadow: '0 4px 12px rgba(99, 102, 241, 0.3)'
                            }}>
                                시험 출제하기
                            </Link>
                        )}
                    </div>
                </div>

                {dataMode === "demo" && (
                    <div
                        role="status"
                        aria-label="데모 데이터 안내"
                        style={{
                            display: 'flex',
                            alignItems: 'flex-start',
                            gap: '0.85rem',
                            padding: '1rem 1.1rem',
                            marginBottom: '1.5rem',
                            borderRadius: 'var(--radius-lg)',
                            border: '1px solid rgba(245,158,11,0.28)',
                            background: 'rgba(245,158,11,0.09)',
                            color: 'var(--foreground)',
                        }}
                    >
                        <AlertTriangle size={19} color="var(--warning)" style={{ flexShrink: 0, marginTop: 2 }} />
                        <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: '0.9rem', fontWeight: 900, color: 'var(--warning)', marginBottom: '0.2rem' }}>
                                데모 데이터 모드
                            </div>
                            <p style={{ fontSize: '0.82rem', color: 'var(--muted)', lineHeight: 1.55, wordBreak: 'keep-all' }}>
                                현재 저장된 시험과 제출이 없어 예시 시험/학생 데이터로 화면을 채웠습니다. 실제 시험을 만들거나 제출이 들어오면 예시 데이터는 자동으로 사라집니다.
                            </p>
                        </div>
                    </div>
                )}

                {dataMode === "real" && analyticsDataHealth.kind !== "ready" && (
                    <div
                        role="status"
                        aria-label="분석 데이터 상태"
                        style={{
                            display: 'grid',
                            gridTemplateColumns: 'minmax(0, 1.2fr) minmax(220px, 1fr)',
                            gap: '1rem',
                            alignItems: 'stretch',
                            padding: '1rem 1.1rem',
                            marginBottom: '1.5rem',
                            borderRadius: 'var(--radius-lg)',
                            border: `1px solid ${dataHealthTone.border}`,
                            background: dataHealthTone.background,
                            color: 'var(--foreground)',
                        }}
                        className="dashboard-data-health"
                    >
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.85rem', minWidth: 0 }}>
                            <DataHealthIcon size={20} color={dataHealthTone.color} style={{ flexShrink: 0, marginTop: 2 }} />
                            <div style={{ minWidth: 0 }}>
                                <div style={{ fontSize: '0.9rem', fontWeight: 900, color: dataHealthTone.color, marginBottom: '0.2rem' }}>
                                    {analyticsDataHealth.label}
                                </div>
                                <p style={{ fontSize: '0.82rem', color: 'var(--muted)', lineHeight: 1.55, wordBreak: 'keep-all' }}>
                                    시험 {analyticsDataHealth.totalExamCount}개, 제출 {analyticsDataHealth.totalAttemptCount}건, 문항 {analyticsDataHealth.totalQuestionCount}개 기준입니다. {analyticsDataHealth.detail}
                                </p>
                            </div>
                        </div>
                        <div style={{ display: 'grid', gap: '0.45rem', alignContent: 'center' }}>
                            {analyticsDataHealth.issues.slice(0, 4).map(issue => (
                                <div
                                    key={issue.key}
                                    style={{
                                        display: 'flex',
                                        justifyContent: 'space-between',
                                        alignItems: 'center',
                                        gap: '0.75rem',
                                        padding: '0.45rem 0.55rem',
                                        borderRadius: 'var(--radius-md)',
                                        border: '1px solid var(--border)',
                                        background: 'var(--surface)',
                                    }}
                                >
                                    <span style={{ fontSize: '0.78rem', fontWeight: 800, color: 'var(--foreground)', minWidth: 0 }}>
                                        {issue.label}
                                    </span>
                                    <span style={{
                                        flexShrink: 0,
                                        fontSize: '0.72rem',
                                        fontWeight: 900,
                                        color: issue.severity === "error" ? 'var(--error)' : 'var(--warning)',
                                    }}>
                                        {issue.count}건
                                    </span>
                                </div>
                            ))}
                            {questionResultRepairPlan.repairableCount > 0 && (
                                <>
                                    <button
                                        type="button"
                                        onClick={handleRepairAnalyticsData}
                                        disabled={isRepairingAnalyticsData}
                                        style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'space-between',
                                            gap: '0.75rem',
                                            padding: '0.58rem 0.7rem',
                                            borderRadius: 'var(--radius-md)',
                                            border: '1px solid rgba(99,102,241,0.28)',
                                            background: 'rgba(99,102,241,0.1)',
                                            color: 'var(--primary)',
                                            cursor: isRepairingAnalyticsData ? 'wait' : 'pointer',
                                            fontSize: '0.8rem',
                                            fontWeight: 900,
                                        }}
                                    >
                                        <span>{isRepairingAnalyticsData ? "문항 결과 복구 중..." : "문항 결과 자동 복구"}</span>
                                        <span style={{ flexShrink: 0, color: 'var(--muted)', fontSize: '0.72rem' }}>
                                            {questionResultRepairPlan.repairableCount}제출 · {questionResultRepairPlan.repairedQuestionResultCount}문항
                                        </span>
                                    </button>
                                    <div style={{
                                        display: 'grid',
                                        gap: '0.35rem',
                                        padding: '0.62rem 0.68rem',
                                        borderRadius: 'var(--radius-md)',
                                        border: '1px dashed var(--border)',
                                        background: 'var(--surface)',
                                    }}>
                                        <div style={{ fontSize: '0.72rem', color: 'var(--muted)', fontWeight: 900 }}>
                                            복구 대상 미리보기
                                        </div>
                                        {questionResultRepairPlan.items.slice(0, 3).map(item => (
                                            <div key={item.attemptId} style={{ display: 'flex', justifyContent: 'space-between', gap: '0.65rem', fontSize: '0.72rem', color: 'var(--foreground)', lineHeight: 1.35 }}>
                                                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                    {item.examTitle} · {item.studentName || "학생 미상"}
                                                </span>
                                                <span style={{ color: 'var(--primary)', fontWeight: 900, flexShrink: 0 }}>
                                                    {item.missingQuestionResultCount}/{item.expectedQuestionCount}문항
                                                </span>
                                            </div>
                                        ))}
                                        {questionResultRepairPlan.repairableCount > 3 && (
                                            <div style={{ color: 'var(--muted)', fontSize: '0.7rem', fontWeight: 800 }}>
                                                외 {questionResultRepairPlan.repairableCount - 3}개 제출 추가 복구 예정
                                            </div>
                                        )}
                                    </div>
                                </>
                            )}
                            {(questionResultRepairPlan.skippedOrphanAttemptCount > 0 || questionResultRepairPlan.skippedInProgressAttemptCount > 0) && (
                                <div style={{ fontSize: '0.72rem', color: 'var(--muted)', fontWeight: 800, lineHeight: 1.5, wordBreak: 'keep-all' }}>
                                    자동 복구 제외:
                                    {questionResultRepairPlan.skippedOrphanAttemptCount > 0 ? ` 시험 없는 제출 ${questionResultRepairPlan.skippedOrphanAttemptCount}건` : ""}
                                    {questionResultRepairPlan.skippedOrphanAttemptCount > 0 && questionResultRepairPlan.skippedInProgressAttemptCount > 0 ? " ·" : ""}
                                    {questionResultRepairPlan.skippedInProgressAttemptCount > 0 ? ` 진행 중 제출 ${questionResultRepairPlan.skippedInProgressAttemptCount}건` : ""}
                                </div>
                            )}
                            {analyticsDataHealth.issues.length === 0 && (
                                <div style={{ fontSize: '0.8rem', color: 'var(--muted)', fontWeight: 800 }}>
                                    실제 시험과 제출이 쌓이면 자동으로 점검합니다.
                                </div>
                            )}
                        </div>
                    </div>
                )}

                <div
                    className="dashboard-analysis-actions"
                    aria-label="분석 다음 조치"
                    style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fit, minmax(min(210px, 100%), 1fr))',
                        gap: '0.75rem',
                        marginBottom: '1.5rem',
                    }}
                >
                    {dashboardAnalysisActions.map(action => {
                        const actionTone = action.tone === "primary"
                            ? { border: 'rgba(99,102,241,0.24)', background: 'rgba(99,102,241,0.08)', color: 'var(--primary)' }
                            : action.tone === "warning"
                                ? { border: 'rgba(245,158,11,0.28)', background: 'rgba(245,158,11,0.09)', color: 'var(--warning)' }
                                : { border: 'var(--border)', background: 'var(--surface)', color: 'var(--foreground)' };
                        const content = (
                            <>
                                <span style={{ display: 'block', color: actionTone.color, fontSize: '0.86rem', fontWeight: 950, marginBottom: '0.2rem' }}>
                                    {action.label}
                                </span>
                                <span style={{ display: 'block', color: 'var(--muted)', fontSize: '0.76rem', lineHeight: 1.45, wordBreak: 'keep-all' }}>
                                    {action.detail}
                                </span>
                            </>
                        );
                        const sharedStyle = {
                            width: '100%',
                            minHeight: 78,
                            padding: '0.85rem 0.95rem',
                            borderRadius: 'var(--radius-lg)',
                            border: `1px solid ${actionTone.border}`,
                            background: actionTone.background,
                            textAlign: 'left' as const,
                            cursor: 'pointer',
                        };

                        if (action.key === "create") {
                            return (
                                <Link key={action.key} href="/create" style={sharedStyle}>
                                    {content}
                                </Link>
                            );
                        }

                        return (
                            <button
                                key={action.key}
                                type="button"
                                onClick={() => {
                                    if (action.key === "exam") setActiveTab("exam");
                                    if (action.key === "student") setActiveTab("student");
                                    if (action.key === "repair") void handleRepairAnalyticsData();
                                    if (action.key === "refresh") void handleRefreshDashboardData();
                                }}
                                disabled={(action.key === "repair" && isRepairingAnalyticsData) || (action.key === "refresh" && isRefreshingDashboardData)}
                                style={{
                                    ...sharedStyle,
                                    opacity: (action.key === "repair" && isRepairingAnalyticsData) || (action.key === "refresh" && isRefreshingDashboardData) ? 0.62 : 1,
                                    cursor: (action.key === "repair" && isRepairingAnalyticsData) || (action.key === "refresh" && isRefreshingDashboardData) ? 'wait' : 'pointer',
                                }}
                            >
                                {content}
                            </button>
                        );
                    })}
                </div>

                {/* Tabs */}
                {renderTabs()}

                {/* Tab Content */}
                <div style={{ minHeight: '600px' }}>
                    {activeTab === 'overview' && (
                        <OverviewTab
                            exams={exams}
                            attempts={attempts}
                            stats={stats}
                            trendData={trendData}
                            onNavigateToExamAnalytics={handleNavigateToExamAnalytics}
                        />
                    )}
                    {activeTab === 'exam' && (
                        <ExamAnalyticsTab
                            exams={exams}
                            attempts={attempts}
                            rosterStudents={rosterStudents}
                            rosterGroups={rosterGroups}
                            initialExamId={selectedExamIdForAnalytics}
                            currentPlan={currentPlan}
                        />
                    )}
                    {activeTab === 'student' && (
                        <StudentAnalyticsTab
                            exams={exams}
                            attempts={attempts}
                            rosterStudents={rosterStudents}
                            rosterGroups={rosterGroups}
                            currentPlan={currentPlan}
                        />
                    )}
                </div>

            </main>
        </div>
    );
}
