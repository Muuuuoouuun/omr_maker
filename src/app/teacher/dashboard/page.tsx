"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import TeacherHeader from "@/components/TeacherHeader";
import { Exam, Attempt } from "@/types/omr";
import OverviewTab from "@/components/dashboard/tabs/OverviewTab";
import StatusPill from "@/components/dashboard/StatusPill";
import { AlertTriangle, BarChart2, CheckCircle2, CloudOff, Database, GraduationCap, LayoutDashboard, RefreshCw } from "lucide-react";
import { AnalyticsTabSkeleton, DashboardPageSkeleton } from "@/components/dashboard/DashboardLoadingSkeleton";

// Analytics tabs statically import recharts + thousands of lines of analytics code
// but only render when their tab is active. Defer them so the default overview paints
// without pulling those modules into the initial route bundle.
const ExamAnalyticsTab = dynamic(() => import("@/components/dashboard/tabs/ExamAnalyticsTab"), {
    ssr: false,
    loading: () => <AnalyticsTabSkeleton />,
});
const StudentAnalyticsTab = dynamic(() => import("@/components/dashboard/tabs/StudentAnalyticsTab"), {
    ssr: false,
    loading: () => <AnalyticsTabSkeleton />,
});
// Only ever rendered for the signed mockup account, but a static import made
// it the one thing that still pulled recharts into every teacher's initial
// dashboard bundle — cancelling out the two dynamic() calls above.
const MockupOverview = dynamic(() => import("@/components/dashboard/MockupOverview"), {
    ssr: false,
    loading: () => <AnalyticsTabSkeleton />,
});
import { toast } from "@/components/Toast";
import { createDashboardRevalidationGate, isTeacherDashboardStorageKey } from "@/components/dashboard/dashboardRevalidation";
import { buildDemoDashboardData } from "@/lib/demoData";
import { buildQuestionResultRepairPlan } from "@/lib/analyticsDataRepair";
import { readLocalAttempts, readLocalExams, saveLocalAttempt } from "@/lib/omrPersistence";
import {
    loadTeacherAttemptSummaries,
    loadTeacherAttempts,
    resolveTeacherAttemptCollectionCompleteness,
} from "@/lib/teacherAttemptClient";
import { loadTeacherExams } from "@/lib/teacherExamClient";
import { summarizeAnalyticsDataHealth, summarizePersistenceHealth, type PersistenceHealth } from "@/lib/persistenceHealth";
import { readLocalRosterSnapshot } from "@/lib/rosterPersistence";
import { loadTeacherRosterSnapshot } from "@/lib/teacherRosterClient";
import type { RosterGroup, RosterStudent } from "@/lib/rosterStorage";
import { buildTeacherDashboardMetrics } from "@/lib/teacherDashboardMetrics";
import {
    beginDashboardDetailBackgroundRetry,
    preferLocalDashboardItems,
    resolveDashboardDetailRetryFailure,
    type DashboardDetailSnapshot,
} from "@/lib/teacherDashboardLoad";
import { useServerPlan } from "@/lib/useServerPlan";
import { readTeacherSession } from "@/lib/teacherSession";
import { isMockupTeacherIdentity } from "@/lib/mockupAccount";
import { loadTeacherAttemptAggregate } from "@/lib/teacherAttemptReportingClient";
import type { TeacherAttemptAggregate } from "@/lib/teacherAttemptReportingGateway";
import { loadTeacherIndividualAssignmentTargetCounts } from "@/app/actions/teacherAssignment";
import type { ExamAnalyticsSampleStatus } from "@/lib/examAnalyticsReport";
import { resolveCanonicalLoad, type CanonicalLoadState } from "@/lib/canonicalLoadState";

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
type DashboardSnapshot = {
    exams: Exam[];
    attempts: Attempt[];
    rosterStudents: RosterStudent[];
    rosterGroups: RosterGroup[];
    aggregate?: TeacherAttemptAggregate;
    individualAssignmentTargetCounts?: Record<string, number>;
    individualAssignmentModes?: Record<string, "base" | "retake">;
    forceDemoData?: boolean;
};
type DetailedAttemptLoad = {
    generation: number;
    promise: ReturnType<typeof loadTeacherAttempts>;
};
const TEACHER_DASHBOARD_CACHE_STALE_AT_KEY = "omr_teacher_dashboard_cache_stale_at_v1";

function isDashboardSnapshotEmpty(snapshot: DashboardSnapshot): boolean {
    return snapshot.forceDemoData !== true
        && snapshot.exams.length === 0
        && snapshot.attempts.length === 0
        && snapshot.rosterStudents.length === 0
        && snapshot.rosterGroups.length === 0;
}

function buildAttemptSummarySignal(attempts: Attempt[]): string {
    return attempts
        .map(attempt => {
            // The current lightweight projection exposes lifecycle timestamps rather
            // than updatedAt. Keep the optional field in the signal so a future
            // projection can strengthen invalidation without another cache rewrite.
            const updatedAt = (attempt as Attempt & { updatedAt?: unknown }).updatedAt;
            return [
                attempt.id,
                typeof updatedAt === "string" ? updatedAt : "",
                attempt.status,
                attempt.finishedAt,
                attempt.score,
                attempt.totalScore,
                attempt.mergedAt || "",
                attempt.drawingPageCount ?? "",
                attempt.drawingStrokeCount ?? "",
                JSON.stringify(attempt.retake || null),
                JSON.stringify(attempt.studentQuestions || []),
            ].join("\u001f");
        })
        .sort()
        .join("\u001e");
}

function normalizeDashboardTab(value: string | null): TabType {
    return value === "exam" || value === "student" || value === "overview" ? value : "overview";
}

// Wrap the inner component so useSearchParams is inside a Suspense boundary
// (required by Next 16 to avoid deopting the whole page to client-only rendering).
export default function TeacherDashboardPage() {
    return (
        <Suspense fallback={<DashboardPageSkeleton />}>
            <TeacherDashboard />
        </Suspense>
    );
}

