import { describe, expect, it } from "vitest";
import type { PdfDrawings, Question } from "@/types/omr";
import {
    attachInferredQuestionPdfRegions,
    inferQuestionPdfRegions,
    summarizeQuestionDrawings,
} from "./handwritingAnalytics";

function stroke(points: Array<{ x: number; y: number }>, mode = "pen"): string {
    return JSON.stringify({ mode, points });
}

describe("handwriting analytics", () => {
    it("counts handwriting by explicit question PDF regions", () => {
        const questions: Question[] = [
            {
                id: 1,
                number: 1,
                pdfRegion: { page: 1, x: 0, y: 0, width: 1, height: 0.5 },
            },
            {
                id: 2,
                number: 2,
                pdfRegion: { page: 1, x: 0, y: 0.5, width: 1, height: 0.5 },
            },
        ];
        const drawings: PdfDrawings = {
            1: [
                stroke([{ x: 0.25, y: 0.2 }, { x: 0.3, y: 0.22 }]),
                stroke([{ x: 0.25, y: 0.72 }, { x: 0.3, y: 0.74 }]),
                stroke([{ x: 0.2, y: 0.25 }, { x: 0.32, y: 0.27 }], "eraser"),
            ],
        };

        expect(summarizeQuestionDrawings(questions, drawings)).toEqual([
            { questionId: 1, questionNumber: 1, page: 1, strokeCount: 1 },
            { questionId: 2, questionNumber: 2, page: 1, strokeCount: 1 },
        ]);
    });

    it("infers question regions from PDF marker positions without storing cropped images", () => {
        const questions: Question[] = [
            { id: 1, number: 1, pdfLocation: { page: 1, x: 0.2, y: 0.2 } },
            { id: 2, number: 2, pdfLocation: { page: 1, x: 0.2, y: 0.65 } },
            { id: 3, number: 3, pdfLocation: { page: 1, x: 0.72, y: 0.2 } },
            { id: 4, number: 4, pdfLocation: { page: 1, x: 0.72, y: 0.65 } },
        ];
        const regions = inferQuestionPdfRegions(questions);

        expect(regions.get(1)).toMatchObject({ page: 1 });
        expect(regions.get(1)?.x).toBeGreaterThan(0.16);
        expect(regions.get(1)?.x).toBeLessThan(0.2);
        expect(regions.get(1)?.y).toBeGreaterThan(0.15);
        expect(regions.get(1)?.height).toBeGreaterThan(0.43);
        expect(regions.get(1)?.height).toBeLessThan(0.46);
        expect(regions.get(2)?.y).toBeGreaterThan(0.6);
        expect(regions.get(3)?.x).toBeGreaterThan(0.68);
        expect(regions.get(4)?.x).toBeGreaterThan(0.68);

        const drawings: PdfDrawings = {
            1: [
                stroke([{ x: 0.25, y: 0.18 }, { x: 0.28, y: 0.2 }]),
                stroke([{ x: 0.28, y: 0.72 }, { x: 0.3, y: 0.74 }]),
                stroke([{ x: 0.76, y: 0.18 }, { x: 0.79, y: 0.2 }]),
                stroke([{ x: 0.78, y: 0.72 }, { x: 0.8, y: 0.74 }]),
            ],
        };

        expect(summarizeQuestionDrawings(questions, drawings)).toEqual([
            { questionId: 1, questionNumber: 1, page: 1, strokeCount: 1 },
            { questionId: 2, questionNumber: 2, page: 1, strokeCount: 1 },
            { questionId: 3, questionNumber: 3, page: 1, strokeCount: 1 },
            { questionId: 4, questionNumber: 4, page: 1, strokeCount: 1 },
        ]);
    });

    it("does not let a single marker in a column claim the full page height", () => {
        const questions: Question[] = [
            { id: 1, number: 1, pdfLocation: { page: 1, x: 0.2, y: 0.18 } },
            { id: 2, number: 2, pdfLocation: { page: 1, x: 0.2, y: 0.56 } },
            { id: 3, number: 3, pdfLocation: { page: 1, x: 0.72, y: 0.18 } },
        ];

        const regions = inferQuestionPdfRegions(questions);

        expect(regions.get(3)?.x).toBeGreaterThan(0.68);
        expect(regions.get(3)?.width).toBeLessThan(0.3);
        expect(regions.get(3)?.height).toBeGreaterThan(0.58);
        expect(regions.get(3)?.height).toBeLessThan(0.75);
        expect(regions.get(3)?.y).toBeGreaterThan(0.14);
        expect((regions.get(3)?.y || 0) + (regions.get(3)?.height || 0)).toBeLessThanOrEqual(0.925);
    });

    it("extends single-row math pages enough for large diagrams and choices", () => {
        const questions: Question[] = [
            { id: 1, number: 11, pdfLocation: { page: 1, x: 0.105, y: 0.128 } },
            { id: 2, number: 12, pdfLocation: { page: 1, x: 0.518, y: 0.128 } },
        ];

        const regions = inferQuestionPdfRegions(questions);

        expect((regions.get(1)?.y || 0) + (regions.get(1)?.height || 0)).toBeGreaterThan(0.7);
        expect((regions.get(2)?.y || 0) + (regions.get(2)?.height || 0)).toBeGreaterThan(0.7);
        expect((regions.get(1)?.y || 0) + (regions.get(1)?.height || 0)).toBeLessThanOrEqual(0.925);
    });

    it("does not cut a long single-column question because another column has a lower row", () => {
        const questions: Question[] = [
            { id: 1, number: 1, pdfLocation: { page: 1, x: 0.18, y: 0.12 } },
            { id: 2, number: 2, pdfLocation: { page: 1, x: 0.18, y: 0.58 } },
            { id: 3, number: 3, pdfLocation: { page: 1, x: 0.72, y: 0.12 } },
        ];

        const regions = inferQuestionPdfRegions(questions);

        expect((regions.get(3)?.y || 0) + (regions.get(3)?.height || 0)).toBeGreaterThan(0.7);
        expect((regions.get(3)?.y || 0) + (regions.get(3)?.height || 0)).toBeLessThanOrEqual(0.925);
    });

    it("extends a mid-page final question far enough to include trailing choices", () => {
        const questions: Question[] = [
            { id: 1, number: 1, pdfLocation: { page: 1, x: 0.18, y: 0.12 } },
            { id: 2, number: 2, pdfLocation: { page: 1, x: 0.72, y: 0.41 } },
        ];

        const regions = inferQuestionPdfRegions(questions);
        const region = regions.get(2);

        expect(region).toBeDefined();
        expect((region?.y || 0) + (region?.height || 0)).toBeGreaterThan(0.8);
        expect((region?.y || 0) + (region?.height || 0)).toBeLessThanOrEqual(0.925);
    });

    it("keeps inferred regions tight to the question marker instead of the page edge", () => {
        const questions: Question[] = [
            { id: 1, number: 1, pdfLocation: { page: 1, x: 0.105, y: 0.22 } },
            { id: 2, number: 2, pdfLocation: { page: 1, x: 0.105, y: 0.44 } },
            { id: 3, number: 3, pdfLocation: { page: 1, x: 0.519, y: 0.22 } },
        ];

        const regions = inferQuestionPdfRegions(questions);

        expect(regions.get(1)?.x).toBeGreaterThan(0.08);
        expect(regions.get(1)?.x).toBeLessThan(0.1);
        expect(regions.get(1)?.width).toBeLessThan(0.42);
        expect(regions.get(3)?.x).toBeGreaterThanOrEqual(0.512);
    });

    it("does not assign page-level handwriting to every question when no PDF position exists", () => {
        const questions: Question[] = [
            { id: 1, number: 1 },
            { id: 2, number: 2 },
        ];
        const drawings: PdfDrawings = {
            1: [stroke([{ x: 0.25, y: 0.18 }])],
        };

        expect(summarizeQuestionDrawings(questions, drawings)).toEqual([]);
    });

    it("materializes question PDF regions so exams can store crop metadata without image files", () => {
        const questions: Question[] = [
            {
                id: 1,
                number: 1,
                pdfLocation: { page: 1, x: 0.18, y: 0.22 },
                pdfRegion: { page: 1, x: 0.7, y: 0.7, width: 0.2, height: 0.2 },
            },
            { id: 2, number: 2, pdfLocation: { page: 1, x: 0.18, y: 0.7 } },
            { id: 3, number: 3, pdfLocation: { page: 1, x: 0.72, y: 0.22 } },
        ];

        const materialized = attachInferredQuestionPdfRegions(questions, { overwriteExisting: true });

        expect(materialized[0].pdfRegion).toMatchObject({ page: 1 });
        expect(materialized[0].pdfRegion?.x).toBeGreaterThan(0.15);
        expect(materialized[0].pdfRegion?.y).toBeGreaterThan(0.18);
        expect(materialized[1].pdfRegion?.y).toBeGreaterThan(0.4);
        expect(materialized[2].pdfRegion?.x).toBeGreaterThan(0.68);
        expect(materialized[0].pdfRegion).not.toEqual(questions[0].pdfRegion);
    });

    it("stops Korean passage questions before the next passage heading", () => {
        const questions: Question[] = [
            {
                id: 9,
                number: 9,
                pdfLocation: { page: 3, x: 0.52, y: 0.6 },
                tags: { source: "지문 02 (4-9번)" },
            },
        ];

        const materialized = attachInferredQuestionPdfRegions(questions, {
            overwriteExisting: true,
            textPages: [{
                page: 3,
                items: [
                    { str: "9.", x: 0.52, y: 0.6, height: 0.01 },
                    { str: "윗글에", x: 0.55, y: 0.6, height: 0.01 },
                    { str: "대한", x: 0.6, y: 0.64, height: 0.01 },
                    { str: "답은", x: 0.55, y: 0.7, height: 0.01 },
                    { str: "[10~13]", x: 0.1, y: 0.79, height: 0.01 },
                    { str: "다음 글을 읽고 물음에 답하시오.", x: 0.18, y: 0.79, height: 0.01 },
                ],
            }],
            passageGroups: [
                { startQuestion: 10, page: 3, y: 0.79 },
            ],
        });

        const bottom = (materialized[0].pdfRegion?.y || 0) + (materialized[0].pdfRegion?.height || 0);

        expect(bottom).toBeLessThan(0.79);
        expect(bottom).toBeGreaterThan(0.7);
    });

    it("shrinks excessive empty tail for text-heavy Korean questions", () => {
        const questions: Question[] = [
            {
                id: 31,
                number: 31,
                pdfLocation: { page: 12, x: 0.105, y: 0.28 },
                tags: { source: "지문 08 (31-34번)" },
            },
            {
                id: 32,
                number: 32,
                pdfLocation: { page: 12, x: 0.105, y: 0.7 },
                tags: { source: "지문 08 (31-34번)" },
            },
        ];

        const materialized = attachInferredQuestionPdfRegions(questions, {
            overwriteExisting: true,
            textPages: [{
                page: 12,
                items: [
                    { str: "31.", x: 0.105, y: 0.28, height: 0.01 },
                    { str: "다음", x: 0.14, y: 0.31, height: 0.01 },
                    { str: "내용으로", x: 0.18, y: 0.36, height: 0.01 },
                    { str: "적절한", x: 0.14, y: 0.42, height: 0.01 },
                    { str: "것은?", x: 0.2, y: 0.46, height: 0.01 },
                    { str: "32.", x: 0.105, y: 0.7, height: 0.01 },
                ],
            }],
        });

        const q31Bottom = (materialized[0].pdfRegion?.y || 0) + (materialized[0].pdfRegion?.height || 0);
        const q32Top = materialized[1].pdfRegion?.y || 0;

        expect(q31Bottom).toBeLessThan(0.55);
        expect(q32Top).toBeGreaterThan(0.68);
    });

    it("clips Korean passage regions before same-column footer notices only", () => {
        const questions: Question[] = [
            {
                id: 32,
                number: 32,
                pdfLocation: { page: 12, x: 0.105, y: 0.7 },
                tags: { source: "지문 08 (31-34번)" },
            },
            {
                id: 34,
                number: 34,
                pdfLocation: { page: 12, x: 0.518, y: 0.29 },
                tags: { source: "지문 08 (31-34번)" },
            },
        ];

        const materialized = attachInferredQuestionPdfRegions(questions, {
            overwriteExisting: true,
            textPages: [{
                page: 12,
                items: [
                    { str: "32.", x: 0.105, y: 0.7, height: 0.01 },
                    { str: "선택지", x: 0.14, y: 0.8, height: 0.01 },
                    { str: "마지막 보기", x: 0.14, y: 0.88, height: 0.01 },
                    { str: "34.", x: 0.518, y: 0.29, height: 0.01 },
                    { str: "윗글을", x: 0.55, y: 0.36, height: 0.01 },
                    { str: "바탕으로", x: 0.55, y: 0.48, height: 0.01 },
                    { str: "고른 것은?", x: 0.55, y: 0.68, height: 0.01 },
                    { str: "확인 사항", x: 0.546, y: 0.823, height: 0.01 },
                    { str: "답안지의 해당란에 필요한 내용을", x: 0.545, y: 0.841, height: 0.01 },
                ],
            }],
        });

        const q32Bottom = (materialized[0].pdfRegion?.y || 0) + (materialized[0].pdfRegion?.height || 0);
        const q34Bottom = (materialized[1].pdfRegion?.y || 0) + (materialized[1].pdfRegion?.height || 0);

        expect(q32Bottom).toBeGreaterThan(0.88);
        expect(q34Bottom).toBeLessThan(0.823);
        expect(q34Bottom).toBeGreaterThan(0.68);
    });
});
