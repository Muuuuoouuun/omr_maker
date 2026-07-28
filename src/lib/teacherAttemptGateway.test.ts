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
            memberRole: "teacher",
        });
        expect(calls).toEqual([{
            name: "omr_set_subquestion_review_v1",
            args: {
                p_organization_id: "org-a",
                p_attempt_id: "attempt-1",
                p_subquestion_id: "7:reason",
                p_status: "reviewed",
            },
        }]);
    });

    it("force-finishes only selected IDs and never forwards score or question results", async () => {
        const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
        const client = {
            async rpc(name: string, args: Record<string, unknown>) {
                calls.push({ name, args });
                return { data: [{ payload: attempt }], error: null };
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
            attemptIds: ["attempt-1", "attempt-1", " attempt-2 "],
            finishedAt: "2026-07-14T00:02:00.000Z",
            score: 999,
            questionResults: [{ questionId: 1, score: 999 }],
        }, {
            organizationId: "org-a",
            organizationName: "Org A",
            actorUserId: "teacher-1",
            memberRole: "admin",
        });
        expect(calls).toEqual([{
            name: "omr_force_finish_attempts_v1",
            args: {
                p_organization_id: "org-a",
                p_attempt_ids: ["attempt-1", "attempt-2"],
                p_finished_at: "2026-07-14T00:02:00.000Z",
            },
        }]);
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
