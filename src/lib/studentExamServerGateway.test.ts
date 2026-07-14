import { describe, expect, it } from "vitest";
import type { Exam } from "@/types/omr";
import type { StudentAttemptSubmission } from "./studentExamContract";
import { parseStudentAttemptTicket } from "./studentAttemptTicket";
import {
    openStudentExamWithGateway,
    previewStudentExamWithGateway,
    submitStudentAttemptWithGateway,
    type StudentExamGatewayClient,
} from "./studentExamServerGateway";

const env = { NODE_ENV: "production", STUDENT_ATTEMPT_SECRET: "gateway-test-secret" };
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
        const opened = await openStudentExamWithGateway(client, {
            examId: exam.id,
            pin: "4321",
            questionIds: [2],
            student: { studentId: "student-1", studentName: "학생 1", identityType: "registered" },
        }, env, 1_000);
        expect(opened.status).toBe("allowed");
        if (opened.status !== "allowed") return;
        expect(opened.exam.questions.map(question => question.id)).toEqual([2]);
        expect(parseStudentAttemptTicket(opened.ticket, env, 1_000)?.allowedQuestionIds).toEqual([2]);

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
