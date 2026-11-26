"use client";

import type { CSSProperties } from "react";
import { ArrowRight } from "lucide-react";
import {
    AnalyticsMetricGrid,
    type AnalyticsMetricItem,
} from "@/components/AnalyticsMetricGrid";
import { AnalyticsReportSection } from "@/components/AnalyticsReportSection";
import { PremiumActionLink } from "@/components/PremiumFeatureGate";
import type { ExamHeadlineInsight } from "@/lib/examAnalyticsReport";
import type { ScoreBucket } from "@/lib/scoreDistribution";
import styles from "./ExamAnalyticsTab.module.css";

export interface ExamOverviewWeakQuestion {
    key: string | number;
    questionNumber: number;
    title: string;
    correctRate: number;
    evidence?: string;
}

export type ExamOverviewAchievementTone = "neutral" | "success" | "warning" | "grade";

export interface ExamOverviewAchievementBand {
    key: string;
    label: string;
    count: number;
    percent: number;
    tone: ExamOverviewAchievementTone;
}

export interface ExamOverviewAction {
    key: string;
    title: string;
    detail: string;
    href?: string;
    onAction?: () => void;
    enabled?: boolean;
    lockedTitle?: string;
}

export interface ExamAnalyticsReportOverviewProps {
    metrics: AnalyticsMetricItem[];
    headline: ExamHeadlineInsight;
    distribution: ScoreBucket[];
    weakQuestions: ExamOverviewWeakQuestion[];
    achievementBands: ExamOverviewAchievementBand[];
    actions: ExamOverviewAction[];
    hasPerformanceEvidence: boolean;
    sampleStatusDescriptionId?: string;
}

type DistributionBarStyle = CSSProperties & {
    "--distribution-share": string;
};

type AchievementBarStyle = CSSProperties & {
    "--achievement-share": string;
};

const headlineToneClasses: Record<ExamHeadlineInsight["tone"], string> = {
    action: styles.reportHeadlineAction,
    observation: styles.reportHeadlineObservation,
    positive: styles.reportHeadlinePositive,
};

const achievementToneClasses: Record<ExamOverviewAchievementTone, string> = {
    neutral: styles.achievementNeutral,
    success: styles.achievementSuccess,
    warning: styles.achievementWarning,
    grade: styles.achievementGrade,
};

function distributionSummary(distribution: ScoreBucket[]): string {
    const total = distribution.reduce((sum, bucket) => sum + bucket.count, 0);
    if (total === 0) return "표시할 점수 분포가 없습니다.";
    const highest = Math.max(...distribution.map(bucket => bucket.count));
    const peaks = distribution.filter(bucket => bucket.count === highest);
    if (peaks.length > 1) return `최다 구간 ${peaks.length}개가 각각 ${highest}명입니다. 총 ${total}명입니다.`;
    return `${peaks[0].label}점 구간이 ${highest}명으로 가장 많습니다. 총 ${total}명입니다.`;
}

