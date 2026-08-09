import { readFileSync } from "node:fs";
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

const profileMocks = vi.hoisted(() => ({
    student: vi.fn(),
    group: vi.fn(),
}));

const effectivePlanMocks = vi.hoisted(() => ({
    read: vi.fn(),
}));
const entitlementMocks = vi.hoisted(() => ({ has: vi.fn() }));

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

vi.mock("@/lib/studentProfileAnalytics", () => ({
    buildStudentProfileInsight: profileMocks.student,
}));

vi.mock("@/lib/groupProfileAnalytics", () => ({
    buildGroupProfileInsight: profileMocks.group,
}));

vi.mock("@/lib/effectiveWorkspacePlanGateway", () => ({
    readEffectiveWorkspacePlan: effectivePlanMocks.read,
}));
vi.mock("@/utils/plans", () => ({
    hasPlanEntitlement: entitlementMocks.has,
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
    loadTeacherCanonicalAnalyticsSnapshots,
    loadTeacherCanonicalAttempt,
} from "@/app/actions/teacherAttempts";
import { loadTeacherCanonicalRoster } from "@/app/actions/teacherRoster";
import { loadTeacherCanonicalRosterProfile } from "@/app/actions/teacherRosterProfiles";

const PROVIDER_SENTINEL = "provider-private-row tenant=org-secret token=do-not-expose";

beforeEach(() => {
    vi.clearAllMocks();
    effectivePlanMocks.read.mockResolvedValue({ authoritative: true, plan: "pro" });
    entitlementMocks.has.mockReturnValue(true);
});

describe("canonical collection server action contract", () => {
    it("exposes analytics as a bounded snapshot-only action separate from rich attempt detail", () => {
        const source = readFileSync(`${process.cwd()}/src/app/actions/teacherAttempts.ts`, "utf8");
        const start = source.indexOf("export async function loadTeacherCanonicalAnalyticsSnapshots");
        const end = source.indexOf("export async function", start + 30);
        expect(start).toBeGreaterThanOrEqual(0);
        const action = source.slice(start, end < 0 ? undefined : end);
        expect(action).toContain("analyticsSnapshots");
        expect(action).not.toContain("attempts: result.attempts");
        expect(action).not.toMatch(/return\s+\{\s*status:\s*"loaded",\s*attempts/);
    });

    it("keeps the users initial/profile call graph on summaries plus the bounded server profile DTO", () => {
        const source = readFileSync(`${process.cwd()}/src/app/teacher/users/page.tsx`, "utf8");
        expect(source).toContain("loadTeacherAttemptSummaries");
        expect(source).toContain('await import("@/app/actions/teacherRosterProfiles")');
        expect(source).not.toContain("loadTeacherAttempts");
        expect(source).not.toContain("ensureDetailedAttempts");
        expect(source).not.toContain("buildCanonicalAttemptAnalyticsIndex");
        expect(source).not.toContain("resolveAttemptGrading");
    });

    it("shares one canonical evidence index per exam in each bounded server profile build", () => {
        for (const file of ["studentProfileAnalytics.ts", "groupProfileAnalytics.ts"]) {
            const source = readFileSync(`${process.cwd()}/src/lib/${file}`, "utf8");
            expect(source).toContain("buildCanonicalAttemptAnalyticsIndex");
            expect(source).toContain("analyticsIndexByExamId");
            expect(source).not.toContain("getAttemptQuestionResults(exam, attempt)");
        }
    });

    it("keeps dashboard rich attempts behind the explicit detail-on-demand callback", () => {
        const source = readFileSync(`${process.cwd()}/src/app/teacher/dashboard/page.tsx`, "utf8");
        expect(source.match(/loadTeacherAttempts\(\)/g)).toHaveLength(1);
        const detailStart = source.indexOf("const loadDetailedAttempts = useCallback");
        const detailEnd = source.indexOf("const applyDashboardSnapshot", detailStart);
        expect(detailStart).toBeGreaterThanOrEqual(0);
        expect(source.slice(detailStart, detailEnd)).toContain("promise: loadTeacherAttempts()");
        const initialLoadStart = source.indexOf("const loadDashboardData = useCallback");
        const initialLoadEnd = source.indexOf("const retryDashboardLoad", initialLoadStart);
        expect(source.slice(initialLoadStart, initialLoadEnd)).toContain("loadTeacherAttemptSummaries()");
        expect(source.slice(initialLoadStart, initialLoadEnd)).not.toContain("loadTeacherAttempts()");
        expect(source).toContain("activeTab === \"overview\"");
        expect(source).toContain("loadTeacherAnalyticsSnapshots()");
    });

    it("keeps remote student analytics on the bounded snapshot without a raw verifier or index path", () => {
        const source = readFileSync(`${process.cwd()}/src/components/dashboard/tabs/StudentAnalyticsTab.tsx`, "utf8");
        expect(source).not.toContain('from "@/lib/premiumAnalytics"');
        expect(source).not.toContain('from "@/lib/attemptScores"');
        expect(source).not.toContain('from "@/lib/regionalAnalytics"');
        expect(source).toContain('import("@/lib/studentAnalyticsLocalRuntime")');
        expect(source).not.toContain("buildCanonicalAttemptAnalyticsIndex");
        expect(source).not.toContain("canonicalQuestionResultManifest");
        expect(source).toContain("!requiresCanonicalSnapshot && exam && localRuntime");
        expect(source).toContain("localRuntime.resolveAttemptGrading(exam, attempt)");
        expect(source).toContain("requiresCanonicalSnapshot\n                ? canonicalStudentRowsByAttemptId.get(attempt.id)");
    });

    it("builds complete student and group profile DTOs only from exact current server collections", async () => {
        const student = { id: "student-1", name: "김학생", email: "", group: "A반" };
        const group = { id: "group-1", name: "A반", studentCount: 1 };
        const attempts = [{
            id: "attempt-1", examId: "exam-1", organizationId: "org-1", status: "completed",
            studentId: "student-1", studentProfileId: "student-1", groupId: "group-1",
            questionResults: [{}],
        }];
        const summaries = [{
            id: "attempt-1", examId: "exam-1", studentId: "student-1", studentProfileId: "student-1",
            groupId: "group-1", groupName: "A반", status: "completed", questionResultsQuestionCount: 1,
            examTitle: "시험", studentName: "김학생", startedAt: "2026-08-09T00:00:00.000Z",
            finishedAt: "2026-08-09T01:00:00.000Z", score: 1, totalScore: 1, answers: {}, detailLevel: "summary",
        }];
        const exams = [{ id: "exam-1", title: "시험", organizationId: "org-1", questions: [] }];
        const meta = { organizationId: "org-1", loadedAt: "2026-08-09T01:02:03.000Z", rawCount: 1, parsedCount: 1 };
        gatewayMocks.attemptList.mockResolvedValue({
            status: "loaded",
            attempts,
            page: { partial: false, hasMore: false, itemCount: 1 },
            meta,
        });
        gatewayMocks.attemptSummaryList.mockResolvedValue({
            status: "loaded",
            attempts: summaries,
            page: { partial: false, hasMore: false, itemCount: 1 },
            meta,
        });
        gatewayMocks.attemptLoad.mockResolvedValue({ status: "loaded", attempt: attempts[0] });
        gatewayMocks.examList.mockResolvedValue({ status: "loaded", exams, meta });
        gatewayMocks.rosterLoad.mockResolvedValue({
            status: "loaded",
            snapshot: { students: [student], groups: [group], invites: [] },
            revision: 7,
            meta,
        });
        const studentProfile = {
            attempts: [], averageScore: 80, bestScore: 80, latestScore: 80, trendDelta: 0,
            averageElapsedTimeSec: 60, averageQuestionTimeSec: 30, totalTrackedTimeSec: 60,
            focusLossCount: 0, wrongQuestionCount: 1, unansweredQuestionCount: 0,
            handwritingArchiveCount: 0, baseAttemptCount: 1, retakeAttemptCount: 0,
            weaknessGroups: [], headlineWeaknessGroups: [], mostMissedQuestions: [], tagStats: [],
        };
        const groupProfile = {
            groupId: "group-1", groupName: "A반", rosterStudentCount: 1, attemptCount: 1,
            retakeAttemptCount: 0, examCount: 1, activeStudentCount: 1, averageScore: 80,
            averageElapsedTimeSec: 60, averageQuestionTimeSec: 30, totalTrackedTimeSec: 60,
            focusLossCount: 0, wrongQuestionCount: 1, unansweredQuestionCount: 0,
            handwritingArchiveCount: 0, handwritingArchiveRate: 0, exams: [], weaknessGroups: [],
            mostMissedQuestions: [], tagStats: [], studentsNeedingAttention: [],
        };
        profileMocks.student.mockReturnValue(studentProfile);
        profileMocks.group.mockReturnValue(groupProfile);

        await expect(loadTeacherCanonicalRosterProfile({ kind: "student", id: "student-1" })).resolves.toEqual({
            status: "loaded",
            kind: "student",
            profile: studentProfile,
        });
        expect(profileMocks.student).toHaveBeenCalledWith(student, attempts, new Map([["exam-1", exams[0]]]), {
            recentLimit: 8,
            weaknessLimit: 6,
        });

        await expect(loadTeacherCanonicalRosterProfile({ kind: "group", id: "group-1" })).resolves.toEqual({
            status: "loaded",
            kind: "group",
            profile: groupProfile,
        });
        expect(profileMocks.group).toHaveBeenCalledWith(group, [student], attempts, new Map([["exam-1", exams[0]]]), {
            examLimit: 6,
            weaknessLimit: 6,
            riskLimit: 5,
        });
        expect(gatewayMocks.attemptLoad).toHaveBeenCalledTimes(2);
        expect(gatewayMocks.attemptLoad.mock.calls.map(call => call[1])).toEqual(["attempt-1", "attempt-1"]);
        expect(gatewayMocks.attemptList).not.toHaveBeenCalled();

        for (const key of [
            "answers", "correctAnswer", "selectedAnswer", "answerBody", "questionBody",
            "handwritingPayload", "payload", "token", "pin", "credential", "secret", "rawInviteUrl", "url",
        ]) {
            profileMocks.student.mockReturnValue({ ...studentProfile, [key]: `secret-${key}` });
            const secretResult = await loadTeacherCanonicalRosterProfile({ kind: "student", id: "student-1" });
            expect(secretResult).toEqual({ status: "service_unavailable", error: "프로필 분석 결과가 너무 큽니다." });
            expect(JSON.stringify(secretResult)).not.toContain(`secret-${key}`);
        }

        let accessorReads = 0;
        const accessorProfile = { ...studentProfile };
        Object.defineProperty(accessorProfile, "attempts", {
            enumerable: true,
            get() {
                accessorReads += 1;
                return [];
            },
        });
        profileMocks.student.mockReturnValue(accessorProfile);
        await expect(loadTeacherCanonicalRosterProfile({ kind: "student", id: "student-1" })).resolves.toMatchObject({
            status: "service_unavailable",
        });
        expect(accessorReads).toBe(0);

        profileMocks.student.mockReturnValue(new Proxy(studentProfile, {
            ownKeys() {
                throw new Error("proxy trap must be contained");
            },
        }));
        await expect(loadTeacherCanonicalRosterProfile({ kind: "student", id: "student-1" })).resolves.toMatchObject({
            status: "service_unavailable",
        });

        profileMocks.student.mockReturnValue({
            ...studentProfile,
            attempts: Array.from({ length: 60 }, (_, index) => ({
                id: `attempt-${index}`,
                examTitle: "가".repeat(3_000),
            })),
        });
        await expect(loadTeacherCanonicalRosterProfile({ kind: "student", id: "student-1" })).resolves.toMatchObject({
            status: "service_unavailable",
        });
    });

    it("passes exact successful collection metadata through unchanged", async () => {
        const meta = {
            organizationId: "org-1",
            loadedAt: "2026-08-09T01:02:03.000Z",
            rawCount: 0,
            parsedCount: 0,
        };
        gatewayMocks.examList.mockResolvedValue({
            status: "loaded",
            exams: [],
            meta: { ...meta, rawCount: 0, parsedCount: 0 },
        });

        await expect(listTeacherCanonicalExams()).resolves.toEqual({
            status: "loaded",
            exams: [],
            meta,
        });
    });

    it("does not combine rich attempts and analytics snapshots in one Flight action result", async () => {
        const meta = {
            organizationId: "org-1",
            loadedAt: "2026-08-09T01:02:03.000Z",
            rawCount: 0,
            parsedCount: 0,
        };
        const page = { partial: false, hasMore: false, itemCount: 0 };
        gatewayMocks.attemptList.mockResolvedValue({ status: "loaded", attempts: [], page, meta });

        await expect(listTeacherCanonicalAttempts()).resolves.toEqual({
            status: "loaded",
            attempts: [],
            page,
            meta,
        });
    });

    it("preflights an overbound 2000 by 500 summary collection without loading rich rows", async () => {
        const heapBefore = process.memoryUsage().heapUsed;
        const startedAt = performance.now();
        const attempts = Array.from({ length: 2_000 }, (_, index) => ({
            id: `attempt-${index}`,
            examId: "exam-max",
            examTitle: "대규모 시험",
            studentName: `학생 ${index}`,
            startedAt: "2026-08-09T00:00:00.000Z",
            finishedAt: "2026-08-09T01:00:00.000Z",
            score: 500,
            totalScore: 500,
            answers: {},
            detailLevel: "summary",
            status: "completed",
            questionResultsQuestionCount: 500,
        }));
        const meta = { organizationId: "org-1", loadedAt: "2026-08-09T01:02:03.000Z", rawCount: 2_000, parsedCount: 2_000 };
        gatewayMocks.attemptSummaryList.mockResolvedValue({
            status: "loaded",
            attempts,
            page: { partial: false, hasMore: false, itemCount: 2_000 },
            meta,
        });
        gatewayMocks.attemptList.mockRejectedValue(new Error("rich loader must not run"));

        const summaries = await listTeacherCanonicalAttemptSummaries();
        const result = await loadTeacherCanonicalAnalyticsSnapshots();
        const actionEnvelope = structuredClone({ summaries, analytics: result });
        const elapsedMs = performance.now() - startedAt;
        const heapDelta = process.memoryUsage().heapUsed - heapBefore;
        const maxRssBytes = process.resourceUsage().maxRSS * 1024;
        const envelopeBytes = new TextEncoder().encode(JSON.stringify(actionEnvelope)).byteLength;
        console.info("canonical summary-preflight Flight max", { elapsedMs, heapDelta, maxRssBytes, envelopeBytes });
        expect(result.status).toBe("loaded");
        if (result.status !== "loaded") return;
        expect(gatewayMocks.attemptList).not.toHaveBeenCalled();
        expect(result.analyticsSnapshots["exam-max"]).toMatchObject({
            status: "unavailable",
            advancedAggregatesComplete: false,
            studentAggregatesComplete: false,
            diagnostics: { attemptCount: 2_000, canonicalQuestionResultCount: 1_000_000 },
        });
        expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(2 * 1024 * 1024);
        expect(actionEnvelope.summaries.status).toBe("loaded");
        if (actionEnvelope.summaries.status === "loaded") {
            expect(actionEnvelope.summaries.attempts).toHaveLength(2_000);
            expect(actionEnvelope.summaries.attempts.every(attempt => (
                attempt.detailLevel === "summary"
                && Object.hasOwn(attempt, "answers")
                && Object.keys(attempt.answers).length === 0
                && !Object.hasOwn(attempt, "questionResults")
            ))).toBe(true);
        }
        expect(JSON.stringify(actionEnvelope)).not.toContain("questionResultsFullEvidenceHash");
        expect(JSON.stringify(actionEnvelope)).not.toContain("questionResultsDefinitionManifestHash");
        expect(envelopeBytes).toBeLessThan(4 * 1024 * 1024);
        expect(heapDelta).toBeLessThan(512 * 1024 * 1024);
        expect(maxRssBytes).toBeLessThan(512 * 1024 * 1024);
        expect(elapsedMs).toBeLessThan(1_500);
    });

    it("counts every row the broad rich loader could materialize, including retakes and in-progress rows", async () => {
        const attempts = Array.from({ length: 2_000 }, (_, index) => ({
            id: `mixed-${index}`,
            examId: "exam-mixed-max",
            examTitle: "혼합 대규모 시험",
            studentId: `student-${index}`,
            studentProfileId: `student-${index}`,
            studentName: `학생 ${index}`,
            startedAt: "2026-08-09T00:00:00.000Z",
            finishedAt: "2026-08-09T01:00:00.000Z",
            score: 500,
            totalScore: 500,
            answers: {},
            detailLevel: "summary",
            status: index % 2 === 0 ? "in_progress" : "completed",
            ...(index % 2 === 0 ? {} : {
                retake: {
                    sourceAttemptId: "source",
                    questionIds: [1],
                    mode: "wrong",
                    createdAt: "2026-08-09T00:30:00.000Z",
                },
            }),
            questionResultsQuestionCount: 500,
        }));
        const meta = { organizationId: "org-1", loadedAt: "2026-08-09T01:02:03.000Z", rawCount: 2_000, parsedCount: 2_000 };
        gatewayMocks.attemptSummaryList.mockResolvedValue({
            status: "loaded",
            attempts,
            page: { partial: false, hasMore: false, itemCount: 2_000 },
            meta,
        });
        gatewayMocks.attemptList.mockRejectedValue(new Error("mixed rich loader must not run"));

        const result = await loadTeacherCanonicalAnalyticsSnapshots();

        expect(result.status).toBe("loaded");
        expect(gatewayMocks.attemptList).not.toHaveBeenCalled();
        if (result.status === "loaded") expect(result.analyticsSnapshots).toEqual({});
        expect(gatewayMocks.examList).not.toHaveBeenCalled();
        expect(gatewayMocks.attemptLoad).not.toHaveBeenCalled();
    });

    it("accepts a legitimate empty in-progress summary without materializing rich rows", async () => {
        const progress = {
            id: "progress-empty", examId: "exam-progress", examTitle: "진행 시험", studentName: "학생",
            startedAt: "2026-08-09T00:00:00.000Z", finishedAt: "", score: 0, totalScore: 0,
            answers: {}, detailLevel: "summary", status: "in_progress",
        };
        const meta = { organizationId: "org-1", loadedAt: "2026-08-09T01:02:03.000Z", rawCount: 1, parsedCount: 1 };
        gatewayMocks.attemptSummaryList.mockResolvedValue({
            status: "loaded", attempts: [progress], page: { partial: false, hasMore: false, itemCount: 1 }, meta,
        });
        gatewayMocks.examList.mockResolvedValue({ status: "loaded", exams: [], meta: { ...meta, rawCount: 0, parsedCount: 0 } });

        await expect(loadTeacherCanonicalAnalyticsSnapshots()).resolves.toMatchObject({ status: "loaded" });
        expect(gatewayMocks.attemptList).not.toHaveBeenCalled();
        expect(gatewayMocks.attemptLoad).not.toHaveBeenCalled();
    });

    it("preflights 2000 eligible one-row attempts without issuing 2000 detail queries", async () => {
        const attempts = Array.from({ length: 2_000 }, (_, index) => ({
            id: `base-one-${index}`, examId: "exam-many-base", examTitle: "대규모 시험", studentName: `학생 ${index}`,
            startedAt: "2026-08-09T00:00:00.000Z", finishedAt: "2026-08-09T01:00:00.000Z",
            score: 1, totalScore: 1, answers: {}, detailLevel: "summary", status: "completed",
            questionResultsQuestionCount: 1,
        }));
        const meta = { organizationId: "org-1", loadedAt: "2026-08-09T01:02:03.000Z", rawCount: 2_000, parsedCount: 2_000 };
        gatewayMocks.attemptSummaryList.mockResolvedValue({
            status: "loaded", attempts, page: { partial: false, hasMore: false, itemCount: 2_000 }, meta,
        });

        const result = await loadTeacherCanonicalAnalyticsSnapshots();

        expect(result.status).toBe("loaded");
        expect(gatewayMocks.attemptLoad).not.toHaveBeenCalled();
        expect(gatewayMocks.examList).not.toHaveBeenCalled();
        if (result.status === "loaded") {
            expect(result.analyticsSnapshots["exam-many-base"]).toMatchObject({
                status: "unavailable",
                advancedAggregatesComplete: false,
                diagnostics: { attemptCount: 2_000, canonicalQuestionResultCount: 2_000 },
            });
        }
    });

    it("preserves the supported 100-attempt analytics path with exactly one bounded detail read per eligible attempt", async () => {
        const attempts = Array.from({ length: 100 }, (_, index) => ({
            id: `base-supported-${index}`, examId: "exam-supported", examTitle: "지원 규모 시험", studentName: `학생 ${index}`,
            startedAt: "2026-08-09T00:00:00.000Z", finishedAt: "2026-08-09T01:00:00.000Z",
            score: 1, totalScore: 1, answers: {}, detailLevel: "summary", status: "completed",
            questionResultsQuestionCount: 1,
        }));
        const meta = { organizationId: "org-1", loadedAt: "2026-08-09T01:02:03.000Z", rawCount: 100, parsedCount: 100 };
        gatewayMocks.attemptSummaryList.mockResolvedValue({
            status: "loaded", attempts, page: { partial: false, hasMore: false, itemCount: 100 }, meta,
        });
        gatewayMocks.attemptLoad.mockImplementation(async (_client, attemptId) => ({
            status: "loaded",
            attempt: {
                ...attempts.find(attempt => attempt.id === attemptId),
                organizationId: "org-1",
                detailLevel: undefined,
                questionResults: [{}],
            },
        }));
        gatewayMocks.examList.mockResolvedValue({
            status: "loaded",
            exams: [{ id: "exam-supported", organizationId: "org-1", title: "지원 규모 시험", createdAt: "2026-08-09T00:00:00.000Z", questions: [] }],
            meta: { ...meta, rawCount: 1, parsedCount: 1 },
        });

        const result = await loadTeacherCanonicalAnalyticsSnapshots();

        expect(result.status).toBe("loaded");
        expect(gatewayMocks.attemptLoad).toHaveBeenCalledTimes(100);
        expect(gatewayMocks.examList).toHaveBeenCalledTimes(1);
        expect(gatewayMocks.attemptList).not.toHaveBeenCalled();
    });

    it("ignores a legacy retake missing a declared result count because retakes are never materialized officially", async () => {
        const retake = {
            id: "legacy-retake", examId: "exam-retake", examTitle: "재시험", studentName: "학생",
            startedAt: "2026-08-09T00:00:00.000Z", finishedAt: "2026-08-09T01:00:00.000Z",
            score: 0, totalScore: 1, answers: {}, detailLevel: "summary", status: "completed",
            retake: { sourceAttemptId: "base", questionIds: [1], mode: "wrong", createdAt: "2026-08-09T00:30:00.000Z" },
        };
        const meta = { organizationId: "org-1", loadedAt: "2026-08-09T01:02:03.000Z", rawCount: 1, parsedCount: 1 };
        gatewayMocks.attemptSummaryList.mockResolvedValue({
            status: "loaded", attempts: [retake], page: { partial: false, hasMore: false, itemCount: 1 }, meta,
        });

        await expect(loadTeacherCanonicalAnalyticsSnapshots()).resolves.toEqual({
            status: "loaded", analyticsSnapshots: {}, meta,
        });
        expect(gatewayMocks.attemptLoad).not.toHaveBeenCalled();
        expect(gatewayMocks.examList).not.toHaveBeenCalled();
    });

    it("never broad-loads a forged underdeclared retake collection", async () => {
        const attempts = Array.from({ length: 2_000 }, (_, index) => ({
            id: `retake-underdeclared-${index}`, examId: "exam-retake", examTitle: "재시험", studentName: `학생 ${index}`,
            startedAt: "2026-08-09T00:00:00.000Z", finishedAt: "2026-08-09T01:00:00.000Z",
            score: 0, totalScore: 1, answers: {}, detailLevel: "summary", status: "completed",
            questionResultsQuestionCount: 1,
            retake: { sourceAttemptId: "base", questionIds: [1], mode: "wrong", createdAt: "2026-08-09T00:30:00.000Z" },
        }));
        const meta = { organizationId: "org-1", loadedAt: "2026-08-09T01:02:03.000Z", rawCount: 2_000, parsedCount: 2_000 };
        gatewayMocks.attemptSummaryList.mockResolvedValue({
            status: "loaded", attempts, page: { partial: false, hasMore: false, itemCount: 2_000 }, meta,
        });
        gatewayMocks.attemptList.mockRejectedValue(new Error("broad rich loader must stay unreachable"));

        const result = await loadTeacherCanonicalAnalyticsSnapshots();

        expect(result.status).toBe("loaded");
        expect(gatewayMocks.attemptList).not.toHaveBeenCalled();
        expect(gatewayMocks.attemptLoad).not.toHaveBeenCalled();
    });

    it("loads only eligible base details and rejects declared versus actual result-count drift", async () => {
        const summary = {
            id: "base-count-drift", examId: "exam-1", examTitle: "시험", studentName: "학생",
            startedAt: "2026-08-09T00:00:00.000Z", finishedAt: "2026-08-09T01:00:00.000Z",
            score: 1, totalScore: 1, answers: {}, detailLevel: "summary", status: "completed",
            questionResultsQuestionCount: 1,
        };
        const meta = { organizationId: "org-1", loadedAt: "2026-08-09T01:02:03.000Z", rawCount: 1, parsedCount: 1 };
        gatewayMocks.attemptSummaryList.mockResolvedValue({
            status: "loaded", attempts: [summary], page: { partial: false, hasMore: false, itemCount: 1 }, meta,
        });
        gatewayMocks.attemptLoad.mockResolvedValue({
            status: "loaded",
            attempt: { ...summary, organizationId: "org-1", detailLevel: undefined, questionResults: [] },
        });
        gatewayMocks.examList.mockResolvedValue({
            status: "loaded",
            exams: [{ id: "exam-1", organizationId: "org-1", title: "시험", createdAt: "2026-08-09T00:00:00.000Z", questions: [] }],
            meta,
        });

        await expect(loadTeacherCanonicalAnalyticsSnapshots()).resolves.toMatchObject({ status: "service_unavailable" });
        expect(gatewayMocks.attemptLoad).toHaveBeenCalledTimes(1);
        expect(gatewayMocks.attemptLoad.mock.calls[0][1]).toBe("base-count-drift");
        expect(gatewayMocks.attemptList).not.toHaveBeenCalled();
    });

    it("rejects incomplete or wrong-organization authoritative exam collections", async () => {
        const summary = {
            id: "base-exam-scope", examId: "exam-1", examTitle: "시험", studentName: "학생",
            startedAt: "2026-08-09T00:00:00.000Z", finishedAt: "2026-08-09T01:00:00.000Z",
            score: 1, totalScore: 1, answers: {}, detailLevel: "summary", status: "completed",
            questionResultsQuestionCount: 1,
        };
        const rich = { ...summary, organizationId: "org-1", detailLevel: undefined, questionResults: [{}] };
        const meta = { organizationId: "org-1", loadedAt: "2026-08-09T01:02:03.000Z", rawCount: 1, parsedCount: 1 };
        gatewayMocks.attemptSummaryList.mockResolvedValue({ status: "loaded", attempts: [summary], page: { partial: false, hasMore: false, itemCount: 1 }, meta });
        gatewayMocks.attemptLoad.mockResolvedValue({ status: "loaded", attempt: rich });

        gatewayMocks.examList.mockResolvedValue({
            status: "loaded",
            exams: [{ id: "exam-1", organizationId: "org-other", title: "시험", createdAt: "2026-08-09T00:00:00.000Z", questions: [] }],
            meta,
        });
        await expect(loadTeacherCanonicalAnalyticsSnapshots()).resolves.toMatchObject({ status: "service_unavailable" });

        gatewayMocks.examList.mockResolvedValue({
            status: "loaded",
            exams: [{ id: "exam-1", organizationId: "org-1", title: "시험", createdAt: "2026-08-09T00:00:00.000Z", questions: [] }],
            meta: { ...meta, rawCount: 2, parsedCount: 1 },
        });
        await expect(loadTeacherCanonicalAnalyticsSnapshots()).resolves.toMatchObject({ status: "service_unavailable" });
    });

    it("fails analytics preflight closed on accessors, invalid counts, or rich count mismatch", async () => {
        const base = {
            id: "attempt-1", examId: "exam-1", examTitle: "시험", studentName: "학생",
            startedAt: "2026-08-09T00:00:00.000Z", finishedAt: "2026-08-09T01:00:00.000Z",
            score: 1, totalScore: 1, answers: {}, detailLevel: "summary", status: "completed",
        };
        const meta = { organizationId: "org-1", loadedAt: "2026-08-09T01:02:03.000Z", rawCount: 1, parsedCount: 1 };
        let reads = 0;
        const accessor = { ...base };
        Object.defineProperty(accessor, "questionResultsQuestionCount", {
            enumerable: true,
            get() { reads += 1; return 1; },
        });
        gatewayMocks.attemptSummaryList.mockResolvedValue({ status: "loaded", attempts: [accessor], page: { partial: false, hasMore: false, itemCount: 1 }, meta });
        await expect(loadTeacherCanonicalAnalyticsSnapshots()).resolves.toMatchObject({ status: "service_unavailable" });
        expect(reads).toBe(0);
        expect(gatewayMocks.attemptList).not.toHaveBeenCalled();

        gatewayMocks.attemptSummaryList.mockResolvedValue({ status: "loaded", attempts: [{ ...base, questionResultsQuestionCount: 501 }], page: { partial: false, hasMore: false, itemCount: 1 }, meta });
        await expect(loadTeacherCanonicalAnalyticsSnapshots()).resolves.toMatchObject({ status: "service_unavailable" });
        expect(gatewayMocks.attemptList).not.toHaveBeenCalled();

        gatewayMocks.attemptSummaryList.mockResolvedValue({ status: "loaded", attempts: [{ ...base, questionResultsQuestionCount: 1 }], page: { partial: false, hasMore: false, itemCount: 1 }, meta });
        gatewayMocks.attemptList.mockResolvedValue({ status: "loaded", attempts: [{ ...base, detailLevel: undefined, questionResultsQuestionCount: 2 }], page: { partial: false, hasMore: false, itemCount: 1 }, meta });
        await expect(loadTeacherCanonicalAnalyticsSnapshots()).resolves.toMatchObject({ status: "service_unavailable" });
    });

    it("keeps the supported preflight path on the exact rich verifier action", async () => {
        const meta = { organizationId: "org-1", loadedAt: "2026-08-09T01:02:03.000Z", rawCount: 0, parsedCount: 0 };
        const page = { partial: false, hasMore: false, itemCount: 0 };
        gatewayMocks.attemptSummaryList.mockResolvedValue({ status: "loaded", attempts: [], page, meta });
        await expect(loadTeacherCanonicalAnalyticsSnapshots()).resolves.toEqual({
            status: "loaded",
            analyticsSnapshots: {},
            meta,
        });
        expect(gatewayMocks.attemptSummaryList).toHaveBeenCalledTimes(1);
        expect(gatewayMocks.attemptList).not.toHaveBeenCalled();
        expect(gatewayMocks.attemptLoad).not.toHaveBeenCalled();
        expect(gatewayMocks.examList).not.toHaveBeenCalled();
    });

    it("preflights paid profiles from relevant summaries and never broad-loads a million rich rows", async () => {
        const student = { id: "student-1", name: "학생", email: "", group: "A반" };
        const summaries = Array.from({ length: 2_000 }, (_, index) => ({
            id: `profile-${index}`,
            examId: "exam-profile-max",
            examTitle: "프로필 대규모 시험",
            studentId: "student-1",
            studentProfileId: "student-1",
            studentName: "학생",
            startedAt: "2026-08-09T00:00:00.000Z",
            finishedAt: "2026-08-09T01:00:00.000Z",
            score: 500,
            totalScore: 500,
            answers: {},
            detailLevel: "summary",
            status: "completed",
            questionResultsQuestionCount: 500,
        }));
        const meta = { organizationId: "org-1", loadedAt: "2026-08-09T01:02:03.000Z", rawCount: 2_000, parsedCount: 2_000 };
        gatewayMocks.attemptSummaryList.mockResolvedValue({
            status: "loaded",
            attempts: summaries,
            page: { partial: false, hasMore: false, itemCount: 2_000 },
            meta,
        });
        gatewayMocks.rosterLoad.mockResolvedValue({
            status: "loaded",
            snapshot: { students: [student], groups: [{ id: "group-1", name: "A반" }], invites: [] },
            revision: 1,
            meta,
        });
        gatewayMocks.examList.mockResolvedValue({
            status: "loaded",
            exams: [],
            meta: { ...meta, rawCount: 0, parsedCount: 0 },
        });
        gatewayMocks.attemptList.mockRejectedValue(new Error("profile broad rich loader must not run"));
        gatewayMocks.attemptLoad.mockRejectedValue(new Error("profile detail loader must not run"));

        const result = await loadTeacherCanonicalRosterProfile({ kind: "student", id: "student-1" });

        expect(result).toEqual({
            status: "service_unavailable",
            error: "프로필 분석 범위가 너무 큽니다.",
        });
        expect(gatewayMocks.attemptSummaryList).toHaveBeenCalledTimes(1);
        expect(gatewayMocks.attemptList).not.toHaveBeenCalled();
        expect(gatewayMocks.attemptLoad).not.toHaveBeenCalled();

        const groupResult = await loadTeacherCanonicalRosterProfile({ kind: "group", id: "group-1" });
        expect(groupResult).toEqual({
            status: "service_unavailable",
            error: "프로필 분석 범위가 너무 큽니다.",
        });
        expect(gatewayMocks.attemptSummaryList).toHaveBeenCalledTimes(2);
        expect(gatewayMocks.attemptList).not.toHaveBeenCalled();
        expect(gatewayMocks.attemptLoad).not.toHaveBeenCalled();
    });

    it("rejects profile details that drift from the requested stable owner or declared result count", async () => {
        const student = { id: "student-1", name: "동명이인", email: "", group: "A반" };
        const summary = {
            id: "profile-owner-drift", examId: "exam-1", examTitle: "시험", studentId: "student-1", studentProfileId: "student-1",
            studentName: "동명이인", startedAt: "2026-08-09T00:00:00.000Z", finishedAt: "2026-08-09T01:00:00.000Z",
            score: 1, totalScore: 1, answers: {}, detailLevel: "summary", status: "completed", questionResultsQuestionCount: 1,
        };
        const meta = { organizationId: "org-1", loadedAt: "2026-08-09T01:02:03.000Z", rawCount: 1, parsedCount: 1 };
        gatewayMocks.attemptSummaryList.mockResolvedValue({ status: "loaded", attempts: [summary], page: { partial: false, hasMore: false, itemCount: 1 }, meta });
        gatewayMocks.examList.mockResolvedValue({ status: "loaded", exams: [{ id: "exam-1", organizationId: "org-1", title: "시험", questions: [] }], meta });
        gatewayMocks.rosterLoad.mockResolvedValue({ status: "loaded", snapshot: { students: [student], groups: [], invites: [] }, revision: 1, meta });
        gatewayMocks.attemptLoad.mockResolvedValue({
            status: "loaded",
            attempt: { ...summary, detailLevel: undefined, organizationId: "org-1", studentId: "student-2", studentProfileId: "student-2", questionResults: [{}] },
        });

        await expect(loadTeacherCanonicalRosterProfile({ kind: "student", id: "student-1" })).resolves.toMatchObject({ status: "service_unavailable" });
        expect(profileMocks.student).not.toHaveBeenCalled();

        gatewayMocks.attemptLoad.mockResolvedValue({
            status: "loaded",
            attempt: { ...summary, detailLevel: undefined, organizationId: "org-1", questionResults: [] },
        });
        await expect(loadTeacherCanonicalRosterProfile({ kind: "student", id: "student-1" })).resolves.toMatchObject({ status: "service_unavailable" });
        expect(profileMocks.student).not.toHaveBeenCalled();
    });

    it("never infers group ownership from a display name shared by another stable identity", async () => {
        const group = { id: "group-1", name: "동명이반" };
        const rosterStudent = { id: "student-1", name: "학생", email: "", group: "동명이반" };
        const summary = {
            id: "other-group-attempt", examId: "exam-1", examTitle: "시험",
            studentId: "student-2", studentProfileId: "student-2", groupName: "동명이반",
            studentName: "다른 학생", startedAt: "2026-08-09T00:00:00.000Z",
            finishedAt: "2026-08-09T01:00:00.000Z", score: 1, totalScore: 1,
            answers: {}, detailLevel: "summary", status: "completed", questionResultsQuestionCount: 1,
        };
        const collectionMeta = { organizationId: "org-1", loadedAt: "2026-08-09T01:02:03.000Z", rawCount: 1, parsedCount: 1 };
        gatewayMocks.attemptSummaryList.mockResolvedValue({
            status: "loaded", attempts: [summary],
            page: { partial: false, hasMore: false, itemCount: 1 }, meta: collectionMeta,
        });
        gatewayMocks.examList.mockResolvedValue({
            status: "loaded", exams: [], meta: { ...collectionMeta, rawCount: 0, parsedCount: 0 },
        });
        gatewayMocks.rosterLoad.mockResolvedValue({
            status: "loaded", snapshot: { students: [rosterStudent], groups: [group], invites: [] },
            revision: 1, meta: collectionMeta,
        });
        const emptyProfile = {
            groupId: group.id, groupName: group.name, rosterStudentCount: 1, attemptCount: 0,
            retakeAttemptCount: 0, examCount: 0, activeStudentCount: 0, averageScore: 0,
            averageElapsedTimeSec: 0, averageQuestionTimeSec: 0, totalTrackedTimeSec: 0,
            focusLossCount: 0, wrongQuestionCount: 0, unansweredQuestionCount: 0,
            handwritingArchiveCount: 0, handwritingArchiveRate: 0, exams: [], weaknessGroups: [],
            mostMissedQuestions: [], tagStats: [], studentsNeedingAttention: [],
        };
        profileMocks.group.mockReturnValue(emptyProfile);

        await expect(loadTeacherCanonicalRosterProfile({ kind: "group", id: group.id })).resolves.toEqual({
            status: "loaded", kind: "group", profile: emptyProfile,
        });
        expect(gatewayMocks.attemptLoad).not.toHaveBeenCalled();
        expect(profileMocks.group).toHaveBeenCalledWith(
            group,
            [rosterStudent],
            [],
            new Map(),
            { examLimit: 6, weaknessLimit: 6, riskLimit: 5 },
        );
    });

    it("bounds profile detail concurrency and rejects oversized relevant sets before any rich read", async () => {
        const student = { id: "student-1", name: "학생", email: "", group: "A반" };
        const summaries = Array.from({ length: 21 }, (_, index) => ({
            id: `profile-bounded-${index}`, examId: "exam-1", examTitle: "시험", studentId: "student-1", studentProfileId: "student-1",
            studentName: "학생", startedAt: "2026-08-09T00:00:00.000Z", finishedAt: "2026-08-09T01:00:00.000Z",
            score: 1, totalScore: 1, answers: {}, detailLevel: "summary", status: "completed", questionResultsQuestionCount: 500,
        }));
        const meta = { organizationId: "org-1", loadedAt: "2026-08-09T01:02:03.000Z", rawCount: 21, parsedCount: 21 };
        gatewayMocks.attemptSummaryList.mockResolvedValue({ status: "loaded", attempts: summaries, page: { partial: false, hasMore: false, itemCount: 21 }, meta });
        gatewayMocks.examList.mockResolvedValue({ status: "loaded", exams: [{ id: "exam-1", organizationId: "org-1", title: "시험", questions: [] }], meta: { ...meta, rawCount: 1, parsedCount: 1 } });
        gatewayMocks.rosterLoad.mockResolvedValue({ status: "loaded", snapshot: { students: [student], groups: [], invites: [] }, revision: 1, meta: { ...meta, rawCount: 1, parsedCount: 1 } });

        await expect(loadTeacherCanonicalRosterProfile({ kind: "student", id: "student-1" })).resolves.toEqual({
            status: "service_unavailable", error: "프로필 분석 범위가 너무 큽니다.",
        });
        expect(gatewayMocks.attemptLoad).not.toHaveBeenCalled();
    });

    it("limits exact profile detail reads to six concurrent requests", async () => {
        const student = { id: "student-1", name: "학생", email: "", group: "A반" };
        const summaries = Array.from({ length: 8 }, (_, index) => ({
            id: `profile-concurrent-${index}`, examId: "exam-1", examTitle: "시험", studentId: "student-1", studentProfileId: "student-1",
            studentName: "학생", startedAt: "2026-08-09T00:00:00.000Z", finishedAt: "2026-08-09T01:00:00.000Z",
            score: 1, totalScore: 1, answers: {}, detailLevel: "summary", status: "completed", questionResultsQuestionCount: 1,
        }));
        const meta = { organizationId: "org-1", loadedAt: "2026-08-09T01:02:03.000Z", rawCount: 8, parsedCount: 8 };
        gatewayMocks.attemptSummaryList.mockResolvedValue({ status: "loaded", attempts: summaries, page: { partial: false, hasMore: false, itemCount: 8 }, meta });
        gatewayMocks.examList.mockResolvedValue({ status: "loaded", exams: [{ id: "exam-1", organizationId: "org-1", title: "시험", questions: [] }], meta: { ...meta, rawCount: 1, parsedCount: 1 } });
        gatewayMocks.rosterLoad.mockResolvedValue({ status: "loaded", snapshot: { students: [student], groups: [], invites: [] }, revision: 1, meta: { ...meta, rawCount: 1, parsedCount: 1 } });
        let active = 0;
        let maximum = 0;
        gatewayMocks.attemptLoad.mockImplementation(async (_client, attemptId) => {
            active += 1;
            maximum = Math.max(maximum, active);
            await new Promise(resolve => setTimeout(resolve, 5));
            active -= 1;
            const summary = summaries.find(item => item.id === attemptId)!;
            return { status: "loaded", attempt: { ...summary, detailLevel: undefined, organizationId: "org-1", questionResults: [{}] } };
        });
        profileMocks.student.mockReturnValue({
            attempts: [], averageScore: 100, bestScore: 100, latestScore: 100, trendDelta: 0,
            averageElapsedTimeSec: 0, averageQuestionTimeSec: 0, totalTrackedTimeSec: 0,
            focusLossCount: 0, wrongQuestionCount: 0, unansweredQuestionCount: 0,
            handwritingArchiveCount: 0, baseAttemptCount: 8, retakeAttemptCount: 0,
            weaknessGroups: [], headlineWeaknessGroups: [], mostMissedQuestions: [], tagStats: [],
        });

        await expect(loadTeacherCanonicalRosterProfile({ kind: "student", id: "student-1" })).resolves.toMatchObject({ status: "loaded" });
        expect(maximum).toBeLessThanOrEqual(6);
    });

    it("fails profile reads closed unless the server-authoritative plan grants analytics capabilities", async () => {
        const meta = { organizationId: "org-1", loadedAt: "2026-08-09T01:02:03.000Z", rawCount: 1, parsedCount: 1 };
        gatewayMocks.attemptList.mockResolvedValue({
            status: "loaded",
            attempts: [],
            page: { partial: false, hasMore: false, itemCount: 0 },
            meta,
        });
        gatewayMocks.examList.mockResolvedValue({
            status: "loaded",
            exams: [],
            meta: { ...meta, rawCount: 0, parsedCount: 0 },
        });
        gatewayMocks.rosterLoad.mockResolvedValue({
            status: "loaded",
            snapshot: { students: [{ id: "student-1", name: "학생", email: "", group: "" }], groups: [], invites: [] },
            revision: 1,
            meta,
        });
        effectivePlanMocks.read.mockResolvedValue({ authoritative: true, plan: "free" });
        entitlementMocks.has.mockReturnValue(false);

        await expect(loadTeacherCanonicalRosterProfile({ kind: "student", id: "student-1" }))
            .resolves.toEqual({ status: "forbidden" });
        expect(profileMocks.student).not.toHaveBeenCalled();
        expect(profileMocks.group).not.toHaveBeenCalled();
    });

    it("checks only the profile kind's exact server capability", async () => {
        const meta = { organizationId: "org-1", loadedAt: "2026-08-09T01:02:03.000Z", rawCount: 1, parsedCount: 1 };
        const emptyExamMeta = { ...meta, rawCount: 0, parsedCount: 0 };
        const student = { id: "student-1", name: "학생", email: "", group: "A반" };
        const group = { id: "group-1", name: "A반" };
        gatewayMocks.attemptList.mockResolvedValue({ status: "loaded", attempts: [], page: { partial: false, hasMore: false, itemCount: 0 }, meta });
        gatewayMocks.attemptSummaryList.mockResolvedValue({ status: "loaded", attempts: [], page: { partial: false, hasMore: false, itemCount: 0 }, meta });
        gatewayMocks.examList.mockResolvedValue({ status: "loaded", exams: [], meta: emptyExamMeta });
        gatewayMocks.rosterLoad.mockResolvedValue({ status: "loaded", snapshot: { students: [student], groups: [group], invites: [] }, revision: 1, meta });
        profileMocks.student.mockReturnValue({
            attempts: [], averageScore: 0, bestScore: 0, latestScore: 0, trendDelta: 0,
            averageElapsedTimeSec: 0, averageQuestionTimeSec: 0, totalTrackedTimeSec: 0,
            focusLossCount: 0, wrongQuestionCount: 0, unansweredQuestionCount: 0,
            handwritingArchiveCount: 0, baseAttemptCount: 0, retakeAttemptCount: 0,
            weaknessGroups: [], headlineWeaknessGroups: [], mostMissedQuestions: [], tagStats: [],
        });
        profileMocks.group.mockReturnValue({
            groupId: "group-1", groupName: "A반", rosterStudentCount: 1, attemptCount: 0,
            retakeAttemptCount: 0, examCount: 0, activeStudentCount: 0, averageScore: 0,
            averageElapsedTimeSec: 0, averageQuestionTimeSec: 0, totalTrackedTimeSec: 0,
            focusLossCount: 0, wrongQuestionCount: 0, unansweredQuestionCount: 0,
            handwritingArchiveCount: 0, handwritingArchiveRate: 0, exams: [], weaknessGroups: [],
            mostMissedQuestions: [], tagStats: [], studentsNeedingAttention: [],
        });
        entitlementMocks.has.mockImplementation((_plan, key) => key === "studentGrowthReports");
        await expect(loadTeacherCanonicalRosterProfile({ kind: "student", id: "student-1" })).resolves.toMatchObject({ status: "loaded" });
        await expect(loadTeacherCanonicalRosterProfile({ kind: "group", id: "group-1" })).resolves.toEqual({ status: "forbidden" });

        entitlementMocks.has.mockImplementation((_plan, key) => key === "advancedAnalytics");
        await expect(loadTeacherCanonicalRosterProfile({ kind: "group", id: "group-1" })).resolves.toMatchObject({ status: "loaded" });
        await expect(loadTeacherCanonicalRosterProfile({ kind: "student", id: "student-1" })).resolves.toEqual({ status: "forbidden" });
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
