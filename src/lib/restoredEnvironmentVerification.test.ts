import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
    assertPostgres17Version,
    resolveRestoredEnvironmentConfig,
    runRestoredEnvironmentVerification,
} from "../../scripts/verify-restored-environment.mjs";
import {
    RESTORE_TARGET_APPLY_LIMITS,
    RESTORE_BINDING_SOURCE_PATHS,
    createRestoreApplyMarker,
    readRestoreApplyMarker,
} from "../../scripts/restore-target-apply-core.mjs";
import {
    CANONICAL_BACKUP_TABLES,
    REMOTE_ASSET_BUCKET,
    hashProjectRef,
} from "../../scripts/backup-restore-core.mjs";

const SOURCE_REF = "production-source-ref";
const TARGET_REF = "staging-restore-ref";
const BUILD = "c".repeat(40);
const SHA = "d".repeat(64);
const BOUNDARY_SHA256 = "7".repeat(64);
const SERVICE_KEY = "restore-service-role-key-at-least-32-bytes";

function artifact(path: string, body: string) {
    writeFileSync(path, body, { mode: 0o600 });
    return { file: path.split("/").at(-1), bytes: Buffer.byteLength(body), sha256: createHash("sha256").update(body).digest("hex") };
}

function backupFixture(createdAt = "2026-08-07T00:00:00.000Z") {
    const backupDir = mkdtempSync(join(tmpdir(), "omr-restore-backup-"));
    const databaseDir = join(backupDir, "database");
    mkdirSync(databaseDir, { mode: 0o700 });
    const roles = artifact(join(databaseDir, "roles.sql"), "-- roles\n");
    const schema = artifact(join(databaseDir, "schema.sql"), "-- schema\n");
    const data = artifact(join(databaseDir, "data.sql"), "-- data\n");
    const tableCounts = Object.fromEntries(CANONICAL_BACKUP_TABLES.map(table => [table, 0]));
    tableCounts.omr_exams = 2;
    const objects = [{
        path: "organizations/org-1/exams/exam-1/problem/asset-1.pdf",
        bytes: 4,
        sha256: SHA,
        contentType: "application/pdf",
    }];
    const manifest = {
        formatVersion: 1,
        createdAt,
        gitCommit: BUILD,
        sourceProjectRefHash: hashProjectRef(SOURCE_REF),
        database: { roles, schema, data, tableCounts },
        storage: { bucket: REMOTE_ASSET_BUCKET, objectCount: 1, totalBytes: 4, objects },
    };
    writeFileSync(join(backupDir, "manifest.json"), `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
    writeFileSync(join(backupDir, ".COMPLETE"), "complete\n", { mode: 0o600 });
    return { backupDir, manifest };
}

function replaceStorageManifest(
    backupDir: string,
    manifest: ReturnType<typeof backupFixture>["manifest"],
    objects: Array<{ path: string; bytes: number; sha256: string; contentType: string }>,
) {
    const updated = {
        ...manifest,
        storage: {
            ...manifest.storage,
            objectCount: objects.length,
            totalBytes: objects.reduce((sum, object) => sum + object.bytes, 0),
            objects,
        },
    };
    writeFileSync(join(backupDir, "manifest.json"), `${JSON.stringify(updated)}\n`, { mode: 0o600 });
}

function env() {
    return {
        OMR_DEPLOYMENT_TIER: "staging",
        OMR_RESTORE_TARGET_SUPABASE_URL: `https://${TARGET_REF}.supabase.co`,
        OMR_RESTORE_TARGET_APP_URL: "https://restore-staging.example.test",
        OMR_RESTORE_EXPECTED_BUILD: BUILD,
        OMR_RESTORE_EXPECTED_BOUNDARY_SHA256: BOUNDARY_SHA256,
        OMR_PRODUCTION_SUPABASE_URL: `https://${SOURCE_REF}.supabase.co`,
        OMR_PRODUCTION_APP_URL: "https://production.example.test",
        OMR_RESTORE_TARGET_SERVICE_ROLE_KEY: SERVICE_KEY,
        OMR_RESTORE_TARGET_DB_HOST: `db.${TARGET_REF}.supabase.co`,
        OMR_RESTORE_TARGET_DB_PORT: "5432",
        OMR_RESTORE_TARGET_DB_USER: "postgres",
        OMR_RESTORE_TARGET_DB_NAME: "postgres",
        OMR_RESTORE_TARGET_DB_PASSWORD: "restore-db-password",
        OMR_POSTGRES_BIN: "/opt/postgresql-17/bin",
    };
}

function boundaryResult(config: ReturnType<typeof resolveRestoredEnvironmentConfig>, overrides = {}) {
    return {
        status: "passed",
        buildSha: BUILD,
        environmentDigest: config.environmentDigest,
        targetDigest: config.targetDigest,
        verifiedAt: "2026-08-07T00:40:00.000Z",
        artifactSha256: "a".repeat(64),
        ...overrides,
    };
}

function smokeResult(config: ReturnType<typeof resolveRestoredEnvironmentConfig>, overrides = {}) {
    return {
        status: "passed",
        buildSha: BUILD,
        environmentDigest: config.environmentDigest,
        targetDigest: config.targetDigest,
        verifiedAt: "2026-08-07T00:40:00.000Z",
        artifactSha256: "b".repeat(64),
        disposableCredentialsRevoked: true,
        ...overrides,
    };
}

function argv(backupDir: string, output: string) {
    return [
        "--verify",
        `--backup=${backupDir}`,
        `--output=${output}`,
        `--confirm-target-project-ref=${TARGET_REF}`,
        "--started-at=2026-08-07T00:30:00.000Z",
        "--rpo-minutes=60",
        "--rto-minutes=45",
    ];
}

function resolveConfig(input: Parameters<typeof resolveRestoredEnvironmentConfig>[0], verifyCheckout = () => ({
    buildSha: BUILD,
    sourceSha256: "9".repeat(64),
    boundarySha256: BOUNDARY_SHA256,
})) {
    const config = resolveRestoredEnvironmentConfig({ ...input, verifyCheckout });
    const markerPath = join(config.outputPath.slice(0, config.outputPath.lastIndexOf("/")), ".INCOMPLETE");
    if (!existsSync(markerPath)) {
        writeFileSync(markerPath, `${JSON.stringify(createRestoreApplyMarker(config))}\n`, { mode: 0o600, flag: "wx" });
    }
    return config;
}

function canonicalStorageObjects(count: number) {
    return Array.from({ length: count }, (_, index) => ({
        path: `organizations/org-${String(index).padStart(5, "0")}/exams/exam-${String(index).padStart(5, "0")}/problem/asset.pdf`,
        bytes: 1,
        sha256: SHA,
        contentType: "application/pdf",
    }));
}

function withStorageObjects(config: ReturnType<typeof resolveConfig>, objects: ReturnType<typeof canonicalStorageObjects>) {
    const hidden = config as unknown as { database: unknown; serviceRoleKey: string };
    const result = {
        ...config,
        manifest: {
            ...config.manifest,
            storage: {
                bucket: REMOTE_ASSET_BUCKET,
                objectCount: objects.length,
                totalBytes: objects.reduce((total, object) => total + object.bytes, 0),
                objects,
            },
        },
    };
    Object.defineProperties(result, {
        database: { value: hidden.database, enumerable: false },
        serviceRoleKey: { value: hidden.serviceRoleKey, enumerable: false },
    });
    return result;
}

