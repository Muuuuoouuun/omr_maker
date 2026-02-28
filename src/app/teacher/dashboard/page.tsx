"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Exam, Attempt } from "@/types/omr";
import OverviewTab from "@/components/dashboard/tabs/OverviewTab";
import ExamAnalyticsTab from "@/components/dashboard/tabs/ExamAnalyticsTab";
import StudentAnalyticsTab from "@/components/dashboard/tabs/StudentAnalyticsTab";
import { LayoutDashboard, BarChart2, GraduationCap } from "lucide-react";

type TabType = 'overview' | 'exam' | 'student';

export default function TeacherDashboard() {
    const [activeTab, setActiveTab] = useState<TabType>('overview');
    const [selectedExamIdForAnalytics, setSelectedExamIdForAnalytics] = useState<string | undefined>(undefined);
    const [exams, setExams] = useState<Exam[]>([]);
    const [attempts, setAttempts] = useState<Attempt[]>([]);
    const [stats, setStats] = useState({
        totalStudents: 0,
        avgScore: 0,
        activeExams: 0
    });
    const [trendData, setTrendData] = useState<number[]>([]);

    useEffect(() => {
        // Load Data
        let loadedExams: Exam[] = [];
        let loadedAttempts: Attempt[] = [];

        // Scan localStorage for exams
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key?.startsWith("omr_exam_")) {
                try {
                    const val = JSON.parse(localStorage.getItem(key) || "");
                    loadedExams.push(val);
                    // eslint-disable-next-line @typescript-eslint/no-unused-vars
                } catch (e) { }
            }
        }
        // Load attempts
        const attemptsStr = localStorage.getItem("omr_attempts");
        if (attemptsStr) {
            try {
                loadedAttempts.push(...JSON.parse(attemptsStr));
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
            } catch (e) { }
        }

        // --- INJECT MOCK DATA FOR DEMONSTRATION IF NEEDED ---
        // Provide rich mock data so that Exam Analytics Tab works nicely with examples
        const MOCK_EXAMS: Exam[] = [
            {
                id: 'mock-1', title: '[예시] Midterm English Test', createdAt: new Date(Date.now() - 86400000 * 2).toISOString(),
                questions: Array.from({ length: 20 }).map((_, i) => ({
                    id: i + 1, number: i + 1, label: i < 5 ? '문법' : (i < 10 ? '독해' : '어휘'), score: 5, answer: 1
                }))
            },
            {
                id: 'mock-2', title: '[예시] Chapter 4 Mathematics', createdAt: new Date(Date.now() - 86400000 * 5).toISOString(),
                questions: Array.from({ length: 15 }).map((_, i) => ({
                    id: i + 1, number: i + 1, label: i < 5 ? '계산' : (i < 10 ? '이해' : '응용'), score: 6.66, answer: 1
                }))
            }
        ];

        // Add mock exams if they aren't duplicates
        MOCK_EXAMS.forEach(mockExam => {
            if (!loadedExams.some(e => e.id === mockExam.id)) {
                loadedExams.push(mockExam);
                // add mock attempts for this exam
                const mockAttempts: Attempt[] = Array.from({ length: 25 }).map((_, i) => ({
                    id: `mock-attempt-${mockExam.id}-${i}`,
                    examId: mockExam.id,
                    examTitle: mockExam.title,
                    studentName: `학생 ${i + 1}`,
                    startedAt: new Date(Date.now() - 86400000 * 1).toISOString(),
                    finishedAt: new Date(Date.now() - 86400000 * 1 + i * 1000).toISOString(),
                    score: mockExam.id === 'mock-1' ? (50 + Math.random() * 50) : (40 + Math.random() * 50),
                    totalScore: 100,
                    status: 'completed',
                    answers: Array.from({ length: mockExam.questions.length }).reduce((acc: Record<number, number>, _, qIdx) => {
                        // 70% random chance to be correct
                        const isCorrect = Math.random() > 0.3;
                        const correctAns = mockExam.questions[qIdx].answer || 1;
                        acc[qIdx + 1] = isCorrect ? correctAns : (correctAns === 1 ? 2 : 1);
                        return acc;
                    }, {})
                }));
                loadedAttempts.push(...mockAttempts);
            }
        });

        // Sort exams by date
        loadedExams.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setExams(loadedExams);
        setAttempts(loadedAttempts);

        // Calculate Stats
        const totalScore = loadedAttempts.reduce((acc, curr) => acc + (curr.score / curr.totalScore) * 100, 0);
        const avg = loadedAttempts.length > 0 ? Math.round(totalScore / loadedAttempts.length) : 0;

        setStats({
            totalStudents: new Set(loadedAttempts.map(a => a.studentName + a.id)).size,
            avgScore: avg,
            activeExams: loadedExams.length
        });

        // Calculate Trend Data (Last N attempts scores)
        const scores = loadedAttempts
            .sort((a, b) => new Date(a.finishedAt).getTime() - new Date(b.finishedAt).getTime())
            .map(a => Math.round((a.score / a.totalScore) * 100))
            .slice(-10);

        if (scores.length < 5) {
            // Mock data with average if not enough
            setTrendData([65, 78, 72, 85, 82, 90, avg || 80]);
        } else {
            setTrendData(scores);
        }

    }, []);

    const handleNavigateToExamAnalytics = (examId: string) => {
        setSelectedExamIdForAnalytics(examId);
        setActiveTab('exam');
    };

    // Tab Navigation Component
    const renderTabs = () => (
        <div style={{
            display: 'flex', gap: '0.5rem', marginBottom: '2rem',
            background: 'var(--surface)', padding: '0.5rem', borderRadius: 'var(--radius-lg)',
            border: '1px solid var(--border)', overflowX: 'auto',
            boxShadow: '0 4px 6px rgba(0,0,0,0.02)'
        }}>
            <button
                onClick={() => setActiveTab('overview')}
                style={{
                    display: 'flex', alignItems: 'center', gap: '0.5rem',
                    padding: '0.75rem 1.5rem', borderRadius: 'var(--radius-md)',
                    background: activeTab === 'overview' ? 'var(--primary)' : 'transparent',
                    color: activeTab === 'overview' ? 'white' : 'var(--muted)',
                    fontWeight: activeTab === 'overview' ? 700 : 500,
                    transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)', flex: 1, justifyContent: 'center', whiteSpace: 'nowrap'
                }}
            >
                <LayoutDashboard size={18} />
                대시보드 요약
            </button>
            <button
                onClick={() => setActiveTab('exam')}
                style={{
                    display: 'flex', alignItems: 'center', gap: '0.5rem',
                    padding: '0.75rem 1.5rem', borderRadius: 'var(--radius-md)',
                    background: activeTab === 'exam' ? 'var(--primary)' : 'transparent',
                    color: activeTab === 'exam' ? 'white' : 'var(--muted)',
                    fontWeight: activeTab === 'exam' ? 700 : 500,
                    transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)', flex: 1, justifyContent: 'center', whiteSpace: 'nowrap'
                }}
            >
                <BarChart2 size={18} />
                시험 분석
            </button>
            <button
                onClick={() => setActiveTab('student')}
                style={{
                    display: 'flex', alignItems: 'center', gap: '0.5rem',
                    padding: '0.75rem 1.5rem', borderRadius: 'var(--radius-md)',
                    background: activeTab === 'student' ? 'var(--primary)' : 'transparent',
                    color: activeTab === 'student' ? 'white' : 'var(--muted)',
                    fontWeight: activeTab === 'student' ? 700 : 500,
                    transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)', flex: 1, justifyContent: 'center', whiteSpace: 'nowrap'
                }}
            >
                <GraduationCap size={18} />
                학생 성취도
            </button>
        </div>
    );

    return (
        <div className="layout-main">
            <header className="header">
                <div className="container header-content">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                        <Link href="/" className="logo">Classin</Link>
                        <span style={{
                            fontSize: '0.75rem', fontWeight: 700,
                            background: 'rgba(99, 102, 241, 0.1)', color: 'var(--primary)',
                            padding: '4px 10px', borderRadius: 'var(--radius-full)',
                            border: '1px solid rgba(99, 102, 241, 0.2)'
                        }}>
                            TEACHER
                        </span>
                    </div>
                </div>
            </header>

            <main className="container animate-fade-in" style={{ paddingBottom: '4rem' }}>
                {/* Welcome Section */}
                <div style={{ margin: '3rem 0', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
                    <div>
                        <h1 className="title-gradient" style={{ fontSize: '2.5rem', marginBottom: '0.75rem', lineHeight: 1.2 }}>
                            Analytics Center
                        </h1>
                        <p className="text-muted" style={{ fontSize: '1.1rem' }}>
                            방대한 리포트와 시험 통계를 한 번에 관리하세요.
                        </p>
                    </div>
                    {activeTab !== 'overview' && (
                        <Link href="/create" style={{
                            padding: '0.75rem 1.5rem', background: 'var(--primary)',
                            color: 'white', borderRadius: 'var(--radius-full)',
                            fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem',
                            boxShadow: '0 4px 12px rgba(99, 102, 241, 0.3)'
                        }}>
                            시험 출제하기
                        </Link>
                    )}
                </div>

                {/* Tabs */}
                {renderTabs()}

                {/* Tab Content */}
                <div style={{ minHeight: '600px' }}>
                    {activeTab === 'overview' && (
                        <OverviewTab
                            exams={exams}
                            attempts={attempts}
                            stats={stats}
                            trendData={trendData}
                            onNavigateToExamAnalytics={handleNavigateToExamAnalytics}
                        />
                    )}
                    {activeTab === 'exam' && (
                        <ExamAnalyticsTab exams={exams} attempts={attempts} initialExamId={selectedExamIdForAnalytics} />
                    )}
                    {activeTab === 'student' && (
                        <StudentAnalyticsTab exams={exams} attempts={attempts} />
                    )}
                </div>

            </main>
        </div>
    );
}

