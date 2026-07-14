import { describe, expect, it } from "vitest";
import { attemptToSupabaseRow, examToSupabaseRow } from "@/lib/omrPersistence";
import type { StudentServerSession } from "@/lib/studentServerSession";
import type { Attempt, Exam } from "@/types/omr";
import {
    listStudentAttemptsWithGateway,
    loadStudentAttemptWithGateway,
    type StudentAttemptReadGatewayClient,
} from "./studentAttemptReadGateway";

const session: StudentServerSession = {
    audience: "omr-student",
    schemaVersion: 1,
    organizationId: "org-1",
    studentId: "student-1",
    studentName: "학생 1",
    identityType: "registered",
    issuedAt: 1_000,
    expiresAt: 99_000,
};

const attempt: Attempt = {
    id: "attempt-1",
    examId: "exam-1",
    examTitle: "공식 시험",
    organizationId: "org-1",
    studentProfileId: "student-1",
    studentId: "student-1",
    studentName: "학생 1",
    identityType: "registered",
    startedAt: "2026-07-14T00:00:00.000Z",
    finishedAt: "2026-07-14T01:00:00.000Z",
    score: 5,
    totalScore: 10,
    answers: { 1: 3, 2: 2 },
    status: "completed",
    questionResults: [
        {
            schemaVersion: 1,
            attemptId: "attempt-1",
            examId: "exam-1",
            examTitle: "공식 시험",
            studentName: "학생 1",
            studentId: "student-1",
            identityType: "registered",
            questionId: 1,
            questionNumber: 1,
            score: 5,
            earnedScore: 5,
            selectedAnswer: 3,
            correctAnswer: 3,
            status: "correct",
            isCorrect: true,
            isWrong: false,
            isUnanswered: false,
            concept: "교사용 비밀 개념",
            finishedAt: "2026-07-14T01:00:00.000Z",
        },
        {
            schemaVersion: 1,
            attemptId: "attempt-1",
            examId: "exam-1",
            examTitle: "공식 시험",
            studentName: "학생 1",
            studentId: "student-1",
            identityType: "registered",
            questionId: 2,
            questionNumber: 2,
            score: 5,
            earnedScore: 0,
            selectedAnswer: 2,
            correctAnswer: 1,
            status: "wrong",
            isCorrect: false,
            isWrong: true,
            isUnanswered: false,
            finishedAt: "2026-07-14T01:00:00.000Z",
        },
    ],
};

const exam: Exam = {
    id: "exam-1",
    title: "공식 시험",
    organizationId: "org-1",
    createdAt: "2026-07-13T00:00:00.000Z",
    answerKeyPdf: "data:application/pdf;base64,secret-answer-key",
    questions: [
        { id: 1, number: 1, answer: 3, score: 5, choices: 5, explanation: "비밀 해설" },
        { id: 2, number: 2, answer: 1, score: 5, choices: 4 },
    ],
};

function mockClient(options: {
    attemptRows?: unknown[];
    singleAttempt?: unknown;
    examRow?: unknown;
} = {}) {
    const calls: Array<{ table: string; filters: Array<[string, string]>; mode: "list" | "single" }> = [];
    const client: StudentAttemptReadGatewayClient = {
        from(table) {
            return {
                select() {
                    const filters: Array<[string, string]> = [];
                    const query = {
                        eq(column: string, value: string) {
                            filters.push([column, value]);
                            return query;
                        },
                        async order() {
                            calls.push({ table, filters: [...filters], mode: "list" });
                            return { data: options.attemptRows ?? [attemptToSupabaseRow(attempt)], error: null };
                        },
                        async maybeSingle() {
                            calls.push({ table, filters: [...filters], mode: "single" });
                            if (table === "omr_exams") {
                                return { data: options.examRow === undefined ? examToSupabaseRow(exam) : options.examRow, error: null };
                            }
                            return {
                                data: options.singleAttempt === undefined ? attemptToSupabaseRow(attempt) : options.singleAttempt,
                                error: null,
                            };
                        },
                    };
                    return query;
                },
            };
        },
    };
    return { client, calls };
}

describe("student attempt read gateway", () => {
    it("lists only completed attempts scoped by both HttpOnly-session organization and student", async () => {
        const { client, calls } = mockClient();
        const result = await listStudentAttemptsWithGateway(client, session);
        expect(result.status).toBe("loaded");
        expect(calls[0].filters).toEqual(expect.arrayContaining([
            ["organization_id", "org-1"],
            ["student_profile_id", "student-1"],
            ["student_id", "student-1"],
            ["status", "completed"],
        ]));
        const serialized = JSON.stringify(result);
        expect(serialized).not.toContain("correctAnswer");
        expect(serialized).not.toContain("교사용 비밀 개념");
        expect(serialized).not.toContain("secret-answer-key");
    });

    it("returns an answer-key-free review exam and official per-question statuses", async () => {
        const { client, calls } = mockClient();
        const result = await loadStudentAttemptWithGateway(client, "attempt-1", session);
        expect(result).toMatchObject({
            status: "loaded",
            detail: {
                attempt: {
                    score: 5,
                    questionResults: [
                        { questionId: 1, selectedAnswer: 3, status: "correct" },
                        { questionId: 2, selectedAnswer: 2, status: "wrong" },
                    ],
                },
                exam: { id: "exam-1", questions: [{ id: 1 }, { id: 2 }] },
            },
        });
        expect(calls[0].filters).toContainEqual(["id", "attempt-1"]);
        expect(calls[1].filters).toEqual(expect.arrayContaining([
            ["organization_id", "org-1"],
            ["id", "exam-1"],
        ]));
        const serialized = JSON.stringify(result);
        expect(serialized).not.toContain('"answer"');
        expect(serialized).not.toContain("비밀 해설");
        expect(serialized).not.toContain("secret-answer-key");
    });

    it("fails closed if a service response contains another student or organization payload", async () => {
        const crossStudent = attemptToSupabaseRow({
            ...attempt,
            organizationId: "other-org",
            studentProfileId: "other-student",
            studentId: "other-student",
            studentName: "다른 학생",
            questionResults: attempt.questionResults?.map(result => ({
                ...result,
                studentId: "other-student",
                studentName: "다른 학생",
            })),
        });
        const { client } = mockClient({ singleAttempt: crossStudent });
        await expect(loadStudentAttemptWithGateway(client, "attempt-1", session)).resolves.toEqual({
            status: "service_unavailable",
            error: "Invalid scoped student attempt",
        });
    });

    it("returns not_found without exposing any local or cross-student record", async () => {
        const { client } = mockClient({ singleAttempt: null });
        await expect(loadStudentAttemptWithGateway(client, "missing", session)).resolves.toEqual({
            status: "not_found",
        });
    });
});
