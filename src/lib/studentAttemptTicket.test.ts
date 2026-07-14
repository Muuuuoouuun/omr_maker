import { describe, expect, it } from "vitest";
import {
    STUDENT_ATTEMPT_TICKET_TTL_MS,
    createStudentAttemptTicket,
    parseStudentAttemptTicket,
    resolveStudentAttemptSecret,
} from "./studentAttemptTicket";

const env = { NODE_ENV: "production", STUDENT_ATTEMPT_SECRET: "test-student-secret" };
const ticketId = "00000000-0000-4000-8000-000000000001";
const futureTicketId = "00000000-0000-4000-8000-000000000002";

describe("student attempt ticket", () => {
    it("requires an explicit production secret", () => {
        expect(resolveStudentAttemptSecret({ NODE_ENV: "production" })).toBeNull();
        expect(resolveStudentAttemptSecret({ NODE_ENV: "development" })).toBe("dev-student-attempt-secret");
    });

    it("signs normalized exam, student, organization, and question claims", () => {
        const ticket = createStudentAttemptTicket({
            examId: " exam-1 ",
            organizationId: " org-1 ",
            studentId: " student-1 ",
            studentName: " 학생 1 ",
            identityType: "registered",
            allowedQuestionIds: [2, 1, 2, 0, -1],
        }, env, 1_000, ticketId);

        expect(parseStudentAttemptTicket(ticket, env, 1_000)).toEqual({
            schemaVersion: 1,
            audience: "omr-attempt",
            ticketId,
            examId: "exam-1",
            organizationId: "org-1",
            studentId: "student-1",
            studentName: "학생 1",
            identityType: "registered",
            allowedQuestionIds: [1, 2],
            issuedAt: 1_000,
            expiresAt: 1_000 + STUDENT_ATTEMPT_TICKET_TTL_MS,
        });
    });

    it("rejects tampering, a wrong secret, and expiry", () => {
        const ticket = createStudentAttemptTicket({
            examId: "exam-1",
            organizationId: "org-1",
            studentId: "student-1",
            studentName: "학생 1",
            identityType: "registered",
            allowedQuestionIds: [1],
        }, env, 1_000, ticketId);
        expect(ticket).toBeTruthy();
        const [payload, signature] = ticket!.split(".");

        expect(parseStudentAttemptTicket(`${payload}x.${signature}`, env, 1_000)).toBeNull();
        expect(parseStudentAttemptTicket(ticket, { ...env, STUDENT_ATTEMPT_SECRET: "wrong" }, 1_000)).toBeNull();
        expect(parseStudentAttemptTicket(ticket, env, 1_000 + STUDENT_ATTEMPT_TICKET_TTL_MS)).toBeNull();
    });

    it("rejects tickets issued too far in the future", () => {
        const ticket = createStudentAttemptTicket({
            examId: "exam-1",
            organizationId: "org-1",
            studentId: "student-1",
            studentName: "학생 1",
            identityType: "registered",
            allowedQuestionIds: [1],
        }, env, 100_000, futureTicketId);

        expect(parseStudentAttemptTicket(ticket, env, 1_000)).toBeNull();
    });

    it("does not mint tickets with missing identity or allowed questions", () => {
        expect(createStudentAttemptTicket({ examId: "exam-1", organizationId: "org-1", studentId: "", studentName: "학생", identityType: "registered", allowedQuestionIds: [1] }, env)).toBeNull();
        expect(createStudentAttemptTicket({ examId: "exam-1", organizationId: "org-1", studentId: "student-1", studentName: "학생", identityType: "registered", allowedQuestionIds: [] }, env)).toBeNull();
    });
});
