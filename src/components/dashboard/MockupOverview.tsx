"use client";

import { useMemo, useRef } from "react";
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
import { serializeCsvRows } from "@/lib/csv";
import CountUp, { parseCountableValue } from "@/components/dashboard/CountUp";
import WaveBar from "@/components/dashboard/WaveBar";
import useCometReveal from "@/components/dashboard/useCometReveal";

interface MockupOverviewProps {
    exams: Exam[];
    attempts: Attempt[];
    rosterGroups: RosterGroup[];
    totalStudents: number;
    averageScore: number;
    onNavigateToExamAnalytics: (examId: string) => void;
    onNavigateToStudentAnalytics: () => void;
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
    onNavigateToStudentAnalytics,
}: MockupOverviewProps) {
    const model = useMemo(() => {
        const examById = new Map(exams.map(exam => [exam.id, exam]));
        const scoreLookup = buildAttemptScoreLookup(attempts, examById);
        const attemptsByExamId = new Map<string, Attempt[]>();
        const attemptsByGroupId = new Map<string, Attempt[]>();
        for (const attempt of attempts) {
            if (attempt.retake) continue;
            const examAttempts = attemptsByExamId.get(attempt.examId);
            if (examAttempts) examAttempts.push(attempt);
            else attemptsByExamId.set(attempt.examId, [attempt]);

            if (!attempt.groupId) continue;
            const groupAttempts = attemptsByGroupId.get(attempt.groupId);
            if (groupAttempts) groupAttempts.push(attempt);
            else attemptsByGroupId.set(attempt.groupId, [attempt]);
        }
        const orderedExams = [...exams].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
        const rows = orderedExams.map(exam => {
            const examAttempts = attemptsByExamId.get(exam.id) || [];
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
            const groupAttempts = attemptsByGroupId.get(group.id) || [];
            const average = groupAttempts.length > 0
                ? groupAttempts.reduce((sum, attempt) => sum + (scoreLookup.get(attempt.id)?.scorePercent ?? 0), 0) / groupAttempts.length
                : group.avgScore;
            return { name: group.name, average: Math.round(average * 10) / 10, color: group.name === "2학년 3반" ? "#ff766f" : "#65cdb2" };
        });

        const possibleAttempts = Math.max(1, exams.length * totalStudents);
        const completedAttemptCount = attempts.filter(attempt => !attempt.retake && attempt.status === "completed").length;
        return {
            rows,
            recentRows: [...rows].reverse().slice(0, 6),
            classRows,
            completionRate: Math.round(completedAttemptCount / possibleAttempts * 100),
            completedAttemptCount,
            possibleAttempts,
            activeExamCount: exams.filter(exam => !exam.archived).length,
        };
    }, [attempts, exams, rosterGroups, totalStudents]);

    const exportSummary = () => {
        const csv = serializeCsvRows([
            ["시험명", "응시 학생", "참여율", "평균 점수", "상태"],
            ...model.rows.map(row => [
                row.title,
                row.participants,
                percent(row.participation),
                `${row.average}점`,
                row.archived ? "채점 완료" : "진행 중",
            ]),
        ]);
        const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = "omr-maker-demo-summary.csv";
        anchor.click();
        URL.revokeObjectURL(url);
    };

    const scoredRows = model.rows.filter(row => row.participants > 0);
    const latestRow = scoredRows.at(-1);
    const previousRow = scoredRows.at(-2);
    const activeRow = model.recentRows.find(row => !row.archived) || latestRow;
    const lowestParticipationRow = model.rows
        .filter(row => row.participants > 0)
        .reduce<(typeof model.rows)[number] | undefined>((lowest, row) => (
            !lowest || row.participation < lowest.participation ? row : lowest
        ), undefined);
    const averageDelta = latestRow && previousRow ? latestRow.average - previousRow.average : 0;
    const averageComparison = previousRow
        ? `직전 시험보다 ${Math.abs(averageDelta).toFixed(1)}점 ${averageDelta >= 0 ? "상승" : "하락"}`
        : "직전 시험 비교 데이터 준비 중";

    // 시안 B — comet head leads the demo trend line draw (soft-light variant).
    const trendChartRef = useRef<HTMLDivElement | null>(null);
    useCometReveal(trendChartRef, {
        color: "#1769e0",
        replayKey: model.rows,
        enabled: model.rows.length > 1,
    });

    const metrics = [
        {
            label: "전체 평균 점수",
            value: `${averageScore.toFixed(1)}점`,
            detail: latestRow ? `최근 ${latestRow.shortTitle} ${latestRow.average.toFixed(1)}점` : "전체 완료 응시 기준",
            comparison: averageComparison,
            comparisonTone: averageDelta > 0 ? "positive" : averageDelta < 0 ? "negative" : "neutral",
            actionLabel: "점수 원인 보기",
            icon: TrendingUp,
            tone: "blue",
            onAction: () => onNavigateToExamAnalytics(latestRow?.id || exams[0]?.id || ""),
        },
        {
            label: "명단 학생",
            value: `${totalStudents}명`,
            detail: `${rosterGroups.length}개 반 · 등록 명단 기준`,
            comparison: latestRow ? `최근 시험 참여율 ${percent(latestRow.participation)}` : "응시 데이터 준비 중",
            comparisonTone: latestRow && latestRow.participation < 80 ? "negative" : "positive",
            actionLabel: "학생별 성취 보기",
            icon: Users,
            tone: "mint",
            onAction: onNavigateToStudentAnalytics,
        },
        {
            label: "진행 중 시험",
            value: `${model.activeExamCount}개`,
            detail: `전체 ${exams.length}개 시험 중`,
            comparison: activeRow ? `최근 확인: ${activeRow.shortTitle}` : "진행 시험 없음",
            comparisonTone: "neutral",
            actionLabel: "진행 시험 분석",
            icon: FileCheck2,
            tone: "blue",
            onAction: () => onNavigateToExamAnalytics(activeRow?.id || exams[0]?.id || ""),
        },
        {
            label: "응시 완료율",
            value: `${model.completionRate}%`,
            detail: `완료 ${model.completedAttemptCount}/${model.possibleAttempts}건`,
            comparison: lowestParticipationRow
                ? `최저 참여: ${lowestParticipationRow.shortTitle} ${percent(lowestParticipationRow.participation)}`
                : "예정 응시 기준",
            comparisonTone: model.completionRate < 80 ? "negative" : "positive",
            actionLabel: "미응시·이탈 확인",
            icon: CheckCircle2,
            tone: "mint",
            onAction: () => onNavigateToExamAnalytics(lowestParticipationRow?.id || latestRow?.id || exams[0]?.id || ""),
        },
    ] as const;

    return (
        <section className="mockup-overview" aria-label="데모 계정 대시보드 개요">
            <div className="mockup-metric-grid">
                {metrics.map((metric, metricIndex) => {
                    const Icon = metric.icon;
                    const countable = parseCountableValue(metric.value);
                    return (
                        <article className="mockup-metric kpi-spring" style={{ animationDelay: `${metricIndex * 80}ms` }} key={metric.label}>
                            <button
                                type="button"
                                className="mockup-metric-action"
                                onClick={metric.onAction}
                                aria-label={`${metric.label} ${metric.value}. ${metric.comparison}. ${metric.actionLabel}`}
                            >
                                <span className={`mockup-metric-icon is-${metric.tone}`} aria-hidden="true"><Icon size={23} /></span>
                                <span className="mockup-metric-copy">
                                    <span className="mockup-metric-label">{metric.label}</span>
                                    <strong>
                                        {countable ? (
                                            <CountUp
                                                value={countable.num}
                                                decimals={countable.decimals}
                                                prefix={countable.prefix}
                                                suffix={countable.suffix}
                                                delayMs={metricIndex * 80 + 150}
                                            />
                                        ) : (
                                            metric.value
                                        )}
                                    </strong>
                                    <span className="mockup-metric-detail">{metric.detail}</span>
                                    <span className="mockup-metric-footer">
                                        <span className={`mockup-metric-change is-${metric.comparisonTone}`}>{metric.comparison}</span>
                                        <span className="mockup-metric-link">{metric.actionLabel}<ArrowRight size={14} /></span>
                                    </span>
                                </span>
                            </button>
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
                    <div ref={trendChartRef} className="mockup-chart comet-chart-light" aria-label="최근 7개 시험 평균 점수 선 그래프">
                        <ResponsiveContainer
                            width="100%"
                            height="100%"
                            minWidth={1}
                            minHeight={1}
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
                                <Area type="monotone" dataKey="average" className="comet-target" stroke="#1769e0" strokeWidth={3} fill="url(#mockupScoreFill)" dot={{ r: 4, fill: "#fff", stroke: "#1769e0", strokeWidth: 3 }} activeDot={{ r: 6 }} isAnimationActive={false} />
                            </AreaChart>
                        </ResponsiveContainer>
                    </div>
                </article>

                <article className="mockup-panel mockup-insights-panel">
                    <div className="mockup-panel-heading">
                        <div>
                            <h2>오늘의 우선 조치</h2>
                            <p>학습 영향이 큰 순서대로 바로 확인할 수 있어요.</p>
                        </div>
                    </div>
                    <div className="mockup-insight-list">
                        <button type="button" onClick={() => onNavigateToExamAnalytics("mock-calculus-limit")}>
                            <span className="mockup-insight-icon is-mint"><Target size={18} /></span>
                            <span><strong>함수의 극한 정답률 58%</strong><small>최근 3회 평균보다 9%p 낮아요 · 1순위 보완</small></span>
                            <span className="mockup-insight-action">문항 분석 <ArrowRight size={15} /></span>
                        </button>
                        <button type="button" onClick={() => onNavigateToExamAnalytics("mock-final-comprehensive")}>
                            <span className="mockup-insight-icon is-blue"><Users size={18} /></span>
                            <span><strong>2학년 3반이 평균 대비 6.2점 낮아요</strong><small>반별 평균 점수 비교 기준 · 집중 지도 대상</small></span>
                            <span className="mockup-insight-action">반 비교 <ArrowRight size={15} /></span>
                        </button>
                        <button type="button" onClick={() => onNavigateToExamAnalytics("mock-math-midterm")}>
                            <span className="mockup-insight-icon is-coral"><CircleAlert size={18} /></span>
                            <span><strong>서술형 12번 오답이 집중됐어요</strong><small>풀이 근거 누락 유형 · 재지도 권장</small></span>
                            <span className="mockup-insight-action">오답 유형 <ArrowRight size={15} /></span>
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
                            minWidth={1}
                            minHeight={1}
                            initialDimension={{ width: 700, height: 235 }}
                        >
                            <BarChart data={model.classRows} margin={{ top: 22, right: 4, bottom: 0, left: -24 }}>
                                <CartesianGrid stroke="#edf1f6" vertical={false} />
                                <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fill: "#64748b", fontSize: 11, fontWeight: 700 }} />
                                <YAxis domain={[60, 100]} axisLine={false} tickLine={false} tick={{ fill: "#94a3b8", fontSize: 10 }} />
                                <Tooltip formatter={(value) => [`${Number(value).toFixed(1)}점`, "반 평균"]} contentStyle={{ border: "1px solid #dfe7f1", borderRadius: 10, fontSize: 12 }} />
                                <Bar dataKey="average" maxBarSize={42} isAnimationActive={false} shape={<WaveBar radius={7} />}>
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
