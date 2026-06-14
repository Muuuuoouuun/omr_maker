"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import TeacherHeader from "@/components/TeacherHeader";
import { Activity, Users, CheckCircle2, Clock, AlertTriangle, Bell, PlayCircle, PauseCircle } from "lucide-react";
import { toast } from "@/components/Toast";
import type { Exam, Attempt } from "@/types/omr";
import { loadAttempts, loadExams } from "@/lib/omrPersistence";

type StudentStatus = "submitted" | "in_progress" | "not_started";

interface LiveStudent {
    id: string;
    name: string;
    avatar: string;
    status: StudentStatus;
    progress: number; // 0-100
    currentQ: number;
    totalQ: number;
    startedAt?: string;
    score?: number;
}

interface LiveExam {
    id: string;
    title: string;
    total: number;
    duration: number;
    questions?: { id: number; answer?: number }[];
}

const MOCK_EXAMS: LiveExam[] = [
    { id: "ex1", title: "Midterm English Test", total: 35, duration: 60 },
    { id: "ex2", title: "Chapter 4 Mathematics", total: 32, duration: 45 },
    { id: "ex3", title: "Science Pop Quiz", total: 30, duration: 20 },
];

const AVATAR_COLORS = ["#4f46e5", "#ec4899", "#8b5cf6", "#10b981", "#f59e0b", "#0ea5e9"];

const MOCK_FIRST_NAMES = ["민준", "서연", "도윤", "예은", "하준", "지우", "시우", "수아", "재윤", "유나", "건우", "하윤", "지호", "서아", "선우", "지민", "윤서", "태호", "예준", "채원", "주원", "은서", "이준", "리아", "연우", "서현", "다은", "승우", "세은", "현우", "채은", "준서", "하린", "도현", "지안"];

function hashString(str: string): number {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
        h = ((h << 5) - h) + str.charCodeAt(i);
        h |= 0;
    }
    return Math.abs(h);
}

function pickAvatar(name: string): string {
    return AVATAR_COLORS[hashString(name) % AVATAR_COLORS.length];
}

function countAnsweredEntries(answers: Record<number, number> | undefined): number {
    if (!answers) return 0;
    let c = 0;
    for (const k in answers) {
        const v = answers[k];
        if (v !== undefined && v !== null && v !== 0) c++;
    }
    return c;
}

function attemptToStudent(a: Attempt, totalQ: number): LiveStudent {
    const status: StudentStatus =
        a.status === "completed" ? "submitted" :
        a.status === "in_progress" ? "in_progress" : "not_started";
    const answered = countAnsweredEntries(a.answers);
    const name = a.studentName || "Student";
    const progress =
        status === "submitted" ? 100 :
        status === "in_progress" ? (totalQ > 0 ? Math.round((answered / totalQ) * 100) : 0) : 0;
    const score =
        status === "submitted" && a.totalScore > 0
            ? Math.round((a.score / a.totalScore) * 100)
            : undefined;
    return {
        id: a.id,
        name,
        avatar: pickAvatar(name + a.id),
        status,
        progress,
        currentQ: answered,
        totalQ,
        startedAt: a.startedAt,
        score,
    };
}

function genSyntheticStudents(count: number, totalQ: number, startIdx: number): LiveStudent[] {
    const out: LiveStudent[] = [];
    for (let i = 0; i < count; i++) {
        const idx = startIdx + i;
        const seed = (idx * 9301 + 49297) % 233280;
        const r = seed / 233280;
        const status: StudentStatus = r < 0.35 ? "submitted" : r < 0.8 ? "in_progress" : "not_started";
        const progress =
            status === "submitted" ? 100 :
            status === "in_progress" ? Math.round(20 + ((seed % 70))) : 0;
        const currentQ = totalQ > 0 ? Math.ceil((progress / 100) * totalQ) : 0;
        const name = MOCK_FIRST_NAMES[idx % MOCK_FIRST_NAMES.length] + (idx >= MOCK_FIRST_NAMES.length ? "2" : "");
        out.push({
            id: `synthetic-${idx}`,
            name,
            avatar: pickAvatar(name + idx),
            status,
            progress,
            currentQ,
            totalQ,
            startedAt: status !== "not_started" ? new Date(Date.now() - (seed % 1800) * 1000).toISOString() : undefined,
            score: status === "submitted" ? Math.round(50 + (seed % 50)) : undefined,
        });
    }
    return out;
}

