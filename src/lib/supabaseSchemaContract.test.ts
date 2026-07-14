import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const rootDir = process.cwd();

function readSchema(): string {
    return readFileSync(path.join(rootDir, "supabase/schema.sql"), "utf8");
}

function readProductionRls(): string {
    return readFileSync(path.join(rootDir, "supabase/production-rls.sql"), "utf8");
}

function columnExists(schema: string, table: string, column: string): boolean {
    const createPattern = new RegExp(`create table if not exists public\\.${table}\\s*\\(([\\s\\S]*?)\\n\\);`, "i");
    const createMatch = schema.match(createPattern);
    const createBody = createMatch?.[1] || "";
    const createHasColumn = new RegExp(`(^|\\n)\\s*${column}\\s+`, "i").test(createBody);
    const alterHasColumn = new RegExp(`alter table public\\.${table}[\\s\\S]*?add column if not exists ${column}\\s+`, "i").test(schema);
    return createHasColumn || alterHasColumn;
}

function expectColumns(schema: string, table: string, columns: string[]) {
    const missing = columns.filter(column => !columnExists(schema, table, column));
    expect(missing, `${table} missing columns`).toEqual([]);
}

function expectIndex(schema: string, indexName: string) {
    expect(schema).toMatch(new RegExp(`create\\s+(unique\\s+)?index if not exists ${indexName}`, "i"));
}

