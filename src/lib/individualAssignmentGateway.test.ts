import { describe, expect, it, vi } from "vitest";
import type { WorkspaceContext } from "@/lib/workspaceContext";

const context: WorkspaceContext = {
    organizationId: "org-1",
    organizationName: "학원",
    actorUserId: "teacher-1",
    memberRole: "teacher",
};

async function subject() {
    try {
        return await import("./individualAssignmentGateway");
    } catch {
        return {} as typeof import("./individualAssignmentGateway");
    }
}

describe("individual student assignment gateway", () => {
    it("loads exact target counts for a bounded set of targeted exams", async () => {
        const gateway = await subject();
        expect(gateway.loadTeacherIndividualAssignmentTargetCountsWithGateway).toBeTypeOf("function");
        if (!gateway.loadTeacherIndividualAssignmentTargetCountsWithGateway) return;
        const calls: string[] = [];
        const client = {
            async rpc(_name: string, params: Record<string, unknown>) {
                const examId = String(params.p_exam_id);
                calls.push(examId);
                return {
                    data: [{
                        status: "loaded",
                        assignmentId: `assignment-${examId}`,
                        revision: 1,
                        mode: "base",
                        targetStudentIds: examId === "exam-a" ? ["s1", "s2"] : ["s3"],
                    }],
                    error: null,
                };
            },
        };

        await expect(gateway.loadTeacherIndividualAssignmentTargetCountsWithGateway(
            client,
            context,
            ["exam-b", "exam-a", "exam-a"],
        )).resolves.toEqual({
            status: "loaded",
            targetCounts: { "exam-a": 2, "exam-b": 1 },
            assignmentModes: { "exam-a": "base", "exam-b": "base" },
        });
        expect(calls.sort()).toEqual(["exam-a", "exam-b"]);
    });

    it("sends a bounded, normalized target set to the single atomic RPC", async () => {
        const gateway = await subject();
        expect(gateway.saveTeacherIndividualAssignmentWithGateway).toBeTypeOf("function");
        if (!gateway.saveTeacherIndividualAssignmentWithGateway) return;

        const rpc = vi.fn(async () => ({
            data: {
                status: "saved",
                assignmentId: "assignment-1",
                revision: 2,
                targetCount: 2,
                mode: "base",
            },
            error: null,
        }));
        const result = await gateway.saveTeacherIndividualAssignmentWithGateway(
            { rpc },
            context,
            {
                examId: " exam-1 ",
                targetStudentIds: [" student-2 ", "student-1", "student-2"],
                mode: "base",
                expectedRevision: 1,
            },
        );

        expect(result).toEqual({
            status: "saved",
            assignmentId: "assignment-1",
            revision: 2,
            targetCount: 2,
            mode: "base",
        });
        expect(rpc).toHaveBeenCalledOnce();
        expect(rpc).toHaveBeenCalledWith("omr_assign_students_v1", expect.objectContaining({
            p_organization_id: "org-1",
            p_actor_user_id: "teacher-1",
            p_actor_role: "teacher",
            p_exam_id: "exam-1",
            p_target_student_ids: ["student-1", "student-2"],
            p_mode: "base",
            p_expected_revision: 1,
            p_mutation_id: expect.stringMatching(/^assignment:[a-f0-9]{64}$/),
        }));
    });

    it("rejects empty, oversized, inactive-role, and malformed requests before the RPC", async () => {
        const gateway = await subject();
        expect(gateway.saveTeacherIndividualAssignmentWithGateway).toBeTypeOf("function");
        if (!gateway.saveTeacherIndividualAssignmentWithGateway) return;
        const rpc = vi.fn();
        const client = { rpc };

        await expect(gateway.saveTeacherIndividualAssignmentWithGateway(client, context, {
            examId: "exam-1", targetStudentIds: [], mode: "base", expectedRevision: 0,
        })).resolves.toEqual({ status: "invalid_request" });
        await expect(gateway.saveTeacherIndividualAssignmentWithGateway(client, context, {
            examId: "exam-1",
            targetStudentIds: Array.from({ length: 101 }, (_, index) => `student-${index}`),
            mode: "base",
            expectedRevision: 0,
        })).resolves.toEqual({ status: "invalid_request" });
        await expect(gateway.saveTeacherIndividualAssignmentWithGateway(client, {
            ...context, memberRole: "viewer",
        }, {
            examId: "exam-1", targetStudentIds: ["student-1"], mode: "base", expectedRevision: 0,
        })).resolves.toEqual({ status: "unauthorized" });
        expect(rpc).not.toHaveBeenCalled();
    });

    it("preserves CAS conflicts and retryable service failures without leaking database text", async () => {
        const gateway = await subject();
        expect(gateway.saveTeacherIndividualAssignmentWithGateway).toBeTypeOf("function");
        if (!gateway.saveTeacherIndividualAssignmentWithGateway) return;
        const input = { examId: "exam-1", targetStudentIds: ["student-1"], mode: "base" as const, expectedRevision: 3 };

        await expect(gateway.saveTeacherIndividualAssignmentWithGateway({
            rpc: vi.fn(async () => ({ data: { status: "revision_conflict", currentRevision: 4 }, error: null })),
        }, context, input)).resolves.toEqual({ status: "conflict", currentRevision: 4 });
        await expect(gateway.saveTeacherIndividualAssignmentWithGateway({
            rpc: vi.fn(async () => ({ data: null, error: { message: "password db.internal" } })),
        }, context, input)).resolves.toEqual({ status: "service_unavailable" });
        await expect(gateway.saveTeacherIndividualAssignmentWithGateway({
            rpc: vi.fn(async () => ({ data: { status: "plan_denied" }, error: null })),
        }, context, { ...input, mode: "retake" })).resolves.toEqual({ status: "plan_denied" });
    });

    it("atomically clears targeted distribution while changing to public or group access", async () => {
        const gateway = await subject();
        expect(gateway.clearTeacherIndividualAssignmentWithGateway).toBeTypeOf("function");
        if (!gateway.clearTeacherIndividualAssignmentWithGateway) return;
        const rpc = vi.fn(async () => ({ data: { status: "cleared", revision: 6 }, error: null }));

        await expect(gateway.clearTeacherIndividualAssignmentWithGateway({ rpc }, context, {
            examId: " exam-1 ", expectedRevision: 5, accessType: "group",
            groupIds: [" group-2 ", "group-1", "group-2"],
        })).resolves.toEqual({ status: "cleared", revision: 6 });
        expect(rpc).toHaveBeenCalledWith("omr_clear_student_assignment_v1", expect.objectContaining({
            p_exam_id: "exam-1",
            p_expected_revision: 5,
            p_access_type: "group",
            p_group_ids: ["group-1", "group-2"],
            p_mutation_id: expect.stringMatching(/^assignment-clear:[a-f0-9]{64}$/),
        }));
    });

    it("loads the current server revision and target ids for edit/retry", async () => {
        const gateway = await subject();
        expect(gateway.loadTeacherIndividualAssignmentWithGateway).toBeTypeOf("function");
        if (!gateway.loadTeacherIndividualAssignmentWithGateway) return;
        const rpc = vi.fn(async () => ({
            data: {
                status: "loaded", assignmentId: "assignment-1", revision: 5,
                mode: "retake", targetStudentIds: ["student-2", "student-1"],
            },
            error: null,
        }));

        await expect(gateway.loadTeacherIndividualAssignmentWithGateway({ rpc }, context, " exam-1 "))
            .resolves.toEqual({
                status: "loaded", assignmentId: "assignment-1", revision: 5,
                mode: "retake", targetStudentIds: ["student-1", "student-2"],
            });
    });
});
