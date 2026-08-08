import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
    chmod,
    lstat,
    mkdir,
    mkdtemp,
    open,
    realpath,
    rename,
    rm,
    stat,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { createInterface } from "node:readline";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "@supabase/supabase-js";

import {
    CANONICAL_BACKUP_TABLES,
    REMOTE_ASSET_BUCKET,
    hashProjectRef,
    redactBackupSummary,
    validateBackupManifest,
} from "./backup-restore-core.mjs";
import {
    compareRegistryToStorage,
    downloadAndHashStorageObjects,
    listStorageObjectsToFixedPoint,
    readRemoteAssetRegistry,
} from "./storage-backup-gateway.mjs";

const EXPECTED_READINESS_VERSION = "202608080008";
const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/;
const PROJECT_REF_PATTERN = /^[a-z0-9][a-z0-9-]{2,62}$/;
const SAFE_DB_IDENTIFIER = /^[A-Za-z0-9_.-]{1,128}$/;
const SAFE_DB_HOST = /^[A-Za-z0-9.-]{1,253}$/;
const COMMAND_TIMEOUT_MS = 15 * 60 * 1000;
const COMMAND_KILL_GRACE_MS = 5_000;
const MAX_STDERR_BYTES = 64 * 1024;
const CANONICAL_TABLE_SET = new Set(CANONICAL_BACKUP_TABLES);

function singleValue(target, key, value) {
    if (Object.hasOwn(target, key)) throw new Error(`Duplicate backup argument: ${key}`);
    target[key] = value;
}

export function parseBackupProductionArgs(argv) {
    if (!Array.isArray(argv)) throw new Error("Backup arguments must be an array");
    const parsed = {};
    let create = false;
    let inventory = false;
    for (const argument of argv) {
        if (argument === "--create") {
            if (create) throw new Error("Duplicate backup argument: create");
            create = true;
        } else if (argument === "--inventory-only") {
            if (inventory) throw new Error("Duplicate backup argument: inventory-only");
            inventory = true;
        } else if (argument.startsWith("--output=")) {
            singleValue(parsed, "outputDir", argument.slice("--output=".length));
        } else if (argument.startsWith("--confirm-source-project-ref=")) {
            singleValue(parsed, "confirmedSourceProjectRef", argument.slice("--confirm-source-project-ref=".length));
        } else if (argument.startsWith("--confirm-writes-paused=")) {
            singleValue(parsed, "confirmedWritesPausedRef", argument.slice("--confirm-writes-paused=".length));
        } else if (argument.startsWith("--confirm-asset-gc-paused=")) {
            singleValue(parsed, "confirmedAssetGcPausedRef", argument.slice("--confirm-asset-gc-paused=".length));
        } else {
            throw new Error(`Unknown backup argument: ${String(argument).slice(0, 40)}`);
        }
    }
    if (create === inventory) throw new Error("Select exactly one backup mode");
    return {
        mode: create ? "create" : "inventory",
        ...(parsed.outputDir === undefined ? {} : { outputDir: parsed.outputDir }),
        ...(parsed.confirmedSourceProjectRef === undefined ? {} : { confirmedSourceProjectRef: parsed.confirmedSourceProjectRef }),
        ...(parsed.confirmedWritesPausedRef === undefined ? {} : { confirmedWritesPausedRef: parsed.confirmedWritesPausedRef }),
        ...(parsed.confirmedAssetGcPausedRef === undefined ? {} : { confirmedAssetGcPausedRef: parsed.confirmedAssetGcPausedRef }),
    };
}

function clean(value) {
    return typeof value === "string" ? value.trim() : "";
}

