"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Exam } from "@/types/omr";
import AssignmentBlock from "@/components/dashboard/AssignmentBlock";
import ThemeToggle from "@/components/ThemeToggle";
import { Sparkles, Award } from "lucide-react";

import {
    attemptMatchesSession,
    getSession,
    loadAllExams,
    loadAttempts,
    makeStudentId,
    mergeGuestAttempts,
    saveSession,
    scorePercent,
    type StudentSession,
} from "@/utils/storage";

function getTimeGreeting(): string {
    const h = new Date().getHours();
    if (h < 6) return "늦은 밤이네요";
    if (h < 12) return "좋은 아침이에요";
    if (h < 18) return "오늘도 수고하세요";
    return "좋은 저녁이에요";
}

export default function StudentDashboard() {
    const router = useRouter();
    const [user, setUser] = useState<StudentSession | null>(null);
    const [todoExams, setTodoExams] = useState<Exam[]>([]);
    const [doneExams, setDoneExams] = useState<(Exam & { attemptId: string })[]>([]);
    const [stats, setStats] = useState({
        avgScore: 0,
        completedCount: 0
    });

    useEffect(() => {
        const currentUser = getSession();
        if (!currentUser) {
            alert("로그인이 필요합니다.");
            router.push("/");
            return;
        }
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setUser(currentUser);

        const allExams = loadAllExams();
        const allAttempts = loadAttempts();
        const myAttempts = allAttempts.filter(a => attemptMatchesSession(a, currentUser));

        // 3. Categorize Exams
        const done: (Exam & { attemptId: string })[] = [];
        const todo: Exam[] = [];

        allExams.forEach(exam => {
            // Check Access
            let hasAccess = false;
            // Public exams are accessible to everyone
            if (exam.accessConfig?.type === 'public') hasAccess = true;
            // Group exams check if user's group is in the list. Guests only see public.
            else if (currentUser.isGuest) hasAccess = false;
            else if (currentUser.groupId && exam.accessConfig?.groupIds?.includes(currentUser.groupId)) hasAccess = true;

            if (!hasAccess) return;

            // Check if completed
            const attempt = myAttempts.find(a => a.examId === exam.id);
            if (attempt) {
                done.push({ ...exam, attemptId: attempt.id });
            } else {
                todo.push(exam);
            }
        });

        setTodoExams(todo);
        setDoneExams(done);

        // 4. Calculate Stats
        const totalScore = myAttempts.reduce((acc, curr) => acc + scorePercent(curr), 0);
        const avg = myAttempts.length > 0 ? Math.round(totalScore / myAttempts.length) : 0;
        setStats({
            avgScore: avg,
            completedCount: myAttempts.length
        });

    }, [router]);

    const handleMergeAccount = () => {
        // Mocking a flow where guest logs in
        const name = prompt("Enter your name to sign up/login:");
        if (!name) return;

        // 1. Simulate new session
        const trimmedName = name.trim();
        const groupId = "group-1";
        const newSession: StudentSession = {
            name: trimmedName,
            studentId: makeStudentId(trimmedName, groupId),
            groupId,
            groupName: "Class A",
            isGuest: false
        };

        // 2. Perform Merge
        if (user?.guestId) {
            mergeGuestAttempts(user.guestId, trimmedName, newSession.studentId);
            alert(`History merged to ${trimmedName}!`);
        }

        saveSession(newSession);
        window.location.reload(); // Reload to refresh data
    };

    if (!user) return <div style={{ padding: '2rem' }}>Loading...</div>;

    return (
        <div className="layout-main">
            <header className="header">
                <div className="container header-content">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                        <Link href="/" className="logo">OMR Maker</Link>
                        <span style={{
                            fontSize: '0.75rem', fontWeight: 700,
                            background: 'rgba(236, 72, 153, 0.1)', color: 'var(--secondary)',
                            padding: '4px 10px', borderRadius: 'var(--radius-full)',
                            border: '1px solid rgba(236, 72, 153, 0.2)'
                        }}>
                            {user.isGuest ? "GUEST" : "STUDENT"}
                        </span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                        <span style={{ fontWeight: 600, fontSize: '0.95rem' }}>
                            {user.name} <span style={{ color: 'var(--muted)', fontWeight: 400 }}>({user.groupName})</span>
                        </span>
                        <button onClick={() => {
                            if (confirm("로그아웃하시겠습니까?")) {
                                sessionStorage.removeItem("omr_student_session");
                                router.push("/");
                            }
                        }} style={{ fontSize: '0.9rem', color: 'var(--muted)', cursor: 'pointer', transition: 'color 0.2s', fontWeight: 500 }}>
                            로그아웃
                        </button>
                        <ThemeToggle />
                    </div>
                </div>
            </header>

            <main className="container animate-fade-in" style={{ paddingBottom: '4rem' }}>

                {/* Guest Banner */}
                {user.isGuest && (
                    <div className="animate-slide-up" style={{
                        margin: '2rem 0 1rem', padding: '1.5rem',
                        background: 'linear-gradient(to right, #4f46e5, #8b5cf6)',
                        borderRadius: 'var(--radius-lg)', color: 'white',
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        boxShadow: '0 10px 25px -5px rgba(79, 70, 229, 0.4)'
                    }}>
                        <div>
                            <h3 style={{ fontSize: '1.2rem', fontWeight: 700, marginBottom: '0.25rem' }}>Save your progress!</h3>
                            <p style={{ opacity: 0.9, fontSize: '0.95rem' }}>Create an account to keep your exam history forever.</p>
                        </div>
                        <button
                            onClick={handleMergeAccount}
                            className="btn"
                            style={{
                                background: 'white', color: 'var(--primary)',
                                fontWeight: 700, border: 'none',
                                padding: '0.75rem 1.5rem', fontSize: '0.95rem'
                            }}
                        >
                            Sign Up & Merge
                        </button>
                    </div>
                )}

                {/* Welcome */}
                <div style={{ margin: '3rem 0' }}>
                    <div style={{
                        display: 'inline-flex', alignItems: 'center', gap: '0.5rem',
                        fontSize: '0.8rem', fontWeight: 700, letterSpacing: '0.04em',
                        color: 'var(--muted)', marginBottom: '0.5rem'
                    }}>
                        <Sparkles size={14} color="var(--primary)" />
                        {getTimeGreeting()}
                    </div>
                    <h1 className="title-gradient" style={{ fontSize: '2.5rem', marginBottom: '0.75rem', lineHeight: 1.2 }}>
                        {user.name}님,
                    </h1>
                    <p className="text-muted" style={{ fontSize: '1.1rem' }}>
                        {todoExams.length > 0 ? (
                            <>오늘 <strong style={{ color: 'var(--primary)', fontWeight: 700 }}>{todoExams.length}개</strong>의 시험이 기다리고 있어요.</>
                        ) : (
                            <>오늘은 예정된 시험이 없습니다. 편안한 하루 보내세요.</>
                        )}
                    </p>
                </div>

                {/* Dashboard Grid */}
                <div className="bento-grid">
                    {/* Stats */}
                    <Link href="/student/history" className="bento-card col-span-1 card-hover" style={{
                        background: 'linear-gradient(135deg, var(--secondary), #f472b6)',
                        color: 'white', border: 'none',
                        display: 'flex', flexDirection: 'column', justifyContent: 'center'
                    }}>
                        <div style={{ fontSize: '0.95rem', fontWeight: 600, opacity: 0.9, marginBottom: '0.5rem' }}>나의 평균 점수</div>
                        <div style={{ fontSize: '3rem', fontWeight: 800, lineHeight: 1 }}>{stats.avgScore}</div>
                        <div style={{ fontSize: '0.85rem', opacity: 0.8, marginTop: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            상세 보기 <span>→</span>
                        </div>
                    </Link>

                    <div className="bento-card col-span-1" style={{ justifyContent: 'center', alignItems: 'center', background: 'var(--surface)', position: 'relative', overflow: 'hidden' }}>
                        <Award size={22} color="var(--primary)" style={{ position: 'absolute', top: 16, right: 16, opacity: 0.6 }} />
                        <div style={{ fontSize: '3rem', fontWeight: 800, color: 'var(--foreground)', lineHeight: 1, marginBottom: '0.5rem' }}>
                            {stats.completedCount}
                        </div>
                        <div style={{ color: 'var(--muted)', fontSize: '0.9rem', fontWeight: 600 }}>완료한 시험</div>
                    </div>

                    {/* Todo List (Main Focus) */}
                    <div className="col-span-2 row-span-2">
                        <AssignmentBlock type="todo" exams={todoExams} />
                    </div>

                    {/* Completed List */}
                    <div className="col-span-2">
                        <AssignmentBlock type="done" exams={doneExams} />
                    </div>
                </div>
            </main>
        </div>
    );
}
