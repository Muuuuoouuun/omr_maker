import { describe, expect, it, vi } from "vitest";
import type { Attempt, Exam } from "@/types/omr";
import type { StudentAttemptSubmission } from "./studentExamContract";
import { parseStudentAttemptTicket } from "./studentAttemptTicket";
import {
    openStudentExamWithGateway,
    previewStudentExamWithGateway,
    submitStudentAttemptWithGateway,
    type StudentExamGatewayClient,
} from "./studentExamServerGateway";
import * as studentExamGatewayModule from "./studentExamServerGateway";

const env = {
    NODE_ENV: "production",
    STUDENT_ATTEMPT_SECRET: "gateway-student-attempt-secret-at-least-32-bytes",
};
const exam: Exam = {
    id: "exam-1",
    title: "원격 시험",
    organizationId: "org-1",
    createdAt: "2026-07-14T00:00:00.000Z",
    accessConfig: { type: "public", pin: "4321" },
    answerKeyPdf: "data:application/pdf;base64,secret-answer-key",
    questions: [
        { id: 1, number: 1, answer: 3, score: 5, choices: 5, explanation: "비밀 해설" },
        { id: 2, number: 2, answer: 1, score: 5, choices: 4 },
    ],
};

function mockClient(options: {
    rpcError?: string;
    mutateStoredAttempt?: (attempt: Record<string, unknown>) => Record<string, unknown>;
} = {}) {
    const filters: Array<[string, string]> = [];
    const rpcCalls: Array<{ name: string; params: Record<string, unknown> }> = [];
    const query = {
        eq(column: string, value: string) {
            filters.push([column, value]);
            return query;
        },
        async maybeSingle() {
            const organizationFilter = filters.find(([column]) => column === "organization_id")?.[1];
            return {
                data: organizationFilter && organizationFilter !== exam.organizationId
                    ? null
                    : { id: exam.id, organization_id: exam.organizationId, payload: exam },
                error: null,
            };
        },
    };
    const client: StudentExamGatewayClient = {
        from() {
            return { select: () => query };
        },
        async rpc(name, params) {
            rpcCalls.push({ name, params });
            if (options.rpcError) return { data: null, error: { message: options.rpcError } };
            const attemptRow = params.p_attempt as { payload: unknown };
            const payload = attemptRow.payload as Record<string, unknown>;
            return {
                data: [{ payload: options.mutateStoredAttempt ? options.mutateStoredAttempt(payload) : payload }],
                error: null,
            };
        },
    };
    return { client, filters, rpcCalls };
}

async function openAllowedExam(client: StudentExamGatewayClient) {
    return openStudentExamWithGateway(client, {
        examId: exam.id,
        pin: "4321",
        student: {
            studentId: "student-1",
            studentName: "학생 1",
            identityType: "registered",
        },
    }, env, 1_000);
}

