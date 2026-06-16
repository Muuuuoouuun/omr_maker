"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import TeacherHeader from "@/components/TeacherHeader";
import { User, Bell, FileText, CheckCircle, Key, Palette, Shield, Copy, Eye, EyeOff, Save, RotateCcw, Download, Upload, LogOut, Database, RefreshCw, AlertTriangle, CloudOff } from "lucide-react";
import { toast } from "@/components/Toast";
import { SETTINGS_STORAGE_KEY, maskGeminiApiKey } from "@/lib/geminiApiKey";
import { DEFAULT_SETTINGS, mergeSettings, readStoredSettings, type AppSettings } from "@/lib/appSettings";
import { buildDataDbReadiness, type DataDbReadinessSummary, type DataDbReadinessTone } from "@/lib/dataDbReadiness";
import { loadAttempts, loadExams } from "@/lib/omrPersistence";
import { loadRosterSnapshot, readRosterTombstones } from "@/lib/rosterPersistence";
import { PRIMARY_NOTIFICATION_CHANNEL } from "@/lib/serviceRoadmap";
import {
    buildTeacherSessionDisplay,
    clearTeacherSession,
    readTeacherSession,
    type TeacherSessionDisplay,
} from "@/lib/teacherSession";

type Section = "profile" | "notifications" | "exam-defaults" | "grading" | "api" | "theme" | "data" | "security";

const STORAGE_KEY = SETTINGS_STORAGE_KEY;
const THEME_KEY = "omr_theme";
type Settings = AppSettings;

function loadPersisted(): Settings {
    return readStoredSettings();
}

function applyTheme(theme: Settings["theme"]) {
    if (typeof window === "undefined") return;
    const root = document.documentElement;
    let resolved: "light" | "dark" = "light";
    if (theme.mode === "auto") {
        resolved = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    } else {
        resolved = theme.mode;
    }
    root.setAttribute("data-theme", resolved);
    root.setAttribute("data-density", theme.density);
    root.setAttribute("data-motion", theme.motion ? "on" : "off");
    root.style.setProperty("--primary", theme.accent);
    try {
        window.localStorage.setItem(THEME_KEY, theme.mode);
    } catch {
        // ignore
    }
}

function readTeacherSessionDisplay(now = Date.now()): TeacherSessionDisplay {
    if (typeof window === "undefined") {
        return buildTeacherSessionDisplay(null, now);
    }

    const session = readTeacherSession(undefined, now);
    return buildTeacherSessionDisplay(session, now);
}

const SECTIONS: { key: Section; label: string; icon: React.ReactNode; color: string }[] = [
    { key: "profile", label: "프로필", icon: <User size={18} />, color: "#4f46e5" },
    { key: "notifications", label: "알림", icon: <Bell size={18} />, color: "#ec4899" },
    { key: "exam-defaults", label: "시험 기본값", icon: <FileText size={18} />, color: "#8b5cf6" },
    { key: "grading", label: "채점", icon: <CheckCircle size={18} />, color: "#10b981" },
    { key: "api", label: "API 키", icon: <Key size={18} />, color: "#f59e0b" },
    { key: "theme", label: "테마", icon: <Palette size={18} />, color: "#0ea5e9" },
    { key: "data", label: "데이터 · DB", icon: <Database size={18} />, color: "#14b8a6" },
    { key: "security", label: "보안", icon: <Shield size={18} />, color: "#ef4444" },
];

function initialDataDbReadiness(): DataDbReadinessSummary {
    return buildDataDbReadiness({
        syncSources: [],
        examCount: 0,
        attemptCount: 0,
        rosterStudentCount: 0,
        rosterGroupCount: 0,
        tombstones: { students: {}, groups: {} },
    });
}

