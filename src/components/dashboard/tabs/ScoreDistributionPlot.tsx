"use client";

import { useEffect, useRef, type CSSProperties } from "react";
import type { ScoreBucket } from "@/lib/scoreDistribution";
import styles from "./ExamAnalyticsTab.module.css";

interface ScoreDistributionPlotProps {
    buckets: ScoreBucket[];
    examPeakCount: number;
    mean: number | null;
}

function countAxis(peak: number) {
    const roughStep = Math.max(1, peak / 4);
    const magnitude = 10 ** Math.floor(Math.log10(roughStep));
    const step = ([1, 2, 5, 10].find(value => value * magnitude >= roughStep) ?? 10) * magnitude;
    const intervals = Math.max(1, Math.ceil(peak / step));
    return { maximum: intervals * step, ticks: Array.from({ length: intervals + 1 }, (_, i) => i * step) };
}

export default function ScoreDistributionPlot({ buckets, examPeakCount, mean }: ScoreDistributionPlotProps) {
    const plot = useRef<HTMLDivElement>(null);
    const peak = Math.max(0, ...buckets.map(bucket => bucket.count));
    const { maximum, ticks } = countAxis(Math.max(peak, examPeakCount));
    const hasMean = mean !== null && Number.isFinite(mean) && mean >= 0 && mean <= 100;

    useEffect(() => {
        if (!plot.current) return;
        // Commit the 350ms entry transition before enabling the 450ms filter transition.
        // CSS then interpolates from the visible height, including interrupted transitions.
        plot.current.getBoundingClientRect();
        plot.current.dataset.entered = "true";
    }, []);

    return (
        <div
            ref={plot}
            className={styles.distributionPlot}
            aria-hidden="true"
            style={{ "--average-position": `${hasMean ? mean : 0}%` } as CSSProperties}
        >
            <div className={styles.distributionUnit}>명</div>
            <div className={styles.meanRail}>
                {hasMean && <span className={styles.meanLabel}>평균 {mean}점</span>}
            </div>
            <div className={styles.distributionAxis} data-maximum={maximum}>
                {ticks.map(tick => (
                    <span key={tick} style={{ bottom: `${100 * tick / maximum}%` }}>{tick}</span>
                ))}
            </div>
            <div className={styles.distributionField}>
                {ticks.map(tick => (
                    <span key={tick} className={styles.distributionGridline} style={{ bottom: `${100 * tick / maximum}%` }} />
                ))}
                {hasMean && <span className={styles.meanLine} />}
                <ol className={styles.distributionBars}>
                    {buckets.map(bucket => {
                        const isPeak = bucket.count > 0 && bucket.count === peak;
                        return (
                            <li key={bucket.min} className={isPeak ? styles.distributionItemPeak : undefined}>
                                <span
                                    className={`${styles.distributionBar} ${isPeak ? styles.distributionBarPeak : ""}`}
                                    style={{ height: `${100 * bucket.count / maximum}%` }}
                                >
                                    <strong className={styles.distributionCount}>{bucket.count}</strong>
                                </span>
                            </li>
                        );
                    })}
                </ol>
            </div>
            <div className={styles.distributionLabels}>
                {buckets.map(bucket => (
                    <span key={bucket.min}><span>{bucket.min}–</span><span>{bucket.max}</span></span>
                ))}
            </div>
            <div className={styles.distributionBoundaryLabels}>
                {[0, 20, 40, 60, 80, 100].map(value => (
                    <span key={value} style={{ left: `${value}%` }}>{value}</span>
                ))}
            </div>
            <div className={styles.distributionScoreUnit}>점수 (점)</div>
        </div>
    );
}
