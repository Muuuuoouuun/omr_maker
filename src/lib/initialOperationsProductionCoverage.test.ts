import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
    return readFileSync(resolve(process.cwd(), path), "utf8");
}

const requiredProductionPaths = [
    "rpc:omr_open_attempt_session_v1",
    "rpc:omr_checkpoint_attempt_session_v1",
    "rpc:omr_heartbeat_attempt_session_v1",
    "rpc:omr_prepare_attempt_session_submit_v1",
    "rpc:omr_commit_attempt_session_submit_v1",
    "rpc:omr_list_active_attempt_sessions_v1",
    "table:omr_remote_assets",
    "rpc:omr_prepare_teacher_asset_upload_v1",
    "rpc:omr_authorize_teacher_asset_finalize_v1",
    "rpc:omr_finalize_teacher_asset_upload_v1",
] as const;

describe("initial-operations production workload coverage", () => {
    it("executes production workload RPCs instead of the canned load operation RPC", () => {
        const gateway = source("src/lib/initialOperationsLoadGateway.server.ts");
        expect(gateway).not.toContain('client.rpc("omr_initial_ops_operation_v1"');
        expect(gateway).not.toContain('client.rpc("omr_initial_ops_reserve_upload_v1"');
        for (const path of requiredProductionPaths) {
            expect(gateway).toContain(path.slice(path.indexOf(":") + 1));
        }
        expect(gateway).toContain("openStudentAttemptSessionWithGateway");
        expect(gateway).toContain("checkpointStudentAttemptSessionWithGateway");
        expect(gateway).toContain("heartbeatStudentAttemptSessionWithGateway");
        expect(gateway).toContain("prepareStudentAttemptSessionSubmitWithGateway");
        expect(gateway).toContain("commitStudentAttemptSessionSubmitWithGateway");
        expect(gateway).toContain("listTeacherActiveAttemptSessionsWithGateway");
    });

    it("attests the exact production path map in the staging contract and every raw request", () => {
        const handler = source("src/lib/initialOperationsControlHandler.server.ts");
        const driver = source("scripts/initial-operations-driver.mjs");
        const core = source("scripts/initial-operations-core.mjs");

        expect(handler).toContain("INITIAL_OPERATIONS_PRODUCTION_WORKLOAD_PATHS");
        expect(handler).toContain("controlPlaneVersion: 2");
        expect(handler).toContain("productionWorkloadPaths");
        expect(driver).toContain("productionWorkloadPaths");
        expect(driver).toContain("workloadPaths: result.body?.workloadPaths");
        expect(core).toContain("INITIAL_OPERATIONS_PRODUCTION_WORKLOAD_PATHS");
        expect(core).toContain('fail("production_workload_coverage"');
    });

    it("collects positive in-window call deltas for every production database path", () => {
        const migrationPath = resolve(
            process.cwd(),
            "supabase/migrations/202608060026_initial_operations_production_coverage.sql",
        );
        expect(existsSync(migrationPath)).toBe(true);
        if (!existsSync(migrationPath)) return;
        const migration = readFileSync(migrationPath, "utf8");
        const bundle = source("scripts/initial-operations-evidence-bundle.mjs");
        const core = source("scripts/initial-operations-core.mjs");

        for (const path of requiredProductionPaths) {
            expect(migration).toContain(path);
        }
        expect(migration).not.toMatch(/query\s+ilike\s+'%omr_initial_ops_%'/i);
        expect(migration).toContain("p_phase text");
        expect(migration).toContain("extensions.pg_stat_statements_reset");
        expect(migration).toContain("extensions.pg_stat_statements_info");
        expect(migration).not.toContain("select deadlocks, stats_reset");
        expect(source("src/lib/initialOperationsLoadGateway.server.ts")).toContain("p_phase: phase");
        expect(bundle).toContain("callsBefore");
        expect(bundle).toContain("callsAfter");
        expect(bundle).toContain("callsDelta");
        expect(bundle).toContain("workloadPath");
        expect(core).toContain('fail("database_workload_coverage"');
    });

    it("keeps only fixture, cleanup, and instrumentation on dedicated load RPCs", () => {
        const gateway = source("src/lib/initialOperationsLoadGateway.server.ts");
        expect(gateway).toContain('client.rpc("omr_initial_ops_fixture_v1"');
        expect(gateway).toContain('client.rpc("omr_initial_ops_database_snapshot_v1"');
        expect(gateway).not.toContain("omr_initial_ops_operation_v1");
        expect(gateway).not.toContain("omr_initial_ops_reserve_upload_v1");
    });

    it("grades submissions at the authoritative runtime server timestamp", () => {
        const gateway = source("src/lib/initialOperationsLoadGateway.server.ts");
        expect(gateway).not.toContain('const finishedAt = "2026-08-07T01:00:00.000Z"');
        expect(gateway).toContain("const finishedAt = preparedSession.serverNow");
    });

    it("pins student open to the canonical fixture exam revision", () => {
        const gateway = source("src/lib/initialOperationsLoadGateway.server.ts");
        const handler = source("src/lib/initialOperationsControlHandler.server.ts");
        const driver = source("scripts/initial-operations-driver.mjs");
        const migration = source("supabase/migrations/202608060026_initial_operations_production_coverage.sql");
        expect(gateway).toContain("examUpdatedAt: clean(input.examUpdatedAt)");
        expect(handler).toContain('searchParams.get("examUpdatedAt")');
        expect(driver).toContain("fixtureExamUpdatedAt");
        expect(migration).toContain("select exam.updated_at into v_exam_updated_at");
        expect(migration).toContain("'examUpdatedAt', v_exam_updated_at");
        expect(migration).not.toContain("'examUpdatedAt', v_now");
    });

    it("keeps a retryable cleanup tombstone until Storage deletion succeeds", () => {
        const gateway = source("src/lib/initialOperationsLoadGateway.server.ts");
        const migration = source("supabase/migrations/202608060026_initial_operations_production_coverage.sql");
        expect(migration).toContain("'cleanup_pending'");
        expect(migration).toContain("p_action = 'finalize_cleanup'");
        expect(migration).toMatch(/set upload_object_paths = v_cleanup_paths/);
        expect(gateway).toContain('p_action: "finalize_cleanup"');
    });

    it("seeds actor-bound uploader memberships so ten 50 MiB uploads do not share one quota", () => {
        const gateway = source("src/lib/initialOperationsLoadGateway.server.ts");
        const migration = source("supabase/migrations/202608060026_initial_operations_production_coverage.sql");
        expect(gateway).toContain("createdByUserId: context.actorId");
        expect(migration).toContain("insert into public.omr_organization_members");
        expect(migration).toContain("'uploader_' || v_suffix || '_'");
        expect(migration).toContain("'members'");
        expect(migration).toContain("delete from public.omr_remote_asset_cleanup_queue");
    });

    it("uses the production finalize gateway and production TUS metadata semantics", () => {
        const gateway = source("src/lib/initialOperationsLoadGateway.server.ts");
        const driver = source("scripts/initial-operations-driver.mjs");
        const prepareBranch = gateway.slice(
            gateway.indexOf('operation === "teacher-max-pdf-upload-prepare"'),
            gateway.indexOf('operation === "teacher-max-pdf-upload-finalize"'),
        );
        expect(gateway).toContain("finalizeTeacherRemoteAssetUploadWithGateway");
        expect(prepareBranch).not.toContain("createSignedUrl");
        expect(prepareBranch).not.toContain("readbackUrl");
        expect(gateway).not.toContain('const authorized = await client.rpc("omr_authorize_teacher_asset_finalize_v1"');
        expect(gateway).not.toContain('const finalized = await client.rpc("omr_finalize_teacher_asset_upload_v1"');
        expect(driver).toContain('"Tus-Resumable": "1.0.0"');
        expect(driver).toContain("Upload-Metadata");
        expect(driver).toContain("sha256Hex");
        expect(driver).toContain("6 * 1024 * 1024");
    });
});
