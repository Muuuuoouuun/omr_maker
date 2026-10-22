import { describe, expect, it, vi } from "vitest";
import type { Attempt, Exam } from "@/types/omr";
import type { PreparedStudentAttemptSession } from "./studentAttemptSessionGateway.server";
import { serverGradedAttemptReceiptFromAttempt } from "./serverAttemptGrading";
import { buildServerAttempt, RequiredSubQuestionAnswersError } from "./studentExamServerGrading";
import { submitStudentAttemptSessionService } from "./studentAttemptSessionService.server";
import {
    createMemorySecureSubmissionStore,
    queueSecureSubmission,
    readSecureSubmission,
    recoverIncompleteSecureSubmissionForEditing,
    replaySecureSubmissionsForOwner,
    retryBlockedSecureSubmission,
    SECURE_SUBMISSION_TTL_MS,
    type SecureSubmissionSnapshot,
} from "./studentSecureSubmissionOutbox";

const NOW = Date.parse("2026-10-21T12:00:00.000Z");
const OWNER = "a".repeat(64);
const OTHER_OWNER = "b".repeat(64);
const identity = {
    kind: "student" as const,
    organizationId: "org-required",
    studentId: "student-required",
    name: "학생",
    identityType: "registered" as const,
    issuedAt: 0,
    expiresAt: Number.MAX_SAFE_INTEGER,
};
const exam: Exam = {
    id: "exam-required",
    organizationId: "org-required",
    title: "필수 심화 응답",
    createdAt: "2026-10-21T00:00:00.000Z",
    questions: [{
        id: 1, number: 1, answer: 2, score: 5,
        subQuestions: [{ schemaVersion: 1, id: "reason", prompt: "근거를 쓰세요.", kind: "free_text", required: true, maxLength: 100 }],
    }],
};

function snapshot(): SecureSubmissionSnapshot {
    return {
        sessionId: "session-required", examId: exam.id,
        expectedRevision: 3, expectedLeaseEpoch: 2, leaseToken: "lease-required",
        answers: { 1: 2 }, subQuestionAnswers: {}, progressPayload: {},
        autoSubmitted: false, tabFociLostCount: 0, questionTimings: [], focusLossEvents: [],
        finishedAt: new Date(NOW).toISOString(),
    };
}

function preparedSession(): PreparedStudentAttemptSession {
    return {
        sessionId: "session-required", status: "in_progress",
        revision: 3, leaseEpoch: 2, startedAt: "2026-10-21T11:50:00.000Z",
        serverNow: new Date(NOW).toISOString(), deadlineAt: "2026-10-21T12:20:00.000Z",
        allowedQuestionIds: [1], answers: {}, subQuestionAnswers: {}, progressPayload: {},
        gradingSnapshot: exam, attemptId: "attempt-required", submissionId: "submission-required",
    };
}

function serviceParams(session: PreparedStudentAttemptSession) {
    return {
        identity, sessionId: session.sessionId, examId: exam.id,
        expectedRevision: session.revision, expectedLeaseEpoch: session.leaseEpoch,
        leaseToken: "lease-required", secret: "test-only-signing-secret",
        finishedAt: new Date(NOW).toISOString(),
        prepareGateway: async () => ({ status: "prepared" as const, session }),
    };
}

