import Link from "next/link";
import type { CSSProperties } from "react";

type BrandLogoProps = {
    href?: string;
    label?: string;
    className?: string;
    compact?: boolean;
    markOnly?: boolean;
    priorityLabel?: string;
    style?: CSSProperties;
};

export function BrandMark({ className = "" }: { className?: string }) {
    return (
        <svg
            className={`brand-logo__mark ${className}`.trim()}
            viewBox="0 0 64 64"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
            focusable="false"
        >
            <rect x="4" y="4" width="56" height="56" rx="16" fill="white" />
            <path
                d="M20 12H44C48.4 12 52 15.6 52 20V26"
                stroke="#4285F4"
                strokeWidth="7.5"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
            <path
                d="M52 26V44C52 48.4 48.4 52 44 52H37"
                stroke="#EA4335"
                strokeWidth="7.5"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
            <path
                d="M37 52H20C15.6 52 12 48.4 12 44V37"
                stroke="#FBBC04"
                strokeWidth="7.5"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
            <path
                d="M12 37V20C12 15.6 15.6 12 20 12"
                stroke="#34A853"
                strokeWidth="7.5"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
            <circle cx="24" cy="25" r="3" fill="#E2E8F0" />
            <circle cx="24" cy="36" r="3" fill="#E2E8F0" />
            <path
                d="M29 35.5L34.25 40.75L44 28"
                stroke="#1A73E8"
                strokeWidth="5.2"
                strokeLinecap="round"
                strokeLinejoin="round"
            />
        </svg>
    );
}

export default function BrandLogo({
    href = "/",
    label = "OMR Maker",
    className = "",
    compact = false,
    markOnly = false,
    priorityLabel,
    style,
}: BrandLogoProps) {
    const classes = [
        "logo",
        "brand-logo",
        compact ? "brand-logo--compact" : "",
        markOnly ? "brand-logo--mark-only" : "",
        className,
    ].filter(Boolean).join(" ");

    const content = (
        <>
            <BrandMark />
            {!markOnly && <span className="brand-logo__text">{label}</span>}
            {priorityLabel && <span className="sr-only">{priorityLabel}</span>}
        </>
    );

    return (
        <Link href={href} className={classes} style={style} aria-label={priorityLabel || label}>
            {content}
        </Link>
    );
}
