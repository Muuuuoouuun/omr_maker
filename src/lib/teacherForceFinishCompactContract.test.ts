import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = resolve(
    process.cwd(),
    "supabase/migrations/202608060024_teacher_force_finish_compact_grading.sql",
);
const assertionPath = resolve(
    process.cwd(),
    "supabase/teacher-force-finish-compact-assertions.sql",
);

describe("teacher force-finish compact database grading", () => {
    it("adds an O(session) commit envelope without replacing the legacy v1 RPC", () => {
        expect(existsSync(migrationPath)).toBe(true);
        if (!existsSync(migrationPath)) return;
        const sql = readFileSync(migrationPath, "utf8").toLowerCase();

        expect(sql).toContain("omr_force_finish_attempt_sessions_compact_v1(");
        expect(sql).toContain("omr_prepare_teacher_force_finish_sessions_compact_v1(");
        expect(sql).toContain("p_expectations jsonb");
        expect(sql).toContain("expected_revision");
        expect(sql).toContain("expected_fingerprint");
        expect(sql).not.toContain("p_gradings jsonb");
        expect(sql).not.toContain("expected_grading_snapshot");
        expect(sql).not.toContain("expected_answers");
        expect(sql).toMatch(
            /revoke all on function public\.omr_prepare_teacher_force_finish_sessions_compact_v1\(text,text\[\],text,text\)\s+from public, anon, authenticated/,
        );
        expect(sql).toMatch(
            /revoke all on function public\.omr_force_finish_attempt_sessions_compact_v1\(text,text\[\],timestamptz,text,text,text,jsonb\)\s+from public, anon, authenticated/,
        );
        expect(sql).toMatch(
            /grant execute on function public\.omr_force_finish_attempt_sessions_compact_v1\(text,text\[\],timestamptz,text,text,text,jsonb\)\s+to service_role/,
        );
    });

    it("locks deterministically, checks the locked revision fingerprint, and reuses canonical submission", () => {
        expect(existsSync(migrationPath)).toBe(true);
        if (!existsSync(migrationPath)) return;
        const sql = readFileSync(migrationPath, "utf8").toLowerCase();

        expect(sql).toContain("order by attempt_session.id");
        expect(sql).toContain("for update");
        expect(sql).toContain("omr_teacher_force_finish_fingerprint_v1(");
        expect(sql).toContain("omr_submit_session_attempt_v1(");
        expect(sql).toContain("with expectations as materialized");
        expect(sql).toContain("with ordinality requested(session_id, position)");
        expect(sql).toContain("pg_catalog.cardinality(p_session_ids) not between 1 and 100");
        expect(sql).not.toContain("array_position(p_session_ids");
    });

    it("derives attempt totals and question rows from one materialized grading relation", () => {
        expect(existsSync(migrationPath)).toBe(true);
        if (!existsSync(migrationPath)) return;
        const sql = readFileSync(migrationPath, "utf8").toLowerCase();

        expect(sql).toContain("with canonical_questions as materialized");
        expect(sql).toContain("grading_rows as materialized");
        expect(sql).toContain("grading_snapshot");
        expect(sql).toContain("sub_question_answers");
        expect(sql).toContain("'ungraded'");
        expect(sql).toContain("'unanswered'");
        expect(sql).toContain("'correct'");
        expect(sql).toContain("'wrong'");
        expect(sql).toContain("'questionresults'");
        expect(sql).toContain("'autosubmitted', true");
    });

    it("ships a PostgreSQL fixture for canonical grading and response-loss replay", () => {
        expect(existsSync(assertionPath)).toBe(true);
        if (!existsSync(assertionPath)) return;
        const sql = readFileSync(assertionPath, "utf8").toLowerCase();
        expect(sql).toContain("omr_force_finish_attempt_sessions_compact_v1(");
        expect(sql).toContain("compact force finish returned non-canonical payload");
        expect(sql).toContain("compact force finish normalized result rows drifted");
        expect(sql).toContain("failed compact cas left partial state");
        expect(sql).toContain("response-loss retry changed completion");
        expect(sql).toContain("rollback;");
    });
});
