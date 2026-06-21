"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import OMRCardView from "@/components/OMRCardView";
import ThemeToggle from "@/components/ThemeToggle";
import dynamic from "next/dynamic";
import { toast } from "@/components/Toast";
import { AlertTriangle, Clock, PanelRightClose, PanelRightOpen, PenLine, Save } from "lucide-react";
import { storedDataUrlToFile, saveJsonRecord, loadJsonRecord } from "@/utils/blobStore";
import { resolveDraftDrawings } from "@/lib/draftRecovery";
import { verifyTeacherPassword } from "@/app/actions/auth";
import { saveTeacherSessionWithIdentity } from "@/lib/teacherSession";
import { getOrCreateGuestId, getSession, saveSession, type StudentSession } from "@/utils/storage";
import { canArchiveHandwriting, getCurrentPlan, getPlanLabel } from "@/utils/plans";
import { loadExam as loadPersistedExam, saveAttempt } from "@/lib/omrPersistence";
import { buildQuestionResults } from "@/lib/premiumAnalytics";
import { summarizeQuestionDrawings } from "@/lib/handwritingAnalytics";
import { evaluateExamAccess, examRequiresPin, normalizeExamPin, verifyExamPin, type ExamAccessDecision } from "@/lib/examAccess";
import { summarizePersistenceWrite } from "@/lib/persistenceFeedback";

const PDFViewer = dynamic(() => import("@/components/PDFViewer"), { ssr: false });
import { DEFAULT_CHOICE_COUNT, gradeAttempt, questionChoiceCount } from "@/types/omr";
import type {
    Attempt,
    Exam,
    FocusLossEvent,
    PdfDrawings,
    PlanKey,
    Question,
    QuestionTiming,
    RetakeMetadata,
    StoredDataRef,
} from "@/types/omr";

const AUTOSAVE_INTERVAL_MS = 3000;
const OMR_PANEL_STORAGE_PREFIX = "omr_solve_panel";

interface SolveDraft {
    answers: Record<number, number>;
    /** Legacy inline drawings. New drafts store large handwriting payloads in IndexedDB. */
    drawings?: PdfDrawings;
    drawingsRef?: StoredDataRef;
    timeRemaining: number | null;
    startedAt: string;
    savedAt: string;
}

interface QuestionTimingDraft {
    questionId: number;
    questionNumber: number;
    totalMs: number;
    visitCount: number;
    answerChangeCount: number;
    firstVisitedAt?: string;
    lastVisitedAt?: string;
    lastAnsweredAt?: string;
}

type RetakeConfig = Omit<RetakeMetadata, "createdAt">;

interface SubmitConfirmState {
    unanswered: number;
    total: number;
}

interface SolveLoadError {
    title: string;
    body: string;
}

function SolveDialogShell({
    title,
    children,
    onClose,
}: {
    title: string;
    children: React.ReactNode;
    onClose: () => void;
}) {
    return (
        <div
            role="presentation"
            onClick={onClose}
            style={{
                position: 'fixed',
                inset: 0,
                zIndex: 10000,
                background: 'rgba(15,23,42,0.68)',
                backdropFilter: 'blur(8px)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 'max(1rem, env(safe-area-inset-top)) max(1rem, env(safe-area-inset-right)) max(1rem, env(safe-area-inset-bottom)) max(1rem, env(safe-area-inset-left))',
            }}
        >
            <div
                role="dialog"
                aria-modal="true"
                aria-label={title}
                onClick={(e) => e.stopPropagation()}
                style={{
                    width: '100%',
                    maxWidth: 420,
                    background: 'var(--surface)',
                    color: 'var(--foreground)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-lg)',
                    boxShadow: '0 24px 60px rgba(0,0,0,0.28)',
                    padding: '1.5rem',
                }}
            >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', alignItems: 'flex-start', marginBottom: '1rem' }}>
                    <h2 style={{ fontSize: '1.15rem', fontWeight: 800, lineHeight: 1.3 }}>{title}</h2>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="닫기"
                        style={{ color: 'var(--muted)', fontSize: '1.25rem', lineHeight: 1 }}
                    >
                        ×
                    </button>
                </div>
                {children}
            </div>
        </div>
    );
}

const dialogButtonBase: CSSProperties = {
    padding: '0.7rem 1rem',
    borderRadius: 'var(--radius-md)',
    fontWeight: 700,
    fontSize: '0.9rem',
};

function ExamPinDialog({
    examTitle,
    value,
    error,
    onChange,
    onSubmit,
    onExit,
}: {
    examTitle: string;
    value: string;
    error: string;
    onChange: (value: string) => void;
    onSubmit: () => void;
    onExit: () => void;
}) {
    return (
        <SolveDialogShell title="시험 PIN 확인" onClose={onExit}>
            <p style={{ color: 'var(--muted)', fontSize: '0.9rem', lineHeight: 1.6, marginBottom: '1rem', wordBreak: 'keep-all' }}>
                “{examTitle}” 시험은 PIN이 설정되어 있습니다. 선생님이 안내한 4~6자리 숫자를 입력하세요.
            </p>
            <input
                autoFocus
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete="one-time-code"
                maxLength={6}
                value={value}
                onChange={(event) => onChange(normalizeExamPin(event.target.value))}
                onKeyDown={(event) => {
                    if (event.key === "Enter") onSubmit();
                }}
                aria-label="시험 PIN"
                style={{
                    width: '100%',
                    padding: '0.8rem 0.95rem',
                    borderRadius: 'var(--radius-md)',
                    border: `1px solid ${error ? 'var(--error)' : 'var(--border)'}`,
                    background: 'var(--background)',
                    color: 'var(--foreground)',
                    fontSize: '1.15rem',
                    fontWeight: 800,
                    letterSpacing: '0.32rem',
                    textAlign: 'center',
                    fontVariantNumeric: 'tabular-nums',
                    marginBottom: '0.75rem',
                }}
            />
            {error && (
                <div role="alert" style={{ color: 'var(--error)', fontSize: '0.82rem', fontWeight: 800, marginBottom: '0.9rem' }}>
                    {error}
                </div>
            )}
            <button
                type="button"
                className="btn btn-primary"
                onClick={onSubmit}
                style={{ width: '100%', justifyContent: 'center', padding: '0.78rem 1rem' }}
            >
                입장하기
            </button>
        </SolveDialogShell>
    );
}

function accessDecisionCopy(decision: ExamAccessDecision): { title: string; body: string; action: string } {
    const formatDate = (value?: string) => value ? new Date(value).toLocaleString('ko-KR') : "";
    if (decision.status === "not_started") {
        return {
            title: "아직 응시 시작 전입니다",
            body: decision.at
                ? `${formatDate(decision.at)}부터 응시할 수 있습니다.`
                : "선생님이 설정한 시작 시각 이후에 응시할 수 있습니다.",
            action: "학생 홈으로",
        };
    }
    if (decision.status === "ended") {
        return {
            title: "응시 기간이 종료되었습니다",
            body: decision.at
                ? `${formatDate(decision.at)}에 응시 가능 시간이 끝났습니다.`
                : "이 시험의 응시 가능 시간이 지났습니다.",
            action: "학생 홈으로",
        };
    }
    if (decision.status === "login_required") {
        return {
            title: "학생 로그인이 필요합니다",
            body: "이 시험은 지정된 반 학생만 응시할 수 있습니다. 학생 홈에서 이름과 반을 선택한 뒤 다시 열어주세요.",
            action: "학생 로그인",
        };
    }
    if (decision.status === "group_denied") {
        return {
            title: "응시 대상 반이 아닙니다",
            body: "현재 학생 계정은 이 시험의 배포 대상 반에 포함되어 있지 않습니다. 반 선택이 잘못됐다면 학생 홈에서 다시 로그인하세요.",
            action: "학생 홈으로",
        };
    }
    if (decision.status === "archived") {
        return {
            title: "보관된 시험입니다",
            body: "선생님이 보관 처리한 시험은 학생 응시 화면에서 열 수 없습니다.",
            action: "학생 홈으로",
        };
    }
    return {
        title: "시험을 열 수 없습니다",
        body: "시험 접근 설정을 확인해주세요.",
        action: "학생 홈으로",
    };
}

function ExamAccessBlockedDialog({
    decision,
    onExit,
}: {
    decision: ExamAccessDecision;
    onExit: () => void;
}) {
    const copy = accessDecisionCopy(decision);
    return (
        <SolveDialogShell title={copy.title} onClose={onExit}>
            <p style={{ color: 'var(--muted)', fontSize: '0.95rem', lineHeight: 1.7, marginBottom: '1.25rem', wordBreak: 'keep-all' }}>
                {copy.body}
            </p>
            <button
                type="button"
                className="btn btn-primary"
                onClick={onExit}
                style={{ width: '100%', justifyContent: 'center', padding: '0.78rem 1rem' }}
            >
                {copy.action}
            </button>
        </SolveDialogShell>
    );
}

