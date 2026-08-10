-- OMR Maker production server-only data boundary.
--
-- Apply only after every migration, including the organization-integrity
-- preflight. This profile is intentionally incompatible with browser-side
-- canonical CRUD: anon/authenticated receive no public app table, sequence, or
-- function privileges. Canonical access must use trusted server actions with
-- the service-role key.

begin;

-- Schema, migrations, this profile, and verification use one owner so default
-- ACLs cannot vary silently by deployment step.
do $$
begin
    if current_user is distinct from 'postgres' then
        raise exception using
            errcode = '42501',
            message = 'production boundary must run as migration owner postgres';
    end if;
    if (
        select count(*)
          from pg_roles
         where rolname in ('anon', 'authenticated', 'service_role')
    ) <> 3 then
        raise exception using
            errcode = '42704',
            message = 'production boundary requires anon, authenticated, and service_role roles';
    end if;
    if not exists (
        select 1 from pg_roles where rolname = 'supabase_storage_admin'
    ) or not pg_has_role(
        session_user,
        'supabase_storage_admin',
        'SET'
    ) then
        raise exception using
            errcode = '42501',
            message = 'postgres must be able to SET ROLE supabase_storage_admin';
    end if;
    if to_regclass('storage.objects') is null
        or to_regclass('storage.buckets') is null
    then
        raise exception using
            errcode = '42P01',
            message = 'production boundary requires hosted Storage relations';
    end if;
    if exists (
        select 1
          from pg_class relation
          join pg_namespace namespace on namespace.oid = relation.relnamespace
         where namespace.nspname = 'storage'
           and relation.relname in ('objects', 'buckets')
           and (
               relation.relowner <> 'supabase_storage_admin'::regrole
               or not relation.relrowsecurity
           )
    ) then
        raise exception using
            errcode = '42501',
            message = 'Storage relations must retain supabase_storage_admin ownership and RLS';
    end if;
end
$$;

-- Fail before changing privileges. The assertion is SECURITY DEFINER,
-- service-role-only, bounded, and reports no PII or raw row identifiers.
select public.omr_assert_production_boundary_preflight_v1();

-- Supabase requires every managed Storage entity to retain
-- supabase_storage_admin ownership. Enter that owner only for the supported RLS
-- policy phase, remove exact repository-owned policies, then restore postgres
-- before changing the public application boundary. Restrictive policies combine
-- with unrelated permissive policies and only subtract the OMR private bucket.
set local role supabase_storage_admin;

drop policy if exists "OMR private assets alpha access" on storage.objects;
drop policy if exists "OMR private assets server-only objects" on storage.objects;
create policy "OMR private assets server-only objects"
    on storage.objects
    as restrictive
    for all
    to anon, authenticated
    using (bucket_id <> 'omr-private-assets')
    with check (bucket_id <> 'omr-private-assets');

drop policy if exists "OMR private assets server-only buckets" on storage.buckets;
create policy "OMR private assets server-only buckets"
    on storage.buckets
    as restrictive
    for all
    to anon, authenticated
    using (id <> 'omr-private-assets')
    with check (id <> 'omr-private-assets');

reset role;

-- Close current objects and the schema itself to browser roles. PUBLIC must be
-- revoked as well because function EXECUTE is granted to PUBLIC by default.
revoke all on schema public from public, anon, authenticated;
revoke all on all tables in schema public from public, anon, authenticated;
revoke all on all sequences in schema public from public, anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;

-- Keep trusted server/service-role gateways operational, including trigger
-- helpers and future server RPCs created before this profile is applied.
grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant all on all functions in schema public to service_role;

-- Preserve the RPC-only and private-function boundaries installed by the
-- latest migrations. The blanket grants above intentionally make ordinary
-- canonical data available to the trusted server, but these private state
-- tables are reachable only through their audited SECURITY DEFINER gateways.
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
revoke all on sequence public.omr_operational_job_run_sequence from public, anon, authenticated, service_role;


-- Phase C keeps service_role on audited public RPCs only. Reassert this after
-- the blanket compatibility grant so direct DML/private-worker execution cannot
-- bypass the same-transaction identity and effective-plan fences.
revoke all on table public.omr_remote_assets from service_role;
revoke all on table public.omr_remote_asset_upload_intents from service_role;
revoke all on table public.omr_remote_asset_cleanup_queue from service_role;
revoke all on table public.omr_plan_usage from service_role;
revoke all on table public.omr_plan_usage_reservations from service_role;
revoke all on table public.omr_student_start_credentials from service_role;
grant select on table public.omr_remote_assets to service_role;
grant select on table public.omr_remote_asset_upload_intents to service_role;
grant select on table public.omr_remote_asset_cleanup_queue to service_role;
grant select on table public.omr_plan_usage to service_role;
grant select on table public.omr_plan_usage_reservations to service_role;
grant select on table public.omr_student_start_credentials to service_role;
revoke all on table public.omr_kakao_candidate_reviews from public, anon, authenticated, service_role;
revoke all on table public.omr_kakao_dispatch_logs from public, anon, authenticated, service_role;
revoke all on table public.omr_kakao_reminder_legacy_quarantine from public, anon, authenticated, service_role;
grant select on table public.omr_kakao_candidate_reviews to service_role;
grant select on table public.omr_kakao_dispatch_logs to service_role;
grant select on table public.omr_kakao_reminder_legacy_quarantine to service_role;
do $kakao_rpc_overload_acl$
declare
    routine record;
begin
    for routine in
        select proc.proname,
               proc.prokind,
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
grant execute on function public.omr_save_kakao_candidate_review_v1(text,text,bigint,text,text,jsonb) to service_role;
revoke all on function public.omr_save_kakao_simulation_dispatch_v1(text,text,bigint,text,text,jsonb)
    from public, anon, authenticated, service_role;
grant execute on function public.omr_save_kakao_simulation_dispatch_v1(text,text,bigint,text,text,jsonb) to service_role;
grant execute on function public.omr_kakao_reminder_legacy_inventory_v1() to service_role;
grant execute on function public.omr_kakao_reminder_entitlement_ready_v1() to service_role;
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


-- Cleanup completion is fenced by the claim attempt (lease epoch). Keep the
-- compatibility stubs in the catalog for upgrade diagnostics, but do not let
-- an old worker call them. Likewise, an old application must not reach the
-- blind exam-save upgrade stub or any private implementation snapshot.
revoke execute on function public.omr_ack_remote_asset_cleanup_v1(text,text) from service_role;
revoke execute on function public.omr_fail_remote_asset_cleanup_v1(text,text,text) from service_role;
revoke execute on function public.omr_save_exam_v1(jsonb,jsonb,jsonb,text) from service_role;
revoke execute on function public.omr_save_feedback_v1(text,jsonb) from service_role;
revoke execute on function public.omr_return_feedback_v1(text,text,timestamptz) from service_role;
revoke execute on function public.omr_save_roster_v1(text,jsonb,jsonb,jsonb,jsonb) from service_role;
revoke execute on function public.omr_initial_ops_operation_v1(text,text,text,text,text,text,jsonb) from service_role;
revoke execute on function public.omr_initial_ops_reserve_upload_v1(text,text,text,text,text,text,bigint) from service_role;
revoke all on function public.omr_save_exam_plan_unlocked_v1(jsonb,jsonb)
    from public, anon, authenticated, service_role;
revoke all on function public.omr_save_roster_plan_unlocked_v1(text,jsonb,jsonb,jsonb,jsonb)
    from public, anon, authenticated, service_role;
revoke all on function public.omr_save_roster_unlocked_v1(text,jsonb,jsonb,jsonb,jsonb)
    from public, anon, authenticated, service_role;
revoke all on function public.omr_enqueue_remote_asset_cleanup_v1(text,text,text,text,text,text,text,text)
    from public, anon, authenticated, service_role;
revoke all on function public.omr_enqueue_exam_asset_cleanup_v1(text,text,text[],text)
    from public, anon, authenticated, service_role;
revoke all on function public.omr_remote_assets_enqueue_cleanup_v1()
    from public, anon, authenticated, service_role;
revoke all on function public.omr_exams_enqueue_asset_cleanup_v1()
    from public, anon, authenticated, service_role;
revoke all on function public.omr_mark_exam_reservation_durable_v1()
    from public, anon, authenticated, service_role;
revoke all on function public.omr_teacher_force_finish_fingerprint_v1(bigint,jsonb,jsonb,integer[],jsonb)
    from public, anon, authenticated, service_role;
revoke all on function public.omr_advance_teacher_session_on_disable_v1()
    from public, anon, authenticated, service_role;
revoke all on function public.omr_prepare_teacher_asset_upload_v6_snapshot(jsonb)
    from public, anon, authenticated, service_role;
revoke all on function public.omr_save_exam_v6_snapshot(jsonb,jsonb,jsonb,text)
    from public, anon, authenticated, service_role;
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
grant execute on function public.omr_begin_operational_job_run_v1(text,text)
    to service_role;
grant execute on function public.omr_complete_operational_job_run_v1(text,bigint,text,text,text)
    to service_role;
grant execute on function public.omr_read_operational_job_status_v1(text)
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

-- Migration 011 may be absent on a partially upgraded deployment. Keep this
-- profile applicable so the readiness wrapper below can report false instead
-- of aborting before the probe is published.
do $$
begin
    if pg_catalog.to_regprocedure(
        'public.omr_teacher_notification_summary_v1(text)'
    ) is not null then
        revoke all on function public.omr_teacher_notification_summary_v1(text)
            from public, anon, authenticated;
        grant execute on function public.omr_teacher_notification_summary_v1(text)
            to service_role;
    end if;
end
$$;

-- Migration 030 owns per-user notification interaction state. Keep both RPCs
-- callable only by the server while allowing readiness to fail closed on a
-- partially upgraded database.
do $$
begin
    if pg_catalog.to_regprocedure(
        'public.omr_load_teacher_notification_state_v1(text,text,text[])'
    ) is not null then
        revoke all on function public.omr_load_teacher_notification_state_v1(text,text,text[])
            from public, anon, authenticated, service_role;
        grant execute on function public.omr_load_teacher_notification_state_v1(text,text,text[])
            to service_role;
    end if;
    if pg_catalog.to_regprocedure(
        'public.omr_mutate_teacher_notification_state_v1(text,text,text,text[])'
    ) is not null then
        revoke all on function public.omr_mutate_teacher_notification_state_v1(text,text,text,text[])
            from public, anon, authenticated, service_role;
        grant execute on function public.omr_mutate_teacher_notification_state_v1(text,text,text,text[])
            to service_role;
    end if;
end
$$;

-- Migrations 032/033 add individual-student distribution and exact reporting.
-- Keep only their public server gateways callable; trigger helpers remain
-- private even from service_role after the blanket function grant above.
do $$
declare
    gateway_signature text;
begin
    foreach gateway_signature in array array[
        'public.omr_assign_students_v1(text,text,text,text,text[],text,bigint,text)',
        'public.omr_clear_student_assignment_v1(text,text,text,text,bigint,text,text[],text)',
        'public.omr_load_teacher_student_assignment_v1(text,text,text,text)',
        'public.omr_list_student_assignments_v1(text,text,text,text,text)',
        'public.omr_resolve_student_assignment_v1(text,text,text,text,text,text,text)',
        'public.omr_teacher_attempt_aggregate_v1(text,text,timestamptz,timestamptz)',
        'public.omr_teacher_attempt_export_v1(text,text,integer)',
        'public.omr_teacher_attempt_export_page_v1(text,text,timestamptz,timestamptz,text,integer)'
    ] loop
        if pg_catalog.to_regprocedure(gateway_signature) is not null then
            execute pg_catalog.format(
                'revoke all on function %s from public, anon, authenticated, service_role; grant execute on function %s to service_role;',
                gateway_signature,
                gateway_signature
            );
        end if;
    end loop;

    foreach gateway_signature in array array[
        'public.omr_assert_targeted_assignment_scope_v1(text,text,text,text,text,text,integer[])',
        'public.omr_validate_targeted_attempt_session_v1()',
        'public.omr_validate_targeted_attempt_v1()',
        'public.omr_guard_targeted_exam_access_v1()'
    ] loop
        if pg_catalog.to_regprocedure(gateway_signature) is not null then
            execute pg_catalog.format(
                'revoke all on function %s from public, anon, authenticated, service_role;',
                gateway_signature
            );
        end if;
    end loop;
end
$$;

-- Keep future public-schema objects fail-closed when migrations run as the
-- profile owner. Reapplying this file is safe.
alter default privileges for role postgres
    revoke execute on functions from public;
alter default privileges for role postgres in schema public
    revoke all on tables from public, anon, authenticated;
alter default privileges for role postgres in schema public
    revoke all on sequences from public, anon, authenticated;
alter default privileges for role postgres in schema public
    revoke all on functions from anon, authenticated;
alter default privileges for role postgres in schema public
    grant all on tables to service_role;
alter default privileges for role postgres in schema public
    grant all on sequences to service_role;
alter default privileges for role postgres in schema public
    grant all on functions to service_role;

-- Alpha allow-all policies from schema.sql.
drop policy if exists "OMR organizations are publicly writable" on public.omr_organizations;
drop policy if exists "OMR user profiles are publicly writable" on public.omr_user_profiles;
drop policy if exists "OMR organization members are publicly writable" on public.omr_organization_members;
drop policy if exists "OMR teacher profiles are publicly writable" on public.omr_teacher_profiles;
drop policy if exists "OMR student profiles are publicly writable" on public.omr_student_profiles;
drop policy if exists "OMR classes are publicly writable" on public.omr_classes;
drop policy if exists "OMR class teachers are publicly writable" on public.omr_class_teachers;
drop policy if exists "OMR class students are publicly writable" on public.omr_class_students;
drop policy if exists "OMR materials are publicly writable" on public.omr_materials;
drop policy if exists "OMR exams are publicly readable" on public.omr_exams;
drop policy if exists "OMR exams are publicly writable" on public.omr_exams;
drop policy if exists "OMR exam questions are publicly writable" on public.omr_exam_questions;
drop policy if exists "OMR exam materials are publicly writable" on public.omr_exam_materials;
drop policy if exists "OMR assignments are publicly writable" on public.omr_assignments;
drop policy if exists "OMR assignment targets are publicly writable" on public.omr_assignment_targets;
drop policy if exists "OMR attempts are publicly readable" on public.omr_attempts;
drop policy if exists "OMR attempts are publicly writable" on public.omr_attempts;
drop policy if exists "OMR question results are publicly readable" on public.omr_question_results;
drop policy if exists "OMR question results are publicly writable" on public.omr_question_results;
drop policy if exists "OMR assignment submissions are publicly writable" on public.omr_assignment_submissions;
drop policy if exists "OMR attempt feedback is publicly writable" on public.omr_attempt_feedback;
drop policy if exists "OMR Kakao candidate reviews are publicly writable" on public.omr_kakao_candidate_reviews;
drop policy if exists "OMR Kakao dispatch logs are publicly writable" on public.omr_kakao_dispatch_logs;
drop policy if exists "OMR comments are publicly writable" on public.omr_comments;
drop policy if exists "OMR audit logs are publicly writable" on public.omr_audit_logs;

-- Superseded authenticated-browser policies from production-rls.sql. These
-- explicit drops make the server-only cutover safe on databases that rehearsed
-- or applied the former Supabase Auth profile.
drop policy if exists "prod organizations read by members" on public.omr_organizations;
drop policy if exists "prod organizations managed by admins" on public.omr_organizations;
drop policy if exists "prod user profiles read by self or shared org" on public.omr_user_profiles;
drop policy if exists "prod user profiles insert self" on public.omr_user_profiles;
drop policy if exists "prod user profiles update self" on public.omr_user_profiles;
drop policy if exists "prod organization members read by members or self" on public.omr_organization_members;
drop policy if exists "prod organization members managed by admins" on public.omr_organization_members;
drop policy if exists "prod teacher profiles read by members" on public.omr_teacher_profiles;
drop policy if exists "prod teacher profiles write by admins or self" on public.omr_teacher_profiles;
drop policy if exists "prod student profiles read by staff or self" on public.omr_student_profiles;
drop policy if exists "prod student profiles write by staff" on public.omr_student_profiles;
drop policy if exists "prod classes read by staff or enrolled students" on public.omr_classes;
drop policy if exists "prod classes write by staff" on public.omr_classes;
drop policy if exists "prod class teachers read by members" on public.omr_class_teachers;
drop policy if exists "prod class teachers managed by admins" on public.omr_class_teachers;
drop policy if exists "prod class students read by staff or self" on public.omr_class_students;
drop policy if exists "prod class students write by staff" on public.omr_class_students;
drop policy if exists "prod materials read by members" on public.omr_materials;
drop policy if exists "prod materials write by staff" on public.omr_materials;
drop policy if exists "prod exams read by members or assigned students" on public.omr_exams;
drop policy if exists "prod exams read by staff" on public.omr_exams;
drop policy if exists "prod exams write by staff" on public.omr_exams;
drop policy if exists "prod exam questions read with exam" on public.omr_exam_questions;
drop policy if exists "prod exam questions read by staff" on public.omr_exam_questions;
drop policy if exists "prod exam questions write with exam" on public.omr_exam_questions;
drop policy if exists "prod exam materials read with exam" on public.omr_exam_materials;
drop policy if exists "prod exam materials write with exam" on public.omr_exam_materials;
drop policy if exists "prod assignments read by staff or assigned students" on public.omr_assignments;
drop policy if exists "prod assignments write by staff" on public.omr_assignments;
drop policy if exists "prod assignment targets read by staff or assigned students" on public.omr_assignment_targets;
drop policy if exists "prod assignment targets write by staff" on public.omr_assignment_targets;
drop policy if exists "prod attempts read by staff or self" on public.omr_attempts;
drop policy if exists "prod attempts write by staff or self" on public.omr_attempts;
drop policy if exists "prod attempts write by staff" on public.omr_attempts;
drop policy if exists "prod question results read by staff or self" on public.omr_question_results;
drop policy if exists "prod question results write by staff or self" on public.omr_question_results;
drop policy if exists "prod question results write by staff" on public.omr_question_results;
drop policy if exists "prod assignment submissions read by staff or self" on public.omr_assignment_submissions;
drop policy if exists "prod assignment submissions write by staff or self" on public.omr_assignment_submissions;
drop policy if exists "prod assignment submissions write by staff" on public.omr_assignment_submissions;
drop policy if exists "prod attempt feedback read by staff or returned student" on public.omr_attempt_feedback;
drop policy if exists "prod attempt feedback insert by staff" on public.omr_attempt_feedback;
drop policy if exists "prod attempt feedback update by staff or returned student" on public.omr_attempt_feedback;
drop policy if exists "prod attempt feedback update by staff" on public.omr_attempt_feedback;
drop policy if exists "prod attempt feedback delete by staff" on public.omr_attempt_feedback;
drop policy if exists "prod kakao reviews read by staff" on public.omr_kakao_candidate_reviews;
drop policy if exists "prod kakao reviews write by staff" on public.omr_kakao_candidate_reviews;
drop policy if exists "prod kakao logs read by staff" on public.omr_kakao_dispatch_logs;
drop policy if exists "prod kakao logs write by staff" on public.omr_kakao_dispatch_logs;
drop policy if exists "Kakao reminder source reviews service read" on public.omr_kakao_candidate_reviews;
drop policy if exists "Kakao reminder source dispatches service read" on public.omr_kakao_dispatch_logs;
drop policy if exists "Kakao reminder quarantine service read" on public.omr_kakao_reminder_legacy_quarantine;
drop policy if exists "prod comments read by staff or visible student" on public.omr_comments;
drop policy if exists "prod comments write by staff" on public.omr_comments;
drop policy if exists "prod audit logs read by admins" on public.omr_audit_logs;

