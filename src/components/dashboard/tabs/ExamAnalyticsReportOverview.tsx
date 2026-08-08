"use client";

import type { CSSProperties } from "react";
import { ArrowRight } from "lucide-react";
import { AnalyticsChartFrame } from "@/components/AnalyticsChartFrame";
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
    sampleStatus: "ready" | "partial" | "stale";
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

function sampleStatusNote(status: ExamAnalyticsReportOverviewProps["sampleStatus"]): string | null {
    if (status === "partial") return "일부 제출 기준의 중간 결과입니다.";
    if (status === "stale") return "최신 제출이 아직 반영되지 않았을 수 있습니다.";
    return null;
}

function distributionSummary(distribution: ScoreBucket[]): string {
    const total = distribution.reduce((sum, bucket) => sum + bucket.count, 0);
    const peak = distribution.reduce<ScoreBucket | undefined>((current, bucket) => (
        !current || bucket.count > current.count ? bucket : current
    ), undefined);

    if (!peak || total === 0) return "표시할 점수 분포가 없습니다.";
    return `${peak.label}점 구간이 ${peak.count}명으로 가장 많습니다. 총 ${total}명입니다.`;
}

export default function ExamAnalyticsReportOverview({
    metrics,
    headline,
    distribution,
    weakQuestions,
    achievementBands,
    actions,
    sampleStatus,
}: ExamAnalyticsReportOverviewProps) {
    const sampleNote = sampleStatusNote(sampleStatus);
    const maxDistributionCount = Math.max(1, ...distribution.map(bucket => bucket.count));
    const chartSummary = distributionSummary(distribution);

    return (
        <div className={styles.reportOverview}>
            <AnalyticsReportSection
                id="exam-report-metrics"
                title="시험 핵심 지표"
                className={styles.reportMetricsSection}
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
            >
                <h3 className={styles.reportHeadlineTitle}>{headline.title}</h3>
                <p className={styles.reportHeadlineDetail}>{headline.detail}</p>
                {sampleNote ? <p className={styles.reportSampleNote}>{sampleNote}</p> : null}
            </AnalyticsReportSection>

            <div className={styles.reportEvidenceGrid}>
                <AnalyticsReportSection
                    id="exam-report-distribution"
                    title="점수 분포"
                    description="10점 구간별 응시 인원"
                    className={styles.reportEvidenceSection}
                    printBehavior="allow-break"
                >
                    <AnalyticsChartFrame
                        ariaLabel="점수 구간별 응시 인원"
                        height={260}
                        state={{ status: "ready", summary: chartSummary }}
                        accessibleTable={(
                            <table className={styles.reportDataTable}>
                                <caption>점수 분포 데이터</caption>
                                <thead>
                                    <tr>
                                        <th scope="col">점수 구간</th>
                                        <th scope="col">응시 인원</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {distribution.map(bucket => (
                                        <tr key={`${bucket.min}-${bucket.max}`}>
                                            <th scope="row">{bucket.label}점</th>
                                            <td className="numeric-emphasis">{bucket.count}명</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                    >
                        <ol className={styles.distributionBars} aria-hidden="true">
                            {distribution.map(bucket => (
                                <li key={`${bucket.min}-${bucket.max}`}>
                                    <span className={styles.distributionCount}>{bucket.count}</span>
                                    <span
                                        className={styles.distributionBar}
                                        style={{
                                            "--distribution-share": `${(bucket.count / maxDistributionCount) * 100}%`,
                                        } as DistributionBarStyle}
                                    />
                                    <span className={styles.distributionLabel}>{bucket.label}</span>
                                </li>
                            ))}
                        </ol>
                    </AnalyticsChartFrame>
                </AnalyticsReportSection>

                <AnalyticsReportSection
                    id="exam-report-achievement"
                    title="성취 구간"
                    description="학생 지원 우선순위를 점수 구간으로 읽습니다."
                    className={styles.reportEvidenceSection}
                >
                    <ul className={styles.achievementList} aria-label="학생 성취 구간 분포">
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
                    </ul>
                </AnalyticsReportSection>
            </div>

            <AnalyticsReportSection
                id="exam-report-weak-questions"
                title="취약 문항"
                description="정답률이 낮은 순서와 판단 근거를 함께 확인합니다."
                printBehavior="allow-break"
                className={styles.reportWeakSection}
            >
                <div className={styles.reportTableWrap}>
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
                </div>
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