describe("required-response submission recovery", () => {
    it("provides a typed grading issue with only the missing question identities", () => {
        const input = { examId: exam.id, submissionId: "submission-required", answers: { 1: 2 }, startedAt: "2026-10-21T11:50:00.000Z" };
        expect(() => buildServerAttempt(input, exam, identity, "attempt-required", new Date(NOW).toISOString()))
            .toThrow(RequiredSubQuestionAnswersError);
        try {
            buildServerAttempt(input, exam, identity, "attempt-required", new Date(NOW).toISOString());
        } catch (error) {
            expect(error).toMatchObject({
                message: "REQUIRED_SUB_QUESTIONS_MISSING",
                missingRequiredSubQuestions: [{ questionId: 1, subQuestionId: "reason" }],
            });
        }
    });

    it("returns an actionable service rejection before any commit and retains timer submission policy", async () => {
        const session = preparedSession();
        const commitGateway = vi.fn(async ({ attempt }: { attempt: Attempt }) => ({ status: "submitted" as const, attempt }));
        await expect(submitStudentAttemptSessionService({ ...serviceParams(session), commitGateway }))
            .resolves.toEqual({ status: "answers_incomplete", missingRequiredSubQuestions: [{ questionId: 1, subQuestionId: "reason" }], revision: 3 });
        expect(commitGateway).not.toHaveBeenCalled();

        await expect(submitStudentAttemptSessionService({ ...serviceParams(session), commitGateway, autoSubmitted: true }))
            .resolves.toMatchObject({ status: "submitted", attempt: {
                autoSubmitted: true,
                missingRequiredSubQuestions: [{ questionId: 1, subQuestionId: "reason" }],
            } });
        expect(commitGateway).toHaveBeenCalledOnce();
    });

    it("blocks the frozen invalid snapshot, restores its checkpoint, and submits corrected answers with the same lease", async () => {
        const store = createMemorySecureSubmissionStore();
        const session = preparedSession();
        const commitGateway = vi.fn(async ({ attempt }: { attempt: Attempt }) => ({ status: "submitted" as const, attempt }));
        const checkpoint = vi.fn(async (input: Pick<SecureSubmissionSnapshot, "answers" | "subQuestionAnswers" | "expectedRevision" | "expectedLeaseEpoch">) => {
            if (input.expectedRevision !== session.revision || input.expectedLeaseEpoch !== session.leaseEpoch) return { status: "revision_conflict" as const };
            session.answers = structuredClone(input.answers);
            session.subQuestionAnswers = structuredClone(input.subQuestionAnswers);
            session.revision += 1;
            return { status: "active" as const, session: { revision: session.revision, leaseEpoch: session.leaseEpoch } };
        });
        const submit = vi.fn(async () => {
            const result = await submitStudentAttemptSessionService({ ...serviceParams(session), commitGateway });
            return result.status === "submitted"
                ? { status: "submitted", receipt: serverGradedAttemptReceiptFromAttempt(result.attempt) }
                : result;
        });
        const actions = { checkpoint, submit };
        await queueSecureSubmission(OWNER, snapshot(), { store, now: NOW });
        await expect(replaySecureSubmissionsForOwner(OWNER, actions, { store, now: NOW }))
            .resolves.toMatchObject({ status: "blocked", blockedCount: 1 });
        expect(commitGateway).not.toHaveBeenCalled();
        expect(await readSecureSubmission("session-required", { store })).toMatchObject({
            state: "blocked", blockReason: "answers_incomplete", retryCount: 0, checkpointRevision: 4,
        });
        await expect(replaySecureSubmissionsForOwner(OWNER, actions, { store, now: NOW + 60_000 }))
            .resolves.toMatchObject({ status: "blocked" });
        await expect(retryBlockedSecureSubmission("session-required", OWNER, actions, { store, now: NOW + 60_000 }))
            .resolves.toMatchObject({ status: "blocked" });
        expect(checkpoint).toHaveBeenCalledOnce();
        expect(submit).toHaveBeenCalledOnce();

        const preserveDraft = vi.fn(() => true);
        const recovered = await recoverIncompleteSecureSubmissionForEditing("session-required", OWNER, preserveDraft, { store, now: NOW + 60_000 });
        expect(recovered).toMatchObject({ status: "recovered", revision: 4, snapshot: { answers: { 1: 2 }, expectedLeaseEpoch: 2 } });
        expect(preserveDraft).toHaveBeenCalledWith(expect.objectContaining({ answers: { 1: 2 } }), 4);
        expect(await store.list()).toEqual([]);
        if (recovered.status !== "recovered") throw new Error("expected editable recovery");
        const corrected: SecureSubmissionSnapshot = {
            ...recovered.snapshot,
            expectedRevision: recovered.revision,
            subQuestionAnswers: { 1: { reason: { schemaVersion: 1, body: "본문의 근거", reviewStatus: "needs_review" } } },
        };
        await queueSecureSubmission(OWNER, corrected, { store, now: NOW + 60_001 });
        await expect(replaySecureSubmissionsForOwner(OWNER, actions, { store, now: NOW + 60_001 }))
            .resolves.toMatchObject({ status: "submitted", submitted: [{ attemptId: "attempt-required", score: 5 }] });
        expect(commitGateway).toHaveBeenCalledOnce();
        expect(checkpoint.mock.calls.map(([input]) => input.expectedLeaseEpoch)).toEqual([2, 2]);
        expect(checkpoint.mock.calls.map(([input]) => input.expectedRevision)).toEqual([3, 4]);
        expect(await store.list()).toEqual([]);
    });

    it.each(["wrong_owner", "queued", "lease_conflict", "expired", "claimed"])(
        "retains an immutable snapshot and never exposes its answers for %s",
        async scenario => {
            const store = createMemorySecureSubmissionStore();
            await queueSecureSubmission(OWNER, snapshot(), { store, now: NOW });
            const record = (await readSecureSubmission("session-required", { store }))!;
            await store.put({
                ...record,
                state: scenario === "queued" ? "queued" : "blocked",
                blockReason: scenario === "lease_conflict" ? "lease_conflict" : "answers_incomplete",
                ...(scenario === "claimed" ? { replayClaim: { id: "active", expiresAt: new Date(NOW + 60_000).toISOString() } } : {}),
            });
            const preserve = vi.fn(() => true);
            await expect(recoverIncompleteSecureSubmissionForEditing("session-required", scenario === "wrong_owner" ? OTHER_OWNER : OWNER, preserve, {
                store, now: scenario === "expired" ? NOW + SECURE_SUBMISSION_TTL_MS + 1 : NOW,
            })).resolves.toEqual({ status: "not_recoverable" });
            expect(preserve).not.toHaveBeenCalled();
            expect(await store.list()).toHaveLength(1);
        },
    );

    it.each([false, "throw"])("keeps the original rejected answers when draft preservation fails (%s)", async failure => {
        const store = createMemorySecureSubmissionStore();
        await queueSecureSubmission(OWNER, snapshot(), { store, now: NOW });
        const record = (await readSecureSubmission("session-required", { store }))!;
        await store.put({ ...record, state: "blocked", blockReason: "answers_incomplete" });
        await expect(recoverIncompleteSecureSubmissionForEditing("session-required", OWNER, () => {
            if (failure === "throw") throw new Error("draft quota exceeded");
            return false;
        }, { store, now: NOW })).resolves.toEqual({ status: "storage_error" });
        expect(await readSecureSubmission("session-required", { store })).toMatchObject({ state: "blocked", snapshot: { answers: { 1: 2 } } });
    });
});
