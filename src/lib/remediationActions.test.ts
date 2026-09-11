import { beforeEach, describe, expect, it, vi } from "vitest";

const controls = vi.hoisted(() => ({ sameOrigin: true, session: { memberRole: "teacher" } as { memberRole: string } | null,
    student: { status: "active", identity: { organizationId: "signed-org", studentId: "signed-student", identityType: "registered" } }, rpc: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => ({ value: "signed" }) }) }));
vi.mock("@/lib/serverActionSecurity", () => ({ isSameOriginServerActionRequest: () => controls.sameOrigin }));
vi.mock("@/lib/teacherServerSession", () => ({ resolveAuthorizedTeacherSessionCookie: async () => controls.session, TEACHER_SERVER_SESSION_COOKIE: "teacher" }));
vi.mock("@/lib/studentServerSession", () => ({ resolveAuthorizedStudentSessionCookie: async () => controls.student, STUDENT_SERVER_SESSION_COOKIE: "student" }));
vi.mock("@/lib/supabaseServerAdmin", () => ({ getSupabaseServerConfigFromEnv: () => ({ url: "https://example.test", serviceRoleKey: "test" }), createSupabaseAdminClient: () => ({ rpc: controls.rpc }) }));
vi.mock("@/lib/workspaceContext", () => ({ workspaceContextFromTeacherSession: () => ({ organizationId: "signed-org", sessionAuthority: "account", accountId: "signed-account", accountSessionGeneration: 7, actorUserId: "signed-actor" }) }));
import { loadStudentRemediation, manageRemediation } from "@/app/actions/remediation";

const assign = { op: "assign" as const, sourceAttemptIds: ["source"], dueAt: "2026-09-12T14:59:00.000Z" };
describe("remediation server boundaries", () => {
    beforeEach(() => { controls.sameOrigin = true; controls.session = { memberRole: "teacher" }; controls.student.status = "active";
        controls.student.identity.identityType = "registered"; controls.rpc.mockReset(); controls.rpc.mockResolvedValue({ data: { status: "saved" }, error: null }); });
    it("denies stale sessions, viewers, assistant writes and foreign origins before RPC", async () => {
        for (const session of [null, { memberRole: "viewer" }, { memberRole: "assistant" }]) {
            controls.session = session; expect((await manageRemediation(assign)).status).toBe("error");
        }
        controls.session = { memberRole: "teacher" }; controls.sameOrigin = false;
        expect((await manageRemediation(assign)).status).toBe("error");
        expect(controls.rpc).not.toHaveBeenCalled();
    });
    it("binds every mutation to the signed account, generation and actor", async () => {
        expect(await manageRemediation(assign)).toEqual({ status: "saved" });
        expect(controls.rpc).toHaveBeenCalledWith("omr_manage_remediation_v1", { p_session_authority: "account", p_account_id: "signed-account",
            p_session_generation: 7, p_organization_id: "signed-org", p_actor_user_id: "signed-actor", p_command: assign });
    });
    it("allows assistant reads but trusts only a validated display DTO", async () => {
        controls.session = { memberRole: "assistant" };
        controls.rpc.mockResolvedValue({ data: { status: "loaded", dashboard: { cases: [], candidates: [], hasMore: false, canAssign: false, planEnabled: true } }, error: null });
        expect((await manageRemediation({ op: "load" })).status).toBe("loaded");
        controls.rpc.mockResolvedValue({ data: { status: "loaded", dashboard: {} }, error: null });
        expect((await manageRemediation({ op: "load" })).status).toBe("error");
    });
    it("preserves safe conflicts while never exposing database errors or unrecognized statuses", async () => {
        controls.rpc.mockResolvedValue({ data: { status: "conflict" }, error: null });
        expect(await manageRemediation(assign)).toMatchObject({ status: "error", code: "conflict" });
        controls.rpc.mockResolvedValue({ data: { status: "private database details" }, error: null });
        expect(JSON.stringify(await manageRemediation(assign))).not.toContain("private");
        controls.rpc.mockRejectedValue(new Error("service-role-key"));
        expect(JSON.stringify(await manageRemediation(assign))).not.toContain("service-role-key");
    });
    it("uses only the generation-validated student identity and denies guests", async () => {
        controls.rpc.mockResolvedValue({ data: [], error: null });
        expect(await loadStudentRemediation()).toEqual({ status: "loaded", cases: [] });
        expect(controls.rpc).toHaveBeenCalledWith("omr_student_remediation_v1", { p_org: "signed-org", p_student: "signed-student" });
        controls.rpc.mockClear(); controls.student.status = "unauthenticated";
        expect((await loadStudentRemediation()).status).toBe("error");
        controls.student.status = "active"; controls.student.identity.identityType = "guest";
        expect((await loadStudentRemediation()).status).toBe("error");
        expect(controls.rpc).not.toHaveBeenCalled();
    });
});
