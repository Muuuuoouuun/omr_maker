import CountUp from "./dashboard/CountUp";
import styles from "./AnalyticsReportPrimitives.module.css";

export type AnalyticsMetricTone = "neutral" | "success" | "warning" | "grade" | "retake";

export interface AnalyticsMetricItem {
    id?: string;
    label: string;
    value: string | number;
    unit?: string;
    detail?: string;
    trend?: {
        direction: "up" | "down" | "flat";
        label: string;
    };
    tone?: AnalyticsMetricTone;
    animate?: boolean;
    decimals?: number;
}

export type AnalyticsMetricGridProps = {
    metrics: AnalyticsMetricItem[];
    ariaLabel?: string;
    className?: string;
};

const toneClasses: Record<AnalyticsMetricTone, string> = {
    neutral: styles.toneNeutral,
    success: styles.toneSuccess,
    warning: styles.toneWarning,
    grade: styles.toneGrade,
    retake: styles.toneRetake,
};

function countUpDecimals(value: number): number {
    if (Number.isInteger(value)) return 0;

    const match = value.toString().match(/(?:\.(\d+))?(?:e([+-]?\d+))?$/i);
    const fractionLength = match?.[1]?.length ?? 0;
    const exponent = Number(match?.[2] ?? 0);
    return Math.max(0, fractionLength - exponent);
}

function resolveCountUpDecimals(value: number, decimals?: number): number {
    if (decimals !== undefined && Number.isInteger(decimals) && decimals >= 0) return decimals;
    return countUpDecimals(value);
}

export function AnalyticsMetricGrid({
    metrics,
    ariaLabel,
    className,
}: AnalyticsMetricGridProps) {
    const gridClassName = [styles.metricGrid, className].filter(Boolean).join(" ");

    return (
        <dl className={gridClassName} aria-label={ariaLabel}>
            {metrics.map(metric => {
                const tone = metric.tone ?? "neutral";
                const isFiniteNumber = typeof metric.value === "number" && Number.isFinite(metric.value);
                const valueClassName = isFiniteNumber
                    ? `numeric-emphasis ${styles.metricValue}`
                    : styles.metricValue;

                return (
                    <div
                        key={metric.id ?? metric.label}
                        className={`${styles.metricItem} ${toneClasses[tone]}`}
                    >
                        <dt className={styles.metricLabel}>{metric.label}</dt>
                        <dd className={styles.metricDefinition}>
                            <span className={valueClassName}>
                                {isFiniteNumber && metric.animate
                                    ? (
                                        <CountUp
                                            value={metric.value as number}
                                            decimals={resolveCountUpDecimals(
                                                metric.value as number,
                                                metric.decimals,
                                            )}
                                        />
                                    )
                                    : String(metric.value)}
                                {metric.unit ? <span className={styles.metricUnit}>{metric.unit}</span> : null}
                            </span>
                            {metric.detail ? <span className={styles.metricDetail}>{metric.detail}</span> : null}
                            {metric.trend ? (
                                <span
                                    className={styles.metricTrend}
                                    data-direction={metric.trend.direction}
                                    aria-label={`추세: ${metric.trend.label}`}
                                >
                                    {metric.trend.label}
                                </span>
                            ) : null}
                        </dd>
                    </div>
                );
            })}
        </dl>
    );
}
