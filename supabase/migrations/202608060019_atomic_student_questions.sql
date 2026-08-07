-- Serialize student question writes with teacher answers and update only the
-- selected question inside the authoritative attempt payload.

create or replace function public.omr_upsert_student_attempt_question_v1(
    p_organization_id text,
    p_owner_student_id text,
    p_attempt_id text,
    p_question_id bigint,
    p_body text,
    p_mutation_id text
)
returns table (payload jsonb)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_attempt public.omr_attempts%rowtype;
    v_body text := pg_catalog.btrim(coalesce(p_body, ''));
    v_student_questions jsonb;
    v_existing_question jsonb;
    v_question_index integer;
    v_question_number bigint;
    v_question_count integer;
    v_question jsonb;
    v_updated_questions jsonb;
    v_updated_payload jsonb;
begin
    if nullif(pg_catalog.btrim(p_organization_id), '') is null
       or length(pg_catalog.btrim(p_organization_id)) > 200
       or nullif(pg_catalog.btrim(p_owner_student_id), '') is null
       or length(pg_catalog.btrim(p_owner_student_id)) > 200
       or nullif(pg_catalog.btrim(p_attempt_id), '') is null
       or length(pg_catalog.btrim(p_attempt_id)) > 200
       or p_question_id is null
       or p_question_id < 1
       or p_question_id > 9007199254740991
       or v_body = ''
       or length(v_body) > 500
       or pg_catalog.octet_length(v_body) > 2000
       or nullif(pg_catalog.btrim(p_mutation_id), '') is null
       or length(pg_catalog.btrim(p_mutation_id)) > 200
       or pg_catalog.octet_length(pg_catalog.btrim(p_mutation_id)) > 400
    then
        raise exception 'invalid student question mutation';
    end if;

    select attempt.*
      into v_attempt
      from public.omr_attempts attempt
     where attempt.id = pg_catalog.btrim(p_attempt_id)
     for update;

    if not found
       or v_attempt.organization_id is distinct from pg_catalog.btrim(p_organization_id)
       or coalesce(v_attempt.student_profile_id, v_attempt.student_id)
            is distinct from pg_catalog.btrim(p_owner_student_id)
    then
        raise exception 'attempt not owned';
    end if;
    if pg_catalog.jsonb_typeof(v_attempt.payload -> 'questionResults') is distinct from 'array' then
        raise exception 'attempt question result not found';
    end if;

    select (result.item ->> 'questionNumber')::bigint
      into v_question_number
      from pg_catalog.jsonb_array_elements(v_attempt.payload -> 'questionResults') result(item)
     where result.item ->> 'questionId' ~ '^[0-9]+$'
       and (result.item ->> 'questionId')::numeric = p_question_id
       and result.item ->> 'questionNumber' ~ '^[0-9]+$'
       and (result.item ->> 'questionNumber')::numeric between 1 and 9007199254740991
     limit 1;
    if not found then
        raise exception 'attempt question result not found';
    end if;

    if v_attempt.payload ? 'studentQuestions' then
        if pg_catalog.jsonb_typeof(v_attempt.payload -> 'studentQuestions') is distinct from 'array' then
            raise exception 'invalid student question payload';
        end if;
        v_student_questions := v_attempt.payload -> 'studentQuestions';
    else
        v_student_questions := '[]'::jsonb;
    end if;
    v_question_count := pg_catalog.jsonb_array_length(v_student_questions);

    select (entry.ordinality - 1)::integer, entry.item
      into v_question_index, v_existing_question
      from pg_catalog.jsonb_array_elements(v_student_questions)
           with ordinality as entry(item, ordinality)
     where entry.item ->> 'questionId' ~ '^[0-9]+$'
       and (entry.item ->> 'questionId')::numeric = p_question_id
     limit 1;

    if found and v_existing_question ->> 'mutationId' = pg_catalog.btrim(p_mutation_id) then
        if v_existing_question ->> 'body' is distinct from v_body then
            raise exception 'student question mutation id reused';
        end if;
        return query select v_attempt.payload;
        return;
    end if;
    if not found and v_question_count >= 100 then
        raise exception 'student question capacity exceeded';
    end if;

    v_question := pg_catalog.jsonb_build_object(
        'questionId', p_question_id,
        'questionNumber', v_question_number,
        'body', v_body,
        'createdAt', pg_catalog.clock_timestamp(),
        'status', 'queued',
        'mutationId', pg_catalog.btrim(p_mutation_id)
    );
    if v_question_index is null then
        v_updated_questions := v_student_questions || pg_catalog.jsonb_build_array(v_question);
    else
        v_updated_questions := pg_catalog.jsonb_set(
            v_student_questions,
            array[v_question_index::text],
            v_question,
            false
        );
    end if;
    select coalesce(pg_catalog.jsonb_agg(item order by
        case when item ->> 'questionNumber' ~ '^[0-9]+$'
            then (item ->> 'questionNumber')::numeric else 9007199254740991 end,
        case when item ->> 'questionId' ~ '^[0-9]+$'
            then (item ->> 'questionId')::numeric else 9007199254740991 end
    ), '[]'::jsonb)
      into v_updated_questions
      from pg_catalog.jsonb_array_elements(v_updated_questions) item;

    v_updated_payload := v_attempt.payload
        || pg_catalog.jsonb_build_object('studentQuestions', v_updated_questions);
    update public.omr_attempts attempt
       set payload = v_updated_payload
     where attempt.id = v_attempt.id
       and attempt.organization_id = pg_catalog.btrim(p_organization_id)
    returning attempt.payload into v_updated_payload;

    return query select v_updated_payload;
end;
$$;

comment on function public.omr_upsert_student_attempt_question_v1(text,text,text,bigint,text,text)
    is 'student-question-atomic:202608060019';

revoke all on function public.omr_upsert_student_attempt_question_v1(text,text,text,bigint,text,text)
    from public, anon, authenticated;
grant execute on function public.omr_upsert_student_attempt_question_v1(text,text,text,bigint,text,text)
    to service_role;