function sourceProjectRefFromUrl(rawUrl) {
    let url;
    try {
        url = new URL(rawUrl);
    } catch {
        throw new Error("Supabase URL is invalid");
    }
    if (
        url.protocol !== "https:"
        || url.username
        || url.password
        || url.port
        || url.pathname !== "/"
        || url.search
        || url.hash
    ) throw new Error("Supabase URL is invalid");
    const match = url.hostname.match(/^(?<ref>[a-z0-9-]+)\.supabase\.co$/i);
    const projectRef = match?.groups?.ref?.toLowerCase() ?? "";
    if (!PROJECT_REF_PATTERN.test(projectRef)) throw new Error("Supabase project ref is invalid");
    return { supabaseUrl: url.href.replace(/\/$/, ""), projectRef };
}

function assertSafeOutputDirectory(outputDir, cwd, homeDir) {
    if (!outputDir || !isAbsolute(outputDir)) throw new Error("Backup output must be an absolute path");
    const output = resolve(outputDir);
    const root = parse(output).root;
    if (output === root || output === resolve(homeDir) || output === resolve(cwd)) {
        throw new Error("Backup output path is too broad");
    }
    const repositoryRelative = relative(resolve(cwd), output);
    if (repositoryRelative === "" || (!repositoryRelative.startsWith(`..${sep}`) && repositoryRelative !== ".." && !isAbsolute(repositoryRelative))) {
        throw new Error("Backup output must be outside the repository");
    }
    return output;
}

function requiredSafeEnv(env, name, pattern) {
    const value = clean(env[name]);
    if (!pattern.test(value) || /[\r\n\u0000]/.test(value)) throw new Error(`${name} is missing or invalid`);
    return value;
}

function resolveDatabaseIdentity(env, projectRef) {
    const host = requiredSafeEnv(env, "SUPABASE_DB_HOST", SAFE_DB_HOST).toLowerCase();
    const portText = requiredSafeEnv(env, "SUPABASE_DB_PORT", /^\d{1,5}$/);
    const port = Number(portText);
    if (port < 1 || port > 65535) throw new Error("SUPABASE_DB_PORT is invalid");
    const user = requiredSafeEnv(env, "SUPABASE_DB_USER", SAFE_DB_IDENTIFIER);
    const databaseName = requiredSafeEnv(env, "SUPABASE_DB_NAME", SAFE_DB_IDENTIFIER);
    const password = typeof env.SUPABASE_DB_PASSWORD === "string" ? env.SUPABASE_DB_PASSWORD : "";
    if (password.length < 8 || /[\r\n\u0000]/.test(password)) throw new Error("SUPABASE_DB_PASSWORD is missing or invalid");

    const directIdentity = host === `db.${projectRef}.supabase.co` && user === "postgres";
    const poolerIdentity = host.endsWith(".pooler.supabase.com") && user === `postgres.${projectRef}`;
    if (!directIdentity && !poolerIdentity) throw new Error("Database project identity does not match the Supabase project");
    return { host, port, user, name: databaseName, password };
}

