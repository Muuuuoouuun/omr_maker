"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Exam, Attempt } from "@/types/omr";
import AssignmentBlock from "@/components/dashboard/AssignmentBlock";

import { mergeGuestAttempts } from "@/utils/storage";

export default function StudentDashboard() {
    const router = useRouter();
    const [user, setUser] = useState<{ name: string; groupId: string; groupName: string; isGuest?: boolean; guestId?: string } | null>(null);
    const [todoExams, setTodoExams] = useState<Exam[]>([]);
    const [doneExams, setDoneExams] = useState<(Exam & { attemptId: string })[]>([]);
    const [stats, setStats] = useState({
        avgScore: 0,
        completedCount: 0
    });

    useEffect(() => {
        // 1. Check Session (Simulated)
        const session = sessionStorage.getItem("omr_student_session");
        if (!session) {
            alert("로그인이 필요합니다.");
            router.push("/");
            return;
        }
        const currentUser = JSON.parse(session);
        setUser(currentUser);

        // 2. Load Data
        const allExams: Exam[] = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key?.startsWith("omr_exam_")) {
                try {
                    allExams.push(JSON.parse(localStorage.getItem(key) || ""));
                } catch (e) { }
            }
        }

        const allAttempts: Attempt[] = JSON.parse(localStorage.getItem("omr_attempts") || "[]");

        // Filter attempts: by guestId if guest, or by name if logged in
        // In a real app, we'd use IDs for everything.
        const myAttempts = allAttempts.filter(a => {
            if (currentUser.isGuest) {
                return a.guestId === currentUser.guestId;
            } else {
                return a.studentName === currentUser.name;
                // Note: IF we just merged, we might want to also check matches that WERE guestIds? 
                // For now, assume merge updates studentName.
            }
        });

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
            else if (exam.accessConfig?.groupIds?.includes(currentUser.groupId)) hasAccess = true;

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
        const totalScore = myAttempts.reduce((acc, curr) => acc + (curr.score / curr.totalScore) * 100, 0);
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
        const newSession = {
            name: name,
            groupId: "group-1", // mock group
            groupName: "Class A",
            isGuest: false
        };

        // 2. Perform Merge
        if (user?.guestId) {
            mergeGuestAttempts(user.guestId, name);
            alert(`History merged to ${name}!`);
        }

        sessionStorage.setItem("omr_student_session", JSON.stringify(newSession));
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
                    <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem' }}>
                        <span style={{ fontWeight: 600, fontSize: '0.95rem' }}>
                            {user.name} <span style={{ color: 'var(--muted)', fontWeight: 400 }}>({user.groupName})</span>
                        </span>
                        <button onClick={() => {
                            if (confirm("Logout?")) {
                                sessionStorage.removeItem("omr_student_session");
                                router.push("/");
                            }
                        }} style={{ fontSize: '0.9rem', color: 'var(--muted)', cursor: 'pointer', transition: 'color 0.2s', fontWeight: 500 }}>
                            Logout
                        </button>
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
                    <h1 className="title-gradient" style={{ fontSize: '2.5rem', marginBottom: '0.75rem', lineHeight: 1.2 }}>
                        Hello, {user.name}! 👋
                    </h1>
                    <p className="text-muted" style={{ fontSize: '1.1rem' }}>
                        You have <strong style={{ color: 'var(--primary)', fontWeight: 700 }}>{todoExams.length}</strong> assignments pending today.
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
                        <div style={{ fontSize: '0.95rem', fontWeight: 600, opacity: 0.9, marginBottom: '0.5rem' }}>My Average</div>
                        <div style={{ fontSize: '3rem', fontWeight: 800, lineHeight: 1 }}>{stats.avgScore}</div>
                        <div style={{ fontSize: '0.85rem', opacity: 0.8, marginTop: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            View Details <span>→</span>
                        </div>
                    </Link>

                    <div className="bento-card col-span-1" style={{ justifyContent: 'center', alignItems: 'center', background: 'var(--surface)' }}>
                        <div style={{ fontSize: '3rem', fontWeight: 800, color: 'var(--foreground)', lineHeight: 1, marginBottom: '0.5rem' }}>
                            {stats.completedCount}
                        </div>
                        <div style={{ color: 'var(--muted)', fontSize: '0.9rem', fontWeight: 600 }}>Exams Completed</div>
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
