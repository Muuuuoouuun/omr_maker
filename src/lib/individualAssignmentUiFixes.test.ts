import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { StudentAssignmentPreview, StudentAttemptSummary } from "@/lib/studentExamContract";

async function subject() {
    try {
        return await import("./studentAssignmentClassification");
    } catch {
        return {} as typeof import("./studentAssignmentClassification");
    }
}

function assignment(overrides: Partial<StudentAssignmentPreview> = {}): StudentAssignmentPreview {
    return {
        id: "exam-1",
        assignmentId: "assignment-1",
        assignmentMode: "retake",
        retakeSourceAttemptId: "base-attempt",
        retakeQuestionIds: [2],
        title: "재시험",
        createdAt: "2026-08-07T00:00:00.000Z",
        access: { type: "targeted", entryCheck: "required" },
        ...overrides,
    };
}

function attempt(overrides: Partial<StudentAttemptSummary> = {}): StudentAttemptSummary {
    return {
        id: "attempt-1",
        examId: "exam-1",
        examTitle: "시험",
        assignmentId: "assignment-1",
        status: "completed",
        score: 80,
        totalScore: 100,
        startedAt: "2026-08-07T00:00:00.000Z",
        finishedAt: "2026-08-07T00:10:00.000Z",
        ...overrides,
    };
}

describe("individual assignment UI P1/P2 behavior", () => {
    it("keeps a retake assignment in todo when only its source/base attempt is complete", async () => {
        const loaded = await subject();
        expect(loaded.findCompletedAttemptForAssignment).toBeTypeOf("function");
        if (!loaded.findCompletedAttemptForAssignment) return;
        expect(loaded.findCompletedAttemptForAssignment(assignment(), [
            attempt({ id: "base-attempt", retakeSourceAttemptId: undefined }),
        ])).toBeUndefined();
    });

    it("moves a retake assignment to done only for a completed retake in the same assignment scope", async () => {
        const loaded = await subject();
        expect(loaded.findCompletedAttemptForAssignment).toBeTypeOf("function");
        if (!loaded.findCompletedAttemptForAssignment) return;
        const completedRetake = attempt({ id: "retake-1", retakeSourceAttemptId: "base-attempt" });
        expect(loaded.findCompletedAttemptForAssignment(assignment(), [
            completedRetake,
            attempt({ id: "retake-other", assignmentId: "assignment-other", retakeSourceAttemptId: "base-attempt" }),
        ])).toEqual(completedRetake);
    });

    it("reloads the full latest target and mode after a revision conflict", async () => {
        const loaded = await subject();
        expect(loaded.reloadLatestAssignmentAfterConflict).toBeTypeOf("function");
        if (!loaded.reloadLatestAssignmentAfterConflict) return;
        const load = vi.fn(async () => ({
            status: "loaded" as const,
            assignmentId: "assignment-1",
            revision: 7,
            mode: "retake" as const,
            targetStudentIds: ["student-2", "student-1"],
        }));
        await expect(loaded.reloadLatestAssignmentAfterConflict("exam-1", load)).resolves.toEqual({
            status: "loaded",
            revision: 7,
            mode: "retake",
            targetStudentIds: ["student-2", "student-1"],
        });
        expect(load).toHaveBeenCalledWith("exam-1");
    });

    it("connects plan gating, conflict reload, atomic targeted transition and broad clear to UI/actions", () => {
        const modal = readFileSync("src/components/DistributeModal.tsx", "utf8");
        const create = readFileSync("src/app/create/page.tsx", "utf8");
        const action = readFileSync("src/app/actions/teacherAssignment.ts", "utf8");
        const examList = readFileSync("src/components/dashboard/ExamListBlock.tsx", "utf8");
        expect(modal).toContain("retakeAssignmentsEnabled");
        expect(modal).toContain("reloadLatestAssignmentAfterConflict");
        expect(modal).toContain("onClearStudentAssignment");
        expect(create).toContain("hasPlanEntitlement(currentPlan, 'retakeAssignments')");
        expect(action).toContain('authorizePlanEntitlement("retakeAssignments")');
        expect(action).toContain("clearTeacherIndividualAssignmentWithGateway");
        expect(examList).toContain('"개별 배정"');
    });
});
