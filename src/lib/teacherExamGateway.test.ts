import { describe, expect, it } from "vitest";
import { INITIAL_OPERATIONS_LIMITS } from "@/lib/initialOperationsPolicy";
import type { Exam } from "@/types/omr";
import {
    deleteTeacherExamWithGateway,
    listTeacherExamsWithGateway,
    loadTeacherExamWithGateway,
    saveTeacherExamWithGateway,
    type TeacherExamGatewayClient,
    type TeacherExamWriteClient,
} from "./teacherExamGateway";

const exam: Exam = {
    id: "exam-1",
    title: "서버 저장 시험",
    createdAt: "2026-07-14T00:00:00.000Z",
    questions: [{ id: 1, number: 1, answer: 2, score: 5, choices: 5 }],
};

const context = {
    organizationId: "pilot_org_0123456789abcdef01234567",
    organizationName: "Teacher Org",
    actorUserId: "teacher_0123456789abcdef",
    accountId: "teacher_0123456789abcdef",
    accountSessionGeneration: 3,
    sessionAuthority: "account" as const,
};

function savedResponse(params: Record<string, unknown>) {
    const expectedRevision = Number(params.p_expected_revision);
    const payload = (params.p_exam as { payload: Exam }).payload;
    const revision = expectedRevision + 1;
    const updatedAt = "2026-08-06T01:02:03.000Z";
    return {
        data: {
            status: "saved",
            exam: { ...payload, revision, updatedAt },
            revision,
            updatedAt,
        },
        error: null,
    };
}