function examToLiveExam(exam: Exam): LiveExam {
    const questions = Array.isArray(exam.questions) ? exam.questions : [];
    return {
        id: exam.id,
        title: exam.title,
        total: questions.length,
        duration: exam.durationMin || 60,
        questions: questions.map(q => ({ id: q.id, answer: q.answer })),
    };
}

const MIN_STUDENT_CARDS = 8;

export default function LiveResultsPage() {
    const [exams, setExams] = useState<LiveExam[]>(MOCK_EXAMS);
    const [attempts, setAttempts] = useState<Attempt[]>([]);
    const [selectedExamId, setSelectedExamId] = useState<string>(MOCK_EXAMS[0].id);
    const [, setTick] = useState(0);
    const [timerSeconds, setTimerSeconds] = useState(38 * 60 + 24);
    const [isPaused, setIsPaused] = useState(false);
    // Synthetic students per exam — mutable state so they can "progress" over time
    const [syntheticByExam, setSyntheticByExam] = useState<Record<string, LiveStudent[]>>({});

    const refreshFromStorage = useCallback(async () => {
        const [examResult, attemptResult] = await Promise.all([
            loadExams(),
            loadAttempts(),
        ]);
        const loaded = examResult.items.map(examToLiveExam);
        const effective = loaded.length > 0 ? loaded : MOCK_EXAMS;
        setExams(effective);
        setAttempts(attemptResult.items);
        setSelectedExamId(prev => effective.some(e => e.id === prev) ? prev : effective[0].id);
    }, []);

    // Initial load + adjust selected exam if real exams found
    useEffect(() => {
        let cancelled = false;
        const loadInitial = async () => {
            const [examResult, attemptResult] = await Promise.all([
                loadExams(),
                loadAttempts(),
            ]);
            if (cancelled) return;
            const loaded = examResult.items.map(examToLiveExam);
            const effective = loaded.length > 0 ? loaded : MOCK_EXAMS;
            setExams(effective);
            setAttempts(attemptResult.items);
            setSelectedExamId(prev => effective.some(e => e.id === prev) ? prev : effective[0].id);
        };
        void loadInitial();
        return () => { cancelled = true; };
    }, []);

    // Poll every 3s when tab is visible
    useEffect(() => {
        const id = setInterval(() => {
            if (typeof document === "undefined" || document.visibilityState === "visible") {
                void refreshFromStorage();
            }
        }, 3000);
        return () => clearInterval(id);
    }, [refreshFromStorage]);

    const exam = exams.find(e => e.id === selectedExamId) ?? exams[0] ?? MOCK_EXAMS[0];

    const examAttempts = useMemo(
        () => attempts.filter(a => a && a.examId === exam.id),
        [attempts, exam.id]
    );

    // Initialize synthetic students for this exam if not yet seeded
    useEffect(() => {
        // Seed derived display-only data once the selected exam is known.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setSyntheticByExam(prev => {
            if (prev[exam.id]) return prev;
            const real = examAttempts.map(a => attemptToStudent(a, exam.total));
            const needed = Math.max(MIN_STUDENT_CARDS - real.length, 0);
            if (needed === 0) return prev;
            return { ...prev, [exam.id]: genSyntheticStudents(needed, exam.total || 20, real.length) };
        });
    }, [exam.id, exam.total, examAttempts]);

    // Advance synthetic students every 3s when not paused — makes "Live" feel live
    useEffect(() => {
        if (isPaused) return;
        const id = setInterval(() => {
            setSyntheticByExam(prev => {
                const list = prev[exam.id];
                if (!list || list.length === 0) return prev;
                const totalQ = exam.total || 20;
                const next = list.map(s => {
                    if (s.status === "in_progress" && Math.random() < 0.45) {
                        const inc = Math.floor(5 + Math.random() * 12);
                        const newProgress = Math.min(100, s.progress + inc);
                        const newQ = Math.max(s.currentQ, Math.ceil((newProgress / 100) * totalQ));
                        if (newProgress >= 100) {
                            return {
                                ...s,
                                status: "submitted" as const,
                                progress: 100,
                                currentQ: totalQ,
                                score: Math.round(50 + Math.random() * 50),
                            };
                        }
                        return { ...s, progress: newProgress, currentQ: newQ };
                    }
                    if (s.status === "not_started" && Math.random() < 0.18) {
                        return {
                            ...s,
                            status: "in_progress" as const,
                            progress: Math.floor(5 + Math.random() * 15),
                            currentQ: 1,
                            startedAt: new Date().toISOString(),
                        };
                    }
                    return s;
                });
                return { ...prev, [exam.id]: next };
            });
        }, 3000);
        return () => clearInterval(id);
    }, [exam.id, exam.total, isPaused]);

    const students = useMemo<LiveStudent[]>(() => {
        const totalQ = exam.total;
        const real = examAttempts.map(a => attemptToStudent(a, totalQ));
        if (real.length >= MIN_STUDENT_CARDS) return real;
        const synthetic = syntheticByExam[exam.id] ?? [];
        return [...real, ...synthetic];
    }, [examAttempts, exam.id, exam.total, syntheticByExam]);

    useEffect(() => {
        const id = setInterval(() => {
            setTick(t => t + 1);
            if (!isPaused) setTimerSeconds(s => Math.max(0, s - 1));
        }, 1000);
        return () => clearInterval(id);
    }, [isPaused]);

    const counts = {
        submitted: students.filter(s => s.status === "submitted").length,
        inProgress: students.filter(s => s.status === "in_progress").length,
        notStarted: students.filter(s => s.status === "not_started").length,
    };
    const submittedStudents = students.filter(s => s.status === "submitted");
    const avgScore = submittedStudents.length > 0
        ? Math.round(submittedStudents.reduce((a, s) => a + (s.score || 0), 0) / submittedStudents.length)
        : 0;

    // Question heatmap:
    // - If we have real submitted attempts with answer data, derive accuracy from them.
    // - Otherwise, simulate realistic per-question accuracy from the count of submitted
    //   (real + synthetic) students, with a deterministic per-question baseline so the
    //   heatmap "stabilizes" as more students submit instead of jumping randomly.
    const heatmap = useMemo(() => {
        const questions = exam.questions ?? [];
        const submittedReal = examAttempts.filter(a => a.status === "completed");
        const submittedAll = students.filter(s => s.status === "submitted");
        const totalReal = submittedReal.length;
        const totalAll = submittedAll.length;
        const qList = questions.length > 0
            ? questions
            : Array.from({ length: exam.total || 20 }, (_, i) => ({ id: i + 1, answer: undefined as number | undefined }));

        return qList.map((q, i) => {
            // Path 1: real attempts with known correct answers
            if (totalReal > 0 && q.answer !== undefined && q.answer !== null) {
                let correct = 0;
                for (const a of submittedReal) {
                    const selected = a.answers ? a.answers[q.id] : undefined;
                    if (selected !== undefined && selected === q.answer) correct++;
                }
                return { q: i + 1, correct, total: totalReal };
            }

            // Path 2: synthetic — deterministic baseline per question (35%..90%)
            const seed = hashString(`${exam.id}:${i + 1}`);
            const baseline = 35 + (seed % 56); // 35..90
            const correct = Math.round((baseline / 100) * Math.max(totalAll, 1));
            return { q: i + 1, correct, total: Math.max(totalAll, 1) };
        });
    }, [examAttempts, exam.questions, exam.total, exam.id, students]);

    const mm = Math.floor(timerSeconds / 60).toString().padStart(2, "0");
    const ss = (timerSeconds % 60).toString().padStart(2, "0");

    // Handlers for timer-bar actions
    const handleExtendTime = () => {
        setTimerSeconds(s => s + 300);
        toast.success("시간 5분 연장됨");
    };

    const handleForceFinish = () => {
        if (typeof window === "undefined") return;
        const ok = window.confirm("모든 학생의 시험을 지금 종료하시겠습니까?");
        if (!ok) return;
        setSyntheticByExam(prev => {
            const list = prev[exam.id];
            if (!list) return prev;
            const totalQ = exam.total || 20;
            const next = list.map(s => {
                if (s.status === "submitted") return s;
                const progress = s.progress;
                const score = Math.max(0, Math.round((progress / 100) * 100));
                return {
                    ...s,
                    status: "submitted" as const,
                    progress,
                    currentQ: Math.max(s.currentQ, Math.ceil((progress / 100) * totalQ)),
                    score,
                };
            });
            return { ...prev, [exam.id]: next };
        });
        setTimerSeconds(0);
        setIsPaused(true);
        toast.success("시험 강제 종료됨");
    };

    const handleNotifyNotStarted = () => {
        const n = counts.notStarted;
        toast.success(`${n}명에게 독려 알림을 발송했습니다`);
    };

    return (
        <div className="layout-main">
            <div className="orb orb-primary" />
            <div className="orb orb-secondary" />
            <TeacherHeader badge="LIVE" badgeColor="#ef4444" />

            <main className="container animate-fade-in" style={{ paddingBottom: '4rem', position: 'relative', zIndex: 1 }}>
                {/* Header row */}
                <div style={{ margin: '3rem 0 2rem', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: '2rem', flexWrap: 'wrap' }}>
                    <div>
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
                            <span style={{
                                width: 8, height: 8, borderRadius: '50%', background: '#ef4444',
                                animation: 'pulse 1.4s ease-in-out infinite'
                            }} />
                            <span className="badge" style={{ background: 'rgba(239,68,68,0.1)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.2)' }}>
                                LIVE · 실시간 갱신
                            </span>
                        </div>
                        <h1 className="title-gradient" style={{ fontSize: '2.5rem', marginBottom: '0.5rem', lineHeight: 1.2 }}>
                            실시간 결과
                        </h1>
                        <p className="text-muted" style={{ fontSize: '1.05rem' }}>
                            학생들의 시험 진행 상황을 실시간으로 모니터링하세요.
                        </p>
                    </div>
                    <select
                        value={selectedExamId}
                        onChange={e => setSelectedExamId(e.target.value)}
                        className="input-field"
                        style={{ maxWidth: 340, fontWeight: 600 }}
                    >
                        {exams.map(e => (
                            <option key={e.id} value={e.id}>{e.title}</option>
                        ))}
                    </select>
                </div>

                {/* Timer + actions */}
                <div className="bento-card" style={{
                    background: 'linear-gradient(135deg, #ef4444, #f59e0b)',
                    color: 'white', border: 'none', marginBottom: '1.25rem',
                    position: 'relative', overflow: 'hidden', padding: '1.5rem 2rem'
                }}>
                    <div style={{ position: 'absolute', top: '-30%', right: '-5%', width: 260, height: 260, background: 'radial-gradient(circle, rgba(255,255,255,0.25) 0%, transparent 70%)' }} />
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem', position: 'relative', zIndex: 1 }}>
                        <div>
                            <div style={{ fontSize: '0.8rem', opacity: 0.9, letterSpacing: '0.1em', fontWeight: 700, marginBottom: 6 }}>REMAINING TIME</div>
                            <div style={{ fontSize: '3rem', fontWeight: 900, letterSpacing: '-0.03em', fontVariantNumeric: 'tabular-nums', lineHeight: 1 }}>
                                {mm}:{ss}
                            </div>
                            <div style={{ fontSize: '0.9rem', opacity: 0.9, marginTop: 6 }}>
                                총 {exam.duration}분 · {exam.title}
                            </div>
                        </div>
                        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                            <button
                                onClick={() => setIsPaused(p => !p)}
                                style={{
                                    background: 'rgba(255,255,255,0.18)', color: 'white', padding: '0.75rem 1.25rem',
                                    borderRadius: 'var(--radius-full)', fontSize: '0.9rem', fontWeight: 700,
                                    display: 'flex', alignItems: 'center', gap: '0.5rem',
                                    border: '1px solid rgba(255,255,255,0.25)', backdropFilter: 'blur(10px)'
                                }}
                            >
                                {isPaused ? <PlayCircle size={18} /> : <PauseCircle size={18} />}
                                {isPaused ? '재개' : '일시정지'}
                            </button>
                            <button onClick={handleExtendTime} style={{
                                background: 'rgba(255,255,255,0.18)', color: 'white', padding: '0.75rem 1.25rem',
                                borderRadius: 'var(--radius-full)', fontSize: '0.9rem', fontWeight: 700,
                                display: 'flex', alignItems: 'center', gap: '0.5rem',
                                border: '1px solid rgba(255,255,255,0.25)', backdropFilter: 'blur(10px)'
                            }}>
                                <Clock size={18} /> +5분 연장
                            </button>
                            <button onClick={handleForceFinish} style={{
                                background: 'white', color: '#ef4444', padding: '0.75rem 1.25rem',
                                borderRadius: 'var(--radius-full)', fontSize: '0.9rem', fontWeight: 700,
                                display: 'flex', alignItems: 'center', gap: '0.5rem',
                                boxShadow: '0 4px 14px rgba(0,0,0,0.15)'
                            }}>
                                <AlertTriangle size={18} /> 강제 종료
                            </button>
                        </div>
                    </div>
                </div>

                {/* Stats */}
                <div className="bento-grid" style={{ marginBottom: '1.25rem' }}>
                    <StatTile icon={<CheckCircle2 size={22} />} label="제출 완료" value={counts.submitted} color="#10b981" />
                    <StatTile icon={<Activity size={22} />} label="응시 중" value={counts.inProgress} color="#6366f1" pulse />
                    <StatTile icon={<Clock size={22} />} label="미응시" value={counts.notStarted} color="#ef4444" />
                    <StatTile icon={<Users size={22} />} label="실시간 평균" value={avgScore > 0 ? `${avgScore}점` : "—"} color="#8b5cf6" />
                </div>

                {/* Main grid: Students + Heatmap */}
                <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '1.25rem' }} className="live-grid">
                    {/* Students live view */}
                    <div className="bento-card" style={{ padding: '1.5rem' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
                            <h3 style={{ fontSize: '1.1rem', fontWeight: 700 }}>학생별 실시간 현황</h3>
                            <button onClick={handleNotifyNotStarted} style={{
                                background: 'rgba(239,68,68,0.1)', color: '#ef4444', padding: '0.5rem 1rem',
                                borderRadius: 'var(--radius-full)', fontSize: '0.8rem', fontWeight: 700,
                                display: 'flex', alignItems: 'center', gap: '0.4rem', border: '1px solid rgba(239,68,68,0.2)'
                            }}>
                                <Bell size={14} /> 미응시자 알림
                            </button>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '0.8rem' }}>
                            {students.map((s, idx) => (
                                <StudentCard key={s.id} student={s} delay={idx * 20} />
                            ))}
                        </div>
                    </div>

                    {/* Question heatmap */}
                    <div className="bento-card" style={{ padding: '1.5rem' }}>
                        <h3 style={{ fontSize: '1.1rem', fontWeight: 700, marginBottom: '0.25rem' }}>문항별 정답률</h3>
                        <p style={{ fontSize: '0.8rem', color: 'var(--muted)', marginBottom: '1.25rem' }}>제출 완료한 {submittedStudents.length}명 기준</p>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.5rem' }}>
                            {heatmap.map(h => {
                                const pct = Math.round((h.correct / h.total) * 100) || 0;
                                const color = pct >= 75 ? '#10b981' : pct >= 50 ? '#f59e0b' : '#ef4444';
                                const bg = pct >= 75 ? 'rgba(16,185,129,0.12)' : pct >= 50 ? 'rgba(245,158,11,0.12)' : 'rgba(239,68,68,0.12)';
                                return (
                                    <div key={h.q} style={{
                                        padding: '0.75rem 0.5rem', background: bg, borderRadius: 'var(--radius-md)',
                                        textAlign: 'center', border: `1px solid ${color}33`,
                                        transition: 'var(--transition-base)', cursor: 'default'
                                    }}
                                        title={`Q${h.q}: ${pct}%`}
                                    >
                                        <div style={{ fontSize: '0.7rem', color: 'var(--muted)', fontWeight: 700 }}>Q{h.q}</div>
                                        <div style={{ fontSize: '1rem', fontWeight: 800, color }}>{pct}%</div>
                                    </div>
                                );
                            })}
                        </div>

                        <div style={{ marginTop: '1.5rem', padding: '1rem', background: 'var(--background)', borderRadius: 'var(--radius-md)', border: '1px dashed var(--border)' }}>
                            <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.08em', marginBottom: '0.5rem' }}>⚠️ 주의 문항</div>
                            {heatmap.filter(h => (h.correct / h.total) * 100 < 45).slice(0, 3).map(h => (
                                <div key={h.q} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', padding: '0.35rem 0' }}>
                                    <span style={{ fontWeight: 600 }}>Q{h.q}</span>
                                    <span style={{ color: '#ef4444', fontWeight: 700 }}>{Math.round((h.correct / h.total) * 100)}%</span>
                                </div>
                            ))}
                            {heatmap.filter(h => (h.correct / h.total) * 100 < 45).length === 0 && (
                                <div style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>현재까진 양호합니다 ✨</div>
                            )}
                        </div>
                    </div>
                </div>
            </main>

            <style>{`
                @media (max-width: 1024px) {
                    .live-grid { grid-template-columns: 1fr !important; }
                }
            `}</style>
        </div>
    );
}

