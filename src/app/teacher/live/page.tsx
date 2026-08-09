"use client";

import { useState, useEffect, useMemo, useCallback, useRef, type MouseEvent as ReactMouseEvent } from "react";
import Link from "next/link";
import TeacherHeader from "@/components/TeacherHeader";
import StatusPill from "@/components/dashboard/StatusPill";
import { Activity, Users, CheckCircle2, Clock, AlertTriangle, Bell, PlayCircle, PauseCircle, PlusCircle } from "lucide-react";
import { toast } from "@/components/Toast";
import type { Exam, Attempt } from "@/types/omr";
import { shouldUseDemoData } from "@/lib/demoData";
import { readTeacherSession } from "@/lib/teacherSession";
import {
    forceFinishTeacherAttemptSessions,
    forceFinishTeacherAttempts,
    loadTeacherActiveAttemptSessions,
    loadTeacherAttemptSummaries,
    loadTeacherAttempts,
} from "@/lib/teacherAttemptClient";
import type { TeacherActiveAttemptSession } from "@/lib/teacherAttemptGateway";
import { loadTeacherExam, loadTeacherExams, saveTeacherExamMutation } from "@/lib/teacherExamClient";
import { loadTeacherRosterSnapshot } from "@/lib/teacherRosterClient";
import type { RosterGroup, RosterStudent } from "@/lib/rosterStorage";
import { resolveAttemptScore } from "@/lib/attemptScores";
import { buildLiveQuestionHeatmap, dedupeLiveAttempts } from "@/lib/liveAnalytics";
import { liveAttemptsNeedingForceFinish } from "@/lib/liveControls";
import { safeRatePercent } from "@/lib/scoreUtils";
import { awaySeverity, resolveAwayCount } from "@/lib/examAwayTracker";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import { attemptMatchesStudentProfile } from "@/utils/storage";
import {
    classifyTeacherLiveExamPhase,
    mergeTeacherLiveExamAttempts,
    selectTeacherLiveExamId,
    selectTeacherLiveAssignedRosterStudents,
    teacherLiveCatalogShouldFail,
    teacherLiveExamPresentation,
    type TeacherLiveExamPhase,
} from "@/lib/teacherLiveExamState";

type StudentStatus = "submitted" | "in_progress" | "not_started";
type LiveDataMode = "real" | "demo";
type LiveCatalogLoadStatus = "loading" | "ready" | "failed";
type SelectedAttemptDetails = {
    examId: string;
    requestGeneration: number;
    status: "idle" | "loading" | "refreshing" | "ready" | "failed";
};

interface LiveStudent {
    id: string;
    name: string;
    avatar: string;
    status: StudentStatus;
    progress: number; // 0-100
    currentQ: number;
    totalQ: number;
    startedAt?: string;
    score?: number;
    awayCount: number;
}

interface LiveExam {
    id: string;
    title: string;
    total: number;
    duration: number;
    questions?: { id: number; answer?: number }[];
    sourceExam?: Exam;
}

const MOCK_EXAMS: LiveExam[] = [
    { id: "ex1", title: "Midterm English Test", total: 35, duration: 60 },
    { id: "ex2", title: "Chapter 4 Mathematics", total: 32, duration: 45 },
    { id: "ex3", title: "Science Pop Quiz", total: 30, duration: 20 },
];

const EMPTY_LIVE_EXAM: LiveExam = { id: "", title: "", total: 0, duration: 0, questions: [] };

/**
 * Remaining seconds for the live countdown, derived from the actual exam:
 * an end-time window (endAt) takes precedence, otherwise the duration budget.
 * Prevents the banner from showing a hardcoded/stale value across exams.
 */
function liveExamTimerSeconds(exam: LiveExam, now = Date.now()): number {
    const source = exam.sourceExam;
    const endAtMs = source?.endAt ? Date.parse(source.endAt) : NaN;
    if (Number.isFinite(endAtMs)) {
        return Math.max(0, Math.floor((endAtMs - now) / 1000));
    }
    const minutes = source?.durationMin ?? exam.duration ?? 0;
    return Math.max(0, Math.round(minutes * 60));
}

const AVATAR_COLORS = ["#4f46e5", "#ec4899", "#8b5cf6", "#10b981", "#f59e0b", "#0ea5e9"];

const MOCK_FIRST_NAMES = ["민준", "서연", "도윤", "예은", "하준", "지우", "시우", "수아", "재윤", "유나", "건우", "하윤", "지호", "서아", "선우", "지민", "윤서", "태호", "예준", "채원", "주원", "은서", "이준", "리아", "연우", "서현", "다은", "승우", "세은", "현우", "채은", "준서", "하린", "도현", "지안"];

function hashString(str: string): number {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
        h = ((h << 5) - h) + str.charCodeAt(i);
        h |= 0;
    }
    return Math.abs(h);
}

function pickAvatar(name: string): string {
    return AVATAR_COLORS[hashString(name) % AVATAR_COLORS.length];
}

function countAnsweredEntries(answers: Record<number, number> | undefined): number {
    if (!answers) return 0;
    let c = 0;
    for (const k in answers) {
        const v = answers[k];
        if (v !== undefined && v !== null && v !== 0) c++;
    }
    return c;
}

function attemptToStudent(a: Attempt, totalQ: number, exam?: Exam): LiveStudent {
    const status: StudentStatus =
        a.status === "completed" ? "submitted" :
        a.status === "in_progress" ? "in_progress" : "not_started";
    const answered = countAnsweredEntries(a.answers);
    const name = a.studentName || "Student";
    const progress =
        status === "submitted" ? 100 :
        status === "in_progress" ? safeRatePercent(answered, totalQ) : 0;
    const score = status === "submitted"
        ? resolveAttemptScore(a, exam).scorePercent
        : undefined;
    return {
        id: a.id,
        name,
        avatar: pickAvatar(name + a.id),
        status,
        progress,
        currentQ: answered,
        totalQ,
        startedAt: a.startedAt,
        score,
        awayCount: resolveAwayCount(a),
    };
}

function activeSessionToStudent(session: TeacherActiveAttemptSession): LiveStudent {
    const name = session.studentName || "Student";
    return {
        id: session.attemptId,
        name,
        avatar: pickAvatar(name + session.attemptId),
        status: "in_progress",
        progress: safeRatePercent(session.answeredCount, session.totalQuestionCount),
        currentQ: session.answeredCount,
        totalQ: session.totalQuestionCount,
        startedAt: session.startedAt,
        awayCount: 0,
    };
}

function rosterStudentToLiveStudent(student: RosterStudent, totalQ: number): LiveStudent {
    return {
        id: student.id,
        name: student.name,
        avatar: student.avatar || pickAvatar(student.name + student.id),
        status: "not_started",
        progress: 0,
        currentQ: 0,
        totalQ,
        awayCount: 0,
    };
}

