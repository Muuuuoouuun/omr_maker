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
});
