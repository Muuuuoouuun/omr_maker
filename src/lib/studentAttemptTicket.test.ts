import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import {
    STUDENT_ATTEMPT_TICKET_TTL_MS,
    createStudentAttemptTicket,
    parseStudentAttemptTicket,
    resolveStudentAttemptSecret,
} from "./studentAttemptTicket";

const env = {
    NODE_ENV: "production",
    STUDENT_ATTEMPT_SECRET: "student-attempt-secret-at-least-32-bytes",
};
const ticketId = "00000000-0000-4000-8000-000000000001";
const futureTicketId = "00000000-0000-4000-8000-000000000002";

function resignClaims(claims: Record<string, unknown>): string {
    const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
    const signature = createHmac("sha256", env.STUDENT_ATTEMPT_SECRET)
        .update(payload, "utf8")
        .digest("base64url");
    return `${payload}.${signature}`;
}

describe("student attempt ticket", () => {
    it("requires an explicit production secret", () => {
        expect(resolveStudentAttemptSecret({ NODE_ENV: "production" })).toBeNull();
        expect(resolveStudentAttemptSecret({
            NODE_ENV: "production",
            STUDENT_ATTEMPT_SECRET: "short-attempt-secret",
        })).toBeNull();
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
            schemaVersion: 2,
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
        expect(parseStudentAttemptTicket(ticket, {
            ...env,
            STUDENT_ATTEMPT_SECRET: "wrong-attempt-secret-at-least-32-bytes",
        }, 1_000)).toBeNull();
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

    it("does not mint half-retake capabilities and bounds raw ticket parsing", () => {
        const base = { examId: "exam-1", organizationId: "org-1", studentId: "student-1", studentName: "학생", identityType: "registered" as const, allowedQuestionIds: [1] };
        expect(createStudentAttemptTicket({ ...base, retakeSourceAttemptId: "source-1" }, env)).toBeNull();
        expect(createStudentAttemptTicket({ ...base, retakeMode: "wrong" }, env)).toBeNull();
        expect(parseStudentAttemptTicket("x".repeat(32_769), env)).toBeNull();
    });

    it("binds targeted tickets to an exact assignment revision and rejects legacy assignment-only claims", () => {
        const base = {
            examId: "exam-1",
            organizationId: "org-1",
            studentId: "student-1",
            studentName: "학생",
            identityType: "registered" as const,
            allowedQuestionIds: [1],
            assignmentId: "assignment-reused",
        };
        expect(createStudentAttemptTicket(base, env, 1_000, ticketId)).toBeNull();
        const ticket = createStudentAttemptTicket({ ...base, assignmentRevision: 8 }, env, 1_000, ticketId);
        expect(parseStudentAttemptTicket(ticket, env, 1_000)).toMatchObject({
            assignmentId: "assignment-reused",
            assignmentRevision: 8,
        });
        expect(parseStudentAttemptTicket(resignClaims({
            schemaVersion: 1,
            audience: "omr-attempt",
            ticketId,
            examId: "exam-1",
            organizationId: "org-1",
            assignmentId: "assignment-reused",
            studentId: "student-1",
            studentName: "학생",
            identityType: "registered",
            allowedQuestionIds: [1],
            issuedAt: 1_000,
            expiresAt: 1_000 + STUDENT_ATTEMPT_TICKET_TTL_MS,
        }), env, 1_000)).toBeNull();
    });

    it.each([
        [{ retakeSourceAttemptId: "source-1" }],
        [{ retakeMode: "wrong" }],
        [{ retakeSourceAttemptId: "source-1", retakeMode: "forged" }],
    ])("rejects a signed malformed retake capability", extra => {
        const malformed = resignClaims({
            schemaVersion: 1,
            audience: "omr-attempt",
            ticketId,
            examId: "exam-1",
            organizationId: "org-1",
            studentId: "student-1",
            studentName: "학생 1",
            identityType: "registered",
            allowedQuestionIds: [1],
            issuedAt: 1_000,
            expiresAt: 1_000 + STUDENT_ATTEMPT_TICKET_TTL_MS,
            ...extra,
        });
        expect(parseStudentAttemptTicket(malformed, env, 1_000)).toBeNull();
    });
});
