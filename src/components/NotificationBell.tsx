"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Bell, CheckCircle2, CreditCard, MessageCircle, Users, Clock } from "lucide-react";
import { readLocalAttempts, readLocalExams } from "@/lib/omrPersistence";
import { readRosterGroups, readRosterInvites, readRosterStudents } from "@/lib/rosterStorage";
import { createLocalPlanCycleReminder } from "@/lib/billingRecords";
import { buildKakaoNotificationCandidates } from "@/lib/kakaoNotificationQueue";
import { getPlanLabel, normalizePlan } from "@/utils/plans";

interface Notification {
    id: string;
    title: string;
    message: string;
    time: string;
    unread: boolean;
    href?: string;
    kind: "info" | "success" | "warning" | "billing";
    /** Stable key for auto-generated notifications so we don't spawn duplicates on refresh */
    source?: "invites" | "recent-exams" | "plan-renewal" | "kakao-candidates";
}

const STORAGE_KEY = "omr_notifications";
const DISMISSED_KEY = "omr_notifications_dismissed";
// Auto-notification dismissals self-expire so "모두 삭제" never permanently
// silences a category. Auto ids are content-scoped (see below), so a genuinely
// new event produces a new id and reappears immediately regardless of this TTL;
// the window only bounds how long an *identical* state stays hidden and prunes
// the stored dismissal list.
const DISMISSED_TTL_MS = 14 * 24 * 60 * 60 * 1000;

interface DismissedEntry {
    id: string;
    at: number;
}

// Compute what auto-generated notifications SHOULD exist right now based on
// localStorage state. Returns an empty list when nothing applies.
function computeAutoNotifications(): Notification[] {
    if (typeof window === "undefined") return [];
    const out: Notification[] = [];

    // Parse the heavy localStorage blobs once and reuse them across every
    // section below (this runs on mount and every 60s on all teacher pages).
    let attempts: ReturnType<typeof readLocalAttempts> = [];
    let exams: ReturnType<typeof readLocalExams> = [];
    try { attempts = readLocalAttempts(); } catch {}
    try { exams = readLocalExams(); } catch {}

    // 1) Pending invites
    try {
        const pending = readRosterInvites(localStorage).filter(invite => invite.status === "pending").length;
        if (pending > 0) {
            out.push({
                id: `auto-invites:${pending}`,
                source: "invites",
                kind: "info",
                title: "초대 수락 대기",
                message: `${pending}개 초대가 수락 대기 중`,
                time: "방금",
                unread: true,
                href: "/teacher/users",
            });
        }
    } catch {}

    // 2) Attempts finished in last 24h
    try {
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        const recent = attempts.filter(a => {
            if (a.status !== "completed") return false;
            const t = new Date(a.finishedAt).getTime();
            return !Number.isNaN(t) && t >= cutoff;
        }).length;
        if (recent > 0) {
            out.push({
                id: `auto-recent-exams:${recent}`,
                source: "recent-exams",
                kind: "success",
                title: "최근 시험 제출",
                message: `최근 24시간 내 ${recent}개 시험 제출 완료`,
                time: "최근 24시간",
                unread: true,
                href: "/teacher/live",
            });
        }
    } catch {}

    // 3) Kakao notification candidates. These are planning records only:
    // no message is sent from this local UI.
    try {
        const queue = buildKakaoNotificationCandidates({
            exams,
            attempts,
            students: readRosterStudents(localStorage),
            groups: readRosterGroups(localStorage),
            limit: 8,
        });
        if (queue.totalCount > 0) {
            const parts = [
                queue.missingExamCount > 0 ? `미응시 ${queue.missingExamCount}건` : "",
                queue.classRetakeRecommendationCount > 0 ? `반별 재시험 ${queue.classRetakeRecommendationCount}건` : "",
                queue.retakeRecommendationCount > 0 ? `재시험 ${queue.retakeRecommendationCount}건` : "",
            ].filter(Boolean);
            out.push({
                id: `auto-kakao-candidates:${queue.missingExamCount}-${queue.classRetakeRecommendationCount}-${queue.retakeRecommendationCount}-${queue.targetStudentCount}`,
                source: "kakao-candidates",
                kind: "warning",
                title: "카카오 발송 후보 대기",
                message: `${parts.join(" · ")} · 대상 학생 ${queue.targetStudentCount}명`,
                time: "발송 전",
                unread: true,
                href: "/teacher/dashboard?tab=exam",
            });
        }
    } catch {}

    // 4) Plan renewal within 7 days
    try {
        const plan = normalizePlan(localStorage.getItem("omr_plan"));
        if (plan === "pro" || plan === "academy") {
            const now = new Date();
            const renewal = new Date(now.getFullYear(), now.getMonth() + 1, 1);
            const reminder = createLocalPlanCycleReminder({
                planName: getPlanLabel(plan),
                now,
                cycleDate: renewal,
            });
            if (reminder) {
                out.push({
                    id: `auto-plan-renewal:${renewal.getFullYear()}-${renewal.getMonth() + 1}`,
                    source: "plan-renewal",
                    kind: "billing",
                    title: reminder.title,
                    message: reminder.message,
                    time: reminder.time,
                    unread: true,
                    href: "/teacher/billing",
                });
            }
        }
    } catch {}

    return out;
}

