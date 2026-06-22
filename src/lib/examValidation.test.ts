import { describe, expect, it } from "vitest";
import type { Question } from "@/types/omr";
import { validateExamDraft } from "./examValidation";

const validQuestions: Question[] = [
    {
        id: 1,
        number: 1,
        answer: 2,
        choices: 5,
        score: 4,
        label: "문법",
        tags: { concept: "높임 표현" },
        pdfLocation: { page: 1, x: 0.2, y: 0.3 },
        pdfRegion: { page: 1, x: 0.12, y: 0.2, width: 0.72, height: 0.18 },
    },
    {
        id: 2,
        number: 2,
        answer: 4,
        choices: 5,
        score: 4,
        label: "문학",
        tags: { concept: "화자의 정서" },
        pdfLocation: { page: 1, x: 0.2, y: 0.6 },
        pdfRegion: { page: 1, x: 0.12, y: 0.5, width: 0.72, height: 0.18 },
    },
];

describe("exam validation", () => {
    it("accepts a complete publishable exam draft", () => {
        const summary = validateExamDraft({
            title: "6월 모의고사",
            questions: validQuestions,
            durationMin: 50,
            startAt: "2026-06-15T19:00",
            endAt: "2026-06-15T19:50",
            hasProblemPdf: true,
            accessConfig: { type: "public", pin: "1234" },
        });

        expect(summary.isPublishable).toBe(true);
        expect(summary.errors).toHaveLength(0);
        expect(summary.warnings).toHaveLength(0);
        expect(summary).toMatchObject({
            totalQuestions: 2,
            answeredCount: 2,
            totalScore: 8,
            taggedCount: 2,
            pdfLinkedCount: 2,
            pdfRegionCount: 2,
        });
    });

    it("blocks missing answers, invalid choice ranges, and bad schedules", () => {
        const summary = validateExamDraft({
            title: "A",
            questions: [
                { id: 1, number: 1, choices: 4 },
                { id: 2, number: 2, answer: 5, choices: 4 },
            ],
            durationMin: 0,
            startAt: "2026-06-15T20:00",
            endAt: "2026-06-15T19:00",
        });

        expect(summary.isPublishable).toBe(false);
        expect(summary.errors.map(error => error.code)).toEqual([
            "title_required",
            "missing_answers",
            "answer_out_of_range",
            "invalid_duration",
            "invalid_schedule_order",
        ]);
    });

    it("blocks invalid or duplicate question numbers before OMR answer mapping", () => {
        const summary = validateExamDraft({
            title: "문항 번호 검증",
            questions: [
                { id: 1, number: 1, answer: 1 },
                { id: 2, number: 1, answer: 2 },
                { id: 3, number: 0, answer: 3 },
            ],
        });

        expect(summary.isPublishable).toBe(false);
        expect(summary.errors).toEqual([
            expect.objectContaining({
                code: "invalid_question_numbers",
                questionIds: [3],
            }),
            expect.objectContaining({
                code: "duplicate_question_numbers",
                questionIds: [1, 2],
            }),
        ]);
    });

    it("treats unspecified multiple-choice questions as 5 options", () => {
        const summary = validateExamDraft({
            title: "기본 5지선다",
            questions: [
                { id: 1, number: 1, answer: 5 },
            ],
        });

        expect(summary.errors.map(error => error.code)).not.toContain("answer_out_of_range");
    });

    it("blocks invalid distribution config", () => {
        expect(validateExamDraft({
            title: "배포 검증",
            questions: validQuestions,
            accessConfig: { type: "group", groupIds: [] },
        }).errors.map(error => error.code)).toContain("group_required");

        expect(validateExamDraft({
            title: "배포 검증",
            questions: validQuestions,
            accessConfig: { type: "public", pin: "12ab" },
        }).errors.map(error => error.code)).toContain("invalid_pin");
    });

    it("warns about missing service-quality metadata without blocking publish", () => {
        const summary = validateExamDraft({
            title: "메타 부족 시험",
            questions: [
                { id: 1, number: 1, answer: 2, choices: 5 },
            ],
            hasProblemPdf: true,
        });

        expect(summary.isPublishable).toBe(true);
        expect(summary.warnings.map(warning => warning.code)).toEqual([
            "metadata_incomplete",
            "pdf_locations_incomplete",
        ]);
    });

    it("warns when PDF anchors exist but precise handwriting regions are incomplete", () => {
        const summary = validateExamDraft({
            title: "PDF 위치만 연결된 시험",
            questions: [
                {
                    id: 1,
                    number: 1,
                    answer: 2,
                    label: "문법",
                    pdfLocation: { page: 1, x: 0.2, y: 0.3 },
                },
                {
                    id: 2,
                    number: 2,
                    answer: 4,
                    label: "문학",
                    pdfLocation: { page: 1, x: 0.2, y: 0.6 },
                    pdfRegion: { page: 1, x: 0.12, y: 0.5, width: 0.72, height: 0.18 },
                },
            ],
            hasProblemPdf: true,
        });

        expect(summary.isPublishable).toBe(true);
        expect(summary).toMatchObject({
            pdfLinkedCount: 2,
            pdfRegionCount: 1,
        });
        expect(summary.warnings).toContainEqual(expect.objectContaining({
            code: "pdf_regions_incomplete",
            questionIds: [1],
        }));
    });
});