export function resolveBackupProductionConfig(input) {
    const args = parseBackupProductionArgs(input.argv);
    const env = input.env ?? {};
    const cwd = resolve(input.cwd);
    const homeDir = resolve(input.homeDir);
    const rawUrl = clean(env.SUPABASE_URL) || clean(env.NEXT_PUBLIC_SUPABASE_URL);
    const { supabaseUrl, projectRef } = sourceProjectRefFromUrl(rawUrl);
    const confirmedRef = clean(args.confirmedSourceProjectRef).toLowerCase();
    if (!confirmedRef || confirmedRef !== projectRef) {
        throw new Error("Confirmed source project ref does not match the Supabase URL");
    }
    const serviceRoleKey = clean(env.SUPABASE_SERVICE_ROLE_KEY) || clean(env.OMR_SUPABASE_SERVICE_ROLE_KEY);
    if (serviceRoleKey.length < 32 || /\s/.test(serviceRoleKey)) throw new Error("Supabase service role key is missing or invalid");
    const gitCommit = clean(input.gitCommit).toLowerCase();
    if (!GIT_SHA_PATTERN.test(gitCommit)) throw new Error("A full Git commit SHA is required");

    if (args.mode === "inventory") {
        if (args.outputDir || args.confirmedWritesPausedRef || args.confirmedAssetGcPausedRef) {
            throw new Error("Inventory mode does not accept create-only arguments");
        }
        return {
            mode: "inventory",
            cwd,
            sourceProjectRef: projectRef,
            sourceProjectRefHash: hashProjectRef(projectRef),
            supabaseUrl,
            serviceRoleKey,
            gitCommit,
        };
    }

    if (clean(args.confirmedWritesPausedRef).toLowerCase() !== projectRef) {
        throw new Error("Production writes must be paused and confirmed for the exact source project");
    }
    if (clean(args.confirmedAssetGcPausedRef).toLowerCase() !== projectRef) {
        throw new Error("Asset GC must be paused and confirmed for the exact source project");
    }
    if (input.gitWorktreeClean !== true) throw new Error("Backup creation requires a clean Git worktree");
    const postgresBinDir = clean(env.OMR_POSTGRES_BIN);
    if (!isAbsolute(postgresBinDir) || resolve(postgresBinDir) !== postgresBinDir) {
        throw new Error("OMR_POSTGRES_BIN must be an absolute normalized path");
    }
    return {
        mode: "create",
        cwd,
        outputDir: assertSafeOutputDirectory(args.outputDir, cwd, homeDir),
        sourceProjectRef: projectRef,
        sourceProjectRefHash: hashProjectRef(projectRef),
        supabaseUrl,
        serviceRoleKey,
        database: resolveDatabaseIdentity(env, projectRef),
        postgresBinDir,
        gitCommit,
    };
}

export function buildPostgresDumpCommands(config) {
    if (config.mode !== "create") throw new Error("Dump commands require create mode");
    const databaseDir = join(config.outputDir, "database");
    const common = ["--no-password"];
    return [
        {
            command: join(config.postgresBinDir, "pg_dumpall"),
            args: [...common, "--roles-only", "--no-role-passwords", "--no-tablespaces"],
            outputPath: join(databaseDir, "roles.sql"),
        },
        {
            command: join(config.postgresBinDir, "pg_dump"),
            args: [...common, "--schema-only", "--schema=public", "--no-owner", "--no-privileges", "--quote-all-identifiers"],
            outputPath: join(databaseDir, "schema.sql"),
        },
        {
            command: join(config.postgresBinDir, "pg_dump"),
            args: [
                ...common,
                "--data-only",
                "--no-owner",
                "--no-privileges",
                "--quote-all-identifiers",
                "--strict-names",
                ...CANONICAL_BACKUP_TABLES.map((table) => `--table=public.${table}`),
            ],
            outputPath: join(databaseDir, "data.sql"),
        },
    ];
}

function minimalPostgresEnvironment(serviceFile, passFile) {
    return {
        LC_ALL: "C",
        LANG: "C",
        PGAPPNAME: "omr-production-backup",
        PGCONNECT_TIMEOUT: "10",
        PGPASSFILE: passFile,
        PGSERVICE: "omr_backup",
        PGSERVICEFILE: serviceFile,
    };
}

function escapePgPass(value) {
    return String(value).replaceAll("\\", "\\\\").replaceAll(":", "\\:");
}

async function writeProtectedFile(path, contents) {
    let handle;
    try {
        handle = await open(path, "wx", 0o600);
        await handle.writeFile(contents, "utf8");
        await handle.sync();
    } finally {
        await handle?.close().catch(() => undefined);
    }
}

function installTerminationGuard() {
    let requested = false;
    const onInterrupt = () => { requested = true; };
    const onTerminate = () => { requested = true; };
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onTerminate);
    return {
        throwIfRequested() {
            if (requested) throw new Error("Backup interrupted");
        },
        dispose() {
            process.removeListener("SIGINT", onInterrupt);
            process.removeListener("SIGTERM", onTerminate);
        },
    };
}

