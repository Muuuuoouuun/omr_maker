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
    it("bounds the cutover and takes every DDL lock in the runtime writer order before probing", () => {
        const sql = readFileSync(migrationPath, "utf8");
        expect(sql).toMatch(/^\s*begin;\s*set local lock_timeout = '2s';\s*set local statement_timeout = '120s';/i);

        const lockOrder = [
            "lock table public.omr_attempt_sessions in access exclusive mode;",
            "lock table public.omr_attempts in access exclusive mode;",
            "lock table public.omr_question_results in access exclusive mode;",
        ].map(statement => sql.toLowerCase().indexOf(statement));
        expect(lockOrder.every(index => index >= 0)).toBe(true);
        expect(lockOrder).toEqual([...lockOrder].sort((left, right) => left - right));

        const firstProbeOrDdl = Math.min(
            ...["do $$", "alter table", "create "]
                .map(statement => sql.toLowerCase().indexOf(statement))
                .filter(index => index >= 0),
        );
        expect(sql.toLowerCase().indexOf("set local lock_timeout = '2s';")).toBeLessThan(firstProbeOrDdl);
        expect(sql.toLowerCase().indexOf("set local statement_timeout = '120s';")).toBeLessThan(firstProbeOrDdl);
        expect(lockOrder[2]).toBeLessThan(firstProbeOrDdl);
        expect(sql).not.toMatch(/create\s+(?:unique\s+)?index\s+concurrently/i);
    });

    it("makes every trigger replacement idempotent for the bounded reapply", () => {
        const sql = readFileSync(migrationPath, "utf8").toLowerCase();
        const triggerCreations = /create\s+(?:constraint\s+)?trigger\s+([a-z_][a-z0-9_]*)[\s\S]*?\son\s+((?:public|omr_internal)\.[a-z_][a-z0-9_]*)/g;
        let creation = triggerCreations.exec(sql);
        let count = 0;
        while (creation) {
            const prefix = sql.slice(0, creation.index);
            expect(prefix).toContain(`drop trigger if exists ${creation[1]} on ${creation[2]};`);
            count += 1;
            creation = triggerCreations.exec(sql);
        }
        expect(count).toBe(10);
    });

    it("runs a bounded pre-apply writer blocker, proves exact rollback, then applies and reapplies", () => {
        const runner = readFileSync(`${root}/scripts/verify-supabase-live.mjs`, "utf8");
        expect(runner).toMatch(/import\s*{[\s\S]*?\bspawn\b[\s\S]*?\bspawnSync\b[\s\S]*?}\s*from\s*"node:child_process"/);
        expect(runner).toContain("verifyCanonicalQuestionResultEvidenceContention");
        expect(runner).toContain("canonicalQuestionResultEvidenceMigrationStateSql");
        expect(runner).not.toContain("pg_catalog.coalesce(");
        expect(runner).toContain("pg_catalog.obj_description(procedure.oid, 'pg_proc') as comment");
        expect(runner).toContain("lock table public.omr_attempt_sessions in row exclusive mode;");
        expect(runner).toContain("lock table public.omr_attempts in row exclusive mode;");
        expect(runner.indexOf("lock table public.omr_attempt_sessions in row exclusive mode;")).toBeLessThan(
            runner.indexOf("lock table public.omr_attempts in row exclusive mode;"),
        );
        expect(runner).toContain("set statement_timeout = '10s';");
        expect(runner).toContain("OMR_CANONICAL_EVIDENCE_WRITER_LOCKS_READY");
        expect(runner).toContain("canonicalEvidenceBlockerReadyTimeoutMs");
        expect(runner).toContain("canonicalEvidenceContentionProcessTimeoutMs");
        expect(runner).toContain("allowFailure: true");
        expect(runner).toMatch(/lock timeout/i);
        expect(runner).toMatch(/beforeState\s*!==\s*afterState/);
        expect(runner).toContain("pg_terminate_backend");
        expect(runner).toMatch(/with\s+blocker_backend\s+as\s+materialized\s*\([\s\S]*?pid\s*<>\s*pg_catalog\.pg_backend_pid\(\)[\s\S]*?\)[\s\S]*?pg_catalog\.pg_terminate_backend\(blocker_backend\.pid\)/i);
        expect(runner).toMatch(/finally\s*{[\s\S]*?stopCanonicalEvidenceWriterBlocker/);
        expect(runner).toMatch(/await\s+startCanonicalEvidenceWriterBlocker\([^)]*\)[\s\S]*?psqlFile\(/);
        expect(runner).toMatch(/verifyCanonicalQuestionResultEvidenceContention\([^)]*\);[\s\S]*?psqlFile\(`supabase\/migrations\/\$\{migration\}`\);[\s\S]*?psqlFile\(`supabase\/migrations\/\$\{migration\}`\);/);

        const live = readFileSync(liveBehaviorPath, "utf8");
        expect(live).toContain("canonical_evidence_contention_verified");
        expect(runner).toContain("canonical_evidence_contention_verified=1");
    });

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
