"use client";

import { Link as LinkIcon, MessageCircle } from "lucide-react";
import StatusPill from "@/components/dashboard/StatusPill";
import type { RosterInvite } from "@/lib/rosterStorage";

interface InvitesTabDisplayProps {
    hydrated: boolean;
    rosterInvites: RosterInvite[];
}

interface InvitesTabReadOnlyProps extends InvitesTabDisplayProps {
    capability: "degraded_read_only";
    copyFlash?: never;
    handleCopyInvite?: never;
    handleResendInvite?: never;
    handleCancelInvite?: never;
    setShowInviteModal?: never;
}

interface InvitesTabFreshProps extends InvitesTabDisplayProps {
    capability: "fresh_mutable";
    copyFlash: boolean;
    handleCopyInvite: () => void | Promise<void>;
    handleResendInvite: (id: string) => void;
    handleCancelInvite: (id: string) => void;
    setShowInviteModal: (open: boolean) => void;
}

export type InvitesTabProps = InvitesTabReadOnlyProps | InvitesTabFreshProps;

function inviteStatus(invite: RosterInvite) {
    const statuses = {
        pending: { tone: "warning", label: "대기 중" },
        accepted: { tone: "success", label: "수락됨" },
        expired: { tone: "muted", label: "만료" },
    } as const;
    return statuses[invite.status] ?? statuses.pending;
}

