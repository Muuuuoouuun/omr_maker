begin;

-- The scoped service-role v2 function is the only supported feedback-open
-- boundary. The legacy SECURITY DEFINER function accepted only a public id.
drop function if exists public.omr_mark_feedback_opened(text, timestamptz);

-- Hot read paths. Composite indexes follow the equality scope columns before
-- the sort columns used by teacher live views and student history.
create index if not exists omr_exams_org_updated_id_idx
    on public.omr_exams (organization_id, updated_at desc, id);
create index if not exists omr_attempts_org_finished_id_idx
    on public.omr_attempts (organization_id, finished_at desc, id);
create index if not exists omr_attempts_org_exam_finished_id_idx
    on public.omr_attempts (organization_id, exam_id, finished_at desc, id);
create index if not exists omr_attempts_owner_finished_id_idx
    on public.omr_attempts (student_id, finished_at desc, id);
create index if not exists omr_attempts_student_completed_idx
    on public.omr_attempts (
        organization_id, student_profile_id, student_id, finished_at desc, id
    ) where status = 'completed';
create index if not exists omr_feedback_student_returned_idx
    on public.omr_attempt_feedback (
        organization_id, student_profile_id, updated_at desc, id
    ) where status = 'returned';
create index if not exists omr_students_org_user_active_idx
    on public.omr_student_profiles (organization_id, user_id)
    where user_id is not null and status in ('invited', 'active');
create index if not exists omr_class_students_active_student_idx
    on public.omr_class_students (student_profile_id, class_id)
    where enrollment_status = 'active';
create index if not exists omr_assignments_org_exam_idx
    on public.omr_assignments (organization_id, exam_id);

-- A signed student session uses an owner-bound deterministic attempt id. Save
-- the attempt and its analytical rows atomically; a retry also repairs a row
-- left partially written by the former two-query implementation.
create or replace function public.omr_submit_session_attempt_v1(
    p_attempt jsonb,
    p_question_results jsonb
)
returns table (payload jsonb)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_attempt public.omr_attempts%rowtype;
    v_stored public.omr_attempts%rowtype;
begin
    if jsonb_typeof(p_attempt) is distinct from 'object' then
        raise exception 'attempt must be an object';
    end if;
    if jsonb_typeof(p_question_results) is distinct from 'array' then
        raise exception 'question_results must be an array';
    end if;

    select * into v_attempt
      from jsonb_populate_record(null::public.omr_attempts, p_attempt);

    if nullif(btrim(v_attempt.id), '') is null
       or nullif(btrim(v_attempt.organization_id), '') is null
       or nullif(btrim(v_attempt.exam_id), '') is null
       or nullif(btrim(v_attempt.student_id), '') is null
       or v_attempt.payload is null then
        raise exception 'invalid canonical attempt';
    end if;
    if not exists (
        select 1 from public.omr_exams exam
         where exam.id = v_attempt.exam_id
           and exam.organization_id = v_attempt.organization_id
    ) then
        raise exception 'exam organization mismatch';
    end if;
    if exists (
        select 1
          from jsonb_to_recordset(p_question_results) as result(
              attempt_id text,
              exam_id text,
              organization_id text,
              student_id text
          )
         where result.attempt_id is distinct from v_attempt.id
            or result.exam_id is distinct from v_attempt.exam_id
            or result.organization_id is distinct from v_attempt.organization_id
            or result.student_id is distinct from v_attempt.student_id
    ) then
        raise exception 'question result scope mismatch';
    end if;

    insert into public.omr_attempts
    select (v_attempt).*
    on conflict (id) do nothing
    returning * into v_stored;

    if not found then
        select * into v_stored
          from public.omr_attempts
         where id = v_attempt.id
         for update;
        if v_stored.organization_id is distinct from v_attempt.organization_id
           or v_stored.exam_id is distinct from v_attempt.exam_id
           or v_stored.student_id is distinct from v_attempt.student_id
           or v_stored.student_profile_id is distinct from v_attempt.student_profile_id then
            raise exception 'attempt identifier belongs to another owner';
        end if;
    end if;

    insert into public.omr_question_results
    select *
      from jsonb_populate_recordset(
          null::public.omr_question_results,
          p_question_results
      )
    on conflict (attempt_id, question_id) do nothing;

    return query select v_stored.payload;
