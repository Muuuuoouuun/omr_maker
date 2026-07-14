import { describe, expect, it } from "vitest";
import type { Attempt } from "@/types/omr";
import {
    listTeacherAttemptsWithGateway,
    loadTeacherAttemptWithGateway,
    saveTeacherAttemptWithGateway,
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

    it("saves only through the organization-scoped atomic RPC", async () => {
        let rpcName = "";
        let rpcArgs: Record<string, unknown> = {};
        const client = {
            async rpc(name: string, args: Record<string, unknown>) {
                rpcName = name;
                rpcArgs = args;
                return { data: [{ payload: { ...attempt, organizationId: "org-a" } }], error: null };
            },
        } as unknown as TeacherAttemptGatewayClient;

        await expect(saveTeacherAttemptWithGateway(client, {
            ...attempt,
            organizationId: "org-client-spoof",
        }, {
            organizationId: "org-a",
            organizationName: "Org A",
        })).resolves.toMatchObject({ status: "saved", attempt: { id: "attempt-1" } });

        expect(rpcName).toBe("omr_teacher_update_attempt_v1");
        expect(rpcArgs.p_organization_id).toBe("org-a");
        expect(rpcArgs.p_attempt).toMatchObject({ organization_id: "org-a" });
    });
});
