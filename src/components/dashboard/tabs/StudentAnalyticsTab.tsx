"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import Link from "next/link";
import StatusPill from "@/components/dashboard/StatusPill";
import { Exam, Attempt, type PlanKey } from "@/types/omr";
import {
    ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip,
    ResponsiveContainer, Legend, ReferenceLine
} from 'recharts';

interface StudentTrendTooltipProps {
    active?: boolean;
    payload?: Array<{
        name?: string;
        value?: number;
        payload?: {
            date: string;
            examTitle: string;
            studentScore: number;
            avgScore: number;
        };
    }>;
}

function StudentTrendTooltip({ active, payload }: StudentTrendTooltipProps) {
    if (!active || !payload || !payload.length) return null;
    const data = payload[0]?.payload;
    if (!data) return null;

    const diff = data.studentScore - data.avgScore;
    const isAbove = diff >= 0;

    return (
        <div style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: '10px',
            padding: '0.75rem 0.9rem',
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.12)',
            minWidth: '190px',
            fontSize: '0.85rem',
            pointerEvents: 'none',
        }}>
            <div style={{ fontWeight: 700, color: 'var(--foreground)', marginBottom: '0.15rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '240px' }}>
                {data.examTitle}
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--muted)', marginBottom: '0.55rem' }}>
                {data.date}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.3rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.8rem' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: 'var(--foreground)', fontWeight: 600 }}>
                        <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--primary)', flexShrink: 0 }} />
                        내 점수
                    </span>
                    <strong style={{ color: 'var(--primary)', fontWeight: 800, fontSize: '0.95rem' }}>
                        {data.studentScore}점
                    </strong>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.8rem' }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: 'var(--muted)' }}>
                        <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--warning)', flexShrink: 0 }} />
                        선택 범위 평균
                    </span>
                    <span style={{ color: 'var(--muted)', fontWeight: 700 }}>
                        {data.avgScore}점
                    </span>
                </div>
                <div style={{
                    marginTop: '0.35rem',
                    paddingTop: '0.35rem',
                    borderTop: '1px dashed var(--border)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    fontSize: '0.76rem',
                }}>
                    <span style={{ color: 'var(--muted)' }}>평균 대비</span>
                    <span style={{
                        fontWeight: 800,
                        color: isAbove ? 'var(--success)' : 'var(--grade-red)',
                    }}>
                        {isAbove ? `+${diff}점 (상회)` : `${diff}점 (하회)`}
                    </span>
                </div>
            </div>
        </div>
    );
}
import { Bell, Lock, MapPin, Target, TrendingUp } from "lucide-react";
import { PremiumActionLink, PremiumFeatureCard } from "@/components/PremiumFeatureGate";
import { formatKoreanDate } from "@/lib/pure";
import { computeRankPercentile } from "@/lib/scoreDistribution";
import {
    buildStudentAnalyticsRegionalScopes,
    filterStudentAnalyticsAttemptsByRegion,
    studentAnalyticsRegionName,
    studentAnalyticsStudentKey,
    type StudentAnalyticsRegionalScope,
} from "@/lib/studentAnalyticsScopeProjection";
import { safeScorePercent } from "@/lib/scoreUtils";
import type { RosterGroup, RosterStudent } from "@/lib/rosterStorage";
import { resolveScopedSelection } from "@/lib/dashboardSelection";
import { buildRetakeHref } from "@/lib/retakeLinks";
import { hasPlanEntitlement } from "@/utils/plans";
import { buildStudentResultHref } from "@/lib/studentResultHub";
import {
    currentTeacherCanonicalAnalyticsSnapshot,
    exactTeacherCanonicalWrongRetakeCohorts,
    type TeacherCanonicalAnalyticsSnapshot,
    type TeacherCanonicalAnalyticsSnapshotMap,
    type TeacherCanonicalStudentAnalyticsRow,
} from "@/lib/teacherCanonicalAnalyticsSnapshotContract";

interface StudentAnalyticsTabProps {
    exams: Exam[];
    attempts: Attempt[];
    rosterStudents?: RosterStudent[];
    rosterGroups?: RosterGroup[];
    currentPlan?: PlanKey;
    canonicalAnalyticsSnapshots?: TeacherCanonicalAnalyticsSnapshotMap;
}

const ALL_REGION_KEY = "__all_regions__";
const EMPTY_BEHAVIOR = {
    elapsedTimeSec: 0,
    totalTrackedTimeSec: 0,
    averageTimeSec: 0,
    slowQuestionNumbers: [],
    rushedQuestionNumbers: [],
    revisitedQuestionNumbers: [],
    answerChangedQuestionNumbers: [],
    focusLossCount: 0,
    focusLossQuestionNumbers: [],
};

// Shared card surface so student-analytics sections match the exam tab's coherent
// grammar (rounded, subtly elevated, consistently bordered). The `.card` class has no
// styling of its own, so each card spreads this base first and overrides as needed.
const CARD_SURFACE_STYLE: CSSProperties = {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-xl)',
    boxShadow: 'var(--shadow-md)',
};

type StudentAnalyticsLocalRuntime = typeof import("@/lib/studentAnalyticsLocalRuntime");

function regionalScopeLabel(scope: StudentAnalyticsRegionalScope | undefined): string {
    return scope?.regionName || "전체 지역";
}

function storedAttemptScore(attempt: Attempt) {
    return {
        earnedScore: attempt.score,
        totalScore: attempt.totalScore,
        scorePercent: safeScorePercent(attempt.score, attempt.totalScore),
        source: "storedScore" as const,
        gradedQuestionCount: 0,
        ungradedQuestionCount: 0,
    };
}

function formatSeconds(totalSec: number): string {
    const safeSec = Math.max(0, Math.round(totalSec || 0));
    if (safeSec <= 0) return "기록 없음";
    if (safeSec < 60) return `${safeSec}초`;
    const minutes = Math.floor(safeSec / 60);
    const seconds = safeSec % 60;
    if (minutes < 60) return seconds > 0 ? `${minutes}분 ${seconds}초` : `${minutes}분`;
    const hours = Math.floor(minutes / 60);
    const restMinutes = minutes % 60;
    return restMinutes > 0 ? `${hours}시간 ${restMinutes}분` : `${hours}시간`;
}

