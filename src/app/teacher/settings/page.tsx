"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import TeacherHeader from "@/components/TeacherHeader";
import { User, Bell, FileText, CheckCircle, Key, Palette, Shield, Copy, Eye, EyeOff, Save, RotateCcw, Download, Upload, LogOut, Database, RefreshCw, AlertTriangle, CloudOff } from "lucide-react";
import { toast } from "@/components/Toast";
import { clearTeacherAuthSession, getTeacherDeploymentReadiness } from "@/app/actions/auth";
import { SETTINGS_STORAGE_KEY, maskGeminiApiKey } from "@/lib/geminiApiKey";
import { DEFAULT_SETTINGS, mergeSettings, readStoredSettings, type AppSettings } from "@/lib/appSettings";
import { buildDataDbReadiness, type DataDbReadinessSummary, type DataDbReadinessTone } from "@/lib/dataDbReadiness";
import type { DeploymentReadinessSummary, DeploymentReadinessTone } from "@/lib/deploymentReadiness";
import { loadTeacherAttempts } from "@/lib/teacherAttemptClient";
import { loadTeacherExams } from "@/lib/teacherExamClient";
import { readRosterTombstones } from "@/lib/rosterPersistence";
import { loadTeacherRosterSnapshot } from "@/lib/teacherRosterClient";
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

const ACCENT_PALETTES: Record<string, { light: string; dark: string }> = {
    "#4f46e5": { light: "#818cf8", dark: "#3730a3" },
    "#ec4899": { light: "#f472b6", dark: "#be185d" },
    "#8b5cf6": { light: "#a78bfa", dark: "#6d28d9" },
    "#10b981": { light: "#34d399", dark: "#047857" },
    "#f59e0b": { light: "#fbbf24", dark: "#b45309" },
    "#ef4444": { light: "#f87171", dark: "#b91c1c" },
};

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
    const accentPalette = ACCENT_PALETTES[theme.accent] || ACCENT_PALETTES[DEFAULT_SETTINGS.theme.accent];
    root.style.setProperty("--primary-light", accentPalette.light);
    root.style.setProperty("--primary-dark", accentPalette.dark);
}

