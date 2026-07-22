"use client";

import Link from "next/link";
import { Check } from "lucide-react";
import { useRouter } from "next/navigation";
import { formatKoreanDateTime } from "@/lib/pure";
import { safeScorePercent } from "@/lib/scoreUtils";
import {
    buildStudentResultHref,
    type StudentAttemptSeriesItem,
    type StudentResultView,
} from "@/lib/studentResultHub";
import type { Attempt } from "@/types/omr";
import styles from "./StudentResultHub.module.css";

interface StudentResultHeaderProps {
    attempt: Attempt;
    examTitle?: string;
    series: StudentAttemptSeriesItem[];
    activeView: StudentResultView;
}

function attemptLabel(item: StudentAttemptSeriesItem, originalCount: number): string {
    if (item.kind === "original") {
        return originalCount > 1 ? `원시험 ${item.ordinal}` : "원시험";
    }

    return `재시험 ${item.ordinal}`;
}

function formatDelta(scoreDelta: number | null): string | null {
    if (scoreDelta === null) return null;
    return `${scoreDelta >= 0 ? "+" : ""}${scoreDelta}점`;
}

function AttemptSwitcher({
    attempt,
    series,
    activeView,
}: Pick<StudentResultHeaderProps, "attempt" | "series" | "activeView">) {
    const router = useRouter();
    const originalCount = series.filter(item => item.kind === "original").length;

    const navigateToAttempt = (attemptId: string) => {
        router.push(buildStudentResultHref(attemptId, activeView));
    };

    return (
        <section className={styles.attemptSwitcher} aria-label="응시 회차">
            <div className={styles.attemptLinks}>
                {series.map(item => {
                    const isCurrent = item.attempt.id === attempt.id;
                    const label = attemptLabel(item, originalCount);
                    const delta = formatDelta(item.scoreDelta);

                    return (
                        <Link
                            key={item.attempt.id}
                            className={`${styles.attemptLink} ${isCurrent ? styles.attemptLinkCurrent : ""}`}
                            href={buildStudentResultHref(item.attempt.id, activeView)}
                            aria-current={isCurrent ? "page" : undefined}
                        >
                            <span>{label}</span>
                            {delta && <span className={styles.scoreDelta}>{delta}</span>}
                            {isCurrent && (
                                <span className={styles.currentAttempt}>
                                    <Check size={14} aria-hidden="true" />
                                    현재
                                </span>
                            )}
                        </Link>
                    );
                })}
            </div>

            <select
                className={styles.attemptSelect}
                aria-label="응시 회차 선택"
                value={attempt.id}
                onChange={event => navigateToAttempt(event.target.value)}
            >
                {series.map(item => {
                    const isCurrent = item.attempt.id === attempt.id;
                    const label = attemptLabel(item, originalCount);
                    const delta = formatDelta(item.scoreDelta);

                    return (
                        <option key={item.attempt.id} value={item.attempt.id}>
                            {label}{delta ? ` (${delta})` : ""}{isCurrent ? " (현재)" : ""}
                        </option>
                    );
                })}
            </select>
        </section>
    );
}

export default function StudentResultHeader({
    attempt,
    examTitle,
    series,
    activeView,
}: StudentResultHeaderProps) {
    const title = examTitle || attempt.examTitle;
    const scorePercent = safeScorePercent(attempt.score, attempt.totalScore);

    return (
        <header className={styles.header}>
            <nav className={`${styles.breadcrumb} ${styles.screenOnly}`} aria-label="현재 위치">
                <Link href={`/teacher/exam/${encodeURIComponent(attempt.examId)}`}>시험 상세</Link>
                <span aria-hidden="true">&gt;</span>
                <span aria-current="page">{attempt.studentName}</span>
            </nav>

            <div className={styles.headerMain}>
                <div className={styles.studentSummary}>
                    <p className={styles.examTitle}>{title}</p>
                    <h1>{attempt.studentName}</h1>
                    <p className={styles.finishedAt}>응시 완료 {formatKoreanDateTime(attempt.finishedAt)}</p>
                </div>
                <p className={styles.score} aria-label={`점수 ${scorePercent}점`}>
                    <strong>{scorePercent}%</strong>
                    <span>점수</span>
                </p>
            </div>

            <AttemptSwitcher attempt={attempt} series={series} activeView={activeView} />
        </header>
    );
}
