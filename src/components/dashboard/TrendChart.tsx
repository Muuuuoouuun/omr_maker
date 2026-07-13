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

    return (
        <div style={{ width: '100%', minWidth: 0, height }}>
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