async function withPostgresCredentials(config, termination, operation) {
    const prefix = join(tmpdir(), "omr-backup-pg-");
    const directory = await mkdtemp(prefix);
    const normalizedDirectory = resolve(directory);
    if (!normalizedDirectory.startsWith(resolve(tmpdir()) + sep + "omr-backup-pg-")) {
        throw new Error("Private PostgreSQL credential directory is invalid");
    }
    await chmod(directory, 0o700);
    const serviceFile = join(directory, "pg_service.conf");
    const passFile = join(directory, "pgpass");
    const db = config.database;
    let result;
    try {
        termination.throwIfRequested();
        await writeProtectedFile(serviceFile, [
            "[omr_backup]",
            `host=${db.host}`,
            `port=${db.port}`,
            `user=${db.user}`,
            `dbname=${db.name}`,
            "sslmode=verify-full",
            "sslrootcert=system",
            "connect_timeout=10",
            "",
        ].join("\n"));
        termination.throwIfRequested();
        await writeProtectedFile(passFile, `${[db.host, db.port, db.name, db.user, db.password].map(escapePgPass).join(":")}\n`);
        termination.throwIfRequested();
        result = await operation(minimalPostgresEnvironment(serviceFile, passFile));
        termination.throwIfRequested();
    } finally {
        await rm(normalizedDirectory, { recursive: true, force: true });
    }
    termination.throwIfRequested();
    return result;
}

export function runNativeBackupCommand(plan, env, cwd, options = {}) {
    const timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS;
    const killGraceMs = options.killGraceMs ?? COMMAND_KILL_GRACE_MS;
    const maxStderrBytes = options.maxStderrBytes ?? MAX_STDERR_BYTES;
    return new Promise(async (resolveCommand, rejectCommand) => {
        let outputHandle;
        try {
            outputHandle = await open(plan.outputPath, "wx", 0o600);
        } catch {
            rejectCommand(new Error("output"));
            return;
        }
        let child;
        try {
            child = spawn(plan.command, plan.args, {
                cwd,
                env,
                shell: false,
                stdio: ["ignore", outputHandle.fd, "pipe"],
            });
        } catch {
            await outputHandle.close().catch(() => undefined);
            rejectCommand(new Error("spawn"));
            return;
        }
        let commandFailed = false;
        let stderrBytes = 0;
        let forceKillTimer;
        const requestStop = () => {
            commandFailed = true;
            child.kill("SIGTERM");
            if (!forceKillTimer) {
                forceKillTimer = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
            }
        };
        const timeout = setTimeout(() => {
            requestStop();
        }, timeoutMs);
        const stopOnSignal = () => requestStop();
        process.once("SIGINT", stopOnSignal);
        process.once("SIGTERM", stopOnSignal);
        child.stderr?.on("data", (chunk) => {
            stderrBytes += chunk.byteLength;
            if (stderrBytes > maxStderrBytes) {
                requestStop();
            }
        });
        child.once("error", () => { commandFailed = true; });
        child.once("close", async (code, signal) => {
            clearTimeout(timeout);
            clearTimeout(forceKillTimer);
            process.removeListener("SIGINT", stopOnSignal);
            process.removeListener("SIGTERM", stopOnSignal);
            await outputHandle.close().catch(() => { commandFailed = true; });
            if (code === 0 && signal === null && !commandFailed) resolveCommand();
            else rejectCommand(new Error("command"));
        });
    });
}

function defaultVerifyPostgresVersion(config) {
    for (const binary of ["pg_dump", "pg_dumpall"]) {
        let output;
        try {
            output = execFileSync(join(config.postgresBinDir, binary), ["--version"], {
                encoding: "utf8",
                env: { LC_ALL: "C", LANG: "C" },
                stdio: ["ignore", "pipe", "ignore"],
                timeout: 10_000,
                maxBuffer: 4_096,
            });
        } catch {
            throw new Error("PostgreSQL 17 backup tools are unavailable");
        }
        const major = output.match(/PostgreSQL\)\s+(\d+)/)?.[1];
        if (major !== "17") throw new Error("PostgreSQL 17 backup tools are required");
    }
}

