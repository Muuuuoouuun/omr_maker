import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Exam } from "@/types/omr";

const mocks = vi.hoisted(() => ({
    fetchExam: vi.fn(), plan: vi.fn(), open: vi.fn(), signPdf: vi.fn(), targeted: vi.fn(),
    admin: { rpc: vi.fn() },
    origin: "http://localhost:3000",
    identity: {
        kind: "student", studentId: "student-1", name: "학생", organizationId: "org-1",
        identityType: "registered", issuedAt: 0, expiresAt: 9e15,
    },
}));
vi.mock("next/headers", () => ({
    cookies: async () => ({ get: () => ({ value: "test-session" }) }),
    headers: async () => new Headers({ host: "localhost:3000", origin: mocks.origin }),
}));
vi.mock("@/lib/supabaseServerAdmin", async importOriginal => ({
    ...await importOriginal<typeof import("@/lib/supabaseServerAdmin")>(),
    getSupabaseServerConfigFromEnv: () => ({ url: "https://example.invalid", serviceRoleKey: "test-only" }),
    createSupabaseAdminClient: () => mocks.admin,
    fetchExamRowById: mocks.fetchExam,
}));
vi.mock("@/lib/studentServerSession", async importOriginal => ({
    ...await importOriginal<typeof import("@/lib/studentServerSession")>(),
    resolveAuthorizedStudentSessionCookie: async () => ({ status: "active", identity: mocks.identity }),
    resolveStudentSessionSecret: () => "test-only-session-secret",
}));
vi.mock("@/lib/effectiveWorkspacePlanGateway", () => ({ readEffectiveWorkspacePlan: mocks.plan }));
vi.mock("@/lib/studentAttemptSessionService.server", async importOriginal => ({
    ...await importOriginal<typeof import("@/lib/studentAttemptSessionService.server")>(),
    openStudentAttemptSessionService: mocks.open,
}));
vi.mock("@/lib/remoteAssetGateway.server", async importOriginal => ({
    ...await importOriginal<typeof import("@/lib/remoteAssetGateway.server")>(),
    createStudentProblemPdfSignedUrlWithGateway: mocks.signPdf,
}));
vi.mock("@/lib/studentTargetedAssignmentGateway.server", async importOriginal => ({
    ...await importOriginal<typeof import("@/lib/studentTargetedAssignmentGateway.server")>(),
    resolveStudentTargetedAssignmentWithGateway: mocks.targeted,
}));

import { loadExamForSolving } from "@/app/actions/studentExam";
import {
    checkpointDurableStudentAttemptSession,
    heartbeatDurableStudentAttemptSession,
    openDurableStudentAttemptSession,
    resolveLegacyDurableStudentAttemptSessionScope,
    submitDurableStudentAttemptSession,
    takeoverDurableStudentAttemptSession,
} from "@/app/actions/studentAttemptSession";
import { examFromSupabaseRow, examToSupabaseRow } from "./omrPersistence";
import { createStudentAttemptTicket } from "./studentAttemptTicket";
import { studentAttemptSessionStateFromRpc } from "./studentAttemptSessionContract";

const canonical: Exam = {
    id: "exam-1", title: "Payload security", organizationId: "org-1", revision: 3,
    createdAt: "2026-10-20T00:00:00.000Z", durationMin: 80,
    classId: "PRIVATE_CLASS", createdByUserId: "PRIVATE_CREATOR",
    accessConfig: { type: "public" },
    pdfDataRef: {
        store: "remote", key: "problem-asset", organizationId: "org-1", kind: "problem_pdf",
        examId: "exam-1", mimeType: "application/pdf", size: 100, updatedAt: "2026-10-20T00:00:00.000Z",
    },
    answerKeyPdf: "PRIVATE_ANSWER_KEY",
    questions: [1, 2].map(id => ({
        id, number: id, score: 5, choices: 5, answer: 3, explanation: "PRIVATE_EXPLANATION",
        label: "PRIVATE_LABEL", tags: { concept: "PRIVATE_CONCEPT_TAG", mistakeTypes: ["PRIVATE_MISTAKE_HINT"], prerequisites: ["PRIVATE_PREREQUISITE"] },
        contentAnalysis: { status: "reviewed", concepts: ["PRIVATE_CONCEPT"], trapPoints: ["PRIVATE_ANSWER_HINT"], summary: "PRIVATE_SUMMARY" },
        subQuestions: [{ schemaVersion: 1, kind: "free_text", id: "reason", prompt: "Explain", required: true, maxLength: 300, teacherNote: "PRIVATE_NOTE" }],
    })),
};

