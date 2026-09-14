import { beforeEach, describe, expect, it, vi } from "vitest";

const controls = vi.hoisted(() => ({
    sameOrigin: true, session: { memberRole: "teacher" } as { memberRole: string } | null,
    rpc: vi.fn(),
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => ({ value: "signed" }) }) }));
vi.mock("@/lib/serverActionSecurity", () => ({ isSameOriginServerActionRequest: () => controls.sameOrigin }));
vi.mock("@/lib/teacherServerSession", () => ({ resolveAuthorizedTeacherSessionCookie: async () => controls.session, TEACHER_SERVER_SESSION_COOKIE: "teacher" }));
vi.mock("@/lib/supabaseServerAdmin", () => ({ getSupabaseServerConfigFromEnv: () => ({ url: "https://example.test", serviceRoleKey: "test" }), createSupabaseAdminClient: () => ({ rpc: controls.rpc }) }));
vi.mock("@/lib/workspaceContext", () => ({ workspaceContextFromTeacherSession: () => ({ organizationId: "signed-org", sessionAuthority: "account", accountId: "signed-account", accountSessionGeneration: 7, actorUserId: "signed-actor" }) }));

import { loadSolapiReminderDashboard, previewSolapiReminders, saveSolapiReminderContact, saveSolapiReminderSettings } from "@/app/actions/solapiReminders";
import { defaultReminderSettings } from "./solapiReminders";

describe("reminder server actions", () => {
    beforeEach(() => {
        controls.sameOrigin = true; controls.session = { memberRole: "teacher" }; controls.rpc.mockReset();
        controls.rpc.mockResolvedValue({ data: { status: "saved" }, error: null });
        vi.stubEnv("OMR_REMINDER_MODE", "dry_run");
    });
    it("rejects missing sessions, read-only roles, and cross-origin calls before database access", async () => {
        controls.session = null;
        expect((await loadSolapiReminderDashboard()).status).toBe("error");
        controls.session = { memberRole: "viewer" };
        expect((await saveSolapiReminderContact({ studentId: "a", phone: "01012345678", enabled: true })).status).toBe("error");
        controls.session = { memberRole: "teacher" }; controls.sameOrigin = false;
        expect((await saveSolapiReminderSettings(defaultReminderSettings("exam"))).status).toBe("error");
        expect(controls.rpc).not.toHaveBeenCalled();
    });
    it("binds contact mutations to the signed workspace and normalizes the phone", async () => {
        expect(await saveSolapiReminderContact({ studentId: "student-a", phone: "010-1234-5678", enabled: true })).toEqual({ status: "saved" });
        expect(controls.rpc).toHaveBeenCalledWith("omr_manage_reminders_v1", {
            p_session_authority: "account", p_account_id: "signed-account", p_session_generation: 7,
            p_organization_id: "signed-org", p_actor_user_id: "signed-actor",
            p_command: { op: "save_contact", studentId: "student-a", phone: "01012345678", enabled: true },
        });
    });
    it("validates bounded settings and contacts before mutation", async () => {
        expect((await saveSolapiReminderSettings({ ...defaultReminderSettings("exam"), quietStart: 24 })).status).toBe("error");
        expect((await saveSolapiReminderContact({ studentId: "a", phone: "invalid", enabled: true })).status).toBe("error");
        expect(controls.rpc).not.toHaveBeenCalled();
    });
    it("never activates live reminders with missing credentials or the wrong organization", async () => {
        vi.stubEnv("OMR_REMINDER_MODE", "live"); vi.stubEnv("OMR_REMINDER_ORGANIZATION_ID", "other-org");
        expect((await saveSolapiReminderSettings({ ...defaultReminderSettings("exam"), enabled: true })).status).toBe("error");
        expect(controls.rpc).not.toHaveBeenCalled();
    });
    it("masks preview phones and only calls the read RPC", async () => {
        controls.rpc.mockResolvedValue({ data: { status: "loaded", total: 1, candidates: [{
            organizationId: "signed-org", examId: "exam", studentId: "student", studentName: "학생", examTitle: "시험",
            phone: "01012345678", kind: "before_deadline", deadline: "2026-09-11T10:00:00Z", dueAt: "2026-09-11T09:00:00Z",
        }] }, error: null });
        const result = await previewSolapiReminders("exam");
        expect(result.status).toBe("loaded");
        expect(JSON.stringify(result)).toContain("010-****-5678");
        expect(JSON.stringify(result)).not.toContain("01012345678");
        expect(controls.rpc.mock.calls[0][1].p_command).toEqual({ op: "preview", examId: "exam" });
    });
    it("does not expose provider or database error details", async () => {
        controls.rpc.mockRejectedValue(new Error("service-role-key and private phone"));
        const result = await loadSolapiReminderDashboard();
        expect(result.status).toBe("error");
        expect(JSON.stringify(result)).not.toContain("service-role-key");
    });
});
