import { describe, expect, it, vi } from "vitest";
import type { StudentServerIdentity } from "@/lib/studentServerSession";

const student: StudentServerIdentity = {
    kind: "student",
    organizationId: "org-1",
    studentId: "student-1",
    name: "학생 1",
    identityType: "registered",
    issuedAt: 1,
    expiresAt: 2,
};

const guest: StudentServerIdentity = {
    kind: "guest",
    guestId: "guest-1",
    organizationId: "org-1",
    name: "게스트",
    studentId: "guest:guest-1",
    identityType: "guest",
    issuedAt: 1,
    expiresAt: 2,
};

async function subject() {
    try {
        return await import("./studentTargetedAssignmentGateway.server");
    } catch {
        return {} as typeof import("./studentTargetedAssignmentGateway.server");
    }
}

describe("student targeted assignment gateway", () => {
    it("lists only the signed student's server-authorized assignment rows", async () => {
        const gateway = await subject();
        expect(gateway.listStudentAssignmentsWithGateway).toBeTypeOf("function");
        if (!gateway.listStudentAssignmentsWithGateway) return;
        const rpc = vi.fn(async () => ({ data: [{
            assignment_id: "assignment-1",
            assignment_mode: "retake",
            retake_source_attempt_id: "attempt-1",
            retake_question_ids: [2, 4],
            id: "exam-1",
            title: "개별 재시험",
            created_at: "2026-08-07T00:00:00.000Z",
            updated_at: "2026-08-07T01:00:00.000Z",
            archived: false,
            duration_min: 30,
            access_type: "targeted",
        }], error: null }));

        await expect(gateway.listStudentAssignmentsWithGateway({ rpc }, student)).resolves.toEqual({
            status: "loaded",
            assignments: [{
                id: "exam-1",
                assignmentId: "assignment-1",
                assignmentMode: "retake",
                retakeSourceAttemptId: "attempt-1",
                retakeQuestionIds: [2, 4],
                title: "개별 재시험",
                createdAt: "2026-08-07T00:00:00.000Z",
                updatedAt: "2026-08-07T01:00:00.000Z",
                archived: false,
                durationMin: 30,
                access: { type: "targeted", entryCheck: "required" },
            }],
        });
        expect(rpc).toHaveBeenCalledWith("omr_list_student_assignments_v1", expect.objectContaining({
            p_organization_id: "org-1",
            p_owner_student_id: "student-1",
            p_identity_type: "registered",
        }));
    });

    it("refuses a guest before any targeted-assignment RPC", async () => {
        const gateway = await subject();
        expect(gateway.resolveStudentTargetedAssignmentWithGateway).toBeTypeOf("function");
        if (!gateway.resolveStudentTargetedAssignmentWithGateway) return;
        const rpc = vi.fn();
        await expect(gateway.resolveStudentTargetedAssignmentWithGateway(
            { rpc }, guest, "assignment-1", "exam-1",
        )).resolves.toEqual({ status: "denied" });
        expect(rpc).not.toHaveBeenCalled();
    });

    it("resolves assignment, retake source, and question scope from the database only", async () => {
        const gateway = await subject();
        expect(gateway.resolveStudentTargetedAssignmentWithGateway).toBeTypeOf("function");
        if (!gateway.resolveStudentTargetedAssignmentWithGateway) return;
        const rpc = vi.fn(async () => ({ data: {
            status: "authorized",
            assignmentId: "assignment-1",
            examId: "exam-1",
            mode: "retake",
            sourceAttemptId: "attempt-1",
            questionIds: [4, 2, 2],
        }, error: null }));

        await expect(gateway.resolveStudentTargetedAssignmentWithGateway(
            { rpc }, student, " assignment-1 ", " exam-1 ",
        )).resolves.toEqual({
            status: "authorized",
            assignmentId: "assignment-1",
            examId: "exam-1",
            mode: "retake",
            sourceAttemptId: "attempt-1",
            questionIds: [2, 4],
        });
    });
});
