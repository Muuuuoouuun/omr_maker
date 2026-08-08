import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (relativePath: string) => readFileSync(path.join(root, relativePath), "utf8");

describe("atomic operator pilot-teacher provisioning migration", () => {
    const migration = read("supabase/migrations/202608080006_initial_operator_provisioning.sql");
    const boundary = read("supabase/production-server-boundary.sql");
    const rollback = read("supabase/production-server-boundary-rollback.sql");
    const live = read("supabase/live-test-assertions.sql");

    it("stores only bounded hashed idempotency state behind FORCE RLS", () => {
        expect(migration).toContain("create table public.omr_pilot_plan_grants");
        expect(migration).toContain("idempotency_key_hash text not null");
        expect(migration).toContain("request_hash text not null");
        expect(migration).toMatch(/unique \(idempotency_key_hash\)/i);
        expect(migration).toMatch(/idempotency_key_hash ~ '\^\[a-f0-9\]\{64\}\$'/i);
        expect(migration).toMatch(/request_hash ~ '\^\[a-f0-9\]\{64\}\$'/i);
        expect(migration).toContain("superseded_at timestamptz");
        expect(migration).toContain("state text not null default 'active'");
        expect(migration).toMatch(/state in \('active', 'superseded'\)/i);
        expect(migration).toMatch(/enable row level security/i);
        expect(migration).toMatch(/force row level security/i);
        expect(migration).toMatch(
            /revoke all on table public\.omr_pilot_plan_grants\s+from public, anon, authenticated, service_role/i,
        );
        expect(migration).not.toMatch(/\b(email|display_name|password_hash|actor|reason)\s+text/i);
    });

    it("exposes one exact service-role-only, owner-pinned provisioning RPC", () => {
        expect(migration.match(/create function public\.omr_provision_pilot_teacher_v1\s*\(/gi)).toHaveLength(1);
        for (const input of [
            "p_organization_name text",
            "p_email text",
            "p_display_name text",
            "p_password_hash text",
            "p_plan text",
            "p_expires_at timestamptz",
            "p_actor text",
            "p_reason text",
            "p_idempotency_key text",
        ]) expect(migration).toContain(input);
        expect(migration).toContain("returns jsonb");
        expect(migration).toContain("security definer");
        expect(migration).toContain("set search_path = ''");
        expect(migration).toContain("set statement_timeout = '10s'");
        expect(migration).toContain("set lock_timeout = '3s'");
        expect(migration).toContain("v_actor !~ '^operator:[a-z0-9][a-z0-9._-]{0,63}$'");
        expect(migration).toContain("v_reason !~ '^[a-z][a-z0-9_]{0,63}$'");
        expect(migration).toMatch(/alter function public\.omr_provision_pilot_teacher_v1[\s\S]+owner to postgres/i);
        expect(migration).toMatch(/grant execute on function public\.omr_provision_pilot_teacher_v1[\s\S]+to service_role/i);
        expect(migration).not.toMatch(/grant execute[^;]+\bto\s+(anon|authenticated)\b/i);
    });

    it("binds replay to every normalized field and mutates nothing before conflict resolution", () => {
        expect(migration).toContain("pg_catalog.pg_advisory_xact_lock");
        expect(migration).toContain("for update");
        expect(migration).toContain("on conflict (idempotency_key_hash) do nothing");
        for (const requestField of [
            "organizationName", "email", "displayName", "passwordHash",
            "plan", "expiresAt", "actor", "reason",
        ]) expect(migration).toContain(`'${requestField}'`);
        expect(migration).toContain("raise exception 'idempotency_conflict'");
        expect(migration).toContain("'replayed', true");
        expect(migration).toContain("'replayed', false");
        expect(migration).toContain("update public.omr_teacher_account_tokens");
        expect(migration).toContain("insert into public.omr_teacher_profiles");
        expect(migration).toContain("from public.omr_teacher_profiles profile");
        expect(migration).toMatch(/session_generation = account\.session_generation \+ 1/i);
        expect(migration).toContain("raise exception 'provisioning_conflict'");
    });

    it("returns no credential material and writes an allowlisted audit payload", () => {
        expect(migration).toContain("insert into public.omr_audit_logs");
        for (const key of [
            "reason", "beforePlan", "afterPlan", "expiresAt", "grantId",
            "beforeSessionGeneration", "afterSessionGeneration",
        ]) expect(migration).toContain(`'${key}'`);
        for (const safeResultKey of [
            "organizationId", "accountId", "grantId", "plan", "expiresAt", "replayed",
        ]) expect(migration).toContain(`'${safeResultKey}'`);
        expect(migration).not.toContain("'idempotencyKey'");
    });

    it("provides a trusted effective-plan boundary that expires and supersedes grants", () => {
        expect(migration).toContain("create function public.omr_read_effective_workspace_plan_v1");
        expect(migration).toContain("grant execute on function public.omr_read_effective_workspace_plan_v1(text) to service_role");
        expect(migration).toMatch(/superseded_at is null[\s\S]+expires_at > pg_catalog\.clock_timestamp\(\)/i);
        expect(migration).toContain("'plan', 'free'");
        expect(live).toContain("expired pilot grant did not resolve to effective free");
        expect(live).toContain("pilot provisioning materialized a paid legacy plan");
    });

    it("is wired into exact production, rollback, live, and readiness contracts", () => {
        for (const source of [boundary, rollback]) {
            expect(source).toContain("public.omr_pilot_plan_grants");
            expect(source).toContain("omr_provision_pilot_teacher_v1");
            expect(source).toContain("omr_read_effective_workspace_plan_v1");
        }
        expect(boundary).toContain("'version', '202608080006'");
        expect(boundary).toContain("'operatorPilotProvisioningReady'");
        for (const readinessProof of [
            "omr_pilot_plan_grants_one_current_org_idx",
            "omr_pilot_plan_grants_idempotency_hash_unique",
            "omr_pilot_plan_grants_state_check",
            "omr_pilot_plan_grants_expiry_check",
            "omr_pilot_plan_grants_superseded_check",
            "grant_row.state = ''active''",
            "grant_row.superseded_at is null",
            "grant_row.expires_at > pg_catalog.clock_timestamp()",
            "'''plan'', ''free'''",
            "v_existing_grant.request_hash is distinct from v_request_hash",
            "pg_catalog.pg_advisory_xact_lock(20260808, pg_catalog.hashtext(v_email))",
            "session_generation = account.session_generation + 1",
            "insert into public.omr_audit_logs",
        ]) expect(boundary).toContain(readinessProof);
        for (const evidence of [
            "operator provisioning exact replay mutated state",
            "operator provisioning idempotency conflict mutated state",
            "operator provisioning verifier conflict mutated state",
            "operator provisioning concurrent replay duplicated state",
            "operator provisioning distinct-key email race mixed state",
            "operator provisioning conflicting email race orphaned state",
            "operator provisioning replacement did not rotate exactly one session generation",
            "operator provisioning audit failure was not atomic",
            "operator provisioning replacement audit failure was not atomic",
            "operator provisioning unsafe existing account was accepted",
            "operator provisioning effective-plan body drift passed readiness",
            "operator provisioning current-grant index drift passed readiness",
            "operator provisioning ledger constraint drift passed readiness",
            "operator provisioning mutation body drift passed readiness",
            "operator provisioning second membership was accepted",
            "operator provisioning second profile was accepted",
            "operator provisioning RPC exposed to anon",
            "operator provisioning RPC exposed to authenticated",
            "pilot grant ledger exposed to %",
            "operator provisioning leaked PII or secret material",
        ]) expect(live).toContain(evidence);
    });
});
