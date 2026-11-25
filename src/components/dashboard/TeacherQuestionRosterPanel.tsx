import { useMemo, useState } from "react";
import type { TeacherQuestionRoster } from "@/lib/teacherQuestionRoster";

const PAGE_SIZE = 12;

export default function TeacherQuestionRosterPanel({ roster }: { roster: TeacherQuestionRoster }) {
    const [questionId, setQuestionId] = useState<number>();
    const [filter, setFilter] = useState("wrong");
    const [limit, setLimit] = useState(PAGE_SIZE);
    const question = roster.status === "ready"
        ? roster.questions.find(item => item.id === questionId) ?? roster.questions[0] : undefined;
    const choices = useMemo(() => {
        const options = new Set<number>();
        for (const row of question?.rows ?? []) {
            if (row.selectedAnswer !== undefined) options.add(row.selectedAnswer);
        }
        return Array.from(options).sort((a, b) => a - b);
    }, [question]);
    const matches = useMemo(() => (question?.rows ?? [])
        .filter(row => filter === "wrong" || filter === "unanswered"
            ? row.status === filter : row.selectedAnswer === Number(filter))
        .sort((a, b) => a.studentName.localeCompare(b.studentName, "ko") || a.attemptId.localeCompare(b.attemptId)),
    [question, filter]);

    return (
        <section className="bento-card" aria-labelledby="teacher-question-roster-title"
            style={{ padding: "1.2rem", marginBottom: "1rem", display: "grid", gap: "0.8rem", overflowWrap: "anywhere" }}>
            <h2 id="teacher-question-roster-title">문항별 학생 찾기</h2>
            {roster.status === "unavailable" && (
                <p role="status">문항별 명단을 확인할 수 없습니다. 전체 본시험 제출과 동일한 문항 기준의 채점 기록이 모두 필요합니다. 저장된 총점은 학생별 결과에서 확인할 수 있습니다.</p>
            )}
            {roster.status === "empty" && <p>아직 제출을 마친 본시험 답안이 없습니다.</p>}
            {roster.status === "ready" && question && (
                <>
                    <p>제출을 마친 본시험 답안에서 오답, 미응답, 선택한 보기를 확인하세요.</p>
                    <div style={{ display: "flex", gap: "0.8rem", flexWrap: "wrap" }}>
                        <div style={{ display: "grid", gap: "0.25rem", maxWidth: "100%" }}>
                            <label htmlFor="teacher-roster-question">문항</label>
                            <select id="teacher-roster-question" value={question.id} onChange={event => {
                                setQuestionId(Number(event.target.value));
                                setFilter("wrong");
                                setLimit(PAGE_SIZE);
                            }}>
                                {roster.questions.map(item => <option key={item.id} value={item.id}>{item.number}번</option>)}
                            </select>
                        </div>
                        <div style={{ display: "grid", gap: "0.25rem", maxWidth: "100%" }}>
                            <label htmlFor="teacher-roster-filter">응답 조건</label>
                            <select id="teacher-roster-filter" value={filter} onChange={event => {
                                setFilter(event.target.value);
                                setLimit(PAGE_SIZE);
                            }}>
                                <option value="wrong">오답을 고른 학생</option>
                                <option value="unanswered">미응답 학생</option>
                                {choices.map(choice => <option key={choice} value={choice}>{choice}번 보기를 고른 학생</option>)}
                            </select>
                        </div>
                    </div>
                    <p role="status">{question.number}번 · 본시험 제출 {roster.total}건 중 {matches.length}건</p>
                    {matches.length ? <ul aria-label="조건에 맞는 제출 명단">
                        {matches.slice(0, limit).map(row => <li key={row.attemptId}>
                            <strong>{row.studentName || "이름 없음"}</strong>
                            {row.groupName && <span> · {row.groupName}</span>}
                            <span> · {row.selectedAnswer === undefined ? "미응답" : `${row.selectedAnswer}번 선택`}</span>
                        </li>)}
                    </ul> : <p>이 조건에 해당하는 제출이 없습니다.</p>}
                    {matches.length > limit && <button type="button" className="btn btn-secondary"
                        onClick={() => setLimit(value => value + PAGE_SIZE)}>명단 더 보기</button>}
                </>
            )}
        </section>
    );
}
