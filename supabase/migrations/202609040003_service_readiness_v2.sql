begin;

create or replace function public.omr_service_readiness_v1()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_attempt_rpc boolean;
    v_session_attempt_rpc boolean;
    v_teacher_exam_rpc boolean;
    v_teacher_exam_delete_rpc boolean;
    v_teacher_attempt_rpc boolean;
    v_teacher_roster_rpc boolean;
    v_teacher_roster_revision_rpc boolean;
    v_shared_login_rate_limit_rpc boolean;
    v_handwriting_rpc boolean;
    v_feedback_save_rpc boolean;
    v_feedback_return_rpc boolean;
    v_feedback_open_rpc boolean;
    v_remote_asset_metadata_rpc boolean;
    v_query_path_indexes boolean;
    v_legacy_feedback_rpc_removed boolean;
    v_exams_force_rls boolean;
    v_attempts_force_rls boolean;
    v_question_results_force_rls boolean;
    v_student_credentials_force_rls boolean;
    v_remote_assets_force_rls boolean;
    v_roster_invites_force_rls boolean;
    v_attempt_feedback_force_rls boolean;
    v_roster_revisions_force_rls boolean;
    v_auth_rate_limits_force_rls boolean;
begin
    v_attempt_rpc := pg_catalog.to_regprocedure('public.omr_submit_attempt_v1(text,jsonb,jsonb)') is not null;
    v_session_attempt_rpc := pg_catalog.to_regprocedure('public.omr_submit_session_attempt_v1(jsonb,jsonb)') is not null;
    v_teacher_exam_rpc := pg_catalog.to_regprocedure('public.omr_save_exam_v1(jsonb,jsonb)') is not null;
    v_teacher_exam_delete_rpc := pg_catalog.to_regprocedure('public.omr_delete_exam_v1(text,text)') is not null;
    v_teacher_attempt_rpc := pg_catalog.to_regprocedure('public.omr_teacher_update_attempt_v1(text,jsonb,jsonb)') is not null;
    v_teacher_roster_rpc := pg_catalog.to_regprocedure('public.omr_save_roster_v1(text,jsonb,jsonb,jsonb,jsonb)') is not null;
    v_teacher_roster_revision_rpc := pg_catalog.to_regprocedure('public.omr_save_roster_v2(text,bigint,jsonb,jsonb,jsonb,jsonb)') is not null;
    v_shared_login_rate_limit_rpc := pg_catalog.to_regprocedure('public.omr_check_login_rate_limit_v1(text[],integer)') is not null
        and pg_catalog.to_regprocedure('public.omr_record_login_failure_v1(text[],integer,integer,integer)') is not null
        and pg_catalog.to_regprocedure('public.omr_clear_login_rate_limit_v1(text[])') is not null;
    v_handwriting_rpc := pg_catalog.to_regprocedure('public.omr_attach_attempt_handwriting_v1(text,text,jsonb)') is not null;
    v_feedback_save_rpc := pg_catalog.to_regprocedure('public.omr_save_feedback_v1(text,jsonb)') is not null;
    v_feedback_return_rpc := pg_catalog.to_regprocedure('public.omr_return_feedback_v1(text,text,timestamptz)') is not null;
    v_feedback_open_rpc := pg_catalog.to_regprocedure('public.omr_mark_feedback_opened_v2(text,text,text,timestamptz)') is not null;
    v_remote_asset_metadata_rpc := pg_catalog.to_regprocedure('public.omr_save_remote_asset_metadata_v1(jsonb)') is not null;
    v_legacy_feedback_rpc_removed := pg_catalog.to_regprocedure('public.omr_mark_feedback_opened(text,timestamptz)') is null;
    v_query_path_indexes := pg_catalog.to_regclass('public.omr_exams_org_updated_id_idx') is not null
        and pg_catalog.to_regclass('public.omr_attempts_org_finished_id_idx') is not null
        and pg_catalog.to_regclass('public.omr_attempts_org_exam_finished_id_idx') is not null
        and pg_catalog.to_regclass('public.omr_attempts_owner_finished_id_idx') is not null
        and pg_catalog.to_regclass('public.omr_feedback_student_returned_idx') is not null;

    select coalesce(relforcerowsecurity, false) into v_exams_force_rls
      from pg_catalog.pg_class where oid = 'public.omr_exams'::pg_catalog.regclass;
    select coalesce(relforcerowsecurity, false) into v_attempts_force_rls
      from pg_catalog.pg_class where oid = 'public.omr_attempts'::pg_catalog.regclass;
    select coalesce(relforcerowsecurity, false) into v_question_results_force_rls
      from pg_catalog.pg_class where oid = 'public.omr_question_results'::pg_catalog.regclass;
    select coalesce(relforcerowsecurity, false) into v_student_credentials_force_rls
      from pg_catalog.pg_class where oid = 'public.omr_student_start_credentials'::pg_catalog.regclass;
    select coalesce(relforcerowsecurity, false) into v_remote_assets_force_rls
      from pg_catalog.pg_class where oid = 'public.omr_remote_assets'::pg_catalog.regclass;
    select coalesce(relforcerowsecurity, false) into v_roster_invites_force_rls
      from pg_catalog.pg_class where oid = 'public.omr_roster_invites'::pg_catalog.regclass;
    select coalesce(relforcerowsecurity, false) into v_attempt_feedback_force_rls
      from pg_catalog.pg_class where oid = 'public.omr_attempt_feedback'::pg_catalog.regclass;
    select coalesce(relforcerowsecurity, false) into v_roster_revisions_force_rls
      from pg_catalog.pg_class where oid = 'public.omr_roster_revisions'::pg_catalog.regclass;
    select coalesce(relforcerowsecurity, false) into v_auth_rate_limits_force_rls
      from pg_catalog.pg_class where oid = 'public.omr_auth_rate_limits'::pg_catalog.regclass;

    return jsonb_build_object(
        'version', '202609040003',
        'attemptRpc', v_attempt_rpc,
        'sessionAttemptRpc', v_session_attempt_rpc,
        'teacherExamRpc', v_teacher_exam_rpc,
        'teacherExamDeleteRpc', v_teacher_exam_delete_rpc,
        'teacherAttemptRpc', v_teacher_attempt_rpc,
        'teacherRosterRpc', v_teacher_roster_rpc,
        'teacherRosterRevisionRpc', v_teacher_roster_revision_rpc,
        'sharedLoginRateLimitRpc', v_shared_login_rate_limit_rpc,
        'handwritingRpc', v_handwriting_rpc,
        'feedbackSaveRpc', v_feedback_save_rpc,
        'feedbackReturnRpc', v_feedback_return_rpc,
        'feedbackOpenRpc', v_feedback_open_rpc,
        'remoteAssetMetadataRpc', v_remote_asset_metadata_rpc,
        'queryPathIndexes', v_query_path_indexes,
        'legacyFeedbackRpcRemoved', v_legacy_feedback_rpc_removed,
        'examsForceRls', v_exams_force_rls,
        'attemptsForceRls', v_attempts_force_rls,
        'questionResultsForceRls', v_question_results_force_rls,
        'studentCredentialsForceRls', v_student_credentials_force_rls,
        'remoteAssetsForceRls', v_remote_assets_force_rls,
        'rosterInvitesForceRls', v_roster_invites_force_rls,
        'attemptFeedbackForceRls', v_attempt_feedback_force_rls,
        'rosterRevisionsForceRls', v_roster_revisions_force_rls,
        'authRateLimitsForceRls', v_auth_rate_limits_force_rls,
        'ready', v_attempt_rpc
            and v_session_attempt_rpc
            and v_teacher_exam_rpc
            and v_teacher_exam_delete_rpc
            and v_teacher_attempt_rpc
            and v_teacher_roster_rpc
            and v_teacher_roster_revision_rpc
            and v_shared_login_rate_limit_rpc
            and v_handwriting_rpc
            and v_feedback_save_rpc
            and v_feedback_return_rpc
            and v_feedback_open_rpc
            and v_remote_asset_metadata_rpc
            and v_query_path_indexes
            and v_legacy_feedback_rpc_removed
            and v_exams_force_rls
            and v_attempts_force_rls
            and v_question_results_force_rls
            and v_student_credentials_force_rls
            and v_remote_assets_force_rls
            and v_roster_invites_force_rls
            and v_attempt_feedback_force_rls
            and v_roster_revisions_force_rls
            and v_auth_rate_limits_force_rls
    );
end;
$$;

revoke all on function public.omr_service_readiness_v1() from public, anon, authenticated;
grant execute on function public.omr_service_readiness_v1() to service_role;

commit;
