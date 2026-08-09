import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve(
    process.cwd(),
    "supabase/migrations/202608080008_effective_workspace_plan_enforcement.sql",
), "utf8");
const productionBoundary = readFileSync(resolve(process.cwd(), "supabase/production-server-boundary.sql"), "utf8");
const rollbackBoundary = readFileSync(resolve(process.cwd(), "supabase/production-server-boundary-rollback.sql"), "utf8");

describe("effective workspace plan enforcement migration", () => {
    it("creates non-overloaded account-bound vNext mutation boundaries", () => {
        for (const name of [
            "omr_save_roster_v3",
            "omr_save_exam_v3",
            "omr_prepare_teacher_asset_upload_v2",
            "omr_authorize_teacher_asset_finalize_v2",
            "omr_finalize_teacher_asset_upload_v2",
            "omr_prepare_attempt_handwriting_asset_v2",
            "omr_attach_attempt_handwriting_v2",
            "omr_save_feedback_v4",
            "omr_return_feedback_v4",
            "omr_assign_students_v2",
            "omr_clear_student_assignment_v2",
            "omr_reserve_plan_usage_v2",
            "omr_release_plan_usage_v2",
            "omr_sync_student_plan_usage_v2",
        ]) {
            expect(migration).toContain(`function public.${name}(`);
        }
        expect(migration).toContain("p_account_id text");
        expect(migration).toContain("p_session_generation bigint");
        expect(migration).toContain("function public.omr_open_attempt_session_v2(");
    });

    it("uses exact private effective-plan authorization and never trusts organization.plan", () => {
        expect(migration).toContain("function public.omr_lock_provisioned_teacher_identity_v1(");
        expect(migration).toContain("function public.omr_authorize_effective_teacher_plan_v1(");
        expect(migration).toContain("function public.omr_read_effective_organization_plan_v1(");
        expect(migration).toContain("function public.omr_lock_legacy_teacher_identity_v1(");
        expect(migration).toContain("function public.omr_read_legacy_teacher_plan_v1(");
        expect(migration).toContain("function public.omr_lock_teacher_mutation_identity_v1(");
        expect(migration).toContain("function public.omr_read_teacher_mutation_plan_v1(");
        expect(migration).toContain("function public.omr_set_effective_plan_transaction_proof_v1(");
        expect(migration).toContain("function public.omr_assert_effective_plan_transaction_proof_v1(");
        expect(migration).toContain("public.omr_read_effective_workspace_plan_v1");
        const helper = migration.split("function public.omr_lock_provisioned_teacher_identity_v1(")[1]
            ?.split("function public.omr_authorize_effective_teacher_plan_v1(")[0] ?? "";
        expect(helper).toContain("from public.omr_teacher_accounts account");
        expect(helper).toContain("from public.omr_organization_members member");
        expect(helper).toContain("from public.omr_teacher_profiles profile");
        expect(helper).toContain("from public.omr_organizations organization");
        expect(helper).toContain("from public.omr_pilot_plan_grants grant_row");
        expect(helper).toContain("grant_row.account_id is distinct from p_account_id");
        expect(helper).toContain("grant_row.organization_id is distinct from p_organization_id");
        expect(helper).toContain("lock table public.omr_organization_members in share mode");
        expect(helper).toContain("lock table public.omr_teacher_profiles in share mode");
        expect(helper.indexOf("lock table public.omr_teacher_profiles")).toBeLessThan(helper.indexOf("omr_teacher_accounts account"));
        expect(helper.match(/for update/g)?.length).toBeGreaterThanOrEqual(5);
        expect(helper.indexOf("omr_teacher_accounts account")).toBeLessThan(helper.indexOf("omr_organization_members member"));
        expect(helper.indexOf("omr_organization_members member")).toBeLessThan(helper.indexOf("omr_teacher_profiles profile"));
        expect(helper.indexOf("omr_teacher_profiles profile")).toBeLessThan(helper.indexOf("omr_organizations organization"));
        expect(helper.indexOf("omr_organizations organization")).toBeLessThan(helper.indexOf("omr_pilot_plan_grants grant_row"));
        const provisionedPlanHelper = migration.split("function public.omr_authorize_effective_teacher_plan_v1(")[1]
            ?.split("function public.omr_read_effective_organization_plan_v1(")[0] ?? "";
        expect(helper).not.toMatch(/organization\.plan/);
        expect(provisionedPlanHelper).not.toMatch(/organization\.plan/);
        const legacyHelper = migration.split("function public.omr_lock_legacy_teacher_identity_v1(")[1]
            ?.split("function public.omr_read_legacy_teacher_plan_v1(")[0] ?? "";
        expect(legacyHelper).toContain("from public.omr_teacher_accounts account");
        expect(legacyHelper).toContain("from public.omr_organization_members member");
        expect(legacyHelper).toContain("from public.omr_teacher_profiles profile");
        expect(legacyHelper).toMatch(/or exists \([\s\S]*from public\.omr_pilot_plan_grants grant_row/);
        expect(legacyHelper).toContain("from public.omr_pilot_plan_grants grant_row");
        expect(legacyHelper).toContain("grant_row.organization_id = p_organization_id");
        const legacyPlanHelper = migration.split("function public.omr_read_legacy_teacher_plan_v1(")[1]
            ?.split("alter function public.omr_lock_provisioned_teacher_identity_v1")[0] ?? "";
        expect(legacyPlanHelper).toContain("organization.plan");
        for (const name of [
            "omr_reserve_plan_usage_v2",
            "omr_release_plan_usage_v2",
            "omr_sync_student_plan_usage_v2",
        ]) {
            const body = migration.split(`function public.${name}(`)[1]?.split("$$;")[0] ?? "";
            expect(body).not.toMatch(/p_(?:plan|limit|observed_usage|period_start|resource_keys)/);
        }
        const releaseBody = migration.split("function public.omr_release_plan_usage_v2(")[1]
            ?.split("$$;")[0] ?? "";
        expect(releaseBody).toContain("from public.omr_exams exam");
        expect(releaseBody).toContain("for update");
        expect(releaseBody).toContain("'released', false");
        expect(releaseBody.indexOf("from public.omr_exams exam"))
            .toBeLessThan(releaseBody.indexOf("public.omr_release_plan_usage("));
    });

    it("validates identity before receipt replay and current plan before every storage capability", () => {
        for (const [name, receiptMarker, planMarker] of [
            ["omr_save_exam_v3", "from public.omr_exam_mutations", "omr_save_exam_effective_worker_v3"],
            ["omr_save_feedback_v4", "from public.omr_feedback_mutations", "omr_read_teacher_mutation_plan_v1"],
            ["omr_assign_students_v2", "last_mutation_id", "omr_read_teacher_mutation_plan_v1"],
        ] as const) {
            const body = migration.split(`function public.${name}(`)[1]
                ?.split("$$;")[0] ?? "";
            const receiptIndex = body.indexOf(receiptMarker);
            expect(body.indexOf("omr_lock_teacher_mutation_identity_v1")).toBeGreaterThan(-1);
            expect(receiptIndex).toBeGreaterThan(-1);
            expect(body.indexOf("omr_lock_teacher_mutation_identity_v1")).toBeLessThan(receiptIndex);
            expect(body.indexOf(planMarker)).toBeGreaterThan(receiptIndex);
        }
        const returnFeedback = migration.split("function public.omr_return_feedback_v4(")[1]
            ?.split("$$;")[0] ?? "";
        expect(returnFeedback.indexOf("omr_lock_teacher_mutation_identity_v1")).toBeGreaterThan(-1);
        expect(returnFeedback.indexOf("omr_lock_teacher_mutation_identity_v1"))
            .toBeLessThan(returnFeedback.indexOf("from public.omr_feedback_mutations"));
        expect(returnFeedback).not.toContain("omr_read_teacher_mutation_plan_v1");
        const clearAssignment = migration.split("function public.omr_clear_student_assignment_v2(")[1]
            ?.split("$$;")[0] ?? "";
        expect(clearAssignment.indexOf("omr_lock_teacher_mutation_identity_v1")).toBeGreaterThan(-1);
        expect(clearAssignment.indexOf("omr_lock_teacher_mutation_identity_v1"))
            .toBeLessThan(clearAssignment.indexOf("last_mutation_id"));
        expect(clearAssignment).not.toContain("omr_read_teacher_mutation_plan_v1");
        const assign = migration.split("function public.omr_assign_students_v2(")[1]
            ?.split("$$;")[0] ?? "";
        expect(assign.indexOf("omr_read_teacher_mutation_plan_v1"))
            .toBeGreaterThan(assign.indexOf("retake_unavailable"));
        expect(assign.indexOf("omr_read_teacher_mutation_plan_v1"))
            .toBeLessThan(assign.indexOf("update public.omr_exams exam"));
        const examWorker = migration.split("function public.omr_save_exam_effective_worker_v3(")[1]
            ?.split("function public.omr_save_exam_v3(")[0] ?? "";
        expect(examWorker).toMatch(/v_plan = 'free'[\s\S]*jsonb_array_length\(p_teacher_asset_intent_ids\) > 0[\s\S]*plan entitlement required/);
        for (const name of [
            "omr_prepare_teacher_asset_upload_v2",
            "omr_authorize_teacher_asset_finalize_v2",
            "omr_finalize_teacher_asset_upload_v2",
        ]) {
            const body = migration.split(`function public.${name}(`)[1]
                ?.split("$$;")[0] ?? "";
            expect(body).toContain("omr_lock_teacher_mutation_identity_v1");
            expect(body).toContain("omr_read_teacher_mutation_plan_v1");
            expect(body.indexOf("omr_lock_teacher_mutation_identity_v1"))
                .toBeLessThan(body.indexOf("omr_read_teacher_mutation_plan_v1"));
            expect(body).toMatch(/intent\.expires_at[\s\S]*(?:<=|>)[\s\S]*grantExpiresAt|least\([\s\S]*grantExpiresAt/);
        }
        const handwritingPrepare = migration.split("function public.omr_prepare_attempt_handwriting_asset_v2(")[1]
            ?.split("$$;")[0] ?? "";
        expect(handwritingPrepare).toContain("omr_read_effective_organization_plan_v1");
        expect(handwritingPrepare.indexOf("omr_read_effective_organization_plan_v1"))
            .toBeLessThan(handwritingPrepare.indexOf("for update"));
        expect(migration).toContain("handwriting_reservation_source");
        expect(migration).toContain("handwriting_reservation_grant_id");
        expect(migration).toContain("handwriting_reservation_expires_at");
        expect(migration).toContain("handwriting_reservation_expires_at > created_at");
        expect(migration).toContain("<= created_at + interval '15 minutes'");
        expect(migration).toContain("omr_remote_assets_one_handwriting_per_attempt_uidx");
        expect(migration).toContain("update public.omr_attempts attempt");
        expect(migration).toContain("attempt.payload #>> '{drawingsRef,key}' = asset.id");
        expect(handwritingPrepare).toContain("interval '15 minutes'");
        expect(handwritingPrepare).toMatch(/v_reservation_expires_at := least\([\s\S]*expiresAt/);
        expect(handwritingPrepare).toContain("v_stored.handwriting_reservation_grant_id");
        expect(handwritingPrepare).toContain("v_stored.object_path");
        expect(handwritingPrepare).not.toContain("v_stored.id is distinct from v_asset.id");
        expect(handwritingPrepare).not.toContain("v_stored.object_path is distinct from v_asset.object_path");
        expect(handwritingPrepare.indexOf("v_stored_found")).toBeLessThan(
            handwritingPrepare.indexOf("handwriting archive plan denied"),
        );
        const handwritingAttach = migration.split("function public.omr_attach_attempt_handwriting_v2(")[1]
            ?.split("$$;")[0] ?? "";
        expect(handwritingAttach).toContain("omr_read_effective_organization_plan_v1");
        expect(handwritingAttach.indexOf("v_attempt.payload -> 'drawingsRef' = v_ref"))
            .toBeLessThan(handwritingAttach.indexOf("handwriting archive plan denied"));
        expect(handwritingAttach).toContain("v_asset.handwriting_reservation_expires_at");
        expect(handwritingAttach).toContain("v_asset.handwriting_reservation_grant_id");
        const cleanup = migration.split("create function public.omr_claim_remote_asset_cleanup_v1(")[1]
            ?.split("$$;")[0] ?? "";
        expect(cleanup).toContain("asset.handwriting_reservation_expires_at");
        expect(cleanup).toContain("asset.handwriting_reservation_source is null");
        expect(cleanup).toContain("for update skip locked");
        expect(cleanup).toContain("delete from public.omr_remote_assets asset");
        expect(cleanup).toContain("attempt.payload #>> '{drawingsRef,key}' = asset.id");
    });

    it("redefines targeted student guards to use effective entitlement, never forged organization plan", () => {
        for (const name of [
            "omr_assert_targeted_assignment_scope_v1",
            "omr_validate_targeted_attempt_session_v1",
            "omr_validate_targeted_attempt_v1",
        ]) {
            expect(migration).toContain(`function public.${name}(`);
        }
        const assertBody = migration.split("function public.omr_assert_targeted_assignment_scope_v1(")[1]
            ?.split("$$;")[0] ?? "";
        expect(assertBody).not.toContain("omr_read_effective_organization_plan_v1");
        expect(assertBody).not.toContain("organization.plan");
        const attemptBody = migration.split("function public.omr_validate_targeted_attempt_v1(")[1]
            ?.split("$$;")[0] ?? "";
        expect(attemptBody).toContain("omr_assert_effective_plan_transaction_proof_v1");
        expect(attemptBody).toContain("from public.omr_attempt_sessions attempt_session");
        expect(attemptBody).not.toContain("organization.plan");
        const sessionTrigger = migration.split("function public.omr_validate_targeted_attempt_session_v1(")[1]
            ?.split("$$;")[0] ?? "";
        expect(sessionTrigger).toContain("omr_assert_effective_plan_transaction_proof_v1");
        expect(sessionTrigger).not.toContain("omr_read_effective_organization_plan_v1");
        const open = migration.split("function public.omr_open_attempt_session_v2(")[1]
            ?.split("$$;")[0] ?? "";
        expect(open.indexOf("omr_prove_effective_organization_plan_v1"))
            .toBeLessThan(open.indexOf("omr_open_attempt_session_v1"));
    });

    it("revokes every caller-trusting or generic service-role bypass", () => {
        for (const signature of [
            "omr_save_remote_asset_metadata_v1(jsonb)",
            "omr_save_roster_v2(text,jsonb,jsonb,jsonb,jsonb,bigint)",
            "omr_save_roster_v1(text,jsonb,jsonb,jsonb,jsonb)",
            "omr_save_roster_plan_unlocked_v1(text,jsonb,jsonb,jsonb,jsonb)",
            "omr_save_roster_unlocked_v1(text,jsonb,jsonb,jsonb,jsonb)",
            "omr_save_exam_v2(jsonb,jsonb,jsonb,text,bigint,text)",
            "omr_prepare_teacher_asset_upload_v1(jsonb)",
            "omr_authorize_teacher_asset_finalize_v1(text,text,text,jsonb)",
            "omr_finalize_teacher_asset_upload_v1(text,text,text,jsonb)",
            "omr_prepare_attempt_handwriting_asset_v1(text,jsonb)",
            "omr_attach_attempt_handwriting_v1(text,text,jsonb)",
            "omr_save_feedback_v3(text,jsonb,bigint,text)",
            "omr_return_feedback_v3(text,text,bigint,text)",
            "omr_save_feedback_v2(text,jsonb,bigint,text)",
            "omr_return_feedback_v2(text,text,bigint,text)",
            "omr_assign_students_v1(text,text,text,text,text[],text,bigint,text)",
            "omr_clear_student_assignment_v1(text,text,text,text,bigint,text,text[],text)",
            "omr_reserve_plan_usage(text,text,date,text,integer,integer,integer)",
            "omr_release_plan_usage(text,text,date,text)",
            "omr_sync_student_plan_usage(text,text[],integer,integer)",
            "omr_open_attempt_session_v1(text,text,text,text,text,text,text,text,text,text,text,integer[],integer[],timestamp with time zone,jsonb,integer,timestamp with time zone,text,text,integer)",
        ]) {
            expect(migration).toContain(`revoke all on function public.${signature}`);
        }
    });

    it("keeps private helpers private and public vNext RPCs service-role-only", () => {
        expect(migration).toMatch(/set search_path = ''/g);
        expect(migration).toContain("set statement_timeout = '5s'");
        expect(migration).toContain("set lock_timeout = '2s'");
        for (const signature of [
            "omr_lock_provisioned_teacher_identity_v1(text,bigint,text)",
            "omr_authorize_effective_teacher_plan_v1(text,text)",
            "omr_read_effective_organization_plan_v1(text)",
            "omr_lock_legacy_teacher_identity_v1(text,bigint,text,text)",
            "omr_read_legacy_teacher_plan_v1(text,text,text)",
            "omr_lock_teacher_mutation_identity_v1(text,text,bigint,text,text)",
            "omr_read_teacher_mutation_plan_v1(text,text,text,text)",
        ]) {
            expect(migration).toContain(
                `revoke all on function public.${signature}\n    from public, anon, authenticated, service_role;`,
            );
        }
        expect(migration).not.toMatch(/grant execute[^;]+to\s+(?:public|anon|authenticated)\b/i);
    });

    it("attests the exact Phase C routine catalog and bodies instead of trusting marker substrings", () => {
        expect(productionBoundary).toContain("v_effective_workspace_plan_enforcement_ready");
        expect(productionBoundary).toContain("pg_catalog.pg_get_function_result(routine.oid)");
        expect(productionBoundary).toContain("pg_catalog.obj_description(routine.oid, 'pg_proc')");
        expect(productionBoundary).toContain("'statement_timeout=5s'");
        expect(productionBoundary).toContain("'lock_timeout=2s'");
        expect(productionBoundary).toMatch(/extensions\.digest\([\s\S]*phase-c-effective-plan-enforcement:202608080008/);
        expect(productionBoundary).toContain("e7d60f32babc3f278fa673fcb8707e530fab4d42307f853bc271d5371bc17148");
        expect(productionBoundary).toContain("omr_save_exam_effective_worker_v3");
        expect(productionBoundary).toContain("omr_set_effective_plan_transaction_proof_v1");
        expect(productionBoundary).toContain("omr_claim_remote_asset_cleanup_v8_snapshot");
        expect(productionBoundary).not.toContain("exact legacy self-service teacher account lookup envelope:202608080008");
        expect(productionBoundary).toContain("exact legacy self-service teacher account lookup envelope:202608080007");
    });

    it("reapplies the Phase C ACL fence after every production and rollback blanket grant", () => {
        for (const boundary of [productionBoundary, rollbackBoundary]) {
            const lastBlanket = boundary.lastIndexOf("grant all on all functions in schema public to service_role");
            const tail = boundary.slice(lastBlanket);
            expect(lastBlanket).toBeGreaterThan(-1);
            for (const table of [
                "omr_remote_assets", "omr_remote_asset_upload_intents",
                "omr_remote_asset_cleanup_queue", "omr_plan_usage", "omr_plan_usage_reservations",
            ]) {
                expect(tail).toContain(`revoke all on table public.${table} from service_role;`);
                expect(tail).toContain(`grant select on table public.${table} to service_role;`);
            }
            expect(tail).toContain("revoke all on sequence public.omr_remote_asset_cleanup_queue_id_seq from service_role;");
            for (const signature of [
                "omr_set_effective_plan_transaction_proof_v1(text,jsonb)",
                "omr_claim_remote_asset_cleanup_v8_snapshot(text,integer,integer)",
                "omr_assert_targeted_assignment_scope_v1(text,text,text,text,text,text,integer[])",
                "omr_save_exam_v2(jsonb,jsonb,jsonb,text,bigint,text)",
                "omr_reserve_plan_usage(text,text,date,text,integer,integer,integer)",
            ]) expect(tail).toContain(`revoke all on function public.${signature}`);
            for (const signature of [
                "omr_save_roster_v3(text,text,bigint,text,text,jsonb,jsonb,jsonb,jsonb,bigint)",
                "omr_prepare_attempt_handwriting_asset_v2(text,text,text,jsonb)",
                "omr_sync_student_plan_usage_v2(text,text,bigint,text,text)",
            ]) {
                expect(tail).toContain(`revoke all on function public.${signature} from public, anon, authenticated;`);
                expect(tail).toContain(`grant execute on function public.${signature} to service_role;`);
            }
        }
        const finalRollbackFence = rollbackBoundary.lastIndexOf("Final Stage 3 Phase C ACL fence");
        expect(finalRollbackFence).toBeGreaterThan(
            rollbackBoundary.lastIndexOf("grant execute on function public.omr_return_feedback_v3"),
        );
        expect(rollbackBoundary.lastIndexOf(
            "revoke all on function public.omr_return_feedback_v3(text,text,bigint,text)",
        )).toBeGreaterThan(finalRollbackFence);
    });

    it("keeps the 100-user operational gate on exact v2 paths with a seeded legacy account graph", () => {
        expect(migration).toContain("rename to omr_initial_ops_fixture_v26_snapshot");
        expect(migration).toContain("rename to omr_initial_ops_database_snapshot_v26_snapshot");
        expect(migration).toContain("'teacherIdentity'");
        expect(migration).toContain("'sessionAuthority', 'legacy_account'");
        expect(migration).toContain("'accountSessionGeneration', 1");
        expect(migration).toContain("insert into public.omr_teacher_accounts");
        expect(migration).toContain("insert into public.omr_teacher_profiles");
        expect(migration).toContain("'rpc:omr_open_attempt_session_v2'");
        expect(migration).toContain("'rpc:omr_prepare_teacher_asset_upload_v2'");
        expect(migration).toContain("'rpc:omr_authorize_teacher_asset_finalize_v2'");
        expect(migration).toContain("'rpc:omr_finalize_teacher_asset_upload_v2'");
        expect(productionBoundary).toContain("omr_initial_ops_fixture_v26_snapshot");
        expect(productionBoundary).toContain("phase-c-initial-ops-identity-and-v2-paths:202608080008");
        expect(productionBoundary).toContain("ac8aef94e7e0edd577a4077c4727f44e8af4db6c421796bed385fcc9d48ff576");
        expect(rollbackBoundary.slice(rollbackBoundary.lastIndexOf("Final Stage 3 Phase C ACL fence")))
            .toContain("omr_initial_ops_fixture_v26_snapshot");
    });
});
