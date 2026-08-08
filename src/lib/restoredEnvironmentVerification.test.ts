import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
    assertPostgres17Version,
    resolveRestoredEnvironmentConfig,
    runRestoredEnvironmentVerification,
} from "../../scripts/verify-restored-environment.mjs";
import {
    CANONICAL_BACKUP_TABLES,
    REMOTE_ASSET_BUCKET,
    hashProjectRef,
} from "../../scripts/backup-restore-core.mjs";

const SOURCE_REF = "production-source-ref";
const TARGET_REF = "staging-restore-ref";
const BUILD = "c".repeat(40);
const SHA = "d".repeat(64);
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

function env() {
    return {
        OMR_DEPLOYMENT_TIER: "staging",
        OMR_RESTORE_TARGET_SUPABASE_URL: `https://${TARGET_REF}.supabase.co`,
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

describe("restored staging environment verification", () => {
    it("requires PostgreSQL 17 restore verification tools", () => {
        expect(assertPostgres17Version("psql (PostgreSQL) 17.5")).toBe(17);
        expect(() => assertPostgres17Version("psql (PostgreSQL) 16.9")).toThrow(/17/);
        expect(() => assertPostgres17Version("unknown")).toThrow(/17/);
    });

    it("fails closed without staging credentials and emits unverified from the CLI", () => {
        const { backupDir } = backupFixture();
        expect(() => resolveRestoredEnvironmentConfig({
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
        const config = resolveRestoredEnvironmentConfig({
            argv: argv(backupDir, output),
            env: env(),
            cwd: process.cwd(),
            now: new Date("2026-08-07T00:40:00.000Z"),
        });

        expect(config).toMatchObject({
            environment: "staging",
            targetProjectRef: TARGET_REF,
            targetProjectRefHash: hashProjectRef(TARGET_REF),
            rpoMinutes: 60,
            rtoMinutes: 45,
            outputPath: output,
        });
        expect(JSON.stringify(config)).not.toContain(SERVICE_KEY);

        writeFileSync(join(backupDir, "database", "data.sql"), "tampered\n");
        expect(() => resolveRestoredEnvironmentConfig({
            argv: argv(backupDir, output),
            env: env(),
            cwd: process.cwd(),
            now: new Date("2026-08-07T00:40:00.000Z"),
        })).toThrow(/artifact|hash|size/i);
    });

    it("rejects a symlinked completion marker", () => {
        const { backupDir } = backupFixture();
        rmSync(join(backupDir, ".COMPLETE"));
        symlinkSync(join(backupDir, "manifest.json"), join(backupDir, ".COMPLETE"));
        expect(() => resolveRestoredEnvironmentConfig({
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
        expect(() => resolveRestoredEnvironmentConfig({
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
        const config = resolveRestoredEnvironmentConfig({
            argv: argv(backupDir, output),
            env: env(),
            cwd: process.cwd(),
            now: new Date("2026-08-07T00:40:00.000Z"),
        });
        const result = await runRestoredEnvironmentVerification(config, {
            now: () => new Date("2026-08-07T00:40:00.000Z"),
            collectTableCounts: async () => manifest.database.tableCounts,
            collectStorageObjects: async () => manifest.storage.objects,
        });

        expect(result).toMatchObject({
            status: "verified",
            environment: "staging",
            targetProjectRefHash: hashProjectRef(TARGET_REF),
            databaseTableCount: 40,
            storageObjectCount: 1,
            rpoMinutes: 60,
            rtoMinutes: 45,
        });
        expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(result);

        await expect(runRestoredEnvironmentVerification(config, {
            now: () => new Date("2026-08-07T00:40:00.000Z"),
            collectTableCounts: async () => ({ ...manifest.database.tableCounts, omr_exams: 1 }),
            collectStorageObjects: async () => manifest.storage.objects,
        })).rejects.toThrow(/inventory|mismatch/i);
        await expect(runRestoredEnvironmentVerification(config, {
            now: () => new Date("2026-08-07T00:40:00.000Z"),
            collectTableCounts: async () => manifest.database.tableCounts,
            collectStorageObjects: async () => [{ ...manifest.storage.objects[0], sha256: "e".repeat(64) }],
        })).rejects.toThrow(/inventory|mismatch/i);
    });

    it("rechecks the RTO after inventory collection completes", async () => {
        const { backupDir, manifest } = backupFixture();
        const output = join(mkdtempSync(join(tmpdir(), "omr-restore-rto-")), "evidence.json");
        const config = resolveRestoredEnvironmentConfig({
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
        })).rejects.toThrow(/RTO/i);
    });
});