function SolveLoadErrorCard({ error }: { error: SolveLoadError }) {
    return (
        <div className="layout-main solve-page" style={{
            background: 'var(--background)',
            minHeight: '100dvh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '1rem',
        }}>
            <div className="bento-card" role="alert" style={{
                width: '100%',
                maxWidth: 440,
                padding: '2rem',
                textAlign: 'center',
                border: '1px solid var(--border)',
                boxShadow: '0 18px 48px rgba(15,23,42,0.12)',
            }}>
                <div style={{
                    width: 64,
                    height: 64,
                    borderRadius: '50%',
                    background: 'rgba(239,68,68,0.1)',
                    color: 'var(--error)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    marginBottom: '1rem',
                }}>
                    <AlertTriangle size={30} />
                </div>
                <h2 style={{ fontSize: '1.25rem', fontWeight: 850, marginBottom: '0.55rem', lineHeight: 1.35 }}>
                    {error.title}
                </h2>
                <p style={{ color: 'var(--muted)', fontSize: '0.95rem', lineHeight: 1.7, marginBottom: '1.35rem', wordBreak: 'keep-all' }}>
                    {error.body}
                </p>
                <Link href="/?role=student" className="btn btn-primary" style={{ justifyContent: 'center' }}>
                    학생 홈으로
                </Link>
            </div>
        </div>
    );
}

