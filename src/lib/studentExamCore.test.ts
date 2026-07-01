import { describe, expect, it } from "vitest";
import { attemptOwnedBy, buildServerAttempt, identityAccessSession, type SubmitAttemptInput } from "./studentExamCore";
import type { Exam } from "@/types/omr";
import type { StudentServerIdentity } from "./studentServerSession";

const EXAM: Exam = {
    id: "e1", title: "기말", createdAt: "2026-07-01T00:00:00.000Z", organizationId: "teacher_abc",
    questions: [
        { id: 1, number: 1, answer: 3, choices: 5, score: 10 },
        { id: 2, number: 2, answer: 2, choices: 5, score: 10 },
    ],
};
const GUEST: StudentServerIdentity = {
    kind: "guest", guestId: "g1", name: "Guest Student", identityType: "guest",
    issuedAt: 0, expiresAt: 9e15,
};
const INPUT: SubmitAttemptInput = { examId: "e1", answers: { 1: 3, 2: 4 }, startedAt: "2026-07-01T01:00:00.000Z" };

describe("studentExamCore", () => {
    it("server-grades and injects owner/org, ignoring any client score", () => {
        const attempt = buildServerAttempt(INPUT, EXAM, GUEST, "att1", "2026-07-01T01:30:00.000Z");
        expect(attempt.score).toBe(10);       // only q1 correct
        expect(attempt.totalScore).toBe(20);
        expect(attempt.organizationId).toBe("teacher_abc");
        expect(attempt.studentId).toBe("guest:g1");
        expect(attempt.guestId).toBe("g1");
        expect(attempt.identityType).toBe("guest");
        expect(attempt.questionResults).toHaveLength(2);
        expect(attempt.questionResults?.[0]).toMatchObject({ questionId: 1, isCorrect: true });
    });

    it("attemptOwnedBy matches guest by guestId and student by studentId", () => {
        expect(attemptOwnedBy({ studentId: "guest:g1", guestId: "g1" }, GUEST)).toBe(true);
        expect(attemptOwnedBy({ studentId: "guest:g2", guestId: "g2" }, GUEST)).toBe(false);
        const student: StudentServerIdentity = { kind: "student", studentId: "grp1::김", name: "김", identityType: "temporary", issuedAt: 0, expiresAt: 9e15 };
        expect(attemptOwnedBy({ studentId: "grp1::김" }, student)).toBe(true);
        expect(attemptOwnedBy({ studentId: "grp1::이" }, student)).toBe(false);
    });

    it("maps identity to an ExamAccessSession for evaluateExamAccess", () => {
        expect(identityAccessSession(GUEST)).toMatchObject({ isGuest: true, identityType: "guest" });
    });
});
