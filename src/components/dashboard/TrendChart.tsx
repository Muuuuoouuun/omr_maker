"use client";

import { useId, useMemo } from "react";
import { AreaChart, Area, ResponsiveContainer, Tooltip } from "recharts";

interface TrendChartProps {
    data: number[];
    labels?: string[];
    color?: string;
    height?: number;
}

export default function TrendChart({ data, labels, color = "#ffffff", height = 100 }: TrendChartProps) {
    // Namespaced per-instance so two charts sharing a color don't collide on the
    // gradient id (which previously derived only from the color).
    const rawId = useId();
    const gradientId = `trend-gradient-${rawId.replace(/[^a-zA-Z0-9_-]/g, "")}`;

    const chartData = useMemo(() => {
        return data.map((val, i) => ({
            name: (labels && labels[i]) ? labels[i] : `Exam ${i + 1}`,
            score: val
        }));
    }, [data, labels]);

    if (data.length === 0) {
        return (
            <div style={{
                height,
                minWidth: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color,
                opacity: 0.78,
                fontSize: '0.9rem',
                fontWeight: 700,
                textAlign: 'center',
                padding: '0 1rem',
            }}>
                아직 제출 점수가 없습니다
            </div>
        );
    }

    if (data.length === 1) {
        return (
            <div
                role="status"
                aria-label={`최근 시험 평균 점수 ${data[0]}점. 비교할 시험이 쌓이면 추이가 표시됩니다.`}
                style={{
                    width: '100%',
                    minWidth: 0,
                    height,
                    display: 'grid',
                    placeItems: 'center',
                    color,
                    textAlign: 'center',
                }}
            >
                <div>
                    <strong style={{ display: 'block', fontSize: '2.25rem', lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>
                        {data[0]}점
                    </strong>
                    <span style={{ display: 'block', marginTop: '0.65rem', fontSize: '0.82rem', fontWeight: 700, opacity: 0.78 }}>
                        비교할 시험이 쌓이면 추이를 표시합니다
                    </span>
                </div>
            </div>
        );
    }

    return (
        <div
            style={{ width: '100%', minWidth: 0, height }}
            role="img"
            tabIndex={0}
            aria-label={`최근 ${data.length}개 시험 평균 점수 추이. 최신 점수 ${data[data.length - 1]}점.`}
        >
            <ResponsiveContainer
                width="100%"
                height="100%"
                minWidth={0}
                minHeight={height}
                initialDimension={{ width: 640, height }}
            >
                <AreaChart data={chartData} margin={{ top: 10, right: 10, left: 10, bottom: 0 }}>
                    <defs>
                        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor={color} stopOpacity={0.4} />
                            <stop offset="95%" stopColor={color} stopOpacity={0} />
                        </linearGradient>
                    </defs>
                    <Tooltip
                        contentStyle={{
                            borderRadius: '12px',
                            border: '1px solid var(--border)',
                            boxShadow: '0 8px 30px rgba(0,0,0,0.12)',
                            background: 'var(--surface)',
                            color: 'var(--foreground)'
                        }}
                        itemStyle={{ color: 'var(--primary)', fontWeight: 800 }}
                        labelStyle={{ color: 'var(--muted)', marginBottom: '4px', fontSize: '0.85rem' }}
                        // Show the exam title/date (from `labels`) as the tooltip heading
                        // instead of the raw category index.
                        labelFormatter={(_label, payload) => (
                            payload && payload.length > 0 ? payload[0].payload.name : ''
                        )}
                        formatter={(value: number | string | undefined) => [`${value}점`, '평균 점수']}
                    />
                    <Area
                        type="monotone"
                        dataKey="score"
                        stroke={color}
                        fill={`url(#${gradientId})`}
                        strokeWidth={3}
                        animationDuration={1500}
                        animationEasing="ease-out"
                        activeDot={{ r: 7, strokeWidth: 0, fill: color }}
                        dot={{ r: 5, strokeWidth: 2, fill: 'var(--primary-dark)', stroke: color }}
                    />
                </AreaChart>
            </ResponsiveContainer>
        </div>
    );
}
