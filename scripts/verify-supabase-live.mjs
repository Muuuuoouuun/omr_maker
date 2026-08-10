import {
    accessSync,
    constants,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { delimiter, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";

import { CANONICAL_TABLES } from "./canonical-table-manifest.mjs";
import { deriveLivePgReleaseProofs } from "./live-pg-release-proof-core.mjs";

const root = resolve(import.meta.dirname, "..");
const container = `omr-postgres-verify-${process.pid}`;
const password = "omr-live-test-password";
const migrationOwner = "postgres";
const localDatabase = "omr_live_verify";
const requiredPostgresBinaries = ["initdb", "pg_ctl", "createdb", "psql", "postgres", "pg_dump"];
const dockerInfoTimeoutMs = 5_000;
const liveSqlTimeoutMs = 120_000;
const canonicalEvidenceBlockerReadyTimeoutMs = 5_000;
const canonicalEvidenceContentionProcessTimeoutMs = 8_000;
const canonicalEvidenceBlockerProcessTimeoutMs = 12_000;
const canonicalEvidenceBlockerStopTimeoutMs = 3_000;
const canonicalEvidenceBlockerOutputLimit = 16_384;
const canonicalEvidenceWriterReadyMarker = "OMR_CANONICAL_EVIDENCE_WRITER_LOCKS_READY";
const canonicalEvidenceWriterApplicationName = `omr_canonical_evidence_writer_${process.pid}`;
const canonicalQuestionResultEvidenceMigration = "202608100001_canonical_question_result_evidence.sql";
const canonicalEvidenceWriterBlockerCommands = [
    `begin;
set statement_timeout = '10s';
lock table public.omr_attempt_sessions in row exclusive mode;
lock table public.omr_attempts in row exclusive mode;
select '${canonicalEvidenceWriterReadyMarker}';`,
    "select pg_catalog.pg_sleep(10);",
    "rollback;",
];
const kakaoEntitlementUpgradeFixture =
    process.env.OMR_KAKAO_ENTITLEMENT_UPGRADE_FIXTURE === "1";
const liveCanonicalTablesSql = `
select coalesce(json_agg(canonical.table_name order by canonical.table_name), '[]'::json)::text
  from (
      select relation.relname as table_name
        from pg_class relation
        join pg_namespace namespace on namespace.oid = relation.relnamespace
       where namespace.nspname = 'public'
         and relation.relkind in ('r', 'p')
         and relation.relname like 'omr\\_%' escape '\\'
  ) canonical
`;
const liveUnsupportedCanonicalRelationsSql = `
select coalesce(
           json_agg(
               json_build_object('kind', relation.relkind, 'name', relation.relname)
               order by relation.relkind, relation.relname
           ),
           '[]'::json
       )::text
  from pg_class relation
  join pg_namespace namespace on namespace.oid = relation.relnamespace
 where namespace.nspname = 'public'
   and relation.relkind in ('f', 'v', 'm')
   and relation.relname like 'omr\\_%' escape '\\'
`;
const canonicalQuestionResultEvidenceMigrationStateSql = `
with target_relations as (
    select relation.oid, namespace.nspname, relation.relname,
           relation.relkind, relation.relpersistence, relation.relrowsecurity,
           relation.relforcerowsecurity, relation.relacl,
           pg_catalog.pg_get_userbyid(relation.relowner) as owner_name,
           pg_catalog.obj_description(relation.oid, 'pg_class') as comment
      from pg_catalog.pg_class relation
      join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
     where (namespace.nspname, relation.relname) in (
         ('public', 'omr_attempt_sessions'),
         ('public', 'omr_attempts'),
         ('public', 'omr_question_results'),
         ('omr_internal', 'canonical_evidence_dirty_attempts')
     )
), target_functions as (
    select procedure.oid, namespace.nspname, procedure.proname,
           pg_catalog.pg_get_function_identity_arguments(procedure.oid) as identity_arguments,
           pg_catalog.pg_get_functiondef(procedure.oid) as definition,
           procedure.proacl, procedure.proconfig,
           pg_catalog.pg_get_userbyid(procedure.proowner) as owner_name,
           pg_catalog.obj_description(procedure.oid, 'pg_proc') as comment
      from pg_catalog.pg_proc procedure
      join pg_catalog.pg_namespace namespace on namespace.oid = procedure.pronamespace
     where namespace.nspname = 'public'
       and procedure.proname in (
           'omr_assert_canonical_question_result_json_v1',
           'omr_canonical_json_text_v1',
           'omr_compute_canonical_question_result_evidence_v1',
           'omr_bind_attempt_evidence_generation_v1',
           'omr_guard_canonical_question_result_evidence_v1',
           'omr_question_result_assignment_generation_guard_v2',
           'omr_canonical_attempt_child_evidence_matches_v1',
           'omr_assert_canonical_attempt_child_evidence_v1',
           'omr_mark_canonical_attempt_evidence_dirty_v1',
           'omr_finalize_canonical_attempt_evidence_dirty_v1',
           'omr_guard_completed_question_result_grading_immutability_v1',
           'omr_force_finish_attempt_sessions_compact_v2',
           'omr_canonical_question_result_evidence_ready_v1',
           'omr_service_readiness_v1'
       )
)
select pg_catalog.jsonb_build_object(
    'namespaces', (
        select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
                   namespace.nspname, namespace.nspacl,
                   pg_catalog.pg_get_userbyid(namespace.nspowner)
               ) order by namespace.nspname), '[]'::jsonb)
          from pg_catalog.pg_namespace namespace
         where namespace.nspname in ('public', 'omr_internal')
    ),
    'relations', (
        select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(relation)
                   order by relation.nspname, relation.relname), '[]'::jsonb)
          from target_relations relation
    ),
    'columns', (
        select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
                   relation.nspname, relation.relname, attribute.attnum, attribute.attname,
                   pg_catalog.format_type(attribute.atttypid, attribute.atttypmod),
                   attribute.attnotnull, attribute.attidentity, attribute.attgenerated,
                   pg_catalog.pg_get_expr(default_value.adbin, default_value.adrelid)
               ) order by relation.nspname, relation.relname, attribute.attnum), '[]'::jsonb)
          from target_relations relation
          join pg_catalog.pg_attribute attribute on attribute.attrelid = relation.oid
               and attribute.attnum > 0 and not attribute.attisdropped
          left join pg_catalog.pg_attrdef default_value on default_value.adrelid = relation.oid
               and default_value.adnum = attribute.attnum
    ),
    'constraints', (
        select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
                   relation.nspname, relation.relname, constraint_row.conname,
                   constraint_row.contype, constraint_row.condeferrable,
                   constraint_row.condeferred, constraint_row.convalidated,
                   pg_catalog.pg_get_constraintdef(constraint_row.oid, true)
               ) order by relation.nspname, relation.relname, constraint_row.conname), '[]'::jsonb)
          from target_relations relation
          join pg_catalog.pg_constraint constraint_row on constraint_row.conrelid = relation.oid
    ),
    'indexes', (
        select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
                   relation.nspname, relation.relname, index_relation.relname,
                   pg_catalog.pg_get_indexdef(index_row.indexrelid)
               ) order by relation.nspname, relation.relname, index_relation.relname), '[]'::jsonb)
          from target_relations relation
          join pg_catalog.pg_index index_row on index_row.indrelid = relation.oid
          join pg_catalog.pg_class index_relation on index_relation.oid = index_row.indexrelid
    ),
    'triggers', (
        select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
                   relation.nspname, relation.relname, trigger_row.tgname,
                   pg_catalog.pg_get_triggerdef(trigger_row.oid, true)
               ) order by relation.nspname, relation.relname, trigger_row.tgname), '[]'::jsonb)
          from target_relations relation
          join pg_catalog.pg_trigger trigger_row on trigger_row.tgrelid = relation.oid
               and not trigger_row.tgisinternal
    ),
    'functions', (
        select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(procedure)
                   order by procedure.nspname, procedure.proname, procedure.identity_arguments), '[]'::jsonb)
          from target_functions procedure
    )
)::text
`;

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        cwd: root,
        encoding: "utf8",
        stdio: options.capture ? "pipe" : "inherit",
        env: options.env || process.env,
        timeout: options.timeout,
    });
    if (result.status !== 0 && !options.allowFailure) {
        const detail = [
            result.error?.message,
            result.stdout,
            result.stderr,
        ].filter(Boolean).join("\n");
        throw new Error(`${command} ${args.join(" ")} failed${detail ? `\n${detail}` : ""}`);
    }
    return result;
}

