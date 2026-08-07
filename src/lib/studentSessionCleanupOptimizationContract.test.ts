import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const migrationPath = join(root, "supabase/migrations/202608060013_session_and_cleanup_optimization.sql");
const migration = existsSync(migrationPath) ? readFileSync(migrationPath, "utf8") : "";
const boundary = readFileSync(join(root, "supabase/production-server-boundary.sql"), "utf8");
const rollback = readFileSync(join(root, "supabase/production-server-boundary-rollback.sql"), "utf8");
const live = readFileSync(join(root, "supabase/live-test-assertions.sql"), "utf8");
const readinessClient = readFileSync(join(root, "src/lib/supabaseReadinessProbe.ts"), "utf8");
const deploymentReadiness = readFileSync(join(root, "src/lib/deploymentReadiness.ts"), "utf8");

function routine(name: string, nextMarker: string): string {
    const start = migration.indexOf(`function public.${name}`);
    const end = migration.indexOf(nextMarker, start + 1);
    return start >= 0 && end > start ? migration.slice(start, end) : "";
}

describe("student session and cleanup optimization migration", () => {
    it("locks the session once before validating every checkpoint key", () => {
        expect(existsSync(migrationPath)).toBe(true);
        const checkpoint = routine(
            "omr_checkpoint_attempt_session_v1",
            "create function public.omr_gc_attempt_sessions_v1",
        );
        expect(checkpoint).toContain("select * into v_session");
        expect(checkpoint).toContain("for update");
        expect(checkpoint.indexOf("select * into v_session"))
            .toBeLessThan(checkpoint.indexOf("for v_answer_key"));
        expect(checkpoint).toContain("v_session.allowed_question_ids");
        expect(checkpoint).not.toContain("select scoped_session.allowed_question_ids");
        expect(checkpoint.match(/from public\.omr_attempt_sessions/g)).toHaveLength(1);
    });

    it("garbage-collects terminal sessions in a small locked batch after recovery retention", () => {
        const gc = routine(
            "omr_gc_attempt_sessions_v1",
            "create function public.omr_requeue_dead_remote_asset_cleanup_v1",
        );
        expect(migration).toContain("omr_attempt_sessions_terminal_gc_idx");
        expect(migration).toContain("omr_attempt_sessions_expiry_gc_idx");
        expect(gc).toContain("p_limit between 1 and 100");
        expect(gc).toContain("p_retention_days between 7 and 90");
        expect(gc).toContain("for update skip locked");
        expect(gc).toContain("limit p_limit");
        expect(gc).toContain("attempt_session.status in ('submitted', 'expired')");
        expect(gc).toContain("attempt_handwriting");
        expect(gc).toContain("drawingsRef,key");
    });

    it("provides a fenced service-only operator requeue for dead quota rows", () => {
        const requeue = routine(
            "omr_requeue_dead_remote_asset_cleanup_v1",
            "create or replace function public.omr_claim_remote_asset_cleanup_v1",
        );
        expect(migration).toContain("omr_remote_asset_cleanup_org_status_idx");
        expect(requeue).toContain("queue.status = 'dead'");
        expect(requeue).toContain("queue.attempts = p_expected_attempt");
        expect(requeue).toContain("for update");
        expect(requeue).toContain("set status = 'pending'");
        expect(requeue).toContain("attempts = 0");
        expect(requeue).toContain("operator_requeue:");
        expect(requeue).not.toContain("to_jsonb(v_queue)");
        expect(requeue).not.toContain("'objectPath'");
        expect(requeue).not.toContain("'sourceId'");
        expect(requeue).not.toContain("'organizationId'");
        expect(migration).toContain(
            "revoke all on function public.omr_requeue_dead_remote_asset_cleanup_v1(text,text,integer,text,text) from public, anon, authenticated",
        );
        expect(migration).toContain(
            "grant execute on function public.omr_requeue_dead_remote_asset_cleanup_v1(text,text,integer,text,text) to service_role",
        );
    });

    it("bounds every opportunistic expiry and orphan pass in one cleanup claim", () => {
        const claim = routine(
            "omr_claim_remote_asset_cleanup_v1",
            "revoke all on function public.omr_checkpoint_attempt_session_v1",
        );
        expect(migration).toContain("omr_remote_assets_handwriting_orphan_gc_idx");
        expect(claim).toContain("expired_session_candidates as materialized");
        expect(claim).toContain("orphan_handwriting_candidates as materialized");
        expect(claim).toContain("expired_intent_candidates as materialized");
        expect(claim.match(/limit p_limit/g)?.length).toBeGreaterThanOrEqual(5);
        expect(claim.match(/for update skip locked/g)?.length).toBeGreaterThanOrEqual(5);
        expect(claim).toContain("interval '7 days'");
        expect(claim).toContain("perform public.omr_gc_attempt_sessions_v1");
    });

    it("keeps new maintenance gateways in readiness, rollback, and live PostgreSQL assertions", () => {
        expect(boundary).toContain("public.omr_gc_attempt_sessions_v1(integer,integer)");
        expect(boundary).toContain("public.omr_requeue_dead_remote_asset_cleanup_v1(text,text,integer,text,text)");
        expect(boundary).toContain("'sessionCleanupOptimizationReady'");
        expect(boundary).toContain("'version', '202608060029'");
        expect(readinessClient).toContain('SUPABASE_READINESS_VERSION = "202608060029"');
        expect(readinessClient).toContain('"sessionCleanupOptimizationReady"');
        expect(deploymentReadiness).toContain("sessionCleanupOptimizationReady: \"세션·자산 정리 최적화\"");
        expect(rollback).toContain("'omr_gc_attempt_sessions_v1'");
        expect(rollback).toContain("'omr_requeue_dead_remote_asset_cleanup_v1'");
        expect(live).toContain("checkpoint validation performed more than one session table scan");
        expect(live).toContain("terminal session GC exceeded its batch");
        expect(live).toContain("dead cleanup requeue fence failed");
        expect(live).toContain("cleanup maintenance exceeded its bounded batch");
    });
});
