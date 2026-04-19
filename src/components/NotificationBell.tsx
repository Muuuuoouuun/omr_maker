"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Bell, AlertCircle, CheckCircle2, CreditCard, Users, Clock } from "lucide-react";

interface Notification {
    id: string;
    title: string;
    message: string;
    time: string;
    unread: boolean;
    href?: string;
    kind: "info" | "success" | "warning" | "billing";
    /** Stable key for auto-generated notifications so we don't spawn duplicates on refresh */
    source?: "invites" | "recent-exams" | "plan-renewal";
}

const STORAGE_KEY = "omr_notifications";
const DISMISSED_KEY = "omr_notifications_dismissed";

// Compute what auto-generated notifications SHOULD exist right now based on
// localStorage state. Returns an empty list when nothing applies.
function computeAutoNotifications(): Notification[] {
    if (typeof window === "undefined") return [];
    const out: Notification[] = [];

    // 1) Pending invites
    try {
        const raw = localStorage.getItem("omr_invites");
        if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                const pending = parsed.filter((i: { status?: string }) => i && i.status === "pending").length;
                if (pending > 0) {
                    out.push({
                        id: "auto-invites",
                        source: "invites",
                        kind: "info",
                        title: "초대 수락 대기",
                        message: `${pending}개 초대가 수락 대기 중`,
                        time: "방금",
                        unread: true,
                        href: "/teacher/users",
                    });
                }
            }
        }
    } catch {}

    // 2) Attempts finished in last 24h
    try {
        const raw = localStorage.getItem("omr_attempts");
        if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                const cutoff = Date.now() - 24 * 60 * 60 * 1000;
                const recent = (parsed as { finishedAt?: string; status?: string }[]).filter(a => {
                    if (!a || a.status !== "completed") return false;
                    const t = a.finishedAt ? new Date(a.finishedAt).getTime() : NaN;
                    return !Number.isNaN(t) && t >= cutoff;
                }).length;
                if (recent > 0) {
                    out.push({
                        id: "auto-recent-exams",
                        source: "recent-exams",
                        kind: "success",
                        title: "최근 시험 제출",
                        message: `최근 24시간 내 ${recent}개 시험 제출 완료`,
                        time: "최근 24시간",
                        unread: true,
                        href: "/teacher/live",
                    });
                }
            }
        }
    } catch {}

    // 3) Plan renewal within 7 days
    try {
        const plan = localStorage.getItem("omr_plan");
        if (plan === "pro" || plan === "school") {
            // Use the 1st of next month as the mock renewal date
            const now = new Date();
            const renewal = new Date(now.getFullYear(), now.getMonth() + 1, 1);
            const daysUntil = Math.ceil((renewal.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
            if (daysUntil >= 0 && daysUntil <= 7) {
                const planName = plan === "pro" ? "Pro" : "School";
                out.push({
                    id: "auto-plan-renewal",
                    source: "plan-renewal",
                    kind: "billing",
                    title: `${planName} 플랜 갱신 예정`,
                    message: `${daysUntil}일 후 (${renewal.toISOString().slice(0, 10)}) 자동 결제됩니다`,
                    time: `${daysUntil}일 후`,
                    unread: true,
                    href: "/teacher/billing",
                });
            }
        }
    } catch {}

    return out;
}

const KIND_META: Record<Notification["kind"], { color: string; icon: React.ReactNode }> = {
    info: { color: "#4f46e5", icon: <Users size={16} /> },
    success: { color: "#10b981", icon: <CheckCircle2 size={16} /> },
    warning: { color: "#f59e0b", icon: <AlertCircle size={16} /> },
    billing: { color: "#a855f7", icon: <CreditCard size={16} /> },
};

export default function NotificationBell() {
    const [open, setOpen] = useState(false);
    const [notifications, setNotifications] = useState<Notification[]>([]);
    const [hydrated, setHydrated] = useState(false);
    const rootRef = useRef<HTMLDivElement | null>(null);

    // Merge auto-generated (dynamic) notifications with persisted user
    // notifications. The persisted list is what the user has dismissed/read
    // on, so it always wins for notifications they touched. Auto notifs are
    // injected fresh (but their unread state is preserved if we've seen them).
    const refresh = useCallback(() => {
        let persisted: Notification[] = [];
        let dismissed: string[] = [];
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) persisted = parsed as Notification[];
            }
        } catch {}
        try {
            const raw = localStorage.getItem(DISMISSED_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed)) dismissed = parsed as string[];
            }
        } catch {}
        const dismissedSet = new Set(dismissed);

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
        refresh();
        setHydrated(true);
        const id = setInterval(refresh, 60 * 1000);
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
        if (!window.confirm("모든 알림을 삭제하시겠습니까?")) return;
        // Remember which auto-generated notifications were dismissed so they
        // don't get re-added on the next refresh tick.
        try {
            const autoIds = notifications
                .map(n => n.id)
                .filter(id => id.startsWith("auto-"));
            if (autoIds.length > 0) {
                const raw = localStorage.getItem(DISMISSED_KEY);
                let existing: string[] = [];
                if (raw) {
                    const parsed = JSON.parse(raw);
                    if (Array.isArray(parsed)) existing = parsed as string[];
                }
                const merged = Array.from(new Set([...existing, ...autoIds]));
                localStorage.setItem(DISMISSED_KEY, JSON.stringify(merged));
            }
        } catch {}
        persist([]);
    };

    return (
        <div ref={rootRef} style={{ position: 'relative' }}>
            <button
                onClick={() => setOpen(prev => !prev)}
                aria-label={unreadCount > 0 ? `알림 (읽지 않음 ${unreadCount}개)` : '알림 받기'}
                style={{
                    width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center',
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
                                        style={{ fontSize: '0.75rem', color: 'var(--primary)', fontWeight: 600 }}
                                    >
                                        모두 읽음
                                    </button>
                                )}
                                <button
                                    onClick={clearAll}
                                    style={{ fontSize: '0.75rem', color: 'var(--muted)', fontWeight: 500 }}
                                >
                                    모두 삭제
                                </button>
                            </div>
                        )}
                    </div>

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