function ReadOnlyInvites({ hydrated, rosterInvites }: InvitesTabReadOnlyProps) {
    return (
        <div className="bento-card teacher-invites-card" style={{ padding: "1.5rem" }}>
            <div className="teacher-invite-share" style={{ padding: "1rem 1.25rem", marginBottom: "1.5rem" }}>
                <div style={{ display: "flex", gap: "0.75rem", alignItems: "center" }}>
                    <LinkIcon size={20} color="var(--primary)" aria-hidden="true" />
                    <div>
                        <div style={{ fontSize: "0.85rem", fontWeight: 700 }}>학생 초대 기록</div>
                        <span style={{ fontSize: "0.8rem", color: "var(--muted)" }}>저장된 기록을 읽기 전용으로 표시 중입니다.</span>
                    </div>
                </div>
            </div>
            <div className="teacher-invite-table-scroll scroll-custom" tabIndex={0} aria-label="초대 기록 표, 가로로 스크롤할 수 있습니다">
                <table className="teacher-invite-table" style={{ width: "100%", borderCollapse: "collapse", textAlign: "left" }}>
                    <thead>
                        <tr style={{ color: "var(--muted)", fontSize: "0.8rem", borderBottom: "1px solid var(--border)" }}>
                            <th style={{ padding: "0.85rem 0.5rem" }}>초대 연락처</th>
                            <th style={{ padding: "0.85rem 0.5rem" }}>기록 시각</th>
                            <th style={{ padding: "0.85rem 0.5rem" }}>상태</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rosterInvites.map(invite => {
                            const status = inviteStatus(invite);
                            return (
                                <tr key={invite.id} style={{ borderBottom: "1px solid var(--border)" }}>
                                    <td style={{ padding: "1rem 0.5rem", fontWeight: 600 }}>{invite.email}</td>
                                    <td style={{ padding: "1rem 0.5rem", color: "var(--muted)" }}>{invite.sentAt}</td>
                                    <td style={{ padding: "1rem 0.5rem" }}><StatusPill tone={status.tone} label={status.label} size="sm" /></td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
            {hydrated && rosterInvites.length === 0 && (
                <div style={{ padding: "2.5rem 1rem", textAlign: "center", color: "var(--muted)", fontSize: "0.9rem" }}>
                    저장된 초대 기록이 없습니다. 최신 서버 명단을 다시 불러오세요.
                </div>
            )}
        </div>
    );
}

export default function InvitesTab(props: InvitesTabProps) {
    if (props.capability === "degraded_read_only") {
        return <ReadOnlyInvites {...props} />;
    }

    const {
        copyFlash,
        hydrated,
        rosterInvites,
        handleCopyInvite,
        handleResendInvite,
        handleCancelInvite,
        setShowInviteModal,
    } = props;
    return (
        <div className="bento-card teacher-invites-card" style={{ padding: "1.5rem" }}>
            <div className="teacher-invite-share" style={{
                display: "flex", gap: "0.75rem", padding: "1rem 1.25rem",
                background: "linear-gradient(135deg, rgba(99,102,241,0.06), rgba(139,92,246,0.06))",
                borderRadius: "var(--radius-md)", border: "1px solid rgba(99,102,241,0.15)",
                marginBottom: "1.5rem", alignItems: "center",
            }}>
                <LinkIcon size={20} color="var(--primary)" style={{ flexShrink: 0, marginTop: 2 }} />
                <div className="teacher-invite-share-copy" style={{ flex: 1 }}>
                    <div style={{ fontSize: "0.85rem", fontWeight: 700, marginBottom: "0.25rem" }}>학생 시험 링크</div>
                    <span style={{ fontSize: "0.8rem", color: "var(--muted)" }}>시험 배포 단계에서 대상 반별 만료 링크를 발급합니다.</span>
                </div>
                {copyFlash && <span style={{ fontSize: "0.8rem", color: "var(--success)", fontWeight: 700 }}>복사됨</span>}
                <button type="button" className="teacher-invite-action" onClick={handleCopyInvite}>발급 안내</button>
                <button type="button" className="teacher-invite-action" onClick={() => setShowInviteModal(true)}>
                    <MessageCircle size={13} /> 카카오 초대 기록
                </button>
            </div>

            <div className="teacher-invite-table-scroll scroll-custom" tabIndex={0} aria-label="초대 기록 표, 가로로 스크롤할 수 있습니다">
                <table className="teacher-invite-table" style={{ width: "100%", borderCollapse: "collapse", textAlign: "left" }}>
                    <thead>
                        <tr style={{ color: "var(--muted)", fontSize: "0.8rem", borderBottom: "1px solid var(--border)" }}>
                            <th style={{ padding: "0.85rem 0.5rem" }}>초대 연락처</th>
                            <th style={{ padding: "0.85rem 0.5rem" }}>기록 시각</th>
                            <th style={{ padding: "0.85rem 0.5rem" }}>상태</th>
                            <th style={{ padding: "0.85rem 0.5rem", textAlign: "right" }}>작업</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rosterInvites.map(invite => {
                            const status = inviteStatus(invite);
                            return (
                                <tr key={invite.id} style={{ borderBottom: "1px solid var(--border)" }}>
                                    <td style={{ padding: "1rem 0.5rem", fontWeight: 600 }}>{invite.email}</td>
                                    <td style={{ padding: "1rem 0.5rem", color: "var(--muted)" }}>{invite.sentAt}</td>
                                    <td style={{ padding: "1rem 0.5rem" }}><StatusPill tone={status.tone} label={status.label} size="sm" /></td>
                                    <td style={{ padding: "1rem 0.5rem", textAlign: "right" }}>
                                        <div style={{ display: "flex", gap: "0.75rem", justifyContent: "flex-end" }}>
                                            {invite.status !== "accepted" && (
                                                <button onClick={() => handleResendInvite(invite.id)}>기록 갱신</button>
                                            )}
                                            <button onClick={() => handleCancelInvite(invite.id)}>취소</button>
                                        </div>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
            {hydrated && rosterInvites.length === 0 && (
                <div style={{ padding: "2.5rem 1rem", textAlign: "center", color: "var(--muted)", fontSize: "0.9rem" }}>
                    아직 저장된 초대 기록이 없습니다. 위의 <strong style={{ color: "var(--primary)" }}>카카오 초대 기록</strong> 버튼으로 시작하세요.
                </div>
            )}
        </div>
    );
}
