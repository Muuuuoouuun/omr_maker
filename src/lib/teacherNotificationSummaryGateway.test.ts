import { describe, expect, it } from "vitest";
import {
    loadTeacherNotificationSummaryWithGateway,
    type TeacherNotificationSummaryGatewayClient,
} from "./teacherNotificationSummaryGateway";

function context(organizationId = "org-a") {
    return { organizationId, organizationName: "Org A" };
}

describe("teacher notification summary gateway", () => {
    it("passes only the canonical organization id to the aggregate RPC", async () => {
        const calls: Array<[string, Record<string, unknown>]> = [];
        const client: TeacherNotificationSummaryGatewayClient = {
            async rpc(name, params) {
                calls.push([name, params]);
                return {
                    data: [{
                        recent_completed_attempt_count: "3",
                        queued_student_question_count: "2",
                        recent_event_version: "11111111111111111111111111111111",
                        queued_event_version: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                    }],
                    error: null,
                };
            },
        };

        await expect(loadTeacherNotificationSummaryWithGateway(client, context())).resolves.toEqual({
            status: "loaded",
            summary: {
                recentCompletedAttemptCount: 3,
                queuedStudentQuestionCount: 2,
                recentEventVersion: "11111111111111111111111111111111",
                queuedEventVersion: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            },
        });
        expect(calls).toEqual([["omr_teacher_notification_summary_v1", { p_organization_id: "org-a" }]]);
    });

    it("fails closed on blank scope, RPC errors, empty rows, and malformed counts", async () => {
        const neverCalled: TeacherNotificationSummaryGatewayClient = {
            async rpc() {
                throw new Error("must not run");
            },
        };
        await expect(loadTeacherNotificationSummaryWithGateway(neverCalled, context("  ")))
            .resolves.toEqual({ status: "service_unavailable", error: "Missing organization scope" });

        const cases: TeacherNotificationSummaryGatewayClient[] = [
            { async rpc() { return { data: null, error: { message: "rpc down" } }; } },
            { async rpc() { return { data: [], error: null }; } },
            { async rpc() { return { data: [{
                recent_completed_attempt_count: -1,
                queued_student_question_count: 0,
                recent_event_version: "none",
                queued_event_version: "none",
            }], error: null }; } },
            { async rpc() { return { data: [{
                recent_completed_attempt_count: 1,
                queued_student_question_count: 1,
                recent_event_version: "11111111111111111111111111111111",
                queued_event_version: null,
            }], error: null }; } },
        ];
        for (const client of cases) {
            await expect(loadTeacherNotificationSummaryWithGateway(client, context()))
                .resolves.toMatchObject({ status: "service_unavailable" });
        }
    });
});