// Read the non-expired dismissal entries. Legacy category-scoped string ids
// (e.g. "auto-recent-exams") are intentionally dropped: they matched every
// future event and permanently silenced the category, which is the bug this
// fixes. Content-scoped ids now carry a timestamp and expire after the TTL.
function readDismissedEntries(): DismissedEntry[] {
    try {
        const raw = localStorage.getItem(DISMISSED_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        const now = Date.now();
        const entries: DismissedEntry[] = [];
        for (const item of parsed) {
            if (item && typeof item === "object" && typeof item.id === "string" && typeof item.at === "number") {
                if (now - item.at < DISMISSED_TTL_MS) entries.push({ id: item.id, at: item.at });
            }
        }
        return entries;
    } catch {
        return [];
    }
}

const KIND_META: Record<Notification["kind"], { color: string; icon: React.ReactNode }> = {
    info: { color: "#4f46e5", icon: <Users size={16} /> },
    success: { color: "#10b981", icon: <CheckCircle2 size={16} /> },
    warning: { color: "#f59e0b", icon: <MessageCircle size={16} /> },
    billing: { color: "#a855f7", icon: <CreditCard size={16} /> },
};

export default function NotificationBell() {
    const [open, setOpen] = useState(false);
    const [notifications, setNotifications] = useState<Notification[]>([]);
    const [hydrated, setHydrated] = useState(false);
    const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement | null>(null);

    // Merge auto-generated (dynamic) notifications with persisted user
    // notifications. The persisted list is what the user has dismissed/read
    // on, so it always wins for notifications they touched. Auto notifs are
    // injected fresh (but their unread state is preserved if we've seen them).
    const refresh = useCallback(() => {
        let persisted: Notification[] = [];
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) persisted = parsed as Notification[];
            }
        } catch {}
        const dismissedSet = new Set(readDismissedEntries().map(entry => entry.id));

        const auto = computeAutoNotifications().filter(n => !dismissedSet.has(n.id));

        // Reconcile unread state: if the same auto id is already in the
        // persisted list and the user marked it read, keep it read.
        const persistedById = new Map(persisted.map(n => [n.id, n]));
        const mergedAuto = auto.map(a => {
            const prev = persistedById.get(a.id);
            if (prev && prev.unread === false) return { ...a, unread: false };
            return a;
        });

        // Keep any user-added / non-auto persisted notifications
        const userOnly = persisted.filter(n => !n.source);

        const merged = [...mergedAuto, ...userOnly];
        setNotifications(merged);
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
        } catch {}
    }, []);

    // Hydrate once + refresh every 60s
    useEffect(() => {
        // Refresh derives notifications from client-only localStorage after mount.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        refresh();
        setHydrated(true);
        const id = setInterval(() => {
            // Skip the localStorage parsing work while the tab is backgrounded.
            if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
            refresh();
        }, 60 * 1000);
        return () => clearInterval(id);
    }, [refresh]);

    // Close on outside click
    useEffect(() => {
        if (!open) return;
        const onClick = (e: MouseEvent) => {
            if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
                setOpen(false);
            }
        };
        window.addEventListener("mousedown", onClick);
        return () => window.removeEventListener("mousedown", onClick);
    }, [open]);

    const unreadCount = notifications.filter(n => n.unread).length;

    const persist = (next: Notification[]) => {
        setNotifications(next);
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); } catch {}
    };

    const markAllRead = () => {
        persist(notifications.map(n => ({ ...n, unread: false })));
    };
    const markOneRead = (id: string) => {
        persist(notifications.map(n => n.id === id ? { ...n, unread: false } : n));
    };
    const clearAll = () => {
        // Remember which auto-generated notifications were dismissed so they
        // don't get re-added on the next refresh tick. Dismissals are stored
        // with a timestamp and expire (see readDismissedEntries), and the auto
        // ids are content-scoped, so this hides only the *current* state — a
        // new event later produces a new id and reappears.
        try {
            const now = Date.now();
            const dismissedIds = new Set(
                notifications.map(n => n.id).filter(id => id.startsWith("auto-"))
            );
            if (dismissedIds.size > 0) {
                const existing = readDismissedEntries().filter(entry => !dismissedIds.has(entry.id));
                const merged: DismissedEntry[] = [
                    ...existing,
                    ...[...dismissedIds].map(id => ({ id, at: now })),
                ];
                localStorage.setItem(DISMISSED_KEY, JSON.stringify(merged));
            }
        } catch {}
        persist([]);
        setClearConfirmOpen(false);
    };

    return (
        <div ref={rootRef} style={{ position: 'relative' }}>
            <button
                onClick={() => setOpen(prev => !prev)}
                aria-label={unreadCount > 0 ? `알림 (읽지 않음 ${unreadCount}개)` : '알림 받기'}
                style={{
                    width: 44, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    borderRadius: 'var(--radius-full)', background: 'var(--background)',
                    border: '1px solid var(--border)', color: 'var(--foreground)',
                    position: 'relative', transition: 'var(--transition-base)', flexShrink: 0
                }}
                onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = 'rgba(99,102,241,0.4)';
                    e.currentTarget.style.color = 'var(--primary)';
                }}
                onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = 'var(--border)';
                    e.currentTarget.style.color = 'var(--foreground)';
                }}
            >
                <Bell size={18} />
                {hydrated && unreadCount > 0 && (
                    <span style={{
                        position: 'absolute', top: 2, right: 2,
                        minWidth: 16, height: 16, padding: '0 4px',
                        background: '#ef4444', color: 'white',
                        borderRadius: 'var(--radius-full)',
                        fontSize: '0.62rem', fontWeight: 800,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        border: '1.5px solid var(--surface)',
                        fontVariantNumeric: 'tabular-nums'
                    }}>
                        {unreadCount > 9 ? '9+' : unreadCount}
                    </span>
                )}
            </button>

            {open && (
                <div
                    role="dialog"
                    aria-label="알림 목록"
                    style={{
                        position: 'absolute', top: 'calc(100% + 0.5rem)', right: 0,
                        width: 360, maxWidth: '90vw',
                        background: 'var(--surface)',
                        border: '1px solid var(--border)',
                        borderRadius: 'var(--radius-lg)',
                        boxShadow: '0 12px 48px rgba(0,0,0,0.15)',
                        zIndex: 100, overflow: 'hidden',
                        animation: 'fadeIn 0.15s ease-out'
                    }}
                >
                    {/* Header */}
                    <div style={{
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        padding: '0.85rem 1rem', borderBottom: '1px solid var(--border)'
                    }}>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.4rem' }}>
                            <span style={{ fontSize: '0.95rem', fontWeight: 700 }}>알림</span>
                            {unreadCount > 0 && (
                                <span style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>
                                    {unreadCount}개 읽지 않음
                                </span>
                            )}
                        </div>
                        {notifications.length > 0 && (
                            <div style={{ display: 'flex', gap: '0.5rem' }}>
                                {unreadCount > 0 && (
                                    <button
                                        onClick={markAllRead}
                                        style={{ minHeight: 44, padding: '0 0.6rem', fontSize: '0.75rem', color: 'var(--primary)', fontWeight: 600 }}
                                    >
                                        모두 읽음
                                    </button>
                                )}
                                <button
                                    onClick={() => setClearConfirmOpen(true)}
                                    style={{ minHeight: 44, padding: '0 0.6rem', fontSize: '0.75rem', color: 'var(--muted)', fontWeight: 500 }}
                                >
                                    모두 삭제
                                </button>
                            </div>
                        )}
                    </div>

                    {clearConfirmOpen && (
                        <div
                            role="alertdialog"
                            aria-label="모든 알림 삭제 확인"
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                gap: '0.75rem',
                                padding: '0.75rem 1rem',
                                background: 'rgba(239,68,68,0.08)',
                                borderBottom: '1px solid rgba(239,68,68,0.18)',
                            }}
                        >
                            <span style={{ fontSize: '0.8rem', color: 'var(--foreground)', fontWeight: 700, wordBreak: 'keep-all' }}>
                                모든 알림을 삭제할까요?
                            </span>
                            <div style={{ display: 'flex', gap: '0.45rem', flexShrink: 0 }}>
                                <button
                                    onClick={() => setClearConfirmOpen(false)}
                                    style={{ minHeight: 44, padding: '0 0.6rem', fontSize: '0.75rem', color: 'var(--muted)', fontWeight: 700 }}
                                >
                                    취소
                                </button>
                                <button
                                    onClick={clearAll}
                                    style={{
                                        minHeight: 44,
                                        padding: '0 0.7rem',
                                        borderRadius: 'var(--radius-md)',
                                        background: 'var(--error)',
                                        color: 'white',
                                        fontSize: '0.75rem',
                                        fontWeight: 800,
                                    }}
                                >
                                    삭제
                                </button>
                            </div>
                        </div>
                    )}

                    {/* List */}
                    <div style={{ maxHeight: 420, overflowY: 'auto' }}>
                        {notifications.length === 0 ? (
                            <div style={{ padding: '3rem 2rem', textAlign: 'center', color: 'var(--muted)' }}>
                                <Clock size={28} style={{ marginBottom: '0.75rem', opacity: 0.5 }} />
                                <div style={{ fontSize: '0.9rem', fontWeight: 600, marginBottom: '0.2rem' }}>알림이 없습니다</div>
                                <div style={{ fontSize: '0.78rem' }}>새 소식이 도착하면 여기에 표시됩니다.</div>
                            </div>
                        ) : (
                            notifications.map(n => {
                                const meta = KIND_META[n.kind];
                                const content = (
                                    <>
                                        <div style={{
                                            width: 32, height: 32, flexShrink: 0,
                                            borderRadius: 8,
                                            background: `color-mix(in srgb, ${meta.color}, transparent 88%)`,
                                            color: meta.color,
                                            display: 'flex', alignItems: 'center', justifyContent: 'center'
                                        }}>
                                            {meta.icon}
                                        </div>
                                        <div style={{ flex: 1, minWidth: 0 }}>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', marginBottom: '0.15rem' }}>
                                                <span style={{ fontSize: '0.85rem', fontWeight: n.unread ? 700 : 500, color: 'var(--foreground)' }}>
                                                    {n.title}
                                                </span>
                                                <span style={{ fontSize: '0.72rem', color: 'var(--muted)', flexShrink: 0, whiteSpace: 'nowrap' }}>{n.time}</span>
                                            </div>
                                            <div style={{ fontSize: '0.78rem', color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                                {n.message}
                                            </div>
                                        </div>
                                        {n.unread && (
                                            <span aria-label="읽지 않음" style={{ width: 8, height: 8, borderRadius: '50%', background: meta.color, marginTop: 6, flexShrink: 0 }} />
                                        )}
                                    </>
                                );
                                const commonStyle: React.CSSProperties = {
                                    display: 'flex', alignItems: 'flex-start', gap: '0.75rem',
                                    padding: '0.85rem 1rem', borderBottom: '1px solid var(--border)',
                                    background: n.unread ? 'rgba(99,102,241,0.02)' : 'transparent',
                                    transition: 'background 0.15s', cursor: n.href ? 'pointer' : 'default',
                                    textAlign: 'left', width: '100%'
                                };
                                return n.href ? (
                                    <Link
                                        key={n.id}
                                        href={n.href}
                                        onClick={() => { markOneRead(n.id); setOpen(false); }}
                                        style={commonStyle}
                                    >
                                        {content}
                                    </Link>
                                ) : (
                                    <div key={n.id} onClick={() => markOneRead(n.id)} style={commonStyle}>
                                        {content}
                                    </div>
                                );
                            })
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
