"use client";

import { useMemo, useState, useEffect, useRef, type CSSProperties } from "react";
import { DEFAULT_CHOICE_COUNT, Exam, Attempt, type PlanKey } from "@/types/omr";
import type { QuestionResult } from "@/types/omr";
import {
    BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer,
    Radar, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis
} from 'recharts';
import type { ValueType } from "recharts/types/component/DefaultTooltipContent";
import {
    AlertTriangle,
    BarChart2,
    CalendarDays,
    CheckCircle,
    ChevronDown,
    ChevronUp,
    Database,
    Download,
    FileQuestion,
    List,
    MapPin,
    MessageCircle,
    Search,
    Settings2,
    Target,
    Users,
} from "lucide-react";
import { PremiumActionLink, PremiumFeatureCard } from "@/components/PremiumFeatureGate";
import styles from "./ExamAnalyticsTab.module.css";
import {
    attemptElapsedTimeSec,
    buildCanonicalAttemptAnalyticsIndex,
    buildClassExamScoreGroups,
    buildClassExamWeaknessMatrix,
    buildExamQuestionPointBiserial,
    buildExamQuestionResultStats,
    buildLearningRecommendations,
    buildQuestionResultTagStats,
    buildRetakeQuestionIds,
    buildSimilarQuestionGroups,
    collectQuestionResults,
    formatParticipationRateLabel,
    resolveAttemptGrading,
    hasGradableAttemptScore,
    studentScopeKeyForAttempt,
    summarizeAttemptScore,
    summarizeAttemptBehavior,
} from "@/lib/premiumAnalytics";
import { computeGroupScoreSummary, computeScoreDistribution } from "@/lib/scoreDistribution";
import { completedAttemptsOnly } from "@/lib/attemptScores";
import type { AttemptGradingSource, LearningRecommendation } from "@/lib/premiumAnalytics";
import { buildQuestionBankReadiness, type QuestionBankReadinessStatus } from "@/lib/questionBank";
import {
    buildRegionalActionPlans,
    buildRegionalLearningScopes,
    filterAttemptsByRegion,
    regionKeyFor,
    regionNameForGroup,
    regionNameForStudent,
    type RegionalLearningScope,
} from "@/lib/regionalAnalytics";
import type { RosterGroup, RosterStudent } from "@/lib/rosterStorage";
import { formatRegionScopedLabel, resolveExamSelection, resolveExamSelectionInputValue, resolveScopedSelection } from "@/lib/dashboardSelection";
import { safeRatePercent, safeScorePercent } from "@/lib/scoreUtils";
import {
    currentTeacherCanonicalAnalyticsSnapshot,
    exactTeacherCanonicalWrongRetakeCohorts,
    teacherCanonicalQuestionCohortCsvRows,
    type TeacherCanonicalAnalyticsSnapshotMap,
} from "@/lib/teacherCanonicalAnalyticsSnapshotContract";
import { serializeCsvRows } from "@/lib/csv";
import { buildRetakeHref } from "@/lib/retakeLinks";
import { buildKakaoNotificationCandidates, type KakaoNotificationCandidate, type KakaoNotificationCandidateKind } from "@/lib/kakaoNotificationQueue";
import {
    buildKakaoCandidateMessagePreview,
    readKakaoCandidateReviews,
    summarizeKakaoCandidateReviews,
    type KakaoCandidateReviewMap,
    type KakaoCandidateReviewStatus,
} from "@/lib/kakaoCandidateReview";
import {
    queueKakaoDispatchSimulation,
    readKakaoDispatchLogs,
    summarizeKakaoDispatchLogs,
    saveKakaoCandidateReview,
    type KakaoDispatchLog,
    syncKakaoDispatchLog,
    updateKakaoDispatchLogStatus,
    writeKakaoDispatchLogs,
} from "@/lib/kakaoCandidateReviewPersistence";
import { getKakaoProviderReadiness, type KakaoProviderReadinessStatus } from "@/lib/kakaoProvider";
import { hasPlanEntitlement } from "@/utils/plans";
import WaveBar from "@/components/dashboard/WaveBar";
import StatusPill from "@/components/dashboard/StatusPill";
import type { AnalyticsMetricItem } from "@/components/AnalyticsMetricGrid";
import {
    buildExamHeadlineInsight,
    examAnalyticsSampleStatusNote,
} from "@/lib/examAnalyticsReport";
import type { ExamAnalyticsSampleStatus } from "@/lib/examAnalyticsReport";
import ExamAnalyticsReportOverview, {
    type ExamOverviewAction,
    type ExamOverviewWeakQuestion,
} from "./ExamAnalyticsReportOverview";

interface ExamAnalyticsTabProps {
    exams: Exam[];
    attempts: Attempt[];
    rosterStudents?: RosterStudent[];
    rosterGroups?: RosterGroup[];
    initialExamId?: string;
    currentPlan?: PlanKey;
    sampleStatus?: ExamAnalyticsSampleStatus;
    /** Present for real remote data; absent only for bounded local/demo analysis. */
    canonicalAnalyticsSnapshots?: TeacherCanonicalAnalyticsSnapshotMap;
}

export function filterGradableQuestionEvidence<T extends { totalCount: number }>(items: T[]): T[] {
    return items.filter(item => item.totalCount > 0);
}

export function buildQuestionCorrectRateChartData<T extends {
    index: number;
    totalCount: number;
    correctRate: number;
}>(items: T[]): Array<Omit<T, "correctRate"> & {
    correctRate: number | null;
    correctRateLabel: string;
}> {
    return items.map(item => ({
        ...item,
        correctRate: item.totalCount > 0 ? item.correctRate : null,
        correctRateLabel: item.totalCount > 0 ? `${item.correctRate}%` : "미채점",
    }));
}

export function QuestionCorrectRateTooltip({
    active,
    label,
    payload,
}: {
    active?: boolean;
    label?: string | number;
    payload?: ReadonlyArray<{ value?: number | string | null }>;
}) {
    if (!active || !payload?.length) return null;
    const value = payload[0]?.value;

    return (
        <div
            role="status"
            className="recharts-default-tooltip"
            style={{
                padding: "10px",
                border: "1px solid var(--border)",
                borderRadius: "8px",
                boxShadow: "0 4px 12px rgba(0,0,0,0.05)",
                background: "var(--background)",
            }}
        >
            <p>{label}번 문항</p>
            <p>정답률: {value === null || value === undefined ? "미채점" : `${value}%`}</p>
        </div>
    );
}

const EXAM_ANALYTICS_SAMPLE_QUALIFIER_ID = "exam-analytics-sample-qualifier";

const difficultyLabelMap: Record<string, string> = {
    easy: "기초",
    medium: "표준",
    hard: "심화",
    killer: "킬러",
};

/**
 * Below this, a question's point-biserial correlation with total score is considered weak
 * item discrimination — the common psychometric convention (r < .20 "poor", .20–.29
 * "marginal", ≥.30 "good") used to flag the 문항별 상세 table's 진단 badge.
 */
const WEAK_POINT_BISERIAL_THRESHOLD = 0.2;

export function summarizeRiskyQuestions<T>(items: T[]): {
    displayQuestions: T[];
    totalCount: number;
} {
    return {
        displayQuestions: items.slice(0, 5),
        totalCount: items.length,
    };
}

export function buildQuestionQualityActionTitle(
    riskyQuestionCount: number,
    tooEasyCount: number,
): string {
    return `문항 품질 ${riskyQuestionCount + tooEasyCount}개 점검`;
}

// Shared card surface so every analytics section reads as one coherent grammar
// (rounded, subtly elevated, consistently bordered) — the `.card` class carries no
// styling of its own, so the treatment lives here as an inline base that each card
// spreads first and then overrides (padding, accents) as needed.
const CARD_SURFACE_STYLE: CSSProperties = {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-xl)',
    boxShadow: 'var(--shadow-md)',
};

function formatSeconds(totalSec: number): string {
    if (totalSec < 60) return `${totalSec}초`;
    const minutes = Math.floor(totalSec / 60);
    const seconds = totalSec % 60;
    return seconds > 0 ? `${minutes}분 ${seconds}초` : `${minutes}분`;
}

function formatExamDate(value: string | undefined): string {
    if (!value) return "일정 미설정";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "일정 미설정";
    return new Intl.DateTimeFormat("ko-KR", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).format(date);
}

function roundScoreValue(value: number): number {
    return Math.round(value * 100) / 100;
}

function isGradableResult(result: QuestionResult): boolean {
    return result.status !== "ungraded";
}

function resultStatusLabel(result?: QuestionResult): string {
    if (!result) return "-";
    if (result.status === "correct" || result.isCorrect) return "O";
    if (result.status === "wrong" || result.isWrong) return "X";
    if (result.status === "unanswered" || result.isUnanswered) return "미응답";
    return "미채점";
}

export function buildStudentQuestionAnalysisCsvRows(input: {
    gradingSource: AttemptGradingSource;
    questionResults: readonly QuestionResult[];
    labelScores: Record<string, { earned: number; total: number }>;
}): unknown[][] {
    const gradingSourceLabel = input.gradingSource === "canonical_submission"
        ? "제출 당시 저장 채점"
        : input.gradingSource === "legacy_derived_current_exam"
            ? "과거 기록 · 현재 시험지 기준 참고 채점"
            : input.gradingSource === "stored_totals_only"
                ? "저장 총점만 확인 가능"
                : "채점 근거 불완전";
    const rows: unknown[][] = [
        ["채점 근거", gradingSourceLabel],
        [],
        ["문항 번호", "라벨(장르)", "배점", "학생 선택", "정답", "정오"],
    ];
    [...input.questionResults]
        .sort((left, right) => left.questionNumber - right.questionNumber || left.questionId - right.questionId)
        .forEach(result => rows.push([
            result.questionNumber,
            result.label || "일반",
            result.score,
            result.selectedAnswer ?? "-",
            result.correctAnswer ?? "-",
            resultStatusLabel(result),
        ]));
    rows.push([], ["장르별 통계"], ["장르", "획득 점수", "만점"]);
    Object.entries(input.labelScores).forEach(([label, data]) => {
        rows.push([label, roundScoreValue(data.earned), roundScoreValue(data.total)]);
    });
    return rows;
}

type AnalysisScope = "exam" | "class" | "student";
type AnalyticsWorkspaceView = "overview" | "questions" | "students" | "operations";
const ALL_REGION_KEY = "__all_regions__";
const KAKAO_REVIEW_STATUS_OPTIONS: Array<{ status: KakaoCandidateReviewStatus; label: string }> = [
    { status: "ready", label: "후보 준비" },
    { status: "hold", label: "보류" },
    { status: "excluded", label: "제외" },
];

function questionBankStatusLabel(status: QuestionBankReadinessStatus): string {
    if (status === "ready") return "DB 준비";
    if (status === "analysis_ready") return "분석 가능";
    if (status === "crop_needed") return "커팅 필요";
    return "태그 필요";
}

function questionBankStatusColor(status: QuestionBankReadinessStatus): string {
    if (status === "ready") return "var(--success)";
    if (status === "analysis_ready") return "var(--primary)";
    if (status === "crop_needed") return "var(--warning)";
    return "var(--error)";
}

function regionalScopeLabel(scope: RegionalLearningScope | undefined): string {
    return scope?.regionName || "전체 지역";
}

function severityLabel(severity: "watch" | "review" | "urgent" | null): string {
    if (severity === null) return "근거 없음";
    if (severity === "urgent") return "긴급";
    if (severity === "review") return "점검";
    return "관찰";
}

function severityColor(severity: "watch" | "review" | "urgent" | null): string {
    if (severity === null) return "var(--muted)";
    if (severity === "urgent") return "var(--error)";
    if (severity === "review") return "var(--warning)";
    return "var(--primary)";
}

function kakaoCandidateKindLabel(kind: KakaoNotificationCandidateKind): string {
    if (kind === "missing_exam") return "미응시";
    if (kind === "class_retake_recommendation") return "반별 재시험";
    return "재시험";
}

function kakaoCandidateKindColor(kind: KakaoNotificationCandidateKind): string {
    if (kind === "missing_exam") return "var(--warning)";
    if (kind === "class_retake_recommendation") return "var(--primary)";
    return "#0f766e";
}

function kakaoReviewStatusLabel(status: KakaoCandidateReviewStatus | "unreviewed"): string {
    if (status === "ready") return "후보 준비";
    if (status === "hold") return "보류";
    if (status === "excluded") return "제외";
    return "검토 대기";
}

function kakaoReviewStatusColor(status: KakaoCandidateReviewStatus | "unreviewed"): string {
    if (status === "ready") return "var(--success)";
    if (status === "hold") return "var(--warning)";
    if (status === "excluded") return "var(--error)";
    return "var(--muted)";
}

function kakaoDispatchStatusLabel(status: KakaoDispatchLog["status"] | undefined): string {
    if (status === "queued") return "큐 대기 기록됨";
    if (status === "sent") return "시뮬레이션 완료 기록";
    if (status === "failed") return "시뮬레이션 실패 기록";
    if (status === "cancelled") return "시뮬레이션 취소 기록";
    if (status === "skipped") return "후보 제외 기록";
    return "큐 기록 없음";
}

function kakaoDispatchStatusColor(status: KakaoDispatchLog["status"] | undefined): string {
    if (status === "queued") return "var(--primary)";
    if (status === "sent") return "var(--success)";
    if (status === "failed") return "var(--error)";
    if (status === "cancelled" || status === "skipped") return "var(--warning)";
    return "var(--muted)";
}

function kakaoProviderStatusColor(status: KakaoProviderReadinessStatus): string {
    if (status === "ready") return "var(--success)";
    if (status === "simulation") return "var(--primary)";
    if (status === "blocked") return "var(--warning)";
    return "var(--muted)";
}

function attemptRegionName(attempt: Attempt): string {
    return attempt.regionName?.trim() || attempt.regionId?.trim() || "";
}

