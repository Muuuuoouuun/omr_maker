import { createHash } from "node:crypto";
import {
    closeSync,
    linkSync,
    mkdirSync,
    mkdtempSync,
    openSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";

import {
    RESTORE_TARGET_APPLY_LIMITS,
    assertRestoreApplyBounds,
    formatRestoreApplyStatusLine,
    resolveRestoreTargetApplyConfig,
    runRestoreTargetApply,
    streamVerifiedArtifact,
} from "../../scripts/restore-target-apply-core.mjs";
import {
    CANONICAL_BACKUP_TABLES,
    REMOTE_ASSET_BUCKET,
    hashProjectRef,
} from "../../scripts/backup-restore-core.mjs";

const SOURCE_REF = "production-source-ref";
const TARGET_REF = "staging-restore-ref";
const BUILD = "6".repeat(40);
const BOUNDARY_SHA256 = "7".repeat(64);
const SERVICE_KEY = "restore-service-role-key-at-least-32-bytes";

function sha256(body: string | Buffer) {
    return createHash("sha256").update(body).digest("hex");
}

function artifact(path: string, body: string) {
    writeFileSync(path, body, { mode: 0o600 });
    return { file: path.split("/").at(-1), bytes: Buffer.byteLength(body), sha256: sha256(body) };
}

function backupFixture(objectCount = 1) {
    const backupDir = mkdtempSync(join(tmpdir(), "omr-apply-backup-"));
    const databaseDir = join(backupDir, "database");
    const storageDir = join(backupDir, "storage");
    mkdirSync(databaseDir, { mode: 0o700 });
    mkdirSync(storageDir, { mode: 0o700 });
    const roles = artifact(join(databaseDir, "roles.sql"), "-- roles\n");
    const schema = artifact(join(databaseDir, "schema.sql"), "-- schema\n");
    const data = artifact(join(databaseDir, "data.sql"), "-- data\n");
    const objects = Array.from({ length: objectCount }, (_, index) => {
        const objectPath = `organizations/org-1/exams/exam-1/problem/asset-${index + 1}.pdf`;
        const objectFile = join(storageDir, ...objectPath.split("/"));
        mkdirSync(objectFile.slice(0, objectFile.lastIndexOf("/")), { recursive: true, mode: 0o700 });
        writeFileSync(objectFile, "pdf\n", { mode: 0o600 });
        return { path: objectPath, bytes: 4, sha256: sha256("pdf\n"), contentType: "application/pdf" };
    });
    const tableCounts = Object.fromEntries(CANONICAL_BACKUP_TABLES.map(table => [table, 0]));
    const manifest = {
        formatVersion: 1,
        createdAt: "2026-08-10T00:00:00.000Z",
        gitCommit: BUILD,
        sourceProjectRefHash: hashProjectRef(SOURCE_REF),
        database: { roles, schema, data, tableCounts },
        storage: {
            bucket: REMOTE_ASSET_BUCKET,
            objectCount,
            totalBytes: objectCount * 4,
            objects,
        },
    };
    writeFileSync(join(backupDir, "manifest.json"), `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
    writeFileSync(join(backupDir, ".COMPLETE"), "complete\n", { mode: 0o600 });
    return { backupDir, databaseDir, manifest };
}

function env() {
    return {
        OMR_DEPLOYMENT_TIER: "staging",
        OMR_RESTORE_TARGET_SUPABASE_URL: `https://${TARGET_REF}.supabase.co`,
        OMR_RESTORE_TARGET_APP_URL: "https://restore-staging.example.test",
        OMR_RESTORE_EXPECTED_BUILD: BUILD,
        OMR_RESTORE_EXPECTED_BOUNDARY_SHA256: BOUNDARY_SHA256,
        OMR_PRODUCTION_SUPABASE_URL: `https://${SOURCE_REF}.supabase.co`,
        OMR_RESTORE_TARGET_SERVICE_ROLE_KEY: SERVICE_KEY,
        OMR_RESTORE_TARGET_DB_HOST: `db.${TARGET_REF}.supabase.co`,
        OMR_RESTORE_TARGET_DB_PORT: "5432",
        OMR_RESTORE_TARGET_DB_USER: "postgres",
        OMR_RESTORE_TARGET_DB_NAME: "postgres",
        OMR_RESTORE_TARGET_DB_PASSWORD: "restore-db-password",
        OMR_POSTGRES_BIN: "/opt/postgresql-17/bin",
    };
}

function argv(backupDir: string, outputDir: string) {
    return [
        "--apply",
        `--backup=${backupDir}`,
        `--output-dir=${outputDir}`,
        `--confirm-target-project-ref=${TARGET_REF}`,
        `--confirm-boundary-sha256=${BOUNDARY_SHA256}`,
        "--started-at=2026-08-10T00:10:00.000Z",
    ];
}

function resolveConfig(overrides: Record<string, string> = {}) {
    const { backupDir } = backupFixture();
    const outputDir = mkdtempSync(join(tmpdir(), "omr-apply-evidence-"));
    return resolveRestoreTargetApplyConfig({
        argv: argv(backupDir, outputDir),
        env: { ...env(), ...overrides },
        cwd: process.cwd(),
        verifyCheckout: () => ({ buildSha: BUILD, boundarySha256: BOUNDARY_SHA256, sourceSha256: "8".repeat(64) }),
    });
}

function passingChild() {
    const child = new EventEmitter() as EventEmitter & {
        stdin: Writable;
        stdout: PassThrough;
        stderr: PassThrough;
        kill: () => boolean;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new Writable({ write(_chunk, _encoding, callback) { setImmediate(callback); } });
    child.stdin.once("finish", () => setImmediate(() => child.emit("close", 0, null)));
    child.kill = () => true;
    return child;
}

describe("restore target streaming apply core", () => {
    it("rejects source=target, production target, non-staging, stale build, and a wrong boundary", () => {
        expect(() => resolveConfig({ OMR_PRODUCTION_SUPABASE_URL: `https://${TARGET_REF}.supabase.co` })).toThrow(/production|target/i);
        expect(() => resolveConfig({ OMR_DEPLOYMENT_TIER: "production" })).toThrow(/staging/i);
        expect(() => resolveConfig({ OMR_RESTORE_EXPECTED_BUILD: "5".repeat(40) })).toThrow(/build|checkout/i);
        expect(() => resolveConfig({ OMR_RESTORE_EXPECTED_BOUNDARY_SHA256: "4".repeat(64) })).toThrow(/boundary/i);

        const { backupDir } = backupFixture();
        const outputDir = mkdtempSync(join(tmpdir(), "omr-apply-source-target-"));
        expect(() => resolveRestoreTargetApplyConfig({
            argv: argv(backupDir, outputDir).map(value => value.includes("confirm-target")
                ? `--confirm-target-project-ref=${SOURCE_REF}`
                : value),
            env: { ...env(), OMR_RESTORE_TARGET_SUPABASE_URL: `https://${SOURCE_REF}.supabase.co` },
            cwd: process.cwd(),
            verifyCheckout: () => ({ buildSha: BUILD, boundarySha256: BOUNDARY_SHA256, sourceSha256: "8".repeat(64) }),
        })).toThrow(/source|target/i);
    });

    it("binds direct or pooler PostgreSQL credentials to the target and rejects control-byte secrets", () => {
        expect(() => resolveConfig({ OMR_RESTORE_TARGET_DB_HOST: "db.other-project.supabase.co" })).toThrow(/database|target|credential/i);
        expect(() => resolveConfig({ OMR_RESTORE_TARGET_DB_PASSWORD: "line-one\nline-two" })).toThrow(/database|credential/i);
        expect(() => resolveConfig({ OMR_RESTORE_TARGET_DB_PORT: "6543" })).toThrow(/database|credential|port/i);
        expect(() => resolveConfig({ OMR_RESTORE_TARGET_SERVICE_ROLE_KEY: `${SERVICE_KEY}\n` })).toThrow(/credential/i);
        expect(() => resolveConfig({ OMR_RESTORE_TARGET_SUPABASE_URL: `https://${TARGET_REF}.supabase.co/rest/v1` })).toThrow(/URL|canonical|invalid/i);
        expect(() => resolveConfig({
            OMR_RESTORE_TARGET_DB_HOST: "aws-0-ap-northeast-2.pooler.supabase.com",
            OMR_RESTORE_TARGET_DB_USER: `postgres.${TARGET_REF}`,
            OMR_RESTORE_TARGET_DB_PORT: "6543",
        })).not.toThrow();
    });

    it("rejects incomplete backups and SQL symlink or hard-link substitutions", () => {
        const outputDir = mkdtempSync(join(tmpdir(), "omr-apply-identity-"));
        const incomplete = backupFixture();
        writeFileSync(join(incomplete.backupDir, ".INCOMPLETE"), "incomplete\n", { mode: 0o600 });
        expect(() => resolveRestoreTargetApplyConfig({
            argv: argv(incomplete.backupDir, outputDir), env: env(), cwd: process.cwd(),
            verifyCheckout: () => ({ buildSha: BUILD, boundarySha256: BOUNDARY_SHA256, sourceSha256: "8".repeat(64) }),
        })).toThrow(/incomplete/i);

        const linked = backupFixture();
        const rolesPath = join(linked.databaseDir, "roles.sql");
        const originalPath = join(linked.databaseDir, "roles-original.sql");
        writeFileSync(originalPath, readFileSync(rolesPath), { mode: 0o600 });
        rmSync(rolesPath);
        symlinkSync(originalPath, rolesPath);
        expect(() => resolveRestoreTargetApplyConfig({
            argv: argv(linked.backupDir, outputDir), env: env(), cwd: process.cwd(),
            verifyCheckout: () => ({ buildSha: BUILD, boundarySha256: BOUNDARY_SHA256, sourceSha256: "8".repeat(64) }),
        })).toThrow(/symbolic|link|artifact/i);

        const hardLinked = backupFixture();
        linkSync(join(hardLinked.databaseDir, "schema.sql"), join(hardLinked.databaseDir, "schema-copy.sql"));
        expect(() => resolveRestoreTargetApplyConfig({
            argv: argv(hardLinked.backupDir, outputDir), env: env(), cwd: process.cwd(),
            verifyCheckout: () => ({ buildSha: BUILD, boundarySha256: BOUNDARY_SHA256, sourceSha256: "8".repeat(64) }),
        })).toThrow(/hard.?link|link count|artifact/i);
    });

    it("enforces finite SQL, aggregate, process-output, storage, and upload-concurrency bounds", () => {
        expect(RESTORE_TARGET_APPLY_LIMITS).toMatchObject({
            maxSqlArtifactBytes: expect.any(Number),
            maxSqlAggregateBytes: expect.any(Number),
            maxChildRuntimeMs: expect.any(Number),
            maxChildStdoutBytes: expect.any(Number),
            maxChildStderrBytes: expect.any(Number),
            maxStorageObjects: expect.any(Number),
            maxStorageObjectBytes: expect.any(Number),
            maxStorageAggregateBytes: expect.any(Number),
            uploadConcurrency: expect.any(Number),
        });
        expect(RESTORE_TARGET_APPLY_LIMITS.uploadConcurrency).toBeGreaterThanOrEqual(1);
        expect(RESTORE_TARGET_APPLY_LIMITS.uploadConcurrency).toBeLessThanOrEqual(8);
        for (const value of Object.values(RESTORE_TARGET_APPLY_LIMITS)) {
            expect(Number.isSafeInteger(value)).toBe(true);
            expect(value).toBeGreaterThan(0);
        }
        expect(() => assertRestoreApplyBounds({
            sqlArtifactBytes: [RESTORE_TARGET_APPLY_LIMITS.maxSqlArtifactBytes + 1, 1, 1],
            storageObjectBytes: [],
        })).toThrow(/SQL|artifact|bound/i);
        expect(() => assertRestoreApplyBounds({
            sqlArtifactBytes: [1, 1, 1],
            storageObjectBytes: Array.from(
                { length: RESTORE_TARGET_APPLY_LIMITS.maxStorageObjects + 1 },
                () => 1,
            ),
        })).toThrow(/storage|count|bound/i);
    });

    it("streams a verified opened artifact with backpressure", async () => {
        const directory = mkdtempSync(join(tmpdir(), "omr-apply-stream-"));
        const path = join(directory, "data.sql");
        const body = Buffer.alloc(256 * 1024, 97);
        writeFileSync(path, body, { mode: 0o600 });
        const fd = openSync(path, "r");
        const chunks: Buffer[] = [];
        const sink = new Writable({
            highWaterMark: 1024,
            write(chunk, _encoding, callback) {
                chunks.push(Buffer.from(chunk));
                setImmediate(callback);
            },
        });
        const result = await streamVerifiedArtifact({
            fd,
            path,
            bytes: body.byteLength,
            sha256: sha256(body),
        }, sink);
        closeSync(fd);
        expect(result).toEqual({ bytes: body.byteLength, sha256: sha256(body) });
        expect(Buffer.concat(chunks)).toEqual(body);
    });

    it("detects a same-path same-inode mutation during an artifact stream", async () => {
        const directory = mkdtempSync(join(tmpdir(), "omr-apply-substitute-"));
        const path = join(directory, "data.sql");
        const body = Buffer.alloc(256 * 1024, 97);
        writeFileSync(path, body, { mode: 0o600 });
        const fd = openSync(path, "r");
        let mutated = false;
        const sink = new Writable({
            highWaterMark: 1024,
            write(_chunk, _encoding, callback) {
                if (!mutated) {
                    mutated = true;
                    writeFileSync(path, Buffer.alloc(body.byteLength, 98), { mode: 0o600 });
                }
                setImmediate(callback);
            },
        });
        await expect(streamVerifiedArtifact({
            fd,
            path,
            bytes: body.byteLength,
            sha256: sha256(body),
        }, sink)).rejects.toThrow(/changed|identity|hash|size/i);
        closeSync(fd);
    });

    it("applies roles, schema, and data one at a time without full-file string or buffer reads", async () => {
        const config = resolveConfig();
        const order: string[] = [];
        let active = 0;
        let maxActive = 0;
        const spawnPsql = ({ kind }: { kind: string }) => {
            order.push(kind);
            active += 1;
            maxActive = Math.max(maxActive, active);
            const child = new EventEmitter() as EventEmitter & {
                stdin: Writable;
                stdout: PassThrough;
                stderr: PassThrough;
                kill: () => boolean;
            };
            child.stdout = new PassThrough();
            child.stderr = new PassThrough();
            child.stdin = new Writable({ write(chunk, _encoding, callback) { void chunk; setImmediate(callback); } });
            child.stdin.once("finish", () => setImmediate(() => {
                active -= 1;
                child.emit("close", 0, null);
            }));
            child.kill = () => true;
            return child;
        };
        await runRestoreTargetApply(config, {
            spawnPsql,
            uploadStorageObject: async ({ body }: { body: NodeJS.ReadableStream }) => {
                for await (const chunk of body) { void chunk; /* consume the bounded stream */ }
            },
        });
        expect(order).toEqual(["roles", "schema", "data"]);
        expect(maxActive).toBe(1);
        const source = readFileSync("scripts/restore-target-apply-core.mjs", "utf8");
        expect(source).not.toMatch(/readFileSync\([^)]*(?:roles|schema|data|artifact)/i);
        expect(source).not.toMatch(/artifact[^\n]*\.toString\s*\(/i);
    });

    it("uploads the exact bounded SHA metadata header expected by storage-js and the restore verifier SQL", async () => {
        const config = resolveConfig();
        const object = config.manifest.storage.objects[0];
        const storageJs = readFileSync("node_modules/@supabase/storage-js/src/packages/StorageFileApi.ts", "utf8");
        const verifier = readFileSync("scripts/verify-restored-environment.mjs", "utf8");
        const originalFetch = globalThis.fetch;
        let metadataHeader: string | null = null;
        globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
            metadataHeader = new Headers(init?.headers).get("x-metadata");
            for await (const chunk of init?.body as unknown as NodeJS.ReadableStream) {
                void chunk;
            }
            return new Response(null, { status: 200 });
        }) as typeof fetch;
        try {
            await runRestoreTargetApply(config, { spawnPsql: passingChild });
        } finally {
            globalThis.fetch = originalFetch;
        }

        expect(storageJs).toMatch(/encodeMetadata\(metadata[\s\S]{0,100}JSON\.stringify\(metadata\)/);
        expect(storageJs).toMatch(/headers\['x-metadata'\]\s*=\s*this\.toBase64\(this\.encodeMetadata\(metadata\)\)/);
        expect(metadataHeader).toBeTypeOf("string");
        expect(Buffer.byteLength(metadataHeader!, "ascii")).toBeLessThanOrEqual(256);
        expect(Buffer.from(metadataHeader!, "base64").toString("utf8")).toBe(JSON.stringify({
            sha256Hex: object.sha256,
        }));
        expect(verifier).toContain("{metadata,sha256Hex}");
    });

    it("bounds child output and runtime and leaves the exact marker incomplete", async () => {
        const config = resolveConfig();
        const noisyChild = () => {
            const child = new EventEmitter() as EventEmitter & {
                stdin: Writable;
                stdout: PassThrough;
                stderr: PassThrough;
                kill: () => boolean;
            };
            child.stdin = new PassThrough();
            child.stdout = new PassThrough();
            child.stderr = new PassThrough();
            child.kill = () => { child.emit("close", null, "SIGKILL"); return true; };
            setImmediate(() => child.stdout.write(Buffer.alloc(RESTORE_TARGET_APPLY_LIMITS.maxChildStdoutBytes + 1)));
            return child;
        };
        await expect(runRestoreTargetApply(config, { spawnPsql: noisyChild })).rejects.toThrow(/output|bounded|apply/i);
        expect(readFileSync(join(config.outputDir, ".INCOMPLETE"), "utf8")).toContain(config.environmentDigest);

        const timeoutConfig = resolveConfig();
        let childKilled = false;
        let childClosed = false;
        const hangingChild = () => {
            const child = new EventEmitter() as EventEmitter & {
                stdin: Writable;
                stdout: PassThrough;
                stderr: PassThrough;
                kill: () => boolean;
            };
            child.stdin = new PassThrough();
            child.stdout = new PassThrough();
            child.stderr = new PassThrough();
            child.once("close", () => { childClosed = true; });
            child.kill = () => { childKilled = true; child.emit("close", null, "SIGKILL"); return true; };
            return child;
        };
        await expect(runRestoreTargetApply(timeoutConfig, {
            spawnPsql: hangingChild,
            limits: { maxChildRuntimeMs: 5 },
        })).rejects.toThrow(/timeout|timed out|apply/i);
        expect(childKilled).toBe(true);
        expect(childClosed).toBe(true);
        expect(() => readFileSync(join(timeoutConfig.outputDir, ".RESTORE_COMPLETE"))).toThrow();
    });

    it("rejects a storage body hash mismatch without publishing completion", async () => {
        const config = resolveConfig();
        const object = config.manifest.storage.objects[0];
        writeFileSync(join(config.backupDir, "storage", ...object.path.split("/")), "bad\n", { mode: 0o600 });
        await expect(runRestoreTargetApply(config, {
            spawnPsql: passingChild,
            uploadStorageObject: async ({ body }: { body: NodeJS.ReadableStream }) => {
                for await (const chunk of body) { void chunk; /* consume until verification aborts */ }
            },
        })).rejects.toThrow(/storage|hash|size|artifact/i);
        expect(() => readFileSync(join(config.outputDir, ".RESTORE_COMPLETE"))).toThrow();
    });

    it("settles an upload failure without publishing completion", async () => {
        const uploadConfig = resolveConfig();
        await expect(runRestoreTargetApply(uploadConfig, {
            spawnPsql: passingChild,
            uploadStorageObject: async () => { throw new Error("upload rejected"); },
        })).rejects.toThrow(/storage|upload|restore/i);
        expect(readFileSync(join(uploadConfig.outputDir, ".INCOMPLETE"), "utf8")).toContain(uploadConfig.targetDigest);
    });

    it("uploads storage with bounded concurrency and rechecks every streamed body", async () => {
        const fixture = backupFixture(RESTORE_TARGET_APPLY_LIMITS.uploadConcurrency + 2);
        const outputDir = mkdtempSync(join(tmpdir(), "omr-apply-concurrency-"));
        const config = resolveRestoreTargetApplyConfig({
            argv: argv(fixture.backupDir, outputDir),
            env: env(),
            cwd: process.cwd(),
            verifyCheckout: () => ({ buildSha: BUILD, boundarySha256: BOUNDARY_SHA256, sourceSha256: "8".repeat(64) }),
        });
        let active = 0;
        let maxActive = 0;
        let uploaded = 0;
        const remotePaths: string[] = [];
        await runRestoreTargetApply(config, {
            spawnPsql: passingChild,
            uploadStorageObject: async ({ body, path }: { body: NodeJS.ReadableStream; path: string }) => {
                active += 1;
                maxActive = Math.max(maxActive, active);
                remotePaths.push(path);
                for await (const chunk of body) { void chunk; /* consume */ }
                await new Promise(resolve => setImmediate(resolve));
                uploaded += 1;
                active -= 1;
            },
        });
        expect(uploaded).toBe(fixture.manifest.storage.objectCount);
        expect(maxActive).toBeLessThanOrEqual(RESTORE_TARGET_APPLY_LIMITS.uploadConcurrency);
        expect(maxActive).toBeGreaterThan(1);
        expect(remotePaths.sort()).toEqual(fixture.manifest.storage.objects.map(object => object.path).sort());
        expect(remotePaths.every(path => !path.startsWith("/") && !path.includes(config.backupDir))).toBe(true);
    });

    it("aborts and settles every active upload when an upload times out", async () => {
        const fixture = backupFixture(RESTORE_TARGET_APPLY_LIMITS.uploadConcurrency + 2);
        const outputDir = mkdtempSync(join(tmpdir(), "omr-apply-upload-timeout-"));
        const config = resolveRestoreTargetApplyConfig({
            argv: argv(fixture.backupDir, outputDir), env: env(), cwd: process.cwd(),
            verifyCheckout: () => ({ buildSha: BUILD, boundarySha256: BOUNDARY_SHA256, sourceSha256: "8".repeat(64) }),
        });
        let active = 0;
        let settled = 0;
        await expect(runRestoreTargetApply(config, {
            spawnPsql: passingChild,
            limits: { maxStorageUploadRuntimeMs: 5 },
            uploadStorageObject: async ({ body, signal }: { body: NodeJS.ReadableStream; signal: AbortSignal }) => {
                active += 1;
                try {
                    for await (const chunk of body) { void chunk; /* body remains streaming */ }
                    await new Promise<void>((resolve, reject) => {
                        if (signal.aborted) reject(new Error("aborted"));
                        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
                    });
                } finally {
                    active -= 1;
                    settled += 1;
                }
            },
        })).rejects.toThrow(/timeout|timed out|upload/i);
        expect(active).toBe(0);
        expect(settled).toBeGreaterThan(0);
        expect(() => readFileSync(join(outputDir, ".RESTORE_COMPLETE"))).toThrow();
    });

    it("keeps the exact apply binding INCOMPLETE and never publishes completion on failure", async () => {
        const config = resolveConfig();
        await expect(runRestoreTargetApply(config, {
            spawnPsql: () => { throw new Error("psql failed"); },
        })).rejects.toThrow(/apply|psql|restore/i);
        expect(readFileSync(join(config.outputDir, ".INCOMPLETE"), "utf8")).toContain(config.environmentDigest);
        expect(() => readFileSync(join(config.outputDir, ".RESTORE_COMPLETE"), "utf8")).toThrow();
    });

    it("formats exactly one bounded allowlisted JSON status line", () => {
        const line = formatRestoreApplyStatusLine({
            status: "restored",
            buildSha: BUILD,
            environmentDigest: "a".repeat(64),
            targetDigest: "b".repeat(64),
            backupManifestSha256: "c".repeat(64),
            boundarySha256: BOUNDARY_SHA256,
            targetProjectRefHash: hashProjectRef(TARGET_REF),
            storageObjectCount: 1,
            storageBytes: 4,
            completedAt: "2026-08-10T00:20:00.000Z",
        });
        expect(line.split("\n")).toHaveLength(2);
        expect(JSON.parse(line)).toEqual({
            schemaVersion: 1,
            status: "restored",
            buildSha: BUILD,
            environmentDigest: "a".repeat(64),
            targetDigest: "b".repeat(64),
            backupManifestSha256: "c".repeat(64),
            boundarySha256: BOUNDARY_SHA256,
            targetProjectRefHash: hashProjectRef(TARGET_REF),
            storageObjectCount: 1,
            storageBytes: 4,
            completedAt: "2026-08-10T00:20:00.000Z",
        });
        expect(line).not.toMatch(/service|password|https?:|organizations\//i);
    });
});
