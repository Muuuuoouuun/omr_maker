"use client";

import { useMemo, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import useCometReveal from "@/components/dashboard/useCometReveal";
import { Exam, Attempt, type PlanKey } from "@/types/omr";
import {
    LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip,
    ResponsiveContainer, Legend
} from 'recharts';
import { Bell, Lock, MapPin, Target, TrendingUp } from "lucide-react";
import { PremiumActionLink, PremiumFeatureCard } from "@/components/PremiumFeatureGate";
import { formatKoreanDate } from "@/lib/pure";
import {
    buildLearningRecommendations,
    buildRetakeQuestionIds,
    getAttemptQuestionResults,
    studentScopeKeyForAttempt,
    summarizeAttemptBehavior,
} from "@/lib/premiumAnalytics";
import { baseAttemptsOnly, buildAttemptScoreLookup, resolveAttemptScore, retakeAttemptsOnly } from "@/lib/attemptScores";
import { computeRankPercentile } from "@/lib/scoreDistribution";
import {
    buildRegionalLearningScopes,
    filterAttemptsByRegion,
    regionNameForAttempt,
    type RegionalLearningScope,
} from "@/lib/regionalAnalytics";
import type { RosterGroup, RosterStudent } from "@/lib/rosterStorage";
import { resolveScopedSelection } from "@/lib/dashboardSelection";
import { buildRetakeHref } from "@/lib/retakeLinks";
import { hasPlanEntitlement } from "@/utils/plans";
import { buildStudentResultHref } from "@/lib/studentResultHub";

interface StudentAnalyticsTabProps {
    exams: Exam[];
    attempts: Attempt[];
    rosterStudents?: RosterStudent[];
    rosterGroups?: RosterGroup[];
    currentPlan?: PlanKey;
}

const ALL_REGION_KEY = "__all_regions__";

// Shared card surface so student-analytics sections match the exam tab's coherent
// grammar (rounded, subtly elevated, consistently bordered). The `.card` class has no
// styling of its own, so each card spreads this base first and overrides as needed.
const CARD_SURFACE_STYLE: CSSProperties = {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius-xl)',
    boxShadow: 'var(--shadow-md)',
};

