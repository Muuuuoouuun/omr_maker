begin;

drop function if exists public.omr_answer_attempt_question_v1(text, text, text, text);
drop function if exists public.omr_set_subquestion_review_v1(text, text, text, text);
drop function if exists public.omr_force_finish_attempts_v1(text, text[], timestamptz);

create or replace function public.omr_teacher_attempt_write_allowed_v1(
    p_organization_id text,
    p_actor_user_id text,
    p_member_role text,
    p_class_id text
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
    if p_member_role in ('owner', 'admin') then
        return true;
    end if;
    if p_member_role not in ('teacher', 'assistant')
        or nullif(trim(p_class_id), '') is null
    then
        return false;
    end if;

    -- Hold the assignment through the enclosing mutation transaction so a
    -- concurrent class revocation cannot race a service-role write.
    perform 1
      from public.omr_class_teachers assignment
     where assignment.organization_id = trim(p_organization_id)
       and assignment.class_id = trim(p_class_id)
       and assignment.teacher_user_id = trim(p_actor_user_id)
       and assignment.class_role in ('lead', 'co_teacher', 'grader')
     for key share;
    return found;
end;
$$;

create or replace function public.omr_answer_attempt_question_v1(
    p_organization_id text,
    p_attempt_id text,
    p_question_id text,
    p_answer text,
    p_actor_user_id text,
    p_member_role text,
    p_actor_label text
)
returns table (payload jsonb)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_attempt public.omr_attempts%rowtype;
    v_question_index integer;
    v_question jsonb;
    v_answer text := trim(coalesce(p_answer, ''));
    v_updated_payload jsonb;
begin
    if nullif(trim(p_organization_id), '') is null
        or nullif(trim(p_attempt_id), '') is null
        or nullif(trim(p_question_id), '') is null
        or v_answer = ''
        or length(v_answer) > 500
        or nullif(trim(p_actor_user_id), '') is null
        or p_member_role not in ('owner', 'admin', 'teacher', 'assistant')
        or nullif(trim(p_actor_label), '') is null
        or length(trim(p_actor_label)) > 200
    then
        raise exception 'invalid answer mutation';
    end if;

    select attempt.*
      into v_attempt
      from public.omr_attempts attempt
     where attempt.id = trim(p_attempt_id)
     for update;

    if not found or v_attempt.organization_id is distinct from trim(p_organization_id) then
        raise exception 'attempt organization mismatch';
    end if;
    if v_attempt.class_id is not null and not exists (
        select 1
          from public.omr_classes class
         where class.id = v_attempt.class_id
           and class.organization_id = trim(p_organization_id)
    ) then
        raise exception 'attempt class scope mismatch';
    end if;
    if not public.omr_teacher_attempt_write_allowed_v1(
        p_organization_id,
        p_actor_user_id,
        p_member_role,
        v_attempt.class_id
    ) then
        raise exception 'attempt class assignment denied';
    end if;
    if jsonb_typeof(v_attempt.payload -> 'studentQuestions') is distinct from 'array' then
        raise exception 'attempt question not found';
    end if;

    select (entry.ordinality - 1)::integer, entry.item
      into v_question_index, v_question
      from jsonb_array_elements(v_attempt.payload -> 'studentQuestions')
           with ordinality as entry(item, ordinality)
     where entry.item ->> 'questionId' = trim(p_question_id)
     limit 1;

    if not found then
        raise exception 'attempt question not found';
    end if;

    if v_question ->> 'status' = 'answered'
        and v_question #>> '{answer,body}' = v_answer
    then
        return query select v_attempt.payload;
        return;
    end if;

    v_question := v_question || jsonb_build_object(
        'status', 'answered',
        'answer', jsonb_build_object(
            'body', v_answer,
            'createdAt', clock_timestamp(),
            'teacherName', trim(p_actor_label)
        )
    );
    v_updated_payload := jsonb_set(
        v_attempt.payload,
        array['studentQuestions', v_question_index::text],
        v_question,
        false
    );

    update public.omr_attempts attempt
       set payload = v_updated_payload
     where attempt.id = v_attempt.id
       and attempt.organization_id = trim(p_organization_id)
    returning attempt.payload into v_updated_payload;

    return query select v_updated_payload;
end;
$$;

create or replace function public.omr_set_subquestion_review_v1(
    p_organization_id text,
    p_attempt_id text,
    p_subquestion_id text,
    p_status text,
    p_actor_user_id text,
    p_member_role text,
    p_actor_label text
)
returns table (payload jsonb)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_attempt public.omr_attempts%rowtype;
    v_separator integer := position(':' in coalesce(p_subquestion_id, ''));
    v_question_id text;
    v_subquestion_id text;
    v_answer jsonb;
    v_updated_payload jsonb;
begin
    if nullif(trim(p_organization_id), '') is null
        or nullif(trim(p_attempt_id), '') is null
        or v_separator <= 1
        or p_status not in ('needs_review', 'reviewed')
        or nullif(trim(p_actor_user_id), '') is null
        or p_member_role not in ('owner', 'admin', 'teacher', 'assistant')
        or nullif(trim(p_actor_label), '') is null
        or length(trim(p_actor_label)) > 200
    then
        raise exception 'invalid subquestion review mutation';
    end if;
    v_question_id := trim(substring(p_subquestion_id from 1 for v_separator - 1));
    v_subquestion_id := trim(substring(p_subquestion_id from v_separator + 1));
    if v_question_id !~ '^[0-9]+$'
        or v_subquestion_id = ''
        or length(v_subquestion_id) > 100
        or position(':' in v_subquestion_id) > 0
    then
        raise exception 'invalid subquestion review mutation';
    end if;

    select attempt.*
      into v_attempt
      from public.omr_attempts attempt
     where attempt.id = trim(p_attempt_id)
     for update;

    if not found or v_attempt.organization_id is distinct from trim(p_organization_id) then
        raise exception 'attempt organization mismatch';
    end if;
    if v_attempt.class_id is not null and not exists (
        select 1
          from public.omr_classes class
         where class.id = v_attempt.class_id
           and class.organization_id = trim(p_organization_id)
    ) then
        raise exception 'attempt class scope mismatch';
    end if;
    if not public.omr_teacher_attempt_write_allowed_v1(
        p_organization_id,
        p_actor_user_id,
        p_member_role,
        v_attempt.class_id
    ) then
        raise exception 'attempt class assignment denied';
    end if;

    v_answer := v_attempt.payload #> array[
        'subQuestionAnswers',
        v_question_id,
        v_subquestion_id
    ];
    if jsonb_typeof(v_answer) is distinct from 'object' then
        raise exception 'attempt subquestion not found';
    end if;

    if v_answer ->> 'reviewStatus' = p_status then
        return query select v_attempt.payload;
        return;
    end if;

    if p_status = 'reviewed' then
        v_answer := v_answer || jsonb_build_object(
            'reviewStatus', 'reviewed',
            'reviewedAt', clock_timestamp(),
            'reviewedBy', trim(p_actor_label)
        );
    else
        v_answer := (v_answer - 'reviewedAt' - 'reviewedBy')
            || jsonb_build_object('reviewStatus', 'needs_review');
    end if;

    v_updated_payload := jsonb_set(
        v_attempt.payload,
        array['subQuestionAnswers', v_question_id, v_subquestion_id],
        v_answer,
        false
    );
    update public.omr_attempts attempt
       set payload = v_updated_payload
     where attempt.id = v_attempt.id
       and attempt.organization_id = trim(p_organization_id)
    returning attempt.payload into v_updated_payload;

    return query select v_updated_payload;
