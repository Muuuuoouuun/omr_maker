"use client";

import { useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import dynamic from "next/dynamic";
import type { StudentGrowthReportModel, StudentGrowthRow } from "@/lib/studentGrowthReport";
import LockedFeaturePanel from "./LockedFeaturePanel";
import styles from "./StudentResultHub.module.css";

const GrowthTrendChart = dynamic(
    () => import("@/components/teacher/student-results/GrowthTrendChart"),
    {
        ssr: false,
        loading: () => <p className={styles.growthReportState} role="status">성장 그래프를 준비하고 있습니다.</p>,
    },
);

export type StudentGrowthReportState =
    | { status: "idle" | "loading" }
    | { status: "error"; message: string }
    | { status: "empty"; message: string }
    | { status: "ready" | "stale" | "partial"; model: StudentGrowthReportModel; message?: string };

interface StudentGrowthReportProps {
    state: StudentGrowthReportState;
    enabled: boolean;
    onRetry: () => void;
    lockedDescription?: string;
}

type GrowthMode = "summary" | "trend";

const MODES: GrowthMode[] = ["summary", "trend"];

function formatGap(value: number | null): string {
    if (value == null) return "비교 없음";
    return `${value > 0 ? "+" : ""}${value}%p`;
}

function formatRank(model: StudentGrowthReportModel, latest: StudentGrowthRow | undefined): string {
    if (!latest || latest.participantCount < 2) return "반 비교 불가";
    if (model.currentRank == null) return "등수 미제공";
    return `${model.currentRank}등 / ${latest.participantCount}명`;
}

function comparisonAverageGap(rows: StudentGrowthRow[]): number | null {
    const comparableRows = rows.filter(row => row.participantCount >= 2);
    if (comparableRows.length === 0) return null;
    return Math.round(
        comparableRows.reduce((sum, row) => sum + row.gap, 0) / comparableRows.length * 10,
    ) / 10;
}

function formatTrend(model: StudentGrowthReportModel): string {
    const scoreTrend = model.trend === "up"
        ? "점수 상승 흐름"
        : model.trend === "down"
            ? "점수 하락 흐름"
            : model.trend === "flat"
                ? "점수 흐름 유지"
                : "비교 자료 부족";
    if (model.rankDelta == null) return scoreTrend;
    const rankTrend = model.rankDelta === 0
        ? "등수 유지"
        : `${Math.abs(model.rankDelta)}계단 ${model.rankDelta > 0 ? "상승" : "하락"}`;
    return `${scoreTrend} · ${rankTrend}`;
}

function GrowthSummaryRail({ model }: { model: StudentGrowthReportModel }) {
    const latest = model.rows.at(-1);
    const averageGap = comparisonAverageGap(model.rows);
    return (
        <dl className={styles.growthSummaryRail} aria-label="최근 시험 요약">
            <div>
                <dt>최근 점수</dt>
                <dd className="numeric-emphasis">{model.latestScore == null ? "기록 없음" : `${model.latestScore}점`}</dd>
            </div>
            <div>
                <dt>평균 격차</dt>
                <dd className="numeric-emphasis">{averageGap == null ? "반 비교 불가" : formatGap(averageGap)}</dd>
            </div>
            <div>
                <dt>현재 등수</dt>
                <dd>{formatRank(model, latest)}</dd>
            </div>
            <div>
                <dt>성장 흐름</dt>
                <dd>{formatTrend(model)}</dd>
            </div>
        </dl>
    );
}

function GrowthDataTable({ rows }: { rows: StudentGrowthRow[] }) {
    return (
        <div className={styles.growthDataTableWrapper}>
            <table className={styles.growthDataTable} aria-label="개인 성장 데이터">
                <thead>
                    <tr>
                        <th scope="col">시험</th>
                        <th scope="col">학생 점수</th>
                        <th scope="col">반 평균</th>
                        <th scope="col">평균 격차</th>
                        <th scope="col">등수</th>
                        <th scope="col">참여 인원</th>
                    </tr>
                </thead>
                <tbody>
                    {rows.map(row => (
                        <tr key={row.examId}>
                            <th scope="row">{row.examTitle}</th>
                            <td>{row.studentScore}점</td>
                            <td>{row.participantCount < 2 ? "비교 불가" : `${row.classAverage}점`}</td>
                            <td>{row.participantCount < 2 ? "비교 불가" : formatGap(row.gap)}</td>
                            <td>{row.participantCount < 2 ? "비교 불가" : row.rank == null ? "미제공" : `${row.rank}등`}</td>
                            <td>{row.participantCount}명</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function ReportState({ state, onRetry }: { state: Exclude<StudentGrowthReportState, { status: "ready" | "stale" | "partial" }>; onRetry: () => void }) {
    if (state.status === "error") {
        return (
            <div className={styles.growthReportState}>
                <p role="alert">{state.message}</p>
                <button type="button" className="btn btn-secondary" onClick={onRetry}>다시 시도</button>
            </div>
        );
    }
    let message: string;
    if (state.status === "idle") {
        message = "개인 성장 데이터를 준비하고 있습니다.";
    } else if (state.status === "loading") {
        message = "개인 성장 데이터를 불러오는 중입니다.";
    } else {
        message = "message" in state ? state.message : "개인 성장 데이터를 준비하고 있습니다.";
    }
    return <p className={styles.growthReportState} role="status">{message}</p>;
}

function GrowthDataNotice({
    status,
    message,
    onRetry,
}: {
    status: "ready" | "stale" | "partial";
    message?: string;
    onRetry: () => void;
}) {
    if (status === "ready") return null;
    const stateNote = status === "stale"
        ? `저장된 성장 데이터를 표시합니다.${message ? ` ${message}` : ""}`
        : `일부 제출 기준으로 계산했습니다.${message ? ` ${message}` : ""}`;
    return (
        <div className={styles.growthDataNote} role="status">
            <span>{stateNote}</span>
            {status === "stale" && (
                <button type="button" className="btn btn-secondary" onClick={onRetry}>다시 시도</button>
            )}
        </div>
    );
}

export default function StudentGrowthReport({
    state,
    enabled,
    onRetry,
    lockedDescription = "개인별 점수 추세와 반 평균 비교는 분석 플랜에서 확인할 수 있습니다.",
}: StudentGrowthReportProps) {
    const [mode, setMode] = useState<GrowthMode>("summary");
    const rawId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
    const tabRefs = useRef<Record<GrowthMode, HTMLButtonElement | null>>({ summary: null, trend: null });
    const panelId = `student-growth-panel-${rawId}`;
    const tabId = (value: GrowthMode) => `student-growth-tab-${value}-${rawId}`;

    if (!enabled) {
        return (
            <LockedFeaturePanel
                title="개인 성장"
                description={lockedDescription}
                previewItems={["최근 시험 점수", "반 평균 격차", "등수 변화와 성장 추세"]}
            />
        );
    }

    if (!("model" in state)) {
        return (
            <section className={`${styles.panel} ${styles.growthReport}`} aria-labelledby={`student-growth-title-${rawId}`}>
                <h2 id={`student-growth-title-${rawId}`} className={styles.reportSectionTitle}>개인 성장</h2>
                <ReportState state={state} onRetry={onRetry} />
            </section>
        );
    }

    const { model } = state;
    if (model.rows.length === 0) {
        return (
            <section className={`${styles.panel} ${styles.growthReport}`} aria-labelledby={`student-growth-title-${rawId}`}>
                <h2 id={`student-growth-title-${rawId}`} className={styles.reportSectionTitle}>개인 성장</h2>
                <GrowthDataNotice status={state.status} message={state.message} onRetry={onRetry} />
                <p className={styles.growthReportState} role="status" aria-label="성장 데이터 없음">표시할 성장 데이터가 없습니다.</p>
            </section>
        );
    }

    const focusMode = (nextMode: GrowthMode) => {
        tabRefs.current[nextMode]?.focus();
    };
    const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, currentMode: GrowthMode) => {
        const currentIndex = MODES.indexOf(currentMode);
        let nextMode: GrowthMode | null = null;
        if (event.key === "ArrowRight") nextMode = MODES[(currentIndex + 1) % MODES.length];
        if (event.key === "ArrowLeft") nextMode = MODES[(currentIndex - 1 + MODES.length) % MODES.length];
        if (event.key === "Home") nextMode = MODES[0];
        if (event.key === "End") nextMode = MODES[MODES.length - 1];
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setMode(currentMode);
            return;
        }
        if (nextMode) {
            event.preventDefault();
            focusMode(nextMode);
        }
    };
    const hasComparison = model.rows.some(row => row.participantCount >= 2);
    const hasUnavailableComparison = model.rows.some(row => row.participantCount < 2);

    return (
        <section className={`${styles.panel} ${styles.growthReport}`} aria-labelledby={`student-growth-title-${rawId}`}>
            <div className={styles.growthReportHeader}>
                <div>
                    <h2 id={`student-growth-title-${rawId}`}>개인 성장</h2>
                    <p>점수 추세와 반 평균 격차, 등수 변화를 시험 순서로 확인합니다.</p>
                </div>
                <div className={styles.growthTabs} role="tablist" aria-label="개인 성장 보기">
                    {MODES.map(value => {
                        const selected = mode === value;
                        const label = value === "summary" ? "요약" : "추세만";
                        return (
                            <button
                                key={value}
                                ref={node => { tabRefs.current[value] = node; }}
                                id={tabId(value)}
                                type="button"
                                role="tab"
                                aria-selected={selected}
                                aria-controls={panelId}
                                tabIndex={selected ? 0 : -1}
                                className={selected ? styles.growthTabSelected : styles.growthTab}
                                onClick={() => setMode(value)}
                                onKeyDown={event => handleTabKeyDown(event, value)}
                            >
                                {label}
                            </button>
                        );
                    })}
                </div>
            </div>

            <GrowthDataNotice status={state.status} message={state.message} onRetry={onRetry} />

            {hasUnavailableComparison && (
                <p className={styles.growthComparisonNote} role="status" aria-label="반 비교 안내">
                    {hasComparison
                        ? "같은 반 응시자가 1명인 시험은 개인 점수만 표시합니다."
                        : "비교 가능한 같은 반 응시자가 없습니다. 개인 점수 흐름만 표시합니다."}
                </p>
            )}

            {model.rows.length === 1 && (
                <p className={styles.growthOnePointNote} role="status">비교할 시험이 더 필요합니다.</p>
            )}

            <div
                id={panelId}
                role="tabpanel"
                aria-labelledby={tabId(mode)}
                className={mode === "trend" ? styles.growthPanelTrendOnly : styles.growthPanelSummary}
            >
                <GrowthTrendChart rows={model.rows} />
                {mode === "summary" && <GrowthSummaryRail model={model} />}
            </div>
            <GrowthDataTable rows={model.rows} />
        </section>
    );
}
