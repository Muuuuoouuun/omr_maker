"use client";

import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";
import { Lock } from "lucide-react";
import type { PlanKey } from "@/types/omr";
import { PLAN_BY_KEY } from "@/utils/plans";

const DEFAULT_REQUIRED_PLAN: PlanKey = "pro";
const DEFAULT_LOCKED_LABEL = "Pro 필요";
const DEFAULT_LOCKED_TITLE = "Pro 이상에서 사용할 수 있습니다.";

interface PremiumActionLinkProps {
    enabled: boolean;
    href: string;
    children: ReactNode;
    requiredPlan?: PlanKey;
    lockedLabel?: string;
    lockedTitle?: string;
    className?: string;
    style?: CSSProperties;
}

export function PremiumActionLink({
    enabled,
    href,
    children,
    requiredPlan = DEFAULT_REQUIRED_PLAN,
    lockedLabel,
    lockedTitle,
    className,
    style,
}: PremiumActionLinkProps) {
    const requiredPlanName = PLAN_BY_KEY[requiredPlan].name;
    const resolvedLockedLabel = lockedLabel ?? (requiredPlan === DEFAULT_REQUIRED_PLAN ? DEFAULT_LOCKED_LABEL : `${requiredPlanName} 필요`);
    const resolvedLockedTitle = lockedTitle ?? (requiredPlan === DEFAULT_REQUIRED_PLAN ? DEFAULT_LOCKED_TITLE : `${requiredPlanName} 이상에서 사용할 수 있습니다.`);

    if (enabled) {
        return (
            <Link href={href} className={className} style={style}>
                {children}
            </Link>
        );
    }

    return (
        <Link
            href="/teacher/billing"
            className={className}
            title={resolvedLockedTitle}
            aria-label={resolvedLockedTitle}
            style={{
                ...style,
                display: 'inline-flex',
                alignItems: 'center',
                gap: '0.35rem',
                border: '1px solid var(--border)',
                background: 'var(--surface)',
                color: 'var(--muted)',
                boxShadow: 'none',
            }}
        >
            <Lock size={13} />
            {resolvedLockedLabel}
        </Link>
    );
}

interface PremiumFeatureCardProps {
    title: string;
    description: string;
    requiredPlan?: PlanKey;
    badge?: string;
    ctaLabel?: string;
    style?: CSSProperties;
}

export function PremiumFeatureCard({
    title,
    description,
    requiredPlan = DEFAULT_REQUIRED_PLAN,
    badge,
    ctaLabel = "플랜 보기",
    style,
}: PremiumFeatureCardProps) {
    const resolvedBadge = badge ?? PLAN_BY_KEY[requiredPlan].name;

    return (
        <div
            role="status"
            aria-label={`${title} 잠금`}
            className="card"
            style={{
                padding: '1.2rem 1.35rem',
                border: '1px solid rgba(99,102,241,0.2)',
                background: 'linear-gradient(135deg, rgba(99,102,241,0.08), rgba(15,118,110,0.06))',
                ...style,
            }}
        >
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem', minWidth: 0, flex: 1 }}>
                    <div style={{
                        width: 34,
                        height: 34,
                        borderRadius: 'var(--radius-md)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0,
                        background: 'rgba(99,102,241,0.12)',
                        color: 'var(--primary)',
                    }}>
                        <Lock size={17} />
                    </div>
                    <div style={{ minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.25rem' }}>
                            <strong style={{ fontSize: '0.98rem', color: 'var(--foreground)' }}>{title}</strong>
                            <span style={{
                                fontSize: 'var(--type-micro)',
                                fontWeight: 900,
                                padding: '0.18rem 0.48rem',
                                borderRadius: '999px',
                                color: '#3730a3',
                                background: '#e0e7ff',
                            }}>
                                {resolvedBadge}
                            </span>
                        </div>
                        <p style={{ color: 'var(--muted)', fontSize: 'var(--type-body-sm)', lineHeight: 1.55, wordBreak: 'keep-all' }}>
                            {description}
                        </p>
                    </div>
                </div>
                <Link
                    href="/teacher/billing"
                    className="btn btn-secondary"
                    style={{
                        padding: '0.55rem 0.85rem',
                        fontSize: 'var(--type-label)',
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '0.35rem',
                        whiteSpace: 'nowrap',
                    }}
                >
                    <Lock size={13} />
                    {ctaLabel}
                </Link>
            </div>
        </div>
    );
}