describe("teacher canonical exam gateway", () => {
    it("sends an optimistic revision and deterministic idempotency key to the CAS RPC", async () => {
        const calls: Array<{ name: string; params: Record<string, unknown> }> = [];
        const client: TeacherExamWriteClient = {
            async rpc(name, params) {
                calls.push({ name, params });
                return {
                    data: {
                        status: "saved",
                        exam: { ...exam, revision: 4, updatedAt: "2026-08-06T01:02:03.000Z" },
                        revision: 4,
                        updatedAt: "2026-08-06T01:02:03.000Z",
                    },
                    error: null,
                };
            },
        };

        const input = { ...exam, revision: 3 };
        const first = await saveTeacherExamWithGateway(client, input, context);
        const second = await saveTeacherExamWithGateway(client, input, context);

        expect(first).toEqual(second);
        expect(first).toMatchObject({
            status: "saved",
            exam: { revision: 4, updatedAt: "2026-08-06T01:02:03.000Z" },
        });
        expect(calls.map(call => call.name)).toEqual(["omr_save_exam_v3", "omr_save_exam_v3"]);
        expect(calls[0].params).toMatchObject({
            p_session_authority: "account",
            p_account_id: context.accountId,
            p_session_generation: 3,
            p_actor_user_id: context.actorUserId,
        });
        expect(calls[0].params.p_expected_revision).toBe(3);
        expect(calls[0].params.p_mutation_id).toMatch(/^exam-save:[a-f0-9]{64}$/);
        expect(calls[1].params.p_mutation_id).toBe(calls[0].params.p_mutation_id);
    });

    it("keeps the save mutation id stable when a promoted PDF intent gets a newer metadata timestamp", async () => {
        const calls: Array<Record<string, unknown>> = [];
        const client: TeacherExamWriteClient = {
            async rpc(_name, params) {
                calls.push(params);
                return savedResponse(params);
            },
        };
        const remoteRef = (updatedAt: string): NonNullable<Exam["pdfDataRef"]> => ({
            store: "remote",
            key: "asset-problem-response-loss",
            organizationId: context.organizationId,
            examId: exam.id,
            kind: "problem_pdf",
            mimeType: "application/pdf",
            size: 123,
            updatedAt,
        });

        await saveTeacherExamWithGateway(client, {
            ...exam,
            pdfDataRef: remoteRef("2026-08-06T01:00:00.000Z"),
        }, context);
        await saveTeacherExamWithGateway(client, {
            ...exam,
            pdfDataRef: remoteRef("2026-08-06T01:00:01.000Z"),
        }, context);

        expect(calls[1].p_mutation_id).toBe(calls[0].p_mutation_id);
    });

    it("returns a non-destructive conflict instead of claiming a stale save succeeded", async () => {
        const client: TeacherExamWriteClient = {
            async rpc() {
                return {
                    data: {
                        status: "revision_conflict",
                        currentRevision: 7,
                        updatedAt: "2026-08-06T02:03:04.000Z",
                    },
                    error: null,
                };
            },
        };

        await expect(saveTeacherExamWithGateway(client, { ...exam, revision: 5 }, context)).resolves.toEqual({
            status: "conflict",
            currentRevision: 7,
            serverUpdatedAt: "2026-08-06T02:03:04.000Z",
        });
    });

    it("overrides client scope and saves exam plus question rows through one RPC", async () => {
        const calls: Array<{ name: string; params: Record<string, unknown> }> = [];
        const client: TeacherExamWriteClient = {
            async rpc(name, params) {
                calls.push({ name, params });
                return savedResponse(params);
            },
        };
        const result = await saveTeacherExamWithGateway(client, {
            ...exam,
            organizationId: "attacker-org",
            createdByUserId: "attacker-user",
        }, context);

        expect(result).toMatchObject({
            status: "saved",
            exam: { organizationId: context.organizationId, createdByUserId: context.actorUserId },
        });
        expect(calls).toHaveLength(1);
        expect(calls[0].name).toBe("omr_save_exam_v3");
        expect(calls[0].params.p_exam).toMatchObject({
            organization_id: context.organizationId,
            created_by_user_id: context.actorUserId,
        });
        expect(calls[0].params.p_questions).toEqual([
            expect.objectContaining({ exam_id: "exam-1", organization_id: context.organizationId }),
        ]);
        expect(calls[0].params.p_teacher_asset_intent_ids).toEqual([]);
        expect(calls[0].params.p_actor_user_id).toBe(context.actorUserId);
    });

    it("binds exact remote PDF refs and current actor into the atomic save RPC", async () => {
        const calls: Array<Record<string, unknown>> = [];
        const client: TeacherExamWriteClient = {
            async rpc(_name, params) {
                calls.push(params);
                return savedResponse(params);
            },
        };
        await expect(saveTeacherExamWithGateway(client, {
            ...exam,
            pdfDataRef: {
                store: "remote",
                key: "asset-problem",
                organizationId: context.organizationId,
                examId: exam.id,
                kind: "problem_pdf",
            },
            answerKeyPdfRef: {
                store: "remote",
                key: "asset-answer",
                organizationId: context.organizationId,
                examId: exam.id,
                kind: "answer_key_pdf",
            },
        }, context)).resolves.toMatchObject({ status: "saved" });
        expect(calls[0].p_teacher_asset_intent_ids).toEqual(["asset-problem", "asset-answer"]);
        expect(calls[0].p_actor_user_id).toBe(context.actorUserId);
    });

    it("rejects inline PDF bodies at the configured canonical gateway", async () => {
        const client: TeacherExamWriteClient = {
            async rpc() {
                throw new Error("must not be called");
            },
        };
        await expect(saveTeacherExamWithGateway(client, {
            ...exam,
            pdfData: "data:application/pdf;base64,JVBERi0=",
        }, context)).resolves.toEqual({
            status: "invalid_exam",
            error: "Inline PDF bodies are not accepted by the canonical gateway",
        });
    });

    it("omits empty legacy inline PDF fields from the canonical payload", async () => {
        const calls: Array<Record<string, unknown>> = [];
        const client: TeacherExamWriteClient = {
            async rpc(_name, params) {
                calls.push(params);
                return savedResponse(params);
            },
        };
        await expect(saveTeacherExamWithGateway(client, {
            ...exam,
            pdfData: "",
            answerKeyPdf: "",
        }, context)).resolves.toMatchObject({ status: "saved" });
        const payload = (calls[0].p_exam as { payload: Record<string, unknown> }).payload;
        expect(payload).not.toHaveProperty("pdfData");
        expect(payload).not.toHaveProperty("answerKeyPdf");
    });

    it("rejects a remote asset belonging to another organization", async () => {
        const client: TeacherExamWriteClient = {
            async rpc() {
                throw new Error("must not be called");
            },
        };
        await expect(saveTeacherExamWithGateway(client, {
            ...exam,
            pdfDataRef: {
                store: "remote",
                key: "asset-1",
                organizationId: "other-org",
                kind: "problem_pdf",
                examId: "exam-1",
            },
        }, context)).resolves.toMatchObject({ status: "invalid_exam" });
    });

    it("rejects browser-local PDF refs at the configured canonical gateway", async () => {
        const client: TeacherExamWriteClient = {
            async rpc() {
                throw new Error("must not be called");
            },
        };
        await expect(saveTeacherExamWithGateway(client, {
            ...exam,
            pdfDataRef: { store: "indexeddb", key: "browser-only-problem" },
        }, context)).resolves.toEqual({
            status: "invalid_exam",
            error: "Canonical PDF refs must use remote storage",
        });
    });

    it("does not report success when the RPC fails", async () => {
        const client: TeacherExamWriteClient = {
            async rpc() {
                return { data: null, error: { message: "database unavailable" } };
            },
        };
        await expect(saveTeacherExamWithGateway(client, exam, context)).resolves.toEqual({
            status: "service_unavailable",
            error: "database unavailable",
        });
    });

    it("deletes through the organization-scoped atomic RPC", async () => {
        const calls: Array<{ name: string; params: Record<string, unknown> }> = [];
        const client: TeacherExamWriteClient = {
            async rpc(name, params) {
                calls.push({ name, params });
                return { data: { deleted: true }, error: null };
            },
        };
        await expect(deleteTeacherExamWithGateway(client, exam.id, context)).resolves.toEqual({
            status: "deleted",
            examId: exam.id,
        });
        expect(calls).toEqual([{
            name: "omr_delete_exam_v1",
            params: { p_organization_id: context.organizationId, p_exam_id: exam.id },
        }]);
    });

    it("scopes exam reads and lists to the server teacher organization", async () => {
        const filters: Array<[string, string]> = [];
        const row = {
            id: exam.id,
            organization_id: context.organizationId,
            title: exam.title,
            payload: { ...exam, organizationId: context.organizationId },
            created_at: exam.createdAt,
            updated_at: exam.createdAt,
            archived: false,
            questions: exam.questions,
            revision: 1,
        };
        const second = { async maybeSingle() { return { data: row, error: null }; } };
        const first = {
            eq(column: string, value: string) { filters.push([column, value]); return second; },
            order() { return first; },
            async limit() { return { data: [row], error: null }; },
        };
        const query = {
            eq(column: string, value: string) { filters.push([column, value]); return first; },
        };
        const client = { from: () => ({ select: () => query }) } as unknown as TeacherExamGatewayClient;

        await expect(loadTeacherExamWithGateway(client, exam.id, context)).resolves.toMatchObject({
            status: "loaded",
            exam: { id: exam.id },
        });
        await expect(listTeacherExamsWithGateway(client, context)).resolves.toMatchObject({
            status: "loaded",
            exams: [{ id: exam.id }],
        });
        expect(filters.filter(([column]) => column === "organization_id")).toHaveLength(2);
    });

    it("returns exact successful collection metadata", async () => {
        const postgresUtc = "2026-07-14T00:00:00+00:00";
        const row = {
            id: exam.id,
            organization_id: context.organizationId,
            title: exam.title,
            created_at: postgresUtc,
            updated_at: postgresUtc,
            archived: false,
            questions: exam.questions,
        };
        const query = {
            eq() { return query; },
            order() { return query; },
            async limit() { return { data: [row], error: null }; },
        };
        const client = { from: () => ({ select: () => query }) } as unknown as TeacherExamGatewayClient;

        const result = await listTeacherExamsWithGateway(client, context);

        expect(result).toMatchObject({
            status: "loaded",
            exams: [{
                id: exam.id,
                organizationId: context.organizationId,
                createdAt: exam.createdAt,
                updatedAt: exam.createdAt,
            }],
            meta: {
                organizationId: context.organizationId,
                rawCount: 1,
                parsedCount: 1,
            },
        });
        if (result.status === "loaded") {
            expect(Object.keys(result.meta).sort()).toEqual([
                "loadedAt",
                "organizationId",
                "parsedCount",
                "rawCount",
            ]);
            expect(new Date(result.meta.loadedAt).toISOString()).toBe(result.meta.loadedAt);
        }
    });

    it.each([
        ["a malformed row", { id: "", organization_id: context.organizationId }],
        ["a wrong-organization row", { id: "exam-other", organization_id: "org-other" }],
        ["a missing organization", { id: "exam-missing-org", organization_id: undefined }],
        ["a whitespace-padded organization", { id: "exam-padded-org", organization_id: ` ${context.organizationId} ` }],
        ["a blank title", { id: "exam-blank-title", title: "   " }],
        ["malformed questions", { id: "exam-bad-questions", questions: { id: 1 } }],
        ["a question with a malformed known score", {
            id: "exam-bad-question-score",
            questions: [{ ...exam.questions[0], score: "5" }],
        }],
        ["a question with an unsupported choice count", {
            id: "exam-bad-question-choices",
            questions: [{ ...exam.questions[0], choices: 3 }],
        }],
        ["a question with a fractional answer", {
            id: "exam-bad-question-answer",
            questions: [{ ...exam.questions[0], answer: 2.5 }],
        }],
        ["a question with malformed nested tags", {
            id: "exam-bad-question-tags",
            questions: [{ ...exam.questions[0], tags: { mistakeTypes: ["calculation", 7] } }],
        }],
        ["a nonboolean archived flag", { id: "exam-bad-archived", archived: "false" }],
        ["a coerced duration", { id: "exam-bad-duration", duration_min: "50" }],
        ["a malformed access config", { id: "exam-bad-access", access_config: { type: "private" } }],
        ["a malformed PDF reference", {
            id: "exam-bad-pdf-ref", pdf_data_ref: { store: "remote", key: "pdf", size: "123" },
        }],
        ["a noncanonical UTC timestamp", { id: "exam-offset", updated_at: "2026-07-14T09:00:00+09:00" }],
        ["a whitespace-padded timestamp", { id: "exam-padded-time", updated_at: ` ${exam.createdAt} ` }],
        ["a calendar-impossible timestamp", { id: "exam-impossible-time", updated_at: "2026-02-30T00:00:00.123456Z" }],
    ])("rejects the entire exam collection when it contains %s", async (_label, invalidRow) => {
        const validRow = {
            id: exam.id,
            organization_id: context.organizationId,
            title: exam.title,
            created_at: exam.createdAt,
            updated_at: exam.createdAt,
            archived: false,
            questions: exam.questions,
        };
        const query = {
            eq() { return query; },
            order() { return query; },
            async limit() { return { data: [validRow, { ...validRow, ...invalidRow }], error: null }; },
        };
        const client = { from: () => ({ select: () => query }) } as unknown as TeacherExamGatewayClient;

        await expect(listTeacherExamsWithGateway(client, context)).resolves.toEqual({
            status: "service_unavailable",
            error: "Invalid canonical exam collection",
        });
    });

    it("applies the organization scope before the exact exam cap plus one", async () => {
        const calls: Array<[string, ...unknown[]]> = [];
        const row = {
            id: exam.id,
            organization_id: context.organizationId,
            title: exam.title,
            payload: { ...exam, organizationId: context.organizationId },
            created_at: exam.createdAt,
            updated_at: exam.createdAt,
            archived: false,
            questions: exam.questions,
        };
        const query = {
            eq(column: string, value: string) {
                calls.push(["eq", column, value]);
                return query;
            },
            order(column: string, options: { ascending: boolean }) {
                calls.push(["order", column, options]);
                return query;
            },
            async limit(value: number) {
                calls.push(["limit", value]);
                return { data: [row], error: null };
            },
        };
        const client = { from: () => ({ select: () => query }) } as unknown as TeacherExamGatewayClient;

        await expect(listTeacherExamsWithGateway(client, context)).resolves.toMatchObject({ status: "loaded" });
        expect(calls).toEqual([
            ["eq", "organization_id", context.organizationId],
            ["order", "updated_at", { ascending: false }],
            ["order", "id", { ascending: true }],
            ["limit", INITIAL_OPERATIONS_LIMITS.teacherExams + 1],
        ]);
    });

    it("fails loudly instead of returning a truncated organization exam list", async () => {
        const rows = Array.from({ length: INITIAL_OPERATIONS_LIMITS.teacherExams + 1 }, (_, index) => ({
            id: `exam-${index}`,
            organization_id: context.organizationId,
            title: `시험 ${index}`,
            payload: { ...exam, id: `exam-${index}`, organizationId: context.organizationId },
            created_at: exam.createdAt,
            updated_at: exam.createdAt,
            archived: false,
            questions: exam.questions,
        }));
        const query = {
            eq() { return query; },
            order() { return query; },
            async limit() { return { data: rows, error: null }; },
        };
        const client = { from: () => ({ select: () => query }) } as unknown as TeacherExamGatewayClient;

        await expect(listTeacherExamsWithGateway(client, context)).resolves.toEqual({
            status: "service_unavailable",
            error: "initial_capacity_exceeded",
        });
    });
});
