import Link from "next/link";
import Image from "next/image";
import type { CSSProperties, MouseEventHandler } from "react";

type BrandLogoProps = {
    href?: string;
    label?: string;
    className?: string;
    compact?: boolean;
    markOnly?: boolean;
    priorityLabel?: string;
    style?: CSSProperties;
    onClick?: MouseEventHandler<HTMLAnchorElement>;
};

export function BrandMark({ className = "" }: { className?: string }) {
    return (
        <Image
            className={`brand-logo__mark ${className}`.trim()}
            src="/logo.png"
            alt=""
            width={96}
            height={96}
            sizes="75px"
            loading="eager"
            aria-hidden="true"
        />
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
    onClick,
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
        <Link href={href} className={classes} style={style} aria-label={priorityLabel || label} onClick={onClick}>
            {content}
        </Link>
    );
}
