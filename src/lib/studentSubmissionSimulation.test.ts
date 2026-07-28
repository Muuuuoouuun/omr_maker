import { describe, expect, it } from "vitest";
import type { SubmitAttemptInput } from "@/lib/studentExamCore";
import type { StudentServerIdentity } from "@/lib/studentServerSession";
import { createStudentSubmissionSimulator } from "./studentSubmissionSimulation";

const identity: StudentServerIdentity = {
    kind: "student",
    studentId: "class-a::김학생",
    name: "김학생",
    groupId: "class-a",
    groupName: "A반",
    identityType: "temporary",
    issuedAt: 1_000,
    expiresAt: 100_000,
};

const input: SubmitAttemptInput = {
    examId: "e2e-korean-integrated-exam",
    submissionId: "11111111-1111-4111-8111-111111111111",
    answers: { 1: 2, 2: 3, 3: 1 },
    startedAt: "2026-07-28T00:00:00.000Z",
};

const env = {
    NODE_ENV: "test",
    OMR_E2E_STUDENT_SUBMISSION_SIMULATION: "1",
    OMR_E2E_STUDENT_SUBMISSION_EXAM_ID: "e2e-korean-integrated-exam",
    OMR_E2E_STUDENT_SUBMISSION_EXAM_TITLE: "E2E 국어 통합 시험",
    OMR_E2E_STUDENT_SUBMISSION_ANSWER_KEY: "2,3,4",
    STUDENT_SESSION_SECRET: "test-student-session-secret",
};

describe("student submission development simulation", () => {
    it("is impossible to enable in production", () => {
        const simulate = createStudentSubmissionSimulator();
        expect(simulate(input, identity, { ...env, NODE_ENV: "production" }, Date.now()))
            .toEqual({ status: "disabled" });
    });

    it("rejects exams and answers outside the server allowlist", () => {
        const simulate = createStudentSubmissionSimulator();
        expect(simulate({ ...input, examId: "another-exam" }, identity, env, Date.now()))
            .toEqual({ status: "invalid" });
        expect(simulate({ ...input, answers: { ...input.answers, 99: 1 } }, identity, env, Date.now()))
            .toEqual({ status: "invalid" });
        expect(simulate({ ...input, answers: { 1: 9 } }, identity, env, Date.now()))
            .toEqual({ status: "invalid" });
    });

    it("returns one owner-bound canonical graded attempt for every idempotent replay", () => {
        const simulate = createStudentSubmissionSimulator();
        const first = simulate(input, identity, env, Date.parse("2026-07-28T00:02:00.000Z"));
        const second = simulate(input, identity, env, Date.parse("2026-07-28T00:03:00.000Z"));

        expect(first.status).toBe("ok");
        expect(second).toEqual(first);
        if (first.status !== "ok") throw new Error("expected simulation attempt");
        expect(first.attempt).toMatchObject({
            examId: input.examId,
            examTitle: "E2E 국어 통합 시험",
            studentId: identity.studentId,
            studentName: identity.name,
            score: 20,
            totalScore: 30,
            answers: input.answers,
            status: "completed",
        });
        expect(first.attempt.id).not.toBe(input.submissionId);
        expect(first.attempt.questionResults).toHaveLength(3);
    });

    it("expires idle entries, evicts the least-recently-used entry at the cap, and supports deterministic reset", () => {
        const simulate = createStudentSubmissionSimulator({ ttlMs: 1_000, maxEntries: 2 });
        const withSubmission = (submissionId: string): SubmitAttemptInput => ({ ...input, submissionId });
        const first = simulate(withSubmission("11111111-1111-4111-8111-111111111111"), identity, env, 1_000);
        const second = simulate(withSubmission("22222222-2222-4222-8222-222222222222"), identity, env, 1_100);
        expect(first.status).toBe("ok");
        expect(second.status).toBe("ok");

        simulate(withSubmission("11111111-1111-4111-8111-111111111111"), identity, env, 1_200);
        simulate(withSubmission("33333333-3333-4333-8333-333333333333"), identity, env, 1_300);
        const evictedReplay = simulate(withSubmission("22222222-2222-4222-8222-222222222222"), identity, env, 1_400);
        expect(evictedReplay.status).toBe("ok");
        if (second.status !== "ok" || evictedReplay.status !== "ok") throw new Error("expected attempts");
        expect(evictedReplay.attempt).toEqual(second.attempt);

        const ttlReplay = simulate(withSubmission("33333333-3333-4333-8333-333333333333"), identity, env, 2_401);
        expect(ttlReplay.status).toBe("ok");
        simulate.reset();
        const resetReplay = simulate(withSubmission("33333333-3333-4333-8333-333333333333"), identity, env, 2_500);
        if (ttlReplay.status !== "ok" || resetReplay.status !== "ok") throw new Error("expected attempts");
        expect(resetReplay.attempt).toEqual(ttlReplay.attempt);
        expect(simulate.size()).toBe(1);
    });

    it("rejects a mismatched payload for the same cached submission id", () => {
        const simulate = createStudentSubmissionSimulator();
        const first = simulate(input, identity, env, 1_000);
        const mismatch = simulate({
            ...input,
            answers: { ...input.answers, 1: 4 },
        }, identity, env, 1_100);

        expect(first.status).toBe("ok");
        expect(mismatch).toEqual({ status: "invalid" });
    });
});
