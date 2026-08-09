"use client";

// Extracted verbatim from src/app/teacher/users/page.tsx (Phase 2
// decomposition). Props carry the exact identifiers the block already used so
// the JSX body is untouched — pure movement, no behaviour change.

import NextLink from "next/link";
import { BarChart3, FolderPlus, Lock, PenLine, Search, Trash2, UserPlus, Users } from "lucide-react";
import { ALL_REGION_KEY, MiniStat } from "@/components/teacher/users/parts";
import { regionKeyFor, regionNameForGroup } from "@/lib/regionalAnalytics";
import { buildRegionScopedAnalyticsHref } from "@/lib/dashboardSelection";
import type { RosterGroup, RosterStudent } from "@/lib/rosterStorage";

interface GroupsTabProps {
    displayGroups: RosterGroup[];
    displayStudents: RosterStudent[];
    analyticsAvailable: boolean;
    isDemoRoster: boolean;
    advancedAnalyticsEnabled: boolean;
    handleOpenGroupProfile: (groupId: string) => void;
    handleAddStudentToGroup: (group: RosterGroup) => void;
    handleOpenEditGroup: (group: RosterGroup) => void;
    handleDeleteGroup: (group: RosterGroup) => void;
    setSelectedRegionKey: (key: string) => void;
    setQuery: (query: string) => void;
    setTab: (tab: "students" | "groups" | "invites") => void;
    setEditingGroup: (group: RosterGroup | null) => void;
    setShowGroupModal: (open: boolean) => void;
}

