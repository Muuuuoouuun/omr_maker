"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import BrandLogo from "@/components/BrandLogo";
import { Exam } from "@/types/omr";
import AssignmentBlock from "@/components/dashboard/AssignmentBlock";
import { useMonotonicAssignmentTime, type AssignmentServerClock } from "@/components/dashboard/useAssignmentClock";
import { presentTodoAssignments, summarizeTodoHeadline } from "@/lib/studentAssignmentPresentation";
import { recordSolveEntryIntentForPath } from "@/lib/solveEntryIntent";
import { displayStudentName } from "@/lib/guestIdentity";
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
import { buildStudentLoginHref } from "@/lib/studentRedirect";
import { clearStudentReturnHint, refreshStudentReturnHint } from "@/lib/studentReturnHint";
import { listMyAssignmentsClient } from "@/lib/studentExamClient";
import type { StudentAssignmentPreview, StudentAttemptSummary } from "@/lib/studentExamContract";
import {
    assignmentAttemptScopeKey,
    buildMissingCompletedReviewAssignments,
    findCompletedAttemptForAssignment,
    findInProgressAttemptForAssignment,
    localStudentAssignmentPreview,
    studentAssignmentDraftStorageKey,
    type ReviewOnlyCompletedAssignment,
} from "@/lib/studentAssignmentClassification";
import { loadStudentReturnedFeedbackWithDevFallback } from "@/lib/studentFeedbackClient";
import { resolveCanonicalLoad, type CanonicalLoadState } from "@/lib/canonicalLoadState";
import {
    INITIAL_CAPACITY_REMEDIATION_KO,
    INITIAL_FEEDBACK_CAPACITY_REMEDIATION_KO,
} from "@/lib/initialOperationsPolicy";

/** True only for the exact immutable assignment generation displayed. */
function hasLocalDraftFor(exam: Exam | StudentAssignmentPreview, ownerKey: string): boolean {
    if (typeof window === "undefined" || !ownerKey) return false;
    try {
        const assignment = "assignmentId" in exam ? exam : {};
        const retakeSegment = "assignmentMode" in exam && exam.assignmentMode === "retake"
            ? [
                "retake",
                encodeURIComponent(exam.retakeSourceAttemptId || "source"),
                "wrong",
                [...new Set(exam.retakeQuestionIds || [])].sort((a, b) => a - b).join("-") || "questions",
            ].join("_")
            : "base";
        const key = studentAssignmentDraftStorageKey(exam.id, ownerKey, assignment, retakeSegment);
        if (!key) return false;
        const parsed = JSON.parse(window.localStorage.getItem(key) || "null") as { scopeBinding?: unknown } | null;
        return parsed?.scopeBinding === key;
    } catch {
        // storage blocked — treat as no draft
    }
    return false;
}

type DashboardAssignment = (Exam | StudentAssignmentPreview) & {
    hasLocalDraft?: boolean;
    hasRemoteProgress?: boolean;
};
type DashboardCompletedAssignment = (Exam | StudentAssignmentPreview | ReviewOnlyCompletedAssignment) & {
    attemptId: string;
    /** When the completed attempt was submitted — shown as "완료 · 10/1 제출". */
    finishedAt?: string;
    hasUnreadFeedback?: boolean;
    answeredQuestionCount?: number;
};
type StudentDashboardSnapshot = {
    todoExams: DashboardAssignment[];
    doneExams: DashboardCompletedAssignment[];
};
const STUDENT_DASHBOARD_CACHE_STALE_AT_KEY = "omr_student_dashboard_cache_stale_at_v1";

