import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = path.join(
    process.cwd(),
    "supabase/migrations/202608060008_feedback_premium_boundary.sql",
);
const migration = existsSync(migrationPath) ? readFileSync(migrationPath, "utf8") : "";

function functionBody(name: string, nextMarker: string): string {
    const start = migration.indexOf(`create or replace function public.${name}`);
    const end = migration.indexOf(nextMarker, start + 1);
    return start >= 0 && end > start ? migration.slice(start, end) : "";
}

describe("feedback premium migration boundary", () => {
    it("rechecks and locks the canonical paid organization plan inside both feedback mutations", () => {
        expect(existsSync(migrationPath)).toBe(true);
        expect(migration).toMatch(/^begin;/);
        expect(migration.trimEnd()).toMatch(/commit;$/);

        const save = functionBody("omr_save_feedback_v1", "create or replace function public.omr_return_feedback_v1");
        const returned = functionBody("omr_return_feedback_v1", "revoke all on function public.omr_save_feedback_v1");

        for (const body of [save, returned]) {
            expect(body).toContain("security definer");
            expect(body).toContain("set search_path = ''");
            expect(body).toContain("select organization.plan into v_plan");
            expect(body).toContain("from public.omr_organizations organization");
            expect(body).toContain("where organization.id = trim(p_organization_id)");
            expect(body).toContain("for share");
            expect(body).toContain("if v_plan is null or v_plan not in ('pro', 'academy') then");
            expect(body).toContain("raise exception 'plan entitlement required'");
        }
    });

    it("keeps the existing signatures, markup preservation, and service-role-only execution", () => {
        expect(migration).toContain("create or replace function public.omr_save_feedback_v1(\n    p_organization_id text,\n    p_feedback jsonb");
        expect(migration).toContain("create or replace function public.omr_return_feedback_v1(\n    p_organization_id text,\n    p_feedback_id text,\n    p_returned_at timestamptz default now()");
        expect(migration).toMatch(/markup_drawings\s*=\s*case[\s\S]*when p_feedback \? 'markup_drawings'[\s\S]*then excluded\.markup_drawings[\s\S]*else public\.omr_attempt_feedback\.markup_drawings[\s\S]*end/);

        for (const signature of [
            "public.omr_save_feedback_v1(text, jsonb)",
            "public.omr_return_feedback_v1(text, text, timestamptz)",
        ]) {
            expect(migration).toContain(`revoke all on function ${signature} from public, anon, authenticated`);
            expect(migration).toContain(`grant execute on function ${signature} to service_role`);
        }
    });
});
