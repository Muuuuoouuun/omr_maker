"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle, Home, RotateCcw } from "lucide-react";

export default function GlobalError({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    useEffect(() => {
        // In production this is where you'd ping Sentry etc.
        console.error("Global error boundary caught:", error);
    }, [error]);

    return (
        <div className="layout-main" style={{ alignItems: 'center', justifyContent: 'center', minHeight: '80vh' }}>
            <div className="orb orb-primary" />
            <div className="container" style={{ maxWidth: 520, textAlign: 'center', padding: '2rem', position: 'relative', zIndex: 1 }}>
                <div style={{
                    width: 88, height: 88, borderRadius: '50%',
                    background: 'rgba(239,68,68,0.1)', color: '#ef4444',
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    marginBottom: '1.5rem'
                }}>
                    <AlertTriangle size={38} />
                </div>
                <h1 style={{ fontSize: '1.6rem', fontWeight: 800, marginBottom: '0.5rem' }}>
                    예상치 못한 오류가 발생했습니다
                </h1>
                <p style={{ color: 'var(--muted)', fontSize: '0.95rem', marginBottom: '1.5rem' }}>
                    페이지를 다시 시도하거나 홈으로 이동하세요.
                </p>
                {error.digest && (
                    <code style={{
                        display: 'inline-block', fontSize: '0.72rem', color: 'var(--muted)',
                        padding: '0.25rem 0.6rem', background: 'var(--background)',
                        border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
                        marginBottom: '1.5rem', fontFamily: 'var(--font-mono)'
                    }}>
                        {error.digest}
                    </code>
                )}
                <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center', flexWrap: 'wrap' }}>
                    <button
                        onClick={reset}
                        style={{
                            padding: '0.75rem 1.5rem',
                            background: 'linear-gradient(135deg, var(--primary), var(--primary-dark))',
                            color: 'white', borderRadius: 'var(--radius-full)',
                            fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '0.5rem',
                            boxShadow: '0 4px 14px rgba(99,102,241,0.3)'
                        }}
                    >
                        <RotateCcw size={16} /> 다시 시도
                    </button>
                    <Link href="/" style={{
                        padding: '0.75rem 1.5rem',
                        background: 'var(--surface)', border: '1px solid var(--border)',
                        color: 'var(--foreground)', borderRadius: 'var(--radius-full)',
                        fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '0.5rem'
                    }}>
                        <Home size={16} /> 홈으로
                    </Link>
                </div>
            </div>
        </div>
    );
}
