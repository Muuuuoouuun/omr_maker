import { describe, expect, it } from "vitest";
import {
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

const context = {
    organizationId: "org-1",
    organizationName: "조직 1",
    actorUserId: "teacher-1",
};

const feedback: AttemptFeedback = {
    id: "feedback:attempt-1",
    attemptId: "attempt-1",
    examId: "exam-1",
    organizationId: "org-1",
    studentProfileId: "student-1",
    teacherUserId: "teacher-1",
    status: "returned",
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
    return feedbackToSupabaseRow(feedback, context, { 1: ["M 0 0 L 1 1"] });
}

function mockClient(row = returnedRow()) {
    const filters: Array<[string, string]> = [];
    const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const query = {
        eq(column: string, value: string) {
            filters.push([column, value]);
            return query;
        },
        async maybeSingle() {
            return { data: row, error: null };
        },
        async order() {
            return { data: [row], error: null };
        },
    };
    const client: FeedbackGatewayClient = {
        from() {
            return { select: () => query };
        },
        async rpc(name, args) {
            rpcCalls.push({ name, args });
            if (name === "omr_save_feedback_v1") {
                return { data: args.p_feedback, error: null };
            }
            return { data: row, error: null };
        },
    };
    return { client, filters, rpcCalls };
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
            name: "omr_save_feedback_v1",
            args: {
                p_organization_id: "org-1",
                p_feedback: {
                    organization_id: "org-1",
                    teacher_user_id: "teacher-1",
                    status: "draft",
                    markup_drawings: { 1: ["stroke"] },
                },
            },
        });
    });

    it("scopes teacher reads and return mutation to the server organization", async () => {
        const { client, filters, rpcCalls } = mockClient();
        await expect(loadTeacherFeedbackWithGateway(client, "attempt-1", context)).resolves.toMatchObject({
            status: "loaded",
            item: { feedback: { id: feedback.id } },
        });
        await expect(returnTeacherFeedbackWithGateway(client, feedback.id, context)).resolves.toMatchObject({
            status: "returned",
        });
        expect(filters).toContainEqual(["organization_id", "org-1"]);
        expect(rpcCalls[0]).toMatchObject({
            name: "omr_return_feedback_v1",
            args: { p_organization_id: "org-1", p_feedback_id: feedback.id },
        });
    });

    it("uses server session scope for student list, detail, and opened receipt", async () => {
        const { client, filters, rpcCalls } = mockClient();
        const list = await listStudentFeedbackWithGateway(client, "org-1", "student-1");
        const detail = await loadStudentFeedbackWithGateway(client, "attempt-1", "org-1", "student-1");
        const opened = await markStudentFeedbackOpenedWithGateway(client, feedback.id, "org-1", "student-1");

        expect(list).toMatchObject({
            status: "loaded",
            items: [{ feedback: { questionComments: [{ id: "visible" }] } }],
        });
        expect(JSON.stringify(list)).not.toContain("교사 메모");
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
});
