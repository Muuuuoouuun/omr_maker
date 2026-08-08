import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = resolve(
    process.cwd(),
    "supabase/migrations/202608060023_teacher_force_finish_batch_optimization.sql",
);

describe("teacher force-finish batch optimization", () => {
    it("keeps the v1 RPC contract while replacing repeated large CAS values with a fingerprint", () => {
        expect(existsSync(migrationPath)).toBe(true);
        if (!existsSync(migrationPath)) return;
        const sql = readFileSync(migrationPath, "utf8").toLowerCase();

        expect(sql).toContain("omr_force_finish_attempt_sessions_v1(");
        expect(sql).toContain("p_gradings jsonb");
        expect(sql).toContain("expected_fingerprint");
        expect(sql).toContain("expected_grading_snapshot");
        expect(sql).toContain("pg_catalog.sha256");
        expect(sql).toContain("for update");
        expect(sql).toContain("expected_revision");
        expect(sql).toContain("omr_teacher_attempt_write_allowed_v1");
        expect(sql).toContain("omr_submit_session_attempt_v1");
        expect(sql).toContain("teacher-live-session-force-finish:202608060023");
        expect(sql).toMatch(
            /revoke all on function public\.omr_force_finish_attempt_sessions_v1\(text,text\[\],timestamptz,text,text,text,jsonb\)\s+from public, anon, authenticated/,
        );
        expect(sql).toMatch(
            /grant execute on function public\.omr_force_finish_attempt_sessions_v1\(text,text\[\],timestamptz,text,text,text,jsonb\)\s+to service_role/,
        );
    });

    it("makes readiness require the compact v23 helper while keeping it private", () => {
        const boundary = readFileSync(
            resolve(process.cwd(), "supabase/production-server-boundary.sql"),
            "utf8",
        ).toLowerCase();
        expect(boundary).toContain("'version', '202608080010'");
        expect(boundary).toContain("teacher-live-session-force-finish-prepare:202608060023");
        expect(boundary).toContain("teacher-live-session-force-finish:202608060023");
        expect(boundary).toContain(
            "revoke all on function public.omr_teacher_force_finish_fingerprint_v1(bigint,jsonb,jsonb,integer[],jsonb)",
        );
        expect(boundary).toContain("with gradings as materialized");
        expect(boundary).toContain("with ordinality");
    });

    it("indexes the grading envelope once and preserves request order without quadratic lookups", () => {
        expect(existsSync(migrationPath)).toBe(true);
        if (!existsSync(migrationPath)) return;
        const sql = readFileSync(migrationPath, "utf8").toLowerCase();
        const forceFinish = sql.slice(sql.indexOf(
            "create or replace function public.omr_force_finish_attempt_sessions_v1",
        ));

        expect(forceFinish).toContain("with gradings as materialized");
        expect(forceFinish).toContain("with ordinality requested(session_id, position)");
        expect(forceFinish).not.toContain("select item into v_grading");
        expect(forceFinish).not.toContain("array_position(p_session_ids");
        expect(forceFinish).not.toMatch(
            /for v_session[\s\S]+select coalesce\(assignment\.class_id, exam\.class_id\) into v_class_id/,
        );
    });
});
