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
    readiness := public.omr_service_readiness_v1();
    if readiness ->> 'version' <> '202608080006'
       or readiness ->> 'ready' <> 'true'
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
       or readiness ->> 'operatorPilotProvisioningReady' <> 'true' then
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
        'public.omr_save_exam_v2(jsonb,jsonb,jsonb,text,bigint,text)',
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
        'public.omr_save_feedback_v2(text,jsonb,bigint,text)',
        'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role',
        'public.omr_return_feedback_v2(text,text,bigint,text)',
        'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role',
        'public.omr_save_feedback_v3(text,jsonb,bigint,text)',
        'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role',
        'public.omr_return_feedback_v3(text,text,bigint,text)',
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
    ) then
        raise exception 'production boundary exposed a retired unfenced gateway';
    end if;
end
$$;
