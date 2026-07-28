import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const verifier = readFileSync(
    path.join(process.cwd(), "scripts/verify-supabase-live.mjs"),
    "utf8",
);

describe("Supabase live verifier local PostgreSQL fallback", () => {
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
