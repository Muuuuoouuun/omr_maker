import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
    buildPostgresDumpCommands,
    parseBackupProductionArgs,
    resolveBackupProductionConfig,
    runNativeBackupCommand,
    runProductionBackup,
} from "../../scripts/backup-production.mjs";
import {
    CANONICAL_BACKUP_TABLES,
    validateBackupManifest,
} from "../../scripts/backup-restore-core.mjs";

const PROJECT_REF = "abcdefghijklmnopqrst";
const GIT_SHA = "a".repeat(40);
const SERVICE_KEY = "service-role-secret-that-must-never-be-logged";
const DB_PASSWORD = "database:password\\that-must-never-be-in-child-env";
const POSTGRES_BIN = "/opt/postgresql-17/bin";

function sha(body: string) {
    return createHash("sha256").update(body).digest("hex");
}

function baseEnv() {
    return {
        SUPABASE_URL: `https://${PROJECT_REF}.supabase.co`,
        SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
        SUPABASE_DB_HOST: `db.${PROJECT_REF}.supabase.co`,
        SUPABASE_DB_PORT: "5432",
        SUPABASE_DB_USER: "postgres",
        SUPABASE_DB_NAME: "postgres",
        SUPABASE_DB_PASSWORD: DB_PASSWORD,
        OMR_POSTGRES_BIN: POSTGRES_BIN,
    };
}

function createArgv(outputDir: string) {
    return [
        "--create",
        `--output=${outputDir}`,
        `--confirm-source-project-ref=${PROJECT_REF}`,
        `--confirm-writes-paused=${PROJECT_REF}`,
        `--confirm-asset-gc-paused=${PROJECT_REF}`,
    ];
}

function resolveCreate(outputDir: string, overrides: Record<string, unknown> = {}) {
    return resolveBackupProductionConfig({
        argv: createArgv(outputDir),
        env: baseEnv(),
        cwd: process.cwd(),
        homeDir: "/home/operator",
        gitCommit: GIT_SHA,
        gitWorktreeClean: true,
        ...overrides,
    });
}

function dataDump() {
    return CANONICAL_BACKUP_TABLES.map((table) => [
        `COPY public.${table} (id) FROM stdin;`,
        "\\.",
    ].join("\n")).join("\n\n") + "\n";
}

function backupClient(body = "pdf-body", options: {
    leased?: number;
    version?: string;
    ready?: boolean;
    driftRegistryAfterFirstRead?: boolean;
} = {}) {
    const objectPath = "organizations/org-1/exams/exam-1/problem/asset-1.pdf";
    const objectSha = sha(body);
    const directories: Record<string, unknown[]> = {
        "": [{ name: "organizations", id: null, metadata: null }],
        organizations: [{ name: "org-1", id: null, metadata: null }],
        "organizations/org-1": [{ name: "exams", id: null, metadata: null }],
        "organizations/org-1/exams": [{ name: "exam-1", id: null, metadata: null }],
        "organizations/org-1/exams/exam-1": [{ name: "problem", id: null, metadata: null }],
        "organizations/org-1/exams/exam-1/problem": [{
            name: "asset-1.pdf",
            id: "asset-1",
            metadata: {
                size: Buffer.byteLength(body),
                mimetype: "application/pdf",
                sha256Hex: objectSha,
            },
        }],
    };
    let registryReadCount = 0;
    return {
        objectPath,
        objectSha,
        client: {
            async rpc(name: string) {
                expect(name).toBe("omr_service_readiness_v1");
                return {
                    data: {
                        version: options.version ?? "202608080005",
                        ready: options.ready ?? true,
                    },
                    error: null,
                };
            },
            storage: {
                from(bucket: string) {
                    expect(bucket).toBe("omr-private-assets");
                    return {
                        async list(path: string, paging: { offset: number; limit: number }) {
                            const rows = directories[path] ?? [];
                            return { data: rows.slice(paging.offset, paging.offset + paging.limit), error: null };
                        },
                        async download(path: string) {
                            expect(path).toBe(objectPath);
                            return { data: new Blob([body]), error: null };
                        },
                    };
                },
            },
            from(table: string) {
                if (table === "omr_remote_asset_cleanup_queue") {
                    return {
                        select() {
                            return {
                                async eq(column: string, value: string) {
                                    expect([column, value]).toEqual(["status", "leased"]);
                                    return { data: null, count: options.leased ?? 0, error: null };
                                },
                            };
                        },
                    };
                }
                expect(table).toBe("omr_remote_assets");
                return {
                    select() {
                        return {
                            order() {
                                return {
                                    async range(from: number) {
                                        if (from === 0) registryReadCount += 1;
                                        return {
                                            data: from === 0 ? [{
                                                object_path: objectPath,
                                                byte_size: Buffer.byteLength(body),
                                                sha256_hex: options.driftRegistryAfterFirstRead && registryReadCount > 1
                                                    ? "b".repeat(64)
                                                    : objectSha,
                                                mime_type: "application/pdf",
                                            }] : [],
                                            error: null,
                                        };
                                    },
                                };
                            },
                        };
                    },
                };
            },
        },
    };
}