export default function ExamAnalyticsTab({
    exams,
    attempts,
    rosterStudents = [],
    rosterGroups = [],
    initialExamId,
    currentPlan = "free",
    sampleStatus = "ready",
    canonicalAnalyticsSnapshots,
}: ExamAnalyticsTabProps) {
    const [selectedExamId, setSelectedExamId] = useState<string>(initialExamId || (exams.length > 0 ? exams[0].id : ""));
    const [isSelectOpen, setIsSelectOpen] = useState(false);
    const [inputValue, setInputValue] = useState("");
    const [activeOptionIndex, setActiveOptionIndex] = useState(-1);
    const [selectedRegionKey, setSelectedRegionKey] = useState(ALL_REGION_KEY);
    const [activeWorkspaceView, setActiveWorkspaceView] = useState<AnalyticsWorkspaceView>("overview");
    const [analysisScope, setAnalysisScope] = useState<AnalysisScope>("exam");
    const [selectedClassKey, setSelectedClassKey] = useState("");
    const [selectedStudentKey, setSelectedStudentKey] = useState("");
    const [kakaoReviews, setKakaoReviews] = useState<KakaoCandidateReviewMap>({});
    const [kakaoDispatchLogs, setKakaoDispatchLogs] = useState<KakaoDispatchLog[]>([]);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const shouldScrollActiveOptionRef = useRef(false);
    const lastAppliedInitialExamIdRef = useRef<string | undefined>(initialExamId);
    const advancedAnalyticsEnabled = hasPlanEntitlement(currentPlan, "advancedAnalytics");
    const retakeAssignmentsEnabled = hasPlanEntitlement(currentPlan, "retakeAssignments");
    const remindersEnabled = hasPlanEntitlement(currentPlan, "reminders");
    const kakaoProviderReadiness = useMemo(() => getKakaoProviderReadiness(), []);
    const sampleStatusCopy = examAnalyticsSampleStatusNote(sampleStatus);

    useEffect(() => {
        const timer = window.setTimeout(() => {
            try {
                setKakaoReviews(readKakaoCandidateReviews(localStorage));
                setKakaoDispatchLogs(readKakaoDispatchLogs(localStorage));
            } catch {
                setKakaoReviews({});
                setKakaoDispatchLogs([]);
            }
        }, 0);
        return () => window.clearTimeout(timer);
    }, []);

    // Handle click outside to close dropdown
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setIsSelectOpen(false);
                setActiveOptionIndex(-1);
            }
        };
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, []);

    const filteredExams = useMemo(() => {
        if (!inputValue) return exams;
        // Don't filter if the input exactly matches the selected exam title (meaning it's just displaying it)
        const currentSelected = exams.find(e => e.id === selectedExamId);
        if (currentSelected && inputValue === currentSelected.title && !isSelectOpen) return exams;
        return exams.filter(exam => exam.title.toLowerCase().includes(inputValue.toLowerCase()));
    }, [exams, inputValue, selectedExamId, isSelectOpen]);
    const filteredExamKey = filteredExams.map(exam => exam.id).join("\u0000");

    useEffect(() => {
        const timer = window.setTimeout(() => {
            setActiveOptionIndex(isSelectOpen && filteredExams.length > 0 ? 0 : -1);
        }, 0);
        return () => window.clearTimeout(timer);
    }, [filteredExamKey, filteredExams.length, isSelectOpen]);

    useEffect(() => {
        if (!shouldScrollActiveOptionRef.current) return;
        shouldScrollActiveOptionRef.current = false;
        if (!isSelectOpen || activeOptionIndex < 0) return;

        const activeOption = dropdownRef.current?.querySelector<HTMLElement>(
            `#exam-analytics-option-${activeOptionIndex}`,
        );
        if (activeOption && typeof activeOption.scrollIntoView === "function") {
            activeOption.scrollIntoView({ block: "nearest" });
        }
    }, [activeOptionIndex, filteredExamKey, isSelectOpen]);

    // Keep input in sync with selected exam when not open
    useEffect(() => {
        const nextInputValue = resolveExamSelectionInputValue(exams, selectedExamId);
        if (!isSelectOpen && inputValue !== nextInputValue) {
            const timer = window.setTimeout(() => setInputValue(nextInputValue), 0);
            return () => window.clearTimeout(timer);
        }
    }, [selectedExamId, exams, isSelectOpen, inputValue]);

    // Sync initialExamId only when parent navigation changes it; manual selection inside this tab should remain stable.
    useEffect(() => {
        if (initialExamId && initialExamId !== lastAppliedInitialExamIdRef.current) {
            lastAppliedInitialExamIdRef.current = initialExamId;
            const timer = window.setTimeout(() => setSelectedExamId(initialExamId), 0);
            return () => window.clearTimeout(timer);
        }
    }, [initialExamId]);

    useEffect(() => {
        const nextSelection = resolveExamSelection(exams, selectedExamId);
        if (nextSelection !== selectedExamId) {
            const timer = window.setTimeout(() => setSelectedExamId(nextSelection), 0);
            return () => window.clearTimeout(timer);
        }
    }, [exams, selectedExamId]);

    const selectedExam = useMemo(() => exams.find(e => e.id === selectedExamId), [exams, selectedExamId]);
    const selectedExamCollectionAttempts = useMemo(() => (
        attempts.filter(attempt => attempt.examId === selectedExamId)
    ), [attempts, selectedExamId]);
    const allSelectedExamAttempts = useMemo(() => (
        completedAttemptsOnly(selectedExamCollectionAttempts)
    ), [selectedExamCollectionAttempts]);
    const baseExamAttempts = useMemo(() => allSelectedExamAttempts.filter(a => !a.retake), [allSelectedExamAttempts]);
    const regionScopeOptions = useMemo(() => (
        canonicalAnalyticsSnapshots !== undefined ? [] : buildRegionalLearningScopes({
            students: rosterStudents,
            groups: rosterGroups,
            attempts: baseExamAttempts,
            exams: selectedExam ? [selectedExam] : [],
        }).filter(scope => scope.attemptCount > 0)
    ), [baseExamAttempts, canonicalAnalyticsSnapshots, rosterGroups, rosterStudents, selectedExam]);
    const activeRegionKey = selectedRegionKey === ALL_REGION_KEY || regionScopeOptions.some(scope => scope.regionKey === selectedRegionKey)
        ? selectedRegionKey
        : ALL_REGION_KEY;
    const activeRegionScope = regionScopeOptions.find(scope => scope.regionKey === activeRegionKey);
    const activeRegionLabel = activeRegionKey === ALL_REGION_KEY ? "전체 지역" : regionalScopeLabel(activeRegionScope);
    const examAttempts = useMemo(() => (
        activeRegionKey === ALL_REGION_KEY
            ? baseExamAttempts
            : filterAttemptsByRegion(baseExamAttempts, activeRegionKey, rosterStudents, rosterGroups)
    ), [activeRegionKey, baseExamAttempts, rosterGroups, rosterStudents]);
    const requiresCanonicalSnapshot = canonicalAnalyticsSnapshots !== undefined;
    const canonicalSnapshot = useMemo(() => {
        if (!requiresCanonicalSnapshot || !selectedExam || activeRegionKey !== ALL_REGION_KEY) return null;
        return currentTeacherCanonicalAnalyticsSnapshot(
            canonicalAnalyticsSnapshots[selectedExam.id],
            selectedExam.id,
            selectedExamCollectionAttempts,
        );
    }, [activeRegionKey, canonicalAnalyticsSnapshots, requiresCanonicalSnapshot, selectedExam, selectedExamCollectionAttempts]);
    const buildAnalyticsRetakeHref = (
        sourceAttemptId: string,
        questionIds: number[],
        mode: "wrong" | "similar" | "custom",
        metadata: { labels?: string[]; concepts?: string[] } = {},
    ): string | null => {
        if (!selectedExam || questionIds.length === 0) return null;
        const cohortKeys = requiresCanonicalSnapshot
            ? mode === "wrong" && canonicalSnapshot
                ? exactTeacherCanonicalWrongRetakeCohorts(canonicalSnapshot, sourceAttemptId, questionIds)
                : null
            : undefined;
        if (requiresCanonicalSnapshot && !cohortKeys) return null;
        return buildRetakeHref(selectedExam.id, sourceAttemptId, questionIds, mode, {
            ...metadata,
            ...(cohortKeys ? { cohortKeys } : {}),
        });
    };
    const analyticsIndex = useMemo(() => (
        !requiresCanonicalSnapshot && selectedExam
            ? buildCanonicalAttemptAnalyticsIndex(selectedExam, examAttempts)
            : undefined
    ), [examAttempts, requiresCanonicalSnapshot, selectedExam]);
    const scopedRosterStudents = useMemo(() => (
        activeRegionKey === ALL_REGION_KEY
            ? rosterStudents
            : rosterStudents.filter(student => regionKeyFor(regionNameForStudent(student)) === activeRegionKey)
    ), [activeRegionKey, rosterStudents]);
    const scopedRosterGroups = useMemo(() => (
        activeRegionKey === ALL_REGION_KEY
            ? rosterGroups
            : rosterGroups.filter(group => regionKeyFor(regionNameForGroup(group, rosterStudents)) === activeRegionKey)
    ), [activeRegionKey, rosterGroups, rosterStudents]);

    const examStats = useMemo(() => {
        if (!selectedExam || examAttempts.length === 0) return null;

        // A stored legacy score remains valid when it carries a positive totalScore.
        // Rows with no computed or stored denominator are submission evidence only,
        // never zero-score performance evidence.
        const scores = requiresCanonicalSnapshot
            ? examAttempts
                .filter(attempt => Number.isFinite(attempt.totalScore) && attempt.totalScore > 0)
                .map(attempt => safeScorePercent(attempt.score, attempt.totalScore))
            : examAttempts
                .map(attempt => summarizeAttemptScore(selectedExam, attempt, analyticsIndex))
                .filter(hasGradableAttemptScore)
                .map(summary => summary.scorePercent);
        const distribution = computeScoreDistribution(scores);
        const elapsedTimes = examAttempts.map(attemptElapsedTimeSec).filter(value => value > 0);
        const avgElapsedTimeSec = elapsedTimes.length > 0
            ? Math.round(elapsedTimes.reduce((sum, value) => sum + value, 0) / elapsedTimes.length)
            : 0;
        const handwritingArchiveCount = examAttempts.filter(attempt => (
            !!attempt.handwritingArchived && !!(attempt.handwriting?.strokesRef || attempt.drawingsRef)
        )).length;

        return {
            avgScore: distribution.count > 0 ? Math.round(distribution.mean) : null,
            maxScore: distribution.count > 0 ? Math.round(distribution.max) : null,
            minScore: distribution.count > 0 ? Math.round(distribution.min) : null,
            medianScore: distribution.count > 0 ? distribution.median : null,
            standardDeviation: distribution.count > 0 ? distribution.standardDeviation : null,
            distributionBuckets: distribution.buckets,
            submissionCount: examAttempts.length,
            performanceCount: distribution.count,
            avgElapsedTimeSec,
            handwritingArchiveCount,
        };
    }, [analyticsIndex, examAttempts, requiresCanonicalSnapshot, selectedExam]);

    const questionBankReadiness = useMemo(() => {
        if (!selectedExam) return null;
        if (requiresCanonicalSnapshot) return null;
        return buildQuestionBankReadiness(selectedExam, examAttempts);
    }, [examAttempts, requiresCanonicalSnapshot, selectedExam]);

    const regionalActionPlans = useMemo(() => {
        if (!selectedExam) return [];
        if (requiresCanonicalSnapshot) return [];
        return buildRegionalActionPlans({
            students: rosterStudents,
            groups: rosterGroups,
            attempts: baseExamAttempts,
            exams: [selectedExam],
            options: {
                regionLimit: 3,
                examLimit: 1,
                recommendationLimit: 2,
                riskLimit: 3,
                weaknessKinds: ["concept", "mistakeType"],
            },
        }).filter(plan => plan.attemptCount > 0);
    }, [baseExamAttempts, requiresCanonicalSnapshot, rosterGroups, rosterStudents, selectedExam]);
    const visibleRegionalActionPlans = useMemo(() => (
        activeRegionKey === ALL_REGION_KEY
            ? regionalActionPlans
            : regionalActionPlans.filter(plan => plan.regionKey === activeRegionKey)
    ), [activeRegionKey, regionalActionPlans]);

    const kakaoCandidateSummary = useMemo(() => {
        if (!selectedExam) return null;
        if (requiresCanonicalSnapshot) return null;
        return buildKakaoNotificationCandidates({
            exams: [selectedExam],
            attempts: examAttempts,
            students: scopedRosterStudents,
            groups: scopedRosterGroups,
            limit: 6,
        });
    }, [examAttempts, requiresCanonicalSnapshot, scopedRosterGroups, scopedRosterStudents, selectedExam]);
    const kakaoReviewSummary = useMemo(() => {
        if (!kakaoCandidateSummary) return null;
        return summarizeKakaoCandidateReviews(kakaoCandidateSummary.candidates, kakaoReviews);
    }, [kakaoCandidateSummary, kakaoReviews]);
    const kakaoDispatchSummary = useMemo(() => {
        if (!kakaoCandidateSummary) return null;
        return summarizeKakaoDispatchLogs(kakaoDispatchLogs, kakaoCandidateSummary.candidates.map(candidate => candidate.id));
    }, [kakaoCandidateSummary, kakaoDispatchLogs]);

    const updateKakaoReviewStatus = async (candidate: KakaoNotificationCandidate, status: KakaoCandidateReviewStatus) => {
        if (!remindersEnabled) return;
        try {
            const result = await saveKakaoCandidateReview(localStorage, candidate, status);
            if (!result.localSaved && result.remoteError) throw new Error(result.remoteError);
            setKakaoReviews(result.reviews);
        } catch {
            setKakaoReviews(prev => prev);
        }
    };

    const queueKakaoDispatch = (candidate: KakaoNotificationCandidate) => {
        if (!remindersEnabled || !kakaoProviderReadiness.canQueueDispatch) return;
        const record = kakaoReviews[candidate.id];
        if (!record || record.status !== "ready") return;
        void queueKakaoDispatchSimulation(localStorage, record, candidate).then(result => {
            setKakaoDispatchLogs(result.logs);
            if (result.remoteError) {
                console.warn("Kakao dispatch log remote sync failed", result.remoteError);
            }
        }).catch(() => setKakaoDispatchLogs(prev => prev));
    };

    const updateKakaoDispatchStatus = (
        candidate: KakaoNotificationCandidate,
        log: KakaoDispatchLog | undefined,
        status: KakaoDispatchLog["status"],
    ) => {
        if (!remindersEnabled || !kakaoProviderReadiness.canMarkOutcomes || !log) return;
        const record = kakaoReviews[candidate.id];
        if (!record) return;
        const previousLogs = kakaoDispatchLogs;
        const result = updateKakaoDispatchLogStatus(localStorage, log.id, status, {
            providerMessageId: status === "sent" ? `simulation:${log.id}` : undefined,
            errorMessage: status === "failed" ? "provider 연동 전 수동 실패 기록" : undefined,
        });
        if (!result.log) return;
        setKakaoDispatchLogs(result.logs);
        void syncKakaoDispatchLog(result.log, record, candidate).then(syncResult => {
            if (syncResult.remoteError) {
                writeKakaoDispatchLogs(localStorage, previousLogs);
                setKakaoDispatchLogs(previousLogs);
            }
        });
    };

    // Calculate Question Analytics
    const questionAnalytics = useMemo(() => {
        if (!selectedExam || examAttempts.length === 0) return [];

        if (requiresCanonicalSnapshot && canonicalSnapshot?.status !== "ready") return [];
        const resultStats = canonicalSnapshot?.questionStats
            || buildExamQuestionResultStats(selectedExam, examAttempts, analyticsIndex);
        const pointBiserialByQuestionId = canonicalSnapshot
            ? new Map(canonicalSnapshot.pointBiserial)
            : buildExamQuestionPointBiserial(selectedExam, examAttempts, analyticsIndex);
        const cohortCountsByQuestionId = new Map<number, number>();
        resultStats.forEach(stat => cohortCountsByQuestionId.set(
            stat.questionId,
            (cohortCountsByQuestionId.get(stat.questionId) ?? 0) + 1,
        ));

        return resultStats.map((stat) => {
            const choices = Math.max(5, stat.correctAnswer || 0, ...Object.keys(stat.optionCounts).map(Number));
            const optionCounts: Record<number, number> = {
                ...Object.fromEntries(Array.from({ length: choices }, (_, i) => [i + 1, 0])),
                ...stat.optionCounts,
            };
            const correctRate = stat.correctRate;
            const unansweredRate = stat.unansweredRate;

            const optionRates = Object.entries(optionCounts).map(([opt, count]) => ({
                option: parseInt(opt),
                count,
                rate: safeRatePercent(count, stat.totalCount)
            }));
            const topWrongOption = optionRates
                .filter(item => item.option !== stat.correctAnswer)
                .sort((a, b) => b.rate - a.rate)[0];

            return {
                index: stat.questionNumber,
                id: stat.questionId,
                cohortKey: stat.cohortKey,
                definitionManifestHash: stat.definitionManifestHash,
                cohortLabel: (cohortCountsByQuestionId.get(stat.questionId) ?? 0) > 1
                    ? `제출 정의 ${stat.definitionManifestHash.slice(7, 15)}`
                    : "",
                label: stat.label || '일반',
                concept: stat.concept || stat.label || '일반',
                unit: stat.unit,
                difficulty: stat.difficulty,
                mistakeTypes: stat.mistakeTypes || [],
                expectedTimeSec: stat.expectedTimeSec,
                averageTimeSec: stat.averageTimeSec,
                timeOverExpectedRate: stat.timeOverExpectedRate,
                averageVisitCount: stat.averageVisitCount,
                revisitRate: stat.revisitRate,
                answerChangeCount: stat.answerChangeCount,
                correctRate,
                correctCount: stat.correctCount,
                totalCount: stat.totalCount,
                wrongRate: stat.wrongRate,
                unansweredRate,
                // 점이연 상관 기준 — the unified item-discrimination index (null when the
                // respondent pool is below DISCRIMINATION_MIN_RESPONDENTS → rendered "-").
                pointBiserial: pointBiserialByQuestionId.get(stat.cohortKey) ?? null,
                topWrongOption,
                optionRates,
                answer: stat.correctAnswer,
                choices,
            };
        }).sort((a: { correctRate: number }, b: { correctRate: number }) => a.correctRate - b.correctRate); // Sort by hardest first
    }, [analyticsIndex, canonicalSnapshot, examAttempts, requiresCanonicalSnapshot, selectedExam]);

    const gradableQuestionAnalytics = useMemo(
        () => filterGradableQuestionEvidence(questionAnalytics),
        [questionAnalytics],
    );
    const questionCorrectRateChartData = useMemo(
        () => buildQuestionCorrectRateChartData(
            [...questionAnalytics].sort((a, b) => a.index - b.index),
        ),
        [questionAnalytics],
    );
    const questionCorrectRateChartSummary = `문항별 상세 정답률 데이터: ${questionCorrectRateChartData
        .map(question => `${question.index}번${question.cohortLabel ? ` (${question.cohortLabel})` : ""} ${question.correctRateLabel}`)
        .join(", ")}.`;

    const examLabels = useMemo(() => {
        return Array.from(new Set(questionAnalytics.map(q => q.label || '일반')));
    }, [questionAnalytics]);

    const maxChoiceCount = useMemo(() => {
        return Math.max(DEFAULT_CHOICE_COUNT, ...questionAnalytics.map(q => q.choices));
    }, [questionAnalytics]);

    const studentScores = useMemo(() => {
        if (!selectedExam || examAttempts.length === 0) return [];
        if (requiresCanonicalSnapshot) {
            if (canonicalSnapshot?.status !== "ready" || !canonicalSnapshot.studentAggregatesComplete) return [];
            const attemptById = new Map(examAttempts.map(attempt => [attempt.id, attempt]));
            return canonicalSnapshot.studentRows.flatMap(row => {
                const attempt = attemptById.get(row.attemptId);
                if (!attempt) return [];
                return [{
                    studentName: row.studentName,
                    gradingSource: row.gradingSource,
                    questionResults: [] as QuestionResult[],
                    totalScore: row.totalScore,
                    scorePercentage: row.scorePercentage,
                    hasPerformanceScore: row.hasPerformanceScore,
                    labelScores: row.labelScores,
                    behavior: row.behavior,
                    topWeakness: row.topWeakness || undefined,
                    retakeQuestionIds: row.retakeQuestionIds,
                    questionCsvRows: row.questionCsvRows,
                    attempt,
                }];
            });
        }
        return examAttempts.map(attempt => {
            const labelScores: Record<string, { earned: number, total: number }> = {};
            examLabels.forEach(l => labelScores[l] = { earned: 0, total: 0 });

            const gradingResolution = analyticsIndex?.resolutionFor(attempt)
                || resolveAttemptGrading(selectedExam, attempt);
            const results = gradingResolution.questionResults;
            results.forEach(result => {
                if (!isGradableResult(result)) return;
                const label = result.label || '일반';
                if (!labelScores[label]) labelScores[label] = { earned: 0, total: 0 };
                labelScores[label].total += result.score;
                labelScores[label].earned += result.earnedScore;
            });
            const scoreSummary = gradingResolution.scoreSummary;

            return {
                studentName: attempt.studentName,
                gradingSource: gradingResolution.source,
                questionResults: results,
                totalScore: scoreSummary.earnedScore,
                scorePercentage: scoreSummary.scorePercent,
                hasPerformanceScore: hasGradableAttemptScore(scoreSummary),
                labelScores,
                behavior: summarizeAttemptBehavior(attempt),
                topWeakness: undefined,
                retakeQuestionIds: buildRetakeQuestionIds(selectedExam, attempt),
                questionCsvRows: undefined,
                attempt
            };
        });
    }, [analyticsIndex, canonicalSnapshot, examAttempts, examLabels, requiresCanonicalSnapshot, selectedExam]);

    const performanceStudentScores = useMemo(
        () => studentScores.filter(student => student.hasPerformanceScore),
        [studentScores],
    );
    const excludedGradingEvidence = useMemo(() => studentScores.reduce((summary, student) => {
        if (student.gradingSource === "legacy_derived_current_exam") summary.legacy += 1;
        if (student.gradingSource === "stored_totals_only" || student.gradingSource === "incomplete_or_invalid") {
            summary.incomplete += 1;
        }
        return summary;
    }, { legacy: 0, incomplete: 0 }), [studentScores]);

    const [sortField, setSortField] = useState<'name' | 'score'>('score');
    const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

    const sortedStudentScores = useMemo(() => {
        return [...studentScores].sort((a, b) => {
            if (sortField === 'score') {
                return sortDir === 'asc' ? a.totalScore - b.totalScore : b.totalScore - a.totalScore;
            } else {
                return sortDir === 'asc' ? a.studentName.localeCompare(b.studentName) : b.studentName.localeCompare(a.studentName);
            }
        });
    }, [studentScores, sortField, sortDir]);

    const conceptAnalytics = useMemo(() => {
        if (!selectedExam || examAttempts.length === 0) return [];

        const conceptMap: Record<string, {
            questionCount: number;
            correctCountSum: number;
            totalCountSum: number;
            hardCount: number;
            questionNumbers: number[];
            mistakeTypes: Set<string>;
        }> = {};

        gradableQuestionAnalytics.forEach(q => {
            const concept = q.concept || q.label || '일반';
            if (!conceptMap[concept]) {
                conceptMap[concept] = {
                    questionCount: 0,
                    correctCountSum: 0,
                    totalCountSum: 0,
                    hardCount: 0,
                    questionNumbers: [],
                    mistakeTypes: new Set<string>(),
                };
            }
            conceptMap[concept].questionCount++;
            // Aggregate raw counts across the concept's questions so the concept correct
            // rate is a single weighted rate, not an average of already-rounded per-question rates.
            conceptMap[concept].correctCountSum += q.correctCount;
            conceptMap[concept].totalCountSum += q.totalCount;
            conceptMap[concept].questionNumbers.push(q.index);
            if (q.difficulty === 'hard' || q.difficulty === 'killer') conceptMap[concept].hardCount++;
            q.mistakeTypes.forEach(type => conceptMap[concept].mistakeTypes.add(type));
        });

        return Object.entries(conceptMap)
            .map(([concept, data]) => ({
                concept,
                questionCount: data.questionCount,
                correctRate: safeRatePercent(data.correctCountSum, data.totalCountSum),
                hardCount: data.hardCount,
                questionNumbers: data.questionNumbers.sort((a, b) => a - b),
                mistakeTypes: Array.from(data.mistakeTypes),
            }))
            .sort((a, b) => a.correctRate - b.correctRate);
    }, [selectedExam, examAttempts, gradableQuestionAnalytics]);

    // B4: this panel is about the HIGHEST wrong rate, so sort by wrongRate desc rather
    // than reusing questionAnalytics' lowest-correctRate ordering (which unanswered skews).
    const topWrongQuestions = useMemo(
        () => [...gradableQuestionAnalytics].sort((a, b) => b.wrongRate - a.wrongRate).slice(0, 3),
        [gradableQuestionAnalytics],
    );

    const teachingInsights = useMemo(() => {
        if (!examStats) return null;

        const weakConcept = conceptAnalytics[0];
        // Weak discrimination = point-biserial below the psychometric "poor" threshold
        // (r < .20), same criterion as the 문항별 상세 table. Only counts within the
        // 35–85% correct-rate band (outside it a low index is expected, not a defect)
        // and only when the index is reliable (null = fewer than n ≥ 5 respondents).
        const hasWeakDiscrimination = (q: typeof questionAnalytics[number]) =>
            q.pointBiserial !== null && q.pointBiserial < WEAK_POINT_BISERIAL_THRESHOLD
            && q.correctRate >= 35 && q.correctRate <= 85;
        const riskyQuestionSummary = summarizeRiskyQuestions(gradableQuestionAnalytics.filter(q =>
            q.correctRate < 50 ||
            hasWeakDiscrimination(q) ||
            q.unansweredRate >= 20 ||
            (q.topWrongOption?.rate || 0) >= 30
        ));
        const tooEasyCount = gradableQuestionAnalytics.filter(q => q.correctRate >= 90).length;
        const weakDiscriminationCount = gradableQuestionAnalytics.filter(hasWeakDiscrimination).length;
        const lowStudents = performanceStudentScores.filter(student => student.scorePercentage < 60);
        const borderlineStudents = performanceStudentScores.filter(student => student.scorePercentage >= 60 && student.scorePercentage < 80);
        const advancedStudents = performanceStudentScores.filter(student => student.scorePercentage >= 90);

        return {
            weakConcept,
            riskyQuestions: riskyQuestionSummary.displayQuestions,
            riskyQuestionCount: riskyQuestionSummary.totalCount,
            tooEasyCount,
            weakDiscriminationCount,
            lowStudents,
            borderlineStudents,
            advancedStudents,
            actionCopy: weakConcept
                ? `${weakConcept.concept} 보강 후 ${weakConcept.questionNumbers.slice(0, 4).join(", ")}번 유사문항 재응시`
                : "응시 데이터가 쌓이면 보강 우선순위를 계산합니다.",
        };
    }, [conceptAnalytics, examStats, gradableQuestionAnalytics, performanceStudentScores]);

    const studentAchievementBands = useMemo(() => {
        const definitions = [
            { key: "under40", label: "40점 미만", min: 0, max: 40, tone: "grade" as const },
            { key: "under60", label: "40~59점", min: 40, max: 60, tone: "warning" as const },
            { key: "under80", label: "60~79점", min: 60, max: 80, tone: "neutral" as const },
            { key: "over80", label: "80~100점", min: 80, max: 101, tone: "success" as const },
        ];
        const total = performanceStudentScores.length;
        return definitions.map(definition => {
            const count = performanceStudentScores.filter(student => (
                student.scorePercentage >= definition.min && student.scorePercentage < definition.max
            )).length;
            return {
                ...definition,
                count,
                rate: safeRatePercent(count, total),
            };
        });
    }, [performanceStudentScores]);

    const overviewRetakeQuestionIds = (
        teachingInsights?.riskyQuestions.length
            ? teachingInsights.riskyQuestions
            : gradableQuestionAnalytics
    )
        .map(question => question.id)
        .slice(0, 5);
    const overviewRetakeHref = selectedExam && examAttempts[0] && overviewRetakeQuestionIds.length > 0
        ? buildAnalyticsRetakeHref(examAttempts[0].id, overviewRetakeQuestionIds, "custom", {
            concepts: teachingInsights?.weakConcept?.concept ? [teachingInsights.weakConcept.concept] : undefined,
        })
        : null;
    const overviewHeadline = useMemo(() => buildExamHeadlineInsight({
        performanceCount: examStats?.performanceCount ?? 0,
        totalSubmissionCount: examStats?.submissionCount ?? 0,
        weakConcept: teachingInsights?.weakConcept?.concept,
        weakConceptRate: teachingInsights?.weakConcept?.correctRate,
        hasGradableEvidence: gradableQuestionAnalytics.length > 0,
        lowStudentCount: teachingInsights?.lowStudents.length ?? 0,
        riskyQuestionCount: teachingInsights?.riskyQuestionCount ?? 0,
    }), [examStats?.performanceCount, examStats?.submissionCount, gradableQuestionAnalytics.length, teachingInsights]);
    const overviewMetrics = useMemo<AnalyticsMetricItem[]>(() => examStats ? [
        { id: "mean", label: "평균", value: examStats.avgScore ?? "-", unit: examStats.avgScore === null ? undefined : "점", detail: examStats.standardDeviation === null ? "채점 가능한 점수 없음" : `표준편차 ${examStats.standardDeviation}`, animate: true },
        { id: "median", label: "중앙값", value: examStats.medianScore ?? "-", unit: examStats.medianScore === null ? undefined : "점", animate: true },
        { id: "maximum", label: "최고", value: examStats.maxScore ?? "-", unit: examStats.maxScore === null ? undefined : "점", animate: true },
        { id: "minimum", label: "최저", value: examStats.minScore ?? "-", unit: examStats.minScore === null ? undefined : "점", tone: "grade", animate: true },
        { id: "submissions", label: "채점 응시", value: examStats.performanceCount, unit: "명", detail: `전체 제출 ${examStats.submissionCount}건`, animate: true },
        { id: "elapsed", label: "평균 시간", value: formatSeconds(examStats.avgElapsedTimeSec) },
    ] : [], [examStats]);
    const overviewWeakQuestions = useMemo<ExamOverviewWeakQuestion[]>(() => (
        gradableQuestionAnalytics.slice(0, 5).map(question => ({
            key: question.cohortKey,
            questionNumber: question.index,
            title: question.concept,
            correctRate: question.correctRate,
            evidence: question.topWrongOption
                ? `정답 ${question.correctCount}/${question.totalCount}명 · 최다 오답 ${question.topWrongOption.option}번 ${question.topWrongOption.rate}%`
                : `정답 ${question.correctCount}/${question.totalCount}명 · 오답 없음`,
        }))
    ), [gradableQuestionAnalytics]);
    const overviewActions = useMemo<ExamOverviewAction[]>(() => {
        if (!teachingInsights) return [];

        const actions: ExamOverviewAction[] = teachingInsights.weakConcept ? [{
            key: "weak-concept",
            title: `취약 개념 보강 · ${teachingInsights.weakConcept.concept}`,
            detail: teachingInsights.actionCopy,
            onAction: () => setActiveWorkspaceView("questions"),
        }] : [{
            key: "evidence-readiness",
            title: "채점 근거 확인",
            detail: "미채점 문항을 확인한 뒤 취약 개념과 행동 추천을 계산합니다.",
            onAction: () => setActiveWorkspaceView("questions"),
        }];

        if (gradableQuestionAnalytics.length > 0) actions.push(
            {
                key: "question-quality",
                title: buildQuestionQualityActionTitle(teachingInsights.riskyQuestionCount, teachingInsights.tooEasyCount),
                detail: `변별 약함 ${teachingInsights.weakDiscriminationCount}개 · 지나치게 쉬움 ${teachingInsights.tooEasyCount}개`,
                onAction: () => setActiveWorkspaceView("questions"),
            },
            {
                key: "student-support",
                title: `지원이 필요한 학생 ${teachingInsights.lowStudents.length}명`,
                detail: `60~79점 경계 구간 ${teachingInsights.borderlineStudents.length}명 · 심화 ${teachingInsights.advancedStudents.length}명`,
                onAction: () => setActiveWorkspaceView("students"),
            },
        );

        if (overviewRetakeHref) {
            actions.push({
                key: `retake:${gradableQuestionAnalytics.slice(0, 5).map(question => question.cohortKey).join("|")}`,
                title: "보강 세트 만들기",
                detail: "취약 문항으로 재시험 보강 세트를 구성합니다.",
                href: overviewRetakeHref,
                enabled: retakeAssignmentsEnabled,
                lockedTitle: "Pro 이상에서 취약 문항 보강 세트를 만들 수 있습니다.",
            });
        } else if (gradableQuestionAnalytics.length > 0) {
            actions.push({
                key: "questions",
                title: "취약 문항 보기",
                detail: "문항별 정답률과 오답 근거를 확인합니다.",
                onAction: () => setActiveWorkspaceView("questions"),
            });
        }

        return actions;
    }, [gradableQuestionAnalytics, overviewRetakeHref, retakeAssignmentsEnabled, teachingInsights]);

    const examTypeWeaknessGroups = useMemo(() => {
        // Feeds Pro-gated UI only — skip the recommendation pass when locked.
        if (!advancedAnalyticsEnabled) return [];
        if (!selectedExam || examAttempts.length === 0) return [];
        if (requiresCanonicalSnapshot) return canonicalSnapshot?.status === "ready"
            ? canonicalSnapshot.recommendations.slice(0, 6)
            : [];
        return buildLearningRecommendations(selectedExam, examAttempts, {
            scope: "exam",
            kinds: ["concept"],
            limit: 6,
        }, analyticsIndex);
    }, [advancedAnalyticsEnabled, analyticsIndex, canonicalSnapshot, examAttempts, requiresCanonicalSnapshot, selectedExam]);

    const classWeaknessMatrixRows = useMemo(() => {
        // Feeds Pro-gated UI only — skip the per-class matrix when locked.
        if (!advancedAnalyticsEnabled) return [];
        if (!selectedExam || examAttempts.length === 0) return [];
        if (requiresCanonicalSnapshot) return canonicalSnapshot?.status === "ready"
            ? canonicalSnapshot.classMatrix.slice(0, 6)
            : [];
        return buildClassExamWeaknessMatrix(selectedExam, examAttempts, {
            kinds: ["concept"],
            recommendationLimit: 2,
            classLimit: 6,
            rosterGroups: scopedRosterGroups,
            rosterStudents: scopedRosterStudents,
        }, analyticsIndex);
    }, [advancedAnalyticsEnabled, analyticsIndex, canonicalSnapshot, examAttempts, requiresCanonicalSnapshot, scopedRosterGroups, scopedRosterStudents, selectedExam]);

    // Feeds the "반별 점수 비교" range-bar card — same Pro gate and grouping as the weakness
    // matrix above, but only needs raw score percentages (min/median/average/max), not the
    // recommendation machinery.
    const groupScoreSummaries = useMemo(() => {
        if (!advancedAnalyticsEnabled) return [];
        if (!selectedExam || examAttempts.length === 0) return [];
        if (requiresCanonicalSnapshot) return [];
        const groups = buildClassExamScoreGroups(selectedExam, examAttempts, {
            rosterGroups: scopedRosterGroups,
            rosterStudents: scopedRosterStudents,
        }, analyticsIndex);
        return computeGroupScoreSummary(groups.map(group => ({
            groupKey: group.groupKey,
            groupName: formatRegionScopedLabel(group.groupName, group.regionName),
            scores: group.scores,
        })));
    }, [advancedAnalyticsEnabled, analyticsIndex, examAttempts, requiresCanonicalSnapshot, scopedRosterGroups, scopedRosterStudents, selectedExam]);

    const classTypeWeaknessRows = useMemo(() => classWeaknessMatrixRows
        .flatMap(row => {
            const topGroup = row.recommendations[0];
            if (!topGroup) return [];
            return [{
                ...row,
                key: row.groupKey,
                name: row.groupName,
                label: formatRegionScopedLabel(row.groupName, row.regionName),
                topGroup,
            }];
        })
        .slice(0, 4), [classWeaknessMatrixRows]);

    const classScopeOptions = useMemo(() => {
        return classWeaknessMatrixRows
            .map(row => ({
                key: row.groupKey,
                name: row.groupName,
                regionName: row.regionName,
                label: formatRegionScopedLabel(row.groupName, row.regionName),
                attemptCount: row.attemptCount,
                averageScoreRate: row.averageScorePercent,
                participationRate: row.participationRate,
                missingStudentCount: row.missingStudentCount,
            }))
            .sort((a, b) => a.label.localeCompare(b.label, "ko"));
    }, [classWeaknessMatrixRows]);

    const studentScopeOptions = useMemo(() => {
        const seen = new Set<string>();
        return sortedStudentScores
            .map(student => ({
                key: studentScopeKeyForAttempt(student.attempt),
                name: student.studentName,
                groupName: student.attempt.groupName,
                regionName: attemptRegionName(student.attempt),
                label: [
                    student.studentName,
                    student.attempt.groupName,
                    attemptRegionName(student.attempt),
                ].filter(Boolean).join(" · "),
                scorePercentage: student.scorePercentage,
                hasPerformanceScore: student.hasPerformanceScore,
                attempt: student.attempt,
            }))
            .filter(student => {
                if (seen.has(student.key)) return false;
                seen.add(student.key);
                return true;
            });
    }, [sortedStudentScores]);

    const activeClassKey = resolveScopedSelection(classScopeOptions, selectedClassKey);
    const activeStudentKey = resolveScopedSelection(studentScopeOptions, selectedStudentKey);

    const scopedLabelAnalytics = useMemo(() => {
        if (!selectedExam || examAttempts.length === 0) return [];
        if (requiresCanonicalSnapshot) {
            if (canonicalSnapshot?.status !== "ready") return [];
            const byLabel = new Map<string, { correct: number; total: number; time: number; timed: number }>();
            for (const stat of canonicalSnapshot.questionStats) {
                const label = stat.label || "일반";
                const current = byLabel.get(label) || { correct: 0, total: 0, time: 0, timed: 0 };
                current.correct += stat.correctCount;
                current.total += stat.totalCount;
                if (typeof stat.averageTimeSec === "number") {
                    current.time += stat.averageTimeSec * stat.totalCount;
                    current.timed += stat.totalCount;
                }
                byLabel.set(label, current);
            }
            return [...byLabel].map(([label, value]) => ({
                label,
                correctRate: safeRatePercent(value.correct, value.total),
                wrongRate: safeRatePercent(value.total - value.correct, value.total),
                totalCount: value.total,
                averageTimeSec: value.timed > 0 ? Math.round(value.time / value.timed) : 0,
            }));
        }
        const results = collectQuestionResults(selectedExam, examAttempts, {
            groupKey: analysisScope === "class" ? activeClassKey : undefined,
            studentKey: analysisScope === "student" ? activeStudentKey : undefined,
        }, analyticsIndex);
        return buildQuestionResultTagStats(results, "label").map(stat => ({
            label: stat.title,
            correctRate: stat.correctRate,
            wrongRate: stat.wrongRate,
            totalCount: stat.totalCount,
            averageTimeSec: stat.averageTimeSec,
        }));
    }, [activeClassKey, activeStudentKey, analysisScope, analyticsIndex, canonicalSnapshot, examAttempts, requiresCanonicalSnapshot, selectedExam]);

    const studentWeaknessByAttemptId = useMemo(() => {
        const map = new Map<string, LearningRecommendation>();
        if (activeWorkspaceView !== "students" || !advancedAnalyticsEnabled) return map;
        if (!selectedExam || examAttempts.length === 0) return map;
        if (requiresCanonicalSnapshot) {
            for (const student of studentScores) {
                if (student.topWeakness) map.set(student.attempt.id, student.topWeakness);
            }
            return map;
        }

        const attemptsByStudentKey = new Map<string, typeof examAttempts>();
        for (const attempt of examAttempts) {
            if (!hasGradableAttemptScore(summarizeAttemptScore(selectedExam, attempt))) continue;
            const studentKey = studentScopeKeyForAttempt(attempt);
            const bucket = attemptsByStudentKey.get(studentKey) || [];
            bucket.push(attempt);
            attemptsByStudentKey.set(studentKey, bucket);
        }

        for (const [studentKey, studentAttempts] of attemptsByStudentKey) {
            const topGroup = buildLearningRecommendations(selectedExam, studentAttempts, {
                scope: "student",
                studentKey,
                kinds: ["concept"],
                limit: 1,
            }, analyticsIndex)[0];
            if (!topGroup) continue;
            for (const attempt of studentAttempts) map.set(attempt.id, topGroup);
        }

        return map;
    }, [activeWorkspaceView, advancedAnalyticsEnabled, analyticsIndex, examAttempts, requiresCanonicalSnapshot, selectedExam, studentScores]);

    const scopedWeaknessGroups = useMemo(() => {
        // Feeds the Pro-gated 분석 컷 전환 section only.
        if (!advancedAnalyticsEnabled) return [];
        if (!selectedExam || examAttempts.length === 0) return [];

        if (requiresCanonicalSnapshot) {
            if (canonicalSnapshot?.status !== "ready") return [];
            if (analysisScope === "class") {
                return canonicalSnapshot.classMatrix
                    .find(row => row.groupKey === activeClassKey)?.recommendations || [];
            }
            if (analysisScope === "student") return [];
            return canonicalSnapshot.recommendations.slice(0, 5);
        }

        if (analysisScope === "class") {
            if (!activeClassKey) return [];
            return buildLearningRecommendations(selectedExam, examAttempts, {
                scope: "class",
                groupKey: activeClassKey,
                kinds: ["concept"],
                limit: 5,
            }, analyticsIndex);
        }

        if (analysisScope === "student") {
            if (!activeStudentKey) return [];
            return buildLearningRecommendations(selectedExam, examAttempts, {
                scope: "student",
                studentKey: activeStudentKey,
                kinds: ["concept", "mistakeType"],
                limit: 6,
            }, analyticsIndex);
        }

        return examTypeWeaknessGroups.slice(0, 5);
    }, [activeClassKey, activeStudentKey, advancedAnalyticsEnabled, analysisScope, analyticsIndex, canonicalSnapshot, examAttempts, examTypeWeaknessGroups, requiresCanonicalSnapshot, selectedExam]);

    const scopedSummary = useMemo(() => {
        if (analysisScope === "class") {
            const selected = classScopeOptions.find(group => group.key === activeClassKey);
            return selected
                ? `${selected.label} · 제출 ${selected.attemptCount}건 · 평균 ${selected.averageScoreRate === null ? "미채점" : `${selected.averageScoreRate}%`} · 참여 ${formatParticipationRateLabel(selected.participationRate)}${selected.missingStudentCount > 0 ? ` · 미응시 ${selected.missingStudentCount}명` : ""}`
                : "반 정보가 있는 제출이 없습니다.";
        }

        if (analysisScope === "student") {
            const selected = studentScopeOptions.find(student => student.key === activeStudentKey);
            return selected
                ? `${selected.label} · ${selected.hasPerformanceScore ? `점수 ${selected.scorePercentage}%` : "미채점"}`
                : "학생 제출이 없습니다.";
        }

        return `${selectedExam?.title || "선택 시험"} · ${activeRegionLabel} · 제출 ${examAttempts.length}건 · 반 ${classScopeOptions.length}개`;
    }, [activeClassKey, activeRegionLabel, activeStudentKey, analysisScope, classScopeOptions, examAttempts.length, selectedExam?.title, studentScopeOptions]);

    const scopedEmptyMessage = useMemo(() => {
        if (analysisScope === "class" && classScopeOptions.length === 0) {
            return "반 정보가 있는 제출부터 반별 약점 유형이 표시됩니다.";
        }
        if (analysisScope === "student" && studentScopeOptions.length === 0) {
            return "학생 제출이 쌓이면 학생별 약점 유형이 표시됩니다.";
        }
        return "선택한 범위에 오답/미응답 유형이 아직 없습니다.";
    }, [analysisScope, classScopeOptions.length, studentScopeOptions.length]);

    const similarQuestionGroups = useMemo(() => {
        // Feeds Pro-gated UI only — skip when locked.
        if (!advancedAnalyticsEnabled) return [];
        if (!selectedExam || examAttempts.length === 0) return [];
        if (requiresCanonicalSnapshot) return canonicalSnapshot?.status === "ready"
            ? canonicalSnapshot.similarQuestionGroups.filter(group => group.wrongCount > 0).slice(0, 6)
            : [];
        return buildSimilarQuestionGroups(selectedExam, examAttempts, analyticsIndex)
            .filter(group => group.wrongCount > 0)
            .slice(0, 6);
    }, [advancedAnalyticsEnabled, analyticsIndex, canonicalSnapshot, examAttempts, requiresCanonicalSnapshot, selectedExam]);

    const behaviorRows = useMemo(() => {
        // Feeds the Pro-gated 풀이 행동 신호 section only.
        if (!advancedAnalyticsEnabled) return [];
        return examAttempts
            .map(attempt => ({
                attempt,
                summary: summarizeAttemptBehavior(attempt),
            }))
            .filter(row =>
                row.summary.totalTrackedTimeSec > 0 ||
                row.summary.revisitedQuestionNumbers.length > 0 ||
                row.summary.focusLossCount > 0
            )
            .sort((a, b) => {
                if (b.summary.focusLossCount !== a.summary.focusLossCount) {
                    return b.summary.focusLossCount - a.summary.focusLossCount;
                }
                if (b.summary.revisitedQuestionNumbers.length !== a.summary.revisitedQuestionNumbers.length) {
                    return b.summary.revisitedQuestionNumbers.length - a.summary.revisitedQuestionNumbers.length;
                }
                return b.summary.totalTrackedTimeSec - a.summary.totalTrackedTimeSec;
            })
            .slice(0, 6);
    }, [advancedAnalyticsEnabled, examAttempts]);

    const handleSelectExam = (exam: Exam) => {
        setSelectedExamId(exam.id);
        setInputValue(exam.title);
        setIsSelectOpen(false);
        setActiveOptionIndex(-1);
        setSelectedClassKey("");
        setSelectedStudentKey("");
    };

    const moveActiveOptionFromKeyboard = (nextIndex: number) => {
        if (nextIndex === activeOptionIndex) return;
        shouldScrollActiveOptionRef.current = true;
        setActiveOptionIndex(nextIndex);
    };

    const handleSort = (field: 'name' | 'score') => {
        if (sortField === field) {
            setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
        } else {
            setSortField(field);
            setSortDir('desc');
        }
    };

    const handleExportCSV = (student: typeof studentScores[0]) => {
        if (!selectedExam) return;
        const rows = student.questionCsvRows || buildStudentQuestionAnalysisCsvRows(student);

        const csvContent = `${serializeCsvRows(rows)}\n`;
        const blob = new Blob(["\uFEFF" + csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.setAttribute("href", url);
        link.setAttribute("download", `${student.studentName}_${selectedExam.title}_분석.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    };

    const handleExportQuestionCohortCSV = () => {
        if (!selectedExam || canonicalSnapshot?.status !== "ready") return;
        const rows = teacherCanonicalQuestionCohortCsvRows(canonicalSnapshot);
        if (rows.length <= 1) return;
        const csvContent = `${serializeCsvRows(rows)}\n`;
        const blob = new Blob(["\uFEFF" + csvContent], { type: "text/csv;charset=utf-8;" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `${selectedExam.title}_제출정의_문항분석.csv`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
    };

    if (exams.length === 0) {
        return (
            <div className="fade-in-up" style={{ padding: '3rem 2rem', textAlign: 'center' }}>
                <div style={{
                    width: 80, height: 80, borderRadius: '50%',
                    background: 'linear-gradient(135deg, rgba(99,102,241,0.1), rgba(236,72,153,0.1))',
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    color: 'var(--primary)', marginBottom: '1.5rem'
                }}>
                    <BarChart2 size={36} />
                </div>
                <h3 style={{ fontSize: '1.15rem', fontWeight: 700, marginBottom: '0.5rem' }}>분석할 시험이 없습니다</h3>
                <p style={{ fontSize: '0.9rem', color: 'var(--muted)', marginBottom: '1.5rem' }}>
                    먼저 시험을 출제하면 응시 결과를 분석할 수 있습니다.
                </p>
                <a href="/create" style={{
                    display: 'inline-flex', alignItems: 'center', gap: '0.5rem',
                    padding: '0.75rem 1.4rem',
                    background: 'linear-gradient(135deg, var(--primary), var(--primary-dark))',
                    color: 'white', borderRadius: 'var(--radius-full)', fontWeight: 600, fontSize: '0.9rem',
                    boxShadow: '0 4px 14px rgba(99,102,241,0.3)'
                }}>
                    시험 출제하기
                </a>
            </div>
        );
    }

    return (
        <div className={`${styles.workspace} fade-in-up`}>
            <section className={styles.headerPanel} aria-labelledby="exam-analytics-title">
                <div className={styles.headingRow}>
                    <div className={styles.headingCopy}>
                        <h2 id="exam-analytics-title">시험별 통계</h2>
                        <p>점수보다 먼저, 다음 수업에서 무엇을 바꿀지 확인하세요.</p>
                    </div>
                    <div className={styles.scopeNote}>
                        <MapPin size={14} aria-hidden="true" />
                        {activeRegionLabel} · 본시험 제출 기준
                    </div>
                    {canonicalSnapshot?.status === "ready" && canonicalSnapshot.csvQuestionCohorts.length > 0 && (
                        <button type="button" className="btn btn-secondary" onClick={handleExportQuestionCohortCSV}>
                            <Download size={14} aria-hidden="true" /> 제출 정의 CSV
                        </button>
                    )}
                </div>

                {requiresCanonicalSnapshot && (!canonicalSnapshot || canonicalSnapshot.status !== "ready") && (
                    <div role="alert" className={styles.scopeNote}>
                        공식 문항 분석 근거를 확인하지 못했습니다. 총점 요약만 표시하며 문항 통계와 CSV는 사용할 수 없습니다.
                    </div>
                )}
                {canonicalSnapshot?.status === "ready" && !canonicalSnapshot.advancedAggregatesComplete && (
                    <div role="status" className={styles.scopeNote}>
                        최대 제출 규모 안전 경계로 기본 문항 통계만 표시합니다. 반·학생별 고급 추천 분석은 사용할 수 없습니다.
                    </div>
                )}
                {canonicalSnapshot?.status === "ready"
                    && canonicalSnapshot.questionStats.length > 0
                    && canonicalSnapshot.retakeEligibleCohortKeys.length === 0 && (
                    <div role="status" className={styles.scopeNote}>
                        제출 당시 문항 정의가 현재 시험과 달라 공식 재시험 링크를 만들 수 없습니다.
                    </div>
                )}

                <div className={styles.controlRow}>
                    <div className={styles.field} ref={dropdownRef}>
                        <label className={styles.fieldLabel} htmlFor="exam-analytics-search">시험</label>
                        <div className={styles.combobox}>
                            <Search size={17} aria-hidden="true" />
                            <input
                                id="exam-analytics-search"
                                type="text"
                                role="combobox"
                                aria-autocomplete="list"
                                aria-expanded={isSelectOpen}
                                aria-controls="exam-analytics-options"
                                aria-activedescendant={isSelectOpen && activeOptionIndex >= 0 && filteredExams[activeOptionIndex]
                                    ? `exam-analytics-option-${activeOptionIndex}`
                                    : undefined}
                                value={inputValue}
                                onChange={(event) => {
                                    const nextInputValue = event.target.value;
                                    const hasMatchingExam = exams.some(exam => (
                                        exam.title.toLowerCase().includes(nextInputValue.toLowerCase())
                                    ));
                                    setInputValue(nextInputValue);
                                    setIsSelectOpen(true);
                                    setActiveOptionIndex(hasMatchingExam ? 0 : -1);
                                }}
                                onFocus={() => {
                                    setIsSelectOpen(true);
                                    setActiveOptionIndex(exams.length > 0 ? 0 : -1);
                                    const currentExam = exams.find(exam => exam.id === selectedExamId);
                                    if (currentExam && inputValue === currentExam.title) setInputValue("");
                                }}
                                onKeyDown={(event) => {
                                    const lastOptionIndex = filteredExams.length - 1;
                                    if (event.key === "ArrowDown" && lastOptionIndex >= 0) {
                                        event.preventDefault();
                                        setIsSelectOpen(true);
                                        moveActiveOptionFromKeyboard(activeOptionIndex < 0
                                            ? 0
                                            : Math.min(activeOptionIndex + 1, lastOptionIndex));
                                        return;
                                    }
                                    if (event.key === "ArrowUp" && lastOptionIndex >= 0) {
                                        event.preventDefault();
                                        setIsSelectOpen(true);
                                        moveActiveOptionFromKeyboard(activeOptionIndex < 0
                                            ? lastOptionIndex
                                            : Math.max(activeOptionIndex - 1, 0));
                                        return;
                                    }
                                    if (event.key === "Home" && lastOptionIndex >= 0) {
                                        event.preventDefault();
                                        setIsSelectOpen(true);
                                        moveActiveOptionFromKeyboard(0);
                                        return;
                                    }
                                    if (event.key === "End" && lastOptionIndex >= 0) {
                                        event.preventDefault();
                                        setIsSelectOpen(true);
                                        moveActiveOptionFromKeyboard(lastOptionIndex);
                                        return;
                                    }
                                    if (event.key === "Escape") {
                                        event.preventDefault();
                                        setIsSelectOpen(false);
                                        setActiveOptionIndex(-1);
                                        const currentExam = exams.find(exam => exam.id === selectedExamId);
                                        if (currentExam) setInputValue(currentExam.title);
                                        return;
                                    }
                                    if (event.key === "Enter" && isSelectOpen && filteredExams[activeOptionIndex]) {
                                        event.preventDefault();
                                        handleSelectExam(filteredExams[activeOptionIndex]);
                                    }
                                }}
                                placeholder="시험을 검색하거나 선택하세요"
                            />
                            <ChevronDown
                                size={17}
                                aria-hidden="true"
                                className={`${styles.comboboxChevron} ${isSelectOpen ? styles.comboboxChevronOpen : ""}`}
                            />
                        </div>

                        {isSelectOpen && (
                            <div id="exam-analytics-options" role="listbox" className={styles.dropdown}>
                                {filteredExams.length > 0 ? filteredExams.map((exam, index) => (
                                    <button
                                        key={exam.id}
                                        id={`exam-analytics-option-${index}`}
                                        type="button"
                                        role="option"
                                        tabIndex={-1}
                                        aria-selected={index === activeOptionIndex}
                                        className={`${styles.dropdownOption} ${index === activeOptionIndex ? styles.dropdownOptionSelected : ""}`}
                                        onMouseEnter={() => setActiveOptionIndex(index)}
                                        onMouseDown={(event) => {
                                            event.preventDefault();
                                            handleSelectExam(exam);
                                        }}
                                        onClick={() => handleSelectExam(exam)}
                                    >
                                        <span>{exam.title}</span>
                                        <small>{exam.questions.length}문항</small>
                                    </button>
                                )) : (
                                    <div className={styles.emptyOption}>검색 결과가 없습니다</div>
                                )}
                            </div>
                        )}
                    </div>

                    <div className={styles.field}>
                        <label className={styles.fieldLabel} htmlFor="exam-analytics-region">지역</label>
                        <select
                            id="exam-analytics-region"
                            aria-label="시험 분석 지역 필터"
                            className={styles.select}
                            value={activeRegionKey}
                            onChange={event => {
                                setSelectedRegionKey(event.target.value);
                                setSelectedClassKey("");
                                setSelectedStudentKey("");
                            }}
                        >
                            <option value={ALL_REGION_KEY}>전체 지역</option>
                            {regionScopeOptions.map(scope => (
                                <option key={scope.regionKey} value={scope.regionKey}>
                                    {scope.regionName} ({scope.attemptCount}건)
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className={styles.examMeta} aria-label="선택 시험 정보">
                        <div className={styles.metaItem}>
                            <CalendarDays size={15} aria-hidden="true" />
                            <span>{formatExamDate(selectedExam?.createdAt)}</span>
                        </div>
                        <div className={styles.metaItem}>
                            <FileQuestion size={15} aria-hidden="true" />
                            <span>문항 {selectedExam?.questions.length || 0}개</span>
                        </div>
                        <div className={styles.metaItem}>
                            <Users size={15} aria-hidden="true" />
                            <span>제출 {examAttempts.length}건</span>
                        </div>
                    </div>
                </div>

                {sampleStatusCopy ? (
                    <p
                        id={EXAM_ANALYTICS_SAMPLE_QUALIFIER_ID}
                        className={styles.reportSampleNote}
                        role="status"
                    >
                        {sampleStatusCopy}
                    </p>
                ) : null}

                {(excludedGradingEvidence.legacy > 0 || excludedGradingEvidence.incomplete > 0) && (
                    <p
                        role="status"
                        style={{
                            margin: 0,
                            padding: '0.65rem 0.8rem',
                            borderRadius: 'var(--radius-md)',
                            border: '1px solid color-mix(in srgb, var(--warning) 45%, var(--border))',
                            background: 'color-mix(in srgb, var(--warning) 10%, var(--surface))',
                            color: 'var(--text-warning)',
                            fontSize: '0.78rem',
                            fontWeight: 800,
                        }}
                    >
                        과거 기록 기반 참고 분석 {excludedGradingEvidence.legacy}건과 근거 불완전 기록 {excludedGradingEvidence.incomplete}건은 공식 문항·유형 집계에서 제외했습니다.
                    </p>
                )}

                <div className={styles.tabs} role="tablist" aria-label="시험 통계 보기 전환">
                    {[
                        { key: "overview" as const, label: "요약", icon: BarChart2 },
                        { key: "questions" as const, label: "문항 분석", icon: List },
                        { key: "students" as const, label: "학생·반", icon: Users },
                        { key: "operations" as const, label: "운영", icon: Settings2 },
                    ].map(item => {
                        const Icon = item.icon;
                        const selected = activeWorkspaceView === item.key;
                        return (
                            <button
                                key={item.key}
                                type="button"
                                role="tab"
                                aria-selected={selected}
                                aria-controls={`exam-analytics-panel-${item.key}`}
                                className={`${styles.tab} ${selected ? styles.tabSelected : ""}`}
                                onClick={() => setActiveWorkspaceView(item.key)}
                            >
                                <Icon size={16} aria-hidden="true" />
                                {item.label}
                            </button>
                        );
                    })}
                </div>
            </section>

            {activeWorkspaceView === "operations" && (
            <div
                id="exam-analytics-panel-operations"
                role="tabpanel"
                aria-label="시험 운영"
                className={styles.legacyStack}
            >
            {activeWorkspaceView === "operations" && selectedExam && visibleRegionalActionPlans.length > 0 && (
                <div className="card" style={{ ...CARD_SURFACE_STYLE,padding: '1.35rem', border: '1px solid var(--border)', background: 'var(--surface)' }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
                        <div>
                            <h3 style={{ fontSize: 'var(--type-heading-sm)', fontWeight: 900, color: 'var(--foreground)', display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                                <Target size={16} color="var(--primary)" />
                                지역별 다음 액션
                            </h3>
                            <p style={{ fontSize: '0.8rem', color: 'var(--muted)', marginTop: '0.2rem', lineHeight: 1.5 }}>
                                {selectedExam.title} 기준으로 오답 유형, 주의 학생, 재시험 후보를 묶었습니다.
                            </p>
                        </div>
                        <span style={{
                            fontSize: '0.72rem',
                            fontWeight: 900,
                            color: 'var(--primary)',
                            background: 'rgba(99,102,241,0.1)',
                            border: '1px solid rgba(99,102,241,0.18)',
                            padding: '0.24rem 0.6rem',
                            borderRadius: 'var(--radius-full)',
                            whiteSpace: 'nowrap',
                        }}>
                            지역 운영
                        </span>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(260px, 100%), 1fr))', gap: '0.8rem' }}>
                        {visibleRegionalActionPlans.map(plan => {
                            const recommendation = plan.recommendations[0];
                            const href = recommendation && buildAnalyticsRetakeHref(
                                recommendation.sourceAttemptId,
                                recommendation.retakeQuestionIds,
                                recommendation.retakeMode,
                                { labels: recommendation.retakeLabels, concepts: recommendation.retakeConcepts }
                            );

                            return (
                                <div
                                    key={plan.regionKey}
                                    style={{
                                        border: '1px solid var(--border)',
                                        borderRadius: 'var(--radius-md)',
                                        background: 'var(--background)',
                                        padding: '0.95rem',
                                        minWidth: 0,
                                    }}
                                >
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.7rem', marginBottom: '0.65rem' }}>
                                        <div style={{ minWidth: 0 }}>
                                            <div style={{ fontSize: '0.95rem', fontWeight: 900, color: 'var(--foreground)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                {plan.regionName}
                                            </div>
                                            <div style={{ fontSize: '0.72rem', color: 'var(--muted)', fontWeight: 800 }}>
                                                제출 {plan.attemptCount}건 · 평균 {plan.averageScore === null ? "미채점" : `${plan.averageScore}점`} · 오답 {plan.wrongQuestionCount}문항
                                            </div>
                                        </div>
                                        <span style={{
                                            color: severityColor(plan.severity),
                                            border: `1px solid ${severityColor(plan.severity)}`,
                                            background: 'var(--surface)',
                                            borderRadius: '999px',
                                            padding: '0.16rem 0.5rem',
                                            fontSize: '0.7rem',
                                            fontWeight: 900,
                                            whiteSpace: 'nowrap',
                                        }}>
                                            {severityLabel(plan.severity)}
                                        </span>
                                    </div>

                                    <div style={{ fontSize: '0.82rem', color: 'var(--foreground)', fontWeight: 850, lineHeight: 1.45, marginBottom: '0.65rem', wordBreak: 'keep-all' }}>
                                        {plan.recommendedAction}
                                    </div>

                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap' }}>
                                        <div style={{ fontSize: '0.74rem', color: 'var(--muted)', fontWeight: 800 }}>
                                            {plan.averageScore === null ? "주의 학생 근거 없음" : `주의 학생 ${plan.studentsNeedingAttention.length}명`}
                                            {recommendation ? ` · ${recommendation.wrongRate}% 취약` : ""}
                                        </div>
                                        {href && (
                                            <PremiumActionLink
                                                enabled={retakeAssignmentsEnabled}
                                                href={href}
                                                className="btn btn-secondary"
                                                lockedTitle="Pro 이상에서 지역별 추천 재시험을 만들 수 있습니다."
                                                style={{ padding: '0.48rem 0.72rem', fontSize: '0.76rem', borderRadius: 'var(--radius-md)' }}
                                            >
                                                재시험 만들기
                                            </PremiumActionLink>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {activeWorkspaceView === "operations" && selectedExam && kakaoCandidateSummary && kakaoCandidateSummary.totalCount > 0 && (
                <div className="card" style={{ ...CARD_SURFACE_STYLE,padding: '1.35rem', border: '1px solid var(--border)', background: 'var(--surface)' }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
                        <div>
                            <h3 style={{ fontSize: 'var(--type-heading-sm)', fontWeight: 900, color: 'var(--foreground)', display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                                <MessageCircle size={16} color="#f59e0b" />
                                카카오 후보 검토
                            </h3>
                            <p style={{ fontSize: '0.8rem', color: 'var(--muted)', marginTop: '0.2rem', lineHeight: 1.5 }}>
                                발송 전 후보만 정리합니다. 미응시, 반별 재시험, 시험 전체 재시험 후보를 확인한 뒤 실제 카카오 연동 단계로 넘깁니다.
                            </p>
                        </div>
                        <span style={{
                            fontSize: '0.72rem',
                            fontWeight: 900,
                            color: 'var(--warning)',
                            background: 'color-mix(in srgb, var(--warning) 12%, var(--surface))',
                            border: '1px solid color-mix(in srgb, var(--warning) 32%, transparent)',
                            padding: '0.24rem 0.6rem',
                            borderRadius: 'var(--radius-full)',
                            whiteSpace: 'nowrap',
                        }}>
                            발송 전 · 대상 {kakaoCandidateSummary.targetStudentCount}명
                        </span>
                    </div>

                    <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '0.75rem',
                        flexWrap: 'wrap',
                        padding: '0.78rem 0.9rem',
                        borderRadius: 'var(--radius-md)',
                        border: '1px solid var(--border)',
                        background: 'var(--background)',
                        marginBottom: '1rem',
                    }}>
                        <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: '0.78rem', color: 'var(--foreground)', fontWeight: 900, marginBottom: '0.15rem' }}>
                                카카오 provider 상태
                            </div>
                            <div style={{ fontSize: '0.73rem', color: 'var(--muted)', fontWeight: 750, lineHeight: 1.45, wordBreak: 'keep-all' }}>
                                {kakaoProviderReadiness.detail}
                                {kakaoProviderReadiness.channelId ? ` · 채널 ${kakaoProviderReadiness.channelId}` : ""}
                                {kakaoProviderReadiness.missing.length > 0 ? ` · 누락 ${kakaoProviderReadiness.missing.join(", ")}` : ""}
                            </div>
                        </div>
                        <span style={{
                            color: kakaoProviderStatusColor(kakaoProviderReadiness.status),
                            border: `1px solid ${kakaoProviderStatusColor(kakaoProviderReadiness.status)}`,
                            background: 'var(--surface)',
                            borderRadius: '999px',
                            padding: '0.18rem 0.56rem',
                            fontSize: '0.7rem',
                            fontWeight: 950,
                            whiteSpace: 'nowrap',
                        }}>
                            {kakaoProviderReadiness.label}
                        </span>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))', gap: '0.75rem', marginBottom: '1rem' }}>
                        {[
                            { label: "미응시", value: kakaoCandidateSummary.missingExamCount, color: 'var(--warning)' },
                            { label: "반별 재시험", value: kakaoCandidateSummary.classRetakeRecommendationCount, color: 'var(--primary)' },
                            { label: "재시험", value: kakaoCandidateSummary.retakeRecommendationCount, color: '#0f766e' },
                        ].map(item => (
                            <div key={item.label} style={{ padding: '0.85rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', background: 'var(--background)' }}>
                                <div style={{ fontSize: '0.72rem', color: 'var(--muted)', fontWeight: 850, marginBottom: '0.25rem' }}>{item.label}</div>
                                <div style={{ fontSize: '1.25rem', fontWeight: 950, color: item.color }}>{item.value}건</div>
                            </div>
                        ))}
                    </div>

                    {kakaoReviewSummary && (
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(160px, 100%), 1fr))', gap: '0.55rem', marginBottom: '1rem' }}>
                            {[
                                { label: "검토 대기", value: kakaoReviewSummary.unreviewed, status: "unreviewed" as const },
                                { label: "후보 준비", value: kakaoReviewSummary.ready, status: "ready" as const },
                                { label: "보류", value: kakaoReviewSummary.hold, status: "hold" as const },
                                { label: "제외", value: kakaoReviewSummary.excluded, status: "excluded" as const },
                            ].map(item => (
                                <div key={item.label} style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'space-between',
                                    gap: '0.55rem',
                                    padding: '0.58rem 0.7rem',
                                    borderRadius: 'var(--radius-md)',
                                    border: '1px solid var(--border)',
                                    background: 'var(--background)',
                                }}>
                                    <span style={{ fontSize: '0.72rem', color: 'var(--muted)', fontWeight: 850 }}>{item.label}</span>
                                    <span style={{ fontSize: '0.84rem', color: kakaoReviewStatusColor(item.status), fontWeight: 950 }}>{item.value}건</span>
                                </div>
                            ))}
                        </div>
                    )}

                    {kakaoDispatchSummary && (
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(180px, 100%), 1fr))', gap: '0.55rem', marginBottom: '1rem' }}>
                            {[
                                { label: "큐 대기 기록", value: kakaoDispatchSummary.queued, color: 'var(--primary)' },
                                { label: "시뮬레이션 완료 기록", value: kakaoDispatchSummary.sent, color: 'var(--success)' },
                                { label: "시뮬레이션 실패 기록", value: kakaoDispatchSummary.failed, color: 'var(--error)' },
                                { label: "시뮬레이션 취소 기록", value: kakaoDispatchSummary.cancelled, color: 'var(--warning)' },
                            ].map(item => (
                                <div key={item.label} style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'space-between',
                                    gap: '0.55rem',
                                    padding: '0.58rem 0.7rem',
                                    borderRadius: 'var(--radius-md)',
                                    border: '1px solid var(--border)',
                                    background: 'var(--surface)',
                                }}>
                                    <span style={{ fontSize: '0.72rem', color: 'var(--muted)', fontWeight: 850 }}>{item.label}</span>
                                    <span style={{ fontSize: '0.84rem', color: item.color, fontWeight: 950 }}>{item.value}건</span>
                                </div>
                            ))}
                        </div>
                    )}

                    <div style={{ display: 'grid', gap: '0.65rem' }}>
                        {kakaoCandidateSummary.candidates.map(candidate => {
                            const kindColor = kakaoCandidateKindColor(candidate.kind);
                            const reviewStatus = kakaoReviews[candidate.id]?.status || "unreviewed";
                            const reviewColor = kakaoReviewStatusColor(reviewStatus);
                            const latestDispatch = kakaoDispatchSummary?.latestByReviewId[candidate.id];
                            const dispatchColor = kakaoDispatchStatusColor(latestDispatch?.status);
                            const canQueueDispatch = remindersEnabled
                                && kakaoProviderReadiness.canQueueDispatch
                                && reviewStatus === "ready"
                                && latestDispatch?.status !== "queued";
                            const canResolveDispatch = remindersEnabled
                                && kakaoProviderReadiness.canMarkOutcomes
                                && latestDispatch?.status === "queued";
                            const studentPreview = candidate.studentNames.length > 0
                                ? candidate.studentNames.slice(0, 4).join(", ")
                                : candidate.studentIds.slice(0, 4).join(", ");
                            const messagePreview = buildKakaoCandidateMessagePreview(candidate);

                            return (
                                <div
                                    key={candidate.id}
                                    data-testid={`kakao-candidate-${candidate.id}`}
                                    style={{
                                        display: 'grid',
                                        gridTemplateColumns: 'repeat(auto-fit, minmax(min(260px, 100%), 1fr))',
                                        gap: '0.85rem',
                                        alignItems: 'center',
                                        padding: '0.9rem',
                                        borderRadius: 'var(--radius-md)',
                                        border: '1px solid var(--border)',
                                        background: 'var(--background)',
                                    }}
                                >
                                    <div style={{ minWidth: 0 }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', flexWrap: 'wrap', marginBottom: '0.3rem' }}>
                                            <span style={{
                                                color: kindColor,
                                                border: `1px solid ${kindColor}`,
                                                borderRadius: '999px',
                                                padding: '0.14rem 0.48rem',
                                                fontSize: '0.68rem',
                                                fontWeight: 950,
                                                whiteSpace: 'nowrap',
                                            }}>
                                                {kakaoCandidateKindLabel(candidate.kind)}
                                            </span>
                                            <strong style={{ color: 'var(--foreground)', fontSize: '0.88rem', lineHeight: 1.35 }}>
                                                {candidate.title}
                                            </strong>
                                            <span style={{ color: 'var(--muted)', fontSize: '0.72rem', fontWeight: 850 }}>
                                                대상 {candidate.targetCount}명
                                            </span>
                                            <span style={{
                                                color: reviewColor,
                                                border: `1px solid ${reviewColor}`,
                                                borderRadius: '999px',
                                                padding: '0.14rem 0.48rem',
                                                fontSize: '0.68rem',
                                                fontWeight: 950,
                                                whiteSpace: 'nowrap',
                                            }}>
                                                {kakaoReviewStatusLabel(reviewStatus)}
                                            </span>
                                            <span style={{
                                                color: dispatchColor,
                                                border: `1px solid ${dispatchColor}`,
                                                borderRadius: '999px',
                                                padding: '0.14rem 0.48rem',
                                                fontSize: '0.68rem',
                                                fontWeight: 950,
                                                whiteSpace: 'nowrap',
                                            }}>
                                                {kakaoDispatchStatusLabel(latestDispatch?.status)}
                                            </span>
                                        </div>
                                        <div style={{ color: 'var(--muted)', fontSize: '0.78rem', lineHeight: 1.45, fontWeight: 750, wordBreak: 'keep-all' }}>
                                            {candidate.message}
                                        </div>
                                        <div style={{
                                            color: 'var(--foreground)',
                                            fontSize: '0.75rem',
                                            lineHeight: 1.45,
                                            marginTop: '0.34rem',
                                            padding: '0.58rem 0.68rem',
                                            borderRadius: 'var(--radius-md)',
                                            border: '1px dashed var(--border)',
                                            background: 'var(--surface)',
                                            wordBreak: 'keep-all',
                                        }}>
                                            {messagePreview}
                                        </div>
                                        <div style={{ color: 'var(--foreground)', fontSize: '0.74rem', lineHeight: 1.45, marginTop: '0.3rem', wordBreak: 'keep-all' }}>
                                            {studentPreview ? `학생 ${studentPreview}${candidate.targetCount > 4 ? ` 외 ${candidate.targetCount - 4}명` : ""}` : "학생 명단 연결 대기"}
                                            {candidate.groupNames.length > 0 ? ` · 반 ${candidate.groupNames.slice(0, 3).join(", ")}` : ""}
                                            {candidate.regionNames.length > 0 ? ` · 지역 ${candidate.regionNames.slice(0, 2).join(", ")}` : ""}
                                        </div>
                                        <div style={{ color: 'var(--primary)', fontSize: '0.72rem', lineHeight: 1.4, marginTop: '0.22rem', fontWeight: 800 }}>
                                            {candidate.reason}
                                        </div>
                                    </div>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.45rem', alignItems: 'stretch', justifySelf: 'end', minWidth: 'min(210px, 100%)' }}>
                                        <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                                            {KAKAO_REVIEW_STATUS_OPTIONS.map(option => {
                                                const selected = reviewStatus === option.status;
                                                return (
                                                    <button
                                                        key={option.status}
                                                        type="button"
                                                        data-testid={`kakao-review-${candidate.id}-${option.status}`}
                                                        className="btn btn-secondary"
                                                        disabled={!remindersEnabled}
                                                        onClick={() => updateKakaoReviewStatus(candidate, option.status)}
                                                        style={{
                                                            fontSize: '0.7rem',
                                                            padding: '0.34rem 0.54rem',
                                                            borderRadius: 'var(--radius-md)',
                                                            borderColor: selected ? kakaoReviewStatusColor(option.status) : 'var(--border)',
                                                            color: selected ? kakaoReviewStatusColor(option.status) : 'var(--foreground)',
                                                            background: selected ? 'var(--surface)' : 'var(--background)',
                                                            opacity: remindersEnabled ? 1 : 0.55,
                                                        }}
                                                    >
                                                        {option.label}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                        <PremiumActionLink
                                            enabled={remindersEnabled}
                                            href={candidate.href}
                                            className="btn btn-secondary"
                                            lockedTitle="Pro 이상에서 카카오 후보를 검토하고 큐 대기 기록을 관리할 수 있습니다. 실제 메시지는 발송하지 않습니다."
                                            style={{ fontSize: '0.74rem', padding: '0.38rem 0.68rem', whiteSpace: 'nowrap', justifySelf: 'end', textAlign: 'center' }}
                                        >
                                            후보 검토
                                        </PremiumActionLink>
                                        <button
                                            type="button"
                                            data-testid={`kakao-dispatch-queue-${candidate.id}`}
                                            className="btn btn-secondary"
                                            disabled={!canQueueDispatch}
                                            onClick={() => queueKakaoDispatch(candidate)}
                                            title={!kakaoProviderReadiness.canQueueDispatch ? kakaoProviderReadiness.detail : reviewStatus === "ready" ? "실제 발송 없이 큐 대기 로그를 남깁니다." : "후보 준비 상태에서 큐 대기 기록을 남길 수 있습니다."}
                                            style={{
                                                fontSize: '0.74rem',
                                                padding: '0.38rem 0.68rem',
                                                borderRadius: 'var(--radius-md)',
                                                opacity: canQueueDispatch ? 1 : 0.55,
                                                whiteSpace: 'nowrap',
                                            }}
                                        >
                                            큐 대기 기록
                                        </button>
                                        {latestDispatch && (
                                            <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                                                {[
                                                    { status: "sent" as const, label: "완료" },
                                                    { status: "failed" as const, label: "실패" },
                                                    { status: "cancelled" as const, label: "취소" },
                                                ].map(option => (
                                                    <button
                                                        key={option.status}
                                                        type="button"
                                                        data-testid={`kakao-dispatch-${candidate.id}-${option.status}`}
                                                        className="btn btn-secondary"
                                                        disabled={!canResolveDispatch}
                                                        onClick={() => updateKakaoDispatchStatus(candidate, latestDispatch, option.status)}
                                                        style={{
                                                            fontSize: '0.7rem',
                                                            padding: '0.34rem 0.54rem',
                                                            borderRadius: 'var(--radius-md)',
                                                            opacity: canResolveDispatch ? 1 : 0.55,
                                                            color: latestDispatch.status === option.status ? kakaoDispatchStatusColor(option.status) : 'var(--foreground)',
                                                            borderColor: latestDispatch.status === option.status ? kakaoDispatchStatusColor(option.status) : 'var(--border)',
                                                            background: latestDispatch.status === option.status ? 'var(--surface)' : 'var(--background)',
                                                        }}
                                                    >
                                                        {option.label}
                                                    </button>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            {activeWorkspaceView === "operations" && selectedExam && questionBankReadiness && (
                <div className="card" style={{ ...CARD_SURFACE_STYLE,padding: '1.5rem', border: '1px solid var(--border)', background: 'var(--surface)' }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
                        <div>
                            <h3 style={{ fontSize: 'var(--type-heading-sm)', fontWeight: 900, color: 'var(--foreground)', display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                                <Database size={16} color="var(--primary)" />
                                문항 DB 준비 상태
                            </h3>
                            <p style={{ fontSize: '0.8rem', color: 'var(--muted)', marginTop: '0.2rem', lineHeight: 1.5 }}>
                                문항 이미지는 별도 저장하지 않아도 canonical ID, 유형 태그, PDF 영역으로 오답/유형 분석을 추적합니다.
                            </p>
                        </div>
                        <span style={{
                            fontSize: '0.72rem',
                            fontWeight: 900,
                            color: 'var(--primary)',
                            background: 'rgba(99,102,241,0.1)',
                            border: '1px solid rgba(99,102,241,0.18)',
                            padding: '0.24rem 0.6rem',
                            borderRadius: 'var(--radius-full)',
                            whiteSpace: 'nowrap',
                        }}>
                            Canonical question rows
                        </span>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(150px, 100%), 1fr))', gap: '0.75rem', marginBottom: '1rem' }}>
                        {[
                            { label: "분석 가능", value: `${questionBankReadiness.analysisReadyRate}%`, detail: `${questionBankReadiness.analysisReadyCount}/${questionBankReadiness.totalQuestions}문항`, color: 'var(--primary)' },
                            { label: "유형 태그", value: `${questionBankReadiness.metadataReadyRate}%`, detail: `${questionBankReadiness.metadataReadyCount}/${questionBankReadiness.totalQuestions}문항`, color: 'var(--success)' },
                            { label: "영역 커팅", value: `${questionBankReadiness.cropReadyRate}%`, detail: `${questionBankReadiness.cropReadyCount}/${questionBankReadiness.totalQuestions}문항`, color: 'var(--warning)' },
                            { label: "결과 연결", value: `${questionBankReadiness.resultBackedCount}문항`, detail: `제출 결과 기반`, color: '#0f766e' },
                        ].map(item => (
                            <div key={item.label} style={{ padding: '0.9rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', background: 'var(--background)' }}>
                                <div style={{ fontSize: '0.74rem', color: 'var(--muted)', fontWeight: 800, marginBottom: '0.3rem' }}>{item.label}</div>
                                <div style={{ fontSize: '1.35rem', fontWeight: 900, color: item.color }}>{item.value}</div>
                                <div style={{ fontSize: '0.72rem', color: 'var(--muted)', marginTop: '0.2rem' }}>{item.detail}</div>
                            </div>
                        ))}
                    </div>

                    {questionBankReadiness.imageAssetRequiredCount > 0 && (
                        <div style={{
                            padding: '0.8rem 0.9rem',
                            borderRadius: 'var(--radius-md)',
                            border: '1px solid rgba(245,158,11,0.25)',
                            background: 'rgba(245,158,11,0.08)',
                            color: 'var(--warning)',
                            fontSize: '0.8rem',
                            fontWeight: 800,
                            marginBottom: '1rem',
                            lineHeight: 1.45,
                        }}>
                            프리미어 문항 이미지 DB로 확장하려면 {questionBankReadiness.imageAssetRequiredCount}문항에 PDF 영역 커팅이 더 필요합니다.
                        </div>
                    )}

                    <p id="exam-question-db-scroll-hint" className={styles.scrollHint}>
                        표가 화면보다 넓으면 좌우로 스크롤해 확인하세요.
                    </p>
                    <div
                        role="region"
                        tabIndex={0}
                        aria-label="문항 DB 준비 상태 표"
                        aria-describedby="exam-question-db-scroll-hint"
                        className={styles.horizontalTableRegion}
                        style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}
                    >
                        <table style={{ width: '100%', minWidth: '720px', borderCollapse: 'collapse', textAlign: 'left' }}>
                            <thead style={{ background: 'var(--background)', color: 'var(--muted)', fontSize: '0.78rem' }}>
                                <tr>
                                    <th style={{ padding: '0.7rem 0.85rem' }}>문항</th>
                                    <th style={{ padding: '0.7rem 0.85rem' }}>Canonical ID</th>
                                    <th style={{ padding: '0.7rem 0.85rem' }}>유형</th>
                                    <th style={{ padding: '0.7rem 0.85rem' }}>상태</th>
                                    <th style={{ padding: '0.7rem 0.85rem' }}>다음 작업</th>
                                </tr>
                            </thead>
                            <tbody>
                                {questionBankReadiness.weakestRecords.map(record => (
                                    <tr key={record.canonicalQuestionId} style={{ borderTop: '1px solid var(--border)' }}>
                                        <td style={{ padding: '0.78rem 0.85rem', fontWeight: 900, color: 'var(--foreground)' }}>
                                            {record.questionNumber}번
                                        </td>
                                        <td style={{ padding: '0.78rem 0.85rem', color: 'var(--muted)', fontFamily: 'var(--font-mono)', fontSize: '0.76rem' }}>
                                            {record.canonicalQuestionId}
                                        </td>
                                        <td style={{ padding: '0.78rem 0.85rem', color: 'var(--muted)', fontWeight: 800 }}>
                                            {record.concept}
                                        </td>
                                        <td style={{ padding: '0.78rem 0.85rem' }}>
                                            <span style={{
                                                color: questionBankStatusColor(record.readinessStatus),
                                                background: 'var(--background)',
                                                border: `1px solid ${questionBankStatusColor(record.readinessStatus)}`,
                                                borderRadius: '999px',
                                                padding: '0.18rem 0.52rem',
                                                fontSize: '0.72rem',
                                                fontWeight: 900,
                                                whiteSpace: 'nowrap',
                                            }}>
                                                {questionBankStatusLabel(record.readinessStatus)}
                                            </span>
                                        </td>
                                        <td style={{ padding: '0.78rem 0.85rem', color: 'var(--muted)', fontSize: '0.8rem', fontWeight: 800 }}>
                                            {record.missingActions.slice(0, 3).join(" · ") || "준비 완료"}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}

            {activeWorkspaceView === "operations" && selectedExam && !advancedAnalyticsEnabled && (
                <PremiumFeatureCard
                    title="고급 분석 잠금"
                    description="Free에서는 기본 통계와 정오표를 확인합니다. Pro 이상에서 분석 컷 전환, 반별 매트릭스, 유형 재추천 큐, 풀이 행동 신호를 사용할 수 있습니다."
                    badge="Pro"
                />
            )}
            </div>
            )}

            {examStats ? (
                <>
                    {activeWorkspaceView === "overview" && (
                        <div
                            id="exam-analytics-panel-overview"
                            role="tabpanel"
                            aria-label="시험 통계 요약"
                            className={styles.reportOverviewPanel}
                        >
                            <ExamAnalyticsReportOverview
                                metrics={overviewMetrics}
                                headline={overviewHeadline}
                                distribution={examStats.distributionBuckets}
                                weakQuestions={overviewWeakQuestions}
                                achievementBands={studentAchievementBands.map(band => ({
                                    key: band.key,
                                    label: band.label,
                                    count: band.count,
                                    percent: band.rate,
                                    tone: band.tone,
                                }))}
                                actions={overviewActions}
                                hasPerformanceEvidence={examStats.performanceCount > 0}
                                sampleStatusDescriptionId={sampleStatusCopy
                                    ? EXAM_ANALYTICS_SAMPLE_QUALIFIER_ID
                                    : undefined}
                            />
                        </div>
                    )}

                    {activeWorkspaceView === "students" && advancedAnalyticsEnabled && (
                    <div className="card" style={{ ...CARD_SURFACE_STYLE,padding: '1.5rem', border: '1px solid var(--border)', background: 'var(--surface)' }}>
                        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
                            <div>
                                <h3 style={{ fontSize: 'var(--type-heading-sm)', fontWeight: 900, color: 'var(--foreground)', display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                                    <Target size={16} color="var(--primary)" />
                                    분석 컷 전환
                                </h3>
                                <p style={{ fontSize: '0.8rem', color: 'var(--muted)', marginTop: '0.2rem' }}>
                                    같은 시험 데이터를 시험 전체, 반, 학생 기준으로 잘라 약점 유형을 다시 계산합니다.
                                </p>
                            </div>
                            <StatusPill tone="primary" size="sm" label={scopedSummary} />
                        </div>

                        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
                            {[
                                { key: "exam" as const, label: "시험 전체" },
                                { key: "class" as const, label: "반별" },
                                { key: "student" as const, label: "학생별" },
                            ].map(scope => (
                                <button
                                    key={scope.key}
                                    type="button"
                                    onClick={() => setAnalysisScope(scope.key)}
                                    style={{
                                        padding: '0.55rem 0.9rem',
                                        borderRadius: 'var(--radius-full)',
                                        border: `1px solid ${analysisScope === scope.key ? 'var(--primary)' : 'var(--border)'}`,
                                        background: analysisScope === scope.key ? 'var(--primary)' : 'var(--background)',
                                        color: analysisScope === scope.key ? 'white' : 'var(--muted)',
                                        fontWeight: 900,
                                        fontSize: '0.82rem',
                                        cursor: 'pointer',
                                    }}
                                >
                                    {scope.label}
                                </button>
                            ))}

                            {analysisScope === "class" && (
                                <select
                                    value={activeClassKey}
                                    onChange={(event) => setSelectedClassKey(event.target.value)}
                                    disabled={classScopeOptions.length === 0}
                                    style={{
                                        minWidth: '180px',
                                        padding: '0.55rem 0.8rem',
                                        borderRadius: 'var(--radius-md)',
                                        border: '1px solid var(--border)',
                                        background: 'var(--background)',
                                        color: 'var(--foreground)',
                                        fontWeight: 800,
                                    }}
                                >
                                {classScopeOptions.length > 0 ? (
                                    classScopeOptions.map(group => (
                                        <option key={group.key} value={group.key}>
                                            {group.label} ({group.attemptCount}건 · 참여 {formatParticipationRateLabel(group.participationRate)})
                                        </option>
                                    ))
                                ) : (
                                        <option value="">반 정보 없음</option>
                                    )}
                                </select>
                            )}

                            {analysisScope === "student" && (
                                <select
                                    value={activeStudentKey}
                                    onChange={(event) => setSelectedStudentKey(event.target.value)}
                                    disabled={studentScopeOptions.length === 0}
                                    style={{
                                        minWidth: '220px',
                                        padding: '0.55rem 0.8rem',
                                        borderRadius: 'var(--radius-md)',
                                        border: '1px solid var(--border)',
                                        background: 'var(--background)',
                                        color: 'var(--foreground)',
                                        fontWeight: 800,
                                    }}
                                >
                                    {studentScopeOptions.length > 0 ? (
                                        studentScopeOptions.map(student => (
                                            <option key={student.key} value={student.key}>
                                                {student.label} ({student.hasPerformanceScore ? `${student.scorePercentage}%` : "미채점"})
                                            </option>
                                        ))
                                    ) : (
                                        <option value="">학생 정보 없음</option>
                                    )}
                                </select>
                            )}
                        </div>

                        {scopedWeaknessGroups.length > 0 ? (
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(280px, 100%), 1fr))', gap: '0.75rem' }}>
                                {scopedWeaknessGroups.map(group => {
                                    const retakeIds = group.retakeQuestionIds;

                                    return (
                                        <div key={`${analysisScope}:${group.key}`} style={{
                                            display: 'grid',
                                            gap: '0.55rem',
                                            padding: '0.9rem',
                                            borderRadius: 'var(--radius-md)',
                                            border: '1px solid var(--border)',
                                            background: 'var(--background)',
                                        }}>
                                            <div>
                                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem' }}>
                                                    <div style={{ fontWeight: 900, color: 'var(--foreground)', lineHeight: 1.3 }}>
                                                        {group.title}
                                                    </div>
                                                    <span style={{
                                                        color: group.wrongRate >= 60 ? 'var(--error)' : 'var(--warning)',
                                                        fontWeight: 900,
                                                        fontSize: '0.82rem',
                                                    }}>
                                                        {group.wrongRate}%
                                                    </span>
                                                </div>
                                                <div style={{ color: 'var(--muted)', fontSize: '0.76rem', marginTop: '0.25rem', lineHeight: 1.45 }}>
                                                    {group.basis} · {group.questionNumbers.join(', ')}번 · 오답/미답 {group.wrongCount}/{group.totalCount}
                                                </div>
                                                <div style={{ color: 'var(--primary)', fontSize: '0.72rem', marginTop: '0.18rem', fontWeight: 800, lineHeight: 1.4 }}>
                                                    {group.reason}
                                                </div>
                                            </div>
                                            <PremiumActionLink
                                                enabled={retakeAssignmentsEnabled}
                                                href={buildAnalyticsRetakeHref(group.sourceAttemptId, retakeIds, group.retakeMode, {
                                                    labels: group.retakeLabels,
                                                    concepts: group.retakeConcepts,
                                                }) || "#"}
                                                unavailableReason={!buildAnalyticsRetakeHref(group.sourceAttemptId, retakeIds, group.retakeMode) ? "제출 정의 변경 · 재시험 불가" : undefined}
                                                className="btn btn-secondary"
                                                style={{ fontSize: '0.76rem', padding: '0.38rem 0.7rem', justifySelf: 'start' }}
                                                lockedTitle="Pro 이상에서 분석 컷 기준 재시험을 만들 수 있습니다."
                                            >
                                                이 컷으로 재시험
                                            </PremiumActionLink>
                                        </div>
                                    );
                                })}
                            </div>
                        ) : (
                            <div style={{
                                color: 'var(--muted)',
                                fontSize: '0.85rem',
                                padding: '1rem',
                                border: '1px dashed var(--border)',
                                borderRadius: 'var(--radius-md)',
                                background: 'var(--background)',
                            }}>
                                {scopedEmptyMessage}
                            </div>
                        )}
                    </div>
                    )}

                    {activeWorkspaceView === "students" && advancedAnalyticsEnabled && (
                        <div className="card" style={{ ...CARD_SURFACE_STYLE,padding: '1.5rem', border: '1px solid var(--border)', background: 'var(--surface)' }}>
                            <div style={{ marginBottom: '1.25rem' }}>
                                <h3 style={{ fontSize: 'var(--type-heading-sm)', fontWeight: 900, color: 'var(--foreground)', display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                                    <BarChart2 size={16} color="var(--primary)" />
                                    반별 점수 비교
                                </h3>
                                <p style={{ fontSize: '0.8rem', color: 'var(--muted)', marginTop: '0.2rem' }}>
                                    반별 점수의 최저~최고 범위와 중앙값, 평균을 한눈에 비교합니다.
                                </p>
                            </div>

                            {groupScoreSummaries.length > 0 ? (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '1.1rem' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', fontSize: '0.72rem', color: 'var(--muted)', fontWeight: 700 }}>
                                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
                                            <span style={{ width: '14px', height: '8px', borderRadius: '4px', background: 'var(--primary)', opacity: 0.35, display: 'inline-block' }} />
                                            최저~최고
                                        </span>
                                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
                                            <span style={{ width: '2px', height: '12px', background: 'var(--foreground)', display: 'inline-block' }} />
                                            중앙값
                                        </span>
                                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
                                            <span style={{ width: '9px', height: '9px', borderRadius: '50%', background: 'var(--warning)', display: 'inline-block' }} />
                                            평균
                                        </span>
                                    </div>
                                    {groupScoreSummaries.map(group => (
                                        <div key={group.groupKey}>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.4rem', gap: '0.5rem', flexWrap: 'wrap' }}>
                                                <span style={{ fontWeight: 800, color: 'var(--foreground)', fontSize: '0.88rem' }}>{group.groupName}</span>
                                                <span style={{ fontSize: '0.74rem', color: 'var(--muted)', fontWeight: 700 }}>
                                                    최저 {group.min}% · 중앙값 {group.median}% · 평균 {group.average}% · 최고 {group.max}% · {group.count}명
                                                </span>
                                            </div>
                                            <div style={{ position: 'relative', height: '10px', background: 'var(--border)', borderRadius: 'var(--radius-full)', width: '100%' }}>
                                                <div style={{
                                                    position: 'absolute',
                                                    left: `${group.min}%`,
                                                    width: `${Math.max(0, group.max - group.min)}%`,
                                                    height: '100%',
                                                    background: 'var(--primary)',
                                                    opacity: 0.35,
                                                    borderRadius: 'var(--radius-full)',
                                                }} />
                                                <div style={{
                                                    position: 'absolute',
                                                    left: `${group.median}%`,
                                                    top: '-3px',
                                                    width: '2px',
                                                    height: '16px',
                                                    background: 'var(--foreground)',
                                                }} title={`중앙값 ${group.median}%`} />
                                                <div style={{
                                                    position: 'absolute',
                                                    left: `calc(${Math.max(0, Math.min(100, group.average))}% - 5px)`,
                                                    top: '-2px',
                                                    width: '10px',
                                                    height: '10px',
                                                    borderRadius: '50%',
                                                    background: 'var(--warning)',
                                                    border: '2px solid var(--surface)',
                                                }} title={`평균 ${group.average}%`} />
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            ) : (
                                <div style={{
                                    color: 'var(--muted)',
                                    fontSize: '0.85rem',
                                    padding: '1rem',
                                    border: '1px dashed var(--border)',
                                    borderRadius: 'var(--radius-md)',
                                    background: 'var(--background)',
                                }}>
                                    반 정보가 있는 제출부터 반별 점수 비교가 표시됩니다.
                                </div>
                            )}
                        </div>
                    )}

                    {activeWorkspaceView === "students" && advancedAnalyticsEnabled && classWeaknessMatrixRows.length > 0 && (
                        <div className="card" style={{ ...CARD_SURFACE_STYLE,padding: '1.5rem', border: '1px solid var(--border)', background: 'var(--surface)' }}>
                            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
                                <div>
                                    <h3 style={{ fontSize: 'var(--type-heading-sm)', fontWeight: 900, color: 'var(--foreground)', display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                                        <Users size={16} color="var(--primary)" />
                                        반별 시험 분석 매트릭스
                                    </h3>
                                    <p style={{ fontSize: '0.8rem', color: 'var(--muted)', marginTop: '0.2rem' }}>
                                        같은 시험을 반별로 잘라 평균, 참여율, 오답 압력, 집중 문항, 재추천 대상을 비교합니다.
                                    </p>
                                </div>
                                <StatusPill tone="success" size="sm" label="Class cut" />
                            </div>

                            <p id="exam-class-matrix-scroll-hint" className={styles.scrollHint}>
                                표가 화면보다 넓으면 좌우로 스크롤해 확인하세요.
                            </p>
                            <div
                                role="region"
                                tabIndex={0}
                                aria-label="반별 시험 분석 매트릭스 표"
                                aria-describedby="exam-class-matrix-scroll-hint"
                                className={styles.horizontalTableRegion}
                                style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}
                            >
                                <table style={{ width: '100%', minWidth: '860px', borderCollapse: 'collapse', textAlign: 'left', fontVariantNumeric: 'tabular-nums' }}>
                                    <thead style={{ background: 'var(--background)', color: 'var(--muted)', fontSize: '0.78rem' }}>
                                        <tr>
                                            <th style={{ padding: '0.75rem 0.9rem' }}>반</th>
                                            <th style={{ padding: '0.75rem 0.9rem' }}>응시/명단</th>
                                            <th style={{ padding: '0.75rem 0.9rem' }}>평균</th>
                                            <th style={{ padding: '0.75rem 0.9rem' }}>오답 압력</th>
                                            <th style={{ padding: '0.75rem 0.9rem' }}>집중 문항</th>
                                            <th style={{ padding: '0.75rem 0.9rem' }}>최우선 유형</th>
                                            <th style={{ padding: '0.75rem 0.9rem', textAlign: 'right' }}>액션</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {classWeaknessMatrixRows.map(row => {
                                            const topRecommendation = row.recommendations[0];
                                            const retakeIds = topRecommendation?.retakeQuestionIds || row.retakeQuestionIds;
                                            const pressureColor = row.wrongRate >= 60
                                                ? 'var(--error)'
                                                : row.wrongRate >= 35
                                                    ? 'var(--warning)'
                                                    : 'var(--success)';
                                            return (
                                                <tr key={row.groupKey} style={{ borderTop: '1px solid var(--border)' }}>
                                                    <td style={{ padding: '0.85rem 0.9rem', fontWeight: 900, color: 'var(--foreground)' }}>
                                                        {formatRegionScopedLabel(row.groupName, row.regionName)}
                                                    </td>
                                                    <td style={{ padding: '0.85rem 0.9rem', color: 'var(--muted)', fontWeight: 800 }}>
                                                        <div style={{ color: 'var(--foreground)', fontWeight: 900 }}>
                                                            {row.rosterStudentCount > 0
                                                                ? `${row.submittedRosterStudentCount}/${row.rosterStudentCount}명`
                                                                : `${row.studentCount}명`}
                                                        </div>
                                                        <div style={{ fontSize: '0.72rem', color: 'var(--muted)', marginTop: '0.16rem' }}>
                                                            제출 {row.attemptCount}건 · 참여 {formatParticipationRateLabel(row.participationRate)}
                                                        </div>
                                                        {row.missingStudentCount > 0 && (
                                                            <div style={{ fontSize: '0.7rem', color: 'var(--warning)', marginTop: '0.16rem', lineHeight: 1.35 }}>
                                                                미응시 {row.missingStudentCount}명{row.missingStudentNames.length > 0 ? ` · ${row.missingStudentNames.join(", ")}` : ""}
                                                            </div>
                                                        )}
                                                    </td>
                                                    <td style={{ padding: '0.85rem 0.9rem' }}>
                                                        <span style={{
                                                            fontWeight: 900,
                                                            color: row.averageScorePercent === null
                                                                ? 'var(--muted)'
                                                                : row.averageScorePercent < 60
                                                                    ? 'var(--error)'
                                                                    : row.averageScorePercent < 80
                                                                        ? 'var(--warning)'
                                                                        : 'var(--success)',
                                                        }}>
                                                            {row.averageScorePercent === null ? '미채점' : `${row.averageScorePercent}%`}
                                                        </span>
                                                        <div style={{ fontSize: '0.72rem', color: 'var(--muted)', marginTop: '0.16rem' }}>
                                                            채점 {row.performanceCount}명
                                                        </div>
                                                    </td>
                                                    <td style={{ padding: '0.85rem 0.9rem' }}>
                                                        {row.totalCount > 0 ? (
                                                            <>
                                                                <div style={{ fontWeight: 900, color: pressureColor }}>{row.wrongRate}%</div>
                                                                <div style={{ fontSize: '0.74rem', color: 'var(--muted)', marginTop: '0.15rem' }}>
                                                                    {row.wrongCount}/{row.totalCount}
                                                                </div>
                                                            </>
                                                        ) : (
                                                            <span style={{ color: 'var(--muted)', fontWeight: 800 }}>근거 없음</span>
                                                        )}
                                                    </td>
                                                    <td style={{ padding: '0.85rem 0.9rem', color: 'var(--muted)', fontWeight: 800 }}>
                                                        {row.totalCount === 0
                                                            ? '미채점'
                                                            : row.focusQuestionNumbers.length > 0
                                                                ? `${row.focusQuestionNumbers.join(', ')}번`
                                                                : '안정'}
                                                    </td>
                                                    <td style={{ padding: '0.85rem 0.9rem' }}>
                                                        {topRecommendation ? (
                                                            <div style={{ minWidth: '150px' }}>
                                                                <div style={{ fontWeight: 900, color: 'var(--foreground)' }}>{topRecommendation.title}</div>
                                                                <div style={{ fontSize: '0.74rem', color: 'var(--muted)', marginTop: '0.16rem' }}>
                                                                    {topRecommendation.basis} · {topRecommendation.wrongRate}%
                                                                </div>
                                                            </div>
                                                        ) : row.totalCount === 0 ? (
                                                            <span style={{ color: 'var(--muted)', fontSize: '0.8rem', fontWeight: 900 }}>근거 없음</span>
                                                        ) : (
                                                            <span style={{ color: 'var(--success)', fontSize: '0.8rem', fontWeight: 900 }}>추가 보강 없음</span>
                                                        )}
                                                    </td>
                                                    <td style={{ padding: '0.85rem 0.9rem', textAlign: 'right' }}>
                                                        {topRecommendation && retakeIds.length > 0 ? (
                                                            <PremiumActionLink
                                                                enabled={retakeAssignmentsEnabled}
                                                                href={buildAnalyticsRetakeHref(topRecommendation.sourceAttemptId, retakeIds, topRecommendation.retakeMode, {
                                                                    labels: topRecommendation.retakeLabels,
                                                                    concepts: topRecommendation.retakeConcepts,
                                                                }) || "#"}
                                                                unavailableReason={!buildAnalyticsRetakeHref(topRecommendation.sourceAttemptId, retakeIds, topRecommendation.retakeMode) ? "제출 정의 변경 · 재시험 불가" : undefined}
                                                                className="btn btn-secondary"
                                                                style={{ fontSize: '0.74rem', padding: '0.34rem 0.65rem', whiteSpace: 'nowrap' }}
                                                                lockedTitle="Pro 이상에서 반별 재시험 세트를 만들 수 있습니다."
                                                            >
                                                                반별 세트
                                                            </PremiumActionLink>
                                                        ) : row.totalCount === 0 ? (
                                                            <span style={{ color: 'var(--muted)', fontSize: '0.78rem', fontWeight: 800 }}>미채점</span>
                                                        ) : (
                                                            <span style={{ color: 'var(--muted)', fontSize: '0.78rem', fontWeight: 800 }}>유지</span>
                                                        )}
                                                    </td>
                                                </tr>
                                            );
                                        })}
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    )}

                    {activeWorkspaceView === "questions" && advancedAnalyticsEnabled && (examTypeWeaknessGroups.length > 0 || classTypeWeaknessRows.length > 0) && (
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))', gap: '1.5rem' }}>
                            <div className="card" style={{ ...CARD_SURFACE_STYLE,padding: '1.5rem', border: '1px solid var(--border)', background: 'var(--surface)' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', marginBottom: '1rem' }}>
                                    <div>
                                        <h3 style={{ fontSize: 'var(--type-heading-sm)', fontWeight: 800, color: 'var(--foreground)', display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                                            <Target size={16} color="var(--primary)" />
                                            유형 재추천 큐
                                        </h3>
                                        <p style={{ fontSize: '0.8rem', color: 'var(--muted)', marginTop: '0.2rem' }}>
                                            저장된 문항별 결과 데이터로 오답률이 높은 개념을 바로 묶습니다.
                                        </p>
                                    </div>
                                    <StatusPill tone="success" size="sm" label="Result rows" />
                                </div>

                                {examTypeWeaknessGroups.length > 0 ? (
                                    <div style={{ display: 'grid', gap: '0.65rem' }}>
                                        {examTypeWeaknessGroups.map(group => {
                                            const retakeIds = group.retakeQuestionIds;
                                            return (
                                                <div key={group.key} className="exam-type-recommendation-row" style={{
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    justifyContent: 'space-between',
                                                    gap: '0.8rem',
                                                    padding: '0.85rem',
                                                    borderRadius: 'var(--radius-md)',
                                                    border: '1px solid var(--border)',
                                                    background: 'var(--background)'
                                                }}>
                                                    <div style={{ minWidth: 0 }}>
                                                        <div style={{ fontWeight: 900, color: 'var(--foreground)', lineHeight: 1.3 }}>
                                                            {group.title}
                                                            <span style={{ marginLeft: '0.45rem', color: 'var(--muted)', fontSize: '0.74rem', fontWeight: 800 }}>
                                                                {group.basis}
                                                            </span>
                                                        </div>
                                                        <div style={{ fontSize: '0.78rem', color: 'var(--muted)', marginTop: '0.22rem' }}>
                                                            {group.questionNumbers.join(', ')}번 · 오답/미답 {group.wrongCount}/{group.totalCount} · 학생 {group.studentCount}명
                                                        </div>
                                                        <div style={{ fontSize: '0.72rem', color: 'var(--primary)', marginTop: '0.16rem', fontWeight: 800 }}>
                                                            {group.reason}
                                                        </div>
                                                    </div>
                                                    <PremiumActionLink
                                                        enabled={retakeAssignmentsEnabled}
                                                        href={buildAnalyticsRetakeHref(group.sourceAttemptId, retakeIds, group.retakeMode, {
                                                            labels: group.retakeLabels,
                                                            concepts: group.retakeConcepts,
                                                        }) || "#"}
                                                        unavailableReason={!buildAnalyticsRetakeHref(group.sourceAttemptId, retakeIds, group.retakeMode) ? "제출 정의 변경 · 재시험 불가" : undefined}
                                                        className="btn btn-secondary exam-type-recommendation-action"
                                                        style={{ fontSize: '0.75rem', padding: '0.35rem 0.65rem', whiteSpace: 'nowrap' }}
                                                        lockedTitle="Pro 이상에서 유형 재추천 링크를 만들 수 있습니다."
                                                    >
                                                        {group.wrongRate}% 재추천
                                                    </PremiumActionLink>
                                                </div>
                                            );
                                        })}
                                    </div>
                                ) : (
                                    <div style={{ color: 'var(--muted)', fontSize: '0.85rem', padding: '1rem', border: '1px dashed var(--border)', borderRadius: 'var(--radius-md)' }}>
                                        오답 결과가 쌓이면 유형별 재추천 큐가 표시됩니다.
                                    </div>
                                )}
                            </div>

                            <div className="card" style={{ ...CARD_SURFACE_STYLE,padding: '1.5rem', border: '1px solid var(--border)', background: 'var(--surface)' }}>
                                <h3 style={{ fontSize: 'var(--type-heading-sm)', fontWeight: 800, color: 'var(--foreground)', display: 'flex', alignItems: 'center', gap: '0.45rem', marginBottom: '0.25rem' }}>
                                    <Users size={16} color="var(--primary)" />
                                    반별 약점 압력
                                </h3>
                                <p style={{ fontSize: '0.8rem', color: 'var(--muted)', marginBottom: '1rem' }}>
                                    같은 시험을 반 단위로 잘라 가장 먼저 보강할 유형을 보여줍니다.
                                </p>

                                {classTypeWeaknessRows.length > 0 ? (
                                    <div style={{ display: 'grid', gap: '0.55rem' }}>
                                        {classTypeWeaknessRows.map(row => {
                                            const retakeIds = row.topGroup.retakeQuestionIds;
                                            return (
                                                <div key={row.key} style={{
                                                    padding: '0.8rem',
                                                    borderRadius: 'var(--radius-md)',
                                                    border: '1px solid var(--border)',
                                                    background: 'var(--background)',
                                                }}>
                                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', marginBottom: '0.35rem' }}>
                                                        <span style={{ fontWeight: 900, color: 'var(--foreground)' }}>{row.label}</span>
                                                        <span style={{ color: 'var(--grade-red)', fontSize: '0.78rem', fontWeight: 900 }}>
                                                            {row.topGroup.wrongRate}%
                                                        </span>
                                                    </div>
                                                    <div style={{ fontSize: '0.78rem', color: 'var(--muted)', lineHeight: 1.5, marginBottom: '0.55rem' }}>
                                                        {row.topGroup.title} · {row.topGroup.questionNumbers.join(', ')}번 · 제출 {row.attemptCount}건
                                                    </div>
                                                    <div style={{ fontSize: '0.72rem', color: 'var(--primary)', lineHeight: 1.4, fontWeight: 800, marginBottom: '0.55rem' }}>
                                                        {row.topGroup.reason}
                                                    </div>
                                                    <PremiumActionLink
                                                        enabled={retakeAssignmentsEnabled}
                                                        href={buildAnalyticsRetakeHref(row.topGroup.sourceAttemptId, retakeIds, row.topGroup.retakeMode, {
                                                            labels: row.topGroup.retakeLabels,
                                                            concepts: row.topGroup.retakeConcepts,
                                                        }) || "#"}
                                                        unavailableReason={!buildAnalyticsRetakeHref(row.topGroup.sourceAttemptId, retakeIds, row.topGroup.retakeMode) ? "제출 정의 변경 · 재시험 불가" : undefined}
                                                        className="btn btn-secondary"
                                                        style={{ fontSize: '0.74rem', padding: '0.32rem 0.6rem' }}
                                                        lockedTitle="Pro 이상에서 반 보강 재시험 세트를 만들 수 있습니다."
                                                    >
                                                        반 보강 세트
                                                    </PremiumActionLink>
                                                </div>
                                            );
                                        })}
                                    </div>
                                ) : (
                                    <div style={{ color: 'var(--muted)', fontSize: '0.85rem', padding: '1rem', border: '1px dashed var(--border)', borderRadius: 'var(--radius-md)' }}>
                                        반 정보가 있는 제출부터 반별 약점이 표시됩니다.
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {activeWorkspaceView === "students" && advancedAnalyticsEnabled && (similarQuestionGroups.length > 0 || behaviorRows.length > 0) && (
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))', gap: '1.5rem' }}>
                            <div className="card" style={{ ...CARD_SURFACE_STYLE,padding: '1.5rem', border: '1px solid var(--border)', background: 'var(--surface)' }}>
                                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem', marginBottom: '1rem' }}>
                                    <div>
                                        <h3 style={{ fontSize: 'var(--type-heading-sm)', fontWeight: 800, color: 'var(--foreground)', display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                                            <Target size={16} color="var(--primary)" />
                                            유사 유형 소팅
                                        </h3>
                                        <p style={{ fontSize: '0.8rem', color: 'var(--muted)', marginTop: '0.2rem' }}>
                                            같은 지문/작품, 개념, 단원 기준으로 오답 압력이 높은 묶음입니다.
                                        </p>
                                    </div>
                                    <StatusPill tone="success" size="sm" label="Premium" />
                                </div>

                                {similarQuestionGroups.length > 0 ? (
                                    <div style={{ display: 'grid', gap: '0.65rem' }}>
                                        {similarQuestionGroups.map(group => (
                                            <div key={group.key} style={{
                                                display: 'flex',
                                                alignItems: 'center',
                                                justifyContent: 'space-between',
                                                gap: '0.75rem',
                                                padding: '0.85rem',
                                                borderRadius: 'var(--radius-md)',
                                                border: '1px solid var(--border)',
                                                background: 'var(--background)'
                                            }}>
                                                <div style={{ minWidth: 0 }}>
                                                    <div style={{ fontWeight: 900, color: 'var(--foreground)', lineHeight: 1.3 }}>
                                                        {group.title}
                                                        <span style={{ marginLeft: '0.45rem', color: 'var(--muted)', fontSize: '0.74rem', fontWeight: 800 }}>
                                                            {group.basis}
                                                        </span>
                                                    </div>
                                                    <div style={{ fontSize: '0.78rem', color: 'var(--muted)', marginTop: '0.22rem' }}>
                                                        {group.questionNumbers.join(', ')}번 · 오답 {group.wrongCount}/{group.totalCount} · {group.wrongRate}%
                                                    </div>
                                                </div>
                                                <PremiumActionLink
                                                    enabled={retakeAssignmentsEnabled}
                                                    href={buildAnalyticsRetakeHref(`exam:${selectedExamId}`, group.questionIds, "similar", {
                                                        labels: group.labels,
                                                        concepts: group.concepts,
                                                    }) || "#"}
                                                    unavailableReason={!buildAnalyticsRetakeHref(`exam:${selectedExamId}`, group.questionIds, "similar") ? "제출 정의 변경 · 재시험 불가" : undefined}
                                                    className="btn btn-secondary"
                                                    style={{ fontSize: '0.75rem', padding: '0.35rem 0.65rem', whiteSpace: 'nowrap' }}
                                                    lockedTitle="Pro 이상에서 유사 유형 세트 재시험을 만들 수 있습니다."
                                                >
                                                    세트 재시험
                                                </PremiumActionLink>
                                            </div>
                                        ))}
                                    </div>
                                ) : (
                                    <div style={{ color: 'var(--muted)', fontSize: '0.85rem', padding: '1rem', border: '1px dashed var(--border)', borderRadius: 'var(--radius-md)' }}>
                                        오답이 쌓이면 유사 유형 묶음이 표시됩니다.
                                    </div>
                                )}
                            </div>

                            <div className="card" style={{ ...CARD_SURFACE_STYLE,padding: '1.5rem', border: '1px solid var(--border)', background: 'var(--surface)' }}>
                                <h3 style={{ fontSize: 'var(--type-heading-sm)', fontWeight: 800, color: 'var(--foreground)', display: 'flex', alignItems: 'center', gap: '0.45rem', marginBottom: '0.25rem' }}>
                                    <List size={16} color="var(--primary)" />
                                    풀이 행동 신호
                                </h3>
                                <p style={{ fontSize: '0.8rem', color: 'var(--muted)', marginBottom: '1rem' }}>
                                    오래 머문 문항, 다시 돌아온 문항, 화면 이탈을 학생별로 확인합니다.
                                </p>

                                {behaviorRows.length > 0 ? (
                                    <div style={{ display: 'grid', gap: '0.55rem' }}>
                                        {behaviorRows.map(row => (
                                            <div key={row.attempt.id} style={{
                                                padding: '0.8rem',
                                                borderRadius: 'var(--radius-md)',
                                                border: '1px solid var(--border)',
                                                background: 'var(--background)',
                                            }}>
                                                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', marginBottom: '0.3rem' }}>
                                                    <span style={{ fontWeight: 900, color: 'var(--foreground)' }}>{row.attempt.studentName}</span>
                                                    <span style={{ color: row.summary.focusLossCount > 0 ? 'var(--error)' : 'var(--muted)', fontSize: '0.78rem', fontWeight: 800 }}>
                                                        이탈 {row.summary.focusLossCount}회
                                                    </span>
                                                </div>
                                                <div style={{ fontSize: '0.78rem', color: 'var(--muted)', lineHeight: 1.5 }}>
                                                    추적 {formatSeconds(row.summary.totalTrackedTimeSec)}
                                                    {row.summary.slowQuestionNumbers.length > 0 && ` · 오래 머문 ${row.summary.slowQuestionNumbers.join(', ')}번`}
                                                    {row.summary.revisitedQuestionNumbers.length > 0 && ` · 재방문 ${row.summary.revisitedQuestionNumbers.join(', ')}번`}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                ) : (
                                    <div style={{ color: 'var(--muted)', fontSize: '0.85rem', padding: '1rem', border: '1px dashed var(--border)', borderRadius: 'var(--radius-md)' }}>
                                        새 제출부터 문항별 시간과 재방문 로그가 표시됩니다.
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {activeWorkspaceView === "questions" && (
                    <div
                        id="exam-analytics-panel-questions"
                        role="tabpanel"
                        aria-label="문항 분석"
                        className={styles.legacyStack}
                    >
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))', gap: '1.5rem' }}>
                        {/* Radar Chart for labels */}
                        <div className="card chart-card-enter" style={{ ...CARD_SURFACE_STYLE, padding: '1.5rem', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-xl)', position: 'relative', overflow: 'hidden', minWidth: 0, animationDelay: '60ms' }}>
                            {/* Decorative background */}
                            <div style={{
                                position: 'absolute', top: '-30px', right: '-30px',
                                width: '200px', height: '200px',
                                background: 'radial-gradient(circle, rgba(99,102,241,0.08) 0%, transparent 70%)',
                                pointerEvents: 'none', filter: 'blur(20px)'
                            }} />

                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.25rem', position: 'relative' }}>
                                <div>
                                    <h3 style={{ fontSize: 'var(--type-heading-sm)', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '0.5rem', letterSpacing: '-0.01em' }}>
                                        <BarChart2 size={16} color="var(--primary)" />
                                        항목별(라벨) 정답률 분석
                                    </h3>
                                    <p style={{ fontSize: '0.78rem', color: 'var(--muted)', marginTop: '2px', fontWeight: 500 }}>
                                        카테고리별 평균 정답률 레이더
                                    </p>
                                </div>
                                {scopedLabelAnalytics.length > 0 && (
                                    <span className="badge badge-primary" style={{ fontSize: '0.7rem' }}>
                                        {scopedLabelAnalytics.length}개 라벨
                                    </span>
                                )}
                            </div>

                            {/* A radar with fewer than 3 axes collapses to a line/point, so
                                fall back to a bar-style list for 1–2 labels. */}
                            {scopedLabelAnalytics.length >= 3 ? (
                                <>
                                    <div className="radar-bloom" style={{ height: '300px', width: '100%', minWidth: 0, position: 'relative' }}>
                                        <ResponsiveContainer
                                            width="100%"
                                            height="100%"
                                            minWidth={0}
                                            minHeight={300}
                                            initialDimension={{ width: 560, height: 300 }}
                                        >
                                            <RadarChart cx="50%" cy="50%" outerRadius="72%" data={scopedLabelAnalytics} startAngle={90} endAngle={-270}>
                                                <defs>
                                                    <linearGradient id="radarGradient" x1="0" y1="0" x2="1" y2="1">
                                                        <stop offset="0%" stopColor="#4f46e5" stopOpacity={0.7} />
                                                        <stop offset="50%" stopColor="#8b5cf6" stopOpacity={0.5} />
                                                        <stop offset="100%" stopColor="#ec4899" stopOpacity={0.35} />
                                                    </linearGradient>
                                                    <filter id="radarGlow">
                                                        <feGaussianBlur stdDeviation="3" result="coloredBlur" />
                                                        <feMerge>
                                                            <feMergeNode in="coloredBlur" />
                                                            <feMergeNode in="SourceGraphic" />
                                                        </feMerge>
                                                    </filter>
                                                </defs>

                                                {/* Inner dotted gridlines (faint) */}
                                                <PolarGrid
                                                    stroke="var(--muted)"
                                                    strokeDasharray="2 4"
                                                    strokeOpacity={0.3}
                                                    gridType="polygon"
                                                />
                                                <PolarAngleAxis
                                                    dataKey="label"
                                                    tick={{ fill: 'var(--foreground)', fontSize: 12, fontWeight: 700, letterSpacing: '-0.01em' }}
                                                    tickLine={false}
                                                    axisLine={{ stroke: 'var(--muted)', strokeWidth: 1, strokeOpacity: 0.55 }}
                                                />
                                                <PolarRadiusAxis
                                                    angle={90}
                                                    domain={[0, 100]}
                                                    tick={{ fill: 'var(--muted)', fontSize: 10, fontWeight: 500 }}
                                                    tickCount={5}
                                                    axisLine={false}
                                                    stroke="transparent"
                                                />
                                                <Radar
                                                    name="정답률"
                                                    dataKey="correctRate"
                                                    stroke="#6366f1"
                                                    strokeWidth={2.5}
                                                    fill="url(#radarGradient)"
                                                    fillOpacity={0.85}
                                                    dot={{ fill: '#6366f1', stroke: '#fff', strokeWidth: 2, r: 5 }}
                                                    activeDot={{ fill: '#ec4899', stroke: '#fff', strokeWidth: 2, r: 7 }}
                                                    isAnimationActive={false}
                                                    filter="url(#radarGlow)"
                                                />
                                                <RechartsTooltip
                                                    cursor={{ fill: 'transparent' }}
                                                    contentStyle={{
                                                        borderRadius: '12px',
                                                        border: '1px solid rgba(99, 102, 241, 0.2)',
                                                        boxShadow: '0 8px 32px rgba(0,0,0,0.12)',
                                                        background: 'var(--surface)',
                                                        color: 'var(--foreground)',
                                                        fontWeight: 700,
                                                        fontSize: '0.85rem',
                                                        padding: '0.6rem 0.9rem',
                                                        letterSpacing: '-0.01em'
                                                    }}
                                                    itemStyle={{ color: 'var(--primary)', fontWeight: 800, padding: 0 }}
                                                    labelStyle={{ color: 'var(--foreground)', marginBottom: '4px', fontSize: '0.82rem', fontWeight: 700 }}
                                                    formatter={(value: ValueType | undefined) => [
                                                        `${Array.isArray(value) ? value.join("–") : value}%`,
                                                        '정답률',
                                                    ]}
                                                />
                                            </RadarChart>
                                        </ResponsiveContainer>
                                    </div>

                                    {/* Premium Legend */}
                                    <div className="radar-legend">
                                        {scopedLabelAnalytics.map((item, idx) => {
                                            const hue = (idx * 360) / scopedLabelAnalytics.length;
                                            const dotColor = `hsl(${(hue + 230) % 360}, 75%, 60%)`;
                                            const rateColor = item.correctRate >= 80 ? 'var(--success)'
                                                : item.correctRate >= 50 ? 'var(--primary)'
                                                : 'var(--error)';
                                            return (
                                                <div key={item.label} className="radar-legend-item">
                                                    <span className="radar-legend-dot" style={{ background: dotColor }} />
                                                    <span className="radar-legend-label">{item.label}</span>
                                                    <span className="radar-legend-value" style={{ color: rateColor }}>
                                                        {item.correctRate}%
                                                    </span>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </>
                            ) : scopedLabelAnalytics.length > 0 ? (
                                <div style={{ display: 'grid', gap: '0.85rem', padding: '0.75rem 0.25rem' }}>
                                    <div style={{ fontSize: '0.78rem', color: 'var(--muted)', fontWeight: 600 }}>
                                        라벨이 3개 미만이라 레이더 대신 막대로 표시합니다.
                                    </div>
                                    {scopedLabelAnalytics.map(item => {
                                        const rateColor = item.correctRate >= 80 ? 'var(--success)'
                                            : item.correctRate >= 50 ? 'var(--primary)'
                                            : 'var(--error)';
                                        return (
                                            <div key={item.label}>
                                                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.35rem', fontSize: '0.88rem', fontWeight: 700 }}>
                                                    <span style={{ color: 'var(--foreground)' }}>{item.label}</span>
                                                    <span style={{ color: rateColor }}>{item.correctRate}%</span>
                                                </div>
                                                <div style={{ height: '10px', background: 'var(--border)', borderRadius: 'var(--radius-full)', overflow: 'hidden' }}>
                                                    <div style={{ width: `${Math.max(0, Math.min(100, item.correctRate))}%`, height: '100%', background: rateColor, borderRadius: 'var(--radius-full)' }} />
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            ) : (
                                <div style={{ height: '300px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)' }}>라벨이 지정된 문항이 없습니다.</div>
                            )}
                        </div>

                        {/* Top Hardest Questions */}
                        <div className="card" style={{ ...CARD_SURFACE_STYLE,padding: '1.5rem', minWidth: 0 }}>
                            <h3 style={{ fontSize: '1.1rem', fontWeight: 700, marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                <AlertTriangle size={18} color="var(--error)" />
                                오답률이 가장 높은 문항 Top 3
                            </h3>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                                {topWrongQuestions.map((q) => {
                                    // Point-biserial r, same index as the 문항별 상세 table ("-" below n ≥ 5).
                                    const discriminationText = q.pointBiserial !== null ? q.pointBiserial.toFixed(2) : '-';
                                    return (
                                    <div key={q.cohortKey} style={{
                                        padding: '1rem',
                                        borderRadius: 'var(--radius-md)',
                                        background: 'var(--grade-red-soft)',
                                        borderLeft: '4px solid var(--grade-red)',
                                        display: 'flex',
                                        justifyContent: 'space-between',
                                        alignItems: 'center'
                                    }}>
                                        <div>
                                            <div style={{ fontWeight: 700, fontSize: '1.1rem', color: 'var(--error)', marginBottom: '0.2rem' }}>
                                                {q.index}번 문항 ({q.label}){q.cohortLabel ? ` · ${q.cohortLabel}` : ""}
                                            </div>
                                            <div style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>
                                                {q.topWrongOption && q.topWrongOption.rate > 0
                                                    ? `${q.topWrongOption.option}번 선택 쏠림 ${q.topWrongOption.rate}% · 변별도 ${discriminationText}`
                                                    : `미응답 ${q.unansweredRate}% · 변별도 ${discriminationText}`}
                                                {q.averageTimeSec ? ` · 평균 ${formatSeconds(q.averageTimeSec)}` : ""}
                                            </div>
                                        </div>
                                        <div style={{ textAlign: 'right' }}>
                                            <div style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>오답률</div>
                                            <div style={{ fontWeight: 800, fontSize: '1.2rem', color: 'var(--grade-red)' }}>
                                                {q.wrongRate}%
                                            </div>
                                        </div>
                                    </div>
                                    );
                                })}
                                {topWrongQuestions.length === 0 && (
                                    <div style={{ color: 'var(--muted)', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>데이터가 없습니다.</div>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* Detailed Question correct rate bar chart */}
                    <div className="card chart-card-enter" style={{ ...CARD_SURFACE_STYLE, padding: '1.5rem' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem', marginBottom: '1.25rem' }}>
                            <h3 style={{ fontSize: '1.1rem', fontWeight: 700, margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                <CheckCircle size={18} color="var(--success)" />
                                문항별 상세 정답률
                            </h3>
                            <div style={{ display: 'flex', gap: '0.85rem', flexWrap: 'wrap', alignItems: 'center', fontSize: '0.82rem' }}>
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', color: 'var(--grade-red)', fontWeight: 600 }}>
                                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--grade-red)' }} />
                                    킬러(&lt;40%): {questionCorrectRateChartData.filter(q => q.correctRate !== null && q.correctRate < 40).length}문항
                                </span>
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', color: 'var(--warning)', fontWeight: 600 }}>
                                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--warning)' }} />
                                    보통(40~69%): {questionCorrectRateChartData.filter(q => q.correctRate !== null && q.correctRate >= 40 && q.correctRate < 70).length}문항
                                </span>
                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', color: 'var(--primary)', fontWeight: 600 }}>
                                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--primary)' }} />
                                    수월(≥70%): {questionCorrectRateChartData.filter(q => q.correctRate !== null && q.correctRate >= 70).length}문항
                                </span>
                            </div>
                        </div>
                        <div
                            role="img"
                            aria-label="문항별 상세 정답률"
                            aria-describedby="exam-question-correct-rate-summary"
                            style={{ height: '300px', width: '100%', minWidth: 0, marginBottom: '2rem' }}
                        >
                            <ResponsiveContainer
                                width="100%"
                                height="100%"
                                minWidth={0}
                                minHeight={300}
                                initialDimension={{ width: 900, height: 300 }}
                            >
                                <BarChart data={questionCorrectRateChartData}>
                                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
                                    <XAxis dataKey="index" tickFormatter={(v) => `${v}번`} tick={{ fill: 'var(--muted)' }} axisLine={false} tickLine={false} />
                                    <YAxis domain={[0, 100]} tick={{ fill: 'var(--muted)' }} axisLine={false} tickLine={false} />
                                    <RechartsTooltip
                                        filterNull={false}
                                        cursor={{ fill: 'rgba(99, 102, 241, 0.05)' }}
                                        content={<QuestionCorrectRateTooltip />}
                                    />
                                    <Bar dataKey="correctRate" fill="var(--primary)" isAnimationActive={false} shape={<WaveBar />}>
                                        {questionCorrectRateChartData.map((entry, idx) => {
                                            const rate = entry.correctRate;
                                            const cellColor = rate === null
                                                ? "var(--muted)"
                                                : rate < 40
                                                ? "var(--grade-red)"
                                                : rate < 70
                                                ? "var(--warning)"
                                                : "var(--primary)";
                                            return <Cell key={`rate-cell-${entry.index}-${idx}`} fill={cellColor} />;
                                        })}
                                    </Bar>
                                </BarChart>
                            </ResponsiveContainer>
                        </div>
                        <p id="exam-question-correct-rate-summary" className="sr-only">
                            {questionCorrectRateChartSummary}
                        </p>

                        {/* Option Selection Rates Table */}
                        <h4 style={{ fontSize: 'var(--type-heading-sm)', fontWeight: 700, marginTop: '1rem', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <List size={16} color="var(--primary)" />
                            세부사항: 문항별 선택률
                        </h4>
                        <p id="exam-question-detail-scroll-hint" className={styles.scrollHint}>
                            표가 화면보다 넓으면 좌우로 스크롤해 확인하세요.
                        </p>
                        <div
                            role="region"
                            tabIndex={0}
                            aria-label="문항별 상세 분석 표"
                            aria-describedby="exam-question-detail-scroll-hint"
                            className={styles.horizontalTableRegion}
                        >
                            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', minWidth: '820px', fontVariantNumeric: 'tabular-nums' }}>
                                <thead>
                                    <tr style={{ background: 'var(--surface)', color: 'var(--muted)', fontSize: '0.85rem' }}>
                                        <th style={{ padding: '0.75rem 1rem', borderRadius: 'var(--radius-md) 0 0 var(--radius-md)' }}>문항</th>
                                        <th style={{ padding: '0.75rem 1rem' }}>진단</th>
                                        <th style={{ padding: '0.75rem 1rem' }}>정답률</th>
                                        <th style={{ padding: '0.75rem 1rem' }} title="점이연 상관 기준">변별도</th>
                                        <th style={{ padding: '0.75rem 1rem' }}>미응답</th>
                                        <th style={{ padding: '0.75rem 1rem' }}>평균시간</th>
                                        <th style={{ padding: '0.75rem 1rem' }}>재방문/변경</th>
                                        {Array.from({ length: maxChoiceCount }, (_, i) => i + 1).map(opt => (
                                            <th
                                                key={opt}
                                                style={{
                                                    padding: '0.75rem 1rem',
                                                    textAlign: 'center',
                                                    borderRadius: opt === maxChoiceCount ? '0 var(--radius-md) var(--radius-md) 0' : undefined
                                                }}
                                            >
                                                선지 {opt}
                                            </th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {[...questionAnalytics].sort((a: { index: number }, b: { index: number }) => a.index - b.index).map((q) => {
                                        const hasQuestionEvidence = q.totalCount > 0;
                                        const optMap = q.optionRates.reduce((acc: Record<number, number>, curr: { option: number; rate: number }) => { acc[curr.option] = curr.rate; return acc; }, {});
                                        const weakPointBiserial = q.pointBiserial !== null && q.pointBiserial < WEAK_POINT_BISERIAL_THRESHOLD;
                                        const qualityLabel = !hasQuestionEvidence
                                            ? '미채점'
                                            : q.correctRate < 50
                                            ? '보강'
                                            : weakPointBiserial
                                                ? '변별 점검'
                                                : q.correctRate >= 90
                                                    ? '쉬움'
                                                    : '정상';
                                        // 미채점 = no usable denominator (neutral). 보강/변별 점검 is a
                                        // correctness/quality problem (grade-red); 정상/쉬움 is success.
                                        const qualityTone: "grade" | "success" | "muted" = !hasQuestionEvidence
                                            ? 'muted'
                                            : qualityLabel === '정상' || qualityLabel === '쉬움'
                                                ? 'success'
                                                : 'grade';
                                        return (
                                            <tr
                                                key={q.cohortKey}
                                                style={{ borderBottom: '1px solid var(--border)' }}
                                                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(99,102,241,0.06)'; }}
                                                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                                            >
                                                <td style={{ padding: '0.75rem 1rem', fontWeight: 600 }}>
                                                    {q.index}번
                                                    {q.cohortLabel && (
                                                        <span style={{ marginLeft: '0.35rem', fontSize: '0.7rem', color: 'var(--muted)', fontWeight: 700 }}>
                                                            {q.cohortLabel}
                                                        </span>
                                                    )}
                                                    <span style={{ fontSize: '0.75rem', color: 'var(--muted)', fontWeight: 400 }}> ({q.concept})</span>
                                                    {q.difficulty && (
                                                        <span style={{ marginLeft: '0.35rem', fontSize: '0.7rem', color: 'var(--primary)', fontWeight: 800 }}>
                                                            {difficultyLabelMap[q.difficulty] || q.difficulty}
                                                        </span>
                                                    )}
                                                </td>
                                                <td style={{ padding: '0.75rem 1rem' }}>
                                                    <StatusPill tone={qualityTone} size="sm" label={qualityLabel} />
                                                </td>
                                                <td style={{ padding: '0.75rem 1rem', fontWeight: 600, color: !hasQuestionEvidence ? 'var(--muted)' : q.correctRate < 40 ? 'var(--grade-red)' : 'var(--text)' }}>
                                                    {hasQuestionEvidence ? `${q.correctRate}%` : '-'}
                                                </td>
                                                <td
                                                    style={{ padding: '0.75rem 1rem', fontWeight: 700, color: weakPointBiserial ? 'var(--warning)' : 'var(--muted)' }}
                                                    title="점이연 상관 기준"
                                                >
                                                    {q.pointBiserial !== null ? q.pointBiserial.toFixed(2) : '-'}
                                                </td>
                                                <td style={{ padding: '0.75rem 1rem', fontWeight: 700, color: hasQuestionEvidence && q.unansweredRate >= 20 ? 'var(--grade-red)' : 'var(--muted)' }}>
                                                    {hasQuestionEvidence ? `${q.unansweredRate}%` : '-'}
                                                </td>
                                                <td style={{ padding: '0.75rem 1rem', color: q.timeOverExpectedRate && q.timeOverExpectedRate >= 130 ? 'var(--warning)' : 'var(--muted)', fontWeight: 800 }}>
                                                    {q.averageTimeSec ? formatSeconds(q.averageTimeSec) : '-'}
                                                    {q.timeOverExpectedRate ? (
                                                        <div style={{ fontSize: '0.7rem', color: 'var(--muted)', marginTop: '0.12rem', fontWeight: 700 }}>
                                                            기대 {q.timeOverExpectedRate}%
                                                        </div>
                                                    ) : null}
                                                </td>
                                                <td style={{ padding: '0.75rem 1rem', color: hasQuestionEvidence && q.revisitRate >= 40 ? 'var(--primary)' : 'var(--muted)', fontWeight: 800 }}>
                                                    {hasQuestionEvidence ? `${q.revisitRate}%` : '-'}
                                                    {hasQuestionEvidence ? (
                                                        <div style={{ fontSize: '0.7rem', color: 'var(--muted)', marginTop: '0.12rem', fontWeight: 700 }}>
                                                            변경 {q.answerChangeCount}회
                                                        </div>
                                                    ) : null}
                                                </td>
                                                {Array.from({ length: maxChoiceCount }, (_, optIdx) => {
                                                    const optNum = optIdx + 1;
                                                    const isAvailableOption = optNum <= q.choices;
                                                    const isCorrectAnswer = q.answer === optNum;
                                                    return (
                                                        <td key={optNum} style={{ padding: '0.75rem 1rem', textAlign: 'center' }}>
                                                            <span style={{
                                                                display: 'inline-block', minWidth: '40px', padding: '0.2rem 0.4rem', borderRadius: '4px',
                                                                background: isCorrectAnswer ? 'rgba(34, 197, 94, 0.1)' : !isAvailableOption ? 'rgba(148,163,184,0.08)' : 'transparent',
                                                                color: isCorrectAnswer ? 'var(--success)' : !isAvailableOption ? 'rgba(148,163,184,0.55)' : 'var(--muted)',
                                                                fontWeight: isCorrectAnswer ? 700 : 400
                                                            }}>
                                                                {isAvailableOption && hasQuestionEvidence ? `${optMap[optNum] || 0}%` : '-'}
                                                            </span>
                                                        </td>
                                                    );
                                                })}
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </div>

                    </div>
                    )}

                    {/* Student Scores Section */}
                    {activeWorkspaceView === "students" && (
                    <div
                        id="exam-analytics-panel-students"
                        role="tabpanel"
                        aria-label="학생 및 반 분석"
                        className="card"
                        style={{ ...CARD_SURFACE_STYLE,padding: '1.5rem', marginTop: '1.5rem' }}
                    >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
                            <h3 style={{ fontSize: '1.1rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                <AlertTriangle size={18} color="var(--primary)" style={{ visibility: 'hidden' }} />
                                학생별 점수 및 성취도 (장르별)
                            </h3>
                        </div>

                        <p id="exam-student-score-scroll-hint" className={styles.scrollHint}>
                            표가 화면보다 넓으면 좌우로 스크롤해 확인하세요.
                        </p>
                        <div
                            data-testid="exam-analytics-student-table-scroll"
                            role="region"
                            tabIndex={0}
                            aria-label="학생별 점수 및 성취도 표"
                            aria-describedby="exam-student-score-scroll-hint"
                            className={styles.horizontalTableRegion}
                            style={{ borderRadius: 'var(--radius-lg)', border: '1px solid var(--border)' }}
                        >
                            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', minWidth: '940px', fontVariantNumeric: 'tabular-nums' }}>
                                <thead style={{ background: 'var(--surface)' }}>
                                    <tr>
                                        <th
                                            scope="col"
                                            aria-sort={sortField === 'name' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                                            style={{ padding: 0, fontSize: '0.85rem', color: 'var(--muted)' }}
                                        >
                                            <button
                                                type="button"
                                                className={styles.sortButton}
                                                onClick={() => handleSort('name')}
                                                aria-label={`학생 이름 정렬 (${sortField === 'name' ? (sortDir === 'asc' ? '오름차순' : '내림차순') : '정렬 안 됨'})`}
                                            >
                                                학생 이름 {sortField === 'name' ? (sortDir === 'asc' ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />) : null}
                                            </button>
                                        </th>
                                        <th
                                            scope="col"
                                            aria-sort={sortField === 'score' ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
                                            style={{ padding: 0, fontSize: '0.85rem', color: 'var(--muted)' }}
                                        >
                                            <button
                                                type="button"
                                                className={styles.sortButton}
                                                onClick={() => handleSort('score')}
                                                aria-label={`총점 정렬 (${sortField === 'score' ? (sortDir === 'asc' ? '오름차순' : '내림차순') : '정렬 안 됨'})`}
                                            >
                                                총점 {sortField === 'score' ? (sortDir === 'asc' ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />) : null}
                                            </button>
                                        </th>
                                        {/* Dynamic Label Columns */}
                                        {examLabels.map(label => (
                                            <th key={label} style={{ padding: '1rem', fontSize: '0.85rem', color: 'var(--muted)' }}>
                                                {label}
                                            </th>
                                        ))}
                                        <th style={{ padding: '1rem', fontSize: '0.85rem', color: 'var(--muted)' }}>약점 유형</th>
                                        <th style={{ padding: '1rem', fontSize: '0.85rem', color: 'var(--muted)' }}>풀이 행동</th>
                                        <th style={{ padding: '1rem', fontSize: '0.85rem', color: 'var(--muted)' }}>재시험</th>
                                        <th style={{ padding: '1rem', fontSize: '0.85rem', color: 'var(--muted)', textAlign: 'right' }}>데이터 출력</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {sortedStudentScores.map((student) => {
                                        const behavior = student.behavior;
                                        const retakeIds = student.hasPerformanceScore ? student.retakeQuestionIds : [];
                                        const topWeakness = student.hasPerformanceScore
                                            ? studentWeaknessByAttemptId.get(student.attempt.id)
                                            : undefined;
                                        return (
                                            <tr
                                                key={student.attempt.id}
                                                style={{ borderTop: '1px solid var(--border)' }}
                                                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(99,102,241,0.06)'; }}
                                                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                                            >
                                                <td style={{ padding: '1rem', fontWeight: 600 }}>{student.studentName}</td>
                                                <td style={{ padding: '1rem' }}>
                                                    <div style={{
                                                        fontWeight: 800,
                                                        color: !student.hasPerformanceScore
                                                            ? 'var(--muted)'
                                                            : student.scorePercentage >= 80
                                                                ? 'var(--success)'
                                                                : student.scorePercentage < 50
                                                                    ? 'var(--error)'
                                                                    : 'var(--text)',
                                                    }}>
                                                        {student.hasPerformanceScore ? (
                                                            <>{Number(student.totalScore.toFixed(2))}점 <span style={{ fontSize: '0.8rem', color: 'var(--muted)', fontWeight: 400 }}>({student.scorePercentage}%)</span></>
                                                        ) : '미채점'}
                                                    </div>
                                                </td>
                                                {/* Dynamic Label Columns */}
                                                {examLabels.map(label => {
                                                    const ls = student.labelScores[label];
                                                    const rate = safeRatePercent(ls.earned, ls.total);
                                                    return (
                                                        <td key={label} style={{ padding: '1rem' }}>
                                                            {ls.total > 0 ? (
                                                                <>
                                                                    <div style={{ fontSize: '0.9rem', fontWeight: 600 }}>{ls.earned} / {ls.total}</div>
                                                                    <div style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>정답률 {rate}%</div>
                                                                </>
                                                            ) : (
                                                                <span style={{ color: 'var(--muted)', fontWeight: 700 }}>미채점</span>
                                                            )}
                                                        </td>
                                                    );
                                                })}
                                                <td style={{ padding: '1rem' }}>
                                                    {!student.hasPerformanceScore ? (
                                                        <span style={{ color: 'var(--muted)', fontSize: '0.78rem', fontWeight: 800 }}>근거 없음</span>
                                                    ) : topWeakness ? (
                                                        <div style={{ minWidth: '120px' }}>
                                                            <div style={{ fontSize: '0.86rem', fontWeight: 900, color: 'var(--foreground)' }}>
                                                                {topWeakness.title}
                                                            </div>
                                                            <div style={{ fontSize: '0.74rem', color: 'var(--muted)', marginTop: '0.18rem' }}>
                                                                {topWeakness.wrongCount > 0
                                                                    ? `${topWeakness.questionNumbers.join(', ')}번 · 오답률 ${topWeakness.wrongRate}%`
                                                                    : `${topWeakness.slowCorrectQuestionNumbers.join(', ')}번 · 시간 지연 ${topWeakness.slowCorrectCount}문항`}
                                                            </div>
                                                        </div>
                                                    ) : (
                                                        <span style={{ color: 'var(--success)', fontSize: '0.78rem', fontWeight: 800 }}>안정</span>
                                                    )}
                                                </td>
                                                <td style={{ padding: '1rem', color: 'var(--muted)', fontSize: '0.78rem', lineHeight: 1.45 }}>
                                                    {behavior.totalTrackedTimeSec > 0
                                                        ? `평균 ${formatSeconds(behavior.averageTimeSec)}`
                                                        : '새 제출부터 추적'}
                                                    {behavior.revisitedQuestionNumbers.length > 0 && (
                                                        <div style={{ color: 'var(--primary)', fontWeight: 800 }}>
                                                            재방문 {behavior.revisitedQuestionNumbers.join(', ')}번
                                                        </div>
                                                    )}
                                                    {behavior.focusLossCount > 0 && (
                                                        <div style={{ color: 'var(--error)', fontWeight: 800 }}>
                                                            이탈 {behavior.focusLossCount}회
                                                        </div>
                                                    )}
                                                </td>
                                                <td style={{ padding: '1rem' }}>
                                                    {!student.hasPerformanceScore ? (
                                                        <span style={{ color: 'var(--muted)', fontSize: '0.78rem', fontWeight: 800 }}>미채점</span>
                                                    ) : retakeIds.length > 0 ? (
                                                        <PremiumActionLink
                                                            enabled={retakeAssignmentsEnabled}
                                                            href={buildAnalyticsRetakeHref(student.attempt.id, retakeIds, "wrong") || "#"}
                                                            unavailableReason={!buildAnalyticsRetakeHref(student.attempt.id, retakeIds, "wrong") ? "제출 정의 변경 · 재시험 불가" : undefined}
                                                            className="btn btn-secondary"
                                                            style={{ padding: '0.35rem 0.7rem', fontSize: '0.75rem', whiteSpace: 'nowrap' }}
                                                            lockedTitle="Pro 이상에서 학생별 오답 재시험을 만들 수 있습니다."
                                                        >
                                                            오답 {retakeIds.length}문항
                                                        </PremiumActionLink>
                                                    ) : (
                                                        <span style={{ color: 'var(--success)', fontSize: '0.78rem', fontWeight: 800 }}>완료</span>
                                                    )}
                                                </td>
                                                <td style={{ padding: '1rem', textAlign: 'right' }}>
                                                    <button
                                                        onClick={() => handleExportCSV(student)}
                                                        style={{
                                                            background: 'var(--surface)', color: 'var(--foreground)', padding: '0.4rem 0.8rem',
                                                            borderRadius: 'var(--radius-md)', fontSize: '0.75rem', fontWeight: 600,
                                                            display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
                                                            border: '1px solid var(--border)', transition: 'all 0.2s'
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
                                                        <Download size={14} />
                                                        정오표(CSV)
                                                    </button>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </div>
                    )}
                </>
            ) : (
                <div
                    id={activeWorkspaceView === "operations" ? undefined : `exam-analytics-panel-${activeWorkspaceView}`}
                    role="tabpanel"
                    className={styles.emptyState}
                >
                    <div>
                        <BarChart2 size={28} aria-hidden="true" />
                        <strong>아직 응시한 학생이 없습니다.</strong>
                        <p>제출이 들어오면 점수 분포, 취약 문항, 학생별 성취 구간을 이 화면에서 바로 분석합니다.</p>
                    </div>
                </div>
            )}
        </div>
    );
}
