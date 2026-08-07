import { describe, expect, it } from "vitest";
import type { StudentAttemptTicketClaims } from "@/lib/studentAttemptTicket";
import { authorizeStudentAttemptSessionScope } from "./studentAttemptSessionAuthorization.server";

const claims: StudentAttemptTicketClaims = {
    schemaVersion: 1,
    audience: "omr-attempt",
    ticketId: "ticket-1",
    examId: "exam-1",
    organizationId: "org-1",
    assignmentId: "assignment-1",
    studentId: "student-1",
    studentName: "학생",
    identityType: "registered",
    allowedQuestionIds: [2, 3],
    retakeSourceAttemptId: "source-1",
    retakeMode: "wrong",
    issuedAt: 1_000,
    expiresAt: 2_000,
};

const base = {
    claims,
    organizationId: "org-1",
    examId: "exam-1",
    ownerStudentId: "student-1",
    identityType: "registered" as const,
};

describe("student attempt session authorization", () => {
    it.each([
        ["source", { requestedRetake: { sourceAttemptId: "forged", mode: "wrong" as const, questionIds: [2, 3] } }],
        ["mode", { requestedRetake: { sourceAttemptId: "source-1", mode: "custom" as const, questionIds: [2, 3] } }],
        ["question ids", { requestedRetake: { sourceAttemptId: "source-1", mode: "wrong" as const, questionIds: [1, 2] } }],
        ["assignment", { requestedAssignmentId: "assignment-forged" }],
    ])("rejects a forged %s", (_label, forged) => {
        expect(authorizeStudentAttemptSessionScope({ ...base, ...forged })).toEqual({ status: "denied" });
    });

    it("derives assignment and retake scope only from the signed claims", () => {
        expect(authorizeStudentAttemptSessionScope(base)).toEqual({
            status: "authorized",
            assignmentId: "assignment-1",
            retake: { sourceAttemptId: "source-1", mode: "wrong", questionIds: [2, 3] },
        });
    });
});
