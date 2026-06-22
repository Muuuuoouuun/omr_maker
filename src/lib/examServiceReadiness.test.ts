import { describe, expect, it } from "vitest";
import type { Question } from "@/types/omr";
import { validateExamDraft } from "./examValidation";
import { buildExamServiceReadiness } from "./examServiceReadiness";

const completeQuestions: Question[] = [
    {
        id: 1,
        number: 1,
        answer: 2,
        choices: 5,
        score: 5,
        label: "문법",
        tags: { concept: "높임 표현" },
        pdfRegion: { page: 1, x: 0.1, y: 0.1, width: 0.7, height: 0.18 },
    },
    {
        id: 2,
        number: 2,
        answer: 5,
        choices: 5,
        score: 5,
        label: "독해",
        tags: { concept: "중심 내용" },
        pdfRegion: { page: 1, x: 0.1, y: 0.35, width: 0.7, height: 0.18 },
    },
];

function readiness(params: {
    title?: string;
    questions?: Question[];
    hasProblemPdf?: boolean;
    hasAnswerKeyPdf?: boolean;
    accessConfig?: Parameters<typeof buildExamServiceReadiness>[0]["accessConfig"];
}) {
    const title = params.title ?? "6월 중간";
    const questions = params.questions ?? completeQuestions;
    const validation = validateExamDraft({
        title,
        questions,
        durationMin: 50,
        hasProblemPdf: params.hasProblemPdf ?? true,
        accessConfig: params.accessConfig,
    });
    return buildExamServiceReadiness({
        title,
        validation,
        hasProblemPdf: params.hasProblemPdf ?? true,
        hasAnswerKeyPdf: params.hasAnswerKeyPdf ?? false,
        accessConfig: params.accessConfig,
    });
}

describe("exam service readiness", () => {
    it("marks a complete public exam as service-publishable", () => {
        const summary = readiness({
            hasAnswerKeyPdf: true,
            accessConfig: { type: "public", pin: "1234" },
        });

        expect(summary).toMatchObject({
            level: "ready",
            label: "서비스 배포 가능",
            canSaveDraft: true,
            canOpenDistribution: true,
            canPublish: true,
        });
        expect(summary.items.map(item => [item.key, item.status])).toEqual([
            ["draft", "ready"],
            ["answers", "ready"],
            ["problem_pdf", "ready"],
            ["answer_pdf", "ready"],
            ["pdf_regions", "ready"],
            ["metadata", "ready"],
            ["distribution", "ready"],
        ]);
    });

    it("lets teachers open distribution when only service-quality warnings remain", () => {
        const summary = readiness({
            hasProblemPdf: false,
            questions: [
                { id: 1, number: 1, answer: 5 },
            ],
        });

        expect(summary.level).toBe("warning");
        expect(summary.canSaveDraft).toBe(true);
        expect(summary.canOpenDistribution).toBe(true);
        expect(summary.canPublish).toBe(false);
        expect(summary.items.find(item => item.key === "problem_pdf")).toMatchObject({
            status: "warning",
            value: "미연결",
        });
        expect(summary.items.find(item => item.key === "distribution")).toMatchObject({
            status: "warning",
            value: "선택 대기",
        });
    });

    it("blocks distribution when required answer data is invalid", () => {
        const summary = readiness({
            title: "A",
            questions: [
                { id: 1, number: 1, choices: 4 },
                { id: 2, number: 2, answer: 5, choices: 4 },
            ],
            accessConfig: { type: "public" },
        });

        expect(summary.level).toBe("blocked");
        expect(summary.canSaveDraft).toBe(false);
        expect(summary.canOpenDistribution).toBe(false);
        expect(summary.canPublish).toBe(false);
        expect(summary.items.find(item => item.key === "answers")).toMatchObject({
            status: "blocked",
            value: "1/2",
        });
    });

    it("blocks distribution when question numbers cannot support stable OMR mapping", () => {
        const summary = readiness({
            questions: [
                { id: 1, number: 1, answer: 1 },
                { id: 2, number: 1, answer: 2 },
            ],
            accessConfig: { type: "public" },
        });

        expect(summary.level).toBe("blocked");
        expect(summary.canSaveDraft).toBe(false);
        expect(summary.canOpenDistribution).toBe(false);
        expect(summary.canPublish).toBe(false);
        expect(summary.blockingIssues).toContainEqual(expect.objectContaining({
            code: "duplicate_question_numbers",
            questionIds: [1, 2],
        }));
        expect(summary.items.find(item => item.key === "draft")).toMatchObject({
            status: "blocked",
            message: "시험 제목, 문항 수, 문항 ID/번호를 먼저 정리해야 합니다.",
        });
    });

    it("blocks publish when a configured distribution target is invalid", () => {
        const summary = readiness({
            accessConfig: { type: "group", groupIds: [] },
        });

        expect(summary.level).toBe("blocked");
        expect(summary.canOpenDistribution).toBe(false);
        expect(summary.canPublish).toBe(false);
        expect(summary.items.find(item => item.key === "distribution")).toMatchObject({
            status: "blocked",
            value: "0개 그룹",
        });
    });
});
