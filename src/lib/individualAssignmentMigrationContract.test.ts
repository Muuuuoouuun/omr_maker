import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function read(path: string): string {
    try { return readFileSync(path, "utf8"); } catch { return ""; }
}

const migration = read("supabase/migrations/202608060032_individual_student_assignments.sql");

describe("individual student assignment migration contract", () => {
    it("provides one service-role-only atomic assignment plus targets RPC with CAS and idempotency", () => {
        expect(migration).toContain("create or replace function public.omr_assign_students_v1");
        expect(migration).toContain("p_expected_revision bigint");
        expect(migration).toContain("p_mutation_id text");
        expect(migration).toMatch(/cardinality\(v_target_ids\)[\s\S]*100/);
        expect(migration).toContain("revision_conflict");
        expect(migration).toContain("mutation_conflict");
        expect(migration).toMatch(/revoke all on function public\.omr_assign_students_v1[\s\S]*from public, anon, authenticated/);
        expect(migration).toMatch(/grant execute on function public\.omr_assign_students_v1[\s\S]*to service_role/);
    });

    it("validates organization, exam, active teacher role, and every active roster target", () => {
        expect(migration).toContain("omr_organization_members");
        expect(migration).toMatch(/role in \('owner', 'admin', 'teacher', 'assistant'\)/);
        expect(migration).toContain("omr_student_profiles");
        expect(migration).toContain("omr_class_students");
        expect(migration).toContain("enrollment_status = 'active'");
        expect(migration).toContain("student.status = 'active'");
        expect(migration).toContain("exam.archived = false");
    });

    it("keeps student ids out of assignment metadata and enforces target checks at session and attempt writes", () => {
        expect(migration).not.toMatch(/metadata[^;]*(student_ids|target_student_ids)/i);
        expect(migration).toContain("omr_validate_targeted_attempt_session_v1");
        expect(migration).toContain("omr_validate_targeted_attempt_v1");
        expect(migration).toContain("p_identity_type not in ('temporary', 'registered')");
        expect(migration).toContain("omr_assignment_targets");
    });

    it("exposes bounded student list/resolve RPCs and query-supporting indexes", () => {
        expect(migration).toContain("omr_list_student_assignments_v1");
        expect(migration).toContain("omr_resolve_student_assignment_v1");
        expect(migration).toContain("limit 101");
        expect(migration).toContain("omr_assignment_targets_active_student_idx");
        expect(migration).toContain("omr_assignments_targeted_exam_idx");
        expect(migration).toContain("omr_assignment_targets_retake_source_idx");
        expect(migration).toContain("omr_attempts_student_exam_base_completed_idx");
    });

    it("atomically switches the exam to targeted and blocks first or edited assignment while the exam has an active session", () => {
        const assignFunction = migration.slice(
            migration.indexOf("create or replace function public.omr_assign_students_v1"),
            migration.indexOf("create or replace function public.omr_load_teacher_student_assignment_v1"),
        );
        expect(assignFunction).toContain("for update");
        expect(assignFunction).toMatch(/attempt_session\.exam_id\s*=\s*v_exam\.id/);
        expect(assignFunction).toMatch(/attempt_session\.status\s*=\s*'in_progress'/);
        expect(assignFunction).toContain("update public.omr_exams exam");
        expect(assignFunction).toContain("pg_catalog.jsonb_build_object('type', 'targeted')");
        expect(assignFunction.indexOf("active_sessions")).toBeLessThan(assignFunction.indexOf("update public.omr_exams exam"));
    });

    it("fails closed for null identities and null assignment ids on targeted exams", () => {
        const scopeFunction = migration.slice(
            migration.indexOf("create or replace function public.omr_assert_targeted_assignment_scope_v1"),
            migration.indexOf("create or replace function public.omr_validate_targeted_attempt_session_v1"),
        );
        expect(scopeFunction).toContain("p_identity_type is null");
        expect(scopeFunction).toContain("targeted exam requires assignment");
        expect(scopeFunction).toContain("exam.payload #>> '{accessConfig,type}'");
        expect(migration).toMatch(/where p_identity_type in \('guest', 'temporary', 'registered'\)/);
    });

    it("requires an active class as well as an active enrollment at assign, list, resolve, and write time", () => {
        const activeClassJoins = migration.match(/join public\.omr_classes class/g) || [];
        expect(activeClassJoins).toHaveLength(4);
        expect((migration.match(/class\.status = 'active'/g) || []).length).toBeGreaterThanOrEqual(4);
    });

    it("enforces the retake entitlement at the database assignment and write boundaries", () => {
        expect(migration).toContain("'status', 'plan_denied'");
        expect(migration).toContain("free plan denies retake");
        expect(migration).toMatch(/organization\.plan\s*=\s*'free'/);
    });

    it("provides a service-role-only atomic clear RPC for public or group access", () => {
        expect(migration).toContain("create or replace function public.omr_clear_student_assignment_v1");
        expect(migration).toContain("p_access_type text");
        expect(migration).toContain("p_group_ids text[]");
        expect(migration).toContain("'cleared'");
        expect(migration).toMatch(/update public\.omr_assignments assignment[\s\S]*status = 'archived'/);
        expect(migration).toMatch(/update public\.omr_exams exam[\s\S]*p_access_type/);
        expect(migration).toMatch(/revoke all on function public\.omr_clear_student_assignment_v1[\s\S]*from public, anon, authenticated/);
        expect(migration).toMatch(/grant execute on function public\.omr_clear_student_assignment_v1[\s\S]*to service_role/);
    });
});
