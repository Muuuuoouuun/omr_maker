import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
    SUPABASE_ATTEMPT_LIST_READ_COLUMNS,
    SUPABASE_STUDENT_ATTEMPT_SUMMARY_READ_COLUMNS,
    SUPABASE_TEACHER_ATTEMPT_SUMMARY_READ_COLUMNS,
} from "@/lib/supabaseReadColumns";

const root = process.cwd();
const migrationPath = `${root}/supabase/migrations/202608100001_canonical_question_result_evidence.sql`;
const liveBehaviorPath = `${root}/supabase/canonical-question-result-evidence-assertions.sql`;

function parsedFunctionParameters(sql: string): Map<string, string[]> {
    const declarations = /create\s+(?:or\s+replace\s+)?function\s+public\.([a-z_][a-z0-9_]*)\s*\(/gi;
    const parsed = new Map<string, string[]>();
    for (let match = declarations.exec(sql); match; match = declarations.exec(sql)) {
        const open = declarations.lastIndex - 1;
        let depth = 0;
        let close = -1;
        for (let index = open; index < sql.length; index += 1) {
            if (sql[index] === "(") depth += 1;
            else if (sql[index] === ")" && --depth === 0) {
                close = index;
                break;
            }
        }
        if (close < 0) throw new Error(`unterminated function signature: ${match[1]}`);
        const source = sql.slice(open + 1, close).trim();
        const names = source ? source.split(",").map(parameter => {
            const name = /^([a-z_][a-z0-9_]*)\s+/i.exec(parameter.trim())?.[1].toLowerCase();
            if (!name) throw new Error(`invalid function parameter: ${parameter}`);
            return name;
        }) : [];
        if (new Set(names).size !== names.length) throw new Error(`duplicate function parameter: ${match[1]}`);
        parsed.set(match[1].toLowerCase(), names);
        declarations.lastIndex = close + 1;
    }
    return parsed;
}

describe("canonical question-result evidence database contract", () => {
    it("parses every exact public function signature without duplicate parameters", () => {
        const parsed = parsedFunctionParameters(readFileSync(migrationPath, "utf8"));
        expect([...parsed.keys()]).toEqual([
            "omr_assert_canonical_question_result_json_v1",
            "omr_canonical_json_text_v1",
            "omr_compute_canonical_question_result_evidence_v1",
            "omr_bind_attempt_evidence_generation_v1",
            "omr_guard_canonical_question_result_evidence_v1",
            "omr_question_result_assignment_generation_guard_v2",
            "omr_canonical_attempt_child_evidence_matches_v1",
            "omr_assert_canonical_attempt_child_evidence_v1",
            "omr_mark_canonical_attempt_evidence_dirty_v1",
            "omr_finalize_canonical_attempt_evidence_dirty_v1",
            "omr_guard_completed_question_result_grading_immutability_v1",
            "omr_force_finish_attempt_sessions_compact_v2",
            "omr_canonical_question_result_evidence_ready_v1",
            "omr_service_readiness_v1",
        ]);
        expect(readFileSync(migrationPath, "utf8")).not.toMatch(/\bdeclare\s+declare\b/i);
        expect(parsed.get("omr_force_finish_attempt_sessions_compact_v2")).toEqual([
            "p_organization_id", "p_session_ids", "p_finished_at", "p_actor_user_id",
            "p_member_role", "p_actor_label", "p_expectations",
        ]);
    });
    it("adds nullable legacy-safe dedicated evidence columns and exact child generation", () => {
        const sql = readFileSync(migrationPath, "utf8");
        expect(sql).toContain("question_results_question_count integer");
        expect(sql).toContain("question_results_definition_manifest_hash text");
        expect(sql).toContain("question_results_full_evidence_hash text");
        expect(sql).toContain("add column if not exists assignment_revision bigint");
        expect(sql).toContain("omr_question_result_assignment_generation_guard_v2");
        expect(sql).toMatch(/if tg_op = 'UPDATE' and old\.assignment_id is null[\s\S]*?return old;[\s\S]*?question-result assignment generation is immutable/);
        expect(sql).toContain("new.assignment_id is distinct from old.assignment_id");
        expect(sql).toContain("new.assignment_revision is distinct from old.assignment_revision");
        expect(sql).toContain("omr_attempts_assignment_revision_payload_guard");
        expect(sql).toContain("'assignmentRevision',new.assignment_revision");
        expect(sql).toContain("new.payload := pg_catalog.jsonb_set");
    });

    it("computes two domain-separated byte-identical digests and guards immutable completed evidence", () => {
        const sql = readFileSync(migrationPath, "utf8");
        expect(sql).toContain("omr:canonical-question-definition-manifest:v1");
        expect(sql).toContain("omr:canonical-question-result-evidence:v1");
        expect(sql).toContain("omr_canonical_json_text_v1");
        expect(sql).toContain("omr:canonical-number:micro6:v1");
        expect(sql).toContain("canonical number exceeds micro6 range");
        expect(sql).toContain("canonical number exceeds micro6 precision");
        expect(sql).toContain("omr_compute_canonical_question_result_evidence_v1");
        expect(sql).toContain("extensions.digest");
        expect(sql).toContain("questionResultsDefinitionManifestHash");
        expect(sql).toContain("questionResultsFullEvidenceHash");
        expect(sql).toContain("canonical question-result evidence is immutable");
        expect(sql).toContain("jsonb_array_length(v_rows) > 500");
        expect(sql.match(/not coalesce\(row\.value ->> 'correctAnswer'/g)).toHaveLength(2);
        expect(sql).not.toContain("or new.payload ? 'questionResultsQuestionCount'");
        expect(sql).toContain("or nullif(new.payload ->> 'questionResultsQuestionCount','') is not null");
        expect(sql).toContain("omr_force_finish_attempt_sessions_compact_v2");
        expect(sql).toContain("compact force canonical evidence postcondition failed");
        expect(sql).toContain("result.assignment_revision is distinct from session.assignment_revision");
        expect(sql).toContain("attempt.question_results_question_count is distinct from");
        expect(sql).toContain("pg_catalog.jsonb_array_length(attempt.payload -> 'questionResults')");
        expect(sql).toContain("omr_canonical_attempt_child_evidence_matches_v1");
        expect(sql).toContain("child.payload is not distinct from embedded.value");
        expect(sql).toContain("child.correct_answer is distinct from (child.payload ->> 'correctAnswer')::integer");
        expect(sql).toContain("create constraint trigger omr_canonical_evidence_dirty_attempt_finalize_v1");
        expect(sql).toContain("create trigger omr_question_results_canonical_dirty_update_v1");
        expect(sql).toContain("not public.omr_canonical_attempt_child_evidence_matches_v1(attempt.id)");
        expect(sql).toContain("canonical question-result grading fields are immutable");
    });

    it("validates each changed parent once per bulk statement instead of rescanning all 500 rows per child row", () => {
        const sql = readFileSync(migrationPath, "utf8").toLowerCase();
        expect(sql).toContain("referencing new table as canonical_new_rows old table as canonical_old_rows");
        expect(sql).toContain("for each statement");
        expect(sql).not.toContain("create constraint trigger omr_question_results_deferred_canonical_evidence_guard_v1");
        expect(sql).toContain("create constraint trigger omr_canonical_evidence_dirty_attempt_finalize_v1");
        expect(sql).toContain("primary key(transaction_id,attempt_id)");
        expect(sql).toContain("on public.omr_question_results(attempt_id,question_id,question_number)");
    });

    it("enforces the TS canonical JSON depth and array ceilings inside SQL before hashing", () => {
        const sql = readFileSync(migrationPath, "utf8").toLowerCase();
        expect(sql).toContain("omr_assert_canonical_question_result_json_v1");
        expect(sql).toMatch(/jsonb_array_length\([^)]*\)\s*>\s*500/);
        expect(sql).toContain("canonical json depth exceeds 5");
    });

    it("runs 500-row submit and compact RPCs through one authoritative parent seal", () => {
        const live = readFileSync(liveBehaviorPath, "utf8").toLowerCase();
        expect(live).toContain("omr_submit_attempt_v1");
        expect(live).toContain("omr_force_finish_attempt_sessions_compact_v2");
        expect(live).toContain("generate_series(1,500)");
        expect(live).toContain("omr_canonical_evidence_dirty_attempt_finalize_v1 immediate");
        expect(live).toContain("canonical attempt child evidence mismatch");
        expect(live).toContain("canonical json array exceeds 500");
        expect(live).toContain("canonical json depth exceeds 5");
        expect(live).toContain("passagepdfregions");
        expect(live).toContain("1.000001");
        expect(live).toContain("15 seconds");

        const runner = readFileSync(`${root}/scripts/verify-supabase-live.mjs`, "utf8");
        const behaviorIndex = runner.indexOf("supabase/canonical-question-result-evidence-assertions.sql");
        const legacyIndex = runner.indexOf("supabase/individual-student-assignments-assertions.sql");
        expect(behaviorIndex).toBeGreaterThan(0);
        expect(behaviorIndex).toBeLessThan(legacyIndex);
    });

    it("gates production, live-boundary, and rollback verification on the exact evidence capability", () => {
        const production = readFileSync(`${root}/supabase/production-server-boundary.sql`, "utf8");
        const live = readFileSync(`${root}/supabase/live-test-boundary-assertions.sql`, "utf8");
        const rollback = readFileSync(`${root}/supabase/live-test-rollback-assertions.sql`, "utf8");
        for (const sql of [production, live, rollback]) {
            expect(sql).toContain("canonicalQuestionResultEvidenceReady");
            expect(sql).toContain("omr_canonical_question_result_evidence_ready_v1");
        }
        const liveBehavior = readFileSync(`${root}/supabase/live-test-assertions.sql`, "utf8");
        expect(liveBehavior).toContain("sha256:0ecce1e233466821e9193919acc3daf7da4eeac45e89492358aec4cbc57f3ed9");
        expect(liveBehavior).toContain("sha256:ce358c4ecfd4c37c06b41160ade55fae9173a6f3db943d81d90818b05fb58653");
    });

    it("keeps low-entropy answer-key digests out of every redacted list projection", () => {
        expect(SUPABASE_STUDENT_ATTEMPT_SUMMARY_READ_COLUMNS).not.toContain("manifest_hash");
        expect(SUPABASE_STUDENT_ATTEMPT_SUMMARY_READ_COLUMNS).not.toContain("evidence_hash");
        expect(SUPABASE_TEACHER_ATTEMPT_SUMMARY_READ_COLUMNS).not.toContain("manifest_hash");
        expect(SUPABASE_TEACHER_ATTEMPT_SUMMARY_READ_COLUMNS).not.toContain("evidence_hash");
        expect(SUPABASE_ATTEMPT_LIST_READ_COLUMNS).toContain("question_results_definition_manifest_hash");
        expect(SUPABASE_ATTEMPT_LIST_READ_COLUMNS).toContain("question_results_full_evidence_hash");
    });
});