function genSyntheticStudents(count: number, totalQ: number, startIdx: number): LiveStudent[] {
    const out: LiveStudent[] = [];
    for (let i = 0; i < count; i++) {
        const idx = startIdx + i;
        const seed = (idx * 9301 + 49297) % 233280;
        const r = seed / 233280;
        const status: StudentStatus = r < 0.35 ? "submitted" : r < 0.8 ? "in_progress" : "not_started";
        const progress =
            status === "submitted" ? 100 :
            status === "in_progress" ? Math.round(20 + ((seed % 70))) : 0;
        const currentQ = totalQ > 0 ? Math.ceil((progress / 100) * totalQ) : 0;
        const name = MOCK_FIRST_NAMES[idx % MOCK_FIRST_NAMES.length] + (idx >= MOCK_FIRST_NAMES.length ? "2" : "");
        out.push({
            id: `synthetic-${idx}`,
            name,
            avatar: pickAvatar(name + idx),
            status,
            progress,
            currentQ,
            totalQ,
            startedAt: status !== "not_started" ? new Date(Date.now() - (seed % 1800) * 1000).toISOString() : undefined,
            score: status === "submitted" ? Math.round(50 + (seed % 50)) : undefined,
            awayCount: 0,
        });
    }
    return out;
}

function examToLiveExam(exam: Exam): LiveExam {
    const questions = Array.isArray(exam.questions) ? exam.questions : [];
    return {
        id: exam.id,
        title: exam.title,
        total: questions.length,
        duration: exam.durationMin || 60,
        questions: questions.map(q => ({ id: q.id, answer: q.answer })),
        sourceExam: { ...exam, pdfData: undefined, answerKeyPdf: undefined },
    };
}

function resolveLiveExamData(exams: Exam[], allowDemo: boolean): { exams: LiveExam[]; mode: LiveDataMode } {
    const loaded = exams.map(examToLiveExam);
    if (loaded.length > 0) return { exams: loaded, mode: "real" };
    return allowDemo
        ? { exams: MOCK_EXAMS, mode: "demo" }
        : { exams: [], mode: "real" };
}

function ForceFinishConfirmDialog({
    examTitle,
    body,
    confirmLabel,
    onCancel,
    onConfirm,
}: {
    examTitle: string;
    body: string;
    confirmLabel: string;
    onCancel: () => void;
    onConfirm: () => void;
}) {
    const dialogRef = useDialogFocus(true, onCancel);

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
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-label="응시 종료 처리 확인"
                tabIndex={-1}
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
                    응시 종료 처리
                </h2>
                <p style={{ color: 'var(--muted)', lineHeight: 1.7, fontSize: '0.95rem', wordBreak: 'keep-all', marginBottom: '1.25rem' }}>
                    “{examTitle}” {body}
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
                        {confirmLabel}
                    </button>
                </div>
            </div>
        </div>
    );
}

const MIN_STUDENT_CARDS = 8;

