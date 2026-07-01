import { describe, expect, it } from "vitest";
import { stripExamForSolving } from "./examSolvePayload";
import type { Exam } from "@/types/omr";

const EXAM: Exam = {
    id: "e1", title: "기말고사", createdAt: "2026-07-01T00:00:00.000Z",
    answerKeyPdf: "data:application/pdf;base64,AAAA",
    answerKeyPdfRef: { store: "indexeddb", key: "ans-e1" },
    accessConfig: { type: "public", pin: "1234" },
    questions: [
        { id: 1, number: 1, answer: 3, choices: 5, score: 10 },
        { id: 2, number: 2, answer: 1, choices: 4 },
    ],
};

describe("stripExamForSolving", () => {
    it("removes every question answer but keeps display fields", () => {
        const solvable = stripExamForSolving(EXAM);
        expect(solvable.questions).toHaveLength(2);
        for (const q of solvable.questions) {
            expect("answer" in q).toBe(false);
        }
        expect(solvable.questions[0]).toMatchObject({ id: 1, number: 1, choices: 5, score: 10 });
    });

    it("removes the answer key PDF and inline pin, exposing only hasPin", () => {
        const solvable = stripExamForSolving(EXAM);
        expect(solvable.answerKeyPdf).toBeUndefined();
        expect(solvable.answerKeyPdfRef).toBeUndefined();
        expect(solvable.accessConfig).toEqual({ type: "public", groupIds: undefined, hasPin: true });
        expect(JSON.stringify(solvable)).not.toContain("1234");
    });

    it("reports hasPin false when no pin is set", () => {
        const solvable = stripExamForSolving({ ...EXAM, accessConfig: { type: "group", groupIds: ["g1"] } });
        expect(solvable.accessConfig).toEqual({ type: "group", groupIds: ["g1"], hasPin: false });
    });

    it("strips the teacher explanation (it can reveal the answer)", () => {
        const solvable = stripExamForSolving({
            ...EXAM,
            questions: [{ id: 1, number: 1, answer: 3, choices: 5, score: 10, explanation: "정답은 3번" }],
        });
        expect("explanation" in solvable.questions[0]).toBe(false);
        expect(JSON.stringify(solvable)).not.toContain("정답은 3번");
    });
});
