"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import dynamic from "next/dynamic";
import { BookOpen, CheckCircle2, ChevronDown, ChevronUp, Clock, Download, MessageSquare, Repeat2, Send, Target, TrendingUp } from "lucide-react";
import type { Attempt, AttemptFeedback, Exam, PdfDrawings, Question, StudentQuestionNote } from "@/types/omr";
import { storedDataUrlToFile, loadJsonRecord } from "@/utils/blobStore";
import { attemptBelongsToSession, getSession } from "@/utils/storage";
import { loadAttempt, loadExam, saveAttempt, saveLocalAttempt } from "@/lib/omrPersistence";
import { askAttemptQuestion, loadExamForReview, loadMyAttempt } from "@/app/actions/studentExam";
import { loadMyAttemptClient, loadReviewExamClient } from "@/lib/studentExamClient";
import { studentQuestionsByQuestionId, upsertStudentQuestion } from "@/lib/studentQuestions";
import { buildAttemptRetakeRecovery } from "@/lib/retakeRecovery";
import { formatKoreanDateTime } from "@/lib/pure";
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
    loadReturnedAttemptFeedback,
    markFeedbackOpened,
    mergePdfDrawings,
} from "@/lib/feedbackPersistence";

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
    const [openExplanations, setOpenExplanations] = useState<Record<number, boolean>>({});
    const [accessDenied, setAccessDenied] = useState(false);
    const [loadError, setLoadError] = useState(false);
    const [reloadKey, setReloadKey] = useState(0);
    const [handwritingUnavailable, setHandwritingUnavailable] = useState(false);
    const [returnedFeedback, setReturnedFeedback] = useState<AttemptFeedback | null>(null);
    const [teacherMarkupDrawings, setTeacherMarkupDrawings] = useState<PdfDrawings | undefined>(undefined);
    const [annotationDownloading, setAnnotationDownloading] = useState(false);
    // Per-question Q&A: notes keyed by questionId, the open draft, and a small
    // inline notice (this page does not import Toast — mirror the teacher
    // attempt page's local-notice pattern).
    const [studentQuestions, setStudentQuestions] = useState<Record<number, StudentQuestionNote>>({});
    const [questionDrafts, setQuestionDrafts] = useState<Record<number, string>>({});
    const [openQuestionBoxes, setOpenQuestionBoxes] = useState<Record<number, boolean>>({});
    const [questionNotice, setQuestionNotice] = useState("");
    const [sourceAttempt, setSourceAttempt] = useState<Attempt | null>(null);
    // Latest attempt for the local Q&A merge path — reading `attempt` state
    // directly in an async handler risks a stale closure dropping a concurrent
    // question. A ref + a submission mutex keep local writes serialized.
    const attemptRef = useRef<Attempt | null>(null);
    const questionSaveInFlightRef = useRef(false);

    useEffect(() => {
        let cancelled = false;
        const loadReview = async () => {
            if (!id || cancelled) return;
            // Reset the error flag so a retry starts clean.
            setLoadError(false);
            // Server-first: the action returns the attempt only when the signed
            // session cookie owns it. Device-local records fall back to the
            // existing client-side ownership check; an explicit server "denied"
            // is a hard stop and never reads the local copy.
            const result = await loadMyAttemptClient(id, {
                server: (attemptId) => loadMyAttempt(attemptId),
                localFallback: (attemptId) => loadAttempt(attemptId),
            });
            const found = result.status === "ok" ? result.attempt : undefined;
            if (found && !cancelled) {
                if (result.source === "local") {
                    const session = getSession();
                    if (!session || !attemptBelongsToSession(found, session)) {
                        setAccessDenied(true);
                        return;
                    }
                }
                setAttempt(found);
                attemptRef.current = found;
                setStudentQuestions(studentQuestionsByQuestionId(found));

                // Load the retake's source attempt so the recovery card can
                // compare against it. Pseudo sources ("exam:...", "student:...")
                // and self-references are skipped. Same server-first ownership
                // path as the attempt itself; a local hit re-verifies the session.
                const sourceId = found.retake?.sourceAttemptId;
                if (sourceId && !sourceId.includes(":") && sourceId !== found.id) {
                    void loadMyAttemptClient(sourceId, {
                        server: (attemptId) => loadMyAttempt(attemptId),
                        localFallback: (attemptId) => loadAttempt(attemptId),
                    }).then(sourceResult => {
                        if (cancelled || sourceResult.status !== "ok" || !sourceResult.attempt) return;
                        const src = sourceResult.attempt;
                        if (sourceResult.source === "server") {
                            setSourceAttempt(src);
                        } else {
                            const session = getSession();
                            if (session && attemptBelongsToSession(src, session)) setSourceAttempt(src);
                        }
                    }).catch(() => { /* recovery card is best-effort */ });
                }

                const feedback = await loadReturnedAttemptFeedback(found.id);
                if (feedback && !cancelled) {
                    setReturnedFeedback(feedback);
                    void markFeedbackOpened(feedback.id).then(async () => {
                        if (cancelled) return;
                        const refreshed = await loadReturnedAttemptFeedback(found.id);
                        if (!cancelled && refreshed) setReturnedFeedback(refreshed);
                    });
                    const markup = await loadFeedbackMarkupDrawings(feedback);
                    if (!cancelled && markup) setTeacherMarkupDrawings(markup);
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
                // (post-submit), PIN and answer-key PDF withheld server-side. The
                // local exam copy backs degraded/offline setups only — an explicit
                // "denied" must not be satisfied from the on-device answer key.
                const examResult = await loadReviewExamClient(found.id, {
                    server: (attemptId) => loadExamForReview(attemptId),
                    localFallback: () => loadExam(found.examId),
                });
                if (examResult.status === "denied" && !cancelled) {
                    setAccessDenied(true);
                    return;
                }
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
                <p style={{ color: '#64748b', marginTop: '0.5rem' }}>현재 로그인한 학생의 응시 기록만 볼 수 있습니다.</p>
                <Link href="/" className="btn btn-primary" style={{ marginTop: '1rem', display: 'inline-flex' }}>홈으로 돌아가기</Link>
            </div>
        );
    }

    if (loadError) {
        return (
            <div style={{ padding: '2rem', textAlign: 'center' }}>
                <h2>결과를 불러오지 못했습니다.</h2>
                <p style={{ color: '#64748b', marginTop: '0.5rem' }}>네트워크 상태를 확인한 뒤 다시 시도해주세요.</p>
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
        return <div style={{ padding: '2rem', textAlign: 'center' }}>Loading...</div>;
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
    const resultCounts = questionResults.reduce((counts, result) => {
        if (result.status === "correct") counts.correctCount += 1;
        if (result.status === "wrong") counts.incorrectCount += 1;
        if (result.status === "unanswered") counts.unansweredCount += 1;
        if (result.status === "ungraded") counts.ungradedCount += 1;
        return counts;
    }, { correctCount: 0, incorrectCount: 0, unansweredCount: 0, ungradedCount: 0 });
    const percentCorrect = scoreSummary.scorePercent;

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
        limit: 5,
    });
    const behaviorSummary = summarizeAttemptBehavior(attempt);
    const timingByQuestionId = new Map((attempt.questionTimings || []).map(timing => [timing.questionId, timing]));
    const questionNumberById = new Map(reviewQuestions.map(question => [question.id, question.number]));
    const formatRetakeNumbers = (questionIds: number[]) => questionIds
        .map(questionId => questionNumberById.get(questionId))
        .filter((questionNumber): questionNumber is number => typeof questionNumber === "number")
        .sort((a, b) => a - b)
        .join(", ");
    const allReviewQuestionIds = reviewQuestions.map(question => question.id);
    // Recovery vs the source attempt (loaded above). Uses the full exam so the
    // lib scopes to retake.questionIds itself; the source score is measured over
    // the SAME scoped review set so the two percentages compare 1:1.
    const retakeRecovery = attempt.retake && sourceAttempt
        ? buildAttemptRetakeRecovery(exam, attempt, sourceAttempt)
        : null;
    const sourceScoreSummary = retakeRecovery && sourceAttempt
        ? summarizeAttemptScore(reviewExam, sourceAttempt)
        : null;

    const toggleExplanation = (qId: number) => {
        setOpenExplanations(prev => ({ ...prev, [qId]: !prev[qId] }));
    };

    const updateQuestionDraft = (questionId: number, value: string) => {
        setQuestionDrafts(prev => ({ ...prev, [questionId]: value.slice(0, 500) }));
    };

    const toggleQuestionBox = (questionId: number) => {
        setOpenQuestionBoxes(prev => ({ ...prev, [questionId]: !prev[questionId] }));
    };

    const submitQuestion = async (question: Question) => {
        const body = (questionDrafts[question.id] || "").trim();
        if (!body) return;
        // Serialize submissions: the local merge path reads-then-writes the
        // attempt, so a second submit racing the first would build on a stale
        // copy and drop the earlier note. One in-flight save at a time.
        if (questionSaveInFlightRef.current) {
            setQuestionNotice("이전 질문을 저장하는 중입니다. 잠시 후 다시 시도해주세요.");
            return;
        }
        const base = attemptRef.current;
        if (!base) return;
        const input = { questionId: question.id, questionNumber: question.number, body };
        questionSaveInFlightRef.current = true;
        setQuestionNotice("");
        try {
            // Server-first: the action verifies ownership via the session cookie
            // and merges the note into the attempt row server-side. An explicit
            // "denied" is a hard stop, never written to the local copy.
            let updated: Attempt | null = null;
            try {
                const res = await askAttemptQuestion(base.id, input);
                if (res.status === "denied") {
                    setQuestionNotice("이 기록에 질문을 남길 권한이 없습니다.");
                    return;
                }
                if (res.status === "ok" && res.attempt) updated = res.attempt;
            } catch {
                // offline/dev — fall back to the local attempt write below.
            }
            if (updated) {
                try { saveLocalAttempt(updated); } catch { /* quota — server copy is canonical */ }
            } else {
                // Merge onto the freshest local attempt (ref, not stale closure).
                updated = upsertStudentQuestion(attemptRef.current || base, input, new Date().toISOString());
                if (!updated) return;
                const result = await saveAttempt(updated).catch(() => null);
                if (!result?.localSaved) {
                    setQuestionNotice("질문을 저장하지 못했습니다. 브라우저 저장소를 확인한 뒤 다시 시도해주세요.");
                    return;
                }
            }
            if (!updated) return;
            attemptRef.current = updated;
            setAttempt(updated);
            setStudentQuestions(prev => ({ ...prev, ...studentQuestionsByQuestionId(updated) }));
            setQuestionDrafts(prev => ({ ...prev, [question.id]: "" }));
            setOpenQuestionBoxes(prev => ({ ...prev, [question.id]: true }));
            setQuestionNotice("질문을 선생님께 전달했습니다. 답변이 등록되면 이 화면에 표시됩니다.");
        } finally {
            questionSaveInFlightRef.current = false;
        }
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
        document.body.removeChild(link);
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
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
        } catch (error) {
            console.error("Failed to download feedback markup", error);
        } finally {
            setAnnotationDownloading(false);
        }
    };

    return (
        <div className="layout-main" style={{ minHeight: '100vh', background: '#f8fafc' }}>
            <header className="header" style={{ background: 'white', borderBottom: '1px solid #e2e8f0' }}>
                <div className="container header-content">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                        <button onClick={() => router.back()} style={{ border: 'none', background: 'none', fontSize: '1.2rem', cursor: 'pointer' }}>←</button>
                        <span style={{ fontWeight: 600 }}>결과 리포트</span>
                    </div>
                    <Link href="/student/history" className="btn btn-secondary" style={{ fontSize: '0.9rem', padding: '0.4rem 1rem' }}>
                        목록으로
                    </Link>
                </div>
            </header>

            <main className="container" style={{ padding: '2rem 1rem', maxWidth: '800px', margin: '0 auto' }}>
                {/* Score Card */}
                <div style={{ background: 'white', padding: '2rem', borderRadius: '16px', boxShadow: '0 4px 6px -1px rgba(0,0,0,0.1)', textAlign: 'center', marginBottom: '1.25rem' }}>
                    <h1 style={{ fontSize: '1.5rem', marginBottom: '0.5rem', fontWeight: 700 }}>{attempt.examTitle}</h1>
                    <div style={{ fontSize: '3.5rem', fontWeight: 800, color: 'var(--primary)', lineHeight: 1 }}>
                        {percentCorrect}
                        <span style={{ fontSize: '1.5rem', color: '#94a3b8', fontWeight: 500 }}>%</span>
                    </div>
                    <div style={{ fontSize: '1rem', color: '#475569', marginTop: '0.4rem', fontWeight: 600 }}>
                        {scoreSummary.earnedScore} / {scoreSummary.totalScore} 점
                    </div>
                    <p style={{ color: '#64748b', marginTop: '0.5rem' }}>
                        {formatKoreanDateTime(attempt.finishedAt)} 응시 완료
                    </p>
                    {attempt.handwritingArchived && (
                        <div style={{
                            margin: '0.9rem auto 0',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '0.4rem',
                            padding: '0.35rem 0.75rem',
                            borderRadius: '999px',
                            background: '#eef2ff',
                            color: '#4f46e5',
                            fontSize: '0.78rem',
                            fontWeight: 800
                        }}>
                            필기 보관 {attempt.questionDrawings?.length || attempt.drawingPageCount || 0}문항
                        </div>
                    )}
                    {attempt.retake && (
                        <div style={{
                            margin: '0.6rem auto 0',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '0.4rem',
                            padding: '0.35rem 0.75rem',
                            borderRadius: '999px',
                            background: '#f0fdfa',
                            color: '#0f766e',
                            fontSize: '0.78rem',
                            fontWeight: 800
                        }}>
                            재시험 {attempt.retake.questionIds.length}문항
                        </div>
                    )}
                </div>

                {handwritingUnavailable && (
                    <div style={{
                        background: '#fff7ed',
                        border: '1px solid #fed7aa',
                        color: '#9a3412',
                        borderRadius: '12px',
                        padding: '0.9rem 1rem',
                        marginBottom: '1.25rem',
                        fontSize: '0.88rem',
                        fontWeight: 700
                    }}>
                        저장된 필기 정보를 불러오지 못했습니다. 답안과 점수 기록은 정상적으로 보관되어 있습니다.
                    </div>
                )}

                {returnedFeedback && (
                    <section style={{
                        background: 'white',
                        border: '1px solid #c7d2fe',
                        borderRadius: '12px',
                        padding: '1.25rem',
                        marginBottom: '1.25rem',
                        boxShadow: '0 2px 4px rgba(79,70,229,0.08)',
                        display: 'grid',
                        gap: '0.9rem'
                    }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', alignItems: 'flex-start', flexWrap: 'wrap' }}>
                            <div>
                                <div style={{ color: '#4f46e5', fontSize: '0.78rem', fontWeight: 900, marginBottom: '0.25rem' }}>
                                    NEW FEEDBACK
                                </div>
                                <h2 style={{ fontSize: '1.05rem', fontWeight: 900, color: '#0f172a' }}>
                                    교사 피드백
                                </h2>
                            </div>
                            {canDownloadFeedback ? (
                                <button
                                    type="button"
                                    onClick={downloadFeedback}
                                    className="btn btn-secondary"
                                    style={{ fontSize: '0.84rem', display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}
                                >
                                    <Download size={15} />
                                    다운로드
                                </button>
                            ) : (
                                <span style={{
                                    color: '#64748b',
                                    background: '#f1f5f9',
                                    borderRadius: '999px',
                                    padding: '0.3rem 0.7rem',
                                    fontSize: '0.76rem',
                                    fontWeight: 800,
                                }}>
                                    다운로드 제한
                                </span>
                            )}
                            {canDownloadMarkupFile && (
                                <button
                                    type="button"
                                    onClick={() => void downloadFeedbackMarkup()}
                                    disabled={annotationDownloading}
                                    className="btn btn-secondary"
                                    style={{ fontSize: '0.84rem', display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}
                                >
                                    <Download size={15} />
                                    {annotationDownloading ? '생성 중' : canDownloadAnnotatedPdf ? '첨삭 PDF' : '첨삭 파일'}
                                </button>
                            )}
                        </div>

                        {returnedFeedback.summary && (
                            <p style={{ color: '#334155', fontSize: '0.92rem', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                                {returnedFeedback.summary}
                            </p>
                        )}

                        {visibleFeedbackComments.length > 0 && (
                            <div style={{ display: 'grid', gap: '0.45rem' }}>
                                {visibleFeedbackComments.map(comment => (
                                    <div key={comment.id} style={{ padding: '0.65rem', borderRadius: '8px', background: '#eef2ff', border: '1px solid #c7d2fe' }}>
                                        <strong style={{ color: '#312e81', marginRight: '0.4rem' }}>{comment.questionNumber}번</strong>
                                        <span style={{ color: '#334155', fontSize: '0.86rem' }}>{comment.body}</span>
                                    </div>
                                ))}
                            </div>
                        )}

                        <div style={{ color: '#64748b', fontSize: '0.78rem', fontWeight: 700 }}>
                            {returnedFeedback.downloadPolicy.expiresAt
                                ? `다운로드 만료: ${formatKoreanDateTime(returnedFeedback.downloadPolicy.expiresAt)}`
                                : returnedFeedback.downloadPolicy.allowStudentDownload || returnedFeedback.downloadPolicy.allowAnnotatedPdfDownload
                                    ? '다운로드 가능'
                                    : '교사가 다운로드를 허용하지 않았습니다.'}
                        </div>
                    </section>
                )}

                {/* Stat Row */}
                <div style={{
                    display: 'grid',
                    gridTemplateColumns: `repeat(${resultCounts.ungradedCount > 0 ? 4 : 3}, 1fr)`,
                    gap: '0.75rem',
                    marginBottom: '1.5rem',
                }}>
                    <div style={{ background: 'white', padding: '1rem', borderRadius: '12px', border: '1px solid #e2e8f0', textAlign: 'center' }}>
                        <div style={{ fontSize: '0.75rem', color: '#64748b', fontWeight: 600, marginBottom: '0.25rem' }}>정답</div>
                        <div style={{ fontSize: '1.5rem', fontWeight: 800, color: 'var(--success, #16a34a)' }}>{resultCounts.correctCount}</div>
                    </div>
                    <div style={{ background: 'white', padding: '1rem', borderRadius: '12px', border: '1px solid #e2e8f0', textAlign: 'center' }}>
                        <div style={{ fontSize: '0.75rem', color: '#64748b', fontWeight: 600, marginBottom: '0.25rem' }}>오답</div>
                        <div style={{ fontSize: '1.5rem', fontWeight: 800, color: 'var(--error, #dc2626)' }}>{resultCounts.incorrectCount}</div>
                    </div>
                    <div style={{ background: 'white', padding: '1rem', borderRadius: '12px', border: '1px solid #e2e8f0', textAlign: 'center' }}>
                        <div style={{ fontSize: '0.75rem', color: '#64748b', fontWeight: 600, marginBottom: '0.25rem' }}>미응답</div>
                        <div style={{ fontSize: '1.5rem', fontWeight: 800, color: '#94a3b8' }}>{resultCounts.unansweredCount}</div>
                    </div>
                    {resultCounts.ungradedCount > 0 && (
                        <div style={{ background: 'white', padding: '1rem', borderRadius: '12px', border: '1px solid #e2e8f0', textAlign: 'center' }}>
                            <div style={{ fontSize: '0.75rem', color: '#64748b', fontWeight: 600, marginBottom: '0.25rem' }}>미채점</div>
                            <div style={{ fontSize: '1.5rem', fontWeight: 800, color: '#64748b' }}>{resultCounts.ungradedCount}</div>
                        </div>
                    )}
                </div>

                {(hasHandwriting || hasFeedbackMarkup) && (
                    <section style={{
                        background: 'white',
                        border: '1px solid #e2e8f0',
                        borderRadius: '12px',
                        overflow: 'hidden',
                        marginBottom: '1.5rem',
                        boxShadow: '0 2px 4px rgba(0,0,0,0.05)'
                    }}>
                        <div style={{
                            padding: '1rem 1.25rem',
                            borderBottom: '1px solid #e2e8f0',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: '1rem'
                        }}>
                            <div>
                                <h2 style={{ fontSize: '1rem', fontWeight: 700, color: '#0f172a', marginBottom: '0.2rem' }}>
                                    풀이 필기
                                </h2>
                                <p style={{ fontSize: '0.82rem', color: '#64748b' }}>
                                    제출 당시 저장된 필기를 읽기 전용으로 표시합니다.
                                </p>
                            </div>
                            <span style={{
                                fontSize: '0.75rem',
                                fontWeight: 700,
                                color: '#475569',
                                background: '#f1f5f9',
                                borderRadius: '999px',
                                padding: '0.25rem 0.65rem',
                                whiteSpace: 'nowrap'
                            }}>
                                읽기 전용
                            </span>
                        </div>
                        <div style={{ height: '720px', background: '#525659' }}>
                            {pdfFile ? (
                                <PDFViewer
                                    file={pdfFile}
                                    onLoadSuccess={() => { }}
                                    readOnlyDrawings={true}
                                    drawings={combinedReviewDrawings}
                                />
                            ) : (
                                <div style={{
                                    height: '100%',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    color: 'white',
                                    padding: '2rem',
                                    textAlign: 'center'
                                }}>
                                    {pdfLoadFailed
                                        ? "문제 PDF를 불러오지 못했습니다. 필기 데이터는 제출 기록에 저장되어 있습니다."
                                        : "문제 PDF를 불러오는 중입니다..."}
                                </div>
                            )}
                        </div>
                    </section>
                )}

                {retakeRecovery && (
                    <section style={{
                        background: 'white',
                        border: '1px solid #bbf7d0',
                        borderRadius: '12px',
                        padding: '1.25rem',
                        marginBottom: '1.25rem',
                        display: 'grid',
                        gap: '0.85rem'
                    }}>
                        <div>
                            <h2 style={{ fontSize: '1rem', fontWeight: 800, color: '#0f172a', display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                                <TrendingUp size={17} color="#16a34a" />
                                재시험 회복
                            </h2>
                            <p style={{ color: '#64748b', fontSize: '0.84rem', marginTop: '0.25rem' }}>
                                {retakeRecovery.targetCount > 0
                                    ? `원시험에서 틀린 ${retakeRecovery.targetCount}문항 중 ${retakeRecovery.recoveredCount}문항을 이번에 맞혔어요.`
                                    : '이번 범위에는 원시험에서 틀린 문항이 없었습니다.'}
                            </p>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${retakeRecovery.regressedCount > 0 ? 3 : 2}, 1fr)`, gap: '0.6rem' }}>
                            <div style={{ padding: '0.75rem', borderRadius: '8px', background: '#f0fdf4', border: '1px solid #bbf7d0', textAlign: 'center' }}>
                                <div style={{ color: '#64748b', fontSize: '0.72rem', fontWeight: 700, marginBottom: '0.25rem' }}>회복</div>
                                <div style={{ color: '#16a34a', fontSize: '0.95rem', fontWeight: 900 }}>
                                    {retakeRecovery.recoveryRate !== undefined
                                        ? `${retakeRecovery.recoveredCount}/${retakeRecovery.targetCount} (${retakeRecovery.recoveryRate}%)`
                                        : '대상 없음'}
                                </div>
                            </div>
                            <div style={{ padding: '0.75rem', borderRadius: '8px', background: '#eef2ff', border: '1px solid #c7d2fe', textAlign: 'center' }}>
                                <div style={{ color: '#64748b', fontSize: '0.72rem', fontWeight: 700, marginBottom: '0.25rem' }}>점수 변화</div>
                                <div style={{ color: '#4f46e5', fontSize: '0.95rem', fontWeight: 900 }}>
                                    {sourceScoreSummary ? `${sourceScoreSummary.scorePercent}% → ${scoreSummary.scorePercent}%` : '-'}
                                </div>
                            </div>
                            {retakeRecovery.regressedCount > 0 && (
                                <div style={{ padding: '0.75rem', borderRadius: '8px', background: '#fef2f2', border: '1px solid #fecaca', textAlign: 'center' }}>
                                    <div style={{ color: '#64748b', fontSize: '0.72rem', fontWeight: 700, marginBottom: '0.25rem' }}>다시 틀림</div>
                                    <div style={{ color: '#dc2626', fontSize: '0.95rem', fontWeight: 900 }}>{retakeRecovery.regressedCount}문항</div>
                                </div>
                            )}
                        </div>
                    </section>
                )}

                <section style={{
                    background: 'white',
                    border: '1px solid #e2e8f0',
                    borderRadius: '12px',
                    padding: '1.25rem',
                    marginBottom: '1.25rem',
                    display: 'grid',
                    gap: '1rem'
                }}>
                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
                        <div>
                            <h2 style={{ fontSize: '1rem', fontWeight: 800, color: '#0f172a', display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                                <Target size={17} color="#4f46e5" />
                                오답 재시험
                            </h2>
                            <p style={{ color: '#64748b', fontSize: '0.84rem', marginTop: '0.25rem' }}>
                                틀린 문항과 같은 유형을 묶어 다시 풀 수 있습니다.
                            </p>
                        </div>
                        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                            {retakeQuestionIds.length > 0 ? (
                                <Link
                                    href={buildRetakeHref(attempt.examId, attempt.id, retakeQuestionIds, "wrong")}
                                    className="btn btn-primary"
                                    style={{ fontSize: '0.86rem', display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}
                                >
                                    <Repeat2 size={15} />
                                    오답만 재시험
                                </Link>
                            ) : (
                                <span style={{ color: '#16a34a', fontWeight: 800, fontSize: '0.86rem' }}>재시험할 오답이 없습니다</span>
                            )}
                            <Link
                                href={buildRetakeHref(attempt.examId, attempt.id, allReviewQuestionIds, "custom")}
                                className="btn btn-secondary"
                                style={{ fontSize: '0.86rem' }}
                            >
                                전체 재시험
                            </Link>
                        </div>
                    </div>

                    {recommendationGroups.length > 0 && (
                        <div style={{
                            display: 'grid',
                            gap: '0.65rem',
                            padding: '0.9rem',
                            borderRadius: '10px',
                            border: '1px solid #c7d2fe',
                            background: '#eef2ff'
                        }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', flexWrap: 'wrap' }}>
                                <div>
                                    <div style={{ fontWeight: 900, color: '#312e81', fontSize: '0.92rem' }}>
                                        유형 재추천 큐
                                    </div>
                                    <div style={{ color: '#4338ca', fontSize: '0.78rem', marginTop: '0.2rem', fontWeight: 700 }}>
                                        이번 시험에서 틀린 유형만 묶었습니다.
                                    </div>
                                </div>
                                <span style={{
                                    color: '#4338ca',
                                    background: 'white',
                                    border: '1px solid #c7d2fe',
                                    borderRadius: '999px',
                                    padding: '0.25rem 0.6rem',
                                    fontSize: '0.72rem',
                                    fontWeight: 900,
                                    height: 'fit-content'
                                }}>
                                    {retakeQuestionIds.length}문항 대상
                                </span>
                            </div>

                            <div style={{ display: 'grid', gap: '0.55rem' }}>
                                {recommendationGroups.map(group => {
                                    const retakeIds = group.retakeQuestionIds;
                                    const retakeNumbers = formatRetakeNumbers(retakeIds);

                                    return (
                                        <div key={group.key} style={{
                                            display: 'flex',
                                            alignItems: 'center',
                                            justifyContent: 'space-between',
                                            gap: '0.75rem',
                                            padding: '0.85rem',
                                            borderRadius: '8px',
                                            background: 'white',
                                            border: '1px solid #c7d2fe'
                                        }}>
                                            <div style={{ minWidth: 0 }}>
                                                <div style={{ fontWeight: 900, color: '#0f172a', fontSize: '0.9rem', lineHeight: 1.3 }}>
                                                    {group.title}
                                                    <span style={{ marginLeft: '0.45rem', color: '#64748b', fontSize: '0.74rem', fontWeight: 800 }}>
                                                        {group.basis}
                                                    </span>
                                                </div>
                                                <div style={{ color: '#64748b', fontSize: '0.78rem', marginTop: '0.22rem' }}>
                                                    {retakeNumbers || group.questionNumbers.join(', ')}번 · 오답/미답 {group.wrongCount}/{group.totalCount}
                                                </div>
                                                <div style={{ color: '#4338ca', fontSize: '0.72rem', marginTop: '0.18rem', fontWeight: 700 }}>
                                                    {group.reason}
                                                </div>
                                            </div>
                                            <Link
                                                href={buildRetakeHref(attempt.examId, group.sourceAttemptId, retakeIds, group.retakeMode, {
                                                    labels: group.retakeLabels,
                                                    concepts: group.retakeConcepts,
                                                })}
                                                className="btn btn-secondary"
                                                style={{ fontSize: '0.78rem', padding: '0.35rem 0.7rem', whiteSpace: 'nowrap' }}
                                            >
                                                유형 재시험
                                            </Link>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    {recommendationGroups.length === 0 && weaknessGroups.length > 0 && (
                        <div style={{ display: 'grid', gap: '0.55rem' }}>
                            {weaknessGroups.map(group => (
                                <div key={group.key} style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'space-between',
                                    gap: '0.75rem',
                                    padding: '0.8rem 0.9rem',
                                    borderRadius: '8px',
                                    background: '#f8fafc',
                                    border: '1px solid #e2e8f0'
                                }}>
                                    <div style={{ minWidth: 0 }}>
                                        <div style={{ fontWeight: 800, color: '#0f172a', fontSize: '0.9rem' }}>
                                            {group.title}
                                            <span style={{ marginLeft: '0.45rem', color: '#64748b', fontSize: '0.76rem', fontWeight: 700 }}>
                                                {group.basis}
                                            </span>
                                        </div>
                                        <div style={{ color: '#64748b', fontSize: '0.78rem', marginTop: '0.2rem' }}>
                                            {group.questionNumbers.join(', ')}번 · 오답률 {group.wrongRate}%
                                        </div>
                                    </div>
                                    <Link
                                        href={buildRetakeHref(attempt.examId, attempt.id, group.questionIds, "similar", {
                                            labels: group.labels,
                                            concepts: group.concepts,
                                        })}
                                        className="btn btn-secondary"
                                        style={{ fontSize: '0.78rem', padding: '0.35rem 0.7rem', whiteSpace: 'nowrap' }}
                                    >
                                        유형 재시험
                                    </Link>
                                </div>
                            ))}
                        </div>
                    )}
                </section>

                {(attempt.questionTimings?.length || behaviorSummary.focusLossCount > 0) && (
                    <section style={{
                        background: 'white',
                        border: '1px solid #e2e8f0',
                        borderRadius: '12px',
                        padding: '1rem',
                        marginBottom: '1.25rem',
                    }}>
                        <h2 style={{ fontSize: '0.96rem', fontWeight: 800, color: '#0f172a', display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.75rem' }}>
                            <Clock size={16} color="#4f46e5" />
                            풀이 행동 요약
                        </h2>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.6rem' }}>
                            {[
                                { label: '추적 시간', value: formatSeconds(behaviorSummary.totalTrackedTimeSec) },
                                { label: '평균 문항 시간', value: formatSeconds(behaviorSummary.averageTimeSec) },
                                { label: '다시 본 문항', value: behaviorSummary.revisitedQuestionNumbers.length ? `${behaviorSummary.revisitedQuestionNumbers.join(', ')}번` : '없음' },
                                { label: '이탈 기록', value: `${behaviorSummary.focusLossCount}회` },
                            ].map(item => (
                                <div key={item.label} style={{ padding: '0.75rem', borderRadius: '8px', background: '#f8fafc', border: '1px solid #e2e8f0' }}>
                                    <div style={{ color: '#64748b', fontSize: '0.72rem', fontWeight: 700, marginBottom: '0.25rem' }}>{item.label}</div>
                                    <div style={{ color: '#0f172a', fontSize: '0.9rem', fontWeight: 800 }}>{item.value}</div>
                                </div>
                            ))}
                        </div>
                    </section>
                )}

                {/* Filters */}
                <div style={{ display: 'flex', gap: '1rem', marginBottom: '1.5rem', borderBottom: '1px solid #e2e8f0', paddingBottom: '1rem' }}>
                    <button
                        onClick={() => setFilterWrong(false)}
                        className={`btn ${!filterWrong ? 'btn-primary' : 'btn-secondary'}`}
                        style={{ borderRadius: '999px' }}
                    >
                        전체 문항 ({reviewQuestions.length})
                    </button>
                    <button
                        onClick={() => setFilterWrong(true)}
                        className={`btn ${filterWrong ? 'btn-primary' : 'btn-secondary'}`}
                        style={{ borderRadius: '999px', background: filterWrong ? '#ef4444' : undefined, color: filterWrong ? 'white' : undefined }}
                    >
                        오답만 보기 ({resultCounts.incorrectCount + resultCounts.unansweredCount})
                    </button>
                </div>

                {questionNotice && (
                    <div style={{
                        marginBottom: '1rem',
                        padding: '0.7rem 0.9rem',
                        borderRadius: 10,
                        background: '#eff6ff',
                        border: '1px solid #bfdbfe',
                        color: '#1e3a8a',
                        fontSize: '0.84rem',
                        fontWeight: 700,
                    }}>
                        {questionNotice}
                    </div>
                )}

                {/* Question List */}
                <div style={{ display: 'grid', gap: '1rem' }}>
                    {filteredQuestions.map((q) => {
                        const result = resultByQuestionId.get(q.id);
                        const userAns = result?.selectedAnswer ?? attempt.answers[q.id];
                        const correctAnswer = result?.correctAnswer ?? q.answer;
                        const status = result?.status
                            ?? (correctAnswer === undefined
                                ? "ungraded"
                                : userAns === undefined || userAns === null || userAns === 0
                                    ? "unanswered"
                                    : userAns === correctAnswer
                                        ? "correct"
                                        : "wrong");
                        const isCorrect = status === "correct";
                        const isSkipped = status === "unanswered";
                        const isUngraded = status === "ungraded";
                        const explanationOpen = !!openExplanations[q.id];
                        const timing = timingByQuestionId.get(q.id);
                        const questionFeedbackComments = visibleFeedbackComments.filter(comment => comment.questionId === q.id);
                        const statusLabel = isUngraded ? "미채점" : isCorrect ? "정답" : isSkipped ? "미응답" : "오답";
                        const submittedQuestion = studentQuestions[q.id];
                        const questionBoxOpen = !!openQuestionBoxes[q.id];
                        const draft = questionDrafts[q.id] || "";

                        return (
                            <div key={q.id} style={{
                                background: 'white', padding: '1.5rem', borderRadius: '12px',
                                border: '1px solid', borderColor: isCorrect || isUngraded ? '#e2e8f0' : '#fecaca',
                                position: 'relative'
                            }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '1rem' }}>
                                    <span style={{ fontWeight: 700, fontSize: '1.1rem', color: isCorrect || isUngraded ? '#0f172a' : '#ef4444' }}>
                                        문항 {q.number}
                                    </span>
                                    <span style={{
                                        fontWeight: 600, fontSize: '0.9rem',
                                        color: isUngraded ? '#64748b' : isCorrect ? '#16a34a' : '#dc2626'
                                    }}>
                                        {statusLabel}
                                    </span>
                                </div>

                                <div style={{ fontSize: '0.95rem', color: '#334155' }}>
                                    {isCorrect ? (
                                        <div>
                                            <span style={{ color: '#64748b', marginRight: '0.5rem' }}>내 답:</span>
                                            <span style={{ fontWeight: 700, color: '#0f172a' }}>{userAns}번</span>
                                        </div>
                                    ) : (
                                        <div>
                                            <span style={{ color: '#64748b', marginRight: '0.5rem' }}>내 답:</span>
                                            <span style={{ fontWeight: 700, color: isUngraded ? '#475569' : '#ef4444' }}>
                                                {isSkipped ? '(미응답)' : typeof userAns === "number" ? `${userAns}번` : '-'}
                                            </span>
                                            {correctAnswer !== undefined && (
                                                <>
                                                    <span style={{ color: '#94a3b8', margin: '0 0.5rem' }}>·</span>
                                                    <span style={{ color: '#64748b', marginRight: '0.5rem' }}>정답:</span>
                                                    <span style={{ fontWeight: 700, color: '#16a34a' }}>{correctAnswer}번</span>
                                                </>
                                            )}
                                        </div>
                                    )}
                                </div>

                                {(q.label || q.tags?.concept || q.tags?.source || timing) && (
                                    <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                                        {q.label && <span style={{ fontSize: '0.75rem', padding: '2px 8px', borderRadius: '4px', background: '#f1f5f9', color: '#64748b' }}>
                                            #{q.label}
                                        </span>}
                                        {q.tags?.concept && <span style={{ fontSize: '0.75rem', padding: '2px 8px', borderRadius: '4px', background: '#eef2ff', color: '#4f46e5' }}>
                                            {q.tags.concept}
                                        </span>}
                                        {q.tags?.source && <span style={{ fontSize: '0.75rem', padding: '2px 8px', borderRadius: '4px', background: '#f0fdfa', color: '#0f766e' }}>
                                            {q.tags.source}
                                        </span>}
                                        {timing && <span style={{ fontSize: '0.75rem', padding: '2px 8px', borderRadius: '4px', background: '#fff7ed', color: '#9a3412' }}>
                                            {formatSeconds(timing.totalTimeSec)} · 방문 {timing.visitCount}회
                                        </span>}
                                    </div>
                                )}

                                {questionFeedbackComments.length > 0 && (
                                    <div style={{ marginTop: '1rem', display: 'grid', gap: '0.45rem' }}>
                                        {questionFeedbackComments.map(comment => (
                                            <div key={comment.id} style={{
                                                padding: '0.7rem 0.8rem',
                                                borderRadius: '8px',
                                                border: '1px solid #c7d2fe',
                                                background: '#eef2ff',
                                                color: '#334155',
                                                fontSize: '0.86rem',
                                                lineHeight: 1.5,
                                            }}>
                                                <strong style={{ color: '#312e81', marginRight: '0.35rem' }}>교사 코멘트</strong>
                                                {comment.body}
                                            </div>
                                        ))}
                                    </div>
                                )}

                                <div style={{ marginTop: '1rem', borderTop: '1px dashed #e2e8f0', paddingTop: '0.85rem' }}>
                                    <button
                                        type="button"
                                        onClick={() => toggleQuestionBox(q.id)}
                                        style={{
                                            display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
                                            background: 'transparent', border: 'none', cursor: 'pointer',
                                            padding: 0, color: 'var(--primary, #4f46e5)', fontWeight: 600,
                                            fontSize: '0.9rem',
                                        }}
                                        aria-expanded={questionBoxOpen || !!submittedQuestion}
                                    >
                                        <MessageSquare size={16} />
                                        {submittedQuestion ? '질문 보기' : '선생님께 질문하기'}
                                        {questionBoxOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                                    </button>

                                    {(questionBoxOpen || submittedQuestion) && (
                                        <div style={{ marginTop: '0.6rem', display: 'grid', gap: '0.6rem' }}>
                                            {submittedQuestion && (
                                                <div style={{
                                                    display: 'inline-flex', alignItems: 'center', gap: '0.35rem',
                                                    color: submittedQuestion.status === 'answered' ? '#16a34a' : '#64748b',
                                                    fontSize: '0.78rem', fontWeight: 800,
                                                }}>
                                                    <CheckCircle2 size={14} />
                                                    {formatKoreanDateTime(submittedQuestion.createdAt)}
                                                    {submittedQuestion.status === 'answered' ? ' · 답변 완료' : ' · 질문 대기'}
                                                </div>
                                            )}
                                            {submittedQuestion && (
                                                <div style={{
                                                    padding: '0.65rem 0.75rem', borderRadius: '8px',
                                                    border: '1px solid #e2e8f0', background: '#f8fafc',
                                                    color: '#475569', fontSize: '0.84rem', lineHeight: 1.6,
                                                    whiteSpace: 'pre-wrap',
                                                }}>
                                                    {submittedQuestion.body}
                                                </div>
                                            )}
                                            {submittedQuestion?.status === 'answered' && submittedQuestion.answer && (
                                                <div style={{ padding: '0.7rem 0.8rem', borderRadius: '8px', border: '1px solid #bbf7d0', background: '#f0fdf4' }}>
                                                    <div style={{
                                                        display: 'flex', alignItems: 'center', gap: '0.35rem',
                                                        color: '#16a34a', fontWeight: 800, fontSize: '0.78rem', marginBottom: '0.35rem',
                                                    }}>
                                                        <MessageSquare size={13} />
                                                        {submittedQuestion.answer.teacherName
                                                            ? `${submittedQuestion.answer.teacherName} 선생님 답변`
                                                            : '선생님 답변'}
                                                        <span style={{ color: '#64748b', fontWeight: 600 }}>
                                                            · {formatKoreanDateTime(submittedQuestion.answer.createdAt)}
                                                        </span>
                                                    </div>
                                                    <div style={{ color: '#0f172a', fontSize: '0.86rem', lineHeight: 1.65, whiteSpace: 'pre-wrap' }}>
                                                        {submittedQuestion.answer.body}
                                                    </div>
                                                </div>
                                            )}
                                            <label htmlFor={`student-question-${q.id}`} style={{ fontSize: '0.78rem', fontWeight: 800, color: '#475569' }}>
                                                {submittedQuestion ? '질문 다시 남기기' : '선생님께 남길 질문'}
                                            </label>
                                            <textarea
                                                id={`student-question-${q.id}`}
                                                value={draft}
                                                onChange={(event) => updateQuestionDraft(q.id, event.target.value)}
                                                placeholder="어떤 부분이 헷갈렸는지 짧게 남겨두세요."
                                                rows={3}
                                                style={{
                                                    width: '100%', resize: 'vertical', border: '1px solid #cbd5e1',
                                                    borderRadius: 8, padding: '0.6rem', font: 'inherit',
                                                    color: '#0f172a', background: 'white',
                                                }}
                                            />
                                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem' }}>
                                                <span style={{ color: '#94a3b8', fontSize: '0.74rem', fontWeight: 700 }}>{draft.trim().length}/500</span>
                                                <button
                                                    type="button"
                                                    onClick={() => void submitQuestion(q)}
                                                    disabled={!draft.trim()}
                                                    className="btn btn-primary"
                                                    style={{ fontSize: '0.82rem', display: 'inline-flex', alignItems: 'center', gap: '0.35rem', opacity: draft.trim() ? 1 : 0.6 }}
                                                >
                                                    <Send size={14} />
                                                    질문 보내기
                                                </button>
                                            </div>
                                        </div>
                                    )}
                                </div>

                                {q.explanation && (
                                    <div style={{ marginTop: '1rem', borderTop: '1px dashed #e2e8f0', paddingTop: '0.85rem' }}>
                                        <button
                                            type="button"
                                            onClick={() => toggleExplanation(q.id)}
                                            style={{
                                                display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
                                                background: 'transparent', border: 'none', cursor: 'pointer',
                                                padding: 0, color: 'var(--primary, #4f46e5)', fontWeight: 600,
                                                fontSize: '0.9rem',
                                            }}
                                            aria-expanded={explanationOpen}
                                        >
                                            <BookOpen size={16} />
                                            해설 보기
                                            {explanationOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                                        </button>
                                        {explanationOpen && (
                                            <div style={{
                                                marginTop: '0.6rem', padding: '0.9rem 1rem',
                                                background: '#f8fafc', border: '1px solid #e2e8f0',
                                                borderRadius: '8px', color: '#334155',
                                                fontSize: '0.9rem', lineHeight: 1.6, whiteSpace: 'pre-wrap',
                                            }}>
                                                {q.explanation}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>

                {filterWrong && filteredQuestions.length === 0 && (
                    <div style={{ textAlign: 'center', padding: '3rem', color: '#64748b' }}>
                        틀린 문제가 없습니다!
                    </div>
                )}
            </main>
        </div>
    );
}
