import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
    return readFileSync(resolve(process.cwd(), path), "utf8").toLowerCase();
}

describe("post-023 production boundary integration", () => {
    const boundary = source("supabase/production-server-boundary.sql");
    const rollback = source("supabase/production-server-boundary-rollback.sql");
    const boundaryAssertions = source("supabase/live-test-boundary-assertions.sql");
    const rollbackAssertions = source("supabase/live-test-rollback-assertions.sql");

    it("pins runtime readiness to migration 027", () => {
        for (const document of [boundary, boundaryAssertions]) {
            expect(document).toContain("202608060029");
        }
    });

    it("requires the compact force-finish RPC pair and keeps browser roles denied", () => {
        for (const name of [
            "omr_prepare_teacher_force_finish_sessions_compact_v1",
            "omr_force_finish_attempt_sessions_compact_v1",
        ]) {
            expect(boundary).toContain(name);
            expect(rollback).toContain(name);
            expect(boundaryAssertions).toContain(name);
            expect(rollbackAssertions).toContain(name);
        }
        expect(boundary).toContain("teacher-live-session-force-finish-compact-prepare:202608060024");
        expect(boundary).toContain("teacher-live-session-force-finish-compact:202608060024");
        expect(boundary).toContain("p_expectations");
    });

    it("requires revocable account generations and the narrow validation RPC", () => {
        expect(boundary).toContain("session_generation");
        expect(boundary).toContain("omr_teacher_accounts_advance_session_on_disable");
        expect(boundary).toContain("omr_validate_teacher_session_v1(text,bigint)");
        expect(boundary).toContain("session_generation = session_generation + 1");
        expect(rollback).toContain("omr_validate_teacher_session_v1");
        expect(boundaryAssertions).toContain("omr_validate_teacher_session_v1(text,bigint)");
        expect(rollbackAssertions).toContain("omr_validate_teacher_session_v1(text,bigint)");
    });

    it("requires production-path load coverage rather than canned operation coverage", () => {
        expect(boundary).toContain("initial-operations-production-coverage:202608060026");
        expect(boundary).toContain("productionworkloadpaths");
        expect(boundaryAssertions).toContain("initialoperationsloadcontrolready");
    });
});