function regionalScopeLabel(scope: RegionalLearningScope | undefined): string {
    return scope?.regionName || "전체 지역";
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
}: StudentAnalyticsTabProps) {
    const [selectedRegionKey, setSelectedRegionKey] = useState(ALL_REGION_KEY);
    const regionScopeOptions = useMemo(() => (
        buildRegionalLearningScopes({
            students: rosterStudents,
            groups: rosterGroups,
            attempts,
            exams,
        }).filter(scope => scope.attemptCount > 0)
    ), [attempts, exams, rosterGroups, rosterStudents]);
    const activeRegionKey = selectedRegionKey === ALL_REGION_KEY || regionScopeOptions.some(scope => scope.regionKey === selectedRegionKey)
        ? selectedRegionKey
        : ALL_REGION_KEY;
    const activeRegionScope = regionScopeOptions.find(scope => scope.regionKey === activeRegionKey);
    const activeRegionLabel = activeRegionKey === ALL_REGION_KEY ? "전체 지역" : regionalScopeLabel(activeRegionScope);
    const scopedAttempts = useMemo(() => (
        activeRegionKey === ALL_REGION_KEY
            ? attempts
            : filterAttemptsByRegion(attempts, activeRegionKey, rosterStudents, rosterGroups)
    ), [activeRegionKey, attempts, rosterGroups, rosterStudents]);
    const baseScopedAttempts = useMemo(() => baseAttemptsOnly(scopedAttempts), [scopedAttempts]);
    const retakeScopedAttempts = useMemo(() => retakeAttemptsOnly(scopedAttempts), [scopedAttempts]);

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
            const key = studentScopeKeyForAttempt(a);
            const current = studentMap.get(key);
            const regionName = regionNameForAttempt(a, rosterStudents, rosterGroups);
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
            .filter(a => studentScopeKeyForAttempt(a) === activeStudentKey)
            .sort((a, b) => new Date(a.finishedAt).getTime() - new Date(b.finishedAt).getTime());
    }, [activeStudentKey, scopedAttempts]);
    const studentBaseAttempts = useMemo(() => baseAttemptsOnly(studentAttempts), [studentAttempts]);
    const studentRetakeAttempts = useMemo(() => retakeAttemptsOnly(studentAttempts), [studentAttempts]);

    const unattemptedExams = useMemo(() => {
        const attemptedExamIds = new Set(studentBaseAttempts.map(attempt => attempt.examId));
        return exams.filter(exam => !attemptedExamIds.has(exam.id));
    }, [exams, studentBaseAttempts]);

    const examsById = useMemo(() => new Map(exams.map(exam => [exam.id, exam])), [exams]);

    const attemptScoreById = useMemo(() => {
        return buildAttemptScoreLookup(scopedAttempts, examsById);
    }, [scopedAttempts, examsById]);

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
                const exam = examsById.get(attempt.examId);
                const avgScore = averageScoreByExamId.get(attempt.examId) ?? 0;
                const studentScore = attemptScoreById.get(attempt.id)?.scorePercent
                    ?? resolveAttemptScore(attempt, exam).scorePercent;

                return {
                    date: formatKoreanDate(attempt.finishedAt),
                    examTitle: attempt.examTitle,
                    examId: attempt.examId,
                    studentScore,
                    avgScore,
                };
            });
    }, [studentAttempts, excludedExamIds, examsById, attemptScoreById, averageScoreByExamId]);

    // 시안 B — comet head leads the "내 점수" line draw (soft-light variant).
    const trendChartRef = useRef<HTMLDivElement | null>(null);
    useCometReveal(trendChartRef, {
        color: "var(--primary)",
        replayKey: trendData,
        enabled: studentGrowthReportsEnabled && trendData.length > 1,
    });

    const detailedAnalysis = useMemo(() => {
        const getScoreRate = (candidate: Attempt) => (
            attemptScoreById.get(candidate.id)?.scorePercent
            ?? resolveAttemptScore(candidate, examsById.get(candidate.examId)).scorePercent
        );

        return studentBaseAttempts.map(attempt => {
            const exam = examsById.get(attempt.examId);
            const examAttempts = [...(attemptsByExamId.get(attempt.examId) || [])]
                .sort((a, b) => getScoreRate(b) - getScoreRate(a));
            const totalStudents = examAttempts.length;
            const scoreSummary = attemptScoreById.get(attempt.id) ?? resolveAttemptScore(attempt, exam);
            const studentScoreRate = scoreSummary.scorePercent;
            const rank = examAttempts.findIndex(a => getScoreRate(a) === studentScoreRate) + 1 || totalStudents;

            // Calculate strengths and weaknesses based on labels
            const labelStats: Record<string, { correct: number, total: number }> = {};

            if (exam) {
                getAttemptQuestionResults(exam, attempt).forEach(result => {
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

            const recommendations = exam
                ? buildLearningRecommendations(exam, [attempt], {
                    scope: "attempt",
                    attempt,
                    limit: 5,
                })
                : [];
            const topWeakness = recommendations[0];
            const retakeIds = exam ? buildRetakeQuestionIds(exam, attempt) : [];
            const behavior = summarizeAttemptBehavior(attempt);

            return {
                attemptId: attempt.id,
                examId: attempt.examId,
                examTitle: attempt.examTitle,
                score: scoreSummary.earnedScore,
                totalScore: scoreSummary.totalScore,
                scoreRate: studentScoreRate,
                rank,
                totalStudents,
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
                    ? buildRetakeHref(attempt.examId, topWeakness?.sourceAttemptId || attempt.id, topWeakness?.retakeQuestionIds.length ? topWeakness.retakeQuestionIds : retakeIds, topWeakness?.retakeMode || "wrong", {
                        labels: topWeakness?.retakeLabels || [],
                        concepts: topWeakness?.retakeConcepts || [],
                    })
                    : "",
                behavior,
                elapsedTimeSec: behavior.elapsedTimeSec,
                date: formatKoreanDate(attempt.finishedAt)
            };
        }).reverse(); // Latest at the top
    }, [studentBaseAttempts, attemptsByExamId, examsById, attemptScoreById]);

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

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))', gap: '1.5rem' }}>
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

                    <div ref={trendChartRef} className="comet-chart-light" style={{ flex: 1, minHeight: studentGrowthReportsEnabled ? '350px' : 0, width: '100%', minWidth: 0, position: 'relative' }}>
                        <div className="chart-texture is-light" aria-hidden="true" />
                        {studentGrowthReportsEnabled && trendData.length > 0 ? (
                            <ResponsiveContainer
                                width="100%"
                                height="100%"
                                minWidth={0}
                                minHeight={350}
                                initialDimension={{ width: 760, height: 350 }}
                            >
                                <LineChart data={trendData} margin={{ top: 20, right: 30, left: 0, bottom: 20 }}>
                                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
                                    <XAxis dataKey="examTitle" tick={{ fill: 'var(--muted)', fontSize: 12 }} axisLine={false} tickLine={false} />
                                    <YAxis domain={[0, 100]} tick={{ fill: 'var(--muted)' }} axisLine={false} tickLine={false} />
                                    <RechartsTooltip
                                        contentStyle={{ borderRadius: '8px', border: '1px solid var(--border)', boxShadow: '0 4px 12px rgba(0,0,0,0.05)', background: 'var(--background)' }}
                                        labelStyle={{ fontWeight: 'bold', color: 'var(--text)', marginBottom: '8px' }}
                                    />
                                    <Legend wrapperStyle={{ paddingTop: '20px' }} />
                                    <Line
                                        name="내 점수"
                                        type="monotone"
                                        dataKey="studentScore"
                                        className="comet-target"
                                        stroke="var(--primary)"
                                        strokeWidth={3}
                                        dot={{ r: 5, strokeWidth: 2, fill: 'var(--background)' }}
                                        activeDot={{ r: 7 }}
                                        isAnimationActive={false}
                                    />
                                    <Line
                                        name="선택 범위 평균"
                                        type="monotone"
                                        dataKey="avgScore"
                                        stroke="var(--warning)"
                                        strokeWidth={2}
                                        strokeDasharray="5 5"
                                        dot={{ r: 4, strokeWidth: 0, fill: 'var(--muted)' }}
                                        animationBegin={1200}
                                        animationDuration={900}
                                        animationEasing="ease-out"
                                    />
                                </LineChart>
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
                                                <span style={{ color: item.weakRate >= 70 ? 'var(--error)' : 'var(--warning)', fontWeight: 900, fontSize: '0.8rem' }}>
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
                                const exam = examsById.get(attempt.examId);
                                const scoreRate = attemptScoreById.get(attempt.id)?.scorePercent
                                    ?? resolveAttemptScore(attempt, exam).scorePercent;

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
                                        <div style={{ fontWeight: 800, fontSize: '1.1rem', color: scoreRate >= 80 ? 'var(--success)' : (scoreRate < 50 ? 'var(--error)' : 'var(--text)') }}>
                                            {scoreRate}점
                                        </div>
                                    </label>
                                );
                            })}
                        </div>
                    </div>

                    {studentRetakeAttempts.length > 0 && (
                        <div className="card" style={{ ...CARD_SURFACE_STYLE,padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '0.8rem' }}>
                            <h3 style={{ fontSize: '1.1rem', fontWeight: 800, color: '#0f766e' }}>
                                재시험 회복 기록 ({studentRetakeAttempts.length})
                            </h3>
                            <p style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>
                                원시험 성취도와 별도로, 틀린 문항을 다시 풀어 회복한 기록입니다.
                            </p>
                            <div style={{ display: 'grid', gap: '0.5rem' }}>
                                {studentRetakeAttempts.slice().reverse().slice(0, 5).map(attempt => {
                                    const exam = examsById.get(attempt.examId);
                                    const scoreRate = attemptScoreById.get(attempt.id)?.scorePercent
                                        ?? resolveAttemptScore(attempt, exam).scorePercent;
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
                                                background: 'color-mix(in srgb, #0f766e 8%, var(--surface))',
                                                border: '1px solid color-mix(in srgb, #0f766e 28%, transparent)',
                                                color: 'inherit',
                                            }}
                                        >
                                            <div style={{ minWidth: 0 }}>
                                                <div style={{ fontWeight: 800, color: 'var(--foreground)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{attempt.examTitle}</div>
                                                <div style={{ color: '#0f766e', fontSize: '0.75rem', marginTop: '0.2rem', fontWeight: 800 }}>
                                                    {attempt.retake?.questionIds.length || 0}문항 · {formatKoreanDate(attempt.finishedAt)}
                                                </div>
                                            </div>
                                            <div style={{ color: scoreRate >= 80 ? 'var(--success)' : scoreRate < 50 ? 'var(--error)' : 'var(--text)', fontWeight: 900 }}>
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
                                        <td style={{ padding: '1rem 0.5rem', fontWeight: 700, color: detail.scoreRate >= 80 ? 'var(--success)' : (detail.scoreRate < 50 ? 'var(--error)' : 'inherit') }}>
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
                                                <span style={{ background: 'rgba(16, 185, 129, 0.1)', color: 'var(--success)', padding: '4px 8px', borderRadius: '4px', fontSize: '0.85rem', fontWeight: 600 }}>
                                                    {detail.strongPoint}
                                                </span>
                                                : <span style={{ color: 'var(--muted)' }}>-</span>
                                            }
                                        </td>
                                        <td style={{ padding: '1rem 0.5rem' }}>
                                            {detail.weakPoint ?
                                                <div>
                                                    <span style={{ background: 'rgba(239, 68, 68, 0.1)', color: 'var(--error)', padding: '4px 8px', borderRadius: '4px', fontSize: '0.85rem', fontWeight: 700 }}>
                                                        {detail.weakPoint}
                                                    </span>
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
