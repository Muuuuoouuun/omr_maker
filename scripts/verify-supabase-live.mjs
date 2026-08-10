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
import { spawnSync } from "node:child_process";

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

function runSqlMatrix(psqlFile, psqlQuery, verifyKakaoQuarantineBackupRoundtrip) {
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
        psqlFile(`supabase/migrations/${migration}`);
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
    psqlFile("supabase/canonical-question-result-evidence-assertions.sql");
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

function runDockerVerification() {
    function psqlFile(path, commands = [], options = {}) {
        return run("docker", [
            "exec", container,
            "psql", "-U", migrationOwner, "-d", "postgres",
            "-v", "ON_ERROR_STOP=1",
            "-v", `kakao_dblink_password=${password}`,
            ...(options.variables ?? []).flatMap(variable => ["-v", variable]),
            ...commands.flatMap(command => ["-c", command]),
            "-f", `/workspace/${path}`,
        ], { capture: options.capture === true, timeout: liveSqlTimeoutMs });
    }

    function psqlQuery(sql) {
        return run("docker", [
            "exec", container,
            "psql", "-U", migrationOwner, "-d", "postgres",
            "-v", "ON_ERROR_STOP=1", "-At", "-c", sql,
        ], { capture: true, timeout: liveSqlTimeoutMs }).stdout;
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

        return runSqlMatrix(psqlFile, psqlQuery, verifyKakaoQuarantineBackupRoundtrip);
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
            ], { capture: options.capture === true, env: localEnv, timeout: liveSqlTimeoutMs });
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

        return runSqlMatrix(psqlFile, psqlQuery, verifyKakaoQuarantineBackupRoundtrip);
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
        evidence = runDockerVerification();
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
