-- OMR Maker production server-only data boundary — ROLLBACK.
--
-- Inverse of supabase/production-server-boundary.sql, split into three stages
-- because they are not equally safe. Rolling this back means giving browser
-- roles their access back, so the stages are ordered by how much they re-expose
-- and the destructive ones refuse to run without an explicit confirmation.
--
--   STAGE 1  Storage only. Removes the restrictive policies that closed the
--            omr-private-assets bucket. Runs unconditionally. This is the stage
--            you almost certainly want: it is the only part of the boundary that
--            touches Supabase-managed relations, so it is the most likely thing
--            to have broken something unexpected.
--
--   STAGE 2  Browser role privileges on schema public. Re-exposes application
--            data to anon/authenticated. Requires confirmation.
--
--   STAGE 3  The 25 alpha allow-all RLS policies from schema.sql, and the FORCE
--            RLS flags. Returns the database to "anyone with the publishable key
--            can read and write everything". Requires confirmation.
--
-- Run only STAGE 1 unless you specifically need the others. Stages 2 and 3 are
-- pointless on their own — with no grants, policies do nothing, and with no
-- policies, grants are still blocked by RLS — so use 2+3 together or neither.
--
-- To enable stages 2 and 3, in the same session:
--
--     set omr.rollback_confirm = 'restore-browser-access';
--
-- WHAT THIS DOES NOT DO
--
--   - It does not restore the Supabase Auth policies from production-rls.sql.
--     If a database rehearsed that profile before the server-only cutover, run
--     production-rls.sql again instead of stage 3.
--   - It does not undo migrations. The gateway RPCs, preflight functions and
--     schema changes stay; they are additive and the app needs them.
--   - It does not re-create "OMR private assets alpha access" on
--     storage.objects. That policy is a test fixture from live-test-prelude.sql,
--     not a production object — a hosted project's own bucket policies are
--     whatever you configured them to be, and stage 1 leaves those untouched.
--
-- Verified by scripts/verify-supabase-live.mjs against PostgreSQL 17: boundary
-- applies, rollback reverts, and browser CRUD is denied before and permitted
-- after the full three-stage run.

-- ---------------------------------------------------------------------------
-- STAGE 1 — Storage: reopen the private bucket to browser roles.
-- ---------------------------------------------------------------------------

begin;

do $$
begin
    if current_user is distinct from 'postgres' then
        raise exception using
            errcode = '42501',
            message = 'rollback must run as migration owner postgres';
    end if;
    if not exists (select 1 from pg_roles where rolname = 'supabase_storage_admin')
        or not pg_has_role(session_user, 'supabase_storage_admin', 'SET')
    then
        raise exception using
            errcode = '42501',
            message = 'postgres must be able to SET ROLE supabase_storage_admin';
    end if;
end
$$;

-- Same owner dance as the boundary: Supabase requires managed Storage entities
-- to retain supabase_storage_admin ownership, so enter that role only for the
-- policy phase. Dropping the restrictive policies is enough — restrictive
-- policies only ever subtract, so removing them restores whatever permissive
-- policies the project already had.
set local role supabase_storage_admin;

drop policy if exists "OMR private assets server-only objects" on storage.objects;
drop policy if exists "OMR private assets server-only buckets" on storage.buckets;

reset role;

commit;

-- ---------------------------------------------------------------------------
-- STAGE 2 — Browser role privileges on schema public.
--
-- DANGER: after this, anon/authenticated can reach application tables again
-- (subject to RLS). Requires omr.rollback_confirm.
-- ---------------------------------------------------------------------------

begin;

do $$
begin
    if current_user is distinct from 'postgres' then
        raise exception using
            errcode = '42501',
            message = 'rollback must run as migration owner postgres';
    end if;
    if current_setting('omr.rollback_confirm', true) is distinct from 'restore-browser-access' then
        raise exception using
            errcode = '42501',
            message = 'stage 2 re-exposes application data to browser roles; '
                   || 'run: set omr.rollback_confirm = ''restore-browser-access'';';
    end if;
end
$$;

-- Undo the fail-closed default privileges first, so objects created after this
-- point behave like they did before the boundary.
alter default privileges for role postgres in schema public
    grant all on tables to anon, authenticated;
alter default privileges for role postgres in schema public
    grant all on sequences to anon, authenticated;
alter default privileges for role postgres in schema public
    grant execute on functions to anon, authenticated;
alter default privileges for role postgres
    grant execute on functions to public;

grant usage on schema public to anon, authenticated;
grant all on all tables in schema public to anon, authenticated;
grant all on all sequences in schema public to anon, authenticated;
grant execute on all functions in schema public to anon, authenticated;

-- service_role keeps everything it had; the boundary granted it and nothing
-- here takes it away.
grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant all on all functions in schema public to service_role;

-- CRITICAL: the blanket grants above are broader than the alpha baseline ever
-- was. schema.sql and the migrations explicitly revoked a set of tables and
-- SECURITY DEFINER RPCs from browser roles even while everything else was wide
-- open — re-granting without re-revoking would leave the database MORE exposed
-- after a rollback than it was before the boundary was ever applied. Restore
-- those revokes here.
revoke all on public.omr_student_start_credentials from anon, authenticated;
revoke all on public.omr_roster_invites from anon, authenticated;
revoke all on public.omr_remote_asset_upload_intents from anon, authenticated;
revoke all on public.omr_remote_asset_cleanup_queue from anon, authenticated;
revoke all on sequence public.omr_remote_asset_cleanup_queue_id_seq from anon, authenticated;
revoke all on table public.omr_attempt_sessions from public, anon, authenticated;
revoke all on table public.omr_rate_limit_buckets from public, anon, authenticated, service_role;
revoke all on table public.omr_exam_mutations from public, anon, authenticated, service_role;
revoke all on table public.omr_feedback_mutations from public, anon, authenticated, service_role;
revoke all on table public.omr_exam_entry_invites from public, anon, authenticated, service_role;
revoke all on table public.omr_initial_ops_metrics from public, anon, authenticated, service_role;
revoke all on table public.omr_teacher_accounts from public, anon, authenticated, service_role;
revoke all on table public.omr_teacher_account_tokens from public, anon, authenticated, service_role;
revoke all on table public.omr_teacher_notification_states from public, anon, authenticated, service_role;
revoke all on table public.omr_operational_job_status from public, anon, authenticated, service_role;
revoke all on table public.omr_pilot_plan_grants from public, anon, authenticated, service_role;
revoke all on table public.omr_student_credential_epochs from public, anon, authenticated, service_role;
revoke all on table public.omr_student_credential_batch_receipts from public, anon, authenticated, service_role;
revoke all on table public.omr_kakao_candidate_reviews
    from public, anon, authenticated, service_role;
revoke all on table public.omr_kakao_dispatch_logs
    from public, anon, authenticated, service_role;
revoke all on table public.omr_kakao_reminder_legacy_quarantine
    from public, anon, authenticated, service_role;
grant select on table public.omr_kakao_candidate_reviews to service_role;
grant select on table public.omr_kakao_dispatch_logs to service_role;
grant select on table public.omr_kakao_reminder_legacy_quarantine to service_role;
do $kakao_rpc_overload_acl$
declare
    routine record;
begin
    for routine in
        select proc.proname, proc.prokind,
               pg_catalog.pg_get_function_identity_arguments(proc.oid) as identity_arguments
          from pg_catalog.pg_proc proc
          join pg_catalog.pg_namespace namespace on namespace.oid = proc.pronamespace
         where namespace.nspname = 'public'
           and proc.proname in (
               'omr_save_kakao_candidate_review_v1',
               'omr_save_kakao_simulation_dispatch_v1',
               'omr_kakao_reminder_legacy_inventory_v1',
               'omr_quarantine_kakao_reminder_legacy_v1',
               'omr_kakao_reminder_entitlement_ready_v1'
           )
    loop
        execute pg_catalog.format(
            'revoke all on %s public.%I(%s) from public, anon, authenticated, service_role',
            case when routine.prokind = 'p' then 'procedure' else 'function' end,
            routine.proname,
            routine.identity_arguments
        );
    end loop;
end
$kakao_rpc_overload_acl$;
alter function public.omr_save_kakao_candidate_review_v1(text,text,bigint,text,text,jsonb)
    owner to postgres;
alter function public.omr_save_kakao_simulation_dispatch_v1(text,text,bigint,text,text,jsonb)
    owner to postgres;
revoke all on function public.omr_save_kakao_candidate_review_v1(text,text,bigint,text,text,jsonb)
    from public, anon, authenticated, service_role;
