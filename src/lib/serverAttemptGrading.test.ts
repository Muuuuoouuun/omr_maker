import { describe, expect, it } from "vitest";
import type { StudentAttemptTicketClaims } from "./studentAttemptTicket";
import type { Attempt, Exam } from "@/types/omr";
import {
    gradeStudentAttemptOnServer,
    gradeTeacherForcedAttemptOnServer,
} from "./serverAttemptGrading";

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
    schemaVersion: 2,
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

    it("recomputes a stale teacher force-finish score and grades missing answers as unanswered", () => {
        const staleAttempt: Attempt = {
            id: "attempt-live-1",
            examId: exam.id,
            examTitle: exam.title,
            organizationId: "org-1",
            classId: "class-1",
            studentName: "학생 1",
            studentId: "student-1",
            startedAt: "2026-07-14T00:00:00.000Z",
            finishedAt: "2026-07-14T00:00:00.000Z",
            score: 999,
            totalScore: 999,
            answers: { 1: 3 },
            status: "in_progress",
            questionResults: [],
        };

        const result = gradeTeacherForcedAttemptOnServer(
            exam,
            staleAttempt,
            "2026-07-14T00:10:00.000Z",
        );

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.attempt).toMatchObject({
            id: "attempt-live-1",
            classId: "class-1",
            status: "completed",
            autoSubmitted: true,
            finishedAt: "2026-07-14T00:10:00.000Z",
            score: 5,
            totalScore: 10,
        });
        expect(result.attempt.questionResults?.map(row => ({
            questionId: row.questionId,
            status: row.status,
            earnedScore: row.earnedScore,
        }))).toEqual([
            { questionId: 1, status: "correct", earnedScore: 5 },
            { questionId: 2, status: "unanswered", earnedScore: 0 },
            { questionId: 3, status: "ungraded", earnedScore: 0 },
        ]);
    });

    it("returns an already completed attempt unchanged on an idempotent force-finish retry", () => {
        const completed: Attempt = {
            id: "attempt-live-2",
            examId: exam.id,
            examTitle: exam.title,
            organizationId: "org-1",
            studentName: "학생 2",
            startedAt: "2026-07-14T00:00:00.000Z",
            finishedAt: "2026-07-14T00:05:00.000Z",
            score: 5,
            totalScore: 10,
            answers: { 1: 3 },
            status: "completed",
            autoSubmitted: true,
            questionResults: [{
                questionId: 1,
                status: "correct",
            } as NonNullable<Attempt["questionResults"]>[number]],
        };

        const result = gradeTeacherForcedAttemptOnServer(
            exam,
            completed,
            "2026-07-14T00:20:00.000Z",
        );

        expect(result).toEqual({ ok: true, attempt: completed });
    });

    it("returns a completed retake unchanged before validating the current exam scope", () => {
        const completed: Attempt = {
            id: "attempt-retake-completed",
            examId: exam.id,
            examTitle: exam.title,
            organizationId: "org-1",
            studentName: "학생 2",
            startedAt: "2026-07-14T00:00:00.000Z",
            finishedAt: "2026-07-14T00:05:00.000Z",
            score: 5,
            totalScore: 5,
            answers: { 2: 1 },
            status: "completed",
            autoSubmitted: true,
            retake: {
                sourceAttemptId: "attempt-source",
                questionIds: [2],
                mode: "wrong",
                createdAt: "2026-07-14T00:00:00.000Z",
            },
            questionResults: [{
                questionId: 2,
                status: "correct",
                earnedScore: 5,
            } as NonNullable<Attempt["questionResults"]>[number]],
        };
        const revisedExam = {
            ...exam,
            questions: exam.questions.filter(question => question.id !== 2),
        };

        expect(gradeTeacherForcedAttemptOnServer(
            revisedExam,
            completed,
            "2026-07-14T00:20:00.000Z",
        )).toEqual({ ok: true, attempt: completed });
        expect(gradeTeacherForcedAttemptOnServer(
            revisedExam,
            { ...completed, status: "in_progress" },
            "2026-07-14T00:20:00.000Z",
        )).toEqual({ ok: false, error: "invalid_retake_scope" });
    });

    it("fails closed when stored answers are outside the canonical exam scope or choice range", () => {
        const base: Attempt = {
            id: "attempt-live-3",
            examId: exam.id,
            examTitle: exam.title,
            organizationId: "org-1",
            studentName: "학생 3",
            startedAt: "2026-07-14T00:00:00.000Z",
            finishedAt: "2026-07-14T00:00:00.000Z",
            score: 0,
            totalScore: 0,
            answers: { 99: 1 },
            status: "in_progress",
        };
        expect(gradeTeacherForcedAttemptOnServer(exam, base, "2026-07-14T00:10:00.000Z"))
            .toEqual({ ok: false, error: "unexpected_question" });
        expect(gradeTeacherForcedAttemptOnServer(
            exam,
            { ...base, answers: { 2: 5 } },
            "2026-07-14T00:10:00.000Z",
        )).toEqual({ ok: false, error: "invalid_answer" });
    });

    it.each([
        { label: "all unknown", questionIds: [999] },
        { label: "partially unknown", questionIds: [1, 999] },
        { label: "duplicate", questionIds: [1, 1] },
    ])("rejects a $label retake scope before force-finish grading", ({ questionIds }) => {
        const retakeAttempt: Attempt = {
            id: "attempt-retake-invalid",
            examId: exam.id,
            examTitle: exam.title,
            organizationId: "org-1",
            studentName: "학생",
            startedAt: "2026-07-14T00:00:00.000Z",
            finishedAt: "2026-07-14T00:00:00.000Z",
            score: 0,
            totalScore: 0,
            answers: {},
            status: "in_progress",
            retake: {
                sourceAttemptId: "attempt-source",
                questionIds,
                mode: "wrong",
                createdAt: "2026-07-14T00:00:00.000Z",
            },
        };

        expect(gradeTeacherForcedAttemptOnServer(
            exam,
            retakeAttempt,
            "2026-07-14T00:10:00.000Z",
        )).toEqual({ ok: false, error: "invalid_retake_scope" });
    });

    it("keeps canonical exam ordering for a valid retake scope", () => {
        const retakeAttempt: Attempt = {
            id: "attempt-retake-valid",
            examId: exam.id,
            examTitle: exam.title,
            organizationId: "org-1",
            studentName: "학생",
            startedAt: "2026-07-14T00:00:00.000Z",
            finishedAt: "2026-07-14T00:00:00.000Z",
            score: 0,
            totalScore: 0,
            answers: { 1: 3, 2: 1 },
            status: "in_progress",
            retake: {
                sourceAttemptId: "attempt-source",
                questionIds: [2, 1],
                mode: "wrong",
                createdAt: "2026-07-14T00:00:00.000Z",
            },
        };

        const result = gradeTeacherForcedAttemptOnServer(
            exam,
            retakeAttempt,
            "2026-07-14T00:10:00.000Z",
        );
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.attempt.questionResults?.map(row => row.questionId)).toEqual([1, 2]);
    });
});
