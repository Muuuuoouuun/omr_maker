import { describe, expect, it } from "vitest";
import {
    detectQuestionLocationsFromText,
    isBetterDetectedQuestionPlacement,
    type DetectedQuestionPlacement,
    type PdfTextLocatorItem,
} from "./pdfQuestionDetection";

describe("pdf question detection", () => {
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
