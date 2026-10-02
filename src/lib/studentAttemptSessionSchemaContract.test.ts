import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = join(
    process.cwd(),
    "supabase/migrations/202608060007_student_attempt_sessions.sql",
);

describe("student attempt session schema", () => {
    it("keeps progress service-only and protects active ownership lookups", () => {
        const sql = readFileSync(migrationPath, "utf8");
        expect(sql).toContain("create table if not exists public.omr_attempt_sessions");
        expect(sql).toContain("alter table public.omr_attempt_sessions force row level security");
        expect(sql).toContain("revoke all on public.omr_attempt_sessions from public, anon, authenticated");
        expect(sql).toContain("omr_attempt_sessions_active_owner_idx");
        expect(sql).toContain("grading_snapshot jsonb not null");
    });

    it("exposes bounded service-only open, checkpoint, heartbeat, takeover and submit RPCs", () => {
        const sql = readFileSync(migrationPath, "utf8");
        for (const rpc of [
            "omr_open_attempt_session_v1",
            "omr_checkpoint_attempt_session_v1",
            "omr_heartbeat_attempt_session_v1",
            "omr_takeover_attempt_session_v1",
            "omr_prepare_attempt_session_submit_v1",
            "omr_commit_attempt_session_submit_v1",
            "omr_prepare_attempt_handwriting_asset_v1",
            "omr_discard_attempt_handwriting_asset_v1",
            "omr_authorize_remote_asset_cleanup_delete_v1",
        ]) {
            expect(sql).toContain(`function public.${rpc}`);
            expect(sql).toContain(`grant execute on function public.${rpc}`);
        }
        expect(sql).toContain("p_expected_revision bigint");
        expect(sql).toContain("p_expected_lease_epoch bigint");
        expect(sql).toContain("deadline_at");
        expect(sql).toContain("max_attempts");
        expect(sql).toContain("retake source attempt is not owned by student");
    });

    it("reserves a generation-unique handwriting object with a race-safe organization cap", () => {
        const sql = readFileSync(migrationPath, "utf8");
        expect(sql).toContain("v_canonical_asset_id := v_asset.id");
        expect(sql).toContain("_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$");
        expect(sql).not.toContain("|| '_' || v_asset.sha256_hex");
        expect(sql).toContain("pg_catalog.pg_advisory_xact_lock");
        expect(sql).toContain("pg_catalog.hashtextextended(v_session.organization_id, 604006)");
        expect(sql).toContain("from public.omr_remote_asset_upload_intents intent");
        expect(sql).toContain("from public.omr_remote_asset_cleanup_queue queue");
        expect(sql).toContain("queue.status in ('pending', 'leased', 'dead')");
        expect(sql).toContain("queue.byte_size");
        expect(sql).toContain("group by item.object_path");
        expect(sql).toContain("intent.object_path, intent.byte_size, 'expired_upload'");
        expect(sql).toContain("asset.attempt_id = v_attempt.id");
        expect(sql).toContain("asset.kind = 'attempt_handwriting'");
        expect(sql).toContain("order by asset.created_at, asset.id");
        expect(sql).not.toContain("v_stored.id is distinct from v_asset.id");
        expect(sql).not.toContain("v_stored.object_path is distinct from v_asset.object_path");
        expect(sql).toContain("intent.expires_at > now()");
        expect(sql).toContain("organization remote asset storage limit exceeded");
        expect(sql).toContain("v_storage_cap := 2147483648");
        expect(sql).toContain("v_storage_cap := 10737418240");
        expect(sql).toContain("omr_discard_attempt_handwriting_asset_v1");
    });

    it("reclaims abandoned reservations but protects canonical attached handwriting", () => {
        const sql = readFileSync(migrationPath, "utf8");
        const claim = sql.slice(sql.indexOf("function public.omr_claim_remote_asset_cleanup_v1"));
        expect(claim).toContain("asset.created_at <= now() - interval '2 hours'");
        expect(claim).toContain("attempt.payload #>> '{drawingsRef,key}' = asset.id");
        expect(claim).toContain("attempt.payload #>> '{drawingsRef,key}' = queue.source_id");
    });

    it("fences each handwriting generation path until leased cleanup is acknowledged", () => {
        const sql = readFileSync(migrationPath, "utf8");
        const prepare = sql.slice(
            sql.indexOf("function public.omr_prepare_attempt_handwriting_asset_v1"),
            sql.indexOf("function public.omr_discard_attempt_handwriting_asset_v1"),
        );
        const attach = sql.slice(
            sql.indexOf("function public.omr_attach_attempt_handwriting_v1"),
            sql.indexOf("function public.omr_prepare_attempt_handwriting_asset_v1"),
        );
        const authorize = sql.slice(
            sql.indexOf("function public.omr_authorize_remote_asset_cleanup_delete_v1"),
            sql.indexOf("function public.omr_open_attempt_session_v1"),
        );
        expect(prepare).toContain("'cleanup_pending'");
        expect(prepare).toContain("for update");
        expect(attach).toContain("handwriting cleanup in progress");
        expect(authorize).toContain("queue.status = 'leased'");
        expect(authorize).toContain("queue.lease_owner = pg_catalog.btrim(p_worker_id)");
        expect(authorize).toContain("queue.attempts = p_expected_attempt");
        expect(authorize).toContain("attempt.payload #>> '{drawingsRef,key}' = v_queue.source_id");
        expect(authorize).toContain("delete from public.omr_remote_asset_cleanup_queue");
        expect(sql).toContain("omr_ack_remote_asset_cleanup_v1(text,text,integer)");
        expect(sql).toContain("omr_fail_remote_asset_cleanup_v1(text,text,integer,text)");
        expect(sql).toContain("create or replace function public.omr_ack_remote_asset_cleanup_v1(");
        expect(sql).toContain("create or replace function public.omr_fail_remote_asset_cleanup_v1(");
        expect(sql.match(/as 'select false';/g)).toHaveLength(2);
    });

    it("resumes an idempotent session before enforcing the assignment attempt cap", () => {
        const sql = readFileSync(migrationPath, "utf8");
        const openBody = sql.slice(
            sql.indexOf("function public.omr_open_attempt_session_v1"),
            sql.indexOf("function public.omr_checkpoint_attempt_session_v1"),
        );
        expect(openBody.indexOf("from public.omr_attempt_sessions attempt_session"))
            .toBeLessThan(openBody.indexOf("attempt session max_attempts exceeded"));
        expect(openBody.indexOf("attempt_session.submission_id = btrim(p_submission_id)"))
            .toBeLessThan(openBody.indexOf("attempt_session.status = 'in_progress'"));
    });

    it("allows a new assignment attempt after a terminal session while keeping one active scope", () => {
        const sql = readFileSync(migrationPath, "utf8");
        expect(sql).not.toContain("unique (organization_id, exam_id, owner_student_id, scope_key)");
        expect(sql).toContain("omr_attempt_sessions_one_active_scope_idx");
        expect(sql).toContain("where status = 'in_progress'");
    });

    it("rejects an already-expired session during submit preparation", () => {
        const sql = readFileSync(migrationPath, "utf8");
        const prepareBody = sql.slice(
            sql.indexOf("function public.omr_prepare_attempt_session_submit_v1"),
            sql.indexOf("function public.omr_commit_attempt_session_submit_v1"),
        );
        expect(prepareBody).toContain("if v_session.status = 'in_progress' then");
        expect(prepareBody).toContain("return query select");
        expect(prepareBody).not.toContain("update public.omr_attempt_sessions set status = 'expired', updated_at = v_now where id = v_session.id;\n            raise exception 'attempt session expired'");
    });

    it("uses a bounded digest for retake scope keys", () => {
        const sql = readFileSync(migrationPath, "utf8");
        const openBody = sql.slice(
            sql.indexOf("function public.omr_open_attempt_session_v1"),
            sql.indexOf("function public.omr_checkpoint_attempt_session_v1"),
        );
        expect(openBody).toContain("pg_catalog.md5");
        expect(openBody).not.toContain("v_scope_key := 'retake:' || v_source.id");
    });

    it("persists commit-boundary expiry through a stable sentinel", () => {
        const sql = readFileSync(migrationPath, "utf8");
        const commitBody = sql.slice(sql.indexOf("function public.omr_commit_attempt_session_submit_v1"));
        expect(commitBody).toContain("result_status text");
        expect(commitBody).toContain("return query select null::jsonb, 'expired'::text");
        expect(commitBody).not.toContain("if v_session.deadline_at + interval '30 seconds' < v_now then raise exception");
    });

    it("serializes concurrent opens for the same owner and retake scope", () => {
        const sql = readFileSync(migrationPath, "utf8");
        const openBody = sql.slice(
            sql.indexOf("function public.omr_open_attempt_session_v1"),
            sql.indexOf("function public.omr_checkpoint_attempt_session_v1"),
        );
        expect(openBody).toContain("pg_advisory_xact_lock");
        expect(openBody).toContain("hashtextextended");
    });

    it("atomically reserves assignment attempt capacity across different scopes", () => {
        const sql = readFileSync(migrationPath, "utf8");
        const openBody = sql.slice(
            sql.indexOf("function public.omr_open_attempt_session_v1"),
            sql.indexOf("function public.omr_checkpoint_attempt_session_v1"),
        );
        expect(openBody).toContain("':assignment:'");
        expect(openBody).toContain("v_active_reservations");
        expect(openBody).toContain("attempt_session.assignment_id = v_assignment_id");
        expect(openBody).toContain("attempt_session.status = 'in_progress'");
        expect(openBody).toContain("v_used_attempts + v_active_reservations >= v_max_attempts");
    });
});