function TeacherDashboard() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const initialTab = normalizeDashboardTab(searchParams.get('tab'));
    const initialExamId = searchParams.get('examId') || undefined;
    const [activeTab, setActiveTab] = useState<TabType>(initialTab);
    const [isMockupAccount, setIsMockupAccount] = useState(false);
    const [isAccountModeResolved, setIsAccountModeResolved] = useState(false);
    useEffect(() => {
        setIsMockupAccount(isMockupTeacherIdentity(readTeacherSession()));
        setIsAccountModeResolved(true);
    }, []);
    const [selectedExamIdForAnalytics, setSelectedExamIdForAnalytics] = useState<string | undefined>(initialExamId);
    const [exams, setExams] = useState<Exam[]>([]);
    const [attempts, setAttempts] = useState<Attempt[]>([]);
    const [detailedAttempts, setDetailedAttempts] = useState<Attempt[] | null>(null);
    const [detailedAttemptStatus, setDetailedAttemptStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
    const [detailedAttemptGeneration, setDetailedAttemptGeneration] = useState(0);
    const detailedAttemptGenerationRef = useRef(0);
    const detailedAttemptCacheRef = useRef<DashboardDetailSnapshot<Attempt> | null>(null);
    const detailedAttemptLoadRef = useRef<DetailedAttemptLoad | null>(null);
    const attemptSummarySignalRef = useRef<string | null>(null);
    const [rosterStudents, setRosterStudents] = useState<RosterStudent[]>([]);
    const [rosterGroups, setRosterGroups] = useState<RosterGroup[]>([]);
    const [individualAssignmentTargetCounts, setIndividualAssignmentTargetCounts] = useState<ReadonlyMap<string, number>>(
        () => new Map(),
    );
    const [individualAssignmentModes, setIndividualAssignmentModes] = useState<ReadonlyMap<string, "base" | "retake">>(
        () => new Map(),
    );
    const [stats, setStats] = useState({
        totalStudents: 0,
        avgScore: 0,
        activeExams: 0
    });
    const [trendData, setTrendData] = useState<number[]>([]);
    const [trendLabels, setTrendLabels] = useState<string[]>([]);
    const [dataMode, setDataMode] = useState<DashboardDataMode>("real");
    const { plan: currentPlan } = useServerPlan();
    const [syncStatus, setSyncStatus] = useState<PersistenceHealth>(() => summarizePersistenceHealth([]));
    const [dashboardLoadState, setDashboardLoadState] = useState<CanonicalLoadState<DashboardSnapshot>>({ state: "loading" });
    const [isRefreshingDashboardData, setIsRefreshingDashboardData] = useState(false);
    const [isRepairingAnalyticsData, setIsRepairingAnalyticsData] = useState(false);
    const [detailedAttemptSampleStatus, setDetailedAttemptSampleStatus] = useState<ExamAnalyticsSampleStatus>("ready");
    const [detailedAttemptWarning, setDetailedAttemptWarning] = useState("");
    const analyticsAttempts = useMemo(
        () => dataMode === "demo" ? attempts : detailedAttempts || [],
        [attempts, dataMode, detailedAttempts],
    );
    const analyticsDataHealth = useMemo(
        () => dataMode === "demo"
            ? summarizeAnalyticsDataHealth([], [])
            : summarizeAnalyticsDataHealth(exams, analyticsAttempts),
        [analyticsAttempts, dataMode, exams],
    );
    const questionResultRepairPlan = useMemo(
        () => dataMode === "demo"
            ? buildQuestionResultRepairPlan([], [])
            : buildQuestionResultRepairPlan(exams, analyticsAttempts),
        [analyticsAttempts, dataMode, exams],
    );

    const invalidateDetailedAttempts = useCallback(() => {
        const nextGeneration = detailedAttemptGenerationRef.current + 1;
        detailedAttemptGenerationRef.current = nextGeneration;
        detailedAttemptCacheRef.current = null;
        setDetailedAttempts(null);
        setDetailedAttemptStatus("idle");
        setDetailedAttemptSampleStatus("ready");
        setDetailedAttemptWarning("");
        setDetailedAttemptGeneration(nextGeneration);
    }, []);

    const retryDetailedAttempts = useCallback(() => {
        const retry = beginDashboardDetailBackgroundRetry({
            generation: detailedAttemptGenerationRef.current,
            snapshot: detailedAttemptCacheRef.current,
        });
        detailedAttemptGenerationRef.current = retry.generation;
        setDetailedAttempts(retry.items);
        setDetailedAttemptStatus(retry.loadStatus);
        setDetailedAttemptSampleStatus(retry.sampleStatus);
        setDetailedAttemptWarning("");
        setDetailedAttemptGeneration(retry.generation);
    }, []);

    const loadDetailedAttempts = useCallback(async (): Promise<Attempt[]> => {
        if (dataMode === "demo") return attempts;

        // A summary refresh can finish while a rich request is in flight. Loop onto
        // the newest generation instead of publishing or exporting the stale rows.
        while (true) {
            const requestedGeneration = detailedAttemptGenerationRef.current;
            const cached = detailedAttemptCacheRef.current;
            if (cached?.generation === requestedGeneration) {
                setDetailedAttemptSampleStatus(cached.sampleStatus);
                return cached.items;
            }

            let activeLoad = detailedAttemptLoadRef.current;
            if (!activeLoad || activeLoad.generation !== requestedGeneration) {
                if (!detailedAttemptCacheRef.current) {
                    setDetailedAttemptStatus("loading");
                }
                activeLoad = {
                    generation: requestedGeneration,
                    promise: loadTeacherAttempts(),
                };
                detailedAttemptLoadRef.current = activeLoad;
            }

            try {
                const result = await activeLoad.promise;
                if (requestedGeneration !== detailedAttemptGenerationRef.current) continue;
                const completeness = resolveTeacherAttemptCollectionCompleteness(result);
                if (completeness === "error") {
                    throw new Error(result.remoteError || "상세 제출 데이터를 확인하지 못했습니다.");
                }
                const sampleStatus: ExamAnalyticsSampleStatus = completeness === "partial"
                    ? "partial"
                    : completeness === "stale"
                        ? "stale"
                        : "ready";
                detailedAttemptCacheRef.current = {
                    generation: requestedGeneration,
                    items: result.items,
                    sampleStatus,
                };
                setDetailedAttempts(result.items);
                setDetailedAttemptSampleStatus(sampleStatus);
                setDetailedAttemptWarning(sampleStatus === "stale" ? result.remoteError || "최신 서버 데이터를 확인하지 못했습니다." : "");
                setDetailedAttemptStatus("ready");
                return result.items;
            } catch (error) {
                const message = error instanceof Error ? error.message : "상세 제출 데이터를 확인하지 못했습니다.";
                const failure = resolveDashboardDetailRetryFailure({
                    requestedGeneration,
                    currentGeneration: detailedAttemptGenerationRef.current,
                    snapshot: detailedAttemptCacheRef.current,
                    message,
                });
                if (failure.kind === "obsolete") continue;
                setDetailedAttemptWarning(failure.warning);
                if (failure.kind === "cached") {
                    detailedAttemptCacheRef.current = {
                        generation: requestedGeneration,
                        items: failure.items,
                        sampleStatus: failure.sampleStatus,
                    };
                    setDetailedAttempts(failure.items);
                    setDetailedAttemptSampleStatus(failure.sampleStatus);
                    setDetailedAttemptStatus(failure.loadStatus);
                    return failure.items;
                }
                setDetailedAttemptStatus(failure.loadStatus);
                throw error;
            } finally {
                if (detailedAttemptLoadRef.current === activeLoad) {
                    detailedAttemptLoadRef.current = null;
                }
            }
        }
    }, [attempts, dataMode]);

    useEffect(() => {
        const dashboardAllowsDetailedAnalysis = dashboardLoadState.state === "loaded_data"
            || dashboardLoadState.state === "degraded_with_cache";
        if (activeTab === "overview" || isMockupAccount || !dashboardAllowsDetailedAnalysis) return;
        void loadDetailedAttempts().catch(() => {
            toast.error("분석 데이터 로드 실패", "상세 제출 데이터를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.");
        });
    }, [activeTab, dashboardLoadState.state, detailedAttemptGeneration, isMockupAccount, loadDetailedAttempts]);

    const applyDashboardSnapshot = useCallback((snapshot: DashboardSnapshot) => {
        const loadedExams = [...snapshot.exams];
        const loadedAttempts = [...snapshot.attempts];
        const loadedRosterStudents = [...snapshot.rosterStudents];
        const loadedRosterGroups = [...snapshot.rosterGroups];

        // Synthetic analytics are display-only and belong exclusively to the
        // signed public mockup account. Real teacher accounts keep an empty state.
        const shouldSeedDemo = snapshot.forceDemoData === true;
        if (shouldSeedDemo) {
            const demo = buildDemoDashboardData();
            loadedExams.push(...demo.exams);
            loadedAttempts.push(...demo.attempts);
            loadedRosterStudents.push(...demo.rosterStudents);
            loadedRosterGroups.push(...demo.rosterGroups);
        }
        setDataMode(shouldSeedDemo ? "demo" : "real");

        if (!shouldSeedDemo) {
            const nextSummarySignal = buildAttemptSummarySignal(loadedAttempts);
            const previousSummarySignal = attemptSummarySignalRef.current;
            attemptSummarySignalRef.current = nextSummarySignal;
            if (previousSummarySignal !== null && previousSummarySignal !== nextSummarySignal) {
                invalidateDetailedAttempts();
            }
        }

        loadedExams.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        setExams(loadedExams);
        setAttempts(loadedAttempts);
        setRosterStudents(loadedRosterStudents);
        setRosterGroups(loadedRosterGroups);
        setIndividualAssignmentTargetCounts(new Map(
            Object.entries(snapshot.individualAssignmentTargetCounts || {}),
        ));
        setIndividualAssignmentModes(new Map(
            Object.entries(snapshot.individualAssignmentModes || {}),
        ));

        const metrics = buildTeacherDashboardMetrics(loadedExams, loadedAttempts, {
            rosterStudents: shouldSeedDemo ? undefined : loadedRosterStudents,
        });
        setStats({
            totalStudents: loadedRosterStudents.length > 0
                ? metrics.totalStudents
                : snapshot.aggregate?.distinctStudentCount ?? metrics.totalStudents,
            avgScore: snapshot.aggregate
                ? Math.round(snapshot.aggregate.averageScorePercent * 10) / 10
                : metrics.avgScore,
            activeExams: metrics.activeExams,
        });
        setTrendData(metrics.trendData.length === 0 && shouldSeedDemo
            ? [65, 78, 72, 85, 82, 90, metrics.avgScore || 80]
            : metrics.trendData);
        setTrendLabels(metrics.trendData.length === 0 && shouldSeedDemo ? [] : metrics.trendLabels);
    }, [invalidateDetailedAttempts]);

    const loadDashboardData = useCallback(async (options: DashboardLoadOptions = {}) => {
        const loadObservedAt = new Date().toISOString();
        if (isMockupAccount) {
            const snapshot: DashboardSnapshot = {
                exams: [],
                attempts: [],
                rosterStudents: [],
                rosterGroups: [],
                forceDemoData: true,
            };
            applyDashboardSnapshot(snapshot);
            setDashboardLoadState(resolveCanonicalLoad({
                remote: { ok: true, data: snapshot },
                cache: null,
                now: loadObservedAt,
            }, isDashboardSnapshotEmpty));
            if (options.notifyOnSuccess) {
                toast.success("데모 데이터 새로고침 완료", "고정된 예시 데이터로 화면을 다시 구성했습니다.");
            }
            return;
        }
        const localRoster = readLocalRosterSnapshot(localStorage);
        const localSnapshot: DashboardSnapshot = {
            exams: readLocalExams(),
            attempts: readLocalAttempts(),
            rosterStudents: localRoster.students,
            rosterGroups: localRoster.groups,
        };
        let cachedAt: string | null = null;
        try { cachedAt = localStorage.getItem(TEACHER_DASHBOARD_CACHE_STALE_AT_KEY); } catch { /* fail closed below */ }

        const aggregatePromise = loadTeacherAttemptAggregate().catch(() => ({ status: "service_unavailable" as const }));
        let results: Awaited<ReturnType<typeof Promise.all<[
            ReturnType<typeof loadTeacherExams>,
            ReturnType<typeof loadTeacherAttemptSummaries>,
            ReturnType<typeof loadTeacherRosterSnapshot>,
        ]>>>;
        try {
            results = await Promise.all([
                loadTeacherExams(),
                loadTeacherAttemptSummaries(),
                loadTeacherRosterSnapshot(localStorage),
            ]);
        } catch (error) {
            if (options.isCancelled?.()) return;
            const message = error instanceof Error ? error.message : "Dashboard synchronization failed";
            setSyncStatus(summarizePersistenceHealth([{
                remoteLoaded: false,
                remoteSynced: false,
                pendingSyncCount: localSnapshot.exams.length
                    + localSnapshot.attempts.length
                    + localSnapshot.rosterStudents.length
                    + localSnapshot.rosterGroups.length,
                remoteError: message,
            }]));
            const nextState = resolveCanonicalLoad({
                remote: { ok: false },
                cache: cachedAt ? { data: localSnapshot, staleAt: cachedAt } : null,
                now: loadObservedAt,
            }, isDashboardSnapshotEmpty);
            setDashboardLoadState(nextState);
            if (nextState.state === "degraded_with_cache") applyDashboardSnapshot(nextState.data);
            if (options.notifyOnError === true) {
                toast.info(
                    "로컬 데이터 기준으로 표시 중",
                    "동기화 요청을 완료하지 못했습니다. 저장된 데이터는 유지하고 다음 로드 때 다시 시도합니다."
                );
            }
            return;
        }
        const [examResult, attemptResult, rosterResult] = results;
        const aggregateResult = await aggregatePromise;
        if (options.isCancelled?.()) return;

        const nextSyncStatus = summarizePersistenceHealth([examResult, attemptResult, rosterResult]);
        setSyncStatus(nextSyncStatus);
        // Persistent synchronization health belongs to the inline status pill.
        // Only an explicit user-triggered request may duplicate it as a toast.
        if (nextSyncStatus.kind === "error" && options.notifyOnError === true) {
            toast.info(
                "로컬 데이터 기준으로 표시 중",
                "Supabase 동기화가 일부 지연되고 있어 시험·제출·명단은 다음 로드 때 다시 재시도합니다."
            );
        }

        const preferredExams = preferLocalDashboardItems(examResult, localSnapshot.exams);
        const targetedExamIds = preferredExams
            .filter(exam => exam.accessConfig?.type === "targeted")
            .map(exam => exam.id);
        const assignmentCountsResult = targetedExamIds.length > 0
            ? await loadTeacherIndividualAssignmentTargetCounts(targetedExamIds).catch(() => ({ status: "service_unavailable" as const }))
            : { status: "loaded" as const, targetCounts: {}, assignmentModes: {} };
        if (options.isCancelled?.()) return;

        const remoteFailed = !!examResult.remoteError || !!attemptResult.remoteError || !!rosterResult.remoteError;
        const successfulSnapshot: DashboardSnapshot = {
            exams: preferredExams,
            attempts: preferLocalDashboardItems(attemptResult, localSnapshot.attempts),
            rosterStudents: rosterResult.remoteError ? localSnapshot.rosterStudents : rosterResult.students,
            rosterGroups: rosterResult.remoteError ? localSnapshot.rosterGroups : rosterResult.groups,
            ...(aggregateResult.status === "loaded" ? { aggregate: aggregateResult.aggregate } : {}),
            ...(assignmentCountsResult.status === "loaded"
                ? {
                    individualAssignmentTargetCounts: assignmentCountsResult.targetCounts,
                    individualAssignmentModes: assignmentCountsResult.assignmentModes,
                }
                : {}),
        };
        const nextState = resolveCanonicalLoad({
            remote: remoteFailed ? { ok: false } : { ok: true, data: successfulSnapshot },
            cache: remoteFailed && cachedAt ? { data: localSnapshot, staleAt: cachedAt } : null,
            now: loadObservedAt,
        }, isDashboardSnapshotEmpty);
        setDashboardLoadState(nextState);
        if (nextState.state === "loaded_empty" || nextState.state === "loaded_data" || nextState.state === "degraded_with_cache") {
            applyDashboardSnapshot(nextState.data);
        }
        if (!remoteFailed && examResult.remoteLoaded && attemptResult.remoteLoaded && rosterResult.remoteLoaded) {
            try { localStorage.setItem(TEACHER_DASHBOARD_CACHE_STALE_AT_KEY, loadObservedAt); } catch { /* cache remains optional */ }
        }

        if (options.notifyOnSuccess && nextSyncStatus.kind !== "error") {
            toast.success("동기화 확인 완료", nextSyncStatus.detail);
        }
    }, [applyDashboardSnapshot, isMockupAccount]);

    useEffect(() => {
        if (!isAccountModeResolved) return;
        let cancelled = false;

        // A local snapshot becomes renderable only when it carries the last
        // successful canonical verification time. Unverified local rows must not
        // leak analytics while the server request is still loading or has failed.
        if (isMockupAccount) {
            const snapshot: DashboardSnapshot = {
                exams: [],
                attempts: [],
                rosterStudents: [],
                rosterGroups: [],
                forceDemoData: true,
            };
            applyDashboardSnapshot(snapshot);
            setDashboardLoadState(resolveCanonicalLoad({
                remote: { ok: true, data: snapshot },
                cache: null,
                now: new Date().toISOString(),
            }, isDashboardSnapshotEmpty));
        } else {
            const localRoster = readLocalRosterSnapshot(localStorage);
            const localExams = readLocalExams();
            const localAttempts = readLocalAttempts();
            const localSnapshot: DashboardSnapshot = {
                exams: localExams,
                attempts: localAttempts,
                rosterStudents: localRoster.students,
                rosterGroups: localRoster.groups,
            };
            let cachedAt: string | null = null;
            try { cachedAt = localStorage.getItem(TEACHER_DASHBOARD_CACHE_STALE_AT_KEY); } catch { /* keep loading */ }
            if (cachedAt) {
                const cachedState = resolveCanonicalLoad({
                    remote: { ok: false },
                    cache: {
                        data: localSnapshot,
                        staleAt: cachedAt,
                    },
                    now: new Date().toISOString(),
                }, isDashboardSnapshotEmpty);
                setDashboardLoadState(cachedState);
                if (cachedState.state === "degraded_with_cache") applyDashboardSnapshot(cachedState.data);
            }
        }
        const refreshTimer = window.setTimeout(() => {
            void loadDashboardData({ isCancelled: () => cancelled });
        }, 0);
        return () => {
            cancelled = true;
            window.clearTimeout(refreshTimer);
        };
    }, [applyDashboardSnapshot, isAccountModeResolved, isMockupAccount, loadDashboardData]);

    // Cross-tab / refocus revalidation: another tab submitting an attempt, saving
    // an exam, or editing the roster fires a "storage" event here; returning to a
    // backgrounded tab fires focus/visibilitychange. Re-run the existing loader,
    // throttled to once per window with one trailing refresh so bursts coalesce.
    useEffect(() => {
        if (!isAccountModeResolved) return;
        let cancelled = false;
        let trailingTimer: number | undefined;
        const gate = createDashboardRevalidationGate();
        const refresh = () => {
            if (cancelled) return;
            // Background refresh: never toast, and never surface transient errors.
            void loadDashboardData({ isCancelled: () => cancelled, notifyOnError: false });
        };
        const trigger = () => {
            const decision = gate.decide();
            if (decision.kind === "refresh") {
                refresh();
            } else if (decision.kind === "schedule") {
                trailingTimer = window.setTimeout(() => {
                    trailingTimer = undefined;
                    gate.confirmScheduledRefresh();
                    refresh();
                }, decision.delayMs);
            }
        };
        const onStorage = (event: StorageEvent) => {
            if (!isTeacherDashboardStorageKey(event.key)) return;
            trigger();
        };
        const onVisibilityChange = () => {
            if (document.visibilityState === "visible") trigger();
        };
        window.addEventListener("storage", onStorage);
        window.addEventListener("focus", trigger);
        document.addEventListener("visibilitychange", onVisibilityChange);
        return () => {
            cancelled = true;
            if (trailingTimer !== undefined) window.clearTimeout(trailingTimer);
            gate.cancelScheduled();
            window.removeEventListener("storage", onStorage);
            window.removeEventListener("focus", trigger);
            document.removeEventListener("visibilitychange", onVisibilityChange);
        };
    }, [isAccountModeResolved, loadDashboardData]);

    useEffect(() => {
        const nextTab = normalizeDashboardTab(searchParams.get('tab'));
        const nextExamId = searchParams.get('examId') || undefined;
        setActiveTab(nextTab);
        setSelectedExamIdForAnalytics(nextExamId);
    }, [searchParams]);

    // Switch tabs AND mirror the selection into the URL so refresh / browser-back /
    // copied links land on the same view. The searchParams effect above already syncs
    // state back from the URL, so callers only need to call this once.
    const applyTab = useCallback((tab: TabType, examId?: string) => {
        setActiveTab(tab);
        if (examId !== undefined) setSelectedExamIdForAnalytics(examId);
        router.replace(
            `/teacher/dashboard?tab=${tab}${examId ? `&examId=${encodeURIComponent(examId)}` : ''}${isMockupAccount ? "&showcase=1" : ""}`,
            { scroll: false },
        );
    }, [isMockupAccount, router]);

    const handleNavigateToExamAnalytics = useCallback((examId: string) => {
        applyTab('exam', examId);
    }, [applyTab]);

    const handleNavigateToStudentAnalytics = useCallback(() => {
        applyTab('student');
    }, [applyTab]);

    const handleRefreshDashboardData = async () => {
        if (isRefreshingDashboardData) return;
        setIsRefreshingDashboardData(true);
        if (dashboardLoadState.state === "error_without_cache") setDashboardLoadState({ state: "loading" });
        setSyncStatus(summarizePersistenceHealth([]));
        try {
            await loadDashboardData({ notifyOnSuccess: true, notifyOnError: true });
        } catch {
            toast.error("동기화 확인 실패", "데이터를 다시 읽지 못했습니다. 네트워크와 저장소 상태를 확인해주세요.");
        } finally {
            setIsRefreshingDashboardData(false);
        }
    };

    const handleRepairAnalyticsData = async () => {
        if (dashboardLoadState.state !== "loaded_data") {
            toast.info("읽기 전용 분석", "최신 서버 데이터를 확인한 뒤 분석 캐시를 복구할 수 있습니다.");
            return;
        }
        if (questionResultRepairPlan.repairableCount === 0) {
            toast.info("복구할 문항 결과 없음", "현재 자동 복구 가능한 제출이 없습니다.");
            return;
        }

        setIsRepairingAnalyticsData(true);
        try {
            const repairedAttempts: Attempt[] = [];
            let failedCount = 0;
            for (const item of questionResultRepairPlan.items) {
                const localSaved = await saveLocalAttempt(item.repairedAttempt);
                if (localSaved) {
                    repairedAttempts.push(item.repairedAttempt);
                } else {
                    failedCount += 1;
                }
            }

            if (repairedAttempts.length > 0) {
                const repairedById = new Map(repairedAttempts.map(attempt => [attempt.id, attempt]));
                setAttempts(prev => prev.map(attempt => repairedById.get(attempt.id) || attempt));
                setDetailedAttempts(prev => {
                    const next = prev?.map(attempt => repairedById.get(attempt.id) || attempt) || prev;
                    if (next) {
                        detailedAttemptCacheRef.current = {
                            generation: detailedAttemptGenerationRef.current,
                            items: next,
                            sampleStatus: detailedAttemptSampleStatus,
                        };
                    }
                    return next;
                });
            }

            if (failedCount > 0) {
                toast.error("일부 복구 실패", `${failedCount}건은 저장하지 못했습니다. 저장소 권한과 용량을 확인하세요.`);
            } else {
                toast.success(
                    "로컬 분석 캐시 복구 완료",
                    `${repairedAttempts.length}개 제출, ${questionResultRepairPlan.repairedQuestionResultCount}개 문항 결과를 이 기기의 분석 캐시에 정리했습니다. 공식 제출 점수는 변경하지 않았습니다.`
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
    // Tone prop for the shared <StatusPill> (see docs/design-system.md — 컴포넌트 재사용).
    // Distinct from syncTone/dataHealthTone above, which stay in raw border/background/color
    // form for the refresh button and the analytics-issue banner further down this file.
    const syncPillTone = ({
        checking: "primary",
        local: "muted",
        synced: "success",
        pending: "warning",
        error: "error",
    } as const)[syncStatus.kind];
    const dataHealthPillTone = ({
        empty: "muted",
        ready: "success",
        attention: "warning",
        blocked: "error",
    } as const)[analyticsDataHealth.kind];
    const dashboardAnalysisActions = useMemo<DashboardAnalysisAction[]>(() => {
        const actions: DashboardAnalysisAction[] = [];

        if (isMockupAccount) {
            return [
                {
                    key: "exam",
                    label: "시험별 분석 보기",
                    detail: "문항, 개념, 반별 약점을 예시 데이터로 살펴봅니다.",
                    tone: "primary",
                },
                {
                    key: "student",
                    label: "학생별 성장 보기",
                    detail: "학생별 점수 추이와 반복 약점을 확인합니다.",
                    tone: "primary",
                },
            ];
        }

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
    }, [analyticsDataHealth.issues, analyticsDataHealth.kind, dataMode, isMockupAccount, questionResultRepairPlan.repairableCount]);
    const isDashboardResolving = !isAccountModeResolved || dashboardLoadState.state === "loading";
    const isDashboardUnavailable = dashboardLoadState.state === "error_without_cache";
    const isDashboardDegraded = dashboardLoadState.state === "degraded_with_cache";
    const dashboardAllowsAnalysis = dashboardLoadState.state === "loaded_data" || isDashboardDegraded;
    const dashboardAllowsMutations = dashboardLoadState.state === "loaded_data" || dashboardLoadState.state === "loaded_empty";
    const isRealDashboardEmpty = dashboardLoadState.state === "loaded_empty"
        && !isMockupAccount
        && dataMode === "real"
        && isDashboardSnapshotEmpty(dashboardLoadState.data);
    const dashboardHasRenderableData = dashboardAllowsAnalysis;

    // Tab Navigation Component
    const renderTabs = () => isMockupAccount ? (
        <div className="mockup-dashboard-tabs" role="group" aria-label="데모 분석 화면">
            <button type="button" aria-pressed={activeTab === "overview"} onClick={() => applyTab("overview")}>개요</button>
            <button type="button" aria-pressed={activeTab === "exam"} onClick={() => applyTab("exam", selectedExamIdForAnalytics)}>시험별 분석</button>
            <button type="button" aria-pressed={activeTab === "student"} onClick={() => applyTab("student")}>학생별 분석</button>
        </div>
    ) : (
        <div className="dashboard-tabs" role="group" aria-label="대시보드 보기" style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(160px, 100%), 1fr))',
            gap: '0.5rem',
            marginBottom: '2rem',
            background: 'var(--surface)', padding: '0.5rem', borderRadius: 'var(--radius-lg)',
            border: '1px solid var(--border)',
            boxShadow: '0 4px 6px rgba(0,0,0,0.02)'
        }}>
            <button
                type="button"
                aria-pressed={activeTab === 'overview'}
                className={activeTab === 'overview' ? "is-active" : undefined}
                onClick={() => applyTab('overview')}
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
                type="button"
                aria-pressed={activeTab === 'exam'}
                className={activeTab === 'exam' ? "is-active" : undefined}
                onClick={() => applyTab('exam', selectedExamIdForAnalytics)}
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
                type="button"
                aria-pressed={activeTab === 'student'}
                className={activeTab === 'student' ? "is-active" : undefined}
                onClick={() => applyTab('student')}
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
        <div className={`layout-main${isMockupAccount ? " mockup-dashboard-shell" : ""}`}>
            {/* TeacherHeader also renders SkipToMainContent and GlobalSearch;
                this replaced a hand-rolled copy of the same header that had
                drifted from the shared one in search width and badge shape. */}
            <TeacherHeader
                badge={isMockupAccount ? "데모 계정" : "교사"}
                badgeColor={isMockupAccount ? "#1769e0" : undefined}
                showDashboardLink={false}
                showLiveLink={!isMockupAccount}
                showThemeToggle={!isMockupAccount}
            />

            <main id="main-content" tabIndex={-1} className={`container dashboard-main animate-fade-in${isMockupAccount ? " mockup-dashboard-main" : ""}${isMockupAccount && activeTab !== "overview" ? " mockup-dashboard-subview" : ""}`}>
                {/* Welcome Section */}
                <div className="dashboard-welcome">
                    <div className="mobile-section-stack" style={{ minWidth: 0 }}>
                        <h1 className="dashboard-title" style={{ fontSize: '2.5rem', marginBottom: '0.75rem', lineHeight: 1.2, fontWeight: 800, letterSpacing: '-0.01em', color: 'var(--foreground)' }}>
                            {isMockupAccount ? "좋은아침이에요, 김하늘 선생님" : "분석 센터"}
                        </h1>
                        <p className="text-muted" style={{ fontSize: '1.1rem' }}>
                            {isMockupAccount
                                ? "완성된 예시 시험으로 OMR Maker의 통계와 분석을 편하게 둘러보세요."
                                : "시험 현황과 학생 성취도를 한눈에 확인하고 다음 조치를 시작하세요."}
                        </p>
                    </div>
                    {!isMockupAccount && <div className="dashboard-welcome-status">
                        <div
                            className="mobile-action-row"
                            aria-label="데이터 동기화 상태"
                            title={syncStatus.error || syncStatus.detail}
                            style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', minWidth: 0 }}
                        >
                            <StatusPill
                                icon={<SyncIcon size={13} />}
                                label={syncStatus.label}
                                detail={syncStatus.detail}
                                tone={syncPillTone}
                            />
                            <button
                                type="button"
                                onClick={handleRefreshDashboardData}
                                disabled={isRefreshingDashboardData}
                                aria-label="동기화 다시 확인"
                                title="로컬과 Supabase 데이터를 다시 확인합니다"
                                style={{
                                    width: 44,
                                    height: 44,
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
                        {dashboardAllowsAnalysis && analyticsDataHealth.kind !== "empty" && <div
                            aria-label="분석 데이터 상태"
                            title={analyticsDataHealth.issues[0]?.detail || analyticsDataHealth.detail}
                            style={{ minWidth: 0 }}
                        >
                            <StatusPill
                                icon={<DataHealthIcon size={13} />}
                                label={analyticsDataHealth.label}
                                detail={`${analyticsDataHealth.score}점 · ${analyticsDataHealth.detail}`}
                                tone={dataHealthPillTone}
                            />
                        </div>}
                        {dashboardAllowsMutations && <Link href="/create" className="dashboard-create-action" style={{
                                padding: '0.55rem 1.1rem', background: 'var(--primary)',
                                color: 'white', borderRadius: 'var(--radius-full)',
                                fontWeight: 600, fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.4rem',
                                boxShadow: '0 4px 12px rgba(99, 102, 241, 0.3)'
                            }}>
                                시험 출제하기
                        </Link>}
                    </div>}
                </div>

                {isDashboardDegraded && (
                    <section
                        data-testid="canonical-degraded-cache"
                        role="status"
                        style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', alignItems: 'center', padding: '1rem 1.1rem', marginBottom: '1.5rem', border: '1px solid rgba(245,158,11,0.35)', borderRadius: 'var(--radius-lg)', background: 'rgba(245,158,11,0.08)', flexWrap: 'wrap' }}
                    >
                        <div>
                            <strong>저장된 데이터를 읽기 전용으로 표시 중</strong>
                            <p className="text-muted" style={{ marginTop: '0.25rem' }}>
                                마지막 저장 {new Date(dashboardLoadState.staleAt).toLocaleString('ko-KR')} · 서버 연결을 확인해주세요.
                            </p>
                        </div>
                        <button type="button" className="btn btn-secondary" onClick={() => { void handleRefreshDashboardData(); }}>다시 시도</button>
                    </section>
                )}

                {dashboardAllowsAnalysis && dataMode === "demo" && (
                    <div
                        role="status"
                        aria-label="데모 데이터 안내"
                        className={isMockupAccount ? "mockup-demo-notice" : undefined}
                        style={isMockupAccount ? undefined : {
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
                        <AlertTriangle size={19} color={isMockupAccount ? "#1769e0" : "var(--warning)"} style={{ flexShrink: 0, marginTop: 2 }} />
                        <div style={{ minWidth: 0 }}>
                            <div style={isMockupAccount ? undefined : { fontSize: '0.9rem', fontWeight: 900, color: 'var(--warning)', marginBottom: '0.2rem' }}>
                                {isMockupAccount ? "데모 전용 · 모든 데이터는 예시입니다" : "데모 데이터 모드"}
                            </div>
                            <p style={isMockupAccount ? undefined : { fontSize: '0.82rem', color: 'var(--muted)', lineHeight: 1.55, wordBreak: 'keep-all' }}>
                                {isMockupAccount
                                    ? "실제 학교·학생 정보와 연결되지 않으며, 이 계정에서 보이는 시험·점수·인사이트는 제품 체험을 위해 구성한 샘플입니다."
                                    : "현재 저장된 시험과 제출이 없어 예시 시험/학생 데이터로 화면을 채웠습니다. 실제 시험을 만들거나 제출이 들어오면 예시 데이터는 자동으로 사라집니다."}
                            </p>
                        </div>
                    </div>
                )}

                {dashboardAllowsAnalysis && dataMode === "real" && analyticsDataHealth.kind !== "ready" && analyticsDataHealth.kind !== "empty" && (
                    <div
                        role="status"
                        aria-label="분석 데이터 상태"
                        style={{
                            display: 'grid',
                            gridTemplateColumns: 'minmax(0, 1.2fr) minmax(220px, 1fr)',
                            gap: '0.75rem',
                            alignItems: 'stretch',
                            padding: '0.65rem 0.85rem',
                            marginBottom: '1rem',
                            borderRadius: 'var(--radius-lg)',
                            border: `1px solid ${dataHealthTone.border}`,
                            background: dataHealthTone.background,
                            color: 'var(--foreground)',
                        }}
                        className="dashboard-data-health"
                    >
                        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.6rem', minWidth: 0 }}>
                            <DataHealthIcon size={16} color={dataHealthTone.color} style={{ flexShrink: 0, marginTop: 2 }} />
                            <div style={{ minWidth: 0 }}>
                                <div style={{ fontSize: '0.8rem', fontWeight: 900, color: dataHealthTone.color, marginBottom: '0.15rem' }}>
                                    {analyticsDataHealth.label}
                                </div>
                                <p style={{ fontSize: '0.76rem', color: 'var(--muted)', lineHeight: 1.45, wordBreak: 'keep-all' }}>
                                    시험 {analyticsDataHealth.totalExamCount}개, 제출 {analyticsDataHealth.totalAttemptCount}건, 문항 {analyticsDataHealth.totalQuestionCount}개 기준입니다. {analyticsDataHealth.detail}
                                </p>
                            </div>
                        </div>
                        <div style={{ display: 'grid', gap: '0.35rem', alignContent: 'center' }}>
                            {analyticsDataHealth.issues.slice(0, 4).map(issue => (
                                <div
                                    key={issue.key}
                                    style={{
                                        display: 'flex',
                                        justifyContent: 'space-between',
                                        alignItems: 'center',
                                        gap: '0.75rem',
                                        padding: '0.35rem 0.5rem',
                                        borderRadius: 'var(--radius-md)',
                                        border: '1px solid var(--border)',
                                        background: 'var(--surface)',
                                    }}
                                >
                                    <span style={{ fontSize: '0.74rem', fontWeight: 800, color: 'var(--foreground)', minWidth: 0 }}>
                                        {issue.label}
                                    </span>
                                    <span style={{
                                        flexShrink: 0,
                                        fontSize: 'var(--type-caption)',
                                        fontWeight: 900,
                                        color: issue.severity === "error" ? 'var(--error)' : 'var(--warning)',
                                    }}>
                                        {issue.count}건
                                    </span>
                                </div>
                            ))}
                            {dashboardAllowsMutations && questionResultRepairPlan.repairableCount > 0 && (
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
                                            padding: '0.45rem 0.6rem',
                                            borderRadius: 'var(--radius-md)',
                                            border: '1px solid rgba(99,102,241,0.28)',
                                            background: 'rgba(99,102,241,0.1)',
                                            color: 'var(--primary)',
                                            cursor: isRepairingAnalyticsData ? 'wait' : 'pointer',
                                            fontSize: '0.76rem',
                                            fontWeight: 900,
                                        }}
                                    >
                                        <span>{isRepairingAnalyticsData ? "문항 결과 복구 중..." : "문항 결과 자동 복구"}</span>
                                        <span style={{ flexShrink: 0, color: 'var(--muted)', fontSize: 'var(--type-caption)' }}>
                                            {questionResultRepairPlan.repairableCount}제출 · {questionResultRepairPlan.repairedQuestionResultCount}문항
                                        </span>
                                    </button>
                                    <div style={{
                                        display: 'grid',
                                        gap: '0.3rem',
                                        padding: '0.5rem 0.6rem',
                                        borderRadius: 'var(--radius-md)',
                                        border: '1px dashed var(--border)',
                                        background: 'var(--surface)',
                                    }}>
                                        <div style={{ fontSize: 'var(--type-caption)', color: 'var(--muted)', fontWeight: 900 }}>
                                            복구 대상 미리보기
                                        </div>
                                        {questionResultRepairPlan.items.slice(0, 3).map(item => (
                                            <div key={item.attemptId} style={{ display: 'flex', justifyContent: 'space-between', gap: '0.65rem', fontSize: 'var(--type-caption)', color: 'var(--foreground)', lineHeight: 1.4 }}>
                                                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                    {item.examTitle} · {item.studentName || "학생 미상"}
                                                </span>
                                                <span style={{ color: 'var(--primary)', fontWeight: 900, flexShrink: 0 }}>
                                                    {item.missingQuestionResultCount}/{item.expectedQuestionCount}문항
                                                </span>
                                            </div>
                                        ))}
                                        {questionResultRepairPlan.repairableCount > 3 && (
                                            <div style={{ color: 'var(--muted)', fontSize: 'var(--type-micro)', fontWeight: 800 }}>
                                                외 {questionResultRepairPlan.repairableCount - 3}개 제출 추가 복구 예정
                                            </div>
                                        )}
                                    </div>
                                </>
                            )}
                            {(questionResultRepairPlan.skippedOrphanAttemptCount > 0 || questionResultRepairPlan.skippedInProgressAttemptCount > 0) && (
                                <div style={{ fontSize: 'var(--type-caption)', color: 'var(--muted)', fontWeight: 800, lineHeight: 1.5, wordBreak: 'keep-all' }}>
                                    자동 복구 제외:
                                    {questionResultRepairPlan.skippedOrphanAttemptCount > 0 ? ` 시험 없는 제출 ${questionResultRepairPlan.skippedOrphanAttemptCount}건` : ""}
                                    {questionResultRepairPlan.skippedOrphanAttemptCount > 0 && questionResultRepairPlan.skippedInProgressAttemptCount > 0 ? " ·" : ""}
                                    {questionResultRepairPlan.skippedInProgressAttemptCount > 0 ? ` 진행 중 제출 ${questionResultRepairPlan.skippedInProgressAttemptCount}건` : ""}
                                </div>
                            )}
                            {analyticsDataHealth.issues.length === 0 && (
                                <div style={{ fontSize: '0.74rem', color: 'var(--muted)', fontWeight: 800 }}>
                                    실제 시험과 제출이 쌓이면 자동으로 점검합니다.
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {dashboardHasRenderableData && !isMockupAccount && activeTab !== "overview" && activeTab !== "exam" && <div
                    className="dashboard-analysis-actions"
                    aria-label="분석 다음 조치"
                    style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fit, minmax(min(190px, 100%), 1fr))',
                        gap: '0.6rem',
                        marginBottom: '1rem',
                    }}
                >
                    {dashboardAnalysisActions
                        .filter(action => dashboardAllowsMutations || (action.key !== "create" && action.key !== "repair"))
                        .map(action => {
                        const actionTone = action.tone === "primary"
                            ? { border: 'rgba(99,102,241,0.24)', background: 'rgba(99,102,241,0.08)', color: 'var(--primary)' }
                            : action.tone === "warning"
                                ? { border: 'rgba(245,158,11,0.28)', background: 'rgba(245,158,11,0.09)', color: 'var(--warning)' }
                                : { border: 'var(--border)', background: 'var(--surface)', color: 'var(--foreground)' };
                        const content = (
                            <>
                                <span style={{ display: 'block', color: actionTone.color, fontSize: '0.82rem', fontWeight: 950, marginBottom: '0.15rem' }}>
                                    {action.label}
                                </span>
                                <span style={{ display: 'block', color: 'var(--muted)', fontSize: '0.72rem', lineHeight: 1.4, wordBreak: 'keep-all' }}>
                                    {action.detail}
                                </span>
                            </>
                        );
                        const sharedStyle = {
                            width: '100%',
                            minHeight: 56,
                            padding: '0.6rem 0.8rem',
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
                                    if (action.key === "exam") applyTab("exam", selectedExamIdForAnalytics);
                                    if (action.key === "student") applyTab("student");
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
                </div>}

                {isDashboardResolving ? (
                    <AnalyticsTabSkeleton />
                ) : isDashboardUnavailable ? (
                    <section
                        data-testid="canonical-error-no-cache"
                        role="alert"
                        className="bento-card"
                        style={{ minHeight: 280, display: 'grid', placeItems: 'center', padding: '2rem', textAlign: 'center' }}
                    >
                        <div>
                            <AlertTriangle size={28} color="var(--warning)" style={{ margin: '0 auto 0.75rem' }} />
                            <h2 style={{ fontSize: '1.25rem', fontWeight: 850 }}>서버 데이터를 불러오지 못했습니다</h2>
                            <p className="text-muted" style={{ margin: '0.5rem 0 1rem' }}>검증된 저장 데이터가 없어 빈 대시보드로 표시하지 않습니다.</p>
                            <button data-testid="canonical-dashboard-retry" type="button" className="btn btn-primary" onClick={() => { void handleRefreshDashboardData(); }}>다시 시도</button>
                        </div>
                    </section>
                ) : isRealDashboardEmpty ? (
                    <section
                        className="bento-card dashboard-empty-onboarding"
                        aria-labelledby="dashboard-empty-title"
                        style={{
                            minHeight: 360,
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            justifyContent: 'center',
                            padding: 'clamp(2rem, 8vw, 4.5rem) 1.5rem',
                            textAlign: 'center',
                        }}
                    >
                        <span
                            aria-hidden="true"
                            style={{
                                width: 68,
                                height: 68,
                                display: 'grid',
                                placeItems: 'center',
                                marginBottom: '1.25rem',
                                borderRadius: 'var(--radius-full)',
                                background: 'rgba(99,102,241,0.1)',
                                color: 'var(--primary)',
                            }}
                        >
                            <LayoutDashboard size={28} />
                        </span>
                        <h2 id="dashboard-empty-title" style={{ fontSize: '1.35rem', fontWeight: 850, marginBottom: '0.55rem' }}>
                            첫 시험부터 시작해보세요
                        </h2>
                        <p style={{ maxWidth: 480, color: 'var(--muted)', lineHeight: 1.65, marginBottom: '1.4rem', wordBreak: 'keep-all' }}>
                            시험을 만들고 배포하면 응시 현황, 점수, 학생 성취 분석이 이곳에 자동으로 정리됩니다.
                        </p>
                        <Link
                            href="/create"
                            style={{
                                minHeight: 44,
                                display: 'inline-flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                padding: '0.7rem 1.2rem',
                                borderRadius: 'var(--radius-full)',
                                background: 'var(--primary)',
                                color: 'white',
                                fontWeight: 800,
                                boxShadow: '0 6px 18px rgba(99,102,241,0.24)',
                            }}
                        >
                            첫 시험 만들기
                        </Link>
                    </section>
                ) : (
                    <>
                        {/* Tabs */}
                        {!isRealDashboardEmpty && renderTabs()}

                        {/* Tab Content */}
                        <div style={{ minHeight: '600px' }}>
                    {activeTab === 'overview' && isMockupAccount && (
                        <MockupOverview
                            exams={exams}
                            attempts={attempts}
                            rosterGroups={rosterGroups}
                            totalStudents={stats.totalStudents}
                            averageScore={stats.avgScore}
                            onNavigateToExamAnalytics={handleNavigateToExamAnalytics}
                            onNavigateToStudentAnalytics={handleNavigateToStudentAnalytics}
                        />
                    )}
                    {activeTab === 'overview' && !isMockupAccount && (
                        <OverviewTab
                            exams={exams}
                            attempts={attempts}
                            stats={stats}
                            trendData={trendData}
                            trendLabels={trendLabels}
                            rosterStudents={rosterStudents}
                            rosterGroups={rosterGroups}
                            individualAssignmentTargetCounts={individualAssignmentTargetCounts}
                            individualAssignmentModes={individualAssignmentModes}
                            onNavigateToExamAnalytics={handleNavigateToExamAnalytics}
                            onNavigateToStudentAnalytics={handleNavigateToStudentAnalytics}
                            onLoadDetailedAttempts={loadDetailedAttempts}
                        />
                    )}
                    {activeTab !== 'overview'
                        && dataMode === "real"
                        && detailedAttemptStatus === "ready"
                        && detailedAttemptSampleStatus !== "ready" && (
                        <section
                            className="bento-card"
                            role="status"
                            style={{
                                marginBottom: '1rem',
                                padding: '0.9rem 1rem',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                gap: '1rem',
                                flexWrap: 'wrap',
                            }}
                        >
                            <div>
                                <strong style={{ fontSize: '0.92rem' }}>
                                    {detailedAttemptSampleStatus === "partial" ? "일부 제출 기준 분석" : "저장된 제출 기준 분석"}
                                </strong>
                                <p style={{ margin: '0.2rem 0 0', color: 'var(--muted)', fontSize: '0.8rem' }}>
                                    {detailedAttemptWarning || "최신 서버 데이터와 차이가 있을 수 있습니다."}
                                </p>
                            </div>
                            <button type="button" className="btn btn-secondary" onClick={retryDetailedAttempts}>
                                최신 데이터 다시 불러오기
                            </button>
                        </section>
                    )}
                    {activeTab !== 'overview' && dataMode === "real" && detailedAttemptStatus !== "ready" && (
                        detailedAttemptStatus === "error" ? (
                            <section className="bento-card" role="alert" style={{ padding: '2rem', textAlign: 'center' }}>
                                <h2 style={{ fontSize: '1.1rem', fontWeight: 850, marginBottom: '0.5rem' }}>분석 데이터를 불러오지 못했습니다</h2>
                                <p style={{ color: 'var(--muted)', marginBottom: '1rem' }}>상세 제출 데이터를 불러오지 못했습니다. 네트워크를 확인한 뒤 다시 시도해주세요.</p>
                                <button type="button" className="btn btn-primary" onClick={() => void loadDetailedAttempts()}>
                                    다시 불러오기
                                </button>
                            </section>
                        ) : <AnalyticsTabSkeleton />
                    )}
                    {activeTab === 'exam' && (dataMode === "demo" || detailedAttemptStatus === "ready") && (
                        <ExamAnalyticsTab
                            exams={exams}
                            attempts={analyticsAttempts}
                            rosterStudents={rosterStudents}
                            rosterGroups={rosterGroups}
                            initialExamId={selectedExamIdForAnalytics}
                            currentPlan={isMockupAccount ? "academy" : currentPlan}
                            sampleStatus={detailedAttemptSampleStatus}
                        />
                    )}
                    {activeTab === 'student' && (dataMode === "demo" || detailedAttemptStatus === "ready") && (
                        <StudentAnalyticsTab
                            exams={exams}
                            attempts={analyticsAttempts}
                            rosterStudents={rosterStudents}
                            rosterGroups={rosterGroups}
                            currentPlan={isMockupAccount ? "academy" : currentPlan}
                        />
                    )}
                        </div>
                    </>
                )}

            </main>
        </div>
    );
}