describe("production backup runner contract", () => {
    it("exposes native PostgreSQL backup commands without adding the Supabase CLI", () => {
        const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
        const envExample = readFileSync(join(process.cwd(), ".env.example"), "utf8");

        expect(packageJson.devDependencies.supabase).toBeUndefined();
        expect(packageJson.scripts["ops:backup:inventory"]).toBe("node scripts/backup-production.mjs --inventory-only");
        expect(packageJson.scripts["ops:backup:create"]).toBe("node scripts/backup-production.mjs --create");
        for (const name of ["SUPABASE_DB_HOST", "SUPABASE_DB_PORT", "SUPABASE_DB_USER", "SUPABASE_DB_NAME", "SUPABASE_DB_PASSWORD", "OMR_POSTGRES_BIN"]) {
            expect(envExample).toContain(`${name}=`);
        }
        expect(envExample).not.toContain("SUPABASE_DB_URL=");
    });

    it("requires exact project-scoped write and asset-GC confirmations", () => {
        expect(parseBackupProductionArgs(createArgv("/secure/backup-1"))).toEqual({
            mode: "create",
            outputDir: "/secure/backup-1",
            confirmedSourceProjectRef: PROJECT_REF,
            confirmedWritesPausedRef: PROJECT_REF,
            confirmedAssetGcPausedRef: PROJECT_REF,
        });
        expect(parseBackupProductionArgs(["--inventory-only", `--confirm-source-project-ref=${PROJECT_REF}`])).toEqual({
            mode: "inventory",
            confirmedSourceProjectRef: PROJECT_REF,
        });
        expect(() => parseBackupProductionArgs(["--create", "--inventory-only"])).toThrow(/exactly one/i);
        expect(() => parseBackupProductionArgs(["--create", "--confirm-gc-paused"])).toThrow(/unknown/i);
        expect(() => parseBackupProductionArgs(["--create", "--output=/a", "--output=/b"])).toThrow(/duplicate/i);
    });

    it("rejects ref mismatches, dirty Git, unsafe output paths, and missing database identity", () => {
        const cwd = "/workspace/omr";
        const input = {
            argv: createArgv("/secure/backup-1"), env: baseEnv(), cwd, homeDir: "/home/operator",
            gitCommit: GIT_SHA, gitWorktreeClean: true,
        };
        expect(resolveBackupProductionConfig(input)).toMatchObject({
            mode: "create",
            sourceProjectRef: PROJECT_REF,
            database: { host: `db.${PROJECT_REF}.supabase.co`, password: DB_PASSWORD },
            postgresBinDir: POSTGRES_BIN,
        });
        expect(() => resolveBackupProductionConfig({ ...input, gitWorktreeClean: false })).toThrow(/clean Git/i);
        expect(() => resolveBackupProductionConfig({ ...input, argv: createArgv(`${cwd}/backup`) })).toThrow(/repository/i);
        expect(() => resolveBackupProductionConfig({
            ...input,
            argv: createArgv("/secure/backup-1").map((arg) => arg.startsWith("--confirm-writes-paused=") ? "--confirm-writes-paused=wrongprojectref" : arg),
        })).toThrow(/writes/i);
        expect(() => resolveBackupProductionConfig({
            ...input,
            env: { ...baseEnv(), SUPABASE_DB_HOST: "db.differentprojectref.supabase.co" },
        })).toThrow(/database.*project/i);
    });

    it("builds PostgreSQL 17 commands with an exact 39-table data allowlist", () => {
        const commands = buildPostgresDumpCommands(resolveCreate("/secure/backup-1"));
        expect(commands.map((plan) => plan.command)).toEqual([
            `${POSTGRES_BIN}/pg_dumpall`,
            `${POSTGRES_BIN}/pg_dump`,
            `${POSTGRES_BIN}/pg_dump`,
        ]);
        expect(commands[0].args).toEqual(expect.arrayContaining(["--roles-only", "--no-role-passwords", "--no-password"]));
        expect(commands[1].args).toEqual(expect.arrayContaining(["--schema-only", "--schema=public", "--no-owner", "--no-privileges"]));
        expect(commands[2].args).toEqual(expect.arrayContaining(["--data-only", "--strict-names", "--no-owner", "--no-privileges"]));
        expect(commands[2].args.filter((arg) => arg.startsWith("--table="))).toEqual(
            CANONICAL_BACKUP_TABLES.map((table) => `--table=public.${table}`),
        );
        const serialized = JSON.stringify(commands);
        expect(serialized).not.toContain(DB_PASSWORD);
        expect(serialized).not.toContain(SERVICE_KEY);
        expect(serialized).not.toContain("supabase.co");
    });

    it("checks readiness and active cleanup leases before creating output", async () => {
        const parent = await mkdtemp(join(tmpdir(), "omr-production-backup-gate-"));
        for (const client of [backupClient("pdf-body", { ready: false }).client, backupClient("pdf-body", { leased: 1 }).client]) {
            const outputDir = join(parent, `backup-${Math.random()}`);
            await expect(runProductionBackup(resolveCreate(outputDir), {
                createSupabaseClient: () => client,
                verifyPostgresVersion: async () => undefined,
            })).rejects.toThrow(/readiness|lease/i);
            expect(existsSync(outputDir)).toBe(false);
        }
    });

    it("runs inventory checks without database credentials or an output directory", async () => {
        const config = resolveBackupProductionConfig({
            argv: ["--inventory-only", `--confirm-source-project-ref=${PROJECT_REF}`],
            env: {
                SUPABASE_URL: `https://${PROJECT_REF}.supabase.co`,
                SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
            },
            cwd: process.cwd(),
            homeDir: "/home/operator",
            gitCommit: GIT_SHA,
            gitWorktreeClean: false,
        });
        await expect(runProductionBackup(config, {
            createSupabaseClient: () => backupClient().client,
        })).resolves.toMatchObject({
            mode: "inventory",
            warnings: [],
            summary: { registryObjectCount: 1, storageObjectCount: 1 },
        });
    });

    it("creates a validated backup using private credential files and completion sentinels", async () => {
        const parent = await mkdtemp(join(tmpdir(), "omr-production-backup-parent-"));
        const outputDir = join(parent, "backup-1");
        const { client, objectPath, objectSha } = backupClient();
        const calls: Array<{ command: string; args: string[]; env: Record<string, string> }> = [];
        let passFile = "";
        let serviceFile = "";

        const result = await runProductionBackup(resolveCreate(outputDir), {
            createSupabaseClient: () => client,
            verifyPostgresVersion: async () => undefined,
            async runCommand(plan: { command: string; args: string[]; outputPath: string }, env: Record<string, string>) {
                calls.push({ command: plan.command, args: plan.args, env: { ...env } });
                passFile = env.PGPASSFILE;
                serviceFile = env.PGSERVICEFILE;
                expect((await stat(passFile)).mode & 0o777).toBe(0o600);
                expect((await stat(serviceFile)).mode & 0o777).toBe(0o600);
                expect(await readFile(passFile, "utf8")).toContain("database\\:password\\\\that-must-never-be-in-child-env");
                expect(await readFile(serviceFile, "utf8")).toContain("sslmode=verify-full\nsslrootcert=system");
                const content = plan.outputPath.endsWith("roles.sql")
                    ? "-- roles backup without passwords\n"
                    : plan.outputPath.endsWith("schema.sql")
                        ? "-- schema backup\n"
                        : dataDump();
                await writeFile(plan.outputPath, content, { flag: "wx", mode: 0o600 });
            },
            now: () => "2026-08-07T00:00:00.000Z",
        });

        if (!result.manifest) throw new Error("Expected create manifest");
        expect(validateBackupManifest(result.manifest)).toEqual(result.manifest);
        expect(result.manifest.storage.objects).toEqual([{
            path: objectPath, bytes: 8, sha256: objectSha, contentType: "application/pdf",
        }]);
        expect(result.warnings).toEqual([]);
        expect(calls).toHaveLength(3);
        const childSerialization = JSON.stringify(calls);
        expect(childSerialization).not.toContain(DB_PASSWORD);
        expect(childSerialization).not.toContain(SERVICE_KEY);
        expect(childSerialization).not.toContain(`https://${PROJECT_REF}.supabase.co`);
        expect(calls.every((call) => Object.keys(call.env).sort().join(",") === "LANG,LC_ALL,PGAPPNAME,PGCONNECT_TIMEOUT,PGPASSFILE,PGSERVICE,PGSERVICEFILE")).toBe(true);
        expect(existsSync(passFile)).toBe(false);
        expect(existsSync(serviceFile)).toBe(false);
        expect(existsSync(join(outputDir, ".INCOMPLETE"))).toBe(false);
        expect(existsSync(join(outputDir, ".COMPLETE"))).toBe(true);
        expect(JSON.parse(await readFile(join(outputDir, "manifest.json"), "utf8"))).toEqual(result.manifest);
        expect((await stat(outputDir)).mode & 0o777).toBe(0o700);
        expect((await stat(join(outputDir, "manifest.json"))).mode & 0o777).toBe(0o600);
    });

    it("leaves an incomplete marker and no manifest after a sanitized command failure", async () => {
        const parent = await mkdtemp(join(tmpdir(), "omr-production-backup-failure-"));
        const outputDir = join(parent, "backup-1");
        const secretError = `failed ${DB_PASSWORD} ${SERVICE_KEY} https://${PROJECT_REF}.supabase.co`;

        await expect(runProductionBackup(resolveCreate(outputDir), {
            createSupabaseClient: () => backupClient().client,
            verifyPostgresVersion: async () => undefined,
            async runCommand() { throw new Error(secretError); },
        })).rejects.toThrow(/^Database backup command failed$/);

        expect(existsSync(join(outputDir, ".INCOMPLETE"))).toBe(true);
        expect(existsSync(join(outputDir, ".COMPLETE"))).toBe(false);
        expect(existsSync(join(outputDir, "manifest.json"))).toBe(false);
    });

    it("force-kills and awaits a native child that ignores SIGTERM after stderr overflow", async () => {
        const parent = await mkdtemp(join(tmpdir(), "omr-production-backup-child-"));
        const outputPath = join(parent, "child-output.sql");
        const startedAt = Date.now();
        await expect(runNativeBackupCommand({
            command: process.execPath,
            args: [
                "-e",
                "process.on('SIGTERM',()=>{});process.stderr.write('x'.repeat(128));setInterval(()=>{},1000)",
            ],
            outputPath,
        }, {}, process.cwd(), {
            timeoutMs: 2_000,
            killGraceMs: 20,
            maxStderrBytes: 32,
        })).rejects.toThrow(/command/);
        expect(Date.now() - startedAt).toBeLessThan(1_000);
        expect((await stat(outputPath)).isFile()).toBe(true);
    });

    it("removes private credentials when SIGTERM arrives between dump commands", async () => {
        const parent = await mkdtemp(join(tmpdir(), "omr-production-backup-signal-"));
        const outputDir = join(parent, "backup-1");
        const originalSignalListeners = process.listenerCount("SIGTERM");
        let passFile = "";
        let serviceFile = "";

        await expect(runProductionBackup(resolveCreate(outputDir), {
            createSupabaseClient: () => backupClient().client,
            verifyPostgresVersion: async () => undefined,
            async runCommand(plan: { outputPath: string }, env: Record<string, string>) {
                passFile = env.PGPASSFILE;
                serviceFile = env.PGSERVICEFILE;
                await writeFile(plan.outputPath, "-- interrupted roles backup\n", { flag: "wx", mode: 0o600 });
                process.emit("SIGTERM");
            },
        })).rejects.toThrow(/^Backup interrupted$/);

        expect(existsSync(passFile)).toBe(false);
        expect(existsSync(serviceFile)).toBe(false);
        expect(existsSync(join(outputDir, ".INCOMPLETE"))).toBe(true);
        expect(existsSync(join(outputDir, ".COMPLETE"))).toBe(false);
        expect(process.listenerCount("SIGTERM")).toBe(originalSignalListeners);
    });

    it("fails closed when the registry changes during backup", async () => {
        const parent = await mkdtemp(join(tmpdir(), "omr-production-backup-drift-"));
        const outputDir = join(parent, "backup-1");
        const { client } = backupClient("pdf-body", { driftRegistryAfterFirstRead: true });

        await expect(runProductionBackup(resolveCreate(outputDir), {
            createSupabaseClient: () => client,
            verifyPostgresVersion: async () => undefined,
            async runCommand(plan: { outputPath: string }) {
                const content = plan.outputPath.endsWith("roles.sql")
                    ? "-- roles backup\n"
                    : plan.outputPath.endsWith("schema.sql")
                        ? "-- schema backup\n"
                        : dataDump();
                await writeFile(plan.outputPath, content, { flag: "wx", mode: 0o600 });
            },
        })).rejects.toThrow(/Storage registry consistency|changed during backup/i);

        expect(existsSync(join(outputDir, ".INCOMPLETE"))).toBe(true);
        expect(existsSync(join(outputDir, ".COMPLETE"))).toBe(false);
        expect(existsSync(join(outputDir, "manifest.json"))).toBe(false);
    });
});