function waitForDelay(milliseconds) {
    return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds));
}

function appendBoundedBlockerOutput(current, chunk, child) {
    const next = current + chunk.toString("utf8");
    if (next.length > canonicalEvidenceBlockerOutputLimit) {
        child.kill("SIGKILL");
        throw new Error("canonical evidence writer blocker output exceeded its bound");
    }
    return next;
}

function startCanonicalEvidenceWriterBlocker(command, args, options = {}) {
    const child = spawn(command, args, {
        cwd: root,
        env: options.env || process.env,
        stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let ready = false;
    let readySettled = false;
    let resolveCompletion;
    const completion = new Promise(resolveChild => {
        resolveCompletion = resolveChild;
    });
    const hardTimeout = setTimeout(() => child.kill("SIGKILL"), canonicalEvidenceBlockerProcessTimeoutMs);
    const readyTimeout = setTimeout(() => {
        if (!readySettled) child.kill("SIGKILL");
    }, canonicalEvidenceBlockerReadyTimeoutMs);

    child.once("close", (code, signal) => {
        clearTimeout(hardTimeout);
        resolveCompletion({ code, signal });
    });

    const readiness = new Promise((resolveReady, rejectReady) => {
        const failReadiness = error => {
            if (readySettled) return;
            readySettled = true;
            clearTimeout(readyTimeout);
            rejectReady(error);
        };
        child.once("error", error => failReadiness(error));
        child.once("close", (code, signal) => {
            if (!ready) {
                failReadiness(new Error(
                    `canonical evidence writer blocker exited before its lock sentinel: code=${code}, signal=${signal}, stderr=${stderr}`,
                ));
            }
        });
        child.stdout.on("data", chunk => {
            try {
                stdout = appendBoundedBlockerOutput(stdout, chunk, child);
            } catch (error) {
                failReadiness(error);
                return;
            }
            if (!ready && stdout.includes(canonicalEvidenceWriterReadyMarker)) {
                ready = true;
                readySettled = true;
                clearTimeout(readyTimeout);
                resolveReady({
                    child,
                    completion,
                    hardTimeout,
                    output: () => ({ stdout, stderr }),
                });
            }
        });
        child.stderr.on("data", chunk => {
            try {
                stderr = appendBoundedBlockerOutput(stderr, chunk, child);
            } catch (error) {
                failReadiness(error);
            }
        });
    });

    return readiness;
}

async function stopCanonicalEvidenceWriterBlocker(blocker, psqlQuery) {
    try {
        psqlQuery(`
with blocker_backend as materialized (
    select activity.pid
      from pg_catalog.pg_stat_activity activity
     where activity.application_name = '${canonicalEvidenceWriterApplicationName}'
       and activity.pid <> pg_catalog.pg_backend_pid()
)
select pg_catalog.count(*)
  from blocker_backend
 where pg_catalog.pg_terminate_backend(blocker_backend.pid)
        `);
    } finally {
        blocker.child.kill("SIGTERM");
        let stopped = await Promise.race([
            blocker.completion.then(() => true),
            waitForDelay(canonicalEvidenceBlockerStopTimeoutMs).then(() => false),
        ]);
        if (!stopped) {
            blocker.child.kill("SIGKILL");
            stopped = await Promise.race([
                blocker.completion.then(() => true),
                waitForDelay(1_000).then(() => false),
            ]);
        }
        clearTimeout(blocker.hardTimeout);
        if (!stopped) throw new Error("canonical evidence writer blocker did not stop within its bound");
    }
}

async function verifyCanonicalQuestionResultEvidenceContention(
    psqlFile,
    psqlQuery,
    startWriterBlocker,
) {
    const beforeState = psqlQuery(canonicalQuestionResultEvidenceMigrationStateSql).trim();
    const blocker = await startWriterBlocker();
    let migrationResult;
    const startedAt = Date.now();
    try {
        migrationResult = psqlFile(
            `supabase/migrations/${canonicalQuestionResultEvidenceMigration}`,
            [],
            {
                allowFailure: true,
                capture: true,
                timeout: canonicalEvidenceContentionProcessTimeoutMs,
            },
        );
    } finally {
        await stopCanonicalEvidenceWriterBlocker(blocker, psqlQuery);
    }
    const elapsedMs = Date.now() - startedAt;
    const afterState = psqlQuery(canonicalQuestionResultEvidenceMigrationStateSql).trim();
    if (beforeState !== afterState) {
        throw new Error("canonical evidence migration contention left a partial schema");
    }
    if (migrationResult.status === 0) {
        throw new Error("canonical evidence migration unexpectedly bypassed the writer blocker");
    }
    if (migrationResult.error) {
        throw new Error(`canonical evidence migration contention process failed: ${migrationResult.error.message}`);
    }
    const failureOutput = `${migrationResult.stdout || ""}\n${migrationResult.stderr || ""}`;
    if (!/canceling statement due to lock timeout/i.test(failureOutput)) {
        throw new Error(`canonical evidence migration failed for a non-lock reason: ${failureOutput}`);
    }
    if (elapsedMs > canonicalEvidenceContentionProcessTimeoutMs) {
        throw new Error(`canonical evidence migration exceeded contention budget: ${elapsedMs}ms`);
    }
}

function releaseProofReport(result) {
    return { stdout: result.stdout, stderr: result.stderr };
}

function unsupportedLiveCanonicalRelations(psqlQuery) {
    return JSON.parse(psqlQuery(liveUnsupportedCanonicalRelationsSql).trim());
}

function assertLiveCanonicalTables(psqlQuery) {
    const unsupportedRelations = unsupportedLiveCanonicalRelations(psqlQuery);
    if (unsupportedRelations.length > 0) {
        throw new Error(
            `live database contains unsupported public OMR relation kinds: count=${unsupportedRelations.length}`,
        );
    }
    const liveTables = JSON.parse(psqlQuery(liveCanonicalTablesSql).trim());
    if (JSON.stringify(liveTables) !== JSON.stringify(CANONICAL_TABLES)) {
        throw new Error(
            `live canonical tables do not match the generated manifest: expected ${JSON.stringify(CANONICAL_TABLES)}, found ${JSON.stringify(liveTables)}`,
        );
    }
}

function assertUnsupportedLiveRelationProbe(psqlQuery) {
    try {
        psqlQuery(`
do $probe$
begin
    execute 'create view public.omr_live_manifest_view_probe as select 1 as id';
    execute 'create materialized view public.omr_live_manifest_materialized_probe as select 1 as id';
end
$probe$
        `);
        const detected = unsupportedLiveCanonicalRelations(psqlQuery);
        if (
            !detected.some((relation) => relation.kind === "v" && relation.name === "omr_live_manifest_view_probe")
            || !detected.some((relation) => relation.kind === "m" && relation.name === "omr_live_manifest_materialized_probe")
        ) {
            throw new Error("unsupported live relation probe did not detect dynamic view DDL");
        }
    } finally {
        try {
            psqlQuery("drop materialized view if exists public.omr_live_manifest_materialized_probe");
        } finally {
            psqlQuery("drop view if exists public.omr_live_manifest_view_probe");
        }
    }
}

async function runSqlMatrix(
    psqlFile,
    psqlQuery,
    verifyKakaoQuarantineBackupRoundtrip,
    startWriterBlocker,
) {
    const releaseProofReports = [];
    psqlFile("supabase/live-test-prelude.sql");
    psqlFile("supabase/schema.sql");
    psqlFile("supabase/live-test-alpha-generated-helpers.sql");

    const migrations = readdirSync(resolve(root, "supabase/migrations"))
        .filter(name => name.endsWith(".sql"))
        .sort();
    for (const migration of migrations) {
        if (
            kakaoEntitlementUpgradeFixture
            && migration === "202608100002_kakao_reminder_entitlement_boundary.sql"
        ) {
            psqlFile("supabase/kakao-reminder-entitlement-upgrade-fixtures.sql");
        }
        if (migration === canonicalQuestionResultEvidenceMigration) {
            await verifyCanonicalQuestionResultEvidenceContention(
                psqlFile,
                psqlQuery,
                startWriterBlocker,
            );
            psqlFile(`supabase/migrations/${migration}`);
            psqlFile(`supabase/migrations/${migration}`);
        } else {
            psqlFile(`supabase/migrations/${migration}`);
        }
        if (
            kakaoEntitlementUpgradeFixture
            && migration === "202608100002_kakao_reminder_entitlement_boundary.sql"
        ) {
            psqlFile("supabase/kakao-reminder-entitlement-upgrade-assertions.sql");
        }
    }
    assertUnsupportedLiveRelationProbe(psqlQuery);
    assertLiveCanonicalTables(psqlQuery);

    verifyKakaoQuarantineBackupRoundtrip();
    psqlFile("supabase/kakao-reminder-entitlement-readiness-performance-assertions.sql");
    psqlFile("supabase/canonical-question-result-evidence-assertions.sql", [], {
        variables: ["canonical_evidence_contention_verified=1"],
    });
    psqlFile("supabase/kakao-reminder-entitlement-assertions.sql");
    psqlFile("supabase/kakao-reminder-entitlement-concurrency-lock.sql");
    psqlFile("supabase/individual-student-assignments-assertions.sql");
    psqlFile("supabase/teacher-force-finish-compact-assertions.sql");
    psqlFile("supabase/teacher-session-revocation-assertions.sql");
    psqlFile("supabase/production-server-boundary.sql");
    psqlFile("supabase/live-test-boundary-assertions.sql");
    releaseProofReports.push(releaseProofReport(psqlFile("supabase/initial-operations-release-proof-assertions.sql", [], {
        capture: true,
        variables: ["release_proof_phase=boundary_asserted"],
    })));
    psqlFile("supabase/kakao-reminder-overload-fixtures.sql");
    psqlFile("supabase/production-server-boundary-rollback.sql", [
        "set omr.rollback_confirm = 'restore-browser-access'",
    ]);
    psqlFile("supabase/live-test-rollback-assertions.sql");
    releaseProofReports.push(releaseProofReport(psqlFile("supabase/initial-operations-release-proof-assertions.sql", [], {
        capture: true,
        variables: ["release_proof_phase=rollback_asserted"],
    })));
    psqlFile("supabase/production-server-boundary.sql");
    psqlFile("supabase/kakao-reminder-overload-boundary-assertions.sql");
    psqlFile("supabase/production-server-boundary.sql");
    psqlFile("supabase/live-test-boundary-assertions.sql");
    releaseProofReports.push(releaseProofReport(psqlFile("supabase/initial-operations-release-proof-assertions.sql", [], {
        capture: true,
        variables: ["release_proof_phase=reapplied"],
    })));
    psqlFile("supabase/live-test-assertions.sql");
    psqlFile("supabase/roster-snapshot-cas-assertions.sql");
    psqlFile("supabase/teacher-notification-summary-assertions.sql");
    psqlFile("supabase/teacher-notification-state-assertions.sql");
    releaseProofReports.push(releaseProofReport(psqlFile("supabase/initial-operations-release-proof-assertions.sql", [], {
        capture: true,
        variables: ["release_proof_phase=final_asserted"],
    })));
    return deriveLivePgReleaseProofs({ reports: releaseProofReports });
}

function postgresBinCandidates() {
    const pathDirectories = (process.env.PATH || "").split(delimiter).filter(Boolean);
    return [
        process.env.OMR_POSTGRES_BIN,
        ...pathDirectories,
        "/opt/homebrew/opt/postgresql@17/bin",
        "/usr/local/opt/postgresql@17/bin",
        "/home/linuxbrew/.linuxbrew/opt/postgresql@17/bin",
    ].filter(Boolean);
}

function hasRequiredPostgresBinaries(directory) {
    return requiredPostgresBinaries.every(binary => {
        try {
            accessSync(resolve(directory, binary), constants.X_OK);
            return true;
        } catch {
            return false;
        }
    });
}

function isPostgres17Directory(directory) {
    const version = run(postgresBinary(directory, "postgres"), ["--version"], {
        capture: true,
        allowFailure: true,
    });
    return version.status === 0 && /\bPostgreSQL\)\s+17\./.test(version.stdout);
}

function findPostgresBinDirectory() {
    const directories = [...new Set(postgresBinCandidates())];
    const directory = directories.find(directory => hasRequiredPostgresBinaries(directory) && isPostgres17Directory(directory));
    if (directory) return directory;

    throw new Error(
        "PostgreSQL 17 binaries are required for the local fallback. " +
        "Set OMR_POSTGRES_BIN to a directory containing initdb, pg_ctl, createdb, psql, and postgres. " +
        `Checked: ${directories.join(", ")}`,
    );
}

function postgresBinary(directory, name) {
    return resolve(directory, name);
}

function getFreePort(host) {
    return new Promise((resolvePort, reject) => {
        const server = createServer();
        server.unref();
        server.once("error", reject);
        server.listen({ host, port: 0, exclusive: true }, () => {
            const address = server.address();
            if (!address || typeof address === "string") {
                server.close();
                reject(new Error(`Unable to reserve a free PostgreSQL port on ${host}.`));
                return;
            }
            server.close(error => {
                if (error) reject(error);
                else resolvePort(address.port);
            });
        });
    });
}

async function runDockerVerification() {
    function psqlFile(path, commands = [], options = {}) {
        return run("docker", [
            "exec", container,
            "psql", "-U", migrationOwner, "-d", "postgres",
            "-v", "ON_ERROR_STOP=1",
            "-v", `kakao_dblink_password=${password}`,
            ...(options.variables ?? []).flatMap(variable => ["-v", variable]),
            ...commands.flatMap(command => ["-c", command]),
            "-f", `/workspace/${path}`,
        ], {
            allowFailure: options.allowFailure === true,
            capture: options.capture === true,
            timeout: liveSqlTimeoutMs,
            ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
        });
    }

    function psqlQuery(sql) {
        return run("docker", [
            "exec", container,
            "psql", "-U", migrationOwner, "-d", "postgres",
            "-v", "ON_ERROR_STOP=1", "-At", "-c", sql,
        ], { capture: true, timeout: liveSqlTimeoutMs }).stdout;
    }

    async function startWriterBlocker() {
        return await startCanonicalEvidenceWriterBlocker("docker", [
            "exec",
            "--env", `PGAPPNAME=${canonicalEvidenceWriterApplicationName}`,
            container,
            "psql", "-U", migrationOwner, "-d", "postgres",
            "-v", "ON_ERROR_STOP=1",
            ...canonicalEvidenceWriterBlockerCommands.flatMap(command => ["-c", command]),
        ]);
    }

    function verifyKakaoQuarantineBackupRoundtrip() {
        if (!CANONICAL_TABLES.includes("omr_kakao_reminder_legacy_quarantine")) {
            throw new Error("Kakao quarantine is absent from the canonical backup allowlist");
        }
        const dumpPath = `/tmp/omr-kakao-quarantine-${process.pid}.sql`;
        const exactRowsSql = `
select coalesce(
           jsonb_agg(to_jsonb(evidence) order by source_table, source_id),
           '[]'::jsonb
       )::text
  from public.omr_kakao_reminder_legacy_quarantine evidence
`;
        psqlQuery(`
insert into public.omr_kakao_reminder_legacy_quarantine (
    source_table, source_id, organization_id, row_snapshot, reason, inventoried_at
) values (
    'omr_kakao_candidate_reviews', 'kakao:backup-roundtrip:source',
    'kakao-backup-roundtrip-org',
    '{"schemaVersion":1,"payload":{"opaque":"preserve-exactly"}}'::jsonb,
    'operator forensic retention fixture',
    '2026-08-10T00:00:00.123456Z'::timestamptz
)
on conflict (source_table, source_id) do update set
    organization_id = excluded.organization_id,
    row_snapshot = excluded.row_snapshot,
    reason = excluded.reason,
    inventoried_at = excluded.inventoried_at
        `);
        const before = psqlQuery(exactRowsSql).trim();
        run("docker", [
            "exec", container,
            "pg_dump", "-U", migrationOwner, "-d", "postgres",
            "--data-only", "--no-owner", "--no-privileges",
            "--table=public.omr_kakao_reminder_legacy_quarantine",
            `--file=${dumpPath}`,
        ], { timeout: 30_000 });
        psqlQuery("delete from public.omr_kakao_reminder_legacy_quarantine");
        run("docker", [
            "exec", container,
            "psql", "-U", migrationOwner, "-d", "postgres",
            "-v", "ON_ERROR_STOP=1", "-f", dumpPath,
        ], { timeout: 30_000 });
        const after = psqlQuery(exactRowsSql).trim();
        if (after !== before) {
            throw new Error("actual Kakao quarantine pg_dump/restore changed forensic evidence");
        }
        psqlQuery(`
delete from public.omr_kakao_reminder_legacy_quarantine
 where source_table = 'omr_kakao_candidate_reviews'
   and source_id = 'kakao:backup-roundtrip:source'
        `);
    }

    try {
        run("docker", [
            "run", "--detach", "--rm",
            "--name", container,
            "--env", `POSTGRES_PASSWORD=${password}`,
            "--volume", `${root}:/workspace:ro`,
            "postgres:17-alpine",
        ]);

        let ready = false;
        for (let attempt = 0; attempt < 60; attempt += 1) {
            const probe = run("docker", ["exec", container, "pg_isready", "-U", migrationOwner], {
                capture: true,
                allowFailure: true,
            });
            if (probe.status === 0) {
                ready = true;
                break;
            }
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
        }
        if (!ready) throw new Error("PostgreSQL container did not become ready in time.");

        return await runSqlMatrix(
            psqlFile,
            psqlQuery,
            verifyKakaoQuarantineBackupRoundtrip,
            startWriterBlocker,
        );
    } finally {
        run("docker", ["rm", "--force", container], { capture: true, allowFailure: true });
    }
}

async function runLocalVerification() {
    const postgresBin = findPostgresBinDirectory();
    const version = run(postgresBinary(postgresBin, "postgres"), ["--version"], { capture: true });
    if (!/\bPostgreSQL\)\s+17\./.test(version.stdout)) {
        throw new Error(`Local fallback requires PostgreSQL 17; found: ${version.stdout.trim()}`);
    }

    // Declared before the cluster is created so the shutdown in `finally` runs
    // with the same pinned locale, and so the mkdtemp/try pair below stays
    // adjacent — supabaseLiveVerifier.test.ts asserts on that exact shape to
    // prove the cluster is isolated and unconditionally cleaned up.
    const localeEnv = { LC_ALL: "C", LANG: "C" };
    const temporaryDirectory = mkdtempSync(resolve(tmpdir(), "omr-postgres-verify-"));
    try {
        const dataDirectory = resolve(temporaryDirectory, "data");
        const socketDirectory = resolve(temporaryDirectory, "socket");
        const logPath = resolve(temporaryDirectory, "postgres.log");
        const passwordPath = resolve(temporaryDirectory, "pwfile");
        const port = await getFreePort("127.0.0.1");
        // LC_ALL/LANG are pinned to C for the whole local cluster. Without it,
        // macOS resolves an unset or non-POSIX locale through Core Foundation,
        // which spawns threads inside the postmaster before it forks — Postgres
        // then refuses to start with "postmaster became multithreaded during
        // startup". The Docker path never sees this, so the local fallback that
        // exists precisely for machines without Docker failed 100% of the time
        // on macOS. initdb already runs --no-locale, so pinning C changes no
        // collation behaviour; it only keeps the runtime single-threaded.
        const localEnv = { ...process.env, PGPASSWORD: password, ...localeEnv };
        mkdirSync(socketDirectory, { mode: 0o700 });
        writeFileSync(passwordPath, `${password}\n`, { mode: 0o600 });

        function psqlFile(path, commands = [], options = {}) {
            return run(postgresBinary(postgresBin, "psql"), [
                "-h", "127.0.0.1",
                "-p", String(port),
                "-U", migrationOwner,
                "-d", localDatabase,
                "-v", "ON_ERROR_STOP=1",
                "-v", `kakao_dblink_password=${password}`,
                ...(options.variables ?? []).flatMap(variable => ["-v", variable]),
                ...commands.flatMap(command => ["-c", command]),
                "-f", resolve(root, path),
            ], {
                allowFailure: options.allowFailure === true,
                capture: options.capture === true,
                env: localEnv,
                timeout: liveSqlTimeoutMs,
                ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
            });
        }

        function psqlQuery(sql) {
            return run(postgresBinary(postgresBin, "psql"), [
                "-h", "127.0.0.1",
                "-p", String(port),
                "-U", migrationOwner,
                "-d", localDatabase,
                "-v", "ON_ERROR_STOP=1",
                "-At", "-c", sql,
            ], { capture: true, env: localEnv, timeout: liveSqlTimeoutMs }).stdout;
        }

        async function startWriterBlocker() {
            return await startCanonicalEvidenceWriterBlocker(
                postgresBinary(postgresBin, "psql"),
                [
                    "-h", "127.0.0.1",
                    "-p", String(port),
                    "-U", migrationOwner,
                    "-d", localDatabase,
                    "-v", "ON_ERROR_STOP=1",
                    ...canonicalEvidenceWriterBlockerCommands.flatMap(command => ["-c", command]),
                ],
                {
                    env: {
                        ...localEnv,
                        PGAPPNAME: canonicalEvidenceWriterApplicationName,
                    },
                },
            );
        }

        function verifyKakaoQuarantineBackupRoundtrip() {
            if (!CANONICAL_TABLES.includes("omr_kakao_reminder_legacy_quarantine")) {
                throw new Error("Kakao quarantine is absent from the canonical backup allowlist");
            }
            const dumpPath = resolve(temporaryDirectory, "omr-kakao-quarantine.sql");
            const exactRowsSql = `
select coalesce(
           jsonb_agg(to_jsonb(evidence) order by source_table, source_id),
           '[]'::jsonb
       )::text
  from public.omr_kakao_reminder_legacy_quarantine evidence
`;
            psqlQuery(`
insert into public.omr_kakao_reminder_legacy_quarantine (
    source_table, source_id, organization_id, row_snapshot, reason, inventoried_at
) values (
    'omr_kakao_candidate_reviews', 'kakao:backup-roundtrip:source',
    'kakao-backup-roundtrip-org',
    '{"schemaVersion":1,"payload":{"opaque":"preserve-exactly"}}'::jsonb,
    'operator forensic retention fixture',
    '2026-08-10T00:00:00.123456Z'::timestamptz
)
on conflict (source_table, source_id) do update set
    organization_id = excluded.organization_id,
    row_snapshot = excluded.row_snapshot,
    reason = excluded.reason,
    inventoried_at = excluded.inventoried_at
            `);
            const before = psqlQuery(exactRowsSql).trim();
            run(postgresBinary(postgresBin, "pg_dump"), [
                "-h", "127.0.0.1", "-p", String(port),
                "-U", migrationOwner, "-d", localDatabase,
                "--data-only", "--no-owner", "--no-privileges",
                "--table=public.omr_kakao_reminder_legacy_quarantine",
                `--file=${dumpPath}`,
            ], { env: localEnv, timeout: 30_000 });
            psqlQuery("delete from public.omr_kakao_reminder_legacy_quarantine");
            run(postgresBinary(postgresBin, "psql"), [
                "-h", "127.0.0.1", "-p", String(port),
                "-U", migrationOwner, "-d", localDatabase,
                "-v", "ON_ERROR_STOP=1", "-f", dumpPath,
            ], { env: localEnv, timeout: 30_000 });
            const after = psqlQuery(exactRowsSql).trim();
            if (after !== before) {
                throw new Error("actual Kakao quarantine pg_dump/restore changed forensic evidence");
            }
            psqlQuery(`
delete from public.omr_kakao_reminder_legacy_quarantine
 where source_table = 'omr_kakao_candidate_reviews'
   and source_id = 'kakao:backup-roundtrip:source'
            `);
        }

        run(postgresBinary(postgresBin, "initdb"), [
            "-D", dataDirectory,
            "-U", migrationOwner,
            "--auth-local=trust",
            "--auth-host=scram-sha-256",
            "--pwfile", passwordPath,
            "--encoding=UTF8",
            "--no-locale",
            "--no-instructions",
        ], { env: localEnv });
        rmSync(passwordPath, { force: true });

        run(postgresBinary(postgresBin, "pg_ctl"), [
            "-D", dataDirectory,
            "-l", logPath,
            "-o", `-h 127.0.0.1 -p ${port} -k ${socketDirectory}`,
            "-w", "start",
        ], { env: localEnv });
        run(postgresBinary(postgresBin, "createdb"), [
            "-h", "127.0.0.1",
            "-p", String(port),
            "-U", migrationOwner,
            localDatabase,
        ], { env: localEnv });

        return await runSqlMatrix(
            psqlFile,
            psqlQuery,
            verifyKakaoQuarantineBackupRoundtrip,
            startWriterBlocker,
        );
    } finally {
        run(postgresBinary(postgresBin, "pg_ctl"), [
            "-D", resolve(temporaryDirectory, "data"),
            "-m", "immediate",
            "-w", "stop",
        ], { capture: true, allowFailure: true, env: { ...process.env, ...localeEnv } });
        rmSync(temporaryDirectory, { recursive: true, force: true });
    }
}

