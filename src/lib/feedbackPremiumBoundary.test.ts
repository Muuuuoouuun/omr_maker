import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    resolveServerPlanAccess: vi.fn(),
    saveTeacherFeedbackWithGateway: vi.fn(),
    returnTeacherFeedbackWithGateway: vi.fn(),
}));

vi.mock("next/headers", () => ({
    cookies: async () => ({ get: () => ({ value: "signed-teacher-session" }) }),
    headers: async () => new Headers({ origin: "https://omr.example" }),
}));

vi.mock("@/lib/feedbackServerGateway", () => ({
    listStudentFeedbackWithGateway: vi.fn(),
    loadStudentFeedbackWithGateway: vi.fn(),
    loadTeacherFeedbackWithGateway: vi.fn(),
    markStudentFeedbackOpenedWithGateway: vi.fn(),
    returnTeacherFeedbackWithGateway: mocks.returnTeacherFeedbackWithGateway,
    saveTeacherFeedbackWithGateway: mocks.saveTeacherFeedbackWithGateway,
}));

vi.mock("@/lib/serverActionSecurity", () => ({
    isSameOriginServerActionRequest: () => true,
}));

vi.mock("@/lib/studentServerSession", () => ({
    parseSignedStudentSessionCookie: vi.fn(),
    STUDENT_SERVER_SESSION_COOKIE: "omr_student_server_session",
}));

vi.mock("@/lib/teacherServerSession", () => ({
    resolveAuthorizedTeacherSessionCookie: async () => ({
        teacherId: "teacher-pro",
        organizationId: "org-plan",
        memberRole: "teacher",
    }),
    TEACHER_SERVER_SESSION_COOKIE: "omr_teacher_server_session",
}));

vi.mock("@/lib/teacherMutationAuthorization", () => ({
    isTeacherMutationAuthorized: () => true,
}));

vi.mock("@/lib/supabaseServerAdmin", () => ({
    createSupabaseAdminClient: () => ({ rpc: vi.fn() }),
    getSupabaseServerConfigFromEnv: () => ({ url: "https://supabase.example", serviceRoleKey: "service-role" }),
}));

vi.mock("@/lib/workspaceContext", () => ({
    workspaceContextFromTeacherSession: () => ({
        organizationId: "org-plan",
        actorUserId: "teacher-pro",
        memberRole: "teacher",
    }),
}));

vi.mock("@/lib/serverPlan", () => ({
    resolveServerPlanAccess: mocks.resolveServerPlanAccess,
}));

import {
    loadTeacherCanonicalFeedback,
    returnTeacherCanonicalFeedback,
    saveTeacherCanonicalFeedback,
} from "@/app/actions/feedback";

const canonicalFeedback = {
    id: "feedback-1",
    attemptId: "attempt-1",
    revision: 2,
} as never;

describe("feedback premium server boundary", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.saveTeacherFeedbackWithGateway.mockResolvedValue({ status: "saved", item: {} });
        mocks.returnTeacherFeedbackWithGateway.mockResolvedValue({ status: "returned", item: {} });
    });

    it("lets the database replay an exact save after a plan downgrade", async () => {
        mocks.resolveServerPlanAccess.mockResolvedValue({
            authenticated: true,
            authoritative: true,
            plan: "free",
            source: "supabase",
        });

        mocks.saveTeacherFeedbackWithGateway.mockResolvedValue({ status: "saved", item: canonicalFeedback });

        await expect(saveTeacherCanonicalFeedback(canonicalFeedback)).resolves.toMatchObject({ status: "saved" });
        expect(mocks.resolveServerPlanAccess).not.toHaveBeenCalled();
        expect(mocks.saveTeacherFeedbackWithGateway).toHaveBeenCalledOnce();
    });

    it("lets the database replay an exact return after a plan downgrade", async () => {
        mocks.resolveServerPlanAccess.mockResolvedValue({
            authenticated: true,
            authoritative: true,
            plan: "free",
            source: "supabase",
        });

        await expect(returnTeacherCanonicalFeedback(canonicalFeedback)).resolves.toMatchObject({ status: "returned" });
        expect(mocks.resolveServerPlanAccess).not.toHaveBeenCalled();
        expect(mocks.returnTeacherFeedbackWithGateway).toHaveBeenCalledOnce();
    });

    it("delegates premium markup entitlement decisions to the authoritative database RPC", async () => {
        mocks.resolveServerPlanAccess.mockResolvedValue({
            authenticated: true,
            authoritative: false,
            plan: "free",
            source: "unavailable",
        });

        mocks.saveTeacherFeedbackWithGateway.mockResolvedValue({
            status: "service_unavailable",
            error: "plan entitlement required",
        });

        await expect(saveTeacherCanonicalFeedback(canonicalFeedback)).resolves.toMatchObject({
            status: "plan_denied",
        });
        expect(mocks.resolveServerPlanAccess).not.toHaveBeenCalled();
        expect(mocks.saveTeacherFeedbackWithGateway).toHaveBeenCalledOnce();
    });

    it("allows paid plans through to the feedback gateways", async () => {
        mocks.resolveServerPlanAccess.mockResolvedValue({
            authenticated: true,
            authoritative: true,
            plan: "pro",
            source: "supabase",
        });

        await expect(saveTeacherCanonicalFeedback({} as never)).resolves.toMatchObject({ status: "saved" });
        await expect(returnTeacherCanonicalFeedback(canonicalFeedback)).resolves.toMatchObject({ status: "returned" });
        expect(mocks.saveTeacherFeedbackWithGateway).toHaveBeenCalledOnce();
        expect(mocks.returnTeacherFeedbackWithGateway).toHaveBeenCalledOnce();
        expect(mocks.resolveServerPlanAccess).not.toHaveBeenCalled();
    });

    it("keeps existing feedback readable and core text mutations writable after downgrade", async () => {
        mocks.resolveServerPlanAccess.mockResolvedValue({
            authenticated: true,
            authoritative: true,
            plan: "free",
            source: "supabase",
        });
        const gateway = await import("@/lib/feedbackServerGateway");
        vi.mocked(gateway.loadTeacherFeedbackWithGateway).mockResolvedValue({
            status: "loaded",
            item: { feedback: canonicalFeedback },
        } as never);

        await expect(loadTeacherCanonicalFeedback("attempt-1")).resolves.toMatchObject({ status: "loaded" });
        expect(mocks.resolveServerPlanAccess).not.toHaveBeenCalled();
        mocks.saveTeacherFeedbackWithGateway.mockResolvedValue({ status: "saved", item: canonicalFeedback });
        await expect(saveTeacherCanonicalFeedback(canonicalFeedback)).resolves.toMatchObject({ status: "saved" });
        await expect(returnTeacherCanonicalFeedback(canonicalFeedback)).resolves.toMatchObject({ status: "returned" });
    });

    it("normalizes a database entitlement race to the stable plan_denied status", async () => {
        mocks.resolveServerPlanAccess.mockResolvedValue({
            authenticated: true,
            authoritative: true,
            plan: "pro",
            source: "supabase",
        });
        mocks.saveTeacherFeedbackWithGateway.mockResolvedValue({
            status: "service_unavailable",
            error: "plan entitlement required",
        });

        await expect(saveTeacherCanonicalFeedback({} as never)).resolves.toMatchObject({
            status: "plan_denied",
        });
    });
});
