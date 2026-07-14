"use client";

import { useMemo, useState, useEffect, useRef } from "react";
import { DEFAULT_CHOICE_COUNT, Exam, Attempt, questionChoiceCount, type PlanKey } from "@/types/omr";
import type { QuestionResult } from "@/types/omr";
import {
    BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer,
    Radar, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis
} from 'recharts';
import { AlertTriangle, CheckCircle, BarChart2, Download, ChevronUp, ChevronDown, Database, List, Target, Users, Lightbulb, MapPin, MessageCircle } from "lucide-react";
import { PremiumActionLink, PremiumFeatureCard } from "@/components/PremiumFeatureGate";
import {
    attemptElapsedTimeSec,
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
    getAttemptQuestionResults,
    studentScopeKeyForAttempt,
    summarizeAttemptScore,
    summarizeAttemptBehavior,
    DISCRIMINATION_MIN_RESPONDENTS,
} from "@/lib/premiumAnalytics";
import { computeGroupScoreSummary, computeScoreDistribution } from "@/lib/scoreDistribution";
import type { LearningRecommendation } from "@/lib/premiumAnalytics";
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
import { safeRatePercent } from "@/lib/scoreUtils";
import { serializeCsvRows } from "@/lib/csv";
import { buildRetakeHref } from "@/lib/retakeLinks";
import { buildExamRetakeRecoveries, summarizeRetakeRecoveries } from "@/lib/retakeRecovery";
import { buildKakaoNotificationCandidates, type KakaoNotificationCandidate, type KakaoNotificationCandidateKind } from "@/lib/kakaoNotificationQueue";
import {
    buildKakaoCandidateMessagePreview,
    readKakaoCandidateReviews,
    setKakaoCandidateReview,
    summarizeKakaoCandidateReviews,
    type KakaoCandidateReviewMap,
    type KakaoCandidateReviewStatus,
} from "@/lib/kakaoCandidateReview";
import {
    queueKakaoDispatchSimulation,
    readKakaoDispatchLogs,
    summarizeKakaoDispatchLogs,
    syncKakaoCandidateReviewRecord,
    type KakaoDispatchLog,
    syncKakaoDispatchLog,
    updateKakaoDispatchLogStatus,
} from "@/lib/kakaoCandidateReviewPersistence";
import { getKakaoProviderReadiness, type KakaoProviderReadinessStatus } from "@/lib/kakaoProvider";
import { hasPlanEntitlement } from "@/utils/plans";

interface ExamAnalyticsTabProps {
    exams: Exam[];
    attempts: Attempt[];
    rosterStudents?: RosterStudent[];
    rosterGroups?: RosterGroup[];
    initialExamId?: string;
    currentPlan?: PlanKey;
}

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

function formatSeconds(totalSec: number): string {
    if (totalSec < 60) return `${totalSec}초`;
    const minutes = Math.floor(totalSec / 60);
    const seconds = totalSec % 60;
    return seconds > 0 ? `${minutes}분 ${seconds}초` : `${minutes}분`;
}

function roundScoreValue(value: number): number {
    return Math.round(value * 100) / 100;
}

function isGradableResult(result: QuestionResult): boolean {
    return result.status !== "ungraded";
}

function isCorrectResult(result: QuestionResult): boolean {
    return result.status === "correct" || result.isCorrect;
}

function resultStatusLabel(result?: QuestionResult): string {
    if (!result) return "-";
    if (result.status === "correct" || result.isCorrect) return "O";
    if (result.status === "wrong" || result.isWrong) return "X";
    if (result.status === "unanswered" || result.isUnanswered) return "미응답";
    return "미채점";
}