export default function StudentAnalyticsTab({
    exams,
    attempts,
    rosterStudents = [],
    rosterGroups = [],
    currentPlan = "free",
    canonicalAnalyticsSnapshots,
}: StudentAnalyticsTabProps) {
    const requiresCanonicalSnapshot = canonicalAnalyticsSnapshots !== undefined;
    const [localRuntime, setLocalRuntime] = useState<StudentAnalyticsLocalRuntime | null>(null);
    useEffect(() => {
        if (requiresCanonicalSnapshot) return;
        let current = true;
        void import("@/lib/studentAnalyticsLocalRuntime").then(runtime => {
            if (current) setLocalRuntime(runtime);
        });
        return () => { current = false; };
    }, [requiresCanonicalSnapshot]);
    const [selectedRegionKey, setSelectedRegionKey] = useState(ALL_REGION_KEY);
    const analyticsAttempts = useMemo(() => attempts.filter(attempt => attempt.status === "completed"), [attempts]);
    const regionScopeOptions = useMemo(() => (
        buildStudentAnalyticsRegionalScopes({
            students: rosterStudents,
            groups: rosterGroups,
            attempts: analyticsAttempts,
        }).filter(scope => scope.attemptCount > 0)
    ), [analyticsAttempts, rosterGroups, rosterStudents]);
    const activeRegionKey = selectedRegionKey === ALL_REGION_KEY || regionScopeOptions.some(scope => scope.regionKey === selectedRegionKey)
        ? selectedRegionKey
        : ALL_REGION_KEY;
    const activeRegionScope = regionScopeOptions.find(scope => scope.regionKey === activeRegionKey);
    const activeRegionLabel = activeRegionKey === ALL_REGION_KEY ? "전체 지역" : regionalScopeLabel(activeRegionScope);
    const scopedAttempts = useMemo(() => (
        activeRegionKey === ALL_REGION_KEY
            ? analyticsAttempts
            : filterStudentAnalyticsAttemptsByRegion(analyticsAttempts, activeRegionKey, rosterStudents, rosterGroups)
    ), [activeRegionKey, analyticsAttempts, rosterGroups, rosterStudents]);
    const baseScopedAttempts = useMemo(() => scopedAttempts.filter(attempt => !attempt.retake), [scopedAttempts]);
    const retakeScopedAttempts = useMemo(() => scopedAttempts.filter(attempt => !!attempt.retake), [scopedAttempts]);

    const students = useMemo(() => {
        const studentMap = new Map<string, {
            key: string;
            name: string;
            groupName?: string;
            regionName?: string;
            label: string;
            attemptCount: number;
            baseAttemptCount: number;
            retakeAttemptCount: number;
            latestFinishedAt: string;
        }>();
        scopedAttempts.forEach(a => {
            const key = studentAnalyticsStudentKey(a);
            const current = studentMap.get(key);
            const regionName = studentAnalyticsRegionName(a, rosterStudents, rosterGroups);
            const isLatest = !current || new Date(a.finishedAt).getTime() > new Date(current.latestFinishedAt).getTime();
            const nextName = isLatest ? a.studentName : current?.name || a.studentName;
            const nextGroupName = isLatest ? a.groupName : current?.groupName;
            const nextRegionName = isLatest ? regionName : current?.regionName;
            studentMap.set(key, {
                key,
                name: nextName,
                groupName: nextGroupName,
                regionName: nextRegionName,
                label: [
                    nextName,
                    nextGroupName,
                    nextRegionName,
                ].filter(Boolean).join(" · "),
                attemptCount: (current?.attemptCount || 0) + 1,
                baseAttemptCount: (current?.baseAttemptCount || 0) + (a.retake ? 0 : 1),
                retakeAttemptCount: (current?.retakeAttemptCount || 0) + (a.retake ? 1 : 0),
                latestFinishedAt: isLatest
                    ? a.finishedAt
                    : current.latestFinishedAt,
            });
        });
        return Array.from(studentMap.values()).sort((a, b) => {
            const nameCompare = a.name.localeCompare(b.name, "ko");
            if (nameCompare !== 0) return nameCompare;
            const groupCompare = (a.groupName || "").localeCompare(b.groupName || "", "ko");
            if (groupCompare !== 0) return groupCompare;
            return (a.regionName || "").localeCompare(b.regionName || "", "ko");
        });
    }, [rosterGroups, rosterStudents, scopedAttempts]);

    const [selectedStudentKey, setSelectedStudentKey] = useState<string>("");
    const activeStudentKey = resolveScopedSelection(students, selectedStudentKey);
    const activeStudentProfile = students.find(student => student.key === activeStudentKey);
    const activeStudentLabel = activeStudentProfile?.label || "";
    const [excludedExamIds, setExcludedExamIds] = useState<Set<string>>(new Set());
    const [reminderExamIds, setReminderExamIds] = useState<Set<string>>(new Set());
    const studentGrowthReportsEnabled = hasPlanEntitlement(currentPlan, "studentGrowthReports");
    const retakeAssignmentsEnabled = hasPlanEntitlement(currentPlan, "retakeAssignments");
    const remindersEnabled = hasPlanEntitlement(currentPlan, "reminders");

    const toggleExamExclusion = (examId: string) => {
        setExcludedExamIds(prev => {
            const next = new Set(prev);
            if (next.has(examId)) next.delete(examId);
            else next.add(examId);
            return next;
        });
    };

    const toggleReminderQueue = (examId: string) => {
        setReminderExamIds(prev => {
            const next = new Set(prev);
            if (next.has(examId)) next.delete(examId);
            else next.add(examId);
            return next;
        });
    };

    const studentAttempts = useMemo(() => {
        if (!activeStudentKey) return [];
        return scopedAttempts
            .filter(a => studentAnalyticsStudentKey(a) === activeStudentKey)
            .sort((a, b) => new Date(a.finishedAt).getTime() - new Date(b.finishedAt).getTime());
    }, [activeStudentKey, scopedAttempts]);
    const studentBaseAttempts = useMemo(() => studentAttempts.filter(attempt => !attempt.retake), [studentAttempts]);
    const studentRetakeAttempts = useMemo(() => studentAttempts.filter(attempt => !!attempt.retake), [studentAttempts]);

    const unattemptedExams = useMemo(() => {
        const attemptedExamIds = new Set(studentBaseAttempts.map(attempt => attempt.examId));
        return exams.filter(exam => !attemptedExamIds.has(exam.id));
    }, [exams, studentBaseAttempts]);

    const examsById = useMemo(() => new Map(exams.map(exam => [exam.id, exam])), [exams]);
    const canonicalSnapshotsByExamId = useMemo(() => {
        const snapshots = new Map<string, TeacherCanonicalAnalyticsSnapshot>();
        if (!canonicalAnalyticsSnapshots) return snapshots;
        for (const exam of exams) {
            const examAttempts = analyticsAttempts.filter(attempt => attempt.examId === exam.id);
            const snapshot = currentTeacherCanonicalAnalyticsSnapshot(canonicalAnalyticsSnapshots[exam.id], exam.id, examAttempts);
            if (snapshot?.status === "ready") snapshots.set(exam.id, snapshot);
        }
        return snapshots;
    }, [analyticsAttempts, canonicalAnalyticsSnapshots, exams]);
    const canonicalStudentRowsByAttemptId = useMemo(() => {
        const rows = new Map<string, TeacherCanonicalStudentAnalyticsRow>();
        if (!canonicalAnalyticsSnapshots) return rows;
        for (const exam of exams) {
            const examAttempts = analyticsAttempts.filter(attempt => attempt.examId === exam.id);
            const snapshot = currentTeacherCanonicalAnalyticsSnapshot(
                canonicalAnalyticsSnapshots[exam.id],
                exam.id,
                examAttempts,
            );
            if (snapshot?.status !== "ready" || !snapshot.studentAggregatesComplete) continue;
            for (const row of snapshot.studentRows) rows.set(row.attemptId, row);
        }
        return rows;
    }, [analyticsAttempts, canonicalAnalyticsSnapshots, exams]);

    const attemptScoreById = useMemo(() => {
        if (requiresCanonicalSnapshot) {
            return new Map(scopedAttempts.map(attempt => {
                const canonicalRow = canonicalStudentRowsByAttemptId.get(attempt.id);
                return [attempt.id, canonicalRow
                    ? {
                        earnedScore: canonicalRow.totalScore,
                        totalScore: attempt.totalScore,
                        scorePercent: canonicalRow.scorePercentage,
                        source: canonicalRow.gradingSource,
                        gradedQuestionCount: 0,
                        ungradedQuestionCount: 0,
                    }
                    : storedAttemptScore(attempt)];
            }));
        }
        return localRuntime?.buildAttemptScoreLookup(scopedAttempts, examsById)
            ?? new Map(scopedAttempts.map(attempt => [attempt.id, storedAttemptScore(attempt)]));
    }, [canonicalStudentRowsByAttemptId, examsById, localRuntime, requiresCanonicalSnapshot, scopedAttempts]);

    const attemptsByExamId = useMemo(() => {
        const map = new Map<string, Attempt[]>();
        for (const attempt of baseScopedAttempts) {
            const examAttempts = map.get(attempt.examId);
            if (examAttempts) examAttempts.push(attempt);
            else map.set(attempt.examId, [attempt]);
        }
        return map;
    }, [baseScopedAttempts]);

    const averageScoreByExamId = useMemo(() => {
        const map = new Map<string, number>();
        attemptsByExamId.forEach((examAttempts, examId) => {
            if (examAttempts.length === 0) {
                map.set(examId, 0);
                return;
            }
            const total = examAttempts.reduce((sum, attempt) => (
                sum + (attemptScoreById.get(attempt.id)?.scorePercent ?? 0)
            ), 0);
            map.set(examId, Math.round(total / examAttempts.length));
        });
        return map;
    }, [attemptScoreById, attemptsByExamId]);

    // Data for Chart
    const trendData = useMemo(() => {
        return studentAttempts
            .filter(attempt => !attempt.retake)
            .filter(a => !excludedExamIds.has(a.examId))
            .map(attempt => {
                const avgScore = averageScoreByExamId.get(attempt.examId) ?? 0;
                const studentScore = attemptScoreById.get(attempt.id)?.scorePercent
                    ?? storedAttemptScore(attempt).scorePercent;

                return {
                    date: formatKoreanDate(attempt.finishedAt),
                    examTitle: attempt.examTitle,
                    examId: attempt.examId,
                    studentScore,
                    avgScore,
                };
            });
    }, [studentAttempts, excludedExamIds, attemptScoreById, averageScoreByExamId]);

    const studentTrendSummary = useMemo(() => {
        if (!trendData || trendData.length === 0) return null;
        const scores = trendData.map(d => d.studentScore);
        const latest = trendData[trendData.length - 1];
        const prev = trendData.length >= 2 ? trendData[trendData.length - 2] : null;
        const avg = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
        const max = Math.max(...scores);
        const delta = prev ? latest.studentScore - prev.studentScore : null;
        const avgDiff = latest.studentScore - latest.avgScore;

        return {
            latestScore: latest.studentScore,
            averageScore: avg,
            maxScore: max,
            delta,
            avgDiff,
            examCount: trendData.length,
        };
    }, [trendData]);

    const detailedAnalysis = useMemo(() => {
        const getScoreRate = (candidate: Attempt) => (
            attemptScoreById.get(candidate.id)?.scorePercent
            ?? storedAttemptScore(candidate).scorePercent
        );

        return studentBaseAttempts.map(attempt => {
            const exam = examsById.get(attempt.examId);
            const canonicalRow = requiresCanonicalSnapshot
                ? canonicalStudentRowsByAttemptId.get(attempt.id)
                : undefined;
            const examAttempts = [...(attemptsByExamId.get(attempt.examId) || [])]
                .sort((a, b) => getScoreRate(b) - getScoreRate(a));
            const totalStudents = examAttempts.length;
            const gradingResolution = !requiresCanonicalSnapshot && exam && localRuntime
                ? localRuntime.resolveAttemptGrading(exam, attempt)
                : null;
            const scoreSummary = canonicalRow
                ? {
                    earnedScore: canonicalRow.totalScore,
                    totalScore: attempt.totalScore,
                    scorePercent: canonicalRow.scorePercentage,
                    source: canonicalRow.gradingSource,
                }
                : gradingResolution
                ? { ...gradingResolution.scoreSummary, source: gradingResolution.source }
                : storedAttemptScore(attempt);
            const studentScoreRate = scoreSummary.scorePercent;
            const rank = examAttempts.findIndex(a => getScoreRate(a) === studentScoreRate) + 1 || totalStudents;

            // Calculate strengths and weaknesses based on labels
            const labelStats: Record<string, { correct: number, total: number }> = {};

            if (canonicalRow) {
                Object.assign(labelStats, canonicalRow.labelOutcomes);
            } else if (gradingResolution) {
                gradingResolution.questionResults.forEach(result => {
                    if (result.status === "ungraded") return;
                    const label = result.label || '일반/종합';
                    if (!labelStats[label]) labelStats[label] = { correct: 0, total: 0 };

                    labelStats[label].total += 1;
                    if (result.status === "correct" || result.isCorrect) {
                        labelStats[label].correct += 1;
                    }
                });
            }

            let strongPoint = '';
            let weakPoint = '';
            let highestRate = -1;
            let lowestRate = 2; // rate goes up to 1

            Object.entries(labelStats).forEach(([label, stats]) => {
                if (stats.total > 0) {
                    const rate = stats.correct / stats.total;
                    if (rate > highestRate) {
                        highestRate = rate;
                        strongPoint = label;
                    }
                    if (rate < lowestRate) {
                        lowestRate = rate;
                        weakPoint = label;
                    }
                }
            });

            if (highestRate === lowestRate) {
                if (highestRate >= 0.8) weakPoint = '비교적 양호';
                else if (highestRate <= 0.4) strongPoint = '기초 필요';
                else if (Object.keys(labelStats).length === 1) {
                    strongPoint = '균형';
                    weakPoint = '균형';
                }
            }

            const recommendations = !requiresCanonicalSnapshot && exam && localRuntime
                ? localRuntime.buildLearningRecommendations(exam, [attempt], {
                    scope: "attempt",
                    attempt,
                    limit: 5,
                })
                : [];
            const topWeakness = canonicalRow?.topWeakness || recommendations[0];
            const retakeIds = canonicalRow?.retakeQuestionIds
                || (!requiresCanonicalSnapshot && exam && localRuntime ? localRuntime.buildRetakeQuestionIds(exam, attempt) : []);
            const behavior = canonicalRow?.behavior
                || (!requiresCanonicalSnapshot && localRuntime ? localRuntime.summarizeAttemptBehavior(attempt) : EMPTY_BEHAVIOR);
            const officialSnapshot = canonicalSnapshotsByExamId.get(attempt.examId);
            const localRequestedRetakeIds = topWeakness?.retakeQuestionIds.length ? topWeakness.retakeQuestionIds : retakeIds;
            const officialCohortKeys = officialSnapshot
                ? exactTeacherCanonicalWrongRetakeCohorts(officialSnapshot, attempt.id, retakeIds)
                : null;

            return {
                attemptId: attempt.id,
                examId: attempt.examId,
                examTitle: attempt.examTitle,
                score: scoreSummary.earnedScore,
                totalScore: scoreSummary.totalScore,
                scoreRate: studentScoreRate,
                rank,
                totalStudents,
                gradingSource: canonicalRow?.gradingSource || gradingResolution?.source || "stored_totals_only",
                // null for solo submissions (totalStudents < 2) — "상위 100%" is meaningless
                // (and reads as last place) when there's no one else to compare against.
                percentile: computeRankPercentile(rank, totalStudents),
                strongPoint,
                weakPoint: topWeakness?.title || weakPoint,
                weakBasis: topWeakness?.basis,
                weakQuestionNumbers: topWeakness?.questionNumbers || [],
                weakRate: topWeakness?.wrongRate,
                weakReason: topWeakness?.reason,
                retakeIds,
                retakeHref: exam && retakeIds.length > 0
                    ? requiresCanonicalSnapshot
                        ? officialCohortKeys
                            ? buildRetakeHref(attempt.examId, attempt.id, retakeIds, "wrong", { cohortKeys: officialCohortKeys })
                            : ""
                        : buildRetakeHref(attempt.examId, topWeakness?.sourceAttemptId || attempt.id, localRequestedRetakeIds, topWeakness?.retakeMode || "wrong", {
                            labels: topWeakness?.retakeLabels || [],
                            concepts: topWeakness?.retakeConcepts || [],
                        })
                    : "",
                retakeDefinitionUnavailable: requiresCanonicalSnapshot && retakeIds.length > 0 && !officialCohortKeys,
                behavior,
                elapsedTimeSec: behavior.elapsedTimeSec,
                date: formatKoreanDate(attempt.finishedAt)
            };
        }).reverse(); // Latest at the top
    }, [
        studentBaseAttempts,
        attemptsByExamId,
        examsById,
        attemptScoreById,
        canonicalStudentRowsByAttemptId,
        canonicalSnapshotsByExamId,
        localRuntime,
        requiresCanonicalSnapshot,
    ]);
    const excludedGradingEvidence = useMemo(() => detailedAnalysis.reduce((summary, detail) => {
        if (detail.gradingSource === "legacy_derived_current_exam") summary.legacy += 1;
        if (detail.gradingSource === "stored_totals_only" || detail.gradingSource === "incomplete_or_invalid") {
            summary.incomplete += 1;
        }
        return summary;
    }, { legacy: 0, incomplete: 0 }), [detailedAnalysis]);

    const learningQueue = useMemo(() => {
        return detailedAnalysis
            .filter(detail => detail.retakeHref && detail.weakPoint)
            .sort((a, b) => {
                if ((b.weakRate || 0) !== (a.weakRate || 0)) return (b.weakRate || 0) - (a.weakRate || 0);
                return b.scoreRate - a.scoreRate;
            })
            .slice(0, 4);
    }, [detailedAnalysis]);

    if (students.length === 0) {
        return <div className="text-center p-8 text-muted">아직 응시 기록이 있는 학생이 없습니다.</div>;
    }

    return (
        <div className="fade-in-up" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
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
                    과거 기록 기반 참고 분석 {excludedGradingEvidence.legacy}건과 근거 불완전 기록 {excludedGradingEvidence.incomplete}건은 공식 누적 문항·유형 집계에서 제외했습니다.
                </p>
            )}
            {/* Filter Section */}
            <div className="card" style={{ ...CARD_SURFACE_STYLE,padding: '1.5rem', display: 'flex', alignItems: 'center', gap: '1rem', background: 'var(--surface)', flexWrap: 'wrap' }}>
                {regionScopeOptions.length > 0 && (
                    <>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', fontWeight: 800, color: 'var(--text)' }}>
                            <MapPin size={16} color="var(--primary)" />
                            지역:
                        </span>
                        <select
                            aria-label="학생 분석 지역 필터"
                            value={activeRegionKey}
                            onChange={(e) => {
                                setSelectedRegionKey(e.target.value);
                                setSelectedStudentKey("");
                            }}
                            style={{
                                padding: '0.75rem 1rem',
                                borderRadius: 'var(--radius-md)',
                                border: '1px solid var(--border)',
                                background: 'var(--background)',
                                color: 'var(--text)',
                                minWidth: '170px',
                                outline: 'none',
                                cursor: 'pointer',
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
                    </>
                )}
                <span style={{ fontWeight: 600, color: 'var(--text)' }}>분석할 학생 선택:</span>
                <select
                    value={activeStudentKey}
                    onChange={(e) => setSelectedStudentKey(e.target.value)}
                    style={{
                        padding: '0.75rem 1rem',
                        borderRadius: 'var(--radius-md)',
                        border: '1px solid var(--border)',
                        background: 'var(--background)',
                        color: 'var(--text)',
                        flex: 1,
                        maxWidth: '400px',
                        outline: 'none',
                        cursor: 'pointer'
                    }}
                >
                    {students.map(student => (
                        <option key={student.key} value={student.key}>
                            {student.label} (원시험 {student.baseAttemptCount}건{student.retakeAttemptCount > 0 ? ` · 재시험 ${student.retakeAttemptCount}건` : ""})
                        </option>
                    ))}
                </select>
                <span style={{ fontSize: '0.82rem', color: 'var(--muted)', fontWeight: 700 }}>
                    {activeRegionLabel} 기준 원시험 {baseScopedAttempts.length}건 · 재시험 {retakeScopedAttempts.length}건
                </span>
            </div>

            {(!retakeAssignmentsEnabled || !remindersEnabled) && (
                <PremiumFeatureCard
                    title="학생별 액션 잠금"
                    description="Free에서는 점수 추이와 응시 기록을 확인하고, Pro 이상에서 유형 재시험 링크와 카카오 발송 후보·큐 관리를 사용할 수 있습니다. 실제 메시지 발송은 아직 지원하지 않습니다."
                    badge="Pro"
                    style={{ marginTop: '-0.25rem' }}
                />
            )}

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))', gap: '1.5rem', alignItems: 'start' }}>
                {/* Left side: Chart */}
                <div className="card chart-card-enter" style={{ ...CARD_SURFACE_STYLE, padding: '1.5rem', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                    <div style={{ marginBottom: '1.5rem' }}>
                        <h3 style={{ fontSize: '1.25rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                            <TrendingUp size={20} color="var(--primary)" />
                            {activeStudentLabel} 성취도 추이
                        </h3>
                        <p style={{ color: 'var(--muted)', fontSize: '0.9rem' }}>
                            원시험 점수 추이와 선택 범위 학생의 원시험 평균을 같이 비교합니다.
                        </p>
                    </div>
                    {!studentGrowthReportsEnabled && (
                        <PremiumFeatureCard
                            title="성취도 추이 차트"
                            description="Pro 이상에서 학생별 원시험 점수 추이와 전체 학생 평균을 비교할 수 있습니다."
                            badge="Pro"
                            style={{ marginBottom: '1rem' }}
                        />
                    )}

                    {studentGrowthReportsEnabled && studentTrendSummary && (
                        <div style={{
                            display: 'grid',
                            gridTemplateColumns: 'repeat(auto-fit, minmax(105px, 1fr))',
                            gap: '0.65rem',
                            marginBottom: '1rem',
                            padding: '0.75rem 0.9rem',
                            background: 'rgba(99, 102, 241, 0.04)',
                            border: '1px solid var(--border)',
                            borderRadius: 'var(--radius-md)',
                        }}>
                            <div>
                                <div style={{ fontSize: '0.72rem', color: 'var(--muted)', fontWeight: 600, marginBottom: '0.15rem' }}>최신 원시험</div>
                                <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.3rem' }}>
                                    <span style={{ fontSize: '1.2rem', fontWeight: 900, color: 'var(--foreground)' }}>
                                        {studentTrendSummary.latestScore}
                                    </span>
                                    <span style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>점</span>
                                    {studentTrendSummary.delta !== null && (
                                        <span style={{
                                            fontSize: '0.72rem',
                                            fontWeight: 800,
                                            color: studentTrendSummary.delta >= 0 ? 'var(--success)' : 'var(--grade-red)',
                                        }}>
                                            {studentTrendSummary.delta >= 0 ? `▲+${studentTrendSummary.delta}` : `▼${studentTrendSummary.delta}`}
                                        </span>
                                    )}
                                </div>
                            </div>

                            <div>
                                <div style={{ fontSize: '0.72rem', color: 'var(--muted)', fontWeight: 600, marginBottom: '0.15rem' }}>원시험 평균</div>
                                <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.2rem' }}>
                                    <span style={{ fontSize: '1.2rem', fontWeight: 900, color: 'var(--primary)' }}>
                                        {studentTrendSummary.averageScore}
                                    </span>
                                    <span style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>점</span>
                                </div>
                            </div>

                            <div>
                                <div style={{ fontSize: '0.72rem', color: 'var(--muted)', fontWeight: 600, marginBottom: '0.15rem' }}>최고 점수</div>
                                <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.2rem' }}>
                                    <span style={{ fontSize: '1.2rem', fontWeight: 900, color: 'var(--foreground)' }}>
                                        {studentTrendSummary.maxScore}
                                    </span>
                                    <span style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>점</span>
                                </div>
                            </div>

                            <div>
                                <div style={{ fontSize: '0.72rem', color: 'var(--muted)', fontWeight: 600, marginBottom: '0.15rem' }}>반 평균 대비</div>
                                <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.2rem' }}>
                                    <span style={{
                                        fontSize: '1.2rem',
                                        fontWeight: 900,
                                        color: studentTrendSummary.avgDiff >= 0 ? 'var(--success)' : 'var(--grade-red)',
                                    }}>
                                        {studentTrendSummary.avgDiff >= 0 ? `+${studentTrendSummary.avgDiff}` : studentTrendSummary.avgDiff}
                                    </span>
                                    <span style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>점</span>
                                </div>
                            </div>
                        </div>
                    )}

                    <div className="comet-chart-light" style={{ height: studentGrowthReportsEnabled ? '280px' : 0, width: '100%', minWidth: 0, position: 'relative' }}>
                        <div className="chart-texture is-light" aria-hidden="true" />
                        {studentGrowthReportsEnabled && trendData.length > 0 ? (
                            <ResponsiveContainer
                                width="100%"
                                height="100%"
                                minWidth={0}
                                minHeight={280}
                                initialDimension={{ width: 760, height: 280 }}
                            >
                                <ComposedChart
                                    key={`${activeStudentKey}-${trendData.length}`}
                                    data={trendData}
                                    margin={{ top: 15, right: 25, left: -10, bottom: 15 }}
                                >
                                    <defs>
                                        <linearGradient id="studentScoreGlow" x1="0" y1="0" x2="0" y2="1">
                                            <stop offset="5%" stopColor="var(--primary)" stopOpacity={0.22} />
                                            <stop offset="95%" stopColor="var(--primary)" stopOpacity={0.0} />
                                        </linearGradient>
                                    </defs>
                                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" opacity={0.7} />
                                    <XAxis
                                        dataKey="examTitle"
                                        tick={{ fill: 'var(--muted)', fontSize: 11, fontWeight: 600 }}
                                        axisLine={{ stroke: 'var(--border)' }}
                                        tickLine={false}
                                        dy={8}
                                    />
                                    <YAxis
                                        domain={[0, 100]}
                                        ticks={[0, 25, 50, 75, 100]}
                                        tick={{ fill: 'var(--muted)', fontSize: 11 }}
                                        axisLine={false}
                                        tickLine={false}
                                        tickFormatter={(v) => `${v}점`}
                                        dx={-4}
                                    />
                                    <ReferenceLine y={100} stroke="var(--border)" strokeDasharray="2 4" />
                                    <RechartsTooltip
                                        cursor={{ stroke: 'var(--primary)', strokeWidth: 1.5, strokeDasharray: '4 4', strokeOpacity: 0.4 }}
                                        content={<StudentTrendTooltip />}
                                        animationDuration={150}
                                    />
                                    <Legend
                                        verticalAlign="bottom"
                                        align="center"
                                        wrapperStyle={{ paddingTop: '12px', fontSize: '0.8rem' }}
                                        formatter={(value) => (
                                            <span style={{ color: 'var(--foreground)', fontWeight: 600, marginRight: '8px' }}>
                                                {value}
                                            </span>
                                        )}
                                    />
                                    <Area
                                        type="monotone"
                                        dataKey="studentScore"
                                        stroke="none"
                                        fill="url(#studentScoreGlow)"
                                        isAnimationActive={true}
                                        animationDuration={850}
                                        animationEasing="ease-out"
                                        legendType="none"
                                        tooltipType="none"
                                    />
                                    <Line
                                        name="내 점수"
                                        type="monotone"
                                        dataKey="studentScore"
                                        className="comet-target"
                                        stroke="var(--primary)"
                                        strokeWidth={3}
                                        dot={{ r: 4.5, strokeWidth: 2, fill: 'var(--background)' }}
                                        activeDot={{ r: 6.5, strokeWidth: 2, stroke: 'var(--primary)', fill: 'var(--background)' }}
                                        isAnimationActive={true}
                                        animationDuration={850}
                                        animationEasing="ease-out"
                                    />
                                    <Line
                                        name="선택 범위 평균"
                                        type="monotone"
                                        dataKey="avgScore"
                                        stroke="var(--warning)"
                                        strokeWidth={2}
                                        strokeDasharray="5 5"
                                        dot={{ r: 3.5, strokeWidth: 0, fill: 'var(--muted)' }}
                                        activeDot={{ r: 5.5, strokeWidth: 0, fill: 'var(--warning)' }}
                                        isAnimationActive={true}
                                        animationBegin={200}
                                        animationDuration={850}
                                        animationEasing="ease-out"
                                    />
                                </ComposedChart>
                            </ResponsiveContainer>
                        ) : studentGrowthReportsEnabled ? (
                            <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)' }}>
                                표시할 원시험 데이터가 없습니다. (모든 시험 목록이 제외됨)
                            </div>
                        ) : null}
                    </div>
                </div>

                {/* Right side: Exam List & Unattempted Exams */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', minWidth: 0 }}>
                    <div className="card" style={{ ...CARD_SURFACE_STYLE,padding: '1.5rem', display: 'flex', flexDirection: 'column' }}>
                        <h3 style={{ fontSize: '1.1rem', fontWeight: 800, marginBottom: '0.45rem', display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                            <Target size={17} color="var(--primary)" />
                            학생 학습 큐
                        </h3>
                        <p style={{ fontSize: '0.85rem', color: 'var(--muted)', marginBottom: '1rem' }}>
                            최근 시험별 오답 유형을 묶어 바로 재시험으로 연결합니다.
                        </p>

                        {learningQueue.length > 0 ? (
                            <div style={{ display: 'grid', gap: '0.6rem' }}>
                                {learningQueue.map(item => (
                                    <div key={item.attemptId} style={{
                                        padding: '0.85rem',
                                        borderRadius: 'var(--radius-md)',
                                        background: 'var(--background)',
                                        border: '1px solid var(--border)',
                                    }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', marginBottom: '0.35rem' }}>
                                            <div style={{ minWidth: 0 }}>
                                                <div style={{ fontWeight: 900, color: 'var(--foreground)', fontSize: '0.9rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                                    {item.weakPoint}
                                                </div>
                                                <div style={{ fontSize: '0.75rem', color: 'var(--muted)', marginTop: '0.18rem' }}>
                                                    {item.examTitle}
                                                </div>
                                            </div>
                                            {typeof item.weakRate === "number" && (
                                                <span style={{ color: item.weakRate >= 70 ? 'var(--grade-red)' : 'var(--warning)', fontWeight: 900, fontSize: '0.8rem' }}>
                                                    {item.weakRate}%
                                                </span>
                                            )}
                                        </div>
                                        <div style={{ fontSize: '0.76rem', color: 'var(--muted)', marginBottom: '0.55rem' }}>
                                            {item.weakBasis || '약점 유형'} · {item.weakQuestionNumbers.join(', ') || item.retakeIds.join(', ')}번
                                        </div>
                                        {item.weakReason && (
                                            <div style={{ fontSize: '0.72rem', color: 'var(--primary)', fontWeight: 800, marginBottom: '0.55rem', lineHeight: 1.35 }}>
                                                {item.weakReason}
                                            </div>
                                        )}
                                        <PremiumActionLink
                                            enabled={retakeAssignmentsEnabled}
                                            href={item.retakeHref}
                                            className="btn btn-secondary"
                                            style={{ fontSize: '0.75rem', padding: '0.34rem 0.65rem' }}
                                            lockedTitle="Pro 이상에서 학생별 유형 재시험 링크를 만들 수 있습니다."
                                        >
                                            유형 재시험
                                        </PremiumActionLink>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <div style={{ color: 'var(--muted)', fontSize: '0.85rem', padding: '1rem', border: '1px dashed var(--border)', borderRadius: 'var(--radius-md)', background: 'var(--background)' }}>
                                오답/미응답이 쌓이면 학생별 학습 큐가 표시됩니다.
                            </div>
                        )}
                    </div>

                    {/* Unattempted Exams & Reminder Queue */}
                    <div className="card" style={{ ...CARD_SURFACE_STYLE,padding: '1.5rem', display: 'flex', flexDirection: 'column' }}>
                        <h3 style={{ fontSize: '1.1rem', fontWeight: 700, marginBottom: '0.5rem', color: 'var(--error)' }}>
                            미응시 시험 ({unattemptedExams.length})
                        </h3>
                        <p style={{ fontSize: '0.85rem', color: 'var(--muted)', marginBottom: '1rem' }}>
                            학생이 아직 제출하지 않은 시험입니다. 발송 연동 전에는 대기 목록으로 관리합니다.
                        </p>

                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', overflowY: 'auto', maxHeight: '150px' }}>
                            {unattemptedExams.length === 0 ? (
                                <div style={{ fontSize: '0.9rem', color: 'var(--muted)', padding: '1rem', textAlign: 'center', background: 'var(--background)', borderRadius: 'var(--radius-md)' }}>
                                    모든 시험을 완료했습니다.
                                </div>
                            ) : (
                                unattemptedExams.map(exam => {
                                    const queued = reminderExamIds.has(exam.id);
                                    return (
                                        <div key={exam.id} style={{
                                            display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.75rem',
                                            borderRadius: 'var(--radius-md)', background: 'rgba(239, 68, 68, 0.05)', border: '1px solid rgba(239, 68, 68, 0.2)'
                                        }}>
                                            <div>
                                                <div style={{ fontWeight: 600, fontSize: '0.9rem', color: 'var(--foreground)' }}>{exam.title}</div>
                                                <div style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>배포일: {formatKoreanDate(exam.createdAt)}</div>
                                            </div>
                                            {remindersEnabled ? (
                                                <button
                                                    type="button"
                                                    onClick={() => toggleReminderQueue(exam.id)}
                                                    style={{
                                                        background: queued ? 'var(--surface)' : 'var(--error)',
                                                        color: queued ? 'var(--error)' : 'white',
                                                        padding: '0.4rem 0.8rem',
                                                        borderRadius: 'var(--radius-md)', fontSize: '0.75rem', fontWeight: 700,
                                                        transition: 'all 0.2s',
                                                        border: `1px solid ${queued ? 'rgba(239, 68, 68, 0.35)' : 'transparent'}`,
                                                        boxShadow: queued ? 'none' : '0 2px 4px rgba(239, 68, 68, 0.2)'
                                                    }}
                                                    className="card-hover"
                                                >
                                                    <Bell size={13} style={{ verticalAlign: '-2px', marginRight: '0.25rem' }} />
                                                    {queued ? '큐 등록됨' : '후보 큐 등록'}
                                                </button>
                                            ) : (
                                                <Link
                                                    href="/teacher/billing"
                                                    title="Pro 이상에서 카카오 발송 후보·큐를 관리할 수 있습니다. 실제 메시지는 발송하지 않습니다."
                                                    style={{
                                                        display: 'inline-flex',
                                                        alignItems: 'center',
                                                        gap: '0.25rem',
                                                        background: 'var(--surface)',
                                                        color: 'var(--muted)',
                                                        padding: '0.4rem 0.8rem',
                                                        borderRadius: 'var(--radius-md)',
                                                        fontSize: '0.75rem',
                                                        fontWeight: 800,
                                                        border: '1px solid var(--border)',
                                                        whiteSpace: 'nowrap',
                                                    }}
                                                >
                                                    <Lock size={13} />
                                                    Pro 필요
                                                </Link>
                                            )}
                                        </div>
                                    );
                                })
                            )}
                        </div>
                    </div>

                    <div className="card" style={{ ...CARD_SURFACE_STYLE,padding: '1.5rem', display: 'flex', flexDirection: 'column', flex: 1 }}>
                        <h3 style={{ fontSize: '1.1rem', fontWeight: 700, marginBottom: '0.5rem' }}>원시험 기록 ({studentBaseAttempts.length})</h3>
                        <p style={{ fontSize: '0.85rem', color: 'var(--muted)', marginBottom: '1.5rem' }}>차트에서 제외할 원시험의 체크를 해제하세요.</p>

                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', overflowY: 'auto', flex: 1 }}>
                            {studentBaseAttempts.map(attempt => {
                                const isExcluded = excludedExamIds.has(attempt.examId);
                                const scoreRate = attemptScoreById.get(attempt.id)?.scorePercent
                                    ?? storedAttemptScore(attempt).scorePercent;

                                return (
                                    <label
                                        key={attempt.id}
                                        style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            gap: '0.75rem',
                                            padding: '0.75rem',
                                            borderRadius: 'var(--radius-md)',
                                            background: isExcluded ? 'transparent' : 'var(--surface)',
                                            border: `1px solid ${isExcluded ? 'var(--border)' : 'var(--primary)'}`,
                                            opacity: isExcluded ? 0.6 : 1,
                                            cursor: 'pointer',
                                            transition: 'all 0.2s'
                                        }}
                                        className="card-hover"
                                    >
                                        <input
                                            type="checkbox"
                                            checked={!isExcluded}
                                            onChange={() => toggleExamExclusion(attempt.examId)}
                                            style={{ accentColor: 'var(--primary)', width: '16px', height: '16px', cursor: 'pointer' }}
                                        />
                                        <div style={{ flex: 1, overflow: 'hidden' }}>
                                            <div style={{ fontWeight: 600, fontSize: '0.9rem', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>{attempt.examTitle}</div>
                                            <div style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>{formatKoreanDate(attempt.finishedAt)}</div>
                                        </div>
                                        <div style={{ fontWeight: 800, fontSize: '1.1rem', color: scoreRate >= 80 ? 'var(--success)' : (scoreRate < 50 ? 'var(--grade-red)' : 'var(--text)') }}>
                                            {scoreRate}점
                                        </div>
                                    </label>
                                );
                            })}
                        </div>
                    </div>

                    {studentRetakeAttempts.length > 0 && (
                        <div className="card" style={{ ...CARD_SURFACE_STYLE,padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '0.8rem' }}>
                            <h3 style={{ fontSize: '1.1rem', fontWeight: 800, color: 'var(--retake)' }}>
                                재시험 회복 기록 ({studentRetakeAttempts.length})
                            </h3>
                            <p style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>
                                원시험 성취도와 별도로, 틀린 문항을 다시 풀어 회복한 기록입니다.
                            </p>
                            <div style={{ display: 'grid', gap: '0.5rem' }}>
                                {studentRetakeAttempts.slice().reverse().slice(0, 5).map(attempt => {
                                    const scoreRate = attemptScoreById.get(attempt.id)?.scorePercent
                                        ?? storedAttemptScore(attempt).scorePercent;
                                    return (
                                        <Link
                                            key={attempt.id}
                                            href={`/teacher/attempt/${attempt.id}`}
                                            style={{
                                                textDecoration: 'none',
                                                display: 'grid',
                                                gridTemplateColumns: 'minmax(0, 1fr) auto',
                                                gap: '0.75rem',
                                                alignItems: 'center',
                                                padding: '0.75rem',
                                                borderRadius: 'var(--radius-md)',
                                                background: 'var(--retake-soft)',
                                                border: '1px solid var(--retake-line)',
                                                color: 'inherit',
                                            }}
                                        >
                                            <div style={{ minWidth: 0 }}>
                                                <div style={{ fontWeight: 800, color: 'var(--foreground)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{attempt.examTitle}</div>
                                                <div style={{ color: 'var(--retake)', fontSize: '0.75rem', marginTop: '0.2rem', fontWeight: 800 }}>
                                                    {attempt.retake?.questionIds.length || 0}문항 · {formatKoreanDate(attempt.finishedAt)}
                                                </div>
                                            </div>
                                            <div style={{ color: scoreRate >= 80 ? 'var(--success)' : scoreRate < 50 ? 'var(--grade-red)' : 'var(--text)', fontWeight: 900 }}>
                                                {scoreRate}점
                                            </div>
                                        </Link>
                                    );
                                })}
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* Detailed Table Section */}
            <div className="card" style={{ ...CARD_SURFACE_STYLE,padding: '1.5rem', display: 'flex', flexDirection: 'column' }}>
                <h3 style={{ fontSize: '1.25rem', fontWeight: 700, marginBottom: '0.5rem' }}>
                    세부 시험 분석 내역
                </h3>
                <p style={{ color: 'var(--muted)', fontSize: '0.9rem', marginBottom: '1.5rem' }}>
                    원시험별 등수 및 문항 라벨에 따른 강점/약점 유형을 요약하여 보여줍니다.
                </p>

                <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', minWidth: '960px', fontVariantNumeric: 'tabular-nums' }}>
                        <thead>
                            <tr style={{ borderBottom: '2px solid var(--border)', color: 'var(--muted)', fontSize: '0.9rem' }}>
                                <th style={{ padding: '1rem 0.5rem', fontWeight: 600 }}>시험명</th>
                                <th style={{ padding: '1rem 0.5rem', fontWeight: 600 }}>점수</th>
                                <th style={{ padding: '1rem 0.5rem', fontWeight: 600 }}>전체 등수</th>
                                <th style={{ padding: '1rem 0.5rem', fontWeight: 600 }}>강점 유형</th>
                                <th style={{ padding: '1rem 0.5rem', fontWeight: 600 }}>약점 유형</th>
                                <th style={{ padding: '1rem 0.5rem', fontWeight: 600 }}>풀이 신호</th>
                                <th style={{ padding: '1rem 0.5rem', fontWeight: 600 }}>추천 재시험</th>
                                <th style={{ padding: '1rem 0.5rem', fontWeight: 600 }}>응시일</th>
                            </tr>
                        </thead>
                        <tbody>
                            {detailedAnalysis.length === 0 ? (
                                <tr>
                                    <td colSpan={8} style={{ textAlign: 'center', padding: '2rem', color: 'var(--muted)' }}>
                                        기록이 없습니다.
                                    </td>
                                </tr>
                            ) : (
                                detailedAnalysis.map((detail) => (
                                    <tr key={detail.attemptId} className="card-hover" style={{ borderBottom: '1px solid var(--border)' }}>
                                        <td style={{ padding: '1rem 0.5rem', fontWeight: 600, color: 'var(--foreground)' }}>
                                            {detail.examTitle}
                                            <div style={{ marginTop: '0.35rem' }}>
                                                <Link
                                                    href={buildStudentResultHref(detail.attemptId, "analytics")}
                                                    aria-label={`${detail.examTitle} 결과 분석 열기`}
                                                    style={{
                                                        display: 'inline-flex',
                                                        alignItems: 'center',
                                                        minHeight: 44,
                                                        color: 'var(--text-primary)',
                                                        fontSize: '0.76rem',
                                                        fontWeight: 800,
                                                        textDecoration: 'underline',
                                                        textUnderlineOffset: '0.18em',
                                                        whiteSpace: 'nowrap',
                                                    }}
                                                >
                                                    결과 분석
                                                </Link>
                                            </div>
                                        </td>
                                        <td style={{ padding: '1rem 0.5rem', fontWeight: 700, color: detail.scoreRate >= 80 ? 'var(--success)' : (detail.scoreRate < 50 ? 'var(--grade-red)' : 'inherit') }}>
                                            {detail.score} <span style={{ fontSize: '0.8rem', color: 'var(--muted)', fontWeight: 400 }}>/ {detail.totalScore}</span>
                                        </td>
                                        <td style={{ padding: '1rem 0.5rem', fontWeight: 600 }}>
                                            {detail.rank} <span style={{ fontSize: '0.8rem', color: 'var(--muted)', fontWeight: 400 }}>/ {detail.totalStudents}명</span>
                                            {detail.percentile !== null && (
                                                <div style={{ fontSize: '0.72rem', color: 'var(--primary)', fontWeight: 800, marginTop: '0.2rem' }}>
                                                    상위 {detail.percentile}%
                                                </div>
                                            )}
                                        </td>
                                        <td style={{ padding: '1rem 0.5rem' }}>
                                            {detail.strongPoint ?
                                                <StatusPill tone="success" size="sm" label={detail.strongPoint} />
                                                : <span style={{ color: 'var(--muted)' }}>-</span>
                                            }
                                        </td>
                                        <td style={{ padding: '1rem 0.5rem' }}>
                                            {detail.weakPoint ?
                                                <div>
                                                    <StatusPill tone="grade" size="sm" label={detail.weakPoint} />
                                                    {(detail.weakBasis || detail.weakQuestionNumbers.length > 0) && (
                                                        <div style={{ color: 'var(--muted)', fontSize: '0.75rem', marginTop: '0.3rem' }}>
                                                            {detail.weakBasis || '약점'} · {detail.weakQuestionNumbers.join(', ') || detail.retakeIds.join(', ')}번
                                                        </div>
                                                    )}
                                                    {detail.weakReason && (
                                                        <div style={{ color: 'var(--primary)', fontSize: '0.72rem', marginTop: '0.24rem', fontWeight: 800, lineHeight: 1.35 }}>
                                                            {detail.weakReason}
                                                        </div>
                                                    )}
                                                </div>
                                                : <span style={{ color: 'var(--muted)' }}>-</span>
                                            }
                                        </td>
                                        <td style={{ padding: '1rem 0.5rem', color: 'var(--muted)', fontSize: '0.8rem', lineHeight: 1.45 }}>
                                            {detail.behavior.totalTrackedTimeSec > 0
                                                ? `응시 ${formatSeconds(detail.elapsedTimeSec)} · 문항 평균 ${formatSeconds(detail.behavior.averageTimeSec)}`
                                                : detail.elapsedTimeSec > 0
                                                    ? `응시 ${formatSeconds(detail.elapsedTimeSec)}`
                                                : '추적 없음'}
                                            {detail.behavior.revisitedQuestionNumbers.length > 0 && (
                                                <div style={{ color: 'var(--primary)', fontWeight: 800 }}>
                                                    재방문 {detail.behavior.revisitedQuestionNumbers.join(', ')}번
                                                </div>
                                            )}
                                            {detail.behavior.focusLossCount > 0 && (
                                                <div style={{ color: 'var(--error)', fontWeight: 800 }}>
                                                    이탈 {detail.behavior.focusLossCount}회
                                                </div>
                                            )}
                                        </td>
                                        <td style={{ padding: '1rem 0.5rem' }}>
                                            {detail.retakeHref ? (
                                                <PremiumActionLink
                                                    enabled={retakeAssignmentsEnabled}
                                                    href={detail.retakeHref}
                                                    className="btn btn-secondary"
                                                    style={{ fontSize: '0.75rem', padding: '0.34rem 0.65rem', whiteSpace: 'nowrap' }}
                                                    lockedTitle="Pro 이상에서 학생별 추천 재시험을 만들 수 있습니다."
                                                >
                                                    유형 {detail.retakeIds.length}문항
                                                </PremiumActionLink>
                                            ) : detail.retakeDefinitionUnavailable ? (
                                                <span role="status" style={{ color: 'var(--warning)', fontSize: '0.76rem', fontWeight: 800 }}>
                                                    제출 정의 변경 · 재시험 불가
                                                </span>
                                            ) : (
                                                <span style={{ color: 'var(--success)', fontSize: '0.8rem', fontWeight: 800 }}>완료</span>
                                            )}
                                        </td>
                                        <td style={{ padding: '1rem 0.5rem', fontSize: '0.85rem', color: 'var(--muted)' }}>
                                            {detail.date}
                                        </td>
                                    </tr>
                                ))
                            )}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
}
