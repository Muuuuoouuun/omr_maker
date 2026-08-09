import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    chmodSync,
    constants,
    existsSync,
    lstatSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { open, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import { createClient } from "@supabase/supabase-js";

import {
    CANONICAL_BACKUP_TABLES,
    REMOTE_ASSET_BUCKET,
    assertTargetProjectDiffers,
    compareRestoredInventory,
    validateBackupManifest,
} from "./backup-restore-core.mjs";
import {
    downloadAndHashStorageObjects,
    listStorageObjectsToFixedPoint,
} from "./storage-backup-gateway.mjs";
import { parseStrictJson } from "./strict-json.mjs";
import {
    createExternalRestoredSmokeDependencies,
    runRestoredEnvironmentSmoke,
} from "./run-restored-environment-smoke.mjs";

const PROJECT_REF = /^[a-z0-9][a-z0-9-]{2,62}$/;
const SAFE_DB_HOST = /^[A-Za-z0-9.-]{1,253}$/;
const SAFE_DB_IDENTIFIER = /^[A-Za-z0-9_.-]{1,128}$/;
const BUILD_SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const VERIFIER_SOURCE_PATHS = Object.freeze([
    "scripts/verify-restored-environment.mjs",
    "scripts/run-restored-environment-smoke.mjs",
    "scripts/backup-restore-core.mjs",
    "scripts/storage-backup-gateway.mjs",
    "scripts/strict-json.mjs",
    "supabase/production-server-boundary.sql",
]);

function clean(value) {
    return typeof value === "string" ? value.trim() : "";
}

function setOnce(target, key, value) {
    if (Object.hasOwn(target, key)) throw new Error(`Duplicate restore verification argument: ${key}`);
    target[key] = value;
}

function parseArgs(argv) {
    if (!Array.isArray(argv)) throw new Error("Restore verification arguments are invalid");
    const parsed = {};
    let verify = false;
    for (const argument of argv) {
        if (argument === "--verify") {
            if (verify) throw new Error("Duplicate restore verification argument: verify");
            verify = true;
        } else if (argument.startsWith("--backup=")) {
            setOnce(parsed, "backupDir", argument.slice("--backup=".length));
        } else if (argument.startsWith("--output=")) {
            setOnce(parsed, "outputPath", argument.slice("--output=".length));
        } else if (argument.startsWith("--confirm-target-project-ref=")) {
            setOnce(parsed, "confirmedTargetProjectRef", argument.slice("--confirm-target-project-ref=".length));
        } else if (argument.startsWith("--started-at=")) {
            setOnce(parsed, "startedAt", argument.slice("--started-at=".length));
        } else if (argument.startsWith("--rpo-minutes=")) {
            setOnce(parsed, "rpoMinutes", argument.slice("--rpo-minutes=".length));
        } else if (argument.startsWith("--rto-minutes=")) {
            setOnce(parsed, "rtoMinutes", argument.slice("--rto-minutes=".length));
        } else {
            throw new Error(`Unknown restore verification argument: ${String(argument).slice(0, 48)}`);
        }
    }
    if (!verify) throw new Error("Restore verification mode must be explicit");
    return parsed;
}

function strictSupabaseOrigin(value, label) {
    let url;
    try {
        url = new URL(clean(value));
    } catch {
        throw new Error(`${label} is missing or invalid`);
    }
    const match = /^([a-z0-9-]+)\.supabase\.co$/.exec(url.hostname.toLowerCase());
    if (
        url.protocol !== "https:"
        || url.username
        || url.password
        || url.port
        || url.pathname !== "/"
        || url.search
        || url.hash
        || !match
        || !PROJECT_REF.test(match[1])
    ) throw new Error(`${label} is missing or invalid`);
    return { origin: url.origin, projectRef: match[1] };
}

function strictHttpsOrigin(value, label) {
    let url;
    try {
        url = new URL(clean(value));
    } catch {
        throw new Error(`${label} is missing or invalid`);
    }
    if (
        url.protocol !== "https:"
        || url.username
        || url.password
        || url.port
        || url.pathname !== "/"
        || url.search
        || url.hash
    ) throw new Error(`${label} is missing or invalid`);
    return { origin: url.origin, hostname: url.hostname.toLowerCase() };
}

function bindingDigest(domain, values) {
    return createHash("sha256")
        .update(`omr.restore.${domain}:v1\n`, "utf8")
        .update(values.join("\n"), "utf8")
        .digest("hex");
}

function safeAbsolutePath(value, cwd, label, allowDirectory) {
    const raw = clean(value);
    if (!isAbsolute(raw)) throw new Error(`${label} is missing or invalid`);
    const path = resolve(raw);
    const root = parse(path).root;
    const repository = resolve(cwd);
    const repositoryRelative = relative(repository, path);
    if (
        path === root
        || path === repository
        || (!repositoryRelative.startsWith(`..${sep}`) && repositoryRelative !== ".." && !isAbsolute(repositoryRelative))
    ) throw new Error(`${label} must be outside the repository`);
    if (allowDirectory) {
        let info;
        try {
            info = lstatSync(path);
        } catch {
            throw new Error(`${label} is missing or invalid`);
        }
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} is missing or invalid`);
    }
    return path;
}

function resolveSecureOutputParent(outputPath) {
    const path = dirname(outputPath);
    let info;
    try {
        info = lstatSync(path);
        if (
            !info.isDirectory()
            || info.isSymbolicLink()
            || (info.mode & 0o777) !== 0o700
            || (typeof process.getuid === "function" && info.uid !== process.getuid())
        ) throw new Error("invalid");
    } catch {
        throw new Error("Restore verification output parent is missing or unsafe");
    }
    return Object.freeze({
        path,
        realpath: realpathSync(path),
        dev: info.dev,
        ino: info.ino,
        uid: info.uid,
        mode: info.mode & 0o777,
    });
}

function assertSecureOutputParent(identity) {
    let current;
    try {
        current = lstatSync(identity.path);
        if (
            !current.isDirectory()
            || current.isSymbolicLink()
            || current.dev !== identity.dev
            || current.ino !== identity.ino
            || current.uid !== identity.uid
            || (current.mode & 0o777) !== identity.mode
            || realpathSync(identity.path) !== identity.realpath
        ) throw new Error("invalid");
    } catch {
        throw new Error("Restore verification output parent changed or is unsafe");
    }
}

function canonicalIso(value, label) {
    const text = clean(value);
    if (!text || Number.isNaN(Date.parse(text)) || new Date(text).toISOString() !== text) {
        throw new Error(`${label} is missing or invalid`);
    }
    return text;
}

function boundedMinutes(value, label) {
    if (!/^[1-9]\d*$/.test(clean(value))) throw new Error(`${label} is missing or invalid`);
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 7 * 24 * 60) {
        throw new Error(`${label} is missing or invalid`);
    }
    return parsed;
}

function strongSecret(value, label, minimum = 8) {
    const secret = clean(value);
    if (Buffer.byteLength(secret, "utf8") < minimum || Buffer.byteLength(secret, "utf8") > 4096 || /[\r\n\u0000]/.test(secret)) {
        throw new Error(`${label} is missing or invalid`);
    }
    return secret;
}

function readValidatedManifest(backupDir) {
    const completionPath = join(backupDir, ".COMPLETE");
    let completion;
    try {
        completion = lstatSync(completionPath);
    } catch {
        completion = null;
    }
    if (!completion?.isFile() || completion.isSymbolicLink() || existsSync(join(backupDir, ".INCOMPLETE"))) {
        throw new Error("Backup completion marker is missing or invalid");
    }
    const manifestPath = join(backupDir, "manifest.json");
    let raw;
    try {
        const info = lstatSync(manifestPath);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024 * 1024) throw new Error("invalid");
        raw = readFileSync(manifestPath, "utf8");
    } catch {
        throw new Error("Backup manifest is missing or invalid");
    }
    let value;
    try {
        value = parseStrictJson(raw);
    } catch {
        throw new Error("Backup manifest is missing or invalid");
    }
    const manifest = validateBackupManifest(value);
    for (const artifact of Object.values(manifest.database).filter(item => item && typeof item === "object" && "file" in item)) {
        const path = join(backupDir, "database", artifact.file);
        let bytes;
        try {
            const info = lstatSync(path);
            if (!info.isFile() || info.isSymbolicLink() || info.size !== artifact.bytes) throw new Error("invalid");
            bytes = readFileSync(path);
        } catch {
            throw new Error("Backup database artifact is missing or invalid");
        }
        if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) {
            throw new Error("Backup database artifact hash mismatch");
        }
    }
    return manifest;
}

function resolveDatabaseIdentity(env, projectRef) {
    const host = clean(env.OMR_RESTORE_TARGET_DB_HOST).toLowerCase();
    const portText = clean(env.OMR_RESTORE_TARGET_DB_PORT);
    const user = clean(env.OMR_RESTORE_TARGET_DB_USER);
    const name = clean(env.OMR_RESTORE_TARGET_DB_NAME);
    if (!SAFE_DB_HOST.test(host) || !/^\d{1,5}$/.test(portText) || !SAFE_DB_IDENTIFIER.test(user) || !SAFE_DB_IDENTIFIER.test(name)) {
        throw new Error("Restore target database identity is missing or invalid");
    }
    const port = Number(portText);
    if (port < 1 || port > 65535) throw new Error("Restore target database port is invalid");
    const direct = host === `db.${projectRef}.supabase.co` && user === "postgres";
    const pooler = host.endsWith(".pooler.supabase.com") && user === `postgres.${projectRef}`;
    if (!direct && !pooler) throw new Error("Restore target database project identity is invalid");
    return Object.freeze({
        host,
        port,
        user,
        name,
        password: strongSecret(env.OMR_RESTORE_TARGET_DB_PASSWORD, "Restore target database password"),
    });
}

function resolveOptionalSmokeRunner(env) {
    const path = clean(env.OMR_RESTORE_SMOKE_RUNNER);
    const expectedSha256 = clean(env.OMR_RESTORE_SMOKE_RUNNER_SHA256);
    if (!path && !expectedSha256) return { path: "", sha256: "unconfigured" };
    if (!isAbsolute(path) || resolve(path) !== path || !SHA256.test(expectedSha256)) {
        throw new Error("Restore smoke runner identity is missing or invalid");
    }
    let bytes;
    try {
        const info = lstatSync(path);
        if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 4 * 1024 * 1024) throw new Error("invalid");
        bytes = readFileSync(path);
    } catch {
        throw new Error("Restore smoke runner identity is missing or invalid");
    }
    if (createHash("sha256").update(bytes).digest("hex") !== expectedSha256) {
        throw new Error("Restore smoke runner identity is missing or invalid");
    }
    return { path, sha256: expectedSha256 };
}

function verifyCheckoutAtBuild(cwd, buildSha) {
    let head;
    try {
        head = clean(execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
            cwd,
            encoding: "utf8",
            env: { PATH: process.env.PATH ?? "", LC_ALL: "C", LANG: "C" },
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 10_000,
            maxBuffer: 4_096,
        }));
    } catch {
        throw new Error("Restore verifier checkout is missing or invalid");
    }
    if (head !== buildSha) throw new Error("Restore verifier checkout does not match the restored build");
    const digest = createHash("sha256").update("omr.restore.verifier-sources:v1\n", "utf8");
    for (const relativePath of VERIFIER_SOURCE_PATHS) {
        let current;
        let committed;
        try {
            const path = resolve(cwd, relativePath);
            const info = lstatSync(path);
            if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 8 * 1024 * 1024) {
                throw new Error("invalid");
            }
            current = readFileSync(path);
            committed = execFileSync("git", ["show", `${buildSha}:${relativePath}`], {
                cwd,
                encoding: null,
                env: { PATH: process.env.PATH ?? "", LC_ALL: "C", LANG: "C" },
                stdio: ["ignore", "pipe", "ignore"],
                timeout: 10_000,
                maxBuffer: 8 * 1024 * 1024,
            });
        } catch {
            throw new Error("Restore verifier source is missing or invalid");
        }
        if (!Buffer.isBuffer(committed) || !current.equals(committed)) {
            throw new Error("Restore verifier source does not match the restored build");
        }
        digest.update(`${relativePath}\n${current.byteLength}\n`, "utf8").update(current);
    }
    return { buildSha: head, sourceSha256: digest.digest("hex") };
}

function resolveVerifierIdentity(input, buildSha) {
    let identity;
    try {
        const verifyCheckout = input.verifyCheckout ?? verifyCheckoutAtBuild;
        if (typeof verifyCheckout !== "function") throw new Error("invalid");
        identity = verifyCheckout(input.cwd, buildSha);
    } catch {
        throw new Error("Restore verifier checkout or source is missing or invalid");
    }
    if (
        !identity
        || typeof identity !== "object"
        || Array.isArray(identity)
        || Object.keys(identity).length !== 2
        || identity.buildSha !== buildSha
        || !SHA256.test(identity.sourceSha256)
    ) throw new Error("Restore verifier checkout or source is missing or invalid");
    return { buildSha, sourceSha256: identity.sourceSha256 };
}

export function resolveRestoredEnvironmentConfig(input) {
    const args = parseArgs(input?.argv ?? []);
    const env = input?.env ?? {};
    if (clean(env.OMR_DEPLOYMENT_TIER) !== "staging") throw new Error("Restore verification requires the staging tier");
    const backupDir = safeAbsolutePath(args.backupDir, input.cwd, "Backup directory", true);
    const outputPath = safeAbsolutePath(args.outputPath, input.cwd, "Restore verification output", false);
    const outputParentIdentity = resolveSecureOutputParent(outputPath);
    const manifest = readValidatedManifest(backupDir);
    const target = strictSupabaseOrigin(env.OMR_RESTORE_TARGET_SUPABASE_URL, "Restore target Supabase URL");
    const app = strictHttpsOrigin(env.OMR_RESTORE_TARGET_APP_URL, "Restore target app URL");
    const production = strictSupabaseOrigin(env.OMR_PRODUCTION_SUPABASE_URL, "Production Supabase URL");
    if (target.projectRef === production.projectRef) throw new Error("Restore target must not be the production project");
    const confirmedTarget = clean(args.confirmedTargetProjectRef).toLowerCase();
    if (confirmedTarget !== target.projectRef) throw new Error("Confirmed restore target project is missing or invalid");
    const targetIdentity = assertTargetProjectDiffers(manifest.sourceProjectRefHash, target.projectRef);
    const buildSha = clean(env.OMR_RESTORE_EXPECTED_BUILD);
    if (!BUILD_SHA.test(buildSha) || buildSha !== manifest.gitCommit) {
        throw new Error("Restore target build is missing or invalid");
    }
    const verifierIdentity = resolveVerifierIdentity(input, buildSha);
    const startedAt = canonicalIso(args.startedAt, "Restore start time");
    const rpoMinutes = boundedMinutes(args.rpoMinutes, "RPO minutes");
    const rtoMinutes = boundedMinutes(args.rtoMinutes, "RTO minutes");
    const now = input.now instanceof Date ? input.now : new Date();
    if (Number.isNaN(now.getTime())) throw new Error("Restore verification time is invalid");
    const backupAgeMs = Date.parse(startedAt) - Date.parse(manifest.createdAt);
    const recoveryMs = now.getTime() - Date.parse(startedAt);
    if (backupAgeMs < 0 || backupAgeMs > rpoMinutes * 60_000) throw new Error("Restore exceeds the declared RPO");
    if (recoveryMs < 0 || recoveryMs > rtoMinutes * 60_000) throw new Error("Restore exceeds the declared RTO");
    const postgresBin = clean(env.OMR_POSTGRES_BIN);
    if (!isAbsolute(postgresBin) || resolve(postgresBin) !== postgresBin) {
        throw new Error("PostgreSQL 17 binary directory is missing or invalid");
    }
    const serviceRoleKey = strongSecret(env.OMR_RESTORE_TARGET_SERVICE_ROLE_KEY, "Restore target service role key", 32);
    const database = resolveDatabaseIdentity(env, target.projectRef);
    const smokeRunner = resolveOptionalSmokeRunner(env);
    const targetAppDigest = bindingDigest("target-app", [app.origin]);
    const targetSupabaseDigest = bindingDigest("target-supabase", [target.origin, target.projectRef]);
    const targetDigest = bindingDigest("target", [targetAppDigest, targetSupabaseDigest]);
    const environmentDigest = bindingDigest("environment", [
        "staging",
        buildSha,
        targetDigest,
        database.host,
        String(database.port),
        database.user,
        database.name,
        smokeRunner.sha256,
        verifierIdentity.sourceSha256,
    ]);
    const config = {
        environment: "staging",
        backupDir,
        outputPath,
        manifest,
        targetSupabaseUrl: target.origin,
        targetAppUrl: app.origin,
        targetProjectRef: target.projectRef,
        targetProjectRefHash: targetIdentity.targetProjectRefHash,
        buildSha,
        targetAppDigest,
        targetSupabaseDigest,
        targetDigest,
        environmentDigest,
        verifierSourceSha256: verifierIdentity.sourceSha256,
        startedAt,
        rpoMinutes,
        rtoMinutes,
        configuredAt: now.toISOString(),
        postgresBin,
    };
    Object.defineProperties(config, {
        serviceRoleKey: { value: serviceRoleKey, enumerable: false },
        database: { value: database, enumerable: false },
        outputParentIdentity: { value: outputParentIdentity, enumerable: false },
        smokeRunnerPath: { value: smokeRunner.path, enumerable: false },
        smokeRunnerSha256: { value: smokeRunner.sha256, enumerable: false },
        smokeRunnerEnv: {
            value: Object.freeze({
                LC_ALL: "C",
                LANG: "C",
                PATH: process.env.PATH ?? "",
                OMR_DEPLOYMENT_TIER: "staging",
                OMR_RESTORE_TARGET_APP_URL: app.origin,
                OMR_RESTORE_TARGET_SUPABASE_URL: target.origin,
                OMR_RESTORE_TARGET_SERVICE_ROLE_KEY: serviceRoleKey,
                OMR_RESTORE_EXPECTED_BUILD: buildSha,
                OMR_RESTORE_ENVIRONMENT_DIGEST: environmentDigest,
                OMR_RESTORE_TARGET_DIGEST: targetDigest,
                OMR_RESTORE_VERIFIER_SOURCE_SHA256: verifierIdentity.sourceSha256,
            }),
            enumerable: false,
        },
    });
    return Object.freeze(config);
}

export function buildRestoredTableCountSql() {
    const entries = CANONICAL_BACKUP_TABLES.flatMap(table => [
        `'${table}'`,
        `(select pg_catalog.count(*) from public.${table})`,
    ]);
    return `select pg_catalog.jsonb_build_object(${entries.join(",")})::text;`;
}

export function assertPostgres17Version(output) {
    const major = typeof output === "string"
        ? Number(/PostgreSQL\)\s+(\d+)\./.exec(output)?.[1])
        : Number.NaN;
    if (major !== 17) throw new Error("PostgreSQL 17 restore verification tools are required");
    return major;
}

function escapePgPass(value) {
    return String(value).replaceAll("\\", "\\\\").replaceAll(":", "\\:");
}

async function collectTableCountsWithPsql(config) {
    const credentialDir = mkdtempSync(join(tmpdir(), "omr-restore-pg-"));
    chmodSync(credentialDir, 0o700);
    const passFile = join(credentialDir, "pgpass");
    try {
        const db = config.database;
        let version;
        try {
            version = execFileSync(join(config.postgresBin, "psql"), ["--version"], {
                encoding: "utf8",
                env: { LC_ALL: "C", LANG: "C" },
                stdio: ["ignore", "pipe", "ignore"],
                timeout: 10_000,
                maxBuffer: 4_096,
            });
        } catch {
            throw new Error("PostgreSQL 17 restore verification tools are required");
        }
        assertPostgres17Version(version);
        writeFileSync(passFile, `${[db.host, db.port, db.name, db.user, db.password].map(escapePgPass).join(":")}\n`, {
            mode: 0o600,
            flag: "wx",
        });
        const stdout = execFileSync(join(config.postgresBin, "psql"), [
            "-X",
            "--no-psqlrc",
            "--no-password",
            "--set=ON_ERROR_STOP=1",
            "--tuples-only",
            "--no-align",
            "--host", db.host,
            "--port", String(db.port),
            "--username", db.user,
            "--dbname", db.name,
            "--command", buildRestoredTableCountSql(),
        ], {
            encoding: "utf8",
            env: {
                LC_ALL: "C",
                LANG: "C",
                PGAPPNAME: "omr-restore-verifier",
                PGCONNECT_TIMEOUT: "10",
                PGPASSFILE: passFile,
                PGSSLMODE: "verify-full",
                PGSSLROOTCERT: "system",
            },
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 60_000,
            maxBuffer: 2 * 1024 * 1024,
        }).trim();
        const parsed = parseStrictJson(stdout);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
        return parsed;
    } catch {
        throw new Error("Restored database inventory collection failed");
    } finally {
        rmSync(credentialDir, { recursive: true, force: true });
    }
}

async function collectStorageObjectsWithBodies(config) {
    const client = createClient(config.targetSupabaseUrl, config.serviceRoleKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { headers: { "x-omr-client": "restore-verifier" } },
    });
    const temporary = mkdtempSync(join(tmpdir(), "omr-restore-storage-"));
    try {
        const listed = await listStorageObjectsToFixedPoint(client, REMOTE_ASSET_BUCKET);
        const downloaded = await downloadAndHashStorageObjects(
            client,
            REMOTE_ASSET_BUCKET,
            listed,
            join(temporary, "objects"),
        );
        return downloaded.objects;
    } finally {
        rmSync(temporary, { recursive: true, force: true });
    }
}

function verifyBoundarySourceAtBuild(config) {
    const relativePath = "supabase/production-server-boundary.sql";
    const currentPath = resolve(import.meta.dirname, "..", relativePath);
    let current;
    let committed;
    try {
        current = readFileSync(currentPath);
        committed = execFileSync("git", ["show", `${config.buildSha}:${relativePath}`], {
            cwd: resolve(import.meta.dirname, ".."),
            encoding: null,
            env: { PATH: process.env.PATH ?? "", LC_ALL: "C", LANG: "C" },
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 10_000,
            maxBuffer: 4 * 1024 * 1024,
        });
    } catch {
        throw new Error("Restored production boundary was not verified");
    }
    if (!Buffer.isBuffer(committed) || !current.equals(committed)) {
        throw new Error("Restored production boundary was not verified");
    }
    return {
        bytes: current,
        sha256: createHash("sha256").update(current).digest("hex"),
    };
}

async function runBoundaryContractWithPsql(config) {
    const boundary = verifyBoundarySourceAtBuild(config);
    const credentialDir = mkdtempSync(join(tmpdir(), "omr-restore-boundary-pg-"));
    chmodSync(credentialDir, 0o700);
    const passFile = join(credentialDir, "pgpass");
    try {
        const db = config.database;
        const version = execFileSync(join(config.postgresBin, "psql"), ["--version"], {
            encoding: "utf8",
            env: { LC_ALL: "C", LANG: "C" },
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 10_000,
            maxBuffer: 4_096,
        });
        assertPostgres17Version(version);
        writeFileSync(passFile, `${[db.host, db.port, db.name, db.user, db.password].map(escapePgPass).join(":")}\n`, {
            mode: 0o600,
            flag: "wx",
        });
        execFileSync(join(config.postgresBin, "psql"), [
            "-X",
            "--no-psqlrc",
            "--no-password",
            "--set=ON_ERROR_STOP=1",
            "--host", db.host,
            "--port", String(db.port),
            "--username", db.user,
            "--dbname", db.name,
        ], {
            encoding: "utf8",
            input: boundary.bytes,
            env: {
                LC_ALL: "C",
                LANG: "C",
                PGAPPNAME: "omr-restore-boundary-verifier",
                PGCONNECT_TIMEOUT: "10",
                PGPASSFILE: passFile,
                PGSSLMODE: "verify-full",
                PGSSLROOTCERT: "system",
            },
            stdio: ["pipe", "ignore", "ignore"],
            timeout: 120_000,
            maxBuffer: 4_096,
        });
        const verifiedAt = new Date().toISOString();
        return {
            status: "passed",
            buildSha: config.buildSha,
            environmentDigest: config.environmentDigest,
            targetDigest: config.targetDigest,
            verifiedAt,
            artifactSha256: bindingDigest("boundary-artifact", [
                config.buildSha,
                config.environmentDigest,
                config.targetDigest,
                boundary.sha256,
                "exit:0",
            ]),
        };
    } catch {
        throw new Error("Restored production boundary was not verified");
    } finally {
        rmSync(credentialDir, { recursive: true, force: true });
    }
}

async function runBrowserSmokeWithExternalRunner(config) {
    return runRestoredEnvironmentSmoke({
        buildSha: config.buildSha,
        environmentDigest: config.environmentDigest,
        targetDigest: config.targetDigest,
    }, createExternalRestoredSmokeDependencies(config));
}

async function writeExclusiveJson(path, value) {
    const handle = await openExclusiveJson(path, value);
    await handle.close();
}

async function openExclusiveJson(path, value, flags = "wx") {
    let handle;
    try {
        handle = await open(path, flags, 0o600);
        await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
        await handle.sync();
        return handle;
    } catch (error) {
        await handle?.close().catch(() => undefined);
        throw error;
    }
}

async function syncParent(path) {
    let handle;
    try {
        handle = await open(dirname(path), "r");
        await handle.sync();
    } finally {
        await handle?.close().catch(() => undefined);
    }
}

function exactDataObject(value, requiredKeys, optionalKeys = []) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Restored environment qualification was not verified");
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const allowed = new Set([...requiredKeys, ...optionalKeys]);
    const actual = Object.keys(descriptors);
    if (
        requiredKeys.some(key => !Object.hasOwn(descriptors, key))
        || actual.some(key => !allowed.has(key))
        || Object.values(descriptors).some(descriptor => !("value" in descriptor))
    ) throw new Error("Restored environment qualification was not verified");
    return value;
}

function canonicalResultTime(value) {
    if (
        typeof value !== "string"
        || Number.isNaN(Date.parse(value))
        || new Date(value).toISOString() !== value
    ) throw new Error("Restored environment qualification was not verified");
    return value;
}

function validateBoundRunnerResult(value, config, kind) {
    const isSmoke = kind === "smoke";
    const required = [
        "status",
        "buildSha",
        "environmentDigest",
        "targetDigest",
        "verifiedAt",
        "artifactSha256",
        ...(isSmoke ? ["disposableCredentialsRevoked"] : []),
    ];
    const optional = isSmoke
        ? ["browserSmoke", "actorDigests", "journeyStartedAt", "journeyCompletedAt"]
        : [];
    exactDataObject(value, required, optional);
    if (
        value.status !== "passed"
        || value.buildSha !== config.buildSha
        || value.environmentDigest !== config.environmentDigest
        || value.targetDigest !== config.targetDigest
        || !SHA256.test(value.artifactSha256)
        || (isSmoke && value.disposableCredentialsRevoked !== true)
        || (Object.hasOwn(value, "browserSmoke") && value.browserSmoke !== "passed")
    ) throw new Error("Restored environment qualification was not verified");
    canonicalResultTime(value.verifiedAt);
    if (Object.hasOwn(value, "actorDigests")) {
        if (
            !Array.isArray(value.actorDigests)
            || value.actorDigests.length !== 3
            || value.actorDigests.some(digest => !SHA256.test(digest))
            || new Set(value.actorDigests).size !== 3
        ) throw new Error("Restored environment qualification was not verified");
    }
    for (const key of ["journeyStartedAt", "journeyCompletedAt"]) {
        if (Object.hasOwn(value, key)) canonicalResultTime(value[key]);
    }
    return value;
}

async function removeIfPresent(path) {
    try {
        rmSync(path);
    } catch (error) {
        if (error?.code !== "ENOENT") throw error;
    }
}

async function publishCompletionAtomically(input) {
    const pendingPath = `${input.completeMarkerPath}.pending`;
    let finalPublished = false;
    let markerHandle;
    try {
        markerHandle = await openExclusiveJson(pendingPath, input.marker, "wx+");
        await syncParent(pendingPath);
        await rename(pendingPath, input.incompleteMarkerPath);
        await syncParent(input.incompleteMarkerPath);
        await rename(input.incompleteMarkerPath, input.completeMarkerPath);
        finalPublished = true;
        await syncParent(input.completeMarkerPath);
        const finalInfo = lstatSync(input.completeMarkerPath);
        if (
            !finalInfo.isFile()
            || finalInfo.isSymbolicLink()
            || (finalInfo.mode & 0o777) !== 0o600
            || existsSync(input.incompleteMarkerPath)
        ) throw new Error("invalid publication");
        return markerHandle;
    } catch {
        await invalidateOwnedHandle(markerHandle);
        await removeIfPresent(pendingPath).catch(() => undefined);
        if (finalPublished || existsSync(input.completeMarkerPath)) {
            if (!existsSync(input.incompleteMarkerPath)) {
                await rename(input.completeMarkerPath, input.incompleteMarkerPath).catch(() => undefined);
            } else {
                await removeIfPresent(input.completeMarkerPath).catch(() => undefined);
            }
        }
        throw new Error("Restore completion publication was not verified");
    }
}

async function invalidateOwnedHandle(handle) {
    if (!handle) return;
    try {
        await handle.truncate(0);
        await handle.sync();
    } catch {
        // The public path cleanup below remains fail-closed even if the
        // filesystem refuses inode invalidation.
    } finally {
        await handle.close().catch(() => undefined);
    }
}

async function verifyPublishedCompletion(
    config,
    outputHandle,
    completeMarkerPath,
    incompleteMarkerPath,
    expectedMarker,
    ownedCompletionHandle,
) {
    let completionHandle = ownedCompletionHandle;
    try {
        const beforeOpenInfo = lstatSync(completeMarkerPath);
        if (!beforeOpenInfo.isFile() || beforeOpenInfo.isSymbolicLink()) throw new Error("invalid publication");
        completionHandle ??= await open(completeMarkerPath, constants.O_RDWR | constants.O_NOFOLLOW);
        const [outputInfo, outputPathInfo, completeInfo, completePathInfo] = await Promise.all([
            outputHandle.stat(),
            Promise.resolve().then(() => lstatSync(config.outputPath)),
            completionHandle.stat(),
            Promise.resolve().then(() => lstatSync(completeMarkerPath)),
        ]);
        if (
            !outputPathInfo.isFile()
            || outputPathInfo.isSymbolicLink()
            || outputPathInfo.dev !== outputInfo.dev
            || outputPathInfo.ino !== outputInfo.ino
            || !completeInfo.isFile()
            || !completePathInfo.isFile()
            || completePathInfo.isSymbolicLink()
            || completePathInfo.dev !== completeInfo.dev
            || completePathInfo.ino !== completeInfo.ino
            || (completeInfo.mode & 0o777) !== 0o600
            || completeInfo.size < 2
            || completeInfo.size > 8 * 1024
            || existsSync(incompleteMarkerPath)
        ) throw new Error("invalid publication");
        const bytes = Buffer.alloc(completeInfo.size);
        const read = await completionHandle.read(bytes, 0, bytes.length, 0);
        if (read.bytesRead !== bytes.length) throw new Error("invalid publication");
        const raw = bytes.toString("utf8");
        const parsed = parseStrictJson(raw);
        exactDataObject(parsed, [
            "status",
            "buildSha",
            "environmentDigest",
            "targetDigest",
            "verifierSourceSha256",
            "evidenceSha256",
            "verifiedAt",
        ]);
        if (JSON.stringify(parsed) !== JSON.stringify(expectedMarker)) throw new Error("invalid publication");
        assertSecureOutputParent(config.outputParentIdentity);
        return completionHandle;
    } catch {
        await invalidateOwnedHandle(completionHandle);
        throw new Error("Restore completion publication was not verified");
    }
}

export async function runRestoredEnvironmentVerification(config, dependencies = {}) {
    const currentTime = dependencies.now ?? (() => new Date());
    const startedVerificationAt = currentTime();
    if (!(startedVerificationAt instanceof Date) || Number.isNaN(startedVerificationAt.getTime())) {
        throw new Error("Restore verification time is invalid");
    }
    const initialRecoveryMs = startedVerificationAt.getTime() - Date.parse(config.startedAt);
    if (initialRecoveryMs < 0 || initialRecoveryMs > config.rtoMinutes * 60_000) {
        throw new Error("Restore exceeds the declared RTO");
    }
    assertSecureOutputParent(config.outputParentIdentity);
    const incompleteMarkerPath = join(dirname(config.outputPath), ".INCOMPLETE");
    const completeMarkerPath = join(dirname(config.outputPath), ".RESTORE_COMPLETE");
    if (existsSync(config.outputPath) || existsSync(completeMarkerPath)) {
        throw new Error("Restore verification output already exists");
    }
    await writeExclusiveJson(incompleteMarkerPath, {
        status: "incomplete",
        buildSha: config.buildSha,
        environmentDigest: config.environmentDigest,
        targetDigest: config.targetDigest,
        verifierSourceSha256: config.verifierSourceSha256,
        startedAt: startedVerificationAt.toISOString(),
    });
    await syncParent(incompleteMarkerPath);
    let outputCreated = false;
    let outputHandle;
    let completionHandle;
    try {
        const collectTableCounts = dependencies.collectTableCounts ?? collectTableCountsWithPsql;
        const collectStorageObjects = dependencies.collectStorageObjects ?? collectStorageObjectsWithBodies;
        const [tableCounts, objects] = await Promise.all([
            collectTableCounts(config),
            collectStorageObjects(config),
        ]);
        const comparison = compareRestoredInventory(
            { tableCounts: config.manifest.database.tableCounts, objects: config.manifest.storage.objects },
            { tableCounts, objects },
        );
        if (!comparison.ok) throw new Error("Restored environment inventory mismatch");
        const runBoundaryContract = dependencies.runBoundaryContract ?? runBoundaryContractWithPsql;
        const runBrowserSmoke = dependencies.runBrowserSmoke ?? runBrowserSmokeWithExternalRunner;
        let boundary;
        let smoke;
        try {
            boundary = validateBoundRunnerResult(await runBoundaryContract(config), config, "boundary");
            smoke = validateBoundRunnerResult(await runBrowserSmoke(config), config, "smoke");
        } catch {
            throw new Error("Restored environment qualification was not verified");
        }
        const completedAt = currentTime();
        if (!(completedAt instanceof Date) || Number.isNaN(completedAt.getTime())) {
            throw new Error("Restore verification time is invalid");
        }
        const recoveryMs = completedAt.getTime() - Date.parse(config.startedAt);
        if (recoveryMs < 0 || recoveryMs > config.rtoMinutes * 60_000) {
            throw new Error("Restore exceeds the declared RTO");
        }
        const evidence = Object.freeze({
            status: "verified",
            verifiedAt: completedAt.toISOString(),
            environment: "staging",
            buildSha: config.buildSha,
            environmentDigest: config.environmentDigest,
            targetDigest: config.targetDigest,
            targetAppDigest: config.targetAppDigest,
            targetSupabaseDigest: config.targetSupabaseDigest,
            sourceProjectDigest: bindingDigest("source-project", [config.manifest.sourceProjectRefHash]),
            verifierSourceSha256: config.verifierSourceSha256,
            backupCreatedAt: config.manifest.createdAt,
            restoreStartedAt: config.startedAt,
            rpoMinutes: config.rpoMinutes,
            rtoMinutes: config.rtoMinutes,
            backupAgeMinutes: (Date.parse(config.startedAt) - Date.parse(config.manifest.createdAt)) / 60_000,
            recoveryMinutes: recoveryMs / 60_000,
            databaseTableCount: CANONICAL_BACKUP_TABLES.length,
            databaseRowCount: Object.values(tableCounts).reduce((sum, count) => sum + count, 0),
            storageObjectCount: objects.length,
            boundaryContract: "passed",
            boundaryArtifactSha256: boundary.artifactSha256,
            browserSmoke: "passed",
            browserSmokeArtifactSha256: smoke.artifactSha256,
            disposableCredentialsRevoked: true,
            completeMarker: ".RESTORE_COMPLETE",
        });
        outputHandle = await openExclusiveJson(config.outputPath, evidence);
        outputCreated = true;
        const evidenceSha256 = createHash("sha256")
            .update(`${JSON.stringify(evidence)}\n`, "utf8")
            .digest("hex");
        const completionMarker = {
            status: "verified",
            buildSha: config.buildSha,
            environmentDigest: config.environmentDigest,
            targetDigest: config.targetDigest,
            verifierSourceSha256: config.verifierSourceSha256,
            evidenceSha256,
            verifiedAt: completedAt.toISOString(),
        };
        const publishCompletion = dependencies.publishCompletion ?? publishCompletionAtomically;
        let publishedCompletionHandle;
        try {
            const published = await publishCompletion({
                incompleteMarkerPath,
                completeMarkerPath,
                marker: completionMarker,
            });
            if (
                published
                && typeof published.stat === "function"
                && typeof published.read === "function"
                && typeof published.truncate === "function"
                && typeof published.close === "function"
            ) publishedCompletionHandle = published;
        } catch {
            throw new Error("Restore completion publication was not verified");
        }
        completionHandle = await verifyPublishedCompletion(
            config,
            outputHandle,
            completeMarkerPath,
            incompleteMarkerPath,
            completionMarker,
            publishedCompletionHandle,
        );
        await completionHandle.close();
        completionHandle = undefined;
        await outputHandle.close();
        outputHandle = undefined;
        return evidence;
    } catch (error) {
        await invalidateOwnedHandle(completionHandle);
        completionHandle = undefined;
        await invalidateOwnedHandle(outputHandle);
        outputHandle = undefined;
        let completeInfo = null;
        try { completeInfo = lstatSync(completeMarkerPath); } catch { /* absent */ }
        if (completeInfo) {
            if (completeInfo.isFile() && !completeInfo.isSymbolicLink() && !existsSync(incompleteMarkerPath)) {
                await rename(completeMarkerPath, incompleteMarkerPath).catch(() => undefined);
            } else {
                await removeIfPresent(completeMarkerPath).catch(() => undefined);
            }
        }
        if (outputCreated) await removeIfPresent(config.outputPath).catch(() => undefined);
        if (!existsSync(incompleteMarkerPath)) {
            await writeExclusiveJson(incompleteMarkerPath, {
                status: "incomplete",
                buildSha: config.buildSha,
                environmentDigest: config.environmentDigest,
                targetDigest: config.targetDigest,
                verifierSourceSha256: config.verifierSourceSha256,
                startedAt: startedVerificationAt.toISOString(),
            }).catch(() => undefined);
        }
        throw error;
    }
}

async function main() {
    const cwd = resolve(import.meta.dirname, "..");
    try {
        const config = resolveRestoredEnvironmentConfig({
            argv: process.argv.slice(2),
            env: process.env,
            cwd,
            now: new Date(),
        });
        const result = await runRestoredEnvironmentVerification(config);
        process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch {
        process.stdout.write(`${JSON.stringify({ status: "unverified", code: "restored_environment_not_verified" })}\n`);
        process.exitCode = 1;
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await main();
}