type AnalysisScope = "exam" | "class" | "student";
const ALL_REGION_KEY = "__all_regions__";
const KAKAO_REVIEW_STATUS_OPTIONS: Array<{ status: KakaoCandidateReviewStatus; label: string }> = [
    { status: "ready", label: "발송 준비" },
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

function severityLabel(severity: "watch" | "review" | "urgent"): string {
    if (severity === "urgent") return "긴급";
    if (severity === "review") return "점검";
    return "관찰";
}

function severityColor(severity: "watch" | "review" | "urgent"): string {
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
    if (status === "ready") return "발송 준비";
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
    if (status === "queued") return "발송 대기 기록됨";
    if (status === "sent") return "발송 완료 기록";
    if (status === "failed") return "발송 실패 기록";
    if (status === "cancelled") return "발송 취소 기록";
    if (status === "skipped") return "발송 제외 기록";
    return "대기 기록 없음";
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
}: ExamAnalyticsTabProps) {
    const [selectedExamId, setSelectedExamId] = useState<string>(initialExamId || (exams.length > 0 ? exams[0].id : ""));
    const [isSelectOpen, setIsSelectOpen] = useState(false);
    const [inputValue, setInputValue] = useState("");
    const [selectedRegionKey, setSelectedRegionKey] = useState(ALL_REGION_KEY);
    const [analysisScope, setAnalysisScope] = useState<AnalysisScope>("exam");
    const [selectedClassKey, setSelectedClassKey] = useState("");
    const [selectedStudentKey, setSelectedStudentKey] = useState("");
    const [kakaoReviews, setKakaoReviews] = useState<KakaoCandidateReviewMap>({});
    const [kakaoDispatchLogs, setKakaoDispatchLogs] = useState<KakaoDispatchLog[]>([]);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const lastAppliedInitialExamIdRef = useRef<string | undefined>(initialExamId);
    const advancedAnalyticsEnabled = hasPlanEntitlement(currentPlan, "advancedAnalytics");
    const retakeAssignmentsEnabled = hasPlanEntitlement(currentPlan, "retakeAssignments");
    const remindersEnabled = hasPlanEntitlement(currentPlan, "reminders");
    const kakaoProviderReadiness = useMemo(() => getKakaoProviderReadiness(), []);

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
    const allSelectedExamAttempts = useMemo(() => attempts.filter(a => a.examId === selectedExamId), [attempts, selectedExamId]);
    const baseExamAttempts = useMemo(() => allSelectedExamAttempts.filter(a => !a.retake), [allSelectedExamAttempts]);
    const baseRetakeAttempts = useMemo(() => allSelectedExamAttempts.filter(a => !!a.retake), [allSelectedExamAttempts]);
    const regionScopeOptions = useMemo(() => (
        buildRegionalLearningScopes({
            students: rosterStudents,
            groups: rosterGroups,
            attempts: baseExamAttempts,
            exams: selectedExam ? [selectedExam] : [],
        }).filter(scope => scope.attemptCount > 0)
    ), [baseExamAttempts, rosterGroups, rosterStudents, selectedExam]);
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
    const retakeAttempts = useMemo(() => (
        activeRegionKey === ALL_REGION_KEY
            ? baseRetakeAttempts
            : filterAttemptsByRegion(baseRetakeAttempts, activeRegionKey, rosterStudents, rosterGroups)
    ), [activeRegionKey, baseRetakeAttempts, rosterGroups, rosterStudents]);
    // Recovery vs the source attempt; sources are looked up in the unfiltered
    // pool because a retake can cross the current region filter.
    const retakeRecoverySummary = useMemo(() => {
        if (!selectedExam || retakeAttempts.length === 0) return null;
        return summarizeRetakeRecoveries(
            buildExamRetakeRecoveries(selectedExam, retakeAttempts, allSelectedExamAttempts),
        );
    }, [allSelectedExamAttempts, retakeAttempts, selectedExam]);
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

        const scores = examAttempts.map(attempt => summarizeAttemptScore(selectedExam, attempt).scorePercent);
        const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
        // reduce instead of Math.max(...scores)/Math.min(...scores) so we never blow the
        // call stack spreading a very large scores array.
        const maxScore = scores.reduce((hi, value) => Math.max(hi, value), scores[0]);
        const minScore = scores.reduce((lo, value) => Math.min(lo, value), scores[0]);
        const distribution = computeScoreDistribution(scores);
        const elapsedTimes = examAttempts.map(attemptElapsedTimeSec).filter(value => value > 0);
        const avgElapsedTimeSec = elapsedTimes.length > 0
            ? Math.round(elapsedTimes.reduce((sum, value) => sum + value, 0) / elapsedTimes.length)
            : 0;
        const handwritingArchiveCount = examAttempts.filter(attempt => (
            !!attempt.handwritingArchived && !!(attempt.handwriting?.strokesRef || attempt.drawingsRef)
        )).length;

        return {
            avgScore: Math.round(avgScore),
            maxScore: Math.round(maxScore),
            minScore: Math.round(minScore),
            medianScore: distribution.median,
            standardDeviation: distribution.standardDeviation,
            distributionBuckets: distribution.buckets,
            count: examAttempts.length,
            avgElapsedTimeSec,
            handwritingArchiveCount,
        };
    }, [selectedExam, examAttempts]);

    const questionBankReadiness = useMemo(() => {
        if (!selectedExam) return null;
        return buildQuestionBankReadiness(selectedExam, examAttempts);
    }, [selectedExam, examAttempts]);

    const regionalActionPlans = useMemo(() => {
        if (!selectedExam) return [];
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
    }, [baseExamAttempts, rosterGroups, rosterStudents, selectedExam]);
    const visibleRegionalActionPlans = useMemo(() => (
        activeRegionKey === ALL_REGION_KEY
            ? regionalActionPlans
            : regionalActionPlans.filter(plan => plan.regionKey === activeRegionKey)
    ), [activeRegionKey, regionalActionPlans]);

    const kakaoCandidateSummary = useMemo(() => {
        if (!selectedExam) return null;
        return buildKakaoNotificationCandidates({
            exams: [selectedExam],
            attempts: examAttempts,
            students: scopedRosterStudents,
            groups: scopedRosterGroups,
            limit: 6,
        });
    }, [examAttempts, scopedRosterGroups, scopedRosterStudents, selectedExam]);
    const kakaoReviewSummary = useMemo(() => {
        if (!kakaoCandidateSummary) return null;
        return summarizeKakaoCandidateReviews(kakaoCandidateSummary.candidates, kakaoReviews);
    }, [kakaoCandidateSummary, kakaoReviews]);
    const kakaoDispatchSummary = useMemo(() => {
        if (!kakaoCandidateSummary) return null;
        return summarizeKakaoDispatchLogs(kakaoDispatchLogs, kakaoCandidateSummary.candidates.map(candidate => candidate.id));
    }, [kakaoCandidateSummary, kakaoDispatchLogs]);

    const updateKakaoReviewStatus = (candidate: KakaoNotificationCandidate, status: KakaoCandidateReviewStatus) => {
        if (!remindersEnabled) return;
        try {
            const next = setKakaoCandidateReview(localStorage, candidate, status);
            setKakaoReviews(next);
            const record = next[candidate.id];
            void syncKakaoCandidateReviewRecord(record, candidate).then(result => {
                if (result.remoteError) {
                    console.warn("Kakao candidate review remote sync failed", result.remoteError);
                }
            });
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
        const result = updateKakaoDispatchLogStatus(localStorage, log.id, status, {
            providerMessageId: status === "sent" ? `simulation:${log.id}` : undefined,
            errorMessage: status === "failed" ? "provider 연동 전 수동 실패 기록" : undefined,
        });
        if (!result.log) return;
        setKakaoDispatchLogs(result.logs);
        void syncKakaoDispatchLog(result.log, record, candidate).then(syncResult => {
            if (syncResult.remoteError) {
                console.warn("Kakao dispatch status remote sync failed", syncResult.remoteError);
            }
        });
    };

    // Calculate Question Analytics
    const questionAnalytics = useMemo(() => {
        if (!selectedExam || examAttempts.length === 0) return [];

        const resultStats = buildExamQuestionResultStats(selectedExam, examAttempts);
        const statByQuestionId = new Map(resultStats.map(stat => [stat.questionId, stat]));
        const pointBiserialByQuestionId = buildExamQuestionPointBiserial(selectedExam, examAttempts);
        const resultsByAttemptId = new Map(examAttempts.map(attempt => [
            attempt.id,
            new Map(getAttemptQuestionResults(selectedExam, attempt).map(result => [result.questionId, result])),
        ]));
        const sortedByScore = [...examAttempts].sort((a, b) => {
            const aPct = summarizeAttemptScore(selectedExam, a).scorePercent;
            const bPct = summarizeAttemptScore(selectedExam, b).scorePercent;
            return bPct - aPct;
        });
        const splitSize = Math.max(1, Math.ceil(sortedByScore.length / 3));
        const upperGroup = sortedByScore.slice(0, splitSize);
        const lowerGroup = sortedByScore.slice(-splitSize);
        const rateForGroup = (group: Attempt[], questionId: number) => {
            if (group.length === 0) return 0;
            let total = 0;
            let correct = 0;
            for (const attempt of group) {
                const result = resultsByAttemptId.get(attempt.id)?.get(questionId);
                if (!result || !isGradableResult(result)) continue;
                total += 1;
                if (isCorrectResult(result)) correct += 1;
            }
            return safeRatePercent(correct, total);
        };

        return selectedExam.questions.map((q, qIndex) => {
            const stat = statByQuestionId.get(q.id);
            const choices = questionChoiceCount(q);
            const optionCounts: Record<number, number> = {
                ...Object.fromEntries(Array.from({ length: choices }, (_, i) => [i + 1, 0])),
                ...(stat?.optionCounts || {}),
            };
            const correctRate = stat?.correctRate ?? 0;
            const unansweredRate = stat?.unansweredRate ?? 0;
            const upperCorrectRate = rateForGroup(upperGroup, q.id);
            const lowerCorrectRate = rateForGroup(lowerGroup, q.id);
            const discrimination = upperCorrectRate - lowerCorrectRate;
            // With fewer than 5 respondents the upper/lower thirds overlap, so the
            // discrimination index is noise — flag it so the UI shows "-" and skips it.
            const discriminationReliable = examAttempts.length >= DISCRIMINATION_MIN_RESPONDENTS;

            const optionRates = Object.entries(optionCounts).map(([opt, count]) => ({
                option: parseInt(opt),
                count,
                rate: safeRatePercent(count, stat?.totalCount)
            }));
            const topWrongOption = optionRates
                .filter(item => item.option !== q.answer)
                .sort((a, b) => b.rate - a.rate)[0];

            return {
                index: qIndex + 1,
                id: q.id,
                label: q.label || '일반',
                concept: q.tags?.concept || q.label || '일반',
                unit: q.tags?.unit,
                difficulty: q.tags?.difficulty,
                mistakeTypes: q.tags?.mistakeTypes || [],
                expectedTimeSec: stat?.expectedTimeSec ?? q.tags?.expectedTimeSec,
                averageTimeSec: stat?.averageTimeSec,
                timeOverExpectedRate: stat?.timeOverExpectedRate,
                averageVisitCount: stat?.averageVisitCount,
                revisitRate: stat?.revisitRate ?? 0,
                answerChangeCount: stat?.answerChangeCount ?? 0,
                correctRate,
                correctCount: stat?.correctCount ?? 0,
                totalCount: stat?.totalCount ?? 0,
                wrongRate: stat?.wrongRate ?? 0,
                unansweredRate,
                discrimination,
                discriminationReliable,
                // 점이연 상관 기준 — statistically grounded item discrimination, shown in the
                // 문항별 상세 table in place of the upper/lower-third split above.
                pointBiserial: pointBiserialByQuestionId.get(q.id) ?? null,
                topWrongOption,
                optionRates,
                answer: q.answer,
                choices,
            };
        }).sort((a: { correctRate: number }, b: { correctRate: number }) => a.correctRate - b.correctRate); // Sort by hardest first
    }, [selectedExam, examAttempts]);

    const examLabels = useMemo(() => {
        if (!selectedExam) return [];
        return Array.from(new Set(selectedExam.questions.map(q => q.label || '일반')));
    }, [selectedExam]);

    const maxChoiceCount = useMemo(() => {
        if (!selectedExam) return DEFAULT_CHOICE_COUNT;
        return Math.max(DEFAULT_CHOICE_COUNT, ...selectedExam.questions.map(q => questionChoiceCount(q)));
    }, [selectedExam]);

    const studentScores = useMemo(() => {
        if (!selectedExam || examAttempts.length === 0) return [];
        return examAttempts.map(attempt => {
            const labelScores: Record<string, { earned: number, total: number }> = {};
            examLabels.forEach(l => labelScores[l] = { earned: 0, total: 0 });

            const results = getAttemptQuestionResults(selectedExam, attempt);
            results.forEach(result => {
                if (!isGradableResult(result)) return;
                const label = result.label || '일반';
                if (!labelScores[label]) labelScores[label] = { earned: 0, total: 0 };
                labelScores[label].total += result.score;
                labelScores[label].earned += result.earnedScore;
            });
            const scoreSummary = summarizeAttemptScore(selectedExam, attempt);

            return {
                studentName: attempt.studentName,
                totalScore: scoreSummary.earnedScore,
                scorePercentage: scoreSummary.scorePercent,
                labelScores,
                attempt
            };
        });
    }, [selectedExam, examAttempts, examLabels]);

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

        questionAnalytics.forEach(q => {
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
    }, [selectedExam, examAttempts, questionAnalytics]);

    // B4: this panel is about the HIGHEST wrong rate, so sort by wrongRate desc rather
    // than reusing questionAnalytics' lowest-correctRate ordering (which unanswered skews).
    const topWrongQuestions = useMemo(
        () => [...questionAnalytics].sort((a, b) => b.wrongRate - a.wrongRate).slice(0, 3),
        [questionAnalytics],
    );

    const teachingInsights = useMemo(() => {
        if (!examStats) return null;

        const weakConcept = conceptAnalytics[0];
        // Weak discrimination only counts within the 35–85% correct-rate band (outside it a
        // low index is expected, not a defect) and only when the index is reliable (n ≥ 5).
        const hasWeakDiscrimination = (q: typeof questionAnalytics[number]) =>
            q.discriminationReliable && q.discrimination < 10 && q.correctRate >= 35 && q.correctRate <= 85;
        const riskyQuestions = questionAnalytics.filter(q =>
            q.correctRate < 50 ||
            hasWeakDiscrimination(q) ||
            q.unansweredRate >= 20 ||
            (q.topWrongOption?.rate || 0) >= 30
        );
        const tooEasyCount = questionAnalytics.filter(q => q.correctRate >= 90).length;
        const weakDiscriminationCount = questionAnalytics.filter(hasWeakDiscrimination).length;
        const lowStudents = studentScores.filter(student => student.scorePercentage < 60);
        const borderlineStudents = studentScores.filter(student => student.scorePercentage >= 60 && student.scorePercentage < 80);
        const advancedStudents = studentScores.filter(student => student.scorePercentage >= 90);

        return {
            weakConcept,
            riskyQuestions: riskyQuestions.slice(0, 5),
            tooEasyCount,
            weakDiscriminationCount,
            lowStudents,
            borderlineStudents,
            advancedStudents,
            actionCopy: weakConcept
                ? `${weakConcept.concept} 보강 후 ${weakConcept.questionNumbers.slice(0, 4).join(", ")}번 유사문항 재응시`
                : "응시 데이터가 쌓이면 보강 우선순위를 계산합니다.",
        };
    }, [conceptAnalytics, examStats, questionAnalytics, studentScores]);

    const examTypeWeaknessGroups = useMemo(() => {
        // Feeds Pro-gated UI only — skip the recommendation pass when locked.
        if (!advancedAnalyticsEnabled) return [];
        if (!selectedExam || examAttempts.length === 0) return [];
        return buildLearningRecommendations(selectedExam, examAttempts, {
            scope: "exam",
            kinds: ["concept"],
            limit: 6,
        });
    }, [advancedAnalyticsEnabled, selectedExam, examAttempts]);

    const classWeaknessMatrixRows = useMemo(() => {
        // Feeds Pro-gated UI only — skip the per-class matrix when locked.
        if (!advancedAnalyticsEnabled) return [];
        if (!selectedExam || examAttempts.length === 0) return [];
        return buildClassExamWeaknessMatrix(selectedExam, examAttempts, {
            kinds: ["concept"],
            recommendationLimit: 2,
            classLimit: 6,
            rosterGroups: scopedRosterGroups,
            rosterStudents: scopedRosterStudents,
        });
    }, [advancedAnalyticsEnabled, examAttempts, scopedRosterGroups, scopedRosterStudents, selectedExam]);

    // Feeds the "반별 점수 비교" range-bar card — same Pro gate and grouping as the weakness
    // matrix above, but only needs raw score percentages (min/median/average/max), not the
    // recommendation machinery.
    const groupScoreSummaries = useMemo(() => {
        if (!advancedAnalyticsEnabled) return [];
        if (!selectedExam || examAttempts.length === 0) return [];
        const groups = buildClassExamScoreGroups(selectedExam, examAttempts, {
            rosterGroups: scopedRosterGroups,
            rosterStudents: scopedRosterStudents,
        });
        return computeGroupScoreSummary(groups.map(group => ({
            groupKey: group.groupKey,
            groupName: formatRegionScopedLabel(group.groupName, group.regionName),
            scores: group.scores,
        })));
    }, [advancedAnalyticsEnabled, examAttempts, scopedRosterGroups, scopedRosterStudents, selectedExam]);

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
        const results = collectQuestionResults(selectedExam, examAttempts, {
            groupKey: analysisScope === "class" ? activeClassKey : undefined,
            studentKey: analysisScope === "student" ? activeStudentKey : undefined,
        });
        return buildQuestionResultTagStats(results, "label").map(stat => ({
            label: stat.title,
            correctRate: stat.correctRate,
            wrongRate: stat.wrongRate,
            totalCount: stat.totalCount,
            averageTimeSec: stat.averageTimeSec,
        }));
    }, [activeClassKey, activeStudentKey, analysisScope, examAttempts, selectedExam]);

    const studentWeaknessByAttemptId = useMemo(() => {
        const map = new Map<string, LearningRecommendation>();
        if (!selectedExam || examAttempts.length === 0) return map;

        for (const attempt of examAttempts) {
            const studentKey = studentScopeKeyForAttempt(attempt);
            const topGroup = buildLearningRecommendations(selectedExam, examAttempts, {
                scope: "student",
                studentKey,
                kinds: ["concept"],
                limit: 1,
            })[0];
            if (topGroup) map.set(attempt.id, topGroup);
        }

        return map;
    }, [selectedExam, examAttempts]);

    const scopedWeaknessGroups = useMemo(() => {
        // Feeds the Pro-gated 분석 컷 전환 section only.
        if (!advancedAnalyticsEnabled) return [];
        if (!selectedExam || examAttempts.length === 0) return [];

        if (analysisScope === "class") {
            if (!activeClassKey) return [];
            return buildLearningRecommendations(selectedExam, examAttempts, {
                scope: "class",
                groupKey: activeClassKey,
                kinds: ["concept"],
                limit: 5,
            });
        }

        if (analysisScope === "student") {
            if (!activeStudentKey) return [];
            return buildLearningRecommendations(selectedExam, examAttempts, {
                scope: "student",
                studentKey: activeStudentKey,
                kinds: ["concept", "mistakeType"],
                limit: 6,
            });
        }

        return examTypeWeaknessGroups.slice(0, 5);
    }, [activeClassKey, activeStudentKey, advancedAnalyticsEnabled, analysisScope, examAttempts, examTypeWeaknessGroups, selectedExam]);

    const scopedSummary = useMemo(() => {
        if (analysisScope === "class") {
            const selected = classScopeOptions.find(group => group.key === activeClassKey);
            return selected
                ? `${selected.label} · 제출 ${selected.attemptCount}건 · 평균 ${selected.averageScoreRate}% · 참여 ${formatParticipationRateLabel(selected.participationRate)}${selected.missingStudentCount > 0 ? ` · 미응시 ${selected.missingStudentCount}명` : ""}`
                : "반 정보가 있는 제출이 없습니다.";
        }

        if (analysisScope === "student") {
            const selected = studentScopeOptions.find(student => student.key === activeStudentKey);
            return selected
                ? `${selected.label} · 점수 ${selected.scorePercentage}%`
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
        return buildSimilarQuestionGroups(selectedExam, examAttempts)
            .filter(group => group.wrongCount > 0)
            .slice(0, 6);
    }, [advancedAnalyticsEnabled, selectedExam, examAttempts]);

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

        const resultsByQuestionId = new Map(getAttemptQuestionResults(selectedExam, student.attempt).map(result => [result.questionId, result]));
        const rows: unknown[][] = [["문항 번호", "라벨(장르)", "배점", "학생 선택", "정답", "정오"]];

        selectedExam.questions.forEach((q, i) => {
            const result = resultsByQuestionId.get(q.id);
            rows.push([
                q.number || i + 1,
                result?.label || q.label || '일반',
                result?.score ?? 0,
                result?.selectedAnswer ?? '-',
                result?.correctAnswer ?? '-',
                resultStatusLabel(result),
            ]);
        });

        rows.push([]);
        rows.push(["장르별 통계"]);
        rows.push(["장르", "획득 점수", "만점"]);
        Object.entries(student.labelScores).forEach(([label, data]) => {
            rows.push([label, roundScoreValue(data.earned), roundScoreValue(data.total)]);
        });

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
        <div className="fade-in-up" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            {/* Filter Section */}
            <div className="card" style={{ padding: '1.5rem', display: 'flex', alignItems: 'center', gap: '1rem', background: 'var(--surface)' }}>
                <span style={{ fontWeight: 600, color: 'var(--text)' }}>분석할 시험 선택:</span>
                <div ref={dropdownRef} style={{ position: 'relative', flex: 1, maxWidth: '400px' }}>
                    <div
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            position: 'relative',
                            borderRadius: 'var(--radius-md)',
                            border: '1px solid var(--border)',
                            background: 'var(--background)',
                        }}
                    >
                        <input
                            type="text"
                            value={inputValue}
                            onChange={(e) => {
                                setInputValue(e.target.value);
                                setIsSelectOpen(true);
                            }}
                            onFocus={() => {
                                setIsSelectOpen(true);
                                setInputValue(""); // Clear input to allow fresh search
                            }}
                            onBlur={() => {
                                // Restore selected exam text if they didn't pick anything new
                                setTimeout(() => {
                                    if (!isSelectOpen) {
                                        const currentExam = exams.find(e => e.id === selectedExamId);
                                        if (currentExam) setInputValue(currentExam.title);
                                    }
                                }, 150);
                            }}
                            placeholder="시험을 검색하거나 선택하세요"
                            style={{
                                width: '100%',
                                padding: '0.75rem 1rem',
                                paddingRight: '2.5rem',
                                border: 'none',
                                background: 'transparent',
                                color: 'var(--text)',
                                outline: 'none',
                                cursor: 'text'
                            }}
                        />
                        <ChevronDown
                            size={18}
                            style={{
                                position: 'absolute',
                                right: '1rem',
                                pointerEvents: 'none',
                                transform: isSelectOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                                transition: 'transform 0.2s',
                                color: 'var(--muted)'
                            }}
                        />
                    </div>

                    {isSelectOpen && (
                        <div style={{
                            position: 'absolute',
                            top: '100%',
                            left: 0,
                            right: 0,
                            marginTop: '0.5rem',
                            background: 'var(--background)',
                            border: '1px solid var(--border)',
                            borderRadius: 'var(--radius-md)',
                            boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
                            zIndex: 50,
                            maxHeight: '300px',
                            overflowY: 'auto'
                        }}>
                            {filteredExams.length > 0 ? (
                                filteredExams.map(exam => (
                                    <div
                                        key={exam.id}
                                        onMouseDown={(e) => {
                                            // Handle click with onMouseDown so it fires before input onBlur
                                            e.preventDefault();
                                            setSelectedExamId(exam.id);
                                            setInputValue(exam.title);
                                            setIsSelectOpen(false);
                                            setSelectedClassKey("");
                                            setSelectedStudentKey("");
                                        }}
                                        style={{
                                            padding: '0.75rem 1rem',
                                            cursor: 'pointer',
                                            background: exam.id === selectedExamId ? 'var(--surface)' : 'transparent',
                                            color: exam.id === selectedExamId ? 'var(--primary)' : 'var(--text)',
                                            fontWeight: exam.id === selectedExamId ? 600 : 400,
                                        }}
                                        onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(99,102,241,0.06)'; }}
                                        onMouseLeave={(e) => { e.currentTarget.style.background = exam.id === selectedExamId ? 'var(--surface)' : 'transparent'; }}
                                    >
                                        {exam.title}
                                    </div>
                                ))
                            ) : (
                                <div style={{ padding: '1rem', textAlign: 'center', color: 'var(--muted)' }}>
                                    검색 결과가 없습니다
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>

            {regionScopeOptions.length > 0 && (
                <div className="card" style={{ padding: '1.2rem 1.35rem', display: 'flex', alignItems: 'center', gap: '1rem', background: 'var(--surface)', flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', fontWeight: 850, color: 'var(--foreground)' }}>
                        <MapPin size={17} color="var(--primary)" />
                        지역 분석 필터
                    </div>
                    <select
                        aria-label="시험 분석 지역 필터"
                        value={activeRegionKey}
                        onChange={event => {
                            setSelectedRegionKey(event.target.value);
                            setSelectedClassKey("");
                            setSelectedStudentKey("");
                        }}
                        style={{
                            minWidth: '180px',
                            padding: '0.6rem 0.8rem',
                            borderRadius: 'var(--radius-md)',
                            border: '1px solid var(--border)',
                            background: 'var(--background)',
                            color: 'var(--foreground)',
                            fontWeight: 800,
                        }}
                    >
                        <option value={ALL_REGION_KEY}>전체 지역</option>
                        {regionScopeOptions.map(scope => (
                            <option key={scope.regionKey} value={scope.regionKey}>
                                {scope.regionName} ({scope.attemptCount}건)
                            </option>
                        ))}
                    </select>
                    <div style={{ fontSize: '0.82rem', color: 'var(--muted)', lineHeight: 1.45 }}>
                        {activeRegionLabel} 기준 제출 {examAttempts.length}건으로 평균, 문항 정답률, 약점 유형을 다시 계산합니다.
                    </div>
                </div>
            )}

            {selectedExam && visibleRegionalActionPlans.length > 0 && (
                <div className="card" style={{ padding: '1.35rem', border: '1px solid var(--border)', background: 'var(--surface)' }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
                        <div>
                            <h3 style={{ fontSize: '1rem', fontWeight: 900, color: 'var(--foreground)', display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
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
                            const href = recommendation && buildRetakeHref(
                                selectedExam.id,
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
                                                제출 {plan.attemptCount}건 · 평균 {plan.averageScore}점 · 오답 {plan.wrongQuestionCount}문항
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
                                            주의 학생 {plan.studentsNeedingAttention.length}명
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

            {selectedExam && kakaoCandidateSummary && kakaoCandidateSummary.totalCount > 0 && (
                <div className="card" style={{ padding: '1.35rem', border: '1px solid var(--border)', background: 'var(--surface)' }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
                        <div>
                            <h3 style={{ fontSize: '1rem', fontWeight: 900, color: 'var(--foreground)', display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
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
                            color: '#b45309',
                            background: '#fffbeb',
                            border: '1px solid #fde68a',
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
                                { label: "발송 준비", value: kakaoReviewSummary.ready, status: "ready" as const },
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
                                { label: "발송 대기 기록", value: kakaoDispatchSummary.queued, color: 'var(--primary)' },
                                { label: "발송 완료 기록", value: kakaoDispatchSummary.sent, color: 'var(--success)' },
                                { label: "발송 실패 기록", value: kakaoDispatchSummary.failed, color: 'var(--error)' },
                                { label: "발송 취소 기록", value: kakaoDispatchSummary.cancelled, color: 'var(--warning)' },
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
                                            lockedTitle="Pro 이상에서 카카오 후보를 검토하고 발송 준비할 수 있습니다."
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
                                            title={!kakaoProviderReadiness.canQueueDispatch ? kakaoProviderReadiness.detail : reviewStatus === "ready" ? "발송 대기 로그를 남깁니다." : "발송 준비 상태에서 대기 기록을 남길 수 있습니다."}
                                            style={{
                                                fontSize: '0.74rem',
                                                padding: '0.38rem 0.68rem',
                                                borderRadius: 'var(--radius-md)',
                                                opacity: canQueueDispatch ? 1 : 0.55,
                                                whiteSpace: 'nowrap',
                                            }}
                                        >
                                            발송 대기 기록
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

            {selectedExam && questionBankReadiness && (
                <div className="card" style={{ padding: '1.5rem', border: '1px solid var(--border)', background: 'var(--surface)' }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
                        <div>
                            <h3 style={{ fontSize: '1rem', fontWeight: 900, color: 'var(--foreground)', display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
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

                    <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
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

            {selectedExam && !advancedAnalyticsEnabled && (
                <PremiumFeatureCard
                    title="고급 분석 잠금"
                    description="Free에서는 기본 통계와 정오표를 확인합니다. Pro 이상에서 분석 컷 전환, 반별 매트릭스, 유형 재추천 큐, 풀이 행동 신호를 사용할 수 있습니다."
                    badge="Pro"
                />
            )}

            {examStats ? (
                <>
                    {/* Stats Summary */}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(150px, 100%), 1fr))', gap: '1rem' }}>
                        {[
                            { label: '평균 점수', value: `${examStats.avgScore}%`, color: 'var(--primary)' },
                            { label: '중앙값', value: `${examStats.medianScore}%`, color: '#6366f1' },
                            { label: '표준편차', value: `${examStats.standardDeviation}`, color: '#8b5cf6' },
                            { label: '최고 점수', value: `${examStats.maxScore}%`, color: 'var(--success)' },
                            { label: '최저 점수', value: `${examStats.minScore}%`, color: 'var(--warning)' },
                            { label: '응시 인원', value: `${examStats.count}명`, color: 'var(--text)' },
                            { label: '평균 응시시간', value: formatSeconds(examStats.avgElapsedTimeSec), color: '#0ea5e9' },
                            { label: '필기 보관', value: `${examStats.handwritingArchiveCount}건`, color: '#7c3aed' },
                            { label: '재시험 제출', value: `${retakeAttempts.length}건`, color: '#0f766e' },
                            ...(retakeRecoverySummary?.recoveryRate !== undefined ? [{
                                label: '재시험 회복률',
                                value: `${retakeRecoverySummary.recoveryRate}% (${retakeRecoverySummary.recoveredCount}/${retakeRecoverySummary.targetCount})`,
                                color: '#16a34a',
                            }] : []),
                        ].map((stat, i) => (
                            <div key={i} className="card" style={{ padding: '1.5rem', textAlign: 'center', borderTop: `4px solid ${stat.color}` }}>
                                <div style={{ fontSize: '0.9rem', color: 'var(--muted)', marginBottom: '0.5rem' }}>{stat.label}</div>
                                <div style={{ fontSize: '2rem', fontWeight: 800, color: stat.color }}>{stat.value}</div>
                            </div>
                        ))}
                    </div>

                    {examStats.distributionBuckets.some(bucket => bucket.count > 0) && (
                        <div className="card" style={{ padding: '1.5rem' }}>
                            <h3 style={{ fontSize: '1.1rem', fontWeight: 700, marginBottom: '0.35rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                <BarChart2 size={18} color="var(--primary)" />
                                점수 분포
                            </h3>
                            <p style={{ fontSize: '0.82rem', color: 'var(--muted)', marginBottom: '1.25rem' }}>
                                10점 구간별 응시 인원 분포입니다. (중앙값 {examStats.medianScore}% · 표준편차 {examStats.standardDeviation})
                            </p>
                            <div style={{ height: '260px', width: '100%', minWidth: 0 }}>
                                <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={260} initialDimension={{ width: 720, height: 260 }}>
                                    <BarChart data={examStats.distributionBuckets} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
                                        <XAxis dataKey="label" tick={{ fill: 'var(--muted)', fontSize: 12 }} axisLine={false} tickLine={false} />
                                        <YAxis allowDecimals={false} tick={{ fill: 'var(--muted)' }} axisLine={false} tickLine={false} />
                                        <RechartsTooltip
                                            cursor={{ fill: 'rgba(99, 102, 241, 0.05)' }}
                                            contentStyle={{ borderRadius: '8px', border: '1px solid var(--border)', boxShadow: '0 4px 12px rgba(0,0,0,0.05)', background: 'var(--background)', color: 'var(--foreground)' }}
                                            formatter={(value: number | string | undefined) => [`${value}명`, '응시 인원']}
                                            labelFormatter={(label) => `${label}점`}
                                        />
                                        <Bar dataKey="count" fill="var(--primary)" radius={[4, 4, 0, 0]} animationDuration={1200} />
                                    </BarChart>
                                </ResponsiveContainer>
                            </div>
                        </div>
                    )}

                    {teachingInsights && (
                        <div className="card" style={{ padding: '1.5rem', background: 'var(--surface)', border: '1px solid var(--border)' }}>
                            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem', marginBottom: '1.25rem' }}>
                                <div>
                                    <h3 style={{ fontSize: '1.1rem', fontWeight: 800, display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.3rem' }}>
                                        <Lightbulb size={18} color="var(--primary)" />
                                        강사용 다음 액션
                                    </h3>
                                    <p style={{ fontSize: '0.82rem', color: 'var(--muted)', fontWeight: 500 }}>
                                        점수 확인 후 바로 수업 운영에 쓰는 진단 요약입니다.
                                    </p>
                                </div>
                                <span style={{
                                    fontSize: '0.72rem',
                                    fontWeight: 800,
                                    color: 'var(--primary)',
                                    background: 'rgba(99,102,241,0.1)',
                                    border: '1px solid rgba(99,102,241,0.18)',
                                    padding: '0.25rem 0.65rem',
                                    borderRadius: 'var(--radius-full)',
                                    whiteSpace: 'nowrap'
                                }}>
                                    Teacher UX
                                </span>
                            </div>

                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(190px, 100%), 1fr))', gap: '1rem', marginBottom: '1.25rem' }}>
                                <div style={{ padding: '1rem', borderRadius: 'var(--radius-md)', background: 'var(--background)', border: '1px solid var(--border)' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', fontSize: '0.82rem', fontWeight: 800, color: 'var(--primary)', marginBottom: '0.55rem' }}>
                                        <Target size={15} />
                                        오늘 보강
                                    </div>
                                    <div style={{ fontSize: '1rem', fontWeight: 800, color: 'var(--foreground)', lineHeight: 1.35 }}>
                                        {teachingInsights.weakConcept?.concept || '데이터 대기'}
                                    </div>
                                    <div style={{ fontSize: '0.78rem', color: 'var(--muted)', marginTop: '0.45rem', lineHeight: 1.45 }}>
                                        {teachingInsights.actionCopy}
                                    </div>
                                </div>

                                <div style={{ padding: '1rem', borderRadius: 'var(--radius-md)', background: 'var(--background)', border: '1px solid var(--border)' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', fontSize: '0.82rem', fontWeight: 800, color: 'var(--warning)', marginBottom: '0.55rem' }}>
                                        <AlertTriangle size={15} />
                                        문항 품질 점검
                                    </div>
                                    <div style={{ fontSize: '1rem', fontWeight: 800, color: 'var(--foreground)', lineHeight: 1.35 }}>
                                        {teachingInsights.riskyQuestions.length}문항 재검토
                                    </div>
                                    <div style={{ fontSize: '0.78rem', color: 'var(--muted)', marginTop: '0.45rem', lineHeight: 1.45 }}>
                                        변별 약함 {teachingInsights.weakDiscriminationCount}개, 쉬운 문항 {teachingInsights.tooEasyCount}개
                                    </div>
                                </div>

                                <div style={{ padding: '1rem', borderRadius: 'var(--radius-md)', background: 'var(--background)', border: '1px solid var(--border)' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', fontSize: '0.82rem', fontWeight: 800, color: 'var(--success)', marginBottom: '0.55rem' }}>
                                        <Users size={15} />
                                        반 운영
                                    </div>
                                    <div style={{ fontSize: '1rem', fontWeight: 800, color: 'var(--foreground)', lineHeight: 1.35 }}>
                                        보충 {teachingInsights.lowStudents.length}명 · 심화 {teachingInsights.advancedStudents.length}명
                                    </div>
                                    <div style={{ fontSize: '0.78rem', color: 'var(--muted)', marginTop: '0.45rem', lineHeight: 1.45 }}>
                                        60~79점 구간 {teachingInsights.borderlineStudents.length}명은 다음 시험 전 개념 점검 권장
                                    </div>
                                </div>
                            </div>

                            {conceptAnalytics.length > 0 && (
                                <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
                                    <table style={{ width: '100%', minWidth: '680px', borderCollapse: 'collapse', textAlign: 'left' }}>
                                        <thead style={{ background: 'var(--background)', color: 'var(--muted)', fontSize: '0.78rem' }}>
                                            <tr>
                                                <th style={{ padding: '0.75rem 0.9rem' }}>보강 우선순위</th>
                                                <th style={{ padding: '0.75rem 0.9rem' }}>정답률</th>
                                                <th style={{ padding: '0.75rem 0.9rem' }}>문항</th>
                                                <th style={{ padding: '0.75rem 0.9rem' }}>오답 원인 힌트</th>
                                                <th style={{ padding: '0.75rem 0.9rem' }}>수업 조치</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {conceptAnalytics.slice(0, 6).map((item, index) => {
                                                const isWeak = item.correctRate < 60;
                                                const action = isWeak
                                                    ? '개념 재설명 + 유사문항 3개'
                                                    : item.correctRate < 80
                                                        ? '짧은 확인 문제'
                                                        : '심화 변형문항';
                                                return (
                                                    <tr key={item.concept} style={{ borderTop: '1px solid var(--border)' }}>
                                                        <td style={{ padding: '0.8rem 0.9rem', fontWeight: 800, color: index === 0 ? 'var(--error)' : 'var(--foreground)' }}>
                                                            {index + 1}. {item.concept}
                                                        </td>
                                                        <td style={{ padding: '0.8rem 0.9rem' }}>
                                                            <span style={{
                                                                color: item.correctRate < 60 ? 'var(--error)' : item.correctRate < 80 ? 'var(--warning)' : 'var(--success)',
                                                                fontWeight: 900,
                                                            }}>
                                                                {item.correctRate}%
                                                            </span>
                                                        </td>
                                                        <td style={{ padding: '0.8rem 0.9rem', color: 'var(--muted)', fontWeight: 700 }}>
                                                            {item.questionNumbers.join(', ')}번
                                                            {item.hardCount > 0 && (
                                                                <span style={{ marginLeft: '0.4rem', color: 'var(--warning)' }}>심화 {item.hardCount}</span>
                                                            )}
                                                        </td>
                                                        <td style={{ padding: '0.8rem 0.9rem', color: 'var(--muted)' }}>
                                                            {item.mistakeTypes.slice(0, 3).join(', ') || '오답 선택률 확인'}
                                                        </td>
                                                        <td style={{ padding: '0.8rem 0.9rem', fontWeight: 800, color: isWeak ? 'var(--primary)' : 'var(--muted)' }}>
                                                            {action}
                                                        </td>
                                                    </tr>
                                                );
                                            })}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </div>
                    )}

                    {advancedAnalyticsEnabled && (
                    <div className="card" style={{ padding: '1.5rem', border: '1px solid var(--border)', background: 'var(--surface)' }}>
                        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
                            <div>
                                <h3 style={{ fontSize: '1rem', fontWeight: 900, color: 'var(--foreground)', display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                                    <Target size={16} color="var(--primary)" />
                                    분석 컷 전환
                                </h3>
                                <p style={{ fontSize: '0.8rem', color: 'var(--muted)', marginTop: '0.2rem' }}>
                                    같은 시험 데이터를 시험 전체, 반, 학생 기준으로 잘라 약점 유형을 다시 계산합니다.
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
                                {scopedSummary}
                            </span>
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
                                                {student.label} ({student.scorePercentage}%)
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
                                                href={buildRetakeHref(selectedExamId, group.sourceAttemptId, retakeIds, group.retakeMode, {
                                                    labels: group.retakeLabels,
                                                    concepts: group.retakeConcepts,
                                                })}
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

                    {advancedAnalyticsEnabled && (
                        <div className="card" style={{ padding: '1.5rem', border: '1px solid var(--border)', background: 'var(--surface)' }}>
                            <div style={{ marginBottom: '1.25rem' }}>
                                <h3 style={{ fontSize: '1rem', fontWeight: 900, color: 'var(--foreground)', display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
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

                    {advancedAnalyticsEnabled && classWeaknessMatrixRows.length > 0 && (
                        <div className="card" style={{ padding: '1.5rem', border: '1px solid var(--border)', background: 'var(--surface)' }}>
                            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
                                <div>
                                    <h3 style={{ fontSize: '1rem', fontWeight: 900, color: 'var(--foreground)', display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                                        <Users size={16} color="var(--primary)" />
                                        반별 시험 분석 매트릭스
                                    </h3>
                                    <p style={{ fontSize: '0.8rem', color: 'var(--muted)', marginTop: '0.2rem' }}>
                                        같은 시험을 반별로 잘라 평균, 참여율, 오답 압력, 집중 문항, 재추천 대상을 비교합니다.
                                    </p>
                                </div>
                                <span style={{
                                    fontSize: '0.72rem',
                                    fontWeight: 900,
                                    color: '#0f766e',
                                    background: '#f0fdfa',
                                    border: '1px solid #99f6e4',
                                    padding: '0.24rem 0.6rem',
                                    borderRadius: 'var(--radius-full)',
                                    whiteSpace: 'nowrap',
                                }}>
                                    Class cut
                                </span>
                            </div>

                            <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
                                <table style={{ width: '100%', minWidth: '860px', borderCollapse: 'collapse', textAlign: 'left' }}>
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
                                                            color: row.averageScorePercent < 60 ? 'var(--error)' : row.averageScorePercent < 80 ? 'var(--warning)' : 'var(--success)',
                                                        }}>
                                                            {row.averageScorePercent}%
                                                        </span>
                                                    </td>
                                                    <td style={{ padding: '0.85rem 0.9rem' }}>
                                                        <div style={{ fontWeight: 900, color: pressureColor }}>{row.wrongRate}%</div>
                                                        <div style={{ fontSize: '0.74rem', color: 'var(--muted)', marginTop: '0.15rem' }}>
                                                            {row.wrongCount}/{row.totalCount}
                                                        </div>
                                                    </td>
                                                    <td style={{ padding: '0.85rem 0.9rem', color: 'var(--muted)', fontWeight: 800 }}>
                                                        {row.focusQuestionNumbers.length > 0 ? `${row.focusQuestionNumbers.join(', ')}번` : '안정'}
                                                    </td>
                                                    <td style={{ padding: '0.85rem 0.9rem' }}>
                                                        {topRecommendation ? (
                                                            <div style={{ minWidth: '150px' }}>
                                                                <div style={{ fontWeight: 900, color: 'var(--foreground)' }}>{topRecommendation.title}</div>
                                                                <div style={{ fontSize: '0.74rem', color: 'var(--muted)', marginTop: '0.16rem' }}>
                                                                    {topRecommendation.basis} · {topRecommendation.wrongRate}%
                                                                </div>
                                                            </div>
                                                        ) : (
                                                            <span style={{ color: 'var(--success)', fontSize: '0.8rem', fontWeight: 900 }}>추가 보강 없음</span>
                                                        )}
                                                    </td>
                                                    <td style={{ padding: '0.85rem 0.9rem', textAlign: 'right' }}>
                                                        {topRecommendation && retakeIds.length > 0 ? (
                                                            <PremiumActionLink
                                                                enabled={retakeAssignmentsEnabled}
                                                                href={buildRetakeHref(selectedExamId, topRecommendation.sourceAttemptId, retakeIds, topRecommendation.retakeMode, {
                                                                    labels: topRecommendation.retakeLabels,
                                                                    concepts: topRecommendation.retakeConcepts,
                                                                })}
                                                                className="btn btn-secondary"
                                                                style={{ fontSize: '0.74rem', padding: '0.34rem 0.65rem', whiteSpace: 'nowrap' }}
                                                                lockedTitle="Pro 이상에서 반별 재시험 세트를 만들 수 있습니다."
                                                            >
                                                                반별 세트
                                                            </PremiumActionLink>
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

                    {advancedAnalyticsEnabled && (examTypeWeaknessGroups.length > 0 || classTypeWeaknessRows.length > 0) && (
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))', gap: '1.5rem' }}>
                            <div className="card" style={{ padding: '1.5rem', border: '1px solid var(--border)', background: 'var(--surface)' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', marginBottom: '1rem' }}>
                                    <div>
                                        <h3 style={{ fontSize: '1rem', fontWeight: 800, color: 'var(--foreground)', display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                                            <Target size={16} color="var(--primary)" />
                                            유형 재추천 큐
                                        </h3>
                                        <p style={{ fontSize: '0.8rem', color: 'var(--muted)', marginTop: '0.2rem' }}>
                                            저장된 문항별 결과 데이터로 오답률이 높은 개념을 바로 묶습니다.
                                        </p>
                                    </div>
                                    <span style={{
                                        fontSize: '0.72rem',
                                        fontWeight: 800,
                                        color: '#0f766e',
                                        background: '#f0fdfa',
                                        border: '1px solid #99f6e4',
                                        padding: '0.22rem 0.55rem',
                                        borderRadius: '999px',
                                        whiteSpace: 'nowrap',
                                        height: 'fit-content',
                                    }}>
                                        Result rows
                                    </span>
                                </div>

                                {examTypeWeaknessGroups.length > 0 ? (
                                    <div style={{ display: 'grid', gap: '0.65rem' }}>
                                        {examTypeWeaknessGroups.map(group => {
                                            const retakeIds = group.retakeQuestionIds;
                                            return (
                                                <div key={group.key} style={{
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
                                                        href={buildRetakeHref(selectedExamId, group.sourceAttemptId, retakeIds, group.retakeMode, {
                                                            labels: group.retakeLabels,
                                                            concepts: group.retakeConcepts,
                                                        })}
                                                        className="btn btn-secondary"
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

                            <div className="card" style={{ padding: '1.5rem', border: '1px solid var(--border)', background: 'var(--surface)' }}>
                                <h3 style={{ fontSize: '1rem', fontWeight: 800, color: 'var(--foreground)', display: 'flex', alignItems: 'center', gap: '0.45rem', marginBottom: '0.25rem' }}>
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
                                                        <span style={{ color: 'var(--error)', fontSize: '0.78rem', fontWeight: 900 }}>
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
                                                        href={buildRetakeHref(selectedExamId, row.topGroup.sourceAttemptId, retakeIds, row.topGroup.retakeMode, {
                                                            labels: row.topGroup.retakeLabels,
                                                            concepts: row.topGroup.retakeConcepts,
                                                        })}
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

                    {advancedAnalyticsEnabled && (similarQuestionGroups.length > 0 || behaviorRows.length > 0) && (
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))', gap: '1.5rem' }}>
                            <div className="card" style={{ padding: '1.5rem', border: '1px solid var(--border)', background: 'var(--surface)' }}>
                                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem', marginBottom: '1rem' }}>
                                    <div>
                                        <h3 style={{ fontSize: '1rem', fontWeight: 800, color: 'var(--foreground)', display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                                            <Target size={16} color="var(--primary)" />
                                            유사 유형 소팅
                                        </h3>
                                        <p style={{ fontSize: '0.8rem', color: 'var(--muted)', marginTop: '0.2rem' }}>
                                            같은 지문/작품, 개념, 단원 기준으로 오답 압력이 높은 묶음입니다.
                                        </p>
                                    </div>
                                    <span style={{
                                        fontSize: '0.72rem',
                                        fontWeight: 800,
                                        color: '#0f766e',
                                        background: '#f0fdfa',
                                        border: '1px solid #99f6e4',
                                        padding: '0.22rem 0.55rem',
                                        borderRadius: '999px',
                                        whiteSpace: 'nowrap',
                                    }}>
                                        Premium
                                    </span>
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
                                                    href={buildRetakeHref(selectedExamId, `exam:${selectedExamId}`, group.questionIds, "similar", {
                                                        labels: group.labels,
                                                        concepts: group.concepts,
                                                    })}
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

                            <div className="card" style={{ padding: '1.5rem', border: '1px solid var(--border)', background: 'var(--surface)' }}>
                                <h3 style={{ fontSize: '1rem', fontWeight: 800, color: 'var(--foreground)', display: 'flex', alignItems: 'center', gap: '0.45rem', marginBottom: '0.25rem' }}>
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

                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))', gap: '1.5rem' }}>
                        {/* Radar Chart for labels */}
                        <div className="card" style={{ padding: '1.5rem', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-xl)', position: 'relative', overflow: 'hidden', minWidth: 0 }}>
                            {/* Decorative background */}
                            <div style={{
                                position: 'absolute', top: '-30px', right: '-30px',
                                width: '200px', height: '200px',
                                background: 'radial-gradient(circle, rgba(99,102,241,0.08) 0%, transparent 70%)',
                                pointerEvents: 'none', filter: 'blur(20px)'
                            }} />

                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.25rem', position: 'relative' }}>
                                <div>
                                    <h3 style={{ fontSize: '1rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '0.5rem', letterSpacing: '-0.01em' }}>
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
                                    <div style={{ height: '300px', width: '100%', minWidth: 0, position: 'relative' }}>
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
                                                    animationDuration={1400}
                                                    animationEasing="ease-out"
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
                                                    formatter={(value: number | string | undefined) => [`${value}%`, '정답률']}
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
                        <div className="card" style={{ padding: '1.5rem', minWidth: 0 }}>
                            <h3 style={{ fontSize: '1.1rem', fontWeight: 700, marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                <AlertTriangle size={18} color="var(--error)" />
                                오답률이 가장 높은 문항 Top 3
                            </h3>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                                {topWrongQuestions.map((q, i) => {
                                    const discriminationText = q.discriminationReliable ? `${q.discrimination}%` : '-';
                                    return (
                                    <div key={i} style={{
                                        padding: '1rem',
                                        borderRadius: 'var(--radius-md)',
                                        background: 'rgba(239, 68, 68, 0.05)',
                                        borderLeft: '4px solid var(--error)',
                                        display: 'flex',
                                        justifyContent: 'space-between',
                                        alignItems: 'center'
                                    }}>
                                        <div>
                                            <div style={{ fontWeight: 700, fontSize: '1.1rem', color: 'var(--error)', marginBottom: '0.2rem' }}>
                                                {q.index}번 문항 ({q.label})
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
                                            <div style={{ fontWeight: 800, fontSize: '1.2rem', color: 'var(--error)' }}>
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
                    <div className="card" style={{ padding: '1.5rem' }}>
                        <h3 style={{ fontSize: '1.1rem', fontWeight: 700, marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <CheckCircle size={18} color="var(--success)" />
                            문항별 상세 정답률
                        </h3>
                        <div style={{ height: '300px', width: '100%', minWidth: 0, marginBottom: '2rem' }}>
                            <ResponsiveContainer
                                width="100%"
                                height="100%"
                                minWidth={0}
                                minHeight={300}
                                initialDimension={{ width: 900, height: 300 }}
                            >
                                <BarChart data={[...questionAnalytics].sort((a: { index: number }, b: { index: number }) => a.index - b.index)}>
                                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
                                    <XAxis dataKey="index" tickFormatter={(v) => `${v}번`} tick={{ fill: 'var(--muted)' }} axisLine={false} tickLine={false} />
                                    <YAxis domain={[0, 100]} tick={{ fill: 'var(--muted)' }} axisLine={false} tickLine={false} />
                                    <RechartsTooltip
                                        cursor={{ fill: 'rgba(99, 102, 241, 0.05)' }}
                                        contentStyle={{ borderRadius: '8px', border: '1px solid var(--border)', boxShadow: '0 4px 12px rgba(0,0,0,0.05)', background: 'var(--background)' }}
                                        formatter={(value: number | string | undefined) => [`${value}%`, '정답률']}
                                        labelFormatter={(label) => `${label}번 문항`}
                                    />
                                    <Bar dataKey="correctRate" fill="var(--primary)" radius={[4, 4, 0, 0]} animationDuration={1500} />
                                </BarChart>
                            </ResponsiveContainer>
                        </div>

                        {/* Option Selection Rates Table */}
                        <h4 style={{ fontSize: '1.05rem', fontWeight: 700, marginTop: '1rem', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <List size={16} color="var(--primary)" />
                            세부사항: 문항별 선택률
                        </h4>
                        <div style={{ overflowX: 'auto' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', minWidth: '820px' }}>
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
                                    {[...questionAnalytics].sort((a: { index: number }, b: { index: number }) => a.index - b.index).map((q, i) => {
                                        const optMap = q.optionRates.reduce((acc: Record<number, number>, curr: { option: number; rate: number }) => { acc[curr.option] = curr.rate; return acc; }, {});
                                        const weakPointBiserial = q.pointBiserial !== null && q.pointBiserial < WEAK_POINT_BISERIAL_THRESHOLD;
                                        const qualityLabel = q.correctRate < 50
                                            ? '보강'
                                            : weakPointBiserial
                                                ? '변별 점검'
                                                : q.correctRate >= 90
                                                    ? '쉬움'
                                                    : '정상';
                                        return (
                                            <tr
                                                key={i}
                                                style={{ borderBottom: '1px solid var(--border)' }}
                                                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(99,102,241,0.06)'; }}
                                                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                                            >
                                                <td style={{ padding: '0.75rem 1rem', fontWeight: 600 }}>
                                                    {q.index}번
                                                    <span style={{ fontSize: '0.75rem', color: 'var(--muted)', fontWeight: 400 }}> ({q.concept})</span>
                                                    {q.difficulty && (
                                                        <span style={{ marginLeft: '0.35rem', fontSize: '0.7rem', color: 'var(--primary)', fontWeight: 800 }}>
                                                            {difficultyLabelMap[q.difficulty] || q.difficulty}
                                                        </span>
                                                    )}
                                                </td>
                                                <td style={{ padding: '0.75rem 1rem' }}>
                                                    <span style={{
                                                        padding: '0.22rem 0.48rem',
                                                        borderRadius: '999px',
                                                        fontSize: '0.72rem',
                                                        fontWeight: 900,
                                                        background: qualityLabel === '정상' ? 'rgba(16,185,129,0.08)' : 'rgba(245,158,11,0.1)',
                                                        color: qualityLabel === '정상' ? 'var(--success)' : 'var(--warning)',
                                                        whiteSpace: 'nowrap',
                                                    }}>
                                                        {qualityLabel}
                                                    </span>
                                                </td>
                                                <td style={{ padding: '0.75rem 1rem', fontWeight: 600, color: q.correctRate < 40 ? 'var(--error)' : 'var(--text)' }}>
                                                    {q.correctRate}%
                                                </td>
                                                <td
                                                    style={{ padding: '0.75rem 1rem', fontWeight: 700, color: weakPointBiserial ? 'var(--warning)' : 'var(--muted)' }}
                                                    title="점이연 상관 기준"
                                                >
                                                    {q.pointBiserial !== null ? q.pointBiserial.toFixed(2) : '-'}
                                                </td>
                                                <td style={{ padding: '0.75rem 1rem', fontWeight: 700, color: q.unansweredRate >= 20 ? 'var(--error)' : 'var(--muted)' }}>
                                                    {q.unansweredRate}%
                                                </td>
                                                <td style={{ padding: '0.75rem 1rem', color: q.timeOverExpectedRate && q.timeOverExpectedRate >= 130 ? 'var(--warning)' : 'var(--muted)', fontWeight: 800 }}>
                                                    {q.averageTimeSec ? formatSeconds(q.averageTimeSec) : '-'}
                                                    {q.timeOverExpectedRate ? (
                                                        <div style={{ fontSize: '0.7rem', color: 'var(--muted)', marginTop: '0.12rem', fontWeight: 700 }}>
                                                            기대 {q.timeOverExpectedRate}%
                                                        </div>
                                                    ) : null}
                                                </td>
                                                <td style={{ padding: '0.75rem 1rem', color: q.revisitRate >= 40 ? 'var(--primary)' : 'var(--muted)', fontWeight: 800 }}>
                                                    {q.revisitRate}%
                                                    <div style={{ fontSize: '0.7rem', color: 'var(--muted)', marginTop: '0.12rem', fontWeight: 700 }}>
                                                        변경 {q.answerChangeCount}회
                                                    </div>
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
                                                                {isAvailableOption ? `${optMap[optNum] || 0}%` : '-'}
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

                    {/* Student Scores Section */}
                    <div className="card" style={{ padding: '1.5rem', marginTop: '1.5rem' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
                            <h3 style={{ fontSize: '1.1rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                <AlertTriangle size={18} color="var(--primary)" style={{ visibility: 'hidden' }} />
                                학생별 점수 및 성취도 (장르별)
                            </h3>
                        </div>

                        <div
                            data-testid="exam-analytics-student-table-scroll"
                            style={{ overflowX: 'auto', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border)' }}
                        >
                            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', minWidth: '940px' }}>
                                <thead style={{ background: 'var(--surface)' }}>
                                    <tr>
                                        <th
                                            onClick={() => handleSort('name')}
                                            style={{ padding: '1rem', fontSize: '0.85rem', color: 'var(--muted)', cursor: 'pointer', transition: 'color 0.2s' }}
                                            onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--primary)'; }}
                                            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--muted)'; }}
                                        >
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                                학생 이름 {sortField === 'name' ? (sortDir === 'asc' ? <ChevronUp size={14} /> : <ChevronDown size={14} />) : ''}
                                            </div>
                                        </th>
                                        <th
                                            onClick={() => handleSort('score')}
                                            style={{ padding: '1rem', fontSize: '0.85rem', color: 'var(--muted)', cursor: 'pointer', transition: 'color 0.2s' }}
                                            onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--primary)'; }}
                                            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--muted)'; }}
                                        >
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                                총점 {sortField === 'score' ? (sortDir === 'asc' ? <ChevronUp size={14} /> : <ChevronDown size={14} />) : ''}
                                            </div>
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
                                    {sortedStudentScores.map((student, i) => {
                                        const behavior = summarizeAttemptBehavior(student.attempt);
                                        const retakeIds = selectedExam ? buildRetakeQuestionIds(selectedExam, student.attempt) : [];
                                        const topWeakness = studentWeaknessByAttemptId.get(student.attempt.id);
                                        return (
                                            <tr
                                                key={i}
                                                style={{ borderTop: '1px solid var(--border)' }}
                                                onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(99,102,241,0.06)'; }}
                                                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                                            >
                                                <td style={{ padding: '1rem', fontWeight: 600 }}>{student.studentName}</td>
                                                <td style={{ padding: '1rem' }}>
                                                    <div style={{ fontWeight: 800, color: student.scorePercentage >= 80 ? 'var(--success)' : (student.scorePercentage < 50 ? 'var(--error)' : 'var(--text)') }}>
                                                        {Number(student.totalScore.toFixed(2))}점 <span style={{ fontSize: '0.8rem', color: 'var(--muted)', fontWeight: 400 }}>({student.scorePercentage}%)</span>
                                                    </div>
                                                </td>
                                                {/* Dynamic Label Columns */}
                                                {examLabels.map(label => {
                                                    const ls = student.labelScores[label];
                                                    const rate = safeRatePercent(ls.earned, ls.total);
                                                    return (
                                                        <td key={label} style={{ padding: '1rem' }}>
                                                            <div style={{ fontSize: '0.9rem', fontWeight: 600 }}>{ls.earned} / {ls.total}</div>
                                                            <div style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>정답률 {rate}%</div>
                                                        </td>
                                                    );
                                                })}
                                                <td style={{ padding: '1rem' }}>
                                                    {topWeakness ? (
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
                                                    {retakeIds.length > 0 ? (
                                                        <PremiumActionLink
                                                            enabled={retakeAssignmentsEnabled}
                                                            href={buildRetakeHref(selectedExamId, student.attempt.id, retakeIds, "wrong")}
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
                </>
            ) : (
                <div className="card" style={{ padding: '3rem', textAlign: 'center', color: 'var(--muted)' }}>
                    아직 응시한 학생이 없습니다.
                </div>
            )}
        </div>
    );
}
