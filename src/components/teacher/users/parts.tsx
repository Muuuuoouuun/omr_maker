"use client";

// Extracted verbatim from src/app/teacher/users/page.tsx (Phase 2
// decomposition): the leaf display components, modals, and formatters the
// page renders. Pure movement — no behaviour change.

import { useState } from "react";
import NextLink from "next/link";
import StudentConceptMasteryPanel from "@/components/teacher/student-results/StudentConceptMasteryPanel";
import StatusPill from "@/components/dashboard/StatusPill";
import {
    Users,
    TrendingUp,
    CheckCircle2,
    Clock,
    X,
    PenLine,
    Target,
    AlertTriangle,
    FileText,
    BarChart3,
    RefreshCw,
} from "lucide-react";
import type { Attempt } from "@/types/omr";
import { GROUP_COLORS, type RosterGroup, type RosterStudent } from "@/lib/rosterStorage";
import {
    type RosterCsvConflictDisposition,
    type RosterCsvFieldChange,
    type RosterCsvImportPlan,
} from "@/lib/rosterCsvImport";
import { type StudentProfileInsight, type StudentProfileWeaknessInsight } from "@/lib/studentProfileAnalytics";
import { type GroupProfileInsight, type GroupProfileWeaknessInsight } from "@/lib/groupProfileAnalytics";
import { DEFAULT_REGION_NAME } from "@/lib/regionIdentity";
import { buildRetakeHref } from "@/lib/retakeLinks";
import { PremiumActionLink } from "@/components/PremiumFeatureGate";
import { buildStudentResultHref } from "@/lib/studentResultHub";

export function rosterGroupForStudentInput(groupName: string, region: string, groups: RosterGroup[], groupId?: string): RosterGroup | undefined {
    const requestedRegion = region.trim();
    if (groupId) {
        const selected = groups.find(item => item.id === groupId);
        if (selected) return selected;
    }
    return groups.find(item =>
        item.name === groupName
        && (requestedRegion ? item.region?.trim() === requestedRegion : true)
    ) || groups.find(item => item.name === groupName && !item.region?.trim())
        || groups.find(item => item.name === groupName);
}

export function hasArchivedHandwriting(attempt: Attempt): boolean {
    const summaryStrokesRef = "handwritingStrokesRef" in attempt
        ? attempt.handwritingStrokesRef
        : undefined;
    return !!attempt.handwritingArchived && !!(attempt.handwriting?.strokesRef || summaryStrokesRef || attempt.drawingsRef);
}

export function handwritingLabel(attempt: Attempt): string {
    const summaryQuestionCount = "handwritingQuestionCount" in attempt
        && typeof attempt.handwritingQuestionCount === "number"
        ? attempt.handwritingQuestionCount
        : 0;
    const questionCount = attempt.questionDrawings?.length || summaryQuestionCount;
    if (questionCount > 0) return `${questionCount}문항`;
    if (attempt.drawingPageCount) return `${attempt.drawingPageCount}쪽`;
    return "저장됨";
}

export function groupOptionLabel(group: RosterGroup): string {
    return group.region ? `${group.name} · ${group.region}` : group.name;
}

export function initialStudentGroupId(student: RosterStudent | null, groups: RosterGroup[]): string {
    if (!student) return groups[0]?.id ?? "";
    return rosterGroupForStudentInput(student.group, student.region || "", groups)?.id || groups.find(group => group.name === student.group)?.id || "";
}

export const ALL_REGION_KEY = "__all_regions__";

export type StudentFormData = { name: string; email: string; group: string; groupId: string; region: string };

export type GroupFormData = { name: string; color: string; region: string };

export type SortKey = "name" | "avgScore" | "examsTaken" | "lastActive";

export type SortDirection = "asc" | "desc";

export type ConfirmAction =
    | { kind: "student"; id: string; label: string }
    | { kind: "bulk"; count: number }
    | { kind: "invite"; id: string; label: string }
    | { kind: "group"; id: string; label: string; count: number };

export function KPI({ label, value, color, icon }: { label: string; value: number; color: string; icon: React.ReactNode }) {
    return (
        <div className="bento-card" style={{ padding: '1.25rem 1.4rem', position: 'relative', overflow: 'hidden' }}>
            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, background: `linear-gradient(90deg, ${color}, transparent)` }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
                <div>
                    <div style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '0.5rem' }}>{label}</div>
                    <div style={{ fontSize: '2rem', fontWeight: 900, letterSpacing: '-0.03em', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
                </div>
                <div style={{
                    color, background: `color-mix(in srgb, ${color}, transparent 88%)`,
                    padding: 10, borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center'
                }}>{icon}</div>
            </div>
        </div>
    );
}

export function MiniStat({ label, value, color }: { label: string; value: string; color: string }) {
    return (
        <div style={{ padding: '0.85rem', background: `color-mix(in srgb, ${color}, transparent 92%)`, borderRadius: 'var(--radius-md)', border: `1px solid ${color}22` }}>
            <div style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.05em', marginBottom: '0.25rem' }}>{label}</div>
            <div style={{ fontSize: '1.15rem', fontWeight: 800, color }}>{value}</div>
        </div>
    );
}