-- Defense in depth: every canonical/PII registry remains RLS-enabled and
-- FORCE RLS even though browser roles have no direct relation privileges.
-- This is the complete set of public.omr_* app tables created by schema.sql
-- plus migrations. Supabase-managed storage.objects/storage.buckets stay
-- outside this FORCE RLS list; their managed-owner restrictive policies are
-- installed above and verified separately by live assertions.
alter table if exists public.omr_organizations enable row level security;
alter table if exists public.omr_organizations force row level security;
alter table if exists public.omr_plan_usage enable row level security;
alter table if exists public.omr_plan_usage force row level security;
alter table if exists public.omr_plan_usage_reservations enable row level security;
alter table if exists public.omr_plan_usage_reservations force row level security;
alter table if exists public.omr_user_profiles enable row level security;
alter table if exists public.omr_user_profiles force row level security;
alter table if exists public.omr_organization_members enable row level security;
alter table if exists public.omr_organization_members force row level security;
alter table if exists public.omr_teacher_profiles enable row level security;
alter table if exists public.omr_teacher_profiles force row level security;
alter table if exists public.omr_student_profiles enable row level security;
alter table if exists public.omr_student_profiles force row level security;
alter table if exists public.omr_student_start_credentials enable row level security;
alter table if exists public.omr_student_start_credentials force row level security;
alter table if exists public.omr_student_credential_epochs enable row level security;
alter table if exists public.omr_student_credential_epochs force row level security;
alter table if exists public.omr_classes enable row level security;
alter table if exists public.omr_classes force row level security;
alter table if exists public.omr_roster_invites enable row level security;
alter table if exists public.omr_roster_invites force row level security;
alter table if exists public.omr_class_teachers enable row level security;
alter table if exists public.omr_class_teachers force row level security;
alter table if exists public.omr_class_students enable row level security;
alter table if exists public.omr_class_students force row level security;
alter table if exists public.omr_materials enable row level security;
alter table if exists public.omr_materials force row level security;
alter table if exists public.omr_exams enable row level security;
alter table if exists public.omr_exams force row level security;
alter table if exists public.omr_exam_entry_invites enable row level security;
alter table if exists public.omr_exam_entry_invites force row level security;
alter table if exists public.omr_exam_questions enable row level security;
alter table if exists public.omr_exam_questions force row level security;
alter table if exists public.omr_exam_materials enable row level security;
alter table if exists public.omr_exam_materials force row level security;
alter table if exists public.omr_assignments enable row level security;
alter table if exists public.omr_assignments force row level security;
alter table if exists public.omr_assignment_targets enable row level security;
alter table if exists public.omr_assignment_targets force row level security;
alter table if exists public.omr_attempts enable row level security;
alter table if exists public.omr_attempts force row level security;
alter table if exists public.omr_question_results enable row level security;
alter table if exists public.omr_question_results force row level security;
alter table if exists public.omr_assignment_submissions enable row level security;
alter table if exists public.omr_assignment_submissions force row level security;
alter table if exists public.omr_attempt_feedback enable row level security;
alter table if exists public.omr_attempt_feedback force row level security;
alter table if exists public.omr_kakao_candidate_reviews enable row level security;
alter table if exists public.omr_kakao_candidate_reviews force row level security;
alter table if exists public.omr_kakao_dispatch_logs enable row level security;
alter table if exists public.omr_kakao_dispatch_logs force row level security;
alter table if exists public.omr_kakao_reminder_legacy_quarantine enable row level security;
alter table if exists public.omr_kakao_reminder_legacy_quarantine force row level security;
alter table if exists public.omr_comments enable row level security;
alter table if exists public.omr_comments force row level security;
alter table if exists public.omr_audit_logs enable row level security;
alter table if exists public.omr_audit_logs force row level security;
alter table if exists public.omr_remote_assets enable row level security;
alter table if exists public.omr_remote_assets force row level security;
alter table if exists public.omr_remote_asset_upload_intents enable row level security;
alter table if exists public.omr_remote_asset_upload_intents force row level security;
alter table if exists public.omr_remote_asset_cleanup_queue enable row level security;
alter table if exists public.omr_remote_asset_cleanup_queue force row level security;
alter table if exists public.omr_attempt_sessions enable row level security;
alter table if exists public.omr_attempt_sessions force row level security;
alter table if exists public.omr_rate_limit_buckets enable row level security;
alter table if exists public.omr_rate_limit_buckets force row level security;
alter table if exists public.omr_exam_mutations enable row level security;
alter table if exists public.omr_exam_mutations force row level security;
alter table if exists public.omr_feedback_mutations enable row level security;
alter table if exists public.omr_feedback_mutations force row level security;
alter table if exists public.omr_teacher_accounts enable row level security;
alter table if exists public.omr_teacher_accounts force row level security;
alter table if exists public.omr_teacher_account_tokens enable row level security;
alter table if exists public.omr_teacher_account_tokens force row level security;
alter table if exists public.omr_operational_job_status enable row level security;
alter table if exists public.omr_operational_job_status force row level security;
alter table if exists public.omr_pilot_plan_grants enable row level security;
alter table if exists public.omr_pilot_plan_grants force row level security;
alter table if exists public.omr_initial_ops_metrics enable row level security;
alter table if exists public.omr_initial_ops_metrics force row level security;
alter table if exists public.omr_teacher_notification_states enable row level security;
alter table if exists public.omr_teacher_notification_states force row level security;
alter table public.omr_student_credential_batch_receipts enable row level security;
alter table public.omr_student_credential_batch_receipts force row level security;

-- Migration 007's readiness snapshot necessarily describes the pre-009/010
-- catalog. Preserve it as immutable evidence and publish a current wrapper
-- that understands RPC-only tables, cleanup epochs, and exam CAS. The guard
-- makes this profile safely re-applicable.
do $$
begin
    if pg_catalog.to_regprocedure('public.omr_service_readiness_v10_snapshot()') is null then
        alter function public.omr_service_readiness_v1()
            rename to omr_service_readiness_v10_snapshot;
    end if;
end
$$;

revoke all on function public.omr_service_readiness_v4_snapshot()
    from public, anon, authenticated, service_role;
revoke all on function public.omr_service_readiness_v5_snapshot()
    from public, anon, authenticated, service_role;
revoke all on function public.omr_service_readiness_v6_snapshot()
    from public, anon, authenticated, service_role;
revoke all on function public.omr_service_readiness_v7_snapshot()
    from public, anon, authenticated, service_role;
revoke all on function public.omr_service_readiness_v10_snapshot()
    from public, anon, authenticated, service_role;

create or replace function public.omr_service_readiness_v1()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_previous jsonb;
    v_canonical_tables_force_rls boolean;
    v_service_role_privileges_ready boolean;
    v_cleanup_epoch_ready boolean;
    v_operational_job_status_ready boolean;
    v_operator_pilot_provisioning_ready boolean;
    v_provisioned_teacher_login_ready boolean;
    v_attempt_sessions_ready boolean;
    v_durable_rate_limits_ready boolean;
    v_teacher_notification_summary_ready boolean;
    v_teacher_notification_state_ready boolean;
    v_exam_revision_ready boolean;
    v_teacher_exam_cas_ready boolean;
    v_feedback_revision_ready boolean;
    v_feedback_cas_ready boolean;
    v_workspace_bootstrap_plan_safe boolean;
    v_session_cleanup_optimization_ready boolean;
    v_feedback_replay_hardening_ready boolean;
    v_feedback_core_free_ready boolean;
    v_session_cleanup_fencing_ready boolean;
    v_attempt_checkpoint_null_cas_ready boolean;
    v_roster_snapshot_cas_ready boolean;
    v_attempt_mutation_cas_ready boolean;
    v_exam_delete_session_safe boolean;
    v_student_question_atomic_ready boolean;
    v_teacher_live_sessions_ready boolean;
    v_teacher_account_lifecycle_ready boolean;
    v_initial_operations_load_control_ready boolean;
    v_exam_entry_invites_ready boolean;
    v_individual_student_assignments_ready boolean;
    v_teacher_attempt_reporting_ready boolean;
    v_legacy_gateway_catalog_ready boolean;
    v_server_gateway_capabilities_ready boolean;
    v_effective_workspace_plan_enforcement_ready boolean;
    v_student_session_generation_ready boolean;
    v_student_credential_batch_ready boolean;
    v_canonical_question_result_evidence_ready boolean;
    v_assignment_generation_scope_ready boolean;
    v_kakao_reminder_entitlement_ready boolean;
    v_ready boolean;
