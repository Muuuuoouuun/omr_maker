import type { ReactNode } from "react";

type AnalyticsReportSectionProps = {
    id: string;
    title: ReactNode;
    children: ReactNode;
};

export function AnalyticsReportSection({
    id,
    title,
    children,
}: AnalyticsReportSectionProps) {
    return (
        <section aria-labelledby={`${id}-title`}>
            <h2 id={`${id}-title`}>{title}</h2>
            {children}
        </section>
    );
}
