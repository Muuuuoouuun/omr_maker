"use client";

import { useEffect, useRef, useState } from "react";
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
}

const DEFAULT_NOTIFICATIONS: Notification[] = [
    { id: "n1", kind: "warning", title: "미응시 학생 8명", message: "Midterm English Test 시험 시작 1시간 전", time: "방금 전", unread: true, href: "/teacher/live" },
    { id: "n2", kind: "success", title: "시험 제출 완료", message: "Chapter 4 Mathematics — 전원 제출 완료", time: "30분 전", unread: true, href: "/teacher/live" },
    { id: "n3", kind: "info", title: "새 학생 등록", message: "3명이 초대 링크로 가입했습니다", time: "2시간 전", unread: true, href: "/teacher/users" },
    { id: "n4", kind: "billing", title: "Pro 플랜 갱신 예정", message: "2026-05-01에 ₩19,000 결제됩니다", time: "어제", unread: false, href: "/teacher/billing" },
    { id: "n5", kind: "success", title: "AI 채점 완료", message: "45명 자동 채점 완료", time: "2일 전", unread: false },
];

const STORAGE_KEY = "omr_notifications";

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

    // Hydrate
    useEffect(() => {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (Array.isArray(parsed) && parsed.length > 0) {
                    setNotifications(parsed);
                } else {
                    setNotifications(DEFAULT_NOTIFICATIONS);
                }
            } else {
                setNotifications(DEFAULT_NOTIFICATIONS);
                localStorage.setItem(STORAGE_KEY, JSON.stringify(DEFAULT_NOTIFICATIONS));
            }
        } catch {
            setNotifications(DEFAULT_NOTIFICATIONS);
        }
        setHydrated(true);
    }, []);

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
        persist([]);
    };

    return (
        <div ref={rootRef} style={{ position: 'relative' }}>
            <button
                onClick={() => setOpen(prev => !prev)}
                aria-label={`알림 ${unreadCount > 0 ? `(읽지 않음 ${unreadCount}개)` : ''}`}
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
