"use client";

import type { StudentProfileInsight } from "@/lib/studentProfileAnalytics";
import LockedFeaturePanel from "./LockedFeaturePanel";
import styles from "./StudentResultHub.module.css";

export type CumulativeLoadStatus = "idle" | "loading" | "ready" | "stale" | "error";

interface CumulativeGrowthPanelProps {
    titleId: string;
    insight: StudentProfileInsight | null;
    status: CumulativeLoadStatus;
    error?: string;
    rosterMatched: boolean;
    enabled: boolean;
    lockedDescription: string;
    onRetry: () => void;
}

function Stat({ label, value }: { label: string; value: string }) {
    return (
        <div className={styles.reportStat}>
            <span>{label}</span>
            <strong>{value}</strong>
        </div>
    );
}

export default function CumulativeGrowthPanel({
    titleId,
    insight,
    status,
    error,
    rosterMatched,
    enabled,
    lockedDescription,
    onRetry,
}: CumulativeGrowthPanelProps) {
    if (!enabled) {
        return (
            <LockedFeaturePanel
                title="누적 성장"
                description={lockedDescription}
                previewItems={["최근 점수 변화", "반복 약점", "최근 원시험 이력"]}
            />
        );
    }

    const retryButton = (
        <button type="button" className={`btn btn-secondary ${styles.screenOnly} student-result-report-screen-only`} onClick={onRetry}>
            다시 시도
        </button>
    );

    return (
        <section className="bento-card" style={{ padding: "1.25rem" }} aria-labelledby={titleId}>
            <div className={styles.sectionHeading}>
                <h2 id={titleId}>누적 성장</h2>
                {(status === "error" || status === "stale") && retryButton}
            </div>
            {status === "idle" || status === "loading" ? (
                <p className={styles.emptyText} role="status">누적 이력을 불러오는 중입니다.</p>
            ) : status === "error" ? (
                <p className={styles.emptyText} role="alert">누적 이력을 불러오지 못했습니다.{error ? ` ${error}` : ""}</p>
            ) : (
                <>
                    {status === "stale" && (
                        <p className={styles.cumulativeWarning} role="status">
                            저장된 누적 이력을 표시합니다.{error ? ` ${error}` : ""}
                        </p>
                    )}
                    {!rosterMatched ? (
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
                                <div><strong>반복 약점</strong><p>{insight.weaknessGroups.slice(0, 3).map(group => group.title).join(", ") || "뚜렷한 반복 약점 없음"}</p></div>
                                <div><strong>최근 원시험</strong><p>{insight.attempts.filter(item => !item.isRetake).slice(0, 4).map(item => `${item.examTitle} ${item.scorePercent}%`).join(" · ") || "기록 없음"}</p></div>
                            </div>
                        </>
                    ) : (
                        <p className={styles.emptyText}>누적 성장 데이터가 없습니다.</p>
                    )}
                </>
            )}
        </section>
    );
}