describe("Supabase schema contract", () => {
    const schema = readSchema();
    const productionRls = readProductionRls();

    it("keeps roster columns and indexes aligned with teacher user management sync", () => {
        expectColumns(schema, "omr_organizations", [
            "id",
            "name",
            "plan",
            "metadata",
            "created_at",
            "updated_at",
        ]);

        expectColumns(schema, "omr_student_profiles", [
            "id",
            "organization_id",
            "display_name",
            "external_id",
            "email",
            "status",
            "metadata",
            "created_at",
            "updated_at",
        ]);

        expectColumns(schema, "omr_classes", [
            "id",
            "organization_id",
            "name",
            "campus",
            "status",
            "metadata",
            "created_at",
            "updated_at",
        ]);

        expectColumns(schema, "omr_class_students", [
            "class_id",
            "organization_id",
            "student_profile_id",
            "enrollment_status",
            "enrolled_at",
        ]);

        expectIndex(schema, "omr_student_profiles_org_external_id_uidx");
        expectIndex(schema, "omr_student_profiles_org_name_idx");
        expectIndex(schema, "omr_classes_organization_id_idx");
        expectIndex(schema, "omr_class_students_student_idx");
    });

    it("keeps paid-plan counters server-owned and concurrency-safe", () => {
        expectColumns(schema, "omr_plan_usage", [
            "organization_id",
            "metric",
            "period_start",
            "used",
            "updated_at",
        ]);
        expectColumns(schema, "omr_plan_usage_reservations", [
            "organization_id",
            "metric",
            "period_start",
            "resource_key",
            "amount",
            "created_at",
        ]);
        expect(schema).toContain("create or replace function public.omr_reserve_plan_usage");
        expect(schema).toContain("create or replace function public.omr_release_plan_usage");
        expect(schema).toContain("create or replace function public.omr_sync_student_plan_usage");
        expect(schema).toContain("for update;");
        expect(schema).toContain("to service_role;");
        expect(productionRls).toContain("revoke all on table public.omr_plan_usage from anon, authenticated");
    });

    it("keeps remote exam/question columns aligned with persistence row mapping", () => {
        expectColumns(schema, "omr_exams", [
            "id",
            "organization_id",
            "class_id",
            "title",
            "payload",
            "created_by_user_id",
            "created_at",
            "updated_at",
            "archived",
        ]);

        expectColumns(schema, "omr_exam_questions", [
            "id",
            "organization_id",
            "class_id",
            "exam_id",
            "question_id",
            "question_number",
            "canonical_question_id",
            "label",
            "subject",
            "unit",
            "concept",
            "skill",
            "source",
            "difficulty",
            "cognitive_level",
            "mistake_types",
            "prerequisites",
            "expected_time_sec",
            "choices",
            "correct_answer",
            "score",
            "pdf_page",
            "pdf_location",
            "pdf_region",
            "has_pdf_region",
            "asset_status",
            "image_asset_ref",
            "payload",
            "updated_at",
        ]);
    });

    it("keeps attempt fact columns for student, class, region, retake, and guest merge analytics", () => {
        expectColumns(schema, "omr_attempts", [
            "id",
            "organization_id",
            "class_id",
            "assignment_id",
            "student_profile_id",
            "exam_id",
            "student_name",
            "student_id",
            "group_id",
            "group_name",
            "region_id",
            "region_name",
            "identity_type",
            "status",
            "score",
            "total_score",
            "score_percent",
            "retake_source_attempt_id",
            "retake_mode",
            "retake_question_ids",
            "merged_from_guest_id",
            "merged_at",
            "payload",
            "started_at",
            "finished_at",
        ]);

        expectIndex(schema, "omr_attempts_exam_region_idx");
        expectIndex(schema, "omr_attempts_student_profile_idx");
        expectIndex(schema, "omr_attempts_retake_idx");
    });

    it("keeps question result fact columns and indexes for wrong-question/type analytics", () => {
        expectColumns(schema, "omr_question_results", [
            "id",
            "organization_id",
            "class_id",
            "assignment_id",
            "student_profile_id",
            "attempt_id",
            "exam_id",
            "student_name",
            "student_id",
            "group_id",
            "group_name",
            "region_id",
            "region_name",
            "identity_type",
            "question_id",
            "question_number",
            "canonical_question_id",
            "label",
            "subject",
            "unit",
            "concept",
            "skill",
            "source",
            "difficulty",
            "cognitive_level",
            "mistake_types",
            "prerequisites",
            "expected_time_sec",
            "selected_answer",
            "correct_answer",
            "status",
            "is_correct",
            "is_wrong",
            "is_unanswered",
            "score",
            "earned_score",
            "pdf_page",
            "pdf_location",
            "pdf_region",
            "time_sec",
            "visit_count",
            "revisit_count",
            "answer_change_count",
            "handwriting_stroke_count",
            "handwriting_page",
            "retake_source_attempt_id",
            "retake_mode",
            "answered_at",
            "finished_at",
            "payload",
            "updated_at",
        ]);

        expectIndex(schema, "omr_question_results_exam_region_status_idx");
        expectIndex(schema, "omr_question_results_concept_idx");
        expectIndex(schema, "omr_question_results_mistake_types_idx");
        expectIndex(schema, "omr_question_results_retake_idx");
    });

    it("keeps Kakao candidate review and dispatch tables available for pre-send workflows", () => {
        expectColumns(schema, "omr_kakao_candidate_reviews", [
            "id",
            "organization_id",
            "exam_id",
            "candidate_kind",
            "channel",
            "status",
            "title",
            "target_count",
            "student_ids",
            "student_names",
            "group_names",
            "region_names",
            "message_preview",
            "reason",
            "href",
            "reviewed_by_user_id",
            "payload",
            "reviewed_at",
            "updated_at",
        ]);

        expectColumns(schema, "omr_kakao_dispatch_logs", [
            "id",
            "organization_id",
            "review_id",
            "exam_id",
            "channel",
            "provider",
            "status",
            "target_count",
            "student_ids",
            "message_preview",
            "provider_message_id",
            "error_message",
            "payload",
            "created_at",
            "sent_at",
        ]);

        expectIndex(schema, "omr_kakao_candidate_reviews_exam_status_idx");
        expectIndex(schema, "omr_kakao_candidate_reviews_student_ids_idx");
        expectIndex(schema, "omr_kakao_dispatch_logs_status_idx");
    });

    it("keeps the production RLS handoff separate from alpha public policies", () => {
        const protectedTables = [
            "omr_organizations",
            "omr_plan_usage",
            "omr_plan_usage_reservations",
            "omr_user_profiles",
            "omr_organization_members",
            "omr_teacher_profiles",
            "omr_student_profiles",
            "omr_classes",
            "omr_class_teachers",
            "omr_class_students",
            "omr_materials",
            "omr_exams",
            "omr_exam_questions",
            "omr_exam_materials",
            "omr_assignments",
            "omr_assignment_targets",
            "omr_attempts",
            "omr_question_results",
            "omr_assignment_submissions",
            "omr_kakao_candidate_reviews",
            "omr_kakao_dispatch_logs",
            "omr_comments",
            "omr_audit_logs",
        ];

        expect(productionRls).toContain("create or replace function public.omr_is_org_member");
        expect(productionRls).toContain("create or replace function public.omr_has_org_role");
        expect(productionRls).toContain("create or replace function public.omr_can_read_assignment");
        expect(productionRls).toContain("auth.uid()");
        expect(productionRls).toContain("to authenticated");
        expect(productionRls).toContain("revoke all on all tables in schema public from anon");
        expect(productionRls).toContain("grant select on public.omr_audit_logs to authenticated");

        for (const table of protectedTables) {
            expect(productionRls, `${table} should force RLS`).toContain(`alter table public.${table} force row level security`);
        }

        expect(productionRls).toContain('drop policy if exists "OMR organizations are publicly writable"');
        expect(productionRls).toContain('drop policy if exists "OMR attempts are publicly writable"');
        expect(productionRls).not.toMatch(/using\s*\(\s*true\s*\)/i);
        expect(productionRls).not.toMatch(/with check\s*\(\s*true\s*\)/i);
    });
});
