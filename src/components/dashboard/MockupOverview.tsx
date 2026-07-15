"use client";

import { useMemo } from "react";
import {
    Area,
    AreaChart,
    Bar,
    BarChart,
    CartesianGrid,
    Cell,
    ResponsiveContainer,
    Tooltip,
    XAxis,
    YAxis,
} from "recharts";
import {
    ArrowRight,
    CheckCircle2,
    CircleAlert,
    Download,
    FileCheck2,
    LineChart as LineChartIcon,
    Target,
    TrendingUp,
    Users,
} from "lucide-react";
import type { Attempt, Exam } from "@/types/omr";
import type { RosterGroup } from "@/lib/rosterStorage";
import { buildAttemptScoreLookup } from "@/lib/attemptScores";

interface MockupOverviewProps {
    exams: Exam[];
    attempts: Attempt[];
    rosterGroups: RosterGroup[];
    totalStudents: number;
    averageScore: number;
    onNavigateToExamAnalytics: (examId: string) => void;
}

function cleanExamTitle(title: string): string {
    return title.replace(/^\[예시]\s*/, "");
}

function shortExamTitle(title: string): string {
    return cleanExamTitle(title)
        .replace("영어 독해 실전", "영어 독해")
        .replace("기말고사 대비 종합평가", "기말 대비")
        .replace("2학기 수학 중간고사", "수학 중간")
        .replace("통합과학 단원평가", "통합과학")
        .replace("수학 I 함수의 극한", "함수의 극한")
        .replace("1차 수학 진단평가", "수학 진단");
}

function percent(value: number): string {
    return `${Math.round(value)}%`;
}

