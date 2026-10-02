import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const migrationPath = resolve(root, "supabase/migrations/202608060033_teacher_attempt_reporting.sql");
const gatewayPath = resolve(root, "src/lib/teacherAttemptReportingGateway.ts");
const clientPath = resolve(root, "src/lib/teacherAttemptReportingClient.ts");
const projectionPath = resolve(root, "src/lib/teacherAttemptReportingProjection.ts");
const actionPath = resolve(root, "src/app/actions/teacherAttempts.ts");

// Regression: ISSUE-OPS-002 — the recent 2,000-attempt screen projection was
// reused as if it were the complete organization data set for KPIs and CSV.
// Found by /qa on 2026-08-07.
describe("teacher attempt reporting boundary", () => {
    it("ships a dedicated exact aggregate and cursor export boundary", () => {
        expect(existsSync(migrationPath)).toBe(true);
        expect(existsSync(gatewayPath)).toBe(true);
        expect(existsSync(clientPath)).toBe(true);
        expect(existsSync(projectionPath)).toBe(true);

        const migration = readFileSync(migrationPath, "utf8");
        expect(migration).toContain("omr_teacher_attempt_aggregate_v1");
        expect(migration).toContain("omr_teacher_attempt_export_page_v1");
        expect(migration).toContain("omr_teacher_attempt_export_v1");
        expect(migration).toMatch(/count\(\*\)::bigint as total_attempt_count/i);
        expect(migration).toContain("p_snapshot_at");
        expect(migration).toContain("p_limit > 500");
        expect(migration).toMatch(/\(attempt\.finished_at, attempt\.id\)\s*</i);
        expect(migration).toContain("omr_attempts_org_completed_finished_desc_idx");
        expect(migration).toContain("omr_attempts_org_exam_completed_finished_desc_idx");
        expect(migration).toContain("period_scoped as materialized");
        expect(migration).toMatch(/period_scoped as materialized[\s\S]*p_period_start is not null[\s\S]*from period_scoped/i);
        expect(migration).toMatch(/grant execute on function public\.omr_teacher_attempt_aggregate_v1[\s\S]*to service_role/i);
        expect(migration).toMatch(/grant execute on function public\.omr_teacher_attempt_export_page_v1[\s\S]*to service_role/i);
        expect(migration).toMatch(/grant execute on function public\.omr_teacher_attempt_export_v1[\s\S]*to service_role/i);

        const exportFunction = migration.slice(migration.indexOf("create function public.omr_teacher_attempt_export_page_v1"));
        const exportProjection = exportFunction.slice(0, exportFunction.indexOf("language plpgsql"));
        expect(exportProjection).not.toMatch(/student_name|student_profile_id|payload|answers|question_results/i);

        const action = readFileSync(actionPath, "utf8");
        expect(action).toContain("getTeacherCanonicalAttemptAggregate");
        expect(action).toContain("getTeacherCanonicalAttemptExportPage");
        expect(action).toContain("getTeacherCanonicalAttemptExportDataset");
        const client = readFileSync(clientPath, "utf8");
        expect(client).toContain("getTeacherCanonicalAttemptExportDataset");
        expect(client).not.toContain("getTeacherCanonicalAttemptExportPage");
        const actionContext = action.slice(action.indexOf("async function actionContext"));
        expect(actionContext.indexOf("isSameOriginServerActionRequest")).toBeLessThan(
            actionContext.indexOf("createSupabaseAdminClient"),
        );
        expect(actionContext.indexOf("resolveAuthorizedTeacherSessionCookie")).toBeLessThan(
            actionContext.indexOf("createSupabaseAdminClient"),
        );
        const reportingActions = action.slice(
            action.indexOf("getTeacherCanonicalAttemptAggregate"),
            action.indexOf("listTeacherCanonicalActiveAttemptSessions"),
        );
        expect(reportingActions).not.toContain("error.message");
    });
});
