"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import BrandLogo from "@/components/BrandLogo";
import { Exam } from "@/types/omr";
import AssignmentBlock from "@/components/dashboard/AssignmentBlock";
import { createDashboardRevalidationGate, isStudentDashboardStorageKey } from "@/components/dashboard/dashboardRevalidation";
import ThemeToggle from "@/components/ThemeToggle";
import StudentGuestRecoveryPanel from "@/components/StudentGuestRecoveryPanel";
import { toast } from "@/components/Toast";
import { AlertTriangle, Award, LogIn, RefreshCw } from "lucide-react";

import {
    attemptBelongsToSession,
    clearSession,
    getSession,
    previewGuestMerge,
    queueGuestMerge,
    saveSession,
    type GuestMergePreview,
    type StudentSession,
} from "@/utils/storage";
import { readLocalAttempts, readLocalExams } from "@/lib/omrPersistence";
import { safeScorePercent } from "@/lib/scoreUtils";
import { evaluateExamAccess } from "@/lib/examAccess";
import { listMyAssignments } from "@/app/actions/studentExam";
import { clearStudentServerSession, refreshStudentSession } from "@/app/actions/studentSession";
import { listMyAssignmentsClient } from "@/lib/studentExamClient";
import type { StudentAssignmentPreview, StudentAttemptSummary } from "@/lib/studentExamContract";
import { findCompletedAttemptForAssignment } from "@/lib/studentAssignmentClassification";
import { loadStudentReturnedFeedbackWithDevFallback } from "@/lib/studentFeedbackClient";
import {
    INITIAL_CAPACITY_REMEDIATION_KO,
    INITIAL_FEEDBACK_CAPACITY_REMEDIATION_KO,
} from "@/lib/initialOperationsPolicy";

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

type DashboardDataState = "loading" | "ready" | "error";
type DashboardAssignment = (Exam | StudentAssignmentPreview) & { hasLocalDraft?: boolean };

