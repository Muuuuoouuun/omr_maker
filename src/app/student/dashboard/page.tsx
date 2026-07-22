"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import BrandLogo from "@/components/BrandLogo";
import { Exam } from "@/types/omr";
import AssignmentBlock from "@/components/dashboard/AssignmentBlock";
import { createDashboardRevalidationGate, isStudentDashboardStorageKey } from "@/components/dashboard/dashboardRevalidation";
import ThemeToggle from "@/components/ThemeToggle";
import { toast } from "@/components/Toast";
import { Award, LogIn, Sparkles } from "lucide-react";

import {
    attemptBelongsToSession,
    clearSession,
    getSession,
    mergeGuestAttempts,
    previewGuestMerge,
    queueGuestMerge,
    readStoredGuestId,
    type GuestMergePreview,
    type StudentSession,
} from "@/utils/storage";
import { readLocalAttempts, readLocalExams, syncMergedGuestAttempts } from "@/lib/omrPersistence";
import { averageResolvedAttemptPercent, baseAttemptsOnly, retakeAttemptsOnly } from "@/lib/attemptScores";
import { evaluateExamAccess } from "@/lib/examAccess";
import { listMyAssignments } from "@/app/actions/studentExam";
import { clearStudentServerSession } from "@/app/actions/studentSession";
import { listMyAssignmentsClient } from "@/lib/studentExamClient";
import type { SolvableExam } from "@/lib/examSolvePayload";
import { loadStudentReturnedFeedbackWithDevFallback } from "@/lib/studentFeedbackClient";
import { answeredQuestionKeys, newlyAnsweredKeys } from "@/lib/studentQuestions";

/** True when this device holds an unsubmitted draft for the exam/owner pair. */
function hasLocalDraftFor(examId: string, ownerKey: string): boolean {
    if (typeof window === "undefined" || !ownerKey) return false;
    try {
        const prefix = `omr_draft_${examId}_${ownerKey}`;
        for (let i = 0; i < window.localStorage.length; i++) {
            const key = window.localStorage.key(i);
            if (key && key.startsWith(prefix)) return true;
        }
    } catch {
        // storage blocked — treat as no draft
    }
    return false;
}

function getTimeGreeting(): string {
    const h = new Date().getHours();
    if (h < 6) return "늦은 밤이네요";
    if (h < 12) return "좋은 아침이에요";
    if (h < 18) return "오늘도 수고하세요";
    return "좋은 저녁이에요";
}

