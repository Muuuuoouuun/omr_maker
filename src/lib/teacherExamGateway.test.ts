import { describe, expect, it } from "vitest";
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
    organizationId: "teacher_org1",
    organizationName: "Teacher Org",
    actorUserId: "teacher_user1",
};

describe("teacher canonical exam gateway", () => {
    it("overrides client scope and saves exam plus question rows through one RPC", async () => {
        const calls: Array<{ name: string; params: Record<string, unknown> }> = [];
        const client: TeacherExamWriteClient = {
            async rpc(name, params) {
                calls.push({ name, params });
                return { data: {}, error: null };
            },
        };
        const result = await saveTeacherExamWithGateway(client, {
            ...exam,
            organizationId: "attacker-org",
            createdByUserId: "attacker-user",
        }, context);

        expect(result).toMatchObject({
            status: "saved",
            exam: { organizationId: "teacher_org1", createdByUserId: "teacher_user1" },
        });
        expect(calls).toHaveLength(1);
        expect(calls[0].name).toBe("omr_save_exam_v1");
        expect(calls[0].params.p_exam).toMatchObject({
            organization_id: "teacher_org1",
            created_by_user_id: "teacher_user1",
        });
        expect(calls[0].params.p_questions).toEqual([
            expect.objectContaining({ exam_id: "exam-1", organization_id: "teacher_org1" }),
        ]);
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
        };
        const second = { async maybeSingle() { return { data: row, error: null }; } };
        const first = {
            eq(column: string, value: string) { filters.push([column, value]); return second; },
            async order() { return { data: [row], error: null }; },
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
});
