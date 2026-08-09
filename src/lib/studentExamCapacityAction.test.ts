import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    cookie: "",
    fetchAttemptRowsByOwner: vi.fn(),
    fetchStudentAttemptSummaryRowsByOwner: vi.fn(),
    fetchExamRowsByOrganization: vi.fn(),
    fetchStudentExamRowsByOrganization: vi.fn(),
    listStudentAssignmentsRpc: vi.fn(),
}));

vi.mock("next/headers", () => ({
    headers: vi.fn(async () => new Headers()),
    cookies: vi.fn(async () => ({
        get: vi.fn(() => ({ value: mocks.cookie })),
    })),
}));

vi.mock("@/lib/supabaseServerAdmin", async importOriginal => {
    const actual = await importOriginal<typeof import("@/lib/supabaseServerAdmin")>();
    return {
        ...actual,
        getSupabaseServerConfigFromEnv: vi.fn(() => ({
            url: "https://example.supabase.co",
            serviceRoleKey: "service-role",
            backendTimeoutMs: 9_000,
        })),
        createSupabaseAdminClient: vi.fn(() => {
            const query = {
                select() { return query; },
                eq() { return query; },
                async maybeSingle() { return { data: { plan: "free" }, error: null }; },
            };
            return {
                from: () => query,
                rpc: (name: string, params: Record<string, unknown>) => name === "omr_validate_student_session_v1"
                    ? Promise.resolve({ data: true, error: null })
                    : mocks.listStudentAssignmentsRpc(name, params),
            };
        }),
        fetchAttemptRowsByOwner: mocks.fetchAttemptRowsByOwner,
        fetchStudentAttemptSummaryRowsByOwner: mocks.fetchStudentAttemptSummaryRowsByOwner,
        fetchExamRowsByOrganization: mocks.fetchExamRowsByOrganization,
        fetchStudentExamRowsByOrganization: mocks.fetchStudentExamRowsByOrganization,
    };
});

import { listMyAssignments } from "@/app/actions/studentExam";
import { createSignedStudentSessionCookie } from "@/lib/studentServerSession";

