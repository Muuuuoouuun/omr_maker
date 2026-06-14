import { describe, expect, it } from "vitest";
import {
    extractAnswersFromText,
    normalizeAnswerValue,
    normalizeGeminiAnswerRows,
} from "./answerParser";

describe("answer parser normalization", () => {
    it("normalizes numeric, alphabetic, circled, and Korean answer values", () => {
        expect(normalizeAnswerValue("A")).toBe(1);
        expect(normalizeAnswerValue("⑤")).toBe(5);
        expect(normalizeAnswerValue("정답: 3번")).toBe(3);
        expect(normalizeAnswerValue("나")).toBe(2);
    });

    it("extracts answers from common table and inline answer key text", () => {
        const parsed = extractAnswersFromText("1. A 2) ④ 3 - C 4 정답 2번 5: E");

        expect(parsed.map(item => [item.questionNum, item.answer])).toEqual([
            [1, 1],
            [2, 4],
            [3, 3],
            [4, 2],
            [5, 5],
        ]);
    });

    it("deduplicates repeated question rows by highest confidence", () => {
        const parsed = extractAnswersFromText("1. A 1 정답 ⑤ 2. B");

        expect(parsed.find(item => item.questionNum === 1)?.answer).toBe(1);
        expect(parsed).toHaveLength(2);
    });

    it("normalizes Gemini rows with alternate keys and string answers", () => {
        const rows = normalizeGeminiAnswerRows([
            { id: "1", answer: "B", score: "2.5" },
            { number: 2, correctAnswer: "④" },
            { questionNum: "bad", answer: "A" },
        ]);

        expect(rows).toEqual([
            expect.objectContaining({ questionNum: 1, answer: 2, score: 2.5 }),
            expect.objectContaining({ questionNum: 2, answer: 4 }),
        ]);
    });
});
