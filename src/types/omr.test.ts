import { describe, expect, it } from "vitest";
import {
    DEFAULT_CHOICE_COUNT,
    computeExamTotalScore,
    gradeAttempt,
    normalizeChoiceCount,
    questionChoiceCount,
    questionWeight,
    type Question,
} from "./omr";

describe("OMR choice count helpers", () => {
    it("defaults unspecified multiple-choice questions to 5 choices", () => {
        expect(DEFAULT_CHOICE_COUNT).toBe(5);
        expect(normalizeChoiceCount(undefined)).toBe(5);
        expect(questionChoiceCount({})).toBe(5);
    });

    it("preserves explicit 4-choice and 5-choice questions", () => {
        expect(normalizeChoiceCount(4)).toBe(4);
        expect(normalizeChoiceCount(5)).toBe(5);
        expect(questionChoiceCount({ choices: 4 })).toBe(4);
        expect(questionChoiceCount({ choices: 5 })).toBe(5);
    });
});

function q(partial: Partial<Question> & Pick<Question, "id" | "number">): Question {
    return { ...partial };
}

describe("questionWeight", () => {
    it("uses the explicit positive score when provided", () => {
        expect(questionWeight(q({ id: 1, number: 1, score: 7 }), 10)).toBe(7);
    });

    it("falls back to an equal split of 100 when score is missing or non-positive", () => {
        expect(questionWeight(q({ id: 1, number: 1 }), 4)).toBe(25);
        expect(questionWeight(q({ id: 1, number: 1, score: 0 }), 4)).toBe(25);
        expect(questionWeight(q({ id: 1, number: 1, score: -5 }), 5)).toBe(20);
    });

    it("returns 0 when there are no questions to split across", () => {
        expect(questionWeight(q({ id: 1, number: 1 }), 0)).toBe(0);
    });
});

describe("computeExamTotalScore", () => {
    it("sums explicit weights", () => {
        expect(
            computeExamTotalScore([
                q({ id: 1, number: 1, score: 10 }),
                q({ id: 2, number: 2, score: 15 }),
            ]),
        ).toBe(25);
    });

    it("splits 100 evenly when weights are unset", () => {
        expect(
            computeExamTotalScore([
                q({ id: 1, number: 1 }),
                q({ id: 2, number: 2 }),
                q({ id: 3, number: 3 }),
                q({ id: 4, number: 4 }),
            ]),
        ).toBe(100);
    });
});

describe("gradeAttempt", () => {
    it("awards full score when every answer is correct", () => {
        const questions = [
            q({ id: 1, number: 1, answer: 2, score: 10 }),
            q({ id: 2, number: 2, answer: 3, score: 10 }),
        ];
        const graded = gradeAttempt(questions, { 1: 2, 2: 3 });
        expect(graded).toMatchObject({
            earnedScore: 20,
            totalScore: 20,
            correctCount: 2,
            incorrectCount: 0,
            unansweredCount: 0,
            ungradedCount: 0,
        });
    });

    it("treats undefined, null and 0 selections as unanswered (not wrong)", () => {
        const questions = [
            q({ id: 1, number: 1, answer: 2, score: 10 }),
            q({ id: 2, number: 2, answer: 3, score: 10 }),
            q({ id: 3, number: 3, answer: 4, score: 10 }),
        ];
        // id 1 omitted (undefined), id 2 explicitly null, id 3 explicitly 0
        const answers = { 2: null, 3: 0 } as unknown as Record<number, number>;
        const graded = gradeAttempt(questions, answers);
        expect(graded.unansweredCount).toBe(3);
        expect(graded.incorrectCount).toBe(0);
        expect(graded.correctCount).toBe(0);
        expect(graded.earnedScore).toBe(0);
        // Unanswered questions still have an answer key, so they count toward the total.
        expect(graded.totalScore).toBe(30);
    });

    it("does NOT count a question with no answer key as wrong (classifies it as ungraded)", () => {
        const questions = [
            q({ id: 1, number: 1, answer: 2, score: 10 }),
            q({ id: 2, number: 2, score: 10 }), // teacher left the answer key blank
        ];
        const graded = gradeAttempt(questions, { 1: 2, 2: 5 });
        expect(graded.correctCount).toBe(1);
        expect(graded.incorrectCount).toBe(0); // regression guard: was 1 (bug)
        expect(graded.ungradedCount).toBe(1);
    });

    it("excludes ungraded questions from the total so they never penalise the student", () => {
        const questions = [
            q({ id: 1, number: 1, answer: 2, score: 10 }),
            q({ id: 2, number: 2, score: 10 }), // no answer key → excluded from total
        ];
        const graded = gradeAttempt(questions, { 1: 2, 2: 3 });
        expect(graded.earnedScore).toBe(10);
        expect(graded.totalScore).toBe(10); // ungraded question's 10 points excluded
    });

    it("counts a mix of correct, wrong and unanswered questions", () => {
        const questions = [
            q({ id: 1, number: 1, answer: 2, score: 10 }),
            q({ id: 2, number: 2, answer: 3, score: 10 }),
            q({ id: 3, number: 3, answer: 4, score: 10 }),
        ];
        const graded = gradeAttempt(questions, { 1: 2, 2: 1, 3: 0 });
        expect(graded).toMatchObject({
            earnedScore: 10,
            totalScore: 30,
            correctCount: 1,
            incorrectCount: 1,
            unansweredCount: 1,
            ungradedCount: 0,
        });
    });

    it("splits weight evenly and rounds to 2 decimals when scores are unset", () => {
        const questions = [
            q({ id: 1, number: 1, answer: 1 }),
            q({ id: 2, number: 2, answer: 1 }),
            q({ id: 3, number: 3, answer: 1 }),
        ];
        // Each weight is 100/3 = 33.333...; one correct → 33.33
        const graded = gradeAttempt(questions, { 1: 1 });
        expect(graded.earnedScore).toBe(33.33);
        expect(graded.totalScore).toBe(100);
        expect(graded.correctCount).toBe(1);
    });
});
