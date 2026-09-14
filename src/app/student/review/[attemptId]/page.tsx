"use client";

import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import dynamic from "next/dynamic";
import {
    BookOpen,
    CheckCircle2,
    ChevronDown,
    ChevronUp,
    Clock,
    Download,
    FileText,
    HelpCircle,
    MessageSquare,
    Printer,
    Repeat2,
    Send,
    Target,
    TrendingUp,
} from "lucide-react";
import type { Attempt, AttemptFeedback, Exam, PdfDrawings, Question, QuestionResultStatus, QuestionTiming, StudentQuestionNote } from "@/types/omr";
import { storedDataUrlToFile, loadJsonRecord } from "@/utils/blobStore";
import { attemptBelongsToSession, getSession } from "@/utils/storage";
import {
    readLocalAttempts,
    saveLocalAttempt,
    saveLocalServerConfirmedAttempt,
} from "@/lib/omrPersistence";
import { askAttemptQuestion, loadMyAttemptHandwriting, submitAttempt } from "@/app/actions/studentExam";
import { loadStudentOfficialAttempt } from "@/lib/studentAttemptClient";
import type { StudentTrustedOfficialReview } from "@/lib/studentAttemptHistoryContract";
import { studentQuestionsByQuestionId, upsertStudentQuestion } from "@/lib/studentQuestions";
import {
    flushPendingStudentQuestions,
    pendingStudentQuestionNotesById,
    queuePendingStudentQuestion,
    readPendingStudentQuestions,
} from "@/lib/studentQuestionOutbox";
import { buildAttemptRetakeRecovery, buildSourceAttemptRecovery } from "@/lib/retakeRecovery";
import { toast } from "@/components/Toast";
import ThemeToggle from "@/components/ThemeToggle";
import CountUp from "@/components/dashboard/CountUp";
import HandwritingUploadRecoveryCard from "@/components/student/HandwritingUploadRecoveryCard";
import { GradingEvidenceNote } from "@/components/dashboard/StatusPill";
import { formatKoreanDateTime } from "@/lib/pure";
import { awaySeverity } from "@/lib/examAwayTracker";
import {
    buildLearningRecommendations,
    buildRetakeQuestionIds,
    buildStudentWeaknessGroups,
    buildStudentReviewQuestionSnapshot,
    resolveAttemptGrading,
    summarizeCanonicalQuestionSubset,
    summarizeAttemptBehavior,
} from "@/lib/premiumAnalytics";
import type { AttemptGradingSource } from "@/lib/premiumAnalytics";
import { buildRetakeHref, supportedReviewRetakeModes, type ReviewAttemptSource } from "@/lib/retakeLinks";
import { buildAnnotatedPdfBlob } from "@/lib/annotatedPdfExport";
import {
    buildFeedbackDownloadText,
    buildFeedbackMarkupDownloadJson,
    canDownloadReturnedFeedback,
    canDownloadReturnedMarkup,
    loadFeedbackMarkupDrawings,
    mergePdfDrawings,
} from "@/lib/feedbackPersistence";
import {
    loadStudentReturnedFeedbackForAttempt,
    markStudentFeedbackOpened,
} from "@/lib/studentFeedbackClient";
import {
    persistSubmissionReceipt,
    isSubmissionReceiptStorageKey,
    readReconciledSubmissionAttemptId,
    readSubmissionReceipt,
    retryPendingSubmissionReceipt,
    SUBMISSION_RECEIPT_RECONCILED_EVENT,
    submissionReceiptLabel,
    submissionReceiptForAttempt,
    type SubmissionReceipt,
    type SubmissionReceiptReconciledDetail,
} from "@/lib/studentAttemptReceipt";
import { downloadRemoteStudentHandwriting } from "@/lib/studentRemoteHandwritingClient";

const PDFViewer = dynamic(() => import("@/components/PDFViewer"), { ssr: false });

type StudentReviewModel = Omit<StudentTrustedOfficialReview, "gradingSource"> & {
    gradingSource: AttemptGradingSource;
};

function buildLocalStudentReviewModel(exam: Exam, attempt: Attempt): StudentReviewModel {
    const questions = buildStudentReviewQuestionSnapshot(exam, attempt);
    const reviewExam: Exam = { ...exam, questions };
    const grading = resolveAttemptGrading(reviewExam, attempt);
    return {
        gradingSource: grading.source,
        questions,
        questionResults: grading.questionResults,
        scoreSummary: grading.scoreSummary,
        weaknessGroups: buildStudentWeaknessGroups(reviewExam, attempt).slice(0, 3),
        recommendations: buildLearningRecommendations(reviewExam, [attempt], {
            scope: "attempt",
            attempt,
            includeSlowCorrect: true,
            limit: 5,
        }),
        behavior: summarizeAttemptBehavior(attempt),
    };
}

function hasDrawings(drawings?: PdfDrawings): boolean {
    return !!drawings && Object.values(drawings).some(paths => paths.length > 0);
}

function formatSeconds(totalSec: number): string {
    if (totalSec < 60) return `${totalSec}초`;
    const minutes = Math.floor(totalSec / 60);
    const seconds = totalSec % 60;
    return seconds > 0 ? `${minutes}분 ${seconds}초` : `${minutes}분`;
}

function studentQuestionStorageKey(attemptId: string): string {
    return `omr_student_question_queue_${attemptId}`;
}

function isStudentQuestionNote(value: unknown): value is StudentQuestionNote {
    return !!value
        && typeof value === "object"
        && !Array.isArray(value)
        && typeof (value as StudentQuestionNote).questionId === "number"
        && typeof (value as StudentQuestionNote).questionNumber === "number"
        && typeof (value as StudentQuestionNote).body === "string";
}

function readStudentQuestionQueue(attemptId: string): Record<number, StudentQuestionNote> {
    if (typeof window === "undefined") return {};
    try {
        const parsed = JSON.parse(localStorage.getItem(studentQuestionStorageKey(attemptId)) || "{}") as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
        return Object.entries(parsed).reduce<Record<number, StudentQuestionNote>>((acc, [key, value]) => {
            const questionId = Number(key);
            if (Number.isFinite(questionId) && isStudentQuestionNote(value)) acc[questionId] = value;
            return acc;
        }, {});
    } catch {
        return {};
    }
}

// NOTE: the legacy per-attempt localStorage question queue is read-only now —
// it backfills questions that predate the attempt-payload model on every load
// (see readStudentQuestionQueue merge below). It is deliberately never cleared:
// its notes are not migrated onto the attempt, so deleting it would lose them.

/**
 * Union student-question notes by questionId. Server notes win on conflict —
 * they are the authoritative post-sync copy — while local-only notes (queued
 * offline and not yet synced) are preserved so an online submit never drops
 * them (F7).
 */
function mergeStudentQuestionNotes(
    local: StudentQuestionNote[] | undefined,
    server: StudentQuestionNote[] | undefined,
): StudentQuestionNote[] {
    const byId = new Map<number, StudentQuestionNote>();
    for (const note of local || []) byId.set(note.questionId, note);
    for (const note of server || []) byId.set(note.questionId, note);
    return [...byId.values()].sort((a, b) => a.questionNumber - b.questionNumber || a.questionId - b.questionId);
}

function MiniStat({ label, value, color }: { label: string; value: number | string; color: string }) {
    return (
        <div className="student-review-mini-stat">
            <span>{label}</span>
            <strong style={{ color }}>
                {/* Numeric stats roll up with the score reveal; strings stay static. */}
                {typeof value === "number" ? <CountUp value={value} delayMs={250} durationMs={700} /> : value}
            </strong>
        </div>
    );
}

function StatusChip({ status }: { status: QuestionResultStatus }) {
    // Palette lives in globals.css tone classes so both themes render correctly.
    const copy = status === "correct"
        ? { label: "정답", tone: "tone-success" }
        : status === "wrong"
            ? { label: "오답", tone: "tone-error" }
            : status === "unanswered"
                ? { label: "미응답", tone: "tone-neutral" }
                : { label: "미채점", tone: "tone-neutral" };

    return (
        <span className={`student-review-status-chip ${copy.tone}`}>
            {copy.label}
        </span>
    );
}

function questionStatusLabel(status: QuestionResultStatus): string {
    if (status === "correct") return "정답";
    if (status === "wrong") return "오답";
    if (status === "unanswered") return "미응답";
    return "미채점";
}

function MetaChip({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "primary" | "teal" | "amber" }) {
    // Palette lives in globals.css tone classes so both themes render correctly.
    return (
        <span className={`student-review-meta-chip tone-${tone}`}>
            {children}
        </span>
    );
}

