"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, PlusCircle, Activity, Users, BarChart3, Settings as SettingsIcon, CreditCard, FileText, LayoutDashboard, X, CornerDownLeft } from "lucide-react";
import { readLocalExams } from "@/lib/omrPersistence";
import { readRosterStudents } from "@/lib/rosterStorage";

interface SearchItem {
    id: string;
    title: string;
    subtitle?: string;
    href: string;
    icon: React.ReactNode;
    group: "page" | "exam" | "student" | "setting";
    keywords: string;
}

const STATIC_ITEMS: SearchItem[] = [
    { id: "p-dashboard", title: "대시보드", subtitle: "교사 대시보드 홈", href: "/teacher/dashboard", icon: <LayoutDashboard size={16} />, group: "page", keywords: "dashboard teacher home 대시보드" },
    { id: "p-create", title: "시험 출제", subtitle: "새로운 OMR 시험 생성", href: "/create", icon: <PlusCircle size={16} />, group: "page", keywords: "create exam new 출제 생성 시험" },
    { id: "p-live", title: "실시간 결과", subtitle: "진행 중 시험 모니터링", href: "/teacher/live", icon: <Activity size={16} />, group: "page", keywords: "live results monitor 실시간 결과" },
    { id: "p-users", title: "사용자 관리", subtitle: "학생, 반, 초대", href: "/teacher/users", icon: <Users size={16} />, group: "page", keywords: "users students groups invites manage 학생 반 초대 관리" },
    { id: "p-analytics", title: "분석", subtitle: "시험 및 학생 분석", href: "/teacher/dashboard?tab=exam", icon: <BarChart3 size={16} />, group: "page", keywords: "analytics exam student statistics 분석 통계" },
    { id: "p-settings", title: "설정", subtitle: "프로필, 알림, 테마", href: "/teacher/settings", icon: <SettingsIcon size={16} />, group: "page", keywords: "settings profile notifications api theme 설정 프로필 알림 테마" },
    { id: "p-billing", title: "결제 및 플랜", subtitle: "플랜 변경, 결제/플랜 기록", href: "/teacher/billing", icon: <CreditCard size={16} />, group: "page", keywords: "billing plan record 결제 플랜 기록" },
    { id: "s-theme", title: "테마 변경", subtitle: "라이트/다크/자동", href: "/teacher/settings#theme", icon: <SettingsIcon size={16} />, group: "setting", keywords: "theme dark light auto 테마 다크 라이트 자동" },
    { id: "s-api", title: "API 키 관리", subtitle: "Gemini 키", href: "/teacher/settings", icon: <SettingsIcon size={16} />, group: "setting", keywords: "api key gemini 키 제미나이" },
];

const GROUP_LABELS: Record<SearchItem["group"], string> = {
    page: "페이지",
    exam: "시험",
    student: "학생",
    setting: "설정",
};

// The results list renders grouped in this fixed order. The flat `filtered`
// array must follow the same order so keyboard activeIdx / aria-activedescendant
// reference the exact item the highlight shows (settings items are static and
// would otherwise sort before dynamic exam/student results, desyncing the two).
const GROUP_ORDER: SearchItem["group"][] = ["page", "exam", "student", "setting"];
const groupRank = (group: SearchItem["group"]) => GROUP_ORDER.indexOf(group);

