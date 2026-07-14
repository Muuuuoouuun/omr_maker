"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import dynamic from "next/dynamic";
import { Download, ListChecks, Lock, MessageSquare, PenLine, Repeat2, Send, Target } from "lucide-react";
import type { Attempt, Exam, PdfDrawings, QuestionResult } from "@/types/omr";
import { loadJsonRecord, storedDataUrlToFile } from "@/utils/blobStore";
import { getPlanLabel, hasPlanEntitlement } from "@/utils/plans";
import { useServerPlan } from "@/lib/useServerPlan";
import { formatKoreanDateTime } from "@/lib/pure";
import { safeScorePercent } from "@/lib/scoreUtils";
import { readActiveWorkspaceContext } from "@/lib/workspaceContext";
import { fetchRemoteAttempt, loadAttempt, loadExam, saveAttempt } from "@/lib/omrPersistence";
import { answerStudentQuestion } from "@/lib/studentQuestions";
import { toast } from "@/components/Toast";
import {
    buildLearningRecommendations,
    buildRetakeQuestionIds,
    buildStudentWeaknessGroups,
    getAttemptQuestionResults,
    summarizeAttemptScore,
} from "@/lib/premiumAnalytics";
import { hasTeacherSession, readTeacherSession } from "@/lib/teacherSession";
import { buildRetakeHref } from "@/lib/retakeLinks";
import ThemeToggle from "@/components/ThemeToggle";
import { summarizePersistenceWrite } from "@/lib/persistenceFeedback";

const PDFViewer = dynamic(() => import("@/components/PDFViewer"), { ssr: false });

function hasTeacherAccess(): boolean {
    return hasTeacherSession();
}

function hasDrawings(drawings?: PdfDrawings): boolean {
    return !!drawings && Object.values(drawings).some(paths => paths.length > 0);
}

function formatAnswer(answer?: number): string {
    return typeof answer === "number" && answer > 0 ? `${answer}번` : "미응답";
}

