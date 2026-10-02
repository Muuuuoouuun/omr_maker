import { describe, expect, it } from "vitest";
import { applyFastAnswers, parseFastAnswerInput } from "./fastAnswerInput";
import type { Question } from "@/types/omr";

const questions: Question[] = Array.from({ length: 5 }, (_, index) => ({ id: index + 1, number: index + 1, choices: 5, answer: 3 }));

describe("quick answer entry", () => {
    it("preserves a skipped question instead of shifting later answers", () => {
        expect(parseFastAnswerInput("12-45", questions)).toEqual({ ok: true, answers: [1, 2, undefined, 4, 5] });
        expect(parseFastAnswerInput("12045", questions)).toEqual({ ok: true, answers: [1, 2, undefined, 4, 5] });
    });
    it("accepts whitespace and list separators without changing positions", () => {
        expect(parseFastAnswerInput("1, 2;\n- 4\t5", questions)).toEqual({ ok: true, answers: [1, 2, undefined, 4, 5] });
    });
    it.each(["12645", "1x245", "12.45", "①②③", "123451"])("rejects %s as a whole instead of silently deleting input", input => {
        expect(parseFastAnswerInput(input, questions).ok).toBe(false);
        expect(questions.map(question => question.answer)).toEqual([3, 3, 3, 3, 3]);
    });
    it("validates each question's actual choice count", () => {
        const mixed = questions.map((question, index) => ({ ...question, choices: index === 2 ? 4 as const : 5 as const }));
        expect(parseFastAnswerInput("12545", mixed)).toMatchObject({ ok: false, message: expect.stringContaining("3번은 4지선다") });
        expect(parseFastAnswerInput("12445", mixed).ok).toBe(true);
    });
    it("clears only the previously covered tail when shortening input", () => {
        expect(applyFastAnswers(questions, [1, 2], 4).map(question => question.answer)).toEqual([1, 2, undefined, undefined, 3]);
    });
    it("clears skipped slots and preserves separately entered answers beyond the quick entry", () => {
        expect(applyFastAnswers(questions, [1, undefined], 0).map(question => question.answer)).toEqual([1, undefined, 3, 3, 3]);
    });
    it("keeps an invalid intermediate entry from becoming the clear-tail boundary", () => {
        const original = applyFastAnswers(questions, [1, 2, 3, 4, 5], 0);
        expect(parseFastAnswerInput("12645", original).ok).toBe(false);
        expect(applyFastAnswers(original, [1, 2], 5).map(question => question.answer)).toEqual([1, 2, undefined, undefined, undefined]);
    });
    it("can remove all quick-entered answers", () => {
        expect(parseFastAnswerInput("", questions)).toEqual({ ok: true, answers: [] });
        expect(applyFastAnswers(questions, [], 5).every(question => question.answer === undefined)).toBe(true);
    });
});