export default function GlobalSearch() {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const [activeIdx, setActiveIdx] = useState(0);
    const [dynamic, setDynamic] = useState<SearchItem[]>([]);
    const inputRef = useRef<HTMLInputElement | null>(null);
    const panelRef = useRef<HTMLDivElement | null>(null);
    // Element that held focus before the palette opened, so we can restore it on close.
    const triggerRef = useRef<HTMLElement | null>(null);

    // Keyboard: Cmd+K or Ctrl+K
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
                e.preventDefault();
                setOpen(prev => !prev);
            } else if (e.key === "Escape" && open) {
                setOpen(false);
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [open]);

    useEffect(() => {
        const openSearch = () => setOpen(true);
        window.addEventListener("omr:open-search", openSearch);
        return () => window.removeEventListener("omr:open-search", openSearch);
    }, []);

    // Remember the trigger on open and restore focus to it on close, so keyboard
    // users are not dropped back to the top of the page after the palette closes.
    useEffect(() => {
        if (open) {
            triggerRef.current = (document.activeElement as HTMLElement) ?? null;
        } else if (triggerRef.current) {
            triggerRef.current.focus?.();
            triggerRef.current = null;
        }
    }, [open]);

    // When opening, load dynamic items from localStorage (exams + students)
    useEffect(() => {
        if (!open) return;
        setActiveIdx(0);
        try {
            const items: SearchItem[] = [];
            // Exams
            readLocalExams().slice(0, 50).forEach(ex => {
                items.push({
                    id: `exam-${ex.id}`,
                    title: ex.title,
                    subtitle: `${ex.questions.length}문항 · 시험`,
                    href: `/teacher/dashboard?tab=exam&examId=${encodeURIComponent(ex.id)}`,
                    icon: <FileText size={16} />,
                    group: "exam",
                    keywords: `exam ${ex.title}`,
                });
            });
            // Students
            try {
                readRosterStudents(localStorage).slice(0, 50).forEach(s => {
                    items.push({
                        id: `student-${s.id}`,
                        title: s.name,
                        subtitle: `${s.group} · ${s.email || "이메일 없음"}`,
                        href: `/teacher/users`,
                        icon: <Users size={16} />,
                        group: "student",
                        keywords: `student ${s.name} ${s.email} ${s.group}`,
                    });
                });
            } catch {
                // ignore
            }
            setDynamic(items);
        } catch {
            setDynamic([]);
        }
        setTimeout(() => inputRef.current?.focus(), 50);
    }, [open]);

    const all = useMemo(() => [...STATIC_ITEMS, ...dynamic], [dynamic]);
    const filtered = useMemo(() => {
        const base = !query.trim()
            ? all
            : (() => {
                const q = query.toLowerCase();
                return all.filter(item =>
                    item.title.toLowerCase().includes(q) ||
                    (item.subtitle?.toLowerCase().includes(q) ?? false) ||
                    item.keywords.toLowerCase().includes(q));
            })();
        // Stable sort into the grouped render order so the flat index used by
        // keyboard nav / aria-activedescendant matches the visible highlight.
        return [...base]
            .sort((a, b) => groupRank(a.group) - groupRank(b.group))
            .slice(0, 20);
    }, [query, all]);

    // Group by kind for display
    const grouped = useMemo(() => {
        const by: Record<string, SearchItem[]> = {};
        filtered.forEach(item => {
            if (!by[item.group]) by[item.group] = [];
            by[item.group].push(item);
        });
        return by;
    }, [filtered]);

    // Keep activeIdx in range
    useEffect(() => {
        if (activeIdx >= filtered.length) setActiveIdx(Math.max(0, filtered.length - 1));
    }, [filtered.length, activeIdx]);

    const go = (item: SearchItem) => {
        setOpen(false);
        setQuery("");
        router.push(item.href);
    };

    // Constrain Tab/Shift+Tab to the palette so focus never walks into the
    // obscured page behind the overlay.
    const onPanelKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key !== "Tab") return;
        const panel = panelRef.current;
        if (!panel) return;
        const focusables = Array.from(
            panel.querySelectorAll<HTMLElement>('button, input, [tabindex]:not([tabindex="-1"])')
        ).filter(el => !el.hasAttribute("disabled"));
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey) {
            if (document.activeElement === first) {
                e.preventDefault();
                last.focus();
            }
        } else if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
        }
    };

    const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "ArrowDown") {
            e.preventDefault();
            setActiveIdx(i => Math.min(filtered.length - 1, i + 1));
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActiveIdx(i => Math.max(0, i - 1));
        } else if (e.key === "Enter") {
            e.preventDefault();
            const item = filtered[activeIdx];
            if (item) go(item);
        }
    };

    if (!open) return null;

    let globalIdx = -1;

    return (
        <div
            onClick={() => setOpen(false)}
            style={{
                position: 'fixed', inset: 0, zIndex: 1000,
                background: 'rgba(15, 23, 42, 0.5)', backdropFilter: 'blur(4px)',
                display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
                paddingTop: '15vh', animation: 'fadeIn 0.15s ease-out'
            }}
            role="dialog"
            aria-modal="true"
            aria-label="빠른 검색"
        >
            <div
                ref={panelRef}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={onPanelKeyDown}
                style={{
                    width: '100%', maxWidth: 560, margin: '0 1rem',
                    background: 'var(--surface)', borderRadius: 'var(--radius-xl)',
                    boxShadow: '0 24px 80px rgba(0,0,0,0.3)',
                    border: '1px solid var(--border)', overflow: 'hidden'
                }}
            >
                {/* Search input */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '1rem 1.25rem', borderBottom: '1px solid var(--border)' }}>
                    <Search size={18} color="var(--muted)" />
                    <input
                        ref={inputRef}
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        onKeyDown={onInputKey}
                        placeholder="빠른 검색... (페이지, 시험, 학생, 설정)"
                        aria-label="빠른 검색 입력"
                        role="combobox"
                        aria-expanded={filtered.length > 0}
                        aria-controls="global-search-listbox"
                        aria-activedescendant={filtered[activeIdx] ? `gs-opt-${filtered[activeIdx].id}` : undefined}
                        style={{
                            flex: 1, background: 'transparent', border: 'none', outline: 'none',
                            color: 'var(--foreground)', fontSize: '1rem'
                        }}
                    />
                    <button
                        onClick={() => setOpen(false)}
                        aria-label="검색 닫기"
                        style={{
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            width: 44, height: 44, borderRadius: 8, color: 'var(--muted)', flexShrink: 0
                        }}>
                        <X size={16} />
                    </button>
                </div>

                {/* Results */}
                <div id="global-search-listbox" role="listbox" aria-label="검색 결과" style={{ maxHeight: 400, overflowY: 'auto', padding: '0.5rem' }}>
                    {filtered.length === 0 ? (
                        <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--muted)', fontSize: '0.9rem' }}>
                            결과가 없습니다
                        </div>
                    ) : (
                        (["page", "exam", "student", "setting"] as const).map(groupKey => {
                            const items = grouped[groupKey];
                            if (!items || items.length === 0) return null;
                            return (
                                <div key={groupKey}>
                                    <div style={{
                                        padding: '0.5rem 0.75rem 0.25rem',
                                        fontSize: '0.7rem', fontWeight: 700,
                                        color: 'var(--muted)', letterSpacing: '0.08em',
                                        textTransform: 'uppercase'
                                    }}>
                                        {GROUP_LABELS[groupKey]}
                                    </div>
                                    {items.map(item => {
                                        globalIdx++;
                                        const isActive = globalIdx === activeIdx;
                                        return (
                                            <button
                                                key={item.id}
                                                id={`gs-opt-${item.id}`}
                                                role="option"
                                                aria-selected={isActive}
                                                onMouseEnter={() => setActiveIdx(globalIdx)}
                                                onClick={() => go(item)}
                                                style={{
                                                    width: '100%', display: 'flex', alignItems: 'center', gap: '0.85rem',
                                                    padding: '0.7rem 0.75rem', borderRadius: 'var(--radius-md)',
                                                    background: isActive ? 'rgba(99,102,241,0.08)' : 'transparent',
                                                    textAlign: 'left', cursor: 'pointer',
                                                    color: 'var(--foreground)'
                                                }}
                                            >
                                                <div style={{
                                                    width: 32, height: 32, borderRadius: 8,
                                                    background: isActive ? 'var(--primary)' : 'var(--background)',
                                                    color: isActive ? 'white' : 'var(--muted)',
                                                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                                                    flexShrink: 0, transition: 'var(--transition-base)'
                                                }}>
                                                    {item.icon}
                                                </div>
                                                <div style={{ flex: 1, minWidth: 0 }}>
                                                    <div style={{ fontSize: '0.9rem', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.title}</div>
                                                    {item.subtitle && (
                                                        <div style={{ fontSize: '0.78rem', color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                            {item.subtitle}
                                                        </div>
                                                    )}
                                                </div>
                                                {isActive && <CornerDownLeft size={14} color="var(--primary)" />}
                                            </button>
                                        );
                                    })}
                                </div>
                            );
                        })
                    )}
                </div>

                {/* Footer */}
                <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    padding: '0.6rem 1rem', borderTop: '1px solid var(--border)',
                    fontSize: '0.72rem', color: 'var(--muted)', background: 'var(--background)'
                }}>
                    <div style={{ display: 'flex', gap: '1rem' }}>
                        <span><kbd style={kbdStyle}>↑↓</kbd> 이동</span>
                        <span><kbd style={kbdStyle}>↵</kbd> 선택</span>
                        <span><kbd style={kbdStyle}>Esc</kbd> 닫기</span>
                    </div>
                    <span>OMR Maker Search</span>
                </div>
            </div>
        </div>
    );
}

const kbdStyle: React.CSSProperties = {
    padding: '1px 5px', background: 'var(--surface)', border: '1px solid var(--border)',
    borderRadius: 4, fontFamily: 'var(--font-mono)', fontSize: '0.68rem'
};
