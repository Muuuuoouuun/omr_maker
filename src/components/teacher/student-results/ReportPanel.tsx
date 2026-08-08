"use client";

import Link from "next/link";
import { Download, Lock } from "lucide-react";
import type { Attempt, Exam, QuestionResult } from "@/types/omr";
import type { AttemptScoreSummary, WeaknessGroup } from "@/lib/premiumAnalytics";
import type { StudentProfileInsight } from "@/lib/studentProfileAnalytics";
import { formatKoreanDateTime } from "@/lib/pure";
import { safeScorePercent } from "@/lib/scoreUtils";
import StudentGrowthReport, { type StudentGrowthReportState } from "./StudentGrowthReport";
import styles from "./StudentResultHub.module.css";

export interface ReportAnalyticsData {
    score: AttemptScoreSummary;
    counts: {
        correctCount: number;
        incorrectCount: number;
        unansweredCount: number;
        ungradedCount: number;
    };
    wrongResults: QuestionResult[];
    weaknessGroups: WeaknessGroup[];
}

export interface RetakeScoreDelta {
    sourceScorePercent: number;
    currentScorePercent: number;
    delta: number;
}

interface ReportPanelProps {
    attempt: Attempt;
    exam?: Exam;
    analytics: ReportAnalyticsData | null;
    selectedAttemptLabel: string;
    feedbackSummary: string;
    retakeScoreDelta: RetakeScoreDelta | null;
    cumulativeInsight: StudentProfileInsight | null;
    growthReportState: StudentGrowthReportState;
    studentGrowthReportsEnabled: boolean;
    pdfExportEnabled: boolean;
    onRetryCumulative: () => void;
}

function Stat({ label, value }: { label: string; value: string | number }) {
    return (
        <div className={styles.reportStat}>
            <span>{label}</span>
            <strong>{value}</strong>
        </div>
    );
}

