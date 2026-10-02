import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
    buildStudentAttemptProgressPayload,
    STUDENT_ATTEMPT_HANDWRITING_CHECKPOINT_MAX_BYTES,
    STUDENT_ATTEMPT_HANDWRITING_CHECKPOINT_MS,
} from "./studentAttemptHandwritingCheckpoint";

// Regression: ISSUE-P1-HANDWRITING-TAKEOVER — answers crossed devices while active handwriting did not.
// Found by the user-journey audit on 2026-08-07.
// Report: docs/initial-ops-user-journey-audit-2026-08-07.md
describe("active handwriting takeover boundary", () => {
    it("caps 100 continuously drawing students near 320 KiB/s without slowing answer checkpoints", () => {
        const maximumBodyBytesPerSecond = STUDENT_ATTEMPT_HANDWRITING_CHECKPOINT_MAX_BYTES
            * 100
            / (STUDENT_ATTEMPT_HANDWRITING_CHECKPOINT_MS / 1_000);
        expect(STUDENT_ATTEMPT_HANDWRITING_CHECKPOINT_MAX_BYTES).toBe(64 * 1024);
        expect(STUDENT_ATTEMPT_HANDWRITING_CHECKPOINT_MS).toBeGreaterThanOrEqual(20_000);
        expect(maximumBodyBytesPerSecond).toBeLessThanOrEqual(320 * 1024);
        expect(buildStudentAttemptProgressPayload(1, { 1: ["forged"] }, false)).toEqual({
            status: "ready",
            payload: { currentQuestionId: 1 },
        });
    });

    it("checkpoints drawing changes and restores them when applying a taken-over lease", () => {
        const solve = readFileSync(join(process.cwd(), "src/app/solve/[id]/page.tsx"), "utf8");
        const fingerprint = solve.slice(
            solve.indexOf("function checkpointFingerprint"),
            solve.indexOf("function SolveDialogShell"),
        );
        const apply = solve.slice(
            solve.indexOf("const applyDurableAttempt"),
            solve.indexOf("const beginSecureEntry"),
        );
        const checkpoint = solve.slice(
            solve.indexOf("const runCheckpoint"),
            solve.indexOf("const runHeartbeat"),
        );

        expect(fingerprint).toContain("drawings");
        expect(checkpoint).toContain("rawDrawingsRef.current");
        expect(checkpoint).toContain("buildStudentAttemptProgressPayload");
        expect(checkpoint).toContain("STUDENT_ATTEMPT_HANDWRITING_CHECKPOINT_MS");
        expect(checkpoint).toContain("lastHandwritingCheckpointAtRef.current");
        expect(apply).toContain("handwritingCheckpointDrawings");
        expect(apply).toContain("setDrawings(restoredDrawings)");
    });

    it("ships a service-only bounded SQL checkpoint that preserves the last safe handwriting generation", () => {
        const migrations = readdirSync(join(process.cwd(), "supabase/migrations"));
        expect(migrations).toContain("202608060031_attempt_handwriting_takeover_checkpoint.sql");
        const sql = readFileSync(join(
            process.cwd(),
            "supabase/migrations/202608060031_attempt_handwriting_takeover_checkpoint.sql",
        ), "utf8");
        expect(sql).toContain("pg_catalog.pg_column_size(v_handwriting_checkpoint) > 65536");
        expect(sql).toContain("v_session.progress_payload -> 'handwritingCheckpoint'");
        expect(sql).toContain("v_session.lease_epoch is distinct from p_expected_lease_epoch");
        expect(sql).toContain("v_session.lease_token_hash is distinct from pg_catalog.btrim(p_lease_token_hash)");
        expect(sql).toContain("jsonb_object_keys(v_handwriting_checkpoint -> 'drawings')");
        expect(sql).toContain("revoke all on function public.omr_checkpoint_attempt_session_v1");
        expect(sql).toContain("grant execute on function public.omr_checkpoint_attempt_session_v1");

        const boundary = readFileSync(join(process.cwd(), "supabase/production-server-boundary.sql"), "utf8");
        expect(boundary).toContain("handwriting-takeover-checkpoint:202608060031");
        expect(boundary).toContain("pg_column_size(v_handwriting_checkpoint) > 65536");
        expect(boundary).toContain("v_session.progress_payload -> ''handwritingcheckpoint''");

        const live = readFileSync(join(process.cwd(), "supabase/live-test-assertions.sql"), "utf8");
        expect(live).toContain("takeover did not restore the fenced handwriting generation");
        expect(live).toContain("old device retained its lease after handwriting takeover");
        expect(live).toContain("answer-only checkpoint erased the last safe handwriting generation");
    });
});