grant execute on function public.omr_save_kakao_candidate_review_v1(text,text,bigint,text,text,jsonb)
    to service_role;
revoke all on function public.omr_save_kakao_simulation_dispatch_v1(text,text,bigint,text,text,jsonb)
    from public, anon, authenticated, service_role;
grant execute on function public.omr_save_kakao_simulation_dispatch_v1(text,text,bigint,text,text,jsonb)
    to service_role;
grant execute on function public.omr_kakao_reminder_legacy_inventory_v1()
    to service_role;
grant execute on function public.omr_kakao_reminder_entitlement_ready_v1()
    to service_role;
revoke all on table public.omr_student_start_credentials from service_role;
grant select on table public.omr_student_start_credentials to service_role;
revoke all on sequence public.omr_operational_job_run_sequence from public, anon, authenticated, service_role;


-- Phase C keeps service_role on audited public RPCs only. Reassert this after
-- the blanket compatibility grant so direct DML/private-worker execution cannot
-- bypass the same-transaction identity and effective-plan fences.
revoke all on table public.omr_remote_assets from service_role;
revoke all on table public.omr_remote_asset_upload_intents from service_role;
revoke all on table public.omr_remote_asset_cleanup_queue from service_role;
revoke all on table public.omr_plan_usage from service_role;
revoke all on table public.omr_plan_usage_reservations from service_role;
grant select on table public.omr_remote_assets to service_role;
grant select on table public.omr_remote_asset_upload_intents to service_role;
grant select on table public.omr_remote_asset_cleanup_queue to service_role;
grant select on table public.omr_plan_usage to service_role;
grant select on table public.omr_plan_usage_reservations to service_role;
revoke all on sequence public.omr_remote_asset_cleanup_queue_id_seq from service_role;
revoke all on function public.omr_lock_provisioned_teacher_identity_v1(text,bigint,text) from public, anon, authenticated, service_role;
revoke all on function public.omr_authorize_effective_teacher_plan_v1(text,text) from public, anon, authenticated, service_role;
revoke all on function public.omr_read_effective_organization_plan_v1(text) from public, anon, authenticated, service_role;
revoke all on function public.omr_set_effective_plan_transaction_proof_v1(text,jsonb) from public, anon, authenticated, service_role;
revoke all on function public.omr_prove_effective_organization_plan_v1(text) from public, anon, authenticated, service_role;
revoke all on function public.omr_assert_effective_plan_transaction_proof_v1(text,boolean) from public, anon, authenticated, service_role;
revoke all on function public.omr_lock_legacy_teacher_identity_v1(text,bigint,text,text) from public, anon, authenticated, service_role;
revoke all on function public.omr_read_legacy_teacher_plan_v1(text,text,text) from public, anon, authenticated, service_role;
revoke all on function public.omr_lock_teacher_mutation_identity_v1(text,text,bigint,text,text) from public, anon, authenticated, service_role;
revoke all on function public.omr_read_teacher_mutation_plan_v1(text,text,text,text) from public, anon, authenticated, service_role;
revoke all on function public.omr_save_exam_effective_worker_v3(text,text,text,text,jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
revoke all on function public.omr_save_feedback_effective_worker_v4(text,jsonb,bigint,text) from public, anon, authenticated, service_role;
revoke all on function public.omr_claim_remote_asset_cleanup_v8_snapshot(text,integer,integer) from public, anon, authenticated, service_role;
revoke all on function public.omr_save_roster_v2(text,jsonb,jsonb,jsonb,jsonb,bigint) from public, anon, authenticated, service_role;
revoke all on function public.omr_save_roster_v1(text,jsonb,jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
revoke all on function public.omr_save_exam_v2(jsonb,jsonb,jsonb,text,bigint,text) from public, anon, authenticated, service_role;
revoke all on function public.omr_save_exam_v1(jsonb,jsonb,jsonb,text) from public, anon, authenticated, service_role;
revoke all on function public.omr_prepare_teacher_asset_upload_v1(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.omr_authorize_teacher_asset_finalize_v1(text,text,text,jsonb) from public, anon, authenticated, service_role;
revoke all on function public.omr_finalize_teacher_asset_upload_v1(text,text,text,jsonb) from public, anon, authenticated, service_role;
revoke all on function public.omr_prepare_attempt_handwriting_asset_v1(text,jsonb) from public, anon, authenticated, service_role;
revoke all on function public.omr_attach_attempt_handwriting_v1(text,text,jsonb) from public, anon, authenticated, service_role;
revoke all on function public.omr_save_remote_asset_metadata_v1(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.omr_save_feedback_v3(text,jsonb,bigint,text) from public, anon, authenticated, service_role;
revoke all on function public.omr_return_feedback_v3(text,text,bigint,text) from public, anon, authenticated, service_role;
revoke all on function public.omr_save_feedback_v2(text,jsonb,bigint,text) from public, anon, authenticated, service_role;
revoke all on function public.omr_return_feedback_v2(text,text,bigint,text) from public, anon, authenticated, service_role;
revoke all on function public.omr_assign_students_v1(text,text,text,text,text[],text,bigint,text) from public, anon, authenticated, service_role;
revoke all on function public.omr_clear_student_assignment_v1(text,text,text,text,bigint,text,text[],text) from public, anon, authenticated, service_role;
revoke all on function public.omr_open_attempt_session_v1(text,text,text,text,text,text,text,text,text,text,text,integer[],integer[],timestamp with time zone,jsonb,integer,timestamp with time zone,text,text,integer) from public, anon, authenticated, service_role;
revoke all on function public.omr_reserve_plan_usage(text,text,date,text,integer,integer,integer) from public, anon, authenticated, service_role;
revoke all on function public.omr_release_plan_usage(text,text,date,text) from public, anon, authenticated, service_role;
revoke all on function public.omr_sync_student_plan_usage(text,text[],integer,integer) from public, anon, authenticated, service_role;


do $$
declare
    guarded_function text;
    guarded_functions text[] := array[
        'omr_answer_attempt_question_v1',
        'omr_upsert_student_attempt_question_v1',
        'omr_assert_production_boundary_preflight_v1',
        'omr_attach_attempt_handwriting_v1',
        'omr_prepare_attempt_handwriting_asset_v1',
        'omr_discard_attempt_handwriting_asset_v1',
        'omr_claim_guest_attempts_v1',
        'omr_claim_remote_asset_cleanup_v1',
        'omr_gc_attempt_sessions_v1',
        'omr_requeue_dead_remote_asset_cleanup_v1',
        'omr_authorize_remote_asset_cleanup_delete_v1',
        'omr_ack_remote_asset_cleanup_v1',
        'omr_fail_remote_asset_cleanup_v1',
        'omr_begin_operational_job_run_v1',
        'omr_complete_operational_job_run_v1',
        'omr_read_operational_job_status_v1',
        'omr_provision_pilot_teacher_v1',
        'omr_read_effective_workspace_plan_v1',
        'omr_lookup_provisioned_teacher_login_v1',
        'omr_validate_provisioned_teacher_session_v1',
        'omr_probe_provisioned_teacher_canary_v1',
        'omr_authorize_teacher_asset_finalize_v1',
        'omr_enqueue_remote_asset_cleanup_v1',
        'omr_enqueue_exam_asset_cleanup_v1',
        'omr_remote_assets_enqueue_cleanup_v1',
        'omr_exams_enqueue_asset_cleanup_v1',
        'omr_mark_exam_reservation_durable_v1',
        'omr_prepare_teacher_asset_upload_v6_snapshot',
        'omr_save_exam_v6_snapshot',
        'omr_save_exam_v10_snapshot',
        'omr_release_plan_usage_v10_snapshot',
        'omr_normalize_exam_save_request_v10',
        'omr_bootstrap_workspace_organization_v1',
        'omr_save_feedback_v2',
        'omr_return_feedback_v2',
        'omr_save_feedback_v3',
        'omr_return_feedback_v3',
        'omr_save_feedback_v12_snapshot',
        'omr_return_feedback_v12_snapshot',
        'omr_delete_exam_v1',
        'omr_force_finish_attempts_v1',
        'omr_guard_student_credential_mutation_v1',
        'omr_mark_feedback_opened_v2',
        'omr_open_attempt_session_v1',
        'omr_checkpoint_attempt_session_v1',
        'omr_heartbeat_attempt_session_v1',
        'omr_takeover_attempt_session_v1',
        'omr_prepare_attempt_session_submit_v1',
        'omr_commit_attempt_session_submit_v1',
        'omr_prepare_teacher_asset_upload_v1',
        'omr_finalize_teacher_asset_upload_v1',
        'omr_production_boundary_preflight_v1',
        'omr_release_plan_usage',
        'omr_reserve_plan_usage',
        'omr_return_feedback_v1',
        'omr_revoke_withdrawn_student_credential_v1',
        'omr_save_exam_plan_unlocked_v1',
        'omr_save_exam_v1',
        'omr_save_exam_v2',
        'omr_save_feedback_v1',
        'omr_save_remote_asset_metadata_v1',
        'omr_save_roster_plan_unlocked_v1',
        'omr_save_roster_unlocked_v1',
        'omr_save_roster_v1',
        'omr_service_readiness_v1',
        'omr_service_readiness_v6_snapshot',
        'omr_service_readiness_v7_snapshot',
        'omr_service_readiness_v10_snapshot',
        'omr_set_subquestion_review_v1',
        'omr_submit_attempt_v1',
        'omr_submit_session_attempt_v1',
        'omr_sync_student_plan_usage',
        'omr_teacher_attempt_write_allowed_v1',
        'omr_teacher_update_attempt_v1',
        'omr_consume_rate_limit_v1',
        'omr_teacher_notification_summary_v1',
        'omr_load_teacher_notification_state_v1',
        'omr_mutate_teacher_notification_state_v1',
        'omr_list_active_attempt_sessions_v1',
        'omr_prepare_teacher_force_finish_sessions_v1',
        'omr_force_finish_attempt_sessions_v1',
        'omr_prepare_teacher_force_finish_sessions_compact_v1',
        'omr_force_finish_attempt_sessions_compact_v1',
        'omr_teacher_force_finish_fingerprint_v1',
        'omr_begin_teacher_signup_v1',
        'omr_begin_teacher_password_reset_v1',
        'omr_complete_teacher_password_reset_v1',
        'omr_verify_teacher_email_v1',
        'omr_lookup_teacher_account_v1',
        'omr_validate_teacher_session_v1',
        'omr_advance_teacher_session_on_disable_v1',
        'omr_initial_ops_fixture_v1',
        'omr_initial_ops_reserve_upload_v1',
        'omr_initial_ops_operation_v1',
        'omr_initial_ops_database_snapshot_v1',
        'omr_rotate_exam_entry_invite_v1',
        'omr_resolve_exam_entry_invite_v1',
        'omr_get_exam_entry_invite_metadata_v1',
        'omr_revoke_exam_entry_invite_v1',
        'omr_assign_students_v1',
        'omr_clear_student_assignment_v1',
        'omr_load_teacher_student_assignment_v1',
        'omr_list_student_assignments_v1',
        'omr_resolve_student_assignment_v1',
        'omr_assert_targeted_assignment_scope_v1',
        'omr_validate_targeted_attempt_session_v1',
        'omr_validate_targeted_attempt_v1',
        'omr_guard_targeted_exam_access_v1',
        'omr_teacher_attempt_aggregate_v1',
        'omr_teacher_attempt_export_v1',
        'omr_teacher_attempt_export_page_v1'
    ];
begin
    -- Revoke every overload by identity so a signature change cannot silently
    -- leave one reachable.
    for guarded_function in select unnest(guarded_functions) loop
        execute (
            select coalesce(string_agg(
                format(
                    'revoke all on function public.%I(%s) from public, anon, authenticated;',
                    proc.proname,
                    pg_get_function_identity_arguments(proc.oid)
                ),
                ' '
            ), 'select 1;')
              from pg_proc proc
              join pg_namespace namespace on namespace.oid = proc.pronamespace
             where namespace.nspname = 'public'
               and proc.proname = guarded_function
        );
    end loop;
end
$$;

revoke all on function public.omr_teacher_force_finish_fingerprint_v1(bigint,jsonb,jsonb,integer[],jsonb)
    from public, anon, authenticated, service_role;
revoke all on function public.omr_advance_teacher_session_on_disable_v1()
    from public, anon, authenticated, service_role;
revoke all on function public.omr_assert_targeted_assignment_scope_v1(text,text,text,text,text,text,integer[])
    from public, anon, authenticated, service_role;
revoke all on function public.omr_validate_targeted_attempt_session_v1()
    from public, anon, authenticated, service_role;
revoke all on function public.omr_validate_targeted_attempt_v1()
    from public, anon, authenticated, service_role;
revoke all on function public.omr_guard_targeted_exam_access_v1()
    from public, anon, authenticated, service_role;

-- Preserve the latest protocol boundary after the intentionally broad alpha
-- grants. Old cleanup workers and blind exam writers fail closed; only the
-- epoch-fenced, rate-limit, and CAS signatures remain callable by the server.
revoke execute on function public.omr_ack_remote_asset_cleanup_v1(text,text)
    from service_role;
revoke execute on function public.omr_fail_remote_asset_cleanup_v1(text,text,text)
    from service_role;
revoke execute on function public.omr_save_exam_v1(jsonb,jsonb,jsonb,text)
    from service_role;
revoke execute on function public.omr_save_feedback_v1(text,jsonb)
    from service_role;
revoke execute on function public.omr_return_feedback_v1(text,text,timestamptz)
    from service_role;
revoke all on function public.omr_save_exam_v10_snapshot(jsonb,jsonb,jsonb,text)
    from public, anon, authenticated, service_role;
revoke all on function public.omr_release_plan_usage_v10_snapshot(text,text,date,text)
    from public, anon, authenticated, service_role;
revoke all on function public.omr_normalize_exam_save_request_v10(jsonb)
    from public, anon, authenticated, service_role;
revoke all on function public.omr_save_feedback_v12_snapshot(text,jsonb)
    from public, anon, authenticated, service_role;
revoke all on function public.omr_return_feedback_v12_snapshot(text,text,timestamptz)
    from public, anon, authenticated, service_role;
grant execute on function public.omr_authorize_remote_asset_cleanup_delete_v1(text,text,integer)
    to service_role;
grant execute on function public.omr_ack_remote_asset_cleanup_v1(text,text,integer)
    to service_role;
grant execute on function public.omr_fail_remote_asset_cleanup_v1(text,text,integer,text)
    to service_role;
grant execute on function public.omr_consume_rate_limit_v1(text,text,integer,integer,integer)
    to service_role;
grant execute on function public.omr_save_exam_v2(jsonb,jsonb,jsonb,text,bigint,text)
    to service_role;
grant execute on function public.omr_bootstrap_workspace_organization_v1(text,text,jsonb,timestamptz)
    to service_role;
grant execute on function public.omr_save_feedback_v2(text,jsonb,bigint,text)
    to service_role;
grant execute on function public.omr_return_feedback_v2(text,text,bigint,text)
    to service_role;
grant execute on function public.omr_save_feedback_v3(text,jsonb,bigint,text)
    to service_role;
grant execute on function public.omr_return_feedback_v3(text,text,bigint,text)
    to service_role;
grant execute on function public.omr_gc_attempt_sessions_v1(integer,integer)
    to service_role;
grant execute on function public.omr_requeue_dead_remote_asset_cleanup_v1(text,text,integer,text,text)
    to service_role;


-- Final Phase C ACL fence. Keep this after every compatibility grant above.
revoke all on table public.omr_remote_assets from service_role;
revoke all on table public.omr_remote_asset_upload_intents from service_role;
revoke all on table public.omr_remote_asset_cleanup_queue from service_role;
revoke all on table public.omr_plan_usage from service_role;
revoke all on table public.omr_plan_usage_reservations from service_role;
grant select on table public.omr_remote_assets to service_role;
grant select on table public.omr_remote_asset_upload_intents to service_role;
grant select on table public.omr_remote_asset_cleanup_queue to service_role;
grant select on table public.omr_plan_usage to service_role;
grant select on table public.omr_plan_usage_reservations to service_role;
revoke all on sequence public.omr_remote_asset_cleanup_queue_id_seq from service_role;
revoke all on function public.omr_lock_provisioned_teacher_identity_v1(text,bigint,text) from public, anon, authenticated, service_role;
revoke all on function public.omr_authorize_effective_teacher_plan_v1(text,text) from public, anon, authenticated, service_role;
revoke all on function public.omr_read_effective_organization_plan_v1(text) from public, anon, authenticated, service_role;
revoke all on function public.omr_set_effective_plan_transaction_proof_v1(text,jsonb) from public, anon, authenticated, service_role;
revoke all on function public.omr_prove_effective_organization_plan_v1(text) from public, anon, authenticated, service_role;
revoke all on function public.omr_assert_effective_plan_transaction_proof_v1(text,boolean) from public, anon, authenticated, service_role;
revoke all on function public.omr_lock_legacy_teacher_identity_v1(text,bigint,text,text) from public, anon, authenticated, service_role;
revoke all on function public.omr_read_legacy_teacher_plan_v1(text,text,text) from public, anon, authenticated, service_role;
revoke all on function public.omr_lock_teacher_mutation_identity_v1(text,text,bigint,text,text) from public, anon, authenticated, service_role;
revoke all on function public.omr_read_teacher_mutation_plan_v1(text,text,text,text) from public, anon, authenticated, service_role;
revoke all on function public.omr_save_exam_effective_worker_v3(text,text,text,text,jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
revoke all on function public.omr_save_feedback_effective_worker_v4(text,jsonb,bigint,text) from public, anon, authenticated, service_role;
revoke all on function public.omr_claim_remote_asset_cleanup_v8_snapshot(text,integer,integer) from public, anon, authenticated, service_role;
revoke all on function public.omr_initial_ops_fixture_v26_snapshot(text,text,text,text,text) from public, anon, authenticated, service_role;
revoke all on function public.omr_initial_ops_database_snapshot_v26_snapshot(text,text,text,text,text) from public, anon, authenticated, service_role;
revoke all on function public.omr_assert_targeted_assignment_scope_v1(text,text,text,text,text,text,integer[]) from public, anon, authenticated, service_role;
revoke all on function public.omr_validate_targeted_attempt_session_v1() from public, anon, authenticated, service_role;
revoke all on function public.omr_validate_targeted_attempt_v1() from public, anon, authenticated, service_role;
revoke all on function public.omr_guard_targeted_exam_access_v1() from public, anon, authenticated, service_role;
revoke all on function public.omr_save_roster_v2(text,jsonb,jsonb,jsonb,jsonb,bigint) from public, anon, authenticated, service_role;
revoke all on function public.omr_save_roster_v1(text,jsonb,jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
revoke all on function public.omr_save_roster_plan_unlocked_v1(text,jsonb,jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
revoke all on function public.omr_save_roster_unlocked_v1(text,jsonb,jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
revoke all on function public.omr_save_exam_v2(jsonb,jsonb,jsonb,text,bigint,text) from public, anon, authenticated, service_role;
revoke all on function public.omr_save_exam_v1(jsonb,jsonb,jsonb,text) from public, anon, authenticated, service_role;
revoke all on function public.omr_save_exam_v10_snapshot(jsonb,jsonb,jsonb,text) from public, anon, authenticated, service_role;
revoke all on function public.omr_save_exam_v6_snapshot(jsonb,jsonb,jsonb,text) from public, anon, authenticated, service_role;
revoke all on function public.omr_save_exam_plan_unlocked_v1(jsonb,jsonb) from public, anon, authenticated, service_role;
revoke all on function public.omr_prepare_teacher_asset_upload_v1(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.omr_prepare_teacher_asset_upload_v6_snapshot(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.omr_authorize_teacher_asset_finalize_v1(text,text,text,jsonb) from public, anon, authenticated, service_role;
revoke all on function public.omr_finalize_teacher_asset_upload_v1(text,text,text,jsonb) from public, anon, authenticated, service_role;
revoke all on function public.omr_prepare_attempt_handwriting_asset_v1(text,jsonb) from public, anon, authenticated, service_role;
revoke all on function public.omr_attach_attempt_handwriting_v1(text,text,jsonb) from public, anon, authenticated, service_role;
revoke all on function public.omr_save_remote_asset_metadata_v1(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.omr_save_feedback_v3(text,jsonb,bigint,text) from public, anon, authenticated, service_role;
revoke all on function public.omr_return_feedback_v3(text,text,bigint,text) from public, anon, authenticated, service_role;
revoke all on function public.omr_save_feedback_v2(text,jsonb,bigint,text) from public, anon, authenticated, service_role;
revoke all on function public.omr_return_feedback_v2(text,text,bigint,text) from public, anon, authenticated, service_role;
revoke all on function public.omr_save_feedback_v1(text,jsonb) from public, anon, authenticated, service_role;
revoke all on function public.omr_return_feedback_v1(text,text,timestamptz) from public, anon, authenticated, service_role;
revoke all on function public.omr_assign_students_v1(text,text,text,text,text[],text,bigint,text) from public, anon, authenticated, service_role;
revoke all on function public.omr_clear_student_assignment_v1(text,text,text,text,bigint,text,text[],text) from public, anon, authenticated, service_role;
revoke all on function public.omr_open_attempt_session_v1(text,text,text,text,text,text,text,text,text,text,text,integer[],integer[],timestamp with time zone,jsonb,integer,timestamp with time zone,text,text,integer) from public, anon, authenticated, service_role;
revoke all on function public.omr_reserve_plan_usage(text,text,date,text,integer,integer,integer) from public, anon, authenticated, service_role;
revoke all on function public.omr_release_plan_usage(text,text,date,text) from public, anon, authenticated, service_role;
revoke all on function public.omr_release_plan_usage_v10_snapshot(text,text,date,text) from public, anon, authenticated, service_role;
revoke all on function public.omr_sync_student_plan_usage(text,text[],integer,integer) from public, anon, authenticated, service_role;
revoke all on function public.omr_save_roster_v3(text,text,bigint,text,text,jsonb,jsonb,jsonb,jsonb,bigint) from public, anon, authenticated;
grant execute on function public.omr_save_roster_v3(text,text,bigint,text,text,jsonb,jsonb,jsonb,jsonb,bigint) to service_role;
revoke all on function public.omr_save_exam_v3(text,text,bigint,text,jsonb,jsonb,jsonb,bigint,text) from public, anon, authenticated;
grant execute on function public.omr_save_exam_v3(text,text,bigint,text,jsonb,jsonb,jsonb,bigint,text) to service_role;
revoke all on function public.omr_save_feedback_v4(text,text,bigint,text,text,jsonb,bigint,text) from public, anon, authenticated;
grant execute on function public.omr_save_feedback_v4(text,text,bigint,text,text,jsonb,bigint,text) to service_role;
revoke all on function public.omr_return_feedback_v4(text,text,bigint,text,text,text,bigint,text) from public, anon, authenticated;
grant execute on function public.omr_return_feedback_v4(text,text,bigint,text,text,text,bigint,text) to service_role;
revoke all on function public.omr_assign_students_v2(text,text,bigint,text,text,text,text,text[],text,bigint,text) from public, anon, authenticated;
grant execute on function public.omr_assign_students_v2(text,text,bigint,text,text,text,text,text[],text,bigint,text) to service_role;
revoke all on function public.omr_clear_student_assignment_v2(text,text,bigint,text,text,text,text,bigint,text,text[],text) from public, anon, authenticated;
grant execute on function public.omr_clear_student_assignment_v2(text,text,bigint,text,text,text,text,bigint,text,text[],text) to service_role;
revoke all on function public.omr_open_attempt_session_v2(text,text,text,text,text,text,text,text,text,text,text,integer[],integer[],timestamp with time zone,jsonb,integer,timestamp with time zone,text,text,integer) from public, anon, authenticated, service_role;
revoke all on function public.omr_open_attempt_session_v3(text,text,text,text,bigint,text,text,text,text,text,text,text,integer[],integer[],timestamp with time zone,jsonb,integer,timestamp with time zone,text,text,integer) from public, anon, authenticated;
grant execute on function public.omr_open_attempt_session_v3(text,text,text,text,bigint,text,text,text,text,text,text,text,integer[],integer[],timestamp with time zone,jsonb,integer,timestamp with time zone,text,text,integer) to service_role;
revoke all on function public.omr_prepare_teacher_asset_upload_v2(text,text,bigint,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.omr_prepare_teacher_asset_upload_v2(text,text,bigint,text,text,jsonb) to service_role;
revoke all on function public.omr_authorize_teacher_asset_finalize_v2(text,text,bigint,text,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.omr_authorize_teacher_asset_finalize_v2(text,text,bigint,text,text,text,jsonb) to service_role;
revoke all on function public.omr_finalize_teacher_asset_upload_v2(text,text,bigint,text,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.omr_finalize_teacher_asset_upload_v2(text,text,bigint,text,text,text,jsonb) to service_role;
revoke all on function public.omr_prepare_attempt_handwriting_asset_v2(text,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.omr_prepare_attempt_handwriting_asset_v2(text,text,text,jsonb) to service_role;
revoke all on function public.omr_attach_attempt_handwriting_v2(text,text,text,text,text) from public, anon, authenticated;
grant execute on function public.omr_attach_attempt_handwriting_v2(text,text,text,text,text) to service_role;
revoke all on function public.omr_claim_remote_asset_cleanup_v1(text,integer,integer) from public, anon, authenticated;
grant execute on function public.omr_claim_remote_asset_cleanup_v1(text,integer,integer) to service_role;
revoke all on function public.omr_reserve_plan_usage_v2(text,text,bigint,text,text,text,text) from public, anon, authenticated;
grant execute on function public.omr_reserve_plan_usage_v2(text,text,bigint,text,text,text,text) to service_role;
revoke all on function public.omr_release_plan_usage_v2(text,text,bigint,text,text,text,text) from public, anon, authenticated;
grant execute on function public.omr_release_plan_usage_v2(text,text,bigint,text,text,text,text) to service_role;
revoke all on function public.omr_sync_student_plan_usage_v2(text,text,bigint,text,text) from public, anon, authenticated;
grant execute on function public.omr_sync_student_plan_usage_v2(text,text,bigint,text,text) to service_role;

-- Assignment-generation vNext remains server-only across boundary rollback.
revoke all on function public.omr_list_student_assignments_v2(text,text,text,text,text) from public, anon, authenticated;
revoke all on function public.omr_resolve_student_assignment_v2(text,text,text,text,text,text,bigint,text) from public, anon, authenticated;
revoke all on function public.omr_open_attempt_session_v3(text,text,text,text,bigint,text,text,text,text,text,text,text,integer[],integer[],timestamptz,jsonb,integer,timestamptz,text,text,integer) from public, anon, authenticated;
revoke all on function public.omr_checkpoint_attempt_session_v2(text,text,text,text,text,bigint,bigint,bigint,text,jsonb,jsonb,jsonb,integer,boolean) from public, anon, authenticated;
revoke all on function public.omr_heartbeat_attempt_session_v2(text,text,text,text,text,bigint,bigint,text,integer) from public, anon, authenticated;
revoke all on function public.omr_takeover_attempt_session_v2(text,text,text,text,text,bigint,bigint,bigint,text,integer) from public, anon, authenticated;
revoke all on function public.omr_prepare_attempt_session_submit_v2(text,text,text,text,text,bigint,bigint,bigint,text) from public, anon, authenticated;
revoke all on function public.omr_commit_attempt_session_submit_v2(text,text,text,text,text,bigint,bigint,bigint,text,jsonb,jsonb) from public, anon, authenticated;
revoke all on function public.omr_list_active_attempt_sessions_v2(text,text,text,text,integer) from public, anon, authenticated;
revoke all on function public.omr_resolve_legacy_attempt_session_scope_v1(text,text,text) from public, anon, authenticated;
revoke all on function public.omr_prepare_teacher_force_finish_sessions_compact_v2(text,text[],text,text) from public, anon, authenticated;
revoke all on function public.omr_force_finish_attempt_sessions_compact_v2(text,text[],timestamptz,text,text,text,jsonb) from public, anon, authenticated;

commit;

-- ---------------------------------------------------------------------------
-- STAGE 3 — Alpha allow-all RLS policies and FORCE RLS flags.
--
-- DANGER: this is the "anyone with the publishable key can read and write every
-- row" state. Do not run it on a database holding real student data.
-- Requires omr.rollback_confirm.
-- ---------------------------------------------------------------------------

begin;

do $$
begin
    if current_user is distinct from 'postgres' then
        raise exception using
            errcode = '42501',
            message = 'rollback must run as migration owner postgres';
    end if;
    if current_setting('omr.rollback_confirm', true) is distinct from 'restore-browser-access' then
        raise exception using
            errcode = '42501',
            message = 'stage 3 restores allow-all RLS policies; '
                   || 'run: set omr.rollback_confirm = ''restore-browser-access'';';
    end if;
end
$$;

-- FORCE RLS goes back off everywhere schema.sql did not set it. Only the two
-- credential/invite registries are FORCE in the alpha baseline; the boundary
-- forced all 27, so unforce the other 25. RLS itself stays ENABLED — that is
-- true in the alpha schema too.
alter table if exists public.omr_organizations no force row level security;
alter table if exists public.omr_plan_usage no force row level security;
alter table if exists public.omr_plan_usage_reservations no force row level security;
alter table if exists public.omr_user_profiles no force row level security;
alter table if exists public.omr_organization_members no force row level security;
alter table if exists public.omr_teacher_profiles no force row level security;
alter table if exists public.omr_student_profiles no force row level security;
alter table if exists public.omr_classes no force row level security;
alter table if exists public.omr_class_teachers no force row level security;
alter table if exists public.omr_class_students no force row level security;
alter table if exists public.omr_materials no force row level security;
alter table if exists public.omr_exams no force row level security;
alter table if exists public.omr_exam_questions no force row level security;
alter table if exists public.omr_exam_materials no force row level security;
alter table if exists public.omr_assignments no force row level security;
alter table if exists public.omr_assignment_targets no force row level security;
alter table if exists public.omr_attempts no force row level security;
alter table if exists public.omr_question_results no force row level security;
alter table if exists public.omr_assignment_submissions no force row level security;
alter table if exists public.omr_attempt_feedback no force row level security;
-- This paid mutation boundary is permanent across compatibility rollback.
alter table if exists public.omr_kakao_candidate_reviews force row level security;
alter table if exists public.omr_kakao_dispatch_logs force row level security;
alter table if exists public.omr_kakao_reminder_legacy_quarantine force row level security;
alter table if exists public.omr_comments no force row level security;
alter table if exists public.omr_audit_logs no force row level security;
alter table if exists public.omr_remote_assets no force row level security;
-- The service-only upload intent and cleanup outbox remain FORCE RLS because
-- schema.sql already forces them in the pre-boundary baseline.

-- omr_student_start_credentials, omr_student_credential_epochs, and omr_roster_invites keep FORCE RLS.
-- sets it, so leaving it on is the correct alpha state, not an oversight.

-- The 25 alpha allow-all policies, verbatim from schema.sql. A contract test
-- asserts this list matches the set production-server-boundary.sql drops, so the
-- two files cannot drift apart.
drop policy if exists "OMR organizations are publicly writable" on public.omr_organizations;
create policy "OMR organizations are publicly writable" on public.omr_organizations for all using (true) with check (true);
drop policy if exists "OMR user profiles are publicly writable" on public.omr_user_profiles;
create policy "OMR user profiles are publicly writable" on public.omr_user_profiles for all using (true) with check (true);
drop policy if exists "OMR organization members are publicly writable" on public.omr_organization_members;
create policy "OMR organization members are publicly writable" on public.omr_organization_members for all using (true) with check (true);
drop policy if exists "OMR teacher profiles are publicly writable" on public.omr_teacher_profiles;
create policy "OMR teacher profiles are publicly writable" on public.omr_teacher_profiles for all using (true) with check (true);
drop policy if exists "OMR student profiles are publicly writable" on public.omr_student_profiles;
create policy "OMR student profiles are publicly writable" on public.omr_student_profiles for all using (true) with check (true);
drop policy if exists "OMR classes are publicly writable" on public.omr_classes;
create policy "OMR classes are publicly writable" on public.omr_classes for all using (true) with check (true);
drop policy if exists "OMR class teachers are publicly writable" on public.omr_class_teachers;
create policy "OMR class teachers are publicly writable" on public.omr_class_teachers for all using (true) with check (true);
drop policy if exists "OMR class students are publicly writable" on public.omr_class_students;
create policy "OMR class students are publicly writable" on public.omr_class_students for all using (true) with check (true);
drop policy if exists "OMR materials are publicly writable" on public.omr_materials;
create policy "OMR materials are publicly writable" on public.omr_materials for all using (true) with check (true);
drop policy if exists "OMR exams are publicly readable" on public.omr_exams;
create policy "OMR exams are publicly readable" on public.omr_exams for select using (true);
drop policy if exists "OMR exams are publicly writable" on public.omr_exams;
create policy "OMR exams are publicly writable" on public.omr_exams for all using (true) with check (true);
drop policy if exists "OMR exam questions are publicly writable" on public.omr_exam_questions;
create policy "OMR exam questions are publicly writable" on public.omr_exam_questions for all using (true) with check (true);
drop policy if exists "OMR exam materials are publicly writable" on public.omr_exam_materials;
create policy "OMR exam materials are publicly writable" on public.omr_exam_materials for all using (true) with check (true);
drop policy if exists "OMR assignments are publicly writable" on public.omr_assignments;
create policy "OMR assignments are publicly writable" on public.omr_assignments for all using (true) with check (true);
drop policy if exists "OMR assignment targets are publicly writable" on public.omr_assignment_targets;
create policy "OMR assignment targets are publicly writable" on public.omr_assignment_targets for all using (true) with check (true);
drop policy if exists "OMR attempts are publicly readable" on public.omr_attempts;
create policy "OMR attempts are publicly readable" on public.omr_attempts for select using (true);
drop policy if exists "OMR attempts are publicly writable" on public.omr_attempts;
create policy "OMR attempts are publicly writable" on public.omr_attempts for all using (true) with check (true);
drop policy if exists "OMR question results are publicly readable" on public.omr_question_results;
create policy "OMR question results are publicly readable" on public.omr_question_results for select using (true);
drop policy if exists "OMR question results are publicly writable" on public.omr_question_results;
create policy "OMR question results are publicly writable" on public.omr_question_results for all using (true) with check (true);
drop policy if exists "OMR assignment submissions are publicly writable" on public.omr_assignment_submissions;
create policy "OMR assignment submissions are publicly writable" on public.omr_assignment_submissions for all using (true) with check (true);
drop policy if exists "OMR attempt feedback is publicly writable" on public.omr_attempt_feedback;
create policy "OMR attempt feedback is publicly writable" on public.omr_attempt_feedback for all using (true) with check (true);
drop policy if exists "OMR Kakao candidate reviews are publicly writable" on public.omr_kakao_candidate_reviews;
drop policy if exists "OMR Kakao dispatch logs are publicly writable" on public.omr_kakao_dispatch_logs;
drop policy if exists "OMR comments are publicly writable" on public.omr_comments;
create policy "OMR comments are publicly writable" on public.omr_comments for all using (true) with check (true);
drop policy if exists "OMR audit logs are publicly writable" on public.omr_audit_logs;
create policy "OMR audit logs are publicly writable" on public.omr_audit_logs for all using (true) with check (true);

drop policy if exists "prod kakao reviews write by staff" on public.omr_kakao_candidate_reviews;
drop policy if exists "prod kakao logs write by staff" on public.omr_kakao_dispatch_logs;
revoke all on table public.omr_kakao_candidate_reviews
    from public, anon, authenticated, service_role;
revoke all on table public.omr_kakao_dispatch_logs
    from public, anon, authenticated, service_role;
revoke all on table public.omr_kakao_reminder_legacy_quarantine
    from public, anon, authenticated, service_role;
grant select on table public.omr_kakao_candidate_reviews to service_role;
grant select on table public.omr_kakao_dispatch_logs to service_role;
grant select on table public.omr_kakao_reminder_legacy_quarantine to service_role;
do $kakao_rpc_overload_acl$
declare
    routine record;
begin
    for routine in
        select proc.proname, proc.prokind,
               pg_catalog.pg_get_function_identity_arguments(proc.oid) as identity_arguments
          from pg_catalog.pg_proc proc
          join pg_catalog.pg_namespace namespace on namespace.oid = proc.pronamespace
         where namespace.nspname = 'public'
           and proc.proname in (
               'omr_save_kakao_candidate_review_v1',
               'omr_save_kakao_simulation_dispatch_v1',
               'omr_kakao_reminder_legacy_inventory_v1',
               'omr_quarantine_kakao_reminder_legacy_v1',
               'omr_kakao_reminder_entitlement_ready_v1'
           )
    loop
        execute pg_catalog.format(
            'revoke all on %s public.%I(%s) from public, anon, authenticated, service_role',
            case when routine.prokind = 'p' then 'procedure' else 'function' end,
            routine.proname,
            routine.identity_arguments
        );
    end loop;
end
$kakao_rpc_overload_acl$;
revoke all on function public.omr_save_kakao_candidate_review_v1(text,text,bigint,text,text,jsonb)
    from public, anon, authenticated, service_role;
grant execute on function public.omr_save_kakao_candidate_review_v1(text,text,bigint,text,text,jsonb)
    to service_role;
revoke all on function public.omr_save_kakao_simulation_dispatch_v1(text,text,bigint,text,text,jsonb)
    from public, anon, authenticated, service_role;
grant execute on function public.omr_save_kakao_simulation_dispatch_v1(text,text,bigint,text,text,jsonb)
    to service_role;
grant execute on function public.omr_kakao_reminder_legacy_inventory_v1()
    to service_role;
grant execute on function public.omr_kakao_reminder_entitlement_ready_v1()
    to service_role;

-- Durable student sessions did not exist in the alpha browser-access baseline.
-- Keep their table and every RPC overload service-only even after the rollback's
-- intentionally broad grants above.
alter table if exists public.omr_attempt_sessions enable row level security;
alter table if exists public.omr_attempt_sessions force row level security;
revoke all on table public.omr_attempt_sessions from public, anon, authenticated;
alter table if exists public.omr_rate_limit_buckets enable row level security;
alter table if exists public.omr_rate_limit_buckets force row level security;
revoke all on table public.omr_rate_limit_buckets from public, anon, authenticated, service_role;
alter table if exists public.omr_exam_mutations enable row level security;
alter table if exists public.omr_exam_mutations force row level security;
revoke all on table public.omr_exam_mutations from public, anon, authenticated, service_role;
alter table if exists public.omr_feedback_mutations enable row level security;
alter table if exists public.omr_feedback_mutations force row level security;
revoke all on table public.omr_feedback_mutations from public, anon, authenticated, service_role;
alter table if exists public.omr_exam_entry_invites enable row level security;
alter table if exists public.omr_exam_entry_invites force row level security;
revoke all on table public.omr_exam_entry_invites from public, anon, authenticated, service_role;
alter table if exists public.omr_initial_ops_metrics enable row level security;
alter table if exists public.omr_initial_ops_metrics force row level security;
revoke all on table public.omr_initial_ops_metrics from public, anon, authenticated, service_role;
alter table if exists public.omr_teacher_accounts enable row level security;
alter table if exists public.omr_teacher_accounts force row level security;
revoke all on table public.omr_teacher_accounts from public, anon, authenticated, service_role;
alter table if exists public.omr_teacher_account_tokens enable row level security;
alter table if exists public.omr_teacher_account_tokens force row level security;
revoke all on table public.omr_teacher_account_tokens from public, anon, authenticated, service_role;
alter table if exists public.omr_teacher_notification_states enable row level security;
alter table if exists public.omr_teacher_notification_states force row level security;
revoke all on table public.omr_teacher_notification_states from public, anon, authenticated, service_role;
alter table if exists public.omr_operational_job_status enable row level security;
alter table if exists public.omr_operational_job_status force row level security;
revoke all on table public.omr_operational_job_status from public, anon, authenticated, service_role;
do $$
declare
    guarded_function text;
begin
    foreach guarded_function in array array[
        'omr_open_attempt_session_v1',
        'omr_checkpoint_attempt_session_v1',
        'omr_heartbeat_attempt_session_v1',
        'omr_takeover_attempt_session_v1',
        'omr_prepare_attempt_session_submit_v1',
        'omr_commit_attempt_session_submit_v1',
        'omr_delete_exam_v1',
        'omr_prepare_attempt_handwriting_asset_v1',
        'omr_discard_attempt_handwriting_asset_v1',
        'omr_gc_attempt_sessions_v1',
        'omr_requeue_dead_remote_asset_cleanup_v1',
        'omr_prepare_teacher_force_finish_sessions_compact_v1',
        'omr_force_finish_attempt_sessions_compact_v1',
        'omr_validate_teacher_session_v1',
        'omr_load_teacher_notification_state_v1',
        'omr_mutate_teacher_notification_state_v1',
        'omr_begin_operational_job_run_v1',
        'omr_complete_operational_job_run_v1',
        'omr_read_operational_job_status_v1',
        'omr_get_exam_entry_invite_metadata_v1',
        'omr_revoke_exam_entry_invite_v1',
        'omr_assign_students_v1',
        'omr_clear_student_assignment_v1',
        'omr_load_teacher_student_assignment_v1',
        'omr_list_student_assignments_v1',
        'omr_resolve_student_assignment_v1',
        'omr_teacher_attempt_aggregate_v1',
        'omr_teacher_attempt_export_v1',
        'omr_teacher_attempt_export_page_v1'
    ] loop
        execute (
            select coalesce(string_agg(
                format(
                    'revoke all on function public.%I(%s) from public, anon, authenticated; grant execute on function public.%I(%s) to service_role;',
                    proc.proname,
                    pg_get_function_identity_arguments(proc.oid),
                    proc.proname,
                    pg_get_function_identity_arguments(proc.oid)
                ),
                ' '
            ), 'select 1;')
              from pg_proc proc
              join pg_namespace namespace on namespace.oid = proc.pronamespace
             where namespace.nspname = 'public'
               and proc.proname = guarded_function
        );
    end loop;
end
$$;

revoke all on function public.omr_assert_targeted_assignment_scope_v1(text,text,text,text,text,text,integer[])
    from public, anon, authenticated, service_role;
revoke all on function public.omr_validate_targeted_attempt_session_v1()
    from public, anon, authenticated, service_role;
revoke all on function public.omr_validate_targeted_attempt_v1()
    from public, anon, authenticated, service_role;
revoke all on function public.omr_guard_targeted_exam_access_v1()
    from public, anon, authenticated, service_role;

revoke execute on function public.omr_ack_remote_asset_cleanup_v1(text,text)
    from service_role;
revoke execute on function public.omr_fail_remote_asset_cleanup_v1(text,text,text)
    from service_role;
revoke execute on function public.omr_save_exam_v1(jsonb,jsonb,jsonb,text)
    from service_role;
revoke execute on function public.omr_save_feedback_v1(text,jsonb)
    from service_role;
revoke execute on function public.omr_return_feedback_v1(text,text,timestamptz)
    from service_role;
revoke all on function public.omr_save_feedback_v12_snapshot(text,jsonb)
    from public, anon, authenticated, service_role;
revoke all on function public.omr_return_feedback_v12_snapshot(text,text,timestamptz)
    from public, anon, authenticated, service_role;
grant execute on function public.omr_authorize_remote_asset_cleanup_delete_v1(text,text,integer)
    to service_role;
grant execute on function public.omr_ack_remote_asset_cleanup_v1(text,text,integer)
    to service_role;
grant execute on function public.omr_fail_remote_asset_cleanup_v1(text,text,integer,text)
    to service_role;
grant execute on function public.omr_consume_rate_limit_v1(text,text,integer,integer,integer)
    to service_role;
grant execute on function public.omr_save_exam_v2(jsonb,jsonb,jsonb,text,bigint,text)
    to service_role;
grant execute on function public.omr_bootstrap_workspace_organization_v1(text,text,jsonb,timestamptz)
    to service_role;
grant execute on function public.omr_save_feedback_v2(text,jsonb,bigint,text)
    to service_role;
grant execute on function public.omr_return_feedback_v2(text,text,bigint,text)
    to service_role;
grant execute on function public.omr_save_feedback_v3(text,jsonb,bigint,text)
    to service_role;
grant execute on function public.omr_return_feedback_v3(text,text,bigint,text)
    to service_role;
grant execute on function public.omr_gc_attempt_sessions_v1(integer,integer)
    to service_role;
grant execute on function public.omr_requeue_dead_remote_asset_cleanup_v1(text,text,integer,text,text)
    to service_role;

-- Final Stage 3 Phase C ACL fence. Rollback may restore the historical browser
-- policies, but it must never restore direct service-role paid-mutation,
-- private-worker, quota-ledger, or Storage-metadata bypasses.
alter table if exists public.omr_student_credential_epochs enable row level security;
alter table if exists public.omr_student_credential_epochs force row level security;
revoke all on table public.omr_student_credential_epochs from public, anon, authenticated, service_role;
alter table if exists public.omr_student_credential_batch_receipts enable row level security;
alter table if exists public.omr_student_credential_batch_receipts force row level security;
revoke all on table public.omr_student_credential_batch_receipts from public, anon, authenticated, service_role;
revoke all on table public.omr_student_start_credentials from service_role;
grant select on table public.omr_student_start_credentials to service_role;
revoke all on function public.omr_guard_student_credential_mutation_v1() from public, anon, authenticated, service_role;
revoke all on function public.omr_guard_student_profile_generation_v1() from public, anon, authenticated, service_role;
revoke all on function public.omr_guard_student_credential_mutation_v8_snapshot() from public, anon, authenticated, service_role;
revoke all on function public.omr_revoke_student_session_on_status_v2() from public, anon, authenticated, service_role;
revoke all on function public.omr_revoke_student_session_on_delete_v2() from public, anon, authenticated, service_role;
revoke all on function public.omr_revoke_withdrawn_student_credential_v8_snapshot() from public, anon, authenticated, service_role;
revoke all on function public.omr_validate_student_session_v1(text,text,text,integer) from public, anon, authenticated;
grant execute on function public.omr_validate_student_session_v1(text,text,text,integer) to service_role;
revoke all on function public.omr_rotate_student_start_credential_v1(text,text,bigint,text,text,text,text) from public, anon, authenticated, service_role;
revoke all on function public.omr_issue_student_start_code_batch_v1(text,text,bigint,text,text,jsonb,text) from public, anon, authenticated;
grant execute on function public.omr_issue_student_start_code_batch_v1(text,text,bigint,text,text,jsonb,text) to service_role;
revoke all on table public.omr_remote_assets from service_role;
revoke all on table public.omr_remote_asset_upload_intents from service_role;
revoke all on table public.omr_remote_asset_cleanup_queue from service_role;
revoke all on table public.omr_plan_usage from service_role;
revoke all on table public.omr_plan_usage_reservations from service_role;
grant select on table public.omr_remote_assets to service_role;
grant select on table public.omr_remote_asset_upload_intents to service_role;
grant select on table public.omr_remote_asset_cleanup_queue to service_role;
grant select on table public.omr_plan_usage to service_role;
grant select on table public.omr_plan_usage_reservations to service_role;
revoke all on sequence public.omr_remote_asset_cleanup_queue_id_seq from service_role;

revoke all on function public.omr_lock_provisioned_teacher_identity_v1(text,bigint,text) from public, anon, authenticated, service_role;
revoke all on function public.omr_authorize_effective_teacher_plan_v1(text,text) from public, anon, authenticated, service_role;
revoke all on function public.omr_read_effective_organization_plan_v1(text) from public, anon, authenticated, service_role;
revoke all on function public.omr_set_effective_plan_transaction_proof_v1(text,jsonb) from public, anon, authenticated, service_role;
revoke all on function public.omr_prove_effective_organization_plan_v1(text) from public, anon, authenticated, service_role;
revoke all on function public.omr_assert_effective_plan_transaction_proof_v1(text,boolean) from public, anon, authenticated, service_role;
revoke all on function public.omr_lock_legacy_teacher_identity_v1(text,bigint,text,text) from public, anon, authenticated, service_role;
revoke all on function public.omr_read_legacy_teacher_plan_v1(text,text,text) from public, anon, authenticated, service_role;
revoke all on function public.omr_lock_teacher_mutation_identity_v1(text,text,bigint,text,text) from public, anon, authenticated, service_role;
revoke all on function public.omr_read_teacher_mutation_plan_v1(text,text,text,text) from public, anon, authenticated, service_role;
revoke all on function public.omr_save_exam_effective_worker_v3(text,text,text,text,jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
revoke all on function public.omr_save_feedback_effective_worker_v4(text,jsonb,bigint,text) from public, anon, authenticated, service_role;
revoke all on function public.omr_claim_remote_asset_cleanup_v8_snapshot(text,integer,integer) from public, anon, authenticated, service_role;
revoke all on function public.omr_initial_ops_fixture_v26_snapshot(text,text,text,text,text) from public, anon, authenticated, service_role;
revoke all on function public.omr_initial_ops_database_snapshot_v26_snapshot(text,text,text,text,text) from public, anon, authenticated, service_role;
revoke all on function public.omr_assert_targeted_assignment_scope_v1(text,text,text,text,text,text,integer[]) from public, anon, authenticated, service_role;
revoke all on function public.omr_validate_targeted_attempt_session_v1() from public, anon, authenticated, service_role;
revoke all on function public.omr_validate_targeted_attempt_v1() from public, anon, authenticated, service_role;
revoke all on function public.omr_guard_targeted_exam_access_v1() from public, anon, authenticated, service_role;

revoke all on function public.omr_save_roster_v2(text,jsonb,jsonb,jsonb,jsonb,bigint) from public, anon, authenticated, service_role;
revoke all on function public.omr_save_roster_v1(text,jsonb,jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
revoke all on function public.omr_save_roster_plan_unlocked_v1(text,jsonb,jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
revoke all on function public.omr_save_roster_unlocked_v1(text,jsonb,jsonb,jsonb,jsonb) from public, anon, authenticated, service_role;
revoke all on function public.omr_save_exam_v2(jsonb,jsonb,jsonb,text,bigint,text) from public, anon, authenticated, service_role;
revoke all on function public.omr_save_exam_v1(jsonb,jsonb,jsonb,text) from public, anon, authenticated, service_role;
revoke all on function public.omr_save_exam_v10_snapshot(jsonb,jsonb,jsonb,text) from public, anon, authenticated, service_role;
revoke all on function public.omr_save_exam_v6_snapshot(jsonb,jsonb,jsonb,text) from public, anon, authenticated, service_role;
revoke all on function public.omr_save_exam_plan_unlocked_v1(jsonb,jsonb) from public, anon, authenticated, service_role;
revoke all on function public.omr_prepare_teacher_asset_upload_v1(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.omr_prepare_teacher_asset_upload_v6_snapshot(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.omr_authorize_teacher_asset_finalize_v1(text,text,text,jsonb) from public, anon, authenticated, service_role;
revoke all on function public.omr_finalize_teacher_asset_upload_v1(text,text,text,jsonb) from public, anon, authenticated, service_role;
revoke all on function public.omr_prepare_attempt_handwriting_asset_v1(text,jsonb) from public, anon, authenticated, service_role;
revoke all on function public.omr_attach_attempt_handwriting_v1(text,text,jsonb) from public, anon, authenticated, service_role;
revoke all on function public.omr_save_remote_asset_metadata_v1(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.omr_save_feedback_v3(text,jsonb,bigint,text) from public, anon, authenticated, service_role;
revoke all on function public.omr_return_feedback_v3(text,text,bigint,text) from public, anon, authenticated, service_role;
revoke all on function public.omr_save_feedback_v2(text,jsonb,bigint,text) from public, anon, authenticated, service_role;
revoke all on function public.omr_return_feedback_v2(text,text,bigint,text) from public, anon, authenticated, service_role;
revoke all on function public.omr_assign_students_v1(text,text,text,text,text[],text,bigint,text) from public, anon, authenticated, service_role;
revoke all on function public.omr_clear_student_assignment_v1(text,text,text,text,bigint,text,text[],text) from public, anon, authenticated, service_role;
revoke all on function public.omr_open_attempt_session_v1(text,text,text,text,text,text,text,text,text,text,text,integer[],integer[],timestamp with time zone,jsonb,integer,timestamp with time zone,text,text,integer) from public, anon, authenticated, service_role;
revoke all on function public.omr_reserve_plan_usage(text,text,date,text,integer,integer,integer) from public, anon, authenticated, service_role;
revoke all on function public.omr_release_plan_usage(text,text,date,text) from public, anon, authenticated, service_role;
revoke all on function public.omr_release_plan_usage_v10_snapshot(text,text,date,text) from public, anon, authenticated, service_role;
revoke all on function public.omr_sync_student_plan_usage(text,text[],integer,integer) from public, anon, authenticated, service_role;

revoke all on function public.omr_save_roster_v3(text,text,bigint,text,text,jsonb,jsonb,jsonb,jsonb,bigint) from public, anon, authenticated;
grant execute on function public.omr_save_roster_v3(text,text,bigint,text,text,jsonb,jsonb,jsonb,jsonb,bigint) to service_role;
revoke all on function public.omr_save_exam_v3(text,text,bigint,text,jsonb,jsonb,jsonb,bigint,text) from public, anon, authenticated;
grant execute on function public.omr_save_exam_v3(text,text,bigint,text,jsonb,jsonb,jsonb,bigint,text) to service_role;
revoke all on function public.omr_save_feedback_v4(text,text,bigint,text,text,jsonb,bigint,text) from public, anon, authenticated;
grant execute on function public.omr_save_feedback_v4(text,text,bigint,text,text,jsonb,bigint,text) to service_role;
revoke all on function public.omr_return_feedback_v4(text,text,bigint,text,text,text,bigint,text) from public, anon, authenticated;
grant execute on function public.omr_return_feedback_v4(text,text,bigint,text,text,text,bigint,text) to service_role;
revoke all on function public.omr_assign_students_v2(text,text,bigint,text,text,text,text,text[],text,bigint,text) from public, anon, authenticated;
grant execute on function public.omr_assign_students_v2(text,text,bigint,text,text,text,text,text[],text,bigint,text) to service_role;
revoke all on function public.omr_clear_student_assignment_v2(text,text,bigint,text,text,text,text,bigint,text,text[],text) from public, anon, authenticated;
grant execute on function public.omr_clear_student_assignment_v2(text,text,bigint,text,text,text,text,bigint,text,text[],text) to service_role;
revoke all on function public.omr_open_attempt_session_v2(text,text,text,text,text,text,text,text,text,text,text,integer[],integer[],timestamp with time zone,jsonb,integer,timestamp with time zone,text,text,integer) from public, anon, authenticated, service_role;
revoke all on function public.omr_open_attempt_session_v3(text,text,text,text,bigint,text,text,text,text,text,text,text,integer[],integer[],timestamp with time zone,jsonb,integer,timestamp with time zone,text,text,integer) from public, anon, authenticated;
grant execute on function public.omr_open_attempt_session_v3(text,text,text,text,bigint,text,text,text,text,text,text,text,integer[],integer[],timestamp with time zone,jsonb,integer,timestamp with time zone,text,text,integer) to service_role;

-- The full browser-access rollback intentionally grants every public function
-- before rebuilding the guarded server boundary. Keep the canonical digest
-- primitives and trigger workers private; only the exact server verifier and
-- readiness probe remain executable by service_role.
revoke all on function public.omr_assert_canonical_question_result_json_v1(jsonb,integer) from public,anon,authenticated,service_role;
revoke all on function public.omr_canonical_json_text_v1(jsonb) from public,anon,authenticated,service_role;
revoke all on function public.omr_compute_canonical_question_result_evidence_v1(jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.omr_compute_canonical_question_result_evidence_v1(jsonb,jsonb) to service_role;
revoke all on function public.omr_bind_attempt_evidence_generation_v1() from public,anon,authenticated,service_role;
revoke all on function public.omr_guard_canonical_question_result_evidence_v1() from public,anon,authenticated,service_role;
revoke all on function public.omr_question_result_assignment_generation_guard_v2() from public,anon,authenticated,service_role;
revoke all on function public.omr_canonical_attempt_child_evidence_matches_v1(text) from public,anon,authenticated,service_role;
revoke all on function public.omr_assert_canonical_attempt_child_evidence_v1(text) from public,anon,authenticated,service_role;
revoke all on function public.omr_mark_canonical_attempt_evidence_dirty_v1() from public,anon,authenticated,service_role;
revoke all on function public.omr_finalize_canonical_attempt_evidence_dirty_v1() from public,anon,authenticated,service_role;
revoke all on function public.omr_guard_completed_question_result_grading_immutability_v1() from public,anon,authenticated,service_role;
revoke all on function public.omr_canonical_question_result_evidence_ready_v1() from public,anon,authenticated;
grant execute on function public.omr_canonical_question_result_evidence_ready_v1() to service_role;
revoke all on function public.omr_prepare_teacher_asset_upload_v2(text,text,bigint,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.omr_prepare_teacher_asset_upload_v2(text,text,bigint,text,text,jsonb) to service_role;
revoke all on function public.omr_authorize_teacher_asset_finalize_v2(text,text,bigint,text,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.omr_authorize_teacher_asset_finalize_v2(text,text,bigint,text,text,text,jsonb) to service_role;
revoke all on function public.omr_finalize_teacher_asset_upload_v2(text,text,bigint,text,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.omr_finalize_teacher_asset_upload_v2(text,text,bigint,text,text,text,jsonb) to service_role;
revoke all on function public.omr_prepare_attempt_handwriting_asset_v2(text,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.omr_prepare_attempt_handwriting_asset_v2(text,text,text,jsonb) to service_role;
revoke all on function public.omr_attach_attempt_handwriting_v2(text,text,text,text,text) from public, anon, authenticated;
grant execute on function public.omr_attach_attempt_handwriting_v2(text,text,text,text,text) to service_role;
revoke all on function public.omr_claim_remote_asset_cleanup_v1(text,integer,integer) from public, anon, authenticated;
grant execute on function public.omr_claim_remote_asset_cleanup_v1(text,integer,integer) to service_role;
revoke all on function public.omr_reserve_plan_usage_v2(text,text,bigint,text,text,text,text) from public, anon, authenticated;
grant execute on function public.omr_reserve_plan_usage_v2(text,text,bigint,text,text,text,text) to service_role;
revoke all on function public.omr_release_plan_usage_v2(text,text,bigint,text,text,text,text) from public, anon, authenticated;
grant execute on function public.omr_release_plan_usage_v2(text,text,bigint,text,text,text,text) to service_role;
revoke all on function public.omr_sync_student_plan_usage_v2(text,text,bigint,text,text) from public, anon, authenticated;
grant execute on function public.omr_sync_student_plan_usage_v2(text,text,bigint,text,text) to service_role;

commit;
