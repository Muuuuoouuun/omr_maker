"use client";

import Link from "next/link";
import ThemeToggle from "./ThemeToggle";

interface TeacherHeaderProps {
    badge?: string;
    badgeColor?: string;
}

export default function TeacherHeader({ badge = "TEACHER", badgeColor }: TeacherHeaderProps) {
    const color = badgeColor || "var(--primary)";
    return (
        <header className="header">
            <div className="container header-content">
                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                    <Link href="/" className="logo">Classin</Link>
                    <span style={{
                        fontSize: '0.75rem', fontWeight: 700,
                        background: `color-mix(in srgb, ${color}, transparent 88%)`,
                        color,
                        padding: '4px 10px', borderRadius: 'var(--radius-full)',
                        border: `1px solid color-mix(in srgb, ${color}, transparent 78%)`
                    }}>
                        {badge}
                    </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                    <Link href="/teacher/dashboard" style={{
                        fontSize: '0.85rem', fontWeight: 600, color: 'var(--muted)',
                        padding: '0.5rem 0.9rem', borderRadius: 'var(--radius-full)',
                        transition: 'var(--transition-base)'
                    }} className="nav-link">Dashboard</Link>
                    <ThemeToggle />
                </div>
            </div>
        </header>
    );
}
