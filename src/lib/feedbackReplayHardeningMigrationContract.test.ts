import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const migrationsDir = path.join(root, "supabase/migrations");
const migrationName = "202608060014_feedback_replay_hardening.sql";
const migrationPath = path.join(migrationsDir, migrationName);
const migration = existsSync(migrationPath) ? readFileSync(migrationPath, "utf8") : "";

function routine(name: string, nextMarker: string): string {
    const start = migration.indexOf(`create or replace function public.${name}`);
    const end = migration.indexOf(nextMarker, start + 1);
    return start >= 0 && end > start ? migration.slice(start, end) : "";
}

describe("feedback replay hardening follow-up migration", () => {
    it("is ordered after the session cleanup migration", () => {
        const ordered = readdirSync(migrationsDir).filter(name => name.endsWith(".sql")).sort();
        expect(existsSync(migrationPath)).toBe(true);
        expect(ordered.indexOf(migrationName)).toBeGreaterThan(
            ordered.indexOf("202608060013_session_and_cleanup_optimization.sql"),
        );
    });

    it("replaces both v2 gateways so receipt replay precedes the authoritative plan gate", () => {
        const save = routine("omr_save_feedback_v2", "create or replace function public.omr_return_feedback_v2");
        const returned = routine("omr_return_feedback_v2", "revoke all on function public.omr_save_feedback_v2");

        for (const body of [save, returned]) {
            const lock = body.indexOf("pg_advisory_xact_lock");
            const receipt = body.indexOf("from public.omr_feedback_mutations");
            const plan = body.indexOf("from public.omr_organizations");
            expect(lock).toBeGreaterThan(0);
            expect(receipt).toBeGreaterThan(lock);
            expect(plan).toBeGreaterThan(receipt);
            expect(body).toContain("raise exception 'plan entitlement required'");
            expect(body).toContain("for update skip locked");
            expect(body).toContain("octet_length(v_response::text) > 262144");
            expect(body).toContain("raise exception 'feedback receipt exceeds limit'");
        }
        expect(save).toContain("(p_feedback - 'markup_drawings')::text) > 262144");
        expect(returned).toContain("(to_jsonb(v_stored) - 'markup_drawings')::text) > 262144");
    });

    it("reinstalls retention indexes and keeps markup pointers without duplicating drawings in receipts", () => {
        expect(migration).toContain("omr_feedback_mutations_created_idx");
        expect(migration).toContain("omr_feedback_mutations_org_kind_created_idx");
        expect(migration).toContain("to_jsonb(v_stored) - 'markup_drawings'");
        expect(migration).not.toContain("to_jsonb(v_stored) - 'markup'");
        expect(migration).toContain("grant execute on function public.omr_save_feedback_v2");
        expect(migration).toContain("grant execute on function public.omr_return_feedback_v2");
        expect(migration).toContain("feedback-replay-hardening:202608060014");
    });

    it("advances readiness only when the deployed v2 functions carry the 014 marker", () => {
        const boundary = readFileSync(path.join(root, "supabase/production-server-boundary.sql"), "utf8");
        const probe = readFileSync(path.join(root, "src/lib/supabaseReadinessProbe.ts"), "utf8");

        expect(boundary).toContain("v_feedback_replay_hardening_ready");
        expect(boundary).toContain("feedback-replay-hardening:202608060014");
        expect(boundary).toContain("'feedbackReplayHardeningReady'");
        expect(boundary).toContain("'version', '202608080008'");
        expect(probe).toContain('SUPABASE_READINESS_VERSION = "202608080008"');
        expect(probe).toContain('"feedbackReplayHardeningReady"');
    });
});
