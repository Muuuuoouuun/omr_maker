"use client";

import { useEffect, useRef } from "react";
import {
    CartesianGrid,
    Line,
    LineChart,
    ResponsiveContainer,
    XAxis,
    YAxis,
} from "recharts";
import type { StudentGrowthRow } from "@/lib/studentGrowthReport";
import styles from "./StudentResultHub.module.css";

interface GrowthTrendChartProps {
    rows: StudentGrowthRow[];
}

interface GrowthPointProps {
    cx?: number;
    cy?: number;
    payload?: GrowthChartRow;
}

type GrowthChartRow = Omit<StudentGrowthRow, "classAverage" | "gap"> & {
    classAverage: number | null;
    gap: number | null;
    axisLabel: string;
    comparisonAvailable: boolean;
};

function formatGap(value: number): string {
    return `${value > 0 ? "+" : ""}${value}%p`;
}

function shortExamLabel(row: StudentGrowthRow, index: number): string {
    const title = row.examTitle.trim();
    const shortTitle = title.length > 6 ? `${title.slice(0, 6)}…` : title || "시험";
    return `${index + 1} · ${shortTitle}`;
}

function GrowthPoint({ cx, cy, payload }: GrowthPointProps) {
    if (cx == null || cy == null || !payload) return null;

    const gapLabel = payload.gap == null ? "" : formatGap(payload.gap);
    const pillWidth = Math.max(38, 15 + gapLabel.length * 7);
    const rankLabel = payload.rank == null
        ? "등수 미제공"
        : `${payload.rank}등 / ${payload.participantCount}명`;

    return (
        <g className={payload.isLatest ? styles.latestGrowthPoint : styles.growthPoint} pointerEvents="none">
            {payload.isLatest && (
                <circle
                    className={styles.latestPointHalo}
                    cx={cx}
                    cy={cy}
                    r={10}
                    fill="var(--surface)"
                    stroke="var(--primary)"
                    strokeWidth={2}
                />
            )}
            <circle cx={cx} cy={cy} r={5} fill="var(--primary)" stroke="var(--surface)" strokeWidth={3} />
            {payload.comparisonAvailable && (
                <>
                    <g className={styles.growthGapPill} transform={`translate(${cx - pillWidth / 2} ${cy - 36})`}>
                        <g className={styles.growthEvidenceContent}>
                            <rect width={pillWidth} height={20} rx={10} fill="var(--surface)" stroke="var(--border)" />
                            <text
                                x={pillWidth / 2}
                                y={14}
                                textAnchor="middle"
                                fill="var(--foreground)"
                                fontSize={11}
                                fontWeight={800}
                            >
                                {gapLabel}
                            </text>
                        </g>
                    </g>
                    <g className={styles.growthEvidenceContent}>
                        <text
                            className={styles.growthRankLabel}
                            x={cx}
                            y={cy + 26}
                            textAnchor="middle"
                            fill="var(--foreground)"
                            fontSize={11}
                            fontWeight={800}
                        >
                            {rankLabel}
                        </text>
                    </g>
                </>
            )}
        </g>
    );
}

function ClassAveragePoint({ cx, cy, payload }: GrowthPointProps) {
    if (
        cx == null
        || cy == null
        || !payload?.comparisonAvailable
        || payload.classAverage == null
    ) {
        return null;
    }
    return (
        <circle
            className={styles.growthAveragePoint}
            cx={cx}
            cy={cy}
            r={4}
            fill="var(--surface)"
            stroke="var(--muted)"
            strokeWidth={2}
            pointerEvents="none"
        />
    );
}

function useGrowthChartMountAnimation(chartRef: React.RefObject<HTMLDivElement | null>) {
    useEffect(() => {
        const chart = chartRef.current;
        if (!chart) return;
        const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
        const appMotionOff = document.documentElement.dataset.motion === "off";
        if (reduceMotion || appMotionOff) return;

        const frame = window.requestAnimationFrame(() => {
            chart.classList.add(styles.growthChartAnimated);
        });
        return () => {
            window.cancelAnimationFrame(frame);
            chart.classList.remove(styles.growthChartAnimated);
        };
    }, [chartRef]);
}

export default function GrowthTrendChart({ rows }: GrowthTrendChartProps) {
    const chartRef = useRef<HTMLDivElement>(null);
    useGrowthChartMountAnimation(chartRef);
    const chartData: GrowthChartRow[] = rows.map((row, index) => {
        const comparisonAvailable = row.participantCount >= 2;
        return {
            ...row,
            classAverage: comparisonAvailable ? row.classAverage : null,
            gap: comparisonAvailable ? row.gap : null,
            axisLabel: shortExamLabel(row, index),
            comparisonAvailable,
        };
    });
    const hasComparison = chartData.some(row => row.comparisonAvailable);
    const chartMinWidth = rows.length <= 4 ? "100%" : `${rows.length * 112}px`;

    return (
        <div className={styles.growthChartBlock}>
            <div className={styles.growthChartLegend} aria-hidden="true">
                <span className={styles.growthLegendStudent}>학생 점수</span>
                {hasComparison && <span className={styles.growthLegendAverage}>반 평균</span>}
            </div>
            <p className={styles.growthScrollHint}>가로로 스크롤하여 시험별 추세 더 보기</p>
            <div
                ref={chartRef}
                data-testid="growth-chart-shell"
                className={styles.growthChartShell}
                role="region"
                aria-label="개인 성장 그래프 가로 스크롤 영역"
                tabIndex={0}
            >
                <div
                    className={styles.growthChartCanvas}
                    data-testid="growth-chart-canvas"
                    aria-hidden="true"
                    style={{ minWidth: chartMinWidth }}
                >
                    <ResponsiveContainer
                        width="100%"
                        height="100%"
                        minWidth={0}
                        minHeight={300}
                        initialDimension={{ width: 720, height: 300 }}
                    >
                        <LineChart data={chartData} margin={{ top: 52, right: 48, bottom: 26, left: 0 }}>
                            <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 5" />
                            <XAxis
                                dataKey="axisLabel"
                                tick={{ fill: "var(--muted)", fontSize: 11, fontWeight: 700 }}
                                tickLine={false}
                                axisLine={{ stroke: "var(--border)" }}
                                interval={0}
                            />
                            <YAxis
                                domain={[0, 100]}
                                ticks={[0, 25, 50, 75, 100]}
                                width={34}
                                tick={{ fill: "var(--muted)", fontSize: 11 }}
                                tickLine={false}
                                axisLine={false}
                            />
                            {hasComparison && (
                                <Line
                                    type="monotone"
                                    dataKey="classAverage"
                                    name="반 평균"
                                    stroke="var(--muted)"
                                    strokeWidth={2}
                                    strokeDasharray="6 6"
                                    dot={<ClassAveragePoint />}
                                    activeDot={false}
                                    connectNulls={false}
                                    isAnimationActive={false}
                                />
                            )}
                            <Line
                                type="monotone"
                                dataKey="studentScore"
                                name="학생 점수"
                                className={`${styles.studentLine} studentLine`}
                                stroke="var(--primary)"
                                strokeWidth={3}
                                dot={<GrowthPoint />}
                                activeDot={false}
                                isAnimationActive={false}
                            />
                        </LineChart>
                    </ResponsiveContainer>
                </div>
            </div>
        </div>
    );
}
