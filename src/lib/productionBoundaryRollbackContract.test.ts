import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Keeps production-server-boundary-rollback.sql in step with the boundary it
 * reverses. The pair is only correct as a pair: the boundary drops policies and
 * revokes privileges, the rollback restores them, and a change to one side that
 * misses the other leaves the rollback either incomplete (still locked out) or —
 * worse — broader than the alpha baseline it claims to restore.
 *
 * Behaviour is verified against a real PostgreSQL 17 cluster; these are the
 * cheap structural checks that catch drift at edit time, not a substitute for
 * that run.
 */

const rootDir = process.cwd();

function read(relativePath: string): string {
    return readFileSync(path.join(rootDir, relativePath), "utf8");
}

const boundary = read("supabase/production-server-boundary.sql");
const rollback = read("supabase/production-server-boundary-rollback.sql");
const schema = read("supabase/schema.sql");

/** Policy names the boundary drops on public.omr_* tables. */
function droppedAlphaPolicies(sql: string): string[] {
    return [...sql.matchAll(/drop policy if exists "(OMR [^"]+)" on public\./g)]
        .map(match => match[1])
        .sort();
}

function createdPolicies(sql: string): string[] {
    return [...sql.matchAll(/create policy "(OMR [^"]+)" on public\./g)]
        .map(match => match[1])
        .sort();
}

describe("production boundary rollback contract", () => {
    it("restores exactly the alpha policies the boundary drops", () => {
        const dropped = droppedAlphaPolicies(boundary);
        const restored = createdPolicies(rollback);
        expect(restored).toEqual(dropped);
    });

    it("restores policies that schema.sql actually defines", () => {
        // Guards against inventing a policy name the alpha schema never had.
        for (const name of createdPolicies(rollback)) {
            expect(schema).toContain(`create policy "${name}"`);
        }
    });

    it("re-applies the revokes that alpha itself kept in place", () => {
        // The blanket re-grant in stage 2 is broader than alpha ever was, so the
        // tables and SECURITY DEFINER RPCs that schema.sql/migrations explicitly
        // closed must be closed again — otherwise rolling back leaves the
        // database MORE exposed than before the boundary was applied.
        expect(rollback).toContain("revoke all on public.omr_student_start_credentials from anon, authenticated");
        expect(rollback).toContain("revoke all on public.omr_roster_invites from anon, authenticated");
        for (const fn of ["omr_submit_attempt_v1", "omr_save_exam_v1", "omr_return_feedback_v1", "omr_service_readiness_v1"]) {
            expect(rollback).toContain(`'${fn}'`);
        }
    });

    it("gates the two destructive stages behind an explicit confirmation", () => {
        const guards = rollback.match(/current_setting\('omr\.rollback_confirm', true\)/g) || [];
        expect(guards).toHaveLength(2);
        // Stage 1 must not be gated — it is the safe, likely-needed one.
        const stageOne = rollback.slice(0, rollback.indexOf("STAGE 2"));
        expect(stageOne).not.toContain("omr.rollback_confirm");
    });

    it("requires the migration owner in every stage", () => {
        const ownerChecks = rollback.match(/current_user is distinct from 'postgres'/g) || [];
        expect(ownerChecks).toHaveLength(3);
    });

    it("leaves FORCE RLS on exactly the tables schema.sql forces", () => {
        const forcedBySchema = new Set(
            [...schema.matchAll(/alter table (?:if exists )?public\.(omr_\w+)\s+force row level security/g)]
                .map(match => match[1]),
        );
        const unforced = new Set(
            [...rollback.matchAll(/alter table if exists public\.(omr_\w+) no force row level security/g)]
                .map(match => match[1]),
        );
        expect(forcedBySchema.size).toBeGreaterThan(0);
        for (const table of forcedBySchema) {
            expect(unforced.has(table)).toBe(false);
        }
        // Everything the boundary forces and schema.sql does not must be unforced.
        const forcedByBoundary = new Set(
            [...boundary.matchAll(/alter table if exists public\.(omr_\w+) force row level security/g)]
                .map(match => match[1]),
        );
        for (const table of forcedByBoundary) {
            if (!forcedBySchema.has(table)) expect(unforced.has(table)).toBe(true);
        }
    });

    it("drops both storage policies the boundary installs", () => {
        for (const name of ["OMR private assets server-only objects", "OMR private assets server-only buckets"]) {
            expect(boundary).toContain(`create policy "${name}"`);
            expect(rollback).toContain(`drop policy if exists "${name}"`);
        }
    });
});