function QuestionCard({
    question,
    userAnswer,
    correctAnswer,
    status,
    timing,
    explanationOpen,
    questionBoxOpen,
    draft,
    submittedQuestion,
    subQuestionAnswers,
    retakeHref,
    recovered,
    explanationRequestArmed,
    onToggleExplanation,
    onToggleQuestionBox,
    onDraftChange,
    onSubmitQuestion,
    onRequestExplanation,
}: {
    question: Question;
    userAnswer?: number;
    correctAnswer?: number;
    status: QuestionResultStatus;
    recovered?: boolean;
    timing?: QuestionTiming;
    explanationOpen: boolean;
    questionBoxOpen: boolean;
    draft: string;
    submittedQuestion?: StudentQuestionNote;
    subQuestionAnswers?: NonNullable<Attempt["subQuestionAnswers"]>[number];
    retakeHref: string | null;
    explanationRequestArmed?: boolean;
    onToggleExplanation: () => void;
    onToggleQuestionBox: () => void;
    onDraftChange: (value: string) => void;
    onSubmitQuestion: () => void;
    onRequestExplanation: () => void;
}) {
    const isCorrect = status === "correct";
    const isSkipped = status === "unanswered";
    const isUngraded = status === "ungraded";
    const hasExplanation = !!question.explanation?.trim();
    const canSubmit = draft.trim().length > 0;

    return (
        <article className={`student-review-question-card ${status !== "correct" && status !== "ungraded" ? "is-needs-review" : ""}`}>
            <div className="student-review-question-head">
                <div>
                    <h3>문항 {question.number}</h3>
                    <div className="student-review-answer-line">
                        <span>내 답</span>
                        <strong className={isCorrect || isUngraded ? "" : "is-wrong"}>
                            {isSkipped ? "(미응답)" : typeof userAnswer === "number" ? `${userAnswer}번` : "-"}
                        </strong>
                        {correctAnswer !== undefined && (
                            <>
                                <span>정답</span>
                                <strong className="is-correct">{correctAnswer}번</strong>
                            </>
                        )}
                    </div>
                </div>
                <StatusChip status={status} />
            </div>

            {(recovered || question.label || question.tags?.concept || question.tags?.source || timing) && (
                <div className="student-review-meta-row">
                    {recovered && <MetaChip tone="teal">재시험 회복</MetaChip>}
                    {question.label && <MetaChip>#{question.label}</MetaChip>}
                    {question.tags?.concept && <MetaChip tone="primary">{question.tags.concept}</MetaChip>}
                    {question.tags?.source && <MetaChip tone="teal">{question.tags.source}</MetaChip>}
                    {timing && <MetaChip tone="amber">{formatSeconds(timing.totalTimeSec)} · 방문 {timing.visitCount}회</MetaChip>}
                </div>
            )}

            <div className="student-review-question-actions mobile-action-row">
                {retakeHref && (
                    <Link href={retakeHref} className="btn btn-secondary student-review-compact-button">
                        <FileText size={13} />
                        다시 풀기
                    </Link>
                )}
                {hasExplanation ? (
                    <button
                        type="button"
                        onClick={onToggleExplanation}
                        className="student-review-link-button"
                        aria-expanded={explanationOpen}
                    >
                        <BookOpen size={14} />
                        해설
                        {explanationOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                    </button>
                ) : submittedQuestion ? (
                    <span className="student-review-muted-note" title="이미 이 문항에 질문/요청을 남겼습니다">질문 접수됨</span>
                ) : (
                    <button
                        type="button"
                        onClick={onRequestExplanation}
                        className="student-review-link-button"
                        title={explanationRequestArmed
                            ? "한 번 더 누르면 선생님께 해설 요청이 전송됩니다"
                            : "선생님께 이 문항의 해설 작성을 요청합니다"}
                        aria-live="polite"
                    >
                        <HelpCircle size={14} />
                        {explanationRequestArmed ? "한 번 더 누르면 전송" : "해설 요청"}
                    </button>
                )}
                <button
                    type="button"
                    onClick={onToggleQuestionBox}
                    className="student-review-link-button"
                    aria-expanded={questionBoxOpen}
                >
                    <MessageSquare size={14} />
                    질문
                    {questionBoxOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                </button>
            </div>

            {hasExplanation && explanationOpen && (
                <div className="student-review-explanation student-review-long-copy">
                    {question.explanation}
                </div>
            )}

            {!!question.subQuestions?.length && (
                <div className="student-review-subquestions" style={{ marginTop: '0.75rem', padding: '0.75rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', background: 'var(--background)', display: 'grid', gap: '0.6rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', alignItems: 'center' }}>
                        <strong style={{ fontSize: '0.8rem' }}>내 심화 응답</strong>
                        <span style={{ fontSize: '0.68rem', color: 'var(--muted)' }}>점수 미반영</span>
                    </div>
                    {question.subQuestions.map((subQuestion, index) => {
                        const answer = subQuestionAnswers?.[subQuestion.id];
                        return (
                            <div key={subQuestion.id} className="student-review-subquestion" style={{ display: 'grid', gap: '0.25rem' }}>
                                <span className="student-review-long-copy" style={{ color: 'var(--muted)', fontSize: '0.72rem', fontWeight: 800 }}>{String.fromCharCode(65 + index)}. {subQuestion.prompt}</span>
                                <div className="student-review-long-copy" style={{ whiteSpace: 'pre-wrap', fontSize: '0.82rem', lineHeight: 1.55, color: answer ? 'var(--foreground)' : 'var(--muted)' }}>{answer?.body || '작성하지 않음'}</div>
                                {answer?.reviewStatus === 'reviewed' && <span style={{ color: 'var(--success)', fontSize: '0.66rem', fontWeight: 800 }}>선생님 검토 완료</span>}
                            </div>
                        );
                    })}
                </div>
            )}

            {(questionBoxOpen || submittedQuestion) && (
                <div className="student-review-question-box">
                    {submittedQuestion && (
                        <div className="student-review-question-submitted">
                            <CheckCircle2 size={15} />
                            <span>
                                {formatKoreanDateTime(submittedQuestion.createdAt)}
                                {submittedQuestion.status === "answered" ? " 답변 완료" : " 질문 대기"}
                            </span>
                        </div>
                    )}
                    {submittedQuestion && (
                        <div className="student-review-long-copy" style={{
                            padding: '0.65rem 0.75rem',
                            borderRadius: 'var(--radius-md)',
                            border: '1px solid var(--border)',
                            background: 'var(--background)',
                            color: 'var(--muted)',
                            fontSize: '0.82rem',
                            lineHeight: 1.6,
                            whiteSpace: 'pre-wrap',
                            marginBottom: '0.55rem',
                        }}>
                            {submittedQuestion.body}
                        </div>
                    )}
                    {submittedQuestion?.status === "answered" && submittedQuestion.answer && (
                        <div className="student-review-teacher-answer" style={{
                            padding: '0.7rem 0.8rem',
                            borderRadius: 'var(--radius-md)',
                            border: '1px solid color-mix(in srgb, var(--success) 45%, var(--border))',
                            background: 'color-mix(in srgb, var(--success) 10%, var(--surface))',
                            marginBottom: '0.65rem',
                        }}>
                            <div className="student-review-teacher-answer-head" style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.35rem',
                                color: 'var(--success)',
                                fontWeight: 800,
                                fontSize: '0.78rem',
                                marginBottom: '0.35rem',
                            }}>
                                <MessageSquare size={13} />
                                {submittedQuestion.answer.teacherName
                                    ? `${submittedQuestion.answer.teacherName} 선생님 답변`
                                    : "선생님 답변"}
                                <span style={{ color: 'var(--muted)', fontWeight: 600 }}>
                                    · {formatKoreanDateTime(submittedQuestion.answer.createdAt)}
                                </span>
                            </div>
                            <div className="student-review-long-copy" style={{ color: 'var(--foreground)', fontSize: '0.85rem', lineHeight: 1.65, whiteSpace: 'pre-wrap' }}>
                                {submittedQuestion.answer.body}
                            </div>
                        </div>
                    )}
                    <label htmlFor={`student-question-${question.id}`}>선생님께 남길 질문</label>
                    <textarea
                        id={`student-question-${question.id}`}
                        value={draft}
                        onChange={(event) => onDraftChange(event.target.value)}
                        placeholder="어떤 부분이 헷갈렸는지 짧게 남겨두세요."
                    />
                    <div className="student-review-question-submit-row">
                        <span>{draft.trim().length}/500</span>
                        <button
                            type="button"
                            onClick={onSubmitQuestion}
                            className="btn btn-primary student-review-compact-button"
                            disabled={!canSubmit}
                        >
                            <Send size={13} />
                            질문 저장
                        </button>
                    </div>
                </div>
            )}
        </article>
    );
}

export default function ReviewPage() {
    const params = useParams();
    const router = useRouter();
    const id = params?.attemptId as string;

    const [attempt, setAttempt] = useState<Attempt | null>(null);
    const [attemptSource, setAttemptSource] = useState<ReviewAttemptSource>(null);
    const [serverRetakeEligibleQuestionIds, setServerRetakeEligibleQuestionIds] = useState<number[]>([]);
    const [trustedReview, setTrustedReview] = useState<StudentTrustedOfficialReview | null>(null);
    const [exam, setExam] = useState<Exam | null>(null);
    const [submissionReceipt, setSubmissionReceipt] = useState<SubmissionReceipt | null>(null);
    const [submissionRetrying, setSubmissionRetrying] = useState(false);
    const [submissionRetryFeedback, setSubmissionRetryFeedback] = useState("");
    const [submissionRetryPin, setSubmissionRetryPin] = useState("");
    const [restoredDrawings, setRestoredDrawings] = useState<PdfDrawings | undefined>(undefined);
    const [pdfFile, setPdfFile] = useState<File | null>(null);
    const [pdfLoadFailed, setPdfLoadFailed] = useState(false);
    const [filterWrong, setFilterWrong] = useState(false);
    const [selectedQuestionId, setSelectedQuestionId] = useState<number | null>(null);
    const [openExplanations, setOpenExplanations] = useState<Record<number, boolean>>({});
    const [openQuestionBoxes, setOpenQuestionBoxes] = useState<Record<number, boolean>>({});
    const [questionDrafts, setQuestionDrafts] = useState<Record<number, string>>({});
    const [studentQuestions, setStudentQuestions] = useState<Record<number, StudentQuestionNote>>({});
    const [sourceAttempt, setSourceAttempt] = useState<Attempt | null>(null);
    const [accessDenied, setAccessDenied] = useState(false);
    const [loadError, setLoadError] = useState(false);
    const [reloadKey, setReloadKey] = useState(0);
    const [handwritingUnavailable, setHandwritingUnavailable] = useState(false);
    // Two-step confirm for the one-click explanation request: the first click
    // arms the button, the second sends. Auto-disarms after a moment so a
    // stray click never silently fires a request to the teacher.
    const [explanationRequestArmedId, setExplanationRequestArmedId] = useState<number | null>(null);
    const explanationRequestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => () => {
        if (explanationRequestTimerRef.current) clearTimeout(explanationRequestTimerRef.current);
    }, []);
    const [returnedFeedback, setReturnedFeedback] = useState<AttemptFeedback | null>(null);
    const [teacherMarkupDrawings, setTeacherMarkupDrawings] = useState<PdfDrawings | undefined>(undefined);
    const [annotationDownloading, setAnnotationDownloading] = useState(false);

    useEffect(() => {
        const applyReconciliation = (detail: SubmissionReceiptReconciledDetail) => {
            if (detail.previousAttemptId !== id && detail.attempt.id !== id) return;
            attemptRef.current = detail.attempt;
            setAttempt(detail.attempt);
            setAttemptSource("server");
            setSubmissionReceipt(detail.receipt);
            setSubmissionRetryFeedback("서버 반영을 확인했습니다.");
            if (detail.attempt.id !== id) {
                router.replace(`/student/review/${detail.attempt.id}`);
            }
        };
        const onReconciled = (event: WindowEventMap[typeof SUBMISSION_RECEIPT_RECONCILED_EVENT]) => {
            applyReconciliation(event.detail);
        };
        const onStorage = (event: StorageEvent) => {
            if (!isSubmissionReceiptStorageKey(event.key)) return;
            const canonicalAttemptId = readReconciledSubmissionAttemptId(id);
            if (canonicalAttemptId) {
                const canonicalAttempt = readLocalAttempts().find(candidate => candidate.id === canonicalAttemptId);
                const canonicalReceipt = readSubmissionReceipt(canonicalAttemptId);
                if (canonicalAttempt && canonicalReceipt) {
                    applyReconciliation({
                        previousAttemptId: id,
                        attempt: canonicalAttempt,
                        receipt: canonicalReceipt,
                    });
                }
                return;
            }
            const refreshedReceipt = readSubmissionReceipt(id);
            if (refreshedReceipt) setSubmissionReceipt(refreshedReceipt);
        };
        window.addEventListener(SUBMISSION_RECEIPT_RECONCILED_EVENT, onReconciled);
        window.addEventListener("storage", onStorage);
        return () => {
            window.removeEventListener(SUBMISSION_RECEIPT_RECONCILED_EVENT, onReconciled);
            window.removeEventListener("storage", onStorage);
        };
    }, [id, router]);
    // Latest attempt for the local Q&A merge path — reading `attempt` state
    // directly in an async handler risks a stale closure dropping a concurrent
    // question. A ref + a submission mutex keep local writes serialized.
    const attemptRef = useRef<Attempt | null>(null);
    const questionSaveInFlightRef = useRef(false);
    useEffect(() => {
        let cancelled = false;
        const loadReview = async () => {
            if (!id || cancelled) return;
            const canonicalAttemptId = readReconciledSubmissionAttemptId(id);
            if (canonicalAttemptId) {
                router.replace(`/student/review/${canonicalAttemptId}`);
                return;
            }
            // Reset the error flag so a retry starts clean.
            setLoadError(false);
            const session = getSession();
            if (!session) {
                setAccessDenied(true);
                return;
            }
            // One signed owner-detail action returns the immutable submitted
            // grading rows plus the exact-id current explanation projection.
            // Digest columns and raw provider rows never cross this Flight edge.
            const detail = await loadStudentOfficialAttempt(id, session);
            const found = detail?.attempt;
            if (found && !cancelled) {
                if (detail.source === "local") {
                    if (!attemptBelongsToSession(found, session)) {
                        setAccessDenied(true);
                        return;
                    }
                }
                attemptRef.current = found;
                setAttempt(found);
                setAttemptSource(detail.source);
                setTrustedReview(detail.source === "server" ? detail.trustedReview || null : null);
                setServerRetakeEligibleQuestionIds(detail.source === "server"
                    ? detail.retakeEligibleQuestionIds || []
                    : []);
                const storedReceipt = readSubmissionReceipt(found.id);
                const nextReceipt = submissionReceiptForAttempt(found, storedReceipt, detail.source);
                try {
                    if (detail.source === "server") await saveLocalServerConfirmedAttempt(found);
                    await persistSubmissionReceipt(nextReceipt);
                } catch (error) {
                    console.warn("Review receipt persistence failed", error);
                    toast.info(
                        "기기 확인 저장 실패",
                        "공식 결과는 서버에 보관되어 있습니다. 브라우저 저장 공간을 확인해주세요.",
                    );
                }
                setSubmissionReceipt(nextReceipt);
                // Attempt-stored notes are authoritative; the legacy local queue
                // only backfills questions never migrated onto the attempt.
                setStudentQuestions({
                    ...readStudentQuestionQueue(found.id),
                    ...pendingStudentQuestionNotesById(found.id),
                    ...studentQuestionsByQuestionId(found),
                });
                const pendingQuestions = readPendingStudentQuestions(found.id);
                if (pendingQuestions.length > 0) {
                    setQuestionDrafts(previous => ({
                        ...previous,
                        ...Object.fromEntries(pendingQuestions.map(question => [question.questionId, question.body])),
                    }));
                    setOpenQuestionBoxes(previous => ({
                        ...previous,
                        ...Object.fromEntries(pendingQuestions.map(question => [question.questionId, true])),
                    }));
                }

                if (session?.studentId) {
                    try {
                        const feedback = await loadStudentReturnedFeedbackForAttempt(found.id, session.studentId);
                        if (feedback && !cancelled) {
                            setReturnedFeedback(feedback);
                            const markup = await loadFeedbackMarkupDrawings(feedback);
                            if (!cancelled && markup) setTeacherMarkupDrawings(markup);
                            void markStudentFeedbackOpened(feedback.id, session.studentId).then(async () => {
                                if (cancelled) return;
                                const refreshed = await loadStudentReturnedFeedbackForAttempt(found.id, session.studentId);
                                if (!cancelled && refreshed) setReturnedFeedback(refreshed);
                            });
                        }
                    } catch {
                        // Feedback is supplemental; keep the official result available.
                    }
                }

                const inlineDrawings = hasDrawings(found.drawings) ? found.drawings : undefined;
                if (inlineDrawings) {
                    setRestoredDrawings(inlineDrawings);
                    setHandwritingUnavailable(false);
                }

                const drawingsRef = found.handwriting?.strokesRef || found.drawingsRef;
                if (drawingsRef) {
                    const drawingsPromise = drawingsRef.store === "remote"
                        ? loadMyAttemptHandwriting(found.id).then(handwriting => (
                            handwriting.status === "ok" && handwriting.signedUrl
                                ? downloadRemoteStudentHandwriting(handwriting.signedUrl)
                                : null
                        ))
                        : loadJsonRecord<PdfDrawings>(drawingsRef);
                    drawingsPromise
                        .then(drawings => {
                            if (cancelled) return;
                            if (drawings) {
                                setRestoredDrawings(drawings);
                                setHandwritingUnavailable(false);
                            } else if (found.drawings) {
                                setRestoredDrawings(found.drawings);
                            } else {
                                setHandwritingUnavailable(true);
                            }
                        })
                        .catch(err => {
                            console.error("Failed to restore submitted handwriting", err);
                            if (!cancelled && found.drawings) setRestoredDrawings(found.drawings);
                            else if (!cancelled) setHandwritingUnavailable(true);
                        });
                } else if (found.drawings) {
                    setRestoredDrawings(found.drawings);
                }

                const parsedExam = detail.exam;
                if (parsedExam && !cancelled) {
                    setExam(parsedExam);
                    setPdfFile(null);
                    setPdfLoadFailed(false);

                    storedDataUrlToFile("problem.pdf", parsedExam.pdfData, parsedExam.pdfDataRef)
                        .then(file => {
                            if (!cancelled && file) setPdfFile(file);
                        })
                        .catch(() => {
                            if (!cancelled) setPdfLoadFailed(true);
                        });
                } else if (!cancelled) {
                    // Attempt loaded but the review exam payload didn't — the page
                    // can't render a result without it. Surface a retryable error
                    // instead of hanging on the loading spinner forever.
                    setLoadError(true);
                }

                // Load the retake's source attempt so the recovery card can
                // compare against it. Pseudo sources ("exam:...", "student:...")
                // and self-references are skipped.
                const sourceId = found.retake?.sourceAttemptId;
                if (sourceId && !sourceId.includes(":") && sourceId !== found.id) {
                    const sourceResult = await loadStudentOfficialAttempt(sourceId, session);
                    if (!cancelled && sourceResult) {
                        const src = sourceResult.attempt;
                        if (sourceResult.source === "server") {
                            setSourceAttempt(src);
                        } else {
                            const session = getSession();
                            if (session && attemptBelongsToSession(src, session)) setSourceAttempt(src);
                        }
                    }
                }
            } else if (!cancelled) {
                setLoadError(true);
            }
        };
        void loadReview();
        return () => { cancelled = true; };
    }, [id, reloadKey, router]);

    if (accessDenied) {
        return (
            <div style={{ padding: '2rem', textAlign: 'center' }}>
                <h2>접근할 수 없는 기록입니다.</h2>
                <p style={{ color: 'var(--muted)', marginTop: '0.5rem' }}>현재 로그인한 학생의 응시 기록만 볼 수 있습니다.</p>
                <Link href="/" className="btn btn-primary" style={{ marginTop: '1rem', display: 'inline-flex' }}>홈으로 돌아가기</Link>
            </div>
        );
    }

    if (loadError) {
        return (
            <div style={{ padding: '2rem', textAlign: 'center' }}>
                <h2>결과를 불러오지 못했습니다.</h2>
                <p style={{ color: 'var(--muted)', marginTop: '0.5rem' }}>네트워크 상태를 확인한 뒤 다시 시도해주세요.</p>
                <div style={{ display: 'inline-flex', gap: '0.5rem', marginTop: '1rem', flexWrap: 'wrap', justifyContent: 'center' }}>
                    <button
                        type="button"
                        onClick={() => setReloadKey(key => key + 1)}
                        className="btn btn-primary"
                    >
                        다시 시도
                    </button>
                    <Link href="/student/history" className="btn btn-secondary">목록으로</Link>
                </div>
            </div>
        );
    }

    if (!attempt || !exam) {
        // Layout-mirroring skeleton: same shell as the loaded report so the
        // real content replaces the placeholders without a layout jump.
        const skeletonBlock = (height: number | string) => (
            <div
                aria-hidden="true"
                className="animate-pulse"
                style={{
                    height,
                    borderRadius: 'var(--radius-lg)',
                    background: 'color-mix(in srgb, var(--muted) 14%, transparent)',
                }}
            />
        );
        return (
            <div className="layout-main student-review-page">
                <span role="status" aria-live="polite" className="sr-only">결과 리포트를 불러오는 중입니다.</span>
                <header className="header">
                    <div className="container header-content">
                        <span style={{ fontWeight: 800 }}>결과 리포트</span>
                    </div>
                </header>
                <main className="container student-review-main">
                    <section className="student-review-shell" aria-hidden="true">
                        <aside className="student-review-summary" style={{ display: 'grid', gap: '0.9rem', alignContent: 'start' }}>
                            {skeletonBlock(170)}
                            {skeletonBlock(64)}
                            {skeletonBlock(210)}
                            {skeletonBlock(130)}
                        </aside>
                        <section className="student-review-content" style={{ display: 'grid', gap: '0.9rem', alignContent: 'start' }}>
                            {skeletonBlock(56)}
                            {skeletonBlock(96)}
                            {skeletonBlock(300)}
                        </section>
                    </section>
                </main>
            </div>
        );
    }

    if (attemptSource === "server" && !trustedReview) {
        return (
            <div style={{ padding: "2rem", textAlign: "center" }}>
                <h2>공식 채점 근거를 확인할 수 없습니다.</h2>
                <p style={{ color: "var(--muted)", marginTop: "0.5rem" }}>결과는 보존되어 있으며, 잠시 후 다시 확인해주세요.</p>
            </div>
        );
    }

    const handleSubmissionRetry = async () => {
        if (!attempt || submissionRetrying) return;
        setSubmissionRetrying(true);
        setSubmissionRetryFeedback("");
        try {
            const result = await retryPendingSubmissionReceipt(attempt.id, {
                submitSignedSessionAttempt: submitAttempt,
                ...(submissionReceipt?.requiresPin && submissionRetryPin.trim()
                    ? { pin: submissionRetryPin.trim() }
                    : {}),
            });
            if (result.status === "confirmed") {
                setSubmissionRetryFeedback("서버 반영을 확인했습니다.");
            } else {
                const nextReceipt = readSubmissionReceipt(attempt.id);
                if (nextReceipt) setSubmissionReceipt(nextReceipt);
                setSubmissionRetryFeedback(result.error);
            }
        } catch {
            setSubmissionRetryFeedback("다시 시도 중 문제가 발생했습니다. 잠시 후 다시 시도해주세요.");
        } finally {
            setSubmissionRetryPin("");
            setSubmissionRetrying(false);
        }
    };

    const reviewModel = attemptSource === "server"
        ? trustedReview!
        : buildLocalStudentReviewModel(exam, attempt);
    const reviewQuestions = reviewModel.questions;
    const reviewExam: Exam = { ...exam, questions: reviewQuestions };
    const gradingResolution = {
        source: reviewModel.gradingSource,
        questionResults: reviewModel.questionResults,
        scoreSummary: reviewModel.scoreSummary,
    };
    const questionResults = reviewModel.questionResults;
    const resultByQuestionId = new Map(questionResults.map(result => [result.questionId, result]));
    const scoreSummary = gradingResolution.scoreSummary;
    const resultCounts = questionResults.reduce((counts, result) => {
        if (result.status === "correct") counts.correctCount += 1;
        if (result.status === "wrong") counts.incorrectCount += 1;
        if (result.status === "unanswered") counts.unansweredCount += 1;
        if (result.status === "ungraded") counts.ungradedCount += 1;
        return counts;
    }, { correctCount: 0, incorrectCount: 0, unansweredCount: 0, ungradedCount: 0 });

    const wrongQuestionIds = new Set(questionResults
        .filter(result => result.status === "wrong" || result.status === "unanswered")
        .map(result => result.questionId));
    const filteredQuestions = filterWrong
        ? reviewQuestions.filter(q => wrongQuestionIds.has(q.id))
        : reviewQuestions;
    const hasHandwriting = hasDrawings(restoredDrawings);
    const hasFeedbackMarkup = hasDrawings(teacherMarkupDrawings);
    const combinedReviewDrawings = mergePdfDrawings(restoredDrawings, teacherMarkupDrawings);
    const canDownloadFeedback = canDownloadReturnedFeedback(returnedFeedback);
    const canDownloadMarkupFile = canDownloadReturnedMarkup(returnedFeedback) && hasDrawings(combinedReviewDrawings);
    const canDownloadAnnotatedPdf = canDownloadMarkupFile && !!pdfFile;
    const visibleFeedbackComments = returnedFeedback?.questionComments.filter(comment => comment.visibility === "student_visible") || [];
    const retakeQuestionIds = attemptSource === "server"
        ? serverRetakeEligibleQuestionIds
        : buildRetakeQuestionIds(reviewExam, attempt);
    const retakeDefinitionUnavailable = attemptSource === "server"
        && serverRetakeEligibleQuestionIds.length === 0
        && questionResults.some(result => result.status === "wrong" || result.status === "unanswered");
    const weaknessGroups = reviewModel.weaknessGroups;
    const recommendationGroups = reviewModel.recommendations;
    const behaviorSummary = reviewModel.behavior;
    const retakeRecovery = attempt.retake && sourceAttempt
        ? buildAttemptRetakeRecovery(exam, attempt, sourceAttempt)
        : null;
    // Original-attempt view: misses that a later retake of THIS attempt fixed.
    const sourceRecovery = !attempt.retake
        ? buildSourceAttemptRecovery(exam, attempt, readLocalAttempts())
        : null;
    const recoveredQuestionIdSet = new Set(sourceRecovery?.recoveredQuestionIds || []);
    const allReviewQuestionIds = reviewQuestions.map(question => question.id);
    // Source score over the SAME scoped question set, so the two percentages compare 1:1.
    const sourceScoreSummary = retakeRecovery && sourceAttempt
        ? summarizeCanonicalQuestionSubset(exam, sourceAttempt, allReviewQuestionIds)
        : null;
    const timingByQuestionId = new Map((attempt.questionTimings || []).map(timing => [timing.questionId, timing]));
    const questionNumberById = new Map(reviewQuestions.map(question => [question.id, question.number]));
    const explainedCount = reviewQuestions.filter(question => question.explanation?.trim()).length;
    const allQuestionNotes = Object.values(studentQuestions);
    const queuedQuestionCount = allQuestionNotes.filter(note => note.status !== "answered").length;
    const answeredQuestionCount = allQuestionNotes.filter(note => note.status === "answered").length;
    const wrongAndUnansweredCount = resultCounts.incorrectCount + resultCounts.unansweredCount;
    const canUseScopedRetakes = supportedReviewRetakeModes(attemptSource).includes("custom");
    const resolveQuestionState = (question: Question) => {
        const result = resultByQuestionId.get(question.id);
        const isLegacyDerived = gradingResolution.source === "legacy_derived_current_exam";
        const userAnswer = result?.selectedAnswer ?? (isLegacyDerived ? attempt.answers[question.id] : undefined);
        const correctAnswer = result?.correctAnswer ?? (isLegacyDerived ? question.answer : undefined);
        const status: QuestionResultStatus = result?.status
            ?? (!isLegacyDerived || correctAnswer === undefined
                ? "ungraded"
                : userAnswer === undefined || userAnswer === null || userAnswer === 0
                    ? "unanswered"
                    : userAnswer === correctAnswer
                        ? "correct"
                        : "wrong");

        return {
            userAnswer,
            correctAnswer,
            status,
            timing: timingByQuestionId.get(question.id),
        };
    };
    const selectedQuestion = filteredQuestions.find(question => question.id === selectedQuestionId)
        || filteredQuestions[0]
        || null;
    const selectedQuestionState = selectedQuestion ? resolveQuestionState(selectedQuestion) : null;
    const formatRetakeNumbers = (questionIds: number[]) => questionIds
        .map(questionId => questionNumberById.get(questionId))
        .filter((questionNumber): questionNumber is number => typeof questionNumber === "number")
        .sort((a, b) => a - b)
        .join(", ");

    const toggleExplanation = (questionId: number) => {
        setOpenExplanations(prev => ({ ...prev, [questionId]: !prev[questionId] }));
    };

    const toggleQuestionBox = (questionId: number) => {
        setOpenQuestionBoxes(prev => ({ ...prev, [questionId]: !prev[questionId] }));
    };

    const updateQuestionDraft = (questionId: number, value: string) => {
        setQuestionDrafts(prev => ({ ...prev, [questionId]: value.slice(0, 500) }));
    };

    /** Jump to the next wrong/unanswered question after the current one (wraps). */
    const goToNextWrongQuestion = () => {
        const orderedIds = filteredQuestions.map(question => question.id);
        const wrongOrdered = orderedIds.filter(questionId => wrongQuestionIds.has(questionId));
        if (wrongOrdered.length === 0) return;
        const currentIndex = selectedQuestion ? orderedIds.indexOf(selectedQuestion.id) : -1;
        const next = wrongOrdered.find(questionId => orderedIds.indexOf(questionId) > currentIndex)
            ?? wrongOrdered[0];
        setSelectedQuestionId(next);
    };

    const moveQuestionTab = (event: ReactKeyboardEvent<HTMLButtonElement>, questionId: number) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        const currentIndex = filteredQuestions.findIndex(question => question.id === questionId);
        if (currentIndex < 0) return;
        event.preventDefault();
        const direction = event.key === "ArrowLeft" ? -1 : 1;
        const nextIndex = (currentIndex + direction + filteredQuestions.length) % filteredQuestions.length;
        if (nextIndex === currentIndex) return;
        const nextQuestion = filteredQuestions[nextIndex];
        setSelectedQuestionId(nextQuestion.id);
        const tabs = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
        tabs?.[nextIndex]?.focus();
    };

    const submitQuestionBody = async (question: Question, rawBody: string) => {
        const body = rawBody.trim();
        if (!body) return false;
        // Serialize submissions: the local merge path reads-then-writes the
        // attempt, so a second submit racing the first would build on a stale
        // copy and drop the earlier note. One in-flight save at a time.
        if (questionSaveInFlightRef.current) {
            toast.info("잠시만요", "이전 질문을 저장하는 중입니다. 잠시 후 다시 시도해주세요.");
            return false;
        }
        const base = attemptRef.current;
        if (!base) return false;
        const input = { questionId: question.id, questionNumber: question.number, body };
        questionSaveInFlightRef.current = true;
        try {
            const queuedAt = new Date().toISOString();
            const ownerStudentId = base.studentId || getSession()?.studentId;
            const queued = await queuePendingStudentQuestion({
                attemptId: base.id,
                ownerStudentId,
                ...input,
                queuedAt,
            });
            if (queued.status !== "queued") {
                toast.error(
                    "질문 저장 실패",
                    queued.status === "capacity_exceeded"
                        ? "전송 대기 질문이 100건에 도달했습니다. 네트워크 연결 후 기존 질문을 전송하고 다시 시도해주세요."
                        : "브라우저 저장소를 확인한 뒤 다시 시도해주세요.",
                );
                return false;
            }

            const localUpdated = upsertStudentQuestion(attemptRef.current || base, input, queuedAt);
            if (!localUpdated) return false;
            const localSaved = await saveLocalAttempt(localUpdated).catch(() => false);
            attemptRef.current = localUpdated;
            setAttempt(localUpdated);
            setStudentQuestions(previous => ({
                ...previous,
                ...pendingStudentQuestionNotesById(base.id),
                ...studentQuestionsByQuestionId(localUpdated),
            }));
            setOpenQuestionBoxes(prev => ({ ...prev, [question.id]: true }));
            if (!localSaved) {
                toast.error(
                    "질문 전송 보류",
                    "질문 재전송 정보는 보관했지만 결과 캐시 저장에 실패했습니다. 저장 공간을 확인한 뒤 다시 눌러주세요.",
                );
                return false;
            }

            const flushed = await flushPendingStudentQuestions(base.id, askAttemptQuestion);
            if (flushed.status !== "sent") {
                toast.error(
                    "질문 전송 보류",
                    "질문 내용은 이 기기에 보관했습니다. 네트워크와 로그인 상태를 확인한 뒤 질문 저장을 다시 눌러주세요.",
                );
                return false;
            }

            const updated: Attempt = {
                ...flushed.attempt,
                studentQuestions: mergeStudentQuestionNotes(
                    localUpdated.studentQuestions,
                    flushed.attempt.studentQuestions,
                ),
            };
            await saveLocalAttempt(updated).catch(() => false);
            attemptRef.current = updated;
            setAttempt(updated);
            setStudentQuestions(previous => ({ ...previous, ...studentQuestionsByQuestionId(updated) }));
            return true;
        } finally {
            questionSaveInFlightRef.current = false;
        }
    };

    const submitStudentQuestion = async (question: Question) => {
        const saved = await submitQuestionBody(question, questionDrafts[question.id] || "");
        if (saved) setQuestionDrafts(prev => ({ ...prev, [question.id]: "" }));
    };

    /** Two-step "please write an explanation" — first click arms, second sends. */
    const requestExplanation = async (question: Question) => {
        if (explanationRequestArmedId !== question.id) {
            setExplanationRequestArmedId(question.id);
            if (explanationRequestTimerRef.current) clearTimeout(explanationRequestTimerRef.current);
            explanationRequestTimerRef.current = setTimeout(() => setExplanationRequestArmedId(null), 5000);
            return;
        }
        if (explanationRequestTimerRef.current) clearTimeout(explanationRequestTimerRef.current);
        setExplanationRequestArmedId(null);
        const saved = await submitQuestionBody(
            question,
            `${question.number}번 해설이 아직 없어요. 풀이 과정을 알려주세요.`,
        );
        if (saved) toast.success("해설 요청 전송됨", "선생님이 답변하면 이 화면에 표시됩니다.");
    };

    const downloadFeedback = () => {
        if (!returnedFeedback || !canDownloadFeedback) return;
        const blob = new Blob([buildFeedbackDownloadText(returnedFeedback)], { type: "text/plain;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `${attempt.examTitle || "omr"}-feedback.txt`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
    };

    const downloadFeedbackMarkup = async () => {
        if (!returnedFeedback || !canDownloadMarkupFile) return;
        setAnnotationDownloading(true);
        try {
            const blob = pdfFile
                ? await buildAnnotatedPdfBlob(pdfFile, combinedReviewDrawings)
                : new Blob(
                    [buildFeedbackMarkupDownloadJson(returnedFeedback, combinedReviewDrawings)],
                    { type: "application/json;charset=utf-8" },
                );
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = pdfFile
                ? `${attempt.examTitle || "omr"}-feedback-annotated.pdf`
                : `${attempt.examTitle || "omr"}-feedback-markup.json`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
        } catch (error) {
            console.error("Failed to download feedback markup", error);
        } finally {
            setAnnotationDownloading(false);
        }
    };

    return (
        <div className="layout-main student-review-page">
            <header className="header student-review-header">
                <div className="container header-content">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', minWidth: 0 }}>
                        <button
                            type="button"
                            onClick={() => router.back()}
                            aria-label="결과 기록으로 돌아가기"
                            title="결과 기록으로 돌아가기"
                            style={{ border: 'none', background: 'none', fontSize: '1rem', cursor: 'pointer', minWidth: '44px', minHeight: '44px' }}
                        >
                            ←
                        </button>
                        <span style={{ fontWeight: 800, whiteSpace: 'nowrap' }}>결과 리포트</span>
                    </div>
                    <div className="student-review-header-actions" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <button
                            type="button"
                            onClick={() => window.print()}
                            className="btn btn-secondary"
                            title="결과 리포트를 인쇄하거나 PDF로 저장합니다"
                            style={{ fontSize: '0.78rem', padding: '0.32rem 0.8rem', display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}
                        >
                            <Printer size={14} />
                            인쇄
                        </button>
                        <Link href="/student/history" className="btn btn-secondary" style={{ fontSize: '0.78rem', padding: '0.32rem 0.8rem' }}>
                            목록으로
                        </Link>
                        <ThemeToggle size="small" />
                    </div>
                </div>
            </header>

            <main className="container animate-fade-in student-review-main">
                <section className="student-review-shell">
                    <aside className="student-review-summary">
                        <section className="bento-card student-review-score-card mobile-section-stack kpi-spring">
                            <div className="student-review-score-copy">
                                <h1>{attempt.examTitle}</h1>
                                <p>{formatKoreanDateTime(attempt.finishedAt)} 응시 완료</p>
                            </div>
                            <div className="student-review-score-row">
                                {/* 채점 완료 모멘트: 점수가 0→최종값으로 차오릅니다. */}
                                <strong><CountUp value={scoreSummary.scorePercent} delayMs={200} /><span>%</span></strong>
                                <div>{scoreSummary.earnedScore} / {scoreSummary.totalScore}점</div>
                            </div>
                            <GradingEvidenceNote source={gradingResolution.source} />
                            <div className="student-review-pill-row">
                                {attempt.handwritingArchived && (
                                    <MetaChip tone="primary">필기 보관 {attempt.questionDrawings?.length || attempt.drawingPageCount || 0}문항</MetaChip>
                                )}
                                {attempt.retake && (
                                    <MetaChip tone="teal">재시험 {attempt.retake.questionIds.length}문항</MetaChip>
                                )}
                            </div>
                            {submissionReceipt && (
                                <div
                                    className="student-review-submission-receipt"
                                    style={{
                                        display: "grid",
                                        gap: "0.45rem",
                                        padding: "0.75rem",
                                        borderRadius: "var(--radius-md)",
                                        border: "1px solid var(--border)",
                                        background: "var(--surface)",
                                    }}
                                >
                                    <span role="status" style={{ fontWeight: 800 }}>
                                        {submissionReceiptLabel(submissionReceipt)}
                                    </span>
                                    {submissionReceipt.status === "pending" && (
                                        <>
                                            {submissionReceipt.actionDetail && (
                                                <p style={{ margin: 0, color: "var(--muted)", fontSize: "var(--type-caption-min)" }}>
                                                    {submissionReceipt.actionDetail}
                                                </p>
                                            )}
                                            {(submissionReceipt.requiresPin || submissionReceipt.prerequisite === "pin") && (
                                                <>
                                                    <p style={{ margin: 0, color: "var(--muted)", fontSize: "var(--type-caption-min)" }}>
                                                        자동 재시도하지 않습니다. 시험 PIN을 입력한 뒤 직접 다시 시도해주세요.
                                                    </p>
                                                    <label style={{ display: "grid", gap: "0.3rem", maxWidth: "16rem" }}>
                                                        <span style={{ fontWeight: 700 }}>시험 PIN</span>
                                                        <input
                                                            type="password"
                                                            value={submissionRetryPin}
                                                            onChange={event => setSubmissionRetryPin(event.target.value)}
                                                            autoComplete="off"
                                                            inputMode="numeric"
                                                        />
                                                    </label>
                                                </>
                                            )}
                                            {submissionReceipt.prerequisite === "login" ? (
                                                <Link href="/" className="btn btn-secondary" style={{ justifySelf: "start" }}>
                                                    학생 로그인으로 이동
                                                </Link>
                                            ) : (
                                                <button
                                                    type="button"
                                                    className="btn btn-secondary"
                                                    onClick={handleSubmissionRetry}
                                                    disabled={submissionRetrying || ((submissionReceipt.requiresPin || submissionReceipt.prerequisite === "pin") && !submissionRetryPin.trim())}
                                                    style={{ justifySelf: "start" }}
                                                >
                                                    {submissionRetrying ? "다시 시도 중…" : "지금 다시 시도"}
                                                </button>
                                            )}
                                        </>
                                    )}
                                    {submissionReceipt.status === "local_only" && (
                                        <p style={{ margin: 0, color: "var(--muted)", fontSize: "var(--type-caption-min)" }}>
                                            {submissionReceipt.actionDetail || "다른 기기에서는 이 결과를 볼 수 없습니다."}
                                        </p>
                                    )}
                                    {submissionRetryFeedback && (
                                        <p aria-live="polite" style={{ margin: 0, color: "var(--muted)", fontSize: "var(--type-caption-min)" }}>
                                            {submissionRetryFeedback}
                                        </p>
                                    )}
                                </div>
                            )}
                            <HandwritingUploadRecoveryCard
                                attemptId={attempt.id}
                        examId={attempt.examId || exam?.id || ""}
                                onRecovered={() => setReloadKey(value => value + 1)}
                            />
                        </section>

                        <section className="student-review-stat-grid" aria-label="채점 요약">
                            <MiniStat label="정답" value={resultCounts.correctCount} color="var(--success)" />
                            <MiniStat label="오답" value={resultCounts.incorrectCount} color="var(--error)" />
                            <MiniStat label="미응답" value={resultCounts.unansweredCount} color="var(--muted)" />
                            {resultCounts.ungradedCount > 0 && (
                                <MiniStat label="미채점" value={resultCounts.ungradedCount} color="var(--muted)" />
                            )}
                        </section>
                    </aside>

                    <section className="student-review-content">
                        {handwritingUnavailable && (
                            <div className="student-review-alert">
                                저장된 필기 정보를 불러오지 못했습니다. 답안과 점수 기록은 정상적으로 보관되어 있습니다.
                            </div>
                        )}

                        <div className={`student-review-workbench ${!hasHandwriting ? "no-pdf" : ""}`}>
                            {hasHandwriting && (
                                <section className="bento-card student-review-pdf-card">
                                    <div className="student-review-card-head">
                                        <div>
                                            <h2>풀이 필기</h2>
                                            <p>{hasFeedbackMarkup ? "제출 당시 필기와 교사 첨삭을 함께 표시합니다." : "제출 당시 필기와 문제지를 표시합니다."}</p>
                                        </div>
                                        <MetaChip>{hasFeedbackMarkup ? "교사 첨삭 포함" : "읽기 전용"}</MetaChip>
                                    </div>
                                    <div className="student-review-pdf-frame">
                                        {pdfFile ? (
                                            <PDFViewer
                                                file={pdfFile}
                                                onLoadSuccess={() => { }}
                                                readOnlyDrawings
                                                drawings={combinedReviewDrawings}
                                            />
                                        ) : (
                                            <div className="student-review-pdf-empty">
                                                {pdfLoadFailed
                                                    ? "문제 PDF를 불러오지 못했습니다. 필기 데이터는 제출 기록에 저장되어 있습니다."
                                                    : "문제 PDF를 불러오는 중입니다..."}
                                            </div>
                                        )}
                                    </div>
                                </section>
                            )}

                            <section className="student-review-question-panel">
                                <div className="student-review-question-toolbar mobile-section-stack">
                                    <div>
                                        <h2>문항 상세</h2>
                                        <p>
                                            번호를 선택하고 해설/질문만 펼쳐봅니다.
                                            <span className="student-review-kbd-hint" aria-hidden="true">
                                                <kbd>←</kbd><kbd>→</kbd> 문항 이동
                                            </span>
                                        </p>
                                    </div>
                                    <div className="student-review-filter-tabs" role="group" aria-label="문항 필터">
                                        <button
                                            type="button"
                                            onClick={() => setFilterWrong(false)}
                                            className={`btn ${!filterWrong ? "btn-primary" : "btn-secondary"}`}
                                            aria-pressed={!filterWrong}
                                        >
                                            전체 {reviewQuestions.length}
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => setFilterWrong(true)}
                                            className={`btn ${filterWrong ? "btn-primary" : "btn-secondary"}`}
                                            aria-pressed={filterWrong}
                                        >
                                            오답 {wrongAndUnansweredCount}
                                        </button>
                                        <button
                                            type="button"
                                            onClick={goToNextWrongQuestion}
                                            disabled={wrongAndUnansweredCount === 0}
                                            className="btn btn-secondary"
                                            title="현재 문항 다음의 오답/미응답 문항으로 이동합니다"
                                        >
                                            다음 오답 →
                                        </button>
                                    </div>
                                </div>

                                {filteredQuestions.length > 0 ? (
                                <div className="student-review-question-dock">
                                    <div className="student-review-question-map" role="tablist" aria-label="문항 바로가기">
                                        {filteredQuestions.map(question => {
                                            const { status } = resolveQuestionState(question);
                                            const isActive = question.id === selectedQuestion?.id;

                                            return (
                                                <button
                                                    key={question.id}
                                                    type="button"
                                                    onClick={() => setSelectedQuestionId(question.id)}
                                                    onKeyDown={(event) => moveQuestionTab(event, question.id)}
                                                    className={`student-review-question-dot is-${status} ${isActive ? "is-active" : ""}`}
                                                    id={`student-review-question-tab-${question.id}`}
                                                    role="tab"
                                                    aria-label={`문항 ${question.number} ${questionStatusLabel(status)}`}
                                                    aria-selected={isActive}
                                                    aria-controls="student-review-question-panel"
                                                    tabIndex={isActive ? 0 : -1}
                                                    title={`문항 ${question.number} ${questionStatusLabel(status)}`}
                                                >
                                                    <span>{question.number}</span>
                                                    <i aria-hidden="true" />
                                                </button>
                                            );
                                        })}
                                    </div>

                                    {selectedQuestion && selectedQuestionState && (
                                        <div
                                            id="student-review-question-panel"
                                            role="tabpanel"
                                            aria-labelledby={`student-review-question-tab-${selectedQuestion.id}`}
                                        >
                                            <QuestionCard
                                                key={selectedQuestion.id}
                                                question={selectedQuestion}
                                                userAnswer={selectedQuestionState.userAnswer}
                                                correctAnswer={selectedQuestionState.correctAnswer}
                                                status={selectedQuestionState.status}
                                                recovered={recoveredQuestionIdSet.has(selectedQuestion.id)}
                                                timing={selectedQuestionState.timing}
                                                explanationOpen={!!openExplanations[selectedQuestion.id]}
                                                questionBoxOpen={!!openQuestionBoxes[selectedQuestion.id]}
                                                draft={questionDrafts[selectedQuestion.id] || ""}
                                                submittedQuestion={studentQuestions[selectedQuestion.id]}
                                                subQuestionAnswers={attempt.subQuestionAnswers?.[selectedQuestion.id]}
                                                retakeHref={canUseScopedRetakes ? buildRetakeHref(attempt.examId, attempt.id, [selectedQuestion.id], "custom") : null}
                                                explanationRequestArmed={explanationRequestArmedId === selectedQuestion.id}
                                                onToggleExplanation={() => toggleExplanation(selectedQuestion.id)}
                                                onToggleQuestionBox={() => toggleQuestionBox(selectedQuestion.id)}
                                                onDraftChange={(value) => updateQuestionDraft(selectedQuestion.id, value)}
                                                onSubmitQuestion={() => submitStudentQuestion(selectedQuestion)}
                                                onRequestExplanation={() => requestExplanation(selectedQuestion)}
                                            />
                                        </div>
                                    )}
                                </div>
                                ) : (
                                    // F8: an empty filtered set (all-correct with the wrong
                                    // filter on, or a stale retake questionId set) now always
                                    // shows a message instead of a blank panel.
                                    <div className="student-review-empty">
                                        {filterWrong ? "틀린 문제가 없습니다!" : "표시할 문항이 없습니다."}
                                    </div>
                                )}
                            </section>
                        </div>
                    </section>

                    <aside className="student-review-secondary">
                        <section className="bento-card student-review-side-card student-review-next-action mobile-section-stack kpi-spring" style={{ animationDelay: '90ms' }}>
                            <div className="student-review-section-title">
                                <Target size={17} />
                                <strong>오답 재시험</strong>
                            </div>
                            <p>이번 시험에서 틀린 문항을 바로 다시 풉니다.</p>
                            {sourceRecovery && sourceRecovery.recoveredQuestionIds.length > 0 && (
                                <p className="student-review-success-note" style={{ marginBottom: '0.6rem' }}>
                                    이미 재시험으로 {sourceRecovery.recoveredQuestionIds.length}문항을 회복했어요.
                                    {sourceRecovery.unrecoveredQuestionIds.length > 0
                                        ? ` 남은 오답은 ${sourceRecovery.unrecoveredQuestionIds.length}문항입니다.`
                                        : ' 모든 오답을 회복했습니다.'}
                                </p>
                            )}
                            <div className="student-review-side-actions mobile-action-row">
                                {retakeQuestionIds.length > 0 ? (
                                    <Link href={buildRetakeHref(attempt.examId, attempt.id, retakeQuestionIds, "wrong")} className="btn btn-primary student-review-full-button">
                                        <Repeat2 size={15} />
                                        오답만
                                    </Link>
                                ) : retakeDefinitionUnavailable ? (
                                    <span role="status" className="student-review-muted-note">
                                        제출 당시 문항 정의가 현재 시험과 달라 자동 재시험을 만들 수 없습니다.
                                    </span>
                                ) : (
                                    <span className="student-review-success-note">재시험할 오답이 없습니다</span>
                                )}
                                {canUseScopedRetakes ? (
                                    <Link href={buildRetakeHref(attempt.examId, attempt.id, allReviewQuestionIds, "custom")} className="btn btn-secondary student-review-full-button">
                                        전체
                                    </Link>
                                ) : (
                                    <span className="student-review-success-note">운영 기록은 서버가 검증한 오답 전체 재시험만 지원합니다.</span>
                                )}
                            </div>

                            {canUseScopedRetakes && recommendationGroups.length > 0 && (
                                <div className="student-review-recommendations">
                                    <div className="student-review-recommendation-head">
                                        <span>유형 큐</span>
                                        <strong>{recommendationGroups.length}개 유형</strong>
                                    </div>
                                    {recommendationGroups.map(group => {
                                        const retakeIds = group.retakeQuestionIds;
                                        const retakeNumbers = formatRetakeNumbers(retakeIds);
                                        return (
                                            <Link
                                                key={group.key}
                                                href={buildRetakeHref(attempt.examId, group.sourceAttemptId, retakeIds, group.retakeMode, {
                                                    labels: group.retakeLabels,
                                                    concepts: group.retakeConcepts,
                                                })}
                                                className="student-review-recommendation-row"
                                            >
                                                <span>{group.title}</span>
                                                <small>
                                                    {retakeNumbers || group.questionNumbers.join(", ")}번 · {group.wrongCount > 0
                                                        ? `오답 ${group.wrongCount}/${group.totalCount}`
                                                        : `시간 지연 ${group.slowCorrectCount}문항`}
                                                </small>
                                            </Link>
                                        );
                                    })}
                                </div>
                            )}

                            {canUseScopedRetakes && recommendationGroups.length === 0 && weaknessGroups.length > 0 && (
                                <div className="student-review-recommendations">
                                    {weaknessGroups.map(group => (
                                        <Link
                                            key={group.key}
                                            href={buildRetakeHref(attempt.examId, attempt.id, group.questionIds, "similar", {
                                                labels: group.labels,
                                                concepts: group.concepts,
                                            })}
                                            className="student-review-recommendation-row"
                                        >
                                            <span>{group.title}</span>
                                            <small>{group.questionNumbers.join(", ")}번 · 오답률 {group.wrongRate}%</small>
                                        </Link>
                                    ))}
                                </div>
                            )}
                        </section>

                        {returnedFeedback && (
                            <section className="bento-card student-review-side-card student-review-feedback-card kpi-spring" style={{ animationDelay: '90ms' }} aria-labelledby="student-feedback-title">
                                <div className="student-review-card-head">
                                    <div>
                                        <div className="student-review-section-title">
                                            <MessageSquare size={17} />
                                            <strong id="student-feedback-title">교사 피드백</strong>
                                        </div>
                                        {returnedFeedback.summary && (
                                            <p className="student-review-long-copy" style={{ whiteSpace: "pre-wrap" }}>{returnedFeedback.summary}</p>
                                        )}
                                    </div>
                                    <MetaChip tone="primary">새 피드백</MetaChip>
                                </div>

                                {visibleFeedbackComments.length > 0 && (
                                    <div style={{ display: "grid", gap: "0.45rem" }}>
                                        {visibleFeedbackComments.map((comment) => (
                                            <div
                                                key={comment.id}
                                                style={{
                                                    padding: "0.65rem",
                                                    borderRadius: "var(--radius-md)",
                                                    background: "var(--surface)",
                                                    border: "1px solid var(--border)",
                                                    lineHeight: 1.55,
                                                }}
                                            >
                                                <strong style={{ marginRight: "0.4rem" }}>{comment.questionNumber}번</strong>
                                                <span>{comment.body}</span>
                                            </div>
                                        ))}
                                    </div>
                                )}

                                <div className="student-review-side-actions mobile-action-row">
                                    {canDownloadFeedback ? (
                                        <button
                                            type="button"
                                            onClick={downloadFeedback}
                                            className="btn btn-secondary student-review-full-button"
                                        >
                                            <FileText size={15} />
                                            피드백 저장
                                        </button>
                                    ) : (
                                        <span className="student-review-success-note">다운로드 제한</span>
                                    )}
                                    {canDownloadMarkupFile && (
                                        <button
                                            type="button"
                                            onClick={() => void downloadFeedbackMarkup()}
                                            disabled={annotationDownloading}
                                            className="btn btn-secondary student-review-full-button"
                                        >
                                            <Download size={15} />
                                            {annotationDownloading ? "생성 중" : canDownloadAnnotatedPdf ? "첨삭 PDF 저장" : "첨삭 파일 저장"}
                                        </button>
                                    )}
                                </div>
                            </section>
                        )}

                        {retakeRecovery && (
                            <section
                                className="bento-card student-review-side-card kpi-spring"
                                style={{
                                    animationDelay: '160ms',
                                    ...(retakeRecovery.recoveredCount > 0 ? {
                                        background: 'linear-gradient(135deg, rgba(34, 197, 94, 0.07) 0%, rgba(99, 102, 241, 0.05) 100%)',
                                        borderColor: 'rgba(34, 197, 94, 0.35)',
                                    } : {})
                                }}
                            >
                                <div className="student-review-section-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.4rem' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                        <TrendingUp size={16} color={retakeRecovery.recoveredCount > 0 ? 'var(--success)' : undefined} />
                                        <strong>재시험 회복</strong>
                                    </div>
                                    {sourceScoreSummary && (scoreSummary.scorePercent ?? 0) > (sourceScoreSummary.scorePercent ?? 0) && (
                                        <span style={{
                                            fontSize: '0.76rem',
                                            padding: '0.15rem 0.5rem',
                                            borderRadius: '9999px',
                                            background: 'var(--success-soft, rgba(34, 197, 94, 0.15))',
                                            color: 'var(--success-text, #15803d)',
                                            fontWeight: 700,
                                        }}>
                                            +{((scoreSummary.scorePercent ?? 0) - (sourceScoreSummary.scorePercent ?? 0))}%p 회복 성공! 🚀
                                        </span>
                                    )}
                                </div>
                                <p>
                                    {retakeRecovery.targetCount > 0
                                        ? `원시험에서 틀린 ${retakeRecovery.targetCount}문항 중 ${retakeRecovery.recoveredCount}문항을 이번에 맞혔어요.`
                                        : "이번 범위에는 원시험에서 틀린 문항이 없었습니다."}
                                </p>
                                <div className="student-review-behavior-grid">
                                    <MiniStat
                                        label="회복"
                                        value={retakeRecovery.recoveryRate !== undefined
                                            ? `${retakeRecovery.recoveredCount}/${retakeRecovery.targetCount} (${retakeRecovery.recoveryRate}%)`
                                            : "대상 없음"}
                                        color="var(--success)"
                                    />
                                    <MiniStat
                                        label="점수 변화"
                                        value={sourceScoreSummary
                                            ? `${sourceScoreSummary.scorePercent}% → ${scoreSummary.scorePercent}%`
                                            : "-"}
                                        color="#4f46e5"
                                    />
                                    {retakeRecovery.regressedCount > 0 && (
                                        <MiniStat label="다시 틀림" value={`${retakeRecovery.regressedCount}문항`} color="var(--error)" />
                                    )}
                                </div>
                            </section>
                        )}


                        {(attempt.questionTimings?.length || behaviorSummary.focusLossCount > 0) && (
                            <details className="bento-card student-review-side-card student-review-detail-disclosure kpi-spring" style={{ animationDelay: '300ms' }}>
                                <summary className="student-review-section-title">
                                    <Clock size={16} />
                                    <strong>풀이 행동</strong>
                                </summary>
                                <div className="student-review-behavior-grid">
                                    <MiniStat label="추적" value={formatSeconds(behaviorSummary.totalTrackedTimeSec)} color="var(--foreground)" />
                                    <MiniStat label="평균" value={formatSeconds(behaviorSummary.averageTimeSec)} color="var(--foreground)" />
                                    <MiniStat label="재방문" value={behaviorSummary.revisitedQuestionNumbers.length ? `${behaviorSummary.revisitedQuestionNumbers.join(", ")}번` : "없음"} color="var(--foreground)" />
                                    {behaviorSummary.focusLossCount > 0 && (
                                        <span
                                            className="away-severity-badge"
                                            data-away-severity={awaySeverity(behaviorSummary.focusLossCount)}
                                        >
                                            시험 중 화면을 벗어난 기록 {behaviorSummary.focusLossCount}회
                                        </span>
                                    )}
                                </div>
                            </details>
                        )}

                        <details className="bento-card student-review-side-card student-review-detail-disclosure kpi-spring" style={{ animationDelay: '370ms' }} aria-label="학생 질문/해설 지원">
                            <summary className="student-review-section-title">
                                <HelpCircle size={16} />
                                <strong>질문/해설</strong>
                            </summary>
                            <p>궁금한 문항은 대기 목록에 보관됩니다.</p>
                            <div className="student-review-support-grid">
                                <MiniStat label="해설" value={`${explainedCount}/${reviewQuestions.length}`} color="#4f46e5" />
                                <MiniStat label="질문 대기" value={queuedQuestionCount} color="#0f766e" />
                                {answeredQuestionCount > 0 && (
                                    <MiniStat label="답변 완료" value={answeredQuestionCount} color="#4f46e5" />
                                )}
                            </div>
                        </details>
                    </aside>

                </section>
            </main>
        </div>
    );
}
