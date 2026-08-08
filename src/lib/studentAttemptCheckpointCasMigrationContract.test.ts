import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const migrationPath = join(root, "supabase/migrations/202608060016_attempt_checkpoint_null_cas.sql");
const migration = existsSync(migrationPath) ? readFileSync(migrationPath, "utf8") : "";
const boundary = readFileSync(join(root, "supabase/production-server-boundary.sql"), "utf8");
const live = readFileSync(join(root, "supabase/live-test-assertions.sql"), "utf8");

describe("attempt checkpoint null CAS hardening migration", () => {
    it("rejects null expected revision and lease epoch before locking or mutating", () => {
        expect(existsSync(migrationPath)).toBe(true);
        const validation = migration.indexOf("p_expected_revision is null");
        const leaseValidation = migration.indexOf("p_expected_lease_epoch is null");
        const lock = migration.indexOf("for update;");
        expect(validation).toBeGreaterThan(0);
        expect(leaseValidation).toBeGreaterThan(validation);
        expect(lock).toBeGreaterThan(leaseValidation);
        expect(migration).toContain("v_session.revision is distinct from p_expected_revision");
        expect(migration).toContain("v_session.lease_epoch is distinct from p_expected_lease_epoch");
    });

    it("pins deployment readiness and live PostgreSQL assertions to the hardening", () => {
        expect(boundary).toContain("'version', '202608080010'");
        expect(boundary).toContain("'attemptCheckpointNullCasReady'");
        expect(boundary).toContain(
            "attempt-checkpoint-null-cas:202608060016;secure-submission-outbox-replay:202608060028",
        );
        expect(live).toContain("checkpoint accepted a null expected revision");
        expect(live).toContain("checkpoint accepted a null expected lease epoch");
    });
});
