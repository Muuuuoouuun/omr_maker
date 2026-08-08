import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const verifier = readFileSync(
    path.join(process.cwd(), "scripts/verify-supabase-live.mjs"),
    "utf8",
);

describe("Supabase live verifier local PostgreSQL fallback", () => {
    it("rehearses boundary rollback and then restores the production boundary", () => {
        expect(verifier).toContain('psqlFile("supabase/production-server-boundary.sql")');
        expect(verifier).toContain('psqlFile("supabase/teacher-force-finish-compact-assertions.sql")');
        expect(verifier).toContain('psqlFile("supabase/teacher-session-revocation-assertions.sql")');
        expect(verifier).toContain('psqlFile("supabase/live-test-assertions.sql")');
        expect(verifier).toContain('psqlFile("supabase/production-server-boundary-rollback.sql",');
        expect(verifier).toContain('psqlFile("supabase/live-test-rollback-assertions.sql")');
        expect(verifier.match(/psqlFile\("supabase\/production-server-boundary\.sql"\)/g)).toHaveLength(2);
        expect(verifier.match(/psqlFile\("supabase\/live-test-boundary-assertions\.sql"\)/g)).toHaveLength(2);
    });

    it("compares the generated canonical manifest to live public base and partitioned tables", () => {
        expect(verifier).toContain('import { CANONICAL_TABLES } from "./canonical-table-manifest.mjs"');
        expect(verifier).toContain("assertLiveCanonicalTables");
        expect(verifier).toContain("relation.relkind in ('r', 'p')");
        expect(verifier).toContain("relation.relkind = 'f'");
        expect(verifier).toContain("live database contains unsupported public OMR foreign relations");
        expect(verifier).toContain("live canonical tables do not match the generated manifest");
    });

    it("uses an isolated loopback-only PostgreSQL 17 cluster and always cleans it up", () => {
        expect(verifier).toContain("OMR_SUPABASE_LIVE_BACKEND");
        expect(verifier).toContain("OMR_POSTGRES_BIN");
        expect(verifier).toContain("isPostgres17Directory");
        expect(verifier).toContain(
            "directories.find(directory => hasRequiredPostgresBinaries(directory) && isPostgres17Directory(directory))",
        );
        expect(verifier).toContain("dockerInfoTimeoutMs");
        expect(verifier).toContain('run("docker", ["info"], {');
        expect(verifier).toContain("timeout: dockerInfoTimeoutMs");
        expect(verifier).toContain('mkdtempSync(resolve(tmpdir(), "omr-postgres-verify-"))');
        expect(verifier).toContain('getFreePort("127.0.0.1")');
        expect(verifier).toContain('"initdb"');
        expect(verifier).toContain('"pg_ctl"');
        expect(verifier).toContain('"createdb"');
        expect(verifier).toContain('"psql"');
        expect(verifier).toContain('"-h", "127.0.0.1"');
        expect(verifier).toContain('"-v", "ON_ERROR_STOP=1"');
        expect(verifier).toMatch(
            /const temporaryDirectory = mkdtempSync\([^\n]+\);\s*try\s*\{[\s\S]*getFreePort\("127\.0\.0\.1"\)/,
        );
        expect(verifier).toMatch(
            /finally\s*\{[\s\S]*"pg_ctl"[\s\S]*"stop"[\s\S]*rmSync\(temporaryDirectory/,
        );
    });
});
