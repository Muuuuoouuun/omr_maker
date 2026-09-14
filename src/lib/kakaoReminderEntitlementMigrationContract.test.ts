import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const migrationPath = join(root, "supabase/migrations/202608100002_kakao_reminder_entitlement_boundary.sql");
const source = (path: string) => readFileSync(join(root, path), "utf8");

describe("Kakao reminder entitlement migration contract", () => {
    it("uses the monotonic Task7 successor and preserves legacy rows behind explicit inventory/quarantine", () => {
        expect(existsSync(migrationPath)).toBe(true);
        const migration = readFileSync(migrationPath, "utf8");
        expect(migration).toContain("legacy_unreconciled");
        expect(migration).toContain("quarantined");
        expect(migration).toContain("trusted");
        expect(migration).toContain("omr_kakao_reminder_legacy_inventory_v1");
        expect(migration).toContain("omr_quarantine_kakao_reminder_legacy_v1");
        expect(migration).toContain("omr_kakao_reminder_entitlement_ready_v1");
        expect(migration).not.toContain("requires empty legacy tables");
        expect(migration).not.toMatch(/delete\s+from\s+public\.omr_kakao_/i);
        expect(migration).not.toMatch(/truncate\s+(table\s+)?public\.omr_kakao_/i);
    });

    it("keeps quarantine evidence in the canonical backup inventory with explicit retention", () => {
        const migration = readFileSync(migrationPath, "utf8");
        const manifest = source("scripts/canonical-table-manifest.mjs");
        expect(migration).toContain("public.omr_kakao_reminder_legacy_quarantine");
        expect(migration).toContain("forensic evidence is retained until explicit operator deletion");
        expect(migration).not.toContain("public.kakao_reminder_legacy_quarantine");
        expect(manifest).toContain("EXPECTED_CANONICAL_TABLE_COUNT = 47");
    });

    it("never uses an unconditional quarantine read policy and attests each profile exactly", () => {
        const migration = readFileSync(migrationPath, "utf8");
        const rls = source("supabase/production-rls.sql");
        const boundary = source("supabase/production-server-boundary.sql");
        const migrationAssertions = source("supabase/kakao-reminder-entitlement-assertions.sql");
        const boundaryAssertions = source("supabase/live-test-boundary-assertions.sql");
        for (const policySource of [migration, rls]) {
            const quarantinePolicy = policySource.slice(
                policySource.indexOf('create policy "Kakao reminder quarantine service read"'),
                policySource.indexOf(';', policySource.indexOf('create policy "Kakao reminder quarantine service read"')) + 1,
            );
            expect(quarantinePolicy).toContain("using (current_user = 'service_role')");
            expect(quarantinePolicy).not.toMatch(/using\s*\(\s*true\s*\)/i);
        }
        expect(migrationAssertions).toContain("Kakao quarantine policy predicate drifted");
        expect(boundary).toContain("Kakao reminder quarantine service read");
        expect(boundary).toContain("pg_catalog.pg_policy");
        expect(boundaryAssertions).toContain("production boundary retained a Kakao quarantine policy");
    });

    it("indexes unresolved inventory and exposes only trusted or validated legacy source rows", () => {
        const migration = readFileSync(migrationPath, "utf8");
        expect(migration).toMatch(/create index omr_kakao_candidate_reviews_unreconciled_idx[\s\S]+where entitlement_state = 'legacy_unreconciled'/i);
        expect(migration).toMatch(/create index omr_kakao_dispatch_logs_unreconciled_idx[\s\S]+where entitlement_state = 'legacy_unreconciled'/i);
        expect(migration).toContain('create policy "Kakao reminder source reviews service read"');
        expect(migration).toContain('create policy "Kakao reminder source dispatches service read"');
        expect(migration).toContain("entitlement_state in ('trusted', 'validated_legacy')");
        expect(migration).toMatch(/dispatch\.entitlement_state = 'legacy_unreconciled'[\s\S]+review\.entitlement_state in \('trusted', 'validated_legacy'\)/i);
    });

    it("serializes absent-ID races before scope inspection and proves the paid plan in the same transaction", () => {
        const migration = readFileSync(migrationPath, "utf8");
        for (const marker of [
            "omr_kakao_review:",
            "omr_kakao_dispatch:",
            "pg_advisory_xact_lock",
            "for update",
            "omr_lock_teacher_mutation_identity_v1",
            "omr_read_teacher_mutation_plan_v1",
            "omr_set_effective_plan_transaction_proof_v1",
            "omr_assert_effective_plan_transaction_proof_v1",
            "v_plan not in ('pro', 'academy')",
            "'status', 'plan_denied'",
        ]) expect(migration).toContain(marker);

        const reviewLock = migration.indexOf("'omr_kakao_review:' || v_id");
        const reviewRead = migration.indexOf("from public.omr_kakao_candidate_reviews review", reviewLock);
        const reviewWrite = migration.indexOf("insert into public.omr_kakao_candidate_reviews", reviewRead);
        expect(reviewLock).toBeGreaterThan(-1);
        expect(reviewRead).toBeGreaterThan(reviewLock);
        expect(reviewWrite).toBeGreaterThan(reviewRead);
    });

    it("keeps exact RPCs service-role-only across boundary, RLS, and rollback profiles", () => {
        const migration = readFileSync(migrationPath, "utf8");
        for (const rpc of [
            "omr_save_kakao_candidate_review_v1",
            "omr_save_kakao_simulation_dispatch_v1",
        ]) {
            expect(migration).toContain(`create function public.${rpc}(`);
            expect(migration).toContain(`revoke all on function public.${rpc}`);
            expect(migration).toContain(`grant execute on function public.${rpc}`);
        }
        for (const profilePath of [
            "supabase/production-server-boundary.sql",
            "supabase/production-rls.sql",
            "supabase/production-server-boundary-rollback.sql",
        ]) {
            const profile = source(profilePath);
            expect(profile).toContain("omr_save_kakao_candidate_review_v1");
            expect(profile).toContain("omr_save_kakao_simulation_dispatch_v1");
            expect(profile).toContain("omr_kakao_candidate_reviews");
            expect(profile).toContain("omr_kakao_dispatch_logs");
        }
    });

    it("keeps every Kakao RPC/helper and overload fail-closed during rollback itself", () => {
        const rollback = source("supabase/production-server-boundary-rollback.sql");
        const rollbackAssertions = source("supabase/live-test-rollback-assertions.sql");
        for (const name of [
            "omr_save_kakao_candidate_review_v1",
            "omr_save_kakao_simulation_dispatch_v1",
            "omr_kakao_reminder_legacy_inventory_v1",
            "omr_quarantine_kakao_reminder_legacy_v1",
            "omr_kakao_reminder_entitlement_ready_v1",
        ]) {
            expect(rollback).toContain(`'${name}'`);
            expect(rollbackAssertions).toContain(name);
        }
        expect(rollback).toContain("kakao_rpc_overload_acl");
        expect(rollbackAssertions).toContain("rollback left a Kakao overload executable");
    });

    it("requires both mutation RPC owners to remain exact bypass-RLS postgres roles and live-tests owner drift", () => {
        const boundary = source("supabase/production-server-boundary.sql");
        const live = source("supabase/live-test-boundary-assertions.sql");
        expect(boundary).toMatch(/routine\.proname in \([\s\S]*omr_save_kakao_candidate_review_v1[\s\S]*omr_save_kakao_simulation_dispatch_v1[\s\S]*owner_role\.rolname = 'postgres'[\s\S]*owner_role\.rolsuper or owner_role\.rolbypassrls/i);
        expect(live).toContain("kakao_non_bypass_owner");
        expect(live).toContain("alter function public.omr_save_kakao_candidate_review_v1");
        expect(live).toContain("owner to kakao_non_bypass_owner");
        expect(live).toContain("Kakao mutation owner drift did not fail readiness");
        expect(live).toContain("Kakao mutation owner drift remained executable");
        expect(live).toContain("owner to postgres");
        expect(live).toContain("Kakao mutation owner restore did not recover readiness");
        for (const profilePath of [
            "supabase/production-server-boundary.sql",
            "supabase/production-server-boundary-rollback.sql",
            "supabase/production-rls.sql",
        ]) {
            const profile = source(profilePath);
            expect(profile).toContain("alter function public.omr_save_kakao_candidate_review_v1(text,text,bigint,text,text,jsonb)");
            expect(profile).toContain("alter function public.omr_save_kakao_simulation_dispatch_v1(text,text,bigint,text,text,jsonb)");
            expect(profile).toContain("owner to postgres");
        }
    });

    it("extends cumulative readiness without dropping Task6/7 checks and wires concurrency/overload assertions", () => {
        const probe = source("src/lib/supabaseReadinessProbe.ts");
        const boundary = source("supabase/production-server-boundary.sql");
        const verifier = source("scripts/verify-supabase-live.mjs");
        expect(probe).toContain('SUPABASE_READINESS_VERSION = "202608090001"');
        expect(probe).toContain('"canonicalQuestionResultEvidenceReady"');
        expect(probe).toContain('"kakaoReminderEntitlementReady"');
        expect(boundary).toContain("'canonicalQuestionResultEvidenceReady', v_canonical_question_result_evidence_ready");
        expect(boundary).toContain("'kakaoReminderEntitlementReady', v_kakao_reminder_entitlement_ready");
        expect(boundary).toContain("and v_kakao_reminder_entitlement_ready");
        expect(verifier).toContain('psqlFile("supabase/kakao-reminder-entitlement-concurrency-lock.sql")');
        expect(verifier).toContain('psqlFile("supabase/kakao-reminder-overload-boundary-assertions.sql")');
        expect(verifier).toContain('psqlFile("supabase/kakao-reminder-entitlement-readiness-performance-assertions.sql")');
        expect(verifier).toContain("verifyKakaoQuarantineBackupRoundtrip()");
        expect(verifier).toContain('CANONICAL_TABLES.includes("omr_kakao_reminder_legacy_quarantine")');
        expect(verifier).toContain('"pg_dump"');
        expect(verifier).toContain('"--table=public.omr_kakao_reminder_legacy_quarantine"');
        expect(verifier).not.toContain('psqlFile("supabase/kakao-reminder-entitlement-backup-roundtrip-assertions.sql")');
    });
});
