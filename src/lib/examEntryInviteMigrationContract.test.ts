import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(process.cwd(), "supabase/migrations/202608060029_exam_entry_invites.sql"), "utf8");
const live = readFileSync(join(process.cwd(), "supabase/live-test-assertions.sql"), "utf8");
const rollback = readFileSync(join(process.cwd(), "supabase/production-server-boundary-rollback.sql"), "utf8");
const rollbackLive = readFileSync(join(process.cwd(), "supabase/live-test-rollback-assertions.sql"), "utf8");

describe("opaque exam entry invite migration", () => {
    it("stores only a bounded sha256 token hash behind FORCE RLS", () => {
        expect(source).toContain("create table if not exists public.omr_exam_entry_invites");
        expect(source).toMatch(/token_hash text primary key[\s\S]*check \(token_hash ~ '\^\[a-f0-9\]\{64\}\$'\)/i);
        expect(source).not.toMatch(/\btoken\s+text/i);
        expect(source).toContain("alter table public.omr_exam_entry_invites force row level security");
        expect(source).toMatch(/revoke all on public\.omr_exam_entry_invites from public, anon, authenticated, service_role/i);
    });

    it("rotates to one active bounded-lifetime token only for an owning active teacher", () => {
        expect(source).toContain("create or replace function public.omr_rotate_exam_entry_invite_v1");
        expect(source).toContain("member.status = 'active'");
        expect(source).toContain("member.role in ('owner', 'admin', 'teacher')");
        expect(source).toContain("exam.organization_id = pg_catalog.btrim(p_organization_id)");
        expect(source).toContain("p_expires_at > v_now + interval '15 minutes'");
        expect(source).toContain("p_expires_at <= v_now + interval '90 days'");
        expect(source.match(/nullif\(pg_catalog\.btrim\(p_token_hash\), ''\) is null/g)).toHaveLength(2);
        expect(source).toMatch(/update public\.omr_exam_entry_invites[\s\S]*set revoked_at = v_now[\s\S]*revoked_at is null/i);
        expect(source).toContain("omr_exam_entry_invites_one_active_idx");
        expect(source).toContain("omr_exam_entry_invites_org_exam_fk_idx");
        expect(source).toContain("omr_exam_entry_invites_exam_fk_idx");
    });

    it("resolves atomically by hash and exam while rechecking expiry, revocation, org, access, and groups", () => {
        expect(source).toContain("create or replace function public.omr_resolve_exam_entry_invite_v1");
        for (const fragment of [
            "invite.token_hash = pg_catalog.lower(pg_catalog.btrim(p_token_hash))",
            "invite.exam_id = pg_catalog.btrim(p_exam_id)",
            "invite.revoked_at is null",
            "invite.expires_at > v_now",
            "exam.organization_id = v_invite.organization_id",
            "exam.archived is false",
            "v_exam.payload #>> '{accessConfig,type}' is distinct from 'group'",
            "class_item.organization_id = v_invite.organization_id",
            "class_item.status = 'active'",
        ]) expect(source).toContain(fragment);
        expect(source.match(/for share;/g)).toHaveLength(3);
        const resolve = source.slice(source.indexOf("create or replace function public.omr_resolve_exam_entry_invite_v1"));
        const examLock = resolve.indexOf("select exam.* into v_exam");
        const authoritativeInviteLock = resolve.indexOf("select invite.* into v_invite", resolve.indexOf("select invite.* into v_invite") + 1);
        expect(examLock).toBeGreaterThan(0);
        expect(authoritativeInviteLock).toBeGreaterThan(examLock);
        expect(resolve.slice(authoritativeInviteLock, resolve.indexOf("if not found", authoritativeInviteLock))).toContain("for share");
    });

    it("exposes only purpose-scoped service-role RPCs", () => {
        expect(source).toMatch(/revoke all on function public\.omr_rotate_exam_entry_invite_v1\([\s\S]*from public, anon, authenticated/i);
        expect(source).toMatch(/revoke all on function public\.omr_resolve_exam_entry_invite_v1\([\s\S]*from public, anon, authenticated/i);
        expect(source).toMatch(/grant execute on function public\.omr_rotate_exam_entry_invite_v1\([\s\S]*to service_role/i);
        expect(source).toMatch(/grant execute on function public\.omr_resolve_exam_entry_invite_v1\([\s\S]*to service_role/i);
        expect(live).toMatch(/relation\.relname not in \([\s\S]*'omr_exam_entry_invites'[\s\S]*service_role lost an OMR table privilege/i);
        expect(live).toMatch(/has_table_privilege\('service_role', 'public\.omr_exam_entry_invites', 'select,insert,update,delete'\)/i);
        expect(live).toMatch(/set created_at = now\(\) - interval '2 seconds',[\s\S]*expires_at = now\(\) - interval '1 second'/i);
        expect(rollback).toContain("'omr_rotate_exam_entry_invite_v1'");
        expect(rollback).toContain("'omr_resolve_exam_entry_invite_v1'");
        expect(rollbackLive).toMatch(/not pg_catalog\.has_function_privilege\([\s\S]*service_role[\s\S]*omr_rotate_exam_entry_invite_v1/i);
        expect(rollbackLive).toMatch(/routine\.proname in \([\s\S]*omr_resolve_exam_entry_invite_v1[\s\S]*has_function_privilege\('anon'/i);
    });
});
