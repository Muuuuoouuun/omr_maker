import { describe, expect, it } from "vitest";
import type { Question } from "@/types/omr";
import {
    attachInferredPassageRegions,
    attachInferredPassageSources,
    detectPassageGroupsFromPdfText,
    selectPassageGroupsForQuestions,
} from "./pdfPassageGrouping";

describe("pdf passage grouping", () => {
    it("detects Korean reading passage ranges and labels all dependent questions", () => {
        const groups = detectPassageGroupsFromPdfText([
            {
                page: 1,
                items: [
                    { str: "[", x: 0.08, y: 0.2 },
                    { str: "1", x: 0.1, y: 0.2 },
                    { str: "～", x: 0.115, y: 0.2 },
                    { str: "3", x: 0.13, y: 0.2 },
                    { str: "]", x: 0.145, y: 0.2 },
                    { str: "다음 글을 읽고 물음에 답하시오.", x: 0.18, y: 0.2 },
                ],
            },
            {
                page: 2,
                items: [
                    { str: "4 ～ 9 다음 글을 읽고 물음에 답하시오.", x: 0.08, y: 0.14 },
                ],
            },
        ], [1, 2, 3, 4, 5, 6, 7, 8, 9]);
        const questions: Question[] = Array.from({ length: 9 }, (_, index) => ({
            id: index + 1,
            number: index + 1,
        }));

        const tagged = attachInferredPassageSources(questions, groups);

        expect(groups.map(group => group.source)).toEqual([
            "지문 01 (1-3번)",
            "지문 02 (4-9번)",
        ]);
        expect(tagged.slice(0, 3).map(question => question.tags?.source)).toEqual([
            "지문 01 (1-3번)",
            "지문 01 (1-3번)",
            "지문 01 (1-3번)",
        ]);
        expect(tagged.slice(3).every(question => question.tags?.source === "지문 02 (4-9번)")).toBe(true);
    });

    it("uses the first occurrence of duplicated range instructions", () => {
        const groups = detectPassageGroupsFromPdfText([
            { page: 21, items: [{ str: "[ 1 ～ 3 ] 다음 글을 읽고 물음에 답하시오.", x: 0.08, y: 0.2 }] },
            { page: 1, items: [{ str: "[ 1 ～ 3 ] 다음 글을 읽고 물음에 답하시오.", x: 0.08, y: 0.2 }] },
        ], [1, 2, 3]);

        expect(groups).toHaveLength(1);
        expect(groups[0]).toMatchObject({
            startQuestion: 1,
            endQuestion: 3,
            page: 1,
            source: "지문 01 (1-3번)",
        });
    });

    it("preserves teacher-authored source labels by default", () => {
        const questions: Question[] = [
            { id: 1, number: 1, tags: { source: "수동 지문" } },
            { id: 2, number: 2 },
        ];
        const groups = [{
            startQuestion: 1,
            endQuestion: 2,
            page: 1,
            y: 0.2,
            text: "[1~2] 다음 글",
            source: "지문 01 (1-2번)",
        }];

        const tagged = attachInferredPassageSources(questions, groups);

        expect(tagged[0].tags?.source).toBe("수동 지문");
        expect(tagged[1].tags?.source).toBe("지문 01 (1-2번)");
    });

    it("drops later optional-section range groups that do not match selected question pages", () => {
        const groups = [
            { startQuestion: 35, endQuestion: 37, page: 13, y: 0.2, text: "[35~37]", source: "지문 09 (35-37번)" },
            { startQuestion: 35, endQuestion: 36, page: 17, y: 0.2, text: "[35~36]", source: "지문 10 (35-36번)" },
            { startQuestion: 38, endQuestion: 42, page: 14, y: 0.2, text: "[38~42]", source: "지문 11 (38-42번)" },
            { startQuestion: 43, endQuestion: 45, page: 15, y: 0.2, text: "[43~45]", source: "지문 12 (43-45번)" },
            { startQuestion: 44, endQuestion: 45, page: 20, y: 0.2, text: "[44~45]", source: "지문 13 (44-45번)" },
        ];
        const questions: Question[] = [
            { id: 35, number: 35, pdfLocation: { page: 13, x: 0.1, y: 0.7 } },
            { id: 36, number: 36, pdfLocation: { page: 13, x: 0.5, y: 0.2 } },
            { id: 37, number: 37, pdfLocation: { page: 13, x: 0.5, y: 0.5 } },
            { id: 38, number: 38, pdfLocation: { page: 14, x: 0.5, y: 0.7 } },
            { id: 44, number: 44, pdfLocation: { page: 16, x: 0.5, y: 0.1 } },
            { id: 45, number: 45, pdfLocation: { page: 16, x: 0.5, y: 0.3 } },
        ];

        const selected = selectPassageGroupsForQuestions(groups, questions);

        expect(selected.map(group => group.source)).toEqual([
            "지문 01 (35-37번)",
            "지문 02 (38-42번)",
            "지문 03 (43-45번)",
        ]);
    });

    it("stores a shared multi-column passage region on every member question", () => {
        const groups = [{
            startQuestion: 4,
            endQuestion: 9,
            page: 2,
            x: 0.08,
            y: 0.14,
            text: "[4~9] 다음 글을 읽고 물음에 답하시오.",
            source: "지문 01 (4-9번)",
        }];
        const questions: Question[] = Array.from({ length: 6 }, (_, index) => ({
            id: index + 4,
            number: index + 4,
            pdfLocation: index === 0
                ? { page: 3, x: 0.56, y: 0.42 }
                : { page: 3, x: 0.56, y: 0.5 + index * 0.05 },
        }));

        const linked = attachInferredPassageRegions(questions, groups);

        expect(linked[0].passagePdfRegions).toEqual([
            { page: 2, x: 0.045, y: 0.132, width: 0.44, height: 0.823 },
            { page: 2, x: 0.515, y: 0.055, width: 0.44, height: 0.9 },
            { page: 3, x: 0.045, y: 0.055, width: 0.44, height: 0.9 },
            { page: 3, x: 0.515, y: 0.055, width: 0.44, height: 0.353 },
        ]);
        expect(linked.every(question => question.passagePdfRegions === linked[0].passagePdfRegions)).toBe(true);
    });
});
