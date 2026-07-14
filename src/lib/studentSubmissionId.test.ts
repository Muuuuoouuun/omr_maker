import { describe, expect, it } from "vitest";
import { attemptIdForStudentSubmission } from "./studentSubmissionId";

const BASE = {
    submissionId: "550e8400-e29b-41d4-a716-446655440000",
    examId: "exam-a",
    ownerStudentId: "student-a",
    secret: "server-secret",
};

describe("student submission id", () => {
    it("is deterministic for retries and uses a UUID-shaped opaque id", () => {
        const first = attemptIdForStudentSubmission(BASE);
        const retry = attemptIdForStudentSubmission(BASE);
        expect(retry).toBe(first);
        expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it("binds the id to the owner, exam, and server secret", () => {
        const original = attemptIdForStudentSubmission(BASE);
        expect(attemptIdForStudentSubmission({ ...BASE, ownerStudentId: "student-b" })).not.toBe(original);
        expect(attemptIdForStudentSubmission({ ...BASE, examId: "exam-b" })).not.toBe(original);
        expect(attemptIdForStudentSubmission({ ...BASE, secret: "other-secret" })).not.toBe(original);
    });

    it("rejects malformed or incomplete retry tokens", () => {
        expect(attemptIdForStudentSubmission({ ...BASE, submissionId: "guessable" })).toBeNull();
        expect(attemptIdForStudentSubmission({ ...BASE, ownerStudentId: "" })).toBeNull();
    });
});