async function main() {
    const requestedBackend = process.env.OMR_SUPABASE_LIVE_BACKEND || "auto";
    if (!["auto", "docker", "local"].includes(requestedBackend)) {
        throw new Error(
            `OMR_SUPABASE_LIVE_BACKEND must be auto, docker, or local; received ${requestedBackend}.`,
        );
    }

    const dockerCheck = requestedBackend === "local"
        ? { status: 1 }
        : run("docker", ["info"], {
            capture: true,
            allowFailure: true,
            timeout: dockerInfoTimeoutMs,
        });
    if (requestedBackend === "docker" && dockerCheck.status !== 0) {
        throw new Error("Docker backend was requested, but the Docker engine is not responsive.");
    }

    let evidence;
    if (dockerCheck.status === 0) {
        console.log("Supabase live verification backend: Docker PostgreSQL 17");
        evidence = await runDockerVerification();
    } else {
        console.log("Supabase live verification backend: ephemeral local PostgreSQL 17");
        evidence = await runLocalVerification();
    }

    const summaryPath = process.env.OMR_LIVE_PG_PROOF_SUMMARY_PATH;
    if (summaryPath) {
        writeFileSync(summaryPath, `${JSON.stringify({ schemaVersion: 1, ...evidence })}\n`, {
            encoding: "utf8",
            mode: 0o600,
            flag: "wx",
        });
    }
    console.log(`Supabase live release proofs verified: ${evidence.proofs.length}`);
}

await main();
