"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
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
import { loadAttempt, loadExam, saveAttempt, saveLocalAttempt } from "@/lib/omrPersistence";
import { askAttemptQuestion, loadExamForReview, loadMyAttempt } from "@/app/actions/studentExam";
import { loadMyAttemptClient, loadReviewExamClient } from "@/lib/studentExamClient";
import { stripTeacherOnlySubQuestionFields } from "@/lib/examSolvePayload";
import { studentQuestionsByQuestionId, upsertStudentQuestion } from "@/lib/studentQuestions";
import { buildAttemptRetakeRecovery } from "@/lib/retakeRecovery";
import { toast } from "@/components/Toast";
import ThemeToggle from "@/components/ThemeToggle";
import { formatKoreanDateTime } from "@/lib/pure";
import { safeScorePercent } from "@/lib/scoreUtils";
import {
    buildLearningRecommendations,
    buildRetakeQuestionIds,
    buildStudentWeaknessGroups,
    getAttemptQuestionResults,
    summarizeAttemptScore,
    summarizeAttemptBehavior,
} from "@/lib/premiumAnalytics";
import { buildRetakeHref } from "@/lib/retakeLinks";
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

const PDFViewer = dynamic(() => import("@/components/PDFViewer"), { ssr: false });

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
            <strong style={{ color }}>{value}</strong>
        </div>
    );
}

