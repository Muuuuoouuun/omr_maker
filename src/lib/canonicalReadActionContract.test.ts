import { beforeEach, describe, expect, it, vi } from "vitest";

const gatewayMocks = vi.hoisted(() => ({
    examList: vi.fn(),
    attemptList: vi.fn(),
    attemptSummaryList: vi.fn(),
    attemptLoad: vi.fn(),
    rosterLoad: vi.fn(),
}));

const observabilityMocks = vi.hoisted(() => ({
    reportServerError: vi.fn(),
}));

vi.mock("next/headers", () => ({
    headers: async () => new Headers({ host: "omr.example", origin: "https://omr.example" }),
    cookies: async () => ({ get: () => ({ value: "signed-session" }) }),
}));

vi.mock("@/lib/serverActionSecurity", () => ({
    isSameOriginServerActionRequest: () => true,
}));

vi.mock("@/lib/teacherServerSession", () => ({
    resolveAuthorizedTeacherSessionCookie: async () => ({
        teacherId: "teacher-1",
        organizationId: "org-1",
        organizationName: "교실",
        memberRole: "teacher",
    }),
    TEACHER_SERVER_SESSION_COOKIE: "omr_teacher_server_session",
}));

vi.mock("@/lib/workspaceContext", () => ({
    workspaceContextFromTeacherSession: () => ({
        organizationId: "org-1",
        organizationName: "교실",
        actorUserId: "teacher-1",
        memberRole: "teacher",
    }),
}));

vi.mock("@/lib/supabaseServerAdmin", () => ({
    createSupabaseAdminClient: () => ({ from: vi.fn(), rpc: vi.fn() }),
    getSupabaseServerConfigFromEnv: () => ({
        url: "https://supabase.example",
        serviceRoleKey: "service-role",
        backendTimeoutMs: 5_000,
    }),
}));

vi.mock("@/lib/reportServerError", () => ({
    reportServerError: observabilityMocks.reportServerError,
}));

vi.mock("@/lib/teacherExamGateway", () => ({
    listTeacherExamsWithGateway: gatewayMocks.examList,
    loadTeacherExamWithGateway: vi.fn(),
    saveTeacherExamWithGateway: vi.fn(),
    deleteTeacherExamWithGateway: vi.fn(),
}));

vi.mock("@/lib/teacherAttemptGateway", () => ({
    answerTeacherAttemptQuestionWithGateway: vi.fn(),
    forceFinishTeacherAttemptSessionsWithGateway: vi.fn(),
    forceFinishTeacherAttemptsWithGateway: vi.fn(),
    listTeacherActiveAttemptSessionsWithGateway: vi.fn(),
    listTeacherAttemptSummariesWithGateway: gatewayMocks.attemptSummaryList,
    listTeacherAttemptsWithGateway: gatewayMocks.attemptList,
    loadTeacherAttemptWithGateway: gatewayMocks.attemptLoad,
    setTeacherAttemptSubquestionReviewWithGateway: vi.fn(),
}));

vi.mock("@/lib/teacherAttemptReportingGateway", () => ({
    aggregateTeacherAttemptsWithGateway: vi.fn(),
    exportTeacherAttemptDatasetWithGateway: vi.fn(),
    exportTeacherAttemptPageWithGateway: vi.fn(),
}));

vi.mock("@/lib/teacherRosterGateway", () => ({
    loadTeacherRosterWithGateway: gatewayMocks.rosterLoad,
    saveTeacherRosterWithGateway: vi.fn(),
}));

vi.mock("@/lib/examEntryInviteGateway", () => ({
    getExamEntryInviteMetadataWithGateway: vi.fn(),
    revokeExamEntryInviteWithGateway: vi.fn(),
    rotateExamEntryInviteWithGateway: vi.fn(),
}));

vi.mock("@/lib/examEntryInviteE2eSimulation", () => ({
    createExamEntryInviteE2eSimulationClient: vi.fn(),
}));

import { listTeacherCanonicalExams } from "@/app/actions/teacherExam";
import {
    listTeacherCanonicalAttempts,
    listTeacherCanonicalAttemptSummaries,
    loadTeacherCanonicalAttempt,
} from "@/app/actions/teacherAttempts";
import { loadTeacherCanonicalRoster } from "@/app/actions/teacherRoster";

const PROVIDER_SENTINEL = "provider-private-row tenant=org-secret token=do-not-expose";

beforeEach(() => {
    vi.clearAllMocks();
});

describe("canonical collection server action contract", () => {
    it("passes exact successful collection metadata through unchanged", async () => {
        const meta = {
            organizationId: "org-1",
            loadedAt: "2026-08-09T01:02:03.000Z",
            rawCount: 0,
            parsedCount: 0,
        };
        gatewayMocks.examList.mockResolvedValue({ status: "loaded", exams: [], meta });

        await expect(listTeacherCanonicalExams()).resolves.toEqual({
            status: "loaded",
            exams: [],
            meta,
        });
    });

    it.each([
        ["exam list", gatewayMocks.examList, listTeacherCanonicalExams, "시험 목록을 불러올 수 없습니다.", "teacher-exam-read"],
        ["attempt list", gatewayMocks.attemptList, listTeacherCanonicalAttempts, "응시 목록을 불러올 수 없습니다.", "teacher-attempt-read"],
        ["attempt summary list", gatewayMocks.attemptSummaryList, listTeacherCanonicalAttemptSummaries, "응시 목록을 불러올 수 없습니다.", "teacher-attempt-read"],
        ["attempt detail", gatewayMocks.attemptLoad, () => loadTeacherCanonicalAttempt("attempt-1"), "응시 결과를 불러올 수 없습니다.", "teacher-attempt-read"],
        ["roster", gatewayMocks.rosterLoad, loadTeacherCanonicalRoster, "학생 명단을 불러올 수 없습니다.", "teacher-roster-read"],
    ] as const)("does not expose provider text from a failed %s gateway result", async (_label, gateway, action, publicError, reportContext) => {
        gateway.mockResolvedValue({ status: "service_unavailable", error: PROVIDER_SENTINEL });

        const result = await action();

        expect(result).toEqual({ status: "service_unavailable", error: publicError });
        expect(JSON.stringify(result)).not.toContain(PROVIDER_SENTINEL);
        expect(JSON.stringify(result)).not.toContain("loadedAt");
        expect(observabilityMocks.reportServerError).toHaveBeenCalledWith(reportContext, expect.objectContaining({
            diagnostic: PROVIDER_SENTINEL,
        }));
    });

    it.each([
        ["attempt list", gatewayMocks.attemptList, listTeacherCanonicalAttempts, "응시 목록을 불러올 수 없습니다."],
        ["attempt detail", gatewayMocks.attemptLoad, () => loadTeacherCanonicalAttempt("attempt-1"), "응시 결과를 불러올 수 없습니다."],
    ] as const)("routes a thrown %s provider exception to the reporter without returning it", async (_label, gateway, action, publicError) => {
        gateway.mockRejectedValue(new Error(PROVIDER_SENTINEL));

        const result = await action();

        expect(result).toEqual({ status: "service_unavailable", error: publicError });
        expect(JSON.stringify(result)).not.toContain(PROVIDER_SENTINEL);
        expect(observabilityMocks.reportServerError).toHaveBeenCalledTimes(1);
    });
});