function expectSafeStudentResponse(result: unknown, handwritingArchive: boolean, questionIds: number[]) {
    expect(result).toHaveProperty("exam");
    const payload = (result as { exam: Exam & { premiumCapabilities: { handwritingArchive: boolean } } }).exam;
    expect(JSON.stringify(result)).not.toContain("PRIVATE_");
    expect(result).not.toHaveProperty("gradingSnapshot");
    expect(payload.questions.map(question => question.id)).toEqual(questionIds);
    expect(payload.questions[0]).not.toHaveProperty("answer");
    expect(payload.questions[0]).not.toHaveProperty("contentAnalysis");
    expect(payload.questions[0].subQuestions?.[0]).toMatchObject({ prompt: "Explain", required: true, maxLength: 300 });
    expect(payload).toMatchObject({ revision: 3, durationMin: 80, pdfData: "https://example.invalid/signed-problem.pdf", premiumCapabilities: { handwritingArchive } });
    expect(payload.pdfDataRef).toBeUndefined();
    expect(mocks.signPdf).toHaveBeenCalledWith(mocks.admin, { assetId: "problem-asset", organizationId: "org-1", examId: "exam-1" });
}

describe("actual student action payload boundaries", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.origin = "http://localhost:3000";
        vi.stubEnv("STUDENT_ATTEMPT_SECRET", "test-only-attempt-secret-at-least-32-characters");
        mocks.fetchExam.mockResolvedValue(JSON.parse(JSON.stringify(examToSupabaseRow(canonical))));
        mocks.signPdf.mockResolvedValue({ status: "signed", signedUrl: "https://example.invalid/signed-problem.pdf" });
    });

    it.each(["free", "pro"])("projects canonical exam entry and targeted retakes on %s", async plan => {
        mocks.plan.mockResolvedValue({ authoritative: true, plan });
        const regular = await loadExamForSolving(canonical.id);
        expect(regular.status).toBe("ok");
        expectSafeStudentResponse(regular, plan === "pro", [1, 2]);

        mocks.targeted.mockResolvedValue({ status: "authorized", mode: "retake", questionIds: [2] });
        const retake = await loadExamForSolving(canonical.id, undefined, undefined, "assignment-1", 2);
        expect(retake.status).toBe("ok");
        expectSafeStudentResponse(retake, plan === "pro", [2]);
        expect(retake.exam?.accessConfig).toEqual({ type: "targeted", hasPin: false });
    });

    it.each([
        { plan: "free", status: "active" }, { plan: "pro", status: "active" },
        { plan: "free", status: "lease_conflict" }, { plan: "pro", status: "lease_conflict" },
    ])("projects durable $status grading snapshots on $plan", async ({ plan, status }) => {
        mocks.plan.mockResolvedValue({ authoritative: true, plan });
        const snapshot = examFromSupabaseRow(JSON.parse(JSON.stringify(examToSupabaseRow(canonical))));
        snapshot.questions = snapshot.questions.filter(question => question.id === 2);
        mocks.open.mockResolvedValue({ status, session: { id: "session-1", revision: 4 }, gradingSnapshot: snapshot });
        const attemptTicket = createStudentAttemptTicket({
            examId: canonical.id, organizationId: "org-1", studentId: "student-1", studentName: "학생",
            identityType: "registered", allowedQuestionIds: [2], retakeSourceAttemptId: "attempt-1", retakeMode: "wrong",
        });
        expect(attemptTicket).toBeTruthy();
        const result = await openDurableStudentAttemptSession({ examId: canonical.id, attemptTicket: attemptTicket! });
        expect(result.status).toBe(status);
        expect(mocks.open).toHaveBeenCalledOnce();
        expectSafeStudentResponse(result, plan === "pro", [2]);
        expect(result).toMatchObject({ session: { id: "session-1", revision: 4 } });
    });
});

