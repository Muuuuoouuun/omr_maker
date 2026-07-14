"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import dynamic from "next/dynamic";
import { BookOpen, ChevronDown, ChevronUp, Clock, Download, Repeat2, Target } from "lucide-react";
import type { Attempt, AttemptFeedback, Exam, PdfDrawings } from "@/types/omr";
import { storedDataUrlToFile, loadJsonRecord } from "@/utils/blobStore";
import { attemptBelongsToSession, getSession } from "@/utils/storage";
import { loadStudentOfficialAttempt } from "@/lib/studentAttemptClient";
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
    const [handwritingUnavailable, setHandwritingUnavailable] = useState(false);
    const [returnedFeedback, setReturnedFeedback] = useState<AttemptFeedback | null>(null);
    const [teacherMarkupDrawings, setTeacherMarkupDrawings] = useState<PdfDrawings | undefined>(undefined);
    const [annotationDownloading, setAnnotationDownloading] = useState(false);
    const [loading, setLoading] = useState(true);
    const [loadFailed, setLoadFailed] = useState(false);
    const [retryKey, setRetryKey] = useState(0);

    useEffect(() => {
        let cancelled = false;
        const loadReview = async () => {
            if (!id || cancelled) return;
            try {
                const session = getSession();
                if (!session) {
                    setAccessDenied(true);
                    return;
                }

                // Load Attempt
                const officialDetail = await loadStudentOfficialAttempt(id, session);
                if (officialDetail && !cancelled) {
                const found = officialDetail.attempt;
                if (!attemptBelongsToSession(found, session)) {
                    setAccessDenied(true);
                    return;
                }
                setAttempt(found);

                const feedback = await loadStudentReturnedFeedbackForAttempt(found.id, session.studentId);
                if (feedback && !cancelled) {
                    setReturnedFeedback(feedback);
                    void markStudentFeedbackOpened(feedback.id, session.studentId).then(async () => {
                        if (cancelled) return;
                        const refreshed = await loadStudentReturnedFeedbackForAttempt(found.id, session.studentId);
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

                // Load Exam Data associated with this attempt
                const parsedExam = officialDetail.exam;
                if (!cancelled) {
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
                }
                } else if (!cancelled) {
                    setLoadFailed(true);
                }
            } catch (error) {
                console.error("Failed to load review", error);
                if (!cancelled) setLoadFailed(true);
            } finally {
                if (!cancelled) setLoading(false);
            }
        };
        void loadReview();
        return () => { cancelled = true; };
    }, [id, retryKey]);

    if (accessDenied) {
        return (
            <div style={{ padding: '2rem', textAlign: 'center' }}>
                <h2>접근할 수 없는 기록입니다.</h2>
                <p style={{ color: '#64748b', marginTop: '0.5rem' }}>현재 로그인한 학생의 응시 기록만 볼 수 있습니다.</p>
                <Link href="/" className="btn btn-primary" style={{ marginTop: '1rem', display: 'inline-flex' }}>홈으로 돌아가기</Link>
            </div>
        );
    }

    if (loading) {
        return <div role="status" aria-live="polite" style={{ padding: '3rem 1rem', textAlign: 'center', color: 'var(--muted)' }}>결과 리포트를 불러오는 중입니다.</div>;
    }

    if (loadFailed || !attempt || !exam) {
        return (
            <div role="alert" style={{ padding: '3rem 1rem', textAlign: 'center', color: 'var(--foreground)' }}>
                <h2>결과 리포트를 불러오지 못했습니다.</h2>
                <p style={{ color: 'var(--muted)', marginTop: '0.5rem' }}>네트워크와 로그인 상태를 확인한 뒤 다시 시도해주세요.</p>
                <div style={{ display: 'flex', justifyContent: 'center', gap: '0.75rem', marginTop: '1.25rem', flexWrap: 'wrap' }}>
                    <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => {
                            setLoadFailed(false);
                            setLoading(true);
                            setRetryKey(key => key + 1);
                        }}
                    >
                        다시 시도
                    </button>
                    <Link href="/student/history" className="btn btn-secondary">기록 목록</Link>
                </div>
            </div>
        );
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

    const toggleExplanation = (qId: number) => {
        setOpenExplanations(prev => ({ ...prev, [qId]: !prev[qId] }));
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
        <div className="layout-main" style={{ minHeight: '100vh', background: 'var(--background)' }}>
            <header className="header" style={{ background: 'var(--surface)', borderBottom: '1px solid var(--border)' }}>
                <div className="container header-content">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                        <button
                            type="button"
                            onClick={() => router.back()}
                            aria-label="결과 기록으로 돌아가기"
                            style={{ border: 'none', background: 'none', fontSize: '1.2rem', cursor: 'pointer', minWidth: '44px', minHeight: '44px' }}
                        >
                            ←
                        </button>
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
                                    새 피드백
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

                                {q.explanation && (
                                    <div style={{ marginTop: '1rem', borderTop: '1px dashed #e2e8f0', paddingTop: '0.85rem' }}>
                                        <button
                                            type="button"
                                            onClick={() => toggleExplanation(q.id)}
                                            style={{
                                                display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
                                                background: 'transparent', border: 'none', cursor: 'pointer',
                                                padding: '0.5rem 0', minHeight: '44px', color: 'var(--primary, #4f46e5)', fontWeight: 600,
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
