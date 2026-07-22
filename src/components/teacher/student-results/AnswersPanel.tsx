"use client";

import { useMemo, useState } from "react";
import { ListChecks, MessageSquare, Send } from "lucide-react";
import type { Attempt, Exam, QuestionResult } from "@/types/omr";
import type { AttemptScoreSummary } from "@/lib/premiumAnalytics";
import { formatKoreanDateTime } from "@/lib/pure";
import { safeScorePercent } from "@/lib/scoreUtils";
import styles from "./StudentResultHub.module.css";

export interface AnswerResultCounts {
    correctCount: number;
    incorrectCount: number;
    unansweredCount: number;
    ungradedCount: number;
}

interface AnswersPanelProps {
    attempt: Attempt;
    exam?: Exam;
    questionResults: QuestionResult[];
    counts: AnswerResultCounts;
    score?: AttemptScoreSummary;
    subQuestionFilter: "needs_review" | "all";
    onSubQuestionFilterChange: (filter: "needs_review" | "all") => void;
    onReviewSubQuestion: (questionId: number, subQuestionId: string, reviewed: boolean) => Promise<void>;
    savingSubQuestionKey: string | null;
    answerDrafts: Record<number, string>;
    onAnswerDraftChange: (questionId: number, value: string) => void;
    onAnswerStudentQuestion: (questionId: number) => Promise<void>;
    savingQuestionId: number | null;
}

const STATUS_META: Record<QuestionResult["status"], { label: string; color: string }> = {
    correct: { label: "정답", color: "var(--success)" },
    wrong: { label: "오답", color: "var(--error)" },
    unanswered: { label: "미응답", color: "var(--muted)" },
    ungraded: { label: "미채점", color: "var(--muted)" },
};

function formatAnswer(answer?: number): string {
    return typeof answer === "number" && answer > 0 ? `${answer}번` : "미응답";
}

function formatQuestionTime(totalSec?: number): string {
    if (typeof totalSec !== "number" || !Number.isFinite(totalSec) || totalSec <= 0) return "";
    if (totalSec < 60) return `${totalSec}초`;
    const minutes = Math.floor(totalSec / 60);
    const seconds = totalSec % 60;
    return seconds > 0 ? `${minutes}분 ${seconds}초` : `${minutes}분`;
}

function SmallStat({ label, value, color }: { label: string; value: number; color: string }) {
    return (
        <div style={{ background: `${color}12`, border: `1px solid ${color}24`, borderRadius: "var(--radius-md)", padding: "0.7rem", textAlign: "center" }}>
            <div style={{ fontSize: "0.72rem", color: "var(--muted)", fontWeight: 800, marginBottom: "0.15rem" }}>{label}</div>
            <div style={{ color, fontWeight: 900, fontSize: "1.1rem" }}>{value}</div>
        </div>
    );
}

function QuestionAnswerRow({ result, timeSec }: { result: QuestionResult; timeSec?: number }) {
    const status = STATUS_META[result.status];
    const timeLabel = formatQuestionTime(result.timeSec ?? timeSec);

    return (
        <article style={{ display: "grid", gap: "0.35rem", padding: "0.75rem", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", background: "var(--surface)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "0.7rem", flexWrap: "wrap" }}>
                <strong style={{ fontSize: "0.86rem" }}>{result.questionNumber}번</strong>
                <span style={{ color: status.color, fontSize: "0.75rem", fontWeight: 900 }}>{status.label}</span>
            </div>
            <div style={{ color: "var(--muted)", fontSize: "0.78rem", fontWeight: 700 }}>
                선택 {formatAnswer(result.selectedAnswer)}
                {result.correctAnswer !== undefined && ` · 정답 ${formatAnswer(result.correctAnswer)}`}
            </div>
            <div style={{ display: "flex", gap: "0.75rem", color: "var(--muted)", fontSize: "0.72rem", fontWeight: 700, flexWrap: "wrap" }}>
                <span>점수 {result.earnedScore}/{result.score}</span>
                {timeLabel && <span>풀이 {timeLabel}</span>}
            </div>
        </article>
    );
}

