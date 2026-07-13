"use client";

import { useEffect, useState, useCallback } from "react";
import { CheckCircle2, AlertCircle, Info, X } from "lucide-react";

export type ToastKind = "success" | "error" | "info";

interface ToastMessage {
    id: number;
    kind: ToastKind;
    title: string;
    description?: string;
    duration: number;
}

// Singleton event-bus: any component can call `showToast(...)` without context.
type Listener = (t: ToastMessage) => void;
const listeners = new Set<Listener>();
const pendingMessages: ToastMessage[] = [];
let nextId = 1;

export function showToast(kind: ToastKind, title: string, description?: string, duration = 3000) {
    const msg: ToastMessage = { id: nextId++, kind, title, description, duration };
    if (listeners.size === 0) {
        pendingMessages.push(msg);
        return;
    }
    listeners.forEach(l => l(msg));
}

export const toast = {
    success: (title: string, description?: string) => showToast("success", title, description),
    error: (title: string, description?: string) => showToast("error", title, description, 4500),
    info: (title: string, description?: string) => showToast("info", title, description),
};

const KIND: Record<ToastKind, { color: string; bg: string; icon: React.ReactNode }> = {
    success: { color: "#10b981", bg: "rgba(16,185,129,0.08)", icon: <CheckCircle2 size={18} /> },
    error: { color: "#ef4444", bg: "rgba(239,68,68,0.08)", icon: <AlertCircle size={18} /> },
    info: { color: "#4f46e5", bg: "rgba(99,102,241,0.08)", icon: <Info size={18} /> },
};

export default function ToastHost() {
    const [items, setItems] = useState<ToastMessage[]>([]);

    const remove = useCallback((id: number) => {
        setItems(prev => prev.filter(t => t.id !== id));
    }, []);

    useEffect(() => {
        const listener: Listener = (msg) => {
            setItems(prev => [...prev, msg]);
            setTimeout(() => remove(msg.id), msg.duration);
        };
        listeners.add(listener);
        if (pendingMessages.length > 0) {
            pendingMessages.splice(0).forEach(listener);
        }
        return () => { listeners.delete(listener); };
    }, [remove]);

    if (items.length === 0) return null;

    return (
        <div
            role="region"
            aria-label="알림"
            aria-live="polite"
            style={{
                position: 'fixed',
                left: 'max(1rem, env(safe-area-inset-left))',
                right: 'max(1rem, env(safe-area-inset-right))',
                bottom: 'max(1rem, env(safe-area-inset-bottom))',
                display: 'flex', flexDirection: 'column', gap: '0.6rem',
                alignItems: 'flex-end',
                zIndex: 2000, pointerEvents: 'none'
            }}
        >
            {items.map(t => {
                const meta = KIND[t.kind];
                return (
                    <div
                        key={t.id}
                        style={{
                            pointerEvents: 'auto',
                            display: 'flex', alignItems: 'flex-start', gap: '0.75rem',
                            padding: '0.85rem 1rem',
                            width: 'min(400px, 100%)',
                            minWidth: 'min(280px, 100%)',
                            maxWidth: '100%',
                            background: 'var(--surface)',
                            border: `1px solid color-mix(in srgb, ${meta.color}, transparent 78%)`,
                            borderLeft: `4px solid ${meta.color}`,
                            borderRadius: 'var(--radius-md)',
                            boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
                            animation: 'fadeIn 0.2s ease-out'
                        }}
                    >
                        <div style={{ color: meta.color, flexShrink: 0, marginTop: 2 }}>{meta.icon}</div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--foreground)', overflowWrap: 'anywhere' }}>{t.title}</div>
                            {t.description && (
                                <div style={{ fontSize: '0.82rem', color: 'var(--muted)', marginTop: '0.2rem', lineHeight: 1.45, overflowWrap: 'anywhere' }}>{t.description}</div>
                            )}
                        </div>
                        <button
                            onClick={() => remove(t.id)}
                            aria-label="알림 닫기"
                            style={{
                                color: 'var(--muted)',
                                width: 44,
                                height: 44,
                                display: 'inline-flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                flexShrink: 0,
                                borderRadius: 'var(--radius-md)',
                            }}
                        >
                            <X size={14} />
                        </button>
                    </div>
                );
            })}
        </div>
    );
}
