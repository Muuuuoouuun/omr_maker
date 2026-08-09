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
        expect(migration).toContain("p_plan is null");
        expect(migration).toContain("p_expires_at > v_now + interval '366 days'");
        expect(migration.indexOf("p_expires_at > v_now + interval '366 days'"))
            .toBeLessThan(migration.indexOf("v_request := pg_catalog.jsonb_build_object"));
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
            "plan", "expiresAtEpochMicros", "actor", "reason",
        ]) expect(migration).toContain(`'${requestField}'`);
        expect(migration).toContain("extract(epoch from p_expires_at) * 1000000");
        expect(migration).toContain("p_expires_at at time zone 'UTC'");
        expect(migration).toContain("'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"'");
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
        expect(boundary).toContain("'version', '202608090001'");
        expect(boundary).toContain("'operatorPilotProvisioningReady'");
        for (const readinessProof of [
            "omr_pilot_plan_grants_one_current_org_idx",
            "omr_pilot_plan_grants_idempotency_hash_unique",
            "omr_pilot_plan_grants_state_check",
            "omr_pilot_plan_grants_expiry_check",
            "omr_pilot_plan_grants_superseded_check",
            "extensions.digest(pg_catalog.pg_get_functiondef",
            "282a79ed02c1a3cfc927248cf554ff5ae64eb73b18b8b1f658396d466f884a46",
            "fcd083ee1f40a923e03cc8fd7bfccbdaa70d74d34a2e8dc35e7439760b099b45",
            "9e546425eaa75644fb8ee944062da143dad242f4424061910bee2fab4ea07670",
            "a28a831abf38473c8a7d6989749d298b2de2c6d7629fb08925c146a5c57e0bc1",
            "e05ecee3e626ee9d15f3143003f5fe0ea9b0a31ffabe9a395fbff7dac1d17fec",
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
            "operator provisioning effective expiry OR-true drift passed readiness",
            "operator provisioning expiry constraint OR-true drift passed readiness",
            "operator provisioning cross-timezone exact instant did not replay",
            "operator provisioning cross-timezone changed instant did not conflict atomically",
            "operator provisioning null plan did not fail as invalid request",
            "operator provisioning extreme finite expiry did not fail as invalid request",
            "expired pilot receipt did not replay deterministically",
            "operator provisioning second membership was accepted",
            "operator provisioning second profile was accepted",
            "operator provisioning RPC exposed to anon",
            "operator provisioning RPC exposed to authenticated",
            "pilot grant ledger exposed to %",
            "operator provisioning leaked PII or secret material",
        ]) expect(live).toContain(evidence);
    });
});