export default function ReportPanel({
    attempt,
    exam,
    analytics,
    selectedAttemptLabel,
    feedbackSummary,
    retakeScoreDelta,
    cumulativeInsight,
    growthReportState,
    studentGrowthReportsEnabled,
    pdfExportEnabled,
    onRetryCumulative,
}: ReportPanelProps) {
    const fallbackPercent = safeScorePercent(attempt.score, attempt.totalScore);
    const score = analytics?.score;
    const scorePercent = score?.scorePercent ?? fallbackPercent;
    const headline = !analytics
        ? `제출 당시 저장된 점수 ${scorePercent}%를 표시합니다. 문항 분석은 시험 정보를 불러온 뒤 확인할 수 있습니다.`
        : retakeScoreDelta
            ? retakeScoreDelta.delta > 0
                ? `재시험에서 ${retakeScoreDelta.delta}%p 상승했습니다.`
                : retakeScoreDelta.delta < 0
                    ? `재시험 점수가 ${Math.abs(retakeScoreDelta.delta)}%p 낮아져 오답 원인을 다시 확인할 필요가 있습니다.`
                    : "원시험과 재시험 점수가 같습니다. 풀이 과정의 변화를 함께 확인해 주세요."
            : analytics.wrongResults.length
                ? `${scorePercent}%를 기록했고, 오답·미응답 ${analytics.wrongResults.length}문항을 우선 복습하면 좋습니다.`
                : `${scorePercent}%를 기록했고, 현재 시험에서 확인된 오답·미응답이 없습니다.`;

    return (
        <div id="student-result-report-print-root" className={`${styles.reportPrintRoot} student-result-report-print-root`}>
            <div className={`${styles.reportActions} ${styles.screenOnly} student-result-report-screen-only`}>
                {pdfExportEnabled ? (
                    <button type="button" className="btn btn-secondary" onClick={() => window.print()} aria-label="현재 학생 리포트 인쇄 또는 PDF 저장">
                        <Download size={15} aria-hidden="true" /> 인쇄 / PDF 저장
                    </button>
                ) : (
                    <Link href="/teacher/billing" className="btn btn-secondary" title="Pro 이상에서 학생 리포트를 인쇄하거나 PDF로 저장할 수 있습니다.">
                        <Lock size={15} aria-hidden="true" /> 인쇄/PDF 저장 Pro
                    </Link>
                )}
            </div>

            <div className={styles.panelStack}>
                <section className="bento-card" style={{ padding: "1rem" }} aria-labelledby="report-summary-title">
                    <h2 id="report-summary-title" className={styles.reportSectionTitle}>응시 요약</h2>
                    <dl className={styles.reportSummaryList}>
                        <div><dt>학생</dt><dd>{attempt.studentName}</dd></div>
                        <div><dt>시험</dt><dd>{exam?.title || attempt.examTitle}</dd></div>
                        <div><dt>제출</dt><dd>{formatKoreanDateTime(attempt.finishedAt)}</dd></div>
                        <div><dt>선택 응시</dt><dd>{selectedAttemptLabel}</dd></div>
                    </dl>
                </section>

                <section className="bento-card" style={{ padding: "1rem" }} aria-labelledby="report-score-title">
                    <h2 id="report-score-title" className={styles.reportSectionTitle}>점수와 답안 현황</h2>
                    <div className={styles.reportScoreLine}>
                        <strong>{scorePercent}%</strong>
                        <span>{score?.earnedScore ?? attempt.score} / {score?.totalScore ?? attempt.totalScore}점</span>
                    </div>
                    {analytics ? (
                        <div className={styles.reportStatGrid}>
                            <Stat label="정답" value={analytics.counts.correctCount} />
                            <Stat label="오답" value={analytics.counts.incorrectCount} />
                            <Stat label="미응답" value={analytics.counts.unansweredCount} />
                            {analytics.counts.ungradedCount > 0 && <Stat label="미채점" value={analytics.counts.ungradedCount} />}
                        </div>
                    ) : (
                        <p className={styles.emptyText}>시험 정보를 불러오지 못해 제출 당시 저장된 점수를 표시합니다.</p>
                    )}
                </section>

                <section className="bento-card" style={{ padding: "1rem" }} aria-labelledby="report-headline-title">
                    <h2 id="report-headline-title" className={styles.reportSectionTitle}>핵심 해석</h2>
                    <p className={styles.reportFeedback}>{headline}</p>
                    {attempt.retake && (
                        retakeScoreDelta ? (
                            <p className={styles.reportDelta}>
                                원시험 {retakeScoreDelta.sourceScorePercent}% → 재시험 {retakeScoreDelta.currentScorePercent}%
                                <strong>{retakeScoreDelta.delta > 0 ? "+" : ""}{retakeScoreDelta.delta}%p</strong>
                            </p>
                        ) : (
                            <p className={styles.emptyText}>연결된 원시험 기록을 찾을 수 없어 점수 변화를 계산하지 못했습니다.</p>
                        )
                    )}
                </section>

                <StudentGrowthReport
                    state={growthReportState}
                    enabled={studentGrowthReportsEnabled}
                    lockedDescription="시험별 성장 추이와 반 평균 격차, 등수 변화는 Pro 이상에서 확인할 수 있습니다."
                    onRetry={onRetryCumulative}
                />

                <section className="bento-card" style={{ padding: "1rem" }} aria-labelledby="report-weakness-title">
                    <h2 id="report-weakness-title" className={styles.reportSectionTitle}>주요 오답과 약점</h2>
                    {analytics ? (
                        <div className={styles.reportTwoColumns}>
                            <div>
                                <strong>상위 오답·미응답</strong>
                                <p>{analytics.wrongResults.slice(0, 5).map(result => `${result.questionNumber}번`).join(", ") || "없음"}</p>
                            </div>
                            <div>
                                <strong>약점 그룹</strong>
                                <p>{analytics.weaknessGroups.slice(0, 3).map(group => group.title).join(", ") || "뚜렷한 약점 없음"}</p>
                            </div>
                        </div>
                    ) : (
                        <p className={styles.emptyText}>시험 정보를 불러오지 못해 오답과 약점을 계산할 수 없습니다.</p>
                    )}
                    {!!cumulativeInsight?.weaknessGroups.length && (
                        <div className={styles.reportGrowthDetails} style={{ marginTop: "0.75rem" }}>
                            <div>
                                <strong>반복 약점과 추천</strong>
                                <p>{cumulativeInsight.weaknessGroups.slice(0, 3).map(group => `${group.title} · ${group.recommendedAction}`).join(" / ")}</p>
                            </div>
                        </div>
                    )}
                </section>

                <section className="bento-card" style={{ padding: "1rem" }} aria-labelledby="report-feedback-title">
                    <h2 id="report-feedback-title" className={styles.reportSectionTitle}>교사 피드백 요약</h2>
                    <p className={styles.reportFeedback}>{feedbackSummary.trim() || "작성된 전체 피드백이 없습니다."}</p>
                </section>

                <section className="bento-card" style={{ padding: "1rem" }} aria-labelledby="report-history-title">
                    <h2 id="report-history-title" className={styles.reportSectionTitle}>상세 응시 이력</h2>
                    {!studentGrowthReportsEnabled ? (
                        <p className={styles.emptyText}>상세 응시 이력은 Pro 이상에서 확인할 수 있습니다.</p>
                    ) : growthReportState.status === "idle" || growthReportState.status === "loading" ? (
                        <p className={styles.emptyText} role="status">상세 응시 이력을 불러오는 중입니다.</p>
                    ) : growthReportState.status === "error" ? (
                        <div>
                            <p className={styles.emptyText} role="alert">상세 응시 이력을 불러오지 못했습니다. {growthReportState.message}</p>
                            <button type="button" className={`btn btn-secondary ${styles.screenOnly}`} onClick={onRetryCumulative}>다시 시도</button>
                        </div>
                    ) : (
                        <>
                            {growthReportState.status === "stale" && (
                                <div className={styles.cumulativeWarning} role="status">
                                    <span>저장된 상세 이력을 표시합니다.{growthReportState.message ? ` ${growthReportState.message}` : ""}</span>{" "}
                                    <button type="button" className={`btn btn-secondary ${styles.screenOnly}`} onClick={onRetryCumulative}>다시 시도</button>
                                </div>
                            )}
                            {growthReportState.status === "partial" && (
                                <p className={styles.cumulativeWarning} role="status">일부 제출 기준의 상세 이력을 표시합니다.</p>
                            )}
                            {cumulativeInsight?.attempts.length ? (
                                <>
                                    <div className={styles.reportStatGrid}>
                                        <Stat label="평균" value={`${cumulativeInsight.averageScore}%`} />
                                        <Stat label="최고" value={`${cumulativeInsight.bestScore}%`} />
                                        <Stat label="원시험" value={`${cumulativeInsight.baseAttemptCount}회`} />
                                        <Stat label="재시험" value={`${cumulativeInsight.retakeAttemptCount}회`} />
                                    </div>
                                    <div className={styles.rowList} style={{ marginTop: "0.75rem" }}>
                                        {cumulativeInsight.attempts.map(item => (
                                            <Link
                                                key={item.id}
                                                href={item.detailHref}
                                                className="btn btn-secondary"
                                                style={{ display: "flex", justifyContent: "space-between", gap: "0.75rem", fontSize: "0.78rem" }}
                                            >
                                                <span>{item.examTitle}{item.isRetake ? " · 재시험" : ""}</span>
                                                <span>{item.scorePercent}% · {formatKoreanDateTime(item.finishedAt)}</span>
                                            </Link>
                                        ))}
                                    </div>
                                </>
                            ) : growthReportState.status === "empty" || growthReportState.status === "ready" ? (
                                <p className={styles.emptyText}>표시할 누적 응시 이력이 없습니다.</p>
                            ) : growthReportState.status === "stale" ? (
                                <p className={styles.emptyText}>저장된 상세 이력을 학생 명단과 연결하지 못했습니다.</p>
                            ) : growthReportState.status === "partial" ? (
                                <p className={styles.emptyText}>일부 상세 이력을 학생 명단과 연결하지 못했습니다.</p>
                            ) : (
                                <p className={styles.emptyText}>상세 이력을 학생 명단과 연결할 수 없습니다.</p>
                            )}
                        </>
                    )}
                </section>
            </div>
        </div>
    );
}
