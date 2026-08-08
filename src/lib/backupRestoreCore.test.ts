import { describe, expect, it } from "vitest";

import {
    discoverCanonicalTables,
    loadRepositoryCanonicalTables,
} from "../../scripts/canonical-table-manifest.mjs";
import {
    BACKUP_FORMAT_VERSION,
    CANONICAL_BACKUP_TABLES,
    REMOTE_ASSET_BUCKET,
    assertDifferentProjectRefs,
    assertTargetProjectDiffers,
    compareRestoredInventory,
    hashProjectRef,
    parseCopyTableCounts,
    redactBackupSummary,
    validateBackupManifest,
} from "../../scripts/backup-restore-core.mjs";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const GIT_SHA = "c".repeat(40);

function manifestFixture() {
    return {
        formatVersion: BACKUP_FORMAT_VERSION,
        createdAt: "2026-08-07T00:00:00.000Z",
        gitCommit: GIT_SHA,
        sourceProjectRefHash: SHA_A,
        database: {
            roles: { file: "roles.sql", bytes: 10, sha256: SHA_A },
            schema: { file: "schema.sql", bytes: 20, sha256: SHA_B },
            data: { file: "data.sql", bytes: 30, sha256: SHA_A },
            tableCounts: Object.fromEntries(CANONICAL_BACKUP_TABLES.map((table) => [table, 0])),
        },
        storage: {
            bucket: REMOTE_ASSET_BUCKET,
            objectCount: 1,
            totalBytes: 2,
            objects: [
                {
                    path: "organizations/org-hash/exams/exam-hash/problem/asset-hash.pdf",
                    bytes: 2,
                    sha256: SHA_B,
                    contentType: "application/pdf",
                },
            ],
        },
    };
}

