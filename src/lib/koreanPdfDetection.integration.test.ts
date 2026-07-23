import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import {
    detectQuestionLocationsFromText,
    isBetterDetectedQuestionPlacement,
    type DetectedQuestionPlacement,
    type PdfTextLocatorItem,
} from "./pdfQuestionDetection";
import {
    attachInferredPassageRegions,
    attachInferredPassageSources,
    detectPassageGroupsFromPdfText,
    selectPassageGroupsForQuestions,
    type PdfPageTextItems,
} from "./pdfPassageGrouping";
import type { Question } from "@/types/omr";

describe("Korean 45-question PDF detection", () => {
    it("keeps every real common passage linked without broken normalized regions", async () => {
        const pdfPath = path.join(process.cwd(), "output/pdf/2026학년도-수능-국어-언어와매체-홀수형.pdf");
        const pdf = await getDocument({ data: new Uint8Array(await readFile(pdfPath)) }).promise;
        const expected = new Set(Array.from({ length: 45 }, (_, index) => index + 1));
        const bestLocations = new Map<number, DetectedQuestionPlacement>();
        const pages: PdfPageTextItems[] = [];

        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
            const page = await pdf.getPage(pageNumber);
            const viewport = page.getViewport({ scale: 1 });
            const content = await page.getTextContent();
            const items = content.items.map(rawItem => {
                const item = rawItem as { str?: unknown; transform?: unknown; width?: unknown; height?: unknown };
                const transform = Array.isArray(item.transform) ? item.transform : [];
                return {
                    str: typeof item.str === "string" ? item.str : "",
                    x: Number(transform[4]) / viewport.width,
                    y: (viewport.height - Number(transform[5])) / viewport.height,
                    width: typeof item.width === "number" ? item.width / viewport.width : undefined,
                    height: typeof item.height === "number" ? item.height / viewport.height : undefined,
                } satisfies PdfTextLocatorItem;
            }).filter(item => Number.isFinite(item.x) && Number.isFinite(item.y));
            pages.push({ page: pageNumber, items });

            for (const [questionNumber, location] of detectQuestionLocationsFromText(items, expected)) {
                const current = bestLocations.get(questionNumber);
                if (isBetterDetectedQuestionPlacement({ page: pageNumber, location }, current)) {
                    bestLocations.set(questionNumber, { page: pageNumber, location });
                }
            }
        }

        const questions: Question[] = [...expected].map(number => {
            const placement = bestLocations.get(number);
            return {
                id: number,
                number,
                pdfLocation: placement
                    ? { page: placement.page, x: placement.location.x, y: placement.location.y }
                    : undefined,
            };
        });
        const detectedGroups = detectPassageGroupsFromPdfText(pages, expected);
        const groups = selectPassageGroupsForQuestions(
            detectedGroups,
            questions,
        );
        const linked = attachInferredPassageRegions(attachInferredPassageSources(questions, groups), groups);

        expect(bestLocations.size).toBe(45);
        expect(groups.map(group => [group.startQuestion, group.endQuestion])).toEqual([
            [1, 3], [4, 9], [10, 13], [14, 17], [18, 21], [22, 26], [27, 30], [31, 34],
            [35, 36], [40, 43], [44, 45],
        ]);
        for (const group of groups) {
            const members = linked.filter(question => question.number >= group.startQuestion && question.number <= group.endQuestion);
            expect(members.every(question => question.tags?.source === group.source)).toBe(true);
            expect(members.every(question => (question.passagePdfRegions?.length || 0) > 0)).toBe(true);
            for (const region of members[0].passagePdfRegions || []) {
                expect(region.page).toBeGreaterThanOrEqual(group.page);
                expect(region.x).toBeGreaterThanOrEqual(0);
                expect(region.y).toBeGreaterThanOrEqual(0);
                expect(region.x + region.width).toBeLessThanOrEqual(1);
                expect(region.y + region.height).toBeLessThanOrEqual(1);
                expect(region.width).toBeGreaterThan(0);
                expect(region.height).toBeGreaterThan(0);
            }
        }

        await pdf.destroy();
    }, 20_000);
});
