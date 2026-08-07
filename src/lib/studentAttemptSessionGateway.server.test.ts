import { describe, expect, it, vi } from "vitest";
import {
    checkpointStudentAttemptSessionWithGateway,
    commitStudentAttemptSessionSubmitWithGateway,
    heartbeatStudentAttemptSessionWithGateway,
    openStudentAttemptSessionWithGateway,
    prepareStudentAttemptSessionSubmitWithGateway,
    takeoverStudentAttemptSessionWithGateway,
} from "./studentAttemptSessionGateway.server";
import type { Attempt } from "@/types/omr";

const rpcState = {
    session_id: "session-1",
    status: "in_progress",
    revision: 1,
    lease_epoch: 1,
    started_at: "2026-08-06T00:00:00.000Z",
    deadline_at: "2026-08-06T00:30:00.000Z",
    server_now: "2026-08-06T00:00:00.000Z",
    answers: {},
    sub_question_answers: {},
    grading_snapshot: { id: "exam-1", title: "시험", createdAt: "2026-08-06T00:00:00.000Z", questions: [] },
    allowed_question_ids: [1, 2],
    submitted_attempt_id: null,
};

describe("student attempt session gateway", () => {
    it("opens with hashes only and reports an active lease held by another device", async () => {
        const rpc = vi.fn(async () => ({ data: [{ ...rpcState, lease_acquired: false }], error: null }));
        const result = await openStudentAttemptSessionWithGateway({ rpc }, {
            sessionId: "session-new",
            organizationId: "org-1",
            examId: "exam-1",
            ownerStudentId: "student-1",
            studentName: "학생",
            identityType: "registered",
            submissionId: "submission-1",
            attemptId: "attempt-1",
            examQuestionIds: [1, 2],
            gradingSnapshot: {
                id: "exam-1",
                title: "시험",
                createdAt: "2026-08-06T00:00:00.000Z",
                questions: [],
            },
            durationSeconds: 1800,
            newLeaseTokenHash: "new-hash",
            currentLeaseTokenHash: "current-hash",
        });

        expect(result).toMatchObject({ status: "lease_conflict", session: { sessionId: "session-1" } });
        expect(rpc).toHaveBeenCalledWith("omr_open_attempt_session_v1", expect.objectContaining({
            p_new_lease_token_hash: "new-hash",
            p_current_lease_token_hash: "current-hash",
        }));
        expect(JSON.stringify(rpc.mock.calls[0])).not.toContain("lease-secret");
    });

    it("maps checkpoint CAS conflicts to a stable public status", async () => {
        const rpc = vi.fn(async () => ({ data: null, error: { message: "attempt session revision conflict" } }));
        await expect(checkpointStudentAttemptSessionWithGateway({ rpc }, {
            sessionId: "session-1",
            organizationId: "org-1",
            ownerStudentId: "student-1",
            expectedRevision: 1,
            expectedLeaseEpoch: 1,
            leaseTokenHash: "hash",
            answers: { 1: 2 },
            subQuestionAnswers: {},
            progressPayload: {},
        })).resolves.toEqual({ status: "revision_conflict" });
    });

    it("sends only canonical bounded handwriting through the owned checkpoint RPC", async () => {
        const stroke = JSON.stringify({
            mode: "pen",
            color: "#123456",
            width: 2,
            points: [{ x: 0.1, y: 0.2 }, { x: 0.2, y: 0.3 }],
        });
        const rpc = vi.fn(async () => ({ data: [{ ...rpcState, revision: 2 }], error: null }));
        const result = await checkpointStudentAttemptSessionWithGateway({ rpc }, {
            sessionId: "session-1",
            organizationId: "org-1",
            ownerStudentId: "student-1",
            expectedRevision: 1,
            expectedLeaseEpoch: 1,
            leaseTokenHash: "hash",
            answers: { 1: 2 },
            subQuestionAnswers: {},
            progressPayload: {
                currentQuestionId: 1,
                studentName: "must-not-persist",
                handwritingCheckpoint: { schemaVersion: 1, drawings: { 1: [stroke] } },
            },
        });

        expect(result.status).toBe("active");
        expect(rpc).toHaveBeenCalledWith("omr_checkpoint_attempt_session_v1", expect.objectContaining({
            p_progress_payload: {
                currentQuestionId: 1,
                handwritingCheckpoint: {
                    schemaVersion: 1,
                    drawings: { 1: [stroke] },
                    pageCount: 1,
                    strokeCount: 1,
                },
            },
        }));
    });

    it("rejects handwriting beyond the 64 KiB checkpoint budget before the RPC", async () => {
        const stroke = JSON.stringify({
            mode: "pen",
            points: Array.from({ length: 80 }, (_, index) => ({
                x: (index % 10) / 10,
                y: (index % 9) / 9,
            })),
        });
        const rpc = vi.fn(async () => ({ data: [{ ...rpcState, revision: 2 }], error: null }));
        const result = await checkpointStudentAttemptSessionWithGateway({ rpc }, {
            sessionId: "session-1",
            organizationId: "org-1",
            ownerStudentId: "student-1",
            expectedRevision: 1,
            expectedLeaseEpoch: 1,
            leaseTokenHash: "hash",
            answers: {},
            subQuestionAnswers: {},
            progressPayload: {
                currentQuestionId: 1,
                handwritingCheckpoint: {
                    schemaVersion: 1,
                    drawings: { 1: Array.from({ length: 25 }, () => stroke) },
                },
            },
        });

        expect(result).toEqual({ status: "invalid" });
        expect(rpc).not.toHaveBeenCalled();
    });

    it.each([
        ["expected revision", { expectedRevision: null, expectedLeaseEpoch: 1 }],
        ["expected lease epoch", { expectedRevision: 1, expectedLeaseEpoch: null }],
        ["fractional revision", { expectedRevision: 1.5, expectedLeaseEpoch: 1 }],
        ["fractional lease epoch", { expectedRevision: 1, expectedLeaseEpoch: 1.5 }],
        ["zero revision", { expectedRevision: 0, expectedLeaseEpoch: 1 }],
        ["zero lease epoch", { expectedRevision: 1, expectedLeaseEpoch: 0 }],
        ["unsafe revision", { expectedRevision: Number.MAX_SAFE_INTEGER + 1, expectedLeaseEpoch: 1 }],
    ])("rejects an invalid %s before calling the checkpoint RPC", async (_label, cas) => {
        const rpc = vi.fn(async () => ({ data: [{ ...rpcState, revision: 2 }], error: null }));
        const result = await checkpointStudentAttemptSessionWithGateway({ rpc }, {
            sessionId: "session-1",
            organizationId: "org-1",
            ownerStudentId: "student-1",
            expectedRevision: cas.expectedRevision as number,
            expectedLeaseEpoch: cas.expectedLeaseEpoch as number,
            leaseTokenHash: "hash",
            answers: { 1: 2 },
            subQuestionAnswers: {},
            progressPayload: {},
        });

        expect(result).toEqual({ status: "invalid" });
        expect(rpc).not.toHaveBeenCalled();
    });

    it("rotates the lease and returns the incremented epoch on explicit takeover", async () => {
        const rpc = vi.fn(async () => ({
            data: [{ ...rpcState, revision: 2, lease_epoch: 2 }],
            error: null,
        }));
        const result = await takeoverStudentAttemptSessionWithGateway({ rpc }, {
            sessionId: "session-1",
            organizationId: "org-1",
            ownerStudentId: "student-1",
            expectedRevision: 1,
            expectedLeaseEpoch: 1,
            newLeaseTokenHash: "replacement-hash",
        });
        expect(result).toMatchObject({ status: "active", session: { revision: 2, leaseEpoch: 2 } });
    });

    it.each([
        ["null epoch", { expectedLeaseEpoch: null, leaseTokenHash: "hash" }],
        ["zero epoch", { expectedLeaseEpoch: 0, leaseTokenHash: "hash" }],
        ["unsafe epoch", { expectedLeaseEpoch: Number.MAX_SAFE_INTEGER + 1, leaseTokenHash: "hash" }],
        ["blank token", { expectedLeaseEpoch: 1, leaseTokenHash: "   " }],
    ])("rejects heartbeat %s before calling the RPC", async (_label, invalid) => {
        const rpc = vi.fn(async () => ({ data: null, error: null }));

        await expect(heartbeatStudentAttemptSessionWithGateway({ rpc }, {
            sessionId: "session-1",
            organizationId: "org-1",
            ownerStudentId: "student-1",
            expectedLeaseEpoch: invalid.expectedLeaseEpoch as number,
            leaseTokenHash: invalid.leaseTokenHash,
        })).resolves.toEqual({ status: "invalid" });
        expect(rpc).not.toHaveBeenCalled();
    });

    it.each([
        ["null revision", { expectedRevision: null, expectedLeaseEpoch: 1, newLeaseTokenHash: "hash" }],
        ["zero revision", { expectedRevision: 0, expectedLeaseEpoch: 1, newLeaseTokenHash: "hash" }],
        ["unsafe revision", { expectedRevision: Number.MAX_SAFE_INTEGER + 1, expectedLeaseEpoch: 1, newLeaseTokenHash: "hash" }],
        ["null epoch", { expectedRevision: 1, expectedLeaseEpoch: null, newLeaseTokenHash: "hash" }],
        ["zero epoch", { expectedRevision: 1, expectedLeaseEpoch: 0, newLeaseTokenHash: "hash" }],
        ["unsafe epoch", { expectedRevision: 1, expectedLeaseEpoch: Number.MAX_SAFE_INTEGER + 1, newLeaseTokenHash: "hash" }],
        ["blank token", { expectedRevision: 1, expectedLeaseEpoch: 1, newLeaseTokenHash: "   " }],
    ])("rejects takeover %s before calling the RPC", async (_label, invalid) => {
        const rpc = vi.fn(async () => ({ data: null, error: null }));

        await expect(takeoverStudentAttemptSessionWithGateway({ rpc }, {
            sessionId: "session-1",
            organizationId: "org-1",
            ownerStudentId: "student-1",
            expectedRevision: invalid.expectedRevision as number,
            expectedLeaseEpoch: invalid.expectedLeaseEpoch as number,
            newLeaseTokenHash: invalid.newLeaseTokenHash,
        })).resolves.toEqual({ status: "invalid" });
        expect(rpc).not.toHaveBeenCalled();
    });

    it("serializes a canonical attempt row and derives question result rows at commit", async () => {
        const attempt: Attempt = {
            id: "attempt-1",
            organizationId: "org-1",
            examId: "exam-1",
            examTitle: "시험",
            studentId: "student-1",
            studentName: "학생",
            identityType: "registered",
            startedAt: "2026-08-06T00:00:00.000Z",
            finishedAt: "2026-08-06T00:10:00.000Z",
            answers: { 1: 3 },
            subQuestionAnswers: {},
            score: 5,
            totalScore: 5,
            status: "completed",
            questionResults: [{
                schemaVersion: 1,
                attemptId: "attempt-1",
                examId: "exam-1",
                examTitle: "시험",
                organizationId: "org-1",
                studentName: "학생",
                studentId: "student-1",
                questionId: 1,
                questionNumber: 1,
                selectedAnswer: 3,
                correctAnswer: 3,
                isCorrect: true,
                score: 5,
                earnedScore: 5,
                status: "correct",
                isWrong: false,
                isUnanswered: false,
                finishedAt: "2026-08-06T00:10:00.000Z",
            }],
        };
        const rpc = vi.fn(async () => ({ data: [{ payload: attempt }], error: null }));

        await commitStudentAttemptSessionSubmitWithGateway({ rpc }, {
            sessionId: "session-1",
            organizationId: "org-1",
            ownerStudentId: "student-1",
            expectedRevision: 2,
            expectedLeaseEpoch: 1,
            leaseTokenHash: "hash",
            attempt,
        });

        expect(rpc).toHaveBeenCalledWith("omr_commit_attempt_session_submit_v1", expect.objectContaining({
            p_attempt: expect.objectContaining({
                id: "attempt-1",
                organization_id: "org-1",
                exam_id: "exam-1",
                student_id: "student-1",
            }),
            p_question_results: [expect.objectContaining({
                attempt_id: "attempt-1",
                question_id: 1,
            })],
        }));
    });

    it("does not reinterpret an expired prepare response as in-progress", async () => {
        const rpc = vi.fn(async () => ({
            data: [{
                ...rpcState,
                status: "expired",
                grading_snapshot: { id: "exam-1" },
                submission_id: "submission-1",
                attempt_id: "attempt-1",
                progress_payload: {},
            }],
            error: null,
        }));
        await expect(prepareStudentAttemptSessionSubmitWithGateway({ rpc }, {
            sessionId: "session-1",
            organizationId: "org-1",
            ownerStudentId: "student-1",
            expectedRevision: 1,
            expectedLeaseEpoch: 1,
            leaseTokenHash: "hash",
        })).resolves.toEqual({ status: "expired" });
    });

    it.each([
        ["null revision", { expectedRevision: null, expectedLeaseEpoch: 1, leaseTokenHash: "hash" }],
        ["zero revision", { expectedRevision: 0, expectedLeaseEpoch: 1, leaseTokenHash: "hash" }],
        ["unsafe revision", { expectedRevision: Number.MAX_SAFE_INTEGER + 1, expectedLeaseEpoch: 1, leaseTokenHash: "hash" }],
        ["null epoch", { expectedRevision: 1, expectedLeaseEpoch: null, leaseTokenHash: "hash" }],
        ["zero epoch", { expectedRevision: 1, expectedLeaseEpoch: 0, leaseTokenHash: "hash" }],
        ["unsafe epoch", { expectedRevision: 1, expectedLeaseEpoch: Number.MAX_SAFE_INTEGER + 1, leaseTokenHash: "hash" }],
        ["blank token", { expectedRevision: 1, expectedLeaseEpoch: 1, leaseTokenHash: "   " }],
    ])("rejects prepare %s before calling the RPC", async (_label, invalid) => {
        const rpc = vi.fn(async () => ({ data: null, error: null }));

        await expect(prepareStudentAttemptSessionSubmitWithGateway({ rpc }, {
            sessionId: "session-1",
            organizationId: "org-1",
            ownerStudentId: "student-1",
            expectedRevision: invalid.expectedRevision as number,
            expectedLeaseEpoch: invalid.expectedLeaseEpoch as number,
            leaseTokenHash: invalid.leaseTokenHash,
        })).resolves.toEqual({ status: "invalid" });
        expect(rpc).not.toHaveBeenCalled();
    });

    it.each([
        ["null revision", { expectedRevision: null, expectedLeaseEpoch: 1, leaseTokenHash: "hash" }],
        ["zero revision", { expectedRevision: 0, expectedLeaseEpoch: 1, leaseTokenHash: "hash" }],
        ["unsafe revision", { expectedRevision: Number.MAX_SAFE_INTEGER + 1, expectedLeaseEpoch: 1, leaseTokenHash: "hash" }],
        ["null epoch", { expectedRevision: 1, expectedLeaseEpoch: null, leaseTokenHash: "hash" }],
        ["zero epoch", { expectedRevision: 1, expectedLeaseEpoch: 0, leaseTokenHash: "hash" }],
        ["unsafe epoch", { expectedRevision: 1, expectedLeaseEpoch: Number.MAX_SAFE_INTEGER + 1, leaseTokenHash: "hash" }],
        ["blank token", { expectedRevision: 1, expectedLeaseEpoch: 1, leaseTokenHash: "   " }],
    ])("rejects commit %s before calling the RPC", async (_label, invalid) => {
        const rpc = vi.fn(async () => ({ data: null, error: null }));

        await expect(commitStudentAttemptSessionSubmitWithGateway({ rpc }, {
            sessionId: "session-1",
            organizationId: "org-1",
            ownerStudentId: "student-1",
            expectedRevision: invalid.expectedRevision as number,
            expectedLeaseEpoch: invalid.expectedLeaseEpoch as number,
            leaseTokenHash: invalid.leaseTokenHash,
            attempt: { id: "attempt-1" } as Attempt,
        })).resolves.toEqual({ status: "invalid" });
        expect(rpc).not.toHaveBeenCalled();
    });

    it("maps the commit expiry sentinel without exposing a database error", async () => {
        const rpc = vi.fn(async () => ({ data: [{ payload: null, result_status: "expired" }], error: null }));
        const attempt = { id: "attempt-1" } as Attempt;
        await expect(commitStudentAttemptSessionSubmitWithGateway({ rpc }, {
            sessionId: "session-1",
            organizationId: "org-1",
            ownerStudentId: "student-1",
            expectedRevision: 1,
            expectedLeaseEpoch: 1,
            leaseTokenHash: "hash",
            attempt,
        })).resolves.toEqual({ status: "expired" });
    });
});
