-- Make durable pre-submit sessions visible and teacher-force-finishable without
-- exposing immutable grading snapshots or student answer values to browsers.

begin;

create index if not exists omr_attempt_sessions_teacher_live_idx
    on public.omr_attempt_sessions (organization_id, exam_id, id)
    include (attempt_id, assignment_id, owner_student_id, student_name,
             identity_type, started_at, deadline_at, last_heartbeat_at, revision)
    where status = 'in_progress';

create or replace function public.omr_teacher_attempt_read_allowed_v1(
    p_organization_id text,
    p_actor_user_id text,
    p_member_role text,
    p_class_id text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select case
        when p_member_role in ('owner', 'admin') then true
        when p_member_role not in ('teacher', 'assistant')
          or nullif(pg_catalog.btrim(p_class_id), '') is null then false
        else exists (
            select 1
              from public.omr_class_teachers assignment
             where assignment.organization_id = pg_catalog.btrim(p_organization_id)
               and assignment.class_id = pg_catalog.btrim(p_class_id)
               and assignment.teacher_user_id = pg_catalog.btrim(p_actor_user_id)
               and assignment.class_role in ('lead', 'co_teacher', 'grader')
        )
    end;
$$;

create or replace function public.omr_list_active_attempt_sessions_v1(
    p_organization_id text,
    p_exam_id text,
    p_actor_user_id text,
    p_member_role text,
    p_limit integer
)
returns table (
    session_id text,
    attempt_id text,
    exam_id text,
    class_id text,
    assignment_id text,
    owner_student_id text,
    student_profile_id text,
    student_name text,
    identity_type text,
    started_at timestamptz,
    deadline_at timestamptz,
    last_heartbeat_at timestamptz,
    revision bigint,
    answered_count integer,
    total_question_count integer,
    current_question_id integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
    if nullif(pg_catalog.btrim(p_organization_id), '') is null
       or nullif(pg_catalog.btrim(p_exam_id), '') is null
       or nullif(pg_catalog.btrim(p_actor_user_id), '') is null
       or p_member_role not in ('owner', 'admin', 'teacher', 'assistant')
       or p_limit is null or p_limit not between 1 and 101 then
        raise exception 'invalid active attempt session list';
    end if;

    return query
    select attempt_session.id,
           attempt_session.attempt_id,
           attempt_session.exam_id,
           coalesce(assignment.class_id, exam.class_id),
           attempt_session.assignment_id,
           attempt_session.owner_student_id,
           case when attempt_session.identity_type = 'registered'
                then attempt_session.owner_student_id else null end,
           attempt_session.student_name,
           attempt_session.identity_type,
           attempt_session.started_at,
           attempt_session.deadline_at,
           attempt_session.last_heartbeat_at,
           attempt_session.revision,
           coalesce((
               select count(*)::integer
                 from pg_catalog.jsonb_each(attempt_session.answers) answer_entry
                where answer_entry.value <> 'null'::jsonb
                  and answer_entry.value <> '0'::jsonb
           ), 0),
           pg_catalog.cardinality(attempt_session.allowed_question_ids),
           case
               when coalesce(attempt_session.progress_payload ->> 'currentQuestionId', '') ~ '^[1-9][0-9]*$'
               then (attempt_session.progress_payload ->> 'currentQuestionId')::integer
               else null
           end
      from public.omr_attempt_sessions attempt_session
      join public.omr_exams exam
        on exam.id = attempt_session.exam_id
       and exam.organization_id = attempt_session.organization_id
      left join public.omr_assignments assignment
        on assignment.id = attempt_session.assignment_id
       and assignment.organization_id = attempt_session.organization_id
       and assignment.exam_id = attempt_session.exam_id
     where attempt_session.organization_id = pg_catalog.btrim(p_organization_id)
       and attempt_session.exam_id = pg_catalog.btrim(p_exam_id)
       and attempt_session.status = 'in_progress'
       and public.omr_teacher_attempt_read_allowed_v1(
           p_organization_id, p_actor_user_id, p_member_role,
           coalesce(assignment.class_id, exam.class_id)
       )
     order by attempt_session.id
     limit p_limit;
end;
$$;

-- Trusted-server-only rich read. Its snapshot and answer fields are never part
-- of the browser DTO; the subsequent commit rechecks every value under lock.
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
           attempt_session.progress_payload, attempt_session.status,
           attempt_session.submitted_attempt_id
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
     order by pg_catalog.array_position(p_session_ids, attempt_session.id);
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
            where not ((item ->> 'session_id') = any(p_session_ids))
              or pg_catalog.jsonb_typeof(item -> 'expected_revision') is distinct from 'number'
              or pg_catalog.jsonb_typeof(item -> 'expected_answers') is distinct from 'object'
              or pg_catalog.jsonb_typeof(item -> 'expected_sub_question_answers') is distinct from 'object'
              or pg_catalog.jsonb_typeof(item -> 'expected_grading_snapshot') is distinct from 'object'
              or pg_catalog.jsonb_typeof(item -> 'expected_allowed_question_ids') is distinct from 'array'
              or pg_catalog.jsonb_typeof(item -> 'attempt') is distinct from 'object'
              or pg_catalog.jsonb_typeof(item -> 'question_result_rows') is distinct from 'array'
       ) then
        raise exception 'invalid teacher force finish session gradings';
    end if;

    -- Deterministic row-lock order serializes student submit/checkpoint, two
    -- teachers, and response-loss retries around one canonical attempt id.
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

    for v_session in
        select attempt_session.*
          from public.omr_attempt_sessions attempt_session
         where attempt_session.id = any(p_session_ids)
         order by pg_catalog.array_position(p_session_ids, attempt_session.id)
    loop
        select item into v_grading
          from pg_catalog.jsonb_array_elements(p_gradings) item
         where item ->> 'session_id' = v_session.id;

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
        select coalesce(assignment.class_id, exam.class_id) into v_class_id
          from public.omr_exams exam
          left join public.omr_assignments assignment
            on assignment.id = v_session.assignment_id
           and assignment.organization_id = v_session.organization_id
         where exam.id = v_session.exam_id
           and exam.organization_id = v_session.organization_id;
        if v_session.revision is distinct from (v_grading ->> 'expected_revision')::bigint
           or v_session.answers is distinct from v_grading -> 'expected_answers'
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

comment on function public.omr_list_active_attempt_sessions_v1(text,text,text,text,integer)
    is 'teacher-live-session-projection:202608060020';
comment on function public.omr_force_finish_attempt_sessions_v1(text,text[],timestamptz,text,text,text,jsonb)
    is 'teacher-live-session-force-finish:202608060020';

revoke all on function public.omr_teacher_attempt_read_allowed_v1(text,text,text,text) from public, anon, authenticated;
grant execute on function public.omr_teacher_attempt_read_allowed_v1(text,text,text,text) to service_role;
revoke all on function public.omr_list_active_attempt_sessions_v1(text,text,text,text,integer) from public, anon, authenticated;
grant execute on function public.omr_list_active_attempt_sessions_v1(text,text,text,text,integer) to service_role;
revoke all on function public.omr_prepare_teacher_force_finish_sessions_v1(text,text[],text,text) from public, anon, authenticated;
grant execute on function public.omr_prepare_teacher_force_finish_sessions_v1(text,text[],text,text) to service_role;
revoke all on function public.omr_force_finish_attempt_sessions_v1(text,text[],timestamptz,text,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.omr_force_finish_attempt_sessions_v1(text,text[],timestamptz,text,text,text,jsonb) to service_role;

commit;
