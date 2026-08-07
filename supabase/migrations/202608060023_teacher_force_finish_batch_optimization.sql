-- Reduce the 100-session teacher force-finish commit payload and remove the
-- repeated JSON-array/session metadata lookups from the locked transaction.
-- The public v1 RPC signatures and legacy grading envelope remain compatible.

begin;

create or replace function public.omr_teacher_force_finish_fingerprint_v1(
    p_revision bigint,
    p_answers jsonb,
    p_sub_question_answers jsonb,
    p_allowed_question_ids integer[],
    p_grading_snapshot jsonb
)
returns text
language sql
immutable
set search_path = ''
as $$
    select pg_catalog.encode(
        pg_catalog.sha256(
            pg_catalog.convert_to(
                pg_catalog.jsonb_build_array(
                    p_revision,
                    p_answers,
                    p_sub_question_answers,
                    pg_catalog.to_jsonb(p_allowed_question_ids),
                    p_grading_snapshot
                )::text,
                'UTF8'
            )
        ),
        'hex'
    )
$$;

revoke all on function public.omr_teacher_force_finish_fingerprint_v1(bigint,jsonb,jsonb,integer[],jsonb)
    from public, anon, authenticated, service_role;

create or replace function public.omr_prepare_teacher_force_finish_sessions_v1(
    p_organization_id text,
    p_session_ids text[],
    p_actor_user_id text,
    p_member_role text
)
returns table (
    session_id text,
    submission_id text,
    attempt_id text,
    exam_id text,
    class_id text,
    assignment_id text,
    owner_student_id text,
    student_name text,
    identity_type text,
    started_at timestamptz,
    revision bigint,
    answers jsonb,
    sub_question_answers jsonb,
    allowed_question_ids integer[],
    grading_snapshot jsonb,
    retake_source_attempt_id text,
    retake_mode text,
    progress_payload jsonb,
    status text,
    submitted_attempt_id text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    v_expected integer;
begin
    if nullif(pg_catalog.btrim(p_organization_id), '') is null
       or nullif(pg_catalog.btrim(p_actor_user_id), '') is null
       or p_member_role not in ('owner', 'admin', 'teacher', 'assistant')
       or p_session_ids is null
       or pg_catalog.cardinality(p_session_ids) not between 1 and 100
       or exists (select 1 from pg_catalog.unnest(p_session_ids) item
                   where nullif(pg_catalog.btrim(item), '') is null) then
        raise exception 'invalid teacher force finish session prepare';
    end if;
    select count(distinct pg_catalog.btrim(item))::integer into v_expected
      from pg_catalog.unnest(p_session_ids) item;
    if v_expected is distinct from pg_catalog.cardinality(p_session_ids) then
        raise exception 'duplicate teacher force finish session';
    end if;
    if (
        select count(*)
          from public.omr_attempt_sessions attempt_session
          join public.omr_exams exam
            on exam.id = attempt_session.exam_id
           and exam.organization_id = attempt_session.organization_id
          left join public.omr_assignments assignment
            on assignment.id = attempt_session.assignment_id
           and assignment.organization_id = attempt_session.organization_id
         where attempt_session.id = any(p_session_ids)
           and attempt_session.organization_id = pg_catalog.btrim(p_organization_id)
           and attempt_session.status in ('in_progress', 'submitted')
           and public.omr_teacher_attempt_read_allowed_v1(
               p_organization_id, p_actor_user_id, p_member_role,
               coalesce(assignment.class_id, exam.class_id)
           )
    ) is distinct from v_expected then
        raise exception 'attempt class assignment denied';
    end if;

    return query
    select attempt_session.id, attempt_session.submission_id, attempt_session.attempt_id, attempt_session.exam_id,
           coalesce(assignment.class_id, exam.class_id), attempt_session.assignment_id,
           attempt_session.owner_student_id, attempt_session.student_name,
           attempt_session.identity_type, attempt_session.started_at, attempt_session.revision,
           attempt_session.answers, attempt_session.sub_question_answers,
           attempt_session.allowed_question_ids, attempt_session.grading_snapshot,
           attempt_session.retake_source_attempt_id, attempt_session.retake_mode,
           coalesce(attempt_session.progress_payload, '{}'::jsonb)
               || pg_catalog.jsonb_build_object(
                   'forceFinishFingerprint',
                   public.omr_teacher_force_finish_fingerprint_v1(
                       attempt_session.revision,
                       attempt_session.answers,
                       attempt_session.sub_question_answers,
                       attempt_session.allowed_question_ids,
                       attempt_session.grading_snapshot
                   )
               ),
           attempt_session.status, attempt_session.submitted_attempt_id
      from pg_catalog.unnest(p_session_ids) with ordinality requested(session_id, position)
      join public.omr_attempt_sessions attempt_session
        on attempt_session.id = requested.session_id
      join public.omr_exams exam
        on exam.id = attempt_session.exam_id
       and exam.organization_id = attempt_session.organization_id
      left join public.omr_assignments assignment
        on assignment.id = attempt_session.assignment_id
       and assignment.organization_id = attempt_session.organization_id
     where attempt_session.organization_id = pg_catalog.btrim(p_organization_id)
       and attempt_session.status in ('in_progress', 'submitted')
     order by requested.position;
end;
$$;

create or replace function public.omr_force_finish_attempt_sessions_v1(
    p_organization_id text,
    p_session_ids text[],
    p_finished_at timestamptz,
    p_actor_user_id text,
    p_member_role text,
    p_actor_label text,
    p_gradings jsonb
)
returns table (payload jsonb)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_session public.omr_attempt_sessions%rowtype;
    v_attempt public.omr_attempts%rowtype;
    v_class_id text;
    v_expected integer;
    v_found integer;
    v_grading jsonb;
    v_joined record;
    v_payload jsonb;
    v_result_ids integer[];
begin
    if nullif(pg_catalog.btrim(p_organization_id), '') is null
       or nullif(pg_catalog.btrim(p_actor_user_id), '') is null
       or nullif(pg_catalog.btrim(p_actor_label), '') is null
       or p_member_role not in ('owner', 'admin', 'teacher', 'assistant')
       or p_finished_at is null
       or p_finished_at > pg_catalog.clock_timestamp() + interval '5 minutes'
       or p_session_ids is null
       or pg_catalog.cardinality(p_session_ids) not between 1 and 100
       or pg_catalog.jsonb_typeof(p_gradings) is distinct from 'array'
       or exists (select 1 from pg_catalog.unnest(p_session_ids) item
                   where nullif(pg_catalog.btrim(item), '') is null) then
        raise exception 'invalid teacher force finish sessions';
    end if;
    select count(distinct pg_catalog.btrim(item))::integer into v_expected
      from pg_catalog.unnest(p_session_ids) item;
    if v_expected is distinct from pg_catalog.cardinality(p_session_ids)
       or pg_catalog.jsonb_array_length(p_gradings) is distinct from v_expected
       or (select count(distinct item ->> 'session_id')
             from pg_catalog.jsonb_array_elements(p_gradings) item) is distinct from v_expected
       or exists (
           select 1 from pg_catalog.jsonb_array_elements(p_gradings) item
            where pg_catalog.jsonb_typeof(item) is distinct from 'object'
              or not ((item ->> 'session_id') = any(p_session_ids))
              or pg_catalog.jsonb_typeof(item -> 'expected_revision') is distinct from 'number'
              or pg_catalog.jsonb_typeof(item -> 'attempt') is distinct from 'object'
              or pg_catalog.jsonb_typeof(item -> 'question_result_rows') is distinct from 'array'
              or not (
                  coalesce(item ->> 'expected_fingerprint', '') ~ '^[a-f0-9]{64}$'
                  or (
                      not (item ? 'expected_fingerprint')
                      and pg_catalog.jsonb_typeof(item -> 'expected_answers') = 'object'
                      and pg_catalog.jsonb_typeof(item -> 'expected_sub_question_answers') = 'object'
                      and pg_catalog.jsonb_typeof(item -> 'expected_grading_snapshot') = 'object'
                      and pg_catalog.jsonb_typeof(item -> 'expected_allowed_question_ids') = 'array'
                  )
              )
       ) then
        raise exception 'invalid teacher force finish session gradings';
    end if;

    -- Deterministic row-lock order preserves the original all-or-nothing CAS
    -- boundary while the materialized grading join below avoids N rescans.
    for v_session in
        select attempt_session.*
          from public.omr_attempt_sessions attempt_session
         where attempt_session.id = any(p_session_ids)
         order by attempt_session.id
         for update
    loop null; end loop;

    select count(*)::integer into v_found
      from public.omr_attempt_sessions attempt_session
     where attempt_session.id = any(p_session_ids)
       and attempt_session.organization_id = pg_catalog.btrim(p_organization_id)
       and attempt_session.status in ('in_progress', 'submitted');
    if v_found is distinct from v_expected then
        raise exception 'attempt session organization mismatch';
    end if;

    for v_class_id in
        select distinct coalesce(assignment.class_id, exam.class_id)
          from public.omr_attempt_sessions attempt_session
          join public.omr_exams exam
            on exam.id = attempt_session.exam_id
           and exam.organization_id = attempt_session.organization_id
          left join public.omr_assignments assignment
            on assignment.id = attempt_session.assignment_id
           and assignment.organization_id = attempt_session.organization_id
         where attempt_session.id = any(p_session_ids)
         order by coalesce(assignment.class_id, exam.class_id)
    loop
        if not public.omr_teacher_attempt_write_allowed_v1(
            p_organization_id, p_actor_user_id, p_member_role, v_class_id
        ) then raise exception 'attempt class assignment denied'; end if;
    end loop;

    for v_joined in
        with gradings as materialized (
            select item ->> 'session_id' as session_id, item
              from pg_catalog.jsonb_array_elements(p_gradings) item
        ), requested as materialized (
            select requested_item.session_id, requested_item.position
              from pg_catalog.unnest(p_session_ids)
                   with ordinality requested_item(session_id, position)
        )
        select attempt_session as session_row,
               coalesce(assignment.class_id, exam.class_id) as class_id,
               gradings.item as grading
          from requested
          join public.omr_attempt_sessions attempt_session
            on attempt_session.id = requested.session_id
          join gradings on gradings.session_id = attempt_session.id
          join public.omr_exams exam
            on exam.id = attempt_session.exam_id
           and exam.organization_id = attempt_session.organization_id
          left join public.omr_assignments assignment
            on assignment.id = attempt_session.assignment_id
           and assignment.organization_id = attempt_session.organization_id
         order by requested.position
    loop
        v_session := v_joined.session_row;
        v_class_id := v_joined.class_id;
        v_grading := v_joined.grading;
        if v_session.status = 'submitted' then
            if v_session.submitted_attempt_id is distinct from v_session.attempt_id
               or not exists (select 1 from public.omr_attempts stored
                                where stored.id = v_session.attempt_id
                                  and stored.organization_id = v_session.organization_id) then
                raise exception 'submitted attempt session is incomplete';
            end if;
            continue;
        end if;
        if p_finished_at < v_session.started_at then
            raise exception 'finish time precedes attempt session start';
        end if;
        if v_session.revision is distinct from (v_grading ->> 'expected_revision')::bigint then
            raise exception 'stale attempt session grading';
        end if;
        if coalesce(v_grading ->> 'expected_fingerprint', '') ~ '^[a-f0-9]{64}$' then
            if public.omr_teacher_force_finish_fingerprint_v1(
                v_session.revision,
                v_session.answers,
                v_session.sub_question_answers,
                v_session.allowed_question_ids,
                v_session.grading_snapshot
            ) is distinct from v_grading ->> 'expected_fingerprint' then
                raise exception 'stale attempt session grading';
            end if;
        elsif v_session.answers is distinct from v_grading -> 'expected_answers'
           or v_session.sub_question_answers is distinct from v_grading -> 'expected_sub_question_answers'
           or v_session.grading_snapshot is distinct from v_grading -> 'expected_grading_snapshot'
           or pg_catalog.to_jsonb(v_session.allowed_question_ids)
                is distinct from v_grading -> 'expected_allowed_question_ids' then
            raise exception 'stale attempt session grading';
        end if;

        select * into v_attempt
          from pg_catalog.jsonb_populate_record(null::public.omr_attempts, v_grading -> 'attempt');
        if v_attempt.id is distinct from v_session.attempt_id
           or v_attempt.ticket_id is distinct from v_session.submission_id
           or v_attempt.organization_id is distinct from v_session.organization_id
           or v_attempt.exam_id is distinct from v_session.exam_id
           or v_attempt.assignment_id is distinct from v_session.assignment_id
           or v_attempt.class_id is distinct from v_class_id
           or v_attempt.group_id is distinct from v_class_id
           or v_attempt.student_id is distinct from v_session.owner_student_id
           or v_attempt.student_name is distinct from v_session.student_name
           or v_attempt.identity_type is distinct from v_session.identity_type
           or v_attempt.started_at is distinct from v_session.started_at
           or v_attempt.finished_at is distinct from p_finished_at
           or v_attempt.status is distinct from 'completed'
           or v_attempt.retake_source_attempt_id is distinct from v_session.retake_source_attempt_id
           or v_attempt.retake_mode is distinct from v_session.retake_mode
           or v_attempt.retake_question_ids is distinct from (case
                when v_session.retake_source_attempt_id is null then '{}'::integer[]
                else v_session.allowed_question_ids end)
           or v_attempt.payload ->> 'id' is distinct from v_session.attempt_id
           or v_attempt.payload ->> 'examId' is distinct from v_session.exam_id
           or v_attempt.payload ->> 'organizationId' is distinct from v_session.organization_id
           or v_attempt.payload ->> 'classId' is distinct from v_class_id
           or v_attempt.payload ->> 'groupId' is distinct from v_class_id
           or v_attempt.payload ->> 'assignmentId' is distinct from v_session.assignment_id
           or v_attempt.payload ->> 'studentId' is distinct from v_session.owner_student_id
           or v_attempt.payload ->> 'studentName' is distinct from v_session.student_name
           or v_attempt.payload ->> 'identityType' is distinct from v_session.identity_type
           or (v_attempt.payload ->> 'startedAt')::timestamptz is distinct from v_session.started_at
           or (v_attempt.payload ->> 'finishedAt')::timestamptz is distinct from p_finished_at
           or v_attempt.payload -> 'answers' is distinct from v_session.answers
           or v_attempt.payload -> 'subQuestionAnswers' is distinct from v_session.sub_question_answers
           or v_attempt.payload ->> 'autoSubmitted' is distinct from 'true' then
            raise exception 'attempt session canonical force finish mismatch';
        end if;
        if v_session.identity_type = 'registered'
           and v_attempt.student_profile_id is distinct from v_session.owner_student_id then
            raise exception 'attempt session student profile mismatch';
        end if;

        if pg_catalog.jsonb_array_length(v_grading -> 'question_result_rows')
             is distinct from pg_catalog.cardinality(v_session.allowed_question_ids)
           or exists (
               select 1
                 from pg_catalog.jsonb_array_elements(v_grading -> 'question_result_rows') result
                where result ->> 'attempt_id' is distinct from v_session.attempt_id
                  or result ->> 'organization_id' is distinct from v_session.organization_id
                  or result ->> 'exam_id' is distinct from v_session.exam_id
                  or result ->> 'student_id' is distinct from v_session.owner_student_id
                  or result ->> 'class_id' is distinct from v_class_id
                  or coalesce(result ->> 'question_id', '') !~ '^[1-9][0-9]*$'
           ) then raise exception 'attempt session question result mismatch'; end if;
        select pg_catalog.array_agg(question_id order by question_id) into v_result_ids
          from (
              select distinct (result ->> 'question_id')::integer question_id
                from pg_catalog.jsonb_array_elements(v_grading -> 'question_result_rows') result
          ) ids;
        if v_result_ids is distinct from v_session.allowed_question_ids then
            raise exception 'attempt session question result scope mismatch';
        end if;

        select submitted.payload into v_payload
          from public.omr_submit_session_attempt_v1(
              v_grading -> 'attempt', v_grading -> 'question_result_rows'
          ) submitted;
        if v_payload is null then raise exception 'canonical force finish submission failed'; end if;
        update public.omr_attempt_sessions
           set status = 'submitted',
               submitted_attempt_id = v_session.attempt_id,
               submitted_at = pg_catalog.clock_timestamp(),
               updated_at = pg_catalog.clock_timestamp()
         where id = v_session.id;
    end loop;

    return query
    select stored.payload
      from pg_catalog.unnest(p_session_ids) with ordinality requested(session_id, position)
      join public.omr_attempt_sessions attempt_session on attempt_session.id = requested.session_id
      join public.omr_attempts stored on stored.id = attempt_session.submitted_attempt_id
     order by requested.position;
end;
$$;

comment on function public.omr_prepare_teacher_force_finish_sessions_v1(text,text[],text,text)
    is 'teacher-live-session-force-finish-prepare:202608060023';
comment on function public.omr_force_finish_attempt_sessions_v1(text,text[],timestamptz,text,text,text,jsonb)
    is 'teacher-live-session-force-finish:202608060023';

revoke all on function public.omr_prepare_teacher_force_finish_sessions_v1(text,text[],text,text)
    from public, anon, authenticated;
grant execute on function public.omr_prepare_teacher_force_finish_sessions_v1(text,text[],text,text)
    to service_role;
revoke all on function public.omr_force_finish_attempt_sessions_v1(text,text[],timestamptz,text,text,text,jsonb)
    from public, anon, authenticated;
grant execute on function public.omr_force_finish_attempt_sessions_v1(text,text[],timestamptz,text,text,text,jsonb)
    to service_role;

commit;