async function hashFile(path) {
    const digest = createHash("sha256");
    let bytes = 0;
    for await (const chunk of createReadStream(path)) {
        bytes += chunk.byteLength;
        if (!Number.isSafeInteger(bytes)) throw new Error("Database backup artifact is too large");
        digest.update(chunk);
    }
    if (bytes === 0) throw new Error("Database backup artifact is empty");
    return { bytes, sha256: digest.digest("hex") };
}

async function syncFile(path) {
    let handle;
    try {
        handle = await open(path, "r");
        await handle.sync();
    } finally {
        await handle?.close().catch(() => undefined);
    }
}

function parseCopyIdentifier(raw) {
    if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1).replaceAll('""', '"');
    return raw;
}

async function parseCopyTableCountsFromFile(path) {
    const counts = {};
    let active = null;
    const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
    for await (const line of lines) {
        if (active) {
            if (line === "\\.") {
                if (active.record) counts[active.table] = active.count;
                active = null;
            } else {
                active.count += 1;
            }
            continue;
        }
        if (!line.startsWith("COPY ")) continue;
        const match = line.match(/^COPY\s+(?<schema>"(?:[^"]|"")+"|[a-z_][a-z0-9_]*)\.(?<table>"(?:[^"]|"")+"|[a-z_][a-z0-9_]*)\s+\(.+\)\s+FROM\s+stdin;$/i);
        if (!match?.groups) throw new Error("Database backup contains a malformed COPY block");
        const schema = parseCopyIdentifier(match.groups.schema);
        const table = parseCopyIdentifier(match.groups.table);
        const canonical = schema === "public" && CANONICAL_TABLE_SET.has(table);
        if (!canonical) throw new Error("Database backup contains a non-canonical COPY table");
        if (Object.hasOwn(counts, table)) throw new Error("Database backup contains a duplicate COPY block");
        active = { table, count: 0, record: true };
    }
    if (active) throw new Error("Database backup contains an unterminated COPY block");
    return counts;
}

