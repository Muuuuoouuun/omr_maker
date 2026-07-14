import { describe, expect, it } from "vitest";
import type { StudentAttemptTicketClaims } from "./studentAttemptTicket";
import type { Exam } from "@/types/omr";
import { gradeStudentAttemptOnServer } from "./serverAttemptGrading";

const exam: Exam = {
    id: "exam-1",
    title: "서버 채점 시험",
    organizationId: "org-1",
    createdAt: "2026-07-14T00:00:00.000Z",
    durationMin: 60,
    questions: [
        { id: 1, number: 1, answer: 3, score: 5, choices: 5 },
        { id: 2, number: 2, answer: 1, score: 5, choices: 4 },
        { id: 3, number: 3, choices: 4 },
    ],
};

const ticket: StudentAttemptTicketClaims = {
    schemaVersion: 1,
    audience: "omr-attempt",
    ticketId: "ticket-1",
    examId: "exam-1",
    organizationId: "org-1",
    studentId: "student-1",
    studentName: "학생 1",
    identityType: "registered",
    allowedQuestionIds: [1, 2, 3],
    issuedAt: 1_000,
    expiresAt: 1_000 + 12 * 60 * 60 * 1000,
};

describe("server attempt grading", () => {
    it("derives the official score and result rows only from the canonical exam", () => {
        const result = gradeStudentAttemptOnServer(exam, ticket, {
            ticket: "signed-ticket",
            answers: { 1: 3, 2: 2, 3: 4 },
            autoSubmitted: false,
        }, 2_000);

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.receipt).toMatchObject({
            attemptId: "attempt_ticket-1",
            score: 5,
            totalScore: 10,
            correctCount: 1,
            incorrectCount: 1,
            ungradedCount: 1,
            questionResults: [
                { questionId: 1, selectedAnswer: 3, status: "correct", earnedScore: 5 },
                { questionId: 2, selectedAnswer: 2, status: "wrong", earnedScore: 0 },
                { questionId: 3, selectedAnswer: 4, status: "ungraded", earnedScore: 0 },
            ],
        });
        expect(result.attempt.questionResults).toHaveLength(3);
        expect(result.attempt.questionResults?.map(row => row.status)).toEqual(["correct", "wrong", "ungraded"]);
        expect(JSON.stringify(result.receipt)).not.toContain("correctAnswer");
        expect(JSON.stringify(result.receipt)).not.toContain("비밀");
    });

    it("uses the ticket id as an idempotent attempt id", () => {
        const first = gradeStudentAttemptOnServer(exam, ticket, { ticket: "one", answers: { 1: 3 } }, 2_000);
        const retry = gradeStudentAttemptOnServer(exam, ticket, { ticket: "two", answers: { 1: 3 } }, 2_100);
        expect(first.ok && first.attempt.id).toBe("attempt_ticket-1");
        expect(retry.ok && retry.attempt.id).toBe("attempt_ticket-1");
    });

    it("rejects answers for unissued questions and invalid choices", () => {
        expect(gradeStudentAttemptOnServer(exam, ticket, {
            ticket: "signed-ticket",
            answers: { 99: 1 },
        }, 2_000)).toEqual({ ok: false, error: "unexpected_question" });
        expect(gradeStudentAttemptOnServer(exam, ticket, {
            ticket: "signed-ticket",
            answers: { 2: 5 },
        }, 2_000)).toEqual({ ok: false, error: "invalid_answer" });
    });

    it("rejects exam, organization, archive, and timing boundary violations", () => {
        expect(gradeStudentAttemptOnServer({ ...exam, id: "other" }, ticket, { ticket: "x", answers: {} }, 2_000))
            .toEqual({ ok: false, error: "ticket_exam_mismatch" });
        expect(gradeStudentAttemptOnServer({ ...exam, organizationId: "other" }, ticket, { ticket: "x", answers: {} }, 2_000))
            .toEqual({ ok: false, error: "ticket_organization_mismatch" });
        expect(gradeStudentAttemptOnServer({ ...exam, archived: true }, ticket, { ticket: "x", answers: {} }, 2_000))
            .toEqual({ ok: false, error: "exam_archived" });
        expect(gradeStudentAttemptOnServer({ ...exam, startAt: new Date(3_000).toISOString() }, ticket, { ticket: "x", answers: {} }, 2_000))
            .toEqual({ ok: false, error: "exam_not_started" });
        expect(gradeStudentAttemptOnServer({ ...exam, endAt: new Date(1_000).toISOString() }, ticket, { ticket: "x", answers: {} }, 32_001))
            .toEqual({ ok: false, error: "exam_ended" });
    });
});
