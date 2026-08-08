import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = path.join(
    process.cwd(),
    "supabase/migrations/202608060017_roster_snapshot_cas.sql",
);
const productionBoundaryPath = path.join(process.cwd(), "supabase/production-server-boundary.sql");

describe("roster snapshot CAS migration", () => {
    it("loads rows and revision under the same organization lock", () => {
        const migration = fs.readFileSync(migrationPath, "utf8");
        const body = migration.slice(
            migration.indexOf("create function public.omr_load_roster_v2"),
            migration.indexOf("create function public.omr_save_roster_v2"),
        );

        expect(body).toContain("pg_advisory_xact_lock");
        expect(body).toContain("'revision'");
        expect(body).toContain("'classes'");
        expect(body).toContain("'students'");
        expect(body).toContain("'enrollments'");
        expect(body).toContain("'invites'");
        expect(body).toContain("limit 101");
        expect(body).toContain("limit 501");
        expect(body).toContain("limit 251");
    });

    it("locks the organization revision and rejects stale snapshot writers before saving", () => {
        const migration = fs.readFileSync(migrationPath, "utf8");
        const body = migration.slice(migration.indexOf("create function public.omr_save_roster_v2"));

        expect(body).toContain("p_expected_revision bigint");
        expect(body).toContain("pg_advisory_xact_lock");
        expect(body).toContain("roster revision conflict");
        expect(body.indexOf("roster revision conflict")).toBeLessThan(body.indexOf("public.omr_save_roster_v1"));
        expect(body).toContain("'{rosterRevision}'");
        expect(body).toContain("v_current_revision + 1");
        expect(migration).toContain("grant execute on function public.omr_save_roster_v2");
        expect(migration).toContain("to service_role");
        expect(migration).toContain("revoke execute on function public.omr_save_roster_v1");
    });

    it("keeps production readiness fail-closed on the atomic roster gateways", () => {
        const boundary = fs.readFileSync(productionBoundaryPath, "utf8");

        expect(boundary).toContain("v_roster_snapshot_cas_ready boolean");
        expect(boundary).toContain("v_roster_snapshot_cas_ready :=");
        expect(boundary).toContain("omr_load_roster_v2(text)");
        expect(boundary).toContain("omr_save_roster_v2(text,jsonb,jsonb,jsonb,jsonb,bigint)");
        expect(boundary).toContain("not pg_catalog.has_function_privilege('service_role', 'public.omr_save_roster_v1");
        expect(boundary).toContain("and v_roster_snapshot_cas_ready");
        expect(boundary).toContain("'rosterSnapshotCasReady', v_roster_snapshot_cas_ready");
        expect(boundary).toContain("'version', '202608080010'");
    });

    it("prevents workspace bootstrap from resetting the roster revision", () => {
        const migration = fs.readFileSync(migrationPath, "utf8");
        const bootstrap = migration.slice(
            migration.indexOf("create or replace function public.omr_bootstrap_workspace_organization_v1"),
        );

        expect(bootstrap).toContain("pg_advisory_xact_lock");
        expect(bootstrap).toContain("existing.metadata ? 'rosterRevision'");
        expect(bootstrap).toContain("pg_catalog.jsonb_build_object(");
        expect(bootstrap).toContain("'rosterRevision', existing.metadata->'rosterRevision'");
        expect(bootstrap).not.toContain("plan = excluded.plan");
    });
});