export default function MockupOverview({
    exams,
    attempts,
    rosterGroups,
    totalStudents,
    averageScore,
    onNavigateToExamAnalytics,
}: MockupOverviewProps) {
    const model = useMemo(() => {
        const examById = new Map(exams.map(exam => [exam.id, exam]));
        const scoreLookup = buildAttemptScoreLookup(attempts, examById);
        const orderedExams = [...exams].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
        const rows = orderedExams.map(exam => {
            const examAttempts = attempts.filter(attempt => attempt.examId === exam.id && !attempt.retake);
            const score = examAttempts.length > 0
                ? examAttempts.reduce((sum, attempt) => sum + (scoreLookup.get(attempt.id)?.scorePercent ?? 0), 0) / examAttempts.length
                : 0;
            return {
                id: exam.id,
                title: cleanExamTitle(exam.title),
                shortTitle: shortExamTitle(exam.title),
                average: Math.round(score * 10) / 10,
                participants: examAttempts.length,
                participation: totalStudents > 0 ? examAttempts.length / totalStudents * 100 : 0,
                archived: !!exam.archived,
                createdAt: exam.createdAt,
            };
        });

        const classRows = rosterGroups.map(group => {
            const groupAttempts = attempts.filter(attempt => attempt.groupId === group.id && !attempt.retake);
            const average = groupAttempts.length > 0
                ? groupAttempts.reduce((sum, attempt) => sum + (scoreLookup.get(attempt.id)?.scorePercent ?? 0), 0) / groupAttempts.length
                : group.avgScore;
            return { name: group.name, average: Math.round(average * 10) / 10, color: group.name === "2학년 3반" ? "#ff766f" : "#65cdb2" };
        });

        const possibleAttempts = Math.max(1, exams.length * totalStudents);
        return {
            rows,
            recentRows: [...rows].reverse().slice(0, 6),
            classRows,
            completionRate: Math.round(attempts.filter(attempt => attempt.status === "completed").length / possibleAttempts * 100),
            activeExamCount: exams.filter(exam => !exam.archived).length,
        };
    }, [attempts, exams, rosterGroups, totalStudents]);

    const exportSummary = () => {
        const header = "시험명,응시 학생,참여율,평균 점수,상태";
        const rows = model.rows.map(row => [
            row.title,
            row.participants,
            percent(row.participation),
            `${row.average}점`,
            row.archived ? "채점 완료" : "진행 중",
        ].join(","));
        const blob = new Blob(["\uFEFF" + [header, ...rows].join("\n")], { type: "text/csv;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = "omr-maker-demo-summary.csv";
        anchor.click();
        URL.revokeObjectURL(url);
    };

    const metrics = [
        { label: "평균 점수", value: `${averageScore.toFixed(1)}점`, detail: "전체 시험 기준", icon: TrendingUp, tone: "blue" },
        { label: "응시 학생", value: `${totalStudents}명`, detail: "4개 반 누적", icon: Users, tone: "mint" },
        { label: "진행 중 시험", value: `${model.activeExamCount}개`, detail: "분석 가능한 시험", icon: FileCheck2, tone: "blue" },
        { label: "채점 완료", value: `${model.completionRate}%`, detail: "예정 응시 기준", icon: CheckCircle2, tone: "mint" },
    ] as const;

    return (
        <section className="mockup-overview" aria-label="데모 계정 대시보드 개요">
            <div className="mockup-metric-grid">
                {metrics.map(metric => {
                    const Icon = metric.icon;
                    return (
                        <article className="mockup-metric" key={metric.label}>
                            <span className={`mockup-metric-icon is-${metric.tone}`} aria-hidden="true"><Icon size={23} /></span>
                            <span className="mockup-metric-copy">
                                <span className="mockup-metric-label">{metric.label}</span>
                                <strong>{metric.value}</strong>
                                <span>{metric.detail}</span>
                            </span>
                        </article>
                    );
                })}
            </div>

            <div className="mockup-primary-grid">
                <article className="mockup-panel mockup-trend-panel">
                    <div className="mockup-panel-heading">
                        <div>
                            <h2>시험별 평균 점수 추이</h2>
                            <p>최근 7개 시험에서 성취도가 꾸준히 상승하고 있어요.</p>
                        </div>
                        <span className="mockup-legend"><i /> 평균 점수</span>
                    </div>
                    <div className="mockup-chart" aria-label="최근 7개 시험 평균 점수 선 그래프">
                        <ResponsiveContainer
                            width="100%"
                            height="100%"
                            minWidth={0}
                            minHeight={0}
                            initialDimension={{ width: 860, height: 195 }}
                        >
                            <AreaChart data={model.rows} margin={{ top: 18, right: 18, bottom: 4, left: -18 }}>
                                <defs>
                                    <linearGradient id="mockupScoreFill" x1="0" y1="0" x2="0" y2="1">
                                        <stop offset="0%" stopColor="#1769e0" stopOpacity={0.16} />
                                        <stop offset="100%" stopColor="#1769e0" stopOpacity={0} />
                                    </linearGradient>
                                </defs>
                                <CartesianGrid stroke="#e8edf5" strokeDasharray="4 4" vertical={false} />
                                <XAxis dataKey="shortTitle" axisLine={false} tickLine={false} tick={{ fill: "#718096", fontSize: 11, fontWeight: 700 }} dy={10} />
                                <YAxis domain={[50, 100]} axisLine={false} tickLine={false} tick={{ fill: "#94a3b8", fontSize: 11 }} />
                                <Tooltip
                                    cursor={{ stroke: "#b9cdf0", strokeDasharray: "4 4" }}
                                    formatter={(value) => [`${Number(value).toFixed(1)}점`, "평균 점수"]}
                                    labelFormatter={(_, payload) => payload[0]?.payload?.title || ""}
                                    contentStyle={{ border: "1px solid #dfe7f1", borderRadius: 10, boxShadow: "0 10px 28px rgba(15,39,71,0.1)", fontSize: 12 }}
                                />
                                <Area type="monotone" dataKey="average" stroke="#1769e0" strokeWidth={3} fill="url(#mockupScoreFill)" dot={{ r: 4, fill: "#fff", stroke: "#1769e0", strokeWidth: 3 }} activeDot={{ r: 6 }} />
                            </AreaChart>
                        </ResponsiveContainer>
                    </div>
                </article>

                <article className="mockup-panel mockup-insights-panel">
                    <div className="mockup-panel-heading">
                        <div>
                            <h2>학습 인사이트</h2>
                            <p>지금 확인하면 좋은 변화 3가지예요.</p>
                        </div>
                    </div>
                    <div className="mockup-insight-list">
                        <button type="button" onClick={() => onNavigateToExamAnalytics("mock-calculus-limit")}>
                            <span className="mockup-insight-icon is-mint"><Target size={18} /></span>
                            <span><strong>함수의 극한 정답률 58%</strong><small>최근 3회 평균보다 9%p 낮아요.</small></span>
                            <em>개선 필요</em>
                        </button>
                        <button type="button" onClick={() => onNavigateToExamAnalytics("mock-final-comprehensive")}>
                            <span className="mockup-insight-icon is-blue"><Users size={18} /></span>
                            <span><strong>2학년 3반이 평균 대비 6.2점 낮아요</strong><small>반별 평균 점수 비교 기준</small></span>
                            <ArrowRight size={17} />
                        </button>
                        <button type="button" onClick={() => onNavigateToExamAnalytics("mock-math-midterm")}>
                            <span className="mockup-insight-icon is-coral"><CircleAlert size={18} /></span>
                            <span><strong>서술형 12번 오답이 집중됐어요</strong><small>풀이 근거 누락 유형을 확인해보세요.</small></span>
                            <em className="is-warning">주의</em>
                        </button>
                    </div>
                </article>
            </div>

            <div className="mockup-secondary-grid">
                <article className="mockup-panel mockup-exams-panel">
                    <div className="mockup-panel-heading">
                        <div>
                            <h2>최근 시험</h2>
                            <p>시험명을 선택하면 문항·반별 분석으로 이동합니다.</p>
                        </div>
                    </div>
                    <div className="mockup-table-wrap">
                        <table className="mockup-exam-table">
                            <thead><tr><th>시험명</th><th>응시 학생</th><th>평균 점수</th><th>상태</th><th><span className="sr-only">분석 열기</span></th></tr></thead>
                            <tbody>
                                {model.recentRows.map(row => (
                                    <tr key={row.id}>
                                        <td><button type="button" onClick={() => onNavigateToExamAnalytics(row.id)}>{row.title}</button></td>
                                        <td>{row.participants}명 <small>{percent(row.participation)}</small></td>
                                        <td><strong>{row.average.toFixed(1)}점</strong></td>
                                        <td><span className={row.archived ? "is-complete" : "is-live"}>{row.archived ? "채점 완료" : "진행 중"}</span></td>
                                        <td><button type="button" className="mockup-row-action" aria-label={`${row.title} 분석 보기`} onClick={() => onNavigateToExamAnalytics(row.id)}><ArrowRight size={15} /></button></td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </article>

                <article className="mockup-panel mockup-class-panel">
                    <div className="mockup-panel-heading">
                        <div>
                            <h2>반별 평균 점수 비교</h2>
                            <p>전체 평균 <strong>{averageScore.toFixed(1)}점</strong></p>
                        </div>
                    </div>
                    <div className="mockup-class-chart" aria-label="반별 평균 점수 막대 그래프">
                        <ResponsiveContainer
                            width="100%"
                            height="100%"
                            minWidth={0}
                            minHeight={0}
                            initialDimension={{ width: 700, height: 235 }}
                        >
                            <BarChart data={model.classRows} margin={{ top: 22, right: 4, bottom: 0, left: -24 }}>
                                <CartesianGrid stroke="#edf1f6" vertical={false} />
                                <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fill: "#64748b", fontSize: 11, fontWeight: 700 }} />
                                <YAxis domain={[60, 100]} axisLine={false} tickLine={false} tick={{ fill: "#94a3b8", fontSize: 10 }} />
                                <Tooltip formatter={(value) => [`${Number(value).toFixed(1)}점`, "반 평균"]} contentStyle={{ border: "1px solid #dfe7f1", borderRadius: 10, fontSize: 12 }} />
                                <Bar dataKey="average" radius={[7, 7, 0, 0]} maxBarSize={42}>
                                    {model.classRows.map(row => <Cell key={row.name} fill={row.color} />)}
                                </Bar>
                            </BarChart>
                        </ResponsiveContainer>
                    </div>
                </article>
            </div>

            <div className="mockup-overview-actions">
                <button type="button" className="mockup-secondary-action" onClick={exportSummary}><Download size={17} /> 통계 내보내기</button>
                <button type="button" className="mockup-primary-action" onClick={() => onNavigateToExamAnalytics(model.recentRows[0]?.id || exams[0]?.id)}><LineChartIcon size={17} /> 시험별 분석 보기</button>
            </div>
        </section>
    );
}
