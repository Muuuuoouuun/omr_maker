import { describe, expect, it } from "vitest";
import type { Attempt } from "@/types/omr";
import * as teacherAttemptGateway from "./teacherAttemptGateway";
import {
    listTeacherAttemptsWithGateway,
    loadTeacherAttemptWithGateway,
    type TeacherAttemptGatewayClient,
} from "./teacherAttemptGateway";

const attempt: Attempt = {
    id: "attempt-1",
    examId: "exam-1",
    examTitle: "시험",
    organizationId: "org-a",
    studentName: "학생",
    startedAt: "2026-07-14T00:00:00.000Z",
    finishedAt: "2026-07-14T00:01:00.000Z",
    score: 1,
    totalScore: 1,
    answers: { 1: 2 },
    status: "completed",
};

function clientWithRows(rows: unknown[]): { client: TeacherAttemptGatewayClient; filters: Array<[string, string]> } {
    const filters: Array<[string, string]> = [];
    const query = {
        eq(column: string, value: string) {
            filters.push([column, value]);
            return query;
        },
        async maybeSingle() {
            return { data: rows[0] || null, error: null };
        },
        async order() {
            return { data: rows, error: null };
        },
    };
    return {
        filters,
        client: { from: () => ({ select: () => query }) } as unknown as TeacherAttemptGatewayClient,
    };
}