describe("student exam server gateway", () => {
    it("requires an authorized opaque assignment for targeted exams and binds it into the ticket", async () => {
        const targetedExam = { ...exam, accessConfig: { type: "targeted" as const } };
        const resolver = vi.fn(async (name: string) => name === "omr_resolve_student_assignment_v1"
            ? {
                data: {
                    status: "authorized", assignmentId: "assignment-1", examId: exam.id,
                    mode: "base", questionIds: [],
                },
                error: null,
            }
            : { data: null, error: { message: "unexpected rpc" } });
        const targetedClient: StudentExamGatewayClient = {
            from() {
                const query = {
                    eq() { return query; },
                    async maybeSingle() {
                        return { data: { id: exam.id, organization_id: "org-1", payload: targetedExam }, error: null };
                    },
                };
                return { select: () => query };
            },
            rpc: resolver,
        };
        const verified = {
            organizationId: "org-1", studentId: "student-1", studentName: "학생 1", identityType: "registered" as const,
        };
        const student = { studentId: "student-1", studentName: "학생 1", identityType: "registered" as const };

        await expect(openStudentExamWithGateway(targetedClient, {
            examId: exam.id, student,
        }, env, 1_000, verified)).resolves.toEqual({ status: "group_denied" });
        await expect(openStudentExamWithGateway(targetedClient, {
            examId: exam.id, assignmentId: "assignment-1", student,
        }, env, 1_000, {
            organizationId: "org-1", studentId: "guest:guest-1", studentName: "게스트",
            identityType: "guest", guestId: "guest-1",
        })).resolves.toEqual({ status: "login_required" });

        const opened = await openStudentExamWithGateway(targetedClient, {
            examId: exam.id, assignmentId: "assignment-1", student,
        }, env, 1_000, verified);
        expect(opened.status).toBe("allowed");
        if (opened.status !== "allowed") return;
        expect(parseStudentAttemptTicket(opened.ticket, env, 1_000)).toMatchObject({
            assignmentId: "assignment-1", studentId: "student-1", examId: exam.id,
        });
        expect(resolver).toHaveBeenCalledWith("omr_resolve_student_assignment_v1", expect.objectContaining({
            p_assignment_id: "assignment-1", p_owner_student_id: "student-1",
        }));
    });

    it("writes one owned student question through the atomic RPC with a stable mutation id", async () => {
        const upsertStudentQuestionWithGateway = (
            studentExamGatewayModule as unknown as {
                upsertStudentQuestionWithGateway?: (
                    client: StudentExamGatewayClient,
                    input: Record<string, unknown>,
                ) => Promise<unknown>;
            }
        ).upsertStudentQuestionWithGateway;
        expect(upsertStudentQuestionWithGateway).toBeTypeOf("function");
        if (!upsertStudentQuestionWithGateway) return;

        const rpcCalls: Array<{ name: string; params: Record<string, unknown> }> = [];
        const storedAttempt: Attempt = {
            id: "attempt-1",
            organizationId: "org-1",
            examId: "exam-1",
            examTitle: "시험",
            studentProfileId: "student-1",
            studentId: "student-1",
            studentName: "학생",
            startedAt: "2026-08-07T00:00:00.000Z",
            finishedAt: "2026-08-07T00:10:00.000Z",
            score: 1,
            totalScore: 1,
            answers: { 1: 2 },
            status: "completed",
            questionResults: [{
                schemaVersion: 1,
                attemptId: "attempt-1",
                examId: "exam-1",
                examTitle: "시험",
                studentId: "student-1",
                studentName: "학생",
                questionId: 1,
                questionNumber: 1,
                score: 1,
                earnedScore: 1,
                status: "correct",
                isCorrect: true,
                isWrong: false,
                isUnanswered: false,
                finishedAt: "2026-08-07T00:10:00.000Z",
            }],
            studentQuestions: [{
                questionId: 1,
                questionNumber: 1,
                body: "왜 정답인가요?",
                createdAt: "2026-08-07T00:11:00.000Z",
                status: "queued",
            }],
        };
        const client: StudentExamGatewayClient = {
            from() { throw new Error("question mutation must not read the attempt first"); },
            async rpc(name, params) {
                rpcCalls.push({ name, params });
                return { data: [{ payload: storedAttempt }], error: null };
            },
        };

        await expect(upsertStudentQuestionWithGateway(client, {
            organizationId: " org-1 ",
            studentId: " student-1 ",
            attemptId: " attempt-1 ",
            question: {
                questionId: 1,
                questionNumber: 999,
                body: " 왜 정답인가요? ",
                clientMutationId: "2026-08-07T00:11:00.000Z",
            },
        })).resolves.toEqual({ status: "saved", attempt: storedAttempt });
        expect(rpcCalls).toHaveLength(1);
        expect(rpcCalls[0]).toMatchObject({
            name: "omr_upsert_student_attempt_question_v1",
            params: {
                p_organization_id: "org-1",
                p_owner_student_id: "student-1",
                p_attempt_id: "attempt-1",
                p_question_id: 1,
                p_body: "왜 정답인가요?",
            },
        });
        expect(rpcCalls[0].params.p_mutation_id).toMatch(/^student-question:[a-f0-9]{64}$/);
        expect(rpcCalls[0].params).not.toHaveProperty("p_question_number");
    });

    it("rejects invalid question payloads before RPC and fails closed on returned scope drift", async () => {
        const upsertStudentQuestionWithGateway = (
            studentExamGatewayModule as unknown as {
                upsertStudentQuestionWithGateway?: (
                    client: StudentExamGatewayClient,
                    input: Record<string, unknown>,
                ) => Promise<unknown>;
            }
        ).upsertStudentQuestionWithGateway;
        expect(upsertStudentQuestionWithGateway).toBeTypeOf("function");
        if (!upsertStudentQuestionWithGateway) return;

        let rpcCalls = 0;
        const client: StudentExamGatewayClient = {
            from() { throw new Error("unexpected read"); },
            async rpc() {
                rpcCalls += 1;
                return {
                    data: [{ payload: {
                        id: "attempt-1",
                        organizationId: "other-org",
                        examId: "exam-1",
                        examTitle: "시험",
                        studentId: "student-1",
                        studentName: "학생",
                        startedAt: "2026-08-07T00:00:00.000Z",
                        finishedAt: "2026-08-07T00:10:00.000Z",
                        score: 0,
                        totalScore: 1,
                        answers: {},
                        status: "completed",
                    } }],
                    error: null,
                };
            },
        };
        const base = {
            organizationId: "org-1",
            studentId: "student-1",
            attemptId: "attempt-1",
        };

        await expect(upsertStudentQuestionWithGateway(client, {
            ...base,
            question: { questionId: 1, questionNumber: 1, body: "x".repeat(501) },
        })).resolves.toEqual({ status: "invalid_request" });
        expect(rpcCalls).toBe(0);

        await expect(upsertStudentQuestionWithGateway(client, {
            ...base,
            question: { questionId: 1, questionNumber: 1, body: "질문" },
        })).resolves.toEqual({
            status: "service_unavailable",
            error: "stored_attempt_scope_mismatch",
        });
        expect(rpcCalls).toBe(1);
    });

    it("does not expose questions or PDF content before access is granted", async () => {
        const { client } = mockClient();
        const preview = await previewStudentExamWithGateway(client, exam.id);
        expect(preview.status).toBe("available");
        expect(JSON.stringify(preview)).not.toContain("questions");
        expect(JSON.stringify(preview)).not.toContain("pdfData");
        expect(JSON.stringify(preview)).not.toContain("secret-answer-key");
    });

    it("returns a signed solve-safe DTO only after server access checks", async () => {
        const { client } = mockClient();
        const denied = await openStudentExamWithGateway(client, {
            examId: exam.id,
            pin: "0000",
            student: { studentId: "student-1", studentName: "학생 1", identityType: "registered" },
        }, env, 1_000);
        expect(denied).toEqual({ status: "pin_required" });

        const allowed = await openAllowedExam(client);
        expect(allowed.status).toBe("allowed");
        if (allowed.status !== "allowed") return;
        const serialized = JSON.stringify(allowed.exam);
        expect(serialized).not.toContain("secret-answer-key");
        expect(serialized).not.toContain("비밀 해설");
        expect(serialized).not.toContain('"answer"');
        expect(serialized).not.toContain("4321");
        expect(allowed.ticket).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
        expect(parseStudentAttemptTicket(allowed.ticket, env, 1_000)).toMatchObject({
            identityType: "guest",
            studentName: "학생 1",
        });
    });

    it("preserves a signed organization-less guest across public exam entry", async () => {
        const { client } = mockClient();
        const opened = await openStudentExamWithGateway(client, {
            examId: exam.id,
            pin: "4321",
            student: {
                studentId: "guest:client-choice",
                studentName: "클라이언트 사칭 이름",
                identityType: "guest",
                guestId: "client-choice",
            },
        }, env, 1_000, {
            organizationId: "",
            studentId: "guest:guest-cookie-1",
            studentName: "게스트 학생",
            identityType: "guest",
            guestId: "guest-cookie-1",
        });

        expect(opened.status).toBe("allowed");
        if (opened.status !== "allowed") return;
        expect(parseStudentAttemptTicket(opened.ticket, env, 1_000)).toMatchObject({
            organizationId: "org-1",
            studentId: "guest:guest-cookie-1",
            studentName: "게스트 학생",
            identityType: "guest",
            guestId: "guest-cookie-1",
        });
    });

    it("rejects a guest session scoped to another organization", async () => {
        const { client } = mockClient();
        await expect(openStudentExamWithGateway(client, {
            examId: exam.id,
            pin: "4321",
            student: {
                studentId: "guest:guest-cookie-1",
                studentName: "게스트 학생",
                identityType: "guest",
                guestId: "guest-cookie-1",
            },
        }, env, 1_000, {
            organizationId: "other-org",
            studentId: "guest:guest-cookie-1",
            studentName: "게스트 학생",
            identityType: "guest",
            guestId: "guest-cookie-1",
        })).resolves.toEqual({ status: "group_denied" });
    });

    it("rejects a signed guest whose canonical student id and guest id disagree", async () => {
        const { client } = mockClient();
        await expect(openStudentExamWithGateway(client, {
            examId: exam.id,
            pin: "4321",
            student: {
                studentId: "guest:client-choice",
                studentName: "클라이언트 이름",
                identityType: "guest",
                guestId: "client-choice",
            },
        }, env, 1_000, {
            organizationId: "",
            studentId: "guest:signed-student-id",
            studentName: "서명된 이름",
            identityType: "guest",
            guestId: "different-signed-guest-id",
        })).resolves.toEqual({ status: "login_required" });
    });

    it("enforces the PIN reservation limit on the compatibility gateway path", async () => {
        const { client } = mockClient();
        const pinExam = { ...exam, id: "exam-compat-pin-limit" };
        const pinClient: StudentExamGatewayClient = {
            ...client,
            from() {
                const query = {
                    eq() { return query; },
                    async maybeSingle() {
                        return { data: { id: pinExam.id, organization_id: pinExam.organizationId, payload: pinExam }, error: null };
                    },
                };
                return { select: () => query };
            },
        };
        const input = {
            examId: pinExam.id,
            pin: "0000",
            student: { studentId: "student-rate-limit", studentName: "학생", identityType: "registered" as const },
        };
        const verifiedStudent = {
            organizationId: "org-1",
            studentId: "student-rate-limit",
            studentName: "학생",
            identityType: "registered" as const,
        };

        for (let attempt = 0; attempt < 5; attempt += 1) {
            await expect(openStudentExamWithGateway(pinClient, input, env, 1_000, verifiedStudent)).resolves.toEqual({ status: "pin_required" });
        }
        await expect(openStudentExamWithGateway(pinClient, input, env, 1_000, verifiedStudent)).resolves.toEqual({ status: "pin_rate_limited" });
    });

    it("atomically caps a concurrent fresh-guest PIN sweep at the global budget", async () => {
        const { client } = mockClient();
        const pinExam = { ...exam, id: "exam-compat-concurrent-global-pin-limit" };
        const pinClient: StudentExamGatewayClient = {
            ...client,
            from() {
                const query = {
                    eq() { return query; },
                    async maybeSingle() {
                        return { data: { id: pinExam.id, organization_id: pinExam.organizationId, payload: pinExam }, error: null };
                    },
                };
                return { select: () => query };
            },
        };
        const attempts = await Promise.all(Array.from({ length: 75 }, (_, index) => openStudentExamWithGateway(pinClient, {
            examId: pinExam.id,
            pin: "0000",
            student: { studentId: `claimed-${index}`, studentName: "학생", identityType: "guest" },
        }, env, 1_000, null, `fresh-guest-${index}`)));

        expect(attempts.filter(result => result.status === "pin_required")).toHaveLength(60);
        expect(attempts.filter(result => result.status === "pin_rate_limited")).toHaveLength(15);
    });

    it("does not trust a client-asserted registered identity for group exams", async () => {
        const { client } = mockClient();
        const groupExam = {
            ...exam,
            accessConfig: { type: "group" as const, groupIds: ["class-a"] },
        };
        const groupClient: StudentExamGatewayClient = {
            ...client,
            from() {
                const query = {
                    eq() { return query; },
                    async maybeSingle() {
                        return { data: { id: groupExam.id, organization_id: groupExam.organizationId, payload: groupExam }, error: null };
                    },
                };
                return { select: () => query };
            },
        };
        const input = {
            examId: groupExam.id,
            student: {
                studentId: "claimed-student",
                studentName: "사칭 학생",
                identityType: "registered" as const,
                groupId: "class-a",
            },
        };

        await expect(openStudentExamWithGateway(groupClient, input, env, 1_000)).resolves.toEqual({
            status: "login_required",
        });
        await expect(openStudentExamWithGateway(groupClient, input, env, 1_000, {
            organizationId: "",
            studentId: "guest:guest-cookie-1",
            studentName: "게스트 학생",
            identityType: "guest",
            guestId: "guest-cookie-1",
        })).resolves.toEqual({ status: "login_required" });
        const verified = await openStudentExamWithGateway(groupClient, input, env, 1_000, {
            organizationId: "org-1",
            studentId: "server-student",
            studentName: "검증 학생",
            identityType: "registered",
            groupId: "class-a",
        });
        expect(verified.status).toBe("allowed");
        if (verified.status === "allowed") {
            expect(parseStudentAttemptTicket(verified.ticket, env, 1_000)).toMatchObject({
                studentId: "server-student",
                studentName: "검증 학생",
                identityType: "registered",
                groupId: "class-a",
            });
        }

        await expect(openStudentExamWithGateway(groupClient, input, env, 1_000, {
            organizationId: "other-org",
            studentId: "server-student",
            studentName: "검증 학생",
            identityType: "registered",
            groupId: "class-a",
        })).resolves.toEqual({ status: "group_denied" });
    });

    it("binds retake question subsets into both the DTO and signed ticket", async () => {
        const { client } = mockClient();
        const sourceAttempt: Attempt = {
            id: "source-1", examId: exam.id, examTitle: exam.title,
            organizationId: "org-1", studentId: "student-1", studentName: "학생 1",
            identityType: "registered", startedAt: "2026-08-05T00:00:00.000Z",
            finishedAt: "2026-08-05T00:10:00.000Z", score: 5, totalScore: 10,
            answers: { 1: 3, 2: 2 }, status: "completed",
            questionResults: [
                { schemaVersion: 1, attemptId: "source-1", examId: exam.id, examTitle: exam.title, studentId: "student-1", studentName: "학생 1", questionId: 1, questionNumber: 1, score: 5, earnedScore: 5, status: "correct", isCorrect: true, isWrong: false, isUnanswered: false, finishedAt: "2026-08-05T00:10:00.000Z" },
                { schemaVersion: 1, attemptId: "source-1", examId: exam.id, examTitle: exam.title, studentId: "student-1", studentName: "학생 1", questionId: 2, questionNumber: 2, score: 5, earnedScore: 0, status: "wrong", isCorrect: false, isWrong: true, isUnanswered: false, finishedAt: "2026-08-05T00:10:00.000Z" },
            ],
        };
        const retakeClient: StudentExamGatewayClient = {
            ...client,
            from(table) {
                if (table !== "omr_attempts") return client.from(table);
                const query = {
                    eq() { return query; },
                    async maybeSingle() { return { data: { payload: sourceAttempt }, error: null }; },
                };
                return { select: () => query };
            },
        };
        const opened = await openStudentExamWithGateway(retakeClient, {
            examId: exam.id,
            pin: "4321",
            retake: { sourceAttemptId: "source-1", mode: "wrong", questionIds: [2] },
            student: { studentId: "student-1", studentName: "학생 1", identityType: "registered" },
        }, env, 1_000, {
            organizationId: "org-1", studentId: "student-1", studentName: "학생 1", identityType: "registered",
        });
        expect(opened.status).toBe("allowed");
        if (opened.status !== "allowed") return;
        expect(opened.exam.questions.map(question => question.id)).toEqual([2]);
        expect(parseStudentAttemptTicket(opened.ticket, env, 1_000)).toMatchObject({
            allowedQuestionIds: [2], retakeSourceAttemptId: "source-1", retakeMode: "wrong",
        });

        await expect(openStudentExamWithGateway(client, {
            examId: exam.id,
            pin: "4321",
            questionIds: [999],
            student: { studentId: "student-1", studentName: "학생 1", identityType: "registered" },
        }, env, 1_000)).resolves.toEqual({ status: "invalid_questions" });
    });

    it("loads the canonical exam with ticket organization scope and persists only server grading", async () => {
        const { client, filters, rpcCalls } = mockClient();
        const opened = await openAllowedExam(client);
        if (opened.status !== "allowed") throw new Error("expected allowed exam");
        const submission: StudentAttemptSubmission = {
            ticket: opened.ticket,
            answers: { 1: 3, 2: 2 },
        };

        const result = await submitStudentAttemptWithGateway(client, submission, env, 2_000);
        expect(result).toMatchObject({
            status: "submitted",
            receipt: {
                score: 5,
                totalScore: 10,
                correctCount: 1,
                incorrectCount: 1,
                questionResults: [
                    { questionId: 1, selectedAnswer: 3, status: "correct", earnedScore: 5 },
                    { questionId: 2, selectedAnswer: 2, status: "wrong", earnedScore: 0 },
                ],
            },
        });
        const serializedReceipt = JSON.stringify(result.status === "submitted" ? result.receipt : result);
        expect(serializedReceipt).not.toContain("correctAnswer");
        expect(serializedReceipt).not.toContain("비밀 해설");
        expect(serializedReceipt).not.toContain("secret-answer-key");
        expect(filters).toContainEqual(["organization_id", "org-1"]);
        expect(rpcCalls).toHaveLength(1);
        expect(rpcCalls[0].name).toBe("omr_submit_attempt_v1");
        expect(rpcCalls[0].params.p_ticket_id).toBeTruthy();
        expect(rpcCalls[0].params.p_attempt).toMatchObject({ score: 5, total_score: 10 });
    });

    it("rejects a tampered ticket before reading or writing canonical data", async () => {
        const { client, rpcCalls } = mockClient();
        const result = await submitStudentAttemptWithGateway(client, {
            ticket: "tampered.ticket",
            answers: { 1: 3 },
        }, env, 2_000);
        expect(result).toEqual({ status: "invalid_ticket" });
        expect(rpcCalls).toHaveLength(0);
    });

    it("does not claim success when the atomic persistence RPC fails", async () => {
        const { client } = mockClient({ rpcError: "database unavailable" });
        const opened = await openAllowedExam(client);
        if (opened.status !== "allowed") throw new Error("expected allowed exam");
        await expect(submitStudentAttemptWithGateway(client, {
            ticket: opened.ticket,
            answers: { 1: 3 },
        }, env, 2_000)).resolves.toEqual({
            status: "service_unavailable",
            error: "database unavailable",
        });
    });

    it("rejects an idempotent RPC payload outside the ticket student or organization scope", async () => {
        const { client } = mockClient({
            mutateStoredAttempt: attempt => ({
                ...attempt,
                organizationId: "other-org",
                studentId: "other-student",
            }),
        });
        const opened = await openAllowedExam(client);
        if (opened.status !== "allowed") throw new Error("expected allowed exam");

        await expect(submitStudentAttemptWithGateway(client, {
            ticket: opened.ticket,
            answers: { 1: 3 },
        }, env, 2_000)).resolves.toEqual({
            status: "service_unavailable",
            error: "stored_attempt_scope_mismatch",
        });
    });
});