end;
$$;

revoke all on function public.omr_submit_session_attempt_v1(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.omr_submit_session_attempt_v1(jsonb, jsonb) to service_role;

-- Metadata ids are global. An id can only be retried for the exact same tenant,
-- storage object and kind; a cross-tenant collision can never transfer it.
create or replace function public.omr_save_remote_asset_metadata_v1(p_asset jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_asset public.omr_remote_assets%rowtype;
    v_stored public.omr_remote_assets%rowtype;
begin
    if jsonb_typeof(p_asset) is distinct from 'object' then
        raise exception 'asset must be an object';
    end if;
    select * into v_asset
      from jsonb_populate_record(null::public.omr_remote_assets, p_asset);

    if nullif(btrim(v_asset.id), '') is null
       or nullif(btrim(v_asset.organization_id), '') is null
       or nullif(btrim(v_asset.kind), '') is null
       or nullif(btrim(v_asset.object_path), '') is null then
        raise exception 'invalid remote asset metadata';
    end if;
    if v_asset.exam_id is not null and not exists (
        select 1 from public.omr_exams exam
         where exam.id = v_asset.exam_id
           and exam.organization_id = v_asset.organization_id
    ) then
        raise exception 'asset exam organization mismatch';
    end if;
    if v_asset.attempt_id is not null and not exists (
        select 1 from public.omr_attempts attempt
         where attempt.id = v_asset.attempt_id
           and attempt.organization_id = v_asset.organization_id
    ) then
        raise exception 'asset attempt organization mismatch';
    end if;

    insert into public.omr_remote_assets
    select (v_asset).*
    on conflict (id) do update set
        exam_id = excluded.exam_id,
        attempt_id = excluded.attempt_id,
        mime_type = excluded.mime_type,
        byte_size = excluded.byte_size,
        sha256_hex = excluded.sha256_hex,
        original_name = excluded.original_name,
        created_by_user_id = excluded.created_by_user_id,
        updated_at = excluded.updated_at
    where public.omr_remote_assets.organization_id = excluded.organization_id
      and public.omr_remote_assets.object_path = excluded.object_path
      and public.omr_remote_assets.kind = excluded.kind
      and public.omr_remote_assets.storage_bucket = excluded.storage_bucket
    returning * into v_stored;

    if not found then
        raise exception 'asset identifier belongs to another scope';
    end if;
    return to_jsonb(v_stored);
end;
$$;

revoke all on function public.omr_save_remote_asset_metadata_v1(jsonb) from public, anon, authenticated;
grant execute on function public.omr_save_remote_asset_metadata_v1(jsonb) to service_role;

-- Guard the conflict itself, not only the preflight read, so concurrent saves
-- from different organizations cannot transfer an exam id.
create or replace function public.omr_save_exam_v1(
    p_exam jsonb,
    p_questions jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_exam public.omr_exams%rowtype;
    v_stored public.omr_exams%rowtype;
begin
    if jsonb_typeof(p_exam) is distinct from 'object' then
        raise exception 'exam must be an object';
    end if;
    if jsonb_typeof(p_questions) is distinct from 'array' then
        raise exception 'questions must be an array';
    end if;
    select * into v_exam
      from jsonb_populate_record(null::public.omr_exams, p_exam);
    if nullif(trim(v_exam.id), '') is null
       or nullif(trim(v_exam.organization_id), '') is null
       or nullif(trim(v_exam.title), '') is null
       or v_exam.payload is null then
        raise exception 'invalid canonical exam';
    end if;
    if exists (
        select 1
          from jsonb_to_recordset(p_questions) as question(
              exam_id text,
              organization_id text
          )
         where question.exam_id is distinct from v_exam.id
            or question.organization_id is distinct from v_exam.organization_id
    ) then
        raise exception 'exam question scope mismatch';
    end if;

    insert into public.omr_exams (
        id, organization_id, class_id, title, payload, created_by_user_id,
        created_at, updated_at, archived
    ) values (
        v_exam.id, v_exam.organization_id, v_exam.class_id, v_exam.title,
        v_exam.payload, v_exam.created_by_user_id,
        coalesce(v_exam.created_at, now()), coalesce(v_exam.updated_at, now()),
        coalesce(v_exam.archived, false)
    )
    on conflict (id) do update set
        class_id = excluded.class_id,
        title = excluded.title,
        payload = excluded.payload,
        created_by_user_id = excluded.created_by_user_id,
        updated_at = excluded.updated_at,
        archived = excluded.archived
    where public.omr_exams.organization_id = excluded.organization_id
    returning * into v_stored;

    if not found then
        raise exception 'exam identifier belongs to another organization';
    end if;

    delete from public.omr_exam_questions where exam_id = v_exam.id;
    insert into public.omr_exam_questions (
        id, organization_id, class_id, exam_id, question_id, question_number,
        canonical_question_id, label, subject, unit, concept, skill, source,
        difficulty, cognitive_level, mistake_types, prerequisites,
        expected_time_sec, choices, correct_answer, score, pdf_page,
        pdf_location, pdf_region, has_pdf_region, asset_status, image_asset_ref,
        payload, created_at, updated_at
    )
    select
        question.id, question.organization_id, question.class_id,
        question.exam_id, question.question_id, question.question_number,
        question.canonical_question_id, question.label, question.subject,
        question.unit, question.concept, question.skill, question.source,
        question.difficulty, question.cognitive_level,
        coalesce(question.mistake_types, '{}'::text[]),
        coalesce(question.prerequisites, '{}'::text[]),
        question.expected_time_sec, coalesce(question.choices, 5),
        question.correct_answer, coalesce(question.score, 0), question.pdf_page,
        question.pdf_location, question.pdf_region,
        coalesce(question.has_pdf_region, false),
        coalesce(question.asset_status, 'metadata_only'),
        question.image_asset_ref, question.payload,
        coalesce(question.created_at, now()), coalesce(question.updated_at, now())
      from jsonb_populate_recordset(
          null::public.omr_exam_questions,
          p_questions
      ) as question;

    return v_stored.payload;
end;
$$;

revoke all on function public.omr_save_exam_v1(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.omr_save_exam_v1(jsonb, jsonb) to service_role;

-- Serialize whole-roster snapshots per organization while retaining the
-- already-deployed implementation as a private helper.
alter function public.omr_save_roster_v1(text, jsonb, jsonb, jsonb, jsonb)
    rename to omr_save_roster_unlocked_v1;
revoke all on function public.omr_save_roster_unlocked_v1(text, jsonb, jsonb, jsonb, jsonb)
    from public, anon, authenticated, service_role;

create function public.omr_save_roster_v1(
    p_organization_id text,
    p_classes jsonb,
    p_students jsonb,
    p_enrollments jsonb,
    p_invites jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
    if nullif(btrim(p_organization_id), '') is null then
        raise exception 'organization_id is required';
    end if;
    perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('omr_roster:' || btrim(p_organization_id), 0)
    );
    return public.omr_save_roster_unlocked_v1(
        p_organization_id, p_classes, p_students, p_enrollments, p_invites
    );
end;
$$;

revoke all on function public.omr_save_roster_v1(text, jsonb, jsonb, jsonb, jsonb)
    from public, anon, authenticated;
grant execute on function public.omr_save_roster_v1(text, jsonb, jsonb, jsonb, jsonb)
    to service_role;

-- Empty result arrays are replacements too. Delete first on every update so a
-- regrade cannot leave stale analytical rows behind.
create or replace function public.omr_teacher_update_attempt_v1(
    p_organization_id text,
    p_attempt jsonb,
    p_question_results jsonb
)
returns table (payload jsonb)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_existing public.omr_attempts%rowtype;
    v_attempt public.omr_attempts%rowtype;
    v_stored public.omr_attempts%rowtype;
begin
    if nullif(trim(p_organization_id), '') is null then
        raise exception 'organization_id is required';
    end if;
    if jsonb_typeof(p_attempt) is distinct from 'object' then
        raise exception 'attempt must be an object';
    end if;
    if jsonb_typeof(p_question_results) is distinct from 'array' then
        raise exception 'question_results must be an array';
    end if;
    select * into v_attempt
      from jsonb_populate_record(null::public.omr_attempts, p_attempt);
    select * into v_existing
      from public.omr_attempts
     where id = v_attempt.id
       and organization_id = trim(p_organization_id)
     for update;
    if not found then
        raise exception 'attempt is outside teacher organization';
    end if;
    if v_attempt.exam_id <> v_existing.exam_id then
        raise exception 'attempt exam is immutable';
    end if;
    if v_attempt.organization_id is distinct from trim(p_organization_id) then
        raise exception 'attempt organization mismatch';
    end if;
    if exists (
        select 1
          from jsonb_to_recordset(p_question_results) as result(
              attempt_id text, exam_id text, organization_id text
          )
         where result.attempt_id is distinct from v_existing.id
            or result.exam_id is distinct from v_existing.exam_id
            or result.organization_id is distinct from trim(p_organization_id)
    ) then
        raise exception 'question result scope mismatch';
    end if;

    update public.omr_attempts
       set status = v_attempt.status,
           score = v_attempt.score,
           total_score = v_attempt.total_score,
           score_percent = v_attempt.score_percent,
           payload = v_attempt.payload,
           finished_at = v_attempt.finished_at
     where id = v_existing.id
       and organization_id = trim(p_organization_id)
    returning * into v_stored;

    delete from public.omr_question_results
     where attempt_id = v_existing.id
       and organization_id = trim(p_organization_id);
    if jsonb_array_length(p_question_results) > 0 then
        insert into public.omr_question_results
        select * from jsonb_populate_recordset(
            null::public.omr_question_results,
            p_question_results
        );
    end if;
    return query select v_stored.payload;
end;
$$;

revoke all on function public.omr_teacher_update_attempt_v1(text, jsonb, jsonb)
    from public, anon, authenticated;
grant execute on function public.omr_teacher_update_attempt_v1(text, jsonb, jsonb)
    to service_role;

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
begin
    v_attempt_rpc := pg_catalog.to_regprocedure('public.omr_submit_attempt_v1(text,jsonb,jsonb)') is not null;
    v_session_attempt_rpc := pg_catalog.to_regprocedure('public.omr_submit_session_attempt_v1(jsonb,jsonb)') is not null;
    v_teacher_exam_rpc := pg_catalog.to_regprocedure('public.omr_save_exam_v1(jsonb,jsonb)') is not null;
    v_teacher_exam_delete_rpc := pg_catalog.to_regprocedure('public.omr_delete_exam_v1(text,text)') is not null;
    v_teacher_attempt_rpc := pg_catalog.to_regprocedure('public.omr_teacher_update_attempt_v1(text,jsonb,jsonb)') is not null;
    v_teacher_roster_rpc := pg_catalog.to_regprocedure('public.omr_save_roster_v1(text,jsonb,jsonb,jsonb,jsonb)') is not null;
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

    return jsonb_build_object(
        'version', '202607140018',
        'attemptRpc', v_attempt_rpc,
        'sessionAttemptRpc', v_session_attempt_rpc,
        'teacherExamRpc', v_teacher_exam_rpc,
        'teacherExamDeleteRpc', v_teacher_exam_delete_rpc,
        'teacherAttemptRpc', v_teacher_attempt_rpc,
        'teacherRosterRpc', v_teacher_roster_rpc,
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
        'ready', v_attempt_rpc
            and v_session_attempt_rpc
            and v_teacher_exam_rpc
            and v_teacher_exam_delete_rpc
            and v_teacher_attempt_rpc
            and v_teacher_roster_rpc
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
    );
end;
$$;

revoke all on function public.omr_service_readiness_v1() from public, anon, authenticated;
grant execute on function public.omr_service_readiness_v1() to service_role;

commit;
