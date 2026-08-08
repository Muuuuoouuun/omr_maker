import { beforeEach, describe, expect, it, vi } from "vitest";

const controls = vi.hoisted(() => ({
    sameOrigin: true,
    session: { teacherId: "teacher-user", memberRole: "teacher" } as object | null,
    loadState: vi.fn(),
    mutateState: vi.fn(),
    loadSummary: vi.fn(),
}));

vi.mock("next/headers", () => ({
    headers: async () => new Headers({ origin: "https://omr.example", host: "omr.example" }),
    cookies: async () => ({ get: () => ({ value: "signed-teacher" }) }),
}));

vi.mock("@/lib/serverActionSecurity", () => ({
    isSameOriginServerActionRequest: () => controls.sameOrigin,
}));

vi.mock("@/lib/teacherServerSession", () => ({
    resolveAuthorizedTeacherSessionCookie: async () => controls.session,
    resolveTeacherSessionSecret: () => "notification-state-test-secret",
    TEACHER_SERVER_SESSION_COOKIE: "omr_teacher_server_session",
}));

vi.mock("@/lib/supabaseServerAdmin", () => ({
    getSupabaseServerConfigFromEnv: () => ({ url: "https://example.supabase.co", serviceRoleKey: "service-role" }),
    createSupabaseAdminClient: () => ({ rpc: vi.fn() }),
}));

vi.mock("@/lib/workspaceContext", () => ({
    workspaceContextFromTeacherSession: () => ({
        organizationId: "teacher_school1",
        organizationName: "School",
        actorUserId: "teacher_user001",
        memberRole: "teacher",
    }),
}));

vi.mock("@/lib/teacherNotificationSummaryGateway", () => ({
    loadTeacherNotificationSummaryWithGateway: controls.loadSummary,
}));

vi.mock("@/lib/teacherNotificationStateGateway", () => ({
    loadTeacherNotificationStateWithGateway: controls.loadState,
    mutateTeacherNotificationStateWithGateway: controls.mutateState,
}));

import {
    loadTeacherNotificationSummary,
    mutateTeacherNotificationState,
} from "@/app/actions/teacherNotifications";

const ID = "auto-recent-exams:3:11111111111111111111111111111111";

describe("teacher notification state server action", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        controls.sameOrigin = true;
        controls.session = { teacherId: "teacher-user", memberRole: "teacher" };
        controls.loadSummary.mockResolvedValue({
            status: "loaded",
            summary: {
                recentCompletedAttemptCount: 3,
                queuedStudentQuestionCount: 0,
                recentEventVersion: "11111111111111111111111111111111",
                queuedEventVersion: "none",
            },
        });
        controls.loadState.mockResolvedValue({
            status: "loaded",
            states: [{ notificationId: ID, read: true, dismissed: false }],
        });
        controls.mutateState.mockResolvedValue({
            status: "saved",
            states: [{ notificationId: ID, read: true, dismissed: true }],
        });
    });

    it("loads the user-scoped canonical state together with the summary", async () => {
        await expect(loadTeacherNotificationSummary()).resolves.toMatchObject({
            status: "loaded",
            summary: {
                notificationStates: [{ notificationId: ID, read: true, dismissed: false }],
            },
        });
        expect(controls.loadState).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ organizationId: "teacher_school1", actorUserId: "teacher_user001" }),
            [ID],
        );
    });

    it("mutates only ids in the current server-derived summary", async () => {
        await expect(mutateTeacherNotificationState({
            operation: "dismiss",
            notificationIds: [ID],
        })).resolves.toEqual({
            status: "saved",
            states: [{ notificationId: ID, read: true, dismissed: true }],
        });
        expect(controls.mutateState).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ organizationId: "teacher_school1", actorUserId: "teacher_user001" }),
            "dismiss",
            [ID],
        );

        await expect(mutateTeacherNotificationState({
            operation: "dismiss",
            notificationIds: ["auto-recent-exams:1:22222222222222222222222222222222"],
        })).resolves.toEqual({ status: "stale" });
        expect(controls.mutateState).toHaveBeenCalledTimes(1);
    });

    it("rejects cross-origin, unsigned, malformed, and oversized requests before mutation", async () => {
        controls.sameOrigin = false;
        await expect(mutateTeacherNotificationState({ operation: "mark_read", notificationIds: [ID] }))
            .resolves.toEqual({ status: "unauthorized" });

        controls.sameOrigin = true;
        controls.session = null;
        await expect(mutateTeacherNotificationState({ operation: "mark_read", notificationIds: [ID] }))
            .resolves.toEqual({ status: "unauthorized" });

        controls.session = { teacherId: "omr-showcase", sessionAuthority: "mockup" };
        await expect(mutateTeacherNotificationState({ operation: "mark_read", notificationIds: [ID] }))
            .resolves.toEqual({ status: "unauthorized" });
        expect(controls.loadSummary).not.toHaveBeenCalled();

        controls.session = { teacherId: "teacher-user", memberRole: "teacher" };
        await expect(mutateTeacherNotificationState({ operation: "clear", notificationIds: [ID] } as never))
            .resolves.toEqual({ status: "invalid_request" });
        await expect(mutateTeacherNotificationState({ operation: "dismiss", notificationIds: Array(17).fill(ID) }))
            .resolves.toEqual({ status: "invalid_request" });
        expect(controls.mutateState).not.toHaveBeenCalled();
    });
});