export default function StudentDashboard() {
    const router = useRouter();
    const [user, setUser] = useState<StudentSession | null>(null);
    const [todoExams, setTodoExams] = useState<Array<Exam | SolvableExam>>([]);
    const [doneExams, setDoneExams] = useState<Array<(Exam | SolvableExam) & { attemptId: string; hasUnreadFeedback?: boolean; answeredQuestionCount?: number }>>([]);
    const [stats, setStats] = useState({
        avgScore: 0,
        completedCount: 0,
        retakeCount: 0,
    });
    const [sessionState, setSessionState] = useState<"checking" | "active" | "missing">("checking");
    const [guestMergePreview, setGuestMergePreview] = useState<GuestMergePreview | null>(null);
    const [refreshKey, setRefreshKey] = useState(0);

    useEffect(() => {
        let cancelled = false;
        const loadStudentData = async () => {
            // 1. Check Session (Simulated)
            const currentUser = getSession();
            if (!currentUser) {
                setSessionState("missing");
                setGuestMergePreview(null);
                return;
            }
            if (cancelled) return;
            setUser(currentUser);
            setSessionState("active");

            // 2. Load Data — own attempts come from the server boundary
            // (ownership enforced by the signed session cookie); local list is
            // the degraded fallback and keeps the client-side ownership filter.
            const myAttemptsResult = await listMyAssignmentsClient({
                server: () => listMyAssignments(),
                localFallback: async () => readLocalAttempts(),
            });
            if (cancelled) return;
            if (myAttemptsResult.status === "unauthenticated" && currentUser.workspaceId) {
                const query = new URLSearchParams({
                    role: "student",
                    workspace: currentUser.workspaceId,
                    next: "/student/dashboard",
                });
                setSessionState("missing");
                router.replace(`/?${query.toString()}`);
                return;
            }

            const localExams = myAttemptsResult.source === "local" ? readLocalExams() : [];
            const allExams: Array<Exam | SolvableExam> = myAttemptsResult.source === "server"
                ? myAttemptsResult.exams || []
                : localExams;
            const localExamById = new Map(localExams.map(exam => [exam.id, exam]));
            const attemptSource = myAttemptsResult.source;
            const myAttempts = attemptSource === "server"
                ? myAttemptsResult.attempts
                : myAttemptsResult.attempts.filter(a => attemptBelongsToSession(a, currentUser));

            // A guest→student merge (here or on the login screen) reassigns
            // attempt ownership in localStorage only, so the server list still
            // owns those attempts as the guest and omits them here. When the
            // server path is active, re-push any reassigned-but-missing attempts
            // so they reappear, then refresh once they land. Self-terminating:
            // once synced they show up in the server list and are skipped.
            if (attemptSource === "server" && !currentUser.isGuest && currentUser.studentId) {
                const serverIds = myAttempts.map(a => a.id);
                void syncMergedGuestAttempts(currentUser.studentId, { skipAttemptIds: serverIds })
                    .then(synced => { if (synced > 0 && !cancelled) setRefreshKey(key => key + 1); })
                    .catch(() => { /* offline — local path already shows them */ });
            }

            const myBaseAttempts = baseAttemptsOnly(myAttempts);
            const myRetakeAttempts = retakeAttemptsOnly(myAttempts);
            const returnedFeedback = currentUser.isGuest
                ? []
                : await loadStudentReturnedFeedbackWithDevFallback(currentUser.studentId);
            if (cancelled) return;
            const unreadFeedbackAttemptIds = new Set(
                returnedFeedback
                    .filter(feedback => !feedback.delivery.firstOpenedAt)
                    .map(feedback => feedback.attemptId),
            );
            const guestIdForMerge = currentUser.isGuest ? currentUser.guestId : readStoredGuestId();
            const mergePreview = guestIdForMerge
                ? previewGuestMerge(guestIdForMerge, currentUser.isGuest ? undefined : {
                    studentId: currentUser.studentId,
                    name: currentUser.name,
                    groupId: currentUser.groupId,
                    groupName: currentUser.groupName,
                    regionId: currentUser.regionId,
                    regionName: currentUser.regionName,
                    identityType: currentUser.identityType,
                })
                : null;

            // 3. Categorize Exams
            const done: Array<(Exam | SolvableExam) & { attemptId: string; hasUnreadFeedback?: boolean; answeredQuestionCount?: number }> = [];
            const todo: Array<Exam | SolvableExam> = [];

            allExams.forEach(exam => {
                const hasAccess = attemptSource === "server" || (() => {
                    const access = evaluateExamAccess(exam as Exam, { session: currentUser });
                    return access.status === "allowed" || access.status === "pin_required";
                })();

                if (!hasAccess) return;

                // Check if completed
                const attempt = myBaseAttempts.find(a => a.examId === exam.id);
                if (attempt) {
                    done.push({
                        ...exam,
                        attemptId: attempt.id,
                        hasUnreadFeedback: unreadFeedbackAttemptIds.has(attempt.id),
                        answeredQuestionCount: (attempt.studentQuestions || [])
                            .filter(note => note.status === "answered").length,
                    });
                } else if (
                    // Guests on the server path only see exams they actually
                    // started (submitted or drafted on this device) — the public
                    // exam catalog is not broadcast to anonymous identities.
                    !(currentUser.isGuest && attemptSource === "server")
                    || hasLocalDraftFor(exam.id, currentUser.studentId || "")
                ) {
                    todo.push(exam);
                }
            });

            setTodoExams(todo);
            setDoneExams(done);

            // 4. Calculate Stats
            const avg = averageResolvedAttemptPercent(
                myBaseAttempts,
                attemptSource === "server" ? new Map() : localExamById,
            );
            setStats({
                avgScore: avg,
                completedCount: myBaseAttempts.length,
                retakeCount: myRetakeAttempts.length,
            });
            setGuestMergePreview(mergePreview && mergePreview.mergeableCount > 0 ? mergePreview : null);

            // Arrival notification: toast once when a teacher answer newly lands.
            // The first load on a device establishes a silent baseline so we only
            // announce answers that arrive after the student last saw the dashboard.
            if (!currentUser.isGuest) {
                try {
                    const SEEN_KEY = "omr_student_seen_answers";
                    const currentKeys = answeredQuestionKeys(myBaseAttempts);
                    const raw = localStorage.getItem(SEEN_KEY);
                    if (raw === null) {
                        localStorage.setItem(SEEN_KEY, JSON.stringify(currentKeys));
                    } else {
                        let seen: string[] = [];
                        try { const parsed = JSON.parse(raw); if (Array.isArray(parsed)) seen = parsed; } catch {}
                        const fresh = newlyAnsweredKeys(currentKeys, seen);
                        if (fresh.length > 0) {
                            toast.success("선생님 답변 도착", `${fresh.length}개 질문에 답변이 등록됐어요. 완료 기록에서 복습하세요.`);
                        }
                        localStorage.setItem(SEEN_KEY, JSON.stringify(currentKeys));
                    }
                } catch { /* storage unavailable — badge still surfaces answers */ }
            }
        };

        void loadStudentData();
        return () => { cancelled = true; };

    }, [router, refreshKey]);

    // Cross-tab / refocus revalidation: submitting an exam in another tab (or a
    // login/guest-merge there) fires a "storage" event; returning to this tab
    // fires focus/visibilitychange. Bump refreshKey to re-run the loader above,
    // throttled to once per window with one trailing refresh so bursts coalesce.
    useEffect(() => {
        let cancelled = false;
        let trailingTimer: number | undefined;
        const gate = createDashboardRevalidationGate();
        const refresh = () => {
            if (cancelled) return;
            setRefreshKey(key => key + 1);
        };
        const trigger = () => {
            const decision = gate.decide();
            if (decision.kind === "refresh") {
                refresh();
            } else if (decision.kind === "schedule") {
                trailingTimer = window.setTimeout(() => {
                    trailingTimer = undefined;
                    gate.confirmScheduledRefresh();
                    refresh();
                }, decision.delayMs);
            }
        };
        const onStorage = (event: StorageEvent) => {
            if (!isStudentDashboardStorageKey(event.key)) return;
            trigger();
        };
        const onVisibilityChange = () => {
            if (document.visibilityState === "visible") trigger();
        };
        window.addEventListener("storage", onStorage);
        window.addEventListener("focus", trigger);
        document.addEventListener("visibilitychange", onVisibilityChange);
        return () => {
            cancelled = true;
            if (trailingTimer !== undefined) window.clearTimeout(trailingTimer);
            gate.cancelScheduled();
            window.removeEventListener("storage", onStorage);
            window.removeEventListener("focus", trigger);
            document.removeEventListener("visibilitychange", onVisibilityChange);
        };
    }, []);

    const handleConnectStudentAccount = () => {
        if (user?.guestId) {
            const queued = queueGuestMerge(user.guestId);
            if (queued) {
                toast.info(
                    "학생 로그인으로 연결",
                    "이름과 반으로 로그인하면 이 기기의 게스트 기록을 학생 기록에 합칩니다."
                );
            } else {
                toast.error("연결 준비 실패", "브라우저 저장공간을 확인한 뒤 다시 시도해주세요.");
                return;
            }
        }
        router.push("/?role=student");
    };

    const handleMergeGuestIntoCurrentStudent = async () => {
        if (!user || user.isGuest) return;
        const guestId = guestMergePreview?.guestId || readStoredGuestId();
        if (!guestId) {
            toast.info("연결할 게스트 기록 없음", "현재 기기에서 연결 가능한 게스트 기록을 찾지 못했습니다.");
            return;
        }
        const mergedCount = mergeGuestAttempts(guestId, {
            studentId: user.studentId,
            name: user.name,
            groupId: user.groupId,
            groupName: user.groupName,
            regionId: user.regionId,
            regionName: user.regionName,
            identityType: user.identityType,
        });
        if (mergedCount > 0) {
            // Push the reassigned attempts to the server before refreshing so the
            // authoritative server list returns them under the student instead of
            // silently dropping them (they stay owned by the guest remotely until
            // re-upserted). Offline failures queue for the SyncFlusher retry.
            await syncMergedGuestAttempts(user.studentId, { guestId }).catch(() => 0);
            toast.success("게스트 기록 연결됨", `${mergedCount}개의 시험 기록을 학생 기록으로 저장했습니다.`);
            setRefreshKey(key => key + 1);
            return;
        }
        toast.info("새로 연결할 기록 없음", "이미 이 학생 기록에 연결했거나 연결 가능한 게스트 제출이 없습니다.");
        setGuestMergePreview(null);
    };

    const handleLogout = () => {
        const workspaceId = user?.workspaceId;
        clearSession();
        // Also drop the httpOnly server session cookie (shared-device safety).
        clearStudentServerSession().catch(() => { /* offline — cookie expires on TTL */ });
        setUser(null);
        setTodoExams([]);
        setDoneExams([]);
        setStats({ avgScore: 0, completedCount: 0, retakeCount: 0 });
        setGuestMergePreview(null);
        setSessionState("missing");
        toast.info("로그아웃됨", "다시 시험을 보려면 학생 로그인이 필요합니다.");
        if (workspaceId) {
            const query = new URLSearchParams({ role: "student", workspace: workspaceId });
            router.replace(`/?${query.toString()}`);
        }
    };

    if (!user) {
        const checking = sessionState === "checking";
        return (
            <div className="layout-main">
                <header className="header">
                    <div className="container header-content" style={{ gap: "1rem", flexWrap: "wrap" }}>
                        <BrandLogo />
                        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                            <Link
                                href="/?role=student"
                                className="btn btn-primary"
                                style={{ padding: "0.55rem 0.95rem", fontSize: "0.88rem" }}
                            >
                                학생 로그인
                            </Link>
                            <ThemeToggle />
                        </div>
                    </div>
                </header>

                <main className="container animate-fade-in" style={{ padding: "4rem 1rem", maxWidth: 760 }}>
                    <section
                        className="bento-card"
                        style={{
                            alignItems: "flex-start",
                            gap: "1rem",
                            padding: "2rem",
                            minHeight: 0,
                        }}
                    >
                        <div
                            style={{
                                width: 48,
                                height: 48,
                                borderRadius: "var(--radius-md)",
                                background: "rgba(99,102,241,0.1)",
                                color: "var(--primary)",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                            }}
                        >
                            <LogIn size={22} />
                        </div>
                        <div>
                            <h1 style={{ fontSize: "1.55rem", fontWeight: 800, marginBottom: "0.45rem" }}>
                                {checking ? "학생 정보를 불러오는 중입니다" : "학생 로그인이 필요합니다"}
                            </h1>
                            <p className="text-muted" style={{ lineHeight: 1.7, wordBreak: "keep-all" }}>
                                {checking
                                    ? "잠시만 기다려주세요."
                                    : "이름과 반을 선택해 로그인하면 배정된 시험과 복습 기록을 이어서 볼 수 있습니다."}
                            </p>
                        </div>
                        {!checking && (
                            <Link href="/?role=student" className="btn btn-primary">
                                로그인 화면으로 이동
                            </Link>
                        )}
                    </section>
                </main>
            </div>
        );
    }

    return (
        <div className="layout-main">
            <header className="header">
                <div className="container header-content" style={{ gap: "1rem", flexWrap: "wrap" }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                        <BrandLogo />
                        <span style={{
                            fontSize: '0.75rem', fontWeight: 700,
                            background: 'rgba(236, 72, 153, 0.1)', color: 'var(--secondary)',
                            padding: '4px 10px', borderRadius: 'var(--radius-full)',
                            border: '1px solid rgba(236, 72, 153, 0.2)'
                        }}>
                            {user.isGuest ? "게스트" : "학생"}
                        </span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                        <span style={{ fontWeight: 600, fontSize: '0.95rem', display: 'inline-flex', alignItems: 'center', gap: '0.45rem', flexWrap: 'wrap' }}>
                            <span>
                                {user.name} <span style={{ color: 'var(--muted)', fontWeight: 400 }}>({user.groupName})</span>
                            </span>
                            {user.isGuest && user.loginId ? (
                                <span style={{
                                    color: 'var(--primary)',
                                    background: 'rgba(99,102,241,0.1)',
                                    border: '1px solid rgba(99,102,241,0.18)',
                                    borderRadius: 'var(--radius-full)',
                                    padding: '0.18rem 0.5rem',
                                    fontSize: 'var(--type-caption)',
                                    fontWeight: 800,
                                    fontVariantNumeric: 'tabular-nums',
                                }}>
                                    임시 ID {user.loginId}
                                </span>
                            ) : null}
                        </span>
                        <button
                            onClick={handleLogout}
                            style={{
                                minHeight: '2.75rem',
                                padding: '0.45rem 0.2rem',
                                borderRadius: 'var(--radius-md)',
                                fontSize: '0.9rem',
                                color: 'var(--muted)',
                                cursor: 'pointer',
                                transition: 'color 0.2s',
                                fontWeight: 500,
                            }}
                        >
                            로그아웃
                        </button>
                        <ThemeToggle />
                    </div>
                </div>
            </header>

            <main className="container animate-fade-in" style={{ paddingBottom: '4rem' }}>

                {/* Guest Banner */}
                {user.isGuest && (
                    <div style={{
                        margin: '2rem 0 1rem', padding: '1.5rem',
                        background: 'var(--surface)',
                        borderRadius: 'var(--radius-lg)', color: 'var(--foreground)',
                        border: '1px solid var(--border)', borderLeft: '4px solid var(--primary)',
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        gap: '1rem', flexWrap: 'wrap',
                        boxShadow: 'var(--shadow-md)'
                    }}>
                        <div>
                            <h3 style={{ fontSize: '1.2rem', fontWeight: 700, marginBottom: '0.25rem' }}>
                                게스트 기록을 학생 기록으로 저장
                            </h3>
                            <p style={{ color: 'var(--muted)', fontSize: '0.95rem', lineHeight: 1.6, wordBreak: "keep-all" }}>
                                이름과 반으로 로그인하면 지금 기기에서 푼 게스트 기록
                                {guestMergePreview ? ` ${guestMergePreview.mergeableCount}건` : ""}을 같은 학생 기록에 연결합니다.
                            </p>
                            {user.loginId ? (
                                <div style={{ marginTop: '0.45rem', color: 'var(--primary)', fontSize: '0.82rem', fontWeight: 800 }}>
                                    현재 게스트 임시 ID: {user.loginId}
                                </div>
                            ) : null}
                            {guestMergePreview?.examTitles.length ? (
                                <div style={{ marginTop: '0.45rem', color: 'var(--muted)', fontSize: '0.82rem', fontWeight: 700 }}>
                                    최근 기록: {guestMergePreview.examTitles.join(", ")}
                                </div>
                            ) : null}
                        </div>
                        <button
                            onClick={handleConnectStudentAccount}
                            className="btn btn-primary"
                            style={{
                                fontWeight: 700,
                                padding: '0.75rem 1.5rem', fontSize: '0.95rem',
                                flexShrink: 0
                            }}
                        >
                            학생 로그인으로 저장
                        </button>
                    </div>
                )}

                {!user.isGuest && guestMergePreview && (
                    <div style={{
                        margin: '2rem 0 1rem', padding: '1.5rem',
                        background: 'linear-gradient(135deg, rgba(99,102,241,0.08), rgba(16,185,129,0.07))',
                        borderRadius: 'var(--radius-lg)', color: 'var(--foreground)',
                        border: '1px solid rgba(99,102,241,0.18)', borderLeft: '4px solid var(--success)',
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        gap: '1rem', flexWrap: 'wrap',
                        boxShadow: 'var(--shadow-sm)'
                    }}>
                        <div>
                            <h3 style={{ fontSize: '1.1rem', fontWeight: 800, marginBottom: '0.25rem' }}>
                                연결하지 않은 게스트 기록 {guestMergePreview.mergeableCount}건
                            </h3>
                            <p style={{ color: 'var(--muted)', fontSize: '0.92rem', lineHeight: 1.6, wordBreak: "keep-all" }}>
                                같은 기기에서 게스트로 제출한 시험 기록을 현재 학생 계정에 합칠 수 있습니다.
                            </p>
                            {guestMergePreview.examTitles.length > 0 && (
                                <div style={{ marginTop: '0.4rem', color: 'var(--muted)', fontSize: '0.8rem', fontWeight: 700 }}>
                                    대상: {guestMergePreview.examTitles.join(", ")}
                                </div>
                            )}
                        </div>
                        <button
                            type="button"
                            onClick={() => void handleMergeGuestIntoCurrentStudent()}
                            className="btn btn-primary"
                            style={{ fontWeight: 800, padding: '0.72rem 1.25rem', fontSize: '0.9rem', flexShrink: 0 }}
                        >
                            지금 연결
                        </button>
                    </div>
                )}

                {/* Welcome */}
                <div style={{ margin: '3rem 0' }}>
                    <div style={{
                        display: 'inline-flex', alignItems: 'center', gap: '0.5rem',
                        fontSize: '0.8rem', fontWeight: 700, letterSpacing: '0.04em',
                        color: 'var(--muted)', marginBottom: '0.5rem'
                    }}>
                        <Sparkles size={14} color="var(--primary)" />
                        {getTimeGreeting()}
                    </div>
                    <h1 className="title-gradient" style={{ fontSize: '2.5rem', marginBottom: '0.75rem', lineHeight: 1.2 }}>
                        {user.name}님,
                    </h1>
                    <p className="text-muted" style={{ fontSize: '1.1rem' }}>
                        {todoExams.length > 0 ? (
                            <>오늘 <strong style={{ color: 'var(--primary)', fontWeight: 700 }}>{todoExams.length}개</strong>의 시험이 기다리고 있어요.</>
                        ) : (
                            <>오늘은 예정된 시험이 없습니다. 편안한 하루 보내세요.</>
                        )}
                    </p>
                </div>

                {/* Dashboard Grid */}
                <div className="bento-grid">
                    {/* Stats */}
                    <Link href="/student/history" className="bento-card col-span-1 card-hover" style={{
                        background: 'linear-gradient(135deg, var(--secondary), #f472b6)',
                        color: 'white', border: 'none',
                        display: 'flex', flexDirection: 'column', justifyContent: 'center'
                    }}>
                        <div style={{ fontSize: '0.95rem', fontWeight: 600, opacity: 0.9, marginBottom: '0.5rem' }}>나의 원시험 평균</div>
                        <div style={{ fontSize: '3rem', fontWeight: 800, lineHeight: 1 }}>
                            {stats.avgScore}<span style={{ fontSize: '1.5rem', fontWeight: 700, opacity: 0.85 }}>%</span>
                        </div>
                        <div style={{ fontSize: '0.85rem', opacity: 0.8, marginTop: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            상세 보기 <span>→</span>
                        </div>
                    </Link>

                    <div className="bento-card col-span-1" style={{ justifyContent: 'center', alignItems: 'center', background: 'var(--surface)', position: 'relative', overflow: 'hidden' }}>
                        <Award size={22} color="var(--primary)" style={{ position: 'absolute', top: 16, right: 16, opacity: 0.6 }} />
                        <div style={{ fontSize: '3rem', fontWeight: 800, color: 'var(--foreground)', lineHeight: 1, marginBottom: '0.5rem' }}>
                            {stats.completedCount}
                        </div>
                        <div style={{ color: 'var(--muted)', fontSize: '0.9rem', fontWeight: 600 }}>완료한 원시험</div>
                        {stats.retakeCount > 0 && (
                            <div style={{ marginTop: '0.5rem', color: '#0f766e', background: '#f0fdfa', border: '1px solid #99f6e4', borderRadius: '999px', padding: '0.2rem 0.55rem', fontSize: 'var(--type-caption)', fontWeight: 800 }}>
                                재시험 {stats.retakeCount}회
                            </div>
                        )}
                    </div>

                    {/* Todo List (Main Focus) */}
                    <div className="col-span-2 row-span-2">
                        <AssignmentBlock type="todo" exams={todoExams} />
                    </div>

                    {/* Completed List */}
                    <div className="col-span-2">
                        <AssignmentBlock type="done" exams={doneExams} />
                    </div>
                </div>
            </main>
        </div>
    );
}