export default function LiveResultsPage() {
    const [exams, setExams] = useState<LiveExam[]>([]);
    const [liveDataMode, setLiveDataMode] = useState<LiveDataMode>("real");
    const [attempts, setAttempts] = useState<Attempt[]>([]);
    const [activeSessions, setActiveSessions] = useState<TeacherActiveAttemptSession[]>([]);
    const [rosterStudents, setRosterStudents] = useState<RosterStudent[]>([]);
    const [rosterGroups, setRosterGroups] = useState<RosterGroup[]>([]);
    const [selectedExamId, setSelectedExamId] = useState<string>("");
    const [catalogLoadStatus, setCatalogLoadStatus] = useState<LiveCatalogLoadStatus>("loading");
    const [catalogLoadRequest, setCatalogLoadRequest] = useState(0);
    const [, setTick] = useState(0);
    const [timerSeconds, setTimerSeconds] = useState(0);
    const [isScreenRefreshPaused, setIsScreenRefreshPaused] = useState(false);
    const [selectedAttemptDetails, setSelectedAttemptDetails] = useState<SelectedAttemptDetails>({
        examId: "",
        requestGeneration: 0,
        status: "idle",
    });
    const selectedAttemptDetailsRef = useRef(selectedAttemptDetails);
    selectedAttemptDetailsRef.current = selectedAttemptDetails;
    const selectedAttemptRequestGenerationRef = useRef(0);
    const selectedExamIdRef = useRef(selectedExamId);
    selectedExamIdRef.current = selectedExamId;
    const [forceFinishConfirmOpen, setForceFinishConfirmOpen] = useState(false);
    // Synthetic students per exam — mutable state so they can "progress" over time
    const [syntheticByExam, setSyntheticByExam] = useState<Record<string, LiveStudent[]>>({});

    const loadSelectedAttemptDetails = useCallback(async (examId: string, removeMissing = false) => {
        const requestGeneration = selectedAttemptRequestGenerationRef.current + 1;
        selectedAttemptRequestGenerationRef.current = requestGeneration;
        const currentDetails = selectedAttemptDetailsRef.current;
        const isBackgroundRefresh = currentDetails.examId === examId
            && (currentDetails.status === "ready" || currentDetails.status === "refreshing");
        setSelectedAttemptDetails({
            examId,
            requestGeneration,
            status: isBackgroundRefresh ? "refreshing" : "loading",
        });

        const [attemptResult, sessionResult] = await Promise.all([
            loadTeacherAttempts(examId),
            loadTeacherActiveAttemptSessions(examId),
        ]);
        if (
            selectedAttemptRequestGenerationRef.current !== requestGeneration
            || selectedExamIdRef.current !== examId
        ) return;

        if (attemptResult.remoteError || sessionResult.remoteError) {
            setSelectedAttemptDetails({ examId, requestGeneration, status: "failed" });
            setForceFinishConfirmOpen(false);
            return;
        }
        setAttempts(current => mergeTeacherLiveExamAttempts(
            current,
            examId,
            attemptResult.items,
            removeMissing,
        ));
        setActiveSessions(sessionResult.items);
        setSelectedAttemptDetails({ examId, requestGeneration, status: "ready" });
    }, []);

    const refreshFromStorage = useCallback(async () => {
        setCatalogLoadStatus("loading");
        try {
            const [examResult, attemptResult, rosterResult] = await Promise.all([
                loadTeacherExams(),
                loadTeacherAttemptSummaries(),
                loadTeacherRosterSnapshot(window.localStorage),
            ]);
            const allowDemo = shouldUseDemoData(readTeacherSession());
            if (teacherLiveCatalogShouldFail(allowDemo, examResult, attemptResult, rosterResult)) {
                setCatalogLoadStatus("failed");
                return;
            }
            const liveData = resolveLiveExamData(examResult.items, allowDemo);
            setExams(liveData.exams);
            setLiveDataMode(liveData.mode);
            if (liveData.mode === "real") setSyntheticByExam({});
            setAttempts(attemptResult.items);
            setRosterStudents(rosterResult.students);
            setRosterGroups(rosterResult.groups);
            const nextSelectedExamId = liveData.mode === "demo"
                ? (liveData.exams.some(exam => exam.id === selectedExamId) ? selectedExamId : liveData.exams[0]?.id || "")
                : selectTeacherLiveExamId(
                    liveData.exams.flatMap(exam => exam.sourceExam ? [exam.sourceExam] : []),
                    attemptResult.items,
                    selectedExamId,
                );
            selectedExamIdRef.current = nextSelectedExamId;
            setSelectedExamId(nextSelectedExamId);
            setCatalogLoadStatus("ready");
            if (liveData.mode !== "real" || !nextSelectedExamId) return;
            await loadSelectedAttemptDetails(nextSelectedExamId, true);
        } catch {
            setCatalogLoadStatus("failed");
        }
    }, [loadSelectedAttemptDetails, selectedExamId]);

    const refreshSelectedAttempts = useCallback(async () => {
        if (!selectedExamId) return;
        await loadSelectedAttemptDetails(selectedExamId);
    }, [loadSelectedAttemptDetails, selectedExamId]);

    const reconcilePartialForceFinish = useCallback(() => {
        void refreshFromStorage();
    }, [refreshFromStorage]);

    // Initial load + adjust selected exam if real exams found
    useEffect(() => {
        let cancelled = false;
        const loadInitial = async () => {
            setCatalogLoadStatus("loading");
            try {
                const [examResult, attemptResult, rosterResult] = await Promise.all([
                    loadTeacherExams(),
                    loadTeacherAttemptSummaries(),
                    loadTeacherRosterSnapshot(window.localStorage),
                ]);
                if (cancelled) return;
                const allowDemo = shouldUseDemoData(readTeacherSession());
                if (teacherLiveCatalogShouldFail(allowDemo, examResult, attemptResult, rosterResult)) {
                    setCatalogLoadStatus("failed");
                    return;
                }
                const liveData = resolveLiveExamData(examResult.items, allowDemo);
                setExams(liveData.exams);
                setLiveDataMode(liveData.mode);
                if (liveData.mode === "real") setSyntheticByExam({});
                setAttempts(attemptResult.items);
                setRosterStudents(rosterResult.students);
                setRosterGroups(rosterResult.groups);
                setSelectedExamId(prev => {
                    const nextSelectedExamId = liveData.mode === "demo"
                        ? (liveData.exams.some(exam => exam.id === prev) ? prev : liveData.exams[0]?.id || "")
                        : selectTeacherLiveExamId(
                        liveData.exams.flatMap(exam => exam.sourceExam ? [exam.sourceExam] : []),
                        attemptResult.items,
                        prev,
                        );
                    selectedExamIdRef.current = nextSelectedExamId;
                    return nextSelectedExamId;
                });
                setCatalogLoadStatus("ready");
            } catch {
                if (!cancelled) setCatalogLoadStatus("failed");
            }
        };
        void loadInitial();
        return () => { cancelled = true; };
    }, [catalogLoadRequest]);

    useEffect(() => {
        if (!selectedExamId) {
            const requestGeneration = selectedAttemptRequestGenerationRef.current + 1;
            selectedAttemptRequestGenerationRef.current = requestGeneration;
            setSelectedAttemptDetails({ examId: "", requestGeneration, status: "idle" });
            setForceFinishConfirmOpen(false);
            setActiveSessions([]);
            return;
        }
        void refreshSelectedAttempts();
    }, [refreshSelectedAttempts, selectedExamId]);

    // Poll only the selected exam every 3s after the previous request settles.
    // The catalog is loaded on entry and after explicit mutations, avoiding
    // overlapping detail reads and full-organization payload downloads.
    useEffect(() => {
        if (isScreenRefreshPaused) return;
        let cancelled = false;
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const poll = async () => {
            try {
                if (typeof document === "undefined" || document.visibilityState === "visible") {
                    await refreshSelectedAttempts();
                }
            } finally {
                if (!cancelled) timeoutId = setTimeout(poll, 3000);
            }
        };
        timeoutId = setTimeout(poll, 3000);
        return () => {
            cancelled = true;
            if (timeoutId !== undefined) clearTimeout(timeoutId);
        };
    }, [isScreenRefreshPaused, refreshSelectedAttempts]);

    const selectedExam = exams.find(e => e.id === selectedExamId) ?? exams[0];
    const hasExam = !!selectedExam;
    const exam = selectedExam ?? EMPTY_LIVE_EXAM;
    const isDemoLive = liveDataMode === "demo";
    const selectedAttemptDetailsReady = (selectedAttemptDetails.status === "ready" || selectedAttemptDetails.status === "refreshing")
        && selectedAttemptDetails.examId === selectedExamId
        && selectedAttemptDetails.requestGeneration === selectedAttemptRequestGenerationRef.current;

    const examAttempts = useMemo(
        () => hasExam ? attempts.filter(a => a && a.examId === exam.id) : [],
        [attempts, exam.id, hasExam]
    );
    const selectedPhase: TeacherLiveExamPhase = isDemoLive
        ? "ready"
        : classifyTeacherLiveExamPhase(exam.sourceExam || {}, examAttempts);
    const livePresentation = teacherLiveExamPresentation(selectedPhase, isDemoLive);
    const showLiveControls = isDemoLive || selectedPhase === "live";
    const phaseByExamId = useMemo(() => new Map(exams.map(candidate => {
        const candidateAttempts = attempts.filter(attempt => attempt.examId === candidate.id);
        const phase = isDemoLive
            ? "ready" as const
            : classifyTeacherLiveExamPhase(candidate.sourceExam || {}, candidateAttempts);
        return [candidate.id, teacherLiveExamPresentation(phase, isDemoLive)] as const;
    })), [attempts, exams, isDemoLive]);

    // Retake-free, one-row-per-student view of the exam's attempts. Used for the
    // live cards, count tiles, and question heatmap so a student who resubmits or
    // takes a wrong-answer retake isn't double-counted (raw examAttempts is kept
    // for force-finish, which must still target every in-progress attempt).
    const liveAttempts = useMemo(() => dedupeLiveAttempts(examAttempts), [examAttempts]);
    const answerDetailedAttempts = useMemo(
        () => selectedAttemptDetailsReady || isDemoLive ? liveAttempts : [],
        [isDemoLive, liveAttempts, selectedAttemptDetailsReady],
    );

    // Initialize synthetic students for this exam if not yet seeded
    useEffect(() => {
        if (!hasExam || !isDemoLive) return;
        // Seed derived display-only data once the selected exam is known.
        setSyntheticByExam(prev => {
            if (prev[exam.id]) return prev;
            const real = liveAttempts.map(a => attemptToStudent(a, exam.total, exam.sourceExam));
            const needed = Math.max(MIN_STUDENT_CARDS - real.length, 0);
            if (needed === 0) return prev;
            return { ...prev, [exam.id]: genSyntheticStudents(needed, exam.total || 20, real.length) };
        });
    }, [exam.id, exam.sourceExam, exam.total, liveAttempts, hasExam, isDemoLive]);

    // Advance synthetic students every 3s when not paused — makes "Live" feel live
    useEffect(() => {
        if (!hasExam || isScreenRefreshPaused || !isDemoLive) return;
        const id = setInterval(() => {
            setSyntheticByExam(prev => {
                const list = prev[exam.id];
                if (!list || list.length === 0) return prev;
                const totalQ = exam.total || 20;
                const pulse = Math.floor(Date.now() / 3000);
                const next = list.map(s => {
                    const seed = hashString(`${exam.id}:${s.id}:${s.progress}:${s.currentQ}:${pulse}`);
                    if (s.status === "in_progress" && seed % 100 < 45) {
                        const inc = 5 + (seed % 12);
                        const newProgress = Math.min(100, s.progress + inc);
                        const newQ = Math.max(s.currentQ, Math.ceil((newProgress / 100) * totalQ));
                        if (newProgress >= 100) {
                            return {
                                ...s,
                                status: "submitted" as const,
                                progress: 100,
                                currentQ: totalQ,
                                score: 50 + (hashString(`${s.id}:score:${pulse}`) % 51),
                            };
                        }
                        return { ...s, progress: newProgress, currentQ: newQ };
                    }
                    if (s.status === "not_started" && seed % 100 < 18) {
                        return {
                            ...s,
                            status: "in_progress" as const,
                            progress: 5 + (seed % 15),
                            currentQ: 1,
                            startedAt: new Date().toISOString(),
                        };
                    }
                    return s;
                });
                return { ...prev, [exam.id]: next };
            });
        }, 3000);
        return () => clearInterval(id);
    }, [exam.id, exam.total, hasExam, isDemoLive, isScreenRefreshPaused]);

    const assignedRosterStudents = useMemo(() => (
        !isDemoLive && exam.sourceExam
            ? selectTeacherLiveAssignedRosterStudents(exam.sourceExam, rosterStudents, rosterGroups)
            : []
    ), [exam.sourceExam, isDemoLive, rosterGroups, rosterStudents]);

    const students = useMemo<LiveStudent[]>(() => {
        if (!hasExam) return [];
        const totalQ = exam.total;
        const real = answerDetailedAttempts.map(a => attemptToStudent(a, totalQ, exam.sourceExam));
        if (!isDemoLive) {
            const attemptById = new Map(answerDetailedAttempts.map(attempt => [attempt.id, attempt]));
            const latestByStudent = new Map<string, LiveStudent>();
            for (const rosterStudent of assignedRosterStudents) {
                latestByStudent.set(rosterStudent.id, rosterStudentToLiveStudent(rosterStudent, totalQ));
            }
            for (const student of real) {
                const attempt = attemptById.get(student.id);
                const matchedRosterStudent = attempt
                    ? assignedRosterStudents.find(candidate => attemptMatchesStudentProfile(attempt, candidate))
                    : undefined;
                latestByStudent.set(
                    matchedRosterStudent?.id || attempt?.studentProfileId || attempt?.studentId || attempt?.guestId || student.id,
                    student,
                );
            }
            for (const session of activeSessions) {
                const matchedRosterStudent = assignedRosterStudents.find(candidate => (
                    candidate.id === session.studentProfileId || candidate.id === session.ownerStudentId
                ));
                latestByStudent.set(
                    matchedRosterStudent?.id || session.studentProfileId || session.ownerStudentId,
                    activeSessionToStudent(session),
                );
            }
            return Array.from(latestByStudent.values());
        }
        if (real.length >= MIN_STUDENT_CARDS) return real;
        const synthetic = syntheticByExam[exam.id] ?? [];
        return [...real, ...synthetic];
    }, [activeSessions, answerDetailedAttempts, assignedRosterStudents, exam.id, exam.sourceExam, exam.total, hasExam, isDemoLive, syntheticByExam]);

    // Reset the countdown from the actual exam whenever the selected exam changes,
    // instead of counting down from a hardcoded value that never resets.
    useEffect(() => {
        setTimerSeconds(hasExam && showLiveControls ? liveExamTimerSeconds(exam) : 0);
        // Key on the primitive schedule fields, not the `exam` object: the 3s poll
        // replaces `exams` (new object identity) every tick, and depending on `exam`
        // would reset the countdown every 3 seconds.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [exam.id, exam.sourceExam?.endAt, exam.sourceExam?.durationMin, exam.duration, hasExam, showLiveControls]);

    useEffect(() => {
        if (!hasExam || !showLiveControls) return;
        const id = setInterval(() => {
            setTick(t => t + 1);
            setTimerSeconds(s => Math.max(0, s - 1));
        }, 1000);
        return () => clearInterval(id);
    }, [hasExam, showLiveControls]);

    const counts = isDemoLive
        ? {
            submitted: students.filter(s => s.status === "submitted").length,
            inProgress: students.filter(s => s.status === "in_progress").length,
            notStarted: students.filter(s => s.status === "not_started").length,
        }
        : {
            submitted: students.filter(student => student.status === "submitted").length,
            inProgress: students.filter(student => student.status === "in_progress").length,
            notStarted: students.filter(student => student.status === "not_started").length,
        };
    const forceFinishTargets = useMemo(
        () => liveAttemptsNeedingForceFinish(examAttempts),
        [examAttempts]
    );
    const submittedStudents = students.filter(s => s.status === "submitted");
    const avgScore = submittedStudents.length > 0
        ? Math.round(submittedStudents.reduce((a, s) => a + (s.score || 0), 0) / submittedStudents.length)
        : 0;

    const heatmap = useMemo(() => {
        return buildLiveQuestionHeatmap({
            examId: exam.id,
            sourceExam: exam.sourceExam,
            questions: exam.questions ?? [],
            totalQuestionCount: exam.total || 20,
            submittedAttempts: answerDetailedAttempts,
            submittedDisplayCount: students.filter(s => s.status === "submitted").length,
            allowSynthetic: isDemoLive,
        });
    }, [answerDetailedAttempts, exam.questions, exam.total, exam.id, exam.sourceExam, isDemoLive, students]);
    const hasHeatmapData = heatmap.some(h => h.total > 0);
    const weakHeatmapCells = heatmap.filter(h => h.total > 0 && safeRatePercent(h.correct, h.total) < 45);

    const mm = Math.floor(timerSeconds / 60).toString().padStart(2, "0");
    const ss = (timerSeconds % 60).toString().padStart(2, "0");

    // Handlers for timer-bar actions
    const handleExtendTime = async () => {
        if (!hasExam) return;
        if (isDemoLive) {
            // Demo data has no persisted exam to extend — adjust the display only.
            setTimerSeconds(s => s + 300);
            toast.success("시간 5분 연장됨 (데모)");
            return;
        }
        // Real exams: only an end-time window can be extended so students' own
        // timers are actually affected. Load the full stored exam (with PDF refs)
        // rather than the stripped sourceExam so persisting doesn't drop assets.
        const fresh = await loadTeacherExam(exam.id);
        if (!fresh) {
            toast.error("시험을 불러오지 못해 연장하지 못했습니다");
            return;
        }
        if (!fresh.endAt) {
            toast.error("종료 시간이 설정된 시험만 연장할 수 있습니다");
            return;
        }
        const base = Math.max(Date.parse(fresh.endAt) || Date.now(), Date.now());
        const nextEndAt = new Date(base + 5 * 60 * 1000).toISOString();
        const result = await saveTeacherExamMutation({ ...fresh, endAt: nextEndAt, updatedAt: new Date().toISOString() });
        if (!result.ok) {
            toast.error("연장 저장에 실패했습니다", result.error || "시험 서버에 변경을 저장하지 못했습니다.");
            return;
        }
        setTimerSeconds(Math.max(0, Math.floor((base + 5 * 60 * 1000 - Date.now()) / 1000)));
        toast.success("종료 시간이 5분 연장되었습니다");
        void refreshFromStorage();
    };

    const handleForceFinish = (event: ReactMouseEvent<HTMLButtonElement>) => {
        if (!hasExam) return;
        if (!isDemoLive && !selectedAttemptDetailsReady) {
            toast.info("응시 상세 불러오는 중", "답안 데이터를 확인한 뒤 종료 처리를 사용할 수 있습니다.");
            return;
        }
        event.currentTarget.focus({ preventScroll: true });
        setForceFinishConfirmOpen(true);
    };

    const confirmForceFinish = async () => {
        if (!hasExam) return;
        if (!isDemoLive && !selectedAttemptDetailsReady) return;
        if (!isDemoLive) {
            const targets = forceFinishTargets;
            const sessionTargets = activeSessions;
            if (targets.length === 0 && sessionTargets.length === 0) {
                setTimerSeconds(0);
                setIsScreenRefreshPaused(true);
                setForceFinishConfirmOpen(false);
                toast.info("진행 중인 제출 없음", "저장된 응시 중 제출이 없어 로컬 타이머만 종료했습니다.");
                return;
            }

            const finishedAt = new Date().toISOString();
            const sessionResult = sessionTargets.length > 0
                ? await forceFinishTeacherAttemptSessions(sessionTargets, finishedAt)
                : { localSaved: true, remoteSaved: true, attempts: [] as Attempt[], remoteError: undefined };
            if (!sessionResult.localSaved && !sessionResult.remoteSaved) {
                toast.error("종료 처리 실패", sessionResult.remoteError || "진행 중인 응시 세션을 종료하지 못했습니다. 다시 시도해주세요.");
                return;
            }
            const result = targets.length > 0
                ? await forceFinishTeacherAttempts(targets, finishedAt)
                : { localSaved: true, remoteSaved: true, attempts: [] as Attempt[], remoteError: undefined };
            if (!result.localSaved && !result.remoteSaved) {
                toast.error("종료 처리 실패", result.remoteError || "세션은 종료됐지만 이전 형식의 응시를 종료하지 못했습니다. 새로고침 후 다시 시도해주세요.");
                if (sessionResult.attempts.length > 0) reconcilePartialForceFinish();
                return;
            }

            const completed = [...sessionResult.attempts, ...result.attempts];
            const completedById = new Map(completed.map(attempt => [attempt.id, attempt]));
            setAttempts(prev => [
                ...prev.map(attempt => completedById.get(attempt.id) ?? attempt),
                ...completed.filter(attempt => !prev.some(existing => existing.id === attempt.id)),
            ]);
            setActiveSessions([]);
            setTimerSeconds(0);
            setIsScreenRefreshPaused(true);
            setForceFinishConfirmOpen(false);
            if ("cacheWarning" in result && typeof result.cacheWarning === "string" && result.cacheWarning) {
                toast.info(
                    "서버 종료 완료 · 캐시 새로고침 필요",
                    `${result.cacheWarning}. 서버의 완료 결과를 다시 불러옵니다.`,
                );
                void refreshFromStorage();
                return;
            }
            toast.success(
                "응시 종료 처리됨",
                `${completed.length}건을 완료 제출로 저장했습니다.${result.remoteSaved ? "" : " 개발 모드에서 이 기기에 저장했습니다."}`
            );
            return;
        }

        setSyntheticByExam(prev => {
            const list = prev[exam.id];
            if (!list) return prev;
            const totalQ = exam.total || 20;
            const next = list.map(s => {
                if (s.status === "submitted") return s;
                const progress = s.progress;
                const score = Math.max(0, Math.round((progress / 100) * 100));
                return {
                    ...s,
                    status: "submitted" as const,
                    progress,
                    currentQ: Math.max(s.currentQ, Math.ceil((progress / 100) * totalQ)),
                    score,
                };
            });
            return { ...prev, [exam.id]: next };
        });
        setTimerSeconds(0);
        setIsScreenRefreshPaused(true);
        setForceFinishConfirmOpen(false);
        toast.success("데모 시험 종료됨");
    };

    const handleNotifyNotStarted = () => {
        if (!hasExam) return;
        const n = counts.notStarted;
        if (n === 0) {
            toast.info("미응시자 없음", "현재 확인할 미응시 학생이 없습니다.");
            return;
        }
        toast.info(
            "카카오 알림 연동 전",
            `현재는 미응시 ${n}명 확인만 지원합니다. 실제 카카오 발송 채널이 연결되면 이 버튼에서 발송합니다.`
        );
    };

    return (
        <div className="layout-main">
            <div className="orb orb-primary" />
            <div className="orb orb-secondary" />
            <TeacherHeader
                badge={isDemoLive ? "DEMO" : selectedPhase === "live" ? "LIVE" : selectedPhase === "completed" ? "완료" : "준비"}
                badgeColor={selectedPhase === "completed" ? "var(--success)" : selectedPhase === "ready" ? "var(--muted)" : "var(--primary)"}
            />

            <main id="main-content" tabIndex={-1} className="container animate-fade-in" style={{ paddingBottom: '4rem', position: 'relative', zIndex: 1 }}>
                {/* Header row */}
                <div className="live-page-heading mobile-section-stack" style={{ margin: '3rem 0 2rem', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: '2rem', flexWrap: 'wrap' }}>
                    <div>
                        <div role="status" aria-live="polite" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
                            <span style={{
                                width: 8,
                                height: 8,
                                borderRadius: '50%',
                                background: showLiveControls ? 'var(--primary)' : selectedPhase === 'completed' ? 'var(--success)' : 'var(--muted)',
                                animation: showLiveControls && !isScreenRefreshPaused ? 'pulse 1.4s ease-in-out infinite' : 'none'
                            }} />
                            {hasExam
                                ? <StatusPill tone={livePresentation.tone} size="sm" label={livePresentation.label} />
                                : <StatusPill tone="muted" size="sm" label="실시간 준비" />}
                        </div>
                        <h1 className="title-gradient" style={{ fontSize: '2.5rem', marginBottom: '0.5rem', lineHeight: 1.2 }}>
                            응시 결과 확인
                        </h1>
                        <p className="text-muted" style={{ fontSize: '1.05rem' }}>
                            {hasExam ? livePresentation.description : "시험을 선택하면 제출 상태와 문항별 결과를 확인할 수 있습니다."}
                        </p>
                    </div>
                    {hasExam ? (
                        <select
                            value={selectedExamId}
                            onChange={e => {
                                const nextSelectedExamId = e.target.value;
                                const requestGeneration = selectedAttemptRequestGenerationRef.current + 1;
                                selectedAttemptRequestGenerationRef.current = requestGeneration;
                                selectedExamIdRef.current = nextSelectedExamId;
                                setSelectedAttemptDetails({
                                    examId: nextSelectedExamId,
                                    requestGeneration,
                                    status: "loading",
                                });
                                setForceFinishConfirmOpen(false);
                                setSelectedExamId(nextSelectedExamId);
                            }}
                            aria-label="모니터링할 시험 선택"
                            className="input-field"
                            style={{ maxWidth: 340, fontWeight: 600 }}
                        >
                            {exams.map(e => (
                                <option key={e.id} value={e.id}>
                                    {e.title} · {phaseByExamId.get(e.id)?.label}
                                </option>
                            ))}
                        </select>
                    ) : null}
                </div>

                {isDemoLive && (
                    <div
                        role="status"
                        aria-label="데모 실시간 데이터 안내"
                        style={{
                            display: 'flex',
                            alignItems: 'flex-start',
                            gap: '0.85rem',
                            padding: '1rem 1.1rem',
                            marginBottom: '1.5rem',
                            borderRadius: 'var(--radius-lg)',
                            border: '1px solid rgba(245,158,11,0.28)',
                            background: 'rgba(245,158,11,0.09)',
                            color: 'var(--foreground)',
                        }}
                    >
                        <AlertTriangle size={19} color="var(--warning)" style={{ flexShrink: 0, marginTop: 2 }} />
                        <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: '0.9rem', fontWeight: 900, color: 'var(--warning)', marginBottom: '0.2rem' }}>
                                데모 실시간 모드
                            </div>
                            <p style={{ fontSize: '0.82rem', color: 'var(--muted)', lineHeight: 1.55, wordBreak: 'keep-all' }}>
                                저장된 시험이 없어 예시 시험과 합성 응시 흐름을 표시 중입니다. 실제 시험을 만들면 합성 학생과 예시 정답률은 자동으로 사라집니다.
                            </p>
                        </div>
                    </div>
                )}

                {catalogLoadStatus === "loading" ? (
                    <div className="bento-card" role="status" aria-live="polite" style={{ padding: '3rem 2rem', textAlign: 'center' }}>
                        <div className="loading-spinner" aria-hidden="true" style={{ margin: '0 auto 0.85rem' }} />
                        <p style={{ color: 'var(--muted)', fontWeight: 700 }}>시험과 응시 현황을 불러오는 중입니다…</p>
                    </div>
                ) : catalogLoadStatus === "failed" ? (
                    <div
                        className="bento-card"
                        data-testid="teacher-live-catalog-error"
                        role="alert"
                        style={{ padding: '3rem 2rem', textAlign: 'center' }}
                    >
                        <AlertTriangle size={34} color="var(--error)" style={{ marginBottom: '0.85rem' }} />
                        <h2 style={{ fontSize: '1.3rem', fontWeight: 800, marginBottom: '0.45rem' }}>
                            시험과 응시 현황을 서버에서 불러오지 못했습니다.
                        </h2>
                        <p style={{ color: 'var(--muted)', marginBottom: '1.25rem' }}>
                            네트워크 상태를 확인한 뒤 다시 시도해 주세요. 기존 데이터를 빈 현황으로 표시하지 않습니다.
                        </p>
                        <button
                            type="button"
                            className="btn btn-primary"
                            onClick={() => setCatalogLoadRequest(request => request + 1)}
                        >
                            다시 시도
                        </button>
                    </div>
                ) : hasExam ? (
                    <>
                        {/* Lifecycle summary + actions */}
                        {showLiveControls ? (
                            <div className="bento-card" style={{
                                background: 'linear-gradient(135deg, var(--primary), #0ea5e9)',
                                color: 'white', border: 'none', marginBottom: '1.25rem',
                                position: 'relative', overflow: 'hidden', padding: '1.5rem 2rem'
                            }}>
                                <div style={{ position: 'absolute', top: '-30%', right: '-5%', width: 260, height: 260, background: 'radial-gradient(circle, rgba(255,255,255,0.25) 0%, transparent 70%)' }} />
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem', position: 'relative', zIndex: 1 }}>
                                    <div>
                                        <div style={{ fontSize: 'var(--type-caption)', opacity: 0.9, letterSpacing: '0.1em', fontWeight: 700, marginBottom: 6 }}>REMAINING TIME</div>
                                        <div className="numeric-emphasis" style={{ fontSize: '3rem', fontWeight: 900, letterSpacing: '-0.03em', fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>
                                            {mm}:{ss}
                                        </div>
                                        <div style={{ fontSize: 'var(--type-body-sm)', opacity: 0.9, marginTop: 6 }}>
                                            총 {exam.duration}분 · {exam.title}
                                        </div>
                                    </div>
                                    <div className="live-desktop-controls" style={{ display: 'grid', gap: '0.55rem', justifyItems: 'end' }}>
                                        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                                            <button
                                                type="button"
                                                onClick={() => setIsScreenRefreshPaused(paused => !paused)}
                                                aria-label={isScreenRefreshPaused ? "화면 갱신 재개" : "화면 갱신 일시정지"}
                                                aria-pressed={isScreenRefreshPaused}
                                                aria-describedby="live-refresh-control-help"
                                                style={{
                                                    background: 'rgba(255,255,255,0.18)', color: 'white', padding: '0.75rem 1.25rem',
                                                    borderRadius: 'var(--radius-full)', fontSize: 'var(--type-label)', fontWeight: 700,
                                                    display: 'flex', alignItems: 'center', gap: '0.5rem',
                                                    border: '1px solid rgba(255,255,255,0.35)', backdropFilter: 'blur(10px)'
                                                }}
                                            >
                                                {isScreenRefreshPaused ? <PlayCircle size={18} /> : <PauseCircle size={18} />}
                                                {isScreenRefreshPaused ? '화면 갱신 재개' : '화면 갱신 일시정지'}
                                            </button>
                                            <button type="button" onClick={handleExtendTime} style={{
                                                background: 'rgba(255,255,255,0.18)', color: 'white', padding: '0.75rem 1.25rem',
                                                borderRadius: 'var(--radius-full)', fontSize: 'var(--type-label)', fontWeight: 700,
                                                display: 'flex', alignItems: 'center', gap: '0.5rem',
                                                border: '1px solid rgba(255,255,255,0.35)', backdropFilter: 'blur(10px)'
                                            }}>
                                                <Clock size={18} /> +5분 연장
                                            </button>
                                            <button type="button" onClick={handleForceFinish} disabled={!isDemoLive && !selectedAttemptDetailsReady} style={{
                                                background: 'var(--error)', color: 'white', padding: '0.75rem 1.25rem',
                                                borderRadius: 'var(--radius-full)', fontSize: 'var(--type-label)', fontWeight: 800,
                                                display: 'flex', alignItems: 'center', gap: '0.5rem',
                                                border: '1px solid color-mix(in srgb, var(--error) 72%, white)',
                                                    boxShadow: '0 4px 14px rgba(15,23,42,0.18)',
                                                    opacity: !isDemoLive && !selectedAttemptDetailsReady ? 0.6 : 1,
                                            }}>
                                                <AlertTriangle size={18} /> 종료 처리
                                            </button>
                                        </div>
                                        <p id="live-refresh-control-help" style={{ margin: 0, maxWidth: 560, textAlign: 'right', fontSize: 'var(--type-caption)', lineHeight: 1.45, color: 'rgba(255,255,255,0.9)' }}>
                                            교사 화면의 자동 갱신만 멈춥니다. 학생 응시와 시험 시간은 계속됩니다.
                                        </p>
                                    </div>
                                </div>
                            </div>
                        ) : (
                            <div className="bento-card" role="status" style={{ marginBottom: '1.25rem', padding: '1.5rem 2rem', display: 'flex', alignItems: 'center', gap: '1rem', minHeight: 0 }}>
                                <div style={{ width: 48, height: 48, borderRadius: 'var(--radius-md)', display: 'grid', placeItems: 'center', color: selectedPhase === 'completed' ? 'var(--success)' : 'var(--primary)', background: selectedPhase === 'completed' ? 'color-mix(in srgb, var(--success) 10%, var(--surface))' : 'color-mix(in srgb, var(--primary) 10%, var(--surface))' }}>
                                    {selectedPhase === 'completed' ? <CheckCircle2 size={23} /> : <Clock size={23} />}
                                </div>
                                <div>
                                    <StatusPill tone={livePresentation.tone} size="sm" label={livePresentation.label} />
                                    <h2 style={{ marginTop: '0.65rem', fontSize: 'var(--type-heading-md)', fontWeight: 800 }}>{exam.title}</h2>
                                    <p style={{ marginTop: '0.3rem', color: 'var(--muted)', fontSize: 'var(--type-body-sm)', lineHeight: 1.55 }}>{livePresentation.description}</p>
                                </div>
                            </div>
                        )}

                        {/* Stats */}
                        <div className="bento-grid live-summary-rail" style={{ marginBottom: '1.25rem' }}>
                            <StatTile icon={<CheckCircle2 size={22} />} label="제출 완료" value={counts.submitted} color="var(--success)" />
                            <StatTile icon={<Activity size={22} />} label="응시 중" value={counts.inProgress} color="var(--primary)" pulse />
                            <StatTile icon={<Clock size={22} />} label="미응시" value={counts.notStarted} color="var(--warning)" />
                            <StatTile icon={<Users size={22} />} label="제출 평균" value={avgScore > 0 ? `${avgScore}점` : "—"} color="var(--accent)" />
                        </div>

                        {showLiveControls && (
                            <section className="live-mobile-controls mobile-section-stack" aria-label="실시간 시험 작업">
                                <button
                                    type="button"
                                    className="btn btn-primary"
                                    onClick={() => setIsScreenRefreshPaused(paused => !paused)}
                                    aria-label={isScreenRefreshPaused ? "화면 갱신 재개" : "화면 갱신 일시정지"}
                                    aria-pressed={isScreenRefreshPaused}
                                    aria-describedby="live-mobile-refresh-control-help"
                                >
                                    {isScreenRefreshPaused ? <PlayCircle size={18} /> : <PauseCircle size={18} />}
                                    {isScreenRefreshPaused ? '화면 갱신 재개' : '화면 갱신 일시정지'}
                                </button>
                                <p id="live-mobile-refresh-control-help">
                                    교사 화면의 자동 갱신만 멈춥니다. 학생 응시와 시험 시간은 계속됩니다.
                                </p>
                                <div className="mobile-action-row">
                                    <button type="button" className="btn btn-secondary" onClick={handleExtendTime}>
                                        <Clock size={18} /> +5분 연장
                                    </button>
                                    <button type="button" className="btn btn-danger" onClick={handleForceFinish} disabled={!isDemoLive && !selectedAttemptDetailsReady}>
                                        <AlertTriangle size={18} /> 종료 처리
                                    </button>
                                </div>
                            </section>
                        )}

                        {/* Main grid: Students + Heatmap */}
                        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '1.25rem' }} className="live-grid">
                            {/* Students live view */}
                            <div className="bento-card" style={{ padding: '1.5rem' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
                                    <h3 style={{ fontSize: '1.1rem', fontWeight: 700 }}>학생별 제출 현황</h3>
                                    <button type="button" onClick={handleNotifyNotStarted} style={{
                                        background: 'color-mix(in srgb, var(--warning) 10%, var(--surface))', color: 'var(--warning)', padding: '0.5rem 1rem',
                                        borderRadius: 'var(--radius-full)', fontSize: '0.8rem', fontWeight: 700,
                                        display: 'flex', alignItems: 'center', gap: '0.4rem', border: '1px solid color-mix(in srgb, var(--warning) 28%, var(--border))',
                                        minHeight: '2.75rem',
                                    }}>
                                        <Bell size={14} /> 미응시자 확인
                                    </button>
                                </div>
                                {!isDemoLive && !selectedAttemptDetailsReady ? (
                                    <div role="status" style={{ padding: '3rem 1rem', textAlign: 'center', color: 'var(--muted)', fontSize: '0.9rem' }}>
                                        {selectedAttemptDetails.status === "failed"
                                            ? "상세 응시 데이터를 불러오지 못했습니다. 새로고침 후 다시 시도해 주세요."
                                            : "상세 응시 데이터를 불러오는 중입니다."}
                                    </div>
                                ) : students.length > 0 ? (
                                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '0.8rem' }}>
                                        {students.map((s, idx) => (
                                            <StudentCard key={s.id} student={s} delay={idx * 20} />
                                        ))}
                                    </div>
                                ) : (
                                    <div style={{ padding: '3rem 1rem', textAlign: 'center', color: 'var(--muted)', fontSize: '0.9rem' }}>
                                        아직 응시 기록이 없습니다.
                                    </div>
                                )}
                            </div>

                            {/* Question heatmap */}
                            <div className="bento-card" style={{ padding: '1.5rem' }}>
                                <h3 style={{ fontSize: '1.1rem', fontWeight: 700, marginBottom: '0.25rem' }}>문항별 정답률</h3>
                                <p style={{ fontSize: '0.8rem', color: 'var(--muted)', marginBottom: '1.25rem' }}>
                                    {!isDemoLive && !selectedAttemptDetailsReady
                                        ? "상세 답안 데이터를 불러오는 중"
                                        : `제출 완료한 ${submittedStudents.length}명 기준`}
                                </p>
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.5rem' }}>
                                    {heatmap.map(h => {
                                        const hasData = h.total > 0;
                                        const pct = hasData ? safeRatePercent(h.correct, h.total) : 0;
                                        const color = !hasData ? 'var(--muted)' : pct >= 75 ? 'var(--success)' : pct >= 50 ? 'var(--warning)' : 'var(--grade-red)';
                                        const bg = !hasData ? 'var(--background)' : pct >= 75 ? 'color-mix(in srgb, var(--success) 12%, var(--surface))' : pct >= 50 ? 'color-mix(in srgb, var(--warning) 12%, var(--surface))' : 'var(--grade-red-soft)';
                                        return (
                                            <div key={h.q} style={{
                                                padding: '0.75rem 0.5rem', background: bg, borderRadius: 'var(--radius-md)',
                                                textAlign: 'center', border: `1px solid ${color}33`,
                                                transition: 'var(--transition-base)', cursor: 'default'
                                            }}
                                                title={hasData ? `Q${h.q}: ${pct}% (${h.correct}/${h.total})` : `Q${h.q}: 제출 데이터 없음`}
                                            >
                                                <div style={{ fontSize: '0.7rem', color: 'var(--muted)', fontWeight: 700 }}>Q{h.q}</div>
                                                <div style={{ fontSize: '1rem', fontWeight: 800, color }}>{hasData ? `${pct}%` : '—'}</div>
                                            </div>
                                        );
                                    })}
                                </div>

                                <div style={{ marginTop: '1.5rem', padding: '1rem', background: 'var(--background)', borderRadius: 'var(--radius-md)', border: '1px dashed var(--border)' }}>
                                    <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--grade-red)', letterSpacing: '0.08em', marginBottom: '0.5rem' }}>오답률 주의 문항</div>
                                    {!hasHeatmapData && (
                                        <div style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>제출 완료 데이터가 쌓이면 자동으로 표시됩니다.</div>
                                    )}
                                    {hasHeatmapData && weakHeatmapCells.slice(0, 3).map(h => (
                                        <div key={h.q} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', padding: '0.35rem 0' }}>
                                            <span style={{ fontWeight: 600 }}>Q{h.q}</span>
                                            <span style={{ color: 'var(--grade-red)', fontWeight: 700 }}>{safeRatePercent(h.correct, h.total)}%</span>
                                        </div>
                                    ))}
                                    {hasHeatmapData && weakHeatmapCells.length === 0 && (
                                        <div style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>현재까진 양호합니다.</div>
                                    )}
                                </div>
                            </div>
                        </div>
                    </>
                ) : (
                    <div className="bento-card" style={{ padding: '3rem 2rem', textAlign: 'center' }}>
                        <div style={{
                            width: 72,
                            height: 72,
                            borderRadius: '50%',
                            background: 'rgba(99,102,241,0.1)',
                            color: 'var(--primary)',
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            marginBottom: '1rem',
                        }}>
                            <Activity size={32} />
                        </div>
                        <h2 style={{ fontSize: '1.3rem', fontWeight: 800, marginBottom: '0.45rem' }}>
                            진행 중인 시험이 없습니다
                        </h2>
                        <p style={{ color: 'var(--muted)', fontSize: '0.95rem', lineHeight: 1.7, marginBottom: '1.35rem', wordBreak: 'keep-all' }}>
                            시험을 만든 뒤 학생 응시가 시작되면 실시간 현황과 문항별 정답률이 표시됩니다.
                        </p>
                        <Link
                            href="/create"
                            style={{
                                padding: '0.75rem 1.2rem',
                                background: 'var(--primary)',
                                color: 'white',
                                borderRadius: 'var(--radius-full)',
                                fontWeight: 800,
                                fontSize: '0.9rem',
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '0.5rem',
                            }}
                        >
                            <PlusCircle size={18} /> 시험 만들기
                        </Link>
                    </div>
                )}
            </main>

            <style>{`
                @media (max-width: 1024px) {
                    .live-grid { grid-template-columns: 1fr !important; }
                }
            `}</style>
            {forceFinishConfirmOpen && hasExam && (
                <ForceFinishConfirmDialog
                    examTitle={exam.title}
                    body={
                        isDemoLive
                            ? "시험을 지금 종료합니다. 아직 제출하지 않은 합성 학생은 현재 진행률 기준으로 제출 처리됩니다."
                            : forceFinishTargets.length + activeSessions.length > 0
                                ? `시험의 저장된 응시 중 제출 ${forceFinishTargets.length + activeSessions.length}건을 완료 처리합니다. 답안이 없는 문항은 미응답으로 채점되며 이미 제출된 답안은 변경하지 않습니다.`
                                : "시험의 진행 중 제출이 없어 저장 데이터는 변경하지 않고 로컬 타이머만 종료합니다."
                    }
                    confirmLabel={isDemoLive || forceFinishTargets.length + activeSessions.length > 0 ? "지금 종료" : "타이머 종료"}
                    onCancel={() => setForceFinishConfirmOpen(false)}
                    onConfirm={confirmForceFinish}
                />
            )}
        </div>
    );
}

