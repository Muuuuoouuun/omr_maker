"use client";

import { useState } from "react";
import Link from "next/link";
import { Activity, Repeat2, Target } from "lucide-react";
import type { Attempt, Exam, QuestionResult } from "@/types/omr";
import type {
    AttemptBehaviorSummary,
    LearningRecommendation,
    WeaknessGroup,
} from "@/lib/premiumAnalytics";
import { buildRetakeHref } from "@/lib/retakeLinks";
import styles from "./StudentResultHub.module.css";

export interface CurrentExamAnalyticsData {
    wrongResults: QuestionResult[];
    weaknessGroups: WeaknessGroup[];
    recommendations: LearningRecommendation[];
    retakeQuestionIds: number[];
    behavior: AttemptBehaviorSummary;
}

interface AnalyticsPanelProps {
    attempt: Attempt;
    exam?: Exam;
    data: CurrentExamAnalyticsData | null;
}

function formatAnswer(answer?: number): string {
    return typeof answer === "number" && answer > 0 ? `${answer}번` : "미응답";
}

function questionNumberLabel(questionNumbers: number[]): string {
    return questionNumbers.length > 0 ? `${questionNumbers.join(", ")}번` : "없음";
}

function DiagnosticResultRow({ result }: { result: QuestionResult }) {
    const accent = result.status === "unanswered" ? "var(--foreground)" : "var(--text-error)";
    const statusLabel = result.status === "unanswered" ? "미응답" : "오답";
    const typeLabel = result.concept || result.unit || result.label || result.source || "유형 미지정";

    return (
        <article style={{ padding: "0.75rem", borderRadius: "var(--radius-sm)", border: "1px solid color-mix(in srgb, var(--error) 20%, var(--border))", background: "color-mix(in srgb, var(--error) 5%, var(--surface))" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.7rem", flexWrap: "wrap" }}>
                <strong style={{ color: accent, fontSize: "0.88rem" }}>{result.questionNumber}번 · {statusLabel}</strong>
                <span style={{ color: "var(--muted)", fontSize: "0.74rem", fontWeight: 800 }}>{typeLabel}</span>
            </div>
            <div style={{ color: "var(--muted)", fontSize: "0.78rem", fontWeight: 700, marginTop: "0.3rem" }}>
                학생 {formatAnswer(result.selectedAnswer)}
                {result.correctAnswer !== undefined && ` · 정답 ${formatAnswer(result.correctAnswer)}`}
            </div>
            {!!result.mistakeTypes?.length && (
                <div style={{ marginTop: "0.35rem", display: "flex", gap: "0.3rem", flexWrap: "wrap" }}>
                    {result.mistakeTypes.slice(0, 3).map(type => <span key={type} className={styles.signalChip}>{type}</span>)}
                </div>
            )}
        </article>
    );
}

function BehaviorSignals({ behavior }: { behavior: AttemptBehaviorSummary }) {
    const signals = [
        { label: "오래 머문 문항", value: questionNumberLabel(behavior.slowQuestionNumbers) },
        { label: "재방문 문항", value: questionNumberLabel(behavior.revisitedQuestionNumbers) },
        { label: "답안 변경 문항", value: questionNumberLabel(behavior.answerChangedQuestionNumbers) },
        { label: "화면 이탈", value: behavior.focusLossCount > 0 ? `${behavior.focusLossCount}회` : "없음" },
    ];

    return (
        <section className="bento-card" style={{ padding: "1.25rem" }} aria-labelledby="behavior-signals-title">
            <div className={styles.sectionHeading}>
                <h2 id="behavior-signals-title"><Activity size={18} aria-hidden="true" /> 풀이 행동 신호</h2>
            </div>
            <div className={styles.diagnosticGrid}>
                {signals.map(signal => (
                    <div key={signal.label} style={{ padding: "0.8rem", border: "1px solid var(--border)", borderRadius: "var(--radius-md)", background: "var(--background)" }}>
                        <div style={{ color: "var(--muted)", fontSize: "0.72rem", fontWeight: 800 }}>{signal.label}</div>
                        <div style={{ marginTop: "0.25rem", fontSize: "0.86rem", fontWeight: 900 }}>{signal.value}</div>
                    </div>
                ))}
            </div>
            {behavior.focusLossQuestionNumbers.length > 0 && (
                <p style={{ margin: "0.7rem 0 0", color: "var(--muted)", fontSize: "0.74rem", fontWeight: 700 }}>
                    화면 이탈 시점 문항: {questionNumberLabel(behavior.focusLossQuestionNumbers)}
                </p>
            )}
        </section>
    );
}

export default function AnalyticsPanel({ attempt, exam, data }: AnalyticsPanelProps) {
    const [wrongExpanded, setWrongExpanded] = useState(false);

    if (!exam || !data) {
        return (
            <section className="bento-card" style={{ padding: "1.25rem" }} aria-labelledby="analytics-unavailable-title">
                <h2 id="analytics-unavailable-title" style={{ margin: 0, fontSize: "1rem" }}>현재 시험 분석을 표시할 수 없습니다.</h2>
                <p style={{ margin: "0.45rem 0 0", color: "var(--muted)", fontSize: "0.84rem", lineHeight: 1.55 }}>
                    시험 정보를 불러오지 못했습니다. 제출 당시 저장된 점수와 제출 정보는 상단 요약과 답안 탭에서 계속 확인할 수 있습니다.
                </p>
            </section>
        );
    }

    const visibleWrongResults = wrongExpanded ? data.wrongResults : data.wrongResults.slice(0, 8);

    return (
        <div className={styles.panelStack}>
            <section className="bento-card" style={{ padding: "1.25rem" }} aria-labelledby="wrong-analysis-title">
                <div className={styles.sectionHeading}>
                    <h2 id="wrong-analysis-title"><Target size={18} aria-hidden="true" /> 오답·미응답·유형 분석</h2>
                    <span className={styles.countBadge}>{data.wrongResults.length}문항</span>
                </div>
                {data.wrongResults.length > 0 ? (
                    <>
                        <div className={styles.rowList}>
                            {visibleWrongResults.map(result => <DiagnosticResultRow key={result.questionId} result={result} />)}
                        </div>
                        {data.wrongResults.length > 8 && (
                            <button type="button" className="btn btn-secondary" onClick={() => setWrongExpanded(value => !value)} aria-expanded={wrongExpanded} style={{ width: "100%", marginTop: "0.65rem" }}>
                                {wrongExpanded ? "접기" : `전체 보기 (외 ${data.wrongResults.length - 8}문항)`}
                            </button>
                        )}
                    </>
                ) : (
                    <p className={styles.emptyText}>오답 또는 미응답 문항이 없습니다.</p>
                )}
            </section>

            <section className="bento-card" style={{ padding: "1.25rem" }} aria-labelledby="recommendations-title">
                <div className={styles.sectionHeading}>
                    <h2 id="recommendations-title">약점과 추천 학습</h2>
                </div>
                {data.recommendations.length > 0 ? (
                    <div className={styles.rowList}>
                        {data.recommendations.map(group => (
                            <article key={group.key} style={{ padding: "0.85rem", borderRadius: "var(--radius-sm)", border: "1px solid #c7d2fe", background: "#eef2ff", color: "#312e81" }}>
                                <strong style={{ fontSize: "0.86rem" }}>{group.title}</strong>
                                <p style={{ margin: "0.2rem 0 0", color: "#4338ca", fontSize: "0.75rem", fontWeight: 700 }}>
                                    {group.questionNumbers.join(", ")}번 · 오답/미답 {group.wrongCount}/{group.totalCount}
                                </p>
                                <p style={{ margin: "0.3rem 0 0", fontSize: "0.76rem", lineHeight: 1.5 }}>{group.reason || group.recommendedAction}</p>
                                <Link href={buildRetakeHref(attempt.examId, group.sourceAttemptId, group.retakeQuestionIds, group.retakeMode, { labels: group.retakeLabels, concepts: group.retakeConcepts })} className="btn btn-secondary" style={{ marginTop: "0.6rem", fontSize: "0.76rem", display: "inline-flex", alignItems: "center", gap: "0.35rem" }}>
                                    <Repeat2 size={14} aria-hidden="true" /> 유형 재시험
                                </Link>
                            </article>
                        ))}
                    </div>
                ) : data.weaknessGroups.length > 0 ? (
                    <div className={styles.rowList}>
                        {data.weaknessGroups.map(group => (
                            <article key={group.key} style={{ padding: "0.8rem", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", background: "var(--background)" }}>
                                <strong style={{ fontSize: "0.84rem" }}>{group.title}</strong>
                                <p style={{ margin: "0.2rem 0 0", color: "var(--muted)", fontSize: "0.74rem" }}>{group.questionNumbers.join(", ")}번 · {group.recommendedAction}</p>
                                <Link href={buildRetakeHref(attempt.examId, attempt.id, group.questionIds, "similar", { labels: group.labels, concepts: group.concepts })} className="btn btn-secondary" style={{ marginTop: "0.55rem", fontSize: "0.76rem" }}>비슷한 유형 재시험</Link>
                            </article>
                        ))}
                    </div>
                ) : (
                    <p className={styles.emptyText}>현재 시험에서 별도로 추천할 약점 그룹이 없습니다.</p>
                )}
            </section>

            <BehaviorSignals behavior={data.behavior} />

            <section className="bento-card" style={{ padding: "1.25rem" }} aria-labelledby="retake-action-title">
                <div className={styles.sectionHeading}>
                    <h2 id="retake-action-title">추천 재시험</h2>
                </div>
                {data.retakeQuestionIds.length > 0 ? (
                    <Link href={buildRetakeHref(attempt.examId, attempt.id, data.retakeQuestionIds, "wrong")} className="btn btn-primary" style={{ width: "100%", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: "0.4rem" }}>
                        <Repeat2 size={16} aria-hidden="true" /> 오답만 재시험 링크
                    </Link>
                ) : (
                    <p className={styles.emptyText}>재시험이 필요한 오답 또는 미응답 문항이 없습니다.</p>
                )}
            </section>
        </div>
    );
}
