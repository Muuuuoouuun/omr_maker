import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = () => readFileSync(resolve(process.cwd(), "supabase/migrations/202608060009_durable_rate_limits.sql"), "utf8");

describe("durable rate-limit migration", () => {
    it("keeps only hashed buckets behind FORCE RLS and a service-role RPC", () => {
        const source = migration();

        expect(source).toContain("create table if not exists public.omr_rate_limit_buckets");
        expect(source).toContain("bucket_hash text primary key");
        expect(source).toMatch(/create index(?: if not exists)? omr_rate_limit_buckets_expires_idx\s+on public\.omr_rate_limit_buckets \(expires_at, bucket_hash\)/i);
        expect(source).toMatch(/enable row level security/i);
        expect(source).toMatch(/force row level security/i);
        expect(source).toContain("create or replace function public.omr_consume_rate_limit_v1");
        expect(source).toMatch(/security definer/i);
        expect(source).toMatch(/set search_path = ''/i);
        expect(source).toContain("pg_advisory_xact_lock");
        expect(source).toContain("'check', 'consume', 'failure', 'success', 'refund'");
        expect(source).toMatch(/if p_operation = 'refund' then[\s\S]*v_count := v_count - 1/i);
        expect(source).toContain("grant execute on function public.omr_consume_rate_limit_v1");
        expect(source).toContain("to service_role");
        expect(source).toContain("delete from public.omr_rate_limit_buckets");
        expect(source).toContain("revoke all on table public.omr_rate_limit_buckets from public, anon, authenticated, service_role");
        expect(source).toContain("revoke all on function public.omr_consume_rate_limit_v1(text, text, integer, integer, integer) from public, anon, authenticated, service_role");
        expect(source).not.toMatch(/grant (select|insert|update|delete) on table public\.omr_rate_limit_buckets/i);
        expect(source).not.toMatch(/identifier|client_fingerprint|exam_id|actor_id/i);
    });
});
