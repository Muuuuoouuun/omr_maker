import { describe, expect, it } from "vitest";
import {
    loadTeacherNotificationStateWithGateway,
    mutateTeacherNotificationStateWithGateway,
    type TeacherNotificationStateGatewayClient,
} from "./teacherNotificationStateGateway";

const ID = "auto-recent-exams:3:11111111111111111111111111111111";
const context = {
    organizationId: "teacher_school1",
    organizationName: "School",
    actorUserId: "teacher_user001",
};

describe("teacher notification state gateway", () => {
    it("loads state through an exact organization, teacher, and id scope", async () => {
        const calls: Array<[string, Record<string, unknown>]> = [];
        const client: TeacherNotificationStateGatewayClient = {
            async rpc(name, params) {
                calls.push([name, params]);
                return {
                    data: [{ notification_id: ID, read_at: "2026-08-07T01:02:03.000Z", dismissed_at: null }],
                    error: null,
                };
            },
        };

        await expect(loadTeacherNotificationStateWithGateway(client, context, [ID])).resolves.toEqual({
            status: "loaded",
            states: [{ notificationId: ID, read: true, dismissed: false }],
        });
        expect(calls).toEqual([["omr_load_teacher_notification_state_v1", {
            p_organization_id: "teacher_school1",
            p_teacher_user_id: "teacher_user001",
            p_notification_ids: [ID],
        }]]);
    });

    it("uses one atomic mutation RPC and returns the canonical resulting state", async () => {
        const calls: Array<[string, Record<string, unknown>]> = [];
        const client: TeacherNotificationStateGatewayClient = {
            async rpc(name, params) {
                calls.push([name, params]);
                return {
                    data: [{ notification_id: ID, read_at: "2026-08-07T01:02:03.000Z", dismissed_at: "2026-08-07T01:02:03.000Z" }],
                    error: null,
                };
            },
        };

        await expect(mutateTeacherNotificationStateWithGateway(client, context, "dismiss", [ID])).resolves.toEqual({
            status: "saved",
            states: [{ notificationId: ID, read: true, dismissed: true }],
        });
        expect(calls).toEqual([["omr_mutate_teacher_notification_state_v1", {
            p_organization_id: "teacher_school1",
            p_teacher_user_id: "teacher_user001",
            p_operation: "dismiss",
            p_notification_ids: [ID],
        }]]);
    });

    it("fails closed before RPC on missing actor scope, malformed ids, and invalid operations", async () => {
        let calls = 0;
        const client: TeacherNotificationStateGatewayClient = {
            async rpc() {
                calls += 1;
                return { data: [], error: null };
            },
        };
        await expect(loadTeacherNotificationStateWithGateway(client, { ...context, actorUserId: undefined }, [ID]))
            .resolves.toMatchObject({ status: "service_unavailable" });
        await expect(loadTeacherNotificationStateWithGateway(client, context, ["attacker-controlled-id"]))
            .resolves.toMatchObject({ status: "service_unavailable" });
        await expect(mutateTeacherNotificationStateWithGateway(client, context, "clear" as never, [ID]))
            .resolves.toMatchObject({ status: "service_unavailable" });
        expect(calls).toBe(0);
    });

    it("rejects RPC errors and rows outside the requested id set", async () => {
        const clients: TeacherNotificationStateGatewayClient[] = [
            { async rpc() { return { data: null, error: { message: "down" } }; } },
            { async rpc() { return { data: [{ notification_id: "auto-recent-exams:1:22222222222222222222222222222222", read_at: "2026-08-07T01:02:03.000Z", dismissed_at: null }], error: null }; } },
        ];
        for (const client of clients) {
            await expect(loadTeacherNotificationStateWithGateway(client, context, [ID]))
                .resolves.toMatchObject({ status: "service_unavailable" });
        }
    });
});
