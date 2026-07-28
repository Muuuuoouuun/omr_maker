begin;

create or replace function public.omr_answer_attempt_question_v1(
    p_organization_id text,
    p_attempt_id text,
    p_question_id text,
    p_answer text
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

    -- A network retry with the same answer is a true no-op: the first
    -- authoritative timestamp remains stable.
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
            'createdAt', clock_timestamp()
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
    p_status text
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

    v_answer := v_attempt.payload #> array[
        'subQuestionAnswers',
        v_question_id,
        v_subquestion_id
    ];
    if jsonb_typeof(v_answer) is distinct from 'object' then
        raise exception 'attempt subquestion not found';
    end if;

    -- Preserve the first reviewedAt value across idempotent retries.
    if v_answer ->> 'reviewStatus' = p_status then
        return query select v_attempt.payload;
        return;
    end if;

    if p_status = 'reviewed' then
        v_answer := v_answer || jsonb_build_object(
            'reviewStatus', 'reviewed',
            'reviewedAt', clock_timestamp()
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
    p_finished_at timestamptz
)
returns table (payload jsonb)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_attempt_id text;
    v_expected_count integer;
    v_found_count integer;
begin
    if nullif(trim(p_organization_id), '') is null
        or p_attempt_ids is null
        or cardinality(p_attempt_ids) = 0
        or cardinality(p_attempt_ids) > 100
        or p_finished_at is null
        or p_finished_at > clock_timestamp() + interval '5 minutes'
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
    if v_expected_count is distinct from cardinality(p_attempt_ids) then
        raise exception 'duplicate attempt id';
    end if;

    -- Ordered row locks make overlapping bulk requests deterministic.
    for v_attempt_id in
        select attempt.id
          from public.omr_attempts attempt
         where attempt.id = any(p_attempt_ids)
         order by attempt.id
         for update
    loop
        null;
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
           and (
               p_finished_at < attempt.started_at
               or (
                   attempt.class_id is not null
                   and not exists (
                       select 1
                         from public.omr_classes class
                        where class.id = attempt.class_id
                          and class.organization_id = trim(p_organization_id)
                   )
               )
           )
    ) then
        raise exception 'attempt class scope mismatch';
    end if;

    update public.omr_attempts attempt
       set status = 'completed',
           finished_at = p_finished_at,
           payload = jsonb_set(
               jsonb_set(
                   jsonb_set(attempt.payload, '{status}', '"completed"'::jsonb, true),
                   '{finishedAt}',
                   to_jsonb(p_finished_at),
                   true
               ),
               '{autoSubmitted}',
               'true'::jsonb,
               true
           )
     where attempt.id = any(p_attempt_ids)
       and attempt.organization_id = trim(p_organization_id)
       and attempt.status = 'in_progress';

    return query
    select attempt.payload
      from public.omr_attempts attempt
     where attempt.id = any(p_attempt_ids)
       and attempt.organization_id = trim(p_organization_id)
     order by array_position(p_attempt_ids, attempt.id);
end;
$$;

revoke all on function public.omr_answer_attempt_question_v1(text, text, text, text) from public, anon, authenticated;
grant execute on function public.omr_answer_attempt_question_v1(text, text, text, text) to service_role;

revoke all on function public.omr_set_subquestion_review_v1(text, text, text, text) from public, anon, authenticated;
grant execute on function public.omr_set_subquestion_review_v1(text, text, text, text) to service_role;

revoke all on function public.omr_force_finish_attempts_v1(text, text[], timestamptz) from public, anon, authenticated;
grant execute on function public.omr_force_finish_attempts_v1(text, text[], timestamptz) to service_role;

drop function if exists public.omr_teacher_update_attempt_v1(text, jsonb, jsonb);

commit;
