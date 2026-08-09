import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const migrationPath = "supabase/migrations/202608090001_assignment_generation_scope.sql";
const OPEN_V3_TYPES = "text,text,text,text,bigint,text,text,text,text,text,text,text,integer[],integer[],timestamptz,jsonb,integer,timestamptz,text,text,integer";

interface SqlFunctionParameter {
    name: string;
    type: string;
}

interface SqlFunctionSignature {
    name: string;
    parameters: SqlFunctionParameter[];
}

function splitTopLevelSqlParameters(source: string): string[] {
    const parameters: string[] = [];
    let start = 0;
    let depth = 0;
    let quote: "single" | "double" | null = null;
    for (let index = 0; index < source.length; index += 1) {
        const character = source[index];
        const next = source[index + 1];
        if (quote === "single") {
            if (character === "'" && next === "'") index += 1;
            else if (character === "'") quote = null;
            continue;
        }
        if (quote === "double") {
            if (character === '"' && next === '"') index += 1;
            else if (character === '"') quote = null;
            continue;
        }
        if (character === "'") quote = "single";
        else if (character === '"') quote = "double";
        else if (character === "(") depth += 1;
        else if (character === ")") depth -= 1;
        else if (character === "," && depth === 0) {
            parameters.push(source.slice(start, index).trim());
            start = index + 1;
        }
    }
    const tail = source.slice(start).trim();
    if (tail) parameters.push(tail);
    return parameters;
}

