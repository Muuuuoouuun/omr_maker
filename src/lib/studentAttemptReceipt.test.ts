import { describe, expect, it } from "vitest";
import { getAttemptQuestionResults } from "@/lib/premiumAnalytics";
import type { ServerGradedAttemptReceipt } from "@/lib/studentExamContract";
import type { Attempt, Exam } from "@/types/omr";
import { localResultCacheFromServerReceipt } from "./studentAttemptReceipt";

const receipt: ServerGradedAttemptReceipt = {
    attemptId: "attempt-ticket-1",
    examId: "exam-1",
    score: 5,
    totalScore: 10,
    correctCount: 1,
    incorrectCount: 1,
    unansweredCount: 0,
    ungradedCount: 0,
    finishedAt: "2026-07-14T01:00:00.000Z",
    questionResults: [
        { questionId: 1, questionNumber: 1, selectedAnswer: 3, score: 5, earnedScore: 5, status: "correct" },
        { questionId: 2, questionNumber: 2, selectedAnswer: 2, score: 5, earnedScore: 0, status: "wrong" },
    ],
};

describe("student attempt receipt cache", () => {
    it("caches only server-authoritative selections and grading without an answer key", () => {
        const cached = localResultCacheFromServerReceipt(receipt, {
            examTitle: "학생용 시험",
            studentName: "학생 1",
            studentId: "student-1",
            identityType: "registered",
        });
        expect(cached.answers).toEqual({ 1: 3, 2: 2 });
        expect(cached.questionResults.map(result => ({
            questionId: result.questionId,
            status: result.status,
            score: result.score,
            earnedScore: result.earnedScore,
        }))).toEqual([
            { questionId: 1, status: "correct", score: 5, earnedScore: 5 },
            { questionId: 2, status: "wrong", score: 5, earnedScore: 0 },
        ]);
        expect(JSON.stringify(cached)).not.toContain("correctAnswer");
    });

    it("keeps official statuses when review uses an answer-key-free student exam", () => {
        const safeExam: Exam = {
            id: "exam-1",
            title: "학생용 시험",
            createdAt: "2026-07-14T00:00:00.000Z",
            questions: [
                { id: 1, number: 1, choices: 5 },
                { id: 2, number: 2, choices: 4 },
            ],
        };
        const cached = localResultCacheFromServerReceipt(receipt, {
            examTitle: safeExam.title,
            studentName: "학생 1",
            studentId: "student-1",
            identityType: "registered",
        });
        const attempt: Attempt = {
            id: receipt.attemptId,
            examId: receipt.examId,
            examTitle: safeExam.title,
            studentName: "학생 1",
            studentId: "student-1",
            identityType: "registered",
            startedAt: "2026-07-14T00:00:00.000Z",
            finishedAt: receipt.finishedAt,
            score: receipt.score,
            totalScore: receipt.totalScore,
            answers: cached.answers,
            questionResults: cached.questionResults,
            status: "completed",
        };

        expect(getAttemptQuestionResults(safeExam, attempt).map(result => ({
            status: result.status,
            score: result.score,
            earnedScore: result.earnedScore,
            correctAnswer: result.correctAnswer,
        }))).toEqual([
            { status: "correct", score: 5, earnedScore: 5, correctAnswer: undefined },
            { status: "wrong", score: 5, earnedScore: 0, correctAnswer: undefined },
        ]);
    });
});
