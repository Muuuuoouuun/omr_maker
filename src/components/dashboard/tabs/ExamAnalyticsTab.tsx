"use client";

import { useMemo, useState, useEffect, useRef } from "react";
import { Exam, Attempt, questionWeight } from "@/types/omr";
import Link from "next/link";
import {
    BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer,
    Radar, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis
} from 'recharts';
import { AlertTriangle, CheckCircle, BarChart2, Download, ChevronUp, ChevronDown, List, Target, Users, Lightbulb } from "lucide-react";
import { buildRetakeQuestionIds, buildSimilarQuestionGroups, summarizeAttemptBehavior } from "@/lib/premiumAnalytics";

interface ExamAnalyticsTabProps {
    exams: Exam[];
    attempts: Attempt[];
    initialExamId?: string;
}

const difficultyLabelMap: Record<string, string> = {
    easy: "기초",
    medium: "표준",
    hard: "심화",
    killer: "킬러",
};

function formatSeconds(totalSec: number): string {
    if (totalSec < 60) return `${totalSec}초`;
    const minutes = Math.floor(totalSec / 60);
    const seconds = totalSec % 60;
    return seconds > 0 ? `${minutes}분 ${seconds}초` : `${minutes}분`;
}

function buildRetakeHref(examId: string, sourceAttemptId: string, questionIds: number[], mode: "wrong" | "similar" = "wrong"): string {
    const params = new URLSearchParams({
        retakeFrom: sourceAttemptId,
        questions: questionIds.join(","),
        mode,
    });
    return `/solve/${examId}?${params.toString()}`;
}

