import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const migrationName = "202608060019_atomic_student_questions.sql";
const migrationPath = join(root, "supabase/migrations", migrationName);
const migration = existsSync(migrationPath) ? readFileSync(migrationPath, "utf8") : "";
const action = readFileSync(join(root, "src/app/actions/studentExam.ts"), "utf8");
const boundary = readFileSync(join(root, "supabase/production-server-boundary.sql"), "utf8");
const rollback = readFileSync(join(root, "supabase/production-server-boundary-rollback.sql"), "utf8");
const live = readFileSync(join(root, "supabase/live-test-assertions.sql"), "utf8");
const rollbackLive = readFileSync(join(root, "supabase/live-test-rollback-assertions.sql"), "utf8");
const readinessProbe = readFileSync(join(root, "src/lib/supabaseReadinessProbe.ts"), "utf8");

describe("atomic student question mutation", () => {
    it("ships after migration 018 with a service-only, row-locking question RPC", () => {
        const ordered = readdirSync(join(root, "supabase/migrations"))
            .filter(name => name.endsWith(".sql"))
            .sort();
        expect(existsSync(migrationPath)).toBe(true);
        expect(ordered.indexOf(migrationName)).toBeGreaterThan(
            ordered.indexOf("202608060018_attempt_mutation_cas_and_exam_delete.sql"),
        );
        expect(migration).toContain("create or replace function public.omr_upsert_student_attempt_question_v1(");
        expect(migration).toContain("for update;");
        expect(migration).toContain("v_attempt.organization_id is distinct from pg_catalog.btrim(p_organization_id)");
        expect(migration).toContain("coalesce(v_attempt.student_profile_id, v_attempt.student_id)");
        expect(migration).toContain("jsonb_array_elements(v_attempt.payload -> 'questionResults')");
        expect(migration).toContain("jsonb_array_elements(v_student_questions)");
        expect(migration).toContain("v_existing_question ->> 'mutationId' = pg_catalog.btrim(p_mutation_id)");
        expect(migration).toContain("jsonb_set(");
        expect(migration).toContain("jsonb_build_object('studentQuestions'");
        expect(migration).toContain("length(v_body) > 500");
        expect(migration).toContain("v_question_count >= 100");
        expect(migration).toContain("student-question-atomic:202608060019");
        expect(migration).toMatch(/revoke all on function public\.omr_upsert_student_attempt_question_v1[\s\S]+from public, anon, authenticated/);
        expect(migration).toMatch(/grant execute on function public\.omr_upsert_student_attempt_question_v1[\s\S]+to service_role/);
    });

    it("removes the read-merge-whole-row upsert from the signed student action", () => {
        const start = action.indexOf("export async function askAttemptQuestion");
        const questionAction = action.slice(start);
        expect(questionAction).toContain("isSameOriginServerActionRequest");
        expect(questionAction).toContain("resolveCtx()");
        expect(questionAction).toContain("upsertStudentQuestionWithGateway(");
        expect(questionAction).not.toContain("const match = await ownAttempt");
        expect(questionAction).not.toContain('from("omr_attempts").upsert');
        expect(questionAction).not.toContain("upsertStudentQuestion(match");
    });

    it("pins readiness, live behavior, and rollback privilege contracts to the new RPC", () => {
        expect(boundary).toContain("v_student_question_atomic_ready");
        expect(boundary).toContain("student-question-atomic:202608060019");
        expect(boundary).toContain("'studentQuestionAtomicReady'");
        expect(boundary).toContain("'version', '202608080009'");
        expect(readinessProbe).toContain('SUPABASE_READINESS_VERSION = "202608080009"');
        expect(readinessProbe).toContain('"studentQuestionAtomicReady"');
        expect(live).toContain("student question retry lost the concurrent teacher answer");
        expect(live).toContain("student question mutation changed an unrelated question");
        expect(live).toContain("cross-owner student question unexpectedly succeeded");
        expect(rollback).toContain("'omr_upsert_student_attempt_question_v1'");
        expect(rollbackLive).toContain("omr_upsert_student_attempt_question_v1(text,text,text,bigint,text,text)");
    });
});