export default function StudentDashboard() {
    const router = useRouter();
    const [user, setUser] = useState<StudentSession | null>(null);
    const [todoExams, setTodoExams] = useState<DashboardAssignment[]>([]);
    const [doneExams, setDoneExams] = useState<Array<(Exam | StudentAssignmentPreview) & { attemptId: string; hasUnreadFeedback?: boolean; answeredQuestionCount?: number }>>([]);
    const [stats, setStats] = useState({
        avgScore: 0,
        completedCount: 0,
        retakeCount: 0,
    });
    const [sessionState, setSessionState] = useState<"checking" | "active" | "missing" | "error">("checking");
    const [guestMergePreview, setGuestMergePreview] = useState<GuestMergePreview | null>(null);
    const [refreshKey, setRefreshKey] = useState(0);
    const [logoutPending, setLogoutPending] = useState(false);
    const [dataState, setDataState] = useState<DashboardDataState>("loading");
    const [dataError, setDataError] = useState("");
    const [feedbackSyncError, setFeedbackSyncError] = useState("");
    const [accountConnectionNotice, setAccountConnectionNotice] = useState("");
    const [accountConnectionPending, setAccountConnectionPending] = useState(false);

    useEffect(() => {
        let cancelled = false;
        const failDataLoad = (message: string) => {
            if (cancelled) return;
            setTodoExams([]);
            setDoneExams([]);
            setStats({ avgScore: 0, completedCount: 0, retakeCount: 0 });
            setGuestMergePreview(null);
            setDataError(message);
            setDataState("error");
        };
        const loadStudentData = async () => {
            setDataState("loading");
            setDataError("");
            setFeedbackSyncError("");
            // 1. Rebuild the client view from the signed HttpOnly cookie when
            // sessionStorage is empty (new tab, storage eviction, private mode).
            let currentUser = getSession();
            if (!currentUser) {
                try {
                    const restored = await refreshStudentSession();
                    if (cancelled) return;
                    if (!restored.ok || !restored.session) {
                        setGuestMergePreview(null);
                        if (restored.status === "unauthenticated") {
                            setUser(null);
                            setSessionState("missing");
                        } else {
                            setSessionState("error");
                            failDataLoad("학생 세션을 확인하지 못했습니다. 네트워크를 확인한 뒤 다시 시도해주세요.");
                        }
                        return;
                    }
                    currentUser = restored.session;
                    saveSession(currentUser);
                } catch {
                    if (cancelled) return;
                    setSessionState("error");
                    failDataLoad("학생 세션을 확인하지 못했습니다. 네트워크를 확인한 뒤 다시 시도해주세요.");
                    return;
                }
            }
            if (cancelled) return;
            setUser(currentUser);
            setSessionState("active");

            // 2. Load Data — own attempts come from the server boundary
            // (ownership enforced by the signed session cookie); local list is
            // the degraded fallback and keeps the client-side ownership filter.
            const myAttemptsResult = await listMyAssignmentsClient({
                server: () => listMyAssignments(),
                localFallback: async () => readLocalAttempts()
                    .filter(attempt => attemptBelongsToSession(attempt, currentUser)),
            });
            if (cancelled) return;
            if (myAttemptsResult.status === "unauthenticated") {
                clearSession();
                setUser(null);
                setSessionState("missing");
                return;
            }
            if (myAttemptsResult.status !== "ok") {
                failDataLoad(
                    myAttemptsResult.error === "initial_capacity_exceeded"
                        ? INITIAL_CAPACITY_REMEDIATION_KO
                        : "배정된 시험과 제출 기록을 불러오지 못했습니다. 네트워크 연결과 이 기기의 저장공간을 확인한 뒤 다시 시도해주세요.",
                );
                return;
            }

            const localExams = myAttemptsResult.source === "local" ? readLocalExams() : [];
            const allExams: Array<Exam | StudentAssignmentPreview> = myAttemptsResult.source === "server"
                ? myAttemptsResult.exams || []
                : localExams;
            const attemptSource = myAttemptsResult.source;
            const myAttempts: StudentAttemptSummary[] = myAttemptsResult.attempts;

            const myBaseAttempts = myAttempts.filter(attempt => !attempt.retakeSourceAttemptId);
            const myRetakeAttempts = myAttempts.filter(attempt => !!attempt.retakeSourceAttemptId);
            const returnedFeedbackResult = currentUser.isGuest
                ? { status: "loaded" as const, items: [] }
                : await loadStudentReturnedFeedbackWithDevFallback(currentUser.studentId);
            if (cancelled) return;
            if (returnedFeedbackResult.status === "capacity_exceeded") {
                failDataLoad(INITIAL_FEEDBACK_CAPACITY_REMEDIATION_KO);
                return;
            }
            if (returnedFeedbackResult.status === "unauthorized") {
                clearSession();
                setUser(null);
                setSessionState("missing");
                return;
            }
            if (returnedFeedbackResult.status === "service_unavailable") {
                setFeedbackSyncError(returnedFeedbackResult.error);
            }
            const returnedFeedback = returnedFeedbackResult.status === "loaded"
                ? returnedFeedbackResult.items
                : [];
            const unreadFeedbackAttemptIds = new Set(
                returnedFeedback
                    .filter(feedback => !feedback.delivery.firstOpenedAt)
                    .map(feedback => feedback.attemptId),
            );
            const guestIdForMerge = currentUser.isGuest ? currentUser.guestId : undefined;
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
            const done: Array<(Exam | StudentAssignmentPreview) & { attemptId: string; hasUnreadFeedback?: boolean; answeredQuestionCount?: number }> = [];
            const todo: DashboardAssignment[] = [];

            allExams.forEach(exam => {
                const hasAccess = attemptSource === "server" || (() => {
                    const access = evaluateExamAccess(exam as Exam, { session: currentUser });
                    return access.status === "allowed" || access.status === "pin_required";
                })();

                if (!hasAccess) return;

                // Check if completed
                const attempt = findCompletedAttemptForAssignment(exam, myAttempts);
                const hasLocalDraft = hasLocalDraftFor(exam.id, currentUser.studentId || "");
                if (attempt) {
                    done.push({
                        ...exam,
                        attemptId: attempt.id,
                        hasUnreadFeedback: unreadFeedbackAttemptIds.has(attempt.id),
                        answeredQuestionCount: attempt.answeredQuestionCount,
                    });
                } else if (
                    // Guests on the server path only see exams they actually
                    // started (submitted or drafted on this device) — the public
                    // exam catalog is not broadcast to anonymous identities.
                    !(currentUser.isGuest && attemptSource === "server")
                    || hasLocalDraft
                ) {
                    todo.push({ ...exam, hasLocalDraft });
                }
            });

            setTodoExams(todo);
            setDoneExams(done);

            // 4. Calculate Stats
            const avg = myBaseAttempts.length === 0
                ? 0
                : Math.round(myBaseAttempts.reduce((total, attempt) => (
                    total + safeScorePercent(attempt.score, attempt.totalScore)
                ), 0) / myBaseAttempts.length);
            setStats({
                avgScore: avg,
                completedCount: myBaseAttempts.length,
                retakeCount: myRetakeAttempts.length,
            });
            setGuestMergePreview(mergePreview && mergePreview.mergeableCount > 0 ? mergePreview : null);

            // Preserve teacher-answer arrival notifications without transferring
            // question ids or either side's free-text bodies in this list call.
            if (!currentUser.isGuest) {
                try {
                    const seenKey = "omr_student_seen_answer_summaries_v2";
                    const currentKeys = myBaseAttempts
                        .filter(attempt => !!attempt.latestAnsweredAt)
                        .map(attempt => `${attempt.id}:${attempt.answeredQuestionCount || 0}:${attempt.latestAnsweredAt}`);
                    const raw = localStorage.getItem(seenKey);
                    if (raw === null) {
                        localStorage.setItem(seenKey, JSON.stringify(currentKeys));
                    } else {
                        let seen: string[] = [];
                        try {
                            const parsed = JSON.parse(raw);
                            if (Array.isArray(parsed)) seen = parsed.filter(item => typeof item === "string");
                        } catch { /* reset an unreadable baseline below */ }
                        const seenSet = new Set(seen);
                        const changedAttemptCount = currentKeys.filter(key => !seenSet.has(key)).length;
                        if (changedAttemptCount > 0) {
                            toast.success(
                                "선생님 답변 도착",
                                `${changedAttemptCount}개 시험의 질문 답변이 업데이트됐어요. 완료 기록에서 복습하세요.`,
                            );
                        }
                        localStorage.setItem(seenKey, JSON.stringify(currentKeys));
                    }
                } catch { /* storage unavailable — the scalar badge still surfaces answers */ }
            }
            setDataState("ready");
        };

        void loadStudentData().catch(() => {
            failDataLoad(
                "학습 현황을 구성하는 중 문제가 발생했습니다. 네트워크 연결과 이 기기의 저장공간을 확인한 뒤 다시 시도해주세요.",
            );
        });
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

    const handleConnectStudentAccount = async () => {
        if (accountConnectionPending) return;
        setAccountConnectionPending(true);
        setAccountConnectionNotice("");
        if (user?.guestId) {
            const queued = queueGuestMerge(user.guestId);
            if (queued) {
                toast.info(
                    "학생 로그인으로 연결",
                    "이름과 반으로 로그인하면 이 기기의 게스트 기록을 학생 기록에 합칩니다."
                );
            } else {
                toast.error("연결 준비 실패", "브라우저 저장공간을 확인한 뒤 다시 시도해주세요.");
                setAccountConnectionPending(false);
                return;
            }
        }
        try {
            const restored = await refreshStudentSession();
            if (restored.ok && restored.canLoginWithCurrentScope) {
                router.push("/?role=student&connectGuest=1");
                return;
            }
        } catch {
            // The persistent guidance below is safer than falling through to a
            // login page that cannot establish organization scope.
        }
        setAccountConnectionNotice(
            "학생 초대 링크가 필요합니다. 선생님이 보낸 최신 초대 링크를 이 기기에서 연 뒤 이름과 시작 코드로 로그인해주세요.",
        );
        setAccountConnectionPending(false);
    };

    const handleDashboardRetry = () => {
        setSessionState("checking");
        setDataError("");
        setDataState("loading");
        setRefreshKey(key => key + 1);
    };

    const handleLogout = async () => {
        if (logoutPending) return;
        setLogoutPending(true);
        try {
            // A local-only logout leaves the HttpOnly cookie active on shared
            // devices, so confirm the server boundary before clearing the UI.
            const logoutResult = await clearStudentServerSession();
            if (!logoutResult.ok) {
                toast.error("로그아웃하지 못했습니다", "페이지를 새로고침한 뒤 다시 시도해주세요.");
                setLogoutPending(false);
                return;
            }
        } catch {
            toast.error("로그아웃하지 못했습니다", "네트워크를 확인한 뒤 다시 시도해주세요.");
            setLogoutPending(false);
            return;
        }
        clearSession();
        setUser(null);
        setTodoExams([]);
        setDoneExams([]);
        setStats({ avgScore: 0, completedCount: 0, retakeCount: 0 });
        setGuestMergePreview(null);
        setSessionState("missing");
        setDataError("");
        setDataState("loading");
        toast.info("로그아웃됨", "다시 시험을 보려면 학생 로그인이 필요합니다.");
        router.replace("/");
    };

    if (!user) {
        const checking = sessionState === "checking";
        const sessionError = sessionState === "error";
        return (
            <div className="layout-main">
                <header className="header">
                    <div className="container header-content" style={{ gap: "1rem", flexWrap: "wrap" }}>
                        <BrandLogo />
                        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                            <Link href="/" className="btn" style={{ padding: "0.55rem 0.95rem", fontSize: "0.88rem" }}>
                                홈
                            </Link>
                            <ThemeToggle />
                        </div>
                    </div>
                </header>

                <main className="container animate-fade-in" style={{ padding: "4rem 1rem", maxWidth: 760 }}>
                    <section
                        className="bento-card mobile-section-stack"
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
                                {checking
                                    ? "학생 정보를 불러오는 중입니다"
                                    : sessionError
                                        ? "학생 정보를 확인하지 못했습니다"
                                        : "학생 로그인이 필요합니다"}
                            </h1>
                            <p className="text-muted" style={{ lineHeight: 1.7, wordBreak: "keep-all" }}>
                                {checking
                                    ? "잠시만 기다려주세요."
                                    : sessionError
                                        ? "네트워크를 확인한 뒤 다시 시도해주세요."
                                        : "선생님이 보낸 최신 초대 링크를 열고 이름과 시작 코드로 로그인해주세요."}
                            </p>
                        </div>
                        {sessionError && (
                            <button type="button" className="btn btn-primary" onClick={handleDashboardRetry}>
                                다시 시도
                            </button>
                        )}
                        {!checking && !sessionError && <Link href="/" className="btn btn-primary">홈으로 이동</Link>}
                    </section>
                </main>
            </div>
        );
    }

    return (
        <div className="layout-main">
            <header className="header student-dashboard-shell-header">
                <div className="container header-content student-dashboard-header" style={{ gap: "1rem", flexWrap: "wrap" }}>
                    <div className="student-dashboard-brand" style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                        <BrandLogo />
                    </div>
                    <div className="student-dashboard-identity" style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                        <span className="student-dashboard-user" style={{ fontWeight: 600, fontSize: '0.95rem', display: 'inline-flex', alignItems: 'center', gap: '0.45rem', flexWrap: 'wrap' }}>
                            <span className="student-dashboard-user-name" title={`${user.name} (${user.groupName})`}>
                                {user.name}{' '}
                                <span className={`student-dashboard-group-label${user.isGuest ? " is-redundant" : ""}`} style={{ color: 'var(--muted)', fontWeight: 400 }}>
                                    ({user.groupName})
                                </span>
                            </span>
                        </span>
                        <div className="student-dashboard-controls">
                            <button
                                onClick={handleLogout}
                                disabled={logoutPending}
                                aria-busy={logoutPending}
                                style={{
                                    minHeight: '2.75rem',
                                    padding: '0.45rem 0.2rem',
                                    borderRadius: 'var(--radius-md)',
                                    fontSize: '0.9rem',
                                    color: 'var(--muted)',
                                    cursor: logoutPending ? 'wait' : 'pointer',
                                    transition: 'color 0.2s',
                                    fontWeight: 500,
                                }}
                            >
                                {logoutPending ? '로그아웃 중…' : '로그아웃'}
                            </button>
                            <ThemeToggle />
                        </div>
                    </div>
                </div>
            </header>

            <main className="container animate-fade-in" style={{ paddingBottom: '4rem' }}>
                {dataState === "loading" && (
                    <section
                        data-testid="student-dashboard-loading"
                        role="status"
                        aria-live="polite"
                        aria-atomic="true"
                        aria-busy="true"
                        className="bento-card mobile-section-stack"
                        style={{
                            maxWidth: 760,
                            minHeight: 0,
                            margin: "3rem auto 0",
                            padding: "2rem",
                            alignItems: "flex-start",
                            gap: "0.85rem",
                        }}
                    >
                        <RefreshCw size={24} color="var(--primary)" aria-hidden="true" />
                        <div>
                            <h1 style={{ fontSize: "1.55rem", fontWeight: 800, marginBottom: "0.45rem" }}>
                                학습 현황을 불러오는 중입니다
                            </h1>
                            <p className="text-muted" style={{ lineHeight: 1.7 }}>
                                배정된 시험과 제출 기록을 확인하고 있습니다.
                            </p>
                        </div>
                    </section>
                )}

                {dataState === "error" && (
                    <section
                        data-testid="student-dashboard-error"
                        role="status"
                        aria-live="polite"
                        aria-atomic="true"
                        className="bento-card"
                        style={{
                            maxWidth: 760,
                            minHeight: 0,
                            margin: "3rem auto 0",
                            padding: "2rem",
                            alignItems: "flex-start",
                            gap: "1rem",
                            borderColor: "rgba(245, 158, 11, 0.35)",
                        }}
                    >
                        <div style={{
                            width: 48,
                            height: 48,
                            display: "grid",
                            placeItems: "center",
                            borderRadius: "var(--radius-md)",
                            color: "#b45309",
                            background: "rgba(245, 158, 11, 0.12)",
                        }}>
                            <AlertTriangle size={24} aria-hidden="true" />
                        </div>
                        <div>
                            <h1 style={{ fontSize: "1.55rem", fontWeight: 800, marginBottom: "0.45rem" }}>
                                학습 현황을 불러오지 못했습니다
                            </h1>
                            <p className="text-muted" style={{ lineHeight: 1.7, wordBreak: "keep-all" }}>
                                {dataError}
                            </p>
                        </div>
                        <div className="mobile-action-row" style={{ gap: "0.75rem" }}>
                            <button
                                type="button"
                                data-testid="student-dashboard-retry"
                                className="btn btn-primary"
                                onClick={handleDashboardRetry}
                            >
                                다시 시도
                            </button>
                            <Link href="/" className="btn">
                                로그인 안내
                            </Link>
                            <Link href="/" className="btn">
                                홈으로
                            </Link>
                        </div>
                    </section>
                )}

                {dataState === "ready" && (
                    <>
                {feedbackSyncError && (
                    <section
                        data-testid="student-feedback-sync-error"
                        role="alert"
                        className="bento-card mobile-section-stack"
                        style={{
                            marginTop: "1.5rem",
                            minHeight: 0,
                            padding: "1rem 1.25rem",
                            borderColor: "rgba(245, 158, 11, 0.35)",
                            alignItems: "flex-start",
                            gap: "0.75rem",
                        }}
                    >
                        <div>
                            <strong>피드백 알림을 불러오지 못했습니다</strong>
                            <p className="text-muted" style={{ marginTop: "0.35rem", lineHeight: 1.6 }}>
                                시험 목록은 표시하지만 새 피드백 표시는 최신 상태가 아닐 수 있습니다. 네트워크를 확인한 뒤 다시 시도해주세요.
                            </p>
                        </div>
                        <button type="button" className="btn" onClick={handleDashboardRetry}>
                            알림 다시 불러오기
                        </button>
                    </section>
                )}
                {!user.isGuest && <StudentGuestRecoveryPanel />}

                {/* Guest Banner */}
                {user.isGuest && (
                    <details className="student-guest-merge-disclosure">
                        <summary>
                            <span>
                                <strong>게스트 기록 저장하기</strong>
                                <small>학생 로그인에 현재 기록을 연결합니다.</small>
                            </span>
                            <span aria-hidden="true">열기</span>
                        </summary>
                        <div className="student-guest-merge-content">
                            <div>
                                <h3>게스트 기록을 학생 기록으로 저장</h3>
                                <p style={{ color: 'var(--muted)', fontSize: '0.95rem', lineHeight: 1.6, wordBreak: "keep-all" }}>
                                    이름과 반으로 로그인하면 지금 기기에서 푼 게스트 기록
                                    {guestMergePreview ? ` ${guestMergePreview.mergeableCount}건` : ""}을 같은 학생 기록에 연결합니다.
                                </p>
                                {user.loginId ? (
                                    <div className="student-dashboard-login-id" style={{ marginTop: '0.45rem', color: 'var(--primary)', fontSize: '0.82rem', fontWeight: 800 }}>
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
                                onClick={() => { void handleConnectStudentAccount(); }}
                                className="btn btn-primary"
                                disabled={accountConnectionPending}
                                style={{
                                    fontWeight: 700,
                                    padding: '0.75rem 1.5rem', fontSize: '0.95rem',
                                    flexShrink: 0
                                }}
                            >
                                {accountConnectionPending ? "연결 확인 중…" : "학생 로그인으로 저장"}
                            </button>
                        </div>
                        {accountConnectionNotice && (
                            <p role="status" style={{ margin: "0.75rem 0 0", color: "var(--text-warning)", lineHeight: 1.6 }}>
                                {accountConnectionNotice}
                            </p>
                        )}
                    </details>
                )}

                {/* Welcome */}
                <div className="student-dashboard-welcome mobile-section-stack" style={{ margin: '3rem 0' }}>
                    <h1 className="title-gradient" title={`${user.name}님`} style={{ fontSize: '2.5rem', marginBottom: '0.75rem', lineHeight: 1.2 }}>
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
                <div className={`bento-grid student-dashboard-grid student-dashboard-task-flow${stats.completedCount === 0 ? " is-zero-completions" : ""}`}>
                    {/* Todo List (Main Focus) */}
                    <div className="col-span-2 row-span-2 student-dashboard-primary-task">
                        <AssignmentBlock type="todo" exams={todoExams} />
                    </div>

                    {/* Stats */}
                    <Link href="/student/history" className="bento-card col-span-1 card-hover student-dashboard-average-card student-dashboard-history-action" style={{
                        background: 'linear-gradient(135deg, var(--secondary), #f472b6)',
                        color: 'white', border: 'none',
                        display: 'flex', flexDirection: 'column', justifyContent: 'center'
                    }}>
                        <div style={{ fontSize: '0.95rem', fontWeight: 600, opacity: 0.9, marginBottom: '0.5rem' }}>나의 원시험 평균</div>
                        <div style={{ fontSize: '3rem', fontWeight: 800, lineHeight: 1 }}>
                            {stats.avgScore}<span style={{ fontSize: '1.5rem', fontWeight: 700, opacity: 0.85 }}>%</span>
                        </div>
                    </Link>

                    {stats.completedCount > 0 && <div className="bento-card col-span-1 student-dashboard-secondary-status" style={{ justifyContent: 'center', alignItems: 'center', background: 'var(--surface)', position: 'relative', overflow: 'hidden' }}>
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
                    </div>}

                    {/* Completed List */}
                    <div className="col-span-2 student-dashboard-completed-task">
                        <AssignmentBlock type="done" exams={doneExams} />
                    </div>
                </div>
                    </>
                )}
            </main>
        </div>
    );
}
