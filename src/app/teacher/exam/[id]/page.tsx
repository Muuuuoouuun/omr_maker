"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Exam, Attempt } from "@/types/omr";
import StatCard from "@/components/dashboard/StatCard";

export default function ExamDetailPage() {
    const params = useParams();
    const router = useRouter();
    const id = params?.id as string;

    const [exam, setExam] = useState<Exam | null>(null);
    const [attempts, setAttempts] = useState<Attempt[]>([]);
    const [stats, setStats] = useState({
        avgScore: 0,
        maxScore: 0,
        submitCount: 0
    });

    useEffect(() => {
        if (!id) return;

        // Load Exam
        const examData = localStorage.getItem(`omr_exam_${id}`);
        if (examData) {
            setExam(JSON.parse(examData));
        }

        // Load Attempts for this exam
        const allAttemptsStr = localStorage.getItem("omr_attempts");
        if (allAttemptsStr) {
            const allAttempts: Attempt[] = JSON.parse(allAttemptsStr);
            const examAttempts = allAttempts.filter(a => a.examId === id);
            setAttempts(examAttempts);

            // Calculate Stats
            if (examAttempts.length > 0) {
                const total = examAttempts.reduce((acc, curr) => acc + curr.score, 0);
                const max = Math.max(...examAttempts.map(a => a.score));

                // Assuming all attempts have same totalScore (from the exam)
                // If not, we should use percentage. Let's use raw score here.
                setStats({
                    avgScore: parseFloat((total / examAttempts.length).toFixed(1)),
                    maxScore: max,
                    submitCount: examAttempts.length
                });
            }
        }
    }, [id]);

    if (!exam) return <div style={{ padding: '2rem' }}>Loading...</div>;

    return (
        <div className="layout-main" style={{ background: '#f8fafc', minHeight: '100vh' }}>
            <header className="header" style={{ borderBottom: '1px solid var(--border)' }}>
                <div className="container header-content">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                        <button onClick={() => router.back()} style={{ fontSize: '1.2rem' }}>←</button>
                        <span style={{ fontWeight: 700 }}>{exam.title}</span>
                    </div>
                </div>
            </header>

            <main className="container animate-fade-in" style={{ padding: '2rem 1rem' }}>

                {/* Stats Row */}
                <div className="bento-grid" style={{ marginBottom: '2rem', gridTemplateColumns: 'repeat(3, 1fr)', gridAutoRows: 'auto' }}>
                    <StatCard title="Submissions" value={stats.submitCount} icon={<span>📝</span>} />
                    <StatCard title="Average Score" value={stats.avgScore} icon={<span>📊</span>} color="var(--primary)" />
                    <StatCard title="Highest Score" value={stats.maxScore} icon={<span>🏆</span>} color="var(--warning)" />
                </div>

                {/* Students Table */}
                <div className="bento-card" style={{ padding: '0', overflow: 'hidden' }}>
                    <div style={{ padding: '1.5rem', borderBottom: '1px solid var(--border)' }}>
                        <h3 style={{ fontSize: '1.1rem', fontWeight: 700 }}>Student Results</h3>
                    </div>

                    <div style={{ overflowX: 'auto' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
                            <thead style={{ background: '#f8fafc', borderBottom: '1px solid var(--border)' }}>
                                <tr>
                                    <th style={{ padding: '1rem', textAlign: 'left', color: 'var(--muted)' }}>Student</th>
                                    <th style={{ padding: '1rem', textAlign: 'left', color: 'var(--muted)' }}>Score</th>
                                    <th style={{ padding: '1rem', textAlign: 'left', color: 'var(--muted)' }}>Time</th>
                                    <th style={{ padding: '1rem', textAlign: 'left', color: 'var(--muted)' }}>Status</th>
                                    <th style={{ padding: '1rem', textAlign: 'right', color: 'var(--muted)' }}>Action</th>
                                </tr>
                            </thead>
                            <tbody>
                                {attempts.length === 0 ? (
                                    <tr>
                                        <td colSpan={5} style={{ padding: '3rem', textAlign: 'center', color: 'var(--muted)' }}>
                                            No submissions yet.
                                        </td>
                                    </tr>
                                ) : (
                                    attempts.map(attempt => (
                                        <tr key={attempt.id} style={{ borderBottom: '1px solid var(--border)' }}>
                                            <td style={{ padding: '1rem', fontWeight: 600 }}>{attempt.studentName || 'Anonymous'}</td>
                                            <td style={{ padding: '1rem' }}>
                                                <span style={{ fontWeight: 700, color: 'var(--foreground)' }}>{attempt.score}</span>
                                                <span style={{ color: 'var(--muted)', fontSize: '0.8rem' }}> / {attempt.totalScore}</span>
                                            </td>
                                            <td style={{ padding: '1rem', color: 'var(--muted)' }}>
                                                {new Date(attempt.finishedAt).toLocaleString()}
                                            </td>
                                            <td style={{ padding: '1rem' }}>
                                                <span style={{
                                                    padding: '2px 8px', borderRadius: '4px', fontSize: '0.8rem', fontWeight: 600,
                                                    background: '#dcfce7', color: '#166534'
                                                }}>
                                                    Completed
                                                </span>
                                            </td>
                                            <td style={{ padding: '1rem', textAlign: 'right' }}>
                                                <Link
                                                    href={`/student/review/${attempt.id}`}
                                                    className="btn btn-secondary"
                                                    style={{ padding: '0.3rem 0.8rem', fontSize: '0.8rem' }}
                                                >
                                                    View OMR
                                                </Link>
                                            </td>
                                        </tr>
                                    ))
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>

            </main>
        </div>
    );
}
