import type { ReactNode } from "react";
import styles from "./AnalyticsReportPrimitives.module.css";

export type AnalyticsReportSectionProps = {
    id: string;
    title: ReactNode;
    description?: ReactNode;
    meta?: ReactNode;
    actions?: ReactNode;
    density?: "compact" | "default";
    printBehavior?: "keep-together" | "allow-break";
    className?: string;
    ariaDescribedBy?: string;
    children: ReactNode;
};

export function AnalyticsReportSection({
    id,
    title,
    description,
    meta,
    actions,
    density = "default",
    printBehavior = "keep-together",
    className,
    ariaDescribedBy,
    children,
}: AnalyticsReportSectionProps) {
    const sectionClassName = [
        styles.section,
        density === "compact" ? styles.compact : styles.defaultDensity,
        printBehavior === "allow-break" ? styles.allowBreak : styles.keepTogether,
        className,
    ].filter(Boolean).join(" ");

    return (
        <section
            aria-labelledby={`${id}-title`}
            aria-describedby={ariaDescribedBy}
            className={sectionClassName}
        >
            <header className={styles.sectionHeader}>
                <h2 id={`${id}-title`} className={styles.sectionTitle}>{title}</h2>
                {description ? <p className={styles.sectionDescription}>{description}</p> : null}
                {meta ? <div className={styles.sectionMeta}>{meta}</div> : null}
                {actions ? <div className={styles.sectionActions}>{actions}</div> : null}
            </header>
            <div className={styles.sectionBody}>{children}</div>
        </section>
    );
}
