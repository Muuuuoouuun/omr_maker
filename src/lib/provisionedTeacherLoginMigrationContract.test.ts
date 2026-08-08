import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("provisioned teacher login migration", () => {
    const migration = source("supabase/migrations/202608080007_provisioned_teacher_login.sql");

    it("defines exact read-only service-role login and request validators", () => {
        for (const signature of [
            "omr_lookup_provisioned_teacher_login_v1(text)",
            "omr_validate_provisioned_teacher_session_v1(text,bigint,text)",
        ]) {
            expect(migration).toContain(signature);
        }
        expect(migration).toContain("set search_path = ''");
        expect(migration).toContain("set statement_timeout = '5s'");
        expect(migration).toContain("set lock_timeout = '2s'");
        expect(migration.match(/owner to postgres/gi)).toHaveLength(3);
        expect(migration.match(/to service_role/gi)).toHaveLength(3);
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
        expect(migration).toContain("active_membership_count = 1");
        expect(migration).toContain("active_profile_count = 1");
        expect(migration).toContain("organization.id = member.organization_id");
    });

    it("uses only the effective grant reader and contains no repair mutation", () => {
        expect(migration).toContain("public.omr_read_effective_workspace_plan_v1");
        expect(migration).not.toMatch(/organization\.plan/);
        const bodies = migration.split("as $$").slice(1).join("as $$");
        expect(bodies).not.toMatch(/\b(insert into|update public|delete from|merge into)\b/i);
        expect(migration).toContain("p_account_id !~ '^teacher_[a-f0-9]{16}$'");
        expect(migration).toContain("p_organization_id !~ '^pilot_org_[a-f0-9]{24}$'");
        expect(migration).toContain("account.session_generation = p_session_generation");
        expect(migration).toContain("member.organization_id = p_organization_id");
    });
});