export default function StudentDashboard() {
    const router = useRouter();
    const [user, setUser] = useState<StudentSession | null>(null);
    const [todoExams, setTodoExams] = useState<DashboardAssignment[]>([]);
    const [doneExams, setDoneExams] = useState<DashboardCompletedAssignment[]>([]);
    const [assignmentServerNow, setAssignmentServerNow] = useState("");
    const [assignmentServerClock, setAssignmentServerClock] = useState<{
        serverNow: string;
        requestStartedMonotonicMs: number;
        receivedMonotonicMs: number;
    }>();
    const [stats, setStats] = useState({
        avgScore: 0,
        completedCount: 0,
        retakeCount: 0,
    });
    // "expired": this device had a student session but the 12h server cookie
    // is gone. "missing": there was never a session here (or the student logged out).
    const [sessionState, setSessionState] = useState<"checking" | "active" | "missing" | "expired" | "error">("checking");
    const [expiredReturnPath, setExpiredReturnPath] = useState("/student/dashboard");
    const [expiredRecheckPending, setExpiredRecheckPending] = useState(false);
    const [guestMergePreview, setGuestMergePreview] = useState<GuestMergePreview | null>(null);
    const [refreshKey, setRefreshKey] = useState(0);
    const [logoutPending, setLogoutPending] = useState(false);
    const [dataState, setDataState] = useState<CanonicalLoadState<StudentDashboardSnapshot>>({ state: "loading" });
    const [dataError, setDataError] = useState("");
    const [feedbackSyncError, setFeedbackSyncError] = useState("");
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
            setDataState(resolveCanonicalLoad({
                remote: { ok: false },
                cache: null,
                now: new Date().toISOString(),
            }, data => data.todoExams.length === 0 && data.doneExams.length === 0));
        };
        // The server rejected a session this device still remembered: keep the
        // opt-in return hint in sync, then drop the stale local identity.
        const endRejectedSession = (session: StudentSession, localSessionExisted: boolean) => {
            if (cancelled) return;
            if (localSessionExisted) refreshStudentReturnHint(session);
            clearSession();
            setUser(null);
            setExpiredReturnPath(`${window.location.pathname}${window.location.search}`);
            setSessionState(localSessionExisted ? "expired" : "missing");
        };
        const loadStudentData = async () => {
            const loadObservedAt = new Date().toISOString();
            setDataState({ state: "loading" });
            setDataError("");
            setFeedbackSyncError("");
            // 1. Rebuild the client view from the signed HttpOnly cookie when
            // sessionStorage is empty (new tab, storage eviction, private mode).
            let currentUser = getSession();
            const localSessionExisted = !!currentUser;
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
                endRejectedSession(currentUser, localSessionExisted);
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
                endRejectedSession(currentUser, localSessionExisted);
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
            const done: DashboardCompletedAssignment[] = [];
            const todo: DashboardAssignment[] = [];
            const visibleAssignmentScopes = new Set<string>();
            const classifiedAt = myAttemptsResult.serverNow || loadObservedAt;

            allExams.forEach(rawExam => {
                const hasAccess = attemptSource === "server" || (() => {
                    const access = evaluateExamAccess(rawExam as Exam, { session: currentUser });
                    return access.status === "allowed"
                        || access.status === "pin_required"
                        || access.status === "not_started"
                        || access.status === "ended"
                        || access.status === "archived";
                })();

                if (!hasAccess) return;
                const exam = attemptSource === "server"
                    ? rawExam
                    : localStudentAssignmentPreview(rawExam as Exam, loadObservedAt);
                visibleAssignmentScopes.add(assignmentAttemptScopeKey(exam));

                // Check if completed
                const attempt = findCompletedAttemptForAssignment(exam, myAttempts);
                const inProgressAttempt = findInProgressAttemptForAssignment(exam, myAttempts);
                const hasLocalDraft = hasLocalDraftFor(exam, currentUser.studentId || "");
                if (attempt) {
                    done.push({
                        ...exam,
                        attemptId: attempt.id,
                        finishedAt: attempt.finishedAt,
                        hasUnreadFeedback: unreadFeedbackAttemptIds.has(attempt.id),
                        answeredQuestionCount: attempt.answeredQuestionCount,
                    });
                } else if (
                    // Guests on the server path only see exams they actually
                    // started (submitted or drafted on this device) — the public
                    // exam catalog is not broadcast to anonymous identities.
                    !(currentUser.isGuest && attemptSource === "server")
                    || hasLocalDraft
                    || !!inProgressAttempt
                ) {
                    todo.push({ ...exam, hasLocalDraft, hasRemoteProgress: !!inProgressAttempt });
                }
            });

            const finishedAtByAttemptId = new Map(myAttempts.map(attempt => [attempt.id, attempt.finishedAt]));
            done.push(...buildMissingCompletedReviewAssignments(visibleAssignmentScopes, myAttempts).map(review => ({
                ...review,
                finishedAt: finishedAtByAttemptId.get(review.attemptId),
                hasUnreadFeedback: unreadFeedbackAttemptIds.has(review.attemptId),
            })));

            setTodoExams(todo);
            setDoneExams(done);
            setAssignmentServerNow(classifiedAt);
            setAssignmentServerClock(myAttemptsResult.serverClock || {
                serverNow: classifiedAt,
                requestStartedMonotonicMs: performance.now(),
                receivedMonotonicMs: performance.now(),
            });

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

            const snapshot: StudentDashboardSnapshot = { todoExams: todo, doneExams: done };
            const isEmpty = (data: StudentDashboardSnapshot) => data.todoExams.length === 0 && data.doneExams.length === 0;
            if (myAttemptsResult.remoteFailed !== true) {
                const nextState = resolveCanonicalLoad({
                    remote: { ok: true, data: snapshot },
                    cache: null,
                    now: loadObservedAt,
                }, isEmpty);
                setDataState(nextState);
                if (attemptSource === "server") {
                    try { localStorage.setItem(STUDENT_DASHBOARD_CACHE_STALE_AT_KEY, loadObservedAt); } catch { /* cache remains optional */ }
                }
            } else {
                let staleAt: string | null = null;
                try { staleAt = localStorage.getItem(STUDENT_DASHBOARD_CACHE_STALE_AT_KEY); } catch { /* fail closed below */ }
                const nextState = resolveCanonicalLoad({
                    remote: { ok: false },
                    cache: staleAt ? { data: snapshot, staleAt } : null,
                    now: loadObservedAt,
                }, isEmpty);
                if (nextState.state === "error_without_cache") {
                    failDataLoad("서버 학습 현황을 확인하지 못했고 이 기기에 검증된 저장 시각이 없습니다. 네트워크를 확인한 뒤 다시 시도해주세요.");
                    return;
                }
                setDataState(nextState);
            }

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

    const refreshAssignmentClock = useCallback(() => setRefreshKey(current => current + 1), []);

    const handleConnectStudentAccount = async () => {
        if (accountConnectionPending) return;
        setAccountConnectionPending(true);
        if (user?.guestId) {
            const queued = queueGuestMerge(user.guestId);
            if (queued) {
                toast.info(
                    "학생 로그인으로 연결",
                    "학생 계정으로 로그인하면 이 기기의 확인된 게스트 기록을 학생 기록에 연결합니다."
                );
            } else {
                toast.error("연결 준비 실패", "브라우저 저장공간을 확인한 뒤 다시 시도해주세요.");
                setAccountConnectionPending(false);
                return;
            }
        }
        router.push("/?role=student&connectGuest=1");
        setAccountConnectionPending(false);
    };

    const handleDashboardRetry = () => {
        setSessionState("checking");
        setDataError("");
        setDataState({ state: "loading" });
        setRefreshKey(key => key + 1);
    };

    // Production cannot re-login without the invite link; once the student has
    // reopened it (e.g. in another tab) this re-checks the signed cookie.
    const handleExpiredRecheck = async () => {
        if (expiredRecheckPending) return;
        setExpiredRecheckPending(true);
        try {
            const restored = await refreshStudentSession();
            if (restored.ok && restored.session) {
                saveSession(restored.session);
                handleDashboardRetry();
                return;
            }
            toast.info("아직 로그인이 확인되지 않았어요", "초대 링크로 다시 로그인한 뒤 눌러주세요.");
        } catch {
            toast.error("로그인 상태를 확인하지 못했어요", "네트워크를 확인한 뒤 다시 시도해주세요.");
        } finally {
            setExpiredRecheckPending(false);
        }
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
        // Explicit logout also forgets the opt-in name/class hint.
        clearStudentReturnHint();
        clearSession();
        setUser(null);
        setTodoExams([]);
        setDoneExams([]);
        setStats({ avgScore: 0, completedCount: 0, retakeCount: 0 });
        setGuestMergePreview(null);
        setSessionState("missing");
        setDataError("");
        setDataState({ state: "loading" });
        toast.info("로그아웃됨", "다시 시험을 보려면 학생 로그인이 필요합니다.");
        router.replace("/");
    };

    if (!user) {
        const checking = sessionState === "checking";
        const sessionError = sessionState === "error";
        const sessionExpired = sessionState === "expired";
        const productionRuntime = process.env.NODE_ENV === "production";
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
                                        : sessionExpired
                                            ? "로그인 시간이 끝났어요"
                                            : "학생 로그인이 필요합니다"}
                            </h1>
                            <p className="text-muted" style={{ lineHeight: 1.7, wordBreak: "keep-all" }}>
                                {checking
                                    ? "잠시만 기다려주세요."
                                    : sessionError
                                        ? "네트워크를 확인한 뒤 다시 시도해주세요."
                                        : sessionExpired
                                            ? productionRuntime
                                                ? "보안을 위해 12시간이 지나면 다시 확인해요. 학생 로그인 ID와 시작 코드로 이어서 할 수 있어요."
                                                : "보안을 위해 12시간이 지나면 다시 확인해요. 시작 코드만 다시 입력하면 이어서 할 수 있어요."
                                            : "학생 로그인 ID와 시작 코드로 로그인하면 내 시험과 제출 기록을 확인할 수 있습니다."}
                            </p>
                            {sessionExpired && productionRuntime && (
                                <p
                                    className="student-session-expired-invite-guidance"
                                    style={{ marginTop: "0.6rem", lineHeight: 1.7, wordBreak: "keep-all", color: "var(--foreground)" }}
                                >
                                    학생 로그인 ID와 시작 코드로 다시 로그인할 수 있어요. 선생님이 보낸 초대 링크도 계속 사용할 수 있습니다.
                                </p>
                            )}
                        </div>
                        {sessionError && (
                            <button type="button" className="btn btn-primary" onClick={handleDashboardRetry}>
                                다시 시도
                            </button>
                        )}
                        {sessionExpired && !productionRuntime && (
                            <Link
                                href={buildStudentLoginHref(expiredReturnPath, { reason: "expired" })}
                                className="btn btn-primary"
                            >
                                다시 로그인
                            </Link>
                        )}
                        {sessionExpired && productionRuntime && (
                            <Link href={buildStudentLoginHref(expiredReturnPath, { reason: "expired" })} className="btn">학생 로그인</Link>
                        )}
                        {sessionExpired && productionRuntime && (
                            <button
                                type="button"
                                className="btn btn-primary"
                                onClick={() => { void handleExpiredRecheck(); }}
                                disabled={expiredRecheckPending}
                                aria-busy={expiredRecheckPending}
                            >
                                {expiredRecheckPending ? "확인하는 중…" : "다시 확인"}
                            </button>
                        )}
                        {!checking && !sessionError && !sessionExpired && <Link href="/?role=student" className="btn btn-primary">학생 로그인</Link>}
                    </section>
                </main>
            </div>
        );
    }

    const dashboardReadOnly = dataState.state === "degraded_with_cache";

    return (
        <div className="layout-main">
            <header className="header student-dashboard-shell-header">
                <div className="container header-content student-dashboard-header" style={{ gap: "1rem", flexWrap: "wrap" }}>
                    <div className="student-dashboard-brand" style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                        <BrandLogo />
                    </div>
                    <div className="student-dashboard-identity" style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                        <span className="student-dashboard-user" style={{ fontWeight: 600, fontSize: '0.95rem', display: 'inline-flex', alignItems: 'center', gap: '0.45rem', flexWrap: 'wrap' }}>
                            <span className="student-dashboard-user-name" title={`${displayStudentName(user.name)} (${user.groupName})`}>
                                {displayStudentName(user.name)}{' '}
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
                {dataState.state === "loading" && (
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

                {dataState.state === "error_without_cache" && (
                    <section
                        data-testid="student-dashboard-error"
                        data-canonical-state="error_without_cache"
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
                            <Link href={buildStudentLoginHref("/student/dashboard")} className="btn">
                                로그인 안내
                            </Link>
                            <Link href="/" className="btn">
                                홈으로
                            </Link>
                        </div>
                    </section>
                )}

                {dataState.state === "degraded_with_cache" && (
                    <section
                        data-testid="student-dashboard-degraded"
                        role="status"
                        style={{ marginTop: "1.5rem", padding: "1rem 1.25rem", border: "1px solid rgba(245,158,11,0.35)", borderRadius: "var(--radius-lg)", background: "rgba(245,158,11,0.08)" }}
                    >
                        <strong>저장된 데이터를 읽기 전용으로 표시 중</strong>
                        <p className="text-muted" style={{ marginTop: "0.3rem" }}>
                            마지막 저장 {new Date(dataState.staleAt).toLocaleString("ko-KR")} · 서버 연결을 확인한 뒤 다시 시도해주세요.
                        </p>
                        <button type="button" className="btn" onClick={handleDashboardRetry}>다시 시도</button>
                    </section>
                )}

                {(dataState.state === "loaded_empty" || dataState.state === "loaded_data" || dataState.state === "degraded_with_cache") && (
                    <div data-canonical-state={dataState.state}>
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
                {!dashboardReadOnly && !user.isGuest && <StudentGuestRecoveryPanel />}

                {/* Guest Banner */}
                {!dashboardReadOnly && user.isGuest && (
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
                                    학생 계정으로 로그인하면 지금 기기에서 푼 게스트 기록
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

                    </details>
                )}

                <StudentDashboardTaskFlow
                    user={user}
                    todoExams={todoExams}
                    doneExams={doneExams}
                    stats={stats}
                    dashboardReadOnly={dashboardReadOnly}
                    assignmentServerNow={assignmentServerNow}
                    assignmentServerClock={assignmentServerClock}
                    onClockRefresh={refreshAssignmentClock}
                />
                    </div>
                )}
            </main>
        </div>
    );
}

type StudentDashboardStats = { avgScore: number; completedCount: number; retakeCount: number };

/**
 * Headline, quick links, and the assignment grid. Mounted only once the
 * dashboard data has loaded, so the shared clock below anchors on the fresh
 * server time synchronously (no frame where every card reads "확인 필요").
 */
function StudentDashboardTaskFlow({
    user,
    todoExams,
    doneExams,
    stats,
    dashboardReadOnly,
    assignmentServerNow,
    assignmentServerClock,
    onClockRefresh,
}: {
    user: StudentSession;
    todoExams: DashboardAssignment[];
    doneExams: DashboardCompletedAssignment[];
    stats: StudentDashboardStats;
    dashboardReadOnly: boolean;
    assignmentServerNow: string;
    assignmentServerClock?: AssignmentServerClock;
    onClockRefresh: () => void;
}) {
    // One server-anchored clock for the headline and both assignment blocks,
    // so the "open" count and the sections can never disagree.
    const assignmentClock = useMonotonicAssignmentTime(assignmentServerNow, assignmentServerClock, todoExams, onClockRefresh);
    const todoHeadline = summarizeTodoHeadline(presentTodoAssignments(todoExams, assignmentClock), assignmentClock);

    return (
        <>
        {/* Welcome */}
        <div className="student-dashboard-welcome mobile-section-stack" style={{ margin: '3rem 0' }}>
            <h1 className="title-gradient" title={`${displayStudentName(user.name)}님`} style={{ fontSize: '2.5rem', marginBottom: '0.75rem', lineHeight: 1.2 }}>
                {displayStudentName(user.name)}님,
            </h1>
            <p className="text-muted student-dashboard-headline" style={{ fontSize: '1.1rem', wordBreak: 'keep-all' }}>
                {todoHeadline.kind === "open" ? (
                    <>
                        지금 풀 수 있는 시험이 <strong style={{ color: 'var(--primary)', fontWeight: 700, whiteSpace: 'nowrap' }}>{todoHeadline.openCount}개</strong> 있어요.
                        {todoHeadline.dueTodayCount > 0 && (
                            <> 그중 <strong style={{ color: 'var(--text-warning)', fontWeight: 700, whiteSpace: 'nowrap' }}>{todoHeadline.dueTodayCount}개</strong>는 오늘 마감이에요.</>
                        )}
                    </>
                ) : todoHeadline.kind === "scheduled" ? (
                    <>다음 시험은 <strong style={{ color: 'var(--primary)', fontWeight: 700, whiteSpace: 'nowrap' }}>{todoHeadline.startLabel}</strong>에 시작해요.</>
                ) : (
                    <>지금 풀어야 할 시험이 없어요.</>
                )}
            </p>
            <nav className="student-dashboard-quick-links" aria-label="학습 바로가기">
                <Link href="/student/history" className="btn btn-secondary">지난 기록 보기 →</Link>
                {user.identityType === "registered" && (
                    <Link href="/student/remediation" className="btn btn-secondary">선생님이 배정한 오답 보강 →</Link>
                )}
            </nav>
        </div>

        {/* Dashboard Grid */}
        <div className={`bento-grid student-dashboard-grid student-dashboard-task-flow${stats.completedCount === 0 ? " is-zero-completions" : ""}`}>
            {/* Todo List (Main Focus) */}
            <div className="col-span-2 row-span-2 student-dashboard-primary-task">
                <AssignmentBlock
                    type="todo"
                    exams={todoExams}
                    readOnly={dashboardReadOnly}
                    serverNow={assignmentServerNow}
                    clock={assignmentClock}
                    onStartAssignment={(solveHref) => {
                        // The student just chose this exam here, so the solve page
                        // can skip its "학생으로 시험 보기" confirmation once.
                        if (user && !user.isGuest) recordSolveEntryIntentForPath(solveHref, user.studentId);
                    }}
                />
            </div>

            {/* Stats */}
            <Link href="/student/history" className="bento-card col-span-1 card-hover student-dashboard-average-card student-dashboard-history-action" style={{
                background: 'linear-gradient(135deg, var(--secondary), #f472b6)',
                color: 'white', border: 'none',
                display: 'flex', flexDirection: 'column', justifyContent: 'center'
            }}>
                <div style={{ fontSize: '0.95rem', fontWeight: 600, opacity: 0.9, marginBottom: '0.5rem' }}>내 평균 점수</div>
                <div style={{ fontSize: '3rem', fontWeight: 800, lineHeight: 1 }}>
                    {stats.avgScore}<span style={{ fontSize: '1.5rem', fontWeight: 700, opacity: 0.85 }}>%</span>
                </div>
                {/* Retake attempts are excluded: only first attempts count toward the average. */}
                <div style={{ marginTop: '0.6rem', fontSize: 'var(--type-caption)', fontWeight: 600, opacity: 0.9 }}>재시험 제외 · 기록 보기 →</div>
            </Link>

            {stats.completedCount > 0 && <div className="bento-card col-span-1 student-dashboard-secondary-status" style={{ justifyContent: 'center', alignItems: 'center', background: 'var(--surface)', position: 'relative', overflow: 'hidden' }}>
                <Award size={22} color="var(--primary)" style={{ position: 'absolute', top: 16, right: 16, opacity: 0.6 }} />
                <div style={{ fontSize: '3rem', fontWeight: 800, color: 'var(--foreground)', lineHeight: 1, marginBottom: '0.5rem' }}>
                    {stats.completedCount}
                </div>
                <div style={{ color: 'var(--muted)', fontSize: '0.9rem', fontWeight: 600 }}>완료한 시험</div>
                {stats.retakeCount > 0 && (
                    <div style={{ marginTop: '0.5rem', color: '#0f766e', background: '#f0fdfa', border: '1px solid #99f6e4', borderRadius: '999px', padding: '0.2rem 0.55rem', fontSize: 'var(--type-caption)', fontWeight: 800 }}>
                        재시험 {stats.retakeCount}회
                    </div>
                )}
            </div>}

            {/* Completed List */}
            <div className="col-span-2 student-dashboard-completed-task">
                <AssignmentBlock
                    type="done"
                    exams={doneExams}
                    readOnly={dashboardReadOnly}
                    serverNow={assignmentServerNow}
                    clock={assignmentClock}
                />
            </div>
        </div>
        </>
    );
}
