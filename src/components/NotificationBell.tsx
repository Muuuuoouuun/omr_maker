"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bell, CheckCircle2, CreditCard, MessageCircle, Users, Clock, X } from "lucide-react";
import { readLocalAttempts, readLocalExams } from "@/lib/omrPersistence";
import { readRosterGroups, readRosterInvites, readRosterStudents } from "@/lib/rosterStorage";
import { buildKakaoNotificationCandidates } from "@/lib/kakaoNotificationQueue";
import { collectStudentQuestionInbox } from "@/lib/studentQuestions";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import {
    loadTeacherNotificationSummary,
    mutateTeacherNotificationState,
} from "@/app/actions/teacherNotifications";
import {
    resolveTeacherNotificationRefresh,
    type TeacherNotificationStorageNamespace,
} from "@/lib/teacherNotificationSummary";
import { applyTeacherNotificationStates } from "@/lib/teacherNotificationState";

interface Notification {
    id: string;
    title: string;
    message: string;
    time: string;
    unread: boolean;
    href?: string;
    kind: "info" | "success" | "warning" | "billing";
    /** Stable key for auto-generated notifications so we don't spawn duplicates on refresh */
    source?: "invites" | "recent-exams" | "plan-renewal" | "kakao-candidates" | "student-questions" | "sync-status";
}

// Auto-notification dismissals self-expire so "모두 삭제" never permanently
// silences a category. Auto ids are content-scoped (see below), so a genuinely
// new event produces a new id and reappears immediately regardless of this TTL;
// the window only bounds how long an *identical* state stays hidden and prunes
// the stored dismissal list.
const DISMISSED_TTL_MS = 14 * 24 * 60 * 60 * 1000;

interface DismissedEntry {
    id: string;
    at: number;
}

function currentEpochMs(): number {
    return Date.now();
}

// Compute what auto-generated notifications SHOULD exist right now based on
// localStorage state. Returns an empty list when nothing applies.
function computeAutoNotifications(): Notification[] {
    if (typeof window === "undefined") return [];
    const out: Notification[] = [];

    // Parse the heavy localStorage blobs once for explicit local-only
    // development fallback. Canonical production refreshes never call this.
    let attempts: ReturnType<typeof readLocalAttempts> = [];
    let exams: ReturnType<typeof readLocalExams> = [];
    try { attempts = readLocalAttempts(); } catch {}
    try { exams = readLocalExams(); } catch {}

    // 1) Pending invites
    try {
        const pending = readRosterInvites(localStorage).filter(invite => invite.status === "pending").length;
        if (pending > 0) {
            out.push({
                id: `auto-invites:${pending}`,
                source: "invites",
                kind: "info",
                title: "초대 수락 대기",
                message: `${pending}개 초대가 수락 대기 중`,
                time: "방금",
                unread: true,
                href: "/teacher/users",
            });
        }
    } catch {}

    // 2) Attempts finished in last 24h
    try {
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        const recent = attempts.filter(a => {
            if (a.status !== "completed") return false;
            const t = new Date(a.finishedAt).getTime();
            return !Number.isNaN(t) && t >= cutoff;
        }).length;
        if (recent > 0) {
            out.push({
                id: `auto-recent-exams:${recent}`,
                source: "recent-exams",
                kind: "success",
                title: "최근 시험 제출",
                message: `최근 24시간 내 ${recent}개 시험 제출 완료`,
                time: "최근 24시간",
                unread: true,
                href: "/teacher/live",
            });
        }
    } catch {}

    // 3) Pending student questions waiting on a teacher answer. Links to the
    // dashboard overview inbox where the teacher can reply.
    try {
        const pendingQuestions = collectStudentQuestionInbox(attempts).pending.length;
        if (pendingQuestions > 0) {
            out.push({
                id: `auto-student-questions:${pendingQuestions}`,
                source: "student-questions",
                kind: "info",
                title: "학생 질문 대기",
                message: `${pendingQuestions}건의 학생 질문이 답변을 기다립니다`,
                time: "답변 전",
                unread: true,
                href: "/teacher/dashboard#student-question-inbox",
            });
        }
    } catch {}

    // 4) Kakao notification candidates. These are planning records only:
    // no message is sent from this local UI.
    try {
        const queue = buildKakaoNotificationCandidates({
            exams,
            attempts,
            students: readRosterStudents(localStorage),
            groups: readRosterGroups(localStorage),
            limit: 8,
        });
        if (queue.totalCount > 0) {
            const parts = [
                queue.missingExamCount > 0 ? `미응시 ${queue.missingExamCount}건` : "",
                queue.classRetakeRecommendationCount > 0 ? `반별 재시험 ${queue.classRetakeRecommendationCount}건` : "",
                queue.retakeRecommendationCount > 0 ? `재시험 ${queue.retakeRecommendationCount}건` : "",
            ].filter(Boolean);
            out.push({
                id: `auto-kakao-candidates:${queue.missingExamCount}-${queue.classRetakeRecommendationCount}-${queue.retakeRecommendationCount}-${queue.targetStudentCount}`,
                source: "kakao-candidates",
                kind: "warning",
                title: "카카오 발송 후보 대기",
                message: `${parts.join(" · ")} · 대상 학생 ${queue.targetStudentCount}명`,
                time: "발송 전",
                unread: true,
                href: "/teacher/dashboard?tab=exam",
            });
        }
    } catch {}

    return out;
}

