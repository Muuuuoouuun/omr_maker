import { describe, expect, it } from "vitest";
import type { StudentProfileWeaknessInsight } from "./studentProfileAnalytics";
import { buildStudentReportHeadline } from "./studentReportHeadline";

function weakness(partial: Partial<StudentProfileWeaknessInsight>): StudentProfileWeaknessInsight {
    return {
        key: partial.key || "weakness",
        examId: partial.examId || "exam-1",
        examTitle: partial.examTitle || "1차 진단",
        kind: partial.kind || "concept",
        title: partial.title || "시제",
        basis: partial.basis || "같은 개념",
        wrongCount: partial.wrongCount ?? 2,
        unansweredCount: partial.unansweredCount ?? 0,
        totalCount: partial.totalCount ?? 3,
        wrongRate: partial.wrongRate ?? 67,
        questionNumbers: partial.questionNumbers || [1, 2],
        recommendedQuestionIds: partial.recommendedQuestionIds || [1, 2],
        severity: partial.severity || "review",
        reason: partial.reason || "오답이 반복됨",
        sourceAttemptId: partial.sourceAttemptId || "attempt-1",
        retakeMode: partial.retakeMode || "similar",
        retakeQuestionIds: partial.retakeQuestionIds || [1, 2],
        retakeLabels: partial.retakeLabels || [],
        retakeConcepts: partial.retakeConcepts || [partial.title || "시제"],
        recommendedAction: partial.recommendedAction || "같은 개념 2문항 재추천",
    };
}

describe("student report headline", () => {
    it("prioritizes a weakness repeated across distinct exams and names the learning order", () => {
        const groups = [
            weakness({ key: "later", examId: "exam-2", examTitle: "2차 진단", title: "시제" }),
            weakness({ key: "single", examId: "exam-3", examTitle: "3차 진단", title: "문맥 어휘", wrongCount: 5 }),
            weakness({ key: "earlier", examId: "exam-1", examTitle: "1차 진단", title: "시제", recommendedAction: "시제 핵심 2문항 재추천" }),
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
            weakness({ title: "문맥 어휘", recommendedAction: "같은 개념 1문항 재추천" }),
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
