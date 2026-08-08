import type { StudentProfileHeadlineWeaknessEvidence } from "./studentProfileAnalytics";

export interface StudentReportHeadline {
    headline: string;
    weaknessLabel: string;
}

export function buildStudentReportHeadline(
    weaknessGroups: readonly StudentProfileHeadlineWeaknessEvidence[],
    fallbackHeadline: string,
): StudentReportHeadline {
    const selected = weaknessGroups
        .filter(group => group.title.trim() && group.examIds.length > 0)
        .map(group => ({ ...group, examIds: Array.from(new Set(group.examIds)) }))
        .sort((left, right) => (
            right.examIds.length - left.examIds.length
            || right.wrongCount - left.wrongCount
            || right.maxWrongRate - left.maxWrongRate
            || left.title.localeCompare(right.title, "ko")
        ))[0];
    if (!selected) {
        return { headline: fallbackHeadline, weaknessLabel: "뚜렷한 반복 없음" };
    }

    const action = selected.recommendedAction || "추천 학습 문항 복습";
    const learningOrder = `추천 학습 순서는 ‘${action}’ 후 관련 오답 재풀이입니다.`;
    if (selected.examIds.length >= 2) {
        return {
            headline: `누적 이력에서 ‘${selected.title}’ 약점이 ${selected.examIds.length}개 시험에 반복되었습니다. ${learningOrder}`,
            weaknessLabel: `${selected.title} · ${selected.examIds.length}회 반복`,
        };
    }

    return {
        headline: `누적 이력에서 ‘${selected.title}’ 약점이 확인되었습니다. ${learningOrder}`,
        weaknessLabel: "뚜렷한 반복 없음",
    };
}
