import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = path.join(
    process.cwd(),
    "supabase/migrations/202608060012_feedback_cas_and_plan_safe_bootstrap.sql",
);
const migration = existsSync(migrationPath) ? readFileSync(migrationPath, "utf8") : "";
const boundary = readFileSync(path.join(process.cwd(), "supabase/production-server-boundary.sql"), "utf8");

function routine(name: string, nextMarker: string): string {
    const start = migration.indexOf(`create function public.${name}`);
    const end = migration.indexOf(nextMarker, start + 1);
    return start >= 0 && end > start ? migration.slice(start, end) : "";
}

describe("feedback CAS and plan-safe workspace bootstrap migration", () => {
    it("bootstraps organization metadata atomically without ever updating plan", () => {
        expect(existsSync(migrationPath)).toBe(true);
        const bootstrap = routine(
            "omr_bootstrap_workspace_organization_v1",
            "alter table public.omr_attempt_feedback",
        );
        expect(bootstrap).toContain("insert into public.omr_organizations");
        expect(bootstrap).toContain("'free'");
        expect(bootstrap).toContain("on conflict (id) do update set");
        expect(bootstrap).toContain("name = excluded.name");
        expect(bootstrap).toContain("metadata = excluded.metadata");
        expect(bootstrap).toContain("updated_at = excluded.updated_at");
        expect(bootstrap).not.toMatch(/do update set[\s\S]*?plan\s*=/);
        expect(bootstrap).toContain("security definer");
        expect(bootstrap).toContain("set search_path = ''");
    });

    it("installs revisioned feedback mutation receipts and private v2 gateways", () => {
        expect(migration).toContain("add column if not exists revision bigint not null default 1");
        expect(migration).toContain("create table if not exists public.omr_feedback_mutations");
        expect(migration).toContain("force row level security");
        expect(migration).toContain("revoke all on table public.omr_feedback_mutations from public, anon, authenticated, service_role");
        expect(migration).toContain("omr_feedback_mutations_created_idx");
        expect(migration).toContain("omr_feedback_mutations_org_kind_created_idx");
        expect(migration).toContain("alter function public.omr_save_feedback_v1(text, jsonb)\n    rename to omr_save_feedback_v12_snapshot");
        expect(migration).toContain("alter function public.omr_return_feedback_v1(text, text, timestamptz)\n    rename to omr_return_feedback_v12_snapshot");
        expect(migration).toContain("raise exception 'feedback save protocol upgrade required'");
        expect(migration).toContain("raise exception 'feedback return protocol upgrade required'");
    });

    it("serializes save and return with paid-plan locks, revision CAS, and deterministic replay", () => {
        const save = routine("omr_save_feedback_v2", "create function public.omr_return_feedback_v2");
        const returned = routine("omr_return_feedback_v2", "revoke all on function public.omr_bootstrap_workspace_organization_v1");
        for (const body of [save, returned]) {
            const advisoryLock = body.indexOf("pg_advisory_xact_lock");
            const receiptRead = body.indexOf("from public.omr_feedback_mutations");
            const planRead = body.indexOf("from public.omr_organizations");
            expect(advisoryLock).toBeGreaterThan(0);
            expect(receiptRead).toBeGreaterThan(advisoryLock);
            expect(planRead).toBeGreaterThan(receiptRead);
            expect(body).toContain("for share");
            expect(body).toContain("raise exception 'plan entitlement required'");
            expect(body).toContain("for update");
            expect(body).toContain("public.omr_feedback_mutations");
            expect(body).toContain("request_hash");
            expect(body).toContain("mutation_conflict");
            expect(body).toContain("revision_conflict");
            expect(body).toContain("p_expected_revision");
            expect(body).toContain("p_mutation_id");
            expect(body).toContain("limit 128");
            expect(body).toContain("for update skip locked");
            expect(body).toContain("octet_length(v_response::text) > 262144");
            expect(body).toContain("feedback receipt exceeds limit");
            expect(body).not.toContain("receipt.ctid");
        }
        expect(save).toContain("p_feedback - 'updated_at'");
        expect(save).toContain("- 'updatedAt'");
        expect(save).toContain("(p_feedback - 'markup_drawings')::text) > 262144");
        expect(save).toContain("feedback metadata exceeds limit");
        expect(save).toContain("feedback markup exceeds limit");
        expect(save).toContain("feedback markup shape exceeds limit");
        expect(returned).toContain("feedback metadata exceeds limit");
        expect(returned).toContain("octet_length((to_jsonb(v_stored) - 'markup_drawings')::text) > 262144");
        expect(save).toContain("to_jsonb(v_stored) - 'markup_drawings'");
        expect(save).toContain("v_current.status is distinct from 'draft'");
        expect(returned).toContain("v_current.status is distinct from 'draft'");
        expect(returned).toContain("set status = 'returned'");
    });

    it("keeps only v2 mutations callable by service role and advances readiness", () => {
        for (const signature of [
            "public.omr_bootstrap_workspace_organization_v1(text,text,jsonb,timestamptz)",
            "public.omr_save_feedback_v2(text,jsonb,bigint,text)",
            "public.omr_return_feedback_v2(text,text,bigint,text)",
        ]) {
            expect(migration).toContain(`revoke all on function ${signature} from public, anon, authenticated`);
            expect(migration).toContain(`grant execute on function ${signature} to service_role`);
        }
        expect(boundary).toContain("'version', '202608080009'");
        expect(boundary).toContain("'feedbackCasReady'");
        expect(boundary).toContain("'workspaceBootstrapPlanSafe'");
    });
});
