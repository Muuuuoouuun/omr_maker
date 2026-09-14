"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Activity, Bell, ChevronDown, CreditCard, Gauge, Search, Settings, UserRound } from "lucide-react";
import BrandLogo from "./BrandLogo";
import ThemeToggle from "./ThemeToggle";
import GlobalSearch from "./GlobalSearch";
import NotificationBell from "./NotificationBell";
import TeacherLogoutButton from "./TeacherLogoutButton";
import TeacherSessionChip from "./TeacherSessionChip";
import SkipToMainContent from "./SkipToMainContent";

interface TeacherHeaderProps {
    /** @deprecated Page badges are intentionally no longer displayed. */
    badge?: string;
    /** @deprecated Page badges are intentionally no longer displayed. */
    badgeColor?: string;
    /** Controls whether the dashboard shortcut appears in the account menu. */
    showDashboardLink?: boolean;
    /** The ?showcase=1 demo account hides live monitoring. */
    showLiveLink?: boolean;
    showThemeToggle?: boolean;
}

export default function TeacherHeader({
    showDashboardLink = true,
    showLiveLink = true,
    showThemeToggle = true,
}: TeacherHeaderProps) {
    const [isMac, setIsMac] = useState(false);
    const [accountMenuOpen, setAccountMenuOpen] = useState(false);
    const accountMenuRootRef = useRef<HTMLDivElement>(null);
    const accountMenuRef = useRef<HTMLDivElement>(null);
    const accountMenuTriggerRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        // Hydrate browser platform after mount to avoid an SSR mismatch in the
        // shortcut label. The value never needs to participate in other state.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setIsMac(typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform));
    }, []);

    const closeAccountMenu = useCallback((restoreFocus = false) => {
        setAccountMenuOpen(false);
        if (restoreFocus) {
            window.requestAnimationFrame(() => accountMenuTriggerRef.current?.focus({ preventScroll: true }));
        }
    }, []);

    useEffect(() => {
        if (!accountMenuOpen) return;

        const focusFrame = window.requestAnimationFrame(() => {
            accountMenuRef.current
                ?.querySelector<HTMLElement>('[role="menuitem"]')
                ?.focus({ preventScroll: true });
        });
        const handlePointerDown = (event: MouseEvent) => {
            if (!accountMenuRootRef.current?.contains(event.target as Node)) {
                closeAccountMenu(false);
            }
        };
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                event.preventDefault();
                closeAccountMenu(true);
                return;
            }
            if (event.key === "Tab") {
                event.preventDefault();
                closeAccountMenu(true);
                return;
            }

            if (event.key !== "ArrowDown"
                && event.key !== "ArrowUp"
                && event.key !== "Home"
                && event.key !== "End") return;

            const menuItems = Array.from(
                accountMenuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') || [],
            ).filter(item => !item.hasAttribute("disabled") && item.getAttribute("aria-disabled") !== "true");
            if (menuItems.length === 0) return;

            event.preventDefault();
            event.stopPropagation();
            const currentIndex = menuItems.indexOf(document.activeElement as HTMLElement);
            if (event.key === "Home") {
                menuItems[0].focus({ preventScroll: true });
                return;
            }
            if (event.key === "End") {
                menuItems[menuItems.length - 1].focus({ preventScroll: true });
                return;
            }
            if (event.key === "ArrowDown") {
                menuItems[(currentIndex + 1 + menuItems.length) % menuItems.length].focus({ preventScroll: true });
                return;
            }
            if (event.key === "ArrowUp") {
                const previousIndex = currentIndex < 0 ? menuItems.length - 1 : (currentIndex - 1 + menuItems.length) % menuItems.length;
                menuItems[previousIndex].focus({ preventScroll: true });
            }
        };

        window.addEventListener("mousedown", handlePointerDown);
        window.addEventListener("keydown", handleKeyDown);
        return () => {
            window.cancelAnimationFrame(focusFrame);
            window.removeEventListener("mousedown", handlePointerDown);
            window.removeEventListener("keydown", handleKeyDown);
        };
    }, [accountMenuOpen, closeAccountMenu]);

    const menuLinkStyle = {
        minHeight: 44,
        display: "flex",
        alignItems: "center",
        gap: "0.65rem",
        padding: "0.6rem 0.75rem",
        borderRadius: "var(--radius-md)",
        color: "var(--foreground)",
        fontSize: "0.86rem",
        fontWeight: 700,
    } as const;

    return (
        <>
            <SkipToMainContent />
            <header className="header teacher-header">
                <div className="container header-content mobile-inline-surface">
                    <div className="teacher-header-brand" style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
                        <BrandLogo />
                    </div>
                    <div className="teacher-header-actions mobile-action-row" style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                        {/* Search trigger — opens modal via Cmd+K */}
                        <button
                            type="button"
                            onClick={() => window.dispatchEvent(new Event("omr:open-search"))}
                            aria-label="빠른 검색"
                            className="header-search-btn"
                            style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "0.6rem",
                                padding: "0.45rem 0.8rem",
                                background: "var(--background)",
                                border: "1px solid var(--border)",
                                borderRadius: "var(--radius-full)",
                                color: "var(--muted)",
                                fontSize: "0.82rem",
                                transition: "var(--transition-base)",
                                minHeight: 44,
                                minWidth: 180,
                            }}
                            onMouseEnter={(event) => {
                                event.currentTarget.style.borderColor = "rgba(99,102,241,0.4)";
                                event.currentTarget.style.color = "var(--primary)";
                            }}
                            onMouseLeave={(event) => {
                                event.currentTarget.style.borderColor = "var(--border)";
                                event.currentTarget.style.color = "var(--muted)";
                            }}
                        >
                            <Search size={16} aria-hidden="true" />
                            <span style={{ flex: 1, textAlign: "left" }}>검색...</span>
                            <kbd style={{
                                padding: "1px 6px",
                                background: "var(--surface)",
                                border: "1px solid var(--border)",
                                borderRadius: 4,
                                fontFamily: "var(--font-mono)",
                                fontSize: "0.7rem",
                                fontWeight: 600,
                            }}>
                                {isMac ? "⌘K" : "Ctrl K"}
                            </kbd>
                        </button>

                        {showLiveLink && (
                            <Link
                                href="/teacher/live"
                                className="teacher-header-live-action"
                                aria-label="실시간 모니터링"
                                style={{
                                    minHeight: 44,
                                    display: "inline-flex",
                                    alignItems: "center",
                                    gap: "0.4rem",
                                    padding: "0.5rem 0.85rem",
                                    borderRadius: "var(--radius-full)",
                                    border: "1px solid color-mix(in srgb, var(--success), transparent 74%)",
                                    background: "color-mix(in srgb, var(--success), transparent 90%)",
                                    color: "var(--success)",
                                    fontSize: "0.84rem",
                                    fontWeight: 800,
                                    transition: "var(--transition-base)",
                                }}
                            >
                                <Activity size={16} aria-hidden="true" />
                                <span>실시간</span>
                            </Link>
                        )}

                        <NotificationBell />

                        <div ref={accountMenuRootRef} className="teacher-account-menu-root" style={{ position: "relative" }}>
                            <button
                                ref={accountMenuTriggerRef}
                                type="button"
                                aria-label="교사 계정 메뉴"
                                aria-haspopup="menu"
                                aria-expanded={accountMenuOpen}
                                aria-controls="teacher-account-menu"
                                onClick={() => setAccountMenuOpen(open => !open)}
                                style={{
                                    width: 44,
                                    height: 44,
                                    display: "inline-flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    gap: "0.1rem",
                                    borderRadius: "var(--radius-full)",
                                    border: "1px solid var(--border)",
                                    background: accountMenuOpen ? "rgba(99,102,241,0.1)" : "var(--background)",
                                    color: accountMenuOpen ? "var(--primary)" : "var(--foreground)",
                                    flexShrink: 0,
                                }}
                            >
                                <UserRound size={17} aria-hidden="true" />
                                <ChevronDown size={12} aria-hidden="true" />
                            </button>

                            {accountMenuOpen && (
                                <div
                                    ref={accountMenuRef}
                                    id="teacher-account-menu"
                                    role="menu"
                                    aria-label="교사 계정"
                                    className="teacher-account-menu"
                                    onBlur={(event) => {
                                        const nextFocus = event.relatedTarget;
                                        if (!(nextFocus instanceof Node) || !event.currentTarget.contains(nextFocus)) {
                                            closeAccountMenu(false);
                                        }
                                    }}
                                    style={{
                                        position: "absolute",
                                        top: "calc(100% + 0.55rem)",
                                        right: 0,
                                        width: 260,
                                        padding: "0.65rem",
                                        border: "1px solid var(--border)",
                                        borderRadius: "var(--radius-lg)",
                                        background: "var(--surface)",
                                        boxShadow: "0 18px 45px rgba(15,23,42,0.18)",
                                        zIndex: 80,
                                    }}
                                >
                                    <div role="none" style={{ padding: "0.2rem 0.25rem 0.65rem", borderBottom: "1px solid var(--border)", marginBottom: "0.4rem" }}>
                                        <TeacherSessionChip compact />
                                    </div>
                                    {showDashboardLink && (
                                        <Link href="/teacher/dashboard" role="menuitem" onClick={() => closeAccountMenu()} style={menuLinkStyle}>
                                            <Gauge size={17} aria-hidden="true" /> 대시보드
                                        </Link>
                                    )}
                                    {showLiveLink && (
                                        <Link href="/teacher/live" role="menuitem" onClick={() => closeAccountMenu()} style={menuLinkStyle}>
                                            <Activity size={17} aria-hidden="true" /> 실시간 모니터링
                                        </Link>
                                    )}
                                    <Link href="/teacher/remediation" role="menuitem" onClick={() => closeAccountMenu()} style={menuLinkStyle}>
                                        <Activity size={17} aria-hidden="true" /> 오답 보강 관리
                                    </Link>
                                    <Link href="/teacher/reminders" role="menuitem" onClick={() => closeAccountMenu()} style={menuLinkStyle}>
                                        <Bell size={17} aria-hidden="true" /> 학습 알림
                                    </Link>
                                    <Link href="/teacher/settings" role="menuitem" onClick={() => closeAccountMenu()} style={menuLinkStyle}>
                                        <Settings size={17} aria-hidden="true" /> 설정
                                    </Link>
                                    <Link href="/teacher/billing" role="menuitem" onClick={() => closeAccountMenu()} style={menuLinkStyle}>
                                        <CreditCard size={17} aria-hidden="true" /> 요금제 및 결제
                                    </Link>
                                    <div role="none" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.75rem", padding: "0.6rem 0.25rem 0.1rem", marginTop: "0.35rem", borderTop: "1px solid var(--border)" }}>
                                        <span style={{ color: "var(--muted)", fontSize: "0.78rem", fontWeight: 700 }}>화면 · 계정</span>
                                        <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                                            {showThemeToggle && <ThemeToggle size="small" role="menuitem" />}
                                            <TeacherLogoutButton size="small" role="menuitem" />
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </header>
            <GlobalSearch />
            <style>{`
                @media (max-width: 640px) {
                    .teacher-header .header-content { flex-wrap: nowrap; }
                    .teacher-header-actions { flex-wrap: nowrap; }
                    .header-search-btn { min-width: 44px !important; width: 44px !important; padding: 0 !important; justify-content: center !important; }
                    .header-search-btn span, .header-search-btn kbd { display: none !important; }
                    .teacher-header-live-action { display: none !important; }
                    .teacher-account-menu { width: min(260px, calc(100vw - 2rem)) !important; }
                }
            `}</style>
        </>
    );
}
