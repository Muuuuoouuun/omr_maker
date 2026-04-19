"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import TeacherHeader from "@/components/TeacherHeader";
import { User, Bell, FileText, CheckCircle, Key, Palette, Shield, Copy, Eye, EyeOff, Save, RotateCcw, Download, Upload } from "lucide-react";
import { toast } from "@/components/Toast";

type Section = "profile" | "notifications" | "exam-defaults" | "grading" | "api" | "theme" | "security";

interface Settings {
    profile: { name: string; email: string; school: string; subject: string; publicProfile: boolean };
    notifications: { email: boolean; push: boolean; weekly: boolean; autoRemind: boolean; quietStart: string; quietEnd: string };
    examDefaults: { questions: number; duration: number; scorePerQ: number; choices: 4 | 5; autosaveSec: number };
    grading: { negative: boolean; partial: boolean; autoRelease: boolean; rounding: "half" | "up" | "down" | "none" };
    api: { geminiKey: string };
    theme: { mode: "light" | "dark" | "auto"; accent: string; density: "comfortable" | "compact"; motion: boolean };
    security: { twoFactor: boolean; loginAlerts: boolean };
}

const DEFAULT_SETTINGS: Settings = {
    profile: { name: "김선생", email: "teacher@school.ac.kr", school: "한빛고등학교", subject: "수학 · 과학", publicProfile: true },
    notifications: { email: true, push: true, weekly: false, autoRemind: true, quietStart: "22:00", quietEnd: "07:00" },
    examDefaults: { questions: 20, duration: 50, scorePerQ: 5, choices: 5, autosaveSec: 30 },
    grading: { negative: false, partial: true, autoRelease: false, rounding: "half" },
    api: { geminiKey: "AIzaSyBbreLmNTPHKOHgS9HuRjAnjg1Zt8lYbjY" },
    theme: { mode: "light", accent: "#4f46e5", density: "comfortable", motion: true },
    security: { twoFactor: false, loginAlerts: true },
};

const STORAGE_KEY = "omr_settings";
const THEME_KEY = "omr_theme";

function mergeSettings(parsed: Partial<Settings> | null | undefined): Settings {
    if (!parsed || typeof parsed !== "object") return DEFAULT_SETTINGS;
    return {
        profile: { ...DEFAULT_SETTINGS.profile, ...(parsed.profile ?? {}) },
        notifications: { ...DEFAULT_SETTINGS.notifications, ...(parsed.notifications ?? {}) },
        examDefaults: { ...DEFAULT_SETTINGS.examDefaults, ...(parsed.examDefaults ?? {}) },
        grading: { ...DEFAULT_SETTINGS.grading, ...(parsed.grading ?? {}) },
        api: { ...DEFAULT_SETTINGS.api, ...(parsed.api ?? {}) },
        theme: { ...DEFAULT_SETTINGS.theme, ...(parsed.theme ?? {}) },
        security: { ...DEFAULT_SETTINGS.security, ...(parsed.security ?? {}) },
    };
}

function loadPersisted(): Settings {
    if (typeof window === "undefined") return DEFAULT_SETTINGS;
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) return DEFAULT_SETTINGS;
        return mergeSettings(JSON.parse(raw) as Partial<Settings>);
    } catch {
        return DEFAULT_SETTINGS;
    }
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

const SECTIONS: { key: Section; label: string; icon: React.ReactNode; color: string }[] = [
    { key: "profile", label: "프로필", icon: <User size={18} />, color: "#4f46e5" },
    { key: "notifications", label: "알림", icon: <Bell size={18} />, color: "#ec4899" },
    { key: "exam-defaults", label: "시험 기본값", icon: <FileText size={18} />, color: "#8b5cf6" },
    { key: "grading", label: "채점", icon: <CheckCircle size={18} />, color: "#10b981" },
    { key: "api", label: "API 키", icon: <Key size={18} />, color: "#f59e0b" },
    { key: "theme", label: "테마", icon: <Palette size={18} />, color: "#0ea5e9" },
    { key: "security", label: "보안", icon: <Shield size={18} />, color: "#ef4444" },
];

