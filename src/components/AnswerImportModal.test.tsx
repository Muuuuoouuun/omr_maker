import { describe, expect, it } from "vitest";
import { takeSelectedAnswerPdf, validateImportedAnswers } from "./AnswerImportModal";

describe("AnswerImportModal file input", () => {
    it("clears the native input after taking a file so the same PDF can be selected again", () => {
        const file = new File(["pdf"], "answers.pdf", { type: "application/pdf" });
        const input = {
            files: [file] as unknown as FileList,
            value: "/fake/path/answers.pdf",
        };

        expect(takeSelectedAnswerPdf(input)).toBe(file);
        expect(input.value).toBe("");
    });

    it("blocks applying a partial answer key that would preserve stale answers", () => {
        const parsed = [
            { questionNum: 1, answer: 2, confidence: 0.99, rawText: "1 ②" },
            { questionNum: 2, answer: 4, confidence: 0.99, rawText: "2 ④" },
        ];

        expect(validateImportedAnswers(3, parsed, new Set())).toContain("3번");
        expect(validateImportedAnswers(2, parsed, new Set())).toBeNull();
    });
});
