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
           'public.omr_claim_remote_asset_cleanup_v8_snapshot(text,integer,integer)'::regprocedure
       ) not like '%retry_count = queue.retry_count + 1%'
       or pg_catalog.pg_get_functiondef(
           'public.omr_claim_remote_asset_cleanup_v1(text,integer,integer)'::regprocedure
       ) not like '%omr_claim_remote_asset_cleanup_v8_snapshot%'
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
    if pg_catalog.has_table_privilege('anon', 'public.omr_student_credential_batch_receipts', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
       or pg_catalog.has_table_privilege('authenticated', 'public.omr_student_credential_batch_receipts', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
       or pg_catalog.has_table_privilege('service_role', 'public.omr_student_credential_batch_receipts', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
       or not pg_catalog.has_function_privilege(
           'service_role',
           'public.omr_issue_student_start_code_batch_v1(text,text,bigint,text,text,jsonb,text)',
           'EXECUTE'
       )
       or pg_catalog.has_function_privilege(
           'service_role',
           'public.omr_rotate_student_start_credential_v1(text,text,bigint,text,text,text,text)',
           'EXECUTE'
       ) then
        raise exception 'rollback weakened atomic student credential batch boundary';
    end if;
    if pg_catalog.has_table_privilege('anon', 'public.omr_pilot_plan_grants', 'SELECT,INSERT,UPDATE,DELETE')
       or pg_catalog.has_table_privilege('authenticated', 'public.omr_pilot_plan_grants', 'SELECT,INSERT,UPDATE,DELETE')
       or pg_catalog.has_table_privilege('service_role', 'public.omr_pilot_plan_grants', 'SELECT,INSERT,UPDATE,DELETE') then
        raise exception 'rollback exposed RPC-only pilot grant ledger';
    end if;
    if exists (
        select 1 from pg_catalog.unnest(array[
            'public.omr_remote_assets', 'public.omr_remote_asset_upload_intents',
            'public.omr_remote_asset_cleanup_queue', 'public.omr_plan_usage',
            'public.omr_plan_usage_reservations'
        ]) as guarded(table_name)
         where not pg_catalog.has_table_privilege('service_role', table_name, 'SELECT')
            or pg_catalog.has_table_privilege(
                'service_role', table_name,
                'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
            )
    ) or pg_catalog.has_sequence_privilege(
        'service_role', 'public.omr_remote_asset_cleanup_queue_id_seq', 'USAGE,SELECT,UPDATE'
    ) then
        raise exception 'rollback reopened direct Phase C state mutation';
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
        'public.omr_save_exam_v3(text,text,bigint,text,jsonb,jsonb,jsonb,bigint,text)',
        'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role', 'public.omr_bootstrap_workspace_organization_v1(text,text,jsonb,timestamptz)', 'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role', 'public.omr_save_feedback_v4(text,text,bigint,text,text,jsonb,bigint,text)', 'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role', 'public.omr_return_feedback_v4(text,text,bigint,text,text,text,bigint,text)', 'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role', 'public.omr_save_roster_v3(text,text,bigint,text,text,jsonb,jsonb,jsonb,jsonb,bigint)', 'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role', 'public.omr_sync_student_plan_usage_v2(text,text,bigint,text,text)', 'EXECUTE'
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
        'service_role', 'public.omr_probe_provisioned_teacher_canary_v1(text)', 'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role', 'public.omr_rotate_exam_entry_invite_v1(text,text,text,text,timestamptz)', 'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role', 'public.omr_resolve_exam_entry_invite_v1(text,text)', 'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role', 'public.omr_get_exam_entry_invite_metadata_v1(text,text,text)', 'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role', 'public.omr_revoke_exam_entry_invite_v1(text,text,text)', 'EXECUTE'
    ) or pg_catalog.has_function_privilege(
        'anon', 'public.omr_get_exam_entry_invite_metadata_v1(text,text,text)', 'EXECUTE'
    ) or pg_catalog.has_function_privilege(
        'authenticated', 'public.omr_get_exam_entry_invite_metadata_v1(text,text,text)', 'EXECUTE'
    ) or pg_catalog.has_function_privilege(
        'anon', 'public.omr_revoke_exam_entry_invite_v1(text,text,text)', 'EXECUTE'
    ) or pg_catalog.has_function_privilege(
        'authenticated', 'public.omr_revoke_exam_entry_invite_v1(text,text,text)', 'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role', 'public.omr_load_teacher_notification_state_v1(text,text,text[])', 'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role', 'public.omr_mutate_teacher_notification_state_v1(text,text,text,text[])', 'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role', 'public.omr_assign_students_v2(text,text,bigint,text,text,text,text,text[],text,bigint,text)', 'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role', 'public.omr_clear_student_assignment_v2(text,text,bigint,text,text,text,text,bigint,text,text[],text)', 'EXECUTE'
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
    ) or pg_catalog.has_function_privilege(
        'service_role', 'public.omr_save_exam_v2(jsonb,jsonb,jsonb,text,bigint,text)', 'EXECUTE'
    ) or pg_catalog.has_function_privilege(
        'service_role', 'public.omr_save_feedback_v2(text,jsonb,bigint,text)', 'EXECUTE'
    ) or pg_catalog.has_function_privilege(
        'service_role', 'public.omr_return_feedback_v2(text,text,bigint,text)', 'EXECUTE'
    ) or pg_catalog.has_function_privilege(
        'service_role', 'public.omr_save_feedback_v3(text,jsonb,bigint,text)', 'EXECUTE'
    ) or pg_catalog.has_function_privilege(
        'service_role', 'public.omr_return_feedback_v3(text,text,bigint,text)', 'EXECUTE'
    ) then
        raise exception 'rollback reopened a retired or private gateway';
    end if;
    if exists (
        select 1 from pg_catalog.unnest(array[
            'public.omr_save_roster_v3(text,text,bigint,text,text,jsonb,jsonb,jsonb,jsonb,bigint)',
            'public.omr_save_exam_v3(text,text,bigint,text,jsonb,jsonb,jsonb,bigint,text)',
            'public.omr_save_feedback_v4(text,text,bigint,text,text,jsonb,bigint,text)',
            'public.omr_return_feedback_v4(text,text,bigint,text,text,text,bigint,text)',
            'public.omr_assign_students_v2(text,text,bigint,text,text,text,text,text[],text,bigint,text)',
            'public.omr_clear_student_assignment_v2(text,text,bigint,text,text,text,text,bigint,text,text[],text)',
            'public.omr_open_attempt_session_v2(text,text,text,text,text,text,text,text,text,text,text,integer[],integer[],timestamptz,jsonb,integer,timestamptz,text,text,integer)',
            'public.omr_prepare_teacher_asset_upload_v2(text,text,bigint,text,text,jsonb)',
            'public.omr_authorize_teacher_asset_finalize_v2(text,text,bigint,text,text,text,jsonb)',
            'public.omr_finalize_teacher_asset_upload_v2(text,text,bigint,text,text,text,jsonb)',
            'public.omr_prepare_attempt_handwriting_asset_v2(text,text,text,jsonb)',
            'public.omr_attach_attempt_handwriting_v2(text,text,text,text,text)',
            'public.omr_claim_remote_asset_cleanup_v1(text,integer,integer)',
            'public.omr_reserve_plan_usage_v2(text,text,bigint,text,text,text,text)',
            'public.omr_release_plan_usage_v2(text,text,bigint,text,text,text,text)',
            'public.omr_sync_student_plan_usage_v2(text,text,bigint,text,text)'
        ]) as signatures(signature)
         where not pg_catalog.has_function_privilege('service_role', signature, 'EXECUTE')
            or pg_catalog.has_function_privilege('anon', signature, 'EXECUTE')
            or pg_catalog.has_function_privilege('authenticated', signature, 'EXECUTE')
    ) then
        raise exception 'rollback lost an exact Phase C service gateway ACL';
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

set role service_role;
do $$
declare
    v_signature text;
    v_call text;
begin
    foreach v_signature in array array[
        'public.omr_save_remote_asset_metadata_v1(jsonb)',
        'public.omr_save_roster_v2(text,jsonb,jsonb,jsonb,jsonb,bigint)',
        'public.omr_save_roster_v1(text,jsonb,jsonb,jsonb,jsonb)',
        'public.omr_save_roster_plan_unlocked_v1(text,jsonb,jsonb,jsonb,jsonb)',
        'public.omr_save_roster_unlocked_v1(text,jsonb,jsonb,jsonb,jsonb)',
        'public.omr_save_exam_v2(jsonb,jsonb,jsonb,text,bigint,text)',
        'public.omr_save_exam_v1(jsonb,jsonb,jsonb,text)',
        'public.omr_save_exam_v10_snapshot(jsonb,jsonb,jsonb,text)',
        'public.omr_save_exam_v6_snapshot(jsonb,jsonb,jsonb,text)',
        'public.omr_save_exam_plan_unlocked_v1(jsonb,jsonb)',
        'public.omr_prepare_teacher_asset_upload_v1(jsonb)',
        'public.omr_prepare_teacher_asset_upload_v6_snapshot(jsonb)',
        'public.omr_authorize_teacher_asset_finalize_v1(text,text,text,jsonb)',
        'public.omr_finalize_teacher_asset_upload_v1(text,text,text,jsonb)',
        'public.omr_prepare_attempt_handwriting_asset_v1(text,jsonb)',
        'public.omr_attach_attempt_handwriting_v1(text,text,jsonb)',
        'public.omr_save_feedback_v3(text,jsonb,bigint,text)',
        'public.omr_return_feedback_v3(text,text,bigint,text)',
        'public.omr_save_feedback_v2(text,jsonb,bigint,text)',
        'public.omr_return_feedback_v2(text,text,bigint,text)',
        'public.omr_save_feedback_v1(text,jsonb)',
        'public.omr_return_feedback_v1(text,text,timestamp with time zone)',
        'public.omr_assign_students_v1(text,text,text,text,text[],text,bigint,text)',
        'public.omr_clear_student_assignment_v1(text,text,text,text,bigint,text,text[],text)',
        'public.omr_open_attempt_session_v1(text,text,text,text,text,text,text,text,text,text,text,integer[],integer[],timestamp with time zone,jsonb,integer,timestamp with time zone,text,text,integer)',
        'public.omr_reserve_plan_usage(text,text,date,text,integer,integer,integer)',
        'public.omr_release_plan_usage(text,text,date,text)',
        'public.omr_release_plan_usage_v10_snapshot(text,text,date,text)',
        'public.omr_sync_student_plan_usage(text,text[],integer,integer)'
    ] loop
        select pg_catalog.format(
                   'select %I.%I(%s)', namespace.nspname, routine.proname,
                   coalesce((
                       select pg_catalog.string_agg(
                           'null::' || pg_catalog.format_type(argument_type, null), ','
                       )
                         from pg_catalog.unnest(routine.proargtypes::oid[]) argument_type
                   ), '')
               )
          into v_call
          from pg_catalog.pg_proc routine
          join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
         where routine.oid = pg_catalog.to_regprocedure(v_signature);
        if v_call is null then
            raise exception 'rollback retired Phase C signature disappeared: %', v_signature;
        end if;
        begin
            execute v_call;
            raise exception 'rollback let service_role execute retired Phase C signature: %', v_signature;
        exception
            when insufficient_privilege then null;
        end;
    end loop;
    begin
        perform public.omr_set_effective_plan_transaction_proof_v1('org_probe', '{}'::jsonb);
        raise exception 'rollback let service_role execute a private Phase C helper';
    exception
        when insufficient_privilege then null;
    end;
end
$$;
reset role;

do $assignment_generation_scope$
begin
    if pg_catalog.to_regprocedure('public.omr_list_student_assignments_v2(text,text,text,text,text)') is null
       or pg_catalog.to_regprocedure('public.omr_resolve_student_assignment_v2(text,text,text,text,text,text,bigint,text)') is null
       or pg_catalog.to_regprocedure('public.omr_open_attempt_session_v3(text,text,text,text,bigint,text,text,text,text,text,text,text,integer[],integer[],timestamptz,jsonb,integer,timestamptz,text,text,integer)') is null
       or pg_catalog.to_regprocedure('public.omr_checkpoint_attempt_session_v2(text,text,text,text,text,bigint,bigint,bigint,text,jsonb,jsonb,jsonb,integer,boolean)') is null
       or pg_catalog.to_regprocedure('public.omr_heartbeat_attempt_session_v2(text,text,text,text,text,bigint,bigint,text,integer)') is null
       or pg_catalog.to_regprocedure('public.omr_takeover_attempt_session_v2(text,text,text,text,text,bigint,bigint,bigint,text,integer)') is null
       or pg_catalog.to_regprocedure('public.omr_prepare_attempt_session_submit_v2(text,text,text,text,text,bigint,bigint,bigint,text)') is null
       or pg_catalog.to_regprocedure('public.omr_commit_attempt_session_submit_v2(text,text,text,text,text,bigint,bigint,bigint,text,jsonb,jsonb)') is null
       or pg_catalog.to_regprocedure('public.omr_list_active_attempt_sessions_v2(text,text,text,text,integer)') is null
       or pg_catalog.to_regprocedure('public.omr_resolve_legacy_attempt_session_scope_v1(text,text,text)') is null
       or pg_catalog.to_regprocedure('public.omr_prepare_teacher_force_finish_sessions_compact_v2(text,text[],text,text)') is null
       or pg_catalog.to_regprocedure('public.omr_force_finish_attempt_sessions_compact_v2(text,text[],timestamptz,text,text,text,jsonb)') is null then
        raise exception 'assignment generation rollback signature unavailable';
    end if;
end
$assignment_generation_scope$;