export default function AnswersPanel({
    attempt,
    exam,
    questionResults,
    counts,
    score,
    subQuestionFilter,
    onSubQuestionFilterChange,
    onReviewSubQuestion,
    savingSubQuestionKey,
    answerDrafts,
    onAnswerDraftChange,
    onAnswerStudentQuestion,
    savingQuestionId,
}: AnswersPanelProps) {
    const [wrongOnly, setWrongOnly] = useState(false);
    const currentPercent = score?.scorePercent ?? safeScorePercent(attempt.score, attempt.totalScore);
    const currentEarnedScore = score?.earnedScore ?? attempt.score;
    const currentTotalScore = score?.totalScore ?? attempt.totalScore;
    const storedPercent = safeScorePercent(attempt.score, attempt.totalScore);
    const scoreRegraded = !!score
        && attempt.totalScore > 0
        && score.scorePercent !== storedPercent;
    const visibleQuestionResults = wrongOnly
        ? questionResults.filter(result => result.status === "wrong" || result.status === "unanswered")
        : questionResults;
    const wrongQuestionCount = questionResults.filter(result => result.status === "wrong" || result.status === "unanswered").length;
    const timingByQuestionId = useMemo(
        () => new Map((attempt.questionTimings || []).map(timing => [timing.questionId, timing.totalTimeSec])),
        [attempt.questionTimings],
    );

    const subQuestionRows = (exam?.questions || []).flatMap(question => (question.subQuestions || []).map(subQuestion => ({
        question,
        subQuestion,
        answer: attempt.subQuestionAnswers?.[question.id]?.[subQuestion.id],
    })));
    const answeredSubQuestionRows = subQuestionRows.filter(row => !!row.answer?.body);
    const pendingSubQuestionCount = answeredSubQuestionRows.filter(row => row.answer?.reviewStatus !== "reviewed").length;
    const visibleSubQuestionRows = subQuestionFilter === "needs_review"
        ? answeredSubQuestionRows.filter(row => row.answer?.reviewStatus !== "reviewed")
        : subQuestionRows;

    const studentQuestions = attempt.studentQuestions || [];
    const pendingQuestionCount = studentQuestions.filter(note => note.status !== "answered").length;
    const answeredQuestionCount = studentQuestions.length - pendingQuestionCount;

    return (
        <div className={styles.panelStack}>
            <section className="bento-card" style={{ padding: "1.25rem" }} aria-labelledby="answer-summary-title">
                <div id="answer-summary-title" style={{ fontSize: "0.75rem", fontWeight: 800, color: "var(--muted)", letterSpacing: "0.08em", marginBottom: "0.6rem" }}>현재 채점 요약</div>
                <div style={{ display: "flex", alignItems: "baseline", gap: "0.6rem", flexWrap: "wrap" }}>
                    <strong style={{ fontSize: "2.3rem", color: "var(--primary)", lineHeight: 1 }}>{currentPercent}%</strong>
                    <span style={{ color: "var(--muted)", fontWeight: 800 }}>{currentEarnedScore} / {currentTotalScore}점</span>
                </div>
                {scoreRegraded && (
                    <div style={{ marginTop: "0.65rem", color: "var(--warning)", fontSize: "0.72rem", fontWeight: 800 }}>
                        현재 정답 기준 재채점됨 · 제출 당시 {attempt.score}점 ({storedPercent}%)
                    </div>
                )}
                <div className={styles.statGrid} style={{ gridTemplateColumns: `repeat(${counts.ungradedCount > 0 ? 4 : 3}, minmax(0, 1fr))` }}>
                    <SmallStat label="정답" value={counts.correctCount} color="#16a34a" />
                    <SmallStat label="오답" value={counts.incorrectCount} color="#dc2626" />
                    <SmallStat label="미응답" value={counts.unansweredCount} color="#64748b" />
                    {counts.ungradedCount > 0 && <SmallStat label="미채점" value={counts.ungradedCount} color="#64748b" />}
                </div>
            </section>

            <section className="bento-card" style={{ padding: "1.25rem" }} aria-labelledby="all-answers-title">
                <div className={styles.sectionHeading}>
                    <h2 id="all-answers-title"><ListChecks size={18} aria-hidden="true" /> 전체 문항 답안</h2>
                    <div className={styles.filterGroup} role="group" aria-label="문항 결과 필터">
                        <button type="button" className={`btn ${wrongOnly ? "btn-secondary" : "btn-primary"}`} onClick={() => setWrongOnly(false)} aria-pressed={!wrongOnly}>전체 {questionResults.length}</button>
                        <button type="button" className={`btn ${wrongOnly ? "btn-primary" : "btn-secondary"}`} onClick={() => setWrongOnly(true)} aria-pressed={wrongOnly}>오답/미응답 {wrongQuestionCount}</button>
                    </div>
                </div>
                {visibleQuestionResults.length > 0 ? (
                    <div className={styles.rowList}>
                        {visibleQuestionResults.map(result => (
                            <QuestionAnswerRow key={result.questionId} result={result} timeSec={timingByQuestionId.get(result.questionId)} />
                        ))}
                    </div>
                ) : (
                    <p className={styles.emptyText}>{questionResults.length > 0 ? "표시할 오답 또는 미응답이 없습니다." : "현재 시험 정보에서 확인할 수 있는 문항 결과가 없습니다."}</p>
                )}
            </section>

            <section className="bento-card" style={{ padding: "1.25rem" }} aria-labelledby="subquestion-review-title">
                <div className={styles.sectionHeading}>
                    <div>
                        <h2 id="subquestion-review-title">심화 응답 검토</h2>
                        <p>응답 {answeredSubQuestionRows.length}/{subQuestionRows.length} · 검토 필요 {pendingSubQuestionCount}</p>
                    </div>
                    <div className={styles.filterGroup} role="group" aria-label="심화 응답 필터">
                        <button type="button" className={`btn ${subQuestionFilter === "needs_review" ? "btn-primary" : "btn-secondary"}`} onClick={() => onSubQuestionFilterChange("needs_review")} aria-pressed={subQuestionFilter === "needs_review"}>검토 필요</button>
                        <button type="button" className={`btn ${subQuestionFilter === "all" ? "btn-primary" : "btn-secondary"}`} onClick={() => onSubQuestionFilterChange("all")} aria-pressed={subQuestionFilter === "all"}>전체</button>
                    </div>
                </div>
                {visibleSubQuestionRows.length > 0 ? (
                    <div className={styles.rowList}>
                        {visibleSubQuestionRows.map(({ question, subQuestion, answer }) => {
                            const key = `${question.id}:${subQuestion.id}`;
                            return (
                                <article key={key} style={{ padding: "0.75rem", border: "1px solid var(--border)", borderRadius: "var(--radius-sm)", background: "var(--background)" }}>
                                    <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem", alignItems: "start" }}>
                                        <strong style={{ fontSize: "0.82rem" }}>{question.number}번 · {subQuestion.prompt}</strong>
                                        <span style={{ color: answer?.reviewStatus === "reviewed" ? "var(--success)" : answer ? "var(--warning)" : "var(--muted)", fontSize: "0.7rem", fontWeight: 900, whiteSpace: "nowrap" }}>{answer?.reviewStatus === "reviewed" ? "검토 완료" : answer ? "검토 필요" : "미응답"}</span>
                                    </div>
                                    <div style={{ marginTop: "0.45rem", whiteSpace: "pre-wrap", fontSize: "0.82rem", lineHeight: 1.55, color: answer ? "var(--foreground)" : "var(--muted)" }}>{answer?.body || "작성된 응답이 없습니다."}</div>
                                    {subQuestion.answerGuide && <div style={{ marginTop: "0.45rem", paddingTop: "0.45rem", borderTop: "1px dashed var(--border)", fontSize: "0.72rem", color: "var(--muted)" }}>교사용 가이드: {subQuestion.answerGuide}</div>}
                                    {answer && (
                                        <button type="button" className="btn btn-secondary" disabled={savingSubQuestionKey === key} onClick={() => void onReviewSubQuestion(question.id, subQuestion.id, answer.reviewStatus !== "reviewed")} style={{ width: "100%", marginTop: "0.55rem", fontSize: "0.74rem" }}>
                                            {savingSubQuestionKey === key ? "저장 중..." : answer.reviewStatus === "reviewed" ? "검토 필요로 되돌리기" : "검토 완료"}
                                        </button>
                                    )}
                                </article>
                            );
                        })}
                    </div>
                ) : (
                    <p className={styles.emptyText}>{subQuestionRows.length > 0 ? "검토가 필요한 심화 응답이 없습니다." : "이 시험에는 심화 응답 문항이 없습니다."}</p>
                )}
            </section>

            <section className="bento-card" style={{ padding: "1.25rem" }} aria-labelledby="student-questions-title">
                <div className={styles.sectionHeading}>
                    <h2 id="student-questions-title"><MessageSquare size={18} aria-hidden="true" /> 학생 질문</h2>
                    <span className={styles.countBadge}>대기 {pendingQuestionCount} · 답변 {answeredQuestionCount}</span>
                </div>
                {studentQuestions.length > 0 ? (
                    <div className={styles.rowList}>
                        {studentQuestions.map(note => (
                            <article key={note.questionId} style={{ padding: "0.8rem", borderRadius: "var(--radius-md)", border: `1px solid ${note.status === "answered" ? "#bbf7d0" : "#99f6e4"}`, background: note.status === "answered" ? "#f0fdf4" : "#f0fdfa", color: "#0f172a" }}>
                                <div style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem", marginBottom: "0.3rem", flexWrap: "wrap" }}>
                                    <strong style={{ fontSize: "0.86rem" }}>{note.questionNumber}번 질문</strong>
                                    <span style={{ color: "#64748b", fontSize: "0.7rem", fontWeight: 700 }}>{formatKoreanDateTime(note.createdAt)}</span>
                                </div>
                                <div style={{ color: "#334155", fontSize: "0.82rem", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{note.body}</div>
                                {note.status === "answered" && note.answer && (
                                    <div style={{ marginTop: "0.55rem", padding: "0.65rem", borderRadius: "var(--radius-sm)", background: "white", border: "1px solid #e2e8f0" }}>
                                        <div style={{ color: "#16a34a", fontWeight: 800, fontSize: "0.74rem", marginBottom: "0.25rem" }}>내 답변 · {formatKoreanDateTime(note.answer.createdAt)}</div>
                                        <div style={{ color: "#334155", fontSize: "0.82rem", lineHeight: 1.6, whiteSpace: "pre-wrap" }}>{note.answer.body}</div>
                                    </div>
                                )}
                                <label style={{ display: "grid", gap: "0.35rem", marginTop: "0.6rem", color: "#334155", fontSize: "0.74rem", fontWeight: 800 }}>
                                    {note.status === "answered" ? "답변 수정" : "교사 답변"}
                                    <textarea
                                        value={answerDrafts[note.questionId] || ""}
                                        onChange={event => onAnswerDraftChange(note.questionId, event.target.value.slice(0, 500))}
                                        placeholder={note.status === "answered" ? "답변을 고치려면 새로 입력하세요." : "학생에게 보낼 답변을 입력하세요."}
                                        rows={3}
                                        style={{ width: "100%", padding: "0.6rem", borderRadius: "var(--radius-sm)", border: "1px solid #cbd5e1", font: "inherit", resize: "vertical", background: "white" }}
                                    />
                                </label>
                                <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "0.45rem" }}>
                                    <button type="button" className="btn btn-primary" disabled={!(answerDrafts[note.questionId] || "").trim() || savingQuestionId === note.questionId} onClick={() => void onAnswerStudentQuestion(note.questionId)} style={{ fontSize: "0.78rem", display: "inline-flex", alignItems: "center", gap: "0.35rem" }}>
                                        <Send size={13} aria-hidden="true" />
                                        {savingQuestionId === note.questionId ? "저장 중..." : note.status === "answered" ? "답변 수정" : "답변 보내기"}
                                    </button>
                                </div>
                            </article>
                        ))}
                    </div>
                ) : (
                    <p className={styles.emptyText}>학생이 남긴 질문이 없습니다.</p>
                )}
            </section>
        </div>
    );
}
