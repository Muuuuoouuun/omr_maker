import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve(
    process.cwd(),
    "supabase/migrations/202608060022_teacher_account_lifecycle.sql",
), "utf8");
const boundary = readFileSync(resolve(process.cwd(), "supabase/production-server-boundary.sql"), "utf8");
const readiness = readFileSync(resolve(process.cwd(), "src/lib/supabaseReadinessProbe.ts"), "utf8");

describe("teacher account lifecycle migration contract", () => {
    it("stores only bounded hashes and normalized unique email", () => {
        expect(migration).toMatch(/create table if not exists public\.omr_teacher_accounts/i);
        expect(migration).toMatch(/email\s+text\s+not null\s+unique/i);
        expect(migration).toContain("password_hash text not null");
        expect(migration).toMatch(/status\s+text\s+not null[^;]+pending[^;]+active[^;]+disabled/i);
        expect(migration).toMatch(/email = lower\(btrim\(email\)\)/i);
        expect(migration).toMatch(/create table if not exists public\.omr_teacher_account_tokens/i);
        expect(migration).toContain("token_hash text not null unique");
        expect(migration).toContain("expires_at timestamptz not null");
        expect(migration).toContain("consumed_at timestamptz");
        expect(migration).not.toMatch(/password\s+text/i);
        expect(migration).not.toMatch(/token\s+text/i);
    });

    it("keeps browser roles out and exposes only atomic service-role RPCs", () => {
        expect(migration).toMatch(/enable row level security/i);
        expect(migration).toMatch(/force row level security/i);
        expect(migration).toMatch(/revoke all on table public\.omr_teacher_accounts from public, anon, authenticated, service_role/i);
        expect(migration).toMatch(/revoke all on table public\.omr_teacher_account_tokens from public, anon, authenticated, service_role/i);
        for (const rpc of [
            "omr_begin_teacher_signup_v1",
            "omr_begin_teacher_password_reset_v1",
            "omr_complete_teacher_password_reset_v1",
            "omr_verify_teacher_email_v1",
        ]) {
            expect(migration).toContain(`function public.${rpc}`);
            expect(migration).toMatch(new RegExp(`revoke all on function public\\.${rpc}[^;]+from public, anon, authenticated`, "i"));
            expect(migration).toMatch(new RegExp(`grant execute on function public\\.${rpc}[^;]+to service_role`, "i"));
        }
        expect(migration).toMatch(/for update skip locked/i);
    });

    it("rotates verification tokens for pending re-signup without issuing one for active accounts", () => {
        const signup = migration.match(
            /create or replace function public\.omr_begin_teacher_signup_v1[\s\S]+?\n\$\$;/i,
        )?.[0] || "";

        expect(signup).toMatch(/on conflict \(email\) do update/i);
        expect(signup).toMatch(/where omr_teacher_accounts\.status = 'pending'/i);
        expect(signup).toMatch(/set consumed_at = now\(\)[\s\S]+purpose = 'email_verify'[\s\S]+consumed_at is null/i);
        expect(signup.indexOf("set consumed_at = now()"))
            .toBeLessThan(signup.indexOf("insert into public.omr_teacher_account_tokens"));
    });

    it("fails readiness closed until the v22 account lifecycle boundary is installed", () => {
        expect(boundary).toContain("omr_teacher_accounts");
        expect(boundary).toContain("omr_teacher_account_tokens");
        expect(boundary).toContain("teacherAccountLifecycleReady");
        expect(boundary).toContain("'version', '202608060029'");
        expect(readiness).toContain('SUPABASE_READINESS_VERSION = "202608060029"');
        expect(readiness).toContain('"teacherAccountLifecycleReady"');
    });
});
