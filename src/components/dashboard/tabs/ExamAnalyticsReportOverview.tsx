"use client";

import { useState } from "react";
import { ArrowRight, ChartColumn, Table2, ScanLine } from "lucide-react";
import { AnalyticsChartFrame } from "@/components/AnalyticsChartFrame";
import {
    AnalyticsMetricGrid,
    type AnalyticsMetricItem,
} from "@/components/AnalyticsMetricGrid";
import { AnalyticsReportSection } from "@/components/AnalyticsReportSection";
import { PremiumActionLink } from "@/components/PremiumFeatureGate";
import type { ExamHeadlineInsight } from "@/lib/examAnalyticsReport";
import type { ScoreBucket } from "@/lib/scoreDistribution";
import ScoreDistributionPlot from "./ScoreDistributionPlot";
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
    examPeakCount?: number;
    weakQuestions: ExamOverviewWeakQuestion[];
    achievementBands: ExamOverviewAchievementBand[];
    actions: ExamOverviewAction[];
    hasPerformanceEvidence: boolean;
    sampleStatusDescriptionId?: string;
}

const achievementToneClasses: Record<ExamOverviewAchievementTone, string> = {
    neutral: styles.achievementNeutral,
    success: styles.achievementSuccess,
    warning: styles.achievementWarning,
    grade: styles.achievementGrade,
};

function distributionSummary(distribution: ScoreBucket[]): string {
    const total = distribution.reduce((sum, bucket) => sum + bucket.count, 0);
    if (total === 0) return "표시할 점수 분포가 없습니다.";
    const peak = Math.max(...distribution.map(bucket => bucket.count));
    const leaders = distribution.filter(bucket => bucket.count === peak);
    if (leaders.length > 1) {
        return `${leaders.map(bucket => bucket.label + "점").join(", ")} 구간이 각각 ${peak}명으로 공동 최다입니다. 총 ${total}명입니다.`;
    }
    return `${leaders[0].label}점 구간이 ${peak}명으로 가장 많습니다. 총 ${total}명입니다.`;
}

export default function ExamAnalyticsReportOverview({
    metrics,
    headline,
    distribution,
    examPeakCount = 0,
    weakQuestions,
    achievementBands,
    actions,
    hasPerformanceEvidence,
    sampleStatusDescriptionId,
}: ExamAnalyticsReportOverviewProps) {
    const mean = metrics.find(metric => metric.id === "mean")?.value;
    const achievementCount = achievementBands.reduce((total, band) => total + band.count, 0);
    const hasAchievementEvidence = hasPerformanceEvidence && achievementCount > 0;
    const chartSummary = distributionSummary(distribution);
    const [showDistributionTable, setShowDistributionTable] = useState(false);

    return (
        <div className={styles.reportOverview}>
            <div className={styles.reportFocusRow}>
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
                    id="exam-report-distribution"
                    title="점수 분포"
                    description="10점 구간별 응시 인원"
                    actions={hasPerformanceEvidence && (
                        <button
                            className={styles.chartToggle}
                            type="button"
                            aria-label="점수 분포 데이터 표"
                            aria-pressed={showDistributionTable}
                            onClick={() => setShowDistributionTable(value => !value)}
                        >
                            {showDistributionTable ? <ChartColumn size={15} /> : <Table2 size={15} />}
                            {showDistributionTable ? "그래프 보기" : "표 보기"}
                        </button>
                    )}
                    className={`${styles.reportEvidenceSection} ${styles.reportDistributionSection}`}
                    printBehavior="allow-break"
                >
                    <div hidden={showDistributionTable && hasPerformanceEvidence}>
                        <AnalyticsChartFrame
                            ariaLabel="점수 구간별 응시 인원"
                            className={styles.distributionFrame}
                            height={248}
                            state={hasPerformanceEvidence
                                ? { status: "ready", summary: chartSummary }
                                : { status: "empty", message: "채점 가능한 점수 근거가 없습니다." }}
                        >
                            <ScoreDistributionPlot
                                buckets={distribution}
                                examPeakCount={examPeakCount}
                                mean={typeof mean === "number" ? mean : null}
                            />
                        </AnalyticsChartFrame>
                    </div>
                    {hasPerformanceEvidence && (
                        <div className={showDistributionTable ? undefined : styles.distributionTableAlternate}>
                            <table className={`${styles.reportDataTable} ${styles.distributionTable}`}>
                                <caption>점수 분포 데이터</caption>
                                <thead><tr><th scope="col">점수 구간</th><th scope="col">응시 인원</th></tr></thead>
                                <tbody>
                                    {distribution.map(bucket => (
                                        <tr key={bucket.min}>
                                            <th scope="row">{bucket.label}점</th>
                                            <td className="numeric-emphasis">{bucket.count}명</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </AnalyticsReportSection>
            </div>

            <AnalyticsReportSection
                id="exam-report-achievement"
                title="성취 구간"
                meta={hasAchievementEvidence ? `채점 응시 ${achievementCount}명 기준` : undefined}
                className={styles.reportAchievementSection}
            >
                {hasAchievementEvidence ? (
                    <>
                        <div className={styles.achievementTrack} aria-hidden="true">
                            {achievementBands.map(band => (
                                <span
                                    key={band.key}
                                    className={achievementToneClasses[band.tone]}
                                    style={{ flexGrow: band.count }}
                                />
                            ))}
                        </div>
                        <ul className={styles.achievementList} aria-label="학생 성취 구간 분포">
                            {achievementBands.map(band => (
                                <li key={band.key} className={achievementToneClasses[band.tone]}>
                                    <span>{band.label}</span>
                                    <div className={styles.achievementValues}>
                                        <strong>{band.count}명</strong><span>{band.percent}%</span>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    </>
                ) : <p role="status">{hasPerformanceEvidence
                    ? "학생별 성취 구간을 집계할 근거가 부족합니다."
                    : "채점 가능한 점수 근거가 없습니다."}</p>}
            </AnalyticsReportSection>

            <AnalyticsReportSection
                id="exam-report-headline"
                title={<><ScanLine size={16} aria-hidden="true" />시험 핵심 해석</>}
                density="compact"
                className={styles.reportHeadlineSection}
                ariaDescribedBy={sampleStatusDescriptionId}
            >
                <h3 className={styles.reportHeadlineTitle}>{headline.title}</h3>
                <p className={styles.reportHeadlineDetail}>{headline.detail}</p>
            </AnalyticsReportSection>

            <AnalyticsReportSection
                id="exam-report-weak-questions"
                title="취약 문항"
                description="정답률이 낮은 순서와 판단 근거를 함께 확인합니다."
                printBehavior="allow-break"
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
                            {!weakQuestions.length && <tr><td colSpan={4}>정답률을 계산할 수 있는 문항이 없습니다.</td></tr>}
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