describe("backup and restore manifest core", () => {
    it("keeps the exact sorted 38-table backup allowlist aligned with baseline plus migrations", () => {
        const discoveredTables = loadRepositoryCanonicalTables({ rootDir: process.cwd() });

        expect(discoveredTables).toHaveLength(38);
        expect(discoveredTables).toEqual([...discoveredTables].sort());
        expect(new Set(discoveredTables).size).toBe(discoveredTables.length);
        expect(CANONICAL_BACKUP_TABLES).toHaveLength(38);
        expect(CANONICAL_BACKUP_TABLES).toEqual(discoveredTables);
    });

    it("discovers only public OMR CREATE TABLE DDL across deterministically sorted migrations", () => {
        const discoveredTables = discoverCanonicalTables({
            schemaSql: [
                "-- create table public.omr_line_comment (id bigint);",
                "/* create table public.omr_block_comment (id bigint); */",
                "select 'create table public.omr_string_literal (id bigint)';",
                "select 'path\\';",
                "do $body$ begin raise notice 'create table public.omr_function_body'; end $body$;",
                "create table public.omr_after_standard_string (id bigint);",
                'CREATE TABLE IF NOT EXISTS "public"."omr_zeta" (id bigint);',
                "create table private.omr_private (id bigint);",
                "create table public.unrelated (id bigint);",
            ].join("\n"),
            migrationSqlFiles: [
                { path: "002_beta.sql", sql: 'create table public."omr_beta" (id bigint);' },
                { path: "001_alpha.sql", sql: "CREATE TABLE public.omr_alpha (id bigint);" },
                { path: "003_duplicate.sql", sql: "create table if not exists public.omr_alpha (id bigint);" },
            ],
        });

        expect(discoveredTables).toEqual([
            "omr_after_standard_string",
            "omr_alpha",
            "omr_beta",
            "omr_zeta",
        ]);
        expect(new Set(discoveredTables).size).toBe(discoveredTables.length);
    });

    it("rejects migration inputs without a unique path ordering key", () => {
        expect(() => discoverCanonicalTables({
            schemaSql: "",
            migrationSqlFiles: [
                { path: "001.sql", sql: "create table public.omr_alpha (id bigint);" },
                { path: "001.sql", sql: "create table public.omr_beta (id bigint);" },
            ],
        })).toThrow(/duplicate migration path/i);
        expect(() => discoverCanonicalTables({
            schemaSql: "",
            migrationSqlFiles: [{ path: "", sql: "create table public.omr_alpha (id bigint);" }],
        })).toThrow(/migration path/i);
    });

    it("applies canonical CREATE, DROP, and RENAME identity changes in migration order", () => {
        const discoveredTables = discoverCanonicalTables({
            schemaSql: [
                "create table public.omr_created_then_dropped (id bigint);",
                'create unlogged table if not exists "public"."omr_unlogged" (id bigint);',
                "create table public.omr_renamed_old (id bigint);",
            ].join("\n"),
            migrationSqlFiles: [
                {
                    path: "002_rename.sql",
                    sql: [
                        'alter table only "public"."omr_renamed_old" rename to "omr_renamed_final";',
                        "alter table public.omr_unlogged add column note text;",
                    ].join("\n"),
                },
                {
                    path: "001_drop.sql",
                    sql: "drop table if exists public.omr_created_then_dropped;",
                },
            ],
        });

        expect(discoveredTables).toEqual(["omr_renamed_final", "omr_unlogged"]);
    });

    it("removes multiple canonical DROP TABLE targets without retaining stale names", () => {
        expect(discoverCanonicalTables({
            schemaSql: [
                "create table public.omr_drop_alpha (id bigint);",
                "create table public.omr_drop_beta (id bigint);",
                "create table public.omr_keep (id bigint);",
            ].join("\n"),
            migrationSqlFiles: [{
                path: "001_drop.sql",
                sql: "drop table public.omr_drop_alpha, public.omr_drop_beta cascade;",
            }],
        })).toEqual(["omr_keep"]);
    });

    it.each([
        [
            "temporary canonical table",
            "create temporary table public.omr_temp (id bigint);",
            /001_unsupported\.sql.*CREATE TEMPORARY TABLE/i,
        ],
        [
            "malformed canonical create",
            "create table public.omr_broken;",
            /001_unsupported\.sql.*CREATE TABLE/i,
        ],
        [
            "canonical SET SCHEMA",
            "alter table public.omr_move set schema archive;",
            /001_unsupported\.sql.*ALTER TABLE SET SCHEMA/i,
        ],
        [
            "malformed canonical drop",
            "drop table public omr_broken;",
            /001_unsupported\.sql.*DROP TABLE/i,
        ],
        [
            "malformed canonical rename",
            "alter table public.omr_old rename omr_new;",
            /001_unsupported\.sql.*ALTER TABLE RENAME/i,
        ],
    ])("fails closed on unsupported %s identity DDL", (_label, sql, error) => {
        expect(() => discoverCanonicalTables({
            schemaSql: "",
            migrationSqlFiles: [{ path: "001_unsupported.sql", sql }],
        })).toThrow(error);
    });

    it("counts rows inside canonical pg_dump COPY blocks", () => {
        const sql = [
            "COPY public.omr_organizations (id, name) FROM stdin;",
            "org-1\tAlpha",
            "org-2\tBeta",
            "\\.",
            "",
            "COPY public.omr_attempts (id, answers) FROM stdin;",
            'attempt-1\t{"1": 2}',
            "\\.",
            "COPY public.omr_comments (id) FROM stdin;",
            "\\.",
            "",
        ].join("\n");

        expect(parseCopyTableCounts(sql)).toEqual({
            omr_organizations: 2,
            omr_attempts: 1,
            omr_comments: 0,
        });
    });

    it("accepts quoted pg_dump identifiers and rejects malformed or duplicate COPY blocks", () => {
        expect(parseCopyTableCounts('COPY "public"."omr_exams" ("id") FROM stdin;\nexam-1\n\\.\n'))
            .toEqual({ omr_exams: 1 });
        expect(() => parseCopyTableCounts("COPY public.omr_exams (id) FROM stdin;\nexam-1\n"))
            .toThrow(/unterminated/i);
        expect(() => parseCopyTableCounts([
            "COPY public.omr_exams (id) FROM stdin;",
            "\\.",
            "COPY public.omr_exams (id) FROM stdin;",
            "\\.",
        ].join("\n"))).toThrow(/duplicate/i);
        expect(() => parseCopyTableCounts("COPY public.omr_unknown (id) FROM stdin;\n1\n\\.\n"))
            .toThrow(/non-canonical/i);
    });

    it("validates a complete manifest and returns a defensive copy", () => {
        const manifest = manifestFixture();
        const validated = validateBackupManifest(manifest);

        expect(validated).toEqual(manifest);
        expect(validated).not.toBe(manifest);
        expect(validated.storage.objects).not.toBe(manifest.storage.objects);
    });

    it.each([
        ["duplicate object path", (value: ReturnType<typeof manifestFixture>) => value.storage.objects.push({ ...value.storage.objects[0] })],
        ["parent traversal", (value: ReturnType<typeof manifestFixture>) => { value.storage.objects[0].path = "organizations/../secret"; }],
        ["backslash", (value: ReturnType<typeof manifestFixture>) => { value.storage.objects[0].path = "organizations\\secret"; }],
        ["other bucket", (value: ReturnType<typeof manifestFixture>) => { value.storage.bucket = "public-assets"; }],
        ["bad sha", (value: ReturnType<typeof manifestFixture>) => { value.storage.objects[0].sha256 = "bad"; }],
        ["negative bytes", (value: ReturnType<typeof manifestFixture>) => { value.storage.objects[0].bytes = -1; }],
        ["count mismatch", (value: ReturnType<typeof manifestFixture>) => { value.storage.objectCount = 2; }],
        ["byte mismatch", (value: ReturnType<typeof manifestFixture>) => { value.storage.totalBytes = 999; }],
        ["empty SQL artifact", (value: ReturnType<typeof manifestFixture>) => { value.database.data.bytes = 0; }],
        ["non-canonical root", (value: ReturnType<typeof manifestFixture>) => { value.storage.objects[0].path = "C:/outside/problem.pdf"; }],
        ["unsafe MIME", (value: ReturnType<typeof manifestFixture>) => { value.storage.objects[0].contentType = "text/html"; }],
        ["path and MIME mismatch", (value: ReturnType<typeof manifestFixture>) => { value.storage.objects[0].contentType = "application/json"; }],
        ["missing table", (value: ReturnType<typeof manifestFixture>) => { delete value.database.tableCounts.omr_exams; }],
        ["extra table", (value: ReturnType<typeof manifestFixture>) => { value.database.tableCounts.omr_unknown = 0; }],
    ])("rejects %s", (_label, mutate) => {
        const manifest = manifestFixture();
        mutate(manifest);
        expect(() => validateBackupManifest(manifest)).toThrow();
    });

    it("refuses restore to the source project even when case or whitespace differs", () => {
        expect(() => assertDifferentProjectRefs(" AbCdEf123 ", "abcdef123")).toThrow(/different/i);
        expect(assertDifferentProjectRefs("source-ref", "target-ref")).toEqual({
            sourceProjectRef: "source-ref",
            targetProjectRef: "target-ref",
        });
    });

    it("can refuse the source project using only the hash stored in the manifest", () => {
        const sourceHash = hashProjectRef(" AbCdEf123 ");
        expect(() => assertTargetProjectDiffers(sourceHash, "abcdef123")).toThrow(/different/i);
        expect(assertTargetProjectDiffers(sourceHash, "target-ref")).toEqual({
            targetProjectRef: "target-ref",
            targetProjectRefHash: hashProjectRef("target-ref"),
        });
        expect(() => assertTargetProjectDiffers("bad", "target-ref")).toThrow(/SHA-256/i);
    });

    it("reports table and storage inventory differences by category", () => {
        const expectedTableCounts = Object.fromEntries(CANONICAL_BACKUP_TABLES.map((table) => [table, 0]));
        const actualTableCounts = { ...expectedTableCounts };
        expectedTableCounts.omr_exams = 2;
        expectedTableCounts.omr_attempts = 4;
        actualTableCounts.omr_exams = 1;
        delete actualTableCounts.omr_attempts;
        actualTableCounts.omr_comments = 9;
        actualTableCounts.omr_unknown = 1;
        const result = compareRestoredInventory(
            {
                tableCounts: expectedTableCounts,
                objects: [
                    { path: "organizations/org-1/exams/exam-1/problem/a.pdf", bytes: 10, sha256: SHA_A, contentType: "application/pdf" },
                    { path: "organizations/org-1/exams/exam-1/problem/b.pdf", bytes: 20, sha256: SHA_B, contentType: "application/pdf" },
                ],
            },
            {
                tableCounts: actualTableCounts,
                objects: [
                    { path: "organizations/org-1/exams/exam-1/problem/a.pdf", bytes: 11, sha256: SHA_B, contentType: "application/json" },
                    { path: "organizations/org-1/exams/exam-1/problem/c.pdf", bytes: 30, sha256: SHA_A, contentType: "application/pdf" },
                ],
            },
        );

        expect(result.ok).toBe(false);
        expect(result.tables).toEqual({
            missing: ["omr_attempts"],
            extra: ["omr_unknown"],
            countMismatch: [
                { table: "omr_comments", expected: 0, actual: 9 },
                { table: "omr_exams", expected: 2, actual: 1 },
            ],
        });
        expect(result.storage).toEqual({
            missing: ["organizations/org-1/exams/exam-1/problem/b.pdf"],
            extra: ["organizations/org-1/exams/exam-1/problem/c.pdf"],
            sizeMismatch: [{ path: "organizations/org-1/exams/exam-1/problem/a.pdf", expected: 10, actual: 11 }],
            hashMismatch: [{ path: "organizations/org-1/exams/exam-1/problem/a.pdf", expected: SHA_A, actual: SHA_B }],
            contentTypeMismatch: [{
                path: "organizations/org-1/exams/exam-1/problem/a.pdf",
                expected: "application/pdf",
                actual: "application/json",
            }],
        });
    });

    it("never treats an empty or malformed restoration inventory as verified", () => {
        expect(() => compareRestoredInventory(
            { tableCounts: {}, objects: [] },
            { tableCounts: {}, objects: [] },
        )).toThrow(/canonical table/i);
    });

    it("requires expected inventory MIME to match its canonical asset path", () => {
        const tableCounts = Object.fromEntries(CANONICAL_BACKUP_TABLES.map((table) => [table, 0]));
        const invalid = {
            tableCounts,
            objects: [{
                path: "organizations/org-1/exams/exam-1/problem/a.pdf",
                bytes: 10,
                sha256: SHA_A,
                contentType: "application/json",
            }],
        };
        expect(() => compareRestoredInventory(invalid, invalid)).toThrow(/contentType/i);
    });

    it("redacts the manifest to aggregate evidence without URLs, keys, paths, or row data", () => {
        const manifest = manifestFixture();
        const hostile = {
            ...manifest,
            sourceUrl: "https://project.supabase.co",
            serviceRoleKey: "service-role-secret",
            studentRows: [{ name: "실명 학생" }],
        };
        const summary = redactBackupSummary(hostile);
        const serialized = JSON.stringify(summary);

        expect(summary).toEqual({
            formatVersion: 1,
            createdAt: manifest.createdAt,
            gitCommit: manifest.gitCommit,
            sourceProjectRefHash: SHA_A,
            databaseTableCount: 38,
            databaseRowCount: 0,
            storageBucket: REMOTE_ASSET_BUCKET,
            storageObjectCount: 1,
            storageTotalBytes: 2,
        });
        expect(serialized).not.toContain("supabase.co");
        expect(serialized).not.toContain("service-role-secret");
        expect(serialized).not.toContain("실명 학생");
        expect(serialized).not.toContain("asset-hash.pdf");
    });
});