export function MiniRegionMetric({ label, value }: { label: string; value: string }) {
    return (
        <div>
            <div style={{ fontSize: '0.65rem', color: 'var(--muted)', fontWeight: 800, marginBottom: '0.15rem' }}>{label}</div>
            <div style={{ fontSize: '0.9rem', color: 'var(--foreground)', fontWeight: 900, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
        </div>
    );
}

export function RegionalAverageMetric({ averageScore }: { averageScore: number | null }) {
    return <MiniRegionMetric label="평균" value={averageScore === null ? "미채점" : `${averageScore}점`} />;
}

// DEV-B: clickable/keyboard-focusable table header that toggles asc/desc
// sort for a column, with a small arrow indicator. Rendered inside a plain
// <th> so it inherits the header row's text styling via `font: inherit`.
export function SortableHeaderButton({
    label, sortKey, sortState, onSort,
}: {
    label: string;
    sortKey: SortKey;
    sortState: { key: SortKey; direction: SortDirection } | null;
    onSort: (key: SortKey) => void;
}) {
    const active = sortState?.key === sortKey;
    return (
        <button
            type="button"
            onClick={() => onSort(sortKey)}
            style={{
                display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
                background: 'transparent', color: 'inherit', font: 'inherit',
                letterSpacing: 'inherit', textTransform: 'inherit', cursor: 'pointer',
                padding: 0,
            }}
        >
            {label}
            <span aria-hidden="true" style={{ fontSize: '0.65rem', opacity: active ? 1 : 0.35 }}>
                {active ? (sortState?.direction === "asc" ? "▲" : "▼") : "↕"}
            </span>
        </button>
    );
}

// ===== Inline modals =====

export function formatAttemptDate(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "일시 없음";
    return new Intl.DateTimeFormat("ko-KR", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    }).format(date);
}

export function scoreColor(score: number): string {
    if (score >= 80) return "var(--success)";
    if (score >= 65) return "var(--warning)";
    return "var(--error)";
}

export function weaknessKindLabel(kind: StudentProfileWeaknessInsight["kind"] | GroupProfileWeaknessInsight["kind"]): string {
    const labels: Record<StudentProfileWeaknessInsight["kind"] | GroupProfileWeaknessInsight["kind"], string> = {
        concept: "개념",
        mistakeType: "오답 원인",
        unit: "단원",
        source: "지문",
        skill: "스킬",
        difficulty: "난도",
        label: "라벨",
    };
    return labels[kind] || "유형";
}

export function questionNumberLabel(numbers: number[]): string {
    return numbers.length > 0 ? numbers.map(number => `${number}번`).join(", ") : "문항 없음";
}

export function formatDuration(totalSec?: number): string {
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

export function weaknessRetakeHref(weakness: StudentProfileWeaknessInsight | GroupProfileWeaknessInsight): string {
    return buildRetakeHref(weakness.examId, weakness.sourceAttemptId, weakness.retakeQuestionIds, weakness.retakeMode, {
        labels: weakness.retakeLabels,
        concepts: weakness.retakeConcepts,
    });
}

export function ProfileMetric({ label, value, icon, color }: { label: string; value: string; icon: React.ReactNode; color: string }) {
    return (
        <div style={{
            padding: '1rem',
            background: `color-mix(in srgb, ${color}, transparent 93%)`,
            border: `1px solid ${color}24`,
            borderRadius: 'var(--radius-md)',
            minWidth: 0,
        }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', color, marginBottom: '0.55rem' }}>
                {icon}
                <span style={{ fontSize: '0.72rem', fontWeight: 800, letterSpacing: '0.06em' }}>{label}</span>
            </div>
            <div style={{ fontSize: '1.25rem', fontWeight: 900, color: 'var(--foreground)', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
        </div>
    );
}

export function WeaknessRetakeLink({ weakness, enabled }: { weakness: StudentProfileWeaknessInsight | GroupProfileWeaknessInsight; enabled: boolean }) {
    if (weakness.retakeQuestionIds.length === 0) return null;
    return (
        <PremiumActionLink
            enabled={enabled}
            href={weaknessRetakeHref(weakness)}
            lockedTitle="Pro 이상에서 약점 유형 재시험 링크를 만들 수 있습니다."
            style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '0.36rem 0.62rem',
                borderRadius: 'var(--radius-md)',
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                color: 'var(--foreground)',
                fontSize: '0.74rem',
                fontWeight: 850,
                lineHeight: 1,
                whiteSpace: 'nowrap',
            }}
        >
            재추천 {weakness.retakeQuestionIds.length}문항
        </PremiumActionLink>
    );
}

export function GroupProfileModal({
    group, profile, onClose, retakeAssignmentsEnabled,
}: {
    group: RosterGroup;
    profile: GroupProfileInsight;
    onClose: () => void;
    retakeAssignmentsEnabled: boolean;
}) {
    return (
        <ModalShell title={`${group.name} 반 분석`} onClose={onClose} maxWidth={940}>
            <div style={{ display: 'grid', gap: '1rem' }}>
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '1rem',
                    padding: '1rem',
                    background: 'var(--background)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-md)',
                    flexWrap: 'wrap',
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.8rem', minWidth: 0 }}>
                        <div style={{
                            width: 48,
                            height: 48,
                            borderRadius: 'var(--radius-md)',
                            background: `color-mix(in srgb, ${group.color}, transparent 86%)`,
                            color: group.color,
                            display: 'grid',
                            placeItems: 'center',
                            flexShrink: 0,
                        }}>
                            <Users size={22} />
                        </div>
                        <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: '1.05rem', fontWeight: 900 }}>{group.name}</div>
                            <div style={{ color: 'var(--muted)', fontSize: '0.83rem' }}>
                                등록 {profile.rosterStudentCount}명 · 응시 {profile.activeStudentCount}명 · 원시험 {profile.attemptCount}건 · 재시험 {profile.retakeAttemptCount}건
                            </div>
                        </div>
                    </div>
                    <StatusPill
                        label={`평균 ${profile.averageScore}점`}
                        size="sm"
                        style={{
                            background: `color-mix(in srgb, ${group.color}, transparent 88%)`,
                            color: group.color,
                            border: 'none',
                        }}
                    />
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '0.75rem' }}>
                    <ProfileMetric label="시험 수" value={`${profile.examCount}개`} color="#4f46e5" icon={<FileText size={15} />} />
                    <ProfileMetric label="원시험" value={`${profile.attemptCount}건`} color="#10b981" icon={<CheckCircle2 size={15} />} />
                    <ProfileMetric label="재시험" value={`${profile.retakeAttemptCount}건`} color="#0f766e" icon={<RefreshCw size={15} />} />
                    <ProfileMetric label="응시 학생" value={`${profile.activeStudentCount}명`} color={group.color} icon={<Users size={15} />} />
                    <ProfileMetric label="오답/미응답" value={`${profile.wrongQuestionCount}/${profile.unansweredQuestionCount}`} color="#ef4444" icon={<AlertTriangle size={15} />} />
                    <ProfileMetric label="평균 시험시간" value={formatDuration(profile.averageElapsedTimeSec)} color="#0ea5e9" icon={<Clock size={15} />} />
                    <ProfileMetric label="필기 보관률" value={`${profile.handwritingArchiveRate}%`} color="#7c3aed" icon={<PenLine size={15} />} />
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1rem' }}>
                    <section style={{ minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', marginBottom: '0.65rem' }}>
                            <BarChart3 size={16} color="var(--primary)" />
                            <h4 style={{ fontSize: '0.92rem', fontWeight: 800 }}>시험별 현황</h4>
                        </div>
                        <div style={{ display: 'grid', gap: '0.55rem', maxHeight: 360, overflowY: 'auto', paddingRight: '0.25rem' }}>
                            {profile.exams.length === 0 ? (
                                <div style={{ padding: '1rem', background: 'var(--background)', borderRadius: 'var(--radius-md)', color: 'var(--muted)', fontSize: '0.86rem' }}>
                                    아직 이 반의 응시 데이터가 없습니다.
                                </div>
                            ) : profile.exams.map(exam => (
                                <div key={exam.examId} style={{ padding: '0.85rem', background: 'var(--background)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', alignItems: 'flex-start' }}>
                                        <div style={{ minWidth: 0 }}>
                                            <div style={{ fontWeight: 900, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{exam.examTitle}</div>
                                            <div style={{ color: 'var(--muted)', fontSize: '0.75rem', marginTop: '0.2rem' }}>
                                                응시 {exam.studentCount}명 · 제출 {exam.attemptCount}건
                                            </div>
                                        </div>
                                        <div style={{ color: scoreColor(exam.averageScore), fontWeight: 900, fontVariantNumeric: 'tabular-nums' }}>{exam.averageScore}점</div>
                                    </div>
                                    <div style={{ color: 'var(--muted)', fontSize: '0.76rem', marginTop: '0.55rem', lineHeight: 1.6 }}>
                                        오답 {exam.wrongQuestionCount}건 · 미응답 {exam.unansweredQuestionCount}건
                                        {exam.averageElapsedTimeSec > 0 ? ` · 평균 ${formatDuration(exam.averageElapsedTimeSec)}` : ""}
                                        {exam.averageQuestionTimeSec > 0 ? ` · 문항 ${formatDuration(exam.averageQuestionTimeSec)}` : ""}
                                        {exam.topWeakness ? ` · 최우선 ${exam.topWeakness.title}` : ""}
                                    </div>
                                    <div style={{ marginTop: '0.7rem', display: 'flex', justifyContent: 'flex-end' }}>
                                        <NextLink
                                            href={`/teacher/exam/${exam.examId}`}
                                            style={{
                                                padding: '0.35rem 0.65rem',
                                                borderRadius: 'var(--radius-md)',
                                                background: 'var(--surface)',
                                                border: '1px solid var(--border)',
                                                color: 'var(--foreground)',
                                                fontSize: '0.76rem',
                                                fontWeight: 800,
                                            }}
                                        >
                                            시험 분석
                                        </NextLink>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </section>

                    <section style={{ minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', marginBottom: '0.65rem' }}>
                            <Target size={16} color="var(--error)" />
                            <h4 style={{ fontSize: '0.92rem', fontWeight: 800 }}>반 취약 유형</h4>
                        </div>
                        <div style={{ display: 'grid', gap: '0.55rem', maxHeight: 360, overflowY: 'auto', paddingRight: '0.25rem' }}>
                            {profile.weaknessGroups.length === 0 ? (
                                <div style={{ padding: '1rem', background: 'var(--background)', borderRadius: 'var(--radius-md)', color: 'var(--muted)', fontSize: '0.86rem' }}>
                                    누적 오답 유형이 아직 없습니다.
                                </div>
                            ) : profile.weaknessGroups.map(weakness => (
                                <div key={weakness.key} style={{ padding: '0.85rem', background: 'var(--background)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', marginBottom: '0.4rem' }}>
                                        <div style={{ minWidth: 0 }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.2rem', flexWrap: 'wrap' }}>
                                                <StatusPill tone="grade" label={weaknessKindLabel(weakness.kind)} size="sm" />
                                                <span style={{ color: 'var(--muted)', fontSize: '0.72rem' }}>{weakness.examTitle}</span>
                                            </div>
                                            <div style={{ fontWeight: 900, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{weakness.title}</div>
                                        </div>
                                        <div style={{ textAlign: 'right', flexShrink: 0 }}>
                                            <div style={{ color: '#ef4444', fontWeight: 900, fontVariantNumeric: 'tabular-nums' }}>{weakness.wrongRate}%</div>
                                            <div style={{ color: 'var(--muted)', fontSize: '0.7rem' }}>{weakness.wrongCount}/{weakness.totalCount}</div>
                                        </div>
                                    </div>
                                    <div style={{ fontSize: '0.76rem', color: 'var(--muted)', lineHeight: 1.6 }}>
                                        {weakness.basis} · {questionNumberLabel(weakness.questionNumbers)}
                                        {weakness.unansweredCount > 0 ? ` · 미응답 ${weakness.unansweredCount}건` : ""}
                                    </div>
                                    <div style={{ marginTop: '0.28rem', color: 'var(--muted)', fontSize: '0.72rem', lineHeight: 1.45 }}>
                                        {weakness.reason}
                                    </div>
                                    <div style={{ marginTop: '0.55rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.55rem', flexWrap: 'wrap' }}>
                                        <div style={{ color: 'var(--primary)', fontSize: '0.76rem', fontWeight: 850 }}>
                                            {weakness.recommendedAction}
                                        </div>
                                        <WeaknessRetakeLink weakness={weakness} enabled={retakeAssignmentsEnabled} />
                                    </div>
                                </div>
                            ))}
                        </div>
                    </section>
                </div>

                {(profile.mostMissedQuestions.length > 0 || profile.tagStats.length > 0) && (
                    <section>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', marginBottom: '0.65rem' }}>
                            <Clock size={16} color="var(--primary)" />
                            <h4 style={{ fontSize: '0.92rem', fontWeight: 800 }}>문항/라벨 트래킹</h4>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '0.75rem' }}>
                            <div style={{ padding: '0.9rem', background: 'var(--background)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
                                <div style={{ fontWeight: 900, marginBottom: '0.6rem', color: 'var(--foreground)' }}>가장 많이 놓친 문항</div>
                                {profile.mostMissedQuestions.length === 0 ? (
                                    <div style={{ color: 'var(--muted)', fontSize: '0.82rem' }}>오답 문항이 아직 없습니다.</div>
                                ) : (
                                    <div style={{ display: 'grid', gap: '0.45rem' }}>
                                        {profile.mostMissedQuestions.slice(0, 4).map(item => (
                                            <div key={item.key} style={{ display: 'flex', justifyContent: 'space-between', gap: '0.7rem', fontSize: '0.8rem' }}>
                                                <span style={{ color: 'var(--foreground)', fontWeight: 850 }}>
                                                    {item.examTitle} · {item.questionNumber}번
                                                </span>
                                                <span style={{ color: 'var(--error)', fontWeight: 900 }}>
                                                    {item.wrongRate}%{item.averageTimeSec ? ` · ${formatDuration(item.averageTimeSec)}` : ""}
                                                </span>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                            <div style={{ padding: '0.9rem', background: 'var(--background)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
                                <div style={{ fontWeight: 900, marginBottom: '0.6rem', color: 'var(--foreground)' }}>라벨별 통계</div>
                                {profile.tagStats.length === 0 ? (
                                    <div style={{ color: 'var(--muted)', fontSize: '0.82rem' }}>라벨 데이터가 아직 없습니다.</div>
                                ) : (
                                    <div style={{ display: 'grid', gap: '0.45rem' }}>
                                        {profile.tagStats.slice(0, 5).map(item => (
                                            <div key={item.key} style={{ display: 'flex', justifyContent: 'space-between', gap: '0.7rem', fontSize: '0.8rem' }}>
                                                <span style={{ color: 'var(--foreground)', fontWeight: 850 }}>
                                                    {item.title} · {item.questionNumbers.slice(0, 4).join(', ')}번
                                                </span>
                                                <span style={{ color: item.wrongRate >= 60 ? 'var(--error)' : 'var(--muted)', fontWeight: 900 }}>
                                                    오답 {item.wrongRate}%{item.averageTimeSec ? ` · ${formatDuration(item.averageTimeSec)}` : ""}
                                                </span>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>
                    </section>
                )}

                <section>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', marginBottom: '0.65rem' }}>
                        <AlertTriangle size={16} color="var(--warning)" />
                        <h4 style={{ fontSize: '0.92rem', fontWeight: 800 }}>집중 관리 학생</h4>
                    </div>
                    {profile.studentsNeedingAttention.length === 0 ? (
                        <div style={{ padding: '1rem', background: 'var(--background)', borderRadius: 'var(--radius-md)', color: 'var(--muted)', fontSize: '0.86rem' }}>
                            현재 기준으로 집중 관리 학생이 없습니다.
                        </div>
                    ) : (
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.65rem' }}>
                            {profile.studentsNeedingAttention.map(student => (
                                <div key={student.key} style={{ padding: '0.85rem', background: 'var(--background)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
                                    <div style={{ fontWeight: 900, marginBottom: '0.3rem' }}>{student.name}</div>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', color: 'var(--muted)', fontSize: '0.76rem' }}>
                                        <span>평균 {student.averageScore}점</span>
                                        <span>최근 {student.latestScore}점</span>
                                    </div>
                                    <div style={{
                                        marginTop: '0.45rem',
                                        color: student.trendDelta >= 0 ? 'var(--success)' : 'var(--error)',
                                        fontSize: '0.75rem',
                                        fontWeight: 900,
                                    }}>
                                        추세 {student.trendDelta > 0 ? "+" : ""}{student.trendDelta}점 · {student.attemptCount}회
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </section>
            </div>
        </ModalShell>
    );
}

export function StudentProfileModal({
    student, profile, onClose, retakeAssignmentsEnabled,
}: {
    student: RosterStudent;
    profile: StudentProfileInsight;
    onClose: () => void;
    retakeAssignmentsEnabled: boolean;
}) {
    // Score trend is exam-performance signal (an improving/declining trend),
    // not a system state — success for up, grade (not error) for down. See
    // docs/design-system.md's --error vs --grade-red rule.
    const trendTone = profile.trendDelta === null ? "muted" : profile.trendDelta >= 0 ? "success" : "grade";
    const trendLabel = profile.trendDelta === null
        ? "비교 불가"
        : profile.trendDelta === 0
            ? "변화 없음"
            : `${profile.trendDelta > 0 ? "+" : ""}${profile.trendDelta}점`;

    return (
        <ModalShell title={`${student.name} 학생 성장 리포트`} onClose={onClose} maxWidth={900}>
            <div style={{ display: 'grid', gap: '1rem' }}>
                <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: '1rem',
                    padding: '1rem',
                    background: 'var(--background)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-md)',
                    flexWrap: 'wrap',
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.8rem', minWidth: 0 }}>
                        <div style={{
                            width: 48,
                            height: 48,
                            borderRadius: '50%',
                            background: student.avatar,
                            color: 'white',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontWeight: 900,
                            flexShrink: 0,
                        }}>
                            {student.name.slice(1, 2)}
                        </div>
                        <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: '1rem', fontWeight: 800 }}>{student.name}</div>
                            <div style={{ color: 'var(--muted)', fontSize: '0.83rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{student.email}</div>
                        </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                        <span className="badge badge-primary">{student.group}</span>
                        <StatusPill tone={trendTone} label={`최근 추세 ${trendLabel}`} size="sm" />
                    </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '0.75rem' }}>
                    <ProfileMetric label="원시험 평균" value={profile.averageScore === null ? "확인 불가" : `${profile.averageScore}점`} color="#4f46e5" icon={<BarChart3 size={15} />} />
                    <ProfileMetric label="최근 원시험" value={profile.latestScore === null ? "확인 불가" : `${profile.latestScore}점`} color={profile.latestScore === null ? "var(--muted)" : scoreColor(profile.latestScore)} icon={<TrendingUp size={15} />} />
                    <ProfileMetric label="재시험" value={`${profile.retakeAttemptCount}회`} color="#0f766e" icon={<RefreshCw size={15} />} />
                    <ProfileMetric label="오답/미응답" value={`${profile.wrongQuestionCount}/${profile.unansweredQuestionCount}`} color="#ef4444" icon={<AlertTriangle size={15} />} />
                    <ProfileMetric label="필기 보관" value={`${profile.handwritingArchiveCount}건`} color="#7c3aed" icon={<PenLine size={15} />} />
                    <ProfileMetric label="평균 시험시간" value={formatDuration(profile.averageElapsedTimeSec)} color="#0ea5e9" icon={<Clock size={15} />} />
                    <ProfileMetric label="문항 평균시간" value={formatDuration(profile.averageQuestionTimeSec)} color="#f59e0b" icon={<Clock size={15} />} />
                </div>

                {profile.conceptMastery ? <StudentConceptMasteryPanel summary={profile.conceptMastery} /> : null}

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1rem' }}>
                    <section style={{ minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', marginBottom: '0.65rem' }}>
                            <FileText size={16} color="var(--primary)" />
                            <h4 style={{ fontSize: '0.92rem', fontWeight: 800 }}>최근 응시</h4>
                        </div>
                        <div style={{ display: 'grid', gap: '0.55rem', maxHeight: 360, overflowY: 'auto', paddingRight: '0.25rem' }}>
                            {profile.attempts.length === 0 ? (
                                <div style={{ padding: '1rem', background: 'var(--background)', borderRadius: 'var(--radius-md)', color: 'var(--muted)', fontSize: '0.86rem' }}>
                                    아직 응시 이력이 없습니다.
                                </div>
                            ) : profile.attempts.map(attempt => (
                                <div key={attempt.id} style={{ padding: '0.85rem', background: 'var(--background)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', alignItems: 'flex-start' }}>
                                        <div style={{ minWidth: 0 }}>
                                            <div style={{ fontSize: '0.9rem', fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{attempt.examTitle}</div>
                                            <div style={{ display: 'flex', gap: '0.35rem', alignItems: 'center', flexWrap: 'wrap', marginTop: '0.15rem' }}>
                                                <span style={{ fontSize: '0.76rem', color: 'var(--muted)' }}>{formatAttemptDate(attempt.finishedAt)}</span>
                                                {attempt.isRetake && (
                                                    <StatusPill
                                                        tone="retake"
                                                        label={`재시험 ${attempt.retakeQuestionCount}문항`}
                                                        size="sm"
                                                    />
                                                )}
                                            </div>
                                        </div>
                                        <div style={{ color: attempt.scorePercent === null ? "var(--muted)" : scoreColor(attempt.scorePercent), fontWeight: 900, fontVariantNumeric: 'tabular-nums' }}>{attempt.scorePercent === null ? "미채점" : `${attempt.scorePercent}점`}</div>
                                    </div>
                                    <div style={{ display: 'grid', gap: '0.35rem', marginTop: '0.65rem', color: 'var(--muted)', fontSize: '0.78rem' }}>
                                        <div>오답 {questionNumberLabel(attempt.wrongQuestionNumbers)}</div>
                                        <div>미응답 {questionNumberLabel(attempt.unansweredQuestionNumbers)}</div>
                                        <div>
                                            응시 {formatDuration(attempt.elapsedTimeSec)}
                                            {attempt.averageQuestionTimeSec > 0 ? ` · 문항 평균 ${formatDuration(attempt.averageQuestionTimeSec)}` : ""}
                                        </div>
                                        {(attempt.slowQuestionNumbers.length > 0 || attempt.revisitedQuestionNumbers.length > 0 || attempt.focusLossCount > 0) && (
                                            <div style={{ color: 'var(--primary)', fontWeight: 800 }}>
                                                {attempt.slowQuestionNumbers.length > 0 ? `오래 머문 ${questionNumberLabel(attempt.slowQuestionNumbers)}` : ""}
                                                {attempt.revisitedQuestionNumbers.length > 0 ? `${attempt.slowQuestionNumbers.length > 0 ? " · " : ""}재방문 ${questionNumberLabel(attempt.revisitedQuestionNumbers)}` : ""}
                                                {attempt.focusLossCount > 0 ? `${attempt.slowQuestionNumbers.length > 0 || attempt.revisitedQuestionNumbers.length > 0 ? " · " : ""}이탈 ${attempt.focusLossCount}회` : ""}
                                            </div>
                                        )}
                                        {attempt.handwritingArchived && (
                                            <div style={{ color: '#7c3aed', fontWeight: 800, display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                                                <PenLine size={12} /> 필기 {attempt.handwritingLabel}
                                            </div>
                                        )}
                                    </div>
                                    <div style={{ marginTop: '0.7rem', display: 'flex', justifyContent: 'flex-end' }}>
                                        <NextLink
                                            href={buildStudentResultHref(attempt.id, "report")}
                                            aria-label={`${attempt.examTitle} 리포트 열기`}
                                            style={{
                                                display: 'inline-flex',
                                                alignItems: 'center',
                                                justifyContent: 'center',
                                                minHeight: 44,
                                                padding: '0.35rem 0.65rem',
                                                borderRadius: 'var(--radius-md)',
                                                background: 'var(--surface)',
                                                border: '1px solid var(--border)',
                                                color: 'var(--foreground)',
                                                fontSize: '0.76rem',
                                                fontWeight: 800,
                                                textAlign: 'center',
                                            }}
                                        >
                                            리포트 열기
                                        </NextLink>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </section>

                    <section style={{ minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', marginBottom: '0.65rem' }}>
                            <Target size={16} color="var(--error)" />
                            <h4 style={{ fontSize: '0.92rem', fontWeight: 800 }}>취약 유형</h4>
                        </div>
                        <div style={{ display: 'grid', gap: '0.55rem', maxHeight: 360, overflowY: 'auto', paddingRight: '0.25rem' }}>
                            {profile.weaknessGroups.length === 0 ? (
                                <div style={{ padding: '1rem', background: 'var(--background)', borderRadius: 'var(--radius-md)', color: 'var(--muted)', fontSize: '0.86rem' }}>
                                    누적 오답 유형이 아직 없습니다.
                                </div>
                            ) : profile.weaknessGroups.map(group => (
                                <div key={group.key} style={{ padding: '0.85rem', background: 'var(--background)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', marginBottom: '0.4rem' }}>
                                        <div style={{ minWidth: 0 }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.2rem', flexWrap: 'wrap' }}>
                                                <StatusPill tone="grade" label={weaknessKindLabel(group.kind)} size="sm" />
                                                <span style={{ color: 'var(--muted)', fontSize: '0.72rem' }}>{group.examTitle}</span>
                                            </div>
                                            <div style={{ fontWeight: 900, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{group.title}</div>
                                        </div>
                                        <div style={{ textAlign: 'right', flexShrink: 0 }}>
                                            <div style={{ color: '#ef4444', fontWeight: 900, fontVariantNumeric: 'tabular-nums' }}>{group.wrongRate}%</div>
                                            <div style={{ color: 'var(--muted)', fontSize: '0.7rem' }}>{group.wrongCount}/{group.totalCount}</div>
                                        </div>
                                    </div>
                                    <div style={{ fontSize: '0.76rem', color: 'var(--muted)', lineHeight: 1.6 }}>
                                        {group.basis} · {questionNumberLabel(group.questionNumbers)}
                                        {group.unansweredCount > 0 ? ` · 미응답 ${group.unansweredCount}건` : ""}
                                    </div>
                                    <div style={{ marginTop: '0.28rem', color: 'var(--muted)', fontSize: '0.72rem', lineHeight: 1.45 }}>
                                        {group.reason}
                                    </div>
                                    <div style={{ marginTop: '0.55rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.55rem', flexWrap: 'wrap' }}>
                                        <div style={{ color: 'var(--primary)', fontSize: '0.76rem', fontWeight: 850 }}>
                                            {group.recommendedAction}
                                        </div>
                                        <WeaknessRetakeLink weakness={group} enabled={retakeAssignmentsEnabled} />
                                    </div>
                                </div>
                            ))}
                        </div>
                    </section>
                </div>

                {(profile.mostMissedQuestions.length > 0 || profile.tagStats.length > 0) && (
                    <section>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', marginBottom: '0.65rem' }}>
                            <Clock size={16} color="var(--primary)" />
                            <h4 style={{ fontSize: '0.92rem', fontWeight: 800 }}>개인 문항/라벨 트래킹</h4>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '0.75rem' }}>
                            <div style={{ padding: '0.9rem', background: 'var(--background)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
                                <div style={{ fontWeight: 900, marginBottom: '0.6rem', color: 'var(--foreground)' }}>가장 많이 틀린 문항</div>
                                {profile.mostMissedQuestions.length === 0 ? (
                                    <div style={{ color: 'var(--muted)', fontSize: '0.82rem' }}>오답 문항이 아직 없습니다.</div>
                                ) : (
                                    <div style={{ display: 'grid', gap: '0.45rem' }}>
                                        {profile.mostMissedQuestions.slice(0, 4).map(item => (
                                            <div key={item.key} style={{ display: 'flex', justifyContent: 'space-between', gap: '0.7rem', fontSize: '0.8rem' }}>
                                                <span style={{ color: 'var(--foreground)', fontWeight: 850 }}>
                                                    {item.examTitle} · {item.questionNumber}번
                                                </span>
                                                <span style={{ color: 'var(--error)', fontWeight: 900 }}>
                                                    {item.wrongRate}%{item.averageTimeSec ? ` · ${formatDuration(item.averageTimeSec)}` : ""}
                                                </span>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                            <div style={{ padding: '0.9rem', background: 'var(--background)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
                                <div style={{ fontWeight: 900, marginBottom: '0.6rem', color: 'var(--foreground)' }}>라벨별 누적 통계</div>
                                {profile.tagStats.length === 0 ? (
                                    <div style={{ color: 'var(--muted)', fontSize: '0.82rem' }}>라벨 데이터가 아직 없습니다.</div>
                                ) : (
                                    <div style={{ display: 'grid', gap: '0.45rem' }}>
                                        {profile.tagStats.slice(0, 5).map(item => (
                                            <div key={item.key} style={{ display: 'flex', justifyContent: 'space-between', gap: '0.7rem', fontSize: '0.8rem' }}>
                                                <span style={{ color: 'var(--foreground)', fontWeight: 850 }}>
                                                    {item.title} · {item.questionNumbers.slice(0, 4).join(', ')}번
                                                </span>
                                                <span style={{ color: item.wrongRate >= 60 ? 'var(--error)' : 'var(--muted)', fontWeight: 900 }}>
                                                    오답 {item.wrongRate}%{item.averageTimeSec ? ` · ${formatDuration(item.averageTimeSec)}` : ""}
                                                </span>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>
                    </section>
                )}
            </div>
        </ModalShell>
    );
}

export function ModalShell({
    title, onClose, children, maxWidth = 420,
}: {
    title: string;
    onClose: () => void;
    children: React.ReactNode;
    maxWidth?: number | string;
}) {
    return (
        <div
            onClick={onClose}
            style={{
                position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                zIndex: 100, padding: '1rem', animation: 'fadeIn 0.15s both'
            }}
        >
            <div
                onClick={(e) => e.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-label={title}
                className="bento-card"
                style={{
                    width: '100%', maxWidth, padding: '1.5rem',
                    maxHeight: 'calc(100vh - 2rem)',
                    overflowY: 'auto',
                    background: 'var(--modal-surface)', borderRadius: 'var(--radius-lg)',
                    boxShadow: '0 24px 64px rgba(15,23,42,0.28), 0 0 0 1px color-mix(in srgb, var(--border), transparent 18%)',
                    backdropFilter: 'none',
                    WebkitBackdropFilter: 'none',
                }}
            >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
                    <h3 style={{ fontSize: '1.1rem', fontWeight: 700 }}>{title}</h3>
                    <button
                        type="button"
                        aria-label="모달 닫기"
                        onClick={onClose}
                        style={{
                            width: 44,
                            height: 44,
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            color: 'var(--muted)',
                            borderRadius: 'var(--radius-md)',
                        }}
                    >
                        <X size={18} />
                    </button>
                </div>
                {children}
            </div>
        </div>
    );
}

export function StudentModal({
    groups, initial, defaultGroupId, onClose, onSubmit,
}: {
    groups: RosterGroup[];
    initial: RosterStudent | null;
    defaultGroupId?: string;
    onClose: () => void;
    onSubmit: (data: StudentFormData) => void;
}) {
    const initialGroupIdValue = initial ? initialStudentGroupId(initial, groups) : (groups.some(group => group.id === defaultGroupId) ? defaultGroupId || "" : groups[0]?.id ?? "");
    const initialGroup = groups.find(item => item.id === initialGroupIdValue);
    const [name, setName] = useState(initial?.name ?? "");
    const [email, setEmail] = useState(initial?.email ?? "");
    const [groupId, setGroupId] = useState(initialGroupIdValue);
    const [region, setRegion] = useState(initial?.region ?? initialGroup?.region ?? "");
    const [formError, setFormError] = useState("");
    const selectedGroup = groups.find(item => item.id === groupId);
    const hasNoGroups = groups.length === 0;

    const inputStyle: React.CSSProperties = {
        width: '100%', padding: '0.65rem 0.85rem', background: 'var(--background)',
        border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
        fontSize: '0.9rem', color: 'var(--foreground)', outline: 'none',
    };
    const labelStyle: React.CSSProperties = {
        display: 'block', fontSize: '0.75rem', fontWeight: 700,
        color: 'var(--muted)', letterSpacing: '0.05em',
        textTransform: 'uppercase', marginBottom: '0.4rem',
    };

    return (
        <ModalShell title={initial ? "학생 편집" : "학생 추가"} onClose={onClose}>
            <form
                onSubmit={(e) => {
                    e.preventDefault();
                    if (!name.trim()) { setFormError("학생 이름을 입력해주세요."); return; }
                    if (!email.trim()) { setFormError("학생 이메일을 입력해주세요."); return; }
                    if (!selectedGroup) {
                        setFormError(hasNoGroups
                            ? "반이 아직 없습니다. 반 · 그룹 탭에서 반을 먼저 만든 뒤 학생을 추가해주세요."
                            : "소속 반을 선택해주세요.");
                        return;
                    }
                    setFormError("");
                    onSubmit({
                        name: name.trim(),
                        email: email.trim(),
                        group: selectedGroup.name,
                        groupId: selectedGroup.id,
                        region: region.trim() || selectedGroup.region || "",
                    });
                }}
            >
                <div style={{ marginBottom: '1rem' }}>
                    <label style={labelStyle}>이름</label>
                    <input aria-label="학생 이름" value={name} onChange={e => setName(e.target.value)} style={inputStyle} required />
                </div>
                <div style={{ marginBottom: '1rem' }}>
                    <label style={labelStyle}>이메일</label>
                    <input aria-label="학생 이메일" type="email" value={email} onChange={e => setEmail(e.target.value)} style={inputStyle} required />
                </div>
                <div style={{ marginBottom: '1.25rem' }}>
                    <label style={labelStyle}>반</label>
                    <select
                        aria-label="소속 반"
                        value={groupId}
                        onChange={e => {
                            const nextGroup = groups.find(item => item.id === e.target.value);
                            setGroupId(e.target.value);
                            if (nextGroup?.region && !region.trim()) {
                                setRegion(nextGroup.region);
                            }
                        }}
                        style={inputStyle}
                        required
                    >
                        {groups.length === 0 && <option value="">반을 먼저 만들어주세요</option>}
                        {groups.map(g => <option key={g.id} value={g.id}>{groupOptionLabel(g)}</option>)}
                    </select>
                    {hasNoGroups && (
                        <p style={{ fontSize: '0.78rem', color: 'var(--warning, #b45309)', marginTop: '0.45rem', lineHeight: 1.5, wordBreak: 'keep-all' }}>
                            아직 만든 반이 없습니다. <strong>반 · 그룹</strong> 탭에서 반을 만들면 학생을 추가할 수 있습니다.
                        </p>
                    )}
                </div>
                <div style={{ marginBottom: '1.25rem' }}>
                    <label style={labelStyle}>지역</label>
                    <input
                        aria-label="학생 지역"
                        value={region}
                        onChange={e => setRegion(e.target.value)}
                        style={inputStyle}
                        placeholder="예: 서울, 부산, 온라인"
                    />
                </div>
                {formError && (
                    <p role="alert" style={{ fontSize: '0.8rem', color: 'var(--danger, #dc2626)', marginBottom: '0.75rem', lineHeight: 1.5, wordBreak: 'keep-all' }}>
                        {formError}
                    </p>
                )}
                <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                    <button
                        type="button"
                        onClick={onClose}
                        style={{ padding: '0.65rem 1rem', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', fontWeight: 600, fontSize: '0.85rem', color: 'var(--foreground)' }}
                    >
                        취소
                    </button>
                    <button
                        type="submit"
                        style={{ padding: '0.65rem 1.1rem', background: 'linear-gradient(135deg, #22c55e, #10b981)', color: 'white', borderRadius: 'var(--radius-md)', fontWeight: 700, fontSize: '0.85rem' }}
                    >
                        {initial ? "저장" : "추가"}
                    </button>
                </div>
            </form>
        </ModalShell>
    );
}

export function GroupModal({
    initial, onClose, onSubmit,
}: {
    initial?: RosterGroup | null;
    onClose: () => void;
    onSubmit: (data: GroupFormData) => void;
}) {
    const [name, setName] = useState(initial?.name ?? "");
    const [region, setRegion] = useState(initial?.region ?? "");
    const [color, setColor] = useState(initial?.color ?? GROUP_COLORS[0]);

    const inputStyle: React.CSSProperties = {
        width: '100%', padding: '0.65rem 0.85rem', background: 'var(--background)',
        border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
        fontSize: '0.9rem', color: 'var(--foreground)', outline: 'none',
    };
    const labelStyle: React.CSSProperties = {
        display: 'block', fontSize: '0.75rem', fontWeight: 700,
        color: 'var(--muted)', letterSpacing: '0.05em',
        textTransform: 'uppercase', marginBottom: '0.4rem',
    };

    return (
        <ModalShell title={initial ? "반 편집" : "새 반 만들기"} onClose={onClose}>
            <form
                onSubmit={(e) => {
                    e.preventDefault();
                    if (!name.trim()) return;
                    onSubmit({ name: name.trim(), region: region.trim(), color });
                }}
            >
                <div style={{ marginBottom: '1rem' }}>
                    <label style={labelStyle}>이름</label>
                    <input
                        aria-label="반 이름"
                        value={name}
                        onChange={e => setName(e.target.value)}
                        style={inputStyle}
                        autoFocus
                        required
                    />
                </div>
                <div style={{ marginBottom: '1rem' }}>
                    <label style={labelStyle}>지역</label>
                    <input
                        aria-label="반 지역"
                        value={region}
                        onChange={e => setRegion(e.target.value)}
                        style={inputStyle}
                        placeholder="예: 서울, 부산, 온라인"
                    />
                </div>
                <div style={{ marginBottom: '1.25rem' }}>
                    <label style={labelStyle}>색상</label>
                    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                        {GROUP_COLORS.map(c => (
                            <button
                                key={c}
                                type="button"
                                onClick={() => setColor(c)}
                                aria-label={`색상 ${c}`}
                                style={{
                                    width: 44, height: 44, borderRadius: '50%', background: c,
                                    border: color === c ? '3px solid var(--foreground)' : '3px solid transparent',
                                    cursor: 'pointer', transition: 'transform 0.15s',
                                    transform: color === c ? 'scale(1.1)' : 'scale(1)',
                                }}
                            />
                        ))}
                    </div>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                    <button
                        type="button"
                        onClick={onClose}
                        style={{ padding: '0.65rem 1rem', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', fontWeight: 600, fontSize: '0.85rem', color: 'var(--foreground)' }}
                    >
                        취소
                    </button>
                    <button
                        type="submit"
                        style={{ padding: '0.65rem 1.1rem', background: 'var(--primary)', color: 'white', borderRadius: 'var(--radius-md)', fontWeight: 700, fontSize: '0.85rem' }}
                    >
                        {initial ? "저장" : "만들기"}
                    </button>
                </div>
            </form>
        </ModalShell>
    );
}

// DEV-A: bulk group reassignment picker.
export function GroupMoveModal({
    groups, count, selectedRegions, onClose, onConfirm,
}: {
    groups: RosterGroup[];
    count: number;
    /** Effective region of each selected student, for the override-impact note. */
    selectedRegions: string[];
    onClose: () => void;
    onConfirm: (groupId: string, applyRegion: boolean) => void;
}) {
    const [groupId, setGroupId] = useState(groups[0]?.id ?? "");
    // T4: default ON keeps the previous behavior (region follows the class),
    // but the teacher can turn it off to preserve each student's region override.
    const [applyRegion, setApplyRegion] = useState(true);
    const inputStyle: React.CSSProperties = {
        width: '100%', padding: '0.65rem 0.85rem', background: 'var(--background)',
        border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
        fontSize: '0.9rem', color: 'var(--foreground)', outline: 'none',
    };
    const labelStyle: React.CSSProperties = {
        display: 'block', fontSize: '0.75rem', fontWeight: 700,
        color: 'var(--muted)', letterSpacing: '0.05em',
        textTransform: 'uppercase', marginBottom: '0.4rem',
    };

    const targetGroup = groups.find(g => g.id === groupId);
    const targetRegion = targetGroup?.region?.trim() || DEFAULT_REGION_NAME;
    const differingCount = selectedRegions.filter(region => region !== targetRegion).length;

    return (
        <ModalShell title="선택 학생 반 이동" onClose={onClose}>
            <form
                onSubmit={(e) => {
                    e.preventDefault();
                    if (!groupId) return;
                    onConfirm(groupId, applyRegion);
                }}
            >
                <p style={{ color: 'var(--muted)', fontSize: '0.88rem', lineHeight: 1.6, marginBottom: '1rem', wordBreak: 'keep-all' }}>
                    선택된 <strong style={{ color: 'var(--foreground)' }}>{count}명</strong>을 옮길 반을 선택하세요.
                    {applyRegion ? " 반과 지역이 함께 이동됩니다." : " 반만 이동하고 각 학생의 지역은 유지됩니다."}
                </p>
                <div style={{ marginBottom: '1rem' }}>
                    <label style={labelStyle}>이동할 반</label>
                    <select
                        aria-label="이동할 반"
                        value={groupId}
                        onChange={e => setGroupId(e.target.value)}
                        style={inputStyle}
                        required
                    >
                        {groups.length === 0 && <option value="">이동 가능한 반이 없습니다</option>}
                        {groups.map(g => <option key={g.id} value={g.id}>{groupOptionLabel(g)}</option>)}
                    </select>
                </div>

                <label
                    style={{
                        display: 'flex', alignItems: 'flex-start', gap: '0.6rem',
                        padding: '0.6rem 0.7rem', marginBottom: '0.75rem',
                        borderRadius: 'var(--radius-md)', border: '1px solid var(--border)',
                        background: 'var(--background)', cursor: 'pointer', minHeight: 44,
                    }}
                >
                    <input
                        type="checkbox"
                        aria-label="지역도 이동한 반 기준으로 변경"
                        checked={applyRegion}
                        onChange={e => setApplyRegion(e.target.checked)}
                        style={{ marginTop: 3, accentColor: 'var(--primary)', cursor: 'pointer', flexShrink: 0 }}
                    />
                    <span style={{ fontSize: '0.85rem', color: 'var(--foreground)', lineHeight: 1.5, wordBreak: 'keep-all' }}>
                        <span style={{ fontWeight: 700 }}>지역도 이동한 반 기준으로 변경</span>
                        <span style={{ display: 'block', fontSize: '0.78rem', color: 'var(--muted)', marginTop: '0.15rem' }}>
                            체크 해제 시 각 학생의 기존 지역을 그대로 유지합니다.
                        </span>
                    </span>
                </label>

                {differingCount > 0 && (
                    <p style={{
                        fontSize: '0.8rem', lineHeight: 1.55, wordBreak: 'keep-all',
                        color: applyRegion ? 'var(--warning)' : 'var(--muted)',
                        background: applyRegion ? 'rgba(245,158,11,0.09)' : 'var(--background)',
                        border: `1px solid ${applyRegion ? 'rgba(245,158,11,0.28)' : 'var(--border)'}`,
                        borderRadius: 'var(--radius-md)', padding: '0.6rem 0.7rem', marginBottom: '1.25rem',
                    }}>
                        선택한 학생 중 <strong>{differingCount}명</strong>의 현재 지역이 이동할 반의 지역(<strong>{targetRegion}</strong>)과 다릅니다.
                        {applyRegion
                            ? " 확정하면 해당 학생의 지역이 덮어써집니다."
                            : " 체크가 해제되어 이 학생들의 지역은 변경되지 않습니다."}
                    </p>
                )}
                {differingCount === 0 && <div style={{ marginBottom: '1.25rem' }} />}

                <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                    <button
                        type="button"
                        onClick={onClose}
                        style={{ padding: '0.65rem 1rem', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', fontWeight: 600, fontSize: '0.85rem', color: 'var(--foreground)' }}
                    >
                        취소
                    </button>
                    <button
                        type="submit"
                        disabled={!groupId}
                        style={{ padding: '0.65rem 1.1rem', background: 'var(--primary)', color: 'white', borderRadius: 'var(--radius-md)', fontWeight: 700, fontSize: '0.85rem', opacity: groupId ? 1 : 0.6 }}
                    >
                        이동
                    </button>
                </div>
            </form>
        </ModalShell>
    );
}

// T1/T5: dry-run preview of a CSV import. Shows counts + a per-row disposition
// (add / update with field diffs / id-collision conflict / skip with reason)
// and only commits when the teacher presses 가져오기 확정.
export const CSV_PREVIEW_ROW_CAP = 100;

export const CSV_FIELD_LABEL: Record<RosterCsvFieldChange["field"], string> = {
    name: "이름",
    email: "이메일",
    group: "반",
    region: "지역",
};

export function CsvPreviewSection({
    title, count, tone, children,
}: {
    title: string;
    count: number;
    tone: "primary" | "success" | "warning" | "error" | "grade" | "retake" | "muted";
    children: React.ReactNode;
}) {
    if (count === 0) return null;
    return (
        <div style={{ marginBottom: '1rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                <StatusPill tone={tone} label={title} size="sm" />
                <span style={{ fontSize: '0.82rem', fontWeight: 800, color: 'var(--foreground)' }}>{count}건</span>
            </div>
            <div style={{
                display: 'flex', flexDirection: 'column', gap: '0.35rem',
                maxHeight: 200, overflowY: 'auto',
                border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
                padding: '0.5rem 0.6rem', background: 'var(--background)',
            }}>
                {children}
            </div>
        </div>
    );
}

export const CSV_CONFLICT_DISPOSITION_LABEL: Record<RosterCsvConflictDisposition, string> = {
    add: "신규 추가",
    overwrite: "기존 덮어쓰기",
    skip: "건너뛰기",
};

export function csvConflictDispositionNote(disposition: RosterCsvConflictDisposition, row: { existingName: string; existingEmail: string }): string {
    if (disposition === "overwrite") return `기존 학생(${row.existingName} · ${row.existingEmail}) 정보를 이 행으로 덮어씁니다.`;
    if (disposition === "skip") return "이 행은 가져오지 않습니다.";
    return "새 id로 별도 학생을 추가합니다. 기존 학생은 그대로 둡니다.";
}

export function CsvImportPreviewModal({
    plan, onClose, onConfirm,
}: {
    plan: RosterCsvImportPlan;
    onClose: () => void;
    onConfirm: (dispositions: Record<number, RosterCsvConflictDisposition>) => void;
}) {
    // Per-conflict-row choice, keyed by CSV line. Missing entry = "add" (the
    // historical "add as new" behavior stays the default).
    const [conflictDispositions, setConflictDispositions] = useState<Record<number, RosterCsvConflictDisposition>>({});
    const dispositionFor = (line: number): RosterCsvConflictDisposition => conflictDispositions[line] ?? "add";
    const conflictAddCount = plan.conflicts.filter(row => dispositionFor(row.line) === "add").length;
    const conflictOverwriteCount = plan.conflicts.filter(row => dispositionFor(row.line) === "overwrite").length;
    const conflictSkipCount = plan.conflicts.filter(row => dispositionFor(row.line) === "skip").length;
    const addedTotal = plan.adds.length + conflictAddCount;
    const changedUpdates = plan.updates.filter(update => update.changes.length > 0);
    const unchangedCount = plan.updates.length - changedUpdates.length;
    // Mirrors applyRosterCsvConflictDispositions: skipping every conflict can turn a
    // "has changes" plan into a no-op, so the confirm button tracks the live choices.
    const effectiveHasChanges = plan.adds.length > 0
        || changedUpdates.length > 0
        || conflictAddCount + conflictOverwriteCount > 0;
    const rowStyle: React.CSSProperties = {
        fontSize: '0.8rem', color: 'var(--foreground)', lineHeight: 1.5,
        display: 'flex', alignItems: 'flex-start', gap: '0.5rem', wordBreak: 'keep-all',
    };
    const lineStyle: React.CSSProperties = {
        flexShrink: 0, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums', fontWeight: 700, minWidth: 34,
    };
    const moreNote = (shown: number, total: number) => (
        total > shown
            ? <div style={{ fontSize: '0.75rem', color: 'var(--muted)', fontWeight: 600, paddingTop: '0.15rem' }}>…외 {total - shown}건 더</div>
            : null
    );

    return (
        <ModalShell title="CSV 가져오기 미리보기" onClose={onClose} maxWidth={640}>
            <p style={{ color: 'var(--muted)', fontSize: '0.86rem', lineHeight: 1.6, marginBottom: '1rem', wordBreak: 'keep-all' }}>
                아래 내용은 아직 저장되지 않았습니다. 확인 후 <strong style={{ color: 'var(--foreground)' }}>가져오기 확정</strong>을 누르면 반영됩니다.
            </p>

            <div style={{
                display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '1.25rem',
            }}>
                <StatusPill tone="success" label={`추가 ${addedTotal}`} size="sm" />
                <StatusPill tone="primary" label={`업데이트 ${changedUpdates.length + conflictOverwriteCount}`} size="sm" />
                {unchangedCount > 0 && (
                    <StatusPill tone="muted" label={`변경 없음 ${unchangedCount}`} size="sm" />
                )}
                {plan.conflicts.length > 0 && (
                    <StatusPill tone="warning" label={`id 충돌 ${plan.conflicts.length}`} size="sm" />
                )}
                {conflictSkipCount > 0 && (
                    <StatusPill tone="muted" label={`충돌 건너뜀 ${conflictSkipCount}`} size="sm" />
                )}
                {plan.createdGroups.length > 0 && (
                    <StatusPill tone="muted" label={`새 반 ${plan.createdGroups.length}`} size="sm" style={{ color: 'var(--foreground)' }} />
                )}
                {plan.skips.length > 0 && (
                    <StatusPill tone="error" label={`제외 ${plan.skips.length}`} size="sm" />
                )}
            </div>

            <CsvPreviewSection title="추가" count={plan.adds.length} tone="success">
                {plan.adds.slice(0, CSV_PREVIEW_ROW_CAP).map(row => (
                    <div key={`add-${row.line}`} style={rowStyle}>
                        <span style={lineStyle}>#{row.line}</span>
                        <span><strong>{row.name}</strong> · {row.email} · {row.group}{row.region ? ` · ${row.region}` : ""}</span>
                    </div>
                ))}
                {moreNote(CSV_PREVIEW_ROW_CAP, plan.adds.length)}
            </CsvPreviewSection>

            <CsvPreviewSection title="업데이트" count={changedUpdates.length} tone="primary">
                {changedUpdates.slice(0, CSV_PREVIEW_ROW_CAP).map(row => (
                    <div key={`upd-${row.line}`} style={rowStyle}>
                        <span style={lineStyle}>#{row.line}</span>
                        <span>
                            <strong>{row.name}</strong> · {row.email}
                            <span style={{ color: 'var(--muted)' }}> ({row.matchedBy === "email" ? "이메일 일치" : "id 일치"})</span>
                            <span style={{ display: 'block', color: 'var(--muted)', fontSize: '0.75rem' }}>
                                {row.changes.map(change => (
                                    <span key={change.field} style={{ display: 'block' }}>
                                        {CSV_FIELD_LABEL[change.field]}: {change.from || "—"} → <strong style={{ color: 'var(--foreground)' }}>{change.to || "—"}</strong>
                                    </span>
                                ))}
                            </span>
                        </span>
                    </div>
                ))}
                {moreNote(CSV_PREVIEW_ROW_CAP, changedUpdates.length)}
            </CsvPreviewSection>

            <CsvPreviewSection title="id 충돌" count={plan.conflicts.length} tone="warning">
                {plan.conflicts.slice(0, CSV_PREVIEW_ROW_CAP).map(row => {
                    const disposition = dispositionFor(row.line);
                    return (
                        <div key={`cft-${row.line}`} style={{ ...rowStyle, flexWrap: 'wrap', rowGap: '0.35rem' }}>
                            <span style={lineStyle}>#{row.line}</span>
                            <span style={{ flex: '1 1 200px', minWidth: 0 }}>
                                <strong>{row.name}</strong> · {row.email} · {row.group}
                                <span style={{ display: 'block', color: 'var(--muted)', fontSize: '0.75rem' }}>
                                    id <code>{row.importedId}</code>가 기존 학생({row.existingName} · {row.existingEmail})과 겹칩니다.
                                </span>
                                <span style={{ display: 'block', color: disposition === "skip" ? 'var(--muted)' : 'var(--warning)', fontSize: '0.75rem', fontWeight: 700 }}>
                                    {csvConflictDispositionNote(disposition, row)}
                                </span>
                            </span>
                            <select
                                aria-label={`${row.line}행 id 충돌 처리 방법`}
                                value={disposition}
                                onChange={e => setConflictDispositions(prev => ({
                                    ...prev,
                                    [row.line]: e.target.value as RosterCsvConflictDisposition,
                                }))}
                                style={{
                                    flexShrink: 0,
                                    minHeight: 44,
                                    padding: '0.45rem 0.6rem',
                                    background: 'var(--background)',
                                    border: '1px solid var(--border)',
                                    borderRadius: 'var(--radius-md)',
                                    color: 'var(--foreground)',
                                    fontSize: '0.78rem',
                                    fontWeight: 700,
                                }}
                            >
                                {(Object.keys(CSV_CONFLICT_DISPOSITION_LABEL) as RosterCsvConflictDisposition[]).map(option => (
                                    <option key={option} value={option}>{CSV_CONFLICT_DISPOSITION_LABEL[option]}</option>
                                ))}
                            </select>
                        </div>
                    );
                })}
                {moreNote(CSV_PREVIEW_ROW_CAP, plan.conflicts.length)}
                {plan.conflicts.length > CSV_PREVIEW_ROW_CAP && (
                    <div style={{ fontSize: '0.75rem', color: 'var(--muted)', fontWeight: 600 }}>
                        표시되지 않은 충돌 행은 기본값(신규 추가)으로 처리됩니다.
                    </div>
                )}
            </CsvPreviewSection>

            <CsvPreviewSection title="제외" count={plan.skips.length} tone="error">
                {plan.skips.slice(0, CSV_PREVIEW_ROW_CAP).map(row => (
                    <div key={`skp-${row.line}`} style={rowStyle}>
                        <span style={lineStyle}>#{row.line}</span>
                        <span>
                            {row.name || row.email || row.group
                                ? <>{row.name || "(이름 없음)"} · {row.email || "(이메일 없음)"} · {row.group || "(반 없음)"}</>
                                : <span style={{ color: 'var(--muted)' }}>빈 행</span>}
                            <span style={{ display: 'block', color: 'var(--error)', fontSize: '0.75rem' }}>
                                {row.reason === "missing-fields" ? "필수 항목 누락 (이름/이메일/반)" : "이메일 형식 오류"}
                            </span>
                        </span>
                    </div>
                ))}
                {moreNote(CSV_PREVIEW_ROW_CAP, plan.skips.length)}
            </CsvPreviewSection>

            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '1.25rem' }}>
                <button
                    type="button"
                    onClick={onClose}
                    style={{ minHeight: 44, padding: '0.65rem 1rem', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', fontWeight: 600, fontSize: '0.85rem', color: 'var(--foreground)' }}
                >
                    취소
                </button>
                <button
                    type="button"
                    onClick={() => onConfirm(conflictDispositions)}
                    disabled={!effectiveHasChanges}
                    title={effectiveHasChanges ? undefined : "반영할 변경 사항이 없습니다."}
                    style={{
                        minHeight: 44, padding: '0.65rem 1.1rem', background: 'var(--primary)', color: 'white',
                        borderRadius: 'var(--radius-md)', fontWeight: 700, fontSize: '0.85rem',
                        opacity: effectiveHasChanges ? 1 : 0.5, cursor: effectiveHasChanges ? 'pointer' : 'not-allowed',
                    }}
                >
                    가져오기 확정
                </button>
            </div>
        </ModalShell>
    );
}


export function InviteModal({
    onClose, onSubmit,
}: {
    onClose: () => void;
    onSubmit: (email: string) => void;
}) {
    const [contact, setContact] = useState("");
    const inputStyle: React.CSSProperties = {
        width: '100%', padding: '0.75rem 0.9rem', background: 'var(--background)',
        border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
        fontSize: '0.95rem', color: 'var(--foreground)', outline: 'none',
    };
    const labelStyle: React.CSSProperties = {
        display: 'block', fontSize: '0.75rem', fontWeight: 700,
        color: 'var(--muted)', letterSpacing: '0.05em',
        textTransform: 'uppercase', marginBottom: '0.4rem',
    };

    return (
        <ModalShell title="카카오 초대 기록" onClose={onClose}>
            <form
                onSubmit={(e) => {
                    e.preventDefault();
                    onSubmit(contact);
                }}
            >
                <div style={{ marginBottom: '1.25rem' }}>
                    <label style={labelStyle}>초대 연락처</label>
                    <input
                        type="email"
                        value={contact}
                        onChange={e => setContact(e.target.value)}
                        style={inputStyle}
                        placeholder="student@example.com"
                        autoFocus
                        required
                    />
                    <p style={{ marginTop: '0.45rem', color: 'var(--muted)', fontSize: '0.78rem', lineHeight: 1.55, wordBreak: 'keep-all' }}>
                        현재는 초대 기록만 저장합니다. 실제 카카오 발송은 채널 연동 후 지원합니다.
                    </p>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                    <button
                        type="button"
                        onClick={onClose}
                        style={{ padding: '0.65rem 1rem', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', fontWeight: 600, fontSize: '0.85rem', color: 'var(--foreground)' }}
                    >
                        닫기
                    </button>
                    <button
                        type="submit"
                        style={{ padding: '0.65rem 1.1rem', background: 'var(--primary)', color: 'white', borderRadius: 'var(--radius-md)', fontWeight: 700, fontSize: '0.85rem' }}
                    >
                        기록 추가
                    </button>
                </div>
            </form>
        </ModalShell>
    );
}

export function MessageModal({
    recipient, onClose, onSubmit,
}: {
    recipient: string;
    onClose: () => void;
    onSubmit: (body: string) => void;
}) {
    const [body, setBody] = useState("");
    const textareaStyle: React.CSSProperties = {
        width: '100%', minHeight: 120, resize: 'vertical',
        padding: '0.75rem 0.9rem', background: 'var(--background)',
        border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
        fontSize: '0.95rem', color: 'var(--foreground)', outline: 'none',
        lineHeight: 1.6,
    };

    return (
        <ModalShell title={`${recipient} 메시지`} onClose={onClose}>
            <form
                onSubmit={(e) => {
                    e.preventDefault();
                    const trimmed = body.trim();
                    if (!trimmed) return;
                    onSubmit(trimmed);
                }}
            >
                <textarea
                    value={body}
                    onChange={e => setBody(e.target.value)}
                    style={textareaStyle}
                    placeholder="전달할 내용을 입력하세요"
                    autoFocus
                    required
                />
                <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '1rem' }}>
                    <button
                        type="button"
                        onClick={onClose}
                        style={{ padding: '0.65rem 1rem', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', fontWeight: 600, fontSize: '0.85rem', color: 'var(--foreground)' }}
                    >
                        닫기
                    </button>
                    <button
                        type="submit"
                        style={{ padding: '0.65rem 1.1rem', background: 'var(--primary)', color: 'white', borderRadius: 'var(--radius-md)', fontWeight: 700, fontSize: '0.85rem' }}
                    >
                        보내기
                    </button>
                </div>
            </form>
        </ModalShell>
    );
}

export function ConfirmModal({
    action, onClose, onConfirm,
}: {
    action: ConfirmAction;
    onClose: () => void;
    onConfirm: () => void;
}) {
    const copy = action.kind === "student"
        ? {
            title: "학생 삭제",
            body: `${action.label} 학생을 삭제합니다. 목록과 반 통계에서 바로 제외됩니다.`,
            confirm: "삭제",
        }
        : action.kind === "bulk"
            ? {
                title: "선택 학생 삭제",
                body: `선택된 ${action.count}명을 삭제합니다. 목록과 반 통계에서 바로 제외됩니다.`,
                confirm: "삭제",
            }
            : action.kind === "invite"
                ? {
                    title: "초대 취소",
                    body: `${action.label} 초대를 취소합니다. 취소된 초대는 목록에서 제거됩니다.`,
                    confirm: "초대 취소",
                }
            : {
                title: "반 삭제",
                body: `${action.label} 반을 삭제합니다. 학생이 남아 있으면 삭제되지 않습니다.`,
                confirm: "반 삭제",
            };

    return (
        <ModalShell title={copy.title} onClose={onClose}>
            <p style={{ color: 'var(--muted)', fontSize: '0.95rem', lineHeight: 1.7, marginBottom: '1.25rem', wordBreak: 'keep-all' }}>
                {copy.body}
            </p>
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                <button
                    onClick={onClose}
                    style={{ padding: '0.65rem 1rem', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', fontWeight: 600, fontSize: '0.85rem', color: 'var(--foreground)' }}
                >
                    닫기
                </button>
                <button
                    onClick={onConfirm}
                    style={{ padding: '0.65rem 1.1rem', background: 'var(--error)', color: 'white', borderRadius: 'var(--radius-md)', fontWeight: 700, fontSize: '0.85rem' }}
                >
                    {copy.confirm}
                </button>
            </div>
        </ModalShell>
    );
}
