"use client";

import Link from "next/link";
import { Download, Lock } from "lucide-react";
import type { Attempt, Exam, QuestionResult } from "@/types/omr";
import type { AttemptScoreSummary, WeaknessGroup } from "@/lib/premiumAnalytics";
import type { StudentProfileInsight } from "@/lib/studentProfileAnalytics";
import { formatKoreanDateTime } from "@/lib/pure";
import { safeScorePercent } from "@/lib/scoreUtils";
import LockedFeaturePanel from "./LockedFeaturePanel";
import styles from "./StudentResultHub.module.css";

export type CumulativeLoadStatus = "idle" | "loading" | "ready" | "error";

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
    cumulativeStatus: CumulativeLoadStatus;
    cumulativeError?: string;
    rosterMatched: boolean;
    studentGrowthReportsEnabled: boolean;
    pdfExportEnabled: boolean;
}

function Stat({ label, value }: { label: string; value: string | number }) {
    return (
        <div className={styles.reportStat}>
            <span>{label}</span>
            <strong>{value}</strong>
        </div>
    );
}

function CumulativeGrowthBlock({
    insight,
    status,
    error,
    rosterMatched,
    enabled,
}: {
    insight: StudentProfileInsight | null;
    status: CumulativeLoadStatus;
    error?: string;
    rosterMatched: boolean;
    enabled: boolean;
}) {
    if (!enabled) {
        return (
            <LockedFeaturePanel
                title="누적 성장"
                description="시험별 성장 추이와 반복 약점은 Pro 이상에서 확인할 수 있습니다."
                previewItems={["최근 점수 변화", "반복 약점", "최근 원시험 이력"]}
            />
        );
    }

    return (
        <section className="bento-card" style={{ padding: "1.25rem" }} aria-labelledby="report-growth-title">
            <h2 id="report-growth-title" className={styles.reportSectionTitle}>누적 성장</h2>
            {status === "idle" || status === "loading" ? (
                <p className={styles.emptyText} role="status">누적 이력을 불러오는 중입니다.</p>
            ) : status === "error" ? (
                <p className={styles.emptyText}>누적 이력을 불러오지 못했습니다.{error ? ` ${error}` : ""}</p>
            ) : !rosterMatched ? (
                <p className={styles.emptyText}>누적 이력을 학생 명단과 안정적으로 연결할 수 없습니다.</p>
            ) : insight ? (
                <>
                    <div className={styles.reportStatGrid}>
                        <Stat label="최근 점수" value={`${insight.latestScore}%`} />
                        <Stat label="이전 대비" value={`${insight.trendDelta > 0 ? "+" : ""}${insight.trendDelta}%p`} />
                        <Stat label="원시험" value={`${insight.baseAttemptCount}회`} />
                        <Stat label="재시험" value={`${insight.retakeAttemptCount}회`} />
                    </div>
                    <div className={styles.reportGrowthDetails}>
                        <div>
                            <strong>반복 약점</strong>
                            <p>{insight.weaknessGroups.slice(0, 3).map(group => group.title).join(", ") || "뚜렷한 반복 약점 없음"}</p>
                        </div>
                        <div>
                            <strong>최근 원시험</strong>
                            <p>{insight.attempts.filter(item => !item.isRetake).slice(0, 4).map(item => `${item.examTitle} ${item.scorePercent}%`).join(" · ") || "기록 없음"}</p>
                        </div>
                    </div>
                </>
            ) : (
                <p className={styles.emptyText}>누적 성장 데이터가 없습니다.</p>
            )}
        </section>
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
    cumulativeStatus,
    cumulativeError,
    rosterMatched,
    studentGrowthReportsEnabled,
    pdfExportEnabled,
}: ReportPanelProps) {
    const fallbackPercent = safeScorePercent(attempt.score, attempt.totalScore);
    const score = analytics?.score;

    return (
        <div className={styles.reportPrintRoot}>
            <div className={`${styles.reportActions} ${styles.screenOnly}`}>
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
                <section className="bento-card" style={{ padding: "1.25rem" }} aria-labelledby="report-summary-title">
                    <h2 id="report-summary-title" className={styles.reportSectionTitle}>응시 요약</h2>
                    <dl className={styles.reportSummaryList}>
                        <div><dt>학생</dt><dd>{attempt.studentName}</dd></div>
                        <div><dt>시험</dt><dd>{exam?.title || attempt.examTitle}</dd></div>
                        <div><dt>제출</dt><dd>{formatKoreanDateTime(attempt.finishedAt)}</dd></div>
                        <div><dt>선택 응시</dt><dd>{selectedAttemptLabel}</dd></div>
                    </dl>
                </section>

                <section className="bento-card" style={{ padding: "1.25rem" }} aria-labelledby="report-score-title">
                    <h2 id="report-score-title" className={styles.reportSectionTitle}>점수와 답안 현황</h2>
                    <div className={styles.reportScoreLine}>
                        <strong>{score?.scorePercent ?? fallbackPercent}%</strong>
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

                <section className="bento-card" style={{ padding: "1.25rem" }} aria-labelledby="report-weakness-title">
                    <h2 id="report-weakness-title" className={styles.reportSectionTitle}>주요 오답과 약점</h2>
                    <div className={styles.reportTwoColumns}>
                        <div>
                            <strong>상위 오답·미응답</strong>
                            <p>{analytics?.wrongResults.slice(0, 5).map(result => `${result.questionNumber}번`).join(", ") || "없음"}</p>
                        </div>
                        <div>
                            <strong>약점 그룹</strong>
                            <p>{analytics?.weaknessGroups.slice(0, 3).map(group => group.title).join(", ") || "뚜렷한 약점 없음"}</p>
                        </div>
                    </div>
                </section>

                {attempt.retake && (
                    <section className="bento-card" style={{ padding: "1.25rem" }} aria-labelledby="report-retake-title">
                        <h2 id="report-retake-title" className={styles.reportSectionTitle}>재시험 변화</h2>
                        {retakeScoreDelta ? (
                            <p className={styles.reportDelta}>
                                원시험 {retakeScoreDelta.sourceScorePercent}% → 재시험 {retakeScoreDelta.currentScorePercent}%
                                <strong>{retakeScoreDelta.delta > 0 ? "+" : ""}{retakeScoreDelta.delta}%p</strong>
                            </p>
                        ) : (
                            <p className={styles.emptyText}>연결된 원시험 기록을 찾을 수 없어 점수 변화를 계산하지 못했습니다.</p>
                        )}
                    </section>
                )}

                <section className="bento-card" style={{ padding: "1.25rem" }} aria-labelledby="report-feedback-title">
                    <h2 id="report-feedback-title" className={styles.reportSectionTitle}>교사 피드백 요약</h2>
                    <p className={styles.reportFeedback}>{feedbackSummary.trim() || "작성된 전체 피드백이 없습니다."}</p>
                </section>

                <CumulativeGrowthBlock
                    insight={cumulativeInsight}
                    status={cumulativeStatus}
                    error={cumulativeError}
                    rosterMatched={rosterMatched}
                    enabled={studentGrowthReportsEnabled}
                />
            </div>
        </div>
    );
}
