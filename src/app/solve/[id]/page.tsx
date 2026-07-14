"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import BrandLogo from "@/components/BrandLogo";
import OMRCardView from "@/components/OMRCardView";
import ThemeToggle from "@/components/ThemeToggle";
import dynamic from "next/dynamic";
import { toast } from "@/components/Toast";
import { AlertTriangle, Clock, PanelRightClose, PanelRightOpen, PenLine, Save } from "lucide-react";
import { storedDataUrlToFile, saveJsonRecord, loadJsonRecord } from "@/utils/blobStore";
import { resolveDraftDrawings } from "@/lib/draftRecovery";
import { verifyTeacherPassword } from "@/app/actions/auth";
import { loadExamForSolving, submitAttempt } from "@/app/actions/studentExam";
import { openStudentExam, previewStudentExam, submitStudentAttempt } from "@/app/actions/studentAttempt";
import { uploadStudentAttemptHandwriting } from "@/app/actions/remoteAssets";
import { issueGuestSession, validateStudentSession } from "@/app/actions/studentSession";
import { saveTeacherSessionWithIdentity } from "@/lib/teacherSession";
import { getOrCreateGuestId, getSession, guestLoginIdFor, saveSession, type StudentSession } from "@/utils/storage";
import { canArchiveHandwriting, getPlanLabel } from "@/utils/plans";
import { loadExam as loadPersistedExam, readLocalExam, saveAttempt, saveLocalAttempt, saveLocalExam } from "@/lib/omrPersistence";
import { buildQuestionResults } from "@/lib/premiumAnalytics";
import { summarizeQuestionDrawings } from "@/lib/handwritingAnalytics";
import { evaluateExamAccess, examRequiresPin, normalizeExamPin, verifyExamPin, type ExamAccessDecision } from "@/lib/examAccess";
import {
    loadExamForSolvingClient,
    submitAttemptClient,
    type ExamSource,
    type SolveAccessStatus,
} from "@/lib/studentExamClient";
import type { SubmitAttemptInput } from "@/lib/studentExamCore";
import { remainingSecondsWithinWindow } from "@/lib/studentExamCore";
import { findMissingRequiredSubQuestions, requiredSubQuestionProgress, sanitizeSubQuestionAnswersForQuestions } from "@/lib/subQuestions";
import { summarizePersistenceWrite } from "@/lib/persistenceFeedback";
import { stripTeacherOnlySubQuestionFields, type SolvableExam } from "@/lib/examSolvePayload";
import { SOLVE_CLASS_CODE_PARAM } from "@/lib/examLinks";
import { clientExamFromStudentExamPreview, clientExamFromStudentSolveExam } from "@/lib/studentExamContract";
import { localResultCacheFromServerReceipt } from "@/lib/studentAttemptReceipt";

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
    SubQuestionAnswers,
} from "@/types/omr";

const AUTOSAVE_INTERVAL_MS = 3000;
const OMR_PANEL_STORAGE_PREFIX = "omr_solve_panel";

interface SolveDraft {
    answers: Record<number, number>;
    subQuestionAnswers?: SubQuestionAnswers;
    /** Legacy inline drawings. New drafts store large handwriting payloads in IndexedDB. */
    drawings?: PdfDrawings;
    drawingsRef?: StoredDataRef;
    timeRemaining: number | null;
    startedAt: string;
    submissionId: string;
    savedAt: string;
}

function createSubmissionId(): string {
    const cryptoObject = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
    if (cryptoObject?.randomUUID) return cryptoObject.randomUUID();
    const bytes = new Uint8Array(16);
    if (cryptoObject?.getRandomValues) cryptoObject.getRandomValues(bytes);
    else for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map(value => value.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function validSubmissionId(value: unknown): value is string {
    return typeof value === "string"
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
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

interface ExamGuestEntryGroup {
    groupId?: string;
    groupName?: string;
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
    const dialogRef = useRef<HTMLDivElement>(null);
    const onCloseRef = useRef(onClose);

    useEffect(() => {
        onCloseRef.current = onClose;
    }, [onClose]);

    useEffect(() => {
        const dialog = dialogRef.current;
        if (!dialog) return;

        const previouslyFocused = document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        const focusableSelector = [
            'button:not([disabled])',
            'a[href]',
            'input:not([disabled])',
            'select:not([disabled])',
            'textarea:not([disabled])',
            '[tabindex]:not([tabindex="-1"])',
        ].join(',');
        const focusableElements = () => Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector))
            .filter(element => element.getAttribute('aria-hidden') !== 'true');
        const animationFrame = window.requestAnimationFrame(() => {
            const autoFocusTarget = dialog.querySelector<HTMLElement>('[autofocus]');
            (autoFocusTarget || focusableElements()[0] || dialog).focus();
        });

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                onCloseRef.current();
                return;
            }
            if (event.key !== 'Tab') return;

            const focusable = focusableElements();
            if (focusable.length === 0) {
                event.preventDefault();
                dialog.focus();
                return;
            }
            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            const active = document.activeElement;
            if (event.shiftKey && (active === first || !dialog.contains(active))) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && active === last) {
                event.preventDefault();
                first.focus();
            }
        };

        document.addEventListener('keydown', handleKeyDown, true);
        return () => {
            window.cancelAnimationFrame(animationFrame);
            document.removeEventListener('keydown', handleKeyDown, true);
            // WebKit may apply its own post-Escape focus step after the React
            // unmount cleanup. Restore on the next frame so the invoking
            // control reliably regains focus across iPhone/iPad Safari too.
            window.requestAnimationFrame(() => {
                if (previouslyFocused?.isConnected) previouslyFocused.focus();
            });
        };
    }, []);

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
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-label={title}
                tabIndex={-1}
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
                        style={{
                            width: 44,
                            height: 44,
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            color: 'var(--muted)',
                            fontSize: '1.25rem',
                            lineHeight: 1,
                        }}
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
    minHeight: 44,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '0.7rem 1rem',
    borderRadius: 'var(--radius-md)',
    fontWeight: 700,
    fontSize: '0.9rem',
};

function cleanEntryText(value: string | undefined): string {
    return value?.trim() || "";
}

function normalizeEntryCode(value: string | undefined): string {
    return cleanEntryText(value).toLocaleLowerCase("ko-KR");
}

function allowedExamGroupIds(exam: Pick<Exam, "accessConfig"> | null | undefined): string[] {
    if (exam?.accessConfig?.type !== "group") return [];
    return (exam.accessConfig.groupIds || []).map(cleanEntryText).filter(Boolean);
}

function resolveExamGuestGroup(
    exam: Pick<Exam, "accessConfig"> | null | undefined,
    requestedCode: string,
    allowSingleGroupFallback: boolean,
): ExamGuestEntryGroup | null {
    const allowedGroups = allowedExamGroupIds(exam);
    if (allowedGroups.length === 0) return null;

    const normalizedCode = normalizeEntryCode(requestedCode);
    if (normalizedCode) {
        const matchedGroupId = allowedGroups.find(groupId => normalizeEntryCode(groupId) === normalizedCode);
        if (matchedGroupId) return { groupId: matchedGroupId, groupName: matchedGroupId };
        return null;
    }

    if (allowSingleGroupFallback && allowedGroups.length === 1) {
        return { groupId: allowedGroups[0], groupName: allowedGroups[0] };
    }
    return null;
}