describe("restored staging environment verification", () => {
    it("uses checkout-bound apply and smoke sources without buffering SQL or accepting an external runner", () => {
        const source = readFileSync("scripts/verify-restored-environment.mjs", "utf8");
        const applyCore = readFileSync("scripts/restore-target-apply-core.mjs", "utf8");
        expect(source).toContain("RESTORE_BINDING_SOURCE_PATHS");
        expect(source).toMatch(/async function collectStorageObjectsWithBodies\(config\)[\s\S]{0,300}collectRestoredStorageObjectsWithBodies\(config\)/);
        expect(source).not.toContain("downloadAndHashStorageObjects");
        expect(applyCore).toContain('"scripts/restore-smoke-runner.mjs"');
        expect(applyCore).toContain('"scripts/restore-target-apply-core.mjs"');
        expect(applyCore).toContain('"scripts/run-restored-environment-smoke.mjs"');
        expect(applyCore).toContain('"scripts/storage-backup-gateway.mjs"');
        expect(source).not.toContain("resolveOptionalSmokeRunner");
        expect(source).not.toContain("OMR_RESTORE_SMOKE_RUNNER");
        expect(source).not.toMatch(/for \(const artifact[\s\S]{0,800}readFileSync/);
        expect(source).toMatch(/validateRestoreApplyMarker|readRestoreApplyMarker/);
        expect(RESTORE_BINDING_SOURCE_PATHS).toEqual([
            "scripts/apply-backup-to-restore-target.mjs",
            "scripts/restore-target-apply-core.mjs",
            "scripts/restore-smoke-runner.mjs",
            "scripts/run-restored-environment-smoke.mjs",
            "scripts/verify-restored-environment.mjs",
            "scripts/backup-restore-core.mjs",
            "scripts/storage-backup-gateway.mjs",
            "scripts/strict-json.mjs",
            "supabase/production-server-boundary.sql",
        ]);
    });

    it("uses bounded target-PostgreSQL metadata queries and no recursive Storage list POST", () => {
        const source = readFileSync("scripts/verify-restored-environment.mjs", "utf8");
        expect(source).toContain("collectRestoredStorageMetadataWithPsql");
        expect(source).toContain("buildRestoredStorageMetadataSql");
        expect(source).not.toContain("defaultRestoredStorageListing");
        expect(source).not.toContain("/storage/v1/object/list/");
    });

    it("accepts the exact apply marker from the same verification output directory", () => {
        const { backupDir } = backupFixture();
        const outputDir = mkdtempSync(join(tmpdir(), "omr-restore-binding-roundtrip-"));
        const config = resolveConfig({
            argv: argv(backupDir, join(outputDir, "evidence.json")),
            env: env(),
            cwd: process.cwd(),
            now: new Date("2026-08-07T00:40:00.000Z"),
        });
        expect(readRestoreApplyMarker({ ...config, outputDir })).toEqual(createRestoreApplyMarker(config));
    });

    it("requires PostgreSQL 17 restore verification tools", () => {
        expect(assertPostgres17Version("psql (PostgreSQL) 17.5")).toBe(17);
        expect(() => assertPostgres17Version("psql (PostgreSQL) 16.9")).toThrow(/17/);
        expect(() => assertPostgres17Version("unknown")).toThrow(/17/);
    });

    it("fails closed without staging credentials and emits unverified from the CLI", () => {
        const { backupDir } = backupFixture();
        expect(() => resolveConfig({
            argv: argv(backupDir, join(backupDir, "evidence.json")),
            env: {},
            cwd: process.cwd(),
            now: new Date("2026-08-07T00:40:00.000Z"),
        })).toThrow(/staging|missing|invalid/i);

        const result = spawnSync(process.execPath, ["scripts/verify-restored-environment.mjs"], {
            cwd: process.cwd(),
            env: { NODE_ENV: "test", PATH: process.env.PATH ?? "" },
            encoding: "utf8",
        });
        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout)).toMatchObject({ status: "unverified" });
    });

    it("validates the manifest, artifact hashes, source-target isolation, staging target, RPO and RTO", () => {
        const { backupDir } = backupFixture();
        const output = join(mkdtempSync(join(tmpdir(), "omr-restore-evidence-")), "evidence.json");
        const config = resolveConfig({
            argv: argv(backupDir, output),
            env: env(),
            cwd: process.cwd(),
            now: new Date("2026-08-07T00:40:00.000Z"),
        });

        expect(config).toMatchObject({
            environment: "staging",
            targetProjectRef: TARGET_REF,
            buildSha: BUILD,
            rpoMinutes: 60,
            rtoMinutes: 45,
            outputPath: output,
        });
        expect(config.environmentDigest).toMatch(/^[a-f0-9]{64}$/);
        expect(config.targetDigest).toMatch(/^[a-f0-9]{64}$/);
        expect(config.verifierSourceSha256).toBe("9".repeat(64));
        expect(JSON.stringify(config)).not.toContain(SERVICE_KEY);

        for (const unsafeEnv of [
            { OMR_RESTORE_TARGET_SERVICE_ROLE_KEY: `${SERVICE_KEY}\n` },
            { OMR_RESTORE_TARGET_DB_PASSWORD: "restore-db-password\n" },
            { OMR_RESTORE_TARGET_DB_PORT: "1234" },
            { OMR_PRODUCTION_APP_URL: "https://restore-staging.example.test" },
        ]) {
            expect(() => resolveRestoredEnvironmentConfig({
                argv: argv(backupDir, output), env: { ...env(), ...unsafeEnv }, cwd: process.cwd(),
                now: new Date("2026-08-07T00:40:00.000Z"), verifyCheckout: () => ({
                    buildSha: BUILD, sourceSha256: "9".repeat(64), boundarySha256: BOUNDARY_SHA256,
                }),
            })).toThrow(/invalid|production|credential|target/i);
        }

        const original = join(backupDir, "database", "data.sql");
        const foreign = join(backupDir, "database", "foreign.sql");
        writeFileSync(foreign, "-- data\n", { mode: 0o600 });
        rmSync(original);
        symlinkSync(foreign, original);
        expect(() => resolveRestoredEnvironmentConfig({
            argv: argv(backupDir, output), env: env(), cwd: process.cwd(),
            now: new Date("2026-08-07T00:40:00.000Z"), verifyCheckout: () => ({
                buildSha: BUILD, sourceSha256: "9".repeat(64), boundarySha256: BOUNDARY_SHA256,
            }),
        })).toThrow(/artifact|link|invalid/i);
    });

    it.each([
        ["object count", () => Array.from(
            { length: RESTORE_TARGET_APPLY_LIMITS.maxStorageObjects + 1 },
            (_, index) => ({
                path: `organizations/org-1/exams/exam-1/problem/${index}.pdf`,
                bytes: 1,
                sha256: SHA,
                contentType: "application/pdf",
            }),
        )],
        ["per-object bytes", () => [{
            path: "organizations/org-1/exams/exam-1/problem/oversized.pdf",
            bytes: RESTORE_TARGET_APPLY_LIMITS.maxStorageObjectBytes + 1,
            sha256: SHA,
            contentType: "application/pdf",
        }]],
        ["aggregate bytes", () => Array.from(
            { length: Math.floor(
                RESTORE_TARGET_APPLY_LIMITS.maxStorageAggregateBytes
                / RESTORE_TARGET_APPLY_LIMITS.maxStorageObjectBytes,
            ) + 1 },
            (_, index) => ({
                path: `organizations/org-1/exams/exam-1/problem/aggregate-${index}.pdf`,
                bytes: RESTORE_TARGET_APPLY_LIMITS.maxStorageObjectBytes,
                sha256: SHA,
                contentType: "application/pdf",
            }),
        )],
    ])("enforces the shared restore apply Storage %s bound while resolving verifier config", (_label, buildObjects) => {
        const { backupDir, manifest } = backupFixture();
        replaceStorageManifest(backupDir, manifest, buildObjects());
        const output = join(mkdtempSync(join(tmpdir(), "omr-restore-storage-bounds-")), "evidence.json");
        expect(() => resolveConfig({
            argv: argv(backupDir, output),
            env: env(),
            cwd: process.cwd(),
            now: new Date("2026-08-07T00:40:00.000Z"),
        })).toThrow(/Storage|bound|count|aggregate/i);
    });

    it("rejects a verifier checkout or source set that is not the exact restored build", () => {
        const { backupDir } = backupFixture();
        const input = {
            argv: argv(backupDir, join(mkdtempSync(join(tmpdir(), "omr-restore-identity-")), "evidence.json")),
            env: env(),
            cwd: process.cwd(),
            now: new Date("2026-08-07T00:40:00.000Z"),
        };

        expect(() => resolveConfig(input, () => ({
            buildSha: "e".repeat(40),
            sourceSha256: "9".repeat(64),
            boundarySha256: BOUNDARY_SHA256,
        }))).toThrow(/checkout|build|source/i);
        expect(() => resolveConfig(input, () => ({
            buildSha: BUILD,
            sourceSha256: "not-a-digest",
            boundarySha256: BOUNDARY_SHA256,
        }))).toThrow(/checkout|build|source/i);
    });

    it("rejects a symlinked completion marker", () => {
        const { backupDir } = backupFixture();
        rmSync(join(backupDir, ".COMPLETE"));
        symlinkSync(join(backupDir, "manifest.json"), join(backupDir, ".COMPLETE"));
        expect(() => resolveConfig({
            argv: argv(backupDir, join(backupDir, "evidence.json")),
            env: env(),
            cwd: process.cwd(),
            now: new Date("2026-08-07T00:40:00.000Z"),
        })).toThrow(/completion|marker|backup/i);
    });

    it.each([
        ["source target", `https://${SOURCE_REF}.supabase.co`, TARGET_REF],
        ["production target", `https://${TARGET_REF}.supabase.co`, TARGET_REF],
        ["non-staging tier", `https://${TARGET_REF}.supabase.co`, TARGET_REF, "production"],
    ])("rejects unsafe %s reuse", (_label, targetUrl, confirmedRef, tier = "staging") => {
        const { backupDir } = backupFixture();
        const unsafeEnv = {
            ...env(),
            OMR_DEPLOYMENT_TIER: tier,
            OMR_RESTORE_TARGET_SUPABASE_URL: targetUrl,
            OMR_PRODUCTION_SUPABASE_URL: `https://${TARGET_REF}.supabase.co`,
        };
        expect(() => resolveConfig({
            argv: argv(backupDir, join(backupDir, "evidence.json")).map(item => item.startsWith("--confirm-target")
                ? `--confirm-target-project-ref=${confirmedRef}` : item),
            env: unsafeEnv,
            cwd: process.cwd(),
            now: new Date("2026-08-07T00:40:00.000Z"),
        })).toThrow();
    });

    it("compares exact database counts and downloaded storage body hashes before writing evidence", async () => {
        const { backupDir, manifest } = backupFixture();
        const output = join(mkdtempSync(join(tmpdir(), "omr-restore-run-")), "evidence.json");
        const config = resolveConfig({
            argv: argv(backupDir, output),
            env: env(),
            cwd: process.cwd(),
            now: new Date("2026-08-07T00:40:00.000Z"),
        });
        const result = await runRestoredEnvironmentVerification(config, {
            now: () => new Date("2026-08-07T00:40:00.000Z"),
            collectTableCounts: async () => manifest.database.tableCounts,
            collectStorageObjects: async () => manifest.storage.objects,
            runBoundaryContract: async () => boundaryResult(config),
            runBrowserSmoke: async () => smokeResult(config),
        });

        expect(result).toMatchObject({
            status: "verified",
            environment: "staging",
            buildSha: BUILD,
            environmentDigest: config.environmentDigest,
            targetDigest: config.targetDigest,
            verifierSourceSha256: "9".repeat(64),
            databaseTableCount: CANONICAL_BACKUP_TABLES.length,
            storageObjectCount: 1,
            rpoMinutes: 60,
            rtoMinutes: 45,
            boundaryContract: "passed",
            boundaryArtifactSha256: "a".repeat(64),
            browserSmoke: "passed",
            browserSmokeArtifactSha256: "b".repeat(64),
            disposableCredentialsRevoked: true,
            completeMarker: ".RESTORE_COMPLETE",
        });
        expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(result);
        expect(statSync(join(output.slice(0, output.lastIndexOf("/")), ".RESTORE_COMPLETE")).mode & 0o777).toBe(0o600);
        expect(existsSync(join(output.slice(0, output.lastIndexOf("/")), ".INCOMPLETE"))).toBe(false);
        expect(JSON.stringify(result)).not.toContain(TARGET_REF);
        expect(JSON.stringify(result)).not.toContain("restore-staging.example.test");

        const countMismatchOutput = join(mkdtempSync(join(tmpdir(), "omr-restore-count-mismatch-")), "evidence.json");
        const countMismatchConfig = resolveConfig({
            argv: argv(backupDir, countMismatchOutput),
            env: env(),
            cwd: process.cwd(),
            now: new Date("2026-08-07T00:40:00.000Z"),
        });
        await expect(runRestoredEnvironmentVerification(countMismatchConfig, {
            now: () => new Date("2026-08-07T00:40:00.000Z"),
            collectTableCounts: async () => ({ ...manifest.database.tableCounts, omr_exams: 1 }),
            collectStorageObjects: async () => manifest.storage.objects,
            runBoundaryContract: async () => boundaryResult(countMismatchConfig),
            runBrowserSmoke: async () => smokeResult(countMismatchConfig),
        })).rejects.toThrow(/inventory|mismatch/i);
        const hashMismatchOutput = join(mkdtempSync(join(tmpdir(), "omr-restore-hash-mismatch-")), "evidence.json");
        const hashMismatchConfig = resolveConfig({
            argv: argv(backupDir, hashMismatchOutput),
            env: env(),
            cwd: process.cwd(),
            now: new Date("2026-08-07T00:40:00.000Z"),
        });
        await expect(runRestoredEnvironmentVerification(hashMismatchConfig, {
            now: () => new Date("2026-08-07T00:40:00.000Z"),
            collectTableCounts: async () => manifest.database.tableCounts,
            collectStorageObjects: async () => [{ ...manifest.storage.objects[0], sha256: "e".repeat(64) }],
            runBoundaryContract: async () => boundaryResult(hashMismatchConfig),
            runBrowserSmoke: async () => smokeResult(hashMismatchConfig),
        })).rejects.toThrow(/inventory|mismatch/i);
    });

    it("streams restored Storage bodies with bounded concurrency without arrayBuffer materialization", async () => {
        const verifier = await import("../../scripts/verify-restored-environment.mjs") as unknown as {
            collectRestoredStorageObjectsWithBodies?: (config: unknown, options: {
                listObjects: (input: { signal: AbortSignal }) => Promise<unknown[]>;
                fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
                requestTimeoutMs: number;
                concurrency: number;
            }) => Promise<unknown[]>;
        };
        expect(verifier.collectRestoredStorageObjectsWithBodies).toBeTypeOf("function");
        const { backupDir } = backupFixture();
        const output = join(mkdtempSync(join(tmpdir(), "omr-restore-storage-stream-")), "evidence.json");
        const config = resolveConfig({ argv: argv(backupDir, output), env: env(), cwd: process.cwd(), now: new Date("2026-08-07T00:40:00.000Z") });
        const bodies = new Map([
            ["organizations/org-1/exams/exam-1/problem/a.pdf", Buffer.from("alpha")],
            ["organizations/org-1/exams/exam-1/problem/b.pdf", Buffer.from("beta")],
        ]);
        const objects = [...bodies].map(([path, body]) => ({
            path,
            bytes: body.byteLength,
            sha256: createHash("sha256").update(body).digest("hex"),
            contentType: "application/pdf",
        }));
        const storageConfig = {
            ...config,
            manifest: {
                ...config.manifest,
                storage: { bucket: REMOTE_ASSET_BUCKET, objectCount: 2, totalBytes: 9, objects },
            },
        };
        let active = 0;
        let maxActive = 0;
        let arrayBufferCalled = false;
        const result = await verifier.collectRestoredStorageObjectsWithBodies!(storageConfig, {
            listObjects: async ({ signal }) => {
                expect(signal).toBeInstanceOf(AbortSignal);
                return objects;
            },
            fetchImpl: async (input, init) => {
                expect(init?.signal).toBeInstanceOf(AbortSignal);
                const path = decodeURIComponent(new URL(String(input)).pathname.split(`/${REMOTE_ASSET_BUCKET}/`)[1]);
                const body = bodies.get(path)!;
                const response = new Response(new ReadableStream<Uint8Array>({
                    start(controller) {
                        active += 1;
                        maxActive = Math.max(maxActive, active);
                        setTimeout(() => {
                            controller.enqueue(body);
                            controller.close();
                            active -= 1;
                        }, 2);
                    },
                    cancel() { active -= 1; },
                }), { status: 200, headers: { "content-type": "application/pdf", "content-length": String(body.byteLength) } });
                Object.defineProperty(response, "arrayBuffer", { value: async () => {
                    arrayBufferCalled = true;
                    throw new Error("arrayBuffer must not be called");
                } });
                return response;
            },
            requestTimeoutMs: 500,
            concurrency: 2,
        });
        expect(result).toEqual(objects);
        expect(maxActive).toBeLessThanOrEqual(2);
        expect(active).toBe(0);
        expect(arrayBufferCalled).toBe(false);
    });

    it("queries default PostgreSQL metadata before and after body GET with zero Storage list POSTs", async () => {
        const verifier = await import("../../scripts/verify-restored-environment.mjs") as unknown as {
            collectRestoredStorageObjectsWithBodies?: (config: unknown, options: Record<string, unknown>) => Promise<unknown[]>;
        };
        expect(verifier.collectRestoredStorageObjectsWithBodies).toBeTypeOf("function");
        const { backupDir } = backupFixture();
        const output = join(mkdtempSync(join(tmpdir(), "omr-restore-storage-pg-metadata-")), "evidence.json");
        const config = resolveConfig({ argv: argv(backupDir, output), env: env(), cwd: process.cwd(), now: new Date("2026-08-07T00:40:00.000Z") });
        const body = Buffer.from("body");
        const object = {
            ...config.manifest.storage.objects[0],
            sha256: createHash("sha256").update(body).digest("hex"),
        };
        const storageConfig = withStorageObjects(config, [object]);
        let queryCount = 0;
        let listPostCount = 0;
        let objectGetCount = 0;

        const result = await verifier.collectRestoredStorageObjectsWithBodies!(storageConfig, {
            psqlExecFileSync: (_file: string, args: string[]) => {
                if (args[0] === "--version") return "psql (PostgreSQL) 17.5\n";
                queryCount += 1;
                return `${JSON.stringify([object])}\n`;
            },
            fetchImpl: async (_input: string | URL | Request, init?: RequestInit) => {
                if (init?.method === "POST") {
                    listPostCount += 1;
                    throw new Error("Storage list POST is forbidden");
                }
                objectGetCount += 1;
                return new Response(body, {
                    status: 200,
                    headers: { "content-type": "application/pdf", "content-length": String(body.byteLength) },
                });
            },
            requestTimeoutMs: 500,
            operationTimeoutMs: 1_000,
        });
        expect(result).toEqual([object]);
        expect(queryCount).toBe(2);
        expect(listPostCount).toBe(0);
        expect(objectGetCount).toBe(1);
    });

    it.each([
        ["extra object", (object: ReturnType<typeof canonicalStorageObjects>[number]) => [
            object,
            { ...object, path: "organizations/org-extra/exams/exam-extra/problem/asset.pdf" },
        ]],
        ["deleted object", () => []],
        ["mutated metadata", (object: ReturnType<typeof canonicalStorageObjects>[number]) => [{
            ...object,
            sha256: "e".repeat(64),
        }]],
    ])("rejects a restored Storage %s appearing during streamed body verification", async (_label, secondSnapshot) => {
        const verifier = await import("../../scripts/verify-restored-environment.mjs") as unknown as {
            collectRestoredStorageObjectsWithBodies?: (config: unknown, options: Record<string, unknown>) => Promise<unknown[]>;
        };
        expect(verifier.collectRestoredStorageObjectsWithBodies).toBeTypeOf("function");
        const { backupDir } = backupFixture();
        const output = join(mkdtempSync(join(tmpdir(), "omr-restore-storage-metadata-drift-")), "evidence.json");
        const config = resolveConfig({ argv: argv(backupDir, output), env: env(), cwd: process.cwd(), now: new Date("2026-08-07T00:40:00.000Z") });
        const body = Buffer.from("body");
        const object = {
            ...config.manifest.storage.objects[0],
            sha256: createHash("sha256").update(body).digest("hex"),
        };
        const storageConfig = withStorageObjects(config, [object]);
        let metadataQueries = 0;
        let bodyDownloaded = false;

        await expect(verifier.collectRestoredStorageObjectsWithBodies!(storageConfig, {
            listObjects: async () => {
                metadataQueries += 1;
                if (metadataQueries === 1) return [object];
                expect(bodyDownloaded).toBe(true);
                return secondSnapshot(object);
            },
            fetchImpl: async () => {
                bodyDownloaded = true;
                return new Response(body, {
                    status: 200,
                    headers: { "content-type": "application/pdf", "content-length": String(body.byteLength) },
                });
            },
            requestTimeoutMs: 500,
            operationTimeoutMs: 1_000,
        })).rejects.toThrow(/Storage|metadata|inventory|mismatch/i);
        expect(metadataQueries).toBe(2);
        expect(bodyDownloaded).toBe(true);
    });

    it.each([2_500, RESTORE_TARGET_APPLY_LIMITS.maxStorageObjects])(
        "collects %i canonical Storage metadata rows with exactly one bounded PostgreSQL query",
        async (count) => {
            const verifier = await import("../../scripts/verify-restored-environment.mjs") as unknown as {
                collectRestoredStorageMetadataWithPsql?: (config: unknown, options: Record<string, unknown>) => Promise<unknown[]>;
            };
            expect(verifier.collectRestoredStorageMetadataWithPsql).toBeTypeOf("function");
            const { backupDir } = backupFixture();
            const output = join(mkdtempSync(join(tmpdir(), "omr-restore-storage-pg-count-")), "evidence.json");
            const config = resolveConfig({ argv: argv(backupDir, output), env: env(), cwd: process.cwd(), now: new Date("2026-08-07T00:40:00.000Z") });
            const objects = canonicalStorageObjects(count);
            const storageConfig = withStorageObjects(config, objects);
            let queryCount = 0;
            let queryOptions: Record<string, unknown> | undefined;

            const result = await verifier.collectRestoredStorageMetadataWithPsql!(storageConfig, {
                execFileSync: (_file: string, args: string[], options: Record<string, unknown>) => {
                    if (args[0] === "--version") return "psql (PostgreSQL) 17.5\n";
                    queryCount += 1;
                    queryOptions = options;
                    return `${JSON.stringify(objects)}\n`;
                },
            });

            expect(result).toEqual(objects);
            expect(queryCount).toBe(1);
            expect(queryOptions).toMatchObject({
                encoding: "utf8",
                timeout: expect.any(Number),
                maxBuffer: expect.any(Number),
                stdio: ["ignore", "pipe", "ignore"],
            });
            expect(queryOptions?.timeout).toBeLessThanOrEqual(60_000);
            expect(queryOptions?.maxBuffer).toBeLessThanOrEqual(RESTORE_TARGET_APPLY_LIMITS.maxManifestBytes);
        },
    );

    it("builds one schema-qualified, bucket-scoped, stably ordered bounded metadata query", async () => {
        const verifier = await import("../../scripts/verify-restored-environment.mjs") as unknown as {
            buildRestoredStorageMetadataSql?: () => string;
        };
        expect(verifier.buildRestoredStorageMetadataSql).toBeTypeOf("function");
        const sql = verifier.buildRestoredStorageMetadataSql!();
        expect(sql).toMatch(/from\s+storage\.objects\s+as\s+object/i);
        expect(sql).toMatch(/object\.bucket_id\s*=\s*'omr-private-assets'/i);
        expect(sql).toMatch(/order\s+by\s+object\.name\s+collate\s+"C"/i);
        expect(sql).toMatch(/limit\s+10001/i);
        expect(sql).toContain("statement_timeout");
        expect(sql).toContain("lock_timeout");
        for (const key of ["path", "bytes", "sha256", "contentType"]) expect(sql).toContain(`'${key}'`);
        expect(sql).not.toMatch(/select\s+\*/i);
    });

    it("aborts and settles every restored Storage worker on an oversized body", async () => {
        const verifier = await import("../../scripts/verify-restored-environment.mjs") as unknown as {
            collectRestoredStorageObjectsWithBodies?: (config: unknown, options: Record<string, unknown>) => Promise<unknown[]>;
        };
        expect(verifier.collectRestoredStorageObjectsWithBodies).toBeTypeOf("function");
        const { backupDir } = backupFixture();
        const output = join(mkdtempSync(join(tmpdir(), "omr-restore-storage-oversize-")), "evidence.json");
        const config = resolveConfig({ argv: argv(backupDir, output), env: env(), cwd: process.cwd(), now: new Date("2026-08-07T00:40:00.000Z") });
        const object = config.manifest.storage.objects[0];
        let active = 0;
        let cancelled = 0;
        await expect(verifier.collectRestoredStorageObjectsWithBodies!(config, {
            listObjects: async () => [object],
            fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
                start(controller) {
                    active += 1;
                    controller.enqueue(Buffer.from("oversized"));
                },
                cancel() {
                    cancelled += 1;
                    active -= 1;
                },
            }), { status: 200, headers: { "content-type": "application/pdf" } }),
            requestTimeoutMs: 500,
            concurrency: 2,
        })).rejects.toThrow(/Storage|body|bytes|size|bound/i);
        expect(cancelled).toBe(1);
        expect(active).toBe(0);
    });

    it("aborts and joins a stalled restored Storage listing request", async () => {
        const verifier = await import("../../scripts/verify-restored-environment.mjs") as unknown as {
            collectRestoredStorageObjectsWithBodies?: (config: unknown, options: Record<string, unknown>) => Promise<unknown[]>;
        };
        expect(verifier.collectRestoredStorageObjectsWithBodies).toBeTypeOf("function");
        const { backupDir } = backupFixture();
        const output = join(mkdtempSync(join(tmpdir(), "omr-restore-storage-timeout-")), "evidence.json");
        const config = resolveConfig({ argv: argv(backupDir, output), env: env(), cwd: process.cwd(), now: new Date("2026-08-07T00:40:00.000Z") });
        let active = 0;
        const verification = verifier.collectRestoredStorageObjectsWithBodies!(config, {
            listObjects: ({ signal }: { signal: AbortSignal }) => new Promise((_, reject) => {
                active += 1;
                signal.addEventListener("abort", () => {
                    active -= 1;
                    reject(new Error("aborted"));
                }, { once: true });
            }),
            fetchImpl: async () => { throw new Error("download must not start"); },
            requestTimeoutMs: 10,
            concurrency: 2,
        });
        await expect(Promise.race([
            verification,
            new Promise((_, reject) => setTimeout(() => reject(new Error("test deadline")), 200)),
        ])).rejects.toThrow(/Storage|timeout|timed out/i);
        expect(active).toBe(0);
    });

    it("bounds the aggregate restored Storage listing-plus-download operation", async () => {
        const verifier = await import("../../scripts/verify-restored-environment.mjs") as unknown as {
            collectRestoredStorageObjectsWithBodies?: (config: unknown, options: Record<string, unknown>) => Promise<unknown[]>;
        };
        expect(verifier.collectRestoredStorageObjectsWithBodies).toBeTypeOf("function");
        const { backupDir } = backupFixture();
        const output = join(mkdtempSync(join(tmpdir(), "omr-restore-storage-operation-timeout-")), "evidence.json");
        const config = resolveConfig({ argv: argv(backupDir, output), env: env(), cwd: process.cwd(), now: new Date("2026-08-07T00:40:00.000Z") });
        const body = Buffer.from("body");
        const object = {
            ...config.manifest.storage.objects[0],
            sha256: createHash("sha256").update(body).digest("hex"),
        };
        const storageConfig = {
            ...config,
            manifest: {
                ...config.manifest,
                storage: { ...config.manifest.storage, objects: [object] },
            },
        };
        let active = 0;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const verification = verifier.collectRestoredStorageObjectsWithBodies!(storageConfig, {
            listObjects: async () => [object],
            fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
                start(controller) {
                    active += 1;
                    timer = setTimeout(() => {
                        controller.enqueue(body);
                        controller.close();
                        active -= 1;
                    }, 50);
                },
                cancel() {
                    if (timer) clearTimeout(timer);
                    active -= 1;
                },
            }), { status: 200, headers: { "content-type": "application/pdf", "content-length": "4" } }),
            requestTimeoutMs: 500,
            operationTimeoutMs: 10,
            concurrency: 1,
        });
        await expect(verification).rejects.toThrow(/Storage|operation|timeout|timed out/i);
        expect(active).toBe(0);
    });

    it.each([
        ["query failure", () => { throw new Error("database secret output"); }],
        ["oversized output", () => " ".repeat(RESTORE_TARGET_APPLY_LIMITS.maxManifestBytes + 1)],
        ["malformed JSON", () => "[{bad-json]"],
    ])("sanitizes a PostgreSQL metadata %s and removes its private credential file", async (_label, queryResult) => {
        const verifier = await import("../../scripts/verify-restored-environment.mjs") as unknown as {
            collectRestoredStorageMetadataWithPsql?: (config: unknown, options: Record<string, unknown>) => Promise<unknown[]>;
        };
        expect(verifier.collectRestoredStorageMetadataWithPsql).toBeTypeOf("function");
        const { backupDir } = backupFixture();
        const output = join(mkdtempSync(join(tmpdir(), "omr-restore-storage-pg-failure-")), "evidence.json");
        const config = resolveConfig({ argv: argv(backupDir, output), env: env(), cwd: process.cwd(), now: new Date("2026-08-07T00:40:00.000Z") });
        let passFile: string | undefined;

        await expect(verifier.collectRestoredStorageMetadataWithPsql!(config, {
            execFileSync: (_file: string, args: string[], options: { env?: Record<string, string> }) => {
                if (args[0] === "--version") return "psql (PostgreSQL) 17.5\n";
                passFile = options.env?.PGPASSFILE;
                return queryResult();
            },
        })).rejects.toThrow("Restored Storage metadata collection failed");
        expect(passFile).toBeTypeOf("string");
        expect(existsSync(passFile!)).toBe(false);
    });

    it.each([
        ["unknown key", (objects: ReturnType<typeof canonicalStorageObjects>) => [{ ...objects[0], unexpected: true }]],
        ["missing key", (objects: ReturnType<typeof canonicalStorageObjects>) => [{ path: objects[0].path, bytes: 1, contentType: "application/pdf" }]],
        ["wrong SHA", (objects: ReturnType<typeof canonicalStorageObjects>) => [{ ...objects[0], sha256: "e".repeat(64) }]],
        ["out-of-order rows", (objects: ReturnType<typeof canonicalStorageObjects>) => [objects[1], objects[0]]],
        ["extra row beyond the maximum", () => canonicalStorageObjects(RESTORE_TARGET_APPLY_LIMITS.maxStorageObjects + 1)],
    ])("rejects PostgreSQL metadata with %s and cleans up", async (_label, buildObserved) => {
        const verifier = await import("../../scripts/verify-restored-environment.mjs") as unknown as {
            collectRestoredStorageMetadataWithPsql?: (config: unknown, options: Record<string, unknown>) => Promise<unknown[]>;
        };
        expect(verifier.collectRestoredStorageMetadataWithPsql).toBeTypeOf("function");
        const { backupDir } = backupFixture();
        const output = join(mkdtempSync(join(tmpdir(), "omr-restore-storage-pg-shape-")), "evidence.json");
        const config = resolveConfig({ argv: argv(backupDir, output), env: env(), cwd: process.cwd(), now: new Date("2026-08-07T00:40:00.000Z") });
        const expected = canonicalStorageObjects(_label === "out-of-order rows" ? 2 : Math.min(RESTORE_TARGET_APPLY_LIMITS.maxStorageObjects, 1));
        const storageConfig = withStorageObjects(config, expected);
        const observed = buildObserved(expected);
        let passFile: string | undefined;

        await expect(verifier.collectRestoredStorageMetadataWithPsql!(storageConfig, {
            execFileSync: (_file: string, args: string[], options: { env?: Record<string, string> }) => {
                if (args[0] === "--version") return "psql (PostgreSQL) 17.5\n";
                passFile = options.env?.PGPASSFILE;
                return JSON.stringify(observed);
            },
        })).rejects.toThrow(/Storage metadata|inventory|collection/i);
        expect(passFile).toBeTypeOf("string");
        expect(existsSync(passFile!)).toBe(false);
    });

    it.each([
        ["non-200", 503, "application/pdf", null],
        ["wrong MIME", 200, "text/plain", null],
        ["oversized Content-Length", 200, "application/pdf", "5"],
    ])("cancels a %s restored Storage object response body", async (_label, status, contentType, contentLength) => {
        const verifier = await import("../../scripts/verify-restored-environment.mjs") as unknown as {
            collectRestoredStorageObjectsWithBodies?: (config: unknown, options: Record<string, unknown>) => Promise<unknown[]>;
        };
        const { backupDir } = backupFixture();
        const output = join(mkdtempSync(join(tmpdir(), "omr-restore-storage-object-body-")), "evidence.json");
        const config = resolveConfig({ argv: argv(backupDir, output), env: env(), cwd: process.cwd(), now: new Date("2026-08-07T00:40:00.000Z") });
        const object = config.manifest.storage.objects[0];
        let active = 0;
        let cancelled = 0;
        await expect(verifier.collectRestoredStorageObjectsWithBodies!(config, {
            listObjects: async () => [object],
            fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
                start() { active += 1; },
                cancel() { active -= 1; cancelled += 1; },
            }), {
                status,
                headers: {
                    "content-type": contentType,
                    ...(contentLength === null ? {} : { "content-length": contentLength }),
                },
            }),
            requestTimeoutMs: 500,
            operationTimeoutMs: 1_000,
        })).rejects.toThrow(/Storage|object|bound|response/i);
        expect(cancelled).toBe(1);
        expect(active).toBe(0);
    });

    it("rechecks the RTO after inventory collection completes", async () => {
        const { backupDir, manifest } = backupFixture();
        const output = join(mkdtempSync(join(tmpdir(), "omr-restore-rto-")), "evidence.json");
        const config = resolveConfig({
            argv: argv(backupDir, output),
            env: env(),
            cwd: process.cwd(),
            now: new Date("2026-08-07T00:40:00.000Z"),
        });
        const times = [
            new Date("2026-08-07T00:40:00.000Z"),
            new Date("2026-08-07T01:20:00.000Z"),
        ];
        await expect(runRestoredEnvironmentVerification(config, {
            now: () => times.shift()!,
            collectTableCounts: async () => manifest.database.tableCounts,
            collectStorageObjects: async () => manifest.storage.objects,
            runBoundaryContract: async () => boundaryResult(config),
            runBrowserSmoke: async () => smokeResult(config),
        })).rejects.toThrow(/RTO/i);
    });

    it("rejects replacement of the exact apply marker after the final smoke and RTO gates", async () => {
        const { backupDir, manifest } = backupFixture();
        const outputDir = mkdtempSync(join(tmpdir(), "omr-restore-marker-race-"));
        const output = join(outputDir, "evidence.json");
        const config = resolveConfig({
            argv: argv(backupDir, output),
            env: env(),
            cwd: process.cwd(),
            now: new Date("2026-08-07T00:40:00.000Z"),
        });
        const markerPath = join(outputDir, ".INCOMPLETE");

        await expect(runRestoredEnvironmentVerification(config, {
            now: () => new Date("2026-08-07T00:40:00.000Z"),
            collectTableCounts: async () => manifest.database.tableCounts,
            collectStorageObjects: async () => manifest.storage.objects,
            runBoundaryContract: async () => boundaryResult(config),
            runBrowserSmoke: async () => {
                const exactBody = readFileSync(markerPath);
                rmSync(markerPath);
                writeFileSync(markerPath, exactBody, { mode: 0o600, flag: "wx" });
                return smokeResult(config);
            },
        })).rejects.toThrow(/marker|publication|verified/i);
        expect(existsSync(join(outputDir, ".RESTORE_COMPLETE"))).toBe(false);
        expect(existsSync(markerPath)).toBe(true);
        expect(existsSync(output)).toBe(false);
    });

    it("fails closed when the RTO boundary is crossed while completion is being published", async () => {
        const { backupDir, manifest } = backupFixture();
        const outputDir = mkdtempSync(join(tmpdir(), "omr-restore-publication-rto-"));
        const output = join(outputDir, "evidence.json");
        const config = resolveConfig({
            argv: argv(backupDir, output),
            env: env(),
            cwd: process.cwd(),
            now: new Date("2026-08-07T00:40:00.000Z"),
        });
        const times = [
            new Date("2026-08-07T00:40:00.000Z"),
            new Date("2026-08-07T00:40:00.000Z"),
            new Date("2026-08-07T01:15:00.001Z"),
        ];

        await expect(runRestoredEnvironmentVerification(config, {
            now: () => times.shift()!,
            collectTableCounts: async () => manifest.database.tableCounts,
            collectStorageObjects: async () => manifest.storage.objects,
            runBoundaryContract: async () => boundaryResult(config),
            runBrowserSmoke: async () => smokeResult(config),
        })).rejects.toThrow(/RTO|publication|verified/i);
        expect(existsSync(join(outputDir, ".RESTORE_COMPLETE"))).toBe(false);
        expect(existsSync(join(outputDir, ".INCOMPLETE"))).toBe(true);
        expect(existsSync(output)).toBe(false);
    });

    it("rejects same-content apply-marker inode replacement inside atomic publication", async () => {
        const { backupDir, manifest } = backupFixture();
        const outputDir = mkdtempSync(join(tmpdir(), "omr-restore-publication-marker-race-"));
        const output = join(outputDir, "evidence.json");
        const config = resolveConfig({
            argv: argv(backupDir, output),
            env: env(),
            cwd: process.cwd(),
            now: new Date("2026-08-07T00:40:00.000Z"),
        });
        const markerPath = join(outputDir, ".INCOMPLETE");

        await expect(runRestoredEnvironmentVerification(config, {
            now: () => new Date("2026-08-07T00:40:00.000Z"),
            collectTableCounts: async () => manifest.database.tableCounts,
            collectStorageObjects: async () => manifest.storage.objects,
            runBoundaryContract: async () => boundaryResult(config),
            runBrowserSmoke: async () => smokeResult(config),
            beforeCompletionPromotion: async () => {
                const exactBody = readFileSync(markerPath);
                rmSync(markerPath);
                writeFileSync(markerPath, exactBody, { mode: 0o600, flag: "wx" });
            },
        })).rejects.toThrow(/marker|publication|verified/i);
        expect(existsSync(join(outputDir, ".RESTORE_COMPLETE"))).toBe(false);
        expect(existsSync(markerPath)).toBe(true);
        expect(existsSync(output)).toBe(false);
    });

    it("records the exact under-RTO publication fence as authoritative evidence time", async () => {
        const { backupDir, manifest } = backupFixture();
        const outputDir = mkdtempSync(join(tmpdir(), "omr-restore-publication-time-"));
        const output = join(outputDir, "evidence.json");
        const config = resolveConfig({
            argv: argv(backupDir, output),
            env: env(),
            cwd: process.cwd(),
            now: new Date("2026-08-07T00:40:00.000Z"),
        });
        const times = [
            new Date("2026-08-07T00:40:00.000Z"),
            new Date("2026-08-07T00:41:00.000Z"),
            new Date("2026-08-07T00:42:00.000Z"),
            new Date("2026-08-07T00:44:00.000Z"),
            new Date("2026-08-07T00:45:00.000Z"),
        ];
        const result = await runRestoredEnvironmentVerification(config, {
            now: () => times.shift()!,
            collectTableCounts: async () => manifest.database.tableCounts,
            collectStorageObjects: async () => manifest.storage.objects,
            runBoundaryContract: async () => boundaryResult(config),
            runBrowserSmoke: async () => smokeResult(config),
            afterCompletionPromotion: async () => undefined,
        });
        expect(result.verifiedAt).toBe("2026-08-07T00:44:00.000Z");
        expect(result.recoveryMinutes).toBe(14);
        expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(result);
        expect(JSON.parse(readFileSync(join(outputDir, ".RESTORE_COMPLETE"), "utf8")))
            .toMatchObject({ verifiedAt: result.verifiedAt });
    });

    it("rolls publication back when the post-rename fsync verification crosses RTO", async () => {
        const { backupDir, manifest } = backupFixture();
        const outputDir = mkdtempSync(join(tmpdir(), "omr-restore-post-publication-rto-"));
        const output = join(outputDir, "evidence.json");
        const config = resolveConfig({
            argv: argv(backupDir, output),
            env: env(),
            cwd: process.cwd(),
            now: new Date("2026-08-07T00:40:00.000Z"),
        });
        const times = [
            new Date("2026-08-07T00:40:00.000Z"),
            new Date("2026-08-07T00:41:00.000Z"),
            new Date("2026-08-07T00:42:00.000Z"),
            new Date("2026-08-07T00:44:00.000Z"),
            new Date("2026-08-07T01:15:00.001Z"),
        ];
        await expect(runRestoredEnvironmentVerification(config, {
            now: () => times.shift()!,
            collectTableCounts: async () => manifest.database.tableCounts,
            collectStorageObjects: async () => manifest.storage.objects,
            runBoundaryContract: async () => boundaryResult(config),
            runBrowserSmoke: async () => smokeResult(config),
            afterCompletionPromotion: async () => undefined,
        })).rejects.toThrow(/RTO|publication|verified/i);
        expect(existsSync(join(outputDir, ".RESTORE_COMPLETE"))).toBe(false);
        expect(existsSync(join(outputDir, ".INCOMPLETE"))).toBe(true);
        expect(existsSync(output)).toBe(false);
    });

    it.each([
        ["boundary", (config: ReturnType<typeof resolveRestoredEnvironmentConfig>) => ({
            runBoundaryContract: async () => boundaryResult(config, { buildSha: "e".repeat(40) }),
            runBrowserSmoke: async () => smokeResult(config),
        })],
        ["browser", (config: ReturnType<typeof resolveRestoredEnvironmentConfig>) => ({
            runBoundaryContract: async () => boundaryResult(config),
            runBrowserSmoke: async () => smokeResult(config, { targetDigest: "f".repeat(64) }),
        })],
        ["revocation", (config: ReturnType<typeof resolveRestoredEnvironmentConfig>) => ({
            runBoundaryContract: async () => boundaryResult(config),
            runBrowserSmoke: async () => smokeResult(config, { disposableCredentialsRevoked: false }),
        })],
    ])("keeps INCOMPLETE and publishes no completion marker when %s is unverified", async (_label, runners) => {
        const { backupDir, manifest } = backupFixture();
        const outputDir = mkdtempSync(join(tmpdir(), "omr-restore-gate-"));
        const output = join(outputDir, "evidence.json");
        const config = resolveConfig({
            argv: argv(backupDir, output),
            env: env(),
            cwd: process.cwd(),
            now: new Date("2026-08-07T00:40:00.000Z"),
        });

        await expect(runRestoredEnvironmentVerification(config, {
            now: () => new Date("2026-08-07T00:40:00.000Z"),
            collectTableCounts: async () => manifest.database.tableCounts,
            collectStorageObjects: async () => manifest.storage.objects,
            ...runners(config),
        })).rejects.toThrow(/not verified|unverified/i);
        expect(existsSync(join(outputDir, ".INCOMPLETE"))).toBe(true);
        expect(statSync(join(outputDir, ".INCOMPLETE")).mode & 0o777).toBe(0o600);
        expect(existsSync(join(outputDir, ".RESTORE_COMPLETE"))).toBe(false);
        expect(existsSync(output)).toBe(false);
    });

    it("fails closed when atomic completion publication fails after every qualification gate", async () => {
        const { backupDir, manifest } = backupFixture();
        const outputDir = mkdtempSync(join(tmpdir(), "omr-restore-publication-"));
        const output = join(outputDir, "evidence.json");
        const config = resolveConfig({
            argv: argv(backupDir, output),
            env: env(),
            cwd: process.cwd(),
            now: new Date("2026-08-07T00:40:00.000Z"),
        });

        await expect(runRestoredEnvironmentVerification(config, {
            now: () => new Date("2026-08-07T00:40:00.000Z"),
            collectTableCounts: async () => manifest.database.tableCounts,
            collectStorageObjects: async () => manifest.storage.objects,
            runBoundaryContract: async () => boundaryResult(config),
            runBrowserSmoke: async () => smokeResult(config),
            publishCompletion: async () => { throw new Error("raw fs publication failure"); },
        })).rejects.toThrow(/publication|not verified/i);
        expect(existsSync(join(outputDir, ".INCOMPLETE"))).toBe(true);
        expect(statSync(join(outputDir, ".INCOMPLETE")).mode & 0o777).toBe(0o600);
        expect(existsSync(join(outputDir, ".RESTORE_COMPLETE"))).toBe(false);
        expect(existsSync(output)).toBe(false);
    });

    it("rejects output-parent replacement and invalidates the moved owned evidence inode", async () => {
        const { backupDir, manifest } = backupFixture();
        const outputDir = mkdtempSync(join(tmpdir(), "omr-restore-parent-race-"));
        const movedDir = `${outputDir}-moved`;
        const output = join(outputDir, "evidence.json");
        const config = resolveConfig({
            argv: argv(backupDir, output),
            env: env(),
            cwd: process.cwd(),
            now: new Date("2026-08-07T00:40:00.000Z"),
        });

        await expect(runRestoredEnvironmentVerification(config, {
            now: () => new Date("2026-08-07T00:40:00.000Z"),
            collectTableCounts: async () => manifest.database.tableCounts,
            collectStorageObjects: async () => manifest.storage.objects,
            runBoundaryContract: async () => boundaryResult(config),
            runBrowserSmoke: async () => smokeResult(config),
            publishCompletion: async () => {
                renameSync(outputDir, movedDir);
                mkdirSync(outputDir, { mode: 0o700 });
            },
        })).rejects.toThrow(/publication|output|verified/i);
        expect(existsSync(join(outputDir, ".RESTORE_COMPLETE"))).toBe(false);
        expect(existsSync(join(movedDir, ".RESTORE_COMPLETE"))).toBe(false);
        expect(existsSync(join(movedDir, ".INCOMPLETE"))).toBe(true);
        const movedEvidence = readFileSync(join(movedDir, "evidence.json"), "utf8");
        expect(() => JSON.parse(movedEvidence)).toThrow();
    });

    it("rejects a symlinked completion publication without truncating the foreign target", async () => {
        const { backupDir, manifest } = backupFixture();
        const outputDir = mkdtempSync(join(tmpdir(), "omr-restore-marker-symlink-"));
        const output = join(outputDir, "evidence.json");
        const foreignMarker = join(mkdtempSync(join(tmpdir(), "omr-restore-foreign-marker-")), "marker.json");
        const config = resolveConfig({
            argv: argv(backupDir, output),
            env: env(),
            cwd: process.cwd(),
            now: new Date("2026-08-07T00:40:00.000Z"),
        });
        let foreignBody = "";

        await expect(runRestoredEnvironmentVerification(config, {
            now: () => new Date("2026-08-07T00:40:00.000Z"),
            collectTableCounts: async () => manifest.database.tableCounts,
            collectStorageObjects: async () => manifest.storage.objects,
            runBoundaryContract: async () => boundaryResult(config),
            runBrowserSmoke: async () => smokeResult(config),
            publishCompletion: async ({ incompleteMarkerPath, completeMarkerPath, marker }: {
                incompleteMarkerPath: string;
                completeMarkerPath: string;
                marker: object;
            }) => {
                rmSync(incompleteMarkerPath);
                foreignBody = `${JSON.stringify(marker)}\n`;
                writeFileSync(foreignMarker, foreignBody, { mode: 0o600 });
                symlinkSync(foreignMarker, completeMarkerPath);
            },
        })).rejects.toThrow(/publication|verified/i);
        expect(readFileSync(foreignMarker, "utf8")).toBe(foreignBody);
        expect(existsSync(join(outputDir, ".RESTORE_COMPLETE"))).toBe(false);
        expect(existsSync(join(outputDir, ".INCOMPLETE"))).toBe(true);
    });
});
