import Link from "next/link";
import type { StudentConceptMasterySummary } from "@/lib/studentConceptMastery";
import styles from "./StudentResultHub.module.css";

const assessmentLabels = {
    strength: "강점", weakness: "우선 보완", developing: "학습 중", insufficient: "판단 보류",
};
const resultLabels = { correct: "정답", wrong: "오답", unanswered: "미응답", ungraded: "미채점" };

export default function StudentConceptMasteryPanel({ summary }: { summary: StudentConceptMasterySummary }) {
    return (
        <div style={{ marginTop: "1.25rem" }}>
            <h3>개념별 강점과 보완점</h3>
            <p className={styles.emptyText}>원시험 채점 결과 기준입니다. 서로 다른 문항 3개 이상 · 원시험 응시 2회 이상일 때 강점(정답률 80% 이상)·보완점(50% 이하)을 표시합니다. 미응답은 정답률에 포함됩니다.</p>
            {summary.unmappedQuestionCount > 0 ? <p className={styles.cumulativeWarning}>개념이 연결되지 않은 채점 기록 {summary.unmappedQuestionCount}건은 제외했습니다. 다음 시험 전에 학습지 분석을 검토·반영하면 개념별 결과가 쌓입니다.</p> : null}
            {summary.groups.length ? (
                <div className={styles.reportGrowthDetails}>
                    {summary.groups.map(group => (
                        <div key={group.concept}>
                            <strong>{group.concept} · {assessmentLabels[group.assessment]}</strong>
                            <p>정답률 {group.correctRate}% ({group.correctCount}/{group.totalCount}) · 서로 다른 문항 {group.distinctQuestionCount}개 · 원시험 응시 {group.attemptCount}회</p>
                            <p>{group.trendDelta === null ? "추이 비교에 필요한 기록이 부족합니다." : `최근·이전 응시 구간 비교 ${group.trendDelta > 0 ? "+" : ""}${group.trendDelta}%p · 시험 난이도 차이는 반영하지 않습니다.`}</p>
                            <details>
                                <summary>최근 문항 근거 보기</summary>
                                <ul>
                                    {group.evidence.map(item => (
                                        <li key={`${item.attemptId}:${item.questionNumber}`}>
                                            <Link href={`/teacher/attempt/${encodeURIComponent(item.attemptId)}`}>{item.examTitle} · {item.questionNumber}번 · {resultLabels[item.status]}</Link>
                                            {item.trapPoints.length ? <p>문항의 주의 포인트: {item.trapPoints.join(", ")} (학생의 실제 실수로 확인된 내용은 아닙니다.)</p> : null}
                                        </li>
                                    ))}
                                </ul>
                            </details>
                        </div>
                    ))}
                </div>
            ) : <p className={styles.emptyText}>분석 가능한 개념별 채점 기록이 없습니다.</p>}
            <p className={styles.emptyText}>문항의 개념과 정오답을 연결한 결과입니다. 풀이 과정·필기의 실수 원인 분석은 추후 지원 예정입니다.</p>
        </div>
    );
}
