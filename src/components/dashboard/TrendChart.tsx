"use client";

import { useMemo } from "react";
import { AreaChart, Area, ResponsiveContainer, Tooltip } from "recharts";

interface TrendChartProps {
    data: number[];
    labels?: string[];
    color?: string;
    height?: number;
}

export default function TrendChart({ data, labels, color = "#ffffff", height = 100 }: TrendChartProps) {
    const chartData = useMemo(() => {
        return data.map((val, i) => ({
            name: labels ? labels[i] : `Exam ${i + 1}`,
            score: val
        }));
    }, [data, labels]);

    if (data.length === 0) return <div style={{ height }} />;

    return (
        <div style={{ width: '100%', height: `${height}px` }}>
            <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 10, right: 10, left: 10, bottom: 0 }}>
                    <defs>
                        <linearGradient id={`gradient_${color}`} x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor={color} stopOpacity={0.4} />
                            <stop offset="95%" stopColor={color} stopOpacity={0} />
                        </linearGradient>
                    </defs>
                    <Tooltip
                        contentStyle={{
                            borderRadius: '12px',
                            border: 'none',
                            boxShadow: '0 8px 30px rgba(0,0,0,0.12)',
                            background: 'white',
                            color: '#1e293b'
                        }}
                        itemStyle={{ color: '#4f46e5', fontWeight: 800 }}
                        labelStyle={{ color: '#64748b', marginBottom: '4px', fontSize: '0.85rem' }}
                    />
                    <Area
                        type="monotone"
                        dataKey="score"
                        stroke={color}
                        fill={`url(#gradient_${color})`}
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
