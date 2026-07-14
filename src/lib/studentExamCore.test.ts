import { describe, expect, it } from "vitest";
import { attemptOwnedBy, attemptOwnerScope, buildServerAttempt, identityAccessSession, remainingSecondsWithinWindow, resolveAttemptId, resolveRetakeScope, serverStudentProfileId, type SubmitAttemptInput } from "./studentExamCore";
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

describe("remainingSecondsWithinWindow", () => {
    const NOW = Date.parse("2026-07-01T01:00:00.000Z");

    it("returns the full duration when there is no endAt", () => {
        expect(remainingSecondsWithinWindow(3000, undefined, NOW)).toBe(3000);
    });

    it("clamps to the time left until endAt when that is smaller than the duration", () => {
        // endAt is 5 minutes away but the duration budget is 50 minutes
        const endAt = new Date(NOW + 5 * 60 * 1000).toISOString();
        expect(remainingSecondsWithinWindow(50 * 60, endAt, NOW)).toBe(5 * 60);
    });

    it("keeps the duration when endAt is further away than the duration", () => {
        const endAt = new Date(NOW + 90 * 60 * 1000).toISOString();
        expect(remainingSecondsWithinWindow(50 * 60, endAt, NOW)).toBe(50 * 60);
    });

    it("returns 0 when endAt has already passed", () => {
        const endAt = new Date(NOW - 60 * 1000).toISOString();
        expect(remainingSecondsWithinWindow(50 * 60, endAt, NOW)).toBe(0);
    });

    it("never returns a negative or fractional value", () => {
        expect(remainingSecondsWithinWindow(-10, undefined, NOW)).toBe(0);
        expect(remainingSecondsWithinWindow(120.9, undefined, NOW)).toBe(120);
    });
});

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

    it("clamps a future startedAt to the server finish time", () => {
        const attempt = buildServerAttempt(
            { ...INPUT, startedAt: "2999-01-01T00:00:00.000Z" },
            EXAM, GUEST, "att-future", "2026-07-01T01:30:00.000Z",
        );
        expect(attempt.startedAt).toBe("2026-07-01T01:30:00.000Z");
    });

    it("floors an absurdly old startedAt to the exam window (duration + 5m grace)", () => {
        const attempt = buildServerAttempt(
            { ...INPUT, startedAt: "2000-01-01T00:00:00.000Z" },
            EXAM, GUEST, "att-old", "2026-07-01T01:30:00.000Z",
        );
        expect(attempt.startedAt).toBe("2026-07-01T00:35:00.000Z"); // 01:30 - 55m
    });

    it("keeps a valid startedAt within the exam window unchanged", () => {
        const attempt = buildServerAttempt(INPUT, EXAM, GUEST, "att-valid", "2026-07-01T01:30:00.000Z");
        expect(attempt.startedAt).toBe("2026-07-01T01:00:00.000Z");
    });

    it("grades a retake over the scoped questions only", () => {
        const retake = { sourceAttemptId: "base1", questionIds: [2], mode: "wrong" as const, createdAt: "2026-07-01T01:00:00.000Z" };
        const attempt = buildServerAttempt(
            { examId: "e1", answers: { 2: 2 }, startedAt: "2026-07-01T01:00:00.000Z", retake },
            EXAM, GUEST, "att-retake", "2026-07-01T01:30:00.000Z",
        );
        expect(attempt.totalScore).toBe(10);          // only q2 in scope
        expect(attempt.score).toBe(10);               // q2 correct this time
        expect(attempt.retake).toMatchObject({ sourceAttemptId: "base1", questionIds: [2], mode: "wrong" });
        expect(attempt.questionResults).toHaveLength(1);
        expect(attempt.questionResults?.[0]).toMatchObject({ questionId: 2, isCorrect: true });
    });

    it("ignores retake question ids that are not on the exam", () => {
        const scope = resolveRetakeScope(EXAM, {
            sourceAttemptId: "base1", questionIds: [2, 999], mode: "custom", createdAt: "x",
        });
        expect(scope.questions.map(q => q.id)).toEqual([2]);
        expect(scope.retake?.questionIds).toEqual([2]);
    });

    it("drops the retake only when no scoped id resolves", () => {
        expect(resolveRetakeScope(EXAM, {
            sourceAttemptId: "s", questionIds: [999], mode: "wrong", createdAt: "x",
        }).retake).toBeUndefined();
        expect(resolveRetakeScope(EXAM, undefined).questions).toHaveLength(2);
    });

    it("preserves retake metadata for a full-scope retake (grades all, still a retake)", () => {
        const scope = resolveRetakeScope(EXAM, {
            sourceAttemptId: "base1", questionIds: [1, 2], mode: "custom", createdAt: "x",
        });
        expect(scope.questions).toHaveLength(2);
        expect(scope.retake).toMatchObject({ sourceAttemptId: "base1", questionIds: [1, 2], mode: "custom" });
    });

    it("classifies a full-scope retake attempt as a retake, not a base attempt", () => {
        const attempt = buildServerAttempt(
            {
                examId: "e1",
                answers: { 1: 3, 2: 2 },
                startedAt: "2026-07-01T01:00:00.000Z",
                retake: { sourceAttemptId: "base1", questionIds: [1, 2], mode: "custom", createdAt: "x" },
            },
            EXAM, GUEST, "att-full-retake", "2026-07-01T01:30:00.000Z",
        );
        expect(attempt.retake).toMatchObject({ sourceAttemptId: "base1", questionIds: [1, 2] });
        expect(attempt.totalScore).toBe(20); // both questions graded
    });

    const ROSTER_STUDENT: StudentServerIdentity = {
        kind: "student", studentId: "sp_123", name: "김철수", identityType: "temporary",
        organizationId: "org_a", studentProfileId: "sp_123", groupId: "grp1", groupName: "1반",
        issuedAt: 0, expiresAt: 9e15,
    };
    const QUICK_STUDENT: StudentServerIdentity = {
        kind: "student", studentId: "grp1::김철수", name: "김철수", identityType: "temporary",
        organizationId: "org_a", groupId: "grp1", groupName: "1반",
        issuedAt: 0, expiresAt: 9e15,
    };

    it("serverStudentProfileId returns null for guests and unmatched quick-entry, real id for roster matches", () => {
        expect(serverStudentProfileId(GUEST)).toBeNull();
        expect(serverStudentProfileId(QUICK_STUDENT)).toBeNull();
        expect(serverStudentProfileId(ROSTER_STUDENT)).toBe("sp_123");
    });

    it("attemptOwnerScope scopes students by org but leaves guests cross-org", () => {
        expect(attemptOwnerScope(GUEST)).toEqual({ studentId: "guest:g1" });
        expect(attemptOwnerScope(ROSTER_STUDENT)).toEqual({ studentId: "sp_123", organizationId: "org_a" });
        expect(attemptOwnerScope(QUICK_STUDENT)).toEqual({ studentId: "grp1::김철수", organizationId: "org_a" });
    });

    it("buildServerAttempt writes a real profile id only for roster matches (FK-safe)", () => {
        const roster = buildServerAttempt(INPUT, EXAM, ROSTER_STUDENT, "att-r", "2026-07-01T01:30:00.000Z");
        expect(roster.studentProfileId).toBe("sp_123");
        const quick = buildServerAttempt(INPUT, EXAM, QUICK_STUDENT, "att-q", "2026-07-01T01:30:00.000Z");
        expect(quick.studentProfileId).toBeUndefined();
        const guest = buildServerAttempt(INPUT, EXAM, GUEST, "att-g", "2026-07-01T01:30:00.000Z");
        expect(guest.studentProfileId).toBeUndefined();
    });

    it("resolveAttemptId is deterministic per idempotency key and falls back to the random id", () => {
        const withKey = { examId: "e1", idempotencyKey: "k-abc" };
        const id1 = resolveAttemptId(withKey, GUEST, "random-1");
        const id2 = resolveAttemptId(withKey, GUEST, "random-2");
        expect(id1).toBe(id2);                                   // retry collapses to one id
        expect(id1).not.toBe("random-1");
        expect(id1.startsWith("att_")).toBe(true);
        // different key or different owner → different id
        expect(resolveAttemptId({ examId: "e1", idempotencyKey: "k-def" }, GUEST, "r")).not.toBe(id1);
        expect(resolveAttemptId(withKey, ROSTER_STUDENT, "r")).not.toBe(id1);
        // no key → caller's fallback id (back-compat)
        expect(resolveAttemptId({ examId: "e1" }, GUEST, "random-3")).toBe("random-3");
    });

    it("buildServerAttempt records the idempotency key on the attempt", () => {
        const attempt = buildServerAttempt({ ...INPUT, idempotencyKey: "k-1" }, EXAM, GUEST, "att-i", "2026-07-01T01:30:00.000Z");
        expect(attempt.idempotencyKey).toBe("k-1");
        expect(buildServerAttempt(INPUT, EXAM, GUEST, "att-n", "2026-07-01T01:30:00.000Z").idempotencyKey).toBeUndefined();
    });

    it("passes handwriting metadata through to the server attempt", () => {
        const attempt = buildServerAttempt(
            {
                ...INPUT,
                drawings: { 1: ["M0 0L1 1"] },
                handwritingArchived: true,
                handwritingPlan: "pro",
                questionDrawings: [{ questionId: 1, questionNumber: 1, page: 1, strokeCount: 1 }],
            },
            EXAM, GUEST, "att-hw", "2026-07-01T01:30:00.000Z",
        );
        expect(attempt.drawings).toEqual({ 1: ["M0 0L1 1"] });
        expect(attempt.handwritingArchived).toBe(true);
        expect(attempt.handwritingPlan).toBe("pro");
        expect(attempt.questionDrawings).toHaveLength(1);
    });
});
