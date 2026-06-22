"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import {
    normalizeTeacherRedirectPath,
    readTeacherSession,
    saveTeacherSessionSnapshot,
    type TeacherSession,
    teacherSessionRemainingMs,
} from "@/lib/teacherSession";

interface TeacherAuthGateProps {
    children: ReactNode;
    initialSession?: TeacherSession | null;
}

const MAX_SESSION_RECHECK_DELAY_MS = 2_147_000_000;

function buildLoginHref(): string {
    if (typeof window === "undefined") return "/?role=teacher";
    const currentPath = `${window.location.pathname}${window.location.search}`;
    const next = normalizeTeacherRedirectPath(currentPath);
    return `/?role=teacher&next=${encodeURIComponent(next)}`;
}

function nextSessionRecheckDelay(remainingMs: number): number {
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) return 0;
    return Math.min(Math.max(remainingMs + 250, 1000), MAX_SESSION_RECHECK_DELAY_MS);
}

function initialAuthStatus(initialSession: TeacherSession | null | undefined): "checking" | "authenticated" {
    return teacherSessionRemainingMs(initialSession) > 0 ? "authenticated" : "checking";
}

export default function TeacherAuthGate({ children, initialSession = null }: TeacherAuthGateProps) {
    const [authState, setAuthState] = useState<{
        status: "checking" | "authenticated" | "anonymous";
        loginHref: string;
    }>(() => ({ status: initialAuthStatus(initialSession), loginHref: "/?role=teacher" }));

    useEffect(() => {
        let cancelled = false;
        let expiryTimer: number | undefined;

        const clearExpiryTimer = () => {
            if (expiryTimer !== undefined) {
                window.clearTimeout(expiryTimer);
                expiryTimer = undefined;
            }
        };

        const syncAuthState = () => {
            if (cancelled) return;
            const session = readTeacherSession() || initialSession;
            const remainingMs = teacherSessionRemainingMs(session);
            if (remainingMs > 0) {
                saveTeacherSessionSnapshot(session);
            }
            setAuthState({
                loginHref: buildLoginHref(),
                status: remainingMs > 0 ? "authenticated" : "anonymous",
            });

            clearExpiryTimer();
            const delay = nextSessionRecheckDelay(remainingMs);
            if (delay > 0) {
                expiryTimer = window.setTimeout(syncAuthState, delay);
            }
        };

        const handleFocus = () => syncAuthState();
        const handleVisibilityChange = () => {
            if (document.visibilityState === "visible") syncAuthState();
        };

        const initialTimer = window.setTimeout(syncAuthState, 0);
        window.addEventListener("focus", handleFocus);
        document.addEventListener("visibilitychange", handleVisibilityChange);

        return () => {
            cancelled = true;
            window.clearTimeout(initialTimer);
            clearExpiryTimer();
            window.removeEventListener("focus", handleFocus);
            document.removeEventListener("visibilitychange", handleVisibilityChange);
        };
    }, [initialSession]);

    if (authState.status === "checking") {
        return (
            <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'var(--background)' }}>
                <div style={{ color: 'var(--muted)', fontWeight: 800 }}>권한 확인 중...</div>
            </div>
        );
    }

    if (authState.status === "anonymous") {
        return (
            <div className="layout-main center-content" style={{ minHeight: '100vh', padding: '2rem', background: 'var(--background)' }}>
                <div className="glass-panel" style={{ width: '100%', maxWidth: 430, padding: '2rem', textAlign: 'center' }}>
                    <div style={{
                        width: 52,
                        height: 52,
                        margin: '0 auto 1rem',
                        borderRadius: '50%',
                        display: 'grid',
                        placeItems: 'center',
                        background: 'rgba(99,102,241,0.1)',
                        color: 'var(--primary)',
                    }}>
                        <ShieldCheck size={24} />
                    </div>
                    <h1 style={{ fontSize: '1.35rem', fontWeight: 900, marginBottom: '0.5rem' }}>
                        교사 로그인이 필요합니다
                    </h1>
                    <p style={{ color: 'var(--muted)', lineHeight: 1.6, marginBottom: '1.35rem', wordBreak: 'keep-all' }}>
                        시험 생성, 학생 관리, 분석 화면은 교사 세션에서만 열람할 수 있습니다.
                    </p>
                    <Link href={authState.loginHref} className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }}>
                        교사 로그인
                    </Link>
                </div>
            </div>
        );
    }

    return <>{children}</>;
}
