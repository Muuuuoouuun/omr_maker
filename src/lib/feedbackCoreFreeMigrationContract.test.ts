import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const migrationsDir = path.join(root, "supabase/migrations");
const migrationName = "202608060027_feedback_core_free_boundary.sql";
const migrationPath = path.join(migrationsDir, migrationName);
const migration = existsSync(migrationPath) ? readFileSync(migrationPath, "utf8") : "";

function routine(name: string, nextMarker: string): string {
    const start = migration.indexOf(`create or replace function public.${name}`);
    const end = migration.indexOf(nextMarker, start + 1);
    return start >= 0 && end > start ? migration.slice(start, end) : "";
}

describe("core/free feedback boundary migration", () => {
    it("is an additive migration ordered after the initial-operations coverage gate", () => {
        const ordered = readdirSync(migrationsDir).filter(name => name.endsWith(".sql")).sort();
        expect(existsSync(migrationPath)).toBe(true);
        expect(ordered.indexOf(migrationName)).toBeGreaterThan(
            ordered.indexOf("202608060026_initial_operations_production_coverage.sql"),
        );
        expect(migration).toMatch(/^begin;/);
        expect(migration.trimEnd()).toMatch(/commit;$/);
    });

    it("allows bounded text and comments while requiring paid plan only for changed markup or annotated PDF policy", () => {
        const save = routine("omr_save_feedback_v3", "create or replace function public.omr_return_feedback_v3");

        expect(save).toContain("feedback metadata exceeds limit");
        expect(save).toContain("feedback markup exceeds limit");
        expect(save).toContain("v_requires_premium boolean := false");
        expect(save).toContain("v_feedback.markup is distinct from v_current.markup");
        expect(save).toContain("v_feedback.markup_drawings is distinct from v_current.markup_drawings");
        expect(save).toContain("allowAnnotatedPdfDownload");
        expect(save).toContain("if v_requires_premium then");
        expect(save).toContain("raise exception 'plan entitlement required'");
        expect(save).toContain("return public.omr_save_feedback_v2(");
        expect(save).not.toMatch(/summary[^;]{0,160}v_requires_premium/);
        expect(save).not.toMatch(/question_comments[^;]{0,160}v_requires_premium/);
    });

    it("returns core feedback without a plan gate and preserves CAS/replay/read-receipt behavior", () => {
        const returned = routine("omr_return_feedback_v3", "revoke all on function public.omr_save_feedback_v3");

        expect(returned).toContain("from public.omr_feedback_mutations");
        expect(returned).toContain("revision_conflict");
        expect(returned).toContain("set status = 'returned'");
        expect(returned).toContain("notification_status = 'queued'");
        expect(returned).not.toContain("plan entitlement required");
        expect(returned).not.toContain("from public.omr_organizations");
        expect(migration).toContain("feedback-core-free:202608060027");
        expect(migration).toContain("grant execute on function public.omr_save_feedback_v3");
        expect(migration).toContain("grant execute on function public.omr_return_feedback_v3");
    });

    it("advances production readiness and live assertions with the new behavioral gate", () => {
        const boundary = readFileSync(path.join(root, "supabase/production-server-boundary.sql"), "utf8");
        const readiness = readFileSync(path.join(root, "src/lib/supabaseReadinessProbe.ts"), "utf8");
        const liveBoundary = readFileSync(path.join(root, "supabase/live-test-boundary-assertions.sql"), "utf8");
        const live = readFileSync(path.join(root, "supabase/live-test-assertions.sql"), "utf8");

        expect(boundary).toContain("v_feedback_core_free_ready");
        expect(boundary).toContain("omr_save_feedback_v4");
        expect(boundary).toContain("phase-c-effective-plan-enforcement:202608080008");
        expect(boundary).toContain("'feedbackCoreFreeReady'");
        expect(boundary).toContain("'version', '202608080009'");
        expect(readiness).toContain('SUPABASE_READINESS_VERSION = "202608080009"');
        expect(readiness).toContain('"feedbackCoreFreeReady"');
        expect(liveBoundary).toContain("readiness ->> 'feedbackCoreFreeReady' <> 'true'");
        expect(live).toContain("free core feedback save did not persist bounded text and comments");
        expect(live).toContain("free feedback markup unexpectedly succeeded");
        expect(live).toContain("free annotated PDF policy unexpectedly succeeded");
        expect(live).toContain("free core feedback return did not queue the in-app notification");
        expect(live).toContain("free core feedback read receipt was not persisted");
    });
});
