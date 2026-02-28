"use client";

import { useMemo } from "react";

interface TrendChartProps {
    data: number[];
    labels?: string[];
    color?: string;
    height?: number;
}

export default function TrendChart({ data, color = "#6366f1", height = 100 }: TrendChartProps) {
    const points = useMemo(() => {
        if (data.length === 0) return "";

        const max = Math.max(...data, 100);
        const min = 0;
        const range = max - min;

        const width = 100; // viewbox units
        const stepX = width / (data.length - 1 || 1);

        return data.map((val, i) => {
            const x = i * stepX;
            // Invert Y because SVG connects from top-left
            const y = 100 - ((val - min) / range) * 100;
            return `${x},${y}`;
        }).join(" ");
    }, [data]);

    return (
        <div style={{ width: '100%', height: `${height}px`, overflow: 'hidden' }}>
            <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ width: '100%', height: '100%', overflow: 'visible' }}>
                {/* Gradient Fill */}
                <defs>
                    <linearGradient id="gradient" x1="0" x2="0" y1="0" y2="1">
                        <stop offset="0%" stopColor={color} stopOpacity="0.2" />
                        <stop offset="100%" stopColor={color} stopOpacity="0" />
                    </linearGradient>
                </defs>

                {/* Area under the curve */}
                <path
                    d={`M0,100 L0,100 ${points.replace(/(\d+),(\d+)/g, "L$1,$2")} L100,100 Z`}
                    fill="url(#gradient)"
                    stroke="none"
                />

                {/* Line */}
                <polyline
                    fill="none"
                    stroke={color}
                    strokeWidth="3"
                    points={points}
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                />

                {/* Dots */}
                {data.map((val, i) => {
                    const max = Math.max(...data, 100);
                    const range = max; // assume 0 min
                    const x = i * (100 / (data.length - 1 || 1));
                    const y = 100 - (val / range) * 100;

                    return (
                        <circle
                            key={i}
                            cx={x}
                            cy={y}
                            r="4"
                            fill="white"
                            stroke={color}
                            strokeWidth="2"
                            vectorEffect="non-scaling-stroke"
                        />
                    );
                })}
            </svg>
        </div>
    );
}
