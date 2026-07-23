import { describe, expect, it } from "vitest";
import { stripExamForAttemptReview, stripExamForReview, stripExamForSolving } from "./examSolvePayload";
import type { Attempt, Exam } from "@/types/omr";

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

    it("strips teacher-only sub-question guidance from solve payload", () => {
        const solvable = stripExamForSolving({
            ...EXAM,
            questions: [{ id: 1, number: 1, answer: 3, subQuestions: [{
                schemaVersion: 1,
                id: "reason",
                prompt: "왜 골랐나요?",
                kind: "free_text",
                answerGuide: "정답 근거",
                teacherNote: "교사용 메모",
            }] }],
        });
        expect(solvable.questions[0].subQuestions?.[0]).toMatchObject({ prompt: "왜 골랐나요?" });
        expect(JSON.stringify(solvable)).not.toContain("정답 근거");
        expect(JSON.stringify(solvable)).not.toContain("교사용 메모");
    });
});

describe("stripExamForReview", () => {
    it("keeps answers and explanations for the post-submit review", () => {
        const reviewable = stripExamForReview({
            ...EXAM,
            questions: [{ id: 1, number: 1, answer: 3, choices: 5, score: 10, explanation: "정답은 3번" }],
        });
        expect(reviewable.questions[0]).toMatchObject({ answer: 3, explanation: "정답은 3번" });
    });

    it("still withholds the inline PIN and the answer-key PDF", () => {
        const reviewable = stripExamForReview(EXAM);
        expect(reviewable.answerKeyPdf).toBeUndefined();
        expect(reviewable.answerKeyPdfRef).toBeUndefined();
        expect(reviewable.accessConfig).toEqual({ type: "public", groupIds: undefined, hasPin: true });
        expect(JSON.stringify(reviewable)).not.toContain("1234");
    });

    it("keeps the problem PDF payload so review can render it", () => {
        const reviewable = stripExamForReview({ ...EXAM, pdfData: "data:application/pdf;base64,BBBB" });
        expect(reviewable.pdfData).toBe("data:application/pdf;base64,BBBB");
    });

    it("keeps student prompts but strips teacher-only guidance from review payload", () => {
        const reviewable = stripExamForReview({
            ...EXAM,
            questions: [{ id: 1, number: 1, answer: 3, subQuestions: [{
                schemaVersion: 1,
                id: "reason",
                prompt: "왜 골랐나요?",
                kind: "free_text",
                answerGuide: "정답 근거",
            }] }],
        });
        expect(reviewable.questions[0].subQuestions?.[0].prompt).toBe("왜 골랐나요?");
        expect(JSON.stringify(reviewable)).not.toContain("정답 근거");
    });
});

describe("stripExamForAttemptReview", () => {
    it("reveals answers only for questions issued in the completed attempt", () => {
        const attempt = {
            id: "attempt-1",
            examId: EXAM.id,
            examTitle: EXAM.title,
            studentName: "학생",
            startedAt: "2026-07-01T00:00:00.000Z",
            finishedAt: "2026-07-01T01:00:00.000Z",
            score: 10,
            totalScore: 10,
            answers: { 1: 3 },
            status: "completed",
            questionResults: [{
                schemaVersion: 1,
                attemptId: "attempt-1",
                examId: EXAM.id,
                examTitle: EXAM.title,
                studentName: "학생",
                questionId: 1,
                questionNumber: 1,
                score: 10,
                earnedScore: 10,
                selectedAnswer: 3,
                correctAnswer: 3,
                status: "correct",
                isCorrect: true,
                isWrong: false,
                isUnanswered: false,
                finishedAt: "2026-07-01T01:00:00.000Z",
            }],
        } as Attempt;

        const reviewable = stripExamForAttemptReview(EXAM, attempt);

        expect(reviewable.questions.map(question => question.id)).toEqual([1]);
        expect(JSON.stringify(reviewable)).not.toContain('"id":2');
    });
});
