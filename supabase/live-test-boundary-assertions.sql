\set ON_ERROR_STOP on
do $$
declare
    readiness jsonb;
begin
    if position(
        'grant_row.state = ''active''' in pg_catalog.pg_get_functiondef(
            'public.omr_read_effective_workspace_plan_v1(text)'::pg_catalog.regprocedure
        )
    ) = 0 then raise exception 'operator provisioning readiness missed active-state function proof';
    end if;
    if position(
        'grant_row.superseded_at is null' in pg_catalog.pg_get_functiondef(
            'public.omr_read_effective_workspace_plan_v1(text)'::pg_catalog.regprocedure
        )
    ) = 0 then raise exception 'operator provisioning readiness missed superseded function proof';
    end if;
    if position(
        'grant_row.expires_at > pg_catalog.clock_timestamp()' in pg_catalog.pg_get_functiondef(
            'public.omr_read_effective_workspace_plan_v1(text)'::pg_catalog.regprocedure
        )
    ) = 0 then raise exception 'operator provisioning readiness missed expiry function proof';
    end if;
    if position(
        '''plan'', ''free''' in pg_catalog.pg_get_functiondef(
            'public.omr_read_effective_workspace_plan_v1(text)'::pg_catalog.regprocedure
        )
    ) = 0 then raise exception 'operator provisioning readiness missed free-fallback function proof';
    end if;
    if not exists (
        select 1 from pg_catalog.pg_index index_record
         where index_record.indexrelid = pg_catalog.to_regclass(
                   'public.omr_pilot_plan_grants_one_current_org_idx'
               )
           and index_record.indrelid = 'public.omr_pilot_plan_grants'::pg_catalog.regclass
           and index_record.indisvalid and index_record.indisready and index_record.indisunique
           and index_record.indnkeyatts = 1
           and pg_catalog.pg_get_indexdef(index_record.indexrelid, 1, true) = 'organization_id'
           and position('state = ''active''::text' in pg_catalog.lower(pg_catalog.pg_get_expr(
               index_record.indpred, index_record.indrelid, true
           ))) > 0
           and position('superseded_at is null' in pg_catalog.lower(pg_catalog.pg_get_expr(
               index_record.indpred, index_record.indrelid, true
           ))) > 0
    ) then raise exception 'operator provisioning readiness missed current-org unique index proof: key=%, predicate=%',
        pg_catalog.pg_get_indexdef(
            pg_catalog.to_regclass('public.omr_pilot_plan_grants_one_current_org_idx'), 1, true
        ),
        (
            select pg_catalog.pg_get_expr(index_record.indpred, index_record.indrelid, true)
              from pg_catalog.pg_index index_record
             where index_record.indexrelid = pg_catalog.to_regclass(
                       'public.omr_pilot_plan_grants_one_current_org_idx'
                   )
        );
    end if;
    if not exists (
        select 1 from pg_catalog.pg_index index_record
         where index_record.indexrelid = pg_catalog.to_regclass(
                   'public.omr_pilot_plan_grants_idempotency_hash_unique'
               )
           and index_record.indrelid = 'public.omr_pilot_plan_grants'::pg_catalog.regclass
           and index_record.indisvalid and index_record.indisready and index_record.indisunique
           and index_record.indnkeyatts = 1 and index_record.indpred is null
           and pg_catalog.pg_get_indexdef(index_record.indexrelid, 1, true)
               = 'idempotency_key_hash'
    ) then raise exception 'operator provisioning readiness missed idempotency unique index proof';
    end if;
    if pg_catalog.has_schema_privilege('anon', 'public', 'USAGE')
       or pg_catalog.has_schema_privilege('authenticated', 'public', 'USAGE') then
        raise exception 'production boundary left browser schema access';
    end if;
    if pg_catalog.has_table_privilege('anon', 'public.omr_exams', 'SELECT')
       or pg_catalog.has_table_privilege('authenticated', 'public.omr_exams', 'SELECT') then
        raise exception 'production boundary left browser canonical access';
    end if;
    if pg_catalog.has_table_privilege(
           'service_role', 'public.omr_student_credential_batch_receipts',
           'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
       )
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
        raise exception 'production boundary weakened atomic student credential batch ACL';
    end if;
    readiness := public.omr_service_readiness_v1();
    if readiness ->> 'version' <> '202608080010'
       or readiness ->> 'ready' <> 'true'
       or readiness ->> 'studentCredentialBatchReady' <> 'true'
       or readiness ->> 'teacherUploadCleanupQueueReady' <> 'true'
       or readiness ->> 'studentAttemptSessionsReady' <> 'true'
       or readiness ->> 'durableRateLimitsReady' <> 'true'
       or readiness ->> 'examRevisionReady' <> 'true'
       or readiness ->> 'teacherExamCasReady' <> 'true'
       or readiness ->> 'teacherNotificationSummaryReady' <> 'true'
       or readiness ->> 'teacherNotificationStateReady' <> 'true'
       or readiness ->> 'feedbackRevisionReady' <> 'true'
       or readiness ->> 'feedbackCasReady' <> 'true'
       or readiness ->> 'workspaceBootstrapPlanSafe' <> 'true'
       or readiness ->> 'sessionCleanupOptimizationReady' <> 'true'
       or readiness ->> 'feedbackReplayHardeningReady' <> 'true'
       or readiness ->> 'feedbackCoreFreeReady' <> 'true'
       or readiness ->> 'sessionCleanupFencingReady' <> 'true'
       or readiness ->> 'attemptCheckpointNullCasReady' <> 'true'
       or readiness ->> 'rosterSnapshotCasReady' <> 'true'
       or readiness ->> 'attemptMutationCasReady' <> 'true'
       or readiness ->> 'examDeleteSessionSafe' <> 'true'
       or readiness ->> 'teacherLiveSessionsReady' <> 'true'
       or readiness ->> 'teacherAccountLifecycleReady' <> 'true'
       or readiness ->> 'initialOperationsLoadControlReady' <> 'true'
       or readiness ->> 'individualStudentAssignmentsReady' <> 'true'
       or readiness ->> 'teacherAttemptReportingReady' <> 'true'
       or readiness ->> 'operationalJobStatusReady' <> 'true'
       or readiness ->> 'operatorPilotProvisioningReady' <> 'true'
       or readiness ->> 'provisionedTeacherLoginReady' <> 'true'
       or readiness ->> 'effectiveWorkspacePlanEnforcementReady' <> 'true'
       or readiness ->> 'studentSessionGenerationReady' <> 'true' then
        raise exception 'production boundary readiness failed: %', readiness;
    end if;
    if pg_catalog.has_table_privilege(
        'service_role', 'public.omr_rate_limit_buckets', 'SELECT,INSERT,UPDATE,DELETE'
    ) or pg_catalog.has_table_privilege(
        'service_role', 'public.omr_exam_mutations', 'SELECT,INSERT,UPDATE,DELETE'
    ) or pg_catalog.has_table_privilege(
        'service_role', 'public.omr_feedback_mutations', 'SELECT,INSERT,UPDATE,DELETE'
    ) or pg_catalog.has_table_privilege(
        'service_role', 'public.omr_teacher_notification_states', 'SELECT,INSERT,UPDATE,DELETE'
    ) or pg_catalog.has_table_privilege(
        'service_role', 'public.omr_operational_job_status', 'SELECT,INSERT,UPDATE,DELETE'
    ) or pg_catalog.has_table_privilege(
        'service_role', 'public.omr_pilot_plan_grants', 'SELECT,INSERT,UPDATE,DELETE'
    ) or pg_catalog.has_table_privilege(
        'service_role', 'public.omr_remote_assets', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
    ) or pg_catalog.has_table_privilege(
        'service_role', 'public.omr_remote_asset_upload_intents', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
    ) or pg_catalog.has_table_privilege(
        'service_role', 'public.omr_remote_asset_cleanup_queue', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
    ) or pg_catalog.has_table_privilege(
        'service_role', 'public.omr_plan_usage', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
    ) or pg_catalog.has_table_privilege(
        'service_role', 'public.omr_plan_usage_reservations', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
    ) or pg_catalog.has_sequence_privilege(
        'service_role', 'public.omr_remote_asset_cleanup_queue_id_seq', 'USAGE,SELECT,UPDATE'
    ) then
        raise exception 'production boundary exposed RPC-only state tables';
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
        'public.omr_begin_operational_job_run_v1(text,text)',
        'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role',
        'public.omr_complete_operational_job_run_v1(text,bigint,text,text,text)',
        'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role',
        'public.omr_read_operational_job_status_v1(text)',
        'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role',
        'public.omr_provision_pilot_teacher_v1(text,text,text,text,text,timestamptz,text,text,text)',
        'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role',
        'public.omr_read_effective_workspace_plan_v1(text)',
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
        'service_role',
        'public.omr_teacher_notification_summary_v1(text)',
        'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role',
        'public.omr_load_teacher_notification_state_v1(text,text,text[])',
        'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role',
        'public.omr_mutate_teacher_notification_state_v1(text,text,text,text[])',
        'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role',
        'public.omr_bootstrap_workspace_organization_v1(text,text,jsonb,timestamptz)',
        'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role',
        'public.omr_save_feedback_v4(text,text,bigint,text,text,jsonb,bigint,text)',
        'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role',
        'public.omr_return_feedback_v4(text,text,bigint,text,text,text,bigint,text)',
        'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role',
        'public.omr_save_roster_v3(text,text,bigint,text,text,jsonb,jsonb,jsonb,jsonb,bigint)',
        'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role',
        'public.omr_sync_student_plan_usage_v2(text,text,bigint,text,text)',
        'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role', 'public.omr_gc_attempt_sessions_v1(integer,integer)', 'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role',
        'public.omr_requeue_dead_remote_asset_cleanup_v1(text,text,integer,text,text)',
        'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role',
        'public.omr_prepare_teacher_force_finish_sessions_compact_v1(text,text[],text,text)',
        'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role',
        'public.omr_force_finish_attempt_sessions_compact_v1(text,text[],timestamptz,text,text,text,jsonb)',
        'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role',
        'public.omr_validate_teacher_session_v1(text,bigint)',
        'EXECUTE'
    ) then
        raise exception 'production boundary lost a current service gateway';
    end if;
    if pg_catalog.has_function_privilege(
        'service_role', 'public.omr_ack_remote_asset_cleanup_v1(text,text)', 'EXECUTE'
    ) or pg_catalog.has_function_privilege(
        'service_role', 'public.omr_fail_remote_asset_cleanup_v1(text,text,text)', 'EXECUTE'
    ) or pg_catalog.has_function_privilege(
        'service_role', 'public.omr_save_exam_v1(jsonb,jsonb,jsonb,text)', 'EXECUTE'
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
        'service_role', 'public.omr_initial_ops_operation_v1(text,text,text,text,text,text,jsonb)', 'EXECUTE'
    ) or pg_catalog.has_function_privilege(
        'service_role', 'public.omr_initial_ops_reserve_upload_v1(text,text,text,text,text,text,bigint)', 'EXECUTE'
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
        raise exception 'production boundary exposed a retired unfenced gateway';
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
        raise exception 'production boundary lost an exact Phase C service gateway ACL';
    end if;
    if exists (
        select 1 from pg_catalog.unnest(array[
            'public.omr_lock_provisioned_teacher_identity_v1(text,bigint,text)',
            'public.omr_set_effective_plan_transaction_proof_v1(text,jsonb)',
            'public.omr_save_exam_effective_worker_v3(text,text,text,text,jsonb,jsonb,jsonb)',
            'public.omr_claim_remote_asset_cleanup_v8_snapshot(text,integer,integer)',
            'public.omr_assert_targeted_assignment_scope_v1(text,text,text,text,text,text,integer[])'
        ]) as signatures(signature)
         where pg_catalog.has_function_privilege('service_role', signature, 'EXECUTE')
            or pg_catalog.has_function_privilege('anon', signature, 'EXECUTE')
            or pg_catalog.has_function_privilege('authenticated', signature, 'EXECUTE')
    ) then
        raise exception 'production boundary exposed a private Phase C worker';
    end if;
end
$$;

insert into public.omr_organizations (id, name, plan, metadata)
values ('teacher_task6ready', 'Task 6 Readiness', 'free', '{}'::jsonb)
on conflict (id) do nothing;
do $task6_readiness_drift$
declare
    v_original_function text;
    v_readiness jsonb;
begin
    select pg_catalog.pg_get_functiondef(
        'public.omr_issue_student_start_code_batch_v1(text,text,bigint,text,text,jsonb,text)'::pg_catalog.regprocedure
    ) into v_original_function;

    execute $drift$
        create or replace function public.omr_issue_student_start_code_batch_v1(
            p_session_authority text, p_account_id text, p_session_generation bigint,
            p_organization_id text, p_actor_user_id text, p_items jsonb,
            p_idempotency_key text
        ) returns jsonb language sql security definer set search_path = ''
          set statement_timeout = '10s' set lock_timeout = '2s'
          as 'select ''{"status":"issued"}''::jsonb'
    $drift$;
    v_readiness := public.omr_service_readiness_v1();
    if v_readiness ->> 'studentCredentialBatchReady' <> 'false'
       or v_readiness ->> 'ready' <> 'false' then
        raise exception 'Task 6 function body drift passed readiness: %', v_readiness;
    end if;
    execute v_original_function;

    alter table public.omr_student_credential_batch_receipts add column raw_code text;
    if public.omr_service_readiness_v1() ->> 'studentCredentialBatchReady' <> 'false' then
        raise exception 'Task 6 secret-capable column drift passed readiness';
    end if;
    alter table public.omr_student_credential_batch_receipts drop column raw_code;

    alter table public.omr_student_credential_batch_receipts
        drop constraint omr_student_credential_batch_receipts_pkey;
    if public.omr_service_readiness_v1() ->> 'studentCredentialBatchReady' <> 'false' then
        raise exception 'Task 6 primary index drift passed readiness';
    end if;
    alter table public.omr_student_credential_batch_receipts
        add constraint omr_student_credential_batch_receipts_pkey
        primary key (organization_id, idempotency_key_hash);

    grant select on public.omr_student_credential_batch_receipts to service_role;
    if public.omr_service_readiness_v1() ->> 'studentCredentialBatchReady' <> 'false' then
        raise exception 'Task 6 receipt ACL drift passed readiness';
    end if;
    revoke select on public.omr_student_credential_batch_receipts from service_role;

    create function public.omr_issue_student_start_code_batch_v1(integer)
    returns jsonb language sql as 'select ''{}''::jsonb';
    revoke all on function public.omr_issue_student_start_code_batch_v1(integer)
        from public, anon, authenticated, service_role;
    if public.omr_service_readiness_v1() ->> 'studentCredentialBatchReady' <> 'false' then
        raise exception 'Task 6 overload drift passed readiness';
    end if;
    drop function public.omr_issue_student_start_code_batch_v1(integer);

    insert into public.omr_student_credential_batch_receipts (
        organization_id, idempotency_key_hash, request_fingerprint, student_count, state
    ) values (
        'teacher_task6ready', repeat('a', 64), repeat('b', 64), 1, 'pending'
    );
    if public.omr_service_readiness_v1() ->> 'studentCredentialBatchReady' <> 'false' then
        raise exception 'Task 6 committed pending receipt passed readiness';
    end if;
    delete from public.omr_student_credential_batch_receipts
     where organization_id = 'teacher_task6ready';

    v_readiness := public.omr_service_readiness_v1();
    if v_readiness ->> 'studentCredentialBatchReady' <> 'true'
       or v_readiness ->> 'ready' <> 'true' then
        raise exception 'Task 6 readiness did not recover after exact restoration: %', v_readiness;
    end if;
end
$task6_readiness_drift$;
delete from public.omr_organizations where id = 'teacher_task6ready';

-- The Task 5 readiness bit is an exact catalog and state attestation, not a
-- name-only probe. Every induced drift must take the aggregate gateway and
-- database readiness false, and the exact restoration must recover it.
do $task5_readiness_drift$
declare
    v_readiness jsonb;
    v_original_validator text;
    v_original_profile_constraint text;
begin
    select pg_catalog.pg_get_functiondef(
        'public.omr_validate_student_session_v1(text,text,text,integer)'::pg_catalog.regprocedure
    ) into v_original_validator;
    select pg_catalog.pg_get_constraintdef(constraint_row.oid, true)
      into v_original_profile_constraint
      from pg_catalog.pg_constraint constraint_row
     where constraint_row.conname = 'omr_student_profiles_credential_generation_check'
       and constraint_row.conrelid = 'public.omr_student_profiles'::pg_catalog.regclass;

    execute $drift$
        create or replace function public.omr_validate_student_session_v1(
            p_account_id text, p_organization_id text, p_student_id text,
            p_credential_generation integer
        ) returns boolean language sql stable security definer
        set search_path = '' set statement_timeout = '5s' set lock_timeout = '2s'
        as 'select true'
    $drift$;
    v_readiness := public.omr_service_readiness_v1();
    if v_readiness->>'studentSessionGenerationReady' <> 'false'
       or v_readiness->>'serverGatewayCapabilitiesReady' <> 'false'
       or v_readiness->>'ready' <> 'false' then
        raise exception 'student session readiness accepted a fake validator body: %', v_readiness;
    end if;
    execute v_original_validator;

    execute 'alter table public.omr_student_profiles drop constraint '
        || 'omr_student_profiles_credential_generation_check';
    execute 'alter table public.omr_student_profiles add constraint '
        || 'omr_student_profiles_credential_generation_check '
        || 'check (credential_generation > 0 or true)';
    v_readiness := public.omr_service_readiness_v1();
    if v_readiness->>'studentSessionGenerationReady' <> 'false'
       or v_readiness->>'serverGatewayCapabilitiesReady' <> 'false'
       or v_readiness->>'ready' <> 'false' then
        raise exception 'student session readiness accepted a weakened generation constraint: %',
            v_readiness;
    end if;
    execute 'alter table public.omr_student_profiles drop constraint '
        || 'omr_student_profiles_credential_generation_check';
    execute 'alter table public.omr_student_profiles add constraint '
        || 'omr_student_profiles_credential_generation_check '
        || v_original_profile_constraint;

    alter index public.omr_student_credential_epochs_account_id_unique
        rename to omr_student_credential_epochs_account_id_unique_drift;
    v_readiness := public.omr_service_readiness_v1();
    if v_readiness->>'studentSessionGenerationReady' <> 'false'
       or v_readiness->>'serverGatewayCapabilitiesReady' <> 'false'
       or v_readiness->>'ready' <> 'false' then
        raise exception 'student session readiness accepted credential index drift: %', v_readiness;
    end if;
    alter index public.omr_student_credential_epochs_account_id_unique_drift
        rename to omr_student_credential_epochs_account_id_unique;

    alter table public.omr_student_profiles
        disable trigger omr_student_profile_credential_revocation;
    v_readiness := public.omr_service_readiness_v1();
    if v_readiness->>'studentSessionGenerationReady' <> 'false'
       or v_readiness->>'serverGatewayCapabilitiesReady' <> 'false'
       or v_readiness->>'ready' <> 'false' then
        raise exception 'student session readiness accepted a disabled revocation trigger: %',
            v_readiness;
    end if;
    alter table public.omr_student_profiles
        enable trigger omr_student_profile_credential_revocation;

    grant execute on function public.omr_validate_student_session_v1(text,text,text,integer)
        to anon;
    v_readiness := public.omr_service_readiness_v1();
    if v_readiness->>'studentSessionGenerationReady' <> 'false'
       or v_readiness->>'serverGatewayCapabilitiesReady' <> 'false'
       or v_readiness->>'ready' <> 'false' then
        raise exception 'student session readiness accepted browser validator execute: %', v_readiness;
    end if;
    revoke execute on function public.omr_validate_student_session_v1(text,text,text,integer)
        from anon;

    create function public.omr_validate_student_session_v1(text,text,text,bigint)
    returns boolean language sql stable security definer
    set search_path = '' set statement_timeout = '5s' set lock_timeout = '2s'
    as 'select false';
    v_readiness := public.omr_service_readiness_v1();
    if v_readiness->>'studentSessionGenerationReady' <> 'false'
       or v_readiness->>'serverGatewayCapabilitiesReady' <> 'false'
       or v_readiness->>'ready' <> 'false' then
        raise exception 'student session readiness accepted an extra validator overload: %', v_readiness;
    end if;
    drop function public.omr_validate_student_session_v1(text,text,text,bigint);

    insert into public.omr_organizations (id, name, plan, metadata)
    values ('teacher_task5drift', 'Task 5 Drift School', 'free', '{}'::jsonb);
    insert into public.omr_student_profiles (
        id, organization_id, display_name, external_id, status, metadata
    ) values (
        'task5-drift-student', 'teacher_task5drift', 'Task 5 Drift Student',
        'TASK5-DRIFT', 'active', '{}'::jsonb
    );
    insert into public.omr_student_credential_epochs (
        organization_id, student_profile_id, account_id, credential_generation
    ) values (
        'teacher_task5drift', 'task5-drift-student',
        'student_credential_' || repeat('9', 32), 1
    );
    alter table public.omr_student_profiles
        disable trigger omr_student_profile_generation_guard;
    update public.omr_student_profiles set credential_generation = 2
     where organization_id = 'teacher_task5drift' and id = 'task5-drift-student';
    alter table public.omr_student_profiles
        enable trigger omr_student_profile_generation_guard;
    v_readiness := public.omr_service_readiness_v1();
    if v_readiness->>'studentSessionGenerationReady' <> 'false'
       or v_readiness->>'serverGatewayCapabilitiesReady' <> 'false'
       or v_readiness->>'ready' <> 'false' then
        raise exception 'student session readiness accepted profile/epoch data drift: %', v_readiness;
    end if;
    update public.omr_student_profiles set credential_generation = 1
     where organization_id = 'teacher_task5drift' and id = 'task5-drift-student';
    delete from public.omr_organizations where id = 'teacher_task5drift';

    v_readiness := public.omr_service_readiness_v1();
    if v_readiness->>'studentSessionGenerationReady' <> 'true'
       or v_readiness->>'serverGatewayCapabilitiesReady' <> 'true'
       or v_readiness->>'ready' <> 'true' then
        raise exception 'student session readiness did not recover after exact restoration: %',
            v_readiness;
    end if;
end
$task5_readiness_drift$;

-- The named Phase C readiness bit must detect semantic body, overload, and ACL
-- drift and return to ready only after the exact catalog is restored.
do $$
declare
    v_original_definition text;
begin
    select pg_catalog.pg_get_functiondef(
        'public.omr_set_effective_plan_transaction_proof_v1(text,jsonb)'::pg_catalog.regprocedure
    ) into v_original_definition;

    execute $drift$
        create or replace function public.omr_set_effective_plan_transaction_proof_v1(
            p_organization_id text, p_effective jsonb
        )
        returns void language plpgsql security definer
        set search_path = '' set statement_timeout = '5s' set lock_timeout = '2s'
        as 'begin return; end'
    $drift$;
    if (public.omr_service_readiness_v1()->>'effectiveWorkspacePlanEnforcementReady')::boolean then
        raise exception 'Phase C readiness accepted private proof-setter body drift';
    end if;
    execute v_original_definition;
    if not (public.omr_service_readiness_v1()->>'effectiveWorkspacePlanEnforcementReady')::boolean then
        raise exception 'Phase C readiness did not recover after body restoration';
    end if;

    create function public.omr_release_plan_usage_v2(text)
    returns jsonb language sql security definer
    set search_path = '' set statement_timeout = '5s' set lock_timeout = '2s'
    as 'select ''{}''::jsonb';
    if (public.omr_service_readiness_v1()->>'effectiveWorkspacePlanEnforcementReady')::boolean then
        raise exception 'Phase C readiness accepted an impostor overload';
    end if;
    drop function public.omr_release_plan_usage_v2(text);
    if not (public.omr_service_readiness_v1()->>'effectiveWorkspacePlanEnforcementReady')::boolean then
        raise exception 'Phase C readiness did not recover after overload removal';
    end if;

    grant execute on function public.omr_set_effective_plan_transaction_proof_v1(text,jsonb)
        to service_role;
    if (public.omr_service_readiness_v1()->>'effectiveWorkspacePlanEnforcementReady')::boolean then
        raise exception 'Phase C readiness accepted private-helper ACL drift';
    end if;
    revoke execute on function public.omr_set_effective_plan_transaction_proof_v1(text,jsonb)
        from service_role;
    if not (public.omr_service_readiness_v1()->>'effectiveWorkspacePlanEnforcementReady')::boolean then
        raise exception 'Phase C readiness did not recover after ACL restoration';
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
            raise exception 'retired Phase C signature disappeared: %', v_signature;
        end if;
        begin
            execute v_call;
            raise exception 'service_role executed retired Phase C signature: %', v_signature;
        exception
            when insufficient_privilege then null;
        end;
    end loop;
    begin
        perform public.omr_set_effective_plan_transaction_proof_v1('org_probe', '{}'::jsonb);
        raise exception 'service_role executed a private Phase C helper';
    exception
        when insufficient_privilege then null;
    end;
end
$$;
reset role;

begin;
set local role service_role;
do $$
declare
    v_created jsonb;
    v_identity jsonb;
    v_cleaned jsonb;
begin
    v_created := public.omr_initial_ops_fixture_v1(
        'create', 'phasec-load-0001', pg_catalog.repeat('a', 64),
        'teacher_2922a7a32fad97c8', 'initial_ops_exam_2922a7a32fad97c8'
    );
    v_identity := v_created -> 'teacherIdentity';
    if pg_catalog.jsonb_typeof(v_identity) <> 'object'
       or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(v_identity)) <> 4
       or v_identity ->> 'sessionAuthority' <> 'legacy_account'
       or v_identity ->> 'accountId' <> 'teacher_2922a7a32fad97c8'
       or v_identity ->> 'actorUserId' <> 'teacher_2922a7a32fad97c8'
       or (v_identity ->> 'accountSessionGeneration')::bigint <> 1 then
        raise exception 'initial operations Phase C identity envelope drifted: %', v_identity;
    end if;
    if public.omr_initial_ops_fixture_v1(
        'cleanup', 'phasec-load-0001', pg_catalog.repeat('a', 64),
        'teacher_2922a7a32fad97c8', 'initial_ops_exam_2922a7a32fad97c8'
    ) ->> 'status' <> 'cleanup_pending' then
        raise exception 'initial operations Phase C cleanup did not start';
    end if;
    v_cleaned := public.omr_initial_ops_fixture_v1(
        'finalize_cleanup', 'phasec-load-0001', pg_catalog.repeat('a', 64),
        'teacher_2922a7a32fad97c8', 'initial_ops_exam_2922a7a32fad97c8'
    );
    if v_cleaned ->> 'status' <> 'cleaned' then
        raise exception 'initial operations Phase C cleanup did not finish: %', v_cleaned;
    end if;
end
$$;
rollback;
