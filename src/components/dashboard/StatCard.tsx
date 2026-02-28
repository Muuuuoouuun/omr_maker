import { ReactNode } from "react";

interface StatCardProps {
    title: string;
    value: string | number;
    icon?: ReactNode;
    trend?: string;
    trendUp?: boolean;
    color?: string;
}

export default function StatCard({ title, value, icon, trend, trendUp, color = "var(--primary)" }: StatCardProps) {
    return (
        <div className="bento-card col-span-1 card-hover" style={{ justifyContent: 'space-between', position: 'relative', overflow: 'hidden' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <span style={{ color: 'var(--muted)', fontSize: '0.95rem', fontWeight: 600, letterSpacing: '-0.01em' }}>{title}</span>
                {icon && (
                    <div style={{
                        color: color,
                        background: color.startsWith('#') ? `${color}15` : `color-mix(in srgb, ${color}, transparent 85%)`,
                        padding: '10px', borderRadius: '12px',
                        display: 'flex', alignItems: 'center', justifyContent: 'center'
                    }}>
                        {icon}
                    </div>
                )}
            </div>

            <div style={{ marginTop: 'auto' }}>
                <div style={{ fontSize: '2.75rem', fontWeight: 800, color: 'var(--foreground)', lineHeight: 1.1, letterSpacing: '-0.03em' }}>
                    {value}
                </div>
                {trend && (
                    <div style={{
                        fontSize: '0.85rem',
                        fontWeight: 600,
                        marginTop: '0.75rem',
                        color: trendUp ? 'var(--success)' : 'var(--error)',
                        display: 'flex', alignItems: 'center', gap: '6px',
                        background: trendUp ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                        padding: '4px 8px', borderRadius: '6px', width: 'fit-content'
                    }}>
                        <span>{trendUp ? '↗' : '↘'}</span>
                        <span>{trend}</span>
                        <span style={{ color: 'var(--muted)', fontWeight: 400, marginLeft: '4px' }}>vs last 30d</span>
                    </div>
                )}
            </div>

            {/* Subtle background decoration */}
            <div style={{
                position: 'absolute', bottom: '-20px', right: '-20px',
                width: '100px', height: '100px',
                background: `radial-gradient(circle, ${color}10 0%, transparent 70%)`,
                pointerEvents: 'none'
            }}></div>
        </div>
    );
}