function StatusChip({ status }: { status: QuestionResultStatus }) {
    const copy = status === "correct"
        ? { label: "정답", color: "#15803d", background: "#dcfce7", border: "#bbf7d0" }
        : status === "wrong"
            ? { label: "오답", color: "#dc2626", background: "#fef2f2", border: "#fecaca" }
            : status === "unanswered"
                ? { label: "미응답", color: "#475569", background: "#f1f5f9", border: "#e2e8f0" }
                : { label: "미채점", color: "#64748b", background: "#f8fafc", border: "#e2e8f0" };

    return (
        <span
            className="student-review-status-chip"
            style={{ color: copy.color, background: copy.background, borderColor: copy.border }}
        >
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
    const palette = {
        neutral: { color: "#64748b", background: "#f8fafc", border: "#e2e8f0" },
        primary: { color: "#4f46e5", background: "#eef2ff", border: "#c7d2fe" },
        teal: { color: "#0f766e", background: "#f0fdfa", border: "#99f6e4" },
        amber: { color: "#9a3412", background: "#fff7ed", border: "#fed7aa" },
    }[tone];

    return (
        <span className="student-review-meta-chip" style={{ color: palette.color, background: palette.background, borderColor: palette.border }}>
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
    timing?: QuestionTiming;
    explanationOpen: boolean;
    questionBoxOpen: boolean;
    draft: string;
    submittedQuestion?: StudentQuestionNote;
    subQuestionAnswers?: NonNullable<Attempt["subQuestionAnswers"]>[number];
    retakeHref: string;
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

            {(question.label || question.tags?.concept || question.tags?.source || timing) && (
                <div className="student-review-meta-row">
                    {question.label && <MetaChip>#{question.label}</MetaChip>}
                    {question.tags?.concept && <MetaChip tone="primary">{question.tags.concept}</MetaChip>}
                    {question.tags?.source && <MetaChip tone="teal">{question.tags.source}</MetaChip>}
                    {timing && <MetaChip tone="amber">{formatSeconds(timing.totalTimeSec)} · 방문 {timing.visitCount}회</MetaChip>}
                </div>
            )}

            <div className="student-review-question-actions">
                <Link href={retakeHref} className="btn btn-secondary student-review-compact-button">
                    <FileText size={13} />
                    다시 풀기
                </Link>
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
                        title="선생님께 이 문항의 해설 작성을 요청합니다"
                    >
                        <HelpCircle size={14} />
                        해설 요청
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
                <div className="student-review-explanation">
                    {question.explanation}
                </div>
            )}

            {!!question.subQuestions?.length && (
                <div style={{ marginTop: '0.75rem', padding: '0.75rem', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', background: 'var(--background)', display: 'grid', gap: '0.6rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', alignItems: 'center' }}>
                        <strong style={{ fontSize: '0.8rem' }}>내 심화 응답</strong>
                        <span style={{ fontSize: '0.68rem', color: 'var(--muted)' }}>점수 미반영</span>
                    </div>
                    {question.subQuestions.map((subQuestion, index) => {
                        const answer = subQuestionAnswers?.[subQuestion.id];
                        return (
                            <div key={subQuestion.id} style={{ display: 'grid', gap: '0.25rem' }}>
                                <span style={{ color: 'var(--muted)', fontSize: '0.72rem', fontWeight: 800 }}>{String.fromCharCode(65 + index)}. {subQuestion.prompt}</span>
                                <div style={{ whiteSpace: 'pre-wrap', fontSize: '0.82rem', lineHeight: 1.55, color: answer ? 'var(--foreground)' : 'var(--muted)' }}>{answer?.body || '작성하지 않음'}</div>
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
                        <div style={{
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
                        <div style={{
                            padding: '0.7rem 0.8rem',
                            borderRadius: 'var(--radius-md)',
                            border: '1px solid color-mix(in srgb, var(--success) 45%, var(--border))',
                            background: 'color-mix(in srgb, var(--success) 10%, var(--surface))',
                            marginBottom: '0.65rem',
                        }}>
                            <div style={{
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
                            <div style={{ color: 'var(--foreground)', fontSize: '0.85rem', lineHeight: 1.65, whiteSpace: 'pre-wrap' }}>
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
    const [exam, setExam] = useState<Exam | null>(null);
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
    const [returnedFeedback, setReturnedFeedback] = useState<AttemptFeedback | null>(null);
    const [teacherMarkupDrawings, setTeacherMarkupDrawings] = useState<PdfDrawings | undefined>(undefined);
    const [annotationDownloading, setAnnotationDownloading] = useState(false);
    // Latest attempt for the local Q&A merge path — reading `attempt` state
    // directly in an async handler risks a stale closure dropping a concurrent
    // question. A ref + a submission mutex keep local writes serialized.
    const attemptRef = useRef<Attempt | null>(null);
    const questionSaveInFlightRef = useRef(false);
    // Latest question-navigation state for the keyboard handler. Updated during
    // render (below, once filteredQuestions/selectedQuestion exist) so the
    // window-level listener always sees the current, filter-aware list without
    // re-subscribing on every render.
    const navStateRef = useRef<{ ids: number[]; selectedId: number | null }>({ ids: [], selectedId: null });

    // D2: ←/→ move the selected question through the (possibly wrong-filtered)
    // list. Clamped at both ends — no wrap — so the arrows have a clear "start"
    // and "end". Ignored while a text field is focused so arrows still move the
    // caret inside the question textarea.
    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            if (event.altKey || event.ctrlKey || event.metaKey) return;
            const target = event.target as HTMLElement | null;
            const tag = target?.tagName;
            if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;
            const { ids, selectedId } = navStateRef.current;
            if (ids.length === 0) return;
            const currentIndex = selectedId != null ? ids.indexOf(selectedId) : 0;
            const baseIndex = currentIndex < 0 ? 0 : currentIndex;
            const nextIndex = event.key === "ArrowLeft"
                ? Math.max(0, baseIndex - 1)
                : Math.min(ids.length - 1, baseIndex + 1);
            if (nextIndex === baseIndex) return;
            event.preventDefault();
            setSelectedQuestionId(ids[nextIndex]);
        };
        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, []);

    useEffect(() => {
        let cancelled = false;
        const loadReview = async () => {
            if (!id || cancelled) return;
            // Reset the error flag so a retry starts clean.
            setLoadError(false);
            // Server-first: the action returns the attempt only when the signed
            // session cookie owns it. Device-local records fall back to the
            // existing client-side ownership check.
            const result = await loadMyAttemptClient(id, {
                server: (attemptId) => loadMyAttempt(attemptId),
                localFallback: (attemptId) => loadAttempt(attemptId),
            });
            const found = result.status === "ok" ? result.attempt : undefined;
            if (found && !cancelled) {
                const session = getSession();
                if (result.source === "local") {
                    if (!session || !attemptBelongsToSession(found, session)) {
                        setAccessDenied(true);
                        return;
                    }
                }
                attemptRef.current = found;
                setAttempt(found);
                // Attempt-stored notes are authoritative; the legacy local queue
                // only backfills questions never migrated onto the attempt.
                setStudentQuestions({
                    ...readStudentQuestionQueue(found.id),
                    ...studentQuestionsByQuestionId(found),
                });

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
                    loadJsonRecord<PdfDrawings>(drawingsRef)
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
                            console.error("Failed to restore drawings from IndexedDB", err);
                            if (!cancelled && found.drawings) setRestoredDrawings(found.drawings);
                            else if (!cancelled) setHandwritingUnavailable(true);
                        });
                } else if (found.drawings) {
                    setRestoredDrawings(found.drawings);
                }

                // Server-first review payload: answers/explanations included
                // (post-submit), PIN and answer-key PDF withheld server-side.
                const examResult = await loadReviewExamClient(found.id, {
                    server: (attemptId) => loadExamForReview(attemptId),
                    localFallback: async () => {
                        const localExam = await loadExam(found.examId);
                        return localExam ? stripTeacherOnlySubQuestionFields(localExam) : null;
                    },
                });
                const parsedExam = examResult.status === "ok" ? examResult.exam ?? null : null;
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
                    const sourceResult = await loadMyAttemptClient(sourceId, {
                        server: (attemptId) => loadMyAttempt(attemptId),
                        localFallback: (attemptId) => loadAttempt(attemptId),
                    });
                    if (!cancelled && sourceResult.status === "ok" && sourceResult.attempt) {
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
                // No attempt: distinguish an ownership denial from a load
                // failure so the student sees the right screen (and a retry).
                if (result.status === "denied") setAccessDenied(true);
                else setLoadError(true);
            }
        };
        void loadReview();
        return () => { cancelled = true; };
    }, [id, reloadKey]);

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
        return <div role="status" aria-live="polite" style={{ padding: '2rem', textAlign: 'center', color: 'var(--muted)' }}>결과 리포트를 불러오는 중입니다.</div>;
    }

    const reviewQuestionIds = attempt.retake?.questionIds?.length
        ? new Set(attempt.retake.questionIds)
        : null;
    const reviewQuestions = reviewQuestionIds
        ? exam.questions.filter(q => reviewQuestionIds.has(q.id))
        : exam.questions;
    const reviewExam: Exam = { ...exam, questions: reviewQuestions };
    const questionResults = getAttemptQuestionResults(reviewExam, attempt);
    const resultByQuestionId = new Map(questionResults.map(result => [result.questionId, result]));
    const scoreSummary = summarizeAttemptScore(reviewExam, attempt);
    // F6: getAttemptQuestionResults recomputes each question's status from the
    // LIVE exam, so a teacher editing the answer key after submission can shift
    // the review percent away from the score stored at submission time. Detect
    // that divergence so the report can flag "재채점됨" with the original score.
    const storedScorePercent = safeScorePercent(attempt.score, attempt.totalScore);
    const storedEarnedScore = Math.round((attempt.score || 0) * 100) / 100;
    const scoreRegraded = Number.isFinite(attempt.totalScore)
        && attempt.totalScore > 0
        && scoreSummary.scorePercent !== storedScorePercent;
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
    const retakeQuestionIds = buildRetakeQuestionIds(reviewExam, attempt);
    const weaknessGroups = buildStudentWeaknessGroups(reviewExam, attempt).slice(0, 3);
    const recommendationGroups = buildLearningRecommendations(reviewExam, [attempt], {
        scope: "attempt",
        attempt,
        // Show the student their own "정답이지만 느린" unstable concepts too.
        includeSlowCorrect: true,
        limit: 5,
    });
    const behaviorSummary = summarizeAttemptBehavior(attempt);
    const retakeRecovery = attempt.retake && sourceAttempt
        ? buildAttemptRetakeRecovery(exam, attempt, sourceAttempt)
        : null;
    // Source score over the SAME scoped question set, so the two percentages compare 1:1.
    const sourceScoreSummary = retakeRecovery && sourceAttempt
        ? summarizeAttemptScore(reviewExam, sourceAttempt)
        : null;
    const timingByQuestionId = new Map((attempt.questionTimings || []).map(timing => [timing.questionId, timing]));
    const questionNumberById = new Map(reviewQuestions.map(question => [question.id, question.number]));
    const allReviewQuestionIds = reviewQuestions.map(question => question.id);
    const explainedCount = reviewQuestions.filter(question => question.explanation?.trim()).length;
    const allQuestionNotes = Object.values(studentQuestions);
    const queuedQuestionCount = allQuestionNotes.filter(note => note.status !== "answered").length;
    const answeredQuestionCount = allQuestionNotes.filter(note => note.status === "answered").length;
    const wrongAndUnansweredCount = resultCounts.incorrectCount + resultCounts.unansweredCount;
    const resolveQuestionState = (question: Question) => {
        const result = resultByQuestionId.get(question.id);
        const userAnswer = result?.selectedAnswer ?? attempt.answers[question.id];
        const correctAnswer = result?.correctAnswer ?? question.answer;
        const status: QuestionResultStatus = result?.status
            ?? (correctAnswer === undefined
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
    // Keep the keyboard-nav handler in sync with the current filtered list and
    // effective selection (D2). Assigning a ref during render is safe — no state
    // update, just the "latest value" pattern.
    navStateRef.current = {
        ids: filteredQuestions.map(question => question.id),
        selectedId: selectedQuestion?.id ?? null,
    };
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
            // Server-first: the action verifies ownership via the session cookie
            // and merges the note into the attempt row server-side.
            let updated: Attempt | null = null;
            try {
                const res = await askAttemptQuestion(base.id, input);
                if (res.status === "ok" && res.attempt) updated = res.attempt;
            } catch {
                // offline/dev — fall back to the local attempt write below
            }
            if (updated) {
                // F7: the server row can be missing notes queued offline on this
                // device (not yet synced). Union the freshest local notes with the
                // server copy — server wins on conflict — so submitting online never
                // drops a locally-queued question.
                updated = {
                    ...updated,
                    studentQuestions: mergeStudentQuestionNotes(
                        attemptRef.current?.studentQuestions,
                        updated.studentQuestions,
                    ),
                };
                try { saveLocalAttempt(updated); } catch { /* quota — server copy is canonical */ }
            } else {
                // Merge onto the freshest local attempt (ref, not stale closure).
                updated = upsertStudentQuestion(attemptRef.current || base, input, new Date().toISOString());
                if (!updated) return false;
                const result = await saveAttempt(updated).catch(() => null);
                if (!result?.localSaved) {
                    toast.error("질문 저장 실패", "브라우저 저장소를 확인한 뒤 다시 시도해주세요.");
                    return false;
                }
            }

            attemptRef.current = updated;
            setAttempt(updated);
            setStudentQuestions(prev => ({ ...prev, ...studentQuestionsByQuestionId(updated) }));
            setOpenQuestionBoxes(prev => ({ ...prev, [question.id]: true }));
            return true;
        } finally {
            questionSaveInFlightRef.current = false;
        }
    };

    const submitStudentQuestion = async (question: Question) => {
        const saved = await submitQuestionBody(question, questionDrafts[question.id] || "");
        if (saved) setQuestionDrafts(prev => ({ ...prev, [question.id]: "" }));
    };

    /** One-click "please write an explanation" — reuses the Q&A channel. */
    const requestExplanation = async (question: Question) => {
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
            <header className="header">
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
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
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
                    <aside className="student-review-sidebar">
                        <section className="bento-card student-review-score-card">
                            <div className="student-review-score-copy">
                                <h1>{attempt.examTitle}</h1>
                                <p>{formatKoreanDateTime(attempt.finishedAt)} 응시 완료</p>
                            </div>
                            <div className="student-review-score-row">
                                <strong>{scoreSummary.scorePercent}<span>%</span></strong>
                                <div>{scoreSummary.earnedScore} / {scoreSummary.totalScore}점</div>
                            </div>
                            {scoreRegraded && (
                                <div
                                    className="student-review-regrade-badge"
                                    style={{
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        gap: '0.3rem',
                                        alignSelf: 'flex-start',
                                        padding: '0.3rem 0.55rem',
                                        borderRadius: 'var(--radius-full)',
                                        border: '1px solid var(--warning)',
                                        background: 'color-mix(in srgb, var(--warning) 14%, transparent)',
                                        color: 'var(--warning)',
                                        fontSize: '0.68rem',
                                        fontWeight: 800,
                                        lineHeight: 1.35,
                                    }}
                                    title={`제출 당시 점수는 ${storedEarnedScore}점(${storedScorePercent}%)이었습니다. 현재 정답 기준으로 다시 채점된 점수를 표시합니다.`}
                                >
                                    현재 정답 기준 재채점됨 · 제출 당시 {storedEarnedScore}점 ({storedScorePercent}%)
                                </div>
                            )}
                            <div className="student-review-pill-row">
                                {attempt.handwritingArchived && (
                                    <MetaChip tone="primary">필기 보관 {attempt.questionDrawings?.length || attempt.drawingPageCount || 0}문항</MetaChip>
                                )}
                                {attempt.retake && (
                                    <MetaChip tone="teal">재시험 {attempt.retake.questionIds.length}문항</MetaChip>
                                )}
                            </div>
                        </section>

                        {returnedFeedback && (
                            <section className="bento-card student-review-side-card" aria-labelledby="student-feedback-title">
                                <div className="student-review-card-head">
                                    <div>
                                        <div className="student-review-section-title">
                                            <MessageSquare size={17} />
                                            <strong id="student-feedback-title">교사 피드백</strong>
                                        </div>
                                        {returnedFeedback.summary && (
                                            <p style={{ whiteSpace: "pre-wrap" }}>{returnedFeedback.summary}</p>
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
                                                    background: "var(--surface-elevated)",
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

                                <div className="student-review-side-actions">
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

                        <section className="student-review-stat-grid" aria-label="채점 요약">
                            <MiniStat label="정답" value={resultCounts.correctCount} color="var(--success)" />
                            <MiniStat label="오답" value={resultCounts.incorrectCount} color="var(--error)" />
                            <MiniStat label="미응답" value={resultCounts.unansweredCount} color="var(--muted)" />
                            {resultCounts.ungradedCount > 0 && (
                                <MiniStat label="미채점" value={resultCounts.ungradedCount} color="var(--muted)" />
                            )}
                        </section>

                        {retakeRecovery && (
                            <section className="bento-card student-review-side-card">
                                <div className="student-review-section-title">
                                    <TrendingUp size={16} />
                                    <strong>재시험 회복</strong>
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

                        <section className="bento-card student-review-side-card">
                            <div className="student-review-section-title">
                                <Target size={17} />
                                <strong>오답 재시험</strong>
                            </div>
                            <p>오답과 같은 유형을 바로 다시 풉니다.</p>
                            <div className="student-review-side-actions">
                                {retakeQuestionIds.length > 0 ? (
                                    <Link href={buildRetakeHref(attempt.examId, attempt.id, retakeQuestionIds, "wrong")} className="btn btn-primary student-review-full-button">
                                        <Repeat2 size={15} />
                                        오답만
                                    </Link>
                                ) : (
                                    <span className="student-review-success-note">재시험할 오답이 없습니다</span>
                                )}
                                <Link href={buildRetakeHref(attempt.examId, attempt.id, allReviewQuestionIds, "custom")} className="btn btn-secondary student-review-full-button">
                                    전체
                                </Link>
                            </div>

                            {recommendationGroups.length > 0 && (
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

                            {recommendationGroups.length === 0 && weaknessGroups.length > 0 && (
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

                        {(attempt.questionTimings?.length || behaviorSummary.focusLossCount > 0) && (
                            <section className="bento-card student-review-side-card">
                                <div className="student-review-section-title">
                                    <Clock size={16} />
                                    <strong>풀이 행동</strong>
                                </div>
                                <div className="student-review-behavior-grid">
                                    <MiniStat label="추적" value={formatSeconds(behaviorSummary.totalTrackedTimeSec)} color="var(--foreground)" />
                                    <MiniStat label="평균" value={formatSeconds(behaviorSummary.averageTimeSec)} color="var(--foreground)" />
                                    <MiniStat label="재방문" value={behaviorSummary.revisitedQuestionNumbers.length ? `${behaviorSummary.revisitedQuestionNumbers.join(", ")}번` : "없음"} color="var(--foreground)" />
                                    <MiniStat label="이탈" value={`${behaviorSummary.focusLossCount}회`} color="var(--foreground)" />
                                </div>
                            </section>
                        )}

                        <section className="bento-card student-review-side-card">
                            <div className="student-review-section-title">
                                <HelpCircle size={16} />
                                <strong>질문/해설</strong>
                            </div>
                            <p>궁금한 문항은 대기 목록에 보관됩니다.</p>
                            <div className="student-review-support-grid">
                                <MiniStat label="해설" value={`${explainedCount}/${reviewQuestions.length}`} color="#4f46e5" />
                                <MiniStat label="질문 대기" value={queuedQuestionCount} color="#0f766e" />
                                {answeredQuestionCount > 0 && (
                                    <MiniStat label="답변 완료" value={answeredQuestionCount} color="#4f46e5" />
                                )}
                            </div>
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
                                <div className="student-review-question-toolbar">
                                    <div>
                                        <h2>문항 상세</h2>
                                        <p>번호를 선택하고 해설/질문만 펼쳐봅니다.</p>
                                    </div>
                                    <div className="student-review-filter-tabs" role="group" aria-label="문항 필터">
                                        <button
                                            type="button"
                                            onClick={() => setFilterWrong(false)}
                                            className={`btn ${!filterWrong ? "btn-primary" : "btn-secondary"}`}
                                        >
                                            전체 {reviewQuestions.length}
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => setFilterWrong(true)}
                                            className={`btn ${filterWrong ? "btn-primary" : "btn-secondary"}`}
                                        >
                                            오답 {wrongAndUnansweredCount}
                                        </button>
                                    </div>
                                </div>

                                {filteredQuestions.length > 0 ? (
                                <div className="student-review-question-dock">
                                    <div className="student-review-question-map" aria-label="문항 바로가기">
                                        {filteredQuestions.map(question => {
                                            const { status } = resolveQuestionState(question);
                                            const isActive = question.id === selectedQuestion?.id;

                                            return (
                                                <button
                                                    key={question.id}
                                                    type="button"
                                                    onClick={() => setSelectedQuestionId(question.id)}
                                                    className={`student-review-question-dot is-${status} ${isActive ? "is-active" : ""}`}
                                                    aria-pressed={isActive}
                                                    title={`문항 ${question.number} ${questionStatusLabel(status)}`}
                                                >
                                                    <span>{question.number}</span>
                                                    <i aria-hidden="true" />
                                                </button>
                                            );
                                        })}
                                    </div>

                                    {selectedQuestion && selectedQuestionState && (
                                        <QuestionCard
                                            key={selectedQuestion.id}
                                            question={selectedQuestion}
                                            userAnswer={selectedQuestionState.userAnswer}
                                            correctAnswer={selectedQuestionState.correctAnswer}
                                            status={selectedQuestionState.status}
                                            timing={selectedQuestionState.timing}
                                            explanationOpen={!!openExplanations[selectedQuestion.id]}
                                            questionBoxOpen={!!openQuestionBoxes[selectedQuestion.id]}
                                            draft={questionDrafts[selectedQuestion.id] || ""}
                                            submittedQuestion={studentQuestions[selectedQuestion.id]}
                                            subQuestionAnswers={attempt.subQuestionAnswers?.[selectedQuestion.id]}
                                            retakeHref={buildRetakeHref(attempt.examId, attempt.id, [selectedQuestion.id], "custom")}
                                            onToggleExplanation={() => toggleExplanation(selectedQuestion.id)}
                                            onToggleQuestionBox={() => toggleQuestionBox(selectedQuestion.id)}
                                            onDraftChange={(value) => updateQuestionDraft(selectedQuestion.id, value)}
                                            onSubmitQuestion={() => submitStudentQuestion(selectedQuestion)}
                                            onRequestExplanation={() => requestExplanation(selectedQuestion)}
                                        />
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
                </section>
            </main>
        </div>
    );
}
