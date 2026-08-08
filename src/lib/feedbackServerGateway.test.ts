import { describe, expect, it } from "vitest";
import {
    FEEDBACK_COMMENT_MAX_BYTES,
    FEEDBACK_COMMENT_MAX_COUNT,
    FEEDBACK_METADATA_MAX_BYTES,
    FEEDBACK_MARKUP_MAX_PATH_LENGTH,
    FEEDBACK_SUMMARY_MAX_BYTES,
    listStudentFeedbackWithGateway,
    loadStudentFeedbackWithGateway,
    loadTeacherFeedbackWithGateway,
    markStudentFeedbackOpenedWithGateway,
    returnTeacherFeedbackWithGateway,
    saveTeacherFeedbackWithGateway,
    type FeedbackGatewayClient,
} from "./feedbackServerGateway";
import { feedbackToSupabaseRow } from "./feedbackPersistence";
import type { AttemptFeedback } from "@/types/omr";
import { INITIAL_OPERATIONS_LIMITS } from "./initialOperationsPolicy";

const context = {
    organizationId: "pilot_org_0123456789abcdef01234567",
    organizationName: "조직 1",
    actorUserId: "teacher_0123456789abcdef",
    accountId: "teacher_0123456789abcdef",
    accountSessionGeneration: 3,
    sessionAuthority: "account" as const,
};

const feedback: AttemptFeedback = {
    id: "feedback:attempt-1",
    attemptId: "attempt-1",
    examId: "exam-1",
    organizationId: "org-1",
    studentProfileId: "student-1",
    teacherUserId: "teacher-1",
    status: "returned",
    revision: 2,
    summary: "잘했습니다.",
    questionComments: [
        { id: "visible", questionId: 1, questionNumber: 1, body: "다시 확인", visibility: "student_visible" },
        { id: "private", questionId: 1, questionNumber: 1, body: "교사 메모", visibility: "teacher_only" },
    ],
    downloadPolicy: {
        allowStudentDownload: false,
        allowAnnotatedPdfDownload: false,
        watermarkStudentName: true,
    },
    delivery: { notificationStatus: "queued", notificationChannel: "in_app", openCount: 0 },
    returnedAt: "2026-07-14T01:00:00.000Z",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T01:00:00.000Z",
};

function returnedRow() {
    return { ...feedbackToSupabaseRow(feedback, context, { 1: ["M 0 0 L 1 1"] }), revision: 2 };
}

function mockClient(row = returnedRow()) {
    const filters: Array<[string, string]> = [];
    const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const selects: string[] = [];
    const limits: number[] = [];
    const query = {
        eq(column: string, value: string) {
            filters.push([column, value]);
            return query;
        },
        async maybeSingle() {
            return { data: row, error: null };
        },
        order() {
            return query;
        },
        async limit(value: number) {
            limits.push(value);
            return { data: [row], error: null };
        },
    };
    const client: FeedbackGatewayClient = {
        from() {
            return { select: (columns: string) => { selects.push(columns); return query; } };
        },
        async rpc(name, args) {
            rpcCalls.push({ name, args });
            if (name === "omr_save_feedback_v4") {
                const persisted = { ...(args.p_feedback as Record<string, unknown>) };
                delete persisted.markup_drawings;
                return {
                    data: {
                        status: "saved",
                        revision: 3,
                        updatedAt: "2026-07-14T02:00:00.000Z",
                        feedback: {
                            ...persisted,
                            revision: 3,
                            updated_at: "2026-07-14T02:00:00.000Z",
                        },
                    },
                    error: null,
                };
            }
            if (name === "omr_return_feedback_v4") {
                const persisted = { ...row };
                delete persisted.markup_drawings;
                return {
                    data: {
                        status: "returned",
                        revision: 3,
                        updatedAt: "2026-07-14T02:00:00.000Z",
                        feedback: { ...persisted, status: "returned", revision: 3 },
                    },
                    error: null,
                };
            }
            return { data: row, error: null };
        },
    };
    return { client, filters, rpcCalls, selects, limits };
}