function StatTile({ icon, label, value, color, pulse }: { icon: React.ReactNode; label: string; value: string | number; color: string; pulse?: boolean }) {
    return (
        <div className="bento-card" style={{ padding: '1.25rem 1.4rem', position: 'relative', overflow: 'hidden' }}>
            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, background: `linear-gradient(90deg, ${color}, transparent)` }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
                <div>
                    <div style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '0.5rem' }}>{label}</div>
                    <div style={{ fontSize: '2rem', fontWeight: 900, letterSpacing: '-0.03em', fontVariantNumeric: 'tabular-nums', color: 'var(--foreground)' }}>{value}</div>
                </div>
                <div style={{
                    color, background: `color-mix(in srgb, ${color}, transparent 88%)`,
                    padding: 10, borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    animation: pulse ? 'pulse 2s ease-in-out infinite' : undefined
                }}>{icon}</div>
            </div>
        </div>
    );
}

function StudentCard({ student, delay }: { student: LiveStudent; delay: number }) {
    const statusMeta: Record<StudentStatus, { color: string; bg: string; label: string }> = {
        submitted: { color: 'var(--success)', bg: 'color-mix(in srgb, var(--success) 8%, var(--surface))', label: '제출 완료' },
        in_progress: { color: 'var(--primary)', bg: 'color-mix(in srgb, var(--primary) 8%, var(--surface))', label: '응시 중' },
        not_started: { color: 'var(--warning)', bg: 'color-mix(in srgb, var(--warning) 8%, var(--surface))', label: '미응시' },
    };
    const meta = statusMeta[student.status];

    return (
        <div style={{
            padding: '0.9rem', background: meta.bg, borderRadius: 'var(--radius-md)',
            border: `1px solid ${meta.color}22`, animation: `fadeIn 0.3s ${delay}ms both`,
            transition: 'var(--transition-base)', cursor: 'pointer'
        }}
            className="card-hover"
        >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.6rem' }}>
                <div style={{
                    width: 32, height: 32, borderRadius: '50%', background: student.avatar,
                    color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '0.75rem', fontWeight: 700
                }}>{student.name.slice(0, 1)}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--foreground)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{student.name}</div>
                    <div style={{ fontSize: '0.7rem', color: meta.color, fontWeight: 700 }}>{meta.label}</div>
                </div>
                {student.score !== undefined && (
                    <div style={{ fontSize: '0.95rem', fontWeight: 800, color: meta.color }}>{student.score}</div>
                )}
            </div>
            {student.awayCount > 0 && (
                <span
                    className="away-severity-badge"
                    data-away-severity={awaySeverity(student.awayCount)}
                >
                    화면 이탈 {student.awayCount}회
                </span>
            )}
            <div style={{ height: 5, background: 'var(--border)', borderRadius: 'var(--radius-full)', overflow: 'hidden' }}>
                <div style={{ width: `${student.progress}%`, height: '100%', background: meta.color, borderRadius: 'var(--radius-full)', transition: 'width 0.6s ease-out' }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', color: 'var(--muted)', marginTop: '0.4rem', fontWeight: 600 }}>
                <span>{student.currentQ}/{student.totalQ} 문항</span>
                <span>{student.progress}%</span>
            </div>
        </div>
    );
}