export default function TeacherAttemptPage() {
    const params = useParams();
    const router = useRouter();
    const id = params?.attemptId as string;

    const [attempt, setAttempt] = useState<Attempt | null>(null);
    const [exam, setExam] = useState<Exam | null>(null);
    const [drawings, setDrawings] = useState<PdfDrawings | undefined>(undefined);
    const [pdfFile, setPdfFile] = useState<File | null>(null);
    const [accessDenied, setAccessDenied] = useState(false);
    const [handwritingUnavailable, setHandwritingUnavailable] = useState(false);
    const { plan: currentPlan } = useServerPlan();
    const [loaded, setLoaded] = useState(false);
    const [answerDrafts, setAnswerDrafts] = useState<Record<number, string>>({});
    const [savingAnswerFor, setSavingAnswerFor] = useState<number | null>(null);
    // D3: wrong-answer list expansion + full all-questions list toggles.
    const [wrongExpanded, setWrongExpanded] = useState(false);
    const [allQuestionsOpen, setAllQuestionsOpen] = useState(false);
    const [allQuestionsWrongOnly, setAllQuestionsWrongOnly] = useState(false);
    const [subQuestionFilter, setSubQuestionFilter] = useState<'needs_review' | 'all'>('needs_review');
    const [savingSubQuestionKey, setSavingSubQuestionKey] = useState<string | null>(null);
    const pdfExportEnabled = hasPlanEntitlement(currentPlan, "pdfExport");
    const handwritingArchiveEnabled = hasPlanEntitlement(currentPlan, "handwritingArchive");

    useEffect(() => {
        let cancelled = false;
        const loadTeacherAttempt = async () => {
            if (!hasTeacherAccess()) {
                setAccessDenied(true);
                setLoaded(true);
                return;
            }

            try {
                const found = await loadAttempt(id);
                if (!found || cancelled) {
                    setLoaded(true);
                    return;
                }

                // F4: loadAttempt (and its remote fetch) is not organization-scoped,
                // so verify the attempt belongs to this teacher's active workspace
                // before showing it. Only deny on a positive cross-workspace
                // mismatch; legacy attempts without an organizationId are allowed so
                // the check can't lock teachers out of pre-scoping records.
                const activeOrganizationId = readActiveWorkspaceContext().organizationId?.trim();
                const attemptOrganizationId = found.organizationId?.trim();
                if (attemptOrganizationId && activeOrganizationId && attemptOrganizationId !== activeOrganizationId) {
                    setAccessDenied(true);
                    setLoaded(true);
                    return;
                }

                setAttempt(found);

                const parsedExam = await loadExam(found.examId);
                if (parsedExam) {
                    setExam(parsedExam);
                    storedDataUrlToFile("problem.pdf", parsedExam.pdfData, parsedExam.pdfDataRef)
                        .then(file => {
                            if (!cancelled && file) setPdfFile(file);
                        })
                        .catch(() => {
                            if (!cancelled) setPdfFile(null);
                        });
                }

                const inlineDrawings = hasDrawings(found.drawings) ? found.drawings : undefined;
                if (inlineDrawings) setDrawings(inlineDrawings);

                const drawingsRef = found.handwriting?.strokesRef || found.drawingsRef;
                if (found.handwritingArchived && drawingsRef) {
                    loadJsonRecord<PdfDrawings>(drawingsRef)
                        .then(restored => {
                            if (cancelled) return;
                            if (restored) setDrawings(restored);
                            else if (!inlineDrawings) setHandwritingUnavailable(true);
                        })
                        .catch(() => {
                            if (!cancelled && !inlineDrawings) setHandwritingUnavailable(true);
                        })
                        .finally(() => {
                            if (!cancelled) setLoaded(true);
                        });
                } else {
                    setLoaded(true);
                }
            } catch {
                if (!cancelled) setLoaded(true);
            }
        };

        void loadTeacherAttempt();

        return () => { cancelled = true; };
    }, [id]);

    const analytics = useMemo(() => {
        if (!attempt || !exam) return null;
        const questionResults = getAttemptQuestionResults(exam, attempt);
        const score = summarizeAttemptScore(exam, attempt);
        const counts = questionResults.reduce((acc, result) => {
            if (result.status === "correct") acc.correctCount += 1;
            if (result.status === "wrong") acc.incorrectCount += 1;
            if (result.status === "unanswered") acc.unansweredCount += 1;
            if (result.status === "ungraded") acc.ungradedCount += 1;
            return acc;
        }, { correctCount: 0, incorrectCount: 0, unansweredCount: 0, ungradedCount: 0 });
        const wrongResults = questionResults.filter(result => result.status === "wrong" || result.status === "unanswered");
        const retakeQuestionIds = buildRetakeQuestionIds(exam, attempt);
        const weaknessGroups = buildStudentWeaknessGroups(exam, attempt).slice(0, 3);
        const recommendations = buildLearningRecommendations(exam, [attempt], {
            scope: "attempt",
            attempt,
            limit: 3,
        });

        return {
            questionResults,
            score,
            counts,
            wrongResults,
            retakeQuestionIds,
            weaknessGroups,
            recommendations,
        };
    }, [attempt, exam]);

    if (accessDenied) {
        return (
            <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: '2rem', textAlign: 'center' }}>
                <div>
                    <h1 style={{ fontSize: '1.4rem', fontWeight: 800, marginBottom: '0.5rem' }}>선생님 로그인이 필요합니다.</h1>
                    <p style={{ color: 'var(--muted)', marginBottom: '1rem' }}>학생 풀이 필기는 교사 권한에서만 열람할 수 있습니다.</p>
                    <Link href="/" className="btn btn-primary">로그인으로 이동</Link>
                </div>
            </div>
        );
    }

    if (!loaded) {
        return <div style={{ padding: '2rem', textAlign: 'center' }}>Loading...</div>;
    }

    if (!attempt) {
        // F3: loaded but no attempt (deleted, never synced, or wrong id) previously
        // spun forever. Show a real "not found" screen instead.
        return (
            <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: '2rem', textAlign: 'center' }}>
                <div>
                    <h1 style={{ fontSize: '1.4rem', fontWeight: 800, marginBottom: '0.5rem' }}>응시 기록을 찾을 수 없습니다.</h1>
                    <p style={{ color: 'var(--muted)', marginBottom: '1rem' }}>삭제되었거나 접근할 수 없는 기록일 수 있습니다.</p>
                    <Link href="/teacher/dashboard" className="btn btn-primary">대시보드로 이동</Link>
                </div>
            </div>
        );
    }

    // F2: when the exam payload can't be loaded, analytics is null. Fall back to
    // the score stored on the attempt so the header percent matches the score
    // line below instead of contradicting it with a hard 0%.
    const examUnavailable = !exam;
    const percent = analytics?.score.scorePercent ?? safeScorePercent(attempt.score, attempt.totalScore);
    const storedScorePercent = safeScorePercent(attempt.score, attempt.totalScore);
    const storedEarnedScore = Math.round((attempt.score || 0) * 100) / 100;
    // F6: recomputed review percent vs. the score stored at submission — diverges
    // when the answer key was edited after submission.
    const scoreRegraded = !!analytics
        && Number.isFinite(attempt.totalScore)
        && attempt.totalScore > 0
        && analytics.score.scorePercent !== storedScorePercent;

    // D3/D5: full per-question list with a wrong-only toggle and per-question
    // solve time (when timings were captured).
    const timingByQuestionId = new Map((attempt.questionTimings || []).map(timing => [timing.questionId, timing]));
    const allQuestionResults = analytics?.questionResults ?? [];
    const allQuestionsToShow = allQuestionsWrongOnly
        ? allQuestionResults.filter(result => result.status === "wrong" || result.status === "unanswered")
        : allQuestionResults;
    const handwriting = attempt.handwriting;
    const questionSummaries = Object.values(handwriting?.questions || {});
    const canShowDrawings = hasDrawings(drawings);
    const studentQuestionNotes = attempt.studentQuestions || [];
    const pendingQuestionCount = studentQuestionNotes.filter(note => note.status !== "answered").length;
    const answeredQuestionCount = studentQuestionNotes.length - pendingQuestionCount;
    const subQuestionRows = (exam?.questions || []).flatMap(question => (question.subQuestions || []).map(subQuestion => ({
        question,
        subQuestion,
        answer: attempt.subQuestionAnswers?.[question.id]?.[subQuestion.id],
    })));
    const answeredSubQuestionRows = subQuestionRows.filter(row => !!row.answer?.body);
    const pendingSubQuestionCount = answeredSubQuestionRows.filter(row => row.answer?.reviewStatus !== 'reviewed').length;
    const visibleSubQuestionRows = subQuestionFilter === 'needs_review'
        ? answeredSubQuestionRows.filter(row => row.answer?.reviewStatus !== 'reviewed')
        : subQuestionRows;

    const setSubQuestionReviewed = async (questionId: number, subQuestionId: string, reviewed: boolean) => {
        const currentAnswer = attempt.subQuestionAnswers?.[questionId]?.[subQuestionId];
        if (!currentAnswer) return;
        const key = `${questionId}:${subQuestionId}`;
        setSavingSubQuestionKey(key);
        const next: Attempt = {
            ...attempt,
            subQuestionAnswers: {
                ...(attempt.subQuestionAnswers || {}),
                [questionId]: {
                    ...(attempt.subQuestionAnswers?.[questionId] || {}),
                    [subQuestionId]: {
                        ...currentAnswer,
                        reviewStatus: reviewed ? 'reviewed' : 'needs_review',
                        reviewedAt: reviewed ? new Date().toISOString() : undefined,
                        reviewedBy: reviewed ? readTeacherSession()?.displayName : undefined,
                    },
                },
            },
        };
        try {
            const result = await saveAttempt(next);
            const feedback = summarizePersistenceWrite(result, { target: '심화 응답 검토 상태', action: '저장' });
            if (!feedback.ok) throw new Error(feedback.detail);
            setAttempt(next);
            if (feedback.level === 'info') toast.info(feedback.title, feedback.detail);
        } catch {
            toast.error('검토 상태 저장 실패', '네트워크 상태를 확인하고 다시 시도해 주세요.');
        } finally {
            setSavingSubQuestionKey(null);
        }
    };
    const handleAnswerQuestion = async (questionId: number) => {
        const body = (answerDrafts[questionId] || "").trim();
        if (!body) return;
        const teacherName = readTeacherSession()?.displayName;
        setSavingAnswerFor(questionId);
        // Merge the reply onto the freshest server row, not the local-first cache
        // this page loaded. saveAttempt writes the full payload last-writer-wins,
        // so replying against a stale snapshot would silently drop any question the
        // student asked after this device cached the attempt.
        const nowIso = new Date().toISOString();
        let base = attempt;
        try {
            // Scope the fresh fetch to this teacher's workspace (F4) so a reply is
            // never merged onto a row belonging to another workspace.
            const fresh = await fetchRemoteAttempt(attempt.id, {
                organizationId: readActiveWorkspaceContext().organizationId,
            });
            if (fresh) base = fresh;
        } catch {
            // Offline or Supabase unavailable — fall back to the cached attempt.
        }
        let updated = answerStudentQuestion(base, questionId, body, nowIso, teacherName);
        if (!updated && base !== attempt) {
            // F5: the fresh remote row can be missing this question note (the
            // student asked it after this device cached, or the remote copy
            // predates it). Union the locally-loaded note onto the fresh row so
            // the reply attaches without dropping the fresh copy's other notes.
            const localNote = (attempt.studentQuestions || []).find(note => note.questionId === questionId);
            if (localNote) {
                const mergedBase: Attempt = {
                    ...base,
                    studentQuestions: [
                        ...(base.studentQuestions || []).filter(note => note.questionId !== questionId),
                        localNote,
                    ],
                };
                updated = answerStudentQuestion(mergedBase, questionId, body, nowIso, teacherName);
            }
        }
        if (!updated) {
            // Never silent: tell the teacher why the reply couldn't attach.
            setSavingAnswerFor(null);
            toast.error("답변 전송 실패", "질문을 찾지 못했습니다. 화면을 새로고침한 뒤 다시 시도해주세요.");
            return;
        }
        try {
            const result = await saveAttempt(updated);
            if (!result.localSaved) throw new Error("local save failed");
            setAttempt(updated);
            setAnswerDrafts(prev => ({ ...prev, [questionId]: "" }));
            if (result.remoteSaved) {
                toast.success("답변 전송됨", "학생 리뷰 화면에서 답변을 볼 수 있습니다.");
            } else {
                toast.info("답변 저장됨", "서버 동기화는 다음 접속 때 재시도됩니다.");
            }
        } catch {
            toast.error("답변 저장 실패", "브라우저 저장소를 확인한 뒤 다시 시도해주세요.");
        } finally {
            setSavingAnswerFor(null);
        }
    };
    const handleDownloadHandwriting = () => {
        if (!drawings) return;
        const payload = {
            schemaVersion: 1,
            exportedAt: new Date().toISOString(),
            attemptId: attempt.id,
            examId: attempt.examId,
            examTitle: attempt.examTitle,
            studentName: attempt.studentName,
            finishedAt: attempt.finishedAt,
            handwriting: attempt.handwriting,
            questionDrawings: attempt.questionDrawings || [],
            drawings,
        };
        const safeTitle = attempt.examTitle.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 48) || "exam";
        const safeStudent = attempt.studentName.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 32) || "student";
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `${safeTitle}_${safeStudent}_handwriting.json`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    };

    return (
        <div className="layout-main teacher-attempt-page" style={{ minHeight: '100vh', background: 'var(--background)' }}>
            <header className="header teacher-attempt-print-hide">
                <div className="container header-content">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', minWidth: 0 }}>
                        <button
                            type="button"
                            onClick={() => router.back()}
                            aria-label="이전 화면으로"
                            title="이전 화면으로"
                            style={{ border: 'none', background: 'none', fontSize: '1.2rem', cursor: 'pointer' }}
                        >
                            ←
                        </button>
                        <div style={{ minWidth: 0 }}>
                            <div style={{ fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{attempt.examTitle}</div>
                            <div style={{ fontSize: '0.78rem', color: 'var(--muted)' }}>{attempt.studentName} · {formatKoreanDateTime(attempt.finishedAt)}</div>
                        </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                        {pdfExportEnabled ? (
                            <button
                                type="button"
                                onClick={() => window.print()}
                                title="현재 결과 요약을 브라우저 인쇄 창에서 인쇄하거나 PDF로 저장합니다."
                                aria-label="현재 결과 요약 인쇄 또는 PDF 저장"
                                className="btn btn-secondary"
                                style={{ fontSize: '0.85rem', display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}
                            >
                                <Download size={14} />
                                인쇄 / PDF 저장
                            </button>
                        ) : (
                            <Link
                                href="/teacher/billing"
                                title="Pro 이상에서 현재 결과 요약을 인쇄하거나 PDF로 저장할 수 있습니다."
                                className="btn btn-secondary"
                                style={{ fontSize: '0.85rem', display: 'inline-flex', alignItems: 'center', gap: '0.35rem', color: 'var(--muted)' }}
                            >
                                <Lock size={14} />
                                인쇄/PDF 저장 Pro
                            </Link>
                        )}
                        <Link href={`/teacher/exam/${attempt.examId}`} className="btn btn-secondary" style={{ fontSize: '0.85rem' }}>
                            시험 결과로
                        </Link>
                        <ThemeToggle size="small" />
                    </div>
                </div>
            </header>

            <main className="container teacher-attempt-main" style={{ padding: '1.5rem 1rem 2.5rem' }}>
                {examUnavailable && (
                    <div style={{
                        marginBottom: '1rem',
                        padding: '0.7rem 0.85rem',
                        borderRadius: 'var(--radius-md)',
                        border: '1px solid var(--warning)',
                        background: 'color-mix(in srgb, var(--warning) 12%, transparent)',
                        color: 'var(--warning)',
                        fontSize: '0.82rem',
                        fontWeight: 800,
                    }}>
                        시험 정보를 불러오지 못해 점수/유형 분석을 표시할 수 없습니다. 아래 점수는 제출 당시 저장된 값입니다.
                    </div>
                )}
                <section className="teacher-attempt-layout" style={{
                    display: 'grid',
                    gridTemplateColumns: 'minmax(240px, 340px) minmax(0, 1fr)',
                    gap: '1rem',
                    alignItems: 'start'
                }}>
                    <aside className="teacher-attempt-sidebar" style={{ display: 'grid', gap: '1rem' }}>
                        <div className="bento-card" style={{ padding: '1.25rem' }}>
                            <div style={{ fontSize: '0.75rem', fontWeight: 800, color: 'var(--muted)', letterSpacing: '0.08em', marginBottom: '0.6rem' }}>응시 요약</div>
                            <h1 style={{ fontSize: '1.25rem', fontWeight: 900, marginBottom: '0.25rem' }}>{attempt.studentName}</h1>
                            <div style={{ fontSize: '2.6rem', fontWeight: 900, color: 'var(--primary)', lineHeight: 1, marginTop: '0.75rem' }}>{percent}%</div>
                            <div style={{ color: 'var(--muted)', fontWeight: 700, marginTop: '0.25rem' }}>
                                {analytics?.score.earnedScore ?? attempt.score} / {analytics?.score.totalScore ?? attempt.totalScore}점
                            </div>
                            {scoreRegraded && (
                                <div
                                    style={{
                                        display: 'inline-flex',
                                        alignItems: 'center',
                                        marginTop: '0.6rem',
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
                            {analytics && (
                                <div style={{ display: 'grid', gridTemplateColumns: `repeat(${analytics.counts.ungradedCount > 0 ? 4 : 3}, 1fr)`, gap: '0.45rem', marginTop: '1rem' }}>
                                    <SmallStat label="정답" value={analytics.counts.correctCount} color="#16a34a" />
                                    <SmallStat label="오답" value={analytics.counts.incorrectCount} color="#dc2626" />
                                    <SmallStat label="미응답" value={analytics.counts.unansweredCount} color="#64748b" />
                                    {analytics.counts.ungradedCount > 0 && (
                                        <SmallStat label="미채점" value={analytics.counts.ungradedCount} color="#64748b" />
                                    )}
                                </div>
                            )}
                        </div>

                        {subQuestionRows.length > 0 && (
                            <div className="bento-card" style={{ padding: '1.25rem' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem', marginBottom: '0.8rem' }}>
                                    <div>
                                        <div style={{ fontWeight: 900 }}>심화 응답 검토</div>
                                        <div style={{ fontSize: '0.72rem', color: 'var(--muted)', marginTop: 2 }}>응답 {answeredSubQuestionRows.length}/{subQuestionRows.length} · 검토 필요 {pendingSubQuestionCount}</div>
                                    </div>
                                    <div style={{ display: 'flex', gap: '0.3rem' }} role="group" aria-label="심화 응답 필터">
                                        <button type="button" className={`btn ${subQuestionFilter === 'needs_review' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setSubQuestionFilter('needs_review')} style={{ fontSize: '0.68rem', padding: '0.3rem 0.45rem' }}>검토 필요</button>
                                        <button type="button" className={`btn ${subQuestionFilter === 'all' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setSubQuestionFilter('all')} style={{ fontSize: '0.68rem', padding: '0.3rem 0.45rem' }}>전체</button>
                                    </div>
                                </div>
                                {visibleSubQuestionRows.length > 0 ? (
                                    <div style={{ display: 'grid', gap: '0.55rem' }}>
                                        {visibleSubQuestionRows.map(({ question, subQuestion, answer }) => {
                                            const key = `${question.id}:${subQuestion.id}`;
                                            return (
                                                <div key={key} style={{ padding: '0.7rem', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--background)' }}>
                                                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', alignItems: 'start' }}>
                                                        <strong style={{ fontSize: '0.78rem' }}>{question.number}번 · {subQuestion.prompt}</strong>
                                                        <span style={{ color: answer?.reviewStatus === 'reviewed' ? 'var(--success)' : answer ? 'var(--warning)' : 'var(--muted)', fontSize: '0.68rem', fontWeight: 900, whiteSpace: 'nowrap' }}>{answer?.reviewStatus === 'reviewed' ? '검토 완료' : answer ? '검토 필요' : '미응답'}</span>
                                                    </div>
                                                    <div style={{ marginTop: '0.45rem', whiteSpace: 'pre-wrap', fontSize: '0.8rem', lineHeight: 1.55, color: answer ? 'var(--foreground)' : 'var(--muted)' }}>{answer?.body || '작성된 응답이 없습니다.'}</div>
                                                    {subQuestion.answerGuide && <div style={{ marginTop: '0.4rem', paddingTop: '0.4rem', borderTop: '1px dashed var(--border)', fontSize: '0.7rem', color: 'var(--muted)' }}>교사용 가이드: {subQuestion.answerGuide}</div>}
                                                    {answer && (
                                                        <button type="button" className="btn btn-secondary" disabled={savingSubQuestionKey === key} onClick={() => void setSubQuestionReviewed(question.id, subQuestion.id, answer.reviewStatus !== 'reviewed')} style={{ width: '100%', marginTop: '0.5rem', fontSize: '0.7rem', padding: '0.32rem' }}>{answer.reviewStatus === 'reviewed' ? '검토 필요로 되돌리기' : '검토 완료'}</button>
                                                    )}
                                                </div>
                                            );
                                        })}
                                    </div>
                                ) : (
                                    <div style={{ color: 'var(--success)', fontSize: '0.8rem', fontWeight: 800 }}>검토가 필요한 심화 응답이 없습니다.</div>
                                )}
                            </div>
                        )}

                        {analytics && (
                            <div className="bento-card" style={{ padding: '1.25rem' }}>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', marginBottom: '0.8rem' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', fontWeight: 900 }}>
                                        <Target size={17} />
                                        오답/유형 분석
                                    </div>
                                    <span style={{
                                        fontSize: '0.72rem',
                                        fontWeight: 800,
                                        color: 'var(--error)',
                                        background: 'color-mix(in srgb, var(--error) 12%, transparent)',
                                        borderRadius: 'var(--radius-full)',
                                        padding: '0.25rem 0.55rem'
                                    }}>
                                        {analytics.wrongResults.length}문항
                                    </span>
                                </div>

                                {analytics.wrongResults.length > 0 ? (
                                    <div style={{ display: 'grid', gap: '0.55rem' }}>
                                        {(wrongExpanded ? analytics.wrongResults : analytics.wrongResults.slice(0, 8)).map(result => (
                                            <QuestionResultRow key={result.questionId} result={result} />
                                        ))}
                                        {analytics.wrongResults.length > 8 && (
                                            <button
                                                type="button"
                                                onClick={() => setWrongExpanded(value => !value)}
                                                className="btn btn-secondary"
                                                style={{ width: '100%', fontSize: '0.76rem', padding: '0.4rem 0.65rem' }}
                                                aria-expanded={wrongExpanded}
                                            >
                                                {wrongExpanded ? "접기" : `전체 보기 (외 ${analytics.wrongResults.length - 8}문항)`}
                                            </button>
                                        )}
                                    </div>
                                ) : (
                                    <div style={{ color: 'var(--success)', fontSize: '0.86rem', fontWeight: 800 }}>
                                        오답 또는 미응답 문항이 없습니다.
                                    </div>
                                )}

                                {analytics.recommendations.length > 0 && (
                                    <div style={{ marginTop: '0.95rem', display: 'grid', gap: '0.5rem' }}>
                                        {analytics.recommendations.map(group => (
                                            <div key={group.key} style={{ padding: '0.7rem', borderRadius: 'var(--radius-sm)', border: '1px solid #c7d2fe', background: '#eef2ff' }}>
                                                <div style={{ color: '#312e81', fontWeight: 900, fontSize: '0.84rem' }}>{group.title}</div>
                                                <div style={{ color: '#4338ca', fontSize: '0.74rem', fontWeight: 700, marginTop: '0.15rem' }}>
                                                    {group.questionNumbers.join(', ')}번 · 오답/미답 {group.wrongCount}/{group.totalCount}
                                                </div>
                                                <Link
                                                    href={buildRetakeHref(attempt.examId, group.sourceAttemptId, group.retakeQuestionIds, group.retakeMode, {
                                                        labels: group.retakeLabels,
                                                        concepts: group.retakeConcepts,
                                                    })}
                                                    className="btn btn-secondary"
                                                    style={{ marginTop: '0.55rem', fontSize: '0.76rem', padding: '0.32rem 0.65rem', display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}
                                                >
                                                    <Repeat2 size={14} />
                                                    유형 재시험
                                                </Link>
                                            </div>
                                        ))}
                                    </div>
                                )}

                                {analytics.recommendations.length === 0 && analytics.weaknessGroups.length > 0 && (
                                    <div style={{ marginTop: '0.95rem', display: 'grid', gap: '0.5rem' }}>
                                        {analytics.weaknessGroups.map(group => (
                                            <Link
                                                key={group.key}
                                                href={buildRetakeHref(attempt.examId, attempt.id, group.questionIds, "similar", {
                                                    labels: group.labels,
                                                    concepts: group.concepts,
                                                })}
                                                className="btn btn-secondary"
                                                style={{ fontSize: '0.78rem', padding: '0.45rem 0.7rem', justifyContent: 'space-between' }}
                                            >
                                                {group.title}
                                                <span>{group.questionNumbers.join(', ')}번</span>
                                            </Link>
                                        ))}
                                    </div>
                                )}

                                {analytics.retakeQuestionIds.length > 0 && (
                                    <Link
                                        href={buildRetakeHref(attempt.examId, attempt.id, analytics.retakeQuestionIds, "wrong")}
                                        className="btn btn-primary"
                                        style={{ width: '100%', marginTop: '0.95rem', fontSize: '0.84rem', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem' }}
                                    >
                                        <Repeat2 size={15} />
                                        오답만 재시험 링크
                                    </Link>
                                )}
                            </div>
                        )}

                        {analytics && allQuestionResults.length > 0 && (
                            <div className="bento-card" style={{ padding: '1.25rem' }}>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', marginBottom: '0.8rem' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', fontWeight: 900 }}>
                                        <ListChecks size={17} />
                                        전체 문항
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => setAllQuestionsOpen(value => !value)}
                                        className="btn btn-secondary"
                                        style={{ fontSize: '0.74rem', padding: '0.3rem 0.6rem' }}
                                        aria-expanded={allQuestionsOpen}
                                    >
                                        {allQuestionsOpen ? "접기" : `전체 보기 (${allQuestionResults.length}문항)`}
                                    </button>
                                </div>
                                {allQuestionsOpen && (
                                    <>
                                        <div style={{ display: 'flex', gap: '0.3rem', marginBottom: '0.7rem' }} role="group" aria-label="문항 필터">
                                            <button
                                                type="button"
                                                onClick={() => setAllQuestionsWrongOnly(false)}
                                                className={`btn ${allQuestionsWrongOnly ? "btn-secondary" : "btn-primary"}`}
                                                style={{ flex: 1, fontSize: '0.74rem', padding: '0.32rem 0.6rem' }}
                                                aria-pressed={!allQuestionsWrongOnly}
                                            >
                                                전체 {allQuestionResults.length}
                                            </button>
                                            <button
                                                type="button"
                                                onClick={() => setAllQuestionsWrongOnly(true)}
                                                className={`btn ${allQuestionsWrongOnly ? "btn-primary" : "btn-secondary"}`}
                                                style={{ flex: 1, fontSize: '0.74rem', padding: '0.32rem 0.6rem' }}
                                                aria-pressed={allQuestionsWrongOnly}
                                            >
                                                오답 {analytics.wrongResults.length}
                                            </button>
                                        </div>
                                        {allQuestionsToShow.length > 0 ? (
                                            <div style={{ display: 'grid', gap: '0.4rem' }}>
                                                {allQuestionsToShow.map(result => (
                                                    <AllQuestionRow
                                                        key={result.questionId}
                                                        result={result}
                                                        timeSec={timingByQuestionId.get(result.questionId)?.totalTimeSec}
                                                    />
                                                ))}
                                            </div>
                                        ) : (
                                            <div style={{ color: 'var(--muted)', fontSize: '0.82rem', fontWeight: 700, textAlign: 'center', padding: '0.8rem' }}>
                                                표시할 문항이 없습니다.
                                            </div>
                                        )}
                                    </>
                                )}
                            </div>
                        )}

                        {studentQuestionNotes.length > 0 && (
                            <div className="bento-card" style={{ padding: '1.25rem' }}>
                                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', marginBottom: '0.8rem' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', fontWeight: 900 }}>
                                        <MessageSquare size={17} />
                                        학생 질문
                                    </div>
                                    <span style={{
                                        fontSize: '0.72rem',
                                        fontWeight: 800,
                                        color: pendingQuestionCount > 0 ? '#0f766e' : '#64748b',
                                        background: pendingQuestionCount > 0 ? '#f0fdfa' : '#f1f5f9',
                                        borderRadius: 'var(--radius-full)',
                                        padding: '0.25rem 0.55rem'
                                    }}>
                                        대기 {pendingQuestionCount} · 답변 {answeredQuestionCount}
                                    </span>
                                </div>
                                <div style={{ display: 'grid', gap: '0.65rem' }}>
                                    {studentQuestionNotes.map(note => (
                                        <div
                                            key={note.questionId}
                                            style={{
                                                padding: '0.75rem',
                                                borderRadius: 'var(--radius-md)',
                                                border: `1px solid ${note.status === "answered" ? '#bbf7d0' : '#99f6e4'}`,
                                                background: note.status === "answered" ? '#f0fdf4' : '#f0fdfa',
                                            }}
                                        >
                                            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', marginBottom: '0.3rem' }}>
                                                <span style={{ fontWeight: 900, fontSize: '0.84rem', color: '#0f172a' }}>{note.questionNumber}번 질문</span>
                                                <span style={{ color: '#64748b', fontSize: '0.7rem', fontWeight: 700 }}>{formatKoreanDateTime(note.createdAt)}</span>
                                            </div>
                                            <div style={{ color: '#334155', fontSize: '0.82rem', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{note.body}</div>
                                            {note.status === "answered" && note.answer && (
                                                <div style={{ marginTop: '0.55rem', padding: '0.6rem 0.7rem', borderRadius: 'var(--radius-sm)', background: 'white', border: '1px solid #e2e8f0' }}>
                                                    <div style={{ color: '#16a34a', fontWeight: 800, fontSize: '0.74rem', marginBottom: '0.25rem' }}>
                                                        내 답변 · {formatKoreanDateTime(note.answer.createdAt)}
                                                    </div>
                                                    <div style={{ color: '#334155', fontSize: '0.82rem', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{note.answer.body}</div>
                                                </div>
                                            )}
                                            <div style={{ marginTop: '0.55rem' }}>
                                                <textarea
                                                    value={answerDrafts[note.questionId] || ""}
                                                    onChange={(event) => {
                                                        const value = event.target.value.slice(0, 500);
                                                        setAnswerDrafts(prev => ({ ...prev, [note.questionId]: value }));
                                                    }}
                                                    placeholder={note.status === "answered" ? "답변을 고치려면 새로 입력하세요." : "학생에게 보낼 답변을 입력하세요."}
                                                    aria-label={`${note.questionNumber}번 질문 답변`}
                                                    style={{
                                                        width: '100%',
                                                        minHeight: 64,
                                                        padding: '0.55rem 0.65rem',
                                                        borderRadius: 'var(--radius-sm)',
                                                        border: '1px solid #e2e8f0',
                                                        fontSize: '0.84rem',
                                                        lineHeight: 1.55,
                                                        resize: 'vertical',
                                                        background: 'white',
                                                    }}
                                                />
                                                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '0.4rem' }}>
                                                    <button
                                                        type="button"
                                                        className="btn btn-primary"
                                                        disabled={!(answerDrafts[note.questionId] || "").trim() || savingAnswerFor === note.questionId}
                                                        onClick={() => void handleAnswerQuestion(note.questionId)}
                                                        style={{ fontSize: '0.78rem', padding: '0.4rem 0.8rem', display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}
                                                    >
                                                        <Send size={13} />
                                                        {savingAnswerFor === note.questionId
                                                            ? "저장 중..."
                                                            : note.status === "answered" ? "답변 수정" : "답변 보내기"}
                                                    </button>
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        <div className="bento-card" style={{ padding: '1.25rem' }}>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', marginBottom: '0.75rem' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', fontWeight: 900 }}>
                                    <PenLine size={17} />
                                    필기 보관
                                </div>
                                <span style={{
                                    fontSize: '0.72rem',
                                    fontWeight: 800,
                                    color: attempt.handwritingArchived ? '#4f46e5' : '#92400e',
                                    background: attempt.handwritingArchived ? '#eef2ff' : '#fef3c7',
                                    borderRadius: 'var(--radius-full)',
                                    padding: '0.25rem 0.55rem'
                                }}>
                                    {attempt.handwritingArchived ? '저장됨' : '미보관'}
                                </span>
                            </div>
                            <div style={{ display: 'grid', gap: '0.4rem', fontSize: '0.86rem', color: 'var(--muted)' }}>
                                <div>플랜: <strong>{getPlanLabel(handwriting?.plan || attempt.handwritingPlan || 'free')}</strong></div>
                                <div>페이지: <strong>{handwriting?.summary.pageCount ?? attempt.drawingPageCount ?? 0}</strong></div>
                                <div>획 수: <strong>{handwriting?.summary.strokeCount ?? attempt.drawingStrokeCount ?? 0}</strong></div>
                                <div>문항 연결: <strong>{handwriting?.summary.questionCount ?? questionSummaries.length}</strong></div>
                            </div>

                            {questionSummaries.length > 0 && (
                                <div style={{ marginTop: '0.9rem', display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
                                    {questionSummaries.slice(0, 18).map(q => (
                                        <span key={q.questionId} style={{
                                            fontSize: '0.72rem',
                                            fontWeight: 800,
                                            color: '#5b21b6',
                                            background: '#f5f3ff',
                                            borderRadius: 'var(--radius-full)',
                                            padding: '0.25rem 0.55rem'
                                        }}>
                                            {q.questionNumber}번
                                        </span>
                                    ))}
                                </div>
                            )}
                            {canShowDrawings && handwritingArchiveEnabled && (
                                <button
                                    type="button"
                                    onClick={handleDownloadHandwriting}
                                    className="btn btn-secondary"
                                    style={{ width: '100%', marginTop: '0.9rem', fontSize: '0.82rem', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '0.35rem' }}
                                >
                                    <Download size={14} />
                                    필기 원본 파일 저장
                                </button>
                            )}
                            {attempt.handwritingArchived && !handwritingArchiveEnabled && (
                                <Link
                                    href="/teacher/billing"
                                    className="btn btn-secondary"
                                    style={{ width: '100%', marginTop: '0.9rem', fontSize: '0.82rem', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '0.35rem', color: 'var(--muted)' }}
                                    title="Pro 이상에서 필기 원본 파일을 저장할 수 있습니다."
                                >
                                    <Lock size={14} />
                                    필기 파일 저장 Pro
                                </Link>
                            )}
                        </div>
                    </aside>

                    <section className="bento-card teacher-attempt-detail" style={{ padding: 0, overflow: 'hidden', minHeight: 760 }}>
                        <div style={{
                            padding: '1rem 1.2rem',
                            borderBottom: '1px solid var(--border)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: '1rem'
                        }}>
                            <div>
                                <h2 style={{ fontSize: '1rem', fontWeight: 900 }}>학생 풀이 필기</h2>
                                <p style={{ fontSize: '0.82rem', color: 'var(--muted)', marginTop: '0.15rem' }}>
                                    제출 시점의 PDF 필기 레이어를 읽기 전용으로 표시합니다.
                                </p>
                            </div>
                            <span style={{ fontSize: '0.75rem', fontWeight: 800, color: '#475569', background: '#f1f5f9', borderRadius: 'var(--radius-full)', padding: '0.25rem 0.65rem' }}>
                                교사용
                            </span>
                        </div>

                        <div style={{ height: 720, background: '#525659' }}>
                            {canShowDrawings && pdfFile ? (
                                <PDFViewer
                                    file={pdfFile}
                                    onLoadSuccess={() => { }}
                                    readOnlyDrawings
                                    drawings={drawings}
                                />
                            ) : (
                                <div style={{
                                    height: '100%',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    textAlign: 'center',
                                    color: 'white',
                                    padding: '2rem'
                                }}>
                                    <div>
                                        <div style={{ fontSize: '2rem', marginBottom: '0.75rem' }}>✍</div>
                                        <div style={{ fontWeight: 900, marginBottom: '0.35rem' }}>
                                            {attempt.handwritingArchived
                                                ? handwritingUnavailable
                                                    ? '필기 원본을 불러오지 못했습니다.'
                                                    : '문제 PDF 또는 필기 데이터를 불러오는 중입니다.'
                                                : '이 응시는 필기 원본이 보관되지 않았습니다.'}
                                        </div>
                                        <div style={{ fontSize: '0.85rem', color: '#cbd5e1' }}>
                                            Free 플랜 제출 또는 저장 실패 기록은 답안/점수만 확인할 수 있습니다.
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
                    </section>
                </section>
            </main>
        </div>
    );
}

function SmallStat({ label, value, color }: { label: string; value: number; color: string }) {
    return (
        <div style={{ background: `${color}12`, border: `1px solid ${color}24`, borderRadius: 'var(--radius-md)', padding: '0.55rem', textAlign: 'center' }}>
            <div style={{ fontSize: '0.68rem', color: 'var(--muted)', fontWeight: 800, marginBottom: '0.15rem' }}>{label}</div>
            <div style={{ color, fontWeight: 900, fontSize: '1.05rem' }}>{value}</div>
        </div>
    );
}

function QuestionResultRow({ result }: { result: QuestionResult }) {
    const accent = result.status === "unanswered" ? '#64748b' : '#dc2626';
    const typeLabel = result.concept || result.label || result.source || '유형 미지정';

    return (
        <div style={{ padding: '0.7rem', borderRadius: 'var(--radius-sm)', border: '1px solid #fee2e2', background: '#fff7f7' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.6rem' }}>
                <div style={{ color: accent, fontWeight: 900, fontSize: '0.86rem' }}>{result.questionNumber}번</div>
                <div style={{ color: '#64748b', fontSize: '0.72rem', fontWeight: 800 }}>{typeLabel}</div>
            </div>
            <div style={{ color: '#475569', fontSize: '0.78rem', fontWeight: 700, marginTop: '0.25rem' }}>
                학생 {formatAnswer(result.selectedAnswer)}
                {result.correctAnswer !== undefined && ` · 정답 ${formatAnswer(result.correctAnswer)}`}
            </div>
            {!!result.mistakeTypes?.length && (
                <div style={{ marginTop: '0.3rem', display: 'flex', gap: '0.3rem', flexWrap: 'wrap' }}>
                    {result.mistakeTypes.slice(0, 2).map(type => (
                        <span key={type} style={{ color: '#7f1d1d', background: '#fee2e2', borderRadius: 'var(--radius-full)', padding: '0.16rem 0.45rem', fontSize: '0.68rem', fontWeight: 800 }}>
                            {type}
                        </span>
                    ))}
                </div>
            )}
        </div>
    );
}

function formatQuestionTime(totalSec?: number): string {
    if (typeof totalSec !== "number" || !Number.isFinite(totalSec) || totalSec <= 0) return "";
    if (totalSec < 60) return `${totalSec}초`;
    const minutes = Math.floor(totalSec / 60);
    const seconds = totalSec % 60;
    return seconds > 0 ? `${minutes}분 ${seconds}초` : `${minutes}분`;
}

const ALL_QUESTION_STATUS_META: Record<QuestionResult["status"], { label: string; color: string }> = {
    correct: { label: "정답", color: "var(--success)" },
    wrong: { label: "오답", color: "var(--error)" },
    unanswered: { label: "미응답", color: "var(--muted)" },
    ungraded: { label: "미채점", color: "var(--muted)" },
};

function AllQuestionRow({ result, timeSec }: { result: QuestionResult; timeSec?: number }) {
    const statusMeta = ALL_QUESTION_STATUS_META[result.status];
    const timeLabel = formatQuestionTime(timeSec);

    return (
        <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '0.6rem',
            padding: '0.5rem 0.6rem',
            borderRadius: 'var(--radius-sm)',
            border: '1px solid var(--border)',
            background: 'var(--surface)',
        }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', minWidth: 0 }}>
                <span style={{ fontWeight: 900, fontSize: '0.82rem', minWidth: '2.4rem', flex: '0 0 auto' }}>{result.questionNumber}번</span>
                <span style={{ color: statusMeta.color, fontWeight: 800, fontSize: '0.74rem', flex: '0 0 auto' }}>{statusMeta.label}</span>
                <span style={{ color: 'var(--muted)', fontSize: '0.72rem', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    학생 {formatAnswer(result.selectedAnswer)}
                    {result.correctAnswer !== undefined && ` · 정답 ${formatAnswer(result.correctAnswer)}`}
                </span>
            </div>
            {timeLabel && (
                <span style={{ color: 'var(--muted)', fontSize: '0.7rem', fontWeight: 800, whiteSpace: 'nowrap', flex: '0 0 auto' }}>{timeLabel}</span>
            )}
        </div>
    );
}
