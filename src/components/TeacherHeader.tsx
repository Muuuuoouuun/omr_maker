"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Activity, Search } from "lucide-react";
import ThemeToggle from "./ThemeToggle";
import GlobalSearch from "./GlobalSearch";
import NotificationBell from "./NotificationBell";
import TeacherLogoutButton from "./TeacherLogoutButton";
import TeacherSessionChip from "./TeacherSessionChip";

interface TeacherHeaderProps {
    badge?: string;
    badgeColor?: string;
}

export default function TeacherHeader({ badge = "TEACHER", badgeColor }: TeacherHeaderProps) {
    const color = badgeColor || "var(--primary)";
    // Defer mac detection to post-mount to avoid SSR/CSR hydration mismatch
    // (navigator.platform differs between server and client and would mismatch
    // the <kbd> label, which breaks hydration of the whole subtree — including
    // GlobalSearch's keydown listener and ThemeToggle's mount effect).
    const [isMac, setIsMac] = useState(false);
    useEffect(() => {
        // Hydrate browser platform after mount to avoid SSR mismatch.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setIsMac(typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform));
    }, []);
    return (
        <>
            <header className="header teacher-header">
                <div className="container header-content">
                    <div className="teacher-header-brand" style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                        <Link href="/" className="logo">Classin</Link>
                        <span style={{
                            fontSize: '0.75rem', fontWeight: 700,
                            background: `color-mix(in srgb, ${color}, transparent 88%)`,
                            color,
                            padding: '4px 10px', borderRadius: 'var(--radius-full)',
                            border: `1px solid color-mix(in srgb, ${color}, transparent 78%)`
                        }}>
                            {badge}
                        </span>
                    </div>
                    <div className="teacher-header-actions" style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                        {/* Search trigger — opens modal via Cmd+K */}
                        <button
                            onClick={() => {
                                // Dispatch a synthetic Cmd+K so GlobalSearch's window listener opens it
                                window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, ctrlKey: true, bubbles: true }));
                            }}
                            aria-label="빠른 검색"
                            style={{
                                display: 'flex', alignItems: 'center', gap: '0.6rem',
                                padding: '0.45rem 0.8rem',
                                background: 'var(--background)',
                                border: '1px solid var(--border)',
                                borderRadius: 'var(--radius-full)',
                                color: 'var(--muted)',
                                fontSize: '0.82rem',
                                transition: 'var(--transition-base)',
                                minHeight: '2.75rem',
                                minWidth: 180
                            }}
                            className="header-search-btn"
                            onMouseEnter={(e) => {
                                e.currentTarget.style.borderColor = 'rgba(99,102,241,0.4)';
                                e.currentTarget.style.color = 'var(--primary)';
                            }}
                            onMouseLeave={(e) => {
                                e.currentTarget.style.borderColor = 'var(--border)';
                                e.currentTarget.style.color = 'var(--muted)';
                            }}
                        >
                            <Search size={14} />
                            <span style={{ flex: 1, textAlign: 'left' }}>검색...</span>
                            <kbd style={{
                                padding: '1px 6px', background: 'var(--surface)', border: '1px solid var(--border)',
                                borderRadius: 4, fontFamily: 'var(--font-mono)', fontSize: '0.7rem', fontWeight: 600
                            }}>{isMac ? '⌘K' : 'Ctrl K'}</kbd>
                        </button>
                        <Link href="/teacher/dashboard" style={{
                            fontSize: '0.85rem', fontWeight: 600, color: 'var(--muted)',
                            padding: '0.5rem 0.9rem', borderRadius: 'var(--radius-full)',
                            transition: 'var(--transition-base)'
                        }} className="nav-link">Dashboard</Link>
                        <Link href="/teacher/live" style={{
                            display: 'inline-flex', alignItems: 'center', gap: '0.35rem',
                            fontSize: '0.85rem', fontWeight: 700,
                            color: 'var(--success)',
                            padding: '0.5rem 0.9rem', borderRadius: 'var(--radius-full)',
                            border: '1px solid rgba(16,185,129,0.28)',
                            background: 'rgba(16,185,129,0.08)',
                            transition: 'var(--transition-base)',
                            minHeight: '2.75rem',
                        }} className="nav-link-live" aria-label="실시간 모니터링">
                            <Activity size={14} />
                            <span>Live</span>
                        </Link>
                        <TeacherSessionChip />
                        <NotificationBell />
                        <TeacherLogoutButton />
                        <ThemeToggle />
                    </div>
                </div>
            </header>
            <GlobalSearch />
            <style>{`
                @media (max-width: 640px) {
                    .header-search-btn { min-width: 2.75rem !important; width: 2.75rem !important; padding: 0 !important; justify-content: center !important; }
                    .header-search-btn span { display: none !important; }
                    .header-search-btn kbd { display: none !important; }
                    .nav-link-live { min-width: 2.75rem !important; width: 2.75rem !important; padding: 0 !important; justify-content: center !important; }
                    .nav-link-live span { display: none !important; }
                }
            `}</style>
        </>
    );
}
