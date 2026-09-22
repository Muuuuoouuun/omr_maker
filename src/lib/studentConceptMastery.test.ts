import { describe, expect, it } from "vitest";
import type { Exam, QuestionResult } from "@/types/omr";
import { buildStudentConceptMastery } from "./studentConceptMastery";

function result(questionId: number, attemptId: string, status: QuestionResult["status"], concept = "시제"): QuestionResult {
    return {
        schemaVersion: 1, finishedAt: "2026-09-01", examId: "exam", examTitle: "시험", attemptId, studentName: "학생",
        questionId, questionNumber: questionId, concept, status,
        score: 1, earnedScore: status === "correct" ? 1 : 0,
        isCorrect: status === "correct", isWrong: status === "wrong", isUnanswered: status === "unanswered",
    };
}
const dates = new Map([["old", "2026-09-01"], ["new", "2026-09-02"]]);

describe("student concept mastery", () => {
    it("shows evidence-limited judgments and does not inflate evidence with duplicate results", () => {
        const one = result(1, "old", "correct");
        const { groups } = buildStudentConceptMastery([one, one, result(1, "new", "correct")], new Map(), dates);
        expect(groups[0]).toMatchObject({ totalCount: 2, distinctQuestionCount: 1, assessment: "insufficient", trendDelta: null });
    });

    it("classifies strengths and weaknesses and compares chronological original-attempt windows", () => {
        const { groups } = buildStudentConceptMastery([
            result(1, "new", "correct"), result(2, "new", "correct"),
            result(3, "old", "wrong"), result(4, "old", "unanswered"),
            result(5, "old", "correct", "어휘"), result(6, "new", "correct", "어휘"), result(7, "new", "correct", "어휘"),
            result(8, "new", "ungraded"),
        ], new Map(), dates);
        expect(groups.find(group => group.concept === "시제")).toMatchObject({
            totalCount: 4, correctRate: 50, unansweredCount: 1, assessment: "weakness", trendDelta: 100,
        });
        expect(groups.find(group => group.concept === "어휘")).toMatchObject({ assessment: "strength", correctRate: 100 });
    });

    it("uses exact rates rather than rounded display rates for assessment boundaries", () => {
        const nearStrength = Array.from({ length: 201 }, (_, i) => result(i + 1, i % 2 ? "old" : "new", i < 160 ? "correct" : "wrong"));
        const nearWeakness = Array.from({ length: 101 }, (_, i) => result(i + 1, i % 2 ? "old" : "new", i < 51 ? "correct" : "wrong", "어휘"));
        const summary = buildStudentConceptMastery([...nearStrength, ...nearWeakness.map(item => ({ ...item, questionId: item.questionId + 201 }))], new Map(), dates);
        expect(summary.groups.find(group => group.concept === "시제")).toMatchObject({ correctRate: 80, assessment: "developing" });
        expect(summary.groups.find(group => group.concept === "어휘")).toMatchObject({ correctRate: 50, assessment: "developing" });
    });

    it.each([undefined, "", "invalid", "2026", "2026-02-30", "2026-09-02"])("withholds trends for missing, invalid, partial, or tied dates: %s", oldDate => {
        const attemptDates = new Map([["new", "2026-09-02"]]);
        if (oldDate !== undefined) attemptDates.set("old", oldDate);
        const summary = buildStudentConceptMastery([
            result(1, "new", "correct"), result(2, "new", "correct"),
            result(3, "old", "wrong"), result(4, "old", "wrong"),
        ], new Map(), attemptDates);
        expect(summary.groups[0]).toMatchObject({ totalCount: 4, correctRate: 50, trendDelta: null });
    });

    it.each(["새 개념", "시제"])("never attaches current reviewed traps to historic grading even if the concept is %s", concept => {
        const exam: Exam = { id: "exam", title: "시험", createdAt: "2026-09-01", questions: [{
            id: 1, number: 1,
            contentAnalysis: { status: "reviewed", concepts: [concept], trapPoints: ["나중에 추가한 함정"], summary: "수정된 분석" },
        }] };
        const canonical = [result(1, "old", "wrong")];
        const withCurrentExam = buildStudentConceptMastery(canonical, new Map([[exam.id, exam]]), dates);
        expect(withCurrentExam).toEqual(buildStudentConceptMastery(canonical, new Map(), dates));
        expect(withCurrentExam.groups[0].evidence[0].trapPoints).toEqual([]);
    });

    it("does not backdate edited concepts or expose draft trap annotations", () => {
        const exam: Exam = { id: "exam", title: "시험", createdAt: "2026-09-01", questions: [{
            id: 1, number: 1, tags: { concept: "현재 수정된 개념" },
            contentAnalysis: { status: "draft", concepts: ["새 개념"], trapPoints: ["초안 함정"], summary: "초안" },
        }] };
        const summary = buildStudentConceptMastery([result(1, "old", "wrong"), result(1, "new", "correct", "")], new Map([[exam.id, exam]]), dates);
        expect(summary.groups.map(group => group.concept)).toEqual(["시제"]);
        expect(summary.groups[0].evidence[0].trapPoints).toEqual([]);
        expect(summary.unmappedQuestionCount).toBe(1);
    });
});
