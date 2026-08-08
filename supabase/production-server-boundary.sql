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
revoke all on sequence public.omr_operational_job_run_sequence from public, anon, authenticated, service_role;

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
alter table if exists public.omr_initial_ops_metrics enable row level security;
alter table if exists public.omr_initial_ops_metrics force row level security;
alter table if exists public.omr_teacher_notification_states enable row level security;
alter table if exists public.omr_teacher_notification_states force row level security;

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
        ('omr_teacher_notification_states'), ('omr_operational_job_status')
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
                   'omr_teacher_notification_states', 'omr_operational_job_status'
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
        and not exists (
            select 1
              from pg_catalog.pg_class relation
              join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
             where namespace.nspname = 'public' and relation.relkind = 'S'
               and relation.relname <> 'omr_operational_job_run_sequence'
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
                   'omr_open_attempt_session_v1', 'omr_checkpoint_attempt_session_v1',
                   'omr_heartbeat_attempt_session_v1', 'omr_takeover_attempt_session_v1',
                   'omr_prepare_attempt_session_submit_v1', 'omr_commit_attempt_session_submit_v1',
                   'omr_prepare_attempt_handwriting_asset_v1', 'omr_discard_attempt_handwriting_asset_v1'
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
                  'omr_open_attempt_session_v1', 'omr_checkpoint_attempt_session_v1',
                  'omr_heartbeat_attempt_session_v1', 'omr_takeover_attempt_session_v1',
                  'omr_prepare_attempt_session_submit_v1', 'omr_commit_attempt_session_submit_v1',
                  'omr_prepare_attempt_handwriting_asset_v1', 'omr_discard_attempt_handwriting_asset_v1'
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
        and pg_catalog.has_function_privilege('service_role', 'public.omr_save_exam_v2(jsonb,jsonb,jsonb,text,bigint,text)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('anon', 'public.omr_save_exam_v2(jsonb,jsonb,jsonb,text,bigint,text)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('authenticated', 'public.omr_save_exam_v2(jsonb,jsonb,jsonb,text,bigint,text)', 'EXECUTE')
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
        and pg_catalog.has_function_privilege('service_role', 'public.omr_save_feedback_v2(text,jsonb,bigint,text)', 'EXECUTE')
        and pg_catalog.has_function_privilege('service_role', 'public.omr_return_feedback_v2(text,text,bigint,text)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('anon', 'public.omr_save_feedback_v2(text,jsonb,bigint,text)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('authenticated', 'public.omr_return_feedback_v2(text,text,bigint,text)', 'EXECUTE')
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
        pg_catalog.to_regprocedure('public.omr_save_feedback_v3(text,jsonb,bigint,text)') is not null
        and pg_catalog.to_regprocedure('public.omr_return_feedback_v3(text,text,bigint,text)') is not null
        and pg_catalog.has_function_privilege('service_role', 'public.omr_save_feedback_v3(text,jsonb,bigint,text)', 'EXECUTE')
        and pg_catalog.has_function_privilege('service_role', 'public.omr_return_feedback_v3(text,text,bigint,text)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('anon', 'public.omr_save_feedback_v3(text,jsonb,bigint,text)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('authenticated', 'public.omr_return_feedback_v3(text,text,bigint,text)', 'EXECUTE')
        and pg_catalog.obj_description(
            'public.omr_save_feedback_v3(text,jsonb,bigint,text)'::pg_catalog.regprocedure,
            'pg_proc'
        ) = 'feedback-core-free:202608060027'
        and pg_catalog.obj_description(
            'public.omr_return_feedback_v3(text,text,bigint,text)'::pg_catalog.regprocedure,
            'pg_proc'
        ) = 'feedback-core-free:202608060027';

    v_exam_entry_invites_ready :=
        pg_catalog.to_regclass('public.omr_exam_entry_invites') is not null
        and not pg_catalog.has_table_privilege('public', 'public.omr_exam_entry_invites', 'SELECT,INSERT,UPDATE,DELETE')
        and not pg_catalog.has_table_privilege('anon', 'public.omr_exam_entry_invites', 'SELECT,INSERT,UPDATE,DELETE')
        and not pg_catalog.has_table_privilege('authenticated', 'public.omr_exam_entry_invites', 'SELECT,INSERT,UPDATE,DELETE')
        and not pg_catalog.has_table_privilege('service_role', 'public.omr_exam_entry_invites', 'SELECT,INSERT,UPDATE,DELETE')
        and pg_catalog.has_function_privilege('service_role', 'public.omr_rotate_exam_entry_invite_v1(text,text,text,text,timestamptz)', 'EXECUTE')
        and pg_catalog.has_function_privilege('service_role', 'public.omr_resolve_exam_entry_invite_v1(text,text)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('anon', 'public.omr_rotate_exam_entry_invite_v1(text,text,text,text,timestamptz)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('authenticated', 'public.omr_resolve_exam_entry_invite_v1(text,text)', 'EXECUTE')
        and pg_catalog.obj_description(
            'public.omr_rotate_exam_entry_invite_v1(text,text,text,text,timestamptz)'::pg_catalog.regprocedure,
            'pg_proc'
        ) = 'opaque-exam-entry-invite:202608060029'
        and pg_catalog.obj_description(
            'public.omr_resolve_exam_entry_invite_v1(text,text)'::pg_catalog.regprocedure,
            'pg_proc'
        ) = 'opaque-exam-entry-invite:202608060029';

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
                'public.omr_claim_remote_asset_cleanup_v1(text,integer,integer)'::pg_catalog.regprocedure
            ))
        ) > 0
        and position(
            'to_jsonb(claimed)' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_claim_remote_asset_cleanup_v1(text,integer,integer)'::pg_catalog.regprocedure
            ))
        ) = 0
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
            'session_generation = session_generation + 1' in lower(pg_catalog.pg_get_functiondef(
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
        ) = 'initial-operations-production-coverage:202608060026'
        and pg_catalog.obj_description(
            'public.omr_initial_ops_database_snapshot_v1(text,text,text,text,text)'::pg_catalog.regprocedure,
            'pg_proc'
        ) = 'initial-operations-production-coverage:202608060026'
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
            'omr_open_attempt_session_v1' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_initial_ops_database_snapshot_v1(text,text,text,text,text)'::pg_catalog.regprocedure
            ))
        ) > 0
        and position(
            'omr_finalize_teacher_asset_upload_v1' in lower(pg_catalog.pg_get_functiondef(
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
        ) > 0;

    v_roster_snapshot_cas_ready :=
        pg_catalog.to_regprocedure('public.omr_load_roster_v2(text)') is not null
        and pg_catalog.to_regprocedure(
            'public.omr_save_roster_v2(text,jsonb,jsonb,jsonb,jsonb,bigint)'
        ) is not null
        and coalesce(pg_catalog.has_function_privilege(
            'service_role',
            pg_catalog.to_regprocedure('public.omr_load_roster_v2(text)'),
            'EXECUTE'
        ), false)
        and coalesce(pg_catalog.has_function_privilege(
            'service_role',
            pg_catalog.to_regprocedure(
                'public.omr_save_roster_v2(text,jsonb,jsonb,jsonb,jsonb,bigint)'
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
                'public.omr_save_roster_v2(text,jsonb,jsonb,jsonb,jsonb,bigint)'
            ),
            'EXECUTE'
        ), false)
        and not coalesce(pg_catalog.has_function_privilege(
            'authenticated',
            pg_catalog.to_regprocedure(
                'public.omr_save_roster_v2(text,jsonb,jsonb,jsonb,jsonb,bigint)'
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
            'public.omr_assign_students_v1(text,text,text,text,text[],text,bigint,text)'
        ) is not null
        and pg_catalog.to_regprocedure(
            'public.omr_clear_student_assignment_v1(text,text,text,text,bigint,text,text[],text)'
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
                   'omr_assign_students_v1',
                   'omr_clear_student_assignment_v1',
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

    v_server_gateway_capabilities_ready := v_legacy_gateway_catalog_ready
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
        and v_initial_operations_load_control_ready
        and v_individual_student_assignments_ready
        and v_teacher_attempt_reporting_ready;

    v_ready := v_canonical_tables_force_rls
        and v_service_role_privileges_ready
        and v_operational_job_status_ready
        and v_server_gateway_capabilities_ready
        and not exists (
            select 1
              from pg_catalog.jsonb_each(
                  v_previous - 'version' - 'ready' - 'canonicalTablesForceRls'
                  - 'serviceRolePrivilegesReady' - 'serverGatewayCapabilitiesReady'
                  - 'teacherUploadCleanupQueueReady' - 'studentAttemptSessionsReady'
              ) item
             where item.value is distinct from 'true'::jsonb
        );

    return (v_previous - 'version' - 'ready' - 'canonicalTablesForceRls'
            - 'serviceRolePrivilegesReady' - 'serverGatewayCapabilitiesReady'
            - 'teacherUploadCleanupQueueReady' - 'studentAttemptSessionsReady')
        || pg_catalog.jsonb_build_object(
            'version', '202608080005',
            'canonicalTablesForceRls', v_canonical_tables_force_rls,
            'serviceRolePrivilegesReady', v_service_role_privileges_ready,
            'serverGatewayCapabilitiesReady', v_server_gateway_capabilities_ready,
            'operationalJobStatusReady', v_operational_job_status_ready,
            'teacherUploadCleanupQueueReady', v_cleanup_epoch_ready,
            'studentAttemptSessionsReady', v_attempt_sessions_ready,
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
            'sessionCleanupFencingReady', v_session_cleanup_fencing_ready,
            'attemptCheckpointNullCasReady', v_attempt_checkpoint_null_cas_ready,
            'rosterSnapshotCasReady', v_roster_snapshot_cas_ready,
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

commit;
