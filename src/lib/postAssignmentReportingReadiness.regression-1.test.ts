import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function read(path: string): string {
    return readFileSync(path, "utf8");
}

// Regression: migrations 032/033 must not be considered release-ready merely
// because their RPCs exist. The production boundary, readiness probe, live
// assertions, and rollback/reapply matrix all need to recognize them.
describe("individual assignment and exact reporting release boundary", () => {
    const productionBoundary = read("supabase/production-server-boundary.sql");
    const liveAssertions = read("supabase/live-test-assertions.sql");
    const boundaryAssertions = read("supabase/live-test-boundary-assertions.sql");
    const rollbackAssertions = read("supabase/live-test-rollback-assertions.sql");
    const verifier = read("scripts/verify-supabase-live.mjs");
    const readinessProbe = read("src/lib/supabaseReadinessProbe.ts");
    const deploymentReadiness = read("src/lib/deploymentReadiness.ts");

    it("requires the targeted-assignment RPC family in production readiness", () => {
        for (const name of [
            "omr_assign_students_v1",
            "omr_clear_student_assignment_v1",
            "omr_load_teacher_student_assignment_v1",
            "omr_list_student_assignments_v1",
            "omr_resolve_student_assignment_v1",
        ]) {
            expect(productionBoundary).toContain(name);
            expect(liveAssertions).toContain(name);
        }
        expect(productionBoundary).toContain("individualStudentAssignmentsReady");
        expect(productionBoundary).toContain("omr_assignment_targets_retake_source_idx");
        expect(productionBoundary).toContain("omr_attempts_student_exam_base_completed_idx");
        expect(boundaryAssertions).toContain("individualStudentAssignmentsReady");
        expect(readinessProbe).toContain('"individualStudentAssignmentsReady"');
        expect(deploymentReadiness).toContain("individualStudentAssignmentsReady:");
        expect(rollbackAssertions).toContain("omr_assign_students_v1");
        expect(rollbackAssertions).toContain("omr_clear_student_assignment_v1");
    });

    it("requires every targeted-assignment trigger helper to remain private", () => {
        const readinessBlock = productionBoundary.slice(
            productionBoundary.indexOf("v_individual_student_assignments_ready :="),
            productionBoundary.indexOf("v_teacher_attempt_reporting_ready :="),
        );
        for (const name of [
            "omr_assert_targeted_assignment_scope_v1",
            "omr_validate_targeted_attempt_session_v1",
            "omr_validate_targeted_attempt_v1",
            "omr_guard_targeted_exam_access_v1",
        ]) {
            expect(readinessBlock).toContain(name);
        }
    });

    it("requires exact aggregate and cursor export in production readiness", () => {
        for (const name of [
            "omr_teacher_attempt_aggregate_v1",
            "omr_teacher_attempt_export_v1",
            "omr_teacher_attempt_export_page_v1",
        ]) {
            expect(productionBoundary).toContain(name);
            expect(liveAssertions).toContain(name);
        }
        expect(productionBoundary).toContain("teacherAttemptReportingReady");
        expect(productionBoundary).toContain("omr_attempts_org_completed_finished_desc_idx");
        expect(productionBoundary).toContain("omr_attempts_org_exam_completed_finished_desc_idx");
        expect(boundaryAssertions).toContain("teacherAttemptReportingReady");
        expect(readinessProbe).toContain('"teacherAttemptReportingReady"');
        expect(deploymentReadiness).toContain("teacherAttemptReportingReady:");
        expect(rollbackAssertions).toContain("omr_teacher_attempt_export_page_v1");
        expect(rollbackAssertions).toContain("omr_teacher_attempt_export_v1");
    });

    it("discovers all ordered migrations and runs rollback reapply", () => {
        expect(verifier).toContain('readdirSync(resolve(root, "supabase/migrations"))');
        expect(verifier).toMatch(/filter\(name => name\.endsWith\("\.sql"\)\)[\s\S]*\.sort\(\)/);
        expect(verifier).toMatch(/live-test-rollback-assertions\.sql[\s\S]*production-server-boundary\.sql/);
    });
});