export default function SettingsPage() {
    const [section, setSection] = useState<Section>("profile");
    const [showKey, setShowKey] = useState(false);
    // Draft state: edits live here until 저장 commits to localStorage.
    const [draft, setDraft] = useState<Settings>(DEFAULT_SETTINGS);
    // The last persisted settings (what 취소 reverts to, and what 저장 writes).
    const [persisted, setPersisted] = useState<Settings>(DEFAULT_SETTINGS);
    const [hydrated, setHydrated] = useState(false);
    const draftRef = useRef<Settings>(DEFAULT_SETTINGS);
    const persistedRef = useRef<Settings>(DEFAULT_SETTINGS);

    // Keep refs in sync so save/cancel callbacks can read latest values without re-binding.
    useEffect(() => { draftRef.current = draft; }, [draft]);
    useEffect(() => { persistedRef.current = persisted; }, [persisted]);

    // Hydrate from localStorage on mount.
    useEffect(() => {
        const initial = loadPersisted();
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
        if (!window.confirm("모든 설정을 기본값으로 되돌리시겠습니까?")) return;
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
                                    <button onClick={resetAllToDefaults} style={{
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
            <Field label="이메일" hint="로그인 및 알림에 사용됩니다."><input className="input-field" value={value.email} onChange={e => onChange({ email: e.target.value })} /></Field>
            <Field label="소속"><input className="input-field" value={value.school} onChange={e => onChange({ school: e.target.value })} /></Field>
            <Field label="담당 과목"><input className="input-field" value={value.subject} onChange={e => onChange({ subject: e.target.value })} /></Field>

            <Toggle checked={value.publicProfile} onChange={v => onChange({ publicProfile: v })} label="공개 프로필" desc="학생들이 내 이름과 소속을 볼 수 있습니다." />

            <SaveBar onCancel={onCancel} onSave={onSave} />
        </Card>
    );
}

function NotificationsSection({ value, onChange, onSave, onCancel }: SectionProps<Settings["notifications"]>) {
    return (
        <Card title="알림" desc="언제, 어떤 방식으로 알림을 받을지 설정하세요.">
            <Toggle checked={value.email} onChange={v => onChange({ email: v })} label="이메일 알림" desc="학생 제출, 성적 집계, 시스템 공지" />
            <Toggle checked={value.push} onChange={v => onChange({ push: v })} label="브라우저 푸시" desc="실시간 시험 현황 알림" />
            <Toggle checked={value.weekly} onChange={v => onChange({ weekly: v })} label="주간 리포트" desc="매주 월요일 오전 9시, 지난 주 요약" />
            <Toggle checked={value.autoRemind} onChange={v => onChange({ autoRemind: v })} label="미응시 학생 자동 독려" desc="시험 시작 24시간 전 자동 알림 발송" />

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
                        <option value={4}>4지선다</option>
                        <option value={5}>5지선다</option>
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
    const maskedKey = realKey.length > 11
        ? realKey.slice(0, 8) + "•".repeat(Math.max(0, realKey.length - 11)) + realKey.slice(-3)
        : realKey;
    return (
        <Card title="API 키" desc="Gemini 연동을 위한 API 키를 관리하세요.">
            <div style={{ padding: '1rem 1.25rem', background: 'linear-gradient(135deg, rgba(245,158,11,0.06), rgba(239,68,68,0.06))', borderRadius: 'var(--radius-md)', border: '1px solid rgba(245,158,11,0.25)', marginBottom: '1.5rem', display: 'flex', gap: '0.75rem' }}>
                <Shield size={20} color="#f59e0b" style={{ flexShrink: 0, marginTop: 2 }} />
                <div style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>
                    API 키는 브라우저에만 저장되며 서버로 전송되지 않습니다. 키는 다른 기기와 공유되지 않습니다.
                </div>
            </div>

            <Field label="Gemini API Key" hint={<span>키 발급: <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--primary)', fontWeight: 600 }}>aistudio.google.com/apikey</a></span>}>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <input
                        className="input-field"
                        type={showKey ? "text" : "password"}
                        value={showKey ? realKey : maskedKey}
                        onChange={e => showKey && onChange({ geminiKey: e.target.value })}
                        readOnly={!showKey}
                        style={{ fontFamily: 'var(--font-mono)', fontSize: '0.85rem' }}
                    />
                    <button onClick={() => setShowKey(!showKey)} style={{ padding: '0.7rem', border: '1px solid var(--border)', background: 'var(--surface)', borderRadius: 'var(--radius-md)', color: 'var(--muted)' }}>
                        {showKey ? <EyeOff size={18} /> : <Eye size={18} />}
                    </button>
                    <button
                        onClick={() => {
                            if (typeof navigator !== "undefined" && navigator.clipboard) {
                                navigator.clipboard.writeText(realKey).catch(() => { });
                            }
                        }}
                        style={{ padding: '0.7rem', border: '1px solid var(--border)', background: 'var(--surface)', borderRadius: 'var(--radius-md)', color: 'var(--muted)' }}
                    >
                        <Copy size={18} />
                    </button>
                </div>
            </Field>

            <div style={{ padding: '1rem', background: 'var(--background)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                    <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>이달 사용량</span>
                    <span style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--primary)' }}>1,247 / 10,000 req</span>
                </div>
                <div style={{ height: 6, background: 'var(--border)', borderRadius: 'var(--radius-full)', overflow: 'hidden' }}>
                    <div style={{ width: '12.47%', height: '100%', background: 'linear-gradient(90deg, var(--primary), var(--secondary))' }} />
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

function SecuritySection({ value, onChange, onSave, onCancel }: SectionProps<Settings["security"]>) {
    return (
        <Card title="보안" desc="계정 보안을 관리하세요.">
            <Field label="비밀번호 변경">
                <input className="input-field" type="password" placeholder="현재 비밀번호" style={{ marginBottom: '0.5rem' }} />
                <input className="input-field" type="password" placeholder="새 비밀번호" style={{ marginBottom: '0.5rem' }} />
                <input className="input-field" type="password" placeholder="새 비밀번호 확인" />
            </Field>

            <Toggle checked={value.twoFactor} onChange={v => onChange({ twoFactor: v })} label="2단계 인증" desc="로그인 시 앱에서 추가 코드 입력" />
            <Toggle checked={value.loginAlerts} onChange={v => onChange({ loginAlerts: v })} label="로그인 알림" desc="새 기기 로그인 시 이메일 발송" />

            <Field label="활성 세션">
                <div style={{ padding: '0.85rem 1rem', background: 'var(--background)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                        <div style={{ fontSize: '0.9rem', fontWeight: 600 }}>Chrome · macOS</div>
                        <div style={{ fontSize: '0.78rem', color: 'var(--muted)' }}>현재 세션 · 서울</div>
                    </div>
                    <span className="badge badge-success">현재</span>
                </div>
            </Field>
            <SaveBar onCancel={onCancel} onSave={onSave} />
        </Card>
    );
}
