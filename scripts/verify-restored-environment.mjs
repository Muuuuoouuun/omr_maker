import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    chmodSync,
    existsSync,
    lstatSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

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

const PROJECT_REF = /^[a-z0-9][a-z0-9-]{2,62}$/;
const SAFE_DB_HOST = /^[A-Za-z0-9.-]{1,253}$/;
const SAFE_DB_IDENTIFIER = /^[A-Za-z0-9_.-]{1,128}$/;

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

export function resolveRestoredEnvironmentConfig(input) {
    const args = parseArgs(input?.argv ?? []);
    const env = input?.env ?? {};
    if (clean(env.OMR_DEPLOYMENT_TIER) !== "staging") throw new Error("Restore verification requires the staging tier");
    const backupDir = safeAbsolutePath(args.backupDir, input.cwd, "Backup directory", true);
    const outputPath = safeAbsolutePath(args.outputPath, input.cwd, "Restore verification output", false);
    const manifest = readValidatedManifest(backupDir);
    const target = strictSupabaseOrigin(env.OMR_RESTORE_TARGET_SUPABASE_URL, "Restore target Supabase URL");
    const production = strictSupabaseOrigin(env.OMR_PRODUCTION_SUPABASE_URL, "Production Supabase URL");
    if (target.projectRef === production.projectRef) throw new Error("Restore target must not be the production project");
    const confirmedTarget = clean(args.confirmedTargetProjectRef).toLowerCase();
    if (confirmedTarget !== target.projectRef) throw new Error("Confirmed restore target project is missing or invalid");
    const targetIdentity = assertTargetProjectDiffers(manifest.sourceProjectRefHash, target.projectRef);
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
    const config = {
        environment: "staging",
        backupDir,
        outputPath,
        manifest,
        targetSupabaseUrl: target.origin,
        targetProjectRef: target.projectRef,
        targetProjectRefHash: targetIdentity.targetProjectRefHash,
        startedAt,
        rpoMinutes,
        rtoMinutes,
        configuredAt: now.toISOString(),
        postgresBin,
    };
    Object.defineProperties(config, {
        serviceRoleKey: { value: serviceRoleKey, enumerable: false },
        database: { value: database, enumerable: false },
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

async function writeExclusiveJson(path, value) {
    let handle;
    try {
        handle = await open(path, "wx", 0o600);
        await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
        await handle.sync();
    } finally {
        await handle?.close().catch(() => undefined);
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
        targetProjectRefHash: config.targetProjectRefHash,
        sourceProjectRefHash: config.manifest.sourceProjectRefHash,
        backupCreatedAt: config.manifest.createdAt,
        restoreStartedAt: config.startedAt,
        rpoMinutes: config.rpoMinutes,
        rtoMinutes: config.rtoMinutes,
        backupAgeMinutes: (Date.parse(config.startedAt) - Date.parse(config.manifest.createdAt)) / 60_000,
        recoveryMinutes: recoveryMs / 60_000,
        databaseTableCount: CANONICAL_BACKUP_TABLES.length,
        databaseRowCount: Object.values(tableCounts).reduce((sum, count) => sum + count, 0),
        storageObjectCount: objects.length,
    });
    await writeExclusiveJson(config.outputPath, evidence);
    return evidence;
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
