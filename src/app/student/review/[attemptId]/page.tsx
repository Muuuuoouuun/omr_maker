"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import dynamic from "next/dynamic";
import { BookOpen, ChevronDown, ChevronUp } from "lucide-react";
import { gradeAttempt } from "@/types/omr";
import type { Attempt, Exam, PdfDrawings } from "@/types/omr";
import { storedDataUrlToFile, loadJsonRecord } from "@/utils/blobStore";
import { attemptBelongsToSession, getSession } from "@/utils/storage";

const PDFViewer = dynamic(() => import("@/components/PDFViewer"), { ssr: false });

function hasDrawings(drawings?: PdfDrawings): boolean {
    return !!drawings && Object.values(drawings).some(paths => paths.length > 0);
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

    useEffect(() => {
        let cancelled = false;
        queueMicrotask(() => {
            if (!id || cancelled) return;
            // Load Attempt
            const attemptsData = localStorage.getItem('omr_attempts');
            if (attemptsData) {
                const attempts: Attempt[] = JSON.parse(attemptsData);
                const found = attempts.find(a => a.id === id);
                if (found && !cancelled) {
                    const session = getSession();
                    if (!session || !attemptBelongsToSession(found, session)) {
                        setAccessDenied(true);
                        return;
                    }
                    setAttempt(found);
                    
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
                    const examDataStr = localStorage.getItem(`omr_exam_${found.examId}`);
                    if (examDataStr) {
                        const parsedExam = JSON.parse(examDataStr) as Exam;
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
                }
            }
        });
        return () => { cancelled = true; };
    }, [id]);

    if (accessDenied) {
        return (
            <div style={{ padding: '2rem', textAlign: 'center' }}>
                <h2>접근할 수 없는 기록입니다.</h2>
                <p style={{ color: '#64748b', marginTop: '0.5rem' }}>현재 로그인한 학생의 응시 기록만 볼 수 있습니다.</p>
                <Link href="/" className="btn btn-primary" style={{ marginTop: '1rem', display: 'inline-flex' }}>홈으로 돌아가기</Link>
            </div>
        );
    }

    if (!attempt || !exam) {
        return <div style={{ padding: '2rem', textAlign: 'center' }}>Loading...</div>;
    }

    const stats = gradeAttempt(exam.questions, attempt.answers);
    const percentCorrect = stats.totalScore > 0
        ? Math.round((stats.earnedScore / stats.totalScore) * 100)
        : 0;

    const filteredQuestions = filterWrong
        ? exam.questions.filter(q => q.answer && attempt.answers[q.id] !== q.answer)
        : exam.questions;
    const hasHandwriting = hasDrawings(restoredDrawings);

    const toggleExplanation = (qId: number) => {
        setOpenExplanations(prev => ({ ...prev, [qId]: !prev[qId] }));
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
                        {stats.earnedScore} / {stats.totalScore} 점
                    </div>
                    <p style={{ color: '#64748b', marginTop: '0.5rem' }}>
                        {new Date(attempt.finishedAt).toLocaleString()} 응시 완료
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

                {/* Stat Row */}
                <div style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(3, 1fr)',
                    gap: '0.75rem',
                    marginBottom: '1.5rem',
                }}>
                    <div style={{ background: 'white', padding: '1rem', borderRadius: '12px', border: '1px solid #e2e8f0', textAlign: 'center' }}>
                        <div style={{ fontSize: '0.75rem', color: '#64748b', fontWeight: 600, marginBottom: '0.25rem' }}>정답</div>
                        <div style={{ fontSize: '1.5rem', fontWeight: 800, color: 'var(--success, #16a34a)' }}>{stats.correctCount}</div>
                    </div>
                    <div style={{ background: 'white', padding: '1rem', borderRadius: '12px', border: '1px solid #e2e8f0', textAlign: 'center' }}>
                        <div style={{ fontSize: '0.75rem', color: '#64748b', fontWeight: 600, marginBottom: '0.25rem' }}>오답</div>
                        <div style={{ fontSize: '1.5rem', fontWeight: 800, color: 'var(--error, #dc2626)' }}>{stats.incorrectCount}</div>
                    </div>
                    <div style={{ background: 'white', padding: '1rem', borderRadius: '12px', border: '1px solid #e2e8f0', textAlign: 'center' }}>
                        <div style={{ fontSize: '0.75rem', color: '#64748b', fontWeight: 600, marginBottom: '0.25rem' }}>미응답</div>
                        <div style={{ fontSize: '1.5rem', fontWeight: 800, color: '#94a3b8' }}>{stats.unansweredCount}</div>
                    </div>
                </div>

                {hasHandwriting && (
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
                                    drawings={restoredDrawings}
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

                {/* Action: retake */}
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '1rem' }}>
                    <Link
                        href={`/solve/${attempt.examId}`}
                        className="btn btn-primary"
                        style={{ fontSize: '0.9rem' }}
                    >
                        시험 다시 보기
                    </Link>
                </div>

                {/* Filters */}
                <div style={{ display: 'flex', gap: '1rem', marginBottom: '1.5rem', borderBottom: '1px solid #e2e8f0', paddingBottom: '1rem' }}>
                    <button
                        onClick={() => setFilterWrong(false)}
                        className={`btn ${!filterWrong ? 'btn-primary' : 'btn-secondary'}`}
                        style={{ borderRadius: '999px' }}
                    >
                        전체 문항 ({exam.questions.length})
                    </button>
                    <button
                        onClick={() => setFilterWrong(true)}
                        className={`btn ${filterWrong ? 'btn-primary' : 'btn-secondary'}`}
                        style={{ borderRadius: '999px', background: filterWrong ? '#ef4444' : undefined, color: filterWrong ? 'white' : undefined }}
                    >
                        오답만 보기 ({stats.incorrectCount + stats.unansweredCount})
                    </button>
                </div>

                {/* Question List */}
                <div style={{ display: 'grid', gap: '1rem' }}>
                    {filteredQuestions.map((q) => {
                        const userAns = attempt.answers[q.id];
                        const isCorrect = userAns === q.answer;
                        const isSkipped = userAns === undefined || userAns === null || userAns === 0;
                        const explanationOpen = !!openExplanations[q.id];

                        return (
                            <div key={q.id} style={{
                                background: 'white', padding: '1.5rem', borderRadius: '12px',
                                border: '1px solid', borderColor: isCorrect ? '#e2e8f0' : '#fecaca',
                                position: 'relative'
                            }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '1rem' }}>
                                    <span style={{ fontWeight: 700, fontSize: '1.1rem', color: isCorrect ? '#0f172a' : '#ef4444' }}>
                                        문항 {q.number}
                                    </span>
                                    <span style={{
                                        fontWeight: 600, fontSize: '0.9rem',
                                        color: isCorrect ? '#16a34a' : '#dc2626'
                                    }}>
                                        {isCorrect ? "정답" : isSkipped ? "미응답" : "오답"}
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
                                            <span style={{ fontWeight: 700, color: '#ef4444' }}>
                                                {isSkipped ? '(미응답)' : `${userAns}번`}
                                            </span>
                                            {q.answer !== undefined && (
                                                <>
                                                    <span style={{ color: '#94a3b8', margin: '0 0.5rem' }}>·</span>
                                                    <span style={{ color: '#64748b', marginRight: '0.5rem' }}>정답:</span>
                                                    <span style={{ fontWeight: 700, color: '#16a34a' }}>{q.answer}번</span>
                                                </>
                                            )}
                                        </div>
                                    )}
                                </div>

                                {q.label && (
                                    <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem' }}>
                                        <span style={{ fontSize: '0.75rem', padding: '2px 8px', borderRadius: '4px', background: '#f1f5f9', color: '#64748b' }}>
                                            #{q.label}
                                        </span>
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
