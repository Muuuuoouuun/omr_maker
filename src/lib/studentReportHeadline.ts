import type { StudentProfileWeaknessInsight } from "./studentProfileAnalytics";

export interface StudentReportHeadline {
    headline: string;
    weaknessLabel: string;
}

interface WeaknessCandidate {
    title: string;
    examIds: Set<string>;
    wrongCount: number;
    maxWrongRate: number;
    recommendedAction: string;
}

function normalizedTitle(value: string): string {
    return value.trim().toLocaleLowerCase("ko-KR");
}

function preferredAction(
    current: Pick<StudentProfileWeaknessInsight, "wrongCount" | "wrongRate" | "recommendedAction"> | undefined,
    candidate: StudentProfileWeaknessInsight,
): boolean {
    if (!current) return true;
    if (candidate.wrongCount !== current.wrongCount) return candidate.wrongCount > current.wrongCount;
    if (candidate.wrongRate !== current.wrongRate) return candidate.wrongRate > current.wrongRate;
    return candidate.recommendedAction.localeCompare(current.recommendedAction, "ko") < 0;
}

export function buildStudentReportHeadline(
    weaknessGroups: readonly StudentProfileWeaknessInsight[],
    fallbackHeadline: string,
): StudentReportHeadline {
    const candidateByTitle = new Map<string, WeaknessCandidate>();
    const actionSourceByTitle = new Map<string, StudentProfileWeaknessInsight>();

    for (const group of weaknessGroups) {
        const title = group.title.trim();
        if (!title) continue;
        const key = normalizedTitle(title);
        const current = candidateByTitle.get(key);
        if (current) {
            current.examIds.add(group.examId);
            current.wrongCount += Math.max(0, group.wrongCount);
            current.maxWrongRate = Math.max(current.maxWrongRate, group.wrongRate);
        } else {
            candidateByTitle.set(key, {
                title,
                examIds: new Set([group.examId]),
                wrongCount: Math.max(0, group.wrongCount),
                maxWrongRate: group.wrongRate,
                recommendedAction: group.recommendedAction.trim(),
            });
        }
        const actionSource = actionSourceByTitle.get(key);
        if (preferredAction(actionSource, group)) {
            actionSourceByTitle.set(key, group);
            const candidate = candidateByTitle.get(key);
            if (candidate) candidate.recommendedAction = group.recommendedAction.trim();
        }
    }

    const selected = Array.from(candidateByTitle.values()).sort((left, right) => (
        right.examIds.size - left.examIds.size
        || right.wrongCount - left.wrongCount
        || right.maxWrongRate - left.maxWrongRate
        || left.title.localeCompare(right.title, "ko")
    ))[0];
    if (!selected) {
        return { headline: fallbackHeadline, weaknessLabel: "뚜렷한 반복 없음" };
    }

    const action = selected.recommendedAction || "추천 학습 문항 복습";
    const learningOrder = `추천 학습 순서는 ‘${action}’ 후 관련 오답 재풀이입니다.`;
    if (selected.examIds.size >= 2) {
        return {
            headline: `누적 이력에서 ‘${selected.title}’ 약점이 ${selected.examIds.size}개 시험에 반복되었습니다. ${learningOrder}`,
            weaknessLabel: `${selected.title} · ${selected.examIds.size}회 반복`,
        };
    }

    return {
        headline: `누적 이력에서 ‘${selected.title}’ 약점이 확인되었습니다. ${learningOrder}`,
        weaknessLabel: "뚜렷한 반복 없음",
    };
}
