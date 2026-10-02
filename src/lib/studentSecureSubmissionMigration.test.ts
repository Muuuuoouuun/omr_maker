import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = join(
    process.cwd(),
    "supabase/migrations/202608060028_secure_submission_outbox_replay.sql",
);
const rollbackAssertionsPath = join(process.cwd(), "supabase/live-test-rollback-assertions.sql");

describe("secure submission final-checkpoint replay migration", () => {
    it("returns submitted sessions so replay can obtain the canonical receipt", () => {
        const sql = readFileSync(migrationPath, "utf8");
        expect(sql).toContain("if v_session.status <> 'in_progress' then");
        expect(sql).toContain("return query select");
        expect(sql).toContain("v_session.submitted_attempt_id");
    });

    it("accepts only an exact idempotent final-checkpoint replay", () => {
        const sql = readFileSync(migrationPath, "utf8");
        expect(sql).toContain("coalesce(p_final_checkpoint, false)");
        expect(sql).toContain("v_session.revision = p_expected_revision + 1");
        expect(sql).toContain("v_session.answers is not distinct from p_answers");
        expect(sql).toContain("v_session.sub_question_answers is not distinct from p_sub_question_answers");
        expect(sql).toContain("v_session.progress_payload is not distinct from p_progress_payload");
    });

    it("recovers an expired same-token final replay but preserves fencing", () => {
        const sql = readFileSync(migrationPath, "utf8");
        expect(sql).toContain("v_session.lease_epoch is distinct from p_expected_lease_epoch");
        expect(sql).toContain("v_session.lease_token_hash is distinct from pg_catalog.btrim(p_lease_token_hash)");
        expect(sql).toContain("v_session.lease_expires_at <= v_now and not coalesce(p_final_checkpoint, false)");
        expect(sql).not.toContain("lease_token_hash = p_lease_token_hash");
    });

    it("preserves the prior null-CAS readiness guarantee in the replacement function", () => {
        const sql = readFileSync(migrationPath, "utf8");
        const rollbackAssertions = readFileSync(rollbackAssertionsPath, "utf8");
        const compositeMarker = "attempt-checkpoint-null-cas:202608060016;secure-submission-outbox-replay:202608060028";
        expect(sql).toContain(
            compositeMarker,
        );
        expect(rollbackAssertions).toContain(compositeMarker);
        expect(sql).toContain("p_expected_revision is null");
        expect(sql).toContain("p_expected_lease_epoch is null");
    });
});
