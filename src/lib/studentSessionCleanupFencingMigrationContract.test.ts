import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const migrationPath = join(root, "supabase/migrations/202608060015_session_cleanup_fencing.sql");
const migration = existsSync(migrationPath) ? readFileSync(migrationPath, "utf8") : "";
const live = readFileSync(join(root, "supabase/live-test-assertions.sql"), "utf8");
const rollbackLive = readFileSync(join(root, "supabase/live-test-rollback-assertions.sql"), "utf8");
const boundary = readFileSync(join(root, "supabase/production-server-boundary.sql"), "utf8");

function routine(name: string, nextMarker: string): string {
    const start = migration.indexOf(`function public.${name}`);
    const end = migration.indexOf(nextMarker, start + 1);
    return start >= 0 && end > start ? migration.slice(start, end) : "";
}

describe("session cleanup fencing follow-up migration", () => {
    it("takes checkpoint time only after acquiring the session row lock", () => {
        expect(existsSync(migrationPath)).toBe(true);
        const checkpoint = routine(
            "omr_checkpoint_attempt_session_v1",
            "create or replace function public.omr_requeue_dead_remote_asset_cleanup_v1",
        );
        const lock = checkpoint.indexOf("for update;");
        const clock = checkpoint.indexOf("v_now := pg_catalog.clock_timestamp();");
        expect(lock).toBeGreaterThan(0);
        expect(clock).toBeGreaterThan(lock);
        expect(checkpoint).not.toContain("v_now timestamptz := pg_catalog.clock_timestamp()");
    });

    it("keeps cleanup generations monotonic while resetting only retry quota", () => {
        const requeue = routine(
            "omr_requeue_dead_remote_asset_cleanup_v1",
            "create or replace function public.omr_authorize_remote_asset_cleanup_delete_v1",
        );
        const claim = routine(
            "omr_claim_remote_asset_cleanup_v1",
            "revoke all on function public.omr_checkpoint_attempt_session_v1",
        );
        expect(migration).toContain("add column if not exists retry_count integer");
        expect(migration).toContain("drop constraint if exists omr_remote_asset_cleanup_queue_attempts_check");
        expect(requeue).toContain("attempts = queue.attempts + 1");
        expect(requeue).toContain("retry_count = 0");
        expect(requeue).not.toContain("attempts = 0");
        expect(claim).toContain("queue.retry_count < 10");
        expect(claim).toContain("retry_count = queue.retry_count + 1");
        expect(claim).toContain("queue.retry_count >= 10");
    });

    it("uses a partial submitted-session guard index for the bounded handwriting anti-join", () => {
        expect(migration).toContain("omr_attempt_sessions_submitted_asset_guard_idx");
        expect(migration).toContain("(organization_id, submitted_attempt_id, updated_at)");
        expect(migration).toContain("where status = 'submitted'");
        const claim = routine(
            "omr_claim_remote_asset_cleanup_v1",
            "revoke all on function public.omr_checkpoint_attempt_session_v1",
        );
        expect(claim).toContain("orphan_handwriting_candidates as materialized");
        expect(claim).toContain("for update skip locked");
        expect(claim).toContain("limit p_limit");
    });

    it("returns only worker deletion fields and stores no raw operator audit PII", () => {
        const requeue = routine(
            "omr_requeue_dead_remote_asset_cleanup_v1",
            "create or replace function public.omr_authorize_remote_asset_cleanup_delete_v1",
        );
        const claim = routine(
            "omr_claim_remote_asset_cleanup_v1",
            "revoke all on function public.omr_checkpoint_attempt_session_v1",
        );
        expect(requeue).toContain("last_error = 'operator_requeue'");
        expect(requeue).not.toContain("'operator_requeue:' ||");
        expect(claim).not.toContain("to_jsonb(claimed)");
        expect(claim).toContain("'storage_bucket', claimed.storage_bucket");
        expect(claim).toContain("'object_path', claimed.object_path");
        expect(claim).not.toContain("'organization_id'");
        expect(claim).not.toContain("'source_id'");
        expect(claim).not.toContain("'last_error'");
    });

    it("proves stale requeue fencing and guarded rollback in live PostgreSQL", () => {
        expect(live).toContain("stale dead cleanup requeue crossed the generation fence");
        expect(live).toContain("cleanup claim leaked internal row metadata");
        expect(live).toContain("checkpoint lock wait used a stale clock");
        expect(rollbackLive).toContain("rollback lost cleanup generation fencing");
        expect(boundary).toContain("omr_attempt_sessions_submitted_asset_guard_idx");
        expect(boundary).toContain("'sessionCleanupFencingReady'");
    });
});
