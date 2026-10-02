import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const path = join(process.cwd(), "supabase/migrations/202608060021_initial_operations_load_control.sql");

describe("initial-operations load database control contract", () => {
    it("keeps fixture, operation, and instrumentation RPCs service-role-only and run-scoped", async () => {
        const sql = (await readFile(path, "utf8")).toLowerCase();
        for (const routine of [
            "omr_initial_ops_fixture_v1",
            "omr_initial_ops_operation_v1",
            "omr_initial_ops_database_snapshot_v1",
            "omr_initial_ops_reserve_upload_v1",
        ]) {
            expect(sql).toContain(`create or replace function public.${routine}`);
            expect(sql).toContain(`revoke all on function public.${routine}`);
            expect(sql).toContain(`grant execute on function public.${routine}`);
        }
        expect(sql).toContain("to service_role");
        expect(sql).toContain("extensions.digest(p_run_id, 'sha256')");
        expect(sql).toContain("p_run_challenge_hash");
        expect(sql).toContain("challenge_hash = p_run_challenge_hash");
        expect(sql).toContain("initial_ops_exam_");
        expect(sql).toContain("teacher_");
        expect(sql).toContain("on conflict (id) do nothing");
        expect(sql).toContain("pg_stat_statements");
        expect(sql).toContain("pg_stat_database");
        expect(sql).toContain("locktimeouts");
        expect(sql).toContain("state text not null default 'active'");
        expect(sql).toContain("upload_object_paths text[] not null default '{}'::text[]");
        expect(sql).toContain("for update");
        expect(sql).toContain("state = 'cleaning'");
        expect(sql).toContain("cardinality(v_run.upload_object_paths) >= 10");
        expect(sql).toContain("v_run.upload_reserved_bytes + p_byte_size > 524288000");
        expect(sql).toContain("p_actor_id !~ ('^uploader_'");
        expect(sql.match(/set statement_timeout = '30s'/g)).toHaveLength(4);
        expect(sql.match(/set lock_timeout = '5s'/g)).toHaveLength(4);
    });

    it("creates 45 real question rows, exactly one attempt per idempotency key, and cleanup counts", async () => {
        const sql = (await readFile(path, "utf8")).toLowerCase();
        expect(sql).toContain("generate_series(1, 45)");
        expect(sql).toContain("insert into public.omr_attempt_sessions");
        expect(sql).toContain("insert into public.omr_attempts");
        expect(sql).toContain("insert into public.omr_question_results");
        expect(sql).toContain("on conflict (id) do nothing");
        expect(sql).toContain("jsonb_object_agg");
        expect(sql).toContain("initialoperationsreceipthash");
        expect(sql).toContain("'sessions'");
        expect(sql).toContain("'attempts'");
        expect(sql).toContain("'assets'");
        expect(sql).toContain("'objects'");
    });
});