// Read the non-expired dismissal entries. Legacy category-scoped string ids
// (e.g. "auto-recent-exams") are intentionally dropped: they matched every
// future event and permanently silenced the category, which is the bug this
// fixes. Content-scoped ids now carry a timestamp and expire after the TTL.
function readDismissedEntries(storageKey: string): DismissedEntry[] {
    try {
        const raw = localStorage.getItem(storageKey);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        const now = Date.now();
        const entries: DismissedEntry[] = [];
        for (const item of parsed) {
            if (item && typeof item === "object" && typeof item.id === "string" && typeof item.at === "number") {
                if (now - item.at < DISMISSED_TTL_MS) entries.push({ id: item.id, at: item.at });
            }
        }
        return entries;
    } catch {
        return [];
    }
}

function readPersistedNotifications(storageKey: string): Notification[] {
    try {
        const raw = localStorage.getItem(storageKey);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed as Notification[] : [];
    } catch {
        return [];
    }
}

const KIND_META: Record<Notification["kind"], { color: string; icon: React.ReactNode }> = {
    info: { color: "#4f46e5", icon: <Users size={16} /> },
    success: { color: "#10b981", icon: <CheckCircle2 size={16} /> },
    warning: { color: "#f59e0b", icon: <MessageCircle size={16} /> },
    // Legacy local records remain renderable, but no renewal notice is created
    // until a real subscription provider owns the billing schedule.
    billing: { color: "#a855f7", icon: <CreditCard size={16} /> },
};

