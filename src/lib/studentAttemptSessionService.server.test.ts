import { describe, expect, it, vi } from "vitest";
import type { Exam } from "@/types/omr";
import {
    durableAttemptSessionIds,
    openStudentAttemptSessionService,
    submitStudentAttemptSessionService,
} from "./studentAttemptSessionService.server";

const exam: Exam = {
    id: "exam-1",
    organizationId: "org-1",
    title: "시험",
    createdAt: "2026-08-06T00:00:00.000Z",
    updatedAt: "2026-08-06T00:00:00.000Z",
    durationMin: 30,
    questions: [
        { id: 1, number: 1, answer: 3, score: 5 },
        { id: 2, number: 2, answer: 2, score: 5 },
    ],
    accessConfig: { type: "public" },
};

const identity = {
    kind: "student" as const,
    organizationId: "org-1",
    studentId: "student-1",
    name: "학생",
    identityType: "registered" as const,
    issuedAt: 0,
    expiresAt: Number.MAX_SAFE_INTEGER,
};

describe("student attempt session service", () => {
    it("derives stable response-loss retry ids from the immutable signed ticket id", () => {
        const first = durableAttemptSessionIds("00000000-0000-4000-8000-000000000001");
        const retry = durableAttemptSessionIds("00000000-0000-4000-8000-000000000001");
        expect(retry).toEqual(first);
        expect(first).toEqual({
            sessionId: "session_00000000-0000-4000-8000-000000000001",
            attemptId: "attempt_00000000-0000-4000-8000-000000000001",
        });
        expect(durableAttemptSessionIds("00000000-0000-4000-8000-000000000002"))
            .not.toEqual(first);
    });

    it("starts from server data and adopts the database-authorized retake scope", async () => {
        const openGateway = vi.fn(async () => ({
            status: "active" as const,
            gradingSnapshot: exam,
            session: {
                sessionId: "session-1",
                examId: "exam-1",
                status: "in_progress" as const,
                revision: 1,
                leaseEpoch: 1,
                startedAt: "2026-08-06T00:00:00.000Z",
                deadlineAt: "2026-08-06T00:30:00.000Z",
                serverNow: "2026-08-06T00:00:00.000Z",
                answers: {},
                subQuestionAnswers: {},
                progressPayload: {},
                allowedQuestionIds: [2],
            },
        }));
        const result = await openStudentAttemptSessionService({
            exam,
            identity,
            input: {
                submissionId: "submission-1",
                leaseToken: "lease-1",
            },
            authorization: {
                assignmentId: "assignment-reused",
                assignmentRevision: 8,
                retake: { sourceAttemptId: "source-1", mode: "wrong", questionIds: [1] },
            },
            secret: "server-secret",
            ids: { sessionId: "session-1", attemptId: "attempt-1" },
            openGateway,
        });

        expect(result).toMatchObject({
            status: "active",
            leaseToken: "lease-1",
            session: { allowedQuestionIds: [2] },
        });
        expect(openGateway).toHaveBeenCalledWith(expect.objectContaining({
            ownerStudentId: "student-1",
            assignmentId: "assignment-reused",
            assignmentRevision: 8,
            newLeaseTokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
            retake: { sourceAttemptId: "source-1", mode: "wrong", questionIds: [1] },
        }));
    });

    it("returns the newly generated token when an expired lease was rotated", async () => {
        const openGateway = vi.fn(async () => ({
            status: "active" as const,
            leaseTokenRotated: true,
            gradingSnapshot: exam,
            session: {
                sessionId: "session-1",
                examId: "exam-1",
                status: "in_progress" as const,
                revision: 2,
                leaseEpoch: 2,
                startedAt: "2026-08-06T00:00:00.000Z",
                deadlineAt: "2026-08-06T00:30:00.000Z",
                serverNow: "2026-08-06T00:01:00.000Z",
                answers: {},
                subQuestionAnswers: {},
                progressPayload: {},
                allowedQuestionIds: [1, 2],
            },
        }));
        const result = await openStudentAttemptSessionService({
            exam,
            identity,
            input: {
                submissionId: "submission-1",
                leaseToken: "replacement-token",
                currentLeaseToken: "stale-token",
            },
            secret: "server-secret",
            ids: { sessionId: "session-1", attemptId: "attempt-1" },
            openGateway,
        });
        expect(result).toMatchObject({ status: "active", leaseToken: "replacement-token" });
    });

    it("grades only the checkpointed server answers and preserves the authorized retake", async () => {
        const commitGateway = vi.fn(async ({ attempt }: { attempt: import("@/types/omr").Attempt }) => ({
            status: "submitted" as const,
            attempt,
        }));
        const result = await submitStudentAttemptSessionService({
            identity,
            leaseToken: "lease-1",
            expectedRevision: 4,
            expectedLeaseEpoch: 2,
            sessionId: "session-1",
            examId: "exam-1",
            secret: "server-secret",
            prepareGateway: async () => ({
                status: "prepared" as const,
                session: {
                    sessionId: "session-1",
                    examId: "exam-1",
                    status: "in_progress" as const,
                    revision: 4,
                    leaseEpoch: 2,
                    startedAt: "2026-08-06T00:00:00.000Z",
                    deadlineAt: "2026-08-06T00:30:00.000Z",
                    serverNow: "2026-08-06T00:10:00.000Z",
                    answers: { 2: 2 },
                    subQuestionAnswers: {},
                    allowedQuestionIds: [2],
                    gradingSnapshot: exam,
                    submissionId: "submission-1",
                    attemptId: "attempt-1",
                    assignmentId: "assignment-reused",
                    assignmentRevision: 8,
                    retake: { sourceAttemptId: "source-1", mode: "wrong" as const },
                    progressPayload: {},
                },
            }),
            commitGateway,
            finishedAt: "2026-08-06T00:10:00.000Z",
        });

        expect(result).toMatchObject({
            status: "submitted",
            attempt: {
                id: "attempt-1",
                answers: { 2: 2 },
                score: 5,
                totalScore: 5,
                retake: { sourceAttemptId: "source-1", mode: "wrong", questionIds: [2] },
                assignmentId: "assignment-reused",
                assignmentRevision: 8,
            },
        });
        expect(commitGateway).toHaveBeenCalledWith(expect.objectContaining({
            expectedRevision: 4,
            expectedLeaseEpoch: 2,
            attempt: expect.objectContaining({
                answers: { 2: 2 },
                assignmentId: "assignment-reused",
                assignmentRevision: 8,
                questionResults: [expect.objectContaining({
                    assignmentId: "assignment-reused",
                    assignmentRevision: 8,
                })],
            }),
            questionResults: [expect.objectContaining({
                assignmentId: "assignment-reused",
                assignmentRevision: 8,
            })],
        }));
    });

    it("binds nested grading evidence to each reused assignment generation N and N+1", async () => {
        const committed: import("@/types/omr").Attempt[] = [];
        for (const assignmentRevision of [8, 9]) {
            const result = await submitStudentAttemptSessionService({
                identity,
                leaseToken: `lease-${assignmentRevision}`,
                expectedRevision: assignmentRevision,
                expectedLeaseEpoch: 2,
                sessionId: `session-${assignmentRevision}`,
                examId: "exam-1",
                secret: "server-secret",
                prepareGateway: async () => ({
                    status: "prepared" as const,
                    session: {
                        sessionId: `session-${assignmentRevision}`,
                        examId: "exam-1",
                        status: "in_progress" as const,
                        revision: assignmentRevision,
                        leaseEpoch: 2,
                        startedAt: "2026-08-06T00:00:00.000Z",
                        deadlineAt: "2026-08-06T00:30:00.000Z",
                        serverNow: "2026-08-06T00:10:00.000Z",
                        answers: { 1: 3 },
                        subQuestionAnswers: {},
                        allowedQuestionIds: [1],
                        gradingSnapshot: exam,
                        submissionId: `submission-${assignmentRevision}`,
                        attemptId: `attempt-${assignmentRevision}`,
                        assignmentId: "assignment-reused",
                        assignmentRevision,
                        progressPayload: {},
                    },
                }),
                commitGateway: async ({ attempt }) => {
                    committed.push(attempt);
                    return { status: "submitted" as const, attempt };
                },
                finishedAt: "2026-08-06T00:10:00.000Z",
            });
            expect(result.status).toBe("submitted");
        }

        expect(committed.map(attempt => ({
            revision: attempt.assignmentRevision,
            nested: [...new Set(attempt.questionResults?.map(result => result.assignmentRevision))],
        }))).toEqual([
            { revision: 8, nested: [8] },
            { revision: 9, nested: [9] },
        ]);
    });

    it("returns the stored attempt after a lost submit response", async () => {
        const stored = {
            id: "attempt-1",
            organizationId: "org-1",
            examId: "exam-1",
            examTitle: "시험",
            studentId: "student-1",
            studentName: "학생",
            identityType: "registered" as const,
            startedAt: "2026-08-06T00:00:00.000Z",
            finishedAt: "2026-08-06T00:10:00.000Z",
            answers: { 1: 3 },
            subQuestionAnswers: {},
            score: 5,
            totalScore: 5,
            status: "completed" as const,
        };
        const loadSubmittedAttempt = vi.fn(async () => stored);
        const result = await submitStudentAttemptSessionService({
            identity,
            leaseToken: "lease-1",
            expectedRevision: 4,
            expectedLeaseEpoch: 2,
            sessionId: "session-1",
            examId: "exam-1",
            secret: "server-secret",
            prepareGateway: async () => ({
                status: "prepared" as const,
                session: {
                    sessionId: "session-1",
                    examId: "exam-1",
                    status: "submitted" as const,
                    revision: 4,
                    leaseEpoch: 2,
                    startedAt: "2026-08-06T00:00:00.000Z",
                    deadlineAt: "2026-08-06T00:30:00.000Z",
                    serverNow: "2026-08-06T00:10:00.000Z",
                    answers: { 1: 3 },
                    subQuestionAnswers: {},
                    allowedQuestionIds: [1],
                    gradingSnapshot: exam,
                    submissionId: "submission-1",
                    attemptId: "attempt-1",
                    progressPayload: {},
                    submittedAttemptId: "attempt-1",
                },
            }),
            commitGateway: vi.fn(),
            loadSubmittedAttempt,
        });
        expect(result).toEqual({ status: "submitted", attempt: stored });
        expect(loadSubmittedAttempt).toHaveBeenCalledWith("attempt-1");
    });
});
