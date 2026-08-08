import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const migrationPath = join(root, "supabase/migrations/202608060018_attempt_mutation_cas_and_exam_delete.sql");
const migration = existsSync(migrationPath) ? readFileSync(migrationPath, "utf8") : "";
const boundary = readFileSync(join(root, "supabase/production-server-boundary.sql"), "utf8");
const rollback = readFileSync(join(root, "supabase/production-server-boundary-rollback.sql"), "utf8");
const live = readFileSync(join(root, "supabase/live-test-assertions.sql"), "utf8");
const rollbackLive = readFileSync(join(root, "supabase/live-test-rollback-assertions.sql"), "utf8");

function routine(name: string, nextMarker: string): string {
    const start = migration.indexOf(`function public.${name}`);
    const end = migration.indexOf(nextMarker, start + 1);
    return start >= 0 && end > start ? migration.slice(start, end) : "";
}

describe("attempt mutation CAS and submitted-session exam delete migration", () => {
    it.each([
        ["omr_heartbeat_attempt_session_v1", "create or replace function public.omr_takeover_attempt_session_v1", false],
        ["omr_takeover_attempt_session_v1", "create or replace function public.omr_prepare_attempt_session_submit_v1", true],
        ["omr_prepare_attempt_session_submit_v1", "create or replace function public.omr_commit_attempt_session_submit_v1", true],
        ["omr_commit_attempt_session_submit_v1", "create or replace function public.omr_delete_exam_v1", true],
    ])("validates %s CAS and token before locking", (name, nextMarker, hasRevision) => {
        expect(existsSync(migrationPath)).toBe(true);
        const body = routine(name, nextMarker);
        const validation = hasRevision
            ? body.indexOf("p_expected_revision is null")
            : body.indexOf("p_expected_lease_epoch is null");
        const epochValidation = body.indexOf("p_expected_lease_epoch is null");
        const tokenValidation = body.indexOf("nullif(pg_catalog.btrim(");
        const lock = body.indexOf("for update;");

        expect(validation).toBeGreaterThan(0);
        expect(epochValidation).toBeGreaterThan(0);
        expect(tokenValidation).toBeGreaterThan(0);
        expect(body).toContain("9007199254740991");
        expect(lock).toBeGreaterThan(Math.max(validation, epochValidation, tokenValidation));
        if (hasRevision) expect(body).toContain("v_session.revision is distinct from p_expected_revision");
        expect(body).toContain("v_session.lease_epoch is distinct from p_expected_lease_epoch");
    });

    it("deletes durable sessions before attempts while retaining the asset cleanup outbox", () => {
        const body = routine("omr_delete_exam_v1", "comment on function public.omr_heartbeat_attempt_session_v1");
        const enqueue = body.indexOf("perform public.omr_enqueue_exam_asset_cleanup_v1");
        const sessions = body.indexOf("delete from public.omr_attempt_sessions");
        const attempts = body.indexOf("delete from public.omr_attempts");

        expect(enqueue).toBeGreaterThan(0);
        expect(sessions).toBeGreaterThan(enqueue);
        expect(attempts).toBeGreaterThan(sessions);
        expect(body).toContain("attempt_session.organization_id = p_organization_id");
        expect(body).toContain("attempt_session.exam_id = p_exam_id");
    });

    it("pins readiness, live verification, and rollback verification to both fixes", () => {
        expect(boundary).toContain("'version', '202608080006'");
        expect(boundary).toContain("'attemptMutationCasReady'");
        expect(boundary).toContain("'examDeleteSessionSafe'");
        expect(live).toContain("attempt heartbeat accepted an invalid CAS or blank token");
        expect(live).toContain("exam delete left submitted durable-session state behind");
        expect(rollback).toContain("omr_delete_exam_v1");
        expect(rollbackLive).toContain("rollback lost attempt mutation CAS or submitted-session exam delete hardening");
    });
});
