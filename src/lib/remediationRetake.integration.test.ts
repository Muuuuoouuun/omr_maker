import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Attempt, Exam } from "@/types/omr";
import type { StudentExamGatewayClient } from "@/lib/studentExamServerGateway";
import type { StudentServerIdentity } from "@/lib/studentServerSession";
import { buildQuestionResults } from "@/lib/questionResultBuilder";
import { buildCanonicalQuestionResultEvidence } from "@/lib/canonicalQuestionResultManifest";
import { attemptToSupabaseRow } from "@/lib/omrPersistence";
import { resolveRemediationRetakeWithGateway } from "./remediationRetake.server";

const identity: StudentServerIdentity = { kind: "student", identityType: "registered", organizationId: "default", studentId: "student-1",
    name: "학생", issuedAt: 1, expiresAt: 2 };
const original: Exam = { id: "exam-1", organizationId: "default", title: "수학", createdAt: "2026-09-01T00:00:00Z",
    accessConfig: { type: "targeted" }, questions: [{ id: 1, number: 1, score: 5, answer: 2, choices: 5 }, { id: 2, number: 2, score: 5, answer: 3, choices: 5 }] };
const base: Attempt = { id: "source-1", examId: "exam-1", organizationId: "default", studentId: "student-1", studentProfileId: "student-1", studentName: "학생", identityType: "registered",
    examTitle: "수학", status: "completed", answers: { 1: 1, 2: 3 }, score: 5, totalScore: 10,
    startedAt: "2026-09-10T00:00:00Z", finishedAt: "2026-09-10T00:10:00Z" };
const results = buildQuestionResults(original, base);
const source = attemptToSupabaseRow({ ...base, questionResults: results, ...buildCanonicalQuestionResultEvidence(base, results) });

function fixture(options: { exam?: Exam; resolvedRevision?: number; questionIds?: number[]; sourcePresent?: boolean } = {}) {
    const queries: { table: string; filters: Record<string, string> }[] = [];
    const rpc = vi.fn(async (name: string) => {
        let data: unknown;
        if (name === "omr_student_remediation_v1") data = [{ sourceAttemptId: "source-1", examId: "exam-1", examTitle: "수학",
            dueAt: "2026-09-20T14:59:00Z", state: "assigned", targetCount: 1, correctedCount: 0 }];
        else if (name === "omr_read_effective_workspace_plan_v1") data = { organizationId: "default", plan: "pro",
            grantId: `pilot_grant_${"a".repeat(24)}`, expiresAt: "2099-01-01T00:00:00Z" };
        else if (name === "omr_list_student_assignments_v2") data = { serverNow: new Date().toISOString(), assignments: [{
            id: "exam-1", title: "수학", created_at: "2026-09-01T00:00:00Z", archived: false, access_type: "targeted",
            assignment_id: "assignment-1", assignment_revision: 8, assignment_mode: "retake", retake_source_attempt_id: "source-1",
            retake_question_ids: options.questionIds || [1],
        }] };
        else if (name === "omr_resolve_student_assignment_v2") data = { status: "authorized", examId: "exam-1", assignmentId: "assignment-1",
            assignmentRevision: options.resolvedRevision || 8, mode: "retake", sourceAttemptId: "source-1", questionIds: options.questionIds || [1] };
        else throw new Error(`Unexpected RPC: ${name}`);
        return { data, error: null };
    });
    const admin: StudentExamGatewayClient = {
        rpc,
        from(table) {
            const filters: Record<string, string> = {};
            queries.push({ table, filters });
            const query = {
                eq(column: string, value: string) { filters[column] = value; return query; },
                async maybeSingle() {
                    if (table === "omr_exams") return { data: { id: "exam-1", organization_id: "default", payload: options.exam || original }, error: null };
                    if (table === "omr_attempts") return { data: options.sourcePresent === false ? null : source, error: null };
                    throw new Error(`Unexpected table: ${table}`);
                },
            };
            return { select: () => query };
        },
    };
    return { admin, rpc, queries };
}

describe("remediation with real canonical solve validation and mocked database transport", () => {
    beforeEach(() => vi.stubEnv("STUDENT_ATTEMPT_SECRET", "remediation-test-secret-at-least-32-bytes-long"));
    afterEach(() => vi.unstubAllEnvs());
    it("validates canonical evidence and uses only read gateways before handing off", async () => {
        const { admin, rpc, queries } = fixture();
        expect(await resolveRemediationRetakeWithGateway(admin, identity, "source-1")).toEqual({ status: "ready",
            href: "/solve/exam-1?retakeFrom=source-1&questions=1&mode=wrong&assignment=assignment-1&assignmentRevision=8" });
        expect(queries.find(query => query.table === "omr_attempts")?.filters).toEqual({ id: "source-1", organization_id: "default", exam_id: "exam-1", student_id: "student-1" });
        expect(rpc.mock.calls.map(([name]) => name).sort()).toEqual(["omr_list_student_assignments_v2", "omr_read_effective_workspace_plan_v1",
            "omr_resolve_student_assignment_v2", "omr_student_remediation_v1"]);
    });
    it("rejects a changed question definition through the existing manifest boundary", async () => {
        const { admin } = fixture({ exam: { ...original, questions: original.questions.map(q => ({ ...q, score: 10 })) } });
        expect(await resolveRemediationRetakeWithGateway(admin, identity, "source-1")).toEqual({ status: "blocked", code: "questions_changed" });
    });
    it("does not silently adopt a replacement assignment revision", async () => {
        const { admin } = fixture({ resolvedRevision: 9 });
        expect(await resolveRemediationRetakeWithGateway(admin, identity, "source-1")).toEqual({ status: "blocked", code: "service_unavailable" });
    });
    it.each([{ questionIds: [2] }, { sourcePresent: false }])("requires the owned source and exact wrong-question set: %j", async options => {
        const { admin } = fixture(options);
        expect(await resolveRemediationRetakeWithGateway(admin, identity, "source-1")).toEqual({ status: "blocked", code: "questions_changed" });
    });
    it("rechecks the exam window even when the earlier assignment listing was open", async () => {
        const { admin } = fixture({ exam: { ...original, endAt: "2026-01-01T00:00:00Z" } });
        expect(await resolveRemediationRetakeWithGateway(admin, identity, "source-1")).toEqual({ status: "blocked", code: "ended" });
    });
});