function SubmitConfirmDialog({
    state,
    onClose,
    onConfirm,
}: {
    state: SubmitConfirmState;
    onClose: () => void;
    onConfirm: () => void;
}) {
    const hasUnanswered = state.unanswered > 0;
    return (
        <SolveDialogShell title="답안 제출" onClose={onClose}>
            <p style={{ color: 'var(--muted)', fontSize: '0.95rem', lineHeight: 1.7, marginBottom: '1.25rem', wordBreak: 'keep-all' }}>
                {hasUnanswered
                    ? `전체 ${state.total}문항 중 ${state.unanswered}문항이 아직 비어 있습니다. 그대로 제출할까요?`
                    : `전체 ${state.total}문항 답안을 모두 선택했습니다. 제출하면 복습 화면으로 이동합니다.`}
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
                <button type="button" onClick={onClose} style={{ ...dialogButtonBase, background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)' }}>
                    계속 풀기
                </button>
                <button type="button" onClick={onConfirm} style={{ ...dialogButtonBase, background: 'var(--primary)', color: 'white' }}>
                    제출하기
                </button>
            </div>
        </SolveDialogShell>
    );
}

function GuestNameDialog({
    value,
    onChange,
    onClose,
    onSubmit,
}: {
    value: string;
    onChange: (value: string) => void;
    onClose: () => void;
    onSubmit: () => void;
}) {
    return (
        <SolveDialogShell title="게스트 제출" onClose={onClose}>
            <p style={{ color: 'var(--muted)', fontSize: '0.95rem', lineHeight: 1.7, marginBottom: '1rem', wordBreak: 'keep-all' }}>
                공개 시험입니다. 결과를 구분할 이름을 입력하면 이 기기의 게스트 기록으로 저장합니다.
            </p>
            <input
                value={value}
                onChange={(e) => onChange(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' && value.trim()) onSubmit();
                }}
                autoFocus
                placeholder="이름 입력"
                autoComplete="name"
                style={{
                    width: '100%',
                    padding: '0.8rem 0.95rem',
                    borderRadius: 'var(--radius-md)',
                    border: '1px solid var(--border)',
                    background: 'var(--background)',
                    color: 'var(--foreground)',
                    fontSize: '1rem',
                    marginBottom: '1.25rem',
                }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
                <button type="button" onClick={onClose} style={{ ...dialogButtonBase, background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)' }}>
                    취소
                </button>
                <button type="button" onClick={onSubmit} disabled={!value.trim()} style={{ ...dialogButtonBase, background: 'var(--primary)', color: 'white', opacity: value.trim() ? 1 : 0.55 }}>
                    저장하고 제출
                </button>
            </div>
        </SolveDialogShell>
    );
}

function TeacherPasswordDialog({
    identifier,
    password,
    error,
    isChecking,
    onIdentifierChange,
    onPasswordChange,
    onClose,
    onSubmit,
}: {
    identifier: string;
    password: string;
    error: string;
    isChecking: boolean;
    onIdentifierChange: (value: string) => void;
    onPasswordChange: (value: string) => void;
    onClose: () => void;
    onSubmit: () => void;
}) {
    return (
        <SolveDialogShell title="선생님 모드 인증" onClose={onClose}>
            <p style={{ color: 'var(--muted)', fontSize: '0.95rem', lineHeight: 1.7, marginBottom: '1rem', wordBreak: 'keep-all' }}>
                정답/해설 PDF와 문제지를 전환하려면 선생님 계정 인증이 필요합니다.
            </p>
            <input
                type="text"
                value={identifier}
                onChange={(e) => onIdentifierChange(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' && identifier.trim() && password.trim()) onSubmit();
                }}
                autoFocus
                placeholder="아이디 또는 이메일"
                autoComplete="username"
                autoCapitalize="none"
                inputMode="email"
                spellCheck={false}
                style={{
                    width: '100%',
                    padding: '0.8rem 0.95rem',
                    borderRadius: 'var(--radius-md)',
                    border: `1px solid ${error ? 'var(--error)' : 'var(--border)'}`,
                    background: 'var(--background)',
                    color: 'var(--foreground)',
                    fontSize: '1rem',
                    marginBottom: '0.65rem',
                }}
            />
            <input
                type="password"
                value={password}
                onChange={(e) => onPasswordChange(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' && identifier.trim() && password.trim()) onSubmit();
                }}
                placeholder="비밀번호"
                autoComplete="current-password"
                style={{
                    width: '100%',
                    padding: '0.8rem 0.95rem',
                    borderRadius: 'var(--radius-md)',
                    border: `1px solid ${error ? 'var(--error)' : 'var(--border)'}`,
                    background: 'var(--background)',
                    color: 'var(--foreground)',
                    fontSize: '1rem',
                }}
            />
            {error && (
                <div role="alert" style={{ marginTop: '0.6rem', color: 'var(--error)', fontSize: '0.82rem', fontWeight: 700 }}>
                    {error}
                </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1.25rem' }}>
                <button type="button" onClick={onClose} style={{ ...dialogButtonBase, background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)' }}>
                    닫기
                </button>
                <button type="button" onClick={onSubmit} disabled={!identifier.trim() || !password.trim() || isChecking} style={{ ...dialogButtonBase, background: 'var(--primary)', color: 'white', opacity: identifier.trim() && password.trim() && !isChecking ? 1 : 0.55 }}>
                    {isChecking ? "확인 중..." : "인증"}
                </button>
            </div>
        </SolveDialogShell>
    );
}

function compactDrawings(drawings: PdfDrawings): PdfDrawings {
    return Object.fromEntries(
        Object.entries(drawings).filter(([, paths]) => paths.length > 0)
    ) as PdfDrawings;
}

function hasDrawings(drawings: PdfDrawings): boolean {
    return Object.values(drawings).some(paths => paths.length > 0);
}

function drawingStrokeCount(drawings: PdfDrawings): number {
    return Object.values(drawings).reduce((sum, paths) => sum + paths.length, 0);
}

function questionDrawingsById(questionDrawings: ReturnType<typeof summarizeQuestionDrawings>): Record<number, ReturnType<typeof summarizeQuestionDrawings>[number]> {
    return questionDrawings.reduce((acc, item) => {
        acc[item.questionId] = item;
        return acc;
    }, {} as Record<number, ReturnType<typeof summarizeQuestionDrawings>[number]>);
}

export default function SolvePage() {
    const params = useParams();
    const router = useRouter();
    const id = params?.id as string;

    const [examData, setExamData] = useState<Exam | null>(null);
    const [loadError, setLoadError] = useState<SolveLoadError | null>(null);
    const [studentAnswers, setStudentAnswers] = useState<Record<number, number>>({});
    const [drawings, setDrawings] = useState<PdfDrawings>({});
    const [pdfFile, setPdfFile] = useState<File | null>(null);
    const [currentPlan, setCurrentPlan] = useState<PlanKey>("free");
    const [retakeConfig, setRetakeConfig] = useState<RetakeConfig | null>(null);

    const [user, setUser] = useState<StudentSession | null>(() => getSession());

    // Navigation State
    const [currentQuestionId, setCurrentQuestionId] = useState<number | null>(null);
    const [pdfCurrentPage, setPdfCurrentPage] = useState<number | undefined>(undefined);

    // Teacher Mode State
    const [isTeacherMode, setIsTeacherMode] = useState(false);
    const [activeTab, setActiveTab] = useState<'problem' | 'answer'>('problem');
    const [answerFile, setAnswerFile] = useState<File | null>(null);
    const [teacherAuthOpen, setTeacherAuthOpen] = useState(false);
    const [teacherIdentifier, setTeacherIdentifier] = useState("");
    const [teacherPassword, setTeacherPassword] = useState("");
    const [teacherAuthError, setTeacherAuthError] = useState("");
    const [isTeacherAuthing, setIsTeacherAuthing] = useState(false);

    // Layout State
    const [isOMRCollapsed, setIsOMRCollapsed] = useState(false);
    const [submitConfirm, setSubmitConfirm] = useState<SubmitConfirmState | null>(null);
    const [guestSubmitPending, setGuestSubmitPending] = useState<{ autoSubmitted: boolean } | null>(null);
    const [guestName, setGuestName] = useState("");

    // Timer + autosave State
    const [startedAt, setStartedAt] = useState(() => new Date().toISOString());
    const [timeRemaining, setTimeRemaining] = useState<number | null>(null); // seconds
    const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
    const [hasResumed, setHasResumed] = useState(false);
    const [pinVerified, setPinVerified] = useState(false);
    const [pinInput, setPinInput] = useState("");
    const [pinError, setPinError] = useState("");
    const submittedRef = useRef(false);
    const latestDraftRef = useRef<SolveDraft | null>(null);
    const autosaveErrorShownRef = useRef(false);
    const examQuestionsRef = useRef<Question[]>([]);
    const currentQuestionIdRef = useRef<number | null>(null);
    const activeQuestionRef = useRef<{ questionId: number; startedAtMs: number } | null>(null);
    const questionTimingRef = useRef<Record<number, QuestionTimingDraft>>({});
    const focusLossEventsRef = useRef<FocusLossEvent[]>([]);
    const [hydratedOMRPanelKey, setHydratedOMRPanelKey] = useState("");
    
    // Focus Warning States (Anti-cheat)
    const [tabFociLostCount, setTabFociLostCount] = useState(0);
    const [showFocusWarning, setShowFocusWarning] = useState(false);

    // Stable per-device student/guest id
    const [persistId] = useState(() => {
        if (typeof window === "undefined") return "";
        let pid = localStorage.getItem("omr_student_pid");
        if (!pid) {
            pid = `pid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
            localStorage.setItem("omr_student_pid", pid);
        }
        return pid;
    });

    const getQuestionById = useCallback((questionId: number) => {
        return examQuestionsRef.current.find(q => q.id === questionId);
    }, []);

    const ensureQuestionTiming = useCallback((questionId: number, nowMs = Date.now()) => {
        const existing = questionTimingRef.current[questionId];
        if (existing) return existing;

        const question = getQuestionById(questionId);
        const timestamp = new Date(nowMs).toISOString();
        const next: QuestionTimingDraft = {
            questionId,
            questionNumber: question?.number || questionId,
            totalMs: 0,
            visitCount: 0,
            answerChangeCount: 0,
            firstVisitedAt: timestamp,
            lastVisitedAt: timestamp,
        };
        questionTimingRef.current[questionId] = next;
        return next;
    }, [getQuestionById]);

    const settleActiveQuestion = useCallback((nowMs = Date.now()) => {
        const active = activeQuestionRef.current;
        if (!active) return;
        const timing = ensureQuestionTiming(active.questionId, active.startedAtMs);
        timing.totalMs += Math.max(0, nowMs - active.startedAtMs);
        timing.lastVisitedAt = new Date(nowMs).toISOString();
        activeQuestionRef.current = null;
    }, [ensureQuestionTiming]);

    const beginQuestionVisit = useCallback((questionId: number, nowMs = Date.now()) => {
        if (activeQuestionRef.current?.questionId === questionId) {
            setCurrentQuestionId(questionId);
            return;
        }

        settleActiveQuestion(nowMs);
        const timing = ensureQuestionTiming(questionId, nowMs);
        timing.visitCount += 1;
        timing.lastVisitedAt = new Date(nowMs).toISOString();
        activeQuestionRef.current = { questionId, startedAtMs: nowMs };
        currentQuestionIdRef.current = questionId;
        setCurrentQuestionId(questionId);
    }, [ensureQuestionTiming, settleActiveQuestion]);

    const getActiveExamQuestions = () => {
        if (!examData) return [];
        if (!retakeConfig) return examData.questions;
        const activeIds = new Set(retakeConfig.questionIds);
        const scoped = examData.questions.filter(q => activeIds.has(q.id));
        return scoped.length > 0 ? scoped : examData.questions;
    };

    const buildQuestionTimingSnapshot = (questions: Question[]): QuestionTiming[] => {
        settleActiveQuestion(Date.now());
        const activeIds = new Set(questions.map(q => q.id));
        return Object.values(questionTimingRef.current)
            .filter(timing => activeIds.has(timing.questionId))
            .map(timing => ({
                questionId: timing.questionId,
                questionNumber: timing.questionNumber,
                totalTimeSec: Math.round(timing.totalMs / 1000),
                visitCount: timing.visitCount,
                revisitCount: Math.max(0, timing.visitCount - 1),
                answerChangeCount: timing.answerChangeCount,
                firstVisitedAt: timing.firstVisitedAt,
                lastVisitedAt: timing.lastVisitedAt,
                lastAnsweredAt: timing.lastAnsweredAt,
            }))
            .sort((a, b) => a.questionNumber - b.questionNumber);
    };

    // Anti-cheat Window Focus/Visibility Monitoring
    useEffect(() => {
        if (submittedRef.current) return;
        if (examData && evaluateExamAccess(examData, { session: user, pinVerified }).status !== "allowed") return;

        let isFocused = true;

        const triggerWarning = (reason: FocusLossEvent["reason"]) => {
            if (submittedRef.current) return;
            const nowMs = Date.now();
            const questionId = activeQuestionRef.current?.questionId || currentQuestionIdRef.current || undefined;
            const question = questionId ? getQuestionById(questionId) : undefined;
            settleActiveQuestion(nowMs);
            const nextCount = focusLossEventsRef.current.length + 1;
            focusLossEventsRef.current.push({
                at: new Date(nowMs).toISOString(),
                questionId,
                questionNumber: question?.number,
                count: nextCount,
                reason,
            });
            setTabFociLostCount(c => {
                setShowFocusWarning(true);
                return Math.max(c + 1, nextCount);
            });
        };

        const handleWindowBlur = () => {
            if (isFocused) {
                isFocused = false;
                triggerWarning("blur");
            }
        };

        const handleWindowFocus = () => {
            isFocused = true;
            if (currentQuestionIdRef.current) beginQuestionVisit(currentQuestionIdRef.current);
        };

        const handleVisibilityChange = () => {
            if (document.visibilityState === "hidden" && isFocused) {
                isFocused = false;
                triggerWarning("hidden");
            } else if (document.visibilityState === "visible") {
                isFocused = true;
                if (currentQuestionIdRef.current) beginQuestionVisit(currentQuestionIdRef.current);
            }
        };

        window.addEventListener("blur", handleWindowBlur);
        window.addEventListener("focus", handleWindowFocus);
        document.addEventListener("visibilitychange", handleVisibilityChange);

        return () => {
            window.removeEventListener("blur", handleWindowBlur);
            window.removeEventListener("focus", handleWindowFocus);
            document.removeEventListener("visibilitychange", handleVisibilityChange);
        };
    }, [beginQuestionVisit, examData, getQuestionById, pinVerified, settleActiveQuestion, user]);

    useEffect(() => {
        currentQuestionIdRef.current = currentQuestionId;
    }, [currentQuestionId]);

    useEffect(() => {
        examQuestionsRef.current = examData?.questions || [];
    }, [examData]);

    const draftOwnerKey = user?.studentId || user?.guestId || persistId;
    const DRAFT_KEY = id && draftOwnerKey ? `omr_draft_${id}_${draftOwnerKey}` : "";
    const LEGACY_DRAFT_KEY = id ? `omr_draft_${id}` : "";
    const OMR_PANEL_KEY = id && draftOwnerKey ? `${OMR_PANEL_STORAGE_PREFIX}_${id}_${draftOwnerKey}` : "";

    useEffect(() => {
        if (typeof window === "undefined" || !OMR_PANEL_KEY) {
            setHydratedOMRPanelKey("");
            return;
        }
        setHydratedOMRPanelKey("");
        const stored = window.localStorage.getItem(OMR_PANEL_KEY);
        const hasStoredPreference = stored === "collapsed" || stored === "expanded";
        const tabletQuery = window.matchMedia("(min-width: 641px) and (max-width: 1180px)");
        setIsOMRCollapsed(hasStoredPreference ? stored === "collapsed" : tabletQuery.matches);
        setHydratedOMRPanelKey(OMR_PANEL_KEY);
    }, [OMR_PANEL_KEY]);

    useEffect(() => {
        if (typeof window === "undefined" || !OMR_PANEL_KEY || hydratedOMRPanelKey !== OMR_PANEL_KEY) return;
        window.localStorage.setItem(OMR_PANEL_KEY, isOMRCollapsed ? "collapsed" : "expanded");
    }, [OMR_PANEL_KEY, hydratedOMRPanelKey, isOMRCollapsed]);

    useEffect(() => {
        setCurrentPlan(getCurrentPlan());

        const currentSession = getSession();
        if (currentSession) setUser(currentSession);

        const hydrateExam = async () => {
            if (!id) return;
            setLoadError(null);
            const parsed = await loadPersistedExam(id);
            if (!parsed) {
                setLoadError({
                    title: "시험을 찾을 수 없습니다",
                    body: "링크가 잘못됐거나 선생님이 시험을 삭제했을 수 있습니다. 받은 링크를 다시 확인해주세요.",
                });
                return;
            }
            try {
                setLoadError(null);
                examQuestionsRef.current = parsed.questions;
                setExamData(parsed);
                const requiresPin = examRequiresPin(parsed);
                const initialAccess = evaluateExamAccess(parsed, { session: currentSession, pinVerified: !requiresPin });
                const shouldBeginQuestionVisit = initialAccess.status === "allowed";
                setPinVerified(!requiresPin);
                setPinInput("");
                setPinError("");
                if (!shouldBeginQuestionVisit) setCurrentQuestionId(null);

                const searchParams = new URLSearchParams(window.location.search);
                const rawQuestionIds = (searchParams.get("questions") || "")
                    .split(",")
                    .map(value => Number(value.trim()))
                    .filter(value => Number.isFinite(value));
                const validQuestionIds = rawQuestionIds.filter(questionId =>
                    parsed.questions.some(question => question.id === questionId)
                );
                if (validQuestionIds.length > 0) {
                    const mode = searchParams.get("mode") === "similar" ? "similar"
                        : searchParams.get("mode") === "custom" ? "custom"
                            : "wrong";
                    setRetakeConfig({
                        sourceAttemptId: searchParams.get("retakeFrom") || `exam:${parsed.id}`,
                        questionIds: validQuestionIds,
                        mode,
                        labels: (searchParams.get("labels") || "").split(",").filter(Boolean),
                        concepts: (searchParams.get("concepts") || "").split(",").filter(Boolean),
                    });
                    toast.info("재시험 모드", `${validQuestionIds.length}개 문항만 다시 풉니다.`);
                    if (shouldBeginQuestionVisit) beginQuestionVisit(validQuestionIds[0]);
                } else if (parsed.questions[0]) {
                    if (shouldBeginQuestionVisit) beginQuestionVisit(parsed.questions[0].id);
                }

                // Enforce schedule window (startAt/endAt)
                const now = Date.now();
                if (parsed.startAt && new Date(parsed.startAt).getTime() > now) {
                    toast.info("아직 응시 시작 전입니다", `${new Date(parsed.startAt).toLocaleString('ko-KR')}에 시작합니다.`);
                }
                if (parsed.endAt && new Date(parsed.endAt).getTime() < now) {
                    toast.error("응시 기간 종료", "이 시험의 응시 가능 기간이 지났습니다.");
                }

                // Initialize timer from duration
                if (parsed.durationMin && typeof parsed.durationMin === "number") {
                    setTimeRemaining(parsed.durationMin * 60);
                }

                // Restore draft (autosave) if present
                try {
                    const ownerKey = currentSession?.studentId || currentSession?.guestId || persistId;
                    const scopedDraftKey = ownerKey ? `omr_draft_${id}_${ownerKey}` : "";
                    const draftStr = (scopedDraftKey ? localStorage.getItem(scopedDraftKey) : null)
                        || localStorage.getItem(`omr_draft_${id}`);
                    if (draftStr) {
                        const draft = JSON.parse(draftStr);
                        if (draft.answers && typeof draft.answers === "object") {
                            setStudentAnswers(draft.answers);
                        }
                        let loadedDrawings: unknown = null;
                        if (draft.drawingsRef) {
                            try {
                                loadedDrawings = await loadJsonRecord<PdfDrawings>(draft.drawingsRef);
                            } catch {
                                loadedDrawings = null;
                            }
                        }
                        const recovery = resolveDraftDrawings(loadedDrawings, draft.drawings, !!draft.drawingsRef);
                        if (recovery.drawings) {
                            setDrawings(recovery.drawings);
                        }
                        if (recovery.lost) {
                            toast.error("필기 복구 실패", "저장된 필기를 불러오지 못했습니다. 답안과 진행 상태는 그대로 유지됩니다.");
                        }
                        if (typeof draft.timeRemaining === "number") {
                            setTimeRemaining(draft.timeRemaining);
                        }
                        if (typeof draft.startedAt === "string") {
                            setStartedAt(draft.startedAt);
                        }
                        setHasResumed(true);
                    }
                } catch {
                    // ignore bad draft
                }

                const problemPdf = await storedDataUrlToFile("problem.pdf", parsed.pdfData, parsed.pdfDataRef);
                if (problemPdf) setPdfFile(problemPdf);

                const answerPdf = await storedDataUrlToFile("answer_key.pdf", parsed.answerKeyPdf, parsed.answerKeyPdfRef);
                if (answerPdf) setAnswerFile(answerPdf);
            } catch {
                setLoadError({
                    title: "시험 데이터를 읽지 못했습니다",
                    body: "문제지 PDF 또는 시험 설정을 불러오는 중 문제가 발생했습니다. 잠시 후 다시 열거나 선생님에게 문의해주세요.",
                });
                toast.error("시험 데이터 로드 실패", "저장된 PDF 또는 시험 설정을 읽지 못했습니다.");
            }
        };

        hydrateExam();
    }, [beginQuestionVisit, id, persistId]);

    // Show resume banner once after initial load
    useEffect(() => {
        if (hasResumed) {
            toast.info("임시저장 복원됨", "이전에 풀던 답안을 불러왔습니다.");
        }
    }, [hasResumed]);

    // Tick timer every second when examData has duration. Auto-submit at 0.
    useEffect(() => {
        if (timeRemaining === null || submittedRef.current) return;
        if (examData && evaluateExamAccess(examData, { session: user, pinVerified }).status !== "allowed") return;
        if (timeRemaining <= 0) {
            handleSubmitInternal(true);
            return;
        }
        const id = setTimeout(() => setTimeRemaining(t => (t === null ? null : t - 1)), 1000);
        return () => clearTimeout(id);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [timeRemaining, examData, pinVerified, user]);

    useEffect(() => {
        latestDraftRef.current = {
            answers: studentAnswers,
            drawings: compactDrawings(drawings),
            timeRemaining,
            startedAt,
            savedAt: new Date().toISOString(),
        };
    }, [studentAnswers, drawings, timeRemaining, startedAt]);

    // Autosave draft every 3s. Keep this interval independent from the ticking timer.
    useEffect(() => {
        if (!DRAFT_KEY) return;
        if (examData && evaluateExamAccess(examData, { session: user, pinVerified }).status !== "allowed") return;
        const saveDraft = async () => {
            if (submittedRef.current || !latestDraftRef.current) return;
            const savedAt = new Date().toISOString();
            try {
                const draftDrawings = latestDraftRef.current.drawings || {};
                let drawingsRef = latestDraftRef.current.drawingsRef;
                if (hasDrawings(draftDrawings)) {
                    drawingsRef = await saveJsonRecord(`draft:${id}:${draftOwnerKey}:drawings`, draftDrawings);
                    if (!drawingsRef) throw new Error("Failed to save draft drawings");
                }
                localStorage.setItem(DRAFT_KEY, JSON.stringify({
                    ...latestDraftRef.current,
                    drawings: undefined,
                    drawingsRef,
                    savedAt,
                }));
                autosaveErrorShownRef.current = false;
                setLastSavedAt(new Date(savedAt));
            } catch {
                if (!autosaveErrorShownRef.current) {
                    autosaveErrorShownRef.current = true;
                    toast.error("Autosave failed", "Unable to save answers and handwriting.");
                }
                // quota exceeded: keep the first error visible without spamming toasts
            }
        };

        const handleVisibilityChange = () => {
            if (document.visibilityState === "hidden") void saveDraft();
        };
        const handlePageHide = () => {
            void saveDraft();
        };

        const intervalId = window.setInterval(() => { void saveDraft(); }, AUTOSAVE_INTERVAL_MS);
        window.addEventListener("pagehide", handlePageHide);
        window.addEventListener("visibilitychange", handleVisibilityChange);

        return () => {
            window.clearInterval(intervalId);
            window.removeEventListener("pagehide", handlePageHide);
            window.removeEventListener("visibilitychange", handleVisibilityChange);
        };
    }, [DRAFT_KEY, draftOwnerKey, examData, id, pinVerified, user]);

    // Warn on tab close if there are unsaved answers
    useEffect(() => {
        const onBeforeUnload = (e: BeforeUnloadEvent) => {
            if (submittedRef.current) return;
            if (Object.keys(studentAnswers).length === 0 && !hasDrawings(drawings)) return;
            e.preventDefault();
            e.returnValue = "";
        };
        window.addEventListener("beforeunload", onBeforeUnload);
        return () => window.removeEventListener("beforeunload", onBeforeUnload);
    }, [studentAnswers, drawings]);

    const handleAnswerClick = (qId: number, optionIndex: number) => {
        const nowMs = Date.now();
        beginQuestionVisit(qId, nowMs);
        setStudentAnswers(prev => {
            if (prev[qId] !== optionIndex) {
                const timing = ensureQuestionTiming(qId, nowMs);
                timing.answerChangeCount += 1;
                timing.lastAnsweredAt = new Date(nowMs).toISOString();
            }
            return { ...prev, [qId]: optionIndex };
        });
    };

    const handleQuestionClick = (qId: number) => {
        beginQuestionVisit(qId);
        if (examData) {
            const q = examData.questions.find(q => q.id === qId);
            const page = q?.pdfLocation?.page || q?.pdfRegion?.page;
            if (page) setPdfCurrentPage(page);
        }
    };

    const handleDrawingsChange = (page: number, newPaths: string[]) => {
        setDrawings(prev => ({ ...prev, [page]: newPaths }));
    };

    const toggleOMRPanel = useCallback(() => {
        setIsOMRCollapsed(prev => !prev);
    }, []);

    const createGuestSubmitter = useCallback((name: string): StudentSession => {
        const guestId = getOrCreateGuestId();
        const submitter: StudentSession = {
            studentId: `guest:${guestId}`,
            name: name.trim() || "Guest Student",
            isGuest: true,
            identityType: 'guest',
            guestId,
            groupName: 'Guest',
        };
        saveSession(submitter);
        setUser(submitter);
        localStorage.setItem("omr_guest_id", guestId);
        return submitter;
    }, []);

    const handleSubmitInternal = async (autoSubmitted = false, overrideSubmitter?: StudentSession) => {
        if (!examData) return;
        if (submittedRef.current) return;

        let submitter = overrideSubmitter || user;
        const accessDecision = evaluateExamAccess(examData, { session: submitter, pinVerified });
        if (accessDecision.status !== "allowed") {
            if (accessDecision.status === "login_required") {
                toast.error("로그인 필요", "이 시험은 지정된 반 학생만 응시할 수 있습니다.");
                router.push("/?role=student");
                return;
            }
            const copy = accessDecisionCopy(accessDecision);
            toast.error(copy.title, copy.body);
            return;
        }

        if (!submitter) {
            if (autoSubmitted) {
                submitter = createGuestSubmitter("Guest Student");
            } else {
                setGuestName("");
                setGuestSubmitPending({ autoSubmitted });
                return;
            }
        }

        submittedRef.current = true;

        // Use weighted grading from types/omr.ts
        const activeExamQuestions = getActiveExamQuestions();
        const graded = gradeAttempt(activeExamQuestions, studentAnswers);
        const questionTimings = buildQuestionTimingSnapshot(activeExamQuestions);

        const attemptId = Date.now().toString();
        const activeDrawings = compactDrawings(drawings);
        const activeDrawingStrokeCount = drawingStrokeCount(activeDrawings);
        const activeDrawingPageCount = Object.keys(activeDrawings).length;
        const questionDrawings = summarizeQuestionDrawings(examData.questions, activeDrawings);
        const canStoreHandwriting = canArchiveHandwriting(currentPlan);

        let drawingsRef: Attempt["drawingsRef"] | undefined = undefined;
        if (hasDrawings(activeDrawings) && canStoreHandwriting) {
            try {
                const stored = await saveJsonRecord(`attempt:${attemptId}:drawings`, activeDrawings);
                drawingsRef = stored;
            } catch (e) {
                console.error("Failed to save drawings to IndexedDB", e);
            }
            if (!drawingsRef) {
                submittedRef.current = false;
                toast.error("필기 저장 실패", "답안 제출 전 필기 저장에 실패했습니다. 잠시 후 다시 제출해주세요.");
                return;
            }
        }
        if (hasDrawings(activeDrawings) && !canStoreHandwriting) {
            toast.info("필기 보관은 Pro 기능입니다", "답안은 저장됐고 필기 원본은 장기 보관되지 않습니다.");
        }

        const attemptData: Attempt = {
            id: attemptId,
            examId: id,
            examTitle: examData.title,
            studentName: submitter.name,
            studentId: submitter.studentId || submitter.guestId || persistId,
            groupId: submitter.groupId,
            groupName: submitter.groupName,
            regionId: submitter.regionId,
            regionName: submitter.regionName,
            identityType: submitter.identityType || (submitter.isGuest ? 'guest' : 'temporary'),
            guestId: submitter.guestId,
            startedAt,
            finishedAt: new Date().toISOString(),
            score: graded.earnedScore,
            totalScore: graded.totalScore,
            answers: studentAnswers,
            drawings: canStoreHandwriting && hasDrawings(activeDrawings) ? activeDrawings : undefined,
            drawingsRef,
            handwriting: {
                schemaVersion: 1,
                status: !hasDrawings(activeDrawings)
                    ? 'none'
                    : drawingsRef
                        ? 'saved'
                        : 'plan_required',
                strokesRef: drawingsRef,
                plan: currentPlan,
                summary: {
                    pageCount: activeDrawingPageCount,
                    strokeCount: activeDrawingStrokeCount,
                    questionCount: questionDrawings.length,
                },
                questions: questionDrawingsById(questionDrawings),
            },
            handwritingArchived: !!drawingsRef,
            handwritingPlan: currentPlan,
            drawingPageCount: activeDrawingPageCount,
            drawingStrokeCount: activeDrawingStrokeCount,
            questionDrawings,
            status: 'completed' as const,
            autoSubmitted,
            tabFociLostCount,
            questionTimings,
            focusLossEvents: focusLossEventsRef.current,
            retake: retakeConfig ? {
                ...retakeConfig,
                createdAt: new Date().toISOString(),
            } : undefined,
        };
        attemptData.questionResults = buildQuestionResults(
            { ...examData, questions: activeExamQuestions },
            attemptData,
        );

        try {
            const result = await saveAttempt(attemptData);
            const feedback = summarizePersistenceWrite(result, {
                target: "답안",
                action: "저장",
                failureTitle: "답안 저장 실패",
                failureDetail: "브라우저 저장소가 가득 찼거나 Supabase 저장에 실패했습니다.",
            });
            if (!feedback.ok) {
                throw new Error(feedback.detail);
            }
            if (feedback.level === "info") {
                toast.info(feedback.title, feedback.detail);
            }
            // Clean up draft
            try { localStorage.removeItem(DRAFT_KEY); } catch {}
            try { localStorage.removeItem(LEGACY_DRAFT_KEY); } catch {}
        } catch {
            submittedRef.current = false;
            toast.error("저장 공간 부족", "브라우저 저장소가 가득 찼습니다. 관리자에게 문의하세요.");
            return;
        }

        if (autoSubmitted) {
            toast.info("시간 종료", "답안이 자동으로 제출되었습니다.");
        }
        router.push(`/student/review/${attemptId}`);
    };

    const handleSubmit = () => {
        if (!examData) return;
        const activeExamQuestions = getActiveExamQuestions();
        const totalQ = activeExamQuestions.length;
        const answeredCount = activeExamQuestions.filter(q => {
            const answer = studentAnswers[q.id];
            return answer !== undefined && answer !== null && answer !== 0;
        }).length;
        const unanswered = totalQ - answeredCount;
        setSubmitConfirm({ unanswered, total: totalQ });
    };

    const confirmSubmit = () => {
        setSubmitConfirm(null);
        void handleSubmitInternal(false);
    };

    const submitGuestName = () => {
        const pending = guestSubmitPending;
        const trimmedName = guestName.trim();
        if (!pending || !trimmedName) return;
        const submitter = createGuestSubmitter(trimmedName);
        setGuestSubmitPending(null);
        setGuestName("");
        void handleSubmitInternal(pending.autoSubmitted, submitter);
    };

    const toggleTeacherMode = async (checked: boolean) => {
        if (checked) {
            setTeacherIdentifier("");
            setTeacherPassword("");
            setTeacherAuthError("");
            setTeacherAuthOpen(true);
        } else {
            setIsTeacherMode(false);
        }
    };

    const submitTeacherPassword = async () => {
        const identifier = teacherIdentifier.trim();
        const password = teacherPassword.trim();
        if (!identifier || !password) {
            setTeacherAuthError("아이디와 비밀번호를 모두 입력해주세요.");
            return;
        }
        setIsTeacherAuthing(true);
        setTeacherAuthError("");
        try {
            const res = await verifyTeacherPassword(identifier, password);
            if (res.success && res.token) {
                const saved = saveTeacherSessionWithIdentity(res.token, res.teacher);
                if (!saved) {
                    setTeacherAuthError("브라우저 세션 저장을 사용할 수 없습니다.");
                    setIsTeacherMode(false);
                    return;
                }
                setIsTeacherMode(true);
                setTeacherAuthOpen(false);
                setTeacherIdentifier("");
                setTeacherPassword("");
                toast.success("선생님 모드 켜짐", "정답/해설 PDF를 확인할 수 있습니다.");
            } else {
                setTeacherAuthError(res.error || "비밀번호가 틀렸습니다.");
                setIsTeacherMode(false);
            }
        } catch {
            setTeacherAuthError("인증 오류가 발생했습니다. 잠시 후 다시 시도해주세요.");
            setIsTeacherMode(false);
        } finally {
            setIsTeacherAuthing(false);
        }
    };

    if (!examData && loadError) {
        return <SolveLoadErrorCard error={loadError} />;
    }

    if (!examData) {
        return (
            <div style={{ padding: '2rem', textAlign: 'center' }}>
                <h2>시험을 불러오는 중...</h2>
                <Link href="/" className="btn btn-secondary">홈으로 돌아가기</Link>
            </div>
        );
    }

    const accessDecision = evaluateExamAccess(examData, { session: user, pinVerified });
    const requiresPin = accessDecision.status === "pin_required";
    const submitPin = () => {
        if (!verifyExamPin(examData, pinInput)) {
            setPinError("PIN이 일치하지 않습니다.");
            return;
        }
        setPinVerified(true);
        setPinError("");
        const firstQuestionId = retakeConfig?.questionIds[0] || examData.questions[0]?.id;
        if (firstQuestionId) beginQuestionVisit(firstQuestionId);
    };

    if (requiresPin) {
        return (
            <div className="layout-main solve-page" style={{
                background: 'var(--background)',
                minHeight: '100dvh',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '1rem',
            }}>
                <ExamPinDialog
                    examTitle={examData.title}
                    value={pinInput}
                    error={pinError}
                    onChange={(next) => {
                        setPinInput(next);
                        if (pinError) setPinError("");
                    }}
                    onSubmit={submitPin}
                    onExit={() => router.push("/")}
                />
            </div>
        );
    }

    if (accessDecision.status !== "allowed") {
        return (
            <div className="layout-main solve-page" style={{
                background: 'var(--background)',
                minHeight: '100dvh',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '1rem',
            }}>
                <ExamAccessBlockedDialog
                    decision={accessDecision}
                    onExit={() => router.push("/?role=student")}
                />
            </div>
        );
    }

    const activeExamQuestions = getActiveExamQuestions();
    const unansweredQuestions = activeExamQuestions.filter(q => {
        const answer = studentAnswers[q.id];
        return answer === undefined || answer === null || answer === 0;
    });
    const totalQuestions = activeExamQuestions.length;
    const unansweredCount = unansweredQuestions.length;
    const answeredCount = totalQuestions - unansweredCount;
    const nextUnansweredQuestion = unansweredQuestions[0];
    const progress = totalQuestions > 0 ? (answeredCount / totalQuestions) * 100 : 0;
    const activeDrawingStrokeCount = drawingStrokeCount(drawings);
    const activeDrawingPageCount = Object.values(drawings).filter(paths => paths.length > 0).length;
    const activeQuestionDrawings = summarizeQuestionDrawings(activeExamQuestions, drawings);
    const activeQuestionDrawingCount = activeQuestionDrawings.length;
    const hasActiveDrawings = activeDrawingStrokeCount > 0;
    const handwritingArchiveEnabled = canArchiveHandwriting(currentPlan);
    const handwritingStatusDetail = activeQuestionDrawingCount > 0
        ? `${activeQuestionDrawingCount}문항 · ${activeDrawingStrokeCount}획`
        : `${activeDrawingStrokeCount}획`;
    const currentQuestion = activeExamQuestions.find(q => q.id === currentQuestionId) || null;
    const quickAnswerQuestion = currentQuestion || nextUnansweredQuestion || activeExamQuestions[0] || null;
    const quickAnswerChoiceCount = quickAnswerQuestion
        ? questionChoiceCount(quickAnswerQuestion, DEFAULT_CHOICE_COUNT)
        : DEFAULT_CHOICE_COUNT;
    const quickAnswerValue = quickAnswerQuestion ? studentAnswers[quickAnswerQuestion.id] : undefined;
    const nextQuickTarget = nextUnansweredQuestion && nextUnansweredQuestion.id !== quickAnswerQuestion?.id
        ? nextUnansweredQuestion
        : null;

    return (
        <div className="layout-main solve-page" style={{
            background: 'var(--background)',
            height: '100dvh',
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column'
        }}>
            {/* Header */}
            <header className="header solve-header" style={{
                flexShrink: 0,
                height: 'auto',
                padding: '0.75rem 1.5rem'
            }}>
                <div className="container header-content solve-header-content" style={{ gap: '1rem' }}>
                    <div className="solve-title-group" style={{ display: 'flex', alignItems: 'center', gap: '1rem', minWidth: 0, flex: 1 }}>
                        <Link href="/" className="logo solve-brand" style={{ fontSize: '1.15rem', flexShrink: 0 }}>OMR Maker</Link>
                        <div className="solve-divider" style={{
                            height: '22px',
                            width: '1px',
                            background: 'var(--border)',
                            flexShrink: 0
                        }} />
                        <span className="solve-title" style={{
                            fontSize: '0.9rem',
                            fontWeight: 700,
                            color: 'var(--foreground)',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap'
                        }}>
                            {examData.title}
                            {retakeConfig ? ` · 재시험 ${retakeConfig.questionIds.length}문항` : ''}
                        </span>
                    </div>

                    {/* Timer */}
                    {timeRemaining !== null && (
                        (() => {
                            const mm = Math.floor(Math.max(0, timeRemaining) / 60).toString().padStart(2, "0");
                            const ss = (Math.max(0, timeRemaining) % 60).toString().padStart(2, "0");
                            const isCritical = timeRemaining <= 300; // last 5 min
                            return (
                                <div className="solve-timer" style={{
                                    display: 'flex', alignItems: 'center', gap: '0.4rem',
                                    padding: '0.35rem 0.75rem',
                                    background: isCritical ? 'rgba(239,68,68,0.1)' : 'var(--background)',
                                    border: `1px solid ${isCritical ? 'rgba(239,68,68,0.3)' : 'var(--border)'}`,
                                    borderRadius: 'var(--radius-full)',
                                    color: isCritical ? '#ef4444' : 'var(--foreground)',
                                    flexShrink: 0,
                                    animation: isCritical ? 'pulse 1.5s ease-in-out infinite' : undefined
                                }}>
                                    <Clock size={13} />
                                    <span style={{ fontSize: '0.82rem', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                                        {mm}:{ss}
                                    </span>
                                </div>
                            );
                        })()
                    )}

                    {/* Progress indicator */}
                    <div className="solve-progress" style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.75rem',
                        padding: '0.35rem 0.85rem',
                        background: 'var(--background)',
                        border: '1px solid var(--border)',
                        borderRadius: 'var(--radius-full)',
                        flexShrink: 0
                    }}>
                        <div className="solve-progress-bar" style={{
                            width: '90px',
                            height: '4px',
                            background: 'var(--border)',
                            borderRadius: 'var(--radius-full)',
                            overflow: 'hidden'
                        }}>
                            <div className="solve-progress-fill" style={{
                                width: `${progress}%`,
                                height: '100%',
                                background: 'linear-gradient(90deg, var(--primary), var(--secondary))',
                                transition: 'width 0.3s'
                            }} />
                        </div>
                        <span style={{
                            fontSize: '0.82rem',
                            fontWeight: 700,
                            color: 'var(--foreground)',
                            fontVariantNumeric: 'tabular-nums'
                        }}>
                            {answeredCount}/{totalQuestions}
                        </span>
                    </div>

                    {/* Autosave indicator */}
                    {lastSavedAt && (
                        <span
                            className="solve-autosave"
                            title={`마지막 저장: ${lastSavedAt.toLocaleTimeString('ko-KR')}`}
                            style={{
                                display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
                                fontSize: '0.72rem', color: 'var(--muted)', fontWeight: 600, flexShrink: 0
                            }}>
                            <Save size={11} /> 저장됨
                        </span>
                    )}
                    {(hasActiveDrawings || handwritingArchiveEnabled) && (
                        <span
                            className="solve-autosave solve-handwriting-status"
                            title={handwritingArchiveEnabled
                                ? `${getPlanLabel(currentPlan)} 플랜: 제출 후 필기 보관 · ${activeDrawingPageCount}p · ${handwritingStatusDetail}`
                                : "Free 플랜: 제출 후 필기 원본 미보관"}
                            style={{
                                display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
                                fontSize: '0.72rem', color: handwritingArchiveEnabled ? 'var(--primary)' : '#f59e0b',
                                fontWeight: 700, flexShrink: 0
                            }}>
                            <PenLine size={11} />
                            {handwritingArchiveEnabled
                                ? `필기 보관${hasActiveDrawings ? ` ${handwritingStatusDetail}` : ''}`
                                : '필기 임시'}
                        </span>
                    )}

                    <div className="solve-controls" style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexShrink: 0 }}>
                        <label className="solve-teacher-toggle" style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.4rem',
                            fontSize: '0.78rem',
                            cursor: 'pointer',
                            background: 'var(--background)',
                            border: '1px solid var(--border)',
                            padding: '0.35rem 0.7rem',
                            borderRadius: 'var(--radius-full)',
                            fontWeight: 600,
                            color: 'var(--muted)'
                        }}>
                            <input
                                type="checkbox"
                                checked={isTeacherMode}
                                onChange={(e) => toggleTeacherMode(e.target.checked)}
                                style={{ margin: 0 }}
                            />
                            선생님 모드
                        </label>

                        {isTeacherMode ? (
                            <div className="solve-tab-toggle" style={{
                                display: 'flex',
                                background: 'var(--background)',
                                border: '1px solid var(--border)',
                                borderRadius: 'var(--radius-full)',
                                padding: '3px'
                            }}>
                                <button
                                    className="solve-tab-button"
                                    onClick={() => setActiveTab('problem')}
                                    style={{
                                        padding: '0.3rem 0.8rem',
                                        fontSize: '0.78rem',
                                        borderRadius: 'var(--radius-full)',
                                        border: 'none',
                                        background: activeTab === 'problem' ? 'var(--primary)' : 'transparent',
                                        color: activeTab === 'problem' ? 'white' : 'var(--muted)',
                                        fontWeight: 700,
                                        cursor: 'pointer',
                                        transition: 'all 0.2s'
                                    }}
                                >
                                    문제지
                                </button>
                                <button
                                    className="solve-tab-button"
                                    onClick={() => setActiveTab('answer')}
                                    style={{
                                        padding: '0.3rem 0.8rem',
                                        fontSize: '0.78rem',
                                        borderRadius: 'var(--radius-full)',
                                        border: 'none',
                                        background: activeTab === 'answer' ? 'var(--primary)' : 'transparent',
                                        color: activeTab === 'answer' ? 'white' : 'var(--muted)',
                                        fontWeight: 700,
                                        cursor: 'pointer',
                                        transition: 'all 0.2s'
                                    }}
                                >
                                    정답/해설
                                </button>
                            </div>
                        ) : (
                            <label className="btn btn-secondary solve-pdf-button" style={{
                                cursor: 'pointer',
                                fontSize: '0.8rem',
                                padding: '0.45rem 0.85rem'
                            }}>
                                PDF 열기
                                <input id="pdf-upload-input" type="file" accept=".pdf" onChange={(e) => e.target.files && setPdfFile(e.target.files[0])} style={{ display: 'none' }} />
                            </label>
                        )}

                        <button
                            onClick={toggleOMRPanel}
                            className="btn btn-secondary solve-collapse-button"
                            style={{
                                padding: '0.45rem 0.75rem',
                                fontSize: '0.8rem',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.35rem'
                            }}
                            title={isOMRCollapsed ? '답안지 펼치기' : '답안지 접기'}
                            aria-label={isOMRCollapsed ? '답안지 펼치기' : '답안지 접기'}
                            aria-expanded={!isOMRCollapsed}
                            aria-controls="solve-omr-pane"
                        >
                            {isOMRCollapsed ? <PanelRightOpen size={14} /> : <PanelRightClose size={14} />}
                        </button>

                        <button className="btn btn-primary solve-submit-button" style={{ padding: '0.5rem 1rem', fontSize: '0.85rem' }} onClick={handleSubmit}>
                            제출하기
                        </button>
                        <ThemeToggle size="small" />
                    </div>
                </div>
            </header>

            {/* Body */}
            <div className="solve-body" style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
                {/* PDF Area (Left, larger) */}
                <div className="solve-pdf-pane" style={{
                    flex: 1,
                    borderRight: '1px solid var(--border)',
                    background: '#2a2d31',
                    position: 'relative',
                    display: 'flex',
                    flexDirection: 'column',
                    minWidth: 0
                }}>
                    {isTeacherMode && activeTab === 'answer' && !answerFile && (
                        <div className="solve-upload-overlay" style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10, pointerEvents: 'none' }}>
                            <label className="btn btn-primary" style={{ pointerEvents: 'auto', cursor: 'pointer', boxShadow: '0 4px 10px rgba(0,0,0,0.3)' }}>
                                해설/정답 PDF 업로드
                                <input type="file" accept=".pdf" onChange={(e) => e.target.files && setAnswerFile(e.target.files[0])} style={{ display: 'none' }} />
                            </label>
                        </div>
                    )}

                    {isTeacherMode && activeTab === 'problem' && !pdfFile && (
                        <div className="solve-upload-overlay" style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10, pointerEvents: 'none' }}>
                            <label className="btn btn-secondary" style={{ pointerEvents: 'auto', cursor: 'pointer', boxShadow: '0 4px 10px rgba(0,0,0,0.3)' }}>
                                문제지 PDF 업로드
                                <input type="file" accept=".pdf" onChange={(e) => e.target.files && setPdfFile(e.target.files[0])} style={{ display: 'none' }} />
                            </label>
                        </div>
                    )}

                    <PDFViewer
                        file={activeTab === 'problem' ? pdfFile : answerFile}
                        onLoadSuccess={() => { }}
                        onFileDrop={activeTab === 'problem' ? setPdfFile : setAnswerFile}
                        enableDrawing={activeTab === 'problem'}
                        drawings={drawings}
                        onDrawingsChange={handleDrawingsChange}
                        forcePage={activeTab === 'problem' ? pdfCurrentPage : undefined}
                        markers={(activeTab === 'problem' && examData.questions)
                            ? activeExamQuestions
                                .filter((q: Question) => q.pdfLocation || q.pdfRegion)
                                .map((q: Question) => {
                                    const anchor = q.pdfLocation || q.pdfRegion!;
                                    return {
                                        page: anchor.page,
                                        x: anchor.x,
                                        y: anchor.y,
                                        label: q.number,
                                        color: currentQuestionId === q.id ? '#6366f1' : '#ef4444',
                                        onClick: () => handleQuestionClick(q.id),
                                        questionId: q.id,
                                        currentAnswer: studentAnswers[q.id],
                                        onAnswer: (opt: number) => handleAnswerClick(q.id, opt),
                                        optionsCount: questionChoiceCount(q, DEFAULT_CHOICE_COUNT),
                                    };
                                })
                            : []}
                    />
                </div>

                <div className={`solve-omr-rail ${isOMRCollapsed ? 'is-collapsed' : ''}`} aria-label="빠른 답안 레일">
                    <button
                        type="button"
                        className={`solve-omr-rail-button ${isOMRCollapsed ? 'is-collapsed' : ''}`}
                        onClick={toggleOMRPanel}
                        title={isOMRCollapsed ? '답안지 펼치기' : '답안지 접기'}
                        aria-label={`${isOMRCollapsed ? '답안지 펼치기' : '답안지 접기'} · ${answeredCount}/${totalQuestions} · 미답 ${unansweredCount}개`}
                        aria-expanded={!isOMRCollapsed}
                        aria-controls="solve-omr-pane"
                    >
                        {isOMRCollapsed ? <PanelRightOpen size={18} /> : <PanelRightClose size={18} />}
                        <span className="solve-omr-rail-text">답안</span>
                        <span className={`solve-omr-rail-count ${unansweredCount === 0 ? 'is-complete' : ''}`}>{answeredCount}/{totalQuestions}</span>
                        {unansweredCount > 0 && (
                            <span className="solve-omr-rail-missing">{unansweredCount}미답</span>
                        )}
                    </button>
                    {isOMRCollapsed && quickAnswerQuestion && (
                        <div className="solve-omr-quick-card" aria-label={`${quickAnswerQuestion.number}번 빠른 답안`}>
                            <button
                                type="button"
                                className="solve-omr-quick-question"
                                onClick={() => handleQuestionClick(quickAnswerQuestion.id)}
                                title={`${quickAnswerQuestion.number}번 문항으로 이동`}
                            >
                                {quickAnswerQuestion.number}
                            </button>
                            <div className="solve-omr-quick-bubbles" aria-label={`${quickAnswerQuestion.number}번 보기 선택`}>
                                {Array.from({ length: quickAnswerChoiceCount }, (_, index) => {
                                    const optionNumber = index + 1;
                                    const isMarked = quickAnswerValue === optionNumber;
                                    return (
                                        <button
                                            key={optionNumber}
                                            type="button"
                                            className={`solve-omr-quick-bubble ${isMarked ? 'is-marked' : ''}`}
                                            onClick={() => handleAnswerClick(quickAnswerQuestion.id, optionNumber)}
                                            aria-label={`${quickAnswerQuestion.number}번 보기 ${optionNumber}`}
                                            aria-pressed={isMarked}
                                        >
                                            {optionNumber}
                                        </button>
                                    );
                                })}
                            </div>
                            {hasActiveDrawings && (
                                <span
                                    className={`solve-omr-quick-handwriting ${handwritingArchiveEnabled ? '' : 'is-temporary'}`}
                                    title={handwritingArchiveEnabled ? "필기 보관" : "필기 임시"}
                                >
                                    <PenLine size={11} aria-hidden="true" />
                                    {activeDrawingStrokeCount}
                                </span>
                            )}
                            {nextQuickTarget && (
                                <button
                                    type="button"
                                    className="solve-omr-quick-next"
                                    onClick={() => handleQuestionClick(nextQuickTarget.id)}
                                    title={`${nextQuickTarget.number}번 미답 문항으로 이동`}
                                >
                                    미답
                                </button>
                            )}
                        </div>
                    )}
                </div>

                {/* OMR Sheet (Right, responsive card view) */}
                <div id="solve-omr-pane" className={`solve-omr-pane ${isOMRCollapsed ? 'is-collapsed' : ''}`} style={{
                    width: isOMRCollapsed ? '0' : '440px',
                    maxWidth: isOMRCollapsed ? '0' : '40vw',
                    flexShrink: 0,
                    transition: 'width 0.24s, max-width 0.24s, flex-basis 0.24s',
                    overflow: 'hidden',
                    background: 'var(--background)',
                    display: 'flex',
                    flexDirection: 'column'
                }}>
                    <div className="solve-omr-pane-header">
                        <div className="solve-omr-pane-title">
                            <span>OMR 답안</span>
                            <strong>{answeredCount}/{totalQuestions}</strong>
                            {hasActiveDrawings && (
                                <div
                                    className={`solve-omr-pane-handwriting ${handwritingArchiveEnabled ? '' : 'is-temporary'}`}
                                    title={handwritingArchiveEnabled
                                        ? `${getPlanLabel(currentPlan)} 플랜: 제출 후 필기 보관 · ${activeDrawingPageCount}p · ${handwritingStatusDetail}`
                                        : "Free 플랜: 제출 후 필기 원본 미보관"}
                                >
                                    <PenLine size={12} aria-hidden="true" />
                                    <span>{handwritingArchiveEnabled ? '필기 보관' : '필기 임시'} {handwritingStatusDetail}</span>
                                </div>
                            )}
                        </div>
                        <div className="solve-omr-pane-actions">
                            <button
                                type="button"
                                className="solve-omr-next-button"
                                onClick={() => nextUnansweredQuestion && handleQuestionClick(nextUnansweredQuestion.id)}
                                disabled={!nextUnansweredQuestion}
                                title={nextUnansweredQuestion ? `${nextUnansweredQuestion.number}번 미답 문항으로 이동` : "모든 문제 표기 완료"}
                            >
                                {nextUnansweredQuestion ? `${nextUnansweredQuestion.number}번 미답` : "완료"}
                            </button>
                            <button
                                type="button"
                                className="solve-omr-pane-close"
                                onClick={toggleOMRPanel}
                                title="답안지 접기"
                                aria-label="답안지 접기"
                            >
                                <PanelRightClose size={16} />
                            </button>
                        </div>
                    </div>
                    <div style={{ flex: 1, overflowY: 'auto' }} className="scroll-custom solve-omr-scroll">
                        <OMRCardView
                            title={examData.title}
                            questions={activeExamQuestions}
                            userAnswers={studentAnswers}
                            selectedQuestionId={currentQuestionId}
                            onAnswerClick={handleAnswerClick}
                            onQuestionClick={handleQuestionClick}
                            mode="solve"
                            questionDrawings={activeQuestionDrawings}
                        />
                    </div>
                </div>
            </div>

            {submitConfirm && (
                <SubmitConfirmDialog
                    state={submitConfirm}
                    onClose={() => setSubmitConfirm(null)}
                    onConfirm={confirmSubmit}
                />
            )}

            {guestSubmitPending && (
                <GuestNameDialog
                    value={guestName}
                    onChange={setGuestName}
                    onClose={() => {
                        setGuestSubmitPending(null);
                        setGuestName("");
                    }}
                    onSubmit={submitGuestName}
                />
            )}

            {teacherAuthOpen && (
                <TeacherPasswordDialog
                    identifier={teacherIdentifier}
                    password={teacherPassword}
                    error={teacherAuthError}
                    isChecking={isTeacherAuthing}
                    onIdentifierChange={setTeacherIdentifier}
                    onPasswordChange={setTeacherPassword}
                    onClose={() => {
                        setTeacherAuthOpen(false);
                        setTeacherIdentifier("");
                        setTeacherPassword("");
                        setTeacherAuthError("");
                        setIsTeacherMode(false);
                    }}
                    onSubmit={submitTeacherPassword}
                />
            )}

            {/* Focus warning overlay modal (Anti-cheat) */}
            {showFocusWarning && (
                <div style={{
                    position: 'fixed',
                    inset: 0,
                    backgroundColor: 'rgba(15, 23, 42, 0.85)',
                    backdropFilter: 'blur(8px)',
                    zIndex: 9999,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: '1.5rem'
                }}>
                    <div style={{
                        background: 'var(--background, white)',
                        border: '2px solid #ef4444',
                        borderRadius: '16px',
                        padding: '2.5rem 2rem',
                        maxWidth: '480px',
                        width: '100%',
                        textAlign: 'center',
                        boxShadow: '0 25px 50px -12px rgba(239, 68, 68, 0.25)'
                    }}>
                        <div style={{
                            fontSize: '3.5rem',
                            marginBottom: '1rem',
                            animation: 'pulse 2s infinite'
                        }}>
                            ⚠️
                        </div>
                        <h2 style={{
                            fontSize: '1.4rem',
                            fontWeight: 800,
                            color: '#ef4444',
                            marginBottom: '0.75rem'
                        }}>
                            시험 이탈 경고!
                        </h2>
                        <p style={{
                            fontSize: '0.95rem',
                            color: 'var(--foreground)',
                            lineHeight: 1.6,
                            marginBottom: '1.5rem'
                        }}>
                            시험 도중 다른 탭으로 이동하거나 브라우저 화면 포커스를 이탈한 내역이 감지되었습니다.<br />
                            <strong style={{ color: '#ef4444' }}>이탈 기록은 선생님의 감독 대시보드에 실시간으로 기록됩니다.</strong>
                        </p>
                        <div style={{
                            background: 'rgba(239, 68, 68, 0.1)',
                            border: '1px solid rgba(239, 68, 68, 0.2)',
                            borderRadius: '8px',
                            padding: '0.75rem',
                            marginBottom: '2rem',
                            fontSize: '0.9rem',
                            fontWeight: 700,
                            color: '#ef4444'
                        }}>
                            현재 이탈 횟수: <span style={{ fontSize: '1.1rem' }}>{tabFociLostCount}</span>회
                        </div>
                        <button
                            onClick={() => setShowFocusWarning(false)}
                            style={{
                                background: '#ef4444',
                                color: 'white',
                                border: 'none',
                                borderRadius: '8px',
                                padding: '0.75rem 2rem',
                                fontWeight: 700,
                                fontSize: '0.95rem',
                                cursor: 'pointer',
                                transition: 'background 0.2s',
                                width: '100%'
                            }}
                            onMouseOver={(e) => e.currentTarget.style.background = '#dc2626'}
                            onMouseOut={(e) => e.currentTarget.style.background = '#ef4444'}
                        >
                            시험으로 돌아가기
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