export default function NotificationBell() {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [notifications, setNotifications] = useState<Notification[]>([]);
    const [hydrated, setHydrated] = useState(false);
    const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
    const [mutationPending, setMutationPending] = useState(false);
    const [mutationError, setMutationError] = useState("");
    const rootRef = useRef<HTMLDivElement | null>(null);
    const refreshGenerationRef = useRef(0);
    const storageNamespaceRef = useRef<TeacherNotificationStorageNamespace | null>(null);
    const mutationGenerationRef = useRef(0);
    const closeNotifications = useCallback(() => {
        setOpen(false);
        setClearConfirmOpen(false);
    }, []);
    const dialogRef = useDialogFocus(open, closeNotifications);

    const refresh = useCallback(async () => {
        const generation = refreshGenerationRef.current + 1;
        refreshGenerationRef.current = generation;
        const result = await loadTeacherNotificationSummary();
        if (refreshGenerationRef.current !== generation) return;
        const resolution = resolveTeacherNotificationRefresh<Notification>(result, {
            readPersisted: readPersistedNotifications,
            readDismissed: readDismissedEntries,
            computeLocalFallback: computeAutoNotifications,
        });
        storageNamespaceRef.current = resolution.namespace;
        const next = resolution.notifications as Notification[];
        setNotifications(next);
        if (resolution.shouldPersist && resolution.namespace) {
            try {
                localStorage.setItem(resolution.namespace.notificationsKey, JSON.stringify(next));
            } catch {}
        }
    }, []);

    // Hydrate once + refresh every 60s
    useEffect(() => {
        // Refresh derives notifications from client-only localStorage after mount.
        const initialRefreshId = window.setTimeout(() => {
            void refresh();
            setHydrated(true);
        }, 0);
        const id = setInterval(() => {
            // Skip the localStorage parsing work while the tab is backgrounded.
            if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
            void refresh();
        }, 60 * 1000);
        const onVisibilityChange = () => {
            if (document.visibilityState === "hidden") return;
            void refresh();
        };
        document.addEventListener("visibilitychange", onVisibilityChange);
        return () => {
            refreshGenerationRef.current += 1;
            mutationGenerationRef.current += 1;
            clearTimeout(initialRefreshId);
            clearInterval(id);
            document.removeEventListener("visibilitychange", onVisibilityChange);
        };
    }, [refresh]);

    // Close on outside click
    useEffect(() => {
        if (!open) return;
        const onClick = (e: MouseEvent) => {
            if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
                closeNotifications();
            }
        };
        window.addEventListener("mousedown", onClick);
        return () => window.removeEventListener("mousedown", onClick);
    }, [closeNotifications, open]);

    const unreadCount = notifications.filter(n => n.unread).length;

    const persistLocal = (next: Notification[]) => {
        setNotifications(next);
        const namespace = storageNamespaceRef.current;
        if (!namespace) return;
        try { localStorage.setItem(namespace.notificationsKey, JSON.stringify(next)); } catch {}
    };

    const applyLocalMutation = (operation: "mark_read" | "dismiss", ids: string[]) => {
        const idSet = new Set(ids);
        if (operation === "dismiss") {
            try {
                const namespace = storageNamespaceRef.current;
                if (namespace) {
                    const now = currentEpochMs();
                    const existing = readDismissedEntries(namespace.dismissedKey)
                        .filter(entry => !idSet.has(entry.id));
                    localStorage.setItem(namespace.dismissedKey, JSON.stringify([
                        ...existing,
                        ...ids.map(id => ({ id, at: now })),
                    ]));
                }
            } catch {}
        }
        persistLocal(operation === "dismiss"
            ? notifications.filter(notification => !idSet.has(notification.id))
            : notifications.map(notification => idSet.has(notification.id)
                ? { ...notification, unread: false }
                : notification));
    };

    const runMutation = async (operation: "mark_read" | "dismiss", ids: string[]) => {
        if (mutationPending || ids.length === 0) return;
        const generation = mutationGenerationRef.current + 1;
        mutationGenerationRef.current = generation;
        setMutationPending(true);
        setMutationError("");
        const result = await mutateTeacherNotificationState({ operation, notificationIds: ids });
        if (mutationGenerationRef.current !== generation) return;
        if (result.status === "saved") {
            setNotifications(current => applyTeacherNotificationStates(current, result.states));
        } else if (result.status === "local_only") {
            applyLocalMutation(operation, ids);
        } else {
            setMutationError("알림 상태를 동기화하지 못했습니다. 잠시 후 다시 시도해 주세요.");
            await refresh();
        }
        if (mutationGenerationRef.current === generation) setMutationPending(false);
    };

    const markAllRead = () => {
        void runMutation("mark_read", notifications.filter(notification => notification.unread).map(notification => notification.id));
    };
    const markOneRead = async (id: string) => {
        await runMutation("mark_read", [id]);
    };
    const dismissOne = (id: string) => {
        void runMutation("dismiss", [id]);
    };
    const handleClearAll = () => {
        void runMutation("dismiss", notifications.map(notification => notification.id));
        setClearConfirmOpen(false);
    };

    return (
        <div ref={rootRef} style={{ position: 'relative' }}>
            <button
                onClick={() => open ? closeNotifications() : setOpen(true)}
                aria-label={unreadCount > 0 ? `알림 (읽지 않음 ${unreadCount}개)` : '알림 받기'}
                aria-expanded={open}
                aria-controls="teacher-notifications-dialog"
                aria-haspopup="dialog"
                style={{
                    width: 44, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center',
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
                        fontSize: 'var(--type-micro)', fontWeight: 800,
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
                    id="teacher-notifications-dialog"
                    ref={dialogRef}
                    role="dialog"
                    aria-label="알림 목록"
                    tabIndex={-1}
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
                            <span style={{ fontSize: '1.02rem', fontWeight: 800 }}>알림</span>
                            {unreadCount > 0 && (
                                <span style={{ fontSize: 'var(--type-caption)', color: 'var(--muted)' }}>
                                    {unreadCount}개 읽지 않음
                                </span>
                            )}
                        </div>
                        {notifications.length > 0 && (
                            <div style={{ display: 'flex', gap: '0.5rem' }}>
                                {unreadCount > 0 && (
                                    <button
                                        onClick={markAllRead}
                                        disabled={mutationPending}
                                        style={{ minHeight: 44, padding: '0 0.6rem', fontSize: '0.8rem', color: 'var(--primary)', fontWeight: 650 }}
                                    >
                                        모두 읽음
                                    </button>
                                )}
                                <button
                                    onClick={() => setClearConfirmOpen(true)}
                                    disabled={mutationPending}
                                    style={{ minHeight: 44, padding: '0 0.6rem', fontSize: '0.8rem', color: 'var(--muted)', fontWeight: 550 }}
                                >
                                    모두 삭제
                                </button>
                            </div>
                        )}
                    </div>

                    {clearConfirmOpen && (
                        <div
                            role="alertdialog"
                            aria-label="모든 알림 삭제 확인"
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                gap: '0.75rem',
                                padding: '0.75rem 1rem',
                                background: 'rgba(239,68,68,0.08)',
                                borderBottom: '1px solid rgba(239,68,68,0.18)',
                            }}
                        >
                            <span style={{ fontSize: 'var(--type-label)', color: 'var(--foreground)', fontWeight: 750, wordBreak: 'keep-all' }}>
                                모든 알림을 삭제할까요?
                            </span>
                            <div style={{ display: 'flex', gap: '0.45rem', flexShrink: 0 }}>
                                <button
                                    onClick={() => setClearConfirmOpen(false)}
                                    style={{ minHeight: 44, padding: '0 0.6rem', fontSize: '0.8rem', color: 'var(--muted)', fontWeight: 700 }}
                                >
                                    취소
                                </button>
                                <button
                                    onClick={handleClearAll}
                                    disabled={mutationPending}
                                    style={{
                                        minHeight: 44,
                                        padding: '0 0.7rem',
                                        borderRadius: 'var(--radius-md)',
                                        background: 'var(--error)',
                                        color: 'white',
                                        fontSize: '0.8rem',
                                        fontWeight: 800,
                                    }}
                                >
                                    삭제
                                </button>
                            </div>
                        </div>
                    )}

                    {mutationError && (
                        <div role="alert" style={{ padding: '0.65rem 1rem', color: 'var(--error)', fontSize: 'var(--type-label)', borderBottom: '1px solid var(--border)' }}>
                            {mutationError}
                        </div>
                    )}

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
                                                <span style={{ fontSize: '0.9rem', fontWeight: n.unread ? 750 : 550, color: 'var(--foreground)' }}>
                                                    {n.title}
                                                </span>
                                                <span style={{ fontSize: 'var(--type-caption)', color: 'var(--muted)', flexShrink: 0, whiteSpace: 'nowrap' }}>{n.time}</span>
                                            </div>
                                            <div style={{ fontSize: 'var(--type-label)', color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
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
                                    padding: '0.85rem 0.5rem 0.85rem 1rem',
                                    background: n.unread ? 'rgba(99,102,241,0.02)' : 'transparent',
                                    transition: 'background 0.15s', cursor: n.href ? 'pointer' : 'default',
                                    textAlign: 'left', width: '100%'
                                };
                                return (
                                    <div key={n.id} style={{ display: 'flex', alignItems: 'stretch', borderBottom: '1px solid var(--border)' }}>
                                        {n.href ? (
                                            <Link
                                                href={n.href}
                                                onClick={(event) => {
                                                    event.preventDefault();
                                                    void markOneRead(n.id).finally(() => {
                                                        closeNotifications();
                                                        router.push(n.href!);
                                                    });
                                                }}
                                                style={commonStyle}
                                            >
                                                {content}
                                            </Link>
                                        ) : (
                                            <button
                                                type="button"
                                                onClick={() => { void markOneRead(n.id); }}
                                                disabled={mutationPending}
                                                style={commonStyle}
                                            >
                                                {content}
                                            </button>
                                        )}
                                        <button
                                            type="button"
                                            aria-label={`${n.title} 알림 삭제`}
                                            title="알림 삭제"
                                            onClick={() => dismissOne(n.id)}
                                            disabled={mutationPending}
                                            style={{ width: 44, minWidth: 44, color: 'var(--muted)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                                        >
                                            <X size={16} aria-hidden="true" />
                                        </button>
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