async function rolesContainPasswords(path) {
    const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
    for await (const line of lines) {
        if (/(?:SCRAM-SHA-256\$|\bmd5[0-9a-f]{32}\b|\bPASSWORD\s+'[^']*')/i.test(line)) return true;
    }
    return false;
}

async function sqlArtifact(path, file, parseData = false) {
    let info;
    try {
        info = await stat(path);
        if (!info.isFile()) throw new Error("not-file");
        await chmod(path, 0o600);
    } catch {
        throw new Error("Database backup artifact is missing");
    }
    const hashed = await hashFile(path);
    if (file === "roles.sql" && await rolesContainPasswords(path)) {
        throw new Error("Database roles backup contains role passwords");
    }
    await syncFile(path);
    return {
        file,
        ...hashed,
        ...(parseData ? { tableCounts: await parseCopyTableCountsFromFile(path) } : {}),
    };
}

function blockingStorageDifferences(comparison) {
    return comparison.missingRegistryObjects.length
        + comparison.sizeMismatch.length
        + comparison.hashMismatch.length
        + comparison.contentTypeMismatch.length;
}

function snapshotFingerprint(value) {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function assertControlPlane(client) {
    let readiness;
    try {
        readiness = await client.rpc("omr_service_readiness_v1");
    } catch {
        throw new Error("Production readiness check failed");
    }
    if (
        readiness?.error
        || readiness?.data?.ready !== true
        || readiness?.data?.version !== EXPECTED_READINESS_VERSION
    ) throw new Error("Production readiness check failed");

    let leases;
    try {
        leases = await client
            .from("omr_remote_asset_cleanup_queue")
            .select("id", { count: "exact", head: true })
            .eq("status", "leased");
    } catch {
        throw new Error("Active cleanup lease check failed");
    }
    if (leases?.error || !Number.isSafeInteger(leases?.count) || leases.count !== 0) {
        throw new Error("Active cleanup leases must be zero");
    }
}

async function collectStorageSnapshot(client) {
    const listed = await listStorageObjectsToFixedPoint(client, REMOTE_ASSET_BUCKET);
    const registry = await readRemoteAssetRegistry(client);
    const comparison = compareRegistryToStorage(registry, listed);
    if (blockingStorageDifferences(comparison) > 0) throw new Error("Storage registry consistency check failed");
    return {
        listed,
        registry,
        comparison,
        fingerprint: snapshotFingerprint({ listed, registry }),
        warnings: comparison.orphanStorageObjects.length > 0
            ? [`orphan_storage_objects:${comparison.orphanStorageObjects.length}`]
            : [],
    };
}

async function writeManifest(path, manifest) {
    try {
        await writeProtectedFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
    } catch {
        throw new Error("Backup manifest write failed");
    }
}

async function syncDirectory(path) {
    let handle;
    try {
        handle = await open(path, "r");
        await handle.sync();
    } finally {
        await handle?.close().catch(() => undefined);
    }
}

async function syncStoragePayload(root, objects) {
    const directories = new Set([root]);
    for (const object of objects) {
        const segments = object.path.split("/");
        await syncFile(resolve(root, ...segments));
        for (let length = 1; length < segments.length; length += 1) {
            directories.add(resolve(root, ...segments.slice(0, length)));
        }
    }
    const deepestFirst = [...directories].sort((left, right) => right.split(sep).length - left.split(sep).length);
    for (const directory of deepestFirst) await syncDirectory(directory);
}

function defaultCreateSupabaseClient(url, key) {
    return createClient(url, key, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        global: { headers: { "x-omr-client": "production-backup" } },
    });
}

async function assertSafeOutputParent(outputDir) {
    const parent = dirname(outputDir);
    try {
        const info = await lstat(parent);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("unsafe");
        await realpath(parent);
    } catch {
        throw new Error("Backup output parent must already exist");
    }
}

export async function runProductionBackup(config, overrides = {}) {
    const dependencies = {
        createSupabaseClient: overrides.createSupabaseClient ?? defaultCreateSupabaseClient,
        runCommand: overrides.runCommand ?? ((plan, env) => runNativeBackupCommand(plan, env, config.cwd)),
        verifyPostgresVersion: overrides.verifyPostgresVersion ?? defaultVerifyPostgresVersion,
        now: overrides.now ?? (() => new Date().toISOString()),
    };
    const client = dependencies.createSupabaseClient(config.supabaseUrl, config.serviceRoleKey);
    await assertControlPlane(client);
    const initialSnapshot = await collectStorageSnapshot(client);
    if (config.mode === "inventory") {
        return {
            mode: "inventory",
            warnings: initialSnapshot.warnings,
            summary: {
                registryObjectCount: initialSnapshot.registry.length,
                storageObjectCount: initialSnapshot.listed.length,
                orphanStorageObjectCount: initialSnapshot.comparison.orphanStorageObjects.length,
                bodyHashUnverifiedCount: initialSnapshot.comparison.hashUnavailable.length,
            },
        };
    }

    const termination = installTerminationGuard();
    try {
        termination.throwIfRequested();
        await dependencies.verifyPostgresVersion(config);
        termination.throwIfRequested();
        await assertSafeOutputParent(config.outputDir);
        try {
            await mkdir(config.outputDir, { recursive: false, mode: 0o700 });
            await chmod(config.outputDir, 0o700);
            await writeProtectedFile(join(config.outputDir, ".INCOMPLETE"), `${JSON.stringify({
                formatVersion: 1,
                gitCommit: config.gitCommit,
                sourceProjectRefHash: config.sourceProjectRefHash,
            })}\n`);
            await mkdir(join(config.outputDir, "database"), { mode: 0o700 });
        } catch {
            throw new Error("Backup output directory must be new and writable");
        }
        termination.throwIfRequested();

        await withPostgresCredentials(config, termination, async (commandEnv) => {
            for (const plan of buildPostgresDumpCommands(config)) {
                try {
                    await dependencies.runCommand(plan, commandEnv);
                } catch {
                    throw new Error("Database backup command failed");
                }
                termination.throwIfRequested();
            }
        });
        termination.throwIfRequested();

        const databaseDir = join(config.outputDir, "database");
        const roles = await sqlArtifact(join(databaseDir, "roles.sql"), "roles.sql");
        const schema = await sqlArtifact(join(databaseDir, "schema.sql"), "schema.sql");
        const data = await sqlArtifact(join(databaseDir, "data.sql"), "data.sql", true);
        await syncDirectory(databaseDir);
        termination.throwIfRequested();
        const tableCounts = data.tableCounts;
        if (
            Object.keys(tableCounts).length !== CANONICAL_BACKUP_TABLES.length
            || CANONICAL_BACKUP_TABLES.some((table) => !Object.hasOwn(tableCounts, table))
        ) throw new Error("Database backup does not contain the exact canonical table inventory");

        const downloaded = await downloadAndHashStorageObjects(
            client,
            REMOTE_ASSET_BUCKET,
            initialSnapshot.listed,
            join(config.outputDir, "storage"),
        );
        const downloadedComparison = compareRegistryToStorage(initialSnapshot.registry, downloaded.objects);
        if (blockingStorageDifferences(downloadedComparison) > 0 || downloadedComparison.hashUnavailable.length > 0) {
            throw new Error("Downloaded Storage verification failed");
        }
        await syncStoragePayload(join(config.outputDir, "storage"), downloaded.objects);
        termination.throwIfRequested();

        await assertControlPlane(client);
        const finalSnapshot = await collectStorageSnapshot(client);
        if (finalSnapshot.fingerprint !== initialSnapshot.fingerprint) {
            throw new Error("Storage or registry changed during backup");
        }
        const finalDownloadedComparison = compareRegistryToStorage(finalSnapshot.registry, downloaded.objects);
        if (blockingStorageDifferences(finalDownloadedComparison) > 0 || finalDownloadedComparison.hashUnavailable.length > 0) {
            throw new Error("Final Storage verification failed");
        }
        termination.throwIfRequested();

        const manifest = validateBackupManifest({
            formatVersion: 1,
            createdAt: dependencies.now(),
            gitCommit: config.gitCommit,
            sourceProjectRefHash: config.sourceProjectRefHash,
            database: {
                roles: { file: roles.file, bytes: roles.bytes, sha256: roles.sha256 },
                schema: { file: schema.file, bytes: schema.bytes, sha256: schema.sha256 },
                data: { file: data.file, bytes: data.bytes, sha256: data.sha256 },
                tableCounts,
            },
            storage: {
                bucket: REMOTE_ASSET_BUCKET,
                objectCount: downloaded.objectCount,
                totalBytes: downloaded.totalBytes,
                objects: downloaded.objects,
            },
        });
        await writeManifest(join(config.outputDir, "manifest.json"), manifest);
        await syncDirectory(config.outputDir);
        termination.throwIfRequested();
        await rename(join(config.outputDir, ".INCOMPLETE"), join(config.outputDir, ".COMPLETE"));
        return {
            mode: "create",
            manifest,
            warnings: initialSnapshot.warnings,
            summary: redactBackupSummary(manifest),
        };
    } finally {
        termination.dispose();
    }
}

function currentGitState(cwd) {
    try {
        return {
            commit: execFileSync("git", ["rev-parse", "HEAD"], {
                cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
            }).trim(),
            clean: execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=normal"], {
                cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
            }).trim() === "",
        };
    } catch {
        throw new Error("Unable to resolve the current Git state");
    }
}

async function main() {
    const cwd = resolve(import.meta.dirname, "..");
    const git = currentGitState(cwd);
    const config = resolveBackupProductionConfig({
        argv: process.argv.slice(2),
        env: process.env,
        cwd,
        homeDir: homedir(),
        gitCommit: git.commit,
        gitWorktreeClean: git.clean,
    });
    const result = await runProductionBackup(config);
    process.stdout.write(`${JSON.stringify(result.summary)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch(() => {
        process.stderr.write("Production backup failed. Inspect the protected operator log.\n");
        process.exitCode = 1;
    });
}
