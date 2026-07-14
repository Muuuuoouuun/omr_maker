begin;

create or replace function public.omr_service_readiness_v1()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
    v_attempt_rpc boolean;
    v_teacher_exam_rpc boolean;
    v_teacher_attempt_rpc boolean;
    v_teacher_roster_rpc boolean;
    v_handwriting_rpc boolean;
    v_exams_force_rls boolean;
    v_attempts_force_rls boolean;
    v_question_results_force_rls boolean;
    v_student_credentials_force_rls boolean;
    v_remote_assets_force_rls boolean;
    v_roster_invites_force_rls boolean;
begin
    v_attempt_rpc := to_regprocedure('public.omr_submit_attempt_v1(text,jsonb,jsonb)') is not null;
    v_teacher_exam_rpc := to_regprocedure('public.omr_save_exam_v1(jsonb,jsonb)') is not null;
    v_teacher_attempt_rpc := to_regprocedure('public.omr_teacher_update_attempt_v1(text,jsonb,jsonb)') is not null;
    v_teacher_roster_rpc := to_regprocedure('public.omr_save_roster_v1(text,jsonb,jsonb,jsonb,jsonb)') is not null;
    v_handwriting_rpc := to_regprocedure('public.omr_attach_attempt_handwriting_v1(text,text,jsonb)') is not null;

    select coalesce(relforcerowsecurity, false) into v_exams_force_rls
      from pg_class where oid = 'public.omr_exams'::regclass;
    select coalesce(relforcerowsecurity, false) into v_attempts_force_rls
      from pg_class where oid = 'public.omr_attempts'::regclass;
    select coalesce(relforcerowsecurity, false) into v_question_results_force_rls
      from pg_class where oid = 'public.omr_question_results'::regclass;
    select coalesce(relforcerowsecurity, false) into v_student_credentials_force_rls
      from pg_class where oid = 'public.omr_student_start_credentials'::regclass;
    select coalesce(relforcerowsecurity, false) into v_remote_assets_force_rls
      from pg_class where oid = 'public.omr_remote_assets'::regclass;
    select coalesce(relforcerowsecurity, false) into v_roster_invites_force_rls
      from pg_class where oid = 'public.omr_roster_invites'::regclass;

    return jsonb_build_object(
        'version', '202607140013',
        'attemptRpc', v_attempt_rpc,
        'teacherExamRpc', v_teacher_exam_rpc,
        'teacherAttemptRpc', v_teacher_attempt_rpc,
        'teacherRosterRpc', v_teacher_roster_rpc,
        'handwritingRpc', v_handwriting_rpc,
        'examsForceRls', v_exams_force_rls,
        'attemptsForceRls', v_attempts_force_rls,
        'questionResultsForceRls', v_question_results_force_rls,
        'studentCredentialsForceRls', v_student_credentials_force_rls,
        'remoteAssetsForceRls', v_remote_assets_force_rls,
        'rosterInvitesForceRls', v_roster_invites_force_rls,
        'ready', v_attempt_rpc
            and v_teacher_exam_rpc
            and v_teacher_attempt_rpc
            and v_teacher_roster_rpc
            and v_handwriting_rpc
            and v_exams_force_rls
            and v_attempts_force_rls
            and v_question_results_force_rls
            and v_student_credentials_force_rls
            and v_remote_assets_force_rls
            and v_roster_invites_force_rls
    );
end;
$$;

revoke all on function public.omr_service_readiness_v1() from public;
revoke all on function public.omr_service_readiness_v1() from anon;
revoke all on function public.omr_service_readiness_v1() from authenticated;
grant execute on function public.omr_service_readiness_v1() to service_role;

commit;
