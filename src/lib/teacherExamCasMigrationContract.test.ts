import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
    "supabase/migrations/202608060010_teacher_exam_cas.sql",
    "utf8",
).toLowerCase();

describe("teacher exam optimistic-concurrency migration", () => {
    it("stores a canonical positive revision and server mutation receipts", () => {
        expect(migration).toContain("add column if not exists revision bigint not null default 1");
        expect(migration).toContain("create table if not exists public.omr_exam_mutations");
        expect(migration).toContain("request_hash text not null");
        expect(migration).toContain("committed_revision bigint not null");
        expect(migration).toContain("force row level security");
    });

    it("serializes create and edit CAS before invoking the audited asset save wrapper", () => {
        expect(migration).toContain("pg_advisory_xact_lock");
        expect(migration).toContain("p_expected_revision bigint");
        expect(migration).toContain("p_mutation_id text");
        expect(migration).toContain("p_expected_revision = 0");
        expect(migration).toContain("v_current.revision <> p_expected_revision");
        expect(migration).toContain("public.omr_save_exam_v10_snapshot");
    });

    it("replays only an identical committed request and rejects mutation-id reuse", () => {
        expect(migration).toContain("v_existing_mutation.request_hash = v_request_hash");
        expect(migration).toContain("'mutation_conflict'");
        expect(migration).toContain("return v_existing_mutation.result");
    });

    it("uses a server timestamp and blocks compensation after a canonical create", () => {
        expect(migration).toContain("v_committed_at := now()");
        expect(migration).toContain("not exists (\n        select 1 from public.omr_exams exam");
        expect(migration).toContain("exam.id = pg_catalog.substr(p_resource_key, 6)");
    });

    it("keeps the new mutation boundary service-role only and disables legacy blind saves", () => {
        expect(migration).toContain("revoke all on function public.omr_save_exam_v2");
        expect(migration).toContain("grant execute on function public.omr_save_exam_v2");
        expect(migration).toContain("raise exception 'exam save protocol upgrade required'");
        expect(migration).toContain("revoke all on function public.omr_save_exam_v10_snapshot");
        const release = migration.slice(
            migration.indexOf("create function public.omr_release_plan_usage("),
            migration.indexOf("commit;"),
        );
        expect(release).toContain("security definer");
        expect(migration).toContain("revoke all on function public.omr_release_plan_usage_v10_snapshot");
    });

    it("prunes only a bounded batch of old receipts while retaining recent replay receipts", () => {
        expect(migration).toContain("mutation.created_at < now() - interval '90 days'");
        expect(migration).toContain("for update skip locked");
        expect(migration).toContain("limit 100");
        expect(migration).toContain("delete from public.omr_exam_mutations mutation");
    });
});
