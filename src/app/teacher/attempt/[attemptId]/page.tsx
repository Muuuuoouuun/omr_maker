"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import dynamic from "next/dynamic";
import { PenLine } from "lucide-react";
import { gradeAttempt } from "@/types/omr";
import type { Attempt, Exam, PdfDrawings } from "@/types/omr";
import { loadJsonRecord, storedDataUrlToFile } from "@/utils/blobStore";
import { getPlanLabel } from "@/utils/plans";

const PDFViewer = dynamic(() => import("@/components/PDFViewer"), { ssr: false });

function hasTeacherAccess(): boolean {
    if (typeof window === "undefined") return false;
    return !!sessionStorage.getItem("omr_teacher_token");
}

function hasDrawings(drawings?: PdfDrawings): boolean {
    return !!drawings && Object.values(drawings).some(paths => paths.length > 0);
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
    const [loaded, setLoaded] = useState(false);

    useEffect(() => {
        let cancelled = false;
        queueMicrotask(() => {
            if (!hasTeacherAccess()) {
                setAccessDenied(true);
                setLoaded(true);
                return;
            }

            try {
                const attemptsRaw = localStorage.getItem("omr_attempts");
                const attempts = attemptsRaw ? JSON.parse(attemptsRaw) as Attempt[] : [];
                const found = attempts.find(a => a.id === id);
                if (!found || cancelled) {
                    setLoaded(true);
                    return;
                }

                setAttempt(found);

                const examRaw = localStorage.getItem(`omr_exam_${found.examId}`);
                if (examRaw) {
                    const parsedExam = JSON.parse(examRaw) as Exam;
                    setExam(parsedExam);
                    storedDataUrlToFile("problem.pdf", parsedExam.pdfData, parsedExam.pdfDataRef)
                        .then(file => {
                            if (!cancelled && file) setPdfFile(file);
                        })
                        .catch(() => {
                            if (!cancelled) setPdfFile(null);
                        });
                }

                const drawingsRef = found.handwriting?.strokesRef || found.drawingsRef;
                if (found.handwritingArchived && drawingsRef) {
                    loadJsonRecord<PdfDrawings>(drawingsRef)
                        .then(restored => {
                            if (cancelled) return;
                            if (restored) setDrawings(restored);
                            else setHandwritingUnavailable(true);
                        })
                        .catch(() => {
                            if (!cancelled) setHandwritingUnavailable(true);
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
        });

        return () => { cancelled = true; };
    }, [id]);

    const stats = useMemo(() => {
        if (!attempt || !exam) return null;
        return gradeAttempt(exam.questions, attempt.answers);
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

    const percent = stats && stats.totalScore > 0 ? Math.round((stats.earnedScore / stats.totalScore) * 100) : 0;
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
                            <div style={{ fontSize: '0.78rem', color: '#64748b' }}>{attempt.studentName} · {new Date(attempt.finishedAt).toLocaleString('ko-KR')}</div>
                        </div>
                    </div>
                    <Link href={`/teacher/exam/${attempt.examId}`} className="btn btn-secondary" style={{ fontSize: '0.85rem' }}>
                        시험 결과로
                    </Link>
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
                                {attempt.score} / {attempt.totalScore}점
                            </div>
                            {stats && (
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.45rem', marginTop: '1rem' }}>
                                    <SmallStat label="정답" value={stats.correctCount} color="#16a34a" />
                                    <SmallStat label="오답" value={stats.incorrectCount} color="#dc2626" />
                                    <SmallStat label="미응답" value={stats.unansweredCount} color="#64748b" />
                                </div>
                            )}
                        </div>

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
