"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowRight, ChevronDown, Search, Target } from "lucide-react";
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
const PAGE_SIZE = 6;

export default function StudentConceptMasteryPanel({ summary }: { summary: StudentConceptMasterySummary }) {
    const [filter, setFilter] = useState<Filter>("all");
    const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
    const [search, setSearch] = useState("");
    const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
    const groupsRef = useRef<HTMLDivElement>(null);
    const nextFocusIndex = useRef<number | null>(null);
    useEffect(() => {
        if (nextFocusIndex.current === null) return;
        const card = groupsRef.current?.children.item(nextFocusIndex.current) as HTMLElement | null;
        card?.focus();
        nextFocusIndex.current = null;
    }, [visibleCount]);
    const id = useId();
    const counts: Record<Filter, number> = { all: summary.groups.length, weakness: 0, strength: 0, developing: 0, insufficient: 0 };
    for (const group of summary.groups) counts[group.assessment]++;
    // Array.sort is stable: equal-priority/rate groups retain their source order.
    const groups = useMemo(() => [...summary.groups].sort((a, b) => priority[a.assessment] - priority[b.assessment] || a.correctRate - b.correctRate), [summary.groups]);
    const reviewGroups = groups.filter(group => group.assessment === "weakness").slice(0, 3);
    const query = search.trim().toLocaleLowerCase("ko");
    const matches = groups.filter(group => (filter === "all" || filter === group.assessment) && group.concept.toLocaleLowerCase("ko").includes(query));
    const visibleConcepts = new Set(matches.slice(0, visibleCount).map(group => group.concept));
    function toggle(concept: string) {
        setExpanded(current => { const next = new Set(current); if (next.has(concept)) next.delete(concept); else next.add(concept); return next; });
    }
    return (
        <section className={styles.panel} aria-labelledby={`${id}-title`}>
            <header className={styles.panelHeader}>
                <div><span className={styles.eyebrow}>학생별 누적 분석</span><h3 id={`${id}-title`}>개념별 강점과 보완점</h3></div>
                <p className={styles.intro}>복습할 개념을 찾고,<br />문항 근거로 확인하세요.</p>
            </header>
            {summary.unmappedQuestionCount > 0 ? <p className={styles.warning}>개념이 연결되지 않은 채점 기록 {summary.unmappedQuestionCount}건은 제외했습니다. 다음 시험 전에 학습지 분석을 검토·반영하면 개념별 결과가 쌓입니다.</p> : null}
            {summary.groups.length ? <>
                <div className={styles.reviewSummary} data-actionable={reviewGroups.length > 0} role="group" aria-label="복습 우선순위">
                    <div className={styles.reviewTitle}><Target size={19} aria-hidden="true" /><h4>{reviewGroups.length ? "이번 복습에서 먼저 볼 개념" : "아직 우선 보완 개념이 없습니다"}</h4>{reviewGroups.length ? <span className={styles.reviewTotal}>{reviewGroups.length}개 추천</span> : null}</div>
                    {reviewGroups.length ? <>
                        <p className={styles.note}>누적 정답률이 낮은 보완 개념 {reviewGroups.length}개입니다. 미응답은 먼저 풀지 못한 이유를 확인해 주세요.</p>
                        <ol role="list">{reviewGroups.map((group, reviewIndex) => {
                            const reviewEvidence = group.evidence.find(item => item.status === "wrong" || item.status === "unanswered");
                            return <li key={group.concept}>
                                <div className={styles.reviewConcept}><span className={styles.reviewRank} aria-hidden="true">{reviewIndex + 1}</span><strong>{group.concept}</strong></div>
                                <span className={styles.reviewCounts}>누적 오답 {group.totalCount - group.correctCount - group.unansweredCount}건 · 미응답 {group.unansweredCount}건</span>
                                {reviewEvidence ? <><span className={styles.reviewExam}>{reviewEvidence.examTitle}</span><Link aria-label={`${reviewEvidence.examTitle} · ${reviewEvidence.questionNumber}번 ${resultLabels[reviewEvidence.status]} 확인`} href={buildStudentResultHref(reviewEvidence.attemptId, "answers", reviewEvidence.questionNumber)}>{reviewEvidence.questionNumber}번 {resultLabels[reviewEvidence.status]} 확인<ArrowRight size={15} aria-hidden="true" /></Link></> : <span className={styles.note}>표시된 문항 근거에는 오답·미응답이 없습니다. 이전 응시 결과도 확인해 주세요.</span>}
                            </li>;
                        })}</ol>
                    </> : <p className={styles.note}>{counts.insufficient > 0 ? `판단 보류 ${counts.insufficient}개는 기록을 더 쌓은 뒤 판단합니다. 개별 문항의 오답·미응답은 아래 문항 근거에서 확인할 수 있습니다.` : "개념별 문항 근거에서 오답·미응답을 확인하며 학습을 이어가세요."}</p>}
                </div>
                <div className={styles.browseHeader}><div><h4>전체 개념 살펴보기</h4><p className={styles.note}>평가를 선택해 필요한 개념만 모아보세요.</p></div><div className={styles.search}>
                    <label htmlFor={`${id}-search`}><Search size={15} aria-hidden="true" />개념 찾기</label>
                    <input id={`${id}-search`} type="search" value={search} placeholder="개념 이름으로 검색" onChange={event => { setSearch(event.target.value); setVisibleCount(PAGE_SIZE); }} />
                </div></div>
                <div className={styles.filters} role="group" aria-label="개념 평가 필터">
                    {filters.map(value => <button key={value} type="button" data-assessment={value} aria-pressed={filter === value} aria-controls={`${id}-groups`} onClick={() => { setFilter(value); setVisibleCount(PAGE_SIZE); }}><span>{value === "all" ? "전체" : assessmentLabels[value]}</span> <strong>{counts[value]}</strong></button>)}
                </div>
                <div className={styles.resultsToolbar}>
                    <p className={styles.filterStatus} role="status">{filter === "all" ? "전체" : assessmentLabels[filter]}{query ? " 검색 결과" : " 개념"} {matches.length}개 중 {Math.min(matches.length, visibleCount)}개 표시</p>
                    {filter !== "all" || search ? <button type="button" className={styles.reset} onClick={() => { setFilter("all"); setSearch(""); setVisibleCount(PAGE_SIZE); }}>검색·필터 초기화</button> : null}
                </div>
                {matches.length === 0 ? <p className={styles.filterStatus}>해당하는 개념이 없습니다. 검색·필터를 초기화하면 다른 개념을 볼 수 있습니다.</p> : null}
                <div id={`${id}-groups`} className={styles.groups} ref={groupsRef}>
                    {groups.map((group, index) => {
                        const isExpanded = expanded.has(group.concept);
                        const evidenceId = `${id}-evidence-${index}`;
                        return <article key={group.concept} tabIndex={-1} data-assessment={group.assessment} aria-label={`${group.concept} · ${assessmentLabels[group.assessment]}`} className={`${styles.card} ${visibleConcepts.has(group.concept) ? "" : styles.filtered}`}>
                            <div className={styles.heading}><h4>{group.concept}</h4><span className={styles.badge} data-assessment={group.assessment}>{assessmentLabels[group.assessment]}</span></div>
                            <div className={styles.metrics}>
                                <div className={styles.rate}><span>누적 정답률</span><strong>{group.correctRate}<small>%</small></strong><span>정답 {group.correctCount}/{group.totalCount}건</span></div>
                                <dl className={styles.errorCounts}><div><dt>오답</dt><dd data-has-errors={group.totalCount - group.correctCount - group.unansweredCount > 0}>{group.totalCount - group.correctCount - group.unansweredCount}<small>건</small></dd></div><div><dt>미응답</dt><dd>{group.unansweredCount}<small>건</small></dd></div></dl>
                            </div>
                            <p className={styles.sample}>서로 다른 문항 {group.distinctQuestionCount}개 · 원시험 응시 {group.attemptCount}회</p>
                            {group.assessment === "insufficient" ? <p className={styles.sample}>아직 판단에 필요한 기록이 부족합니다.</p> : null}
                            <p className={styles.trend}>{group.trendDelta === null ? "추이 비교 대기 · 기록 또는 응시 순서 확인 필요" : <>최근 추이 <strong>{group.trendDelta > 0 ? "+" : ""}{group.trendDelta}%p</strong><span>이전 응시 구간 대비</span></>}</p>
                            <button type="button" className={styles.evidenceToggle} aria-label={`${group.concept} 문항 근거 ${isExpanded ? "접기" : "보기"} (${group.evidence.length}건 · 최대 6건)`} aria-expanded={isExpanded} aria-controls={evidenceId} onClick={() => toggle(group.concept)}><span>문항 근거 <b>{group.evidence.length}건</b></span><ChevronDown size={17} aria-hidden="true" /></button>
                            <div id={evidenceId} className={`${styles.evidence} ${isExpanded ? "" : styles.collapsed}`}>
                                {group.evidence.length ? <><p className={styles.note}>최근 문항 근거 최대 6건입니다. 누적 결과의 일부만 표시될 수 있습니다.</p><ul>{group.evidence.map((item, evidenceIndex) => <li key={`${item.examId}:${item.attemptId}:${item.questionNumber}:${evidenceIndex}`}><Link aria-label={`${item.examTitle} · ${item.questionNumber}번 · ${resultLabels[item.status]}`} href={buildStudentResultHref(item.attemptId, "answers", item.questionNumber)}><span className={styles.questionNumber}>{item.questionNumber}번</span><span className={styles.evidenceExam}>{item.examTitle}</span><span className={styles.result} data-result={item.status}>{resultLabels[item.status]}</span><ArrowRight size={14} aria-hidden="true" /></Link></li>)}</ul></> : <p className={styles.note}>표시할 문항 근거가 없습니다.</p>}
                            </div>
                        </article>;
                    })}
                </div>
                {matches.length > visibleCount ? <button type="button" className={styles.showMore} onClick={() => { nextFocusIndex.current = groups.indexOf(matches[visibleCount]); setVisibleCount(current => current + PAGE_SIZE); }}>개념 {Math.min(PAGE_SIZE, matches.length - visibleCount)}개 더 보기 ({matches.length - visibleCount}개 남음)</button> : null}
            </> : <p className={styles.note}>분석 가능한 개념별 채점 기록이 없습니다.</p>}
            <footer className={styles.method}><h4>분석 기준</h4><p className={styles.note}>서로 다른 문항 3개 이상 · 원시험 응시 2회 이상. 강점은 정답률 80% 이상, 우선 보완은 50% 이하입니다. 미응답은 정답률에 포함됩니다.</p><p className={styles.note}>추이는 시험 난이도 차이를 반영하지 않습니다. 문항의 개념과 정오답을 연결한 결과이며, 풀이 과정·필기의 실수 원인 분석은 추후 지원 예정입니다.</p></footer>
        </section>
    );
}