describe("durable action runtime input boundary", () => {
    const mutation = {
        sessionId: "session-1", examId: "exam-1", expectedRevision: 1, expectedLeaseEpoch: 1,
        leaseToken: "client-lease-token", answers: { 1: 3 }, subQuestionAnswers: {},
    };
    const mutationActions = [
        checkpointDurableStudentAttemptSession, heartbeatDurableStudentAttemptSession,
        takeoverDurableStudentAttemptSession, submitDurableStudentAttemptSession,
    ];

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.origin = "http://localhost:3000";
    });

    it.each(mutationActions)("rejects malformed envelopes before RPC without throwing: %s", async action => {
        for (const input of [null, [], {}, { ...mutation, sessionId: " " }, { ...mutation, examId: "x".repeat(257) },
            { ...mutation, expectedLeaseEpoch: "1" }, { ...mutation, expectedLeaseEpoch: Number.MAX_SAFE_INTEGER + 1 },
            { ...mutation, assignmentId: "assignment-1", assignmentRevision: "2" }]) {
            await expect(action(input as never)).resolves.toEqual({ status: "invalid" });
        }
        expect(mocks.admin.rpc).not.toHaveBeenCalled();
    });

    it.each([checkpointDurableStudentAttemptSession, heartbeatDurableStudentAttemptSession, submitDurableStudentAttemptSession])(
        "rejects blank, nonstring and oversized lease tokens before hashing: %s", async action => {
            for (const leaseToken of [" ", null, 1, "x".repeat(257)]) {
                await expect(action({ ...mutation, leaseToken } as never)).resolves.toEqual({ status: "invalid" });
            }
            expect(mocks.admin.rpc).not.toHaveBeenCalled();
        },
    );

    it.each([checkpointDurableStudentAttemptSession, takeoverDurableStudentAttemptSession, submitDurableStudentAttemptSession])(
        "rejects invalid revision before the service: %s", async action => {
            for (const expectedRevision of [0, 1.5, "1", Number.MAX_SAFE_INTEGER + 1]) {
                await expect(action({ ...mutation, expectedRevision } as never)).resolves.toEqual({ status: "invalid" });
            }
            expect(mocks.admin.rpc).not.toHaveBeenCalled();
        },
    );

    it("keeps the same-origin guard ahead of malformed argument validation", async () => {
        mocks.origin = "https://untrusted.invalid";
        for (const action of mutationActions) {
            await expect(action(null as never)).resolves.toEqual({ status: "unauthenticated" });
        }
        expect(mocks.admin.rpc).not.toHaveBeenCalled();
    });

    it("rejects malformed open and legacy recovery arguments before dereferencing them", async () => {
        for (const input of [null, [], { examId: "exam-1", attemptTicket: 42 },
            { examId: "exam-1", attemptTicket: "test", requestedRetake: { sourceAttemptId: "a", mode: "wrong", questionIds: null } }]) {
            await expect(openDurableStudentAttemptSession(input as never)).resolves.toEqual({ status: "invalid" });
        }
        for (const input of [null, [], { sessionId: " " }]) {
            await expect(resolveLegacyDurableStudentAttemptSessionScope(input as never)).resolves.toEqual({ status: "invalid" });
        }
        expect(mocks.admin.rpc).not.toHaveBeenCalled();
        expect(mocks.open).not.toHaveBeenCalled();
    });

    it("runs nested answer validation through the real gateway before writing a checkpoint", async () => {
        for (const payload of [{ answers: null }, { answers: { 1: 2.5 } }, { subQuestionAnswers: [] },
            { subQuestionAnswers: { 1: { reason: { schemaVersion: 1, body: null } } } }]) {
            await expect(checkpointDurableStudentAttemptSession({ ...mutation, ...payload } as never))
                .resolves.toEqual({ status: "invalid" });
        }
        expect(mocks.admin.rpc).not.toHaveBeenCalled();
    });

    it("projects student checkpoint answers before RPC, removing forged teacher review fields", async () => {
        mocks.admin.rpc.mockResolvedValue({ data: null, error: { message: "attempt session revision conflict" } });
        const subQuestionAnswers = JSON.parse('{"1":{"__proto__":{"schemaVersion":1,"body":"student explanation","reviewStatus":"reviewed","reviewedBy":"teacher-1","reviewedAt":"2026-10-21T00:00:00.000Z"}}}');
        await expect(checkpointDurableStudentAttemptSession({
            ...mutation, subQuestionAnswers, organizationId: "attacker-org", ownerStudentId: "attacker-student",
        } as never))
            .resolves.toEqual({ status: "revision_conflict" });
        expect(mocks.admin.rpc).toHaveBeenCalledOnce();
        const params = mocks.admin.rpc.mock.calls[0][1];
        expect(params).toMatchObject({ p_organization_id: "org-1", p_owner_student_id: "student-1", p_answers: { 1: 3 } });
        const roundtrip = JSON.parse(JSON.stringify(params.p_sub_question_answers));
        expect(Object.hasOwn(roundtrip[1], "__proto__")).toBe(true);
        expect(roundtrip[1].__proto__).toEqual({ schemaVersion: 1, body: "student explanation", reviewStatus: "needs_review" });
        expect(params.p_lease_token_hash).not.toBe(mutation.leaseToken);
        expect(JSON.stringify(params)).not.toContain("teacher-1");
    });

    it("fails closed for malformed heartbeat state returned by the real gateway", async () => {
        mocks.admin.rpc.mockResolvedValue({ data: [{ status: "in_progress", revision: "1", lease_epoch: 1 }], error: null });
        await expect(heartbeatDurableStudentAttemptSession(mutation)).resolves.toEqual({ status: "service_unavailable" });
        expect(mocks.admin.rpc).toHaveBeenCalledOnce();
    });

    it("normalizes nullable DB assignment scope and damaged responses before a resumed checkpoint", async () => {
        const rawState = {
            session_id: "session-1", exam_id: "exam-1", status: "in_progress", revision: 1, lease_epoch: 1,
            assignment_id: null, assignment_revision: null, allowed_question_ids: [1],
            started_at: "2026-10-21T00:00:00.000Z", deadline_at: "2026-10-21T01:00:00.000Z",
            server_now: "2026-10-21T00:01:00.000Z", answers: { 1: 3 },
            sub_question_answers: { 1: {
                broken: { schemaVersion: 1, body: null, reviewStatus: "needs_review" },
                reason: { schemaVersion: 1, body: "Valid reason", reviewStatus: "needs_review", answeredAt: "bad-date" },
            } },
        };
        const session = studentAttemptSessionStateFromRpc(rawState)!;
        expect(session).not.toHaveProperty("assignmentId");
        expect(session).not.toHaveProperty("assignmentRevision");
        expect(session.subQuestionAnswers).toEqual({ 1: { reason: { schemaVersion: 1, body: "Valid reason", reviewStatus: "needs_review" } } });
        mocks.admin.rpc.mockResolvedValue({ data: [{ ...rawState, revision: 2 }], error: null });
        await expect(checkpointDurableStudentAttemptSession({
            ...mutation, assignmentId: session.assignmentId, assignmentRevision: session.assignmentRevision,
            answers: session.answers, subQuestionAnswers: session.subQuestionAnswers,
        })).resolves.toMatchObject({ status: "active", session: { revision: 2 } });
        expect(mocks.admin.rpc).toHaveBeenCalledWith("omr_checkpoint_attempt_session_v2", expect.objectContaining({
            p_assignment_id: "", p_assignment_revision: null, p_sub_question_answers: session.subQuestionAnswers,
        }));
    });
});
