"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import dynamic from "next/dynamic";
import { Download, Lock, PenLine, Repeat2, Target } from "lucide-react";
import type { Attempt, Exam, PdfDrawings, PlanKey, QuestionResult } from "@/types/omr";
import { loadJsonRecord, storedDataUrlToFile } from "@/utils/blobStore";
import { getCurrentPlan, getPlanLabel, hasPlanEntitlement } from "@/utils/plans";
import { formatKoreanDateTime } from "@/lib/pure";
import { loadAttempt, loadExam } from "@/lib/omrPersistence";
import {
    buildLearningRecommendations,
    buildRetakeQuestionIds,
    buildStudentWeaknessGroups,
    getAttemptQuestionResults,
    summarizeAttemptScore,
} from "@/lib/premiumAnalytics";
import { hasTeacherSession } from "@/lib/teacherSession";
import { buildRetakeHref } from "@/lib/retakeLinks";

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
    const [currentPlan] = useState<PlanKey>(() => getCurrentPlan());
    const [loaded, setLoaded] = useState(false);
    const pdfExportEnabled = hasPlanEntitlement(currentPlan, "pdfExport");

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
                    <p style={{ color: '#64748b', marginBottom: '1rem' }}>학생 풀이 필기는 교사 권한에서만 열람할 수 있습니다.</p>
                    <Link href="/" className="btn btn-primary">로그인으로 이동</Link>
                </div>
            </div>
        );
    }

    if (!loaded || !attempt) {
        return <div style={{ padding: '2rem', textAlign: 'center' }}>Loading...</div>;
    }

    const percent = analytics?.score.scorePercent ?? 0;
    const handwriting = attempt.handwriting;
    const questionSummaries = Object.values(handwriting?.questions || {});
    const canShowDrawings = hasDrawings(drawings);

    return (
        <div className="layout-main" style={{ minHeight: '100vh', background: '#f8fafc' }}>
            <header className="header" style={{ background: 'white', borderBottom: '1px solid #e2e8f0' }}>
                <div className="container header-content">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', minWidth: 0 }}>
                        <button onClick={() => router.back()} style={{ border: 'none', background: 'none', fontSize: '1.2rem', cursor: 'pointer' }}>←</button>
                        <div style={{ minWidth: 0 }}>
                            <div style={{ fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{attempt.examTitle}</div>
                            <div style={{ fontSize: '0.78rem', color: '#64748b' }}>{attempt.studentName} · {formatKoreanDateTime(attempt.finishedAt)}</div>
                        </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                        {pdfExportEnabled ? (
                            <button
                                type="button"
                                onClick={() => window.print()}
                                className="btn btn-secondary"
                                style={{ fontSize: '0.85rem', display: 'inline-flex', alignItems: 'center', gap: '0.35rem' }}
                            >
                                <Download size={14} />
                                PDF 리포트
                            </button>
                        ) : (
                            <Link
                                href="/teacher/billing"
                                title="Pro 이상에서 PDF 리포트를 출력할 수 있습니다."
                                className="btn btn-secondary"
                                style={{ fontSize: '0.85rem', display: 'inline-flex', alignItems: 'center', gap: '0.35rem', color: '#64748b' }}
                            >
                                <Lock size={14} />
                                PDF 리포트 Pro
                            </Link>
                        )}
                        <Link href={`/teacher/exam/${attempt.examId}`} className="btn btn-secondary" style={{ fontSize: '0.85rem' }}>
                            시험 결과로
                        </Link>
                    </div>
                </div>
            </header>

            <main className="container" style={{ padding: '1.5rem 1rem 2.5rem' }}>
                <section style={{
                    display: 'grid',
                    gridTemplateColumns: 'minmax(240px, 340px) minmax(0, 1fr)',
                    gap: '1rem',
                    alignItems: 'start'
                }}>
                    <aside style={{ display: 'grid', gap: '1rem' }}>
                        <div className="bento-card" style={{ padding: '1.25rem' }}>
                            <div style={{ fontSize: '0.75rem', fontWeight: 800, color: '#64748b', letterSpacing: '0.08em', marginBottom: '0.6rem' }}>응시 요약</div>
                            <h1 style={{ fontSize: '1.25rem', fontWeight: 900, marginBottom: '0.25rem' }}>{attempt.studentName}</h1>
                            <div style={{ fontSize: '2.6rem', fontWeight: 900, color: 'var(--primary)', lineHeight: 1, marginTop: '0.75rem' }}>{percent}%</div>
                            <div style={{ color: '#475569', fontWeight: 700, marginTop: '0.25rem' }}>
                                {analytics?.score.earnedScore ?? attempt.score} / {analytics?.score.totalScore ?? attempt.totalScore}점
                            </div>
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
                                        color: '#dc2626',
                                        background: '#fef2f2',
                                        borderRadius: '999px',
                                        padding: '0.25rem 0.55rem'
                                    }}>
                                        {analytics.wrongResults.length}문항
                                    </span>
                                </div>

                                {analytics.wrongResults.length > 0 ? (
                                    <div style={{ display: 'grid', gap: '0.55rem' }}>
                                        {analytics.wrongResults.slice(0, 8).map(result => (
                                            <QuestionResultRow key={result.questionId} result={result} />
                                        ))}
                                        {analytics.wrongResults.length > 8 && (
                                            <div style={{ color: '#64748b', fontSize: '0.78rem', fontWeight: 700 }}>
                                                외 {analytics.wrongResults.length - 8}문항
                                            </div>
                                        )}
                                    </div>
                                ) : (
                                    <div style={{ color: '#16a34a', fontSize: '0.86rem', fontWeight: 800 }}>
                                        오답 또는 미응답 문항이 없습니다.
                                    </div>
                                )}

                                {analytics.recommendations.length > 0 && (
                                    <div style={{ marginTop: '0.95rem', display: 'grid', gap: '0.5rem' }}>
                                        {analytics.recommendations.map(group => (
                                            <div key={group.key} style={{ padding: '0.7rem', borderRadius: '8px', border: '1px solid #c7d2fe', background: '#eef2ff' }}>
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
                                    borderRadius: '999px',
                                    padding: '0.25rem 0.55rem'
                                }}>
                                    {attempt.handwritingArchived ? '저장됨' : '미보관'}
                                </span>
                            </div>
                            <div style={{ display: 'grid', gap: '0.4rem', fontSize: '0.86rem', color: '#475569' }}>
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
                                            borderRadius: '999px',
                                            padding: '0.25rem 0.55rem'
                                        }}>
                                            {q.questionNumber}번
                                        </span>
                                    ))}
                                </div>
                            )}
                        </div>
                    </aside>

                    <section className="bento-card" style={{ padding: 0, overflow: 'hidden', minHeight: 760 }}>
                        <div style={{
                            padding: '1rem 1.2rem',
                            borderBottom: '1px solid #e2e8f0',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: '1rem'
                        }}>
                            <div>
                                <h2 style={{ fontSize: '1rem', fontWeight: 900 }}>학생 풀이 필기</h2>
                                <p style={{ fontSize: '0.82rem', color: '#64748b', marginTop: '0.15rem' }}>
                                    제출 시점의 PDF 필기 레이어를 읽기 전용으로 표시합니다.
                                </p>
                            </div>
                            <span style={{ fontSize: '0.75rem', fontWeight: 800, color: '#475569', background: '#f1f5f9', borderRadius: '999px', padding: '0.25rem 0.65rem' }}>
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
        <div style={{ background: `${color}12`, border: `1px solid ${color}24`, borderRadius: 10, padding: '0.55rem', textAlign: 'center' }}>
            <div style={{ fontSize: '0.68rem', color: '#64748b', fontWeight: 800, marginBottom: '0.15rem' }}>{label}</div>
            <div style={{ color, fontWeight: 900, fontSize: '1.05rem' }}>{value}</div>
        </div>
    );
}

function QuestionResultRow({ result }: { result: QuestionResult }) {
    const accent = result.status === "unanswered" ? '#64748b' : '#dc2626';
    const typeLabel = result.concept || result.label || result.source || '유형 미지정';

    return (
        <div style={{ padding: '0.7rem', borderRadius: '8px', border: '1px solid #fee2e2', background: '#fff7f7' }}>
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
                        <span key={type} style={{ color: '#7f1d1d', background: '#fee2e2', borderRadius: '999px', padding: '0.16rem 0.45rem', fontSize: '0.68rem', fontWeight: 800 }}>
                            {type}
                        </span>
                    ))}
                </div>
            )}
        </div>
    );
}
