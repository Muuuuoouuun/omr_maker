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
        const permanentlyClosed = new Set([
            "OMR Kakao candidate reviews are publicly writable",
            "OMR Kakao dispatch logs are publicly writable",
        ]);
        expect(restored).toEqual(dropped.filter(name => !permanentlyClosed.has(name)));
        for (const name of permanentlyClosed) {
            expect(rollback).not.toContain(`create policy "${name}"`);
        }
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
        expect(rollback).toContain("revoke all on public.omr_remote_asset_cleanup_queue from anon, authenticated");
        expect(rollback).toContain("revoke all on sequence public.omr_remote_asset_cleanup_queue_id_seq from anon, authenticated");
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
        // Everything the boundary forces and schema.sql does not must be
        // unforced, except post-alpha service-only state that must never reopen.
        const permanentlyForced = new Set([
            "omr_attempt_sessions",
            "omr_rate_limit_buckets",
            "omr_exam_mutations",
            "omr_feedback_mutations",
            "omr_initial_ops_metrics",
            "omr_teacher_accounts",
            "omr_teacher_account_tokens",
            "omr_exam_entry_invites",
            "omr_teacher_notification_states",
            "omr_operational_job_status",
            "omr_pilot_plan_grants",
            "omr_student_credential_epochs",
            "omr_kakao_candidate_reviews",
            "omr_kakao_dispatch_logs",
            "omr_kakao_reminder_legacy_quarantine",
            "omr_remediation_cases",
        ]);
        const forcedByBoundary = new Set(
            [...boundary.matchAll(/alter table if exists public\.(omr_\w+) force row level security/g)]
                .map(match => match[1]),
        );
        for (const table of forcedByBoundary) {
            if (!forcedBySchema.has(table) && !permanentlyForced.has(table)) {
                expect(unforced.has(table)).toBe(true);
            }
        }
        expect(rollback).toContain("alter table if exists public.omr_attempt_sessions force row level security");
        expect(rollback).toContain("revoke all on table public.omr_attempt_sessions from public, anon, authenticated");
        expect(rollback).toContain("alter table if exists public.omr_rate_limit_buckets force row level security");
        expect(rollback).toContain("alter table if exists public.omr_exam_mutations force row level security");
        expect(rollback).toContain("revoke all on table public.omr_rate_limit_buckets from public, anon, authenticated, service_role");
        expect(rollback).toContain("revoke all on table public.omr_exam_mutations from public, anon, authenticated, service_role");
        expect(rollback).toContain("revoke all on table public.omr_pilot_plan_grants from public, anon, authenticated, service_role");
        expect(rollback).toContain("alter table if exists public.omr_feedback_mutations force row level security");
        expect(rollback).toContain("revoke all on table public.omr_feedback_mutations from public, anon, authenticated, service_role");
        expect(rollback).toContain("revoke all on table public.omr_initial_ops_metrics from public, anon, authenticated, service_role");
        expect(rollback).toContain("revoke all on table public.omr_teacher_accounts from public, anon, authenticated, service_role");
        expect(rollback).toContain("revoke all on table public.omr_teacher_account_tokens from public, anon, authenticated, service_role");
        expect(rollback).toContain("revoke all on table public.omr_teacher_notification_states from public, anon, authenticated, service_role");
        expect(rollback).toContain("revoke all on table public.omr_operational_job_status from public, anon, authenticated, service_role");
    });

    it("keeps post-alpha gateways exact and fail-closed after rollback", () => {
        for (const name of [
            "omr_authorize_remote_asset_cleanup_delete_v1",
            "omr_consume_rate_limit_v1",
            "omr_save_exam_v2",
            "omr_save_exam_v10_snapshot",
            "omr_release_plan_usage_v10_snapshot",
            "omr_normalize_exam_save_request_v10",
            "omr_teacher_notification_summary_v1",
            "omr_bootstrap_workspace_organization_v1",
            "omr_save_feedback_v2",
            "omr_return_feedback_v2",
            "omr_save_feedback_v3",
            "omr_return_feedback_v3",
            "omr_save_feedback_v12_snapshot",
            "omr_return_feedback_v12_snapshot",
            "omr_rotate_exam_entry_invite_v1",
            "omr_resolve_exam_entry_invite_v1",
        ]) {
            expect(rollback).toContain(`'${name}'`);
        }
        expect(rollback).toContain("omr_ack_remote_asset_cleanup_v1(text,text,integer)");
        expect(rollback).toContain("omr_fail_remote_asset_cleanup_v1(text,text,integer,text)");
        expect(rollback).toContain("omr_save_exam_v2(jsonb,jsonb,jsonb,text,bigint,text)");
        expect(rollback).toContain("omr_save_feedback_v2(text,jsonb,bigint,text)");
        expect(rollback).toContain("omr_return_feedback_v2(text,text,bigint,text)");
        expect(rollback).toContain("omr_save_feedback_v3(text,jsonb,bigint,text)");
        expect(rollback).toContain("omr_return_feedback_v3(text,text,bigint,text)");
    });

    it("drops both storage policies the boundary installs", () => {
        for (const name of ["OMR private assets server-only objects", "OMR private assets server-only buckets"]) {
            expect(boundary).toContain(`create policy "${name}"`);
            expect(rollback).toContain(`drop policy if exists "${name}"`);
        }
    });
});
