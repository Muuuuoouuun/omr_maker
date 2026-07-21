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

    it("extracts Korean horizontal answer tables", () => {
        const parsed = extractAnswersFromText(
            "문항 1 2 3 4 5 정답 ③ ④ ⑤ ① ② 배점 2 2 2 2 2 "
            + "문항번호 6 7 8 정답 A B C",
        );

        expect(parsed.map(item => [item.questionNum, item.answer])).toEqual([
            [1, 3],
            [2, 4],
            [3, 5],
            [4, 1],
            [5, 2],
            [6, 1],
            [7, 2],
            [8, 3],
        ]);
    });

    it("extracts numbered rows that use a Korean question suffix", () => {
        const parsed = extractAnswersFromText("정답 1번 ③ 2번: ④ 3번) C 4번 - 2번");

        expect(parsed.map(item => [item.questionNum, item.answer])).toEqual([
            [1, 3],
            [2, 4],
            [3, 3],
            [4, 2],
        ]);
    });

    it("does not invent rows when a horizontal table has mismatched columns", () => {
        const parsed = extractAnswersFromText("문항 1 2 3 4 정답 ① ② ③");

        expect(parsed).toEqual([]);
    });

    it("deduplicates repeated question rows by highest confidence", () => {
        const parsed = extractAnswersFromText("1. A 1 정답 ⑤ 2. B");

        expect(parsed.find(item => item.questionNum === 1)?.answer).toBe(1);
        expect(parsed).toHaveLength(2);
    });

    it("does not read per-question decimal scores as answers", () => {
        // "각 2.5점" must not become question 2 → answer 5; "배점 1.5" not Q1 → 5.
        const parsed = extractAnswersFromText("각 2.5점 배점 1.5 출제일 2026.1 1. ③ 2. ④");

        expect(parsed.find(item => item.questionNum === 1)?.answer).toBe(3);
        expect(parsed.find(item => item.questionNum === 2)?.answer).toBe(4);
        // The decimal fragments never produced spurious question rows.
        expect(parsed.map(item => item.questionNum)).toEqual([1, 2]);
    });

    it("rejects placeholder strings that merely contain a letter token", () => {
        expect(normalizeAnswerValue("N/A")).toBeNull();
        expect(normalizeAnswerValue("unknown answer")).toBeNull();
        expect(normalizeAnswerValue("가답안 참조")).toBeNull();
        // A genuine isolated token (optionally with 번) still maps.
        expect(normalizeAnswerValue("A번")).toBe(1);
        expect(normalizeAnswerValue("다")).toBe(3);
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