function StatTile({ icon, label, value, color, pulse }: { icon: React.ReactNode; label: string; value: string | number; color: string; pulse?: boolean }) {
    return (
        <div className="bento-card" style={{ padding: '1.25rem 1.4rem', position: 'relative', overflow: 'hidden' }}>
            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, background: `linear-gradient(90deg, ${color}, transparent)` }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
                <div>
                    <div style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '0.5rem' }}>{label}</div>
                    <div style={{ fontSize: '2rem', fontWeight: 900, letterSpacing: '-0.03em', fontVariantNumeric: 'tabular-nums', color: 'var(--foreground)' }}>{value}</div>
                </div>
                <div style={{
                    color, background: `color-mix(in srgb, ${color}, transparent 88%)`,
                    padding: 10, borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    animation: pulse ? 'pulse 2s ease-in-out infinite' : undefined
                }}>{icon}</div>
            </div>
        </div>
    );
}

function StudentCard({ student, delay }: { student: LiveStudent; delay: number }) {
    const statusMeta: Record<StudentStatus, { color: string; bg: string; label: string }> = {
        submitted: { color: '#10b981', bg: 'rgba(16,185,129,0.08)', label: '제출 완료' },
        in_progress: { color: '#6366f1', bg: 'rgba(99,102,241,0.08)', label: '응시 중' },
        not_started: { color: '#94a3b8', bg: 'rgba(148,163,184,0.08)', label: '미응시' },
    };
    const meta = statusMeta[student.status];

    return (
        <div style={{
            padding: '0.9rem', background: meta.bg, borderRadius: 'var(--radius-md)',
            border: `1px solid ${meta.color}22`, animation: `fadeIn 0.3s ${delay}ms both`,
            transition: 'var(--transition-base)', cursor: 'pointer'
        }}
            className="card-hover"
        >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.6rem' }}>
                <div style={{
                    width: 32, height: 32, borderRadius: '50%', background: student.avatar,
                    color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '0.75rem', fontWeight: 700
                }}>{student.name.slice(0, 1)}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--foreground)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{student.name}</div>
                    <div style={{ fontSize: '0.7rem', color: meta.color, fontWeight: 700 }}>{meta.label}</div>
                </div>
                {student.score !== undefined && (
                    <div style={{ fontSize: '0.95rem', fontWeight: 800, color: meta.color }}>{student.score}</div>
                )}
            </div>
            <div style={{ height: 5, background: 'var(--border)', borderRadius: 'var(--radius-full)', overflow: 'hidden' }}>
                <div style={{ width: `${student.progress}%`, height: '100%', background: meta.color, borderRadius: 'var(--radius-full)', transition: 'width 0.6s ease-out' }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.7rem', color: 'var(--muted)', marginTop: '0.4rem', fontWeight: 600 }}>
                <span>{student.currentQ}/{student.totalQ} 문항</span>
                <span>{student.progress}%</span>
            </div>
        </div>
    );
}