export default function ExamAnalyticsTab({ exams, attempts, initialExamId }: ExamAnalyticsTabProps) {
    const [selectedExamId, setSelectedExamId] = useState<string>(initialExamId || (exams.length > 0 ? exams[0].id : ""));
    const [isSelectOpen, setIsSelectOpen] = useState(false);
    const [inputValue, setInputValue] = useState("");
    const dropdownRef = useRef<HTMLDivElement>(null);

    // Handle click outside to close dropdown
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setIsSelectOpen(false);
            }
        };
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, []);

    const filteredExams = useMemo(() => {
        if (!inputValue) return exams;
        // Don't filter if the input exactly matches the selected exam title (meaning it's just displaying it)
        const currentSelected = exams.find(e => e.id === selectedExamId);
        if (currentSelected && inputValue === currentSelected.title && !isSelectOpen) return exams;
        return exams.filter(exam => exam.title.toLowerCase().includes(inputValue.toLowerCase()));
    }, [exams, inputValue, selectedExamId, isSelectOpen]);

    // Keep input in sync with selected exam when not open
    useEffect(() => {
        const currentSelected = exams.find(e => e.id === selectedExamId);
        if (currentSelected && !isSelectOpen) {
            setInputValue(currentSelected.title);
        }
    }, [selectedExamId, exams, isSelectOpen]);

    // Sync initialExamId if parent changes it
    useEffect(() => {
        if (initialExamId) {
            setSelectedExamId(initialExamId);
        }
    }, [initialExamId]);

    useEffect(() => {
        if (!selectedExamId && exams.length > 0) {
            setSelectedExamId(exams[0].id);
        }
    }, [exams, selectedExamId]);

    const selectedExam = useMemo(() => exams.find(e => e.id === selectedExamId), [exams, selectedExamId]);
    const allSelectedExamAttempts = useMemo(() => attempts.filter(a => a.examId === selectedExamId), [attempts, selectedExamId]);
    const examAttempts = useMemo(() => allSelectedExamAttempts.filter(a => !a.retake), [allSelectedExamAttempts]);
    const retakeAttempts = useMemo(() => allSelectedExamAttempts.filter(a => !!a.retake), [allSelectedExamAttempts]);

    const examStats = useMemo(() => {
        if (!selectedExam || examAttempts.length === 0) return null;

        const scores = examAttempts.map(a => (a.score / a.totalScore) * 100);
        const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
        const maxScore = Math.max(...scores);
        const minScore = Math.min(...scores);

        return {
            avgScore: Math.round(avgScore),
            maxScore: Math.round(maxScore),
            minScore: Math.round(minScore),
            count: examAttempts.length
        };
    }, [selectedExam, examAttempts]);

    // Calculate Question Analytics
    const questionAnalytics = useMemo(() => {
        if (!selectedExam || examAttempts.length === 0) return [];

        const sortedByScore = [...examAttempts].sort((a, b) => {
            const aPct = a.totalScore > 0 ? a.score / a.totalScore : 0;
            const bPct = b.totalScore > 0 ? b.score / b.totalScore : 0;
            return bPct - aPct;
        });
        const splitSize = Math.max(1, Math.ceil(sortedByScore.length / 3));
        const upperGroup = sortedByScore.slice(0, splitSize);
        const lowerGroup = sortedByScore.slice(-splitSize);
        const rateForGroup = (group: Attempt[], questionId: number, answer?: number) => {
            if (group.length === 0 || answer === undefined) return 0;
            const correct = group.filter(attempt => attempt.answers[questionId] === answer).length;
            return Math.round((correct / group.length) * 100);
        };

        return selectedExam.questions.map((q, qIndex) => {
            let correctCount = 0;
            let unansweredCount = 0;
            const choices = q.choices || 5;
            const optionCounts: Record<number, number> = Object.fromEntries(
                Array.from({ length: choices }, (_, i) => [i + 1, 0])
            );

            examAttempts.forEach(attempt => {
                const selectedAns = attempt.answers[q.id];
                if (selectedAns !== undefined && selectedAns !== 0) {
                    if (selectedAns === q.answer) correctCount++;
                    if (optionCounts[selectedAns] !== undefined) {
                        optionCounts[selectedAns]++;
                    } else {
                        optionCounts[selectedAns] = 1; // dynamically add other options if they exist
                    }
                } else {
                    unansweredCount++;
                }
            });
            const correctRate = Math.round((correctCount / examAttempts.length) * 100);
            const unansweredRate = Math.round((unansweredCount / examAttempts.length) * 100);
            const upperCorrectRate = rateForGroup(upperGroup, q.id, q.answer);
            const lowerCorrectRate = rateForGroup(lowerGroup, q.id, q.answer);
            const discrimination = upperCorrectRate - lowerCorrectRate;

            const optionRates = Object.entries(optionCounts).map(([opt, count]) => ({
                option: parseInt(opt),
                count,
                rate: Math.round((count / examAttempts.length) * 100)
            }));
            const topWrongOption = optionRates
                .filter(item => item.option !== q.answer)
                .sort((a, b) => b.rate - a.rate)[0];

            return {
                index: qIndex + 1,
                id: q.id,
                label: q.label || '일반',
                concept: q.tags?.concept || q.label || '일반',
                unit: q.tags?.unit,
                difficulty: q.tags?.difficulty,
                mistakeTypes: q.tags?.mistakeTypes || [],
                expectedTimeSec: q.tags?.expectedTimeSec,
                correctRate,
                wrongRate: 100 - correctRate,
                unansweredRate,
                discrimination,
                topWrongOption,
                optionRates,
                answer: q.answer,
                choices,
            };
        }).sort((a: { correctRate: number }, b: { correctRate: number }) => a.correctRate - b.correctRate); // Sort by hardest first
    }, [selectedExam, examAttempts]);

    // Calculate Label Analytics for Radar Chart
    const labelAnalytics = useMemo(() => {
        if (!selectedExam || examAttempts.length === 0) return [];

        const labelMap: Record<string, { totalPoints: number, earnedPoints: number }> = {};

        selectedExam.questions.forEach(q => {
            const label = q.label || '일반';
            if (!labelMap[label]) labelMap[label] = { totalPoints: 0, earnedPoints: 0 };

            const weight = questionWeight(q, selectedExam.questions.length);
            labelMap[label].totalPoints += weight * examAttempts.length;

            examAttempts.forEach(attempt => {
                const selectedAns = attempt.answers[q.id];
                if (selectedAns !== undefined && selectedAns === q.answer) {
                    labelMap[label].earnedPoints += weight;
                }
            });
        });

        return Object.entries(labelMap).map(([label, data]) => ({
            label,
            correctRate: Math.round((data.earnedPoints / data.totalPoints) * 100)
        }));
    }, [selectedExam, examAttempts]);

    const examLabels = useMemo(() => {
        if (!selectedExam) return [];
        return Array.from(new Set(selectedExam.questions.map(q => q.label || '일반')));
    }, [selectedExam]);

    const maxChoiceCount = useMemo(() => {
        if (!selectedExam) return 5;
        return Math.max(4, ...selectedExam.questions.map(q => q.choices || 5));
    }, [selectedExam]);

    const studentScores = useMemo(() => {
        if (!selectedExam || examAttempts.length === 0) return [];
        return examAttempts.map(attempt => {
            const labelScores: Record<string, { earned: number, total: number }> = {};
            examLabels.forEach(l => labelScores[l] = { earned: 0, total: 0 });

            selectedExam.questions.forEach(q => {
                const label = q.label || '일반';
                const score = questionWeight(q, selectedExam.questions.length);
                labelScores[label].total += score;
                const selectedAns = attempt.answers[q.id];
                if (selectedAns !== undefined && selectedAns === q.answer) {
                    labelScores[label].earned += score;
                }
            });

            const scorePercentage = Math.round((attempt.score / attempt.totalScore) * 100);

            return {
                studentName: attempt.studentName,
                totalScore: attempt.score,
                scorePercentage,
                labelScores,
                attempt
            };
        });
    }, [selectedExam, examAttempts, examLabels]);

    const [sortField, setSortField] = useState<'name' | 'score'>('score');
    const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

    const sortedStudentScores = useMemo(() => {
        return [...studentScores].sort((a, b) => {
            if (sortField === 'score') {
                return sortDir === 'asc' ? a.totalScore - b.totalScore : b.totalScore - a.totalScore;
            } else {
                return sortDir === 'asc' ? a.studentName.localeCompare(b.studentName) : b.studentName.localeCompare(a.studentName);
            }
        });
    }, [studentScores, sortField, sortDir]);

    const conceptAnalytics = useMemo(() => {
        if (!selectedExam || examAttempts.length === 0) return [];

        const conceptMap: Record<string, {
            questionCount: number;
            correctRateSum: number;
            hardCount: number;
            questionNumbers: number[];
            mistakeTypes: Set<string>;
        }> = {};

        questionAnalytics.forEach(q => {
            const concept = q.concept || q.label || '일반';
            if (!conceptMap[concept]) {
                conceptMap[concept] = {
                    questionCount: 0,
                    correctRateSum: 0,
                    hardCount: 0,
                    questionNumbers: [],
                    mistakeTypes: new Set<string>(),
                };
            }
            conceptMap[concept].questionCount++;
            conceptMap[concept].correctRateSum += q.correctRate;
            conceptMap[concept].questionNumbers.push(q.index);
            if (q.difficulty === 'hard' || q.difficulty === 'killer') conceptMap[concept].hardCount++;
            q.mistakeTypes.forEach(type => conceptMap[concept].mistakeTypes.add(type));
        });

        return Object.entries(conceptMap)
            .map(([concept, data]) => ({
                concept,
                questionCount: data.questionCount,
                correctRate: Math.round(data.correctRateSum / data.questionCount),
                hardCount: data.hardCount,
                questionNumbers: data.questionNumbers.sort((a, b) => a - b),
                mistakeTypes: Array.from(data.mistakeTypes),
            }))
            .sort((a, b) => a.correctRate - b.correctRate);
    }, [selectedExam, examAttempts, questionAnalytics]);

    const teachingInsights = useMemo(() => {
        if (!examStats) return null;

        const weakConcept = conceptAnalytics[0];
        const riskyQuestions = questionAnalytics.filter(q =>
            q.correctRate < 50 ||
            q.discrimination < 10 ||
            q.unansweredRate >= 20 ||
            (q.topWrongOption?.rate || 0) >= 30
        );
        const tooEasyCount = questionAnalytics.filter(q => q.correctRate >= 90).length;
        const weakDiscriminationCount = questionAnalytics.filter(q => q.discrimination < 10 && q.correctRate >= 35 && q.correctRate <= 85).length;
        const lowStudents = studentScores.filter(student => student.scorePercentage < 60);
        const borderlineStudents = studentScores.filter(student => student.scorePercentage >= 60 && student.scorePercentage < 80);
        const advancedStudents = studentScores.filter(student => student.scorePercentage >= 90);

        return {
            weakConcept,
            riskyQuestions: riskyQuestions.slice(0, 5),
            tooEasyCount,
            weakDiscriminationCount,
            lowStudents,
            borderlineStudents,
            advancedStudents,
            actionCopy: weakConcept
                ? `${weakConcept.concept} 보강 후 ${weakConcept.questionNumbers.slice(0, 4).join(", ")}번 유사문항 재응시`
                : "응시 데이터가 쌓이면 보강 우선순위를 계산합니다.",
        };
    }, [conceptAnalytics, examStats, questionAnalytics, studentScores]);

    const similarQuestionGroups = useMemo(() => {
        if (!selectedExam || examAttempts.length === 0) return [];
        return buildSimilarQuestionGroups(selectedExam, examAttempts)
            .filter(group => group.wrongCount > 0)
            .slice(0, 6);
    }, [selectedExam, examAttempts]);

    const behaviorRows = useMemo(() => {
        return examAttempts
            .map(attempt => ({
                attempt,
                summary: summarizeAttemptBehavior(attempt),
            }))
            .filter(row =>
                row.summary.totalTrackedTimeSec > 0 ||
                row.summary.revisitedQuestionNumbers.length > 0 ||
                row.summary.focusLossCount > 0
            )
            .sort((a, b) => {
                if (b.summary.focusLossCount !== a.summary.focusLossCount) {
                    return b.summary.focusLossCount - a.summary.focusLossCount;
                }
                if (b.summary.revisitedQuestionNumbers.length !== a.summary.revisitedQuestionNumbers.length) {
                    return b.summary.revisitedQuestionNumbers.length - a.summary.revisitedQuestionNumbers.length;
                }
                return b.summary.totalTrackedTimeSec - a.summary.totalTrackedTimeSec;
            })
            .slice(0, 6);
    }, [examAttempts]);

    const handleSort = (field: 'name' | 'score') => {
        if (sortField === field) {
            setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
        } else {
            setSortField(field);
            setSortDir('desc');
        }
    };

    const handleExportCSV = (student: typeof studentScores[0]) => {
        if (!selectedExam) return;

        // CSV header
        let csvContent = "문항 번호,라벨(장르),배점,학생 선택,정답,정오\n";

        selectedExam.questions.forEach((q, i) => {
            const selectedAns = student.attempt.answers[q.id];
            const isCorrect = (selectedAns !== undefined && selectedAns === q.answer);
            const score = questionWeight(q, selectedExam.questions.length);
            csvContent += `${q.number || i + 1},${q.label || '일반'},${score},${selectedAns || '-'},${q.answer || 1},${isCorrect ? 'O' : 'X'}\n`;
        });

        csvContent += "\n장르별 통계\n장르,획득 점수,만점\n";
        Object.entries(student.labelScores).forEach(([label, data]) => {
            csvContent += `${label},${data.earned},${data.total}\n`;
        });

        const blob = new Blob(["\uFEFF" + csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.setAttribute("href", url);
        link.setAttribute("download", `${student.studentName}_${selectedExam.title}_분석.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    if (exams.length === 0) {
        return (
            <div className="fade-in-up" style={{ padding: '3rem 2rem', textAlign: 'center' }}>
                <div style={{
                    width: 80, height: 80, borderRadius: '50%',
                    background: 'linear-gradient(135deg, rgba(99,102,241,0.1), rgba(236,72,153,0.1))',
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    color: 'var(--primary)', marginBottom: '1.5rem'
                }}>
                    <BarChart2 size={36} />
                </div>
                <h3 style={{ fontSize: '1.15rem', fontWeight: 700, marginBottom: '0.5rem' }}>분석할 시험이 없습니다</h3>
                <p style={{ fontSize: '0.9rem', color: 'var(--muted)', marginBottom: '1.5rem' }}>
                    먼저 시험을 출제하면 응시 결과를 분석할 수 있습니다.
                </p>
                <a href="/create" style={{
                    display: 'inline-flex', alignItems: 'center', gap: '0.5rem',
                    padding: '0.75rem 1.4rem',
                    background: 'linear-gradient(135deg, var(--primary), var(--primary-dark))',
                    color: 'white', borderRadius: 'var(--radius-full)', fontWeight: 600, fontSize: '0.9rem',
                    boxShadow: '0 4px 14px rgba(99,102,241,0.3)'
                }}>
                    시험 출제하기
                </a>
            </div>
        );
    }

    return (
        <div className="fade-in-up" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            {/* Filter Section */}
            <div className="card" style={{ padding: '1.5rem', display: 'flex', alignItems: 'center', gap: '1rem', background: 'var(--surface)' }}>
                <span style={{ fontWeight: 600, color: 'var(--text)' }}>분석할 시험 선택:</span>
                <div ref={dropdownRef} style={{ position: 'relative', flex: 1, maxWidth: '400px' }}>
                    <div
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            position: 'relative',
                            borderRadius: 'var(--radius-md)',
                            border: '1px solid var(--border)',
                            background: 'var(--background)',
                        }}
                    >
                        <input
                            type="text"
                            value={inputValue}
                            onChange={(e) => {
                                setInputValue(e.target.value);
                                setIsSelectOpen(true);
                            }}
                            onFocus={() => {
                                setIsSelectOpen(true);
                                setInputValue(""); // Clear input to allow fresh search
                            }}
                            onBlur={() => {
                                // Restore selected exam text if they didn't pick anything new
                                setTimeout(() => {
                                    if (!isSelectOpen) {
                                        const currentExam = exams.find(e => e.id === selectedExamId);
                                        if (currentExam) setInputValue(currentExam.title);
                                    }
                                }, 150);
                            }}
                            placeholder="시험을 검색하거나 선택하세요"
                            style={{
                                width: '100%',
                                padding: '0.75rem 1rem',
                                paddingRight: '2.5rem',
                                border: 'none',
                                background: 'transparent',
                                color: 'var(--text)',
                                outline: 'none',
                                cursor: 'text'
                            }}
                        />
                        <ChevronDown
                            size={18}
                            style={{
                                position: 'absolute',
                                right: '1rem',
                                pointerEvents: 'none',
                                transform: isSelectOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                                transition: 'transform 0.2s',
                                color: 'var(--muted)'
                            }}
                        />
                    </div>

                    {isSelectOpen && (
                        <div style={{
                            position: 'absolute',
                            top: '100%',
                            left: 0,
                            right: 0,
                            marginTop: '0.5rem',
                            background: 'var(--background)',
                            border: '1px solid var(--border)',
                            borderRadius: 'var(--radius-md)',
                            boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
                            zIndex: 50,
                            maxHeight: '300px',
                            overflowY: 'auto'
                        }}>
                            {filteredExams.length > 0 ? (
                                filteredExams.map(exam => (
                                    <div
                                        key={exam.id}
                                        onMouseDown={(e) => {
                                            // Handle click with onMouseDown so it fires before input onBlur
                                            e.preventDefault();
                                            setSelectedExamId(exam.id);
                                            setInputValue(exam.title);
                                            setIsSelectOpen(false);
                                        }}
                                        style={{
                                            padding: '0.75rem 1rem',
                                            cursor: 'pointer',
                                            background: exam.id === selectedExamId ? 'var(--surface)' : 'transparent',
                                            color: exam.id === selectedExamId ? 'var(--primary)' : 'var(--text)',
                                            fontWeight: exam.id === selectedExamId ? 600 : 400,
                                        }}
                                        className="hover:bg-slate-50 dark:hover:bg-slate-800"
                                    >
                                        {exam.title}
                                    </div>
                                ))
                            ) : (
                                <div style={{ padding: '1rem', textAlign: 'center', color: 'var(--muted)' }}>
                                    검색 결과가 없습니다
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>

            {examStats ? (
                <>
                    {/* Stats Summary */}
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: '1rem' }}>
                        {[
                            { label: '평균 점수', value: `${examStats.avgScore}점`, color: 'var(--primary)' },
                            { label: '최고 점수', value: `${examStats.maxScore}점`, color: 'var(--success)' },
                            { label: '최저 점수', value: `${examStats.minScore}점`, color: 'var(--warning)' },
                            { label: '응시 인원', value: `${examStats.count}명`, color: 'var(--text)' },
                            { label: '재시험 제출', value: `${retakeAttempts.length}건`, color: '#0f766e' },
                        ].map((stat, i) => (
                            <div key={i} className="card" style={{ padding: '1.5rem', textAlign: 'center', borderTop: `4px solid ${stat.color}` }}>
                                <div style={{ fontSize: '0.9rem', color: 'var(--muted)', marginBottom: '0.5rem' }}>{stat.label}</div>
                                <div style={{ fontSize: '2rem', fontWeight: 800, color: stat.color }}>{stat.value}</div>
                            </div>
                        ))}
                    </div>

                    {teachingInsights && (
                        <div className="card" style={{ padding: '1.5rem', background: 'var(--surface)', border: '1px solid var(--border)' }}>
                            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem', marginBottom: '1.25rem' }}>
                                <div>
                                    <h3 style={{ fontSize: '1.1rem', fontWeight: 800, display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.3rem' }}>
                                        <Lightbulb size={18} color="var(--primary)" />
                                        강사용 다음 액션
                                    </h3>
                                    <p style={{ fontSize: '0.82rem', color: 'var(--muted)', fontWeight: 500 }}>
                                        점수 확인 후 바로 수업 운영에 쓰는 진단 요약입니다.
                                    </p>
                                </div>
                                <span style={{
                                    fontSize: '0.72rem',
                                    fontWeight: 800,
                                    color: 'var(--primary)',
                                    background: 'rgba(99,102,241,0.1)',
                                    border: '1px solid rgba(99,102,241,0.18)',
                                    padding: '0.25rem 0.65rem',
                                    borderRadius: 'var(--radius-full)',
                                    whiteSpace: 'nowrap'
                                }}>
                                    Teacher UX
                                </span>
                            </div>

                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1rem', marginBottom: '1.25rem' }}>
                                <div style={{ padding: '1rem', borderRadius: 'var(--radius-md)', background: 'var(--background)', border: '1px solid var(--border)' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', fontSize: '0.82rem', fontWeight: 800, color: 'var(--primary)', marginBottom: '0.55rem' }}>
                                        <Target size={15} />
                                        오늘 보강
                                    </div>
                                    <div style={{ fontSize: '1rem', fontWeight: 800, color: 'var(--foreground)', lineHeight: 1.35 }}>
                                        {teachingInsights.weakConcept?.concept || '데이터 대기'}
                                    </div>
                                    <div style={{ fontSize: '0.78rem', color: 'var(--muted)', marginTop: '0.45rem', lineHeight: 1.45 }}>
                                        {teachingInsights.actionCopy}
                                    </div>
                                </div>

                                <div style={{ padding: '1rem', borderRadius: 'var(--radius-md)', background: 'var(--background)', border: '1px solid var(--border)' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', fontSize: '0.82rem', fontWeight: 800, color: 'var(--warning)', marginBottom: '0.55rem' }}>
                                        <AlertTriangle size={15} />
                                        문항 품질 점검
                                    </div>
                                    <div style={{ fontSize: '1rem', fontWeight: 800, color: 'var(--foreground)', lineHeight: 1.35 }}>
                                        {teachingInsights.riskyQuestions.length}문항 재검토
                                    </div>
                                    <div style={{ fontSize: '0.78rem', color: 'var(--muted)', marginTop: '0.45rem', lineHeight: 1.45 }}>
                                        변별 약함 {teachingInsights.weakDiscriminationCount}개, 쉬운 문항 {teachingInsights.tooEasyCount}개
                                    </div>
                                </div>

                                <div style={{ padding: '1rem', borderRadius: 'var(--radius-md)', background: 'var(--background)', border: '1px solid var(--border)' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', fontSize: '0.82rem', fontWeight: 800, color: 'var(--success)', marginBottom: '0.55rem' }}>
                                        <Users size={15} />
                                        반 운영
                                    </div>
                                    <div style={{ fontSize: '1rem', fontWeight: 800, color: 'var(--foreground)', lineHeight: 1.35 }}>
                                        보충 {teachingInsights.lowStudents.length}명 · 심화 {teachingInsights.advancedStudents.length}명
                                    </div>
                                    <div style={{ fontSize: '0.78rem', color: 'var(--muted)', marginTop: '0.45rem', lineHeight: 1.45 }}>
                                        60~79점 구간 {teachingInsights.borderlineStudents.length}명은 다음 시험 전 개념 점검 권장
                                    </div>
                                </div>
                            </div>

                            {conceptAnalytics.length > 0 && (
                                <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
                                    <table style={{ width: '100%', minWidth: '680px', borderCollapse: 'collapse', textAlign: 'left' }}>
                                        <thead style={{ background: 'var(--background)', color: 'var(--muted)', fontSize: '0.78rem' }}>
                                            <tr>
                                                <th style={{ padding: '0.75rem 0.9rem' }}>보강 우선순위</th>
                                                <th style={{ padding: '0.75rem 0.9rem' }}>정답률</th>
                                                <th style={{ padding: '0.75rem 0.9rem' }}>문항</th>
                                                <th style={{ padding: '0.75rem 0.9rem' }}>오답 원인 힌트</th>
                                                <th style={{ padding: '0.75rem 0.9rem' }}>수업 조치</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {conceptAnalytics.slice(0, 6).map((item, index) => {
                                                const isWeak = item.correctRate < 60;
                                                const action = isWeak
                                                    ? '개념 재설명 + 유사문항 3개'
                                                    : item.correctRate < 80
                                                        ? '짧은 확인 문제'
                                                        : '심화 변형문항';
                                                return (
                                                    <tr key={item.concept} style={{ borderTop: '1px solid var(--border)' }}>
                                                        <td style={{ padding: '0.8rem 0.9rem', fontWeight: 800, color: index === 0 ? 'var(--error)' : 'var(--foreground)' }}>
                                                            {index + 1}. {item.concept}
                                                        </td>
                                                        <td style={{ padding: '0.8rem 0.9rem' }}>
                                                            <span style={{
                                                                color: item.correctRate < 60 ? 'var(--error)' : item.correctRate < 80 ? 'var(--warning)' : 'var(--success)',
                                                                fontWeight: 900,
                                                            }}>
                                                                {item.correctRate}%
                                                            </span>
                                                        </td>
                                                        <td style={{ padding: '0.8rem 0.9rem', color: 'var(--muted)', fontWeight: 700 }}>
                                                            {item.questionNumbers.join(', ')}번
                                                            {item.hardCount > 0 && (
                                                                <span style={{ marginLeft: '0.4rem', color: 'var(--warning)' }}>심화 {item.hardCount}</span>
                                                            )}
                                                        </td>
                                                        <td style={{ padding: '0.8rem 0.9rem', color: 'var(--muted)' }}>
                                                            {item.mistakeTypes.slice(0, 3).join(', ') || '오답 선택률 확인'}
                                                        </td>
                                                        <td style={{ padding: '0.8rem 0.9rem', fontWeight: 800, color: isWeak ? 'var(--primary)' : 'var(--muted)' }}>
                                                            {action}
                                                        </td>
                                                    </tr>
                                                );
                                            })}
                                        </tbody>
                                    </table>
                                </div>
                            )}
                        </div>
                    )}

                    {(similarQuestionGroups.length > 0 || behaviorRows.length > 0) && (
                        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.2fr) minmax(0, 1fr)', gap: '1.5rem' }}>
                            <div className="card" style={{ padding: '1.5rem', border: '1px solid var(--border)', background: 'var(--surface)' }}>
                                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem', marginBottom: '1rem' }}>
                                    <div>
                                        <h3 style={{ fontSize: '1rem', fontWeight: 800, color: 'var(--foreground)', display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                                            <Target size={16} color="var(--primary)" />
                                            유사 유형 소팅
                                        </h3>
                                        <p style={{ fontSize: '0.8rem', color: 'var(--muted)', marginTop: '0.2rem' }}>
                                            같은 지문/작품, 개념, 단원 기준으로 오답 압력이 높은 묶음입니다.
                                        </p>
                                    </div>
                                    <span style={{
                                        fontSize: '0.72rem',
                                        fontWeight: 800,
                                        color: '#0f766e',
                                        background: '#f0fdfa',
                                        border: '1px solid #99f6e4',
                                        padding: '0.22rem 0.55rem',
                                        borderRadius: '999px',
                                        whiteSpace: 'nowrap',
                                    }}>
                                        Premium
                                    </span>
                                </div>

                                {similarQuestionGroups.length > 0 ? (
                                    <div style={{ display: 'grid', gap: '0.65rem' }}>
                                        {similarQuestionGroups.map(group => (
                                            <div key={group.key} style={{
                                                display: 'flex',
                                                alignItems: 'center',
                                                justifyContent: 'space-between',
                                                gap: '0.75rem',
                                                padding: '0.85rem',
                                                borderRadius: 'var(--radius-md)',
                                                border: '1px solid var(--border)',
                                                background: 'var(--background)'
                                            }}>
                                                <div style={{ minWidth: 0 }}>
                                                    <div style={{ fontWeight: 900, color: 'var(--foreground)', lineHeight: 1.3 }}>
                                                        {group.title}
                                                        <span style={{ marginLeft: '0.45rem', color: 'var(--muted)', fontSize: '0.74rem', fontWeight: 800 }}>
                                                            {group.basis}
                                                        </span>
                                                    </div>
                                                    <div style={{ fontSize: '0.78rem', color: 'var(--muted)', marginTop: '0.22rem' }}>
                                                        {group.questionNumbers.join(', ')}번 · 오답 {group.wrongCount}/{group.totalCount} · {group.wrongRate}%
                                                    </div>
                                                </div>
                                                <Link
                                                    href={buildRetakeHref(selectedExamId, `exam:${selectedExamId}`, group.questionIds, "similar")}
                                                    className="btn btn-secondary"
                                                    style={{ fontSize: '0.75rem', padding: '0.35rem 0.65rem', whiteSpace: 'nowrap' }}
                                                >
                                                    세트 재시험
                                                </Link>
                                            </div>
                                        ))}
                                    </div>
                                ) : (
                                    <div style={{ color: 'var(--muted)', fontSize: '0.85rem', padding: '1rem', border: '1px dashed var(--border)', borderRadius: 'var(--radius-md)' }}>
                                        오답이 쌓이면 유사 유형 묶음이 표시됩니다.
                                    </div>
                                )}
                            </div>

                            <div className="card" style={{ padding: '1.5rem', border: '1px solid var(--border)', background: 'var(--surface)' }}>
                                <h3 style={{ fontSize: '1rem', fontWeight: 800, color: 'var(--foreground)', display: 'flex', alignItems: 'center', gap: '0.45rem', marginBottom: '0.25rem' }}>
                                    <List size={16} color="var(--primary)" />
                                    풀이 행동 신호
                                </h3>
                                <p style={{ fontSize: '0.8rem', color: 'var(--muted)', marginBottom: '1rem' }}>
                                    오래 머문 문항, 다시 돌아온 문항, 화면 이탈을 학생별로 확인합니다.
                                </p>

                                {behaviorRows.length > 0 ? (
                                    <div style={{ display: 'grid', gap: '0.55rem' }}>
                                        {behaviorRows.map(row => (
                                            <div key={row.attempt.id} style={{
                                                padding: '0.8rem',
                                                borderRadius: 'var(--radius-md)',
                                                border: '1px solid var(--border)',
                                                background: 'var(--background)',
                                            }}>
                                                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', marginBottom: '0.3rem' }}>
                                                    <span style={{ fontWeight: 900, color: 'var(--foreground)' }}>{row.attempt.studentName}</span>
                                                    <span style={{ color: row.summary.focusLossCount > 0 ? 'var(--error)' : 'var(--muted)', fontSize: '0.78rem', fontWeight: 800 }}>
                                                        이탈 {row.summary.focusLossCount}회
                                                    </span>
                                                </div>
                                                <div style={{ fontSize: '0.78rem', color: 'var(--muted)', lineHeight: 1.5 }}>
                                                    추적 {formatSeconds(row.summary.totalTrackedTimeSec)}
                                                    {row.summary.slowQuestionNumbers.length > 0 && ` · 오래 머문 ${row.summary.slowQuestionNumbers.join(', ')}번`}
                                                    {row.summary.revisitedQuestionNumbers.length > 0 && ` · 재방문 ${row.summary.revisitedQuestionNumbers.join(', ')}번`}
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                ) : (
                                    <div style={{ color: 'var(--muted)', fontSize: '0.85rem', padding: '1rem', border: '1px dashed var(--border)', borderRadius: 'var(--radius-md)' }}>
                                        새 제출부터 문항별 시간과 재방문 로그가 표시됩니다.
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1.5rem' }}>
                        {/* Radar Chart for labels */}
                        <div className="card" style={{ padding: '1.5rem', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-xl)', position: 'relative', overflow: 'hidden' }}>
                            {/* Decorative background */}
                            <div style={{
                                position: 'absolute', top: '-30px', right: '-30px',
                                width: '200px', height: '200px',
                                background: 'radial-gradient(circle, rgba(99,102,241,0.08) 0%, transparent 70%)',
                                pointerEvents: 'none', filter: 'blur(20px)'
                            }} />

                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.25rem', position: 'relative' }}>
                                <div>
                                    <h3 style={{ fontSize: '1rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '0.5rem', letterSpacing: '-0.01em' }}>
                                        <BarChart2 size={16} color="var(--primary)" />
                                        항목별(라벨) 정답률 분석
                                    </h3>
                                    <p style={{ fontSize: '0.78rem', color: 'var(--muted)', marginTop: '2px', fontWeight: 500 }}>
                                        카테고리별 평균 정답률 레이더
                                    </p>
                                </div>
                                {labelAnalytics.length > 0 && (
                                    <span className="badge badge-primary" style={{ fontSize: '0.7rem' }}>
                                        {labelAnalytics.length}개 라벨
                                    </span>
                                )}
                            </div>

                            {labelAnalytics.length > 0 ? (
                                <>
                                    <div style={{ height: '300px', width: '100%', position: 'relative' }}>
                                        <ResponsiveContainer width="100%" height="100%">
                                            <RadarChart cx="50%" cy="50%" outerRadius="72%" data={labelAnalytics} startAngle={90} endAngle={-270}>
                                                <defs>
                                                    <linearGradient id="radarGradient" x1="0" y1="0" x2="1" y2="1">
                                                        <stop offset="0%" stopColor="#4f46e5" stopOpacity={0.7} />
                                                        <stop offset="50%" stopColor="#8b5cf6" stopOpacity={0.5} />
                                                        <stop offset="100%" stopColor="#ec4899" stopOpacity={0.35} />
                                                    </linearGradient>
                                                    <filter id="radarGlow">
                                                        <feGaussianBlur stdDeviation="3" result="coloredBlur" />
                                                        <feMerge>
                                                            <feMergeNode in="coloredBlur" />
                                                            <feMergeNode in="SourceGraphic" />
                                                        </feMerge>
                                                    </filter>
                                                </defs>

                                                {/* Inner dotted gridlines (faint) */}
                                                <PolarGrid
                                                    stroke="var(--muted)"
                                                    strokeDasharray="2 4"
                                                    strokeOpacity={0.3}
                                                    gridType="polygon"
                                                />
                                                <PolarAngleAxis
                                                    dataKey="label"
                                                    tick={{ fill: 'var(--foreground)', fontSize: 12, fontWeight: 700, letterSpacing: '-0.01em' }}
                                                    tickLine={false}
                                                    axisLine={{ stroke: 'var(--muted)', strokeWidth: 1, strokeOpacity: 0.55 }}
                                                />
                                                <PolarRadiusAxis
                                                    angle={90}
                                                    domain={[0, 100]}
                                                    tick={{ fill: 'var(--muted)', fontSize: 10, fontWeight: 500 }}
                                                    tickCount={5}
                                                    axisLine={false}
                                                    stroke="transparent"
                                                />
                                                <Radar
                                                    name="정답률"
                                                    dataKey="correctRate"
                                                    stroke="#6366f1"
                                                    strokeWidth={2.5}
                                                    fill="url(#radarGradient)"
                                                    fillOpacity={0.85}
                                                    dot={{ fill: '#6366f1', stroke: '#fff', strokeWidth: 2, r: 5 }}
                                                    activeDot={{ fill: '#ec4899', stroke: '#fff', strokeWidth: 2, r: 7 }}
                                                    animationDuration={1400}
                                                    animationEasing="ease-out"
                                                    filter="url(#radarGlow)"
                                                />
                                                <RechartsTooltip
                                                    cursor={{ fill: 'transparent' }}
                                                    contentStyle={{
                                                        borderRadius: '12px',
                                                        border: '1px solid rgba(99, 102, 241, 0.2)',
                                                        boxShadow: '0 8px 32px rgba(0,0,0,0.12)',
                                                        background: 'var(--surface)',
                                                        color: 'var(--foreground)',
                                                        fontWeight: 700,
                                                        fontSize: '0.85rem',
                                                        padding: '0.6rem 0.9rem',
                                                        letterSpacing: '-0.01em'
                                                    }}
                                                    itemStyle={{ color: 'var(--primary)', fontWeight: 800, padding: 0 }}
                                                    labelStyle={{ color: 'var(--foreground)', marginBottom: '4px', fontSize: '0.82rem', fontWeight: 700 }}
                                                    formatter={(value: number | string | undefined) => [`${value}%`, '정답률']}
                                                />
                                            </RadarChart>
                                        </ResponsiveContainer>
                                    </div>

                                    {/* Premium Legend */}
                                    <div className="radar-legend">
                                        {labelAnalytics.map((item, idx) => {
                                            const hue = (idx * 360) / labelAnalytics.length;
                                            const dotColor = `hsl(${(hue + 230) % 360}, 75%, 60%)`;
                                            const rateColor = item.correctRate >= 80 ? 'var(--success)'
                                                : item.correctRate >= 50 ? 'var(--primary)'
                                                : 'var(--error)';
                                            return (
                                                <div key={item.label} className="radar-legend-item">
                                                    <span className="radar-legend-dot" style={{ background: dotColor }} />
                                                    <span className="radar-legend-label">{item.label}</span>
                                                    <span className="radar-legend-value" style={{ color: rateColor }}>
                                                        {item.correctRate}%
                                                    </span>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </>
                            ) : (
                                <div style={{ height: '300px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)' }}>라벨이 지정된 문항이 없습니다.</div>
                            )}
                        </div>

                        {/* Top Hardest Questions */}
                        <div className="card" style={{ padding: '1.5rem' }}>
                            <h3 style={{ fontSize: '1.1rem', fontWeight: 700, marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                <AlertTriangle size={18} color="var(--error)" />
                                오답률이 가장 높은 문항 Top 3
                            </h3>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                                {questionAnalytics.slice(0, 3).map((q, i) => (
                                    <div key={i} style={{
                                        padding: '1rem',
                                        borderRadius: 'var(--radius-md)',
                                        background: 'rgba(239, 68, 68, 0.05)',
                                        borderLeft: '4px solid var(--error)',
                                        display: 'flex',
                                        justifyContent: 'space-between',
                                        alignItems: 'center'
                                    }}>
                                        <div>
                                            <div style={{ fontWeight: 700, fontSize: '1.1rem', color: 'var(--error)', marginBottom: '0.2rem' }}>
                                                {q.index}번 문항 ({q.label})
                                            </div>
                                            <div style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>
                                                {q.topWrongOption && q.topWrongOption.rate > 0
                                                    ? `${q.topWrongOption.option}번 선택 쏠림 ${q.topWrongOption.rate}% · 변별도 ${q.discrimination}%`
                                                    : `미응답 ${q.unansweredRate}% · 변별도 ${q.discrimination}%`}
                                            </div>
                                        </div>
                                        <div style={{ textAlign: 'right' }}>
                                            <div style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>오답률</div>
                                            <div style={{ fontWeight: 800, fontSize: '1.2rem', color: 'var(--error)' }}>
                                                {q.wrongRate}%
                                            </div>
                                        </div>
                                    </div>
                                ))}
                                {questionAnalytics.length === 0 && (
                                    <div style={{ color: 'var(--muted)', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>데이터가 없습니다.</div>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* Detailed Question correct rate bar chart */}
                    <div className="card" style={{ padding: '1.5rem' }}>
                        <h3 style={{ fontSize: '1.1rem', fontWeight: 700, marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <CheckCircle size={18} color="var(--success)" />
                            문항별 상세 정답률
                        </h3>
                        <div style={{ height: '300px', width: '100%', marginBottom: '2rem' }}>
                            <ResponsiveContainer width="100%" height="100%">
                                <BarChart data={[...questionAnalytics].sort((a: { index: number }, b: { index: number }) => a.index - b.index)}>
                                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
                                    <XAxis dataKey="index" tickFormatter={(v) => `${v}번`} tick={{ fill: 'var(--muted)' }} axisLine={false} tickLine={false} />
                                    <YAxis domain={[0, 100]} tick={{ fill: 'var(--muted)' }} axisLine={false} tickLine={false} />
                                    <RechartsTooltip
                                        cursor={{ fill: 'rgba(99, 102, 241, 0.05)' }}
                                        contentStyle={{ borderRadius: '8px', border: '1px solid var(--border)', boxShadow: '0 4px 12px rgba(0,0,0,0.05)', background: 'var(--background)' }}
                                        formatter={(value: number | string | undefined) => [`${value}%`, '정답률']}
                                        labelFormatter={(label) => `${label}번 문항`}
                                    />
                                    <Bar dataKey="correctRate" fill="var(--primary)" radius={[4, 4, 0, 0]} animationDuration={1500} />
                                </BarChart>
                            </ResponsiveContainer>
                        </div>

                        {/* Option Selection Rates Table */}
                        <h4 style={{ fontSize: '1.05rem', fontWeight: 700, marginTop: '1rem', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <List size={16} color="var(--primary)" />
                            세부사항: 문항별 선택률
                        </h4>
                        <div style={{ overflowX: 'auto' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', minWidth: '600px' }}>
                                <thead>
                                    <tr style={{ background: 'var(--surface)', color: 'var(--muted)', fontSize: '0.85rem' }}>
                                        <th style={{ padding: '0.75rem 1rem', borderRadius: 'var(--radius-md) 0 0 var(--radius-md)' }}>문항</th>
                                        <th style={{ padding: '0.75rem 1rem' }}>진단</th>
                                        <th style={{ padding: '0.75rem 1rem' }}>정답률</th>
                                        <th style={{ padding: '0.75rem 1rem' }}>변별도</th>
                                        <th style={{ padding: '0.75rem 1rem' }}>미응답</th>
                                        {Array.from({ length: maxChoiceCount }, (_, i) => i + 1).map(opt => (
                                            <th
                                                key={opt}
                                                style={{
                                                    padding: '0.75rem 1rem',
                                                    textAlign: 'center',
                                                    borderRadius: opt === maxChoiceCount ? '0 var(--radius-md) var(--radius-md) 0' : undefined
                                                }}
                                            >
                                                선지 {opt}
                                            </th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {[...questionAnalytics].sort((a: { index: number }, b: { index: number }) => a.index - b.index).map((q, i) => {
                                        const optMap = q.optionRates.reduce((acc: Record<number, number>, curr: { option: number; rate: number }) => { acc[curr.option] = curr.rate; return acc; }, {});
                                        const qualityLabel = q.correctRate < 50
                                            ? '보강'
                                            : q.discrimination < 10
                                                ? '변별 점검'
                                                : q.correctRate >= 90
                                                    ? '쉬움'
                                                    : '정상';
                                        return (
                                            <tr key={i} style={{ borderBottom: '1px solid var(--border)' }} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                                                <td style={{ padding: '0.75rem 1rem', fontWeight: 600 }}>
                                                    {q.index}번
                                                    <span style={{ fontSize: '0.75rem', color: 'var(--muted)', fontWeight: 400 }}> ({q.concept})</span>
                                                    {q.difficulty && (
                                                        <span style={{ marginLeft: '0.35rem', fontSize: '0.7rem', color: 'var(--primary)', fontWeight: 800 }}>
                                                            {difficultyLabelMap[q.difficulty] || q.difficulty}
                                                        </span>
                                                    )}
                                                </td>
                                                <td style={{ padding: '0.75rem 1rem' }}>
                                                    <span style={{
                                                        padding: '0.22rem 0.48rem',
                                                        borderRadius: '999px',
                                                        fontSize: '0.72rem',
                                                        fontWeight: 900,
                                                        background: qualityLabel === '정상' ? 'rgba(16,185,129,0.08)' : 'rgba(245,158,11,0.1)',
                                                        color: qualityLabel === '정상' ? 'var(--success)' : 'var(--warning)',
                                                        whiteSpace: 'nowrap',
                                                    }}>
                                                        {qualityLabel}
                                                    </span>
                                                </td>
                                                <td style={{ padding: '0.75rem 1rem', fontWeight: 600, color: q.correctRate < 40 ? 'var(--error)' : 'var(--text)' }}>
                                                    {q.correctRate}%
                                                </td>
                                                <td style={{ padding: '0.75rem 1rem', fontWeight: 700, color: q.discrimination < 10 ? 'var(--warning)' : 'var(--muted)' }}>
                                                    {q.discrimination}%
                                                </td>
                                                <td style={{ padding: '0.75rem 1rem', fontWeight: 700, color: q.unansweredRate >= 20 ? 'var(--error)' : 'var(--muted)' }}>
                                                    {q.unansweredRate}%
                                                </td>
                                                {Array.from({ length: maxChoiceCount }, (_, optIdx) => optIdx + 1).map(optNum => (
                                                    <td key={optNum} style={{ padding: '0.75rem 1rem', textAlign: 'center' }}>
                                                        <span style={{
                                                            display: 'inline-block', minWidth: '40px', padding: '0.2rem 0.4rem', borderRadius: '4px',
                                                            background: q.answer === optNum ? 'rgba(34, 197, 94, 0.1)' : optNum > q.choices ? 'rgba(148,163,184,0.08)' : 'transparent',
                                                            color: q.answer === optNum ? 'var(--success)' : optNum > q.choices ? 'rgba(148,163,184,0.55)' : 'var(--muted)',
                                                            fontWeight: q.answer === optNum ? 700 : 400
                                                        }}>
                                                            {optNum > q.choices ? '-' : `${optMap[optNum] || 0}%`}
                                                        </span>
                                                    </td>
                                                ))}
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </div>

                    {/* Student Scores Section */}
                    <div className="card" style={{ padding: '1.5rem', marginTop: '1.5rem' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
                            <h3 style={{ fontSize: '1.1rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                <AlertTriangle size={18} color="var(--primary)" style={{ visibility: 'hidden' }} />
                                학생별 점수 및 성취도 (장르별)
                            </h3>
                        </div>

                        <div style={{ overflowX: 'auto', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border)' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', minWidth: '800px' }}>
                                <thead style={{ background: 'var(--surface)' }}>
                                    <tr>
                                        <th
                                            onClick={() => handleSort('name')}
                                            style={{ padding: '1rem', fontSize: '0.85rem', color: 'var(--muted)', cursor: 'pointer', transition: 'color 0.2s' }}
                                            className="hover:text-primary"
                                        >
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                                학생 이름 {sortField === 'name' ? (sortDir === 'asc' ? <ChevronUp size={14} /> : <ChevronDown size={14} />) : ''}
                                            </div>
                                        </th>
                                        <th
                                            onClick={() => handleSort('score')}
                                            style={{ padding: '1rem', fontSize: '0.85rem', color: 'var(--muted)', cursor: 'pointer', transition: 'color 0.2s' }}
                                            className="hover:text-primary"
                                        >
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                                총점 {sortField === 'score' ? (sortDir === 'asc' ? <ChevronUp size={14} /> : <ChevronDown size={14} />) : ''}
                                            </div>
                                        </th>
                                        {/* Dynamic Label Columns */}
                                        {examLabels.map(label => (
                                            <th key={label} style={{ padding: '1rem', fontSize: '0.85rem', color: 'var(--muted)' }}>
                                                {label}
                                            </th>
                                        ))}
                                        <th style={{ padding: '1rem', fontSize: '0.85rem', color: 'var(--muted)' }}>풀이 행동</th>
                                        <th style={{ padding: '1rem', fontSize: '0.85rem', color: 'var(--muted)' }}>재시험</th>
                                        <th style={{ padding: '1rem', fontSize: '0.85rem', color: 'var(--muted)', textAlign: 'right' }}>데이터 출력</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {sortedStudentScores.map((student, i) => {
                                        const behavior = summarizeAttemptBehavior(student.attempt);
                                        const retakeIds = selectedExam ? buildRetakeQuestionIds(selectedExam, student.attempt) : [];
                                        return (
                                            <tr key={i} style={{ borderTop: '1px solid var(--border)' }} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                                                <td style={{ padding: '1rem', fontWeight: 600 }}>{student.studentName}</td>
                                                <td style={{ padding: '1rem' }}>
                                                    <div style={{ fontWeight: 800, color: student.scorePercentage >= 80 ? 'var(--success)' : (student.scorePercentage < 50 ? 'var(--error)' : 'var(--text)') }}>
                                                        {Number(student.totalScore.toFixed(2))}점 <span style={{ fontSize: '0.8rem', color: 'var(--muted)', fontWeight: 400 }}>({student.scorePercentage}%)</span>
                                                    </div>
                                                </td>
                                                {/* Dynamic Label Columns */}
                                                {examLabels.map(label => {
                                                    const ls = student.labelScores[label];
                                                    const rate = ls.total > 0 ? Math.round((ls.earned / ls.total) * 100) : 0;
                                                    return (
                                                        <td key={label} style={{ padding: '1rem' }}>
                                                            <div style={{ fontSize: '0.9rem', fontWeight: 600 }}>{ls.earned} / {ls.total}</div>
                                                            <div style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>정답률 {rate}%</div>
                                                        </td>
                                                    );
                                                })}
                                                <td style={{ padding: '1rem', color: 'var(--muted)', fontSize: '0.78rem', lineHeight: 1.45 }}>
                                                    {behavior.totalTrackedTimeSec > 0
                                                        ? `평균 ${formatSeconds(behavior.averageTimeSec)}`
                                                        : '새 제출부터 추적'}
                                                    {behavior.revisitedQuestionNumbers.length > 0 && (
                                                        <div style={{ color: 'var(--primary)', fontWeight: 800 }}>
                                                            재방문 {behavior.revisitedQuestionNumbers.join(', ')}번
                                                        </div>
                                                    )}
                                                    {behavior.focusLossCount > 0 && (
                                                        <div style={{ color: 'var(--error)', fontWeight: 800 }}>
                                                            이탈 {behavior.focusLossCount}회
                                                        </div>
                                                    )}
                                                </td>
                                                <td style={{ padding: '1rem' }}>
                                                    {retakeIds.length > 0 ? (
                                                        <Link
                                                            href={buildRetakeHref(selectedExamId, student.attempt.id, retakeIds, "wrong")}
                                                            className="btn btn-secondary"
                                                            style={{ padding: '0.35rem 0.7rem', fontSize: '0.75rem', whiteSpace: 'nowrap' }}
                                                        >
                                                            오답 {retakeIds.length}문항
                                                        </Link>
                                                    ) : (
                                                        <span style={{ color: 'var(--success)', fontSize: '0.78rem', fontWeight: 800 }}>완료</span>
                                                    )}
                                                </td>
                                                <td style={{ padding: '1rem', textAlign: 'right' }}>
                                                    <button
                                                        onClick={() => handleExportCSV(student)}
                                                        style={{
                                                            background: 'var(--surface)', color: 'var(--foreground)', padding: '0.4rem 0.8rem',
                                                            borderRadius: 'var(--radius-md)', fontSize: '0.75rem', fontWeight: 600,
                                                            display: 'inline-flex', alignItems: 'center', gap: '0.4rem',
                                                            border: '1px solid var(--border)', transition: 'all 0.2s'
                                                        }}
                                                        className="hover:border-primary hover:text-primary"
                                                    >
                                                        <Download size={14} />
                                                        정오표(CSV)
                                                    </button>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    </div>
                </>
            ) : (
                <div className="card" style={{ padding: '3rem', textAlign: 'center', color: 'var(--muted)' }}>
                    아직 응시한 학생이 없습니다.
                </div>
            )}
        </div>
    );
}