function ResetSettingsConfirmDialog({
    onCancel,
    onConfirm,
}: {
    onCancel: () => void;
    onConfirm: () => void;
}) {
    return (
        <div
            role="presentation"
            onClick={onCancel}
            style={{
                position: 'fixed',
                inset: 0,
                zIndex: 1200,
                background: 'rgba(15,23,42,0.58)',
                backdropFilter: 'blur(8px)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '1rem',
            }}
        >
            <div
                role="dialog"
                aria-modal="true"
                aria-label="설정 초기화 확인"
                onClick={(e) => e.stopPropagation()}
                style={{
                    width: '100%',
                    maxWidth: 430,
                    background: 'var(--surface)',
                    color: 'var(--foreground)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-lg)',
                    boxShadow: '0 24px 60px rgba(0,0,0,0.28)',
                    padding: '1.5rem',
                }}
            >
                <h2 style={{ fontSize: '1.15rem', fontWeight: 800, marginBottom: '0.65rem' }}>
                    설정 초기화
                </h2>
                <p style={{ color: 'var(--muted)', lineHeight: 1.7, fontSize: '0.95rem', wordBreak: 'keep-all', marginBottom: '1.25rem' }}>
                    프로필, 알림, 시험 기본값, 채점, 테마, 보안 설정을 기본값으로 되돌립니다. API 키도 저장된 기본 상태로 초기화됩니다.
                </p>
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
                    <button
                        type="button"
                        onClick={onCancel}
                        style={{ padding: '0.7rem 1rem', background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', fontWeight: 700, fontSize: '0.9rem' }}
                    >
                        취소
                    </button>
                    <button
                        type="button"
                        onClick={onConfirm}
                        style={{ padding: '0.7rem 1rem', background: 'var(--error)', color: 'white', borderRadius: 'var(--radius-md)', fontWeight: 800, fontSize: '0.9rem' }}
                    >
                        기본값으로 초기화
                    </button>
                </div>
            </div>
        </div>
    );
}

export default function SettingsPage() {
    const [section, setSection] = useState<Section>("profile");
    const [showKey, setShowKey] = useState(false);
    // Draft state: edits live here until 저장 commits to localStorage.
    const [draft, setDraft] = useState<Settings>(DEFAULT_SETTINGS);
    // The last persisted settings (what 취소 reverts to, and what 저장 writes).
    const [persisted, setPersisted] = useState<Settings>(DEFAULT_SETTINGS);
    const [hydrated, setHydrated] = useState(false);
    const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
    const [dataReadiness, setDataReadiness] = useState<DataDbReadinessSummary>(() => initialDataDbReadiness());
    const [isCheckingDataDb, setIsCheckingDataDb] = useState(false);
    const draftRef = useRef<Settings>(DEFAULT_SETTINGS);
    const persistedRef = useRef<Settings>(DEFAULT_SETTINGS);

    // Keep refs in sync so save/cancel callbacks can read latest values without re-binding.
    useEffect(() => { draftRef.current = draft; }, [draft]);
    useEffect(() => { persistedRef.current = persisted; }, [persisted]);

    // Hydrate from localStorage on mount.
    useEffect(() => {
        const initial = loadPersisted();
        // Hydrate client-only persisted settings after mount.
        setDraft(initial);
        setPersisted(initial);
        draftRef.current = initial;
        persistedRef.current = initial;
        setHydrated(true);
    }, []);

    // Apply theme whenever the draft theme changes — so the user sees a live preview.
    useEffect(() => {
        if (!hydrated) return;
        applyTheme(draft.theme);
    }, [hydrated, draft.theme]);

    // Listen for system scheme changes when in "auto" mode.
    useEffect(() => {
        if (!hydrated || draft.theme.mode !== "auto" || typeof window === "undefined") return;
        const mq = window.matchMedia("(prefers-color-scheme: dark)");
        const onChange = () => applyTheme(draft.theme);
        mq.addEventListener("change", onChange);
        return () => mq.removeEventListener("change", onChange);
    }, [hydrated, draft.theme]);

    const updateSection = useCallback(<K extends keyof Settings>(key: K, partial: Partial<Settings[K]>) => {
        setDraft(prev => ({ ...prev, [key]: { ...prev[key], ...partial } }));
    }, []);

    const saveSection = useCallback(<K extends keyof Settings>(key: K) => {
        const next: Settings = { ...persistedRef.current, [key]: draftRef.current[key] };
        persistedRef.current = next;
        setPersisted(next);
        if (typeof window !== "undefined") {
            try {
                window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
            } catch {
                // ignore quota errors
            }
        }
    }, []);

    const cancelSection = useCallback(<K extends keyof Settings>(key: K) => {
        setDraft(prev => ({ ...prev, [key]: persistedRef.current[key] }));
    }, []);

    const importInputRef = useRef<HTMLInputElement | null>(null);

    const resetAllToDefaults = useCallback(() => {
        setDraft(DEFAULT_SETTINGS);
        setPersisted(DEFAULT_SETTINGS);
        draftRef.current = DEFAULT_SETTINGS;
        persistedRef.current = DEFAULT_SETTINGS;
        try {
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify(DEFAULT_SETTINGS));
        } catch {
            // ignore
        }
        applyTheme(DEFAULT_SETTINGS.theme);
        setResetConfirmOpen(false);
        toast.success("초기화 완료", "모든 설정을 기본값으로 되돌렸습니다.");
    }, []);

    const handleExport = useCallback(() => {
        const json = JSON.stringify(persistedRef.current, null, 2);
        const blob = new Blob([json], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `omr-settings-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, []);

    const handleImportFile = useCallback(async (file: File) => {
        try {
            const text = await file.text();
            const parsed = JSON.parse(text) as Partial<Settings>;
            const merged = mergeSettings(parsed);
            setDraft(merged);
            setPersisted(merged);
            draftRef.current = merged;
            persistedRef.current = merged;
            try {
                window.localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
            } catch {
                // ignore quota errors
            }
            applyTheme(merged.theme);
            toast.success("설정 가져오기 완료", "백업 파일을 성공적으로 불러왔습니다.");
        } catch {
            toast.error("가져오기 실패", "JSON 파일 형식을 확인해주세요.");
        }
    }, []);

    const refreshDataDbReadiness = useCallback(async (notify = false) => {
        if (typeof window === "undefined") return;
        setIsCheckingDataDb(true);
        try {
            const [examResult, attemptResult, rosterResult] = await Promise.all([
                loadExams(),
                loadAttempts(),
                loadRosterSnapshot(window.localStorage),
            ]);
            const summary = buildDataDbReadiness({
                syncSources: [
                    { ...examResult, sourceKey: "exams", sourceLabel: "시험" },
                    { ...attemptResult, sourceKey: "attempts", sourceLabel: "제출" },
                    { ...rosterResult, sourceKey: "roster", sourceLabel: "명단" },
                ],
                examCount: examResult.items.length,
                attemptCount: attemptResult.items.length,
                rosterStudentCount: rosterResult.students.length,
                rosterGroupCount: rosterResult.groups.length,
                tombstones: readRosterTombstones(window.localStorage),
            });
            setDataReadiness(summary);
            if (notify) {
                if (summary.persistence.kind === "error") {
                    toast.info("DB 상태 확인 완료", "일부 원격 동기화는 다음 로드에서 다시 시도됩니다.");
                } else {
                    toast.success("DB 상태 확인 완료", summary.detail);
                }
            }
        } catch {
            toast.error("DB 상태 확인 실패", "브라우저 저장소 또는 네트워크 상태를 확인해주세요.");
        } finally {
            setIsCheckingDataDb(false);
        }
    }, []);

    useEffect(() => {
        if (!hydrated || section !== "data") return;
        void refreshDataDbReadiness();
    }, [hydrated, refreshDataDbReadiness, section]);

    return (
        <div className="layout-main">
            <div className="orb orb-primary" />
            <div className="orb orb-accent" />
            <TeacherHeader badge="SETTINGS" badgeColor="#6366f1" />

            <main className="container animate-fade-in" style={{ paddingBottom: '4rem', position: 'relative', zIndex: 1 }}>
                <div style={{ margin: '3rem 0 2rem' }}>
                    <h1 className="title-gradient" style={{ fontSize: '2.5rem', marginBottom: '0.5rem', lineHeight: 1.2 }}>설정</h1>
                    <p className="text-muted" style={{ fontSize: '1.05rem' }}>프로필, 알림, 시험 기본값을 관리하세요.</p>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '240px 1fr', gap: '1.5rem' }} className="settings-grid">
                    {/* Side nav */}
                    <aside className="bento-card" style={{ padding: '0.75rem', alignSelf: 'flex-start', position: 'sticky', top: '5.5rem' }}>
                        {SECTIONS.map(s => (
                            <button
                                key={s.key}
                                onClick={() => setSection(s.key)}
                                style={{
                                    width: '100%', display: 'flex', alignItems: 'center', gap: '0.75rem',
                                    padding: '0.75rem 0.9rem', borderRadius: 'var(--radius-md)',
                                    background: section === s.key ? `color-mix(in srgb, ${s.color}, transparent 88%)` : 'transparent',
                                    color: section === s.key ? s.color : 'var(--muted)',
                                    fontWeight: section === s.key ? 700 : 500,
                                    fontSize: '0.9rem', transition: 'var(--transition-base)', textAlign: 'left'
                                }}
                            >
                                {s.icon}
                                {s.label}
                            </button>
                        ))}
                    </aside>

                    {/* Content */}
                    <section>
                        {section === "profile" && <ProfileSection value={draft.profile} onChange={v => updateSection("profile", v)} onSave={() => saveSection("profile")} onCancel={() => cancelSection("profile")} />}
                        {section === "notifications" && <NotificationsSection value={draft.notifications} onChange={v => updateSection("notifications", v)} onSave={() => saveSection("notifications")} onCancel={() => cancelSection("notifications")} />}
                        {section === "exam-defaults" && <ExamDefaultsSection value={draft.examDefaults} onChange={v => updateSection("examDefaults", v)} onSave={() => saveSection("examDefaults")} onCancel={() => cancelSection("examDefaults")} />}
                        {section === "grading" && <GradingSection value={draft.grading} onChange={v => updateSection("grading", v)} onSave={() => saveSection("grading")} onCancel={() => cancelSection("grading")} />}
                        {section === "api" && <ApiSection value={draft.api} onChange={v => updateSection("api", v)} onSave={() => saveSection("api")} onCancel={() => cancelSection("api")} showKey={showKey} setShowKey={setShowKey} />}
                        {section === "theme" && <ThemeSection value={draft.theme} onChange={v => updateSection("theme", v)} onSave={() => saveSection("theme")} onCancel={() => cancelSection("theme")} />}
                        {section === "data" && <DataDbSection summary={dataReadiness} isChecking={isCheckingDataDb} onRefresh={() => refreshDataDbReadiness(true)} />}
                        {section === "security" && <SecuritySection value={draft.security} onChange={v => updateSection("security", v)} onSave={() => saveSection("security")} onCancel={() => cancelSection("security")} />}

                        {/* Global settings actions */}
                        <div className="bento-card" style={{ padding: '1.5rem', marginTop: '0.25rem', background: 'var(--background)', border: '1px dashed var(--border)' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
                                <div>
                                    <div style={{ fontSize: '0.9rem', fontWeight: 700, marginBottom: '0.25rem' }}>백업 · 복원</div>
                                    <div style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>전체 설정을 JSON으로 내보내거나, 다른 기기에서 불러올 수 있습니다.</div>
                                </div>
                                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                                    <input
                                        ref={importInputRef}
                                        type="file"
                                        accept="application/json,.json"
                                        style={{ display: 'none' }}
                                        onChange={(e) => {
                                            const f = e.target.files?.[0];
                                            if (f) handleImportFile(f);
                                            if (importInputRef.current) importInputRef.current.value = "";
                                        }}
                                    />
                                    <button onClick={handleExport} style={{
                                        padding: '0.55rem 1rem', background: 'var(--surface)', border: '1px solid var(--border)',
                                        borderRadius: 'var(--radius-md)', fontSize: '0.85rem', fontWeight: 600,
                                        display: 'flex', alignItems: 'center', gap: '0.4rem', color: 'var(--foreground)'
                                    }}>
                                        <Download size={14} /> 내보내기
                                    </button>
                                    <button onClick={() => importInputRef.current?.click()} style={{
                                        padding: '0.55rem 1rem', background: 'var(--surface)', border: '1px solid var(--border)',
                                        borderRadius: 'var(--radius-md)', fontSize: '0.85rem', fontWeight: 600,
                                        display: 'flex', alignItems: 'center', gap: '0.4rem', color: 'var(--foreground)'
                                    }}>
                                        <Upload size={14} /> 가져오기
                                    </button>
                                    <button onClick={() => setResetConfirmOpen(true)} style={{
                                        padding: '0.55rem 1rem', background: 'rgba(239,68,68,0.08)', color: '#ef4444',
                                        border: '1px solid rgba(239,68,68,0.25)', borderRadius: 'var(--radius-md)',
                                        fontSize: '0.85rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.4rem'
                                    }}>
                                        <RotateCcw size={14} /> 전체 초기화
                                    </button>
                                </div>
                            </div>
                        </div>
                    </section>
                </div>
            </main>

            <style>{`
                @media (max-width: 768px) {
                    .settings-grid { grid-template-columns: 1fr !important; }
                }
            `}</style>
            {resetConfirmOpen && (
                <ResetSettingsConfirmDialog
                    onCancel={() => setResetConfirmOpen(false)}
                    onConfirm={resetAllToDefaults}
                />
            )}
        </div>
    );
}

function Card({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
    return (
        <div className="bento-card" style={{ padding: '2rem', marginBottom: '1.25rem', animation: 'fadeIn 0.3s both' }}>
            <h2 style={{ fontSize: '1.2rem', fontWeight: 700, marginBottom: desc ? '0.25rem' : '1.5rem' }}>{title}</h2>
            {desc && <p style={{ fontSize: '0.9rem', color: 'var(--muted)', marginBottom: '1.5rem' }}>{desc}</p>}
            {children}
        </div>
    );
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: React.ReactNode }) {
    return (
        <div style={{ marginBottom: '1.25rem' }}>
            <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 700, color: 'var(--foreground)', marginBottom: '0.5rem', letterSpacing: '0.02em' }}>{label}</label>
            {children}
            {hint && <div style={{ fontSize: '0.78rem', color: 'var(--muted)', marginTop: '0.4rem' }}>{hint}</div>}
        </div>
    );
}

function Toggle({ checked, onChange, label, desc }: { checked: boolean; onChange: (v: boolean) => void; label: string; desc?: string }) {
    return (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1rem 0', borderBottom: '1px solid var(--border)' }}>
            <div style={{ flex: 1, paddingRight: '1rem' }}>
                <div style={{ fontSize: '0.95rem', fontWeight: 600 }}>{label}</div>
                {desc && <div style={{ fontSize: '0.82rem', color: 'var(--muted)', marginTop: '0.2rem' }}>{desc}</div>}
            </div>
            <button
                onClick={() => onChange(!checked)}
                style={{
                    width: 44, height: 24, borderRadius: 12, position: 'relative',
                    background: checked ? 'var(--primary)' : 'var(--border)',
                    transition: 'var(--transition-base)', flexShrink: 0
                }}
            >
                <div style={{
                    width: 18, height: 18, borderRadius: '50%', background: 'white',
                    position: 'absolute', top: 3, left: checked ? 23 : 3,
                    transition: 'left 0.2s ease', boxShadow: '0 1px 3px rgba(0,0,0,0.2)'
                }} />
            </button>
        </div>
    );
}

function SaveBar({ onCancel, onSave }: { onCancel: () => void; onSave: () => void }) {
    const [saved, setSaved] = useState(false);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        return () => {
            if (timerRef.current) clearTimeout(timerRef.current);
        };
    }, []);

    const handleSave = () => {
        onSave();
        setSaved(true);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setSaved(false), 1800);
    };

    return (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', marginTop: '1.5rem', paddingTop: '1.5rem', borderTop: '1px solid var(--border)', alignItems: 'center' }}>
            {saved && (
                <span
                    style={{
                        fontSize: '0.85rem',
                        fontWeight: 600,
                        color: 'var(--primary)',
                        marginRight: '0.25rem',
                        opacity: saved ? 1 : 0,
                        transition: 'opacity 0.4s ease',
                    }}
                >
                    저장됨
                </span>
            )}
            <button onClick={onCancel} style={{ padding: '0.7rem 1.4rem', background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', fontWeight: 600, fontSize: '0.9rem' }}>취소</button>
            <button onClick={handleSave} style={{ padding: '0.7rem 1.4rem', background: 'linear-gradient(135deg, var(--primary), var(--primary-dark))', color: 'white', borderRadius: 'var(--radius-md)', fontWeight: 600, fontSize: '0.9rem', display: 'flex', alignItems: 'center', gap: '0.4rem', boxShadow: '0 4px 12px rgba(99,102,241,0.3)' }}>
                <Save size={14} /> 저장
            </button>
        </div>
    );
}

type SectionProps<T> = {
    value: T;
    onChange: (v: Partial<T>) => void;
    onSave: () => void;
    onCancel: () => void;
};

function ProfileSection({ value, onChange, onSave, onCancel }: SectionProps<Settings["profile"]>) {
    return (
        <Card title="프로필" desc="공개적으로 보여질 정보를 관리하세요.">
            <div style={{ display: 'flex', alignItems: 'center', gap: '1.25rem', marginBottom: '1.5rem', padding: '1.25rem', background: 'var(--background)', borderRadius: 'var(--radius-md)' }}>
                <div style={{ width: 72, height: 72, borderRadius: '50%', background: 'linear-gradient(135deg, #4f46e5, #8b5cf6)', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.8rem', fontWeight: 800 }}>{(value.name || "?").slice(0, 1)}</div>
                <div style={{ flex: 1 }}>
                    <div style={{ fontSize: '1.05rem', fontWeight: 700 }}>{value.name}</div>
                    <div style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>{value.email}</div>
                </div>
                <button style={{ padding: '0.6rem 1.1rem', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', fontSize: '0.85rem', fontWeight: 600 }}>이미지 변경</button>
            </div>

            <Field label="이름"><input className="input-field" value={value.name} onChange={e => onChange({ name: e.target.value })} /></Field>
            <Field label="이메일" hint="로그인에 사용됩니다. 카카오 알림 연락처는 학생/초대 관리에서 별도로 연결합니다."><input className="input-field" value={value.email} onChange={e => onChange({ email: e.target.value })} /></Field>
            <Field label="소속"><input className="input-field" value={value.school} onChange={e => onChange({ school: e.target.value })} /></Field>
            <Field label="담당 과목"><input className="input-field" value={value.subject} onChange={e => onChange({ subject: e.target.value })} /></Field>

            <Toggle checked={value.publicProfile} onChange={v => onChange({ publicProfile: v })} label="공개 프로필" desc="학생들이 내 이름과 소속을 볼 수 있습니다." />

            <SaveBar onCancel={onCancel} onSave={onSave} />
        </Card>
    );
}

function NotificationsSection({ value, onChange, onSave, onCancel }: SectionProps<Settings["notifications"]>) {
    return (
        <Card title="알림" desc={`${PRIMARY_NOTIFICATION_CHANNEL.label} 우선 채널을 기준으로 알림 대상을 관리합니다.`}>
            <Toggle checked={value.email} onChange={v => onChange({ email: v })} label="카카오 알림 준비" desc="초대, 미응시 독려, 결과 안내의 1차 발송 채널" />
            <Toggle checked={value.push} onChange={v => onChange({ push: v })} label="브라우저 푸시" desc="실시간 시험 현황 알림" />
            <Toggle checked={value.weekly} onChange={v => onChange({ weekly: v })} label="주간 리포트" desc="매주 월요일 오전 9시, 지난 주 요약" />
            <Toggle checked={value.autoRemind} onChange={v => onChange({ autoRemind: v })} label="미응시 학생 독려 후보" desc="시험 시작 24시간 전 카카오 발송 대상 후보를 표시" />

            <div style={{ marginTop: '1.5rem', padding: '1rem', background: 'rgba(99,102,241,0.05)', borderRadius: 'var(--radius-md)', border: '1px solid rgba(99,102,241,0.15)' }}>
                <div style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--primary)', marginBottom: '0.5rem' }}>알림 정숙 시간</div>
                <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
                    <input type="time" className="input-field" value={value.quietStart} onChange={e => onChange({ quietStart: e.target.value })} style={{ width: 140 }} />
                    <span style={{ color: 'var(--muted)' }}>~</span>
                    <input type="time" className="input-field" value={value.quietEnd} onChange={e => onChange({ quietEnd: e.target.value })} style={{ width: 140 }} />
                </div>
            </div>

            <SaveBar onCancel={onCancel} onSave={onSave} />
        </Card>
    );
}

function ExamDefaultsSection({ value, onChange, onSave, onCancel }: SectionProps<Settings["examDefaults"]>) {
    return (
        <Card title="시험 기본값" desc="새 시험 생성 시 자동으로 적용될 값을 설정하세요.">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                <Field label="기본 문항 수"><input className="input-field" type="number" value={value.questions} onChange={e => onChange({ questions: Number(e.target.value) })} /></Field>
                <Field label="기본 시간 (분)"><input className="input-field" type="number" value={value.duration} onChange={e => onChange({ duration: Number(e.target.value) })} /></Field>
                <Field label="문항당 기본 배점"><input className="input-field" type="number" value={value.scorePerQ} step={0.5} onChange={e => onChange({ scorePerQ: Number(e.target.value) })} /></Field>
                <Field label="선택지 수">
                    <select className="input-field" value={value.choices} onChange={e => onChange({ choices: Number(e.target.value) as 4 | 5 })}>
                        <option value={5}>5지선다</option>
                        <option value={4}>4지선다</option>
                    </select>
                </Field>
            </div>
            <Field label="자동 저장 주기" hint="편집 중 자동으로 저장됩니다.">
                <select className="input-field" value={value.autosaveSec} onChange={e => onChange({ autosaveSec: Number(e.target.value) })}>
                    <option value={10}>10초</option>
                    <option value={30}>30초</option>
                    <option value={60}>1분</option>
                    <option value={0}>수동</option>
                </select>
            </Field>
            <SaveBar onCancel={onCancel} onSave={onSave} />
        </Card>
    );
}

function GradingSection({ value, onChange, onSave, onCancel }: SectionProps<Settings["grading"]>) {
    return (
        <Card title="채점 규칙" desc="점수 계산 방식을 설정하세요.">
            <Toggle checked={value.negative} onChange={v => onChange({ negative: v })} label="오답 감점 허용" desc="오답 시 문항 배점의 일부를 감점합니다." />
            <Toggle checked={value.partial} onChange={v => onChange({ partial: v })} label="부분 점수 허용" desc="서술형 문항에서 부분 점수를 부여합니다." />
            <Toggle checked={value.autoRelease} onChange={v => onChange({ autoRelease: v })} label="제출 즉시 성적 공개" desc="학생에게 제출 직후 점수를 보여줍니다." />

            <Field label="반올림 방식">
                <select className="input-field" value={value.rounding} onChange={e => onChange({ rounding: e.target.value as Settings["grading"]["rounding"] })}>
                    <option value="half">반올림 (소수점 0.5)</option>
                    <option value="up">올림</option>
                    <option value="down">버림</option>
                    <option value="none">그대로 표시</option>
                </select>
            </Field>
            <SaveBar onCancel={onCancel} onSave={onSave} />
        </Card>
    );
}

function ApiSection({ value, onChange, onSave, onCancel, showKey, setShowKey }: SectionProps<Settings["api"]> & { showKey: boolean; setShowKey: (v: boolean) => void }) {
    const realKey = value.geminiKey;
    const maskedKey = maskGeminiApiKey(realKey);
    const hasKey = realKey.trim().length > 0;

    return (
        <Card title="API 키" desc="각 사용자의 Gemini API 키를 이 브라우저에 저장해 AI 정답 인식에 사용합니다.">
            <div style={{ padding: '1rem 1.25rem', background: 'linear-gradient(135deg, rgba(245,158,11,0.06), rgba(239,68,68,0.06))', borderRadius: 'var(--radius-md)', border: '1px solid rgba(245,158,11,0.25)', marginBottom: '1.5rem', display: 'flex', gap: '0.75rem' }}>
                <Shield size={20} color="#f59e0b" style={{ flexShrink: 0, marginTop: 2 }} />
                <div style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>
                    저장된 키는 이 기기의 브라우저 localStorage에만 보관됩니다. AI 정답 인식을 실행할 때만 Gemini 요청에 사용되며, OMR Maker 데이터베이스에는 저장하지 않습니다.
                </div>
            </div>

            <Field
                label="개인 Gemini API Key"
                hint={<span>키 발급: <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--primary)', fontWeight: 600 }}>aistudio.google.com/apikey</a></span>}
            >
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <input
                        className="input-field"
                        type={showKey ? "text" : "password"}
                        value={realKey}
                        onChange={e => onChange({ geminiKey: e.target.value })}
                        placeholder="AIza..."
                        autoComplete="off"
                        spellCheck={false}
                        style={{ fontFamily: 'var(--font-mono)', fontSize: '0.85rem' }}
                    />
                    <button
                        type="button"
                        onClick={() => setShowKey(!showKey)}
                        aria-label={showKey ? "Gemini API 키 숨기기" : "Gemini API 키 보기"}
                        title={showKey ? "키 숨기기" : "키 보기"}
                        style={{ padding: '0.7rem', border: '1px solid var(--border)', background: 'var(--surface)', borderRadius: 'var(--radius-md)', color: 'var(--muted)' }}
                    >
                        {showKey ? <EyeOff size={18} /> : <Eye size={18} />}
                    </button>
                    <button
                        type="button"
                        onClick={() => {
                            if (!realKey) return;
                            if (typeof navigator !== "undefined" && navigator.clipboard) {
                                navigator.clipboard.writeText(realKey).catch(() => { });
                            }
                        }}
                        disabled={!hasKey}
                        aria-label="Gemini API 키 복사"
                        title="키 복사"
                        style={{ padding: '0.7rem', border: '1px solid var(--border)', background: 'var(--surface)', borderRadius: 'var(--radius-md)', color: 'var(--muted)', opacity: hasKey ? 1 : 0.45 }}
                    >
                        <Copy size={18} />
                    </button>
                </div>
                {hasKey && (
                    <div style={{ marginTop: '0.6rem', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                        <span style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--success)', background: 'rgba(16,185,129,0.1)', padding: '0.25rem 0.55rem', borderRadius: 'var(--radius-full)' }}>
                            개인 키 저장 준비됨
                        </span>
                        <span style={{ fontSize: '0.78rem', color: 'var(--muted)', fontFamily: 'var(--font-mono)' }}>
                            {maskedKey}
                        </span>
                        <button
                            type="button"
                            onClick={() => onChange({ geminiKey: "" })}
                            style={{ fontSize: '0.78rem', color: 'var(--error)', fontWeight: 700 }}
                        >
                            키 지우기
                        </button>
                    </div>
                )}
            </Field>

            <div style={{ padding: '1rem', background: 'var(--background)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)' }}>
                <div style={{ fontSize: '0.85rem', fontWeight: 700, marginBottom: '0.35rem' }}>적용 위치</div>
                <div style={{ fontSize: '0.82rem', color: 'var(--muted)', lineHeight: 1.6 }}>
                    시험 출제 화면의 답지 업로드 모달에서 <strong style={{ color: 'var(--foreground)' }}>AI(Gemini) 정답 인식</strong>을 켜면 이 키를 우선 사용합니다. 키가 비어 있으면 서버 기본 키를 사용합니다.
                </div>
            </div>

            <SaveBar onCancel={onCancel} onSave={onSave} />
        </Card>
    );
}

function ThemeSection({ value, onChange, onSave, onCancel }: SectionProps<Settings["theme"]>) {
    const modes: { key: Settings["theme"]["mode"]; label: string; preview: string }[] = [
        { key: "light", label: "라이트", preview: "linear-gradient(135deg, #f8fafc, #e2e8f0)" },
        { key: "dark", label: "다크", preview: "linear-gradient(135deg, #1e293b, #0f172a)" },
        { key: "auto", label: "시스템 설정", preview: "linear-gradient(135deg, #f8fafc 50%, #1e293b 50%)" },
    ];
    const accents = ["#4f46e5", "#ec4899", "#8b5cf6", "#10b981", "#f59e0b", "#ef4444"];
    return (
        <Card title="테마" desc="화면 모습을 내 스타일대로 꾸며보세요.">
            <Field label="색상 모드">
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.75rem' }}>
                    {modes.map(t => (
                        <button key={t.key} onClick={() => onChange({ mode: t.key })} style={{
                            padding: '1rem', borderRadius: 'var(--radius-md)',
                            border: value.mode === t.key ? '2px solid var(--primary)' : '1px solid var(--border)',
                            background: 'var(--surface)', cursor: 'pointer', textAlign: 'left'
                        }}>
                            <div style={{ height: 60, borderRadius: 'var(--radius-sm)', background: t.preview, marginBottom: '0.6rem', border: '1px solid var(--border)' }} />
                            <div style={{ fontSize: '0.9rem', fontWeight: 600 }}>{t.label}</div>
                        </button>
                    ))}
                </div>
            </Field>

            <Field label="액센트 색상">
                <div style={{ display: 'flex', gap: '0.75rem' }}>
                    {accents.map(c => {
                        const selected = value.accent === c;
                        return (
                            <button key={c} onClick={() => onChange({ accent: c })} style={{
                                width: 36, height: 36, borderRadius: '50%', background: c,
                                border: selected ? '3px solid var(--foreground)' : '3px solid transparent',
                                boxShadow: selected ? `0 0 0 2px ${c}` : 'none'
                            }} />
                        );
                    })}
                </div>
            </Field>

            <Field label="밀도">
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                    {(["comfortable", "compact"] as const).map(d => (
                        <button key={d} onClick={() => onChange({ density: d })} style={{
                            flex: 1, padding: '0.7rem', borderRadius: 'var(--radius-md)',
                            border: value.density === d ? '2px solid var(--primary)' : '1px solid var(--border)',
                            background: value.density === d ? 'rgba(99,102,241,0.05)' : 'var(--surface)',
                            fontWeight: 600, fontSize: '0.85rem', color: value.density === d ? 'var(--primary)' : 'var(--foreground)'
                        }}>
                            {d === "comfortable" ? "편안하게" : "촘촘하게"}
                        </button>
                    ))}
                </div>
            </Field>

            <Toggle checked={value.motion} onChange={v => onChange({ motion: v })} label="모션 효과" desc="카드 호버, 애니메이션 사용" />

            <SaveBar onCancel={onCancel} onSave={onSave} />
        </Card>
    );
}

function dataToneStyle(tone: DataDbReadinessTone): { color: string; background: string; border: string; icon: React.ReactNode } {
    if (tone === "ready") {
        return {
            color: 'var(--success)',
            background: 'rgba(16,185,129,0.1)',
            border: 'rgba(16,185,129,0.22)',
            icon: <CheckCircle size={15} />,
        };
    }
    if (tone === "warning") {
        return {
            color: 'var(--warning)',
            background: 'rgba(245,158,11,0.1)',
            border: 'rgba(245,158,11,0.24)',
            icon: <AlertTriangle size={15} />,
        };
    }
    if (tone === "error") {
        return {
            color: 'var(--error)',
            background: 'rgba(239,68,68,0.1)',
            border: 'rgba(239,68,68,0.24)',
            icon: <AlertTriangle size={15} />,
        };
    }
    return {
        color: 'var(--muted)',
        background: 'rgba(100,116,139,0.1)',
        border: 'rgba(100,116,139,0.22)',
        icon: <CloudOff size={15} />,
    };
}

function DataDbSection({
    summary,
    isChecking,
    onRefresh,
}: {
    summary: DataDbReadinessSummary;
    isChecking: boolean;
    onRefresh: () => void;
}) {
    const mainTone = dataToneStyle(
        summary.persistence.kind === "error"
            ? "error"
            : summary.persistence.kind === "pending"
                ? "warning"
                : summary.persistence.kind === "synced"
                    ? "ready"
                    : "neutral",
    );

    return (
        <Card title="데이터 · DB" desc="시험, 제출, 명단, 삭제 보관 표시가 저장소와 맞는지 확인합니다.">
            <div style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: '1rem',
                alignItems: 'flex-start',
                flexWrap: 'wrap',
                padding: '1rem 1.1rem',
                borderRadius: 'var(--radius-lg)',
                border: `1px solid ${mainTone.border}`,
                background: mainTone.background,
                marginBottom: '1.25rem',
            }}>
                <div style={{ minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: mainTone.color, fontWeight: 900, marginBottom: '0.3rem' }}>
                        <Database size={18} />
                        {summary.label}
                    </div>
                    <p style={{ color: 'var(--muted)', fontSize: '0.86rem', lineHeight: 1.65, wordBreak: 'keep-all' }}>
                        {summary.detail}
                    </p>
                    {summary.persistence.pendingCount > 0 && (
                        <div style={{ marginTop: '0.45rem', color: 'var(--warning)', fontSize: '0.78rem', fontWeight: 800 }}>
                            재시도 대기 {summary.persistence.pendingCount}건
                        </div>
                    )}
                </div>
                <button
                    type="button"
                    onClick={onRefresh}
                    disabled={isChecking}
                    aria-label="데이터 DB 상태 새로고침"
                    style={{
                        padding: '0.58rem 0.9rem',
                        borderRadius: 'var(--radius-md)',
                        border: '1px solid var(--border)',
                        background: 'var(--surface)',
                        color: 'var(--foreground)',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.42rem',
                        fontSize: '0.82rem',
                        fontWeight: 850,
                        cursor: isChecking ? 'wait' : 'pointer',
                        whiteSpace: 'nowrap',
                    }}
                >
                    <RefreshCw size={14} className={isChecking ? "animate-spin" : undefined} />
                    상태 확인
                </button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '0.75rem', marginBottom: '1.25rem' }}>
                {summary.metrics.map(metric => (
                    <div
                        key={metric.key}
                        style={{
                            padding: '0.95rem',
                            borderRadius: 'var(--radius-md)',
                            border: '1px solid var(--border)',
                            background: 'var(--background)',
                        }}
                    >
                        <div style={{ fontSize: '0.76rem', color: 'var(--muted)', fontWeight: 800, marginBottom: '0.4rem' }}>
                            {metric.label}
                        </div>
                        <div style={{ fontSize: '1.45rem', fontWeight: 950, color: 'var(--foreground)', lineHeight: 1 }}>
                            {metric.value}
                        </div>
                        <div style={{ marginTop: '0.42rem', fontSize: '0.75rem', color: 'var(--muted)' }}>
                            {metric.detail}
                        </div>
                    </div>
                ))}
            </div>

            {summary.syncSources.length > 0 && (
                <div style={{ marginBottom: '1.25rem' }}>
                    <div style={{ fontSize: '0.82rem', color: 'var(--foreground)', fontWeight: 900, marginBottom: '0.55rem' }}>
                        원격 동기화 세부 상태
                    </div>
                    <div style={{ display: 'grid', gap: '0.55rem' }}>
                        {summary.syncSources.map(source => {
                            const tone = dataToneStyle(source.tone);
                            return (
                                <div
                                    key={source.key}
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'space-between',
                                        gap: '0.75rem',
                                        padding: '0.72rem 0.85rem',
                                        borderRadius: 'var(--radius-md)',
                                        border: `1px solid ${tone.border}`,
                                        background: tone.background,
                                    }}
                                >
                                    <span style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', minWidth: 0 }}>
                                        <span style={{ color: tone.color, flexShrink: 0 }}>{tone.icon}</span>
                                        <span style={{ minWidth: 0 }}>
                                            <span style={{ display: 'block', color: tone.color, fontSize: '0.8rem', fontWeight: 900 }}>
                                                {source.label}
                                            </span>
                                            <span style={{ display: 'block', color: 'var(--muted)', fontSize: '0.74rem', lineHeight: 1.45, wordBreak: 'keep-all' }}>
                                                {source.detail}
                                            </span>
                                        </span>
                                    </span>
                                    <span style={{
                                        flexShrink: 0,
                                        color: tone.color,
                                        border: `1px solid ${tone.border}`,
                                        borderRadius: 'var(--radius-full)',
                                        padding: '0.18rem 0.5rem',
                                        fontSize: '0.68rem',
                                        fontWeight: 950,
                                        whiteSpace: 'nowrap',
                                    }}>
                                        {source.pendingCount > 0 ? `${source.pendingCount}건 대기` : source.remoteLoaded ? "원격" : "로컬"}
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                </div>
            )}

            <div style={{ display: 'grid', gap: '0.65rem' }}>
                {summary.checks.map(check => {
                    const tone = dataToneStyle(check.tone);
                    return (
                        <div
                            key={check.key}
                            style={{
                                display: 'flex',
                                alignItems: 'flex-start',
                                gap: '0.7rem',
                                padding: '0.85rem 0.95rem',
                                borderRadius: 'var(--radius-md)',
                                border: `1px solid ${tone.border}`,
                                background: tone.background,
                            }}
                        >
                            <span style={{ color: tone.color, flexShrink: 0, marginTop: 1 }}>
                                {tone.icon}
                            </span>
                            <span style={{ minWidth: 0 }}>
                                <span style={{ display: 'block', color: tone.color, fontSize: '0.84rem', fontWeight: 900, marginBottom: '0.2rem' }}>
                                    {check.label}
                                </span>
                                <span style={{ display: 'block', color: 'var(--muted)', fontSize: '0.78rem', lineHeight: 1.55, wordBreak: 'keep-all' }}>
                                    {check.detail}
                                </span>
                            </span>
                        </div>
                    );
                })}
            </div>
        </Card>
    );
}

function SecuritySection({ value, onChange, onSave, onCancel }: SectionProps<Settings["security"]>) {
    const [sessionDisplay, setSessionDisplay] = useState<TeacherSessionDisplay>(() => buildTeacherSessionDisplay(null));

    useEffect(() => {
        const updateSessionDisplay = () => setSessionDisplay(readTeacherSessionDisplay());
        const initialTimer = window.setTimeout(updateSessionDisplay, 0);
        const interval = window.setInterval(updateSessionDisplay, 60 * 1000);
        return () => {
            window.clearTimeout(initialTimer);
            window.clearInterval(interval);
        };
    }, []);

    const handleEndCurrentSession = () => {
        clearTeacherSession();
        toast.success("세션 종료됨", "교사 세션을 종료했습니다. 다시 로그인해주세요.");
        window.location.href = "/?role=teacher";
    };

    return (
        <Card title="보안" desc="계정 보안을 관리하세요.">
            <Field label="교사 비밀번호">
                <div style={{
                    padding: '0.9rem 1rem',
                    background: 'var(--background)',
                    borderRadius: 'var(--radius-md)',
                    border: '1px solid var(--border)',
                    display: 'grid',
                    gap: '0.45rem',
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', color: 'var(--foreground)', fontSize: '0.9rem', fontWeight: 800 }}>
                        <Shield size={15} color="var(--primary)" />
                        서버 인증으로 관리됨
                    </div>
                    <p style={{ color: 'var(--muted)', fontSize: '0.82rem', lineHeight: 1.65, wordBreak: 'keep-all' }}>
                        교사 비밀번호는 브라우저 설정에 저장하지 않습니다. 운영 환경에서는 서버 환경변수 <code style={{ fontWeight: 800 }}>TEACHER_PASSWORD</code>를 변경한 뒤 다시 배포해 교체하세요.
                    </p>
                </div>
            </Field>

            <Toggle checked={value.twoFactor} onChange={v => onChange({ twoFactor: v })} label="2단계 인증" desc="로그인 시 앱에서 추가 코드 입력" />
            <Toggle checked={value.loginAlerts} onChange={v => onChange({ loginAlerts: v })} label="로그인 알림" desc="새 기기 로그인 시 알림 후보 기록" />

            <Field label="활성 세션">
                <div style={{ padding: '0.85rem 1rem', background: 'var(--background)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                        <div style={{ fontSize: '0.9rem', fontWeight: 800, display: 'flex', alignItems: 'center', gap: '0.45rem', flexWrap: 'wrap' }}>
                            <span>현재 브라우저</span>
                            <span style={{
                                color: sessionDisplay.isExpired ? 'var(--error)' : 'var(--success)',
                                background: sessionDisplay.isExpired ? 'rgba(239,68,68,0.08)' : 'rgba(16,185,129,0.1)',
                                border: `1px solid ${sessionDisplay.isExpired ? 'rgba(239,68,68,0.2)' : 'rgba(16,185,129,0.2)'}`,
                                borderRadius: 'var(--radius-full)',
                                padding: '0.16rem 0.5rem',
                                fontSize: '0.72rem',
                                fontWeight: 900,
                            }}>
                                {sessionDisplay.label}
                            </span>
                        </div>
                        <div style={{ fontSize: '0.78rem', color: 'var(--muted)', marginTop: '0.22rem' }}>
                            {sessionDisplay.detail}
                        </div>
                    </div>
                    <button
                        type="button"
                        onClick={handleEndCurrentSession}
                        style={{
                            padding: '0.45rem 0.75rem',
                            borderRadius: 'var(--radius-md)',
                            background: 'rgba(239,68,68,0.08)',
                            color: 'var(--error)',
                            border: '1px solid rgba(239,68,68,0.2)',
                            fontSize: '0.78rem',
                            fontWeight: 800,
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.35rem',
                            whiteSpace: 'nowrap',
                        }}
                    >
                        <LogOut size={13} />
                        세션 종료
                    </button>
                </div>
            </Field>
            <SaveBar onCancel={onCancel} onSave={onSave} />
        </Card>
    );
}