export default function GroupsTab({
    displayGroups,
    displayStudents,
    analyticsAvailable,
    isDemoRoster,
    advancedAnalyticsEnabled,
    handleOpenGroupProfile,
    handleAddStudentToGroup,
    handleOpenEditGroup,
    handleDeleteGroup,
    setSelectedRegionKey,
    setQuery,
    setTab,
    setEditingGroup,
    setShowGroupModal,
}: GroupsTabProps) {
    if (displayGroups.length === 0) {
        return (
            <section className="bento-card teacher-groups-empty-state" aria-labelledby="groups-empty-title">
                <div className="teacher-groups-empty-icon" aria-hidden="true">
                    <Users size={22} />
                </div>
                <div>
                    <h2 id="groups-empty-title">첫 반을 만들어 학생을 묶어보세요</h2>
                    <p>반별 시험 배정과 성취도 비교를 한곳에서 관리할 수 있습니다.</p>
                </div>
                <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => {
                        setEditingGroup(null);
                        setShowGroupModal(true);
                    }}
                >
                    <FolderPlus size={16} /> 첫 반 만들기
                </button>
            </section>
        );
    }

    return (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '1.25rem' }}>
                        {displayGroups.map(g => {
                            const groupRegion = regionNameForGroup(g, displayStudents);
                            return (
                                <article
                                    key={g.id}
                                    className="bento-card card-hover"
                                    style={{
                                        padding: '1.5rem',
                                        textAlign: 'left',
                                        color: 'var(--foreground)',
                                        minHeight: 220,
                                        display: 'flex',
                                        flexDirection: 'column',
                                        gap: '1rem',
                                    }}
                                >
                                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '0.9rem' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem', minWidth: 0 }}>
                                            <div style={{
                                                width: 46, height: 46, borderRadius: 'var(--radius-md)',
                                                background: `color-mix(in srgb, ${g.color}, transparent 88%)`, color: g.color,
                                                display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0
                                            }}>
                                                <Users size={22} />
                                            </div>
                                            <div style={{ minWidth: 0 }}>
                                                <h3 style={{
                                                    fontSize: '1.05rem',
                                                    fontWeight: 800,
                                                    lineHeight: 1.25,
                                                    marginBottom: '0.25rem',
                                                    overflow: 'hidden',
                                                    display: '-webkit-box',
                                                    WebkitLineClamp: 2,
                                                    WebkitBoxOrient: 'vertical',
                                                }}>{g.name}</h3>
                                                <p style={{ fontSize: '0.83rem', color: 'var(--muted)' }}>{g.count}명 등록 · {groupRegion}</p>
                                            </div>
                                        </div>
                                        <button
                                            type="button"
                                            aria-label={`${g.name} 편집`}
                                            onClick={() => handleOpenEditGroup(g)}
                                            disabled={isDemoRoster}
                                            title={isDemoRoster ? "데모 반은 편집할 수 없습니다." : "반 정보 편집"}
                                            style={{
                                                width: 44,
                                                height: 44,
                                                display: 'inline-flex',
                                                alignItems: 'center',
                                                justifyContent: 'center',
                                                borderRadius: 'var(--radius-md)',
                                                background: 'var(--background)',
                                                border: '1px solid var(--border)',
                                                color: isDemoRoster ? 'var(--muted)' : 'var(--foreground)',
                                                opacity: isDemoRoster ? 0.55 : 1,
                                                flexShrink: 0,
                                            }}
                                        >
                                            <PenLine size={16} />
                                        </button>
                                    </div>

                                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '0.6rem' }}>
                                        <MiniStat label="학생" value={`${g.count}명`} color={g.color} />
                                        <MiniStat label="평균" value={analyticsAvailable ? `${g.avgScore}점` : "—"} color={g.color} />
                                    </div>

                                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '0.5rem', marginTop: 'auto' }}>
                                        <button
                                            type="button"
                                            aria-label={`${g.name} 학생 보기`}
                                            onClick={() => {
                                                setSelectedRegionKey(g.region ? regionKeyFor(g.region) : ALL_REGION_KEY);
                                                setQuery(g.name);
                                                setTab("students");
                                            }}
                                            style={{
                                                minHeight: 44,
                                                padding: '0.55rem 0.65rem',
                                                borderRadius: 'var(--radius-md)',
                                                background: 'var(--surface)',
                                                border: '1px solid var(--border)',
                                                color: 'var(--foreground)',
                                                fontSize: '0.78rem',
                                                fontWeight: 800,
                                                display: 'inline-flex',
                                                alignItems: 'center',
                                                justifyContent: 'center',
                                                gap: '0.35rem',
                                            }}
                                        >
                                            <Search size={13} />
                                            학생 보기
                                        </button>
                                        <button
                                            type="button"
                                            aria-label={`${g.name} 학생 추가`}
                                            onClick={() => handleAddStudentToGroup(g)}
                                            disabled={isDemoRoster}
                                            style={{
                                                minHeight: 44,
                                                padding: '0.55rem 0.65rem',
                                                borderRadius: 'var(--radius-md)',
                                                background: 'var(--primary)',
                                                color: 'white',
                                                fontSize: '0.78rem',
                                                fontWeight: 800,
                                                display: 'inline-flex',
                                                alignItems: 'center',
                                                justifyContent: 'center',
                                                gap: '0.35rem',
                                                opacity: isDemoRoster ? 0.55 : 1,
                                            }}
                                        >
                                            <UserPlus size={13} />
                                            학생 추가
                                        </button>
                                        {advancedAnalyticsEnabled ? (
                                            <button
                                                type="button"
                                                aria-label={`${g.name} 분석 열기`}
                                                onClick={() => handleOpenGroupProfile(g.id)}
                                                disabled={!analyticsAvailable}
                                                title={analyticsAvailable ? undefined : "응시 기록을 완전하게 불러온 뒤 분석할 수 있습니다."}
                                                style={{
                                                    minHeight: 44,
                                                    padding: '0.55rem 0.65rem',
                                                    borderRadius: 'var(--radius-md)',
                                                    background: `color-mix(in srgb, ${g.color}, transparent 88%)`,
                                                    color: g.color,
                                                    fontSize: '0.78rem',
                                                    fontWeight: 900,
                                                    display: 'inline-flex',
                                                    alignItems: 'center',
                                                    justifyContent: 'center',
                                                    gap: '0.35rem',
                                                    opacity: analyticsAvailable ? 1 : 0.55,
                                                }}
                                            >
                                                <BarChart3 size={13} />
                                                분석
                                            </button>
                                        ) : (
                                            <NextLink
                                                href="/teacher/billing"
                                                aria-label={`${g.name} 반별 리포트 Pro 보기`}
                                                title="Pro 이상에서 반별 분석 리포트를 열 수 있습니다."
                                                style={{
                                                    minHeight: 44,
                                                    padding: '0.55rem 0.65rem',
                                                    borderRadius: 'var(--radius-md)',
                                                    background: 'var(--surface)',
                                                    border: '1px solid var(--border)',
                                                    color: 'var(--muted)',
                                                    fontSize: '0.78rem',
                                                    fontWeight: 900,
                                                    display: 'inline-flex',
                                                    alignItems: 'center',
                                                    justifyContent: 'center',
                                                    gap: '0.35rem',
                                                }}
                                            >
                                                <Lock size={13} />
                                                리포트 Pro
                                            </NextLink>
                                        )}
                                        <button
                                            type="button"
                                            aria-label={`${g.name} 삭제`}
                                            onClick={() => handleDeleteGroup(g)}
                                            disabled={isDemoRoster}
                                            style={{
                                                minHeight: 44,
                                                padding: '0.55rem 0.65rem',
                                                borderRadius: 'var(--radius-md)',
                                                background: 'rgba(239,68,68,0.08)',
                                                border: '1px solid rgba(239,68,68,0.2)',
                                                color: '#ef4444',
                                                fontSize: '0.78rem',
                                                fontWeight: 900,
                                                display: 'inline-flex',
                                                alignItems: 'center',
                                                justifyContent: 'center',
                                                gap: '0.35rem',
                                                opacity: isDemoRoster ? 0.55 : 1,
                                            }}
                                        >
                                            <Trash2 size={13} />
                                            삭제
                                        </button>
                                    </div>
                                    <NextLink
                                        href={buildRegionScopedAnalyticsHref("student", g.region ? regionKeyFor(g.region) : undefined)}
                                        aria-label={`${g.name} 대시보드 분석에서 보기`}
                                        title="학생 성취도 탭에서 이 반의 지역 범위로 열립니다."
                                        style={{
                                            minHeight: 44,
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            gap: '0.3rem',
                                            fontSize: '0.8rem',
                                            fontWeight: 800,
                                            color: 'var(--muted)',
                                        }}
                                    >
                                        <BarChart3 size={12} />
                                        이 반 분석 대시보드에서 보기
                                    </NextLink>
                                </article>
                            );
                        })}
                        <button
                            onClick={() => {
                                setEditingGroup(null);
                                setShowGroupModal(true);
                            }}
                            className="bento-card card-hover"
                            style={{
                                padding: '1.5rem', cursor: 'pointer', display: 'flex',
                                flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                                border: '2px dashed var(--border)', background: 'transparent', gap: '0.5rem',
                                color: 'var(--muted)', minHeight: 160
                            }}>
                            <FolderPlus size={28} />
                            <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>새 반 만들기</span>
                        </button>
                    </div>
    );
}