describe("teacher attempt gateway", () => {
    it("lists attempts only through the server-owned organization filter", async () => {
        const { client, filters } = clientWithRows([{ payload: attempt }]);
        await expect(listTeacherAttemptsWithGateway(client, {
            organizationId: "org-a",
            organizationName: "Org A",
        })).resolves.toMatchObject({ status: "loaded", attempts: [{ id: "attempt-1" }] });
        expect(filters).toContainEqual(["organization_id", "org-a"]);
    });

    it("narrows live polling to the selected exam", async () => {
        const { client, filters } = clientWithRows([{ payload: attempt }]);
        await expect(listTeacherAttemptsWithGateway(client, {
            organizationId: "org-a",
            organizationName: "Org A",
        }, "exam-1")).resolves.toMatchObject({ status: "loaded" });
        expect(filters).toEqual([
            ["organization_id", "org-a"],
            ["exam_id", "exam-1"],
        ]);
    });

    it("loads an attempt with both organization and attempt id filters", async () => {
        const { client, filters } = clientWithRows([{ payload: attempt }]);
        await expect(loadTeacherAttemptWithGateway(client, "attempt-1", {
            organizationId: "org-a",
            organizationName: "Org A",
        })).resolves.toMatchObject({ status: "loaded", attempt: { id: "attempt-1" } });
        expect(filters).toEqual([
            ["organization_id", "org-a"],
            ["id", "attempt-1"],
        ]);
    });

    it("does not expose the superseded full-attempt mutation gateway", () => {
        expect("saveTeacherAttemptWithGateway" in teacherAttemptGateway).toBe(false);
    });

    it("answers one student question without forwarding tampered canonical fields", async () => {
        const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
        const client = {
            async rpc(name: string, args: Record<string, unknown>) {
                calls.push({ name, args });
                return {
                    data: [{
                        payload: {
                            ...attempt,
                            score: 1,
                            studentId: "student-original",
                            questionResults: [{ questionId: 1, score: 1 }],
                        },
                    }],
                    error: null,
                };
            },
        } as unknown as TeacherAttemptGatewayClient;
        const scoped = teacherAttemptGateway as unknown as {
            answerTeacherAttemptQuestionWithGateway?: (
                client: TeacherAttemptGatewayClient,
                input: Record<string, unknown>,
                context: Record<string, unknown>,
            ) => Promise<unknown>;
        };
        expect(scoped.answerTeacherAttemptQuestionWithGateway).toBeTypeOf("function");
        if (!scoped.answerTeacherAttemptQuestionWithGateway) return;

        await expect(scoped.answerTeacherAttemptQuestionWithGateway(client, {
            attemptId: "attempt-1",
            questionId: "1",
            answer: "  설명입니다.  ",
            score: 999,
            studentId: "student-attacker",
            questionResults: [{ questionId: 1, score: 999 }],
        }, {
            organizationId: "org-a",
            organizationName: "Org A",
            actorUserId: "teacher-1",
            actorLabel: "김 선생",
            memberRole: "teacher",
        })).resolves.toMatchObject({
            status: "saved",
            attempt: {
                score: 1,
                studentId: "student-original",
                questionResults: [{ questionId: 1, score: 1 }],
            },
        });
        expect(calls).toEqual([{
            name: "omr_answer_attempt_question_v1",
            args: {
                p_organization_id: "org-a",
                p_attempt_id: "attempt-1",
                p_question_id: "1",
                p_answer: "설명입니다.",
                p_actor_user_id: "teacher-1",
                p_member_role: "teacher",
                p_actor_label: "김 선생",
            },
        }]);
    });

    it("updates one subquestion review status with an unambiguous parent path", async () => {
        const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
        const client = {
            async rpc(name: string, args: Record<string, unknown>) {
                calls.push({ name, args });
                return { data: [{ payload: attempt }], error: null };
            },
        } as unknown as TeacherAttemptGatewayClient;
        const scoped = teacherAttemptGateway as unknown as {
            setTeacherAttemptSubquestionReviewWithGateway?: (
                client: TeacherAttemptGatewayClient,
                input: Record<string, unknown>,
                context: Record<string, unknown>,
            ) => Promise<unknown>;
        };
        expect(scoped.setTeacherAttemptSubquestionReviewWithGateway).toBeTypeOf("function");
        if (!scoped.setTeacherAttemptSubquestionReviewWithGateway) return;

        await scoped.setTeacherAttemptSubquestionReviewWithGateway(client, {
            attemptId: "attempt-1",
            questionId: 7,
            subquestionId: "reason",
            status: "reviewed",
            score: 999,
        }, {
            organizationId: "org-a",
            organizationName: "Org A",
            actorUserId: "teacher-1",
            actorLabel: "김 선생",
            memberRole: "teacher",
        });
        expect(calls).toEqual([{
            name: "omr_set_subquestion_review_v1",
            args: {
                p_organization_id: "org-a",
                p_attempt_id: "attempt-1",
                p_subquestion_id: "7:reason",
                p_status: "reviewed",
                p_actor_user_id: "teacher-1",
                p_member_role: "teacher",
                p_actor_label: "김 선생",
            },
        }]);
    });

    it("loads canonical attempts and exams before force-finishing with trusted grading", async () => {
        const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
        const inProgress: Attempt = {
            ...attempt,
            status: "in_progress",
            score: 0,
            totalScore: 0,
            answers: { 1: 2 },
            questionResults: [],
            classId: "class-a",
        };
        const canonicalExam = {
            id: "exam-1",
            organizationId: "org-a",
            classId: "class-a",
            title: "시험",
            createdAt: "2026-07-14T00:00:00.000Z",
            updatedAt: "2026-07-14T00:00:30.000Z",
            questions: [
                { id: 1, number: 1, answer: 2, score: 4, choices: 5 },
                { id: 2, number: 2, answer: 3, score: 6, choices: 5 },
            ],
        };
        const client = {
            from(table: string) {
                const filters: Array<[string, unknown]> = [];
                const query = {
                    eq(column: string, value: unknown) {
                        filters.push([column, value]);
                        return query;
                    },
                    in(column: string, value: unknown) {
                        filters.push([column, value]);
                        return query;
                    },
                    async order() {
                        return table === "omr_attempts"
                            ? { data: [{ payload: inProgress, updated_at: "2026-07-14T00:00:20.000Z" }], error: null }
                            : { data: [{ payload: canonicalExam, updated_at: canonicalExam.updatedAt }], error: null };
                    },
                };
                return { select: () => query };
            },
            async rpc(name: string, args: Record<string, unknown>) {
                calls.push({ name, args });
                return {
                    data: [{
                        payload: {
                            ...inProgress,
                            status: "completed",
                            score: 4,
                            totalScore: 10,
                            finishedAt: "2026-07-14T00:02:00.000Z",
                        },
                    }],
                    error: null,
                };
            },
        } as unknown as TeacherAttemptGatewayClient;
        const scoped = teacherAttemptGateway as unknown as {
            forceFinishTeacherAttemptsWithGateway?: (
                client: TeacherAttemptGatewayClient,
                input: Record<string, unknown>,
                context: Record<string, unknown>,
            ) => Promise<unknown>;
        };
        expect(scoped.forceFinishTeacherAttemptsWithGateway).toBeTypeOf("function");
        if (!scoped.forceFinishTeacherAttemptsWithGateway) return;

        await scoped.forceFinishTeacherAttemptsWithGateway(client, {
            attemptIds: ["attempt-1", "attempt-1", " attempt-1 "],
            finishedAt: "2026-07-14T00:02:00.000Z",
            score: 999,
            questionResults: [{ questionId: 1, score: 999 }],
        }, {
            organizationId: "org-a",
            organizationName: "Org A",
            actorUserId: "teacher-1",
            actorLabel: "관리자",
            memberRole: "admin",
        });
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({
            name: "omr_force_finish_attempts_v1",
            args: {
                p_organization_id: "org-a",
                p_attempt_ids: ["attempt-1"],
                p_finished_at: "2026-07-14T00:02:00.000Z",
                p_actor_user_id: "teacher-1",
                p_member_role: "admin",
                p_actor_label: "관리자",
            },
        });
        expect(calls[0].args.p_gradings).toEqual([
            expect.objectContaining({
                attempt_id: "attempt-1",
                expected_answers: { 1: 2 },
                expected_exam_updated_at: canonicalExam.updatedAt,
                score: 4,
                total_score: 10,
                question_results: [
                    expect.objectContaining({ questionId: 1, status: "correct" }),
                    expect.objectContaining({ questionId: 2, status: "unanswered" }),
                ],
                question_result_rows: [
                    expect.objectContaining({ attempt_id: "attempt-1", question_id: 1, status: "correct" }),
                    expect.objectContaining({ attempt_id: "attempt-1", question_id: 2, status: "unanswered" }),
                ],
            }),
        ]);
    });

    it("rejects viewer mutations before calling the service-role RPC", async () => {
        const client = {
            async rpc() {
                throw new Error("must not be called");
            },
        } as unknown as TeacherAttemptGatewayClient;
        const scoped = teacherAttemptGateway as unknown as {
            answerTeacherAttemptQuestionWithGateway?: (
                client: TeacherAttemptGatewayClient,
                input: Record<string, unknown>,
                context: Record<string, unknown>,
            ) => Promise<unknown>;
        };
        expect(scoped.answerTeacherAttemptQuestionWithGateway).toBeTypeOf("function");
        if (!scoped.answerTeacherAttemptQuestionWithGateway) return;

        await expect(scoped.answerTeacherAttemptQuestionWithGateway(client, {
            attemptId: "attempt-1",
            questionId: "1",
            answer: "설명",
        }, {
            organizationId: "org-a",
            organizationName: "Org A",
            actorUserId: "viewer-1",
            memberRole: "viewer",
        })).resolves.toMatchObject({ status: "forbidden" });
    });
});
