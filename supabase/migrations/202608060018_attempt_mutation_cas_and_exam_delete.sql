-- Fail closed on malformed student-session CAS input, and remove durable
-- sessions before their submitted attempts when deleting an exam.

create or replace function public.omr_heartbeat_attempt_session_v1(
    p_session_id text,
    p_organization_id text,
    p_owner_student_id text,
    p_expected_lease_epoch bigint,
    p_lease_token_hash text,
    p_lease_seconds integer
)
returns table (
    session_id text,
    status text,
    revision bigint,
    lease_epoch bigint,
    deadline_at timestamptz,
    server_now timestamptz,
    submitted_attempt_id text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_now timestamptz := pg_catalog.clock_timestamp();
    v_session public.omr_attempt_sessions%rowtype;
    v_lease_seconds integer := least(greatest(coalesce(p_lease_seconds, 45), 30), 120);
begin
    if p_expected_lease_epoch is null or p_expected_lease_epoch < 1
       or p_expected_lease_epoch > 9007199254740991 then
        raise exception 'invalid attempt session expected lease epoch';
    end if;
    if nullif(pg_catalog.btrim(p_lease_token_hash), '') is null then
        raise exception 'attempt session lease token required';
    end if;

    select * into v_session
      from public.omr_attempt_sessions attempt_session
     where attempt_session.id = pg_catalog.btrim(p_session_id)
     for update;
    if not found
       or v_session.organization_id is distinct from pg_catalog.btrim(p_organization_id)
       or v_session.owner_student_id is distinct from pg_catalog.btrim(p_owner_student_id) then
        raise exception 'attempt session not owned';
    end if;
    if v_session.status <> 'in_progress' then
        return query select v_session.id, v_session.status, v_session.revision,
            v_session.lease_epoch, v_session.deadline_at, v_now, v_session.submitted_attempt_id;
        return;
    end if;
    if v_session.deadline_at + interval '30 seconds' < v_now then
        update public.omr_attempt_sessions
           set status = 'expired', updated_at = v_now
         where id = v_session.id
         returning * into v_session;
    elsif v_session.deadline_at <= v_now then
        null;
    elsif v_session.lease_epoch is distinct from p_expected_lease_epoch
       or v_session.lease_token_hash is distinct from pg_catalog.btrim(p_lease_token_hash)
       or v_session.lease_expires_at <= v_now then
        raise exception 'attempt session lease conflict';
    else
        update public.omr_attempt_sessions
           set last_heartbeat_at = v_now,
               lease_expires_at = v_now + make_interval(secs => v_lease_seconds),
               updated_at = v_now
         where id = v_session.id
         returning * into v_session;
    end if;
    return query select v_session.id, v_session.status, v_session.revision,
        v_session.lease_epoch, v_session.deadline_at, v_now, v_session.submitted_attempt_id;
end;
$$;

create or replace function public.omr_takeover_attempt_session_v1(
    p_session_id text,
    p_organization_id text,
    p_owner_student_id text,
    p_expected_revision bigint,
    p_expected_lease_epoch bigint,
    p_new_lease_token_hash text,
    p_lease_seconds integer
)
returns table (
    session_id text,
    status text,
    revision bigint,
    lease_epoch bigint,
    started_at timestamptz,
    deadline_at timestamptz,
    server_now timestamptz,
    answers jsonb,
    sub_question_answers jsonb,
    progress_payload jsonb,
    allowed_question_ids integer[],
    submitted_attempt_id text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_now timestamptz := pg_catalog.clock_timestamp();
    v_session public.omr_attempt_sessions%rowtype;
    v_lease_seconds integer := least(greatest(coalesce(p_lease_seconds, 45), 30), 120);
begin
    if p_expected_revision is null or p_expected_revision < 1
       or p_expected_revision > 9007199254740991 then
        raise exception 'invalid attempt session expected revision';
    end if;
    if p_expected_lease_epoch is null or p_expected_lease_epoch < 1
       or p_expected_lease_epoch > 9007199254740991 then
        raise exception 'invalid attempt session expected lease epoch';
    end if;
    if nullif(pg_catalog.btrim(p_new_lease_token_hash), '') is null then
        raise exception 'attempt session lease token required';
    end if;

    select * into v_session
      from public.omr_attempt_sessions attempt_session
     where attempt_session.id = pg_catalog.btrim(p_session_id)
     for update;
    if not found
       or v_session.organization_id is distinct from pg_catalog.btrim(p_organization_id)
       or v_session.owner_student_id is distinct from pg_catalog.btrim(p_owner_student_id) then
        raise exception 'attempt session not owned';
    end if;
    if v_session.status <> 'in_progress' then raise exception 'attempt session is not active'; end if;
    if v_session.deadline_at <= v_now then
        update public.omr_attempt_sessions
           set status = 'expired', updated_at = v_now
         where id = v_session.id
         returning * into v_session;
        return query select
            v_session.id, v_session.status, v_session.revision, v_session.lease_epoch,
            v_session.started_at, v_session.deadline_at, v_now, v_session.answers,
            v_session.sub_question_answers, v_session.progress_payload, v_session.allowed_question_ids,
            v_session.submitted_attempt_id;
        return;
    end if;
    if v_session.revision is distinct from p_expected_revision
       or v_session.lease_epoch is distinct from p_expected_lease_epoch then
        raise exception 'attempt session revision conflict';
    end if;
    update public.omr_attempt_sessions as attempt_session
       set lease_token_hash = pg_catalog.btrim(p_new_lease_token_hash),
           lease_epoch = attempt_session.lease_epoch + 1,
           revision = attempt_session.revision + 1,
           last_heartbeat_at = v_now,
           lease_expires_at = v_now + make_interval(secs => v_lease_seconds),
           updated_at = v_now
     where id = v_session.id
     returning * into v_session;
    return query select
        v_session.id, v_session.status, v_session.revision, v_session.lease_epoch,
        v_session.started_at, v_session.deadline_at, v_now, v_session.answers,
        v_session.sub_question_answers, v_session.progress_payload, v_session.allowed_question_ids,
        v_session.submitted_attempt_id;
end;
$$;

create or replace function public.omr_prepare_attempt_session_submit_v1(
    p_session_id text,
    p_organization_id text,
    p_owner_student_id text,
    p_expected_revision bigint,
    p_expected_lease_epoch bigint,
    p_lease_token_hash text
)
returns table (
    session_id text,
    status text,
    revision bigint,
    lease_epoch bigint,
    started_at timestamptz,
    deadline_at timestamptz,
    server_now timestamptz,
    answers jsonb,
    sub_question_answers jsonb,
    allowed_question_ids integer[],
    grading_snapshot jsonb,
    submission_id text,
    attempt_id text,
    assignment_id text,
    retake_source_attempt_id text,
    retake_mode text,
    progress_payload jsonb,
    submitted_attempt_id text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_now timestamptz := pg_catalog.clock_timestamp();
    v_session public.omr_attempt_sessions%rowtype;
begin
    if p_expected_revision is null or p_expected_revision < 1
       or p_expected_revision > 9007199254740991 then
        raise exception 'invalid attempt session expected revision';
    end if;
    if p_expected_lease_epoch is null or p_expected_lease_epoch < 1
       or p_expected_lease_epoch > 9007199254740991 then
        raise exception 'invalid attempt session expected lease epoch';
    end if;
    if nullif(pg_catalog.btrim(p_lease_token_hash), '') is null then
        raise exception 'attempt session lease token required';
    end if;

    select * into v_session
      from public.omr_attempt_sessions attempt_session
     where attempt_session.id = pg_catalog.btrim(p_session_id)
     for update;
    if not found
       or v_session.organization_id is distinct from pg_catalog.btrim(p_organization_id)
       or v_session.owner_student_id is distinct from pg_catalog.btrim(p_owner_student_id) then
        raise exception 'attempt session not owned';
    end if;
    if v_session.status = 'in_progress' then
        if v_session.deadline_at + interval '30 seconds' < v_now then
            update public.omr_attempt_sessions
               set status = 'expired', updated_at = v_now
             where id = v_session.id
             returning * into v_session;
        else
            if v_session.revision is distinct from p_expected_revision then
                raise exception 'attempt session revision conflict';
            end if;
            if v_session.lease_epoch is distinct from p_expected_lease_epoch
               or v_session.lease_token_hash is distinct from pg_catalog.btrim(p_lease_token_hash)
               or v_session.lease_expires_at <= v_now then
                raise exception 'attempt session lease conflict';
            end if;
        end if;
    end if;
    return query select
        v_session.id, v_session.status, v_session.revision, v_session.lease_epoch,
        v_session.started_at, v_session.deadline_at, v_now, v_session.answers,
        v_session.sub_question_answers, v_session.allowed_question_ids,
        v_session.grading_snapshot, v_session.submission_id, v_session.attempt_id,
        v_session.assignment_id, v_session.retake_source_attempt_id, v_session.retake_mode,
        v_session.progress_payload, v_session.submitted_attempt_id;
end;
$$;

create or replace function public.omr_commit_attempt_session_submit_v1(
    p_session_id text,
    p_organization_id text,
    p_owner_student_id text,
    p_expected_revision bigint,
    p_expected_lease_epoch bigint,
    p_lease_token_hash text,
    p_attempt jsonb,
    p_question_results jsonb
)
returns table (payload jsonb, result_status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_now timestamptz := pg_catalog.clock_timestamp();
    v_session public.omr_attempt_sessions%rowtype;
    v_attempt public.omr_attempts%rowtype;
    v_payload jsonb;
    v_result_ids integer[];
    v_canonical_attempt jsonb;
begin
    if p_expected_revision is null or p_expected_revision < 1
       or p_expected_revision > 9007199254740991 then
        raise exception 'invalid attempt session expected revision';
    end if;
    if p_expected_lease_epoch is null or p_expected_lease_epoch < 1
       or p_expected_lease_epoch > 9007199254740991 then
        raise exception 'invalid attempt session expected lease epoch';
    end if;
    if nullif(pg_catalog.btrim(p_lease_token_hash), '') is null then
        raise exception 'attempt session lease token required';
    end if;
    if pg_catalog.jsonb_typeof(p_attempt) is distinct from 'object'
       or pg_catalog.jsonb_typeof(p_question_results) is distinct from 'array'
       or pg_catalog.pg_column_size(p_attempt) > 1048576
       or pg_catalog.pg_column_size(p_question_results) > 1048576
       or pg_catalog.jsonb_array_length(p_question_results) > 500 then
        raise exception 'invalid attempt session submission';
    end if;

    select * into v_session
      from public.omr_attempt_sessions attempt_session
     where attempt_session.id = pg_catalog.btrim(p_session_id)
     for update;
    if not found
       or v_session.organization_id is distinct from pg_catalog.btrim(p_organization_id)
       or v_session.owner_student_id is distinct from pg_catalog.btrim(p_owner_student_id) then
        raise exception 'attempt session not owned';
    end if;
    if v_session.status = 'submitted' then
        return query select attempt.payload, 'submitted'::text
          from public.omr_attempts attempt
         where attempt.id = v_session.submitted_attempt_id;
        return;
    end if;
    if v_session.status <> 'in_progress' then raise exception 'attempt session is not active'; end if;
    if v_session.deadline_at + interval '30 seconds' < v_now then
        update public.omr_attempt_sessions
           set status = 'expired', updated_at = v_now
         where id = v_session.id;
        return query select null::jsonb, 'expired'::text;
        return;
    end if;
    if v_session.revision is distinct from p_expected_revision then
        raise exception 'attempt session revision conflict';
    end if;
    if v_session.lease_epoch is distinct from p_expected_lease_epoch
       or v_session.lease_token_hash is distinct from pg_catalog.btrim(p_lease_token_hash)
       or v_session.lease_expires_at <= v_now then
        raise exception 'attempt session lease conflict';
    end if;

    select * into v_attempt from pg_catalog.jsonb_populate_record(null::public.omr_attempts, p_attempt);
    if v_attempt.id is distinct from v_session.attempt_id
       or v_attempt.organization_id is distinct from v_session.organization_id
       or v_attempt.exam_id is distinct from v_session.exam_id
       or v_attempt.student_id is distinct from v_session.owner_student_id
       or v_attempt.assignment_id is distinct from v_session.assignment_id
       or v_attempt.status is distinct from 'completed'
       or v_attempt.retake_source_attempt_id is distinct from v_session.retake_source_attempt_id
       or v_attempt.retake_mode is distinct from v_session.retake_mode
       or v_attempt.retake_question_ids is distinct from (case
            when v_session.retake_source_attempt_id is null then '{}'::integer[]
            else v_session.allowed_question_ids
          end)
       or v_attempt.payload->'answers' is distinct from v_session.answers then
        raise exception 'attempt session canonical submission mismatch';
    end if;

    if exists (
        select 1
          from pg_catalog.jsonb_array_elements(p_question_results) result
         where pg_catalog.jsonb_typeof(result) is distinct from 'object'
            or (result->>'attempt_id') is distinct from v_session.attempt_id
            or coalesce(result->>'question_id', '') !~ '^[1-9][0-9]*$'
    ) then
        raise exception 'attempt session question result mismatch';
    end if;
    select pg_catalog.array_agg(question_id order by question_id) into v_result_ids
      from (
          select distinct (result->>'question_id')::integer question_id
            from pg_catalog.jsonb_array_elements(p_question_results) result
      ) ids;
    if pg_catalog.jsonb_array_length(p_question_results) <> pg_catalog.cardinality(v_session.allowed_question_ids)
       or v_result_ids is distinct from v_session.allowed_question_ids then
        raise exception 'attempt session question result scope mismatch';
    end if;

    v_canonical_attempt := p_attempt || pg_catalog.jsonb_build_object(
        'ticket_id', v_session.submission_id
    );
    select submitted.payload into v_payload
      from public.omr_submit_session_attempt_v1(v_canonical_attempt, p_question_results) submitted;
    if v_payload is null then raise exception 'attempt session canonical submission failed'; end if;

    update public.omr_attempt_sessions
       set status = 'submitted',
           submitted_attempt_id = v_session.attempt_id,
           submitted_at = v_now,
           updated_at = v_now
     where id = v_session.id;
    return query select v_payload, 'submitted'::text;
end;
$$;

create or replace function public.omr_delete_exam_v1(
    p_organization_id text,
    p_exam_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_exists boolean;
begin
    if nullif(pg_catalog.btrim(p_organization_id), '') is null
       or nullif(pg_catalog.btrim(p_exam_id), '') is null then
        raise exception 'invalid exam delete request';
    end if;
    select exists (
        select 1 from public.omr_exams exam
         where exam.id = p_exam_id and exam.organization_id = p_organization_id
         for update
    ) into v_exists;
    if not v_exists then return pg_catalog.jsonb_build_object('deleted', false); end if;

    perform public.omr_enqueue_exam_asset_cleanup_v1(
        p_organization_id, p_exam_id, '{}'::text[], 'exam_deleted'
    );
    delete from public.omr_attempt_sessions attempt_session
     where attempt_session.organization_id = p_organization_id
       and attempt_session.exam_id = p_exam_id;
    delete from public.omr_question_results result
    using public.omr_attempts attempt
     where result.attempt_id = attempt.id
       and attempt.exam_id = p_exam_id and attempt.organization_id = p_organization_id;
    delete from public.omr_attempts attempt
     where attempt.exam_id = p_exam_id and attempt.organization_id = p_organization_id;
    delete from public.omr_exam_questions question
     where question.exam_id = p_exam_id and question.organization_id = p_organization_id;
    delete from public.omr_exams exam
     where exam.id = p_exam_id and exam.organization_id = p_organization_id;
    return pg_catalog.jsonb_build_object('deleted', true);
end;
$$;

comment on function public.omr_heartbeat_attempt_session_v1(text,text,text,bigint,text,integer)
    is 'attempt-mutation-null-cas:202608060018';
comment on function public.omr_takeover_attempt_session_v1(text,text,text,bigint,bigint,text,integer)
    is 'attempt-mutation-null-cas:202608060018';
comment on function public.omr_prepare_attempt_session_submit_v1(text,text,text,bigint,bigint,text)
    is 'attempt-mutation-null-cas:202608060018';
comment on function public.omr_commit_attempt_session_submit_v1(text,text,text,bigint,bigint,text,jsonb,jsonb)
    is 'attempt-mutation-null-cas:202608060018';
comment on function public.omr_delete_exam_v1(text,text)
    is 'exam-delete-session-safe:202608060018';

revoke all on function public.omr_heartbeat_attempt_session_v1(text,text,text,bigint,text,integer)
    from public, anon, authenticated;
grant execute on function public.omr_heartbeat_attempt_session_v1(text,text,text,bigint,text,integer)
    to service_role;
revoke all on function public.omr_takeover_attempt_session_v1(text,text,text,bigint,bigint,text,integer)
    from public, anon, authenticated;
grant execute on function public.omr_takeover_attempt_session_v1(text,text,text,bigint,bigint,text,integer)
    to service_role;
revoke all on function public.omr_prepare_attempt_session_submit_v1(text,text,text,bigint,bigint,text)
    from public, anon, authenticated;
grant execute on function public.omr_prepare_attempt_session_submit_v1(text,text,text,bigint,bigint,text)
    to service_role;
revoke all on function public.omr_commit_attempt_session_submit_v1(text,text,text,bigint,bigint,text,jsonb,jsonb)
    from public, anon, authenticated;
grant execute on function public.omr_commit_attempt_session_submit_v1(text,text,text,bigint,bigint,text,jsonb,jsonb)
    to service_role;
revoke all on function public.omr_delete_exam_v1(text,text)
    from public, anon, authenticated;
grant execute on function public.omr_delete_exam_v1(text,text)
    to service_role;
