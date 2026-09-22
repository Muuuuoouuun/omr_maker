"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { buildStudentResultHref } from "@/lib/studentResultHub";
import type { StudentConceptMasterySummary } from "@/lib/studentConceptMastery";
import styles from "./StudentConceptMasteryPanel.module.css";

const assessmentLabels = {
    weakness: "우선 보완", strength: "강점", developing: "학습 중", insufficient: "판단 보류",
};
type Assessment = keyof typeof assessmentLabels;
type Filter = "all" | Assessment;
const filters: Filter[] = ["all", "weakness", "strength", "developing", "insufficient"];
const priority: Record<Assessment, number> = { weakness: 0, developing: 1, strength: 2, insufficient: 3 };
const resultLabels = { correct: "정답", wrong: "오답", unanswered: "미응답", ungraded: "미채점" };

export default function StudentConceptMasteryPanel({ summary }: { summary: StudentConceptMasterySummary }) {
    const [filter, setFilter] = useState<Filter>("all");
    const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
    const id = useId();
    const counts: Record<Filter, number> = { all: summary.groups.length, weakness: 0, strength: 0, developing: 0, insufficient: 0 };
    for (const group of summary.groups) counts[group.assessment]++;
    // Array.sort is stable: equal-priority/rate groups retain their source order.
    const groups = [...summary.groups].sort((a, b) => priority[a.assessment] - priority[b.assessment] || a.correctRate - b.correctRate);
    function toggle(concept: string) {
        setExpanded(current => { const next = new Set(current); if (next.has(concept)) next.delete(concept); else next.add(concept); return next; });
    }
    return (
        <section className={styles.panel} aria-labelledby={`${id}-title`}>
            <h3 id={`${id}-title`}>개념별 강점과 보완점</h3>
            <p className={styles.note}>원시험 채점 결과 기준입니다. 서로 다른 문항 3개 이상 · 원시험 응시 2회 이상일 때 강점(정답률 80% 이상)·보완점(50% 이하)을 표시합니다. 미응답은 정답률에 포함됩니다.</p>
            {summary.unmappedQuestionCount > 0 ? <p className={styles.warning}>개념이 연결되지 않은 채점 기록 {summary.unmappedQuestionCount}건은 제외했습니다. 다음 시험 전에 학습지 분석을 검토·반영하면 개념별 결과가 쌓입니다.</p> : null}
            {summary.groups.length ? <>
                <div className={styles.filters} role="group" aria-label="개념 평가 필터">
                    {filters.map(value => <button key={value} type="button" aria-pressed={filter === value} aria-controls={`${id}-groups`} onClick={() => setFilter(value)}>{value === "all" ? "전체" : assessmentLabels[value]} <span>{counts[value]}</span></button>)}
                </div>
                <p className={styles.filterStatus} role="status">{filter === "all" ? "보완이 필요한 개념부터 표시합니다." : `${assessmentLabels[filter]} 개념 ${counts[filter]}개를 표시합니다.`}</p>
                {counts[filter] === 0 ? <p className={styles.filterStatus}>해당하는 개념이 없습니다. 전체를 선택하면 다른 개념을 볼 수 있습니다.</p> : null}
                <div id={`${id}-groups`} className={styles.groups}>
                    {groups.map((group, index) => {
                        const isExpanded = expanded.has(group.concept);
                        const evidenceId = `${id}-evidence-${index}`;
                        return <article key={group.concept} aria-label={`${group.concept} · ${assessmentLabels[group.assessment]}`} className={`${styles.card} ${filter !== "all" && filter !== group.assessment ? styles.filtered : ""}`}>
                            <div className={styles.heading}><h4>{group.concept}</h4><span className={styles.badge} data-assessment={group.assessment}>{assessmentLabels[group.assessment]}</span></div>
                            <p className={styles.rate}>정답률 <strong>{group.correctRate}%</strong> <span>({group.correctCount}/{group.totalCount})</span></p>
                            <p className={styles.note}>서로 다른 문항 {group.distinctQuestionCount}개 · 원시험 응시 {group.attemptCount}회 · 미응답 {group.unansweredCount}개</p>
                            <p className={styles.note}>{group.trendDelta === null ? "추이 비교에 필요한 기록 또는 응시 순서를 확인할 수 없습니다." : `최근·이전 응시 구간 비교 ${group.trendDelta > 0 ? "+" : ""}${group.trendDelta}%p · 시험 난이도 차이는 반영하지 않습니다.`}</p>
                            <button type="button" className={styles.evidenceToggle} aria-expanded={isExpanded} aria-controls={evidenceId} onClick={() => toggle(group.concept)}>{group.concept} 문항 근거 {isExpanded ? "접기" : "보기"} ({group.evidence.length}건 · 최대 6건)</button>
                            <div id={evidenceId} className={`${styles.evidence} ${isExpanded ? "" : styles.collapsed}`}>
                                {group.evidence.length ? <ul>{group.evidence.map((item, evidenceIndex) => <li key={`${item.examId}:${item.attemptId}:${item.questionNumber}:${evidenceIndex}`}><Link href={buildStudentResultHref(item.attemptId, "answers")}>{item.examTitle} · {item.questionNumber}번 · {resultLabels[item.status]}</Link></li>)}</ul> : <p className={styles.note}>표시할 문항 근거가 없습니다.</p>}
                            </div>
                        </article>;
                    })}
                </div>
            </> : <p className={styles.note}>분석 가능한 개념별 채점 기록이 없습니다.</p>}
            <p className={styles.note}>문항의 개념과 정오답을 연결한 결과입니다. 풀이 과정·필기의 실수 원인 분석은 추후 지원 예정입니다.</p>
        </section>
    );
}