function entryIdentityLabel(session: StudentSession | null): string {
    if (!session) return "";
    const scope = [session.regionName, session.groupName || session.groupId].filter(Boolean).join(" ");
    return scope ? `${session.name} · ${scope}` : session.name;
}

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
            body: "이 시험은 지정된 반 학생만 응시할 수 있습니다. 학생 홈에서 로그인하거나 반 코드로 게스트 입장한 뒤 다시 열어주세요.",
            action: "학생 로그인",
        };
    }
    if (decision.status === "group_denied") {
        return {
            title: "응시 대상 반이 아닙니다",
            body: "현재 학생 정보 또는 반 코드가 이 시험의 배포 대상 반과 일치하지 않습니다. 학생 홈에서 다시 확인해주세요.",
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

function buildStudentLoginHref(): string {
    if (typeof window === "undefined") return "/?role=student";
    const next = `${window.location.pathname}${window.location.search}`;
    const query = new URLSearchParams({ role: "student", next });
    const workspaceId = getSession()?.workspaceId;
    if (workspaceId) query.set("workspace", workspaceId);
    return `/?${query.toString()}`;
}

function buildRetakeDraftSegment(config: RetakeConfig | null): string {
    if (!config) return "base";
    const questionKey = [...new Set(config.questionIds)].sort((a, b) => a - b).join("-");
    return [
        "retake",
        encodeURIComponent(config.sourceAttemptId || "source"),
        encodeURIComponent(config.mode),
        encodeURIComponent(questionKey || "questions"),
    ].join("_");
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

function ExamEntryConfirmDialog({
    examTitle,
    user,
    canUseStudent,
    guestName,
    groupCode,
    needsGroupCode,
    suggestedGroupName,
    error,
    studentLoginHref,
    onGuestNameChange,
    onGroupCodeChange,
    onContinueStudent,
    onContinueGuest,
    onExit,
}: {
    examTitle: string;
    user: StudentSession | null;
    canUseStudent: boolean;
    guestName: string;
    groupCode: string;
    needsGroupCode: boolean;
    suggestedGroupName: string;
    error: string;
    studentLoginHref: string;
    onGuestNameChange: (value: string) => void;
    onGroupCodeChange: (value: string) => void;
    onContinueStudent: () => void;
    onContinueGuest: () => void;
    onExit: () => void;
}) {
    const studentLabel = entryIdentityLabel(user);
    const showStudentPanel = !!user && !user.isGuest;
    return (
        <SolveDialogShell title="시험 입장 확인" onClose={onExit}>
            <div style={{ display: 'grid', gap: '1rem' }}>
                <div style={{
                    padding: '0.9rem 1rem',
                    borderRadius: 'var(--radius-md)',
                    border: '1px solid var(--border)',
                    background: 'var(--background)',
                }}>
                    <div style={{ fontSize: '0.78rem', fontWeight: 850, color: 'var(--muted)', marginBottom: '0.35rem' }}>
                        공유 링크
                    </div>
                    <div style={{ fontSize: '1rem', fontWeight: 850, lineHeight: 1.45, wordBreak: 'keep-all' }}>
                        {examTitle}
                    </div>
                    {suggestedGroupName && (
                        <div style={{ marginTop: '0.35rem', fontSize: '0.8rem', color: 'var(--primary)', fontWeight: 800 }}>
                            반 코드: {suggestedGroupName}
                        </div>
                    )}
                </div>

                {showStudentPanel && (
                    <div style={{
                        padding: '0.9rem 1rem',
                        borderRadius: 'var(--radius-md)',
                        border: canUseStudent ? '1px solid rgba(16,185,129,0.28)' : '1px solid rgba(245,158,11,0.28)',
                        background: canUseStudent ? 'rgba(16,185,129,0.08)' : 'rgba(245,158,11,0.1)',
                    }}>
                        <div style={{ fontSize: '0.78rem', fontWeight: 850, color: canUseStudent ? 'var(--success)' : 'var(--warning)', marginBottom: '0.25rem' }}>
                            현재 앱 로그인
                        </div>
                        <div style={{ fontSize: '0.95rem', fontWeight: 850, color: 'var(--foreground)', wordBreak: 'keep-all' }}>
                            {studentLabel}
                        </div>
                        {!canUseStudent && (
                            <p style={{ marginTop: '0.45rem', fontSize: '0.78rem', color: 'var(--muted)', lineHeight: 1.5, wordBreak: 'keep-all' }}>
                                로그인된 학생 정보가 이 시험의 대상 반과 맞지 않습니다. 학생 홈에서 다시 로그인하거나 게스트로 입장하세요.
                            </p>
                        )}
                    </div>
                )}

                <div style={{ display: 'grid', gap: '0.75rem' }}>
                    {!showStudentPanel && (
                        <p style={{ color: 'var(--muted)', fontSize: '0.9rem', lineHeight: 1.6, wordBreak: 'keep-all' }}>
                            앱에 학생 로그인이 되어 있으면 학생 기록으로 응시할 수 있습니다. 로그인하지 않은 기기에서는 게스트 기록으로 저장됩니다.
                        </p>
                    )}
                    {needsGroupCode && (
                        <label style={{ display: 'grid', gap: '0.45rem' }}>
                            <span style={{ fontSize: '0.78rem', fontWeight: 850, color: 'var(--muted)' }}>반 코드</span>
                            <input
                                value={groupCode}
                                onChange={(event) => onGroupCodeChange(event.target.value)}
                                onKeyDown={(event) => {
                                    if (event.key === 'Enter') onContinueGuest();
                                }}
                                placeholder="선생님이 알려준 코드"
                                autoCapitalize="characters"
                                spellCheck={false}
                                style={{
                                    width: '100%',
                                    padding: '0.8rem 0.95rem',
                                    borderRadius: 'var(--radius-md)',
                                    border: '1px solid var(--border)',
                                    background: 'var(--background)',
                                    color: 'var(--foreground)',
                                    fontSize: '1rem',
                                }}
                            />
                        </label>
                    )}
                    <label style={{ display: 'grid', gap: '0.45rem' }}>
                        <span style={{ fontSize: '0.78rem', fontWeight: 850, color: 'var(--muted)' }}>게스트 이름</span>
                        <input
                            value={guestName}
                            onChange={(event) => onGuestNameChange(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter') onContinueGuest();
                            }}
                            placeholder="미입력 시 Guest Student"
                            autoComplete="name"
                            style={{
                                width: '100%',
                                padding: '0.8rem 0.95rem',
                                borderRadius: 'var(--radius-md)',
                                border: '1px solid var(--border)',
                                background: 'var(--background)',
                                color: 'var(--foreground)',
                                fontSize: '1rem',
                            }}
                        />
                    </label>
                    {error && (
                        <div role="alert" style={{ color: 'var(--error)', fontSize: '0.82rem', fontWeight: 800, lineHeight: 1.45 }}>
                            {error}
                        </div>
                    )}
                </div>

                <div style={{ display: 'grid', gap: '0.55rem' }}>
                    {canUseStudent && (
                        <button type="button" className="btn btn-primary" onClick={onContinueStudent} style={{ width: '100%', justifyContent: 'center' }}>
                            학생으로 시험 보기
                        </button>
                    )}
                    <button
                        type="button"
                        className={canUseStudent ? "btn btn-secondary" : "btn btn-primary"}
                        onClick={onContinueGuest}
                        style={{ width: '100%', justifyContent: 'center' }}
                    >
                        게스트로 시험 보기
                    </button>
                    <Link href={studentLoginHref} className="btn" style={{
                        width: '100%',
                        justifyContent: 'center',
                        background: 'transparent',
                        border: '1px solid var(--border)',
                        color: 'var(--muted)',
                    }}>
                        학생 로그인으로 보기
                    </Link>
                </div>
            </div>
        </SolveDialogShell>
    );
}

function SolveLoadErrorCard({ error }: { error: SolveLoadError }) {
    return (
        <div className="layout-main solve-page" style={{
            background: 'var(--background)',
            minHeight: 'var(--app-viewport-height, 100dvh)',
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
    /**
     * Where examData came from. "server" = answer-less payload from the
     * loadExamForSolving server action (access already server-checked).
     * "local" = full on-device exam; access is evaluated client-side as before.
     */
    const [examSource, setExamSource] = useState<ExamSource>("local");
    const [solveStatus, setSolveStatus] = useState<SolveAccessStatus | "loading">("loading");
    const [loadError, setLoadError] = useState<SolveLoadError | null>(null);
    const [studentAnswers, setStudentAnswers] = useState<Record<number, number>>({});
    const [subQuestionAnswers, setSubQuestionAnswers] = useState<SubQuestionAnswers>({});
    const [drawings, setDrawings] = useState<PdfDrawings>({});
    const [pdfFile, setPdfFile] = useState<File | null>(null);
    const [currentPlan, setCurrentPlan] = useState<PlanKey>("free");
    const [retakeConfig, setRetakeConfig] = useState<RetakeConfig | null>(null);

    const [user, setUser] = useState<StudentSession | null>(() => getSession());

    // Navigation State
    const [currentQuestionId, setCurrentQuestionId] = useState<number | null>(null);
    const [pdfCurrentPage, setPdfCurrentPage] = useState<number | undefined>(undefined);
    const [pdfFocusTarget, setPdfFocusTarget] = useState<{ page: number; x: number; y: number; key: number } | null>(null);

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
    const [entryConfirmed, setEntryConfirmed] = useState(false);
    const [secureRemoteMode, setSecureRemoteMode] = useState(false);
    const [secureAttemptTicket, setSecureAttemptTicket] = useState("");
    const [secureRequiresPin, setSecureRequiresPin] = useState(false);
    const [entryGuestName, setEntryGuestName] = useState("");
    const [entryGroupCode, setEntryGroupCode] = useState("");
    const [entryError, setEntryError] = useState("");
    const [linkClassCode, setLinkClassCode] = useState("");
    const [currentSolvePath, setCurrentSolvePath] = useState("");

    // Timer + autosave State
    const [startedAt, setStartedAt] = useState(() => new Date().toISOString());
    const [timeRemaining, setTimeRemaining] = useState<number | null>(null); // seconds
    const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
    const [hasResumed, setHasResumed] = useState(false);
    const [pinVerified, setPinVerified] = useState(false);
    const [pinInput, setPinInput] = useState("");
    const [pinError, setPinError] = useState("");
    /** Verified PIN, threaded into server submit (incl. timer auto-submit). */
    const pinRef = useRef("");
    const submittedRef = useRef(false);
    const submissionIdRef = useRef("");
    const studentAnswersRef = useRef<Record<number, number>>({});
    const subQuestionAnswersRef = useRef<SubQuestionAnswers>({});
    const latestDraftRef = useRef<SolveDraft | null>(null);
    const autosaveErrorShownRef = useRef(false);
    const examQuestionsRef = useRef<Question[]>([]);
    const currentQuestionIdRef = useRef<number | null>(null);
    const activeQuestionRef = useRef<{ questionId: number; startedAtMs: number } | null>(null);
    const questionTimingRef = useRef<Record<number, QuestionTimingDraft>>({});
    const focusLossEventsRef = useRef<FocusLossEvent[]>([]);
    const pdfFocusRequestIdRef = useRef(0);
    const [hydratedOMRPanelKey, setHydratedOMRPanelKey] = useState("");

    const interactionAllowed = !!examData && entryConfirmed && (
        secureRemoteMode
            ? !secureRequiresPin || pinVerified
            : evaluateExamAccess(examData, { session: user, pinVerified }).status === "allowed"
    );

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

    /**
     * Single source of truth for "may the student solve right now".
     * Server-sourced exams: the server already decided (solveStatus).
     * Local exams: live client evaluation, so schedule windows (startAt/endAt)
     * keep being enforced mid-session exactly as before.
     */
    const solveAccess: SolveAccessStatus | "loading" = secureRemoteMode && examData && secureRequiresPin && !pinVerified
        ? "pin_required"
        : (examSource === "local" && examData)
        ? (() => {
            const decision = evaluateExamAccess(examData, { session: user, pinVerified });
            return decision.status === "allowed" ? "ok" : decision.status;
        })()
        : solveStatus;
    const solveAllowed = solveAccess === "ok" && interactionAllowed;

    // Anti-cheat Window Focus/Visibility Monitoring
    useEffect(() => {
        if (submittedRef.current) return;
        if (!solveAllowed) return;

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
    }, [beginQuestionVisit, getQuestionById, settleActiveQuestion, solveAllowed]);

    useEffect(() => {
        currentQuestionIdRef.current = currentQuestionId;
    }, [currentQuestionId]);

    useEffect(() => {
        examQuestionsRef.current = examData?.questions || [];
    }, [examData]);

    const draftOwnerKey = user?.studentId || user?.guestId || persistId;
    const draftRetakeSegment = buildRetakeDraftSegment(retakeConfig);
    const DRAFT_KEY = id && draftOwnerKey ? `omr_draft_${id}_${draftOwnerKey}_${draftRetakeSegment}` : "";
    const LEGACY_DRAFT_KEY = id ? `omr_draft_${id}` : "";
    const OMR_PANEL_KEY = id && draftOwnerKey ? `${OMR_PANEL_STORAGE_PREFIX}_${id}_${draftOwnerKey}_${draftRetakeSegment}` : "";

    const saveDraftSnapshot = useCallback(async (draftSnapshot = latestDraftRef.current) => {
        if (typeof window === "undefined") return false;
        if (!DRAFT_KEY || submittedRef.current || !draftSnapshot) return false;
        if (!solveAllowed) return false;

        const savedAt = new Date().toISOString();
        const draftDrawings = compactDrawings(draftSnapshot.drawings || {});
        const lightweightDraft: SolveDraft = {
            answers: draftSnapshot.answers,
            subQuestionAnswers: draftSnapshot.subQuestionAnswers,
            drawingsRef: draftSnapshot.drawingsRef,
            timeRemaining: draftSnapshot.timeRemaining,
            startedAt: draftSnapshot.startedAt,
            submissionId: draftSnapshot.submissionId,
            savedAt,
        };

        try {
            localStorage.setItem(DRAFT_KEY, JSON.stringify(lightweightDraft));
            setLastSavedAt(new Date(savedAt));
        } catch {
            if (!autosaveErrorShownRef.current) {
                autosaveErrorShownRef.current = true;
                toast.error("임시저장 실패", "브라우저 저장소가 가득 찼거나 차단되어 답안을 저장하지 못했습니다.");
            }
            return false;
        }

        try {
            let drawingsRef = draftSnapshot.drawingsRef;
            if (hasDrawings(draftDrawings)) {
                drawingsRef = await saveJsonRecord(`draft:${id}:${draftOwnerKey}:drawings`, draftDrawings);
                if (!drawingsRef) throw new Error("Failed to save draft drawings");
            }

            const persistedDraft: SolveDraft = {
                ...lightweightDraft,
                drawingsRef,
            };
            localStorage.setItem(DRAFT_KEY, JSON.stringify(persistedDraft));
            if (latestDraftRef.current) {
                latestDraftRef.current = {
                    ...latestDraftRef.current,
                    drawingsRef,
                    savedAt,
                };
            }
            autosaveErrorShownRef.current = false;
            setLastSavedAt(new Date(savedAt));
            return true;
        } catch {
            if (!autosaveErrorShownRef.current) {
                autosaveErrorShownRef.current = true;
                toast.error("필기 임시저장 지연", "답안은 저장됐지만 필기 저장은 다시 시도합니다.");
            }
            return true;
        }
    }, [DRAFT_KEY, draftOwnerKey, id, solveAllowed]);

    useEffect(() => {
        if (typeof window === "undefined" || !OMR_PANEL_KEY) {
            setHydratedOMRPanelKey("");
            return;
        }
        setHydratedOMRPanelKey("");
        const stored = window.localStorage.getItem(OMR_PANEL_KEY);
        const hasStoredPreference = stored === "collapsed" || stored === "expanded";
        const shouldStartCollapsed = window.matchMedia("(min-width: 600px)").matches;
        setIsOMRCollapsed(hasStoredPreference ? stored === "collapsed" : shouldStartCollapsed);
        setHydratedOMRPanelKey(OMR_PANEL_KEY);
    }, [OMR_PANEL_KEY]);

    useEffect(() => {
        if (typeof window === "undefined" || !OMR_PANEL_KEY || hydratedOMRPanelKey !== OMR_PANEL_KEY) return;
        window.localStorage.setItem(OMR_PANEL_KEY, isOMRCollapsed ? "collapsed" : "expanded");
    }, [OMR_PANEL_KEY, hydratedOMRPanelKey, isOMRCollapsed]);

    /**
     * Initialize the solve workspace from a loaded exam payload. Shared by the
     * initial hydrate and the server PIN gate (the server withholds the payload
     * until the PIN passes, so PIN-gated exams fully initialize on PIN success).
     */
    const applyLoadedExam = useCallback(
        async (parsed: Exam & Partial<Pick<SolvableExam, "premiumCapabilities">>, source: ExamSource, session: StudentSession | null, pinAlreadyVerified = false) => {
            try {
                // Server payloads carry an organization-plan capability. Local
                // fallback has no trusted plan source and therefore stays Free.
                setCurrentPlan(source === "server" && parsed.premiumCapabilities?.handwritingArchive ? "pro" : "free");
                parsed = stripTeacherOnlySubQuestionFields(parsed);
                setLoadError(null);
                examQuestionsRef.current = parsed.questions;
                setExamData(parsed);
                setExamSource(source);
                if (source === "local") {
                    // pinAlreadyVerified: the PIN dialog just passed for this local
                    // exam, so don't reset pinVerified back to false and re-gate it.
                    const requiresPin = examRequiresPin(parsed);
                    const effectivePinVerified = pinAlreadyVerified || !requiresPin;
                    setPinVerified(effectivePinVerified);
                } else {
                    // The server only hands out the payload once access (incl. PIN) passed.
                    setPinVerified(true);
                    setSolveStatus("ok");
                }
                setPinInput("");
                setPinError("");
                currentQuestionIdRef.current = null;
                activeQuestionRef.current = null;
                setCurrentQuestionId(null);

                const searchParams = new URLSearchParams(window.location.search);
                const rawQuestionIds = (searchParams.get("questions") || "")
                    .split(",")
                    .map(value => Number(value.trim()))
                    .filter(value => Number.isFinite(value));
                const validQuestionIds = source === "server"
                    ? [...new Set(rawQuestionIds.filter(questionId => Number.isInteger(questionId) && questionId > 0))]
                    : rawQuestionIds.filter(questionId => parsed.questions.some(question => question.id === questionId));
                let nextRetakeConfig: RetakeConfig | null = null;
                if (validQuestionIds.length > 0) {
                    const mode = searchParams.get("mode") === "similar" ? "similar"
                        : searchParams.get("mode") === "custom" ? "custom"
                            : "wrong";
                    nextRetakeConfig = {
                        sourceAttemptId: searchParams.get("retakeFrom") || `exam:${parsed.id}`,
                        questionIds: validQuestionIds,
                        mode,
                        labels: (searchParams.get("labels") || "").split(",").filter(Boolean),
                        concepts: (searchParams.get("concepts") || "").split(",").filter(Boolean),
                    };
                    setRetakeConfig(nextRetakeConfig);
                    toast.info("재시험 모드", `${validQuestionIds.length}개 문항만 다시 풉니다.`);
                } else if (parsed.questions[0]) {
                    setRetakeConfig(null);
                }

                // Enforce schedule window (startAt/endAt)
                const now = Date.now();
                if (parsed.startAt && new Date(parsed.startAt).getTime() > now) {
                    toast.info("아직 응시 시작 전입니다", `${new Date(parsed.startAt).toLocaleString('ko-KR')}에 시작합니다.`);
                }
                if (parsed.endAt && new Date(parsed.endAt).getTime() < now) {
                    toast.error("응시 기간 종료", "이 시험의 응시 가능 기간이 지났습니다.");
                }

                // Initialize timer from duration, clamped to the schedule end so a
                // student entering near endAt isn't shown a full-duration countdown
                // that outlives the window (which strands answers at the boundary).
                if (parsed.durationMin && typeof parsed.durationMin === "number") {
                    setTimeRemaining(remainingSecondsWithinWindow(parsed.durationMin * 60, parsed.endAt, now));
                }

                // Restore draft (autosave) if present
                try {
                    const ownerKey = session?.studentId || session?.guestId || persistId;
                    const draftSegment = buildRetakeDraftSegment(nextRetakeConfig);
                    const scopedDraftKey = ownerKey ? `omr_draft_${id}_${ownerKey}_${draftSegment}` : "";
                    const legacyScopedDraftKey = ownerKey ? `omr_draft_${id}_${ownerKey}` : "";
                    const draftStr = (scopedDraftKey ? localStorage.getItem(scopedDraftKey) : null)
                        || (!nextRetakeConfig && legacyScopedDraftKey ? localStorage.getItem(legacyScopedDraftKey) : null)
                        || (!nextRetakeConfig ? localStorage.getItem(`omr_draft_${id}`) : null);
                    if (draftStr) {
                        const draft = JSON.parse(draftStr) as Partial<SolveDraft>;
                        const restoredAnswers = draft.answers && typeof draft.answers === "object" ? draft.answers : {};
                        const restoredSubQuestionAnswers = draft.subQuestionAnswers && typeof draft.subQuestionAnswers === "object"
                            ? draft.subQuestionAnswers
                            : {};
                        if (Object.keys(restoredAnswers).length > 0) {
                            studentAnswersRef.current = restoredAnswers;
                            setStudentAnswers(restoredAnswers);
                        }
                        subQuestionAnswersRef.current = restoredSubQuestionAnswers;
                        setSubQuestionAnswers(restoredSubQuestionAnswers);
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
                        const rawRestoredTimeRemaining = typeof draft.timeRemaining === "number"
                            ? draft.timeRemaining
                            : typeof parsed.durationMin === "number"
                                ? parsed.durationMin * 60
                                : null;
                        // Clamp the restored (possibly paused/edited) timer to the
                        // schedule window so reopening a draft after endAt yields 0.
                        const restoredTimeRemaining = rawRestoredTimeRemaining === null
                            ? null
                            : remainingSecondsWithinWindow(rawRestoredTimeRemaining, parsed.endAt, now);
                        const restoredStartedAt = typeof draft.startedAt === "string" ? draft.startedAt : new Date().toISOString();
                        const restoredSubmissionId = validSubmissionId(draft.submissionId)
                            ? draft.submissionId
                            : createSubmissionId();
                        submissionIdRef.current = restoredSubmissionId;
                        if (typeof draft.timeRemaining === "number") {
                            setTimeRemaining(restoredTimeRemaining);
                        }
                        if (typeof draft.startedAt === "string") {
                            setStartedAt(restoredStartedAt);
                        }
                        latestDraftRef.current = {
                            answers: restoredAnswers,
                            subQuestionAnswers: restoredSubQuestionAnswers,
                            drawings: recovery.drawings || {},
                            drawingsRef: draft.drawingsRef,
                            timeRemaining: restoredTimeRemaining,
                            startedAt: restoredStartedAt,
                            submissionId: restoredSubmissionId,
                            savedAt: typeof draft.savedAt === "string" ? draft.savedAt : new Date().toISOString(),
                        };
                        setHasResumed(true);
                    }
                } catch {
                    // ignore bad draft
                }

                const [problemPdf, answerPdf] = await Promise.all([
                    storedDataUrlToFile("problem.pdf", parsed.pdfData, parsed.pdfDataRef),
                    source === "server"
                        ? Promise.resolve(null)
                        : storedDataUrlToFile("answer_key.pdf", parsed.answerKeyPdf, parsed.answerKeyPdfRef),
                ]);
                if (problemPdf) setPdfFile(problemPdf);
                if (answerPdf) setAnswerFile(answerPdf);
            } catch {
                setLoadError({
                    title: "시험 데이터를 읽지 못했습니다",
                    body: "문제지 PDF 또는 시험 설정을 불러오는 중 문제가 발생했습니다. 잠시 후 다시 열거나 선생님에게 문의해주세요.",
                });
                toast.error("시험 데이터 로드 실패", "저장된 PDF 또는 시험 설정을 읽지 못했습니다.");
            }
        },
        [id, persistId],
    );

    useEffect(() => {
        const currentSession = getSession();
        if (currentSession) setUser(currentSession);
        const currentSearch = typeof window !== "undefined" ? window.location.search : "";
        const currentPath = typeof window !== "undefined" ? `${window.location.pathname}${currentSearch}` : "";
        const currentParams = new URLSearchParams(currentSearch);
        setCurrentSolvePath(currentPath);
        setLinkClassCode(
            currentParams.get(SOLVE_CLASS_CODE_PARAM)
            || currentParams.get("group")
            || currentParams.get("groupId")
            || currentParams.get("class")
            || ""
        );
        setEntryGroupCode("");
        setEntryGuestName("");
        setEntryError("");
        setEntryConfirmed(false);
        setSecureRemoteMode(false);
        setSecureAttemptTicket("");
        setSecureRequiresPin(false);

        const hydrateExam = async () => {
            if (!id) return;
            setLoadError(null);
            setSolveStatus("loading");

            // Server session first — exam actions key off the signed HttpOnly
            // cookie. Never rebuild a student cookie from localStorage fields.
            let session = currentSession;
            try {
                if (!session || session.isGuest) {
                    const issued = await issueGuestSession(session?.name);
                    if (issued.ok && issued.guestId && issued.guestId !== session?.guestId) {
                        const guestSession: StudentSession = {
                            studentId: `guest:${issued.guestId}`,
                            loginId: guestLoginIdFor(issued.guestId),
                            name: session?.name || "Guest Student",
                            isGuest: true,
                            identityType: "guest",
                            guestId: issued.guestId,
                            groupName: session?.groupName || "Guest Mode",
                        };
                        saveSession(guestSession);
                        setUser(guestSession);
                        localStorage.setItem("omr_guest_id", issued.guestId);
                        session = guestSession;
                    }
                } else if (session.studentId && session.workspaceId) {
                    const validated = await validateStudentSession();
                    if (!validated.ok) {
                        const query = new URLSearchParams({
                            role: "student",
                            next: `/solve/${id}`,
                        });
                        if (session.workspaceId) query.set("workspace", session.workspaceId);
                        router.replace(`/?${query.toString()}`);
                        return;
                    }
                }
            } catch {
                // offline/dev — the local fallback path below still works
            }

            const res = await loadExamForSolvingClient(id, undefined, {
                server: (examId, pin) => loadExamForSolving(examId, pin),
                readLocalExam,
                evaluateLocalAccess: (exam) => {
                    const requiresPin = examRequiresPin(exam);
                    const decision = evaluateExamAccess(exam, { session, pinVerified: !requiresPin });
                    return decision.status === "allowed" ? "ok" : decision.status;
                },
            });

            if (res.exam) {
                // Local-blocked states (PIN, schedule window) re-derive live from examData.
                await applyLoadedExam(res.exam as Exam, res.source, session);
                return;
            }

            // Compatibility gateway for deployments that still expose the
            // ticket-based student attempt RPC. The signed student-session path
            // above remains authoritative; this branch is only reached when it
            // cannot return an exam payload.
            if (res.status === "not_found" || res.status === "error" || res.status === "unauthenticated") {
                const remotePreview = await previewStudentExam(id);
                if (remotePreview.status === "available") {
                    const previewExam = clientExamFromStudentExamPreview(remotePreview.exam);
                    if (previewExam.questions.some(question => (question.subQuestions?.length || 0) > 0)) {
                        setLoadError({
                            title: "학생 로그인을 다시 확인해주세요",
                            body: "심화 응답이 있는 시험은 학생 서버 세션으로 입장해야 합니다. 처음 화면에서 다시 로그인해주세요.",
                        });
                        return;
                    }
                    setSecureRemoteMode(true);
                    setSecureRequiresPin(remotePreview.exam.access.requiresPin);
                    setSecureAttemptTicket("");
                    await applyLoadedExam(previewExam as Exam, "server", session);
                    setPinVerified(!remotePreview.exam.access.requiresPin);
                    return;
                }
            }
            if (res.status === "pin_required" || res.status === "pin_rate_limited") {
                setExamSource(res.source);
                setSolveStatus("pin_required");
                if (res.status === "pin_rate_limited") {
                    setPinError("PIN 시도 횟수를 초과했습니다. 5분 후 다시 시도해주세요.");
                }
                return;
            }
            if (res.status === "login_required" || res.status === "group_denied"
                || res.status === "not_started" || res.status === "ended" || res.status === "archived") {
                setExamSource(res.source);
                setSolveStatus(res.status);
                return;
            }
            if (res.status === "unauthenticated") {
                setLoadError({
                    title: "세션을 확인하지 못했습니다",
                    body: "브라우저 쿠키가 차단되어 있거나 세션이 만료되었습니다. 새로고침해도 반복되면 처음 화면에서 다시 로그인해주세요.",
                });
                return;
            }
            setLoadError(res.status === "not_found"
                ? {
                    title: "시험을 찾을 수 없습니다",
                    body: "링크가 잘못됐거나 선생님이 시험을 삭제했을 수 있습니다. 받은 링크를 다시 확인해주세요.",
                }
                : {
                    title: "시험을 불러올 수 없습니다",
                    body: "네트워크 상태를 확인한 뒤 잠시 후 다시 시도해주세요.",
                });
        };

        hydrateExam();
    }, [applyLoadedExam, id, router]);

    // Show resume banner once after initial load
    useEffect(() => {
        if (hasResumed) {
            toast.info("임시저장 복원됨", "이전에 풀던 답안을 불러왔습니다.");
        }
    }, [hasResumed]);

    // Tick timer every second when examData has duration. Auto-submit at 0.
    useEffect(() => {
        if (timeRemaining === null || submittedRef.current) return;
        if (!solveAllowed) return;
        if (timeRemaining <= 0) {
            handleSubmitInternal(true);
            return;
        }
        const id = setTimeout(() => setTimeRemaining(t => (t === null ? null : t - 1)), 1000);
        return () => clearTimeout(id);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [timeRemaining, solveAllowed]);

    useEffect(() => {
        studentAnswersRef.current = studentAnswers;
        subQuestionAnswersRef.current = subQuestionAnswers;
        if (!submissionIdRef.current) submissionIdRef.current = createSubmissionId();
        latestDraftRef.current = {
            answers: studentAnswers,
            subQuestionAnswers,
            drawings: compactDrawings(drawings),
            drawingsRef: latestDraftRef.current?.drawingsRef,
            timeRemaining,
            startedAt,
            submissionId: submissionIdRef.current,
            savedAt: new Date().toISOString(),
        };
    }, [studentAnswers, subQuestionAnswers, drawings, timeRemaining, startedAt]);

    // Autosave draft every 3s. Keep this interval independent from the ticking timer.
    useEffect(() => {
        if (!DRAFT_KEY) return;
        if (!solveAllowed) return;

        const handleVisibilityChange = () => {
            if (document.visibilityState === "hidden") void saveDraftSnapshot();
        };
        const handlePageHide = () => {
            void saveDraftSnapshot();
        };

        const intervalId = window.setInterval(() => { void saveDraftSnapshot(); }, AUTOSAVE_INTERVAL_MS);
        window.addEventListener("pagehide", handlePageHide);
        window.addEventListener("visibilitychange", handleVisibilityChange);

        return () => {
            window.clearInterval(intervalId);
            window.removeEventListener("pagehide", handlePageHide);
            window.removeEventListener("visibilitychange", handleVisibilityChange);
        };
    }, [DRAFT_KEY, saveDraftSnapshot, solveAllowed]);

    // Warn on tab close if there are unsaved answers
    useEffect(() => {
        const onBeforeUnload = (e: BeforeUnloadEvent) => {
            if (submittedRef.current) return;
            if (Object.keys(studentAnswers).length === 0 && Object.keys(subQuestionAnswers).length === 0 && !hasDrawings(drawings)) return;
            e.preventDefault();
            e.returnValue = "";
        };
        window.addEventListener("beforeunload", onBeforeUnload);
        return () => window.removeEventListener("beforeunload", onBeforeUnload);
    }, [studentAnswers, subQuestionAnswers, drawings]);

    const handleAnswerClick = (qId: number, optionIndex: number) => {
        const nowMs = Date.now();
        beginQuestionVisit(qId, nowMs);
        const previousAnswers = studentAnswersRef.current;
        // Clicking the already-selected option clears it, so a mis-tap can be
        // returned to 미응답 (unanswered) — blank must stay distinct from wrong
        // for review, retake targeting and teacher analytics.
        const isUnmark = previousAnswers[qId] === optionIndex;
        if (previousAnswers[qId] !== optionIndex || isUnmark) {
            const timing = ensureQuestionTiming(qId, nowMs);
            timing.answerChangeCount += 1;
            timing.lastAnsweredAt = new Date(nowMs).toISOString();
        }

        let nextAnswers: Record<number, number>;
        if (isUnmark) {
            nextAnswers = { ...previousAnswers };
            delete nextAnswers[qId];
        } else {
            nextAnswers = { ...previousAnswers, [qId]: optionIndex };
        }
        const nextDraft: SolveDraft = {
            answers: nextAnswers,
            subQuestionAnswers: subQuestionAnswersRef.current,
            drawings: compactDrawings(drawings),
            drawingsRef: latestDraftRef.current?.drawingsRef,
            timeRemaining,
            startedAt,
            submissionId: submissionIdRef.current || createSubmissionId(),
            savedAt: new Date().toISOString(),
        };
        submissionIdRef.current = nextDraft.submissionId;
        studentAnswersRef.current = nextAnswers;
        latestDraftRef.current = nextDraft;
        setStudentAnswers(nextAnswers);
        void saveDraftSnapshot(nextDraft);
    };

    const handleSubQuestionAnswer = (questionId: number, subQuestionId: string, body: string, maxLength: number) => {
        const trimmedToLimit = body.slice(0, maxLength);
        const current = subQuestionAnswersRef.current;
        const questionAnswers = { ...(current[questionId] || {}) };
        if (trimmedToLimit.trim()) {
            questionAnswers[subQuestionId] = {
                schemaVersion: 1,
                body: trimmedToLimit,
                answeredAt: new Date().toISOString(),
                reviewStatus: 'needs_review',
            };
        } else {
            delete questionAnswers[subQuestionId];
        }
        const next = { ...current };
        if (Object.keys(questionAnswers).length > 0) next[questionId] = questionAnswers;
        else delete next[questionId];
        subQuestionAnswersRef.current = next;
        setSubQuestionAnswers(next);
    };

    const handleQuestionClick = (qId: number) => {
        beginQuestionVisit(qId);
        if (examData) {
            const activeQuestion = getActiveExamQuestions().find(q => q.id === qId);
            const q = activeQuestion || examData.questions.find(q => q.id === qId);
            // Keep the answer pane open when this question asks for a written
            // response; plain OMR questions still return focus to the PDF.
            setIsOMRCollapsed(true);
            if (q?.subQuestions?.length) setIsOMRCollapsed(false);
            const focusAnchor = q?.pdfLocation
                ? q.pdfLocation
                : q?.pdfRegion
                    ? {
                        page: q.pdfRegion.page,
                        x: q.pdfRegion.x + q.pdfRegion.width / 2,
                        y: q.pdfRegion.y + q.pdfRegion.height / 2,
                    }
                    : null;
            if (focusAnchor) {
                setPdfCurrentPage(focusAnchor.page);
                pdfFocusRequestIdRef.current += 1;
                setPdfFocusTarget({
                    page: focusAnchor.page,
                    x: focusAnchor.x,
                    y: focusAnchor.y,
                    key: pdfFocusRequestIdRef.current,
                });
            }
        }
    };

    const handleDrawingsChange = (page: number, newPaths: string[]) => {
        setDrawings(prev => ({ ...prev, [page]: newPaths }));
    };

    const toggleOMRPanel = useCallback(() => {
        setIsOMRCollapsed(prev => !prev);
    }, []);

    const createGuestSubmitter = useCallback(async (
        name: string,
        group?: ExamGuestEntryGroup | null,
    ): Promise<StudentSession> => {
        // Server-issued guest identity: reuses a valid guest cookie (keeping the
        // guestId stable) and refreshes its display name. Device-local id only
        // as the offline/dev fallback.
        let guestId = "";
        try {
            const issued = await issueGuestSession(name.trim() || undefined);
            if (issued.ok && issued.guestId) guestId = issued.guestId;
        } catch {
            // offline/dev — fall back to the device-local guest id
        }
        if (!guestId) guestId = getOrCreateGuestId();
        const submitter: StudentSession = {
            studentId: `guest:${guestId}`,
            loginId: guestLoginIdFor(guestId),
            name: name.trim() || "Guest Student",
            isGuest: true,
            identityType: 'guest',
            guestId,
            groupId: group?.groupId,
            groupName: group?.groupName || 'Guest',
        };
        saveSession(submitter);
        setUser(submitter);
        localStorage.setItem("omr_guest_id", guestId);
        return submitter;
    }, []);

    const beginConfirmedEntry = useCallback(() => {
        if (!examData) return;
        setEntryError("");
        setEntryConfirmed(true);
        if (!hasResumed) {
            setStartedAt(new Date().toISOString());
        }
        const firstQuestionId = retakeConfig?.questionIds[0] || examData.questions[0]?.id;
        if (firstQuestionId) beginQuestionVisit(firstQuestionId);
    }, [beginQuestionVisit, examData, hasResumed, retakeConfig]);

    const beginSecureEntry = async (submitter: StudentSession) => {
        if (!examData) return false;
        const result = await openStudentExam({
            examId: examData.id,
            pin: pinInput,
            questionIds: retakeConfig?.questionIds,
            student: {
                studentId: submitter.studentId || submitter.guestId || persistId,
                studentName: submitter.name,
                identityType: submitter.identityType || (submitter.isGuest ? "guest" : "temporary"),
                groupId: submitter.groupId,
                groupName: submitter.groupName,
                guestId: submitter.guestId,
            },
        });
        if (result.status !== "allowed") {
            if (result.status === "pin_required") {
                setPinVerified(false);
                setPinError("PIN이 일치하지 않습니다.");
            } else {
                const message = result.status === "group_denied"
                    ? "현재 학생 또는 반 정보가 이 시험의 배포 대상과 일치하지 않습니다."
                    : result.status === "login_required"
                        ? "학생 로그인이 필요합니다."
                        : result.status === "invalid_questions"
                            ? "재시험 링크의 문항 범위가 올바르지 않습니다. 선생님에게 새 링크를 요청해주세요."
                        : result.status === "not_started"
                            ? "아직 응시 시작 전입니다."
                            : result.status === "ended"
                                ? "응시 기간이 종료되었습니다."
                                : result.status === "archived"
                                    ? "보관된 시험은 응시할 수 없습니다."
                                    : "시험 서버에 연결하지 못했습니다. 잠시 후 다시 시도해주세요.";
                setEntryError(message);
            }
            return false;
        }

        const safeExam = clientExamFromStudentSolveExam(result.exam);
        setExamData(safeExam);
        examQuestionsRef.current = safeExam.questions;
        saveLocalExam(safeExam);
        setSecureAttemptTicket(result.ticket);
        setSecureRequiresPin(result.exam.access.requiresPin);
        setPinVerified(true);
        setEntryError("");
        beginConfirmedEntry();
        return true;
    };

    const continueEntryAsStudent = async () => {
        if (!examData || !user || user.isGuest) return;
        if (secureRemoteMode) {
            await beginSecureEntry(user);
            return;
        }
        const decision = evaluateExamAccess(examData, { session: user, pinVerified });
        if (decision.status !== "allowed") {
            setEntryError("현재 학생 정보가 이 시험의 대상과 맞지 않습니다. 학생 홈에서 다시 로그인하거나 게스트로 입장하세요.");
            return;
        }
        beginConfirmedEntry();
    };

    const continueEntryAsGuest = async () => {
        if (!examData) return;
        const isGroupExam = examData.accessConfig?.type === "group";
        const requestedGroupCode = entryGroupCode || linkClassCode;
        const guestGroup = isGroupExam
            ? secureRemoteMode
                ? requestedGroupCode.trim()
                    ? { groupId: requestedGroupCode.trim(), groupName: requestedGroupCode.trim() }
                    : null
                : resolveExamGuestGroup(examData, requestedGroupCode, true)
            : null;

        if (isGroupExam && !guestGroup) {
            setEntryError("반 코드가 이 시험의 배포 대상과 일치하지 않습니다.");
            return;
        }

        const submitter = await createGuestSubmitter(entryGuestName, guestGroup);
        if (secureRemoteMode) {
            await beginSecureEntry(submitter);
            return;
        }
        const decision = evaluateExamAccess(examData, { session: submitter, pinVerified });
        if (decision.status !== "allowed") {
            const copy = accessDecisionCopy(decision);
            setEntryError(copy.body);
            return;
        }
        beginConfirmedEntry();
    };

    const handleSubmitInternal = async (autoSubmitted = false, overrideSubmitter?: StudentSession) => {
        if (!examData) return;
        if (submittedRef.current) return;

        let submitter = overrideSubmitter || user;
        if (solveAccess !== "ok") {
            if (solveAccess === "login_required") {
                toast.error("로그인 필요", "이 시험은 지정된 반 학생만 응시할 수 있습니다.");
                router.push(buildStudentLoginHref());
                return;
            }
            const copy = accessDecisionCopy({ status: solveAccess } as ExamAccessDecision);
            toast.error(copy.title, copy.body);
            return;
        }

        if (!submitter) {
            if (autoSubmitted) {
                submitter = await createGuestSubmitter("Guest Student");
            } else {
                setGuestName("");
                setGuestSubmitPending({ autoSubmitted });
                return;
            }
        }

        submittedRef.current = true;

        const activeExamQuestions = getActiveExamQuestions();
        const questionTimings = buildQuestionTimingSnapshot(activeExamQuestions);

        const submissionId = submissionIdRef.current || createSubmissionId();
        submissionIdRef.current = submissionId;
        const attemptId = submissionId;
        const activeDrawings = compactDrawings(drawings);
        const activeDrawingStrokeCount = drawingStrokeCount(activeDrawings);
        const activeDrawingPageCount = Object.keys(activeDrawings).length;
        const questionDrawings = summarizeQuestionDrawings(examData.questions, activeDrawings);
        const canStoreHandwriting = canArchiveHandwriting(currentPlan);

        if (secureRemoteMode) {
            if (!secureAttemptTicket) {
                submittedRef.current = false;
                toast.error("응시 세션 만료", "시험 입장 정보를 다시 확인해주세요.");
                return;
            }
            const result = await submitStudentAttempt({
                ticket: secureAttemptTicket,
                answers: studentAnswersRef.current,
                autoSubmitted,
                tabFociLostCount,
                questionTimings,
                focusLossEvents: focusLossEventsRef.current,
            });
            if (result.status !== "submitted") {
                submittedRef.current = false;
                const detail = result.status === "invalid_ticket"
                    ? "응시 세션이 만료됐거나 위조된 요청입니다. 시험에 다시 입장해주세요."
                    : result.status === "invalid_submission"
                        ? "허용되지 않은 문항 또는 답안이 포함됐습니다. 답안을 확인해주세요."
                        : "서버에 답안을 저장하지 못했습니다. 네트워크를 확인한 뒤 다시 제출해주세요.";
                toast.error("서버 제출 실패", detail);
                return;
            }

            const shouldArchiveDrawings = hasDrawings(activeDrawings) && canStoreHandwriting;
            const handwritingUpload = shouldArchiveDrawings
                ? await uploadStudentAttemptHandwriting({
                    ticket: secureAttemptTicket,
                    attemptId: result.receipt.attemptId,
                    drawings: activeDrawings,
                })
                : null;
            const officialResultCache = localResultCacheFromServerReceipt(result.receipt, {
                examTitle: examData.title,
                studentName: submitter.name,
                studentId: submitter.studentId || submitter.guestId || persistId,
                groupId: submitter.groupId,
                groupName: submitter.groupName,
                identityType: submitter.identityType || (submitter.isGuest ? "guest" : "temporary"),
            });
            const cachedAttempt: Attempt = {
                id: result.receipt.attemptId,
                examId: result.receipt.examId,
                examTitle: examData.title,
                studentName: submitter.name,
                studentId: submitter.studentId || submitter.guestId || persistId,
                groupId: submitter.groupId,
                groupName: submitter.groupName,
                identityType: submitter.identityType || (submitter.isGuest ? "guest" : "temporary"),
                guestId: submitter.guestId,
                startedAt,
                finishedAt: result.receipt.finishedAt,
                score: result.receipt.score,
                totalScore: result.receipt.totalScore,
                answers: officialResultCache.answers,
                questionResults: officialResultCache.questionResults,
                status: "completed",
                autoSubmitted,
                tabFociLostCount,
                questionTimings,
                focusLossEvents: focusLossEventsRef.current,
                drawingsRef: handwritingUpload?.status === "uploaded" ? handwritingUpload.ref : undefined,
                handwritingArchived: handwritingUpload?.status === "uploaded",
                handwritingPlan: currentPlan,
                questionDrawings,
                retake: retakeConfig ? { ...retakeConfig, createdAt: new Date().toISOString() } : undefined,
            };
            saveLocalAttempt(cachedAttempt);
            if (!shouldArchiveDrawings || handwritingUpload?.status === "uploaded") {
                try { localStorage.removeItem(DRAFT_KEY); } catch {}
                try { localStorage.removeItem(LEGACY_DRAFT_KEY); } catch {}
            }
            if (shouldArchiveDrawings && handwritingUpload?.status !== "uploaded") {
                toast.info("답안 제출 완료 · 필기 재시도 필요", "답안은 공식 저장됐지만 필기 업로드가 실패했습니다. 이 기기의 임시저장은 유지됩니다.");
            } else {
                toast.success("서버 제출 완료", "서버에서 채점하고 공식 결과를 저장했습니다.");
            }
            router.push(`/student/review/${result.receipt.attemptId}`);
            return;
        }

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

        const activeSubmitter = submitter;
        const handwriting: Attempt["handwriting"] = {
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
        };
        const submitInput: SubmitAttemptInput = {
            examId: id,
            submissionId,
            answers: studentAnswers,
            subQuestionAnswers,
            startedAt,
            autoSubmitted,
            tabFociLostCount,
            questionTimings,
            focusLossEvents: focusLossEventsRef.current,
            drawings: canStoreHandwriting && hasDrawings(activeDrawings) ? activeDrawings : undefined,
            drawingsRef,
            handwriting,
            handwritingArchived: !!drawingsRef,
            handwritingPlan: currentPlan,
            drawingPageCount: activeDrawingPageCount,
            drawingStrokeCount: activeDrawingStrokeCount,
            questionDrawings,
            retake: retakeConfig ? {
                ...retakeConfig,
                createdAt: new Date().toISOString(),
            } : undefined,
        };

        // Degraded/offline fallback — grades on-device with the full local exam.
        // Never used for a server-sourced session (its payload has no answers).
        const buildLocalGradedAttempt = async (input: SubmitAttemptInput): Promise<Attempt | null> => {
            const graded = gradeAttempt(activeExamQuestions, input.answers);
            const finishedAt = new Date().toISOString();
            const safeSubQuestionAnswers = sanitizeSubQuestionAnswersForQuestions(activeExamQuestions, input.subQuestionAnswers, finishedAt);
            const missingRequired = findMissingRequiredSubQuestions(activeExamQuestions, safeSubQuestionAnswers);
            if (!input.autoSubmitted && missingRequired.length > 0) return null;
            const attemptData: Attempt = {
                id: attemptId,
                examId: id,
                examTitle: examData.title,
                studentName: activeSubmitter.name,
                studentId: activeSubmitter.studentId || activeSubmitter.guestId || persistId,
                groupId: activeSubmitter.groupId,
                groupName: activeSubmitter.groupName,
                regionId: activeSubmitter.regionId,
                regionName: activeSubmitter.regionName,
                identityType: activeSubmitter.identityType || (activeSubmitter.isGuest ? 'guest' : 'temporary'),
                guestId: activeSubmitter.guestId,
                startedAt: input.startedAt,
                finishedAt,
                score: graded.earnedScore,
                totalScore: graded.totalScore,
                answers: input.answers,
                subQuestionAnswers: Object.keys(safeSubQuestionAnswers).length > 0 ? safeSubQuestionAnswers : undefined,
                missingRequiredSubQuestions: input.autoSubmitted && missingRequired.length > 0 ? missingRequired : undefined,
                drawings: input.drawings,
                drawingsRef: input.drawingsRef,
                handwriting: input.handwriting,
                handwritingArchived: input.handwritingArchived,
                handwritingPlan: input.handwritingPlan,
                drawingPageCount: input.drawingPageCount,
                drawingStrokeCount: input.drawingStrokeCount,
                questionDrawings: input.questionDrawings,
                status: 'completed' as const,
                autoSubmitted: input.autoSubmitted,
                tabFociLostCount: input.tabFociLostCount,
                questionTimings: input.questionTimings,
                focusLossEvents: input.focusLossEvents,
                retake: input.retake,
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
                if (!feedback.ok) return null;
                if (feedback.level === "info") {
                    toast.info(feedback.title, feedback.detail);
                }
                return attemptData;
            } catch {
                return null;
            }
        };

        const res = await submitAttemptClient(submitInput, pinRef.current || undefined, {
            server: (input, pin) => submitAttempt(input, pin),
            localFallback: buildLocalGradedAttempt,
            allowLocalFallback: examSource === "local",
        });

        if (res.status !== "ok" || !res.attempt) {
            submittedRef.current = false;
            // A PIN rejection is only meaningful on the server path — the local
            // grading path never checks a PIN, so treating a local-session
            // pin_required as a PIN failure would re-gate against a stale local
            // PIN and loop. Only the server path re-opens the PIN dialog.
            if ((res.status === "pin_required" || res.status === "pin_rate_limited") && examSource === "server") {
                setSolveStatus("pin_required");
                toast.error(
                    "PIN 확인 필요",
                    res.status === "pin_rate_limited"
                        ? "PIN 시도 횟수를 초과했습니다. 5분 후 다시 제출해주세요."
                        : "시험 PIN을 다시 입력한 뒤 제출해주세요.",
                );
            } else if (res.status === "ended" || res.status === "not_started" || res.status === "archived") {
                const copy = accessDecisionCopy({ status: res.status } as ExamAccessDecision);
                toast.error(copy.title, "제출이 저장되지 않았습니다. 선생님에게 문의해주세요.");
            } else {
                toast.error("제출 실패", "네트워크 상태를 확인한 뒤 다시 제출해주세요. 답안은 이 기기에 임시저장되어 있습니다.");
            }
            return;
        }

        if (res.source === "server") {
            // Local echo so review/history/dashboard local caches see it immediately.
            try { saveLocalAttempt(res.attempt); } catch { /* quota — server copy is canonical */ }
        }

        // Clean up draft
        try { localStorage.removeItem(DRAFT_KEY); } catch {}
        try { localStorage.removeItem(LEGACY_DRAFT_KEY); } catch {}

        if (autoSubmitted) {
            toast.info("시간 종료", "답안이 자동으로 제출되었습니다.");
        }
        router.push(`/student/review/${res.attempt.id}`);
    };

    const handleSubmit = () => {
        if (!examData) return;
        const activeExamQuestions = getActiveExamQuestions();
        const missingRequired = findMissingRequiredSubQuestions(activeExamQuestions, subQuestionAnswers);
        if (missingRequired.length > 0) {
            const first = activeExamQuestions.find(question => question.id === missingRequired[0].questionId);
            if (first) beginQuestionVisit(first.id);
            setIsOMRCollapsed(false);
            toast.error('필수 심화 응답 확인', `${first?.number || ''}번 문항부터 필수 하위 질문 ${missingRequired.length}개를 작성해 주세요.`);
            return;
        }
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

    const submitGuestName = async () => {
        const pending = guestSubmitPending;
        const trimmedName = guestName.trim();
        if (!pending || !trimmedName) return;
        const submitter = await createGuestSubmitter(trimmedName);
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
                // Student payloads no longer carry the answer-key PDF; recover it
                // from the teacher-side full exam after teacher auth succeeds.
                if (examSource === "server" && !answerFile) {
                    void (async () => {
                        try {
                            const fullExam = await loadPersistedExam(id);
                            if (!fullExam) return;
                            const answerPdf = await storedDataUrlToFile("answer_key.pdf", fullExam.answerKeyPdf, fullExam.answerKeyPdfRef);
                            if (answerPdf) setAnswerFile(answerPdf);
                        } catch {
                            // teacher can still upload the PDF manually
                        }
                    })();
                }
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

    useEffect(() => {
        if (!examData || !solveAllowed || currentQuestionId !== null) return;
        const firstQuestionId = retakeConfig?.questionIds[0] || examData.questions[0]?.id;
        if (firstQuestionId) beginQuestionVisit(firstQuestionId);
    }, [beginQuestionVisit, currentQuestionId, examData, retakeConfig, solveAllowed]);

    if (!examData && loadError) {
        return <SolveLoadErrorCard error={loadError} />;
    }

    const submitPin = async () => {
        if (secureRemoteMode) {
            // The compatibility gateway verifies the PIN together with the
            // selected student/guest identity when the entry button is pressed.
            setPinVerified(true);
            setPinError("");
            return;
        }
        // Local exams verify the on-device PIN; server exams re-request the
        // payload with the PIN and let the server decide.
        if (examSource === "local" && examData) {
            if (!verifyExamPin(examData, pinInput)) {
                setPinError("PIN이 일치하지 않습니다.");
                return;
            }
            pinRef.current = pinInput;
            setPinVerified(true);
            setPinError("");
            return;
        }
        const res = await loadExamForSolvingClient(id, pinInput, {
            server: (examId, pin) => loadExamForSolving(examId, pin),
            readLocalExam,
            evaluateLocalAccess: (exam) => {
                const decision = evaluateExamAccess(exam, { session: user, pinVerified: verifyExamPin(exam, pinInput) });
                return decision.status === "allowed" ? "ok" : decision.status;
            },
        });
        if (res.status === "ok" && res.exam) {
            pinRef.current = pinInput;
            setPinError("");
            // The PIN just passed — tell applyLoadedExam not to re-gate a local exam.
            await applyLoadedExam(res.exam as Exam, res.source, user, res.source === "local");
            return;
        }
        setPinError(
            res.status === "pin_rate_limited"
                ? "PIN 시도 횟수를 초과했습니다. 5분 후 다시 시도해주세요."
                : res.status === "error" || res.status === "not_found"
                    // Request itself failed — don't imply the PIN was wrong.
                    ? "확인 중 문제가 발생했습니다. 잠시 후 다시 시도해주세요."
                    : "PIN이 일치하지 않습니다.",
        );
    };

    if (solveAccess === "pin_required") {
        return (
            <div className="layout-main solve-page" style={{
                background: 'var(--background)',
                minHeight: 'var(--app-viewport-height, 100dvh)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '1rem',
            }}>
                <ExamPinDialog
                    examTitle={examData?.title || "이 시험"}
                    value={pinInput}
                    error={pinError}
                    onChange={(next) => {
                        setPinInput(next);
                        if (pinError) setPinError("");
                    }}
                    onSubmit={() => { void submitPin(); }}
                    onExit={() => router.push("/")}
                />
            </div>
        );
    }

    const canOfferGroupGuestEntry = !!examData
        && examData.accessConfig?.type === "group"
        && (solveAccess === "login_required" || solveAccess === "group_denied");

    if (solveAccess !== "ok" && solveAccess !== "loading" && !canOfferGroupGuestEntry) {
        return (
            <div className="layout-main solve-page" style={{
                background: 'var(--background)',
                minHeight: 'var(--app-viewport-height, 100dvh)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '1rem',
            }}>
                <ExamAccessBlockedDialog
                    decision={{ status: solveAccess } as ExamAccessDecision}
                    onExit={() => router.push(
                        solveAccess === "login_required" ? buildStudentLoginHref() : "/student/dashboard"
                    )}
                />
            </div>
        );
    }

    if (!examData) {
        return (
            <div style={{ padding: '2rem', textAlign: 'center' }}>
                <h2>시험을 불러오는 중...</h2>
                <Link href="/" className="btn btn-secondary">홈으로 돌아가기</Link>
            </div>
        );
    }

    const isGroupEntryExam = examData.accessConfig?.type === "group";
    const resolvedLinkGuestGroup = isGroupEntryExam
        ? secureRemoteMode
            ? (entryGroupCode || linkClassCode).trim()
                ? {
                    groupId: (entryGroupCode || linkClassCode).trim(),
                    groupName: (entryGroupCode || linkClassCode).trim(),
                }
                : null
            : resolveExamGuestGroup(examData, entryGroupCode || linkClassCode, true)
        : null;
    const canUseStudentEntry = !!user && !user.isGuest && solveAccess === "ok";
    const canShowEntryConfirm = !entryConfirmed && (solveAccess === "ok" || canOfferGroupGuestEntry);
    const studentLoginHref = currentSolvePath
        ? `/?role=student&next=${encodeURIComponent(currentSolvePath)}`
        : "/?role=student";

    if (canShowEntryConfirm) {
        return (
            <div className="layout-main solve-page" style={{
                background: 'var(--background)',
                minHeight: 'var(--app-viewport-height, 100dvh)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '1rem',
            }}>
                <ExamEntryConfirmDialog
                    examTitle={examData.title}
                    user={user}
                    canUseStudent={canUseStudentEntry}
                    guestName={entryGuestName}
                    groupCode={entryGroupCode}
                    needsGroupCode={!!isGroupEntryExam && !resolvedLinkGuestGroup}
                    suggestedGroupName={resolvedLinkGuestGroup?.groupName || ""}
                    error={entryError}
                    studentLoginHref={studentLoginHref}
                    onGuestNameChange={(next) => {
                        setEntryGuestName(next);
                        if (entryError) setEntryError("");
                    }}
                    onGroupCodeChange={(next) => {
                        setEntryGroupCode(next);
                        if (entryError) setEntryError("");
                    }}
                    onContinueStudent={() => { void continueEntryAsStudent(); }}
                    onContinueGuest={() => { void continueEntryAsGuest(); }}
                    onExit={() => router.push("/")}
                />
            </div>
        );
    }

    if (solveAccess !== "ok") {
        return (
            <div className="layout-main solve-page" style={{
                background: 'var(--background)',
                minHeight: 'var(--app-viewport-height, 100dvh)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '1rem',
            }}>
                <ExamAccessBlockedDialog
                    decision={{ status: solveAccess } as ExamAccessDecision}
                    onExit={() => router.push(
                        solveAccess === "login_required" ? buildStudentLoginHref() : "/student/dashboard"
                    )}
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
    const requiredSubProgress = requiredSubQuestionProgress(activeExamQuestions, subQuestionAnswers);
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
            height: 'var(--app-viewport-height, 100dvh)',
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
                        <BrandLogo compact markOnly priorityLabel="OMR Maker" className="solve-brand" style={{ fontSize: '1rem' }} />
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
                        {requiredSubProgress.total > 0 && (
                            <span style={{ fontSize: '0.72rem', fontWeight: 800, color: requiredSubProgress.completed === requiredSubProgress.total ? 'var(--success)' : 'var(--warning)', whiteSpace: 'nowrap' }}>
                                필수 심화 {requiredSubProgress.completed}/{requiredSubProgress.total}
                            </span>
                        )}
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
                                aria-label="선생님 모드"
                                checked={isTeacherMode}
                                onChange={(e) => toggleTeacherMode(e.target.checked)}
                                style={{ margin: 0 }}
                            />
                            <span className="solve-teacher-toggle-label">선생님 모드</span>
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
                        <ThemeToggle />
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
                        focusTarget={activeTab === 'problem' ? pdfFocusTarget : null}
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

                <div
                    className={`solve-omr-rail ${isOMRCollapsed ? 'is-collapsed' : ''}`}
                    aria-label="빠른 답안 레일"
                    style={{
                        backdropFilter: 'var(--solve-omr-rail-backdrop, none)',
                        WebkitBackdropFilter: 'var(--solve-omr-rail-backdrop, none)'
                    }}
                >
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
                    backdropFilter: 'var(--solve-omr-pane-backdrop, none)',
                    WebkitBackdropFilter: 'var(--solve-omr-pane-backdrop, none)',
                    display: 'flex',
                    flexDirection: 'column'
                }} aria-hidden={isOMRCollapsed} inert={isOMRCollapsed}>
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
                        {currentQuestion?.subQuestions?.length ? (
                            <section aria-label={`${currentQuestion.number}번 심화 응답`} style={{ margin: '0.75rem', padding: '0.75rem', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', background: 'var(--surface)', display: 'grid', gap: '0.7rem' }}>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}>
                                    <strong style={{ fontSize: '0.82rem' }}>{currentQuestion.number}번 심화 응답</strong>
                                    <span style={{ fontSize: '0.68rem', color: 'var(--muted)' }}>점수에는 반영되지 않습니다</span>
                                </div>
                                {currentQuestion.subQuestions.map((subQuestion, index) => {
                                    const maxLength = subQuestion.maxLength || 300;
                                    const value = subQuestionAnswers[currentQuestion.id]?.[subQuestion.id]?.body || '';
                                    return (
                                        <label key={subQuestion.id} style={{ display: 'grid', gap: '0.3rem', fontSize: '0.76rem', fontWeight: 800 }}>
                                            <span>{String.fromCharCode(65 + index)}. {subQuestion.prompt} {subQuestion.required && <em style={{ color: 'var(--error)', fontStyle: 'normal' }}>(필수)</em>}</span>
                                            <textarea
                                                value={value}
                                                maxLength={maxLength}
                                                onChange={event => handleSubQuestionAnswer(currentQuestion.id, subQuestion.id, event.target.value, maxLength)}
                                                placeholder="생각이나 근거를 짧게 적어주세요."
                                                className="input-field"
                                                style={{ minHeight: 72, resize: 'vertical', padding: '0.55rem', fontSize: '0.8rem', lineHeight: 1.5 }}
                                            />
                                            <span style={{ justifySelf: 'end', color: 'var(--muted)', fontSize: '0.66rem', fontWeight: 600 }}>{value.length}/{maxLength}</span>
                                        </label>
                                    );
                                })}
                            </section>
                        ) : null}
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
                    onClose={() => {
                        setSubmitConfirm(null);
                        window.requestAnimationFrame(() => {
                            document.querySelector<HTMLElement>('.solve-submit-button')?.focus();
                        });
                    }}
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
                    <div
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="solve-focus-warning-title"
                        style={{
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
                        <h2 id="solve-focus-warning-title" style={{
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
                                minHeight: '44px',
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
