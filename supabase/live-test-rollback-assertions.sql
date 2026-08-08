\set ON_ERROR_STOP on

do $$
begin
    if not pg_catalog.has_schema_privilege('anon', 'public', 'USAGE')
       or not pg_catalog.has_schema_privilege('authenticated', 'public', 'USAGE') then
        raise exception 'full rollback did not restore browser schema usage';
    end if;
    if not pg_catalog.has_table_privilege('authenticated', 'public.omr_exams', 'SELECT') then
        raise exception 'full rollback did not restore alpha canonical access';
    end if;
    if pg_catalog.has_table_privilege(
        'authenticated', 'public.omr_remote_asset_cleanup_queue', 'SELECT'
    ) then
        raise exception 'rollback exposed service-only cleanup queue';
    end if;
    if pg_catalog.has_function_privilege(
        'authenticated',
        'public.omr_claim_remote_asset_cleanup_v1(text,integer,integer)',
        'EXECUTE'
    ) then
        raise exception 'rollback exposed service-only cleanup claim RPC';
    end if;
    if pg_catalog.has_sequence_privilege(
        'authenticated', 'public.omr_remote_asset_cleanup_queue_id_seq', 'USAGE'
    ) then
        raise exception 'rollback exposed service-only cleanup queue sequence';
    end if;
    if pg_catalog.has_table_privilege('anon', 'public.omr_attempt_sessions', 'SELECT,INSERT,UPDATE,DELETE')
       or pg_catalog.has_table_privilege('authenticated', 'public.omr_attempt_sessions', 'SELECT,INSERT,UPDATE,DELETE') then
        raise exception 'rollback exposed durable attempt sessions table';
    end if;
    if pg_catalog.to_regclass('public.omr_attempt_sessions_submitted_asset_guard_idx') is null
       or not exists (
           select 1
             from pg_catalog.pg_attribute column_row
            where column_row.attrelid = 'public.omr_remote_asset_cleanup_queue'::regclass
              and column_row.attname = 'retry_count'
              and column_row.attnotnull
       )
       or pg_catalog.pg_get_functiondef(
           'public.omr_requeue_dead_remote_asset_cleanup_v1(text,text,integer,text,text)'::regprocedure
       ) not like '%attempts = queue.attempts + 1%'
       or pg_catalog.pg_get_functiondef(
           'public.omr_claim_remote_asset_cleanup_v1(text,integer,integer)'::regprocedure
       ) not like '%retry_count = queue.retry_count + 1%'
       or pg_catalog.obj_description(
           'public.omr_checkpoint_attempt_session_v1(text,text,text,bigint,bigint,text,jsonb,jsonb,jsonb,integer,boolean)'::regprocedure,
           'pg_proc'
       ) is distinct from 'attempt-checkpoint-null-cas:202608060016;secure-submission-outbox-replay:202608060028;handwriting-takeover-checkpoint:202608060031' then
        raise exception 'rollback lost cleanup generation fencing';
    end if;
    if pg_catalog.obj_description(
           'public.omr_heartbeat_attempt_session_v1(text,text,text,bigint,text,integer)'::regprocedure,
           'pg_proc'
       ) is distinct from 'attempt-mutation-null-cas:202608060018'
       or pg_catalog.obj_description(
           'public.omr_takeover_attempt_session_v1(text,text,text,bigint,bigint,text,integer)'::regprocedure,
           'pg_proc'
       ) is distinct from 'attempt-mutation-null-cas:202608060018'
       or pg_catalog.obj_description(
           'public.omr_prepare_attempt_session_submit_v1(text,text,text,bigint,bigint,text)'::regprocedure,
           'pg_proc'
       ) is distinct from 'attempt-mutation-null-cas:202608060018'
       or pg_catalog.obj_description(
           'public.omr_commit_attempt_session_submit_v1(text,text,text,bigint,bigint,text,jsonb,jsonb)'::regprocedure,
           'pg_proc'
       ) is distinct from 'attempt-mutation-null-cas:202608060018'
       or pg_catalog.obj_description(
           'public.omr_delete_exam_v1(text,text)'::regprocedure,
           'pg_proc'
       ) is distinct from 'exam-delete-session-safe:202608060018' then
        raise exception 'rollback lost attempt mutation CAS or submitted-session exam delete hardening';
    end if;
    if pg_catalog.has_table_privilege('anon', 'public.omr_rate_limit_buckets', 'SELECT,INSERT,UPDATE,DELETE')
       or pg_catalog.has_table_privilege('authenticated', 'public.omr_rate_limit_buckets', 'SELECT,INSERT,UPDATE,DELETE')
       or pg_catalog.has_table_privilege('service_role', 'public.omr_rate_limit_buckets', 'SELECT,INSERT,UPDATE,DELETE')
       or pg_catalog.has_table_privilege('anon', 'public.omr_exam_mutations', 'SELECT,INSERT,UPDATE,DELETE')
       or pg_catalog.has_table_privilege('authenticated', 'public.omr_exam_mutations', 'SELECT,INSERT,UPDATE,DELETE')
       or pg_catalog.has_table_privilege('service_role', 'public.omr_exam_mutations', 'SELECT,INSERT,UPDATE,DELETE')
       or pg_catalog.has_table_privilege('anon', 'public.omr_feedback_mutations', 'SELECT,INSERT,UPDATE,DELETE')
       or pg_catalog.has_table_privilege('authenticated', 'public.omr_feedback_mutations', 'SELECT,INSERT,UPDATE,DELETE')
       or pg_catalog.has_table_privilege('service_role', 'public.omr_feedback_mutations', 'SELECT,INSERT,UPDATE,DELETE')
       or pg_catalog.has_table_privilege('anon', 'public.omr_teacher_notification_states', 'SELECT,INSERT,UPDATE,DELETE')
       or pg_catalog.has_table_privilege('authenticated', 'public.omr_teacher_notification_states', 'SELECT,INSERT,UPDATE,DELETE')
       or pg_catalog.has_table_privilege('service_role', 'public.omr_teacher_notification_states', 'SELECT,INSERT,UPDATE,DELETE') then
        raise exception 'rollback exposed RPC-only rate or mutation state';
    end if;
    if pg_catalog.has_table_privilege('anon', 'public.omr_pilot_plan_grants', 'SELECT,INSERT,UPDATE,DELETE')
       or pg_catalog.has_table_privilege('authenticated', 'public.omr_pilot_plan_grants', 'SELECT,INSERT,UPDATE,DELETE')
       or pg_catalog.has_table_privilege('service_role', 'public.omr_pilot_plan_grants', 'SELECT,INSERT,UPDATE,DELETE') then
        raise exception 'rollback exposed RPC-only pilot grant ledger';
    end if;
    if not pg_catalog.has_function_privilege(
        'service_role',
        'public.omr_authorize_remote_asset_cleanup_delete_v1(text,text,integer)',
        'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role',
        'public.omr_ack_remote_asset_cleanup_v1(text,text,integer)',
        'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role',
        'public.omr_fail_remote_asset_cleanup_v1(text,text,integer,text)',
        'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role',
        'public.omr_consume_rate_limit_v1(text,text,integer,integer,integer)',
        'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role',
        'public.omr_save_exam_v2(jsonb,jsonb,jsonb,text,bigint,text)',
        'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role', 'public.omr_bootstrap_workspace_organization_v1(text,text,jsonb,timestamptz)', 'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role', 'public.omr_save_feedback_v2(text,jsonb,bigint,text)', 'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role', 'public.omr_return_feedback_v2(text,text,bigint,text)', 'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role', 'public.omr_save_feedback_v3(text,jsonb,bigint,text)', 'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role', 'public.omr_return_feedback_v3(text,text,bigint,text)', 'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role', 'public.omr_gc_attempt_sessions_v1(integer,integer)', 'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role', 'public.omr_requeue_dead_remote_asset_cleanup_v1(text,text,integer,text,text)', 'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role', 'public.omr_upsert_student_attempt_question_v1(text,text,text,bigint,text,text)', 'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role', 'public.omr_prepare_teacher_force_finish_sessions_compact_v1(text,text[],text,text)', 'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role', 'public.omr_force_finish_attempt_sessions_compact_v1(text,text[],timestamptz,text,text,text,jsonb)', 'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role', 'public.omr_validate_teacher_session_v1(text,bigint)', 'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role', 'public.omr_provision_pilot_teacher_v1(text,text,text,text,text,timestamptz,text,text,text)', 'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role', 'public.omr_read_effective_workspace_plan_v1(text)', 'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role', 'public.omr_lookup_provisioned_teacher_login_v1(text)', 'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role', 'public.omr_validate_provisioned_teacher_session_v1(text,bigint,text)', 'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role', 'public.omr_rotate_exam_entry_invite_v1(text,text,text,text,timestamptz)', 'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role', 'public.omr_resolve_exam_entry_invite_v1(text,text)', 'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role', 'public.omr_load_teacher_notification_state_v1(text,text,text[])', 'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role', 'public.omr_mutate_teacher_notification_state_v1(text,text,text,text[])', 'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role', 'public.omr_assign_students_v1(text,text,text,text,text[],text,bigint,text)', 'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role', 'public.omr_clear_student_assignment_v1(text,text,text,text,bigint,text,text[],text)', 'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role', 'public.omr_load_teacher_student_assignment_v1(text,text,text,text)', 'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role', 'public.omr_list_student_assignments_v1(text,text,text,text,text)', 'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role', 'public.omr_resolve_student_assignment_v1(text,text,text,text,text,text,text)', 'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role', 'public.omr_teacher_attempt_aggregate_v1(text,text,timestamptz,timestamptz)', 'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role', 'public.omr_teacher_attempt_export_v1(text,text,integer)', 'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role', 'public.omr_teacher_attempt_export_page_v1(text,text,timestamptz,timestamptz,text,integer)', 'EXECUTE'
    ) then
        raise exception 'rollback lost a current service-only RPC';
    end if;
    if pg_catalog.has_function_privilege(
        'service_role', 'public.omr_ack_remote_asset_cleanup_v1(text,text)', 'EXECUTE'
    ) or pg_catalog.has_function_privilege(
        'service_role', 'public.omr_fail_remote_asset_cleanup_v1(text,text,text)', 'EXECUTE'
    ) or pg_catalog.has_function_privilege(
        'service_role', 'public.omr_save_exam_v1(jsonb,jsonb,jsonb,text)', 'EXECUTE'
    ) or pg_catalog.has_function_privilege(
        'service_role', 'public.omr_save_exam_v10_snapshot(jsonb,jsonb,jsonb,text)', 'EXECUTE'
    ) or pg_catalog.has_function_privilege(
        'service_role', 'public.omr_release_plan_usage_v10_snapshot(text,text,date,text)', 'EXECUTE'
    ) or pg_catalog.has_function_privilege(
        'service_role', 'public.omr_normalize_exam_save_request_v10(jsonb)', 'EXECUTE'
    ) or pg_catalog.has_function_privilege(
        'service_role', 'public.omr_save_feedback_v1(text,jsonb)', 'EXECUTE'
    ) or pg_catalog.has_function_privilege(
        'service_role', 'public.omr_return_feedback_v1(text,text,timestamptz)', 'EXECUTE'
    ) or pg_catalog.has_function_privilege(
        'service_role', 'public.omr_save_feedback_v12_snapshot(text,jsonb)', 'EXECUTE'
    ) or pg_catalog.has_function_privilege(
        'service_role', 'public.omr_return_feedback_v12_snapshot(text,text,timestamptz)', 'EXECUTE'
    ) or pg_catalog.has_function_privilege(
        'service_role', 'public.omr_advance_teacher_session_on_disable_v1()', 'EXECUTE'
    ) or pg_catalog.has_function_privilege(
        'service_role', 'public.omr_assert_targeted_assignment_scope_v1(text,text,text,text,text,text,integer[])', 'EXECUTE'
    ) or pg_catalog.has_function_privilege(
        'service_role', 'public.omr_validate_targeted_attempt_session_v1()', 'EXECUTE'
    ) or pg_catalog.has_function_privilege(
        'service_role', 'public.omr_validate_targeted_attempt_v1()', 'EXECUTE'
    ) or pg_catalog.has_function_privilege(
        'service_role', 'public.omr_guard_targeted_exam_access_v1()', 'EXECUTE'
    ) then
        raise exception 'rollback reopened a retired or private gateway';
    end if;
    if exists (
        select 1
          from pg_catalog.pg_proc routine
          join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
         where namespace.nspname = 'public'
           and routine.proname in (
               'omr_enqueue_remote_asset_cleanup_v1',
               'omr_enqueue_exam_asset_cleanup_v1',
               'omr_remote_assets_enqueue_cleanup_v1',
               'omr_exams_enqueue_asset_cleanup_v1',
               'omr_save_exam_v6_snapshot',
               'omr_save_exam_v10_snapshot',
               'omr_release_plan_usage_v10_snapshot',
               'omr_normalize_exam_save_request_v10',
               'omr_authorize_remote_asset_cleanup_delete_v1',
               'omr_consume_rate_limit_v1',
               'omr_save_exam_v2',
               'omr_bootstrap_workspace_organization_v1',
               'omr_save_feedback_v2',
               'omr_return_feedback_v2',
               'omr_save_feedback_v3',
               'omr_return_feedback_v3',
               'omr_gc_attempt_sessions_v1',
               'omr_requeue_dead_remote_asset_cleanup_v1',
               'omr_upsert_student_attempt_question_v1',
               'omr_save_feedback_v12_snapshot',
               'omr_return_feedback_v12_snapshot',
               'omr_teacher_notification_summary_v1',
               'omr_open_attempt_session_v1',
               'omr_checkpoint_attempt_session_v1',
               'omr_heartbeat_attempt_session_v1',
               'omr_takeover_attempt_session_v1',
               'omr_prepare_attempt_session_submit_v1',
               'omr_commit_attempt_session_submit_v1',
               'omr_prepare_teacher_force_finish_sessions_compact_v1',
               'omr_force_finish_attempt_sessions_compact_v1',
               'omr_validate_teacher_session_v1',
               'omr_advance_teacher_session_on_disable_v1',
               'omr_rotate_exam_entry_invite_v1',
               'omr_resolve_exam_entry_invite_v1',
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
           )
           and (
               pg_catalog.has_function_privilege('anon', routine.oid, 'EXECUTE')
               or pg_catalog.has_function_privilege('authenticated', routine.oid, 'EXECUTE')
           )
    ) then
        raise exception 'rollback exposed internal cleanup helper';
    end if;
end
$$;
