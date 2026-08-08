import { describe, expect, it } from "vitest";
import type { StudentProfileHeadlineWeaknessEvidence } from "./studentProfileAnalytics";
import { buildStudentReportHeadline } from "./studentReportHeadline";

function evidence(partial: Partial<StudentProfileHeadlineWeaknessEvidence>): StudentProfileHeadlineWeaknessEvidence {
    return {
        kind: partial.kind || "concept",
        title: partial.title || "시제",
        examIds: partial.examIds || ["exam-1"],
        wrongCount: partial.wrongCount ?? 2,
        maxWrongRate: partial.maxWrongRate ?? 67,
        recommendedAction: partial.recommendedAction || "같은 개념 2문항 재추천",
    };
}

describe("student report headline", () => {
    it("prioritizes a weakness repeated across distinct exams and names the learning order", () => {
        const groups = [
            evidence({ title: "시제", examIds: ["exam-2", "exam-1", "exam-1"], wrongCount: 4, recommendedAction: "시제 핵심 2문항 재추천" }),
            evidence({ title: "문맥 어휘", examIds: ["exam-3"], wrongCount: 5 }),
        ];
        const snapshot = structuredClone(groups);

        const result = buildStudentReportHeadline(groups, "현재 시험 해석");

        expect(result.headline).toContain("‘시제’ 약점이 2개 시험에 반복");
        expect(result.headline).toContain("추천 학습 순서");
        expect(result.headline).toContain("후 관련 오답 재풀이");
        expect(result.weaknessLabel).toBe("시제 · 2회 반복");
        expect(groups).toEqual(snapshot);
    });

    it("describes a single cumulative weakness without claiming repetition", () => {
        const result = buildStudentReportHeadline([
            evidence({ title: "문맥 어휘", recommendedAction: "같은 개념 1문항 재추천" }),
        ], "현재 시험 해석");

        expect(result.headline).toContain("누적 이력에서 ‘문맥 어휘’ 약점이 확인");
        expect(result.headline).not.toContain("반복되었습니다");
        expect(result.weaknessLabel).toBe("뚜렷한 반복 없음");
    });

    it("falls back to the current-attempt headline when cumulative evidence is unavailable", () => {
        expect(buildStudentReportHeadline([], "재시험에서 8%p 상승했습니다.")).toEqual({
            headline: "재시험에서 8%p 상승했습니다.",
            weaknessLabel: "뚜렷한 반복 없음",
        });
    });
});
