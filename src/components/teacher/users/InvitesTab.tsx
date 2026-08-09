"use client";

// Extracted verbatim from src/app/teacher/users/page.tsx (Phase 2
// decomposition). Props carry the exact identifiers the block already used so
// the JSX body is untouched — pure movement, no behaviour change.

import { Link as LinkIcon, MessageCircle } from "lucide-react";
import StatusPill from "@/components/dashboard/StatusPill";
import type { RosterInvite } from "@/lib/rosterStorage";

interface InvitesTabProps {
    copyFlash: boolean;
    hydrated: boolean;
    rosterInvites: RosterInvite[];
    readOnly: boolean;
    handleCopyInvite: () => void | Promise<void>;
    handleResendInvite: (id: string) => void;
    handleCancelInvite: (id: string) => void;
    setShowInviteModal: (open: boolean) => void;
}

export default function InvitesTab({
    copyFlash,
    hydrated,
    rosterInvites,
    readOnly,
    handleCopyInvite,
    handleResendInvite,
    handleCancelInvite,
    setShowInviteModal,
}: InvitesTabProps) {
    return (
                    <div className="bento-card teacher-invites-card" style={{ padding: '1.5rem' }}>
                        <div className="teacher-invite-share" style={{
                            display: 'flex', gap: '0.75rem', padding: '1rem 1.25rem',
                            background: 'linear-gradient(135deg, rgba(99,102,241,0.06), rgba(139,92,246,0.06))',
                            borderRadius: 'var(--radius-md)', border: '1px solid rgba(99,102,241,0.15)',
                            marginBottom: '1.5rem', alignItems: 'center'
                        }}>
                            <LinkIcon size={20} color="var(--primary)" style={{ flexShrink: 0, marginTop: 2 }} />
                            <div className="teacher-invite-share-copy" style={{ flex: 1 }}>
                                <div style={{ fontSize: '0.85rem', fontWeight: 700, marginBottom: '0.25rem' }}>학생 시험 링크</div>
                                <span style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>
                                    시험 배포 단계에서 대상 반별 만료 링크를 발급합니다.
                                </span>
                            </div>
                            {copyFlash && (
                                <span style={{ fontSize: '0.8rem', color: 'var(--success)', fontWeight: 700 }}>복사됨</span>
                            )}
                            {!readOnly && <button
                                type="button"
                                className="teacher-invite-action"
                                onClick={handleCopyInvite}
                                style={{ padding: '0.5rem 1rem', background: 'var(--surface)', color: 'var(--primary)', border: '1px solid rgba(99,102,241,0.3)', borderRadius: 'var(--radius-md)', fontWeight: 600, fontSize: '0.8rem' }}
                            >
                                발급 안내
                            </button>}
                            <button
                                type="button"
                                className="teacher-invite-action"
                                onClick={() => setShowInviteModal(true)}
                                style={{ padding: '0.5rem 1rem', background: 'var(--primary)', color: 'white', borderRadius: 'var(--radius-md)', fontWeight: 600, fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.3rem' }}
                            >
                                <MessageCircle size={13} /> 카카오 초대 기록
                            </button>
                        </div>

                        <div className="teacher-invite-table-scroll scroll-custom" tabIndex={0} aria-label="초대 기록 표, 가로로 스크롤할 수 있습니다">
                        <table className="teacher-invite-table" style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
                            <thead>
                                <tr style={{ color: 'var(--muted)', fontSize: '0.8rem', borderBottom: '1px solid var(--border)', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
                                    <th style={{ padding: '0.85rem 0.5rem' }}>초대 연락처</th>
                                    <th style={{ padding: '0.85rem 0.5rem' }}>기록 시각</th>
                                    <th style={{ padding: '0.85rem 0.5rem' }}>상태</th>
                                    <th style={{ padding: '0.85rem 0.5rem', textAlign: 'right' }}>작업</th>
                                </tr>
                            </thead>
                            <tbody>
                                {rosterInvites.map(inv => {
                                    const map = {
                                        pending: { tone: 'warning', label: '대기 중' },
                                        accepted: { tone: 'success', label: '수락됨' },
                                        expired: { tone: 'muted', label: '만료' },
                                    } as const;
                                    const m = map[inv.status as keyof typeof map] ?? map.pending;
                                    return (
                                        <tr key={inv.id} style={{ borderBottom: '1px solid var(--border)' }}>
                                            <td style={{ padding: '1rem 0.5rem', fontSize: '0.9rem', fontWeight: 600 }}>{inv.email}</td>
                                            <td style={{ padding: '1rem 0.5rem', fontSize: '0.85rem', color: 'var(--muted)' }}>{inv.sentAt}</td>
                                            <td style={{ padding: '1rem 0.5rem' }}>
                                                <StatusPill tone={m.tone} label={m.label} size="sm" />
                                            </td>
                                            <td style={{ padding: '1rem 0.5rem', textAlign: 'right' }}>
                                                {!readOnly && <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
                                                    {inv.status !== "accepted" && (
                                                        <button
                                                            onClick={() => handleResendInvite(inv.id)}
                                                            style={{ fontSize: '0.8rem', color: 'var(--primary)', fontWeight: 600 }}
                                                        >
                                                            기록 갱신
                                                        </button>
                                                    )}
                                                    <button
                                                        onClick={() => handleCancelInvite(inv.id)}
                                                        style={{ fontSize: '0.8rem', color: 'var(--muted)', fontWeight: 500 }}
                                                    >
                                                        취소
                                                    </button>
                                                </div>}
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                        </div>
                        {hydrated && rosterInvites.length === 0 && (
                            <div style={{ padding: '2.5rem 1rem', textAlign: 'center', color: 'var(--muted)', fontSize: '0.9rem' }}>
                                {readOnly
                                    ? "저장된 초대 기록이 없습니다. 최신 서버 명단을 다시 불러오세요."
                                    : <>아직 저장된 초대 기록이 없습니다. 위의 <strong style={{ color: 'var(--primary)' }}>카카오 초대 기록</strong> 버튼으로 시작하세요.</>}
                            </div>
                        )}
                    </div>
    );
}
