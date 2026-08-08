import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("provisioned teacher login migration", () => {
    const migration = source("supabase/migrations/202608080007_provisioned_teacher_login.sql");

    it("defines exact read-only service-role login and request validators", () => {
        for (const signature of [
            "omr_lookup_teacher_account_v1(text)",
            "omr_validate_teacher_session_v1(text,bigint)",
            "omr_begin_teacher_password_reset_v1(text,text,text,timestamptz)",
            "omr_complete_teacher_password_reset_v1(text,text)",
            "omr_lookup_provisioned_teacher_login_v1(text)",
            "omr_validate_provisioned_teacher_session_v1(text,bigint,text)",
            "omr_probe_provisioned_teacher_canary_v1(text)",
        ]) {
            expect(migration).toContain(signature);
        }
        expect(migration).toContain("set search_path = ''");
        expect(migration).toContain("set statement_timeout = '5s'");
        expect(migration).toContain("set lock_timeout = '2s'");
        expect(migration.match(/owner to postgres/gi)).toHaveLength(7);
        expect(migration.match(/to service_role/gi)).toHaveLength(7);
        expect(migration).toMatch(/from public, anon, authenticated/gi);
    });

    it("requires an exact active owner/member/profile/organization binding", () => {
        expect(migration).toContain("account.status = 'active'");
        expect(migration).toContain("member.status = 'active'");
        expect(migration).toContain("member.role = 'owner'");
        expect(migration).toContain("profile.status = 'active'");
        expect(migration).toContain("member.email = account.email");
        expect(migration).toContain("member.display_name = account.display_name");
        expect(migration).toContain("profile.display_name = account.display_name");
        expect(migration).toContain("count(*) over (partition by member.user_id)");
        expect(migration).toContain("count(*) over (partition by profile.user_id)");
        expect(migration).toContain("total_membership_count = 1");
        expect(migration).toContain("total_profile_count = 1");
        expect(migration).toContain("organization.id = member.organization_id");
        expect(migration).not.toMatch(/from public\.omr_organization_members member\s+where member\.status = 'active'/i);
        expect(migration).not.toMatch(/from public\.omr_teacher_profiles profile\s+where profile\.status = 'active'/i);
    });

    it("binds pilot provenance and every effective grant to the exact account and organization", () => {
        const provisionedAuthBodies = migration.split("create function public.omr_lookup_provisioned_teacher_login_v1")[1]
            ?.split("create function public.omr_probe_provisioned_teacher_canary_v1")[0] || "";
        expect(provisionedAuthBodies.match(/provenance_grant\.account_id = account\.id/g)).toHaveLength(2);
        expect(provisionedAuthBodies.match(/provenance_grant\.organization_id = member\.organization_id/g)).toHaveLength(2);
        expect(provisionedAuthBodies.match(/effective_grant\.id = effective\.value ->> 'grantId'/g)).toHaveLength(2);
        expect(provisionedAuthBodies.match(/effective_grant\.account_id = account\.id/g)).toHaveLength(2);
        expect(provisionedAuthBodies.match(/effective_grant\.organization_id = member\.organization_id/g)).toHaveLength(2);
        expect(provisionedAuthBodies.match(/effective_grant\.plan = effective\.value ->> 'plan'/g)).toHaveLength(2);
        expect(provisionedAuthBodies.match(/effective\.value ->> 'grantId' is null/g)).toHaveLength(2);
    });

    it("keeps every pilot-ledger account out of legacy login, validation, and reset ingress", () => {
        const ledgerReferences = migration.match(/from public\.omr_pilot_plan_grants grant_row/gi) || [];
        expect(ledgerReferences).toHaveLength(4);
        expect(migration).toMatch(/grant_row\.account_id = account\.id/);
        expect(migration).toContain("pg_advisory_xact_lock(20260808, pg_catalog.hashtext(p_email))");
        expect(migration).toMatch(/select account\.id into v_account_id[\s\S]*for update;[\s\S]*p_expires_at <= pg_catalog\.clock_timestamp\(\)/);
    });

    it("defines a side-effect-free exact provisioned canary probe", () => {
        expect(migration).toMatch(/jsonb_build_object\(\s*'ready',\s*p_account_id is not null/i);
        expect(migration).toContain("organization.plan = 'free'");
        expect(migration).toContain("grant_row.state = 'active'");
        expect(migration).toContain("grant_row.superseded_at is null");
        expect(migration).toContain("grant_row.expires_at > pg_catalog.clock_timestamp()");
        expect(migration).toContain("audit.action = 'operator.pilot_teacher_provisioned'");
        expect(migration).toContain("audit.entity_type = 'pilot_plan_grant'");
        expect(migration).toContain("audit.entity_id = grant_row.id");
        expect(migration).toContain("audit.metadata ->> 'grantId' = grant_row.id");
        expect(migration).toContain("audit.metadata ->> 'afterPlan' = grant_row.plan");
        expect(migration).toContain("audit.metadata ->> 'expiresAt'");
        expect(migration).toContain("audit.metadata ->> 'afterSessionGeneration' = account.session_generation::text");
    });

    it("uses only the effective grant reader and contains no repair mutation", () => {
        expect(migration).toContain("public.omr_read_effective_workspace_plan_v1");
        const provisionedAuthBodies = migration.split("create function public.omr_lookup_provisioned_teacher_login_v1")[1]
            ?.split("create function public.omr_probe_provisioned_teacher_canary_v1")[0] || "";
        expect(provisionedAuthBodies).not.toMatch(/organization\.plan/);
        const canaryBody = migration.split("create function public.omr_probe_provisioned_teacher_canary_v1")[1]
            ?.split("alter function public.omr_probe_provisioned_teacher_canary_v1")[0] || "";
        expect(canaryBody).not.toMatch(/\b(insert into|update public|delete from|merge into)\b/i);
        expect(migration).toContain("p_account_id !~ '^teacher_[a-f0-9]{16}$'");
        expect(migration).toContain("p_organization_id !~ '^pilot_org_[a-f0-9]{24}$'");
        expect(migration).toContain("account.session_generation = p_session_generation");
        expect(migration).toContain("member.organization_id = p_organization_id");
    });
});