function parsePublicFunctionSignatures(sql: string): SqlFunctionSignature[] {
    const declarations = /create\s+(?:or\s+replace\s+)?function\s+public\.([a-z_][a-z0-9_]*)\s*\(/gi;
    const signatures: SqlFunctionSignature[] = [];
    for (let match = declarations.exec(sql); match; match = declarations.exec(sql)) {
        const open = declarations.lastIndex - 1;
        let close = -1;
        let depth = 0;
        let quote: "single" | "double" | null = null;
        for (let index = open; index < sql.length; index += 1) {
            const character = sql[index];
            const next = sql[index + 1];
            if (quote === "single") {
                if (character === "'" && next === "'") index += 1;
                else if (character === "'") quote = null;
                continue;
            }
            if (quote === "double") {
                if (character === '"' && next === '"') index += 1;
                else if (character === '"') quote = null;
                continue;
            }
            if (character === "'") quote = "single";
            else if (character === '"') quote = "double";
            else if (character === "(") depth += 1;
            else if (character === ")" && --depth === 0) {
                close = index;
                break;
            }
        }
        if (close < 0) throw new Error(`unterminated function signature: ${match[1]}`);
        const parameters = splitTopLevelSqlParameters(sql.slice(open + 1, close)).map(parameter => {
            const parsed = /^([a-z_][a-z0-9_]*)\s+(.+)$/i.exec(parameter);
            if (!parsed) throw new Error(`invalid function parameter in ${match[1]}: ${parameter}`);
            return { name: parsed[1].toLowerCase(), type: parsed[2].trim().replace(/\s+/g, " ").toLowerCase() };
        });
        const names = parameters.map(parameter => parameter.name);
        const duplicate = names.find((name, index) => names.indexOf(name) !== index);
        if (duplicate) throw new Error(`duplicate function parameter in ${match[1]}: ${duplicate}`);
        signatures.push({ name: match[1].toLowerCase(), parameters });
        declarations.lastIndex = close + 1;
    }
    return signatures;
}

const functionBody = (sql: string, name: string, nextName: string) =>
    sql.split(`function public.${name}(`)[1].split(`function public.${nextName}(`)[0];

describe("assignment generation migration contract", () => {
    it("parses every function signature and rejects duplicate parameter names before migration apply", () => {
        expect(() => parsePublicFunctionSignatures(`
            create function public.invalid_duplicate(p_session_id text, p_session_id text)
            returns jsonb language sql as $$ select '{}'::jsonb $$;
        `)).toThrow("duplicate function parameter in invalid_duplicate: p_session_id");

        const sql = readFileSync(migrationPath, "utf8");
        const signatures = parsePublicFunctionSignatures(sql);
        expect(signatures).toHaveLength(18);
        const open = signatures.find(signature => signature.name === "omr_open_attempt_session_v3");
        expect(open?.parameters.map(parameter => parameter.name)).toEqual([
            "p_session_id", "p_organization_id", "p_exam_id", "p_assignment_id",
            "p_assignment_revision", "p_owner_student_id", "p_student_name", "p_identity_type",
            "p_submission_id", "p_attempt_id", "p_retake_source_attempt_id", "p_retake_mode",
            "p_requested_question_ids", "p_exam_question_ids", "p_exam_updated_at",
            "p_grading_snapshot", "p_duration_seconds", "p_exam_ends_at",
            "p_new_lease_token_hash", "p_current_lease_token_hash", "p_lease_seconds",
        ]);
        expect(open?.parameters.map(parameter => parameter.type).join(",")).toBe(OPEN_V3_TYPES);
    });

    it("adds immutable assignment revision to sessions and attempts without backfilling legacy targeted rows", () => {
        const sql = readFileSync(migrationPath, "utf8").toLowerCase();
        expect(sql).toContain("alter table public.omr_attempt_sessions add column if not exists assignment_revision bigint");
        expect(sql).toContain("alter table public.omr_attempts add column if not exists assignment_revision bigint");
        expect(sql).not.toContain("set assignment_revision = assignment.revision");
        expect(sql).toContain("legacy targeted assignment generation missing");
        expect(sql).toContain("not valid");
        expect(sql).toContain("assignment_revision > 0");
        expect(sql).toContain("assignment generation is immutable");
        expect(sql).toContain("attempt session assignment generation mismatch");
        expect(sql).toContain("pg_advisory_xact_lock_shared(pg_catalog.hashtextextended");
        expect(sql).toContain("608032");
    });

    it("exposes exact generation RPCs for list, resolve, every live mutation, submit, and teacher force finish", () => {
        const sql = readFileSync(migrationPath, "utf8").toLowerCase();
        for (const rpc of [
            "omr_list_student_assignments_v2",
            "omr_resolve_student_assignment_v2",
            "omr_open_attempt_session_v3",
            "omr_checkpoint_attempt_session_v2",
            "omr_heartbeat_attempt_session_v2",
            "omr_takeover_attempt_session_v2",
            "omr_prepare_attempt_session_submit_v2",
            "omr_commit_attempt_session_submit_v2",
            "omr_list_active_attempt_sessions_v2",
            "omr_resolve_legacy_attempt_session_scope_v1",
            "omr_prepare_teacher_force_finish_sessions_compact_v2",
            "omr_force_finish_attempt_sessions_compact_v2",
        ]) expect(sql).toContain(`function public.${rpc}`);
        expect(sql).toContain("p_assignment_revision bigint");
        expect(sql).toContain("assignment.revision is distinct from p_assignment_revision");
        expect(sql).toContain("attempt.assignment_revision is distinct from attempt_session.assignment_revision");
    });

    it("returns one database-clock envelope and binds list classification to its exact timestamp", () => {
        const sql = readFileSync(migrationPath, "utf8").toLowerCase();
        const list = sql.split("function public.omr_list_student_assignments_v2(")[1]
            .split("function public.omr_resolve_student_assignment_v2(")[0];
        expect(list).toContain("returns jsonb");
        expect(list.match(/clock_timestamp\(\)/g)).toHaveLength(1);
        expect(list).toContain("'servernow', v_server_now");
        expect(list).toContain("'assignments'");
        expect(list).toContain("'assignmentrevision'");
    });

    it("uses assignment-before-exam lock order, but returns exact submitted replay before current-generation rejection", () => {
        const sql = readFileSync(migrationPath, "utf8").toLowerCase();
        const open = functionBody(sql, "omr_open_attempt_session_v3", "omr_checkpoint_attempt_session_v2");
        expect(open).not.toContain("omr_open_attempt_session_v2(");
        expect(open).not.toContain("omr_open_attempt_session_v1(");
        expect(open.indexOf("from public.omr_assignments assignment"))
            .toBeLessThan(open.indexOf("from public.omr_exams exam"));
        expect(open.indexOf("pg_advisory_xact_lock_shared(pg_catalog.hashtextextended"))
            .toBeLessThan(open.indexOf("from public.omr_assignments assignment"));
        const submittedReplay = open.indexOf("submitted_attempt_id");
        const currentRevision = open.indexOf("assignment generation stale");
        expect(submittedReplay).toBeGreaterThanOrEqual(0);
        expect(submittedReplay).toBeLessThan(currentRevision);
        expect(open).toContain("assignment_revision = p_assignment_revision");
        expect(open).toContain("attempt_session.submission_id = pg_catalog.btrim(p_submission_id)");
        expect(open).toContain("'session_id', v_session.id");
        expect(open).toContain("insert into public.omr_attempt_sessions");
        expect(open).toContain("assignment_revision");
        expect(open).toContain("v_scope_key");
        expect(open).toContain("attempt.assignment_revision = p_assignment_revision");
        expect(open).toContain("attempt_session.assignment_revision = p_assignment_revision");
        expect(open).toContain("'session_id'");
        expect(open).not.toContain("to_jsonb(v_existing)");
        expect(open).toContain("assignment_revision");
    });

    it("creates a paid effective-plan proof before any new retake session can reach domain locks or insert", () => {
        const sql = readFileSync(migrationPath, "utf8").toLowerCase();
        const open = functionBody(sql, "omr_open_attempt_session_v3", "omr_checkpoint_attempt_session_v2");
        const submittedReplay = open.indexOf("if found then");
        const retakeProof = open.indexOf("omr_prove_effective_organization_plan_v1");
        const assignmentLock = open.indexOf("pg_advisory_xact_lock_shared(pg_catalog.hashtextextended");
        const insert = open.indexOf("insert into public.omr_attempt_sessions");
        expect(retakeProof).toBeGreaterThan(submittedReplay);
        expect(retakeProof).toBeLessThan(assignmentLock);
        expect(retakeProof).toBeLessThan(insert);
        expect(open).toContain("if nullif(pg_catalog.btrim(p_retake_source_attempt_id), '') is not null then");
        expect(open).toContain("v_effective ->> 'plan' not in ('pro', 'academy')");
        expect(open).toContain("effective plan denies retake session");
        expect(open).toMatch(/declare[\s\S]*?v_effective jsonb;[\s\S]*?begin/);
        const resolve = functionBody(sql, "omr_resolve_student_assignment_v2", "omr_open_attempt_session_v3");
        expect(resolve).not.toContain("v_effective jsonb");
    });

    it("authorizes lifecycle only from the locked canonical exam payload and database clock", () => {
        const sql = readFileSync(migrationPath, "utf8").toLowerCase();
        const open = functionBody(sql, "omr_open_attempt_session_v3", "omr_checkpoint_attempt_session_v2");
        const examLock = open.indexOf("from public.omr_exams exam");
        const lifecycleRead = open.indexOf("exam.payload ->> 'startat'");
        const sessionLookup = open.indexOf("where attempt_session.submission_id");
        expect(lifecycleRead).toBeGreaterThan(examLock);
        expect(lifecycleRead).toBeLessThan(sessionLookup);
        expect(open).toContain("exam.payload ->> 'endat'");
        expect(open).toContain("p_exam_ends_at is distinct from v_exam_end");
        expect(open).toContain("v_now < v_exam_start");
        expect(open).toContain("v_now >= v_exam_end");
        expect(open).toContain("attempt session exam not started");
        expect(open).toContain("attempt session exam ended");
        expect(open).toContain("v_deadline := least(");
        expect(open).toContain("coalesce(v_exam_end");
        expect(open).toContain("v_now timestamptz;");
        expect(open).not.toContain("v_now timestamptz := pg_catalog.clock_timestamp()");
        const postExamClock = open.indexOf("v_now := pg_catalog.clock_timestamp()", examLock);
        expect(postExamClock).toBeGreaterThan(examLock);
        expect(postExamClock).toBeLessThan(lifecycleRead);
        const insert = open.indexOf("insert into public.omr_attempt_sessions");
        expect(open.lastIndexOf("v_now := pg_catalog.clock_timestamp()", insert)).toBeGreaterThan(sessionLookup);
        expect(open.slice(open.lastIndexOf("v_now := pg_catalog.clock_timestamp()", insert), insert))
            .toContain("v_now >= v_exam_end");
        expect(open).toContain("'server_now', pg_catalog.clock_timestamp()");
        expect(open).toContain("set statement_timeout = '5s'");
        expect(open).toContain("set lock_timeout = '2s'");
    });

    it("makes targeted retake history revision-aware and never adopts an unscoped historical attempt", () => {
        const sql = readFileSync(migrationPath, "utf8").toLowerCase();
        const resolve = functionBody(sql, "omr_resolve_student_assignment_v2", "omr_open_attempt_session_v3");
        expect(resolve).toContain("retake source attempt is not owned by student");
        expect(resolve).not.toContain("attempt.assignment_revision = p_assignment_revision");
        expect(sql).toContain("historical assignment adoption is disabled");
        expect(sql).toContain("omr_question_results_historical_assignment_guard");
        expect(sql).not.toMatch(/update\s+public\.omr_attempts\s+attempt\s+set\s+assignment_id\s*=/);
    });

    it("keeps continuation calls in advisory-assignment-exam-session order and uses the latest checkpoint signature", () => {
        const sql = readFileSync(migrationPath, "utf8").toLowerCase();
        const lock = functionBody(sql, "omr_lock_attempt_session_generation_v1", "omr_checkpoint_attempt_session_v2");
        expect(lock.indexOf("pg_advisory_xact_lock_shared(pg_catalog.hashtextextended"))
            .toBeLessThan(lock.indexOf("from public.omr_assignments assignment"));
        expect(lock.indexOf("from public.omr_assignments assignment"))
            .toBeLessThan(lock.indexOf("from public.omr_exams exam"));
        expect(lock.indexOf("from public.omr_exams exam"))
            .toBeLessThan(lock.lastIndexOf("from public.omr_attempt_sessions"));
        const pairs = [
            ["omr_checkpoint_attempt_session_v2", "omr_heartbeat_attempt_session_v2"],
            ["omr_heartbeat_attempt_session_v2", "omr_takeover_attempt_session_v2"],
            ["omr_takeover_attempt_session_v2", "omr_prepare_attempt_session_submit_v2"],
            ["omr_prepare_attempt_session_submit_v2", "omr_commit_attempt_session_submit_v2"],
            ["omr_commit_attempt_session_submit_v2", "omr_list_active_attempt_sessions_v2"],
        ] as const;
        for (const [name, next] of pairs) {
            const body = functionBody(sql, name, next);
            expect(body, name).toContain("omr_lock_attempt_session_generation_v1(");
        }
        const checkpoint = functionBody(sql, "omr_checkpoint_attempt_session_v2", "omr_heartbeat_attempt_session_v2");
        expect(checkpoint).not.toContain("p_handwriting_checkpoint");
        expect(checkpoint).not.toContain("p_max_handwriting_bytes");
        expect(checkpoint).toContain("p_progress_payload,p_lease_seconds,p_final_checkpoint");
    });

    it("shares the assignment generation fence across students while teacher mutation remains exclusive", () => {
        const sql = readFileSync(migrationPath, "utf8").toLowerCase();
        const generationLock = functionBody(sql, "omr_lock_current_assignment_generation_v1", "omr_guard_assignment_generation_v1");
        const open = functionBody(sql, "omr_open_attempt_session_v3", "omr_checkpoint_attempt_session_v2");
        const continuation = functionBody(sql, "omr_lock_attempt_session_generation_v1", "omr_exact_submitted_attempt_session_v1");
        for (const body of [generationLock, open, continuation]) {
            expect(body).toContain("pg_advisory_xact_lock_shared(pg_catalog.hashtextextended");
            expect(body).toContain("set statement_timeout = '5s'");
            expect(body).toContain("set lock_timeout = '2s'");
        }
        const teacher = readFileSync("supabase/migrations/202608080008_effective_workspace_plan_enforcement.sql", "utf8").toLowerCase();
        expect(teacher).toContain("pg_advisory_xact_lock(pg_catalog.hashtextextended(v_assignment_id, 608032))");
        expect(teacher).not.toContain("pg_advisory_xact_lock_shared(pg_catalog.hashtextextended(v_assignment_id, 608032))");
    });

    it("returns only exact current active rows and atomically rejects legacy teacher force-finish sets", () => {
        const sql = readFileSync(migrationPath, "utf8").toLowerCase();
        const active = functionBody(sql, "omr_list_active_attempt_sessions_v2", "omr_prepare_teacher_force_finish_sessions_compact_v2");
        expect(active).toContain("p_organization_id,p_exam_id,p_actor_user_id,p_member_role,p_limit");
        expect(active).toContain("session.id=active.session_id");
        expect(active).toContain("assignment.revision=session.assignment_revision");
        const prepare = functionBody(sql, "omr_prepare_teacher_force_finish_sessions_compact_v2", "omr_force_finish_attempt_sessions_compact_v2");
        expect(prepare).toContain("cardinality(p_session_ids)");
        expect(prepare).toContain("legacy targeted assignment generation missing");
        const force = functionBody(sql, "omr_force_finish_attempt_sessions_compact_v2", "omr_list_student_assignments_v2");
        expect(force).toContain("select count(*)");
        expect(force).toContain("is distinct from pg_catalog.cardinality(p_session_ids)");
        expect(force).toContain("assignmentrevision");
        expect(force).toContain("attempt.assignment_revision is not distinct from session.assignment_revision");
    });

    it("guards legacy targeted history as review-only while still permitting safe expiry cleanup", () => {
        const sql = readFileSync(migrationPath, "utf8").toLowerCase();
        const guard = functionBody(sql, "omr_guard_assignment_generation_v1", "omr_guard_historical_question_assignment_v1");
        for (const immutable of [
            "score", "total_score", "payload", "student_name", "student_id", "exam_id",
            "organization_id", "finished_at", "retake_source_attempt_id", "retake_mode",
            "ticket_id", "class_id", "student_profile_id", "group_id", "group_name",
            "region_id", "region_name", "retake_question_ids", "merged_from_guest_id", "merged_at",
        ]) expect(guard).toContain(`new.${immutable} is distinct from old.${immutable}`);
        expect(guard).toContain("old.status = 'in_progress'");
        expect(guard).toContain("new.status = 'expired'");
        expect(guard).toContain("old.status = 'submitted'");
    });

    it("permits bounded follow-up writes to exact completed generation attempts after session GC", () => {
        const sql = readFileSync(migrationPath, "utf8").toLowerCase();
        const guard = functionBody(sql, "omr_guard_assignment_generation_v1", "omr_guard_historical_question_assignment_v1");
        const attempts = guard.slice(guard.indexOf("-- omr_attempts:"));
        const legacyBranch = attempts.indexOf("if tg_op = 'update'");
        const completedStart = attempts.indexOf("if tg_op = 'update'", legacyBranch + 1);
        const completed = attempts.slice(completedStart, attempts.indexOf("if new.assignment_revision is null", completedStart));
        expect(completed).toContain("new.status is distinct from old.status");
        for (const immutable of [
            "organization_id", "exam_id", "student_id", "identity_type",
            "assignment_id", "assignment_revision", "retake_source_attempt_id", "retake_mode",
        ]) expect(completed).toContain(`new.${immutable} is distinct from old.${immutable}`);
        expect(completed).toContain("return new");
        expect(completed).not.toContain("from public.omr_attempt_sessions");
        expect(completedStart).toBeLessThan(attempts.indexOf("from public.omr_attempt_sessions"));
    });

    it("never acquires an assignment lock from the attempt-session UPDATE trigger path", () => {
        const sql = readFileSync(migrationPath, "utf8").toLowerCase();
        const guard = functionBody(sql, "omr_guard_assignment_generation_v1", "omr_guard_historical_question_assignment_v1");
        const sessionBranch = guard.slice(
            guard.indexOf("if tg_table_name = 'omr_attempt_sessions' then"),
            guard.indexOf("-- omr_attempts:"),
        );
        expect(sessionBranch).toMatch(/if tg_op = 'update' then[\s\S]*?return new;[\s\S]*?end if;[\s\S]*?perform public\.omr_lock_current_assignment_generation_v1/);
        const updateBranch = sessionBranch.slice(
            sessionBranch.indexOf("if tg_op = 'update' then"),
            sessionBranch.indexOf("perform public.omr_lock_current_assignment_generation_v1"),
        );
        expect(updateBranch).not.toContain("omr_lock_current_assignment_generation_v1");
        expect(sessionBranch.match(/omr_lock_current_assignment_generation_v1/g)).toHaveLength(1);
    });

    it("wires exact vnext signatures into readiness, production, rollback, and live assertions", () => {
        const required = [
            "omr_list_student_assignments_v2", "omr_resolve_student_assignment_v2",
            "omr_open_attempt_session_v3", "omr_checkpoint_attempt_session_v2",
            "omr_heartbeat_attempt_session_v2", "omr_takeover_attempt_session_v2",
            "omr_prepare_attempt_session_submit_v2", "omr_commit_attempt_session_submit_v2",
            "omr_list_active_attempt_sessions_v2", "omr_prepare_teacher_force_finish_sessions_compact_v2",
            "omr_resolve_legacy_attempt_session_scope_v1",
            "omr_force_finish_attempt_sessions_compact_v2",
        ];
        for (const path of [
            "supabase/production-server-boundary.sql",
            "supabase/production-server-boundary-rollback.sql",
            "supabase/live-test-assertions.sql",
            "supabase/live-test-rollback-assertions.sql",
            "src/lib/supabaseReadinessProbe.ts",
            "src/lib/initialOperationsLoadGateway.server.ts",
        ]) {
            const source = readFileSync(path, "utf8");
            for (const rpc of required) expect(source, `${path}:${rpc}`).toContain(rpc);
        }
        expect(readFileSync("src/lib/supabaseReadinessProbe.ts", "utf8"))
            .toContain('SUPABASE_READINESS_VERSION = "202608090001"');
        expect(readFileSync("supabase/production-server-boundary.sql", "utf8"))
            .toContain("'version', '202608090001'");
        for (const path of [
            migrationPath,
            "supabase/production-server-boundary.sql",
            "supabase/production-server-boundary-rollback.sql",
            "supabase/live-test-assertions.sql",
            "supabase/live-test-rollback-assertions.sql",
        ]) {
            expect(readFileSync(path, "utf8")).toContain(`omr_open_attempt_session_v3(${OPEN_V3_TYPES})`);
        }
    });

    it("returns the canonical stored attempt payload on commit response-loss replay", () => {
        const sql = readFileSync(migrationPath, "utf8").toLowerCase();
        const commit = functionBody(sql, "omr_commit_attempt_session_submit_v2", "omr_list_active_attempt_sessions_v2");
        const replay = commit.slice(
            commit.indexOf("if v_result is not null then"),
            commit.indexOf("select * into attempt_session"),
        );
        expect(replay).toContain("from public.omr_attempts");
        expect(replay).toContain("'payload'");
        expect(replay).toContain("'result_status', 'submitted'");
        expect(replay).not.toContain("return v_result");
    });

    it("recovers legacy outbox scope only through exact owner and assignment-null session", () => {
        const sql = readFileSync(migrationPath, "utf8").toLowerCase();
        const recovery = functionBody(
            sql,
            "omr_resolve_legacy_attempt_session_scope_v1",
            "omr_prepare_teacher_force_finish_sessions_compact_v2",
        );
        expect(recovery).toContain("session.organization_id = pg_catalog.btrim(p_organization_id)");
        expect(recovery).toContain("session.owner_student_id = pg_catalog.btrim(p_owner_student_id)");
        expect(recovery).toContain("if v_session.assignment_id is not null then");
        expect(recovery).toContain("'status','targeted'");
        expect(recovery).toContain("'status','resolved','examid',v_session.exam_id");
        expect(recovery).not.toContain("answers");
        expect(recovery).not.toContain("grading_snapshot");
    });

    it("does not claim an impossible server proof for origin-ambiguous segmented drafts", () => {
        const sql = readFileSync(migrationPath, "utf8").toLowerCase();
        expect(sql).not.toContain("omr_resolve_legacy_draft_scope");
    });
});