export default function ExamAnalyticsReportOverview({
    metrics,
    headline,
    distribution,
    weakQuestions,
    achievementBands,
    actions,
    hasPerformanceEvidence,
    sampleStatusDescriptionId,
}: ExamAnalyticsReportOverviewProps) {
    const maxDistributionCount = Math.max(1, ...distribution.map(bucket => bucket.count));
    const chartSummary = distributionSummary(distribution);

    return (
        <div className={styles.reportOverview}>
            <AnalyticsReportSection
                id="exam-report-metrics"
                title="시험 핵심 지표"
                className={styles.reportMetricsSection}
                ariaDescribedBy={sampleStatusDescriptionId}
            >
                <AnalyticsMetricGrid
                    metrics={metrics}
                    ariaLabel="시험 핵심 지표 값"
                    className={styles.reportMetricGrid}
                />
            </AnalyticsReportSection>

            <AnalyticsReportSection
                id="exam-report-headline"
                title="시험 핵심 해석"
                density="compact"
                className={`${styles.reportHeadlineSection} ${headlineToneClasses[headline.tone]}`}
                ariaDescribedBy={sampleStatusDescriptionId}
            >
                <h3 className={styles.reportHeadlineTitle}>{headline.title}</h3>
                <p className={styles.reportHeadlineDetail}>{headline.detail}</p>
            </AnalyticsReportSection>

            <div className={styles.reportEvidenceGrid}>
                <AnalyticsReportSection
                    id="exam-report-distribution"
                    title="점수 분포"
                    description="100점 환산 · 10점 구간별 응시 인원"
                    className={styles.reportEvidenceSection}
                    printBehavior="allow-break"
                >
                    {hasPerformanceEvidence ? (
                        <figure className={styles.distributionFigure} aria-label="점수 구간별 응시 인원" aria-describedby="exam-distribution-summary">
                            <figcaption id="exam-distribution-summary">{chartSummary}</figcaption>
                            <table className={styles.distributionTable} aria-label="점수 분포 데이터">
                                <thead><tr><th scope="col">점수 구간</th><th scope="col">응시 인원</th></tr></thead>
                                <tbody>
                                    {distribution.map(bucket => (
                                        <tr key={bucket.min} data-peak={bucket.count === maxDistributionCount}>
                                            <th scope="row">{bucket.label}점</th>
                                            <td>
                                                <div className={styles.distributionMeasure}>
                                                    <span className={styles.distributionTrack} aria-hidden="true">
                                                        <span style={{ "--distribution-share": `${bucket.count / maxDistributionCount * 100}%` } as DistributionBarStyle} />
                                                    </span>
                                                    <strong>{bucket.count}명</strong>
                                                </div>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </figure>
                    ) : <p role="status">채점 가능한 점수 근거가 없습니다.</p>}
                </AnalyticsReportSection>

                <AnalyticsReportSection
                    id="exam-report-achievement"
                    title="성취 구간"
                    description="학생 지원 우선순위를 점수 구간으로 읽습니다."
                    className={styles.reportEvidenceSection}
                >
                    {hasPerformanceEvidence ? <ul className={styles.achievementList} aria-label="학생 성취 구간 분포">
                        {achievementBands.map(band => (
                            <li key={band.key} className={achievementToneClasses[band.tone]}>
                                <div className={styles.achievementCopy}>
                                    <span>{band.label}</span>
                                    <strong className="numeric-emphasis">{band.count}명</strong>
                                    <span className="numeric-emphasis">{band.percent}%</span>
                                </div>
                                <span className={styles.achievementTrack} aria-hidden="true">
                                    <span
                                        className={styles.achievementFill}
                                        style={{ "--achievement-share": `${Math.max(0, Math.min(100, band.percent))}%` } as AchievementBarStyle}
                                    />
                                </span>
                            </li>
                        ))}
                    </ul> : <p role="status">채점 가능한 점수 근거가 없습니다.</p>}
                </AnalyticsReportSection>
            </div>

            <AnalyticsReportSection
                id="exam-report-weak-questions"
                title="취약 문항"
                description="정답률이 낮은 순서와 판단 근거를 함께 확인합니다."
                printBehavior="allow-break"
                className={styles.reportWeakSection}
            >
                {weakQuestions.length === 0 ? <p role="status">표시할 취약 문항 근거가 없습니다.</p> : <div className={styles.reportTableWrap}>
                    <table className={styles.reportDataTable}>
                        <caption>취약 문항 근거</caption>
                        <thead>
                            <tr>
                                <th scope="col">문항</th>
                                <th scope="col">개념</th>
                                <th scope="col">정답률</th>
                                <th scope="col">근거</th>
                            </tr>
                        </thead>
                        <tbody>
                            {weakQuestions.map(question => (
                                <tr key={question.key}>
                                    <th scope="row">{question.questionNumber}번</th>
                                    <td>{question.title}</td>
                                    <td>
                                        <span
                                            className={`numeric-emphasis ${question.correctRate < 40 ? styles.rateGrade : styles.reportRate}`}
                                        >
                                            {question.correctRate}%
                                        </span>
                                    </td>
                                    <td>{question.evidence || "추가 근거 없음"}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>}
            </AnalyticsReportSection>

            <AnalyticsReportSection
                id="exam-report-actions"
                title="다음 행동"
                description="분석 근거에서 바로 이어지는 작업입니다."
                className={styles.reportActionsSection}
            >
                <ul className={styles.reportActionList}>
                    {actions.map(action => (
                        <li key={action.key}>
                            {action.href ? (
                                <PremiumActionLink
                                    enabled={action.enabled ?? true}
                                    href={action.href}
                                    lockedTitle={action.lockedTitle}
                                    className={styles.reportAction}
                                >
                                    <span>
                                        <strong>{action.title}</strong>
                                        <small>{action.detail}</small>
                                    </span>
                                    <ArrowRight size={16} aria-hidden="true" />
                                </PremiumActionLink>
                            ) : (
                                <button
                                    type="button"
                                    className={styles.reportAction}
                                    onClick={action.onAction}
                                >
                                    <span>
                                        <strong>{action.title}</strong>
                                        <small>{action.detail}</small>
                                    </span>
                                    <ArrowRight size={16} aria-hidden="true" />
                                </button>
                            )}
                        </li>
                    ))}
                </ul>
            </AnalyticsReportSection>
        </div>
    );
}