begin
    v_previous := public.omr_service_readiness_v10_snapshot();

    with expected(table_name) as (values
        ('omr_organizations'), ('omr_plan_usage'), ('omr_plan_usage_reservations'),
        ('omr_user_profiles'), ('omr_organization_members'), ('omr_teacher_profiles'),
        ('omr_student_profiles'), ('omr_student_start_credentials'), ('omr_classes'),
        ('omr_roster_invites'), ('omr_class_teachers'), ('omr_class_students'),
        ('omr_materials'), ('omr_exams'), ('omr_exam_entry_invites'), ('omr_exam_questions'),
        ('omr_exam_materials'), ('omr_assignments'), ('omr_assignment_targets'),
        ('omr_attempts'), ('omr_question_results'), ('omr_assignment_submissions'),
        ('omr_attempt_feedback'), ('omr_kakao_candidate_reviews'),
        ('omr_kakao_dispatch_logs'), ('omr_comments'), ('omr_audit_logs'),
        ('omr_remote_assets'), ('omr_remote_asset_upload_intents'),
        ('omr_remote_asset_cleanup_queue'), ('omr_attempt_sessions'),
        ('omr_rate_limit_buckets'), ('omr_exam_mutations'), ('omr_feedback_mutations'),
        ('omr_initial_ops_metrics'), ('omr_teacher_accounts'), ('omr_teacher_account_tokens'),
        ('omr_teacher_notification_states'), ('omr_operational_job_status'),
        ('omr_pilot_plan_grants'), ('omr_student_credential_epochs'),
        ('omr_student_credential_batch_receipts'),
        ('omr_kakao_reminder_legacy_quarantine')
    ), actual(table_name, row_security, force_row_security) as (
        select relation.relname::text, relation.relrowsecurity, relation.relforcerowsecurity
          from pg_catalog.pg_class relation
          join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
         where namespace.nspname = 'public'
           and relation.relkind in ('r', 'p')
           and relation.relname like 'omr\_%' escape '\'
    )
    select not exists (select table_name from expected except select table_name from actual)
       and not exists (select table_name from actual except select table_name from expected)
       and not exists (select 1 from actual where not row_security or not force_row_security)
      into v_canonical_tables_force_rls;

    -- Ordinary canonical tables remain directly available to the trusted
    -- server. Rate buckets, mutation receipts, load metrics, and teacher
    -- account secrets are RPC-only tables.
    v_service_role_privileges_ready :=
        exists (
            select 1 from pg_catalog.pg_roles role_row
             where role_row.rolname = 'service_role' and role_row.rolbypassrls
        )
        and pg_catalog.has_schema_privilege('service_role', 'public', 'USAGE')
        and not exists (
            select 1
              from pg_catalog.pg_class relation
              join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
             where namespace.nspname = 'public'
               and relation.relkind in ('r', 'p')
               and relation.relname like 'omr\_%' escape '\'
               and relation.relname not in (
                   'omr_rate_limit_buckets', 'omr_exam_mutations', 'omr_feedback_mutations',
                   'omr_exam_entry_invites',
                   'omr_initial_ops_metrics', 'omr_teacher_accounts', 'omr_teacher_account_tokens',
                   'omr_teacher_notification_states', 'omr_operational_job_status',
                   'omr_pilot_plan_grants', 'omr_student_credential_batch_receipts',
                   'omr_student_credential_epochs', 'omr_student_start_credentials',
                   'omr_remote_assets', 'omr_remote_asset_upload_intents',
                   'omr_remote_asset_cleanup_queue', 'omr_plan_usage',
                   'omr_plan_usage_reservations', 'omr_kakao_candidate_reviews',
                   'omr_kakao_dispatch_logs', 'omr_kakao_reminder_legacy_quarantine'
               )
               and (
                   not pg_catalog.has_table_privilege('service_role', relation.oid, 'SELECT')
                   or not pg_catalog.has_table_privilege('service_role', relation.oid, 'INSERT')
                   or not pg_catalog.has_table_privilege('service_role', relation.oid, 'UPDATE')
                   or not pg_catalog.has_table_privilege('service_role', relation.oid, 'DELETE')
               )
        )
        and not pg_catalog.has_table_privilege(
            'service_role', 'public.omr_rate_limit_buckets',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
        )
        and not pg_catalog.has_table_privilege(
            'service_role', 'public.omr_exam_mutations',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
        )
        and not pg_catalog.has_table_privilege(
            'service_role', 'public.omr_feedback_mutations',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
        )
        and not pg_catalog.has_table_privilege(
            'service_role', 'public.omr_exam_entry_invites',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
        )
        and not pg_catalog.has_table_privilege(
            'service_role', 'public.omr_initial_ops_metrics',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
        )
        and not pg_catalog.has_table_privilege(
            'service_role', 'public.omr_teacher_accounts',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
        )
        and not pg_catalog.has_table_privilege(
            'service_role', 'public.omr_teacher_account_tokens',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
        )
        and not pg_catalog.has_table_privilege(
            'service_role', 'public.omr_teacher_notification_states',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
        )
        and not pg_catalog.has_table_privilege(
            'service_role', 'public.omr_operational_job_status',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
        )
        and not pg_catalog.has_table_privilege(
            'service_role', 'public.omr_pilot_plan_grants',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
        )
        and not pg_catalog.has_table_privilege(
            'service_role', 'public.omr_student_credential_epochs',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
        )
        and not pg_catalog.has_table_privilege(
            'service_role', 'public.omr_student_credential_batch_receipts',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
        )
        and pg_catalog.has_table_privilege(
            'service_role', 'public.omr_student_start_credentials', 'SELECT'
        )
        and not pg_catalog.has_table_privilege(
            'service_role', 'public.omr_student_start_credentials',
            'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
        )
        and not exists (
            select 1
              from pg_catalog.pg_class relation
              join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
             where namespace.nspname = 'public' and relation.relkind = 'S'
               and relation.relname not in (
                   'omr_operational_job_run_sequence',
                   'omr_remote_asset_cleanup_queue_id_seq'
               )
               and (
                   not pg_catalog.has_sequence_privilege('service_role', relation.oid, 'USAGE')
                   or not pg_catalog.has_sequence_privilege('service_role', relation.oid, 'SELECT')
                   or not pg_catalog.has_sequence_privilege('service_role', relation.oid, 'UPDATE')
               )
        );

    v_operational_job_status_ready :=
        pg_catalog.to_regclass('public.omr_operational_job_status') is not null
        and pg_catalog.to_regclass('public.omr_operational_job_run_sequence') is not null
        and exists (
            select 1
              from pg_catalog.pg_attribute attribute
             where attribute.attrelid = 'public.omr_operational_job_status'::pg_catalog.regclass
               and attribute.attname = 'active_lease_until'
               and not attribute.attisdropped
               and not attribute.attnotnull
               and pg_catalog.format_type(attribute.atttypid, attribute.atttypmod)
                   = 'timestamp with time zone'
        )
        and exists (
            select 1
              from pg_catalog.pg_attribute attribute
             where attribute.attrelid = 'public.omr_operational_job_status'::pg_catalog.regclass
               and attribute.attname = 'active_lease_started_at'
               and not attribute.attisdropped
               and not attribute.attnotnull
               and pg_catalog.format_type(attribute.atttypid, attribute.atttypmod)
                   = 'timestamp with time zone'
        )
        and exists (
            select 1
              from pg_catalog.pg_index index_record
             where index_record.indexrelid = pg_catalog.to_regclass(
                       'public.omr_remote_asset_cleanup_dead_idx'
                   )
               and index_record.indrelid = 'public.omr_remote_asset_cleanup_queue'::pg_catalog.regclass
               and index_record.indisvalid
               and index_record.indisready
               and not index_record.indisunique
               and index_record.indnatts = 1
               and index_record.indnkeyatts = 1
               and pg_catalog.pg_get_indexdef(index_record.indexrelid, 1, true) = 'status'
               and pg_catalog.pg_get_expr(
                   index_record.indpred, index_record.indrelid, true
               ) = 'status = ''dead''::text'
        )
        and pg_catalog.to_regprocedure(
            'public.omr_begin_operational_job_run_v1(text,text)'
        ) is not null
        and pg_catalog.to_regprocedure(
            'public.omr_complete_operational_job_run_v1(text,bigint,text,text,text)'
        ) is not null
        and pg_catalog.to_regprocedure('public.omr_read_operational_job_status_v1(text)') is not null
        and not exists (
            select 1
              from pg_catalog.pg_proc routine
             where routine.oid in (
                 'public.omr_begin_operational_job_run_v1(text,text)'::pg_catalog.regprocedure,
                 'public.omr_complete_operational_job_run_v1(text,bigint,text,text,text)'::pg_catalog.regprocedure,
                 'public.omr_read_operational_job_status_v1(text)'::pg_catalog.regprocedure
             )
               and (
                   routine.prokind <> 'f'
                   or pg_catalog.pg_get_function_result(routine.oid) <> 'jsonb'
                   or not routine.prosecdef
                   or pg_catalog.pg_get_userbyid(routine.proowner) <> 'postgres'
                   or not coalesce(routine.proconfig, '{}'::text[]) @> array[
                       'search_path=""', 'statement_timeout=5s'
                   ]::text[]
                   or (
                       routine.proname <> 'omr_read_operational_job_status_v1'
                       and not coalesce(routine.proconfig, '{}'::text[])
                           @> array['lock_timeout=2s']::text[]
                   )
               )
        )
        and not exists (
            select 1
              from pg_catalog.pg_proc routine
              join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
             where namespace.nspname = 'public'
               and routine.proname in (
                   'omr_begin_operational_job_run_v1',
                   'omr_complete_operational_job_run_v1',
                   'omr_read_operational_job_status_v1'
               )
               and routine.oid not in (
                   'public.omr_begin_operational_job_run_v1(text,text)'::pg_catalog.regprocedure,
                   'public.omr_complete_operational_job_run_v1(text,bigint,text,text,text)'::pg_catalog.regprocedure,
                   'public.omr_read_operational_job_status_v1(text)'::pg_catalog.regprocedure
               )
        )
        and not exists (
            select 1
              from pg_catalog.unnest(array[
                  'public.omr_begin_operational_job_run_v1(text,text)',
                  'public.omr_complete_operational_job_run_v1(text,bigint,text,text,text)',
                  'public.omr_read_operational_job_status_v1(text)'
              ]) signature(value)
             where not pg_catalog.has_function_privilege('service_role', signature.value, 'EXECUTE')
                or pg_catalog.has_function_privilege('anon', signature.value, 'EXECUTE')
                or pg_catalog.has_function_privilege('authenticated', signature.value, 'EXECUTE')
        )
        and not pg_catalog.has_sequence_privilege(
            'service_role', 'public.omr_operational_job_run_sequence', 'USAGE,SELECT,UPDATE'
        )
        and position(
            'nextval' in pg_catalog.pg_get_functiondef(
                'public.omr_begin_operational_job_run_v1(text,text)'::pg_catalog.regprocedure
            )
        ) > 0
        and position(
            'v_job_status.active_lease_until > v_now' in pg_catalog.pg_get_functiondef(
                'public.omr_begin_operational_job_run_v1(text,text)'::pg_catalog.regprocedure
            )
        ) > 0
        and position(
            'interval ''15 minutes''' in pg_catalog.pg_get_functiondef(
                'public.omr_begin_operational_job_run_v1(text,text)'::pg_catalog.regprocedure
            )
        ) > 0
        and position(
            'v_now + interval ''15 minutes''' in pg_catalog.pg_get_functiondef(
                'public.omr_begin_operational_job_run_v1(text,text)'::pg_catalog.regprocedure
            )
        ) > 0
        and position(
            'p_run_sequence = v_job_status.latest_started_sequence' in pg_catalog.pg_get_functiondef(
                'public.omr_complete_operational_job_run_v1(text,bigint,text,text,text)'::pg_catalog.regprocedure
            )
        ) > 0
        and position(
            'active_lease_until = null' in pg_catalog.pg_get_functiondef(
                'public.omr_complete_operational_job_run_v1(text,bigint,text,text,text)'::pg_catalog.regprocedure
            )
        ) > 0
        and position(
            'active_lease_started_at = null' in pg_catalog.pg_get_functiondef(
                'public.omr_complete_operational_job_run_v1(text,bigint,text,text,text)'::pg_catalog.regprocedure
            )
        ) > 0
        and position(
            '''duplicate'', v_duplicate' in pg_catalog.pg_get_functiondef(
                'public.omr_complete_operational_job_run_v1(text,bigint,text,text,text)'::pg_catalog.regprocedure
            )
        ) > 0
        and position(
            'operational job completion conflict' in pg_catalog.pg_get_functiondef(
                'public.omr_complete_operational_job_run_v1(text,bigint,text,text,text)'::pg_catalog.regprocedure
            )
        ) > 0
        and position(
            'lock table public.omr_remote_asset_cleanup_queue in share mode' in pg_catalog.pg_get_functiondef(
                'public.omr_complete_operational_job_run_v1(text,bigint,text,text,text)'::pg_catalog.regprocedure
            )
        ) > 0
        and not exists (
            select 1
              from pg_catalog.pg_class relation
              cross join lateral pg_catalog.aclexplode(
                  coalesce(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
              ) privilege
             where relation.oid in (
                       'public.omr_operational_job_status'::pg_catalog.regclass,
                       'public.omr_operational_job_run_sequence'::pg_catalog.regclass
                   )
               and privilege.grantee = 0
        )
        and not exists (
            select 1
              from pg_catalog.pg_proc routine
              cross join lateral pg_catalog.aclexplode(
                  coalesce(routine.proacl, pg_catalog.acldefault('f', routine.proowner))
              ) privilege
             where routine.oid in (
                 'public.omr_begin_operational_job_run_v1(text,text)'::pg_catalog.regprocedure,
                 'public.omr_complete_operational_job_run_v1(text,bigint,text,text,text)'::pg_catalog.regprocedure,
                 'public.omr_read_operational_job_status_v1(text)'::pg_catalog.regprocedure
             )
               and privilege.privilege_type = 'EXECUTE'
               and privilege.grantee not in (routine.proowner, 'service_role'::pg_catalog.regrole)
        );

    v_cleanup_epoch_ready :=
        pg_catalog.to_regclass('public.omr_remote_asset_cleanup_queue') is not null
        and pg_catalog.to_regclass('public.omr_remote_asset_cleanup_claim_idx') is not null
        and pg_catalog.to_regprocedure('public.omr_claim_remote_asset_cleanup_v1(text,integer,integer)') is not null
        and pg_catalog.to_regprocedure('public.omr_authorize_remote_asset_cleanup_delete_v1(text,text,integer)') is not null
        and pg_catalog.to_regprocedure('public.omr_ack_remote_asset_cleanup_v1(text,text,integer)') is not null
        and pg_catalog.to_regprocedure('public.omr_fail_remote_asset_cleanup_v1(text,text,integer,text)') is not null
        and pg_catalog.has_function_privilege('service_role', 'public.omr_claim_remote_asset_cleanup_v1(text,integer,integer)', 'EXECUTE')
        and pg_catalog.has_function_privilege('service_role', 'public.omr_authorize_remote_asset_cleanup_delete_v1(text,text,integer)', 'EXECUTE')
        and pg_catalog.has_function_privilege('service_role', 'public.omr_ack_remote_asset_cleanup_v1(text,text,integer)', 'EXECUTE')
        and pg_catalog.has_function_privilege('service_role', 'public.omr_fail_remote_asset_cleanup_v1(text,text,integer,text)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('service_role', 'public.omr_ack_remote_asset_cleanup_v1(text,text)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('service_role', 'public.omr_fail_remote_asset_cleanup_v1(text,text,text)', 'EXECUTE')
        and not exists (
            select 1
              from pg_catalog.pg_proc routine
              join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
             where namespace.nspname = 'public'
               and routine.proname in (
                   'omr_claim_remote_asset_cleanup_v1',
                   'omr_authorize_remote_asset_cleanup_delete_v1',
                   'omr_ack_remote_asset_cleanup_v1',
                   'omr_fail_remote_asset_cleanup_v1'
               )
               and (
                   pg_catalog.has_function_privilege('anon', routine.oid, 'EXECUTE')
                   or pg_catalog.has_function_privilege('authenticated', routine.oid, 'EXECUTE')
               )
        );

    v_attempt_sessions_ready :=
        pg_catalog.to_regclass('public.omr_attempt_sessions') is not null
        and pg_catalog.to_regclass('public.omr_attempt_sessions_one_active_scope_idx') is not null
        and pg_catalog.to_regclass('public.omr_attempt_sessions_active_lease_idx') is not null
        and not pg_catalog.has_table_privilege('anon', 'public.omr_attempt_sessions', 'SELECT,INSERT,UPDATE,DELETE')
        and not pg_catalog.has_table_privilege('authenticated', 'public.omr_attempt_sessions', 'SELECT,INSERT,UPDATE,DELETE')
        and not exists (
            select 1
              from pg_catalog.pg_proc routine
              join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
             where namespace.nspname = 'public'
               and routine.proname in (
                   'omr_open_attempt_session_v3', 'omr_checkpoint_attempt_session_v2',
                   'omr_heartbeat_attempt_session_v2', 'omr_takeover_attempt_session_v2',
                   'omr_prepare_attempt_session_submit_v2', 'omr_commit_attempt_session_submit_v2',
                   'omr_prepare_attempt_handwriting_asset_v2', 'omr_discard_attempt_handwriting_asset_v1'
               )
               and (
                   not pg_catalog.has_function_privilege('service_role', routine.oid, 'EXECUTE')
                   or pg_catalog.has_function_privilege('anon', routine.oid, 'EXECUTE')
                   or pg_catalog.has_function_privilege('authenticated', routine.oid, 'EXECUTE')
               )
        )
        and (
            select count(*) from pg_catalog.pg_proc routine
             join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
            where namespace.nspname = 'public'
              and routine.proname in (
                  'omr_open_attempt_session_v3', 'omr_checkpoint_attempt_session_v2',
                  'omr_heartbeat_attempt_session_v2', 'omr_takeover_attempt_session_v2',
                  'omr_prepare_attempt_session_submit_v2', 'omr_commit_attempt_session_submit_v2',
                  'omr_prepare_attempt_handwriting_asset_v2', 'omr_discard_attempt_handwriting_asset_v1'
              )
        ) = 8;

    v_durable_rate_limits_ready :=
        pg_catalog.to_regclass('public.omr_rate_limit_buckets') is not null
        and pg_catalog.to_regclass('public.omr_rate_limit_buckets_expires_idx') is not null
        and pg_catalog.to_regprocedure('public.omr_consume_rate_limit_v1(text,text,integer,integer,integer)') is not null
        and not pg_catalog.has_table_privilege('public', 'public.omr_rate_limit_buckets', 'SELECT,INSERT,UPDATE,DELETE')
        and not pg_catalog.has_table_privilege('anon', 'public.omr_rate_limit_buckets', 'SELECT,INSERT,UPDATE,DELETE')
        and not pg_catalog.has_table_privilege('authenticated', 'public.omr_rate_limit_buckets', 'SELECT,INSERT,UPDATE,DELETE')
        and not pg_catalog.has_table_privilege('service_role', 'public.omr_rate_limit_buckets', 'SELECT,INSERT,UPDATE,DELETE')
        and pg_catalog.has_function_privilege('service_role', 'public.omr_consume_rate_limit_v1(text,text,integer,integer,integer)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('anon', 'public.omr_consume_rate_limit_v1(text,text,integer,integer,integer)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('authenticated', 'public.omr_consume_rate_limit_v1(text,text,integer,integer,integer)', 'EXECUTE');

    v_teacher_notification_summary_ready :=
        pg_catalog.to_regprocedure(
            'public.omr_teacher_notification_summary_v1(text)'
        ) is not null
        and coalesce(pg_catalog.has_function_privilege(
            'service_role',
            pg_catalog.to_regprocedure('public.omr_teacher_notification_summary_v1(text)'),
            'EXECUTE'
        ), false)
        and not coalesce(pg_catalog.has_function_privilege(
            'anon',
            pg_catalog.to_regprocedure('public.omr_teacher_notification_summary_v1(text)'),
            'EXECUTE'
        ), false)
        and not coalesce(pg_catalog.has_function_privilege(
            'authenticated',
            pg_catalog.to_regprocedure('public.omr_teacher_notification_summary_v1(text)'),
            'EXECUTE'
        ), false)
        and (
            select count(*) = 1
              from pg_catalog.pg_proc routine
              join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
             where namespace.nspname = 'public'
               and routine.proname = 'omr_teacher_notification_summary_v1'
               and routine.prokind = 'f'
               and pg_catalog.oidvectortypes(routine.proargtypes) = 'text'
        );

    v_teacher_notification_state_ready :=
        pg_catalog.to_regclass('public.omr_teacher_notification_states') is not null
        and pg_catalog.to_regclass('public.omr_teacher_notification_states_expiry_idx') is not null
        and exists (
            select 1
              from pg_catalog.pg_class relation
             where relation.oid = 'public.omr_teacher_notification_states'::pg_catalog.regclass
               and relation.relrowsecurity
               and relation.relforcerowsecurity
        )
        and not pg_catalog.has_table_privilege(
            'public', 'public.omr_teacher_notification_states',
            'SELECT,INSERT,UPDATE,DELETE'
        )
        and not pg_catalog.has_table_privilege(
            'anon', 'public.omr_teacher_notification_states',
            'SELECT,INSERT,UPDATE,DELETE'
        )
        and not pg_catalog.has_table_privilege(
            'authenticated', 'public.omr_teacher_notification_states',
            'SELECT,INSERT,UPDATE,DELETE'
        )
        and not pg_catalog.has_table_privilege(
            'service_role', 'public.omr_teacher_notification_states',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
        )
        and pg_catalog.to_regprocedure(
            'public.omr_load_teacher_notification_state_v1(text,text,text[])'
        ) is not null
        and pg_catalog.to_regprocedure(
            'public.omr_mutate_teacher_notification_state_v1(text,text,text,text[])'
        ) is not null
        and pg_catalog.has_function_privilege(
            'service_role',
            'public.omr_load_teacher_notification_state_v1(text,text,text[])',
            'EXECUTE'
        )
        and pg_catalog.has_function_privilege(
            'service_role',
            'public.omr_mutate_teacher_notification_state_v1(text,text,text,text[])',
            'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
            'anon',
            'public.omr_load_teacher_notification_state_v1(text,text,text[])',
            'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
            'authenticated',
            'public.omr_mutate_teacher_notification_state_v1(text,text,text,text[])',
            'EXECUTE'
        )
        and (
            select count(*) = 2
              from pg_catalog.pg_proc routine
              join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
             where namespace.nspname = 'public'
               and routine.prokind = 'f'
               and (
                    (routine.proname = 'omr_load_teacher_notification_state_v1'
                     and pg_catalog.oidvectortypes(routine.proargtypes) = 'text, text, text[]')
                    or
                    (routine.proname = 'omr_mutate_teacher_notification_state_v1'
                     and pg_catalog.oidvectortypes(routine.proargtypes) = 'text, text, text, text[]')
               )
        );

    select exists (
        select 1
          from pg_catalog.pg_attribute attribute
          join pg_catalog.pg_attrdef attribute_default
            on attribute_default.adrelid = attribute.attrelid
           and attribute_default.adnum = attribute.attnum
         where attribute.attrelid = 'public.omr_exams'::pg_catalog.regclass
           and attribute.attname = 'revision'
           and not attribute.attisdropped
           and attribute.attnotnull
           and pg_catalog.pg_get_expr(
               attribute_default.adbin, attribute_default.adrelid
           ) = '1'::text
    ) and exists (
        select 1 from pg_catalog.pg_constraint constraint_row
         where constraint_row.conrelid = 'public.omr_exams'::pg_catalog.regclass
           and constraint_row.conname = 'omr_exams_revision_positive'
           and constraint_row.contype = 'c' and constraint_row.convalidated
    ) into v_exam_revision_ready;

    v_teacher_exam_cas_ready :=
        v_exam_revision_ready
        and pg_catalog.to_regclass('public.omr_exam_mutations') is not null
        and not pg_catalog.has_table_privilege('public', 'public.omr_exam_mutations', 'SELECT,INSERT,UPDATE,DELETE')
        and not pg_catalog.has_table_privilege('anon', 'public.omr_exam_mutations', 'SELECT,INSERT,UPDATE,DELETE')
        and not pg_catalog.has_table_privilege('authenticated', 'public.omr_exam_mutations', 'SELECT,INSERT,UPDATE,DELETE')
        and not pg_catalog.has_table_privilege('service_role', 'public.omr_exam_mutations', 'SELECT,INSERT,UPDATE,DELETE')
        and pg_catalog.has_function_privilege('service_role', 'public.omr_save_exam_v3(text,text,bigint,text,jsonb,jsonb,jsonb,bigint,text)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('anon', 'public.omr_save_exam_v3(text,text,bigint,text,jsonb,jsonb,jsonb,bigint,text)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('authenticated', 'public.omr_save_exam_v3(text,text,bigint,text,jsonb,jsonb,jsonb,bigint,text)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('service_role', 'public.omr_save_exam_v2(jsonb,jsonb,jsonb,text,bigint,text)', 'EXECUTE')
        and not coalesce(pg_catalog.has_function_privilege(
            'service_role',
            pg_catalog.to_regprocedure('public.omr_save_exam_v1(jsonb,jsonb,jsonb,text)'),
            'EXECUTE'
        ), false)
        and not pg_catalog.has_function_privilege('service_role', 'public.omr_save_exam_v10_snapshot(jsonb,jsonb,jsonb,text)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('service_role', 'public.omr_release_plan_usage_v10_snapshot(text,text,date,text)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('service_role', 'public.omr_normalize_exam_save_request_v10(jsonb)', 'EXECUTE');

    select exists (
        select 1
          from pg_catalog.pg_attribute attribute
          join pg_catalog.pg_attrdef attribute_default
            on attribute_default.adrelid = attribute.attrelid
           and attribute_default.adnum = attribute.attnum
         where attribute.attrelid = 'public.omr_attempt_feedback'::pg_catalog.regclass
           and attribute.attname = 'revision'
           and not attribute.attisdropped and attribute.attnotnull
           and pg_catalog.pg_get_expr(attribute_default.adbin, attribute_default.adrelid) = '1'::text
    ) and exists (
        select 1 from pg_catalog.pg_constraint constraint_row
         where constraint_row.conrelid = 'public.omr_attempt_feedback'::pg_catalog.regclass
           and constraint_row.conname = 'omr_attempt_feedback_revision_positive'
           and constraint_row.contype = 'c' and constraint_row.convalidated
    ) into v_feedback_revision_ready;

    v_feedback_cas_ready :=
        v_feedback_revision_ready
        and pg_catalog.to_regclass('public.omr_feedback_mutations') is not null
        and not pg_catalog.has_table_privilege('service_role', 'public.omr_feedback_mutations', 'SELECT,INSERT,UPDATE,DELETE')
        and pg_catalog.has_function_privilege('service_role', 'public.omr_save_feedback_v4(text,text,bigint,text,text,jsonb,bigint,text)', 'EXECUTE')
        and pg_catalog.has_function_privilege('service_role', 'public.omr_return_feedback_v4(text,text,bigint,text,text,text,bigint,text)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('anon', 'public.omr_save_feedback_v4(text,text,bigint,text,text,jsonb,bigint,text)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('authenticated', 'public.omr_return_feedback_v4(text,text,bigint,text,text,text,bigint,text)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('service_role', 'public.omr_save_feedback_v2(text,jsonb,bigint,text)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('service_role', 'public.omr_return_feedback_v2(text,text,bigint,text)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('service_role', 'public.omr_save_feedback_v1(text,jsonb)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('service_role', 'public.omr_return_feedback_v1(text,text,timestamptz)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('service_role', 'public.omr_save_feedback_v12_snapshot(text,jsonb)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('service_role', 'public.omr_return_feedback_v12_snapshot(text,text,timestamptz)', 'EXECUTE');

    v_feedback_replay_hardening_ready :=
        pg_catalog.to_regclass('public.omr_feedback_mutations_created_idx') is not null
        and pg_catalog.to_regclass('public.omr_feedback_mutations_org_kind_created_idx') is not null
        and pg_catalog.obj_description(
            'public.omr_save_feedback_v2(text,jsonb,bigint,text)'::pg_catalog.regprocedure,
            'pg_proc'
        ) = 'feedback-replay-hardening:202608060014'
        and pg_catalog.obj_description(
            'public.omr_return_feedback_v2(text,text,bigint,text)'::pg_catalog.regprocedure,
            'pg_proc'
        ) = 'feedback-replay-hardening:202608060014';

    v_feedback_core_free_ready :=
        pg_catalog.to_regprocedure('public.omr_save_feedback_v4(text,text,bigint,text,text,jsonb,bigint,text)') is not null
        and pg_catalog.to_regprocedure('public.omr_return_feedback_v4(text,text,bigint,text,text,text,bigint,text)') is not null
        and pg_catalog.has_function_privilege('service_role', 'public.omr_save_feedback_v4(text,text,bigint,text,text,jsonb,bigint,text)', 'EXECUTE')
        and pg_catalog.has_function_privilege('service_role', 'public.omr_return_feedback_v4(text,text,bigint,text,text,text,bigint,text)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('anon', 'public.omr_save_feedback_v4(text,text,bigint,text,text,jsonb,bigint,text)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('authenticated', 'public.omr_return_feedback_v4(text,text,bigint,text,text,text,bigint,text)', 'EXECUTE')
        and pg_catalog.obj_description(
            'public.omr_save_feedback_v4(text,text,bigint,text,text,jsonb,bigint,text)'::pg_catalog.regprocedure,
            'pg_proc'
        ) = 'Account-session-bound feedback save with identity-before-replay and plan-before-premium-write ordering.'
        and pg_catalog.obj_description(
            'public.omr_return_feedback_v4(text,text,bigint,text,text,text,bigint,text)'::pg_catalog.regprocedure,
            'pg_proc'
        ) = 'Account-session-bound feedback return with identity-before-replay ordering.';

    v_exam_entry_invites_ready :=
        pg_catalog.to_regclass('public.omr_exam_entry_invites') is not null
        and not pg_catalog.has_table_privilege('public', 'public.omr_exam_entry_invites', 'SELECT,INSERT,UPDATE,DELETE')
        and not pg_catalog.has_table_privilege('anon', 'public.omr_exam_entry_invites', 'SELECT,INSERT,UPDATE,DELETE')
        and not pg_catalog.has_table_privilege('authenticated', 'public.omr_exam_entry_invites', 'SELECT,INSERT,UPDATE,DELETE')
        and not pg_catalog.has_table_privilege('service_role', 'public.omr_exam_entry_invites', 'SELECT,INSERT,UPDATE,DELETE')
        and pg_catalog.to_regprocedure('public.omr_get_exam_entry_invite_metadata_v1(text,text,text)') is not null
        and pg_catalog.to_regprocedure('public.omr_revoke_exam_entry_invite_v1(text,text,text)') is not null
        and pg_catalog.has_function_privilege('service_role', 'public.omr_rotate_exam_entry_invite_v1(text,text,text,text,timestamptz)', 'EXECUTE')
        and pg_catalog.has_function_privilege('service_role', 'public.omr_resolve_exam_entry_invite_v1(text,text)', 'EXECUTE')
        and pg_catalog.has_function_privilege('service_role', 'public.omr_get_exam_entry_invite_metadata_v1(text,text,text)', 'EXECUTE')
        and pg_catalog.has_function_privilege('service_role', 'public.omr_revoke_exam_entry_invite_v1(text,text,text)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('anon', 'public.omr_rotate_exam_entry_invite_v1(text,text,text,text,timestamptz)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('authenticated', 'public.omr_resolve_exam_entry_invite_v1(text,text)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('anon', 'public.omr_get_exam_entry_invite_metadata_v1(text,text,text)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('authenticated', 'public.omr_get_exam_entry_invite_metadata_v1(text,text,text)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('anon', 'public.omr_revoke_exam_entry_invite_v1(text,text,text)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('authenticated', 'public.omr_revoke_exam_entry_invite_v1(text,text,text)', 'EXECUTE')
        and pg_catalog.obj_description(
            'public.omr_rotate_exam_entry_invite_v1(text,text,text,text,timestamptz)'::pg_catalog.regprocedure,
            'pg_proc'
        ) = 'opaque-exam-entry-invite:202608060029'
        and pg_catalog.obj_description(
            'public.omr_resolve_exam_entry_invite_v1(text,text)'::pg_catalog.regprocedure,
            'pg_proc'
        ) = 'opaque-exam-entry-invite:202608060029'
        and pg_catalog.obj_description(
            pg_catalog.to_regprocedure('public.omr_get_exam_entry_invite_metadata_v1(text,text,text)'),
            'pg_proc'
        ) = 'metadata-only-exam-entry-invite-lifecycle:202608080011'
        and pg_catalog.obj_description(
            pg_catalog.to_regprocedure('public.omr_revoke_exam_entry_invite_v1(text,text,text)'),
            'pg_proc'
        ) = 'metadata-only-exam-entry-invite-lifecycle:202608080011';

    v_workspace_bootstrap_plan_safe :=
        pg_catalog.to_regprocedure('public.omr_bootstrap_workspace_organization_v1(text,text,jsonb,timestamptz)') is not null
        and pg_catalog.has_function_privilege('service_role', 'public.omr_bootstrap_workspace_organization_v1(text,text,jsonb,timestamptz)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('anon', 'public.omr_bootstrap_workspace_organization_v1(text,text,jsonb,timestamptz)', 'EXECUTE')
        and position(
            'plan = excluded.plan' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_bootstrap_workspace_organization_v1(text,text,jsonb,timestamptz)'::pg_catalog.regprocedure
            ))
        ) = 0;

    v_session_cleanup_optimization_ready :=
        pg_catalog.to_regclass('public.omr_attempt_sessions_expiry_gc_idx') is not null
        and pg_catalog.to_regclass('public.omr_attempt_sessions_terminal_gc_idx') is not null
        and pg_catalog.to_regclass('public.omr_remote_assets_handwriting_orphan_gc_idx') is not null
        and pg_catalog.to_regclass('public.omr_remote_asset_cleanup_org_status_idx') is not null
        and pg_catalog.to_regprocedure('public.omr_gc_attempt_sessions_v1(integer,integer)') is not null
        and pg_catalog.to_regprocedure('public.omr_requeue_dead_remote_asset_cleanup_v1(text,text,integer,text,text)') is not null
        and pg_catalog.has_function_privilege('service_role', 'public.omr_gc_attempt_sessions_v1(integer,integer)', 'EXECUTE')
        and pg_catalog.has_function_privilege('service_role', 'public.omr_requeue_dead_remote_asset_cleanup_v1(text,text,integer,text,text)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('anon', 'public.omr_gc_attempt_sessions_v1(integer,integer)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('authenticated', 'public.omr_gc_attempt_sessions_v1(integer,integer)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('anon', 'public.omr_requeue_dead_remote_asset_cleanup_v1(text,text,integer,text,text)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('authenticated', 'public.omr_requeue_dead_remote_asset_cleanup_v1(text,text,integer,text,text)', 'EXECUTE');

    v_session_cleanup_fencing_ready :=
        pg_catalog.to_regclass('public.omr_attempt_sessions_submitted_asset_guard_idx') is not null
        and exists (
            select 1
              from pg_catalog.pg_attribute attribute
             where attribute.attrelid = 'public.omr_remote_asset_cleanup_queue'::pg_catalog.regclass
               and attribute.attname = 'retry_count'
               and attribute.attnotnull
               and not attribute.attisdropped
        )
        and exists (
            select 1 from pg_catalog.pg_constraint constraint_row
             where constraint_row.conrelid = 'public.omr_remote_asset_cleanup_queue'::pg_catalog.regclass
               and constraint_row.conname = 'omr_remote_asset_cleanup_queue_retry_count_check'
               and constraint_row.contype = 'c' and constraint_row.convalidated
        )
        and position(
            'attempts = queue.attempts + 1' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_requeue_dead_remote_asset_cleanup_v1(text,text,integer,text,text)'::pg_catalog.regprocedure
            ))
        ) > 0
        and position(
            'retry_count = queue.retry_count + 1' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_claim_remote_asset_cleanup_v8_snapshot(text,integer,integer)'::pg_catalog.regprocedure
            ))
        ) > 0
        and position(
            'to_jsonb(claimed)' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_claim_remote_asset_cleanup_v8_snapshot(text,integer,integer)'::pg_catalog.regprocedure
            ))
        ) = 0
        and position(
            'omr_claim_remote_asset_cleanup_v8_snapshot' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_claim_remote_asset_cleanup_v1(text,integer,integer)'::pg_catalog.regprocedure
            ))
        ) > 0
        and position(
            'v_now := pg_catalog.clock_timestamp();' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_checkpoint_attempt_session_v1(text,text,text,bigint,bigint,text,jsonb,jsonb,jsonb,integer,boolean)'::pg_catalog.regprocedure
            ))
        ) > position(
            'for update;' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_checkpoint_attempt_session_v1(text,text,text,bigint,bigint,text,jsonb,jsonb,jsonb,integer,boolean)'::pg_catalog.regprocedure
            ))
        );

    v_attempt_checkpoint_null_cas_ready :=
        pg_catalog.obj_description(
            'public.omr_checkpoint_attempt_session_v1(text,text,text,bigint,bigint,text,jsonb,jsonb,jsonb,integer,boolean)'::pg_catalog.regprocedure,
            'pg_proc'
        ) = 'attempt-checkpoint-null-cas:202608060016;secure-submission-outbox-replay:202608060028;handwriting-takeover-checkpoint:202608060031'
        and position(
            'p_expected_revision is null' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_checkpoint_attempt_session_v1(text,text,text,bigint,bigint,text,jsonb,jsonb,jsonb,integer,boolean)'::pg_catalog.regprocedure
            ))
        ) > 0
        and position(
            'p_expected_lease_epoch is null' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_checkpoint_attempt_session_v1(text,text,text,bigint,bigint,text,jsonb,jsonb,jsonb,integer,boolean)'::pg_catalog.regprocedure
            ))
        ) > 0
        and position(
            'v_session.revision is distinct from p_expected_revision' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_checkpoint_attempt_session_v1(text,text,text,bigint,bigint,text,jsonb,jsonb,jsonb,integer,boolean)'::pg_catalog.regprocedure
            ))
        ) > 0
        and position(
            'v_session.lease_epoch is distinct from p_expected_lease_epoch' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_checkpoint_attempt_session_v1(text,text,text,bigint,bigint,text,jsonb,jsonb,jsonb,integer,boolean)'::pg_catalog.regprocedure
            ))
        ) > 0
        and position(
            'pg_column_size(v_handwriting_checkpoint) > 65536' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_checkpoint_attempt_session_v1(text,text,text,bigint,bigint,text,jsonb,jsonb,jsonb,integer,boolean)'::pg_catalog.regprocedure
            ))
        ) > 0
        and position(
            'v_session.progress_payload -> ''handwritingcheckpoint''' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_checkpoint_attempt_session_v1(text,text,text,bigint,bigint,text,jsonb,jsonb,jsonb,integer,boolean)'::pg_catalog.regprocedure
            ))
        ) > 0;

    v_operator_pilot_provisioning_ready :=
        pg_catalog.to_regclass('public.omr_pilot_plan_grants') is not null
        and pg_catalog.to_regprocedure(
            'public.omr_provision_pilot_teacher_v1(text,text,text,text,text,timestamptz,text,text,text)'
        ) is not null
        and pg_catalog.to_regprocedure(
            'public.omr_read_effective_workspace_plan_v1(text)'
        ) is not null
        and (
            select pg_catalog.count(*) = 2
               and pg_catalog.bool_and(
                   routine.prosecdef
                   and pg_catalog.pg_get_userbyid(routine.proowner) = 'postgres'
                   and routine.prokind = 'f'
                   and pg_catalog.pg_get_function_result(routine.oid) = 'jsonb'
                   and routine.proconfig @> array['search_path=""']::text[]
                   and case
                       when routine.proname = 'omr_provision_pilot_teacher_v1' then
                           routine.proconfig @> array[
                               'statement_timeout=10s', 'lock_timeout=3s'
                           ]::text[]
                       else routine.proconfig @> array['statement_timeout=5s']::text[]
                   end
                   and pg_catalog.has_function_privilege('service_role', routine.oid, 'EXECUTE')
                   and not pg_catalog.has_function_privilege('anon', routine.oid, 'EXECUTE')
                   and not pg_catalog.has_function_privilege('authenticated', routine.oid, 'EXECUTE')
               )
              from pg_catalog.pg_proc routine
              join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
             where namespace.nspname = 'public'
               and routine.proname in (
                   'omr_provision_pilot_teacher_v1',
                   'omr_read_effective_workspace_plan_v1'
               )
        )
        and pg_catalog.obj_description(
            'public.omr_provision_pilot_teacher_v1(text,text,text,text,text,timestamptz,text,text,text)'::pg_catalog.regprocedure,
            'pg_proc'
        ) = 'atomic-operator-pilot-teacher-provisioning:202608080006'
        and pg_catalog.obj_description(
            'public.omr_read_effective_workspace_plan_v1(text)'::pg_catalog.regprocedure,
            'pg_proc'
        ) like 'expiry-safe-effective-workspace-plan-read:202608080006;%'
        -- Exact PG17 catalog attestations prevent semantics-preserving token
        -- spoofing such as `expires_at > clock_timestamp() OR true`.
        and pg_catalog.encode(extensions.digest(pg_catalog.pg_get_functiondef(
            'public.omr_provision_pilot_teacher_v1(text,text,text,text,text,timestamptz,text,text,text)'::pg_catalog.regprocedure
        ), 'sha256'), 'hex') = '282a79ed02c1a3cfc927248cf554ff5ae64eb73b18b8b1f658396d466f884a46'
        and pg_catalog.encode(extensions.digest(pg_catalog.pg_get_functiondef(
            'public.omr_read_effective_workspace_plan_v1(text)'::pg_catalog.regprocedure
        ), 'sha256'), 'hex') = 'fcd083ee1f40a923e03cc8fd7bfccbdaa70d74d34a2e8dc35e7439760b099b45'
        and exists (
            select 1 from pg_catalog.pg_index index_record
             where index_record.indexrelid = pg_catalog.to_regclass(
                       'public.omr_pilot_plan_grants_one_current_org_idx'
                   )
               and index_record.indrelid = 'public.omr_pilot_plan_grants'::pg_catalog.regclass
               and index_record.indisvalid and index_record.indisready and index_record.indisunique
               and pg_catalog.encode(extensions.digest(
                   pg_catalog.pg_get_indexdef(index_record.indexrelid), 'sha256'
               ), 'hex') = '9e546425eaa75644fb8ee944062da143dad242f4424061910bee2fab4ea07670'
        )
        and exists (
            select 1 from pg_catalog.pg_index index_record
             where index_record.indexrelid = pg_catalog.to_regclass(
                       'public.omr_pilot_plan_grants_idempotency_hash_unique'
                   )
               and index_record.indrelid = 'public.omr_pilot_plan_grants'::pg_catalog.regclass
               and index_record.indisvalid and index_record.indisready and index_record.indisunique
               and pg_catalog.encode(extensions.digest(
                   pg_catalog.pg_get_indexdef(index_record.indexrelid), 'sha256'
               ), 'hex') = 'a28a831abf38473c8a7d6989749d298b2de2c6d7629fb08925c146a5c57e0bc1'
        )
        and (
            select pg_catalog.count(*) = 7
               and pg_catalog.encode(extensions.digest(pg_catalog.string_agg(
                   constraint_record.conname || '='
                       || pg_catalog.pg_get_constraintdef(constraint_record.oid, true),
                   E'\n' order by constraint_record.conname
               ), 'sha256'), 'hex') = 'e05ecee3e626ee9d15f3143003f5fe0ea9b0a31ffabe9a395fbff7dac1d17fec'
              from pg_catalog.pg_constraint constraint_record
             where constraint_record.conrelid = 'public.omr_pilot_plan_grants'::pg_catalog.regclass
               and constraint_record.conname in (
                   'omr_pilot_plan_grants_idempotency_hash_check',
                   'omr_pilot_plan_grants_request_hash_check',
                   'omr_pilot_plan_grants_plan_check',
                   'omr_pilot_plan_grants_state_check',
                   'omr_pilot_plan_grants_expiry_check',
                   'omr_pilot_plan_grants_superseded_check',
                   'omr_pilot_plan_grants_updated_check'
               )
        )
        and not pg_catalog.has_table_privilege(
            'service_role', 'public.omr_pilot_plan_grants',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
        );

    v_provisioned_teacher_login_ready :=
        pg_catalog.to_regprocedure('public.omr_lookup_teacher_account_v1(text)') is not null
        and pg_catalog.to_regprocedure('public.omr_validate_teacher_session_v1(text,bigint)') is not null
        and pg_catalog.to_regprocedure('public.omr_begin_teacher_password_reset_v1(text,text,text,timestamptz)') is not null
        and pg_catalog.to_regprocedure('public.omr_complete_teacher_password_reset_v1(text,text)') is not null
        and pg_catalog.to_regprocedure('public.omr_lookup_provisioned_teacher_login_v1(text)') is not null
        and pg_catalog.to_regprocedure('public.omr_validate_provisioned_teacher_session_v1(text,bigint,text)') is not null
        and pg_catalog.to_regprocedure('public.omr_probe_provisioned_teacher_canary_v1(text)') is not null
        and (
            select pg_catalog.count(*) = 7
               and pg_catalog.bool_and(
                   routine.prosecdef
                   and routine.prokind = 'f'
                   and (
                       (routine.proname = 'omr_lookup_teacher_account_v1'
                        and pg_catalog.oidvectortypes(routine.proargtypes) = 'text')
                       or
                       (routine.proname = 'omr_validate_teacher_session_v1'
                        and pg_catalog.oidvectortypes(routine.proargtypes) = 'text, bigint')
                       or
                       (routine.proname = 'omr_begin_teacher_password_reset_v1'
                        and pg_catalog.oidvectortypes(routine.proargtypes) = 'text, text, text, timestamp with time zone')
                       or
                       (routine.proname = 'omr_complete_teacher_password_reset_v1'
                        and pg_catalog.oidvectortypes(routine.proargtypes) = 'text, text')
                       or
                       (routine.proname = 'omr_lookup_provisioned_teacher_login_v1'
                        and pg_catalog.oidvectortypes(routine.proargtypes) = 'text')
                       or
                       (routine.proname = 'omr_validate_provisioned_teacher_session_v1'
                        and pg_catalog.oidvectortypes(routine.proargtypes) = 'text, bigint, text')
                       or
                       (routine.proname = 'omr_probe_provisioned_teacher_canary_v1'
                        and pg_catalog.oidvectortypes(routine.proargtypes) = 'text')
                   )
                   and pg_catalog.pg_get_userbyid(routine.proowner) = 'postgres'
                   and (
                       (routine.proname in (
                           'omr_validate_teacher_session_v1',
                           'omr_begin_teacher_password_reset_v1',
                           'omr_complete_teacher_password_reset_v1'
                        ) and pg_catalog.pg_get_function_result(routine.oid) = 'boolean')
                       or
                       (routine.proname not in (
                           'omr_validate_teacher_session_v1',
                           'omr_begin_teacher_password_reset_v1',
                           'omr_complete_teacher_password_reset_v1'
                        ) and pg_catalog.pg_get_function_result(routine.oid) = 'jsonb')
                   )
                   and (
                       routine.proname <> 'omr_probe_provisioned_teacher_canary_v1'
                       or routine.provolatile = 's'
                   )
                   and routine.proconfig @> array[
                       'search_path=""', 'statement_timeout=5s', 'lock_timeout=2s'
                   ]::text[]
                   and pg_catalog.has_function_privilege('service_role', routine.oid, 'EXECUTE')
                   and not pg_catalog.has_function_privilege('anon', routine.oid, 'EXECUTE')
                   and not pg_catalog.has_function_privilege('authenticated', routine.oid, 'EXECUTE')
               )
              from pg_catalog.pg_proc routine
              join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
             where namespace.nspname = 'public'
               and routine.proname in (
                   'omr_lookup_teacher_account_v1',
                   'omr_validate_teacher_session_v1',
                   'omr_begin_teacher_password_reset_v1',
                   'omr_complete_teacher_password_reset_v1',
                   'omr_lookup_provisioned_teacher_login_v1',
                   'omr_validate_provisioned_teacher_session_v1',
                   'omr_probe_provisioned_teacher_canary_v1'
               )
        )
        and pg_catalog.obj_description(
            'public.omr_lookup_teacher_account_v1(text)'::pg_catalog.regprocedure,
            'pg_proc'
        ) = 'exact legacy self-service teacher account lookup envelope:202608080007'
        and pg_catalog.obj_description(
            'public.omr_validate_teacher_session_v1(text,bigint)'::pg_catalog.regprocedure,
            'pg_proc'
        ) = 'legacy self-service session validation excluding pilot provenance:202608080007'
        and pg_catalog.obj_description(
            'public.omr_begin_teacher_password_reset_v1(text,text,text,timestamptz)'::pg_catalog.regprocedure,
            'pg_proc'
        ) = 'legacy self-service password-reset ingress excluding pilot provenance:202608080007'
        and pg_catalog.obj_description(
            'public.omr_complete_teacher_password_reset_v1(text,text)'::pg_catalog.regprocedure,
            'pg_proc'
        ) = 'legacy self-service password-reset completion excluding pilot provenance:202608080007'
        and pg_catalog.obj_description(
            'public.omr_lookup_provisioned_teacher_login_v1(text)'::pg_catalog.regprocedure,
            'pg_proc'
        ) = 'exact provisioned teacher login binding:202608080007'
        and pg_catalog.obj_description(
            'public.omr_validate_provisioned_teacher_session_v1(text,bigint,text)'::pg_catalog.regprocedure,
            'pg_proc'
        ) = 'request-time provisioned teacher binding and entitlement validation:202608080007'
        and pg_catalog.obj_description(
            'public.omr_probe_provisioned_teacher_canary_v1(text)'::pg_catalog.regprocedure,
            'pg_proc'
        ) = 'side-effect-free exact provisioned teacher release canary:202608080007'
        and pg_catalog.encode(extensions.digest(pg_catalog.pg_get_functiondef(
            'public.omr_lookup_teacher_account_v1(text)'::pg_catalog.regprocedure
        ), 'sha256'), 'hex') = '1516cbbe5f44bddf3c683f90b99721b3f7399d5d1c8a84fa4a5bc71f1f7a5101'
        and pg_catalog.encode(extensions.digest(pg_catalog.pg_get_functiondef(
            'public.omr_validate_teacher_session_v1(text,bigint)'::pg_catalog.regprocedure
        ), 'sha256'), 'hex') = 'bf69cc465b78ca4bfc8fdd9a117320ea056f5d2508666f77ceb9ac3b4079d5a4'
        and pg_catalog.encode(extensions.digest(pg_catalog.pg_get_functiondef(
            'public.omr_begin_teacher_password_reset_v1(text,text,text,timestamptz)'::pg_catalog.regprocedure
        ), 'sha256'), 'hex') = 'e40b1ef3b480d17343722d65768cac963ecce235e9c1c0c848b7ad41a344a3e9'
        and pg_catalog.encode(extensions.digest(pg_catalog.pg_get_functiondef(
            'public.omr_complete_teacher_password_reset_v1(text,text)'::pg_catalog.regprocedure
        ), 'sha256'), 'hex') = 'c0398cd9badc1b495517f39902e7383413f8051e487425cdd1e18880213b64ba'
        and pg_catalog.encode(extensions.digest(pg_catalog.pg_get_functiondef(
            'public.omr_lookup_provisioned_teacher_login_v1(text)'::pg_catalog.regprocedure
        ), 'sha256'), 'hex') = 'aabf7ecf6c20e281b8c19662280f5af0b3f25bf0f874053adc76f77ff0799de9'
        and pg_catalog.encode(extensions.digest(pg_catalog.pg_get_functiondef(
            'public.omr_validate_provisioned_teacher_session_v1(text,bigint,text)'::pg_catalog.regprocedure
        ), 'sha256'), 'hex') = '62b67281c2132c3f80a6a8cf415227ba38a24e0bfffa483be01ce7437b5227c9'
        and pg_catalog.encode(extensions.digest(pg_catalog.pg_get_functiondef(
            'public.omr_probe_provisioned_teacher_canary_v1(text)'::pg_catalog.regprocedure
        ), 'sha256'), 'hex') = '0302d984bd9f280d887ff17d7953f1e3346b36631ed0bc40ef2e55be5a61cb4e';

    v_teacher_live_sessions_ready :=
        pg_catalog.to_regclass('public.omr_attempt_sessions_teacher_live_idx') is not null
        and pg_catalog.to_regprocedure(
            'public.omr_list_active_attempt_sessions_v1(text,text,text,text,integer)'
        ) is not null
        and pg_catalog.to_regprocedure(
            'public.omr_prepare_teacher_force_finish_sessions_v1(text,text[],text,text)'
        ) is not null
        and pg_catalog.to_regprocedure(
            'public.omr_force_finish_attempt_sessions_v1(text,text[],timestamptz,text,text,text,jsonb)'
        ) is not null
        and pg_catalog.to_regprocedure(
            'public.omr_prepare_teacher_force_finish_sessions_compact_v1(text,text[],text,text)'
        ) is not null
        and pg_catalog.to_regprocedure(
            'public.omr_force_finish_attempt_sessions_compact_v1(text,text[],timestamptz,text,text,text,jsonb)'
        ) is not null
        and pg_catalog.to_regprocedure(
            'public.omr_teacher_force_finish_fingerprint_v1(bigint,jsonb,jsonb,integer[],jsonb)'
        ) is not null
        and pg_catalog.obj_description(
            'public.omr_list_active_attempt_sessions_v1(text,text,text,text,integer)'::pg_catalog.regprocedure,
            'pg_proc'
        ) = 'teacher-live-session-projection:202608060020'
        and pg_catalog.obj_description(
            'public.omr_prepare_teacher_force_finish_sessions_v1(text,text[],text,text)'::pg_catalog.regprocedure,
            'pg_proc'
        ) = 'teacher-live-session-force-finish-prepare:202608060023'
        and pg_catalog.obj_description(
            'public.omr_force_finish_attempt_sessions_v1(text,text[],timestamptz,text,text,text,jsonb)'::pg_catalog.regprocedure,
            'pg_proc'
        ) = 'teacher-live-session-force-finish:202608060023'
        and pg_catalog.obj_description(
            'public.omr_prepare_teacher_force_finish_sessions_compact_v1(text,text[],text,text)'::pg_catalog.regprocedure,
            'pg_proc'
        ) = 'teacher-live-session-force-finish-compact-prepare:202608060024'
        and pg_catalog.obj_description(
            'public.omr_force_finish_attempt_sessions_compact_v1(text,text[],timestamptz,text,text,text,jsonb)'::pg_catalog.regprocedure,
            'pg_proc'
        ) = 'teacher-live-session-force-finish-compact:202608060024'
        and pg_catalog.has_function_privilege(
            'service_role',
            'public.omr_list_active_attempt_sessions_v1(text,text,text,text,integer)',
            'EXECUTE'
        )
        and pg_catalog.has_function_privilege(
            'service_role',
            'public.omr_prepare_teacher_force_finish_sessions_v1(text,text[],text,text)',
            'EXECUTE'
        )
        and pg_catalog.has_function_privilege(
            'service_role',
            'public.omr_force_finish_attempt_sessions_v1(text,text[],timestamptz,text,text,text,jsonb)',
            'EXECUTE'
        )
        and pg_catalog.has_function_privilege(
            'service_role',
            'public.omr_prepare_teacher_force_finish_sessions_compact_v1(text,text[],text,text)',
            'EXECUTE'
        )
        and pg_catalog.has_function_privilege(
            'service_role',
            'public.omr_force_finish_attempt_sessions_compact_v1(text,text[],timestamptz,text,text,text,jsonb)',
            'EXECUTE'
        )
        and not exists (
            select 1
              from pg_catalog.pg_proc routine
              join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
             where namespace.nspname = 'public'
               and routine.proname in (
                   'omr_list_active_attempt_sessions_v1',
                   'omr_prepare_teacher_force_finish_sessions_v1',
                   'omr_force_finish_attempt_sessions_v1',
                   'omr_prepare_teacher_force_finish_sessions_compact_v1',
                   'omr_force_finish_attempt_sessions_compact_v1',
                   'omr_teacher_force_finish_fingerprint_v1'
               )
               and (
                   pg_catalog.has_function_privilege('anon', routine.oid, 'EXECUTE')
                   or pg_catalog.has_function_privilege('authenticated', routine.oid, 'EXECUTE')
               )
        )
        and position(
            'grading_snapshot' in lower(pg_catalog.pg_get_function_result(
                'public.omr_list_active_attempt_sessions_v1(text,text,text,text,integer)'::pg_catalog.regprocedure
            ))
        ) = 0
        and position(
            'expected_fingerprint' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_force_finish_attempt_sessions_v1(text,text[],timestamptz,text,text,text,jsonb)'::pg_catalog.regprocedure
            ))
        ) > 0
        and position(
            'with gradings as materialized' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_force_finish_attempt_sessions_v1(text,text[],timestamptz,text,text,text,jsonb)'::pg_catalog.regprocedure
            ))
        ) > 0
        and position(
            'with ordinality' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_force_finish_attempt_sessions_v1(text,text[],timestamptz,text,text,text,jsonb)'::pg_catalog.regprocedure
            ))
        ) > 0
        and not pg_catalog.has_function_privilege(
            'service_role',
            'public.omr_teacher_force_finish_fingerprint_v1(bigint,jsonb,jsonb,integer[],jsonb)',
            'EXECUTE'
        )
        and position(
            'expected_grading_snapshot' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_force_finish_attempt_sessions_v1(text,text[],timestamptz,text,text,text,jsonb)'::pg_catalog.regprocedure
            ))
        ) > 0
        and position(
            'for update' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_force_finish_attempt_sessions_v1(text,text[],timestamptz,text,text,text,jsonb)'::pg_catalog.regprocedure
            ))
        ) > 0
        and position(
            'p_expectations' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_force_finish_attempt_sessions_compact_v1(text,text[],timestamptz,text,text,text,jsonb)'::pg_catalog.regprocedure
            ))
        ) > 0
        and position(
            'with canonical_questions as materialized' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_force_finish_attempt_sessions_compact_v1(text,text[],timestamptz,text,text,text,jsonb)'::pg_catalog.regprocedure
            ))
        ) > 0
        and position(
            'omr_submit_session_attempt_v1' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_force_finish_attempt_sessions_compact_v1(text,text[],timestamptz,text,text,text,jsonb)'::pg_catalog.regprocedure
            ))
        ) > 0;

    v_teacher_account_lifecycle_ready :=
        pg_catalog.to_regclass('public.omr_teacher_accounts') is not null
        and pg_catalog.to_regclass('public.omr_teacher_account_tokens') is not null
        and exists (
            select 1
              from pg_catalog.pg_class relation
             where relation.oid = 'public.omr_teacher_accounts'::pg_catalog.regclass
               and relation.relrowsecurity and relation.relforcerowsecurity
        )
        and exists (
            select 1
              from pg_catalog.pg_class relation
             where relation.oid = 'public.omr_teacher_account_tokens'::pg_catalog.regclass
               and relation.relrowsecurity and relation.relforcerowsecurity
        )
        and not pg_catalog.has_table_privilege(
            'service_role', 'public.omr_teacher_accounts',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
        )
        and not pg_catalog.has_table_privilege(
            'service_role', 'public.omr_teacher_account_tokens',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
        )
        and not pg_catalog.has_table_privilege(
            'anon', 'public.omr_teacher_accounts', 'SELECT,INSERT,UPDATE,DELETE'
        )
        and not pg_catalog.has_table_privilege(
            'authenticated', 'public.omr_teacher_accounts', 'SELECT,INSERT,UPDATE,DELETE'
        )
        and not pg_catalog.has_table_privilege(
            'anon', 'public.omr_teacher_account_tokens', 'SELECT,INSERT,UPDATE,DELETE'
        )
        and not pg_catalog.has_table_privilege(
            'authenticated', 'public.omr_teacher_account_tokens', 'SELECT,INSERT,UPDATE,DELETE'
        )
        and (
            select count(*) = 6
              from pg_catalog.pg_proc routine
              join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
             where namespace.nspname = 'public'
               and routine.proname in (
                   'omr_begin_teacher_signup_v1',
                   'omr_begin_teacher_password_reset_v1',
                   'omr_complete_teacher_password_reset_v1',
                   'omr_verify_teacher_email_v1',
                   'omr_lookup_teacher_account_v1',
                   'omr_validate_teacher_session_v1'
               )
               and pg_catalog.has_function_privilege('service_role', routine.oid, 'EXECUTE')
               and not pg_catalog.has_function_privilege('anon', routine.oid, 'EXECUTE')
               and not pg_catalog.has_function_privilege('authenticated', routine.oid, 'EXECUTE')
        )
        and position(
            'for update skip locked' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_complete_teacher_password_reset_v1(text,text)'::pg_catalog.regprocedure
            ))
        ) > 0
        and position(
            'for update skip locked' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_verify_teacher_email_v1(text)'::pg_catalog.regprocedure
            ))
        ) > 0
        and exists (
            select 1
              from pg_catalog.pg_attribute attribute
             where attribute.attrelid = 'public.omr_teacher_accounts'::pg_catalog.regclass
               and attribute.attname = 'session_generation'
               and attribute.attnotnull
               and not attribute.attisdropped
        )
        and exists (
            select 1
              from pg_catalog.pg_constraint constraint_row
             where constraint_row.conrelid = 'public.omr_teacher_accounts'::pg_catalog.regclass
               and constraint_row.conname = 'omr_teacher_accounts_session_generation_check'
               and constraint_row.contype = 'c'
               and constraint_row.convalidated
        )
        and exists (
            select 1
              from pg_catalog.pg_trigger trigger_row
             where trigger_row.tgrelid = 'public.omr_teacher_accounts'::pg_catalog.regclass
               and trigger_row.tgname = 'omr_teacher_accounts_advance_session_on_disable'
               and not trigger_row.tgisinternal
               and trigger_row.tgenabled <> 'D'
        )
        and position(
            'session_generation = account.session_generation + 1' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_complete_teacher_password_reset_v1(text,text)'::pg_catalog.regprocedure
            ))
        ) > 0
        and position(
            'account.session_generation = p_session_generation' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_validate_teacher_session_v1(text,bigint)'::pg_catalog.regprocedure
            ))
        ) > 0
        and not pg_catalog.has_function_privilege(
            'service_role',
            'public.omr_advance_teacher_session_on_disable_v1()',
            'EXECUTE'
        );

    v_initial_operations_load_control_ready :=
        pg_catalog.to_regclass('public.omr_initial_ops_metrics') is not null
        and exists (
            select 1
              from pg_catalog.pg_class relation
             where relation.oid = 'public.omr_initial_ops_metrics'::pg_catalog.regclass
               and relation.relrowsecurity and relation.relforcerowsecurity
        )
        and not pg_catalog.has_table_privilege(
            'service_role', 'public.omr_initial_ops_metrics',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
        )
        and pg_catalog.to_regprocedure(
            'public.omr_initial_ops_fixture_v1(text,text,text,text,text)'
        ) is not null
        and pg_catalog.to_regprocedure(
            'public.omr_initial_ops_database_snapshot_v1(text,text,text,text,text)'
        ) is not null
        and pg_catalog.obj_description(
            'public.omr_initial_ops_fixture_v1(text,text,text,text,text)'::pg_catalog.regprocedure,
            'pg_proc'
        ) = 'initial-operations-phase-c-identity-and-production-coverage:202608080008'
        and pg_catalog.obj_description(
            'public.omr_initial_ops_database_snapshot_v1(text,text,text,text,text)'::pg_catalog.regprocedure,
            'pg_proc'
        ) = 'initial-operations-phase-c-identity-and-production-coverage:202608080008'
        and pg_catalog.has_function_privilege(
            'service_role', 'public.omr_initial_ops_fixture_v1(text,text,text,text,text)', 'EXECUTE'
        )
        and pg_catalog.has_function_privilege(
            'service_role', 'public.omr_initial_ops_database_snapshot_v1(text,text,text,text,text)', 'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
            'service_role', 'public.omr_initial_ops_reserve_upload_v1(text,text,text,text,text,text,bigint)', 'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
            'service_role', 'public.omr_initial_ops_operation_v1(text,text,text,text,text,text,jsonb)', 'EXECUTE'
        )
        and not exists (
            select 1
              from pg_catalog.pg_proc routine
              join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
             where namespace.nspname = 'public'
               and routine.proname in (
                   'omr_initial_ops_fixture_v1',
                   'omr_initial_ops_reserve_upload_v1',
                   'omr_initial_ops_operation_v1',
                   'omr_initial_ops_database_snapshot_v1'
               )
               and (
                   pg_catalog.has_function_privilege('anon', routine.oid, 'EXECUTE')
                   or pg_catalog.has_function_privilege('authenticated', routine.oid, 'EXECUTE')
               )
        )
        and position(
            'productionworkloadpaths' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_initial_ops_database_snapshot_v1(text,text,text,text,text)'::pg_catalog.regprocedure
            ))
        ) > 0
        and position(
            'omr_open_attempt_session_v3' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_initial_ops_database_snapshot_v1(text,text,text,text,text)'::pg_catalog.regprocedure
            ))
        ) > 0
        and position(
            'omr_finalize_teacher_asset_upload_v2' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_initial_ops_database_snapshot_v1(text,text,text,text,text)'::pg_catalog.regprocedure
            ))
        ) > 0
        and position(
            'query ilike ''%omr_initial_ops_%''' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_initial_ops_database_snapshot_v1(text,text,text,text,text)'::pg_catalog.regprocedure
            ))
        ) = 0
        and position(
            'finalize_cleanup' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_initial_ops_fixture_v1(text,text,text,text,text)'::pg_catalog.regprocedure
            ))
        ) > 0
        and position(
            '''teacheridentity''' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_initial_ops_fixture_v1(text,text,text,text,text)'::pg_catalog.regprocedure
            ))
        ) > 0
        and not pg_catalog.has_function_privilege(
            'service_role',
            'public.omr_initial_ops_fixture_v26_snapshot(text,text,text,text,text)',
            'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
            'service_role',
            'public.omr_initial_ops_database_snapshot_v26_snapshot(text,text,text,text,text)',
            'EXECUTE'
        )
        and (
            select pg_catalog.count(*) = 4
               and encode(extensions.digest(
                    'phase-c-initial-ops-identity-and-v2-paths:202608080008'
                    || pg_catalog.chr(10)
                    || pg_catalog.string_agg(
                        routine.proname || pg_catalog.chr(31)
                        || pg_catalog.pg_get_function_identity_arguments(routine.oid)
                        || pg_catalog.chr(31)
                        || pg_catalog.pg_get_function_result(routine.oid)
                        || pg_catalog.chr(31)
                        || pg_catalog.pg_get_userbyid(routine.proowner)
                        || pg_catalog.chr(31) || routine.prosecdef::text
                        || pg_catalog.chr(31) || routine.provolatile::text
                        || pg_catalog.chr(31)
                        || coalesce(pg_catalog.array_to_string(routine.proconfig, pg_catalog.chr(30)), '')
                        || pg_catalog.chr(31)
                        || coalesce(pg_catalog.obj_description(routine.oid, 'pg_proc'), '')
                        || pg_catalog.chr(31)
                        || pg_catalog.pg_get_functiondef(routine.oid),
                        pg_catalog.chr(10) order by routine.proname
                    ),
                    'sha256'
                ), 'hex') = 'ac8aef94e7e0edd577a4077c4727f44e8af4db6c421796bed385fcc9d48ff576'
              from pg_catalog.pg_proc routine
              join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
             where namespace.nspname = 'public'
               and routine.proname in (
                   'omr_initial_ops_fixture_v1',
                   'omr_initial_ops_database_snapshot_v1',
                   'omr_initial_ops_fixture_v26_snapshot',
                   'omr_initial_ops_database_snapshot_v26_snapshot'
               )
        );

    v_roster_snapshot_cas_ready :=
        pg_catalog.to_regprocedure('public.omr_load_roster_v2(text)') is not null
        and pg_catalog.to_regprocedure(
            'public.omr_save_roster_v3(text,text,bigint,text,text,jsonb,jsonb,jsonb,jsonb,bigint)'
        ) is not null
        and coalesce(pg_catalog.has_function_privilege(
            'service_role',
            pg_catalog.to_regprocedure('public.omr_load_roster_v2(text)'),
            'EXECUTE'
        ), false)
        and coalesce(pg_catalog.has_function_privilege(
            'service_role',
            pg_catalog.to_regprocedure(
                'public.omr_save_roster_v3(text,text,bigint,text,text,jsonb,jsonb,jsonb,jsonb,bigint)'
            ),
            'EXECUTE'
        ), false)
        and not pg_catalog.has_function_privilege('service_role', 'public.omr_save_roster_v1(text,jsonb,jsonb,jsonb,jsonb)', 'EXECUTE')
        and not coalesce(pg_catalog.has_function_privilege(
            'anon', pg_catalog.to_regprocedure('public.omr_load_roster_v2(text)'), 'EXECUTE'
        ), false)
        and not coalesce(pg_catalog.has_function_privilege(
            'authenticated', pg_catalog.to_regprocedure('public.omr_load_roster_v2(text)'), 'EXECUTE'
        ), false)
        and not coalesce(pg_catalog.has_function_privilege(
            'anon',
            pg_catalog.to_regprocedure(
                'public.omr_save_roster_v3(text,text,bigint,text,text,jsonb,jsonb,jsonb,jsonb,bigint)'
            ),
            'EXECUTE'
        ), false)
        and not coalesce(pg_catalog.has_function_privilege(
            'authenticated',
            pg_catalog.to_regprocedure(
                'public.omr_save_roster_v3(text,text,bigint,text,text,jsonb,jsonb,jsonb,jsonb,bigint)'
            ),
            'EXECUTE'
        ), false);

    select count(*) = 4
       and coalesce(bool_and(
            pg_catalog.obj_description(routine.oid, 'pg_proc') = 'attempt-mutation-null-cas:202608060018'
            and position('p_expected_lease_epoch is null' in lower(pg_catalog.pg_get_functiondef(routine.oid))) > 0
            and position('9007199254740991' in lower(pg_catalog.pg_get_functiondef(routine.oid))) > 0
            and position('nullif(pg_catalog.btrim(' in lower(pg_catalog.pg_get_functiondef(routine.oid))) > 0
            and position('v_session.lease_epoch is distinct from p_expected_lease_epoch' in lower(pg_catalog.pg_get_functiondef(routine.oid))) > 0
            and position('p_expected_lease_epoch is null' in lower(pg_catalog.pg_get_functiondef(routine.oid)))
                < position('for update;' in lower(pg_catalog.pg_get_functiondef(routine.oid)))
        ), false)
      into v_attempt_mutation_cas_ready
      from pg_catalog.pg_proc routine
      join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
     where namespace.nspname = 'public'
       and routine.proname in (
           'omr_heartbeat_attempt_session_v1',
           'omr_takeover_attempt_session_v1',
           'omr_prepare_attempt_session_submit_v1',
           'omr_commit_attempt_session_submit_v1'
       );
    v_attempt_mutation_cas_ready := v_attempt_mutation_cas_ready
        and not exists (
            select 1
              from pg_catalog.pg_proc routine
              join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
             where namespace.nspname = 'public'
               and routine.proname in (
                   'omr_takeover_attempt_session_v1',
                   'omr_prepare_attempt_session_submit_v1',
                   'omr_commit_attempt_session_submit_v1'
               )
               and (
                   position('p_expected_revision is null' in lower(pg_catalog.pg_get_functiondef(routine.oid))) = 0
                   or position('v_session.revision is distinct from p_expected_revision' in lower(pg_catalog.pg_get_functiondef(routine.oid))) = 0
                   or position('p_expected_revision is null' in lower(pg_catalog.pg_get_functiondef(routine.oid)))
                        > position('for update;' in lower(pg_catalog.pg_get_functiondef(routine.oid)))
               )
        );

    v_exam_delete_session_safe :=
        pg_catalog.obj_description(
            'public.omr_delete_exam_v1(text,text)'::pg_catalog.regprocedure,
            'pg_proc'
        ) = 'exam-delete-session-safe:202608060018'
        and position(
            'perform public.omr_enqueue_exam_asset_cleanup_v1' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_delete_exam_v1(text,text)'::pg_catalog.regprocedure
            ))
        ) < position(
            'delete from public.omr_attempt_sessions' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_delete_exam_v1(text,text)'::pg_catalog.regprocedure
            ))
        )
        and position(
            'delete from public.omr_attempt_sessions' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_delete_exam_v1(text,text)'::pg_catalog.regprocedure
            ))
        ) < position(
            'delete from public.omr_attempts' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_delete_exam_v1(text,text)'::pg_catalog.regprocedure
            ))
        );

    v_student_question_atomic_ready :=
        pg_catalog.to_regprocedure(
            'public.omr_upsert_student_attempt_question_v1(text,text,text,bigint,text,text)'
        ) is not null
        and pg_catalog.obj_description(
            'public.omr_upsert_student_attempt_question_v1(text,text,text,bigint,text,text)'::pg_catalog.regprocedure,
            'pg_proc'
        ) = 'student-question-atomic:202608060019'
        and pg_catalog.has_function_privilege(
            'service_role',
            'public.omr_upsert_student_attempt_question_v1(text,text,text,bigint,text,text)',
            'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
            'anon',
            'public.omr_upsert_student_attempt_question_v1(text,text,text,bigint,text,text)',
            'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
            'authenticated',
            'public.omr_upsert_student_attempt_question_v1(text,text,text,bigint,text,text)',
            'EXECUTE'
        )
        and position(
            'for update;' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_upsert_student_attempt_question_v1(text,text,text,bigint,text,text)'::pg_catalog.regprocedure
            ))
        ) > 0
        and position(
            'jsonb_set(' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_upsert_student_attempt_question_v1(text,text,text,bigint,text,text)'::pg_catalog.regprocedure
            ))
        ) > 0;

    v_individual_student_assignments_ready :=
        pg_catalog.to_regclass('public.omr_assignments_targeted_exam_idx') is not null
        and pg_catalog.to_regclass('public.omr_assignment_targets_active_student_idx') is not null
        and pg_catalog.to_regclass('public.omr_assignment_targets_retake_source_idx') is not null
        and pg_catalog.to_regclass('public.omr_attempts_student_exam_base_completed_idx') is not null
        and pg_catalog.to_regprocedure(
            'public.omr_assign_students_v2(text,text,bigint,text,text,text,text,text[],text,bigint,text)'
        ) is not null
        and pg_catalog.to_regprocedure(
            'public.omr_clear_student_assignment_v2(text,text,bigint,text,text,text,text,bigint,text,text[],text)'
        ) is not null
        and pg_catalog.to_regprocedure(
            'public.omr_load_teacher_student_assignment_v1(text,text,text,text)'
        ) is not null
        and pg_catalog.to_regprocedure(
            'public.omr_list_student_assignments_v1(text,text,text,text,text)'
        ) is not null
        and pg_catalog.to_regprocedure(
            'public.omr_resolve_student_assignment_v1(text,text,text,text,text,text,text)'
        ) is not null
        and not exists (
            select 1
              from pg_catalog.pg_proc routine
              join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
             where namespace.nspname = 'public'
               and routine.proname in (
                   'omr_assign_students_v2',
                   'omr_clear_student_assignment_v2',
                   'omr_load_teacher_student_assignment_v1',
                   'omr_list_student_assignments_v1',
                   'omr_resolve_student_assignment_v1'
               )
               and (
                   not pg_catalog.has_function_privilege('service_role', routine.oid, 'EXECUTE')
                   or pg_catalog.has_function_privilege('anon', routine.oid, 'EXECUTE')
                   or pg_catalog.has_function_privilege('authenticated', routine.oid, 'EXECUTE')
               )
        )
        and exists (
            select 1 from pg_catalog.pg_trigger trigger_row
             where trigger_row.tgrelid = 'public.omr_attempt_sessions'::pg_catalog.regclass
               and trigger_row.tgname = 'omr_attempt_session_target_guard'
               and trigger_row.tgenabled <> 'D'
               and not trigger_row.tgisinternal
        )
        and exists (
            select 1 from pg_catalog.pg_trigger trigger_row
             where trigger_row.tgrelid = 'public.omr_attempts'::pg_catalog.regclass
               and trigger_row.tgname = 'omr_attempt_target_guard'
               and trigger_row.tgenabled <> 'D'
               and not trigger_row.tgisinternal
        )
        and exists (
            select 1 from pg_catalog.pg_trigger trigger_row
             where trigger_row.tgrelid = 'public.omr_exams'::pg_catalog.regclass
               and trigger_row.tgname = 'omr_exam_targeted_access_guard'
               and trigger_row.tgenabled <> 'D'
               and not trigger_row.tgisinternal
        )
        and not exists (
            select 1
              from pg_catalog.unnest(array[
                  'public.omr_assert_targeted_assignment_scope_v1(text,text,text,text,text,text,integer[])',
                  'public.omr_validate_targeted_attempt_session_v1()',
                  'public.omr_validate_targeted_attempt_v1()',
                  'public.omr_guard_targeted_exam_access_v1()'
              ]) as private_helper(signature)
             where pg_catalog.to_regprocedure(private_helper.signature) is null
                or coalesce(pg_catalog.has_function_privilege(
                    'service_role',
                    pg_catalog.to_regprocedure(private_helper.signature),
                    'EXECUTE'
                ), false)
                or coalesce(pg_catalog.has_function_privilege(
                    'anon',
                    pg_catalog.to_regprocedure(private_helper.signature),
                    'EXECUTE'
                ), false)
                or coalesce(pg_catalog.has_function_privilege(
                    'authenticated',
                    pg_catalog.to_regprocedure(private_helper.signature),
                    'EXECUTE'
                ), false)
        );

    v_teacher_attempt_reporting_ready :=
        pg_catalog.to_regclass('public.omr_attempts_org_completed_finished_desc_idx') is not null
        and pg_catalog.to_regclass('public.omr_attempts_org_exam_completed_finished_desc_idx') is not null
        and pg_catalog.to_regprocedure(
            'public.omr_teacher_attempt_aggregate_v1(text,text,timestamptz,timestamptz)'
        ) is not null
        and pg_catalog.to_regprocedure(
            'public.omr_teacher_attempt_export_page_v1(text,text,timestamptz,timestamptz,text,integer)'
        ) is not null
        and pg_catalog.to_regprocedure(
            'public.omr_teacher_attempt_export_v1(text,text,integer)'
        ) is not null
        and not exists (
            select 1
              from pg_catalog.pg_proc routine
              join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
             where namespace.nspname = 'public'
               and routine.proname in (
                   'omr_teacher_attempt_aggregate_v1',
                   'omr_teacher_attempt_export_v1',
                   'omr_teacher_attempt_export_page_v1'
               )
               and (
                   not pg_catalog.has_function_privilege('service_role', routine.oid, 'EXECUTE')
                   or pg_catalog.has_function_privilege('anon', routine.oid, 'EXECUTE')
                   or pg_catalog.has_function_privilege('authenticated', routine.oid, 'EXECUTE')
               )
        )
        and position(
            '(attempt.finished_at, attempt.id) <' in pg_catalog.pg_get_functiondef(
                'public.omr_teacher_attempt_export_page_v1(text,text,timestamptz,timestamptz,text,integer)'::pg_catalog.regprocedure
            )
        ) > 0
        and position(
            'p_limit > 500' in pg_catalog.pg_get_functiondef(
                'public.omr_teacher_attempt_export_page_v1(text,text,timestamptz,timestamptz,text,integer)'::pg_catalog.regprocedure
            )
        ) > 0
        and position(
            'limit p_limit + 1' in pg_catalog.pg_get_functiondef(
                'public.omr_teacher_attempt_export_v1(text,text,integer)'::pg_catalog.regprocedure
            )
        ) > 0
        and position(
            'jsonb_agg' in pg_catalog.pg_get_functiondef(
                'public.omr_teacher_attempt_export_v1(text,text,integer)'::pg_catalog.regprocedure
            )
        ) > 0;

    with expected(name, args, result, exposure) as (values
        ('omr_save_roster_v3', 'text, text, bigint, text, text, jsonb, jsonb, jsonb, jsonb, bigint', 'jsonb', 'public'),
        ('omr_save_exam_v3', 'text, text, bigint, text, jsonb, jsonb, jsonb, bigint, text', 'jsonb', 'public'),
        ('omr_save_feedback_v4', 'text, text, bigint, text, text, jsonb, bigint, text', 'jsonb', 'public'),
        ('omr_return_feedback_v4', 'text, text, bigint, text, text, text, bigint, text', 'jsonb', 'public'),
        ('omr_assign_students_v2', 'text, text, bigint, text, text, text, text, text[], text, bigint, text', 'jsonb', 'public'),
        ('omr_clear_student_assignment_v2', 'text, text, bigint, text, text, text, text, bigint, text, text[], text', 'jsonb', 'public'),
        ('omr_open_attempt_session_v3', 'text, text, text, text, bigint, text, text, text, text, text, text, text, integer[], integer[], timestamp with time zone, jsonb, integer, timestamp with time zone, text, text, integer', 'jsonb', 'public'),
        ('omr_prepare_teacher_asset_upload_v2', 'text, text, bigint, text, text, jsonb', 'jsonb', 'public'),
        ('omr_authorize_teacher_asset_finalize_v2', 'text, text, bigint, text, text, text, jsonb', 'jsonb', 'public'),
        ('omr_finalize_teacher_asset_upload_v2', 'text, text, bigint, text, text, text, jsonb', 'jsonb', 'public'),
        ('omr_prepare_attempt_handwriting_asset_v2', 'text, text, text, jsonb', 'jsonb', 'public'),
        ('omr_attach_attempt_handwriting_v2', 'text, text, text, text, text', 'jsonb', 'public'),
        ('omr_claim_remote_asset_cleanup_v1', 'text, integer, integer', 'jsonb', 'public'),
        ('omr_reserve_plan_usage_v2', 'text, text, bigint, text, text, text, text', 'jsonb', 'public'),
        ('omr_release_plan_usage_v2', 'text, text, bigint, text, text, text, text', 'jsonb', 'public'),
        ('omr_sync_student_plan_usage_v2', 'text, text, bigint, text, text', 'jsonb', 'public'),
        ('omr_lock_provisioned_teacher_identity_v1', 'text, bigint, text', 'jsonb', 'private'),
        ('omr_authorize_effective_teacher_plan_v1', 'text, text', 'jsonb', 'private'),
        ('omr_read_effective_organization_plan_v1', 'text', 'jsonb', 'private'),
        ('omr_set_effective_plan_transaction_proof_v1', 'text, jsonb', 'void', 'private'),
        ('omr_prove_effective_organization_plan_v1', 'text', 'jsonb', 'private'),
        ('omr_assert_effective_plan_transaction_proof_v1', 'text, boolean', 'void', 'private'),
        ('omr_lock_legacy_teacher_identity_v1', 'text, bigint, text, text', 'jsonb', 'private'),
        ('omr_read_legacy_teacher_plan_v1', 'text, text, text', 'jsonb', 'private'),
        ('omr_lock_teacher_mutation_identity_v1', 'text, text, bigint, text, text', 'jsonb', 'private'),
        ('omr_read_teacher_mutation_plan_v1', 'text, text, text, text', 'jsonb', 'private'),
        ('omr_save_exam_effective_worker_v3', 'text, text, text, text, jsonb, jsonb, jsonb', 'jsonb', 'private'),
        ('omr_save_feedback_effective_worker_v4', 'text, jsonb, bigint, text', 'jsonb', 'private'),
        ('omr_claim_remote_asset_cleanup_v8_snapshot', 'text, integer, integer', 'jsonb', 'private'),
        ('omr_assert_targeted_assignment_scope_v1', 'text, text, text, text, text, text, integer[]', 'void', 'private'),
        ('omr_validate_targeted_attempt_session_v1', '', 'trigger', 'private'),
        ('omr_validate_targeted_attempt_v1', '', 'trigger', 'private'),
        ('omr_guard_targeted_exam_access_v1', '', 'trigger', 'private')
    ), actual(name, args, result, owner_name, security_definer, volatility, config, description, oid, definition) as (
        select routine.proname::text,
               pg_catalog.oidvectortypes(routine.proargtypes),
               pg_catalog.pg_get_function_result(routine.oid),
               owner_role.rolname::text,
               routine.prosecdef,
               routine.provolatile::text,
               routine.proconfig,
               coalesce(pg_catalog.obj_description(routine.oid, 'pg_proc'), ''),
               routine.oid,
               pg_catalog.pg_get_functiondef(routine.oid)
          from pg_catalog.pg_proc routine
          join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
          join pg_catalog.pg_roles owner_role on owner_role.oid = routine.proowner
         where namespace.nspname = 'public'
           and routine.proname in (select expected.name from expected)
    )
    select not exists (select name, args, result from expected except select name, args, result from actual)
       and not exists (select name, args, result from actual except select name, args, result from expected)
       and not exists (
           select 1 from actual join expected using (name, args, result)
            where owner_name <> 'postgres'
               or not security_definer
               or volatility <> 'v'
               or not coalesce(config @> array['search_path=""'], false)
               or not coalesce(config @> array['lock_timeout=2s'], false)
               or not coalesce(config @> array[
                   case when name = 'omr_claim_remote_asset_cleanup_v1'
                             or name = 'omr_claim_remote_asset_cleanup_v8_snapshot'
                        then 'statement_timeout=10s' else 'statement_timeout=5s' end
               ], false)
               or description = ''
               or (exposure = 'public' and not pg_catalog.has_function_privilege('service_role', oid, 'EXECUTE'))
               or (exposure = 'private' and pg_catalog.has_function_privilege('service_role', oid, 'EXECUTE'))
               or pg_catalog.has_function_privilege('anon', oid, 'EXECUTE')
               or pg_catalog.has_function_privilege('authenticated', oid, 'EXECUTE')
       )
       and (
           select pg_catalog.encode(extensions.digest(
               'phase-c-effective-plan-enforcement:202608080008|' || pg_catalog.string_agg(
               name || '|' || args || '|' || result || '|' || owner_name || '|'
                   || security_definer::text || '|' || volatility || '|'
                   || coalesce(pg_catalog.array_to_string(config, ','), '') || '|'
                   || description || '|' || definition,
               E'\n-- phase-c-routine --\n' order by name, args
               ), 'sha256'), 'hex')
             from actual
       ) = 'e7d60f32babc3f278fa673fcb8707e530fab4d42307f853bc271d5371bc17148'
       and not exists (
           select 1 from (values
               ('omr_remote_assets'), ('omr_remote_asset_upload_intents'),
               ('omr_remote_asset_cleanup_queue'), ('omr_plan_usage'),
               ('omr_plan_usage_reservations')
           ) guarded(table_name)
            where not pg_catalog.has_table_privilege(
                    'service_role', 'public.' || guarded.table_name, 'SELECT'
                  )
               or pg_catalog.has_table_privilege(
                    'service_role', 'public.' || guarded.table_name,
                    'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
                  )
       )
       and not pg_catalog.has_sequence_privilege(
           'service_role', 'public.omr_remote_asset_cleanup_queue_id_seq',
           'USAGE,SELECT,UPDATE'
       )
       and pg_catalog.to_regclass('public.omr_remote_assets_handwriting_reservation_expiry_idx') is not null
       and pg_catalog.to_regclass('public.omr_remote_assets_one_handwriting_per_attempt_uidx') is not null
       and position('lock table public.omr_organization_members in share mode' in lower(
           pg_catalog.pg_get_functiondef('public.omr_lock_provisioned_teacher_identity_v1(text,bigint,text)'::pg_catalog.regprocedure)
       )) > 0
       and position('omr_read_teacher_mutation_plan_v1' in lower(
           pg_catalog.pg_get_functiondef('public.omr_save_exam_effective_worker_v3(text,text,text,text,jsonb,jsonb,jsonb)'::pg_catalog.regprocedure)
       )) > 0
       and position('handwriting_reservation_grant_id' in lower(
           pg_catalog.pg_get_functiondef('public.omr_prepare_attempt_handwriting_asset_v2(text,text,text,jsonb)'::pg_catalog.regprocedure)
       )) > 0
       and position('omr_claim_remote_asset_cleanup_v8_snapshot' in lower(
           pg_catalog.pg_get_functiondef('public.omr_claim_remote_asset_cleanup_v1(text,integer,integer)'::pg_catalog.regprocedure)
       )) > 0
      into v_effective_workspace_plan_enforcement_ready;

    v_student_session_generation_ready :=
        pg_catalog.to_regclass('public.omr_student_credential_epochs') is not null
        and exists (
            select 1 from pg_catalog.pg_class relation
             where relation.oid = 'public.omr_student_credential_epochs'::pg_catalog.regclass
               and relation.relrowsecurity and relation.relforcerowsecurity
        )
        and not exists (
            select 1 from (values
                ('omr_student_profiles', 'credential_generation'),
                ('omr_student_start_credentials', 'account_id'),
                ('omr_student_start_credentials', 'credential_generation'),
                ('omr_student_credential_epochs', 'account_id'),
                ('omr_student_credential_epochs', 'credential_generation')
            ) expected(table_name, column_name)
             where not exists (
                 select 1 from pg_catalog.pg_attribute attribute
                  where attribute.attrelid = ('public.' || expected.table_name)::pg_catalog.regclass
                    and attribute.attname = expected.column_name
                    and not attribute.attisdropped
                    and attribute.attnotnull
             )
        )
        and not exists (
            select 1 from (values
                ('omr_student_credential_active_profile_guard', 'omr_student_start_credentials'),
                ('omr_student_profile_credential_revocation', 'omr_student_profiles'),
                ('omr_student_profile_session_revocation_on_delete', 'omr_student_profiles')
                ,('omr_student_profile_generation_guard', 'omr_student_profiles')
            ) expected(trigger_name, table_name)
             where not exists (
                 select 1 from pg_catalog.pg_trigger trigger_row
                  where trigger_row.tgname = expected.trigger_name
                    and trigger_row.tgrelid = ('public.' || expected.table_name)::pg_catalog.regclass
                    and not trigger_row.tgisinternal
                    and trigger_row.tgenabled = 'O'
             )
        )
        and pg_catalog.to_regprocedure(
            'public.omr_validate_student_session_v1(text,text,text,integer)'
        ) is not null
        and pg_catalog.to_regprocedure(
            'public.omr_rotate_student_start_credential_v1(text,text,bigint,text,text,text,text)'
        ) is not null
        and pg_catalog.has_function_privilege(
            'service_role',
            'public.omr_validate_student_session_v1(text,text,text,integer)',
            'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
            'service_role',
            'public.omr_rotate_student_start_credential_v1(text,text,bigint,text,text,text,text)',
            'EXECUTE'
        )
        and not pg_catalog.has_table_privilege(
            'service_role', 'public.omr_student_credential_epochs',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
        )
        and pg_catalog.has_table_privilege(
            'service_role', 'public.omr_student_start_credentials', 'SELECT'
        )
        and not pg_catalog.has_table_privilege(
            'service_role', 'public.omr_student_start_credentials',
            'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
        )
        and not pg_catalog.has_function_privilege(
            'anon', 'public.omr_validate_student_session_v1(text,text,text,integer)', 'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
            'authenticated', 'public.omr_validate_student_session_v1(text,text,text,integer)', 'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
            'anon',
            'public.omr_rotate_student_start_credential_v1(text,text,bigint,text,text,text,text)',
            'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
            'authenticated',
            'public.omr_rotate_student_start_credential_v1(text,text,bigint,text,text,text,text)',
            'EXECUTE'
        );

    v_student_session_generation_ready := v_student_session_generation_ready
        and (
            with expected(name, args, result, volatility, service_callable) as (values
                ('omr_validate_student_session_v1', 'text, text, text, integer', 'boolean', 's', true),
                ('omr_rotate_student_start_credential_v1', 'text, text, bigint, text, text, text, text', 'jsonb', 'v', false),
                ('omr_guard_student_credential_mutation_v1', '', 'trigger', 'v', false),
                ('omr_guard_student_profile_generation_v1', '', 'trigger', 'v', false),
                ('omr_revoke_student_session_on_status_v2', '', 'trigger', 'v', false),
                ('omr_revoke_student_session_on_delete_v2', '', 'trigger', 'v', false)
            ), actual as (
                select routine.proname::text as name,
                       pg_catalog.oidvectortypes(routine.proargtypes) as args,
                       pg_catalog.pg_get_function_result(routine.oid) as result,
                       routine.provolatile::text as volatility,
                       owner_role.rolname::text as owner_name,
                       routine.prosecdef as security_definer,
                       routine.proconfig as config,
                       routine.prokind,
                       routine.oid,
                       coalesce(pg_catalog.obj_description(routine.oid, 'pg_proc'), '') as description,
                       pg_catalog.pg_get_functiondef(routine.oid) as definition
                  from pg_catalog.pg_proc routine
                  join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
                  join pg_catalog.pg_roles owner_role on owner_role.oid = routine.proowner
                 where namespace.nspname = 'public'
                   and routine.proname in (select expected.name from expected)
            )
            select not exists (
                       select name, args, result, volatility from expected
                       except select name, args, result, volatility from actual
                   )
               and not exists (
                       select name, args, result, volatility from actual
                       except select name, args, result, volatility from expected
                   )
               and not exists (
                   select 1 from actual join expected using (name, args, result, volatility)
                    where actual.prokind <> 'f'
                       or actual.owner_name <> 'postgres'
                       or not actual.security_definer
                       or not coalesce(actual.config @> array['search_path=""'], false)
                       or not coalesce(actual.config @> array['statement_timeout=5s'], false)
                       or not coalesce(actual.config @> array['lock_timeout=2s'], false)
                       or actual.description = ''
                       or pg_catalog.has_function_privilege('anon', actual.oid, 'EXECUTE')
                       or pg_catalog.has_function_privilege('authenticated', actual.oid, 'EXECUTE')
                       or pg_catalog.has_function_privilege('service_role', actual.oid, 'EXECUTE')
                            is distinct from expected.service_callable
               )
               and (
                   select pg_catalog.encode(extensions.digest(
                       'student-session-generation-routines:202608080009|'
                       || pg_catalog.string_agg(
                           name || '|' || args || '|' || result || '|' || owner_name || '|'
                               || security_definer::text || '|' || volatility || '|'
                               || coalesce(pg_catalog.array_to_string(config, ','), '') || '|'
                               || description || '|' || definition,
                           E'\n-- task5-routine --\n' order by name, args
                       ), 'sha256'), 'hex'
                   ) from actual
               ) = '94d72f002aefd97ba6eccb13275429027dab16297acdf5be369b1383446d9d4e'
        );
    v_student_session_generation_ready := v_student_session_generation_ready
        and (
            with actual as (
                select trigger_row.tgname::text as trigger_name,
                       relation.relname::text as table_name,
                       routine.proname::text as function_name,
                       trigger_row.tgtype::integer as trigger_type,
                       trigger_row.tgattr::text as trigger_attributes,
                       trigger_row.tgenabled::text as enabled,
                       pg_catalog.pg_get_triggerdef(trigger_row.oid, true) as definition
                  from pg_catalog.pg_trigger trigger_row
                  join pg_catalog.pg_class relation on relation.oid = trigger_row.tgrelid
                  join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
                  join pg_catalog.pg_proc routine on routine.oid = trigger_row.tgfoid
                 where namespace.nspname = 'public'
                   and not trigger_row.tgisinternal
                   and trigger_row.tgname in (
                       'omr_student_credential_active_profile_guard',
                       'omr_student_profile_generation_guard',
                       'omr_student_profile_credential_revocation',
                       'omr_student_profile_session_revocation_on_delete'
                   )
            )
            select pg_catalog.count(*) = 4
               and pg_catalog.encode(extensions.digest(
                       'student-session-generation-triggers:202608080009|'
                       || pg_catalog.string_agg(
                           trigger_name || '|' || table_name || '|' || function_name || '|'
                               || trigger_type::text || '|' || trigger_attributes || '|'
                               || enabled || '|' || definition,
                           E'\n-- task5-trigger --\n' order by trigger_name
                       ), 'sha256'), 'hex'
                   ) = 'a40670f5a70b96c13beae74c6ed073d90e343881f80378a3fc0f80b00411bda0'
              from actual
        );
    v_student_session_generation_ready := v_student_session_generation_ready
        and not exists (
            select 1 from (values
                ('omr_student_profiles_credential_generation_check', 'omr_student_profiles'),
                ('omr_student_start_credentials_account_id_unique', 'omr_student_start_credentials'),
                ('omr_student_start_credentials_account_id_check', 'omr_student_start_credentials'),
                ('omr_student_start_credentials_generation_check', 'omr_student_start_credentials'),
                ('omr_student_credential_epochs_pkey', 'omr_student_credential_epochs'),
                ('omr_student_credential_epochs_account_id_unique', 'omr_student_credential_epochs'),
                ('omr_student_credential_epochs_account_id_check', 'omr_student_credential_epochs'),
                ('omr_student_credential_epochs_generation_check', 'omr_student_credential_epochs'),
                ('omr_student_credential_epochs_updated_check', 'omr_student_credential_epochs')
            ) expected(constraint_name, table_name)
             where not exists (
                 select 1 from pg_catalog.pg_constraint constraint_row
                  where constraint_row.conname = expected.constraint_name
                    and constraint_row.conrelid = ('public.' || expected.table_name)::pg_catalog.regclass
                    and constraint_row.convalidated
             )
        )
        and (
            select pg_catalog.count(*) = 9
               and pg_catalog.encode(extensions.digest(
                   'student-session-generation-constraints:202608080009|'
                   || pg_catalog.string_agg(
                       constraint_row.conname || '|'
                           || pg_catalog.pg_get_constraintdef(constraint_row.oid, true)
                           || '|' || constraint_row.convalidated::text,
                       E'\n-- task5-constraint --\n' order by constraint_row.conname
                   ), 'sha256'), 'hex'
               ) = 'a9c416b4400d68ece9a56ee6a70e73564337905907f800e7c6568cd36286ae5d'
              from pg_catalog.pg_constraint constraint_row
             where constraint_row.conname in (
                 'omr_student_profiles_credential_generation_check',
                 'omr_student_start_credentials_account_id_unique',
                 'omr_student_start_credentials_account_id_check',
                 'omr_student_start_credentials_generation_check',
                 'omr_student_credential_epochs_pkey',
                 'omr_student_credential_epochs_account_id_unique',
                 'omr_student_credential_epochs_account_id_check',
                 'omr_student_credential_epochs_generation_check',
                 'omr_student_credential_epochs_updated_check'
             )
        );
    v_student_session_generation_ready := v_student_session_generation_ready
        and (
            select pg_catalog.count(*) = 3
               and pg_catalog.encode(extensions.digest(
                   'student-session-generation-normalized-indexes:202608080009|'
                   || pg_catalog.string_agg(
                       index_relation.relname || '|' || table_relation.relname || '|'
                           || index_record.indisvalid::text || '|'
                           || index_record.indisready::text || '|'
                           || index_record.indisunique::text || '|'
                           || index_record.indnkeyatts::text || '|'
                           || index_record.indnatts::text || '|'
                           || coalesce((select pg_catalog.string_agg(
                               pg_catalog.pg_get_indexdef(
                                   index_record.indexrelid, ordinal, false
                               ), ',' order by ordinal
                           ) from pg_catalog.generate_series(
                               1, index_record.indnatts
                           ) ordinal), '') || '|'
                           || coalesce(pg_catalog.pg_get_expr(
                               index_record.indpred, index_record.indrelid, false
                           ), ''),
                       E'\n-- task5-normalized-index --\n' order by index_relation.relname
                   ), 'sha256'), 'hex'
               ) = 'f6f207962762adf8fee68ee7371c50a50dc38d9b97eedc140d6c7ad7611e076c'
              from pg_catalog.pg_index index_record
              join pg_catalog.pg_class index_relation
                on index_relation.oid = index_record.indexrelid
              join pg_catalog.pg_class table_relation
                on table_relation.oid = index_record.indrelid
              join pg_catalog.pg_namespace namespace
                on namespace.oid = index_relation.relnamespace
             where namespace.nspname = 'public'
               and index_relation.relname in (
                   'omr_student_start_credentials_account_id_unique',
                   'omr_student_credential_epochs_pkey',
                   'omr_student_credential_epochs_account_id_unique'
               )
        );
    v_student_session_generation_ready := v_student_session_generation_ready
        and not exists (
            select 1
              from public.omr_student_start_credentials credential
              left join public.omr_student_profiles student
                on student.organization_id = credential.organization_id
               and student.id = credential.student_profile_id
              left join public.omr_student_credential_epochs epoch
                on epoch.organization_id = credential.organization_id
               and epoch.student_profile_id = credential.student_profile_id
             where student.id is null or epoch.account_id is null
                or credential.account_id is distinct from epoch.account_id
                or credential.credential_generation is distinct from epoch.credential_generation
                or credential.credential_generation is distinct from student.credential_generation
        )
        and not exists (
            select 1
              from public.omr_student_profiles student
              join public.omr_student_credential_epochs epoch
                on epoch.organization_id = student.organization_id
               and epoch.student_profile_id = student.id
             where student.credential_generation is distinct from epoch.credential_generation
        );

    select
        pg_catalog.to_regclass('public.omr_student_credential_batch_receipts') is not null
        and exists (
            select 1
              from pg_catalog.pg_class relation
              join pg_catalog.pg_roles owner_role on owner_role.oid = relation.relowner
             where relation.oid = 'public.omr_student_credential_batch_receipts'::pg_catalog.regclass
               and relation.relrowsecurity
               and relation.relforcerowsecurity
               and owner_role.rolname = 'postgres'
               and coalesce(pg_catalog.obj_description(relation.oid, 'pg_class'), '') =
                   'RPC-only idempotency receipts for atomic student credential batches. Stores hashes and counts only, never raw codes, verifiers, student identifiers, or idempotency keys.'
        )
        and (
            with expected(name, type_name, not_null, default_expression) as (values
                ('organization_id', 'text', true, ''),
                ('idempotency_key_hash', 'text', true, ''),
                ('request_fingerprint', 'text', true, ''),
                ('student_count', 'integer', true, ''),
                ('state', 'text', true, '''pending''::text'),
                ('created_at', 'timestamp with time zone', true, 'clock_timestamp()'),
                ('applied_at', 'timestamp with time zone', false, '')
            ), actual(name, type_name, not_null, default_expression) as (
                select attribute.attname::text,
                       pg_catalog.format_type(attribute.atttypid, attribute.atttypmod),
                       attribute.attnotnull,
                       coalesce(pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid), '')
                  from pg_catalog.pg_attribute attribute
                  left join pg_catalog.pg_attrdef default_row
                    on default_row.adrelid = attribute.attrelid
                   and default_row.adnum = attribute.attnum
                 where attribute.attrelid =
                       'public.omr_student_credential_batch_receipts'::pg_catalog.regclass
                   and attribute.attnum > 0
                   and not attribute.attisdropped
                   and attribute.attgenerated = ''
                   and attribute.attidentity = ''
            )
            select not exists (select * from expected except select * from actual)
               and not exists (select * from actual except select * from expected)
        )
        and not pg_catalog.has_table_privilege(
            'service_role', 'public.omr_student_credential_batch_receipts',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
        )
        and not pg_catalog.has_table_privilege(
            'anon', 'public.omr_student_credential_batch_receipts',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
        )
        and not pg_catalog.has_table_privilege(
            'authenticated', 'public.omr_student_credential_batch_receipts',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
        )
        and pg_catalog.to_regprocedure(
            'public.omr_issue_student_start_code_batch_v1(text,text,bigint,text,text,jsonb,text)'
        ) is not null
        and pg_catalog.has_function_privilege(
            'service_role',
            'public.omr_issue_student_start_code_batch_v1(text,text,bigint,text,text,jsonb,text)',
            'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
            'anon',
            'public.omr_issue_student_start_code_batch_v1(text,text,bigint,text,text,jsonb,text)',
            'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
            'authenticated',
            'public.omr_issue_student_start_code_batch_v1(text,text,bigint,text,text,jsonb,text)',
            'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
            'service_role',
            'public.omr_rotate_student_start_credential_v1(text,text,bigint,text,text,text,text)',
            'EXECUTE'
        )
        and (
            with expected(name) as (values
                ('omr_student_credential_batch_receipts_pkey'),
                ('omr_student_credential_batch_receipts_organization_id_fkey'),
                ('omr_student_credential_batch_receipts_key_hash_check'),
                ('omr_student_credential_batch_receipts_fingerprint_check'),
                ('omr_student_credential_batch_receipts_count_check'),
                ('omr_student_credential_batch_receipts_state_check'),
                ('omr_student_credential_batch_receipts_applied_check')
            ), actual(name) as (
                select constraint_row.conname::text
                  from pg_catalog.pg_constraint constraint_row
                 where constraint_row.conrelid =
                       'public.omr_student_credential_batch_receipts'::pg_catalog.regclass
                   and constraint_row.convalidated
            )
            select not exists (select name from expected except select name from actual)
               and not exists (select name from actual except select name from expected)
        )
        and exists (
            select 1
              from pg_catalog.pg_index index_row
              join pg_catalog.pg_class index_relation on index_relation.oid = index_row.indexrelid
             where index_row.indrelid =
                   'public.omr_student_credential_batch_receipts'::pg_catalog.regclass
               and index_relation.relname = 'omr_student_credential_batch_receipts_pkey'
               and index_row.indisprimary
               and index_row.indisunique
               and index_row.indisvalid
               and index_row.indisready
               and index_row.indnkeyatts = 2
               and pg_catalog.pg_get_indexdef(index_row.indexrelid) =
                   'CREATE UNIQUE INDEX omr_student_credential_batch_receipts_pkey ON public.omr_student_credential_batch_receipts USING btree (organization_id, idempotency_key_hash)'
        )
        and exists (
            select 1
              from pg_catalog.pg_proc routine
              join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
              join pg_catalog.pg_roles owner_role on owner_role.oid = routine.proowner
             where namespace.nspname = 'public'
               and routine.proname = 'omr_issue_student_start_code_batch_v1'
               and pg_catalog.oidvectortypes(routine.proargtypes) =
                   'text, text, bigint, text, text, jsonb, text'
               and pg_catalog.pg_get_function_result(routine.oid) = 'jsonb'
               and routine.prokind = 'f'
               and routine.provolatile = 'v'
               and routine.prosecdef
               and owner_role.rolname = 'postgres'
               and coalesce(routine.proconfig @> array['search_path=""'], false)
               and coalesce(routine.proconfig @> array['statement_timeout=10s'], false)
               and coalesce(routine.proconfig @> array['lock_timeout=2s'], false)
               and coalesce(pg_catalog.obj_description(routine.oid, 'pg_proc'), '') <> ''
        )
        and (
            select pg_catalog.count(*) = 1
              from pg_catalog.pg_proc routine
              join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
             where namespace.nspname = 'public'
               and routine.proname = 'omr_issue_student_start_code_batch_v1'
        )
        and not exists (
            select 1
              from public.omr_student_credential_batch_receipts receipt
             where receipt.state <> 'applied'
                or receipt.applied_at is null
        )
        and (
            select pg_catalog.encode(extensions.digest(
                'student-credential-batch:202608080010|'
                || pg_catalog.pg_get_functiondef(routine.oid)
                || '|'
                || coalesce(pg_catalog.obj_description(routine.oid, 'pg_proc'), '')
                || '|'
                || (
                    select pg_catalog.string_agg(
                        attribute.attname || '|' ||
                        pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) || '|' ||
                        attribute.attnotnull::text || '|' ||
                        coalesce(pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid), '') || '|' ||
                        attribute.attgenerated::text || '|' || attribute.attidentity::text,
                        E'\n-- task6-column --\n' order by attribute.attnum
                    )
                      from pg_catalog.pg_attribute attribute
                      left join pg_catalog.pg_attrdef default_row
                        on default_row.adrelid = attribute.attrelid
                       and default_row.adnum = attribute.attnum
                     where attribute.attrelid =
                           'public.omr_student_credential_batch_receipts'::pg_catalog.regclass
                       and attribute.attnum > 0
                       and not attribute.attisdropped
                )
                || '|'
                || coalesce(pg_catalog.obj_description(
                    'public.omr_student_credential_batch_receipts'::pg_catalog.regclass,
                    'pg_class'
                ), '')
                || '|postgres|'
                || (
                    select pg_catalog.pg_get_indexdef(index_row.indexrelid)
                        || '|' || index_row.indisprimary::text
                        || '|' || index_row.indisunique::text
                        || '|' || index_row.indisvalid::text
                        || '|' || index_row.indisready::text
                        || '|' || index_row.indnkeyatts::text
                      from pg_catalog.pg_index index_row
                      join pg_catalog.pg_class index_relation
                        on index_relation.oid = index_row.indexrelid
                     where index_row.indrelid =
                           'public.omr_student_credential_batch_receipts'::pg_catalog.regclass
                       and index_relation.relname = 'omr_student_credential_batch_receipts_pkey'
                )
                || '|'
                || (
                    select pg_catalog.string_agg(
                        constraint_row.conname || '|' || pg_catalog.pg_get_constraintdef(constraint_row.oid, true),
                        E'\n-- task6-constraint --\n'
                        order by constraint_row.conname
                    )
                      from pg_catalog.pg_constraint constraint_row
                     where constraint_row.conrelid =
                           'public.omr_student_credential_batch_receipts'::pg_catalog.regclass
                ),
                'sha256'
            ), 'hex')
              from pg_catalog.pg_proc routine
              join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
             where namespace.nspname = 'public'
               and routine.proname = 'omr_issue_student_start_code_batch_v1'
               and pg_catalog.oidvectortypes(routine.proargtypes) =
                   'text, text, bigint, text, text, jsonb, text'
        ) = '03347ee80c1a3be2ef93c57a0da64da25e0b8efbb1cc13b7a0a01bccff423009'
      into v_student_credential_batch_ready;

    -- Keep exact catalog drift detection for the two legacy-named public
    -- gateway families exercised by the long-lived readiness probes. The v1
    -- exam signature is a denied compatibility stub, but an extra overload or
    -- a procedure impostor must still fail deployment readiness.
    with expected(name, args) as (values
        ('omr_save_exam_v1', 'jsonb, jsonb, jsonb, text'),
        ('omr_save_remote_asset_metadata_v1', 'jsonb')
    ), actual(name, args) as (
        select routine.proname::text,
               pg_catalog.oidvectortypes(routine.proargtypes)
          from pg_catalog.pg_proc routine
          join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
         where namespace.nspname = 'public'
           and routine.prokind = 'f'
           and routine.proname in (select expected.name from expected)
    )
    select not exists (select name, args from expected except select name, args from actual)
       and not exists (select name, args from actual except select name, args from expected)
      into v_legacy_gateway_catalog_ready;

    v_assignment_generation_scope_ready :=
        pg_catalog.to_regprocedure('public.omr_list_student_assignments_v2(text,text,text,text,text)') is not null
        and pg_catalog.to_regprocedure('public.omr_resolve_student_assignment_v2(text,text,text,text,text,text,bigint,text)') is not null
        and pg_catalog.to_regprocedure('public.omr_open_attempt_session_v3(text,text,text,text,bigint,text,text,text,text,text,text,text,integer[],integer[],timestamptz,jsonb,integer,timestamptz,text,text,integer)') is not null
        and pg_catalog.to_regprocedure('public.omr_checkpoint_attempt_session_v2(text,text,text,text,text,bigint,bigint,bigint,text,jsonb,jsonb,jsonb,integer,boolean)') is not null
        and pg_catalog.to_regprocedure('public.omr_heartbeat_attempt_session_v2(text,text,text,text,text,bigint,bigint,text,integer)') is not null
        and pg_catalog.to_regprocedure('public.omr_takeover_attempt_session_v2(text,text,text,text,text,bigint,bigint,bigint,text,integer)') is not null
        and pg_catalog.to_regprocedure('public.omr_prepare_attempt_session_submit_v2(text,text,text,text,text,bigint,bigint,bigint,text)') is not null
        and pg_catalog.to_regprocedure('public.omr_commit_attempt_session_submit_v2(text,text,text,text,text,bigint,bigint,bigint,text,jsonb,jsonb)') is not null
        and pg_catalog.to_regprocedure('public.omr_list_active_attempt_sessions_v2(text,text,text,text,integer)') is not null
        and pg_catalog.to_regprocedure('public.omr_resolve_legacy_attempt_session_scope_v1(text,text,text)') is not null
        and pg_catalog.to_regprocedure('public.omr_prepare_teacher_force_finish_sessions_compact_v2(text,text[],text,text)') is not null
        and pg_catalog.to_regprocedure('public.omr_force_finish_attempt_sessions_compact_v2(text,text[],timestamptz,text,text,text,jsonb)') is not null
        and not exists (
            select 1 from pg_catalog.unnest(array[
                'public.omr_list_student_assignments_v2(text,text,text,text,text)',
                'public.omr_resolve_student_assignment_v2(text,text,text,text,text,text,bigint,text)',
                'public.omr_open_attempt_session_v3(text,text,text,text,bigint,text,text,text,text,text,text,text,integer[],integer[],timestamptz,jsonb,integer,timestamptz,text,text,integer)',
                'public.omr_checkpoint_attempt_session_v2(text,text,text,text,text,bigint,bigint,bigint,text,jsonb,jsonb,jsonb,integer,boolean)',
                'public.omr_heartbeat_attempt_session_v2(text,text,text,text,text,bigint,bigint,text,integer)',
                'public.omr_takeover_attempt_session_v2(text,text,text,text,text,bigint,bigint,bigint,text,integer)',
                'public.omr_prepare_attempt_session_submit_v2(text,text,text,text,text,bigint,bigint,bigint,text)',
                'public.omr_commit_attempt_session_submit_v2(text,text,text,text,text,bigint,bigint,bigint,text,jsonb,jsonb)',
                'public.omr_list_active_attempt_sessions_v2(text,text,text,text,integer)',
                'public.omr_resolve_legacy_attempt_session_scope_v1(text,text,text)',
                'public.omr_prepare_teacher_force_finish_sessions_compact_v2(text,text[],text,text)',
                'public.omr_force_finish_attempt_sessions_compact_v2(text,text[],timestamptz,text,text,text,jsonb)'
            ]) signature
            where not pg_catalog.has_function_privilege('service_role',pg_catalog.to_regprocedure(signature),'EXECUTE')
               or pg_catalog.has_function_privilege('anon',pg_catalog.to_regprocedure(signature),'EXECUTE')
               or pg_catalog.has_function_privilege('authenticated',pg_catalog.to_regprocedure(signature),'EXECUTE')
        );

    v_canonical_question_result_evidence_ready :=
        pg_catalog.to_regprocedure('public.omr_canonical_question_result_evidence_ready_v1()') is not null
        and public.omr_canonical_question_result_evidence_ready_v1();

    -- Exact Kakao writes are service-role RPCs; direct DML, browser execution,
    -- overloads, legacy ambiguity, or routine marker drift fail readiness.
    v_kakao_reminder_entitlement_ready :=
        pg_catalog.to_regprocedure(
            'public.omr_save_kakao_candidate_review_v1(text,text,bigint,text,text,jsonb)'
        ) is not null
        and pg_catalog.to_regprocedure(
            'public.omr_save_kakao_simulation_dispatch_v1(text,text,bigint,text,text,jsonb)'
        ) is not null
        and pg_catalog.to_regprocedure('public.omr_kakao_reminder_legacy_inventory_v1()') is not null
        and pg_catalog.to_regprocedure('public.omr_quarantine_kakao_reminder_legacy_v1(text)') is not null
        and pg_catalog.to_regprocedure('public.omr_kakao_reminder_entitlement_ready_v1()') is not null
        and public.omr_kakao_reminder_entitlement_ready_v1()
        and (
            select pg_catalog.count(*) = 5
              from pg_catalog.pg_proc routine
              join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
             where namespace.nspname = 'public'
               and routine.proname in (
                   'omr_save_kakao_candidate_review_v1',
                   'omr_save_kakao_simulation_dispatch_v1',
                   'omr_kakao_reminder_legacy_inventory_v1',
                   'omr_quarantine_kakao_reminder_legacy_v1',
                   'omr_kakao_reminder_entitlement_ready_v1'
               )
        )
        and (
            select pg_catalog.count(*) = 2
              from pg_catalog.pg_proc routine
              join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
              join pg_catalog.pg_roles owner_role on owner_role.oid = routine.proowner
             where namespace.nspname = 'public'
               and routine.proname in (
                   'omr_save_kakao_candidate_review_v1',
                   'omr_save_kakao_simulation_dispatch_v1'
               )
               and routine.prokind = 'f'
               and routine.prosecdef
               and owner_role.rolname = 'postgres'
               and (owner_role.rolsuper or owner_role.rolbypassrls)
               and pg_catalog.oidvectortypes(routine.proargtypes) =
                   'text, text, bigint, text, text, jsonb'
               and pg_catalog.obj_description(routine.oid, 'pg_proc') like
                   'kakao-reminder-entitlement:202608100002:%'
        )
        and (
            select pg_catalog.count(*) = 3
              from pg_catalog.pg_proc routine
              join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
              join pg_catalog.pg_roles owner_role on owner_role.oid = routine.proowner
             where namespace.nspname = 'public'
               and routine.proname in (
                   'omr_kakao_reminder_legacy_inventory_v1',
                   'omr_quarantine_kakao_reminder_legacy_v1',
                   'omr_kakao_reminder_entitlement_ready_v1'
               )
               and routine.prokind = 'f'
               and owner_role.rolname = 'postgres'
               and (owner_role.rolsuper or owner_role.rolbypassrls)
               and pg_catalog.obj_description(routine.oid, 'pg_proc') like
                   'kakao-reminder-entitlement:202608100002:%'
        )
        and not pg_catalog.has_table_privilege(
            'service_role', 'public.omr_kakao_candidate_reviews',
            'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
        )
        and not pg_catalog.has_table_privilege(
            'service_role', 'public.omr_kakao_dispatch_logs',
            'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
        )
        and pg_catalog.to_regclass('public.omr_kakao_reminder_legacy_quarantine') is not null
        and exists (
            select 1
              from pg_catalog.pg_class relation
              join pg_catalog.pg_roles owner_role on owner_role.oid = relation.relowner
             where relation.oid = 'public.omr_kakao_reminder_legacy_quarantine'::pg_catalog.regclass
               and relation.relrowsecurity
               and relation.relforcerowsecurity
               and owner_role.rolname = 'postgres'
               and (owner_role.rolsuper or owner_role.rolbypassrls)
        )
        and pg_catalog.has_table_privilege(
            'service_role', 'public.omr_kakao_reminder_legacy_quarantine', 'SELECT'
        )
        and not pg_catalog.has_table_privilege(
            'service_role', 'public.omr_kakao_reminder_legacy_quarantine',
            'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
        )
        and not exists (
            select 1
              from pg_catalog.pg_policy policy
             where policy.polrelid =
                       'public.omr_kakao_reminder_legacy_quarantine'::pg_catalog.regclass
        )
        and pg_catalog.has_function_privilege(
            'service_role',
            'public.omr_save_kakao_candidate_review_v1(text,text,bigint,text,text,jsonb)',
            'EXECUTE'
        )
        and pg_catalog.has_function_privilege(
            'service_role',
            'public.omr_save_kakao_simulation_dispatch_v1(text,text,bigint,text,text,jsonb)',
            'EXECUTE'
        )
        and pg_catalog.has_function_privilege(
            'service_role', 'public.omr_kakao_reminder_legacy_inventory_v1()', 'EXECUTE'
        )
        and pg_catalog.has_function_privilege(
            'service_role', 'public.omr_kakao_reminder_entitlement_ready_v1()', 'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
            'service_role', 'public.omr_quarantine_kakao_reminder_legacy_v1(text)', 'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
            'anon',
            'public.omr_save_kakao_candidate_review_v1(text,text,bigint,text,text,jsonb)',
            'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
            'authenticated',
            'public.omr_save_kakao_simulation_dispatch_v1(text,text,bigint,text,text,jsonb)',
            'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
            'authenticated',
            'public.omr_save_kakao_candidate_review_v1(text,text,bigint,text,text,jsonb)',
            'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
            'anon',
            'public.omr_save_kakao_simulation_dispatch_v1(text,text,bigint,text,text,jsonb)',
            'EXECUTE'
        )
        and not exists (
            select 1
              from pg_catalog.pg_proc routine
              join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
             where namespace.nspname = 'public'
               and routine.proname in (
                   'omr_kakao_reminder_legacy_inventory_v1',
                   'omr_quarantine_kakao_reminder_legacy_v1',
                   'omr_kakao_reminder_entitlement_ready_v1'
               )
               and (
                   pg_catalog.has_function_privilege('anon', routine.oid, 'EXECUTE')
                   or pg_catalog.has_function_privilege('authenticated', routine.oid, 'EXECUTE')
               )
        );

    v_server_gateway_capabilities_ready := v_legacy_gateway_catalog_ready
        and v_assignment_generation_scope_ready
        and v_student_session_generation_ready
        and v_student_credential_batch_ready
        and v_canonical_question_result_evidence_ready
        and v_kakao_reminder_entitlement_ready
        and v_effective_workspace_plan_enforcement_ready
        and v_roster_snapshot_cas_ready
        and v_cleanup_epoch_ready
        and v_attempt_sessions_ready
        and v_durable_rate_limits_ready
        and v_teacher_exam_cas_ready
        and v_teacher_notification_summary_ready
        and v_teacher_notification_state_ready
        and v_feedback_cas_ready
        and v_feedback_replay_hardening_ready
        and v_feedback_core_free_ready
        and v_exam_entry_invites_ready
        and v_workspace_bootstrap_plan_safe
        and v_session_cleanup_optimization_ready
        and v_session_cleanup_fencing_ready
        and v_attempt_checkpoint_null_cas_ready
        and v_attempt_mutation_cas_ready
        and v_exam_delete_session_safe
        and v_student_question_atomic_ready
        and v_teacher_live_sessions_ready
        and v_teacher_account_lifecycle_ready
        and v_provisioned_teacher_login_ready
        and v_student_session_generation_ready
        and v_effective_workspace_plan_enforcement_ready
        and v_initial_operations_load_control_ready
        and v_individual_student_assignments_ready
        and v_teacher_attempt_reporting_ready;

    v_ready := v_canonical_tables_force_rls
        and v_service_role_privileges_ready
        and v_operational_job_status_ready
        and v_operator_pilot_provisioning_ready
        and v_provisioned_teacher_login_ready
        and v_server_gateway_capabilities_ready
        and not exists (
            select 1
              from pg_catalog.jsonb_each(
                  v_previous - 'version' - 'ready' - 'canonicalTablesForceRls'
                  - 'serviceRolePrivilegesReady' - 'serverGatewayCapabilitiesReady'
                  - 'teacherUploadCleanupQueueReady' - 'studentAttemptSessionsReady'
                  - 'rosterSnapshotCasReady' - 'sessionCleanupFencingReady'
                  - 'directUploadIntentLifecycleReady'
                  - 'teacherAssetFinalizePreauthorizationReady'
                  - 'canonicalQuestionResultEvidenceReady'
              ) item
             where item.value is distinct from 'true'::jsonb
        );

    return (v_previous - 'version' - 'ready' - 'canonicalTablesForceRls'
            - 'serviceRolePrivilegesReady' - 'serverGatewayCapabilitiesReady'
            - 'teacherUploadCleanupQueueReady' - 'studentAttemptSessionsReady')
            - 'rosterSnapshotCasReady' - 'sessionCleanupFencingReady'
            - 'directUploadIntentLifecycleReady'
            - 'teacherAssetFinalizePreauthorizationReady'
            - 'canonicalQuestionResultEvidenceReady'
        || pg_catalog.jsonb_build_object(
            'version', '202608090001',
            'canonicalTablesForceRls', v_canonical_tables_force_rls,
            'serviceRolePrivilegesReady', v_service_role_privileges_ready,
            'serverGatewayCapabilitiesReady', v_server_gateway_capabilities_ready,
            'effectiveWorkspacePlanEnforcementReady', v_effective_workspace_plan_enforcement_ready,
            'studentSessionGenerationReady', v_student_session_generation_ready,
            'studentCredentialBatchReady', v_student_credential_batch_ready,
            'canonicalQuestionResultEvidenceReady', v_canonical_question_result_evidence_ready,
            'kakaoReminderEntitlementReady', v_kakao_reminder_entitlement_ready,
            'operationalJobStatusReady', v_operational_job_status_ready,
            'operatorPilotProvisioningReady', v_operator_pilot_provisioning_ready,
            'provisionedTeacherLoginReady', v_provisioned_teacher_login_ready,
            'teacherUploadCleanupQueueReady', v_cleanup_epoch_ready,
            'studentAttemptSessionsReady', v_attempt_sessions_ready,
            'rosterSnapshotCasReady', v_roster_snapshot_cas_ready,
            'sessionCleanupFencingReady', v_effective_workspace_plan_enforcement_ready,
            'directUploadIntentLifecycleReady', v_effective_workspace_plan_enforcement_ready,
            'teacherAssetFinalizePreauthorizationReady', v_effective_workspace_plan_enforcement_ready,
            'durableRateLimitsReady', v_durable_rate_limits_ready,
            'examRevisionReady', v_exam_revision_ready,
            'teacherExamCasReady', v_teacher_exam_cas_ready,
            'teacherNotificationSummaryReady', v_teacher_notification_summary_ready,
            'teacherNotificationStateReady', v_teacher_notification_state_ready,
            'feedbackRevisionReady', v_feedback_revision_ready,
            'feedbackCasReady', v_feedback_cas_ready,
            'workspaceBootstrapPlanSafe', v_workspace_bootstrap_plan_safe,
            'sessionCleanupOptimizationReady', v_session_cleanup_optimization_ready,
            'feedbackReplayHardeningReady', v_feedback_replay_hardening_ready,
            'feedbackCoreFreeReady', v_feedback_core_free_ready,
            'examEntryInvitesReady', v_exam_entry_invites_ready,
            'attemptCheckpointNullCasReady', v_attempt_checkpoint_null_cas_ready,
            'attemptMutationCasReady', v_attempt_mutation_cas_ready,
            'examDeleteSessionSafe', v_exam_delete_session_safe,
            'studentQuestionAtomicReady', v_student_question_atomic_ready,
            'teacherLiveSessionsReady', v_teacher_live_sessions_ready,
            'teacherAccountLifecycleReady', v_teacher_account_lifecycle_ready,
            'initialOperationsLoadControlReady', v_initial_operations_load_control_ready,
            'individualStudentAssignmentsReady', v_individual_student_assignments_ready,
            'teacherAttemptReportingReady', v_teacher_attempt_reporting_ready,
            'ready', v_ready
        );
end;
$$;

revoke all on function public.omr_service_readiness_v1()
    from public, anon, authenticated;
grant execute on function public.omr_service_readiness_v1()
    to service_role;


-- Final Phase C ACL fence. Keep this after every compatibility grant above.
revoke all on table public.omr_student_credential_epochs from public, anon, authenticated, service_role;
revoke all on table public.omr_student_credential_batch_receipts from public, anon, authenticated, service_role;
revoke all on table public.omr_student_start_credentials from service_role;
grant select on table public.omr_student_start_credentials to service_role;
revoke all on table public.omr_kakao_candidate_reviews from public, anon, authenticated, service_role;
revoke all on table public.omr_kakao_dispatch_logs from public, anon, authenticated, service_role;
revoke all on table public.omr_kakao_reminder_legacy_quarantine from public, anon, authenticated, service_role;
grant select on table public.omr_kakao_candidate_reviews to service_role;
grant select on table public.omr_kakao_dispatch_logs to service_role;
grant select on table public.omr_kakao_reminder_legacy_quarantine to service_role;
do $kakao_rpc_overload_acl$
declare
    routine record;
begin
    for routine in
        select proc.proname,
               proc.prokind,
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
grant execute on function public.omr_save_kakao_candidate_review_v1(text,text,bigint,text,text,jsonb) to service_role;
revoke all on function public.omr_save_kakao_simulation_dispatch_v1(text,text,bigint,text,text,jsonb)
    from public, anon, authenticated, service_role;
grant execute on function public.omr_save_kakao_simulation_dispatch_v1(text,text,bigint,text,text,jsonb) to service_role;
grant execute on function public.omr_kakao_reminder_legacy_inventory_v1() to service_role;
grant execute on function public.omr_kakao_reminder_entitlement_ready_v1() to service_role;
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

do $$
declare signature text;
begin
    foreach signature in array array[
        'omr_list_student_assignments_v2(text,text,text,text,text)',
        'omr_resolve_student_assignment_v2(text,text,text,text,text,text,bigint,text)',
        'omr_open_attempt_session_v3(text,text,text,text,bigint,text,text,text,text,text,text,text,integer[],integer[],timestamptz,jsonb,integer,timestamptz,text,text,integer)',
        'omr_checkpoint_attempt_session_v2(text,text,text,text,text,bigint,bigint,bigint,text,jsonb,jsonb,jsonb,integer,boolean)',
        'omr_heartbeat_attempt_session_v2(text,text,text,text,text,bigint,bigint,text,integer)',
        'omr_takeover_attempt_session_v2(text,text,text,text,text,bigint,bigint,bigint,text,integer)',
        'omr_prepare_attempt_session_submit_v2(text,text,text,text,text,bigint,bigint,bigint,text)',
        'omr_commit_attempt_session_submit_v2(text,text,text,text,text,bigint,bigint,bigint,text,jsonb,jsonb)',
        'omr_list_active_attempt_sessions_v2(text,text,text,text,integer)',
        'omr_resolve_legacy_attempt_session_scope_v1(text,text,text)',
        'omr_prepare_teacher_force_finish_sessions_compact_v2(text,text[],text,text)',
        'omr_force_finish_attempt_sessions_compact_v2(text,text[],timestamptz,text,text,text,jsonb)'
    ] loop
        execute pg_catalog.format('revoke all on function public.%s from public, anon, authenticated',signature);
        execute pg_catalog.format('grant execute on function public.%s to service_role',signature);
    end loop;
end $$;

commit;
