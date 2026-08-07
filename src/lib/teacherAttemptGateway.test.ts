import { describe, expect, it } from "vitest";
import { INITIAL_OPERATIONS_LIMITS } from "@/lib/initialOperationsPolicy";
import { attemptToSupabaseRow } from "@/lib/omrPersistence";
import type { Attempt } from "@/types/omr";
import * as teacherAttemptGateway from "./teacherAttemptGateway";
import {
    listTeacherAttemptSummariesWithGateway,
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

function attemptListRow(item: Attempt) {
    const row = { ...attemptToSupabaseRow(item) };
    Reflect.deleteProperty(row, "payload");
    return {
        ...row,
        exam_title: item.examTitle,
        guest_id: item.guestId,
        answers: item.answers,
        question_results: item.questionResults,
        question_timings: item.questionTimings,
        focus_loss_events: item.focusLossEvents,
        student_questions: item.studentQuestions,
        auto_submitted: item.autoSubmitted,
        tab_foci_lost_count: item.tabFociLostCount,
        drawings_ref: item.drawingsRef,
        handwriting: item.handwriting,
        handwriting_archived: item.handwritingArchived,
        handwriting_plan: item.handwritingPlan,
        drawing_page_count: item.drawingPageCount,
        drawing_stroke_count: item.drawingStrokeCount,
        question_drawings: item.questionDrawings,
        retake: item.retake,
    };
}

function clientWithRows(rows: unknown[]): { client: TeacherAttemptGatewayClient; filters: Array<[string, string]> } {
    const filters: Array<[string, string]> = [];
    return {
        filters,
        client: {
            from: () => ({
                select: () => {
                    let afterId = "";
                    const query = {
                        eq(column: string, value: string) {
                            filters.push([column, value]);
                            return query;
                        },
                        gt(_column: string, value: string) {
                            afterId = value;
                            return query;
                        },
                        async maybeSingle() {
                            return { data: rows[0] || null, error: null };
                        },
                        order() { return query; },
                        async limit(value: number) {
                            return {
                                data: rows.filter(row => {
                                    const record = row as { id?: string; payload?: { id?: string } };
                                    return (record.id || record.payload?.id || "") > afterId;
                                }).slice(0, value),
                                error: null,
                            };
                        },
                    };
                    return query;
                },
            }),
        } as unknown as TeacherAttemptGatewayClient,
    };
}

describe("teacher attempt gateway", () => {
    it("lists lightweight summaries through the same organization/exam keyset boundary", async () => {
        const selected: string[] = [];
        const filters: Array<[string, string]> = [];
        const row = attemptListRow(attempt);
        const client = {
            from() {
                const query = {
                    eq(column: string, value: string) { filters.push([column, value]); return query; },
                    gt() { return query; },
                    order() { return query; },
                    async limit() { return { data: [row], error: null }; },
                };
                return { select(columns: string) { selected.push(columns); return query; } };
            },
        } as unknown as TeacherAttemptGatewayClient;

        const result = await listTeacherAttemptSummariesWithGateway(client, {
            organizationId: "org-a",
            organizationName: "Org A",
        }, "exam-1");

        expect(filters).toEqual([
            ["organization_id", "org-a"],
            ["exam_id", "exam-1"],
        ]);
        expect(selected[0]).not.toMatch(/answers:|question_results:|question_timings:|focus_loss_events:|handwriting:payload|question_drawings:/);
        expect(result).toMatchObject({
            status: "loaded",
            attempts: [{ id: "attempt-1", detailLevel: "summary", answers: {} }],
        });
    });

    it("lists attempts only through the server-owned organization filter", async () => {
        const { client, filters } = clientWithRows([attemptListRow(attempt)]);
        await expect(listTeacherAttemptsWithGateway(client, {
            organizationId: "org-a",
            organizationName: "Org A",
        })).resolves.toMatchObject({ status: "loaded", attempts: [{ id: "attempt-1" }] });
        expect(filters).toContainEqual(["organization_id", "org-a"]);
    });

    it("narrows live polling to the selected exam", async () => {
        const { client, filters } = clientWithRows([attemptListRow(attempt)]);
        await expect(listTeacherAttemptsWithGateway(client, {
            organizationId: "org-a",
            organizationName: "Org A",
        }, "exam-1")).resolves.toMatchObject({ status: "loaded" });
        expect(filters).toEqual([
            ["organization_id", "org-a"],
            ["exam_id", "exam-1"],
        ]);
    });

    it("uses the indexed newest-first boundary after organization and exam scopes", async () => {
        const calls: Array<[string, ...unknown[]]> = [];
        const rows = Array.from({ length: INITIAL_OPERATIONS_LIMITS.listPageSize + 1 }, (_, index) => attemptListRow({
                ...attempt,
                id: `attempt-${String(index).padStart(4, "0")}`,
                finishedAt: index % 2 === 0 ? "2026-07-14T00:02:00.000Z" : "2026-07-14T00:01:00.000Z",
        }));
        const client = {
            from() {
                const query = {
                    eq(column: string, value: string) {
                        calls.push(["eq", column, value]);
                        return query;
                    },
                    gt() { return query; },
                    order(column: string, options: { ascending: boolean }) {
                        calls.push(["order", column, options]);
                        return query;
                    },
                    async limit(value: number) {
                        calls.push(["limit", value]);
                        return {
                            data: rows.slice(0, value),
                            error: null,
                        };
                    },
                    async range(from: number, to: number) {
                        calls.push(["range", from, to]);
                        return {
                            data: [...rows]
                                .sort((left, right) => right.finished_at.localeCompare(left.finished_at)
                                    || right.id.localeCompare(left.id))
                                .slice(from, to + 1),
                            error: null,
                        };
                    },
                };
                return { select: () => query };
            },
        } as unknown as TeacherAttemptGatewayClient;

        await expect(listTeacherAttemptsWithGateway(client, {
            organizationId: "org-a",
            organizationName: "Org A",
        }, "exam-1")).resolves.toMatchObject({ status: "loaded", attempts: { length: rows.length } });

        expect(calls.slice(0, 3)).toEqual([
            ["eq", "organization_id", "org-a"],
            ["eq", "exam_id", "exam-1"],
            ["order", "finished_at", { ascending: false }],
        ]);
        expect(calls.filter(([method]) => method === "order").slice(0, 2)).toEqual([
            ["order", "finished_at", { ascending: false }],
            ["order", "id", { ascending: false }],
        ]);
        expect(calls.filter(([method]) => method === "range")).toEqual([
            ["range", 0, INITIAL_OPERATIONS_LIMITS.listPageSize - 1],
            ["range", INITIAL_OPERATIONS_LIMITS.listPageSize, (INITIAL_OPERATIONS_LIMITS.listPageSize * 2) - 1],
        ]);

        const result = await listTeacherAttemptsWithGateway(client, {
            organizationId: "org-a",
            organizationName: "Org A",
        }, "exam-1");
        expect(result.status).toBe("loaded");
        if (result.status === "loaded") {
            expect(result.attempts.slice(0, 3).map(item => item.id)).toEqual([
                "attempt-0000",
                "attempt-0002",
                "attempt-0004",
            ]);
        }
    });

    it("reads at most the teacher attempt ceiling plus one and reports a usable partial page", async () => {
        const ranges: Array<[number, number]> = [];
        const total = INITIAL_OPERATIONS_LIMITS.teacherAttempts + 1;
        const rows = Array.from({ length: total }, (_, index) => attemptListRow({
            ...attempt,
            id: `attempt-${String(index).padStart(5, "0")}`,
        }));
        const client = {
            from() {
                const query = {
                    eq() { return query; },
                    gt() { return query; },
                    order() { return query; },
                    async limit(value: number) {
                        return { data: rows.slice(0, value), error: null };
                    },
                    async range(from: number, to: number) {
                        ranges.push([from, to]);
                        return {
                            data: [...rows]
                                .sort((left, right) => right.id.localeCompare(left.id))
                                .slice(from, to + 1),
                            error: null,
                        };
                    },
                };
                return { select: () => query };
            },
        } as unknown as TeacherAttemptGatewayClient;

        await expect(listTeacherAttemptsWithGateway(client, {
            organizationId: "org-a",
            organizationName: "Org A",
        })).resolves.toMatchObject({
            status: "loaded",
            attempts: { length: INITIAL_OPERATIONS_LIMITS.teacherAttempts },
            page: { partial: true, hasMore: true },
        });
        expect(ranges).toHaveLength(9);
        expect(ranges.at(-1)).toEqual([
            INITIAL_OPERATIONS_LIMITS.teacherAttempts,
            INITIAL_OPERATIONS_LIMITS.teacherAttempts,
        ]);
    });

    it("preserves deterministic ordering without skip or duplicate across bounded ranges", async () => {
        const dataset = Array.from({ length: 300 }, (_, index) => attemptListRow({
            ...attempt,
            id: `attempt-${String(index).padStart(4, "0")}`,
        }));
        let requests = 0;
        const client = {
            from() {
                const query = {
                    eq() { return query; },
                    gt() { return query; },
                    order() { return query; },
                    async limit(value: number) {
                        requests += 1;
                        return { data: dataset.slice(0, value), error: null };
                    },
                    async range(from: number, to: number) {
                        requests += 1;
                        return {
                            data: [...dataset]
                                .sort((left, right) => right.id.localeCompare(left.id))
                                .slice(from, to + 1),
                            error: null,
                        };
                    },
                };
                return { select: () => query };
            },
        } as unknown as TeacherAttemptGatewayClient;

        const result = await listTeacherAttemptsWithGateway(client, {
            organizationId: "org-a",
            organizationName: "Org A",
        });
        expect(result.status).toBe("loaded");
        if (result.status === "loaded") {
            const ids = result.attempts.map(item => item.id);
            expect(new Set(ids).size).toBe(ids.length);
            expect(ids).toContain("attempt-0250");
            expect(ids).toHaveLength(300);
            expect(requests).toBe(2);
        }
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
                expected_is_retake: false,
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