function persistThemeMode(theme: Settings["theme"]) {
    if (typeof window === "undefined") return;
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

const SECURITY_POSTURE_ITEMS = [
    {
        key: "credential-source",
        label: "교사 계정 원천",
        detail: "현재 교사 계정은 서버 환경변수에서만 읽고 브라우저 설정에는 저장하지 않습니다.",
        tone: "ready",
    },
    {
        key: "server-session",
        label: "서버 세션 쿠키",
        detail: "/teacher와 /create는 HttpOnly 서명 쿠키가 없으면 서버에서 먼저 차단합니다.",
        tone: "ready",
    },
    {
        key: "login-throttle",
        label: "로그인 시도 제한",
        detail: "동일 식별자와 클라이언트의 반복 실패는 5회 이후 10분 동안 제한됩니다.",
        tone: "ready",
    },
    {
        key: "server-workspace-bootstrap",
        label: "서버 워크스페이스 준비",
        detail: "SUPABASE_SERVICE_ROLE_KEY가 서버에 있으면 로그인과 교사 화면 진입 때 조직·멤버·교사 프로필을 서버에서 준비합니다.",
        tone: "ready",
    },
    {
        key: "supabase-auth",
        label: "운영 전환 대기",
        detail: "실사용 전에는 Supabase Auth, 조직 멤버십, production-rls.sql 정책으로 계정 권한을 이관해야 합니다.",
        tone: "warning",
    },
] as const;

const SECURITY_INTEGRATION_ITEMS = [
    {
        key: "two-factor",
        label: "2단계 인증",
        detail: "현재 미지원입니다. Supabase Auth 또는 별도 OTP provider 연동 후 실제 로그인 단계에 적용됩니다.",
    },
    {
        key: "login-alerts",
        label: "새 기기 로그인 알림",
        detail: "현재 미지원입니다. 기기 식별과 카카오·푸시 알림 provider가 연결된 뒤 제공됩니다.",
    },
] as const;

type CapabilityStatusItem = {
    key: string;
    label: string;
    detail: string;
    tone: "ready" | "warning";
    statusLabel: string;
};

const NOTIFICATION_STATUS_ITEMS: readonly CapabilityStatusItem[] = [
    {
        key: "candidate-queue",
        label: "앱 내 카카오 발송 후보",
        detail: "미응시·재시험 후보를 실제 시험과 학생 명단으로 계산해 알림 센터와 분석 화면에 표시합니다.",
        tone: "ready",
        statusLabel: "후보 계산 사용 중",
    },
    {
        key: "kakao-delivery",
        label: "카카오 실제 발송",
        detail: "현재는 후보 검토와 대기 기록까지만 지원합니다. 카카오 메시지 provider가 연결되기 전에는 실제 메시지를 보내지 않습니다.",
        tone: "warning",
        statusLabel: "연동 전",
    },
    {
        key: "browser-push",
        label: "브라우저 푸시",
        detail: "푸시 구독과 서비스 워커 발송 서버가 연결되지 않아 아직 사용할 수 없습니다.",
        tone: "warning",
        statusLabel: "미지원",
    },
    {
        key: "scheduled-notifications",
        label: "주간 자동 리포트·정숙 시간",
        detail: "예약 작업과 발송 provider가 연결된 뒤 제공됩니다. 현재 저장된 이전 설정은 실제 발송 일정에 영향을 주지 않습니다.",
        tone: "warning",
        statusLabel: "미지원",
    },
] as const;

const PROFILE_STATUS_ITEMS: readonly CapabilityStatusItem[] = [
    {
        key: "server-account",
        label: "로그인 계정과 권한",
        detail: "교사 로그인 ID와 접근 권한은 브라우저 설정이 아니라 서버 계정과 서명 세션에서 관리합니다.",
        tone: "ready",
        statusLabel: "서버 관리",
    },
    {
        key: "teacher-profile",
        label: "이름·소속·담당 과목",
        detail: "현재는 교사 프로필 DB가 연결되지 않아 이 브라우저에서 변경해도 다른 화면이나 학생 화면에 반영되지 않습니다.",
        tone: "warning",
        statusLabel: "편집 미지원",
    },
    {
        key: "profile-visibility",
        label: "프로필 이미지·공개 범위",
        detail: "이미지 저장소와 학생 공개 프로필 정책이 연결된 뒤 제공됩니다.",
        tone: "warning",
        statusLabel: "연동 전",
    },
] as const;

const GRADING_STATUS_ITEMS: readonly CapabilityStatusItem[] = [
    {
        key: "multiple-choice-grading",
        label: "객관식 자동 채점",
        detail: "서버 시험은 정답을 학생 브라우저에 노출하지 않고 제출 후 서버에서 채점합니다. 로컬 시험은 기기 안에서 동일 규칙으로 채점합니다.",
        tone: "ready",
        statusLabel: "사용 중",
    },
    {
        key: "question-score-sum",
        label: "문항별 배점 합산",
        detail: "정답으로 판정된 문항의 배점을 합산하고 오답과 미응답은 0점으로 처리합니다.",
        tone: "ready",
        statusLabel: "사용 중",
    },
    {
        key: "negative-partial-score",
        label: "오답 감점·부분 점수",
        detail: "현재 채점 모델에는 감점과 서술형 부분 점수 규칙이 없습니다. 시험별 채점 정책이 연결되기 전에는 변경할 수 없습니다.",
        tone: "warning",
        statusLabel: "미지원",
    },
    {
        key: "release-rounding",
        label: "성적 공개 시점·반올림 규칙",
        detail: "현재는 제출 후 결과를 바로 보여주며 계산된 점수를 그대로 표시합니다. 공개 예약과 별도 반올림 정책은 아직 지원하지 않습니다.",
        tone: "warning",
        statusLabel: "고정 동작",
    },
] as const;

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

function initialDeploymentReadiness(): DeploymentReadinessSummary {
    return {
        label: "배포 진단 대기",
        detail: "보안 탭을 열면 현재 서버 환경변수 기준으로 교사 로그인과 Supabase 준비 상태를 확인합니다.",
        credentialCount: 0,
        readyCount: 0,
        totalCount: 0,
        checks: [],
    };
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
                    시험 기본값, 테마, API 키를 포함해 이 브라우저에 저장된 설정을 기본 상태로 되돌립니다.
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
    const [deploymentReadiness, setDeploymentReadiness] = useState<DeploymentReadinessSummary>(() => initialDeploymentReadiness());
    const [isCheckingDeployment, setIsCheckingDeployment] = useState(false);
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
                if (key === "theme") persistThemeMode(next.theme);
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
        persistThemeMode(DEFAULT_SETTINGS.theme);
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
            persistThemeMode(merged.theme);
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
                loadTeacherExams(),
                loadTeacherAttempts(),
                loadTeacherRosterSnapshot(window.localStorage),
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

    const refreshDeploymentReadiness = useCallback(async (notify = false) => {
        setIsCheckingDeployment(true);
        try {
            const summary = await getTeacherDeploymentReadiness();
            setDeploymentReadiness(summary);
            if (notify) {
                const hasError = summary.checks.some(check => check.tone === "error");
                if (hasError) {
                    toast.info("배포 진단 완료", "교사 계정 또는 세션 환경변수를 확인해야 합니다.");
                } else {
                    toast.success("배포 진단 완료", summary.detail);
                }
            }
        } catch {
            toast.error("배포 진단 실패", "서버 환경변수 상태를 불러오지 못했습니다.");
        } finally {
            setIsCheckingDeployment(false);
        }
    }, []);

    useEffect(() => {
        if (!hydrated || section !== "security") return;
        void refreshDeploymentReadiness();
    }, [hydrated, refreshDeploymentReadiness, section]);

    return (
        <div className="layout-main">
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
                        {section === "profile" && <ProfileSection />}
                        {section === "notifications" && <NotificationsSection />}
                        {section === "exam-defaults" && <ExamDefaultsSection value={draft.examDefaults} onChange={v => updateSection("examDefaults", v)} onSave={() => saveSection("examDefaults")} onCancel={() => cancelSection("examDefaults")} />}
                        {section === "grading" && <GradingSection />}
                        {section === "api" && <ApiSection value={draft.api} onChange={v => updateSection("api", v)} onSave={() => saveSection("api")} onCancel={() => cancelSection("api")} showKey={showKey} setShowKey={setShowKey} />}
                        {section === "theme" && <ThemeSection value={draft.theme} onChange={v => updateSection("theme", v)} onSave={() => saveSection("theme")} onCancel={() => cancelSection("theme")} />}
                        {section === "data" && <DataDbSection summary={dataReadiness} isChecking={isCheckingDataDb} onRefresh={() => refreshDataDbReadiness(true)} />}
                        {section === "security" && (
                            <SecuritySection
                                deploymentReadiness={deploymentReadiness}
                                isCheckingDeployment={isCheckingDeployment}
                                onRefreshDeployment={() => refreshDeploymentReadiness(true)}
                            />
                        )}

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
                    .settings-grid { grid-template-columns: minmax(0, 1fr) !important; }
                    .settings-grid > * { min-width: 0; }
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
                type="button"
                role="switch"
                aria-checked={checked}
                aria-label={label}
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

function ProfileSection() {
    return (
        <Card title="프로필 상태" desc="서버 계정과 공개 프로필 기능의 현재 연결 상태를 보여줍니다.">
            <CapabilityStatusList items={PROFILE_STATUS_ITEMS} />
            <p style={{ marginTop: '1rem', color: 'var(--muted)', fontSize: '0.78rem', lineHeight: 1.6, wordBreak: 'keep-all' }}>
                실제 교사 계정 정보는 보안 탭의 배포 로그인 진단에서 확인할 수 있습니다. 작동하지 않는 로컬 프로필 편집은 제공하지 않습니다.
            </p>
        </Card>
    );
}

function CapabilityStatusList({ items }: { items: readonly CapabilityStatusItem[] }) {
    return (
        <div style={{ display: 'grid', gap: '0.65rem' }}>
            {items.map(item => {
                const ready = item.tone === "ready";
                const color = ready ? "var(--success)" : "var(--warning)";
                const border = ready ? "rgba(16,185,129,0.24)" : "rgba(245,158,11,0.24)";
                const background = ready ? "rgba(16,185,129,0.07)" : "rgba(245,158,11,0.08)";
                return (
                    <div
                        key={item.key}
                        style={{
                            display: 'flex', alignItems: 'flex-start', gap: '0.7rem',
                            padding: '0.9rem 0.95rem', borderRadius: 'var(--radius-md)',
                            border: `1px solid ${border}`, background,
                        }}
                    >
                        {ready
                            ? <CheckCircle size={16} color={color} style={{ flexShrink: 0, marginTop: 2 }} />
                            : <AlertTriangle size={16} color={color} style={{ flexShrink: 0, marginTop: 2 }} />}
                        <span style={{ minWidth: 0 }}>
                            <span style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', flexWrap: 'wrap', marginBottom: '0.2rem' }}>
                                <strong style={{ fontSize: '0.86rem' }}>{item.label}</strong>
                                <span style={{ padding: '0.13rem 0.42rem', borderRadius: 'var(--radius-full)', color, background, fontSize: 'var(--type-micro)', fontWeight: 900 }}>
                                    {item.statusLabel}
                                </span>
                            </span>
                            <span style={{ display: 'block', color: 'var(--muted)', fontSize: '0.78rem', lineHeight: 1.55, wordBreak: 'keep-all' }}>
                                {item.detail}
                            </span>
                        </span>
                    </div>
                );
            })}
        </div>
    );
}

function NotificationsSection() {
    return (
        <Card title="알림 상태" desc={`${PRIMARY_NOTIFICATION_CHANNEL.label} 후보 계산과 실제 발송 연동 상태를 구분해 보여줍니다.`}>
            <CapabilityStatusList items={NOTIFICATION_STATUS_ITEMS} />
            <p style={{ marginTop: '1rem', color: 'var(--muted)', fontSize: '0.78rem', lineHeight: 1.6, wordBreak: 'keep-all' }}>
                이 화면은 현재 기능 상태를 안내합니다. 발송 provider가 연결되기 전에는 실제 전송 설정을 활성화할 수 없습니다.
            </p>
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

function GradingSection() {
    return (
        <Card title="채점 방식" desc="현재 점수 계산 규칙과 아직 지원하지 않는 정책을 구분해 보여줍니다.">
            <CapabilityStatusList items={GRADING_STATUS_ITEMS} />
            <p style={{ marginTop: '1rem', color: 'var(--muted)', fontSize: '0.78rem', lineHeight: 1.6, wordBreak: 'keep-all' }}>
                채점 기준은 시험별 문항 정답과 배점에서 결정됩니다. 이 화면에서 저장하더라도 실제 점수 계산이 바뀌지 않는 항목은 제공하지 않습니다.
            </p>
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

const ACCENT_COLOR_LABELS: Record<string, string> = {
    "#4f46e5": "인디고",
    "#ec4899": "핑크",
    "#8b5cf6": "바이올렛",
    "#10b981": "그린",
    "#f59e0b": "앰버",
    "#ef4444": "레드",
};

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
                        const colorName = ACCENT_COLOR_LABELS[c] || c;
                        return (
                            <button
                                key={c}
                                type="button"
                                onClick={() => onChange({ accent: c })}
                                aria-label={`액센트 색상 ${colorName}${selected ? " (선택됨)" : ""}`}
                                aria-pressed={selected}
                                style={{
                                    width: 44, height: 44, borderRadius: '50%',
                                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                                    background: 'transparent',
                                }}
                            >
                                <span aria-hidden="true" style={{
                                    width: 32, height: 32, borderRadius: '50%', background: c, display: 'block',
                                    border: selected ? '3px solid var(--foreground)' : '3px solid transparent',
                                    boxShadow: selected ? `0 0 0 2px ${c}` : 'none'
                                }} />
                            </button>
                        );
                    })}
                </div>
            </Field>

            <Toggle checked={value.motion} onChange={v => onChange({ motion: v })} label="모션 효과" desc="화면 전환, 카드 호버, 애니메이션 사용" />

            <SaveBar onCancel={onCancel} onSave={onSave} />
        </Card>
    );
}

function dataToneStyle(tone: DataDbReadinessTone | DeploymentReadinessTone): { color: string; background: string; border: string; icon: React.ReactNode } {
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
                                            <span style={{ display: 'block', color: 'var(--muted)', fontSize: '0.8rem', lineHeight: 1.5, wordBreak: 'keep-all' }}>
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
                                        fontSize: 'var(--type-micro)',
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

function SecuritySection({
    deploymentReadiness,
    isCheckingDeployment,
    onRefreshDeployment,
}: {
    deploymentReadiness: DeploymentReadinessSummary;
    isCheckingDeployment: boolean;
    onRefreshDeployment: () => void;
}) {
    const [sessionDisplay, setSessionDisplay] = useState<TeacherSessionDisplay>(() => buildTeacherSessionDisplay(null));
    const readySecurityItems = SECURITY_POSTURE_ITEMS.filter(item => item.tone === "ready").length;
    const deploymentTone = dataToneStyle(
        deploymentReadiness.checks.some(check => check.tone === "error")
            ? "error"
            : deploymentReadiness.checks.some(check => check.tone === "warning")
                ? "warning"
                : deploymentReadiness.checks.length > 0
                    ? "ready"
                    : "neutral",
    );

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
        void clearTeacherAuthSession().finally(() => {
            window.location.href = "/?role=teacher";
        });
    };

    return (
        <Card title="보안" desc="계정 보안을 관리하세요.">
            <Field label="교사 계정">
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
                    {/* keep-all keeps Korean words intact; overflowWrap:anywhere lets long
                        env-var tokens (TEACHER_LOGIN_ID/TEACHER_PASSWORD) break instead of
                        overflowing the card at narrow widths. */}
                    <p style={{ color: 'var(--muted)', fontSize: '0.82rem', lineHeight: 1.65, wordBreak: 'keep-all', overflowWrap: 'anywhere' }}>
                        교사 계정 정보는 브라우저 설정에 저장하지 않습니다. 운영 환경에서는 <code style={{ fontWeight: 800 }}>TEACHER_ACCOUNTS</code> 또는 <code style={{ fontWeight: 800 }}>TEACHER_LOGIN_ID</code>/<code style={{ fontWeight: 800 }}>TEACHER_PASSWORD</code> 서버 환경변수를 변경한 뒤 다시 배포해 교체하세요.
                    </p>
                </div>
            </Field>

            <Field label="추가 보안 기능">
                <div style={{ display: 'grid', gap: '0.65rem' }}>
                    {SECURITY_INTEGRATION_ITEMS.map(item => (
                        <div
                            key={item.key}
                            style={{
                                display: 'flex', alignItems: 'flex-start', gap: '0.65rem',
                                padding: '0.85rem 0.95rem', borderRadius: 'var(--radius-md)',
                                border: '1px solid rgba(245,158,11,0.24)',
                                background: 'rgba(245,158,11,0.08)',
                            }}
                        >
                            <AlertTriangle size={15} color="var(--warning)" style={{ flexShrink: 0, marginTop: 2 }} />
                            <span style={{ minWidth: 0 }}>
                                <span style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', flexWrap: 'wrap', marginBottom: '0.18rem' }}>
                                    <strong style={{ fontSize: '0.86rem' }}>{item.label}</strong>
                                    <span style={{ padding: '0.13rem 0.42rem', borderRadius: 'var(--radius-full)', color: 'var(--warning)', background: 'rgba(245,158,11,0.12)', fontSize: 'var(--type-micro)', fontWeight: 900 }}>
                                        연동 전
                                    </span>
                                </span>
                                <span style={{ display: 'block', color: 'var(--muted)', fontSize: '0.78rem', lineHeight: 1.55, wordBreak: 'keep-all' }}>
                                    {item.detail}
                                </span>
                            </span>
                        </div>
                    ))}
                </div>
            </Field>

            <Field label="배포 로그인 진단">
                <div style={{
                    display: 'grid',
                    gap: '0.85rem',
                    padding: '1rem',
                    borderRadius: 'var(--radius-lg)',
                    border: `1px solid ${deploymentTone.border}`,
                    background: deploymentTone.background,
                }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.75rem', flexWrap: 'wrap' }}>
                        <div style={{ minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: deploymentTone.color, fontWeight: 950, marginBottom: '0.28rem' }}>
                                {deploymentTone.icon}
                                {deploymentReadiness.label}
                            </div>
                            {/* overflowWrap:anywhere — the diagnostic details cite long env-var
                                tokens (STUDENT_SESSION_SECRET, OMR_PRODUCTION_RLS_APPLIED=true)
                                that keep-all alone cannot break, overflowing the 375px card. */}
                            <p style={{ color: 'var(--muted)', fontSize: '0.82rem', lineHeight: 1.6, wordBreak: 'keep-all', overflowWrap: 'anywhere' }}>
                                {deploymentReadiness.detail}
                            </p>
                            <div style={{ marginTop: '0.38rem', color: 'var(--foreground)', fontSize: '0.78rem', fontWeight: 850 }}>
                                {deploymentReadiness.totalCount > 0
                                    ? `${deploymentReadiness.readyCount}/${deploymentReadiness.totalCount} 항목 준비 · 교사 계정 ${deploymentReadiness.credentialCount}개`
                                    : "서버 진단을 기다리는 중"}
                            </div>
                        </div>
                        <button
                            type="button"
                            onClick={onRefreshDeployment}
                            disabled={isCheckingDeployment}
                            aria-label="배포 로그인 진단 새로고침"
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
                                cursor: isCheckingDeployment ? 'wait' : 'pointer',
                                whiteSpace: 'nowrap',
                            }}
                        >
                            <RefreshCw size={14} className={isCheckingDeployment ? "animate-spin" : undefined} />
                            진단
                        </button>
                    </div>

                    {deploymentReadiness.checks.length > 0 && (
                        <div style={{
                            display: 'grid',
                            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))',
                            gap: '0.65rem',
                        }}>
                            {deploymentReadiness.checks.map(check => {
                                const tone = dataToneStyle(check.tone);
                                return (
                                    <div
                                        key={check.key}
                                        style={{
                                            display: 'flex',
                                            alignItems: 'flex-start',
                                            gap: '0.6rem',
                                            padding: '0.78rem 0.85rem',
                                            borderRadius: 'var(--radius-md)',
                                            border: `1px solid ${tone.border}`,
                                            background: 'var(--surface)',
                                            minHeight: 108,
                                        }}
                                    >
                                        <span style={{ color: tone.color, flexShrink: 0, marginTop: 1 }}>
                                            {tone.icon}
                                        </span>
                                        <span style={{ minWidth: 0 }}>
                                            <span style={{ display: 'block', color: 'var(--foreground)', fontSize: '0.8rem', fontWeight: 900, marginBottom: '0.18rem', overflowWrap: 'anywhere' }}>
                                                {check.label}
                                            </span>
                                            <span style={{ display: 'block', color: 'var(--muted)', fontSize: '0.8rem', lineHeight: 1.55, wordBreak: 'keep-all', overflowWrap: 'anywhere' }}>
                                                {check.detail}
                                            </span>
                                        </span>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            </Field>

            <Field label="운영 보안 점검">
                <div style={{ display: 'grid', gap: '0.75rem' }}>
                    <div style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '0.75rem',
                        padding: '0.85rem 1rem',
                        background: 'var(--background)',
                        border: '1px solid var(--border)',
                        borderRadius: 'var(--radius-md)',
                        flexWrap: 'wrap',
                    }}>
                        <span style={{ color: 'var(--muted)', fontSize: '0.82rem', fontWeight: 800 }}>
                            운영 준비도
                        </span>
                        <strong style={{ color: 'var(--foreground)', fontSize: '0.9rem' }}>
                            {readySecurityItems}/{SECURITY_POSTURE_ITEMS.length} 항목 준비
                        </strong>
                    </div>
                    <div style={{
                        display: 'grid',
                        gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))',
                        gap: '0.7rem',
                        alignItems: 'stretch',
                    }}>
                        {SECURITY_POSTURE_ITEMS.map(item => {
                            const isWarning = item.tone === "warning";
                            return (
                                <div
                                    key={item.key}
                                    style={{
                                        display: 'flex',
                                        alignItems: 'flex-start',
                                        gap: '0.65rem',
                                        minHeight: 118,
                                        height: '100%',
                                        padding: '0.9rem 0.95rem',
                                        background: isWarning ? 'rgba(245,158,11,0.08)' : 'rgba(16,185,129,0.08)',
                                        border: `1px solid ${isWarning ? 'rgba(245,158,11,0.22)' : 'rgba(16,185,129,0.2)'}`,
                                        borderRadius: 'var(--radius-md)',
                                        boxShadow: '0 10px 24px rgba(15,23,42,0.04)',
                                    }}
                                >
                                    <span style={{ color: isWarning ? 'var(--warning)' : 'var(--success)', flexShrink: 0, marginTop: 1 }}>
                                        {isWarning ? <AlertTriangle size={15} /> : <CheckCircle size={15} />}
                                    </span>
                                    <span style={{ minWidth: 0 }}>
                                        <span style={{ display: 'block', color: 'var(--foreground)', fontSize: '0.84rem', fontWeight: 900, marginBottom: '0.18rem' }}>
                                            {item.label}
                                        </span>
                                        <span style={{ display: 'block', color: 'var(--muted)', fontSize: '0.76rem', lineHeight: 1.55, wordBreak: 'keep-all' }}>
                                            {item.detail}
                                        </span>
                                    </span>
                                </div>
                            );
                        })}
                    </div>
                </div>
            </Field>

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
                                fontSize: 'var(--type-caption)',
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
        </Card>
    );
}
