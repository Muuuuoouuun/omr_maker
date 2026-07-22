import { describe, expect, it } from "vitest";
import {
    detectQuestionLocationsFromText,
    findMissingExpectedQuestionNumbers,
    isBetterDetectedQuestionPlacement,
    type DetectedQuestionPlacement,
    type PdfTextLocatorItem,
} from "./pdfQuestionDetection";

describe("pdf question detection", () => {
    it("reports the exact expected question numbers that remain unmatched", () => {
        expect(findMissingExpectedQuestionNumbers([1, 2, 3, 4], [1, 3])).toEqual([2, 4]);
    });

    it("prefers a real question heading over footer or table numbers", () => {
        const items: PdfTextLocatorItem[] = [
            { str: "1", x: 0.52, y: 0.91 },
            { str: "A", x: 0.2, y: 0.72 },
            { str: "1", x: 0.24, y: 0.72 },
            { str: "2", x: 0.32, y: 0.72 },
            { str: "1.", x: 0.08, y: 0.14 },
            { str: "그림은", x: 0.12, y: 0.14 },
            { str: "물체의 운동을 나타낸 것이다.", x: 0.19, y: 0.14 },
        ];

        const detected = detectQuestionLocationsFromText(items, [1]);

        expect(detected.get(1)).toMatchObject({
            questionNumber: 1,
            x: 0.08,
        });
        expect(detected.get(1)?.y).toBeLessThan(0.14);
    });

    it("detects a bare number when it starts a question line with text after it", () => {
        const items: PdfTextLocatorItem[] = [
            { str: "6", x: 0.09, y: 0.16 },
            { str: "다음은", x: 0.13, y: 0.16 },
            { str: "실험에", x: 0.2, y: 0.16 },
            { str: "대한 설명이다.", x: 0.27, y: 0.16 },
        ];

        const detected = detectQuestionLocationsFromText(items, [6]);

        expect(detected.get(6)).toMatchObject({
            questionNumber: 6,
            x: 0.09,
        });
    });

    it("detects a Q-prefixed question number emitted as one PDF text item", () => {
        const items: PdfTextLocatorItem[] = [
            { str: "Q12. ____", x: 0.08, y: 0.2 },
        ];

        const detected = detectQuestionLocationsFromText(items, [12]);

        expect(detected.get(12)).toMatchObject({
            questionNumber: 12,
            x: 0.08,
        });
    });

    it("detects every Q-prefixed heading laid out across the same PDF row", () => {
        const items: PdfTextLocatorItem[] = [
            { str: "Q1. ____", x: 0.1, y: 0.2 },
            { str: "Q2. ____", x: 0.3, y: 0.2 },
            { str: "Q3. ____", x: 0.6, y: 0.2 },
        ];

        const detected = detectQuestionLocationsFromText(items, [1, 2, 3]);

        expect([...detected.keys()]).toEqual([1, 2, 3]);
    });

    it("detects a question number enclosed in parentheses", () => {
        const items: PdfTextLocatorItem[] = [
            { str: "(12)", x: 0.08, y: 0.2 },
            { str: "다음 글을 읽고 물음에 답하시오.", x: 0.13, y: 0.2 },
        ];

        const detected = detectQuestionLocationsFromText(items, [12]);

        expect(detected.get(12)).toMatchObject({
            questionNumber: 12,
            x: 0.08,
        });
    });

    it("normalizes full-width digits in a question heading", () => {
        const items: PdfTextLocatorItem[] = [
            { str: "１２． 다음 글을 읽고 물음에 답하시오.", x: 0.08, y: 0.2 },
        ];

        const detected = detectQuestionLocationsFromText(items, [12]);

        expect(detected.get(12)).toMatchObject({
            questionNumber: 12,
            x: 0.08,
        });
    });

    it("does not discard a top-of-page question whose body starts with a short parenthetical label", () => {
        const items: PdfTextLocatorItem[] = [
            { str: "1.", x: 0.08, y: 0.11 },
            { str: "(가)", x: 0.12, y: 0.11 },
        ];

        const detected = detectQuestionLocationsFromText(items, [1]);

        expect(detected.get(1)).toMatchObject({
            questionNumber: 1,
            x: 0.08,
        });
    });

    it("detects a question whose inline body starts with an angle-bracket label", () => {
        const items: PdfTextLocatorItem[] = [
            { str: "7. <보기>에서 옳은 것을 고르시오.", x: 0.08, y: 0.2 },
        ];

        const detected = detectQuestionLocationsFromText(items, [7]);

        expect(detected.get(7)).toMatchObject({
            questionNumber: 7,
            x: 0.08,
        });
    });

    it("detects a question whose inline body starts with a Korean enclosed label", () => {
        const items: PdfTextLocatorItem[] = [
            { str: "8. ㉠～㉢에 대한 설명으로 옳은 것은?", x: 0.08, y: 0.2 },
        ];

        const detected = detectQuestionLocationsFromText(items, [8]);

        expect(detected.get(8)).toMatchObject({
            questionNumber: 8,
            x: 0.08,
        });
    });

    it("detects configured question numbers above 20 through the 50-question limit", () => {
        const items: PdfTextLocatorItem[] = [21, 45, 50].flatMap((questionNumber, index) => [
            { str: `${questionNumber}.`, x: 0.08, y: 0.18 + index * 0.2 },
            { str: "다음 글을 읽고 물음에 답하시오.", x: 0.14, y: 0.18 + index * 0.2 },
        ]);

        const detected = detectQuestionLocationsFromText(items, [21, 45, 50]);

        expect([...detected.keys()]).toEqual([21, 45, 50]);
    });

    it("ignores answer-choice number rows", () => {
        const items: PdfTextLocatorItem[] = [
            { str: "1", x: 0.1, y: 0.78 },
            { str: "ㄱ", x: 0.14, y: 0.78 },
            { str: "2", x: 0.22, y: 0.78 },
            { str: "ㄴ", x: 0.26, y: 0.78 },
            { str: "3", x: 0.34, y: 0.78 },
            { str: "ㄷ", x: 0.38, y: 0.78 },
            { str: "4", x: 0.46, y: 0.78 },
            { str: "ㄱ, ㄴ", x: 0.5, y: 0.78 },
        ];

        const detected = detectQuestionLocationsFromText(items, [1, 2, 3, 4]);

        expect([...detected.keys()]).toEqual([]);
    });

    it("ignores page header numbers that only label the subject or page", () => {
        const items: PdfTextLocatorItem[] = [
            { str: "2", x: 0.08, y: 0.08 },
            { str: "(물리학 I)", x: 0.12, y: 0.08 },
            { str: "6.", x: 0.08, y: 0.22 },
            { str: "그림은", x: 0.12, y: 0.22 },
            { str: "막대에", x: 0.19, y: 0.22 },
            { str: "대한", x: 0.25, y: 0.22 },
            { str: "설명이다.", x: 0.31, y: 0.22 },
        ];

        const detected = detectQuestionLocationsFromText(items, [2, 6]);

        expect(detected.has(2)).toBe(false);
        expect(detected.get(6)).toMatchObject({
            questionNumber: 6,
            x: 0.08,
        });
    });

    it("prefers the earlier repeated PDF form unless the later candidate is much stronger", () => {
        const early: DetectedQuestionPlacement = {
            page: 14,
            location: { questionNumber: 38, x: 0.1, y: 0.7, score: 82, text: "38. ..." },
        };
        const repeatedLater: DetectedQuestionPlacement = {
            page: 18,
            location: { questionNumber: 38, x: 0.1, y: 0.12, score: 96, text: "38. ..." },
        };
        const muchStrongerLater: DetectedQuestionPlacement = {
            page: 18,
            location: { questionNumber: 38, x: 0.1, y: 0.12, score: 110, text: "38. ..." },
        };

        expect(isBetterDetectedQuestionPlacement(repeatedLater, early)).toBe(false);
        expect(isBetterDetectedQuestionPlacement(muchStrongerLater, early)).toBe(true);
    });
});