describe("feedback server gateway", () => {
    it("overrides client organization and teacher identity before atomic save", async () => {
        const { client, rpcCalls } = mockClient();
        const result = await saveTeacherFeedbackWithGateway(client, {
            ...feedback,
            organizationId: "attacker-org",
            teacherUserId: "attacker-user",
        }, context, { 1: ["stroke"] });

        expect(result.status).toBe("saved");
        expect(rpcCalls).toHaveLength(1);
        expect(rpcCalls[0]).toMatchObject({
            name: "omr_save_feedback_v4",
            args: {
                p_session_authority: "account",
                p_account_id: context.accountId,
                p_session_generation: 3,
                p_actor_user_id: context.actorUserId,
                p_organization_id: context.organizationId,
                p_expected_revision: 2,
                p_feedback: {
                    organization_id: context.organizationId,
                    teacher_user_id: context.actorUserId,
                    status: "draft",
                    markup_drawings: { 1: ["stroke"] },
                },
            },
        });
        expect(rpcCalls[0].args.p_mutation_id).toMatch(/^feedback-save:[a-f0-9]{64}$/);
        expect(result).toMatchObject({ status: "saved", item: { feedback: { revision: 3 } } });
        expect(result.status === "saved" ? result.item.markupDrawings : undefined).toEqual({ 1: ["stroke"] });
    });

    it("scopes teacher reads and return mutation to the server organization", async () => {
        const { client, filters, rpcCalls } = mockClient();
        await expect(loadTeacherFeedbackWithGateway(client, "attempt-1", context)).resolves.toMatchObject({
            status: "loaded",
            item: { feedback: { id: feedback.id } },
        });
        await expect(returnTeacherFeedbackWithGateway(client, feedback, context)).resolves.toMatchObject({
            status: "returned",
        });
        expect(filters).toContainEqual(["organization_id", context.organizationId]);
        expect(rpcCalls[0]).toMatchObject({
            name: "omr_return_feedback_v4",
            args: {
                p_session_authority: "account",
                p_account_id: context.accountId,
                p_session_generation: 3,
                p_actor_user_id: context.actorUserId,
                p_organization_id: context.organizationId,
                p_feedback_id: feedback.id,
                p_expected_revision: 2,
            },
        });
        expect(rpcCalls[0].args.p_mutation_id).toMatch(/^feedback-return:[a-f0-9]{64}$/);
    });

    it("preserves the remote markup pointer in a minimal return receipt envelope", async () => {
        const withPointer = {
            ...feedback,
            markup: {
                schemaVersion: 1 as const,
                pageCount: 1,
                strokeCount: 1,
                storage: "supabase_storage" as const,
            },
        };
        const { client } = mockClient({
            ...feedbackToSupabaseRow(withPointer, context, { 1: ["stroke"] }),
            revision: 2,
        });

        const result = await returnTeacherFeedbackWithGateway(client, withPointer, context);

        expect(result).toMatchObject({
            status: "returned",
            item: { feedback: { markup: withPointer.markup } },
        });
        expect(result.status === "returned" ? result.item.markupDrawings : undefined).toBeUndefined();
    });

    it("uses deterministic mutation ids for response-loss retries", async () => {
        const { client, rpcCalls } = mockClient();
        const draft = { ...feedback, status: "draft" as const };

        await saveTeacherFeedbackWithGateway(client, draft, context, { 1: ["stroke"] });
        await saveTeacherFeedbackWithGateway(client, draft, context, { 1: ["stroke"] });
        await returnTeacherFeedbackWithGateway(client, feedback, context);
        await returnTeacherFeedbackWithGateway(client, feedback, context);

        expect(rpcCalls[0].args.p_mutation_id).toBe(rpcCalls[1].args.p_mutation_id);
        expect(rpcCalls[2].args.p_mutation_id).toBe(rpcCalls[3].args.p_mutation_id);
    });

    it("normalizes client timestamps out of save mutation identity", async () => {
        const { client, rpcCalls } = mockClient();
        await saveTeacherFeedbackWithGateway(client, {
            ...feedback,
            status: "draft",
            updatedAt: "2026-07-14T01:00:00.000Z",
        }, context);
        await saveTeacherFeedbackWithGateway(client, {
            ...feedback,
            status: "draft",
            updatedAt: "2099-01-01T00:00:00.000Z",
        }, context);

        expect(rpcCalls[0].args.p_mutation_id).toBe(rpcCalls[1].args.p_mutation_id);
    });

    it("rejects oversized markup before invoking the service-role RPC", async () => {
        const { client, rpcCalls } = mockClient();
        const result = await saveTeacherFeedbackWithGateway(client, {
            ...feedback,
            status: "draft",
        }, context, { 1: ["M".repeat(FEEDBACK_MARKUP_MAX_PATH_LENGTH + 1)] });

        expect(result).toEqual({ status: "invalid_feedback" });
        expect(rpcCalls).toHaveLength(0);
    });

    it("bounds core/free summary and question comments before invoking the RPC", async () => {
        const oversizedSummary = mockClient();
        const oversizedComment = mockClient();
        const tooManyComments = mockClient();

        await expect(saveTeacherFeedbackWithGateway(oversizedSummary.client, {
            ...feedback,
            status: "draft",
            summary: "가".repeat(FEEDBACK_SUMMARY_MAX_BYTES),
        }, context)).resolves.toEqual({ status: "invalid_feedback" });
        await expect(saveTeacherFeedbackWithGateway(oversizedComment.client, {
            ...feedback,
            status: "draft",
            questionComments: [{
                id: "large",
                questionId: 1,
                questionNumber: 1,
                body: "나".repeat(FEEDBACK_COMMENT_MAX_BYTES),
                visibility: "student_visible",
            }],
        }, context)).resolves.toEqual({ status: "invalid_feedback" });
        await expect(saveTeacherFeedbackWithGateway(tooManyComments.client, {
            ...feedback,
            status: "draft",
            questionComments: Array.from({ length: FEEDBACK_COMMENT_MAX_COUNT + 1 }, (_, index) => ({
                id: `comment-${index}`,
                questionId: 1,
                questionNumber: 1,
                body: "확인",
                visibility: "student_visible" as const,
            })),
        }, context)).resolves.toEqual({ status: "invalid_feedback" });

        expect(oversizedSummary.rpcCalls).toHaveLength(0);
        expect(oversizedComment.rpcCalls).toHaveLength(0);
        expect(tooManyComments.rpcCalls).toHaveLength(0);
    });

    it("keeps a sixteen-KiB serialization and receipt margin at the metadata boundary", async () => {
        expect(FEEDBACK_METADATA_MAX_BYTES).toBe(240 * 1024);
        const near = mockClient();
        const oversized = mockClient();

        await saveTeacherFeedbackWithGateway(near.client, {
            ...feedback,
            status: "draft",
            summary: "x".repeat(30 * 1024),
            // The canonical row carries both normalized columns and its payload
            // snapshot, so individually valid comments also exercise the
            // aggregate receipt margin.
            questionComments: Array.from({ length: 25 }, (_, index) => ({
                id: `near-${index}`,
                questionId: 1,
                questionNumber: 1,
                body: "x".repeat(3 * 1024),
                visibility: "student_visible" as const,
            })),
        }, context);
        const denied = await saveTeacherFeedbackWithGateway(oversized.client, {
            ...feedback,
            status: "draft",
            questionComments: Array.from({ length: 40 }, (_, index) => ({
                id: `oversized-${index}`,
                questionId: 1,
                questionNumber: 1,
                body: "x".repeat(4 * 1024),
                visibility: "student_visible" as const,
            })),
        }, context);

        expect(near.rpcCalls).toHaveLength(1);
        expect(denied).toEqual({ status: "invalid_feedback" });
        expect(oversized.rpcCalls).toHaveLength(0);
    });

    it("returns a stable conflict without replacing the current returned record", async () => {
        const { client } = mockClient();
        client.rpc = async () => ({
            data: {
                status: "revision_conflict",
                currentRevision: 4,
                currentStatus: "returned",
                updatedAt: "2026-07-14T03:00:00.000Z",
            },
            error: null,
        });

        await expect(saveTeacherFeedbackWithGateway(client, feedback, context)).resolves.toEqual({
            status: "conflict",
            currentRevision: 4,
            currentStatus: "returned",
            serverUpdatedAt: "2026-07-14T03:00:00.000Z",
        });
        await expect(returnTeacherFeedbackWithGateway(client, feedback, context)).resolves.toEqual({
            status: "conflict",
            currentRevision: 4,
            currentStatus: "returned",
            serverUpdatedAt: "2026-07-14T03:00:00.000Z",
        });
    });

    it("uses server session scope for student list, detail, and opened receipt", async () => {
        const { client, filters, rpcCalls, selects, limits } = mockClient();
        const list = await listStudentFeedbackWithGateway(client, "org-1", "student-1");
        const detail = await loadStudentFeedbackWithGateway(client, "attempt-1", "org-1", "student-1");
        const opened = await markStudentFeedbackOpenedWithGateway(client, feedback.id, "org-1", "student-1");

        expect(list).toMatchObject({
            status: "loaded",
            items: [{ feedback: { questionComments: [] } }],
        });
        expect(JSON.stringify(list)).not.toContain("교사 메모");
        expect(JSON.stringify(list)).not.toContain("M 0 0 L 1 1");
        expect(list.status === "loaded" ? list.items[0]?.markupDrawings : undefined).toBeUndefined();
        expect(selects[0]).not.toBe("*");
        expect(selects[0]).not.toMatch(/markup|question_comments|payload|summary/);
        expect(limits).toContain(INITIAL_OPERATIONS_LIMITS.studentFeedback + 1);
        expect(detail.status).toBe("loaded");
        expect(opened.status).toBe("opened");
        expect(filters).toContainEqual(["organization_id", "org-1"]);
        expect(filters).toContainEqual(["student_profile_id", "student-1"]);
        expect(filters).toContainEqual(["status", "returned"]);
        expect(rpcCalls.at(-1)).toMatchObject({
            name: "omr_mark_feedback_opened_v2",
            args: {
                p_organization_id: "org-1",
                p_student_profile_id: "student-1",
                p_feedback_id: feedback.id,
            },
        });
    });

    it("returns the stable capacity error when returned-feedback summaries exceed the initial cap", async () => {
        const rows = Array.from({ length: INITIAL_OPERATIONS_LIMITS.studentFeedback + 1 }, (_, index) => ({
            ...returnedRow(),
            id: `feedback-${String(index).padStart(4, "0")}`,
        }));
        const query = {
            eq() { return query; },
            order() { return query; },
            async limit(value: number) { return { data: rows.slice(0, value), error: null }; },
            async maybeSingle() { return { data: null, error: null }; },
        };
        const client: FeedbackGatewayClient = {
            from() { return { select: () => query }; },
            async rpc() { return { data: null, error: null }; },
        };

        await expect(listStudentFeedbackWithGateway(client, "org-1", "student-1")).resolves.toEqual({
            status: "service_unavailable",
            error: "initial_capacity_exceeded",
        });
    });
});