describe("student assignment capacity action boundary", () => {
    beforeEach(() => {
        vi.stubEnv("STUDENT_SESSION_SECRET", "student-capacity-action-secret");
        mocks.cookie = createSignedStudentSessionCookie({
            kind: "student",
            accountId: `student_credential_${"a".repeat(32)}`,
            organizationId: "org-1",
            studentId: "student-1",
            name: "학생 1",
            identityType: "registered",
            credentialGeneration: 1,
        }, process.env, Date.now()) || "";
        mocks.fetchAttemptRowsByOwner.mockReset();
        mocks.fetchStudentAttemptSummaryRowsByOwner.mockReset();
        mocks.fetchExamRowsByOrganization.mockReset();
        mocks.fetchStudentExamRowsByOrganization.mockReset();
        mocks.listStudentAssignmentsRpc.mockReset();
        mocks.fetchExamRowsByOrganization.mockResolvedValue([]);
        mocks.fetchStudentExamRowsByOrganization.mockResolvedValue([]);
        mocks.listStudentAssignmentsRpc.mockImplementation(async () => ({
            data: await mocks.fetchStudentExamRowsByOrganization(),
            error: null,
        }));
        vi.spyOn(console, "error").mockImplementation(() => undefined);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });

    it("preserves the stable initial-capacity error code", async () => {
        mocks.fetchStudentAttemptSummaryRowsByOwner.mockRejectedValue(new Error("initial_capacity_exceeded"));

        await expect(listMyAssignments()).resolves.toEqual({
            status: "error",
            error: "initial_capacity_exceeded",
        });
    });

    it("does not expose raw database error text", async () => {
        mocks.fetchStudentAttemptSummaryRowsByOwner.mockRejectedValue(new Error("password authentication failed for db.internal"));

        await expect(listMyAssignments()).resolves.toEqual({ status: "error" });
    });

    it("consumes list DTOs without requiring omitted detail-only payload fields", async () => {
        mocks.fetchStudentAttemptSummaryRowsByOwner.mockResolvedValue([{
            id: "attempt-1",
            organization_id: "org-1",
            student_profile_id: "student-1",
            exam_id: "exam-1",
            exam_title: "목록 시험",
            student_name: "학생 1",
            student_id: "student-1",
            identity_type: "registered",
            status: "completed",
            score: 8,
            total_score: 10,
            score_percent: 80,
            retake_question_ids: [],
            started_at: "2026-07-14T00:00:00.000Z",
            finished_at: "2026-07-14T00:10:00.000Z",
            answers: { 1: 2 },
            question_results: [],
            student_question_summaries: [{
                questionId: 1,
                status: "answered",
                body: "",
                answer: { body: "", createdAt: "2026-07-14T00:20:00.000Z" },
            }],
        }]);
        mocks.fetchStudentExamRowsByOrganization.mockResolvedValue([{
            id: "exam-1",
            organization_id: "org-1",
            title: "목록 시험",
            created_at: "2026-07-14T00:00:00.000Z",
            updated_at: "2026-07-14T00:00:00.000Z",
            archived: false,
            access_type: "public",
            questions: [{ id: 1, label: "비밀 문항", answer: 2 }],
            pdf_data_ref: { key: "private-pdf" },
            access_config: { type: "public", pin: "4321" },
        }]);

        const result = await listMyAssignments();
        expect(result).toEqual({
            status: "ok",
            attempts: [{
                id: "attempt-1",
                examId: "exam-1",
                examTitle: "목록 시험",
                status: "completed",
                score: 8,
                totalScore: 10,
                startedAt: "2026-07-14T00:00:00.000Z",
                finishedAt: "2026-07-14T00:10:00.000Z",
                answeredQuestionCount: 1,
                latestAnsweredAt: "2026-07-14T00:20:00.000Z",
            }],
            exams: [{
                id: "exam-1",
                title: "목록 시험",
                createdAt: "2026-07-14T00:00:00.000Z",
                updatedAt: "2026-07-14T00:00:00.000Z",
                archived: false,
                lifecycle: "open",
                access: { type: "public", entryCheck: "required" },
            }],
        });
        expect(mocks.listStudentAssignmentsRpc).toHaveBeenCalledWith("omr_list_student_assignments_v1", expect.objectContaining({
            p_organization_id: "org-1",
            p_owner_student_id: "student-1",
        }));
        expect(mocks.fetchExamRowsByOrganization).not.toHaveBeenCalled();
        expect(JSON.stringify(result)).not.toMatch(/student_question_summaries|questionId|body|answers|question_results|correctAnswer|drawings|answerKeyPdf|비밀 문항|private-pdf|4321/);
    });

    it("keeps guest ownership checks functional with the lightweight list DTO", async () => {
        mocks.cookie = createSignedStudentSessionCookie({
            kind: "guest",
            guestId: "guest-1",
            organizationId: "org-1",
            name: "게스트 1",
            identityType: "guest",
        }, process.env, Date.now()) || "";
        mocks.fetchStudentAttemptSummaryRowsByOwner.mockResolvedValue([{
            id: "attempt-guest-1",
            organization_id: "org-1",
            student_profile_id: "guest:guest-1",
            exam_id: "exam-1",
            exam_title: "게스트 시험",
            guest_id: "guest-1",
            student_name: "게스트 1",
            student_id: "guest:guest-1",
            identity_type: "guest",
            status: "completed",
            score: 1,
            total_score: 1,
            score_percent: 100,
            retake_question_ids: [],
            started_at: "2026-07-14T00:00:00.000Z",
            finished_at: "2026-07-14T00:01:00.000Z",
            answers: { 1: 2 },
            question_results: [],
        }]);

        await expect(listMyAssignments()).resolves.toMatchObject({
            status: "ok",
            attempts: [{ id: "attempt-guest-1", examId: "exam-1" }],
        });
    });
});