end;
$$;

create or replace function public.omr_force_finish_attempts_v1(
    p_organization_id text,
    p_attempt_ids text[],
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
    v_attempt public.omr_attempts%rowtype;
    v_attempt_id text;
    v_exam_id text;
    v_expected_count integer;
    v_found_count integer;
    v_grading jsonb;
    v_score numeric;
    v_total_score numeric;
    v_updated_payload jsonb;
begin
    if nullif(trim(p_organization_id), '') is null
        or p_attempt_ids is null
        or cardinality(p_attempt_ids) = 0
        or cardinality(p_attempt_ids) > 100
        or p_finished_at is null
        or p_finished_at > clock_timestamp() + interval '5 minutes'
        or nullif(trim(p_actor_user_id), '') is null
        or p_member_role not in ('owner', 'admin', 'teacher', 'assistant')
        or nullif(trim(p_actor_label), '') is null
        or jsonb_typeof(p_gradings) is distinct from 'array'
        or exists (
            select 1
              from unnest(p_attempt_ids) item
             where nullif(trim(item), '') is null
        )
    then
        raise exception 'invalid force finish mutation';
    end if;

    select count(distinct trim(item))
      into v_expected_count
      from unnest(p_attempt_ids) item;
    if v_expected_count is distinct from cardinality(p_attempt_ids)
        or jsonb_array_length(p_gradings) is distinct from v_expected_count
    then
        raise exception 'duplicate or missing attempt grading';
    end if;

    for v_attempt_id in
        select attempt.id
          from public.omr_attempts attempt
         where attempt.id = any(p_attempt_ids)
         order by attempt.id
         for update
    loop
        null;
    end loop;
    for v_exam_id in
        select distinct attempt.exam_id
          from public.omr_attempts attempt
         where attempt.id = any(p_attempt_ids)
         order by attempt.exam_id
    loop
        perform 1
          from public.omr_exams exam
         where exam.id = v_exam_id
         for update;
    end loop;

    select count(*)
      into v_found_count
      from public.omr_attempts attempt
     where attempt.id = any(p_attempt_ids)
       and attempt.organization_id = trim(p_organization_id);
    if v_found_count is distinct from v_expected_count then
        raise exception 'attempt organization mismatch';
    end if;
    if exists (
        select 1
          from public.omr_attempts attempt
         where attempt.id = any(p_attempt_ids)
           and attempt.organization_id = trim(p_organization_id)
           and attempt.class_id is not null
           and not exists (
               select 1
                 from public.omr_classes class
                where class.id = attempt.class_id
                  and class.organization_id = trim(p_organization_id)
           )
    ) then
        raise exception 'attempt class scope mismatch';
    end if;
    if exists (
        select 1
          from public.omr_attempts attempt
         where attempt.id = any(p_attempt_ids)
           and attempt.organization_id = trim(p_organization_id)
           and not public.omr_teacher_attempt_write_allowed_v1(
               p_organization_id,
               p_actor_user_id,
               p_member_role,
               attempt.class_id
           )
    ) then
        raise exception 'attempt class assignment denied';
    end if;
    if (
        select count(distinct grading.item ->> 'attempt_id')
          from jsonb_array_elements(p_gradings) grading(item)
    ) is distinct from v_expected_count
        or exists (
            select 1
              from jsonb_array_elements(p_gradings) grading(item)
             where nullif(grading.item ->> 'attempt_id', '') is null
                or not ((grading.item ->> 'attempt_id') = any(p_attempt_ids))
                or jsonb_typeof(grading.item -> 'expected_answers') is distinct from 'object'
                or jsonb_typeof(grading.item -> 'expected_retake_question_ids') is distinct from 'array'
                or nullif(grading.item ->> 'expected_exam_updated_at', '') is null
                or jsonb_typeof(grading.item -> 'score') is distinct from 'number'
                or jsonb_typeof(grading.item -> 'total_score') is distinct from 'number'
                or jsonb_typeof(grading.item -> 'question_results') is distinct from 'array'
                or jsonb_typeof(grading.item -> 'question_result_rows') is distinct from 'array'
        )
    then
        raise exception 'invalid canonical grading';
    end if;

    for v_attempt in
        select attempt.*
          from public.omr_attempts attempt
         where attempt.id = any(p_attempt_ids)
           and attempt.organization_id = trim(p_organization_id)
         order by attempt.id
    loop
        select grading.item
          into v_grading
          from jsonb_array_elements(p_gradings) grading(item)
         where grading.item ->> 'attempt_id' = v_attempt.id;

        -- Completed rows are the idempotency record. A retry returns them
        -- unchanged even if its requested finish time is later.
        if v_attempt.status <> 'in_progress' then
            continue;
        end if;
        if p_finished_at < v_attempt.started_at then
            raise exception 'finish time precedes attempt start';
        end if;
        if v_attempt.payload -> 'answers' is distinct from v_grading -> 'expected_answers'
            or to_jsonb(v_attempt.retake_question_ids) is distinct from v_grading -> 'expected_retake_question_ids'
        then
            raise exception 'stale canonical attempt grading';
        end if;
        if not exists (
            select 1
              from public.omr_exams exam
             where exam.id = v_attempt.exam_id
               and exam.organization_id = trim(p_organization_id)
               and exam.updated_at = (v_grading ->> 'expected_exam_updated_at')::timestamptz
        ) then
            raise exception 'stale canonical exam grading';
        end if;

        v_score := (v_grading ->> 'score')::numeric;
        v_total_score := (v_grading ->> 'total_score')::numeric;
        if v_score < 0 or v_total_score < 0 or v_score > v_total_score then
            raise exception 'invalid canonical score';
        end if;
        if exists (
            select 1
              from jsonb_to_recordset(v_grading -> 'question_result_rows') as result(
                  id text,
                  organization_id text,
                  class_id text,
                  attempt_id text,
                  exam_id text,
                  question_id integer
              )
             where result.attempt_id is distinct from v_attempt.id
                or result.exam_id is distinct from v_attempt.exam_id
                or result.organization_id is distinct from trim(p_organization_id)
                or result.class_id is distinct from v_attempt.class_id
                or result.id is distinct from v_attempt.id || ':' || result.question_id::text
        ) then
            raise exception 'question result scope mismatch';
        end if;

        v_updated_payload := jsonb_set(
            jsonb_set(
                jsonb_set(
                    jsonb_set(
                        jsonb_set(
                            jsonb_set(v_attempt.payload, '{status}', '"completed"'::jsonb, true),
                            '{finishedAt}',
                            to_jsonb(p_finished_at),
                            true
                        ),
                        '{autoSubmitted}',
                        'true'::jsonb,
                        true
                    ),
                    '{score}',
                    to_jsonb(v_score),
                    true
                ),
                '{totalScore}',
                to_jsonb(v_total_score),
                true
            ),
            '{questionResults}',
            v_grading -> 'question_results',
            true
        );

        update public.omr_attempts attempt
           set status = 'completed',
               finished_at = p_finished_at,
               score = v_score,
               total_score = v_total_score,
               score_percent = case
                   when v_total_score > 0 then round(v_score * 100 / v_total_score, 2)
                   else 0
               end,
               payload = v_updated_payload
         where attempt.id = v_attempt.id
           and attempt.organization_id = trim(p_organization_id)
           and attempt.status = 'in_progress';

        delete from public.omr_question_results result
         where result.attempt_id = v_attempt.id
           and result.organization_id = trim(p_organization_id);
        insert into public.omr_question_results
        select *
          from jsonb_populate_recordset(
              null::public.omr_question_results,
              v_grading -> 'question_result_rows'
          );
    end loop;

    return query
    select attempt.payload
      from public.omr_attempts attempt
     where attempt.id = any(p_attempt_ids)
       and attempt.organization_id = trim(p_organization_id)
     order by array_position(p_attempt_ids, attempt.id);
end;
$$;

revoke all on function public.omr_teacher_attempt_write_allowed_v1(text, text, text, text) from public, anon, authenticated;
grant execute on function public.omr_teacher_attempt_write_allowed_v1(text, text, text, text) to service_role;

revoke all on function public.omr_answer_attempt_question_v1(text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.omr_answer_attempt_question_v1(text, text, text, text, text, text, text) to service_role;

revoke all on function public.omr_set_subquestion_review_v1(text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.omr_set_subquestion_review_v1(text, text, text, text, text, text, text) to service_role;

revoke all on function public.omr_force_finish_attempts_v1(text, text[], timestamptz, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.omr_force_finish_attempts_v1(text, text[], timestamptz, text, text, text, jsonb) to service_role;

drop function if exists public.omr_teacher_update_attempt_v1(text, jsonb, jsonb);

commit;
