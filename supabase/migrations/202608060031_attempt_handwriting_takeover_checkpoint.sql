begin;

-- Keep a small canonical handwriting generation beside answers so an explicit
-- device takeover can restore it under the same revision/lease CAS fence.
create or replace function public.omr_checkpoint_attempt_session_v1(
    p_session_id text,
    p_organization_id text,
    p_owner_student_id text,
    p_expected_revision bigint,
    p_expected_lease_epoch bigint,
    p_lease_token_hash text,
    p_answers jsonb,
    p_sub_question_answers jsonb,
    p_progress_payload jsonb,
    p_lease_seconds integer,
    p_final_checkpoint boolean
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
    v_now timestamptz;
    v_session public.omr_attempt_sessions%rowtype;
    v_answer_key text;
    v_sub_answer_key text;
    v_answer_value jsonb;
    v_progress_key text;
    v_handwriting_checkpoint jsonb := p_progress_payload -> 'handwritingCheckpoint';
    v_effective_progress jsonb;
    v_page_count integer;
    v_stroke_count integer;
    v_idempotent_final_replay boolean := false;
    v_lease_seconds integer := least(greatest(coalesce(p_lease_seconds, 45), 30), 120);
begin
    if p_expected_revision is null
       or p_expected_lease_epoch is null
       or p_expected_revision < 1
       or p_expected_revision > 9007199254740991
       or p_expected_lease_epoch < 1
       or p_expected_lease_epoch > 9007199254740991
       or nullif(pg_catalog.btrim(p_lease_token_hash), '') is null
       or pg_catalog.jsonb_typeof(p_answers) is distinct from 'object'
       or pg_catalog.jsonb_typeof(p_sub_question_answers) is distinct from 'object'
       or pg_catalog.jsonb_typeof(p_progress_payload) is distinct from 'object'
       or pg_catalog.pg_column_size(p_answers) > 65536
       or pg_catalog.pg_column_size(p_sub_question_answers) > 524288
       or pg_catalog.pg_column_size(p_progress_payload) > 524288
       or (select count(*) from pg_catalog.jsonb_object_keys(p_answers)) > 500 then
        raise exception 'invalid attempt session checkpoint';
    end if;
    for v_progress_key in select key from pg_catalog.jsonb_each(p_progress_payload)
    loop
        if v_progress_key not in ('currentQuestionId', 'handwritingCheckpoint') then
            raise exception 'invalid attempt session progress payload';
        end if;
    end loop;
    if v_handwriting_checkpoint is not null then
        if pg_catalog.jsonb_typeof(v_handwriting_checkpoint) is distinct from 'object'
           or v_handwriting_checkpoint ->> 'schemaVersion' is distinct from '1'
           or pg_catalog.jsonb_typeof(v_handwriting_checkpoint -> 'drawings') is distinct from 'object'
           or pg_catalog.pg_column_size(v_handwriting_checkpoint) > 65536
           or (v_handwriting_checkpoint - 'schemaVersion' - 'drawings' - 'pageCount' - 'strokeCount') <> '{}'::jsonb
           or (v_handwriting_checkpoint ->> 'pageCount') !~ '^[0-9]+$'
           or (v_handwriting_checkpoint ->> 'strokeCount') !~ '^[0-9]+$' then
            raise exception 'invalid attempt session handwriting checkpoint';
        end if;
        if exists (
            select 1
              from pg_catalog.jsonb_object_keys(v_handwriting_checkpoint -> 'drawings') page_key
             where page_key !~ '^[1-9][0-9]{0,3}$'
                or page_key::integer > 2000
        ) or exists (
            select 1
              from pg_catalog.jsonb_each(v_handwriting_checkpoint -> 'drawings') drawing_page
             where pg_catalog.jsonb_typeof(drawing_page.value) is distinct from 'array'
        ) then
            raise exception 'invalid attempt session handwriting pages';
        end if;
        select count(*) filter (where pg_catalog.jsonb_array_length(drawing_page.value) > 0),
               coalesce(sum(pg_catalog.jsonb_array_length(drawing_page.value)), 0)
          into v_page_count, v_stroke_count
          from pg_catalog.jsonb_each(v_handwriting_checkpoint -> 'drawings') drawing_page;
        if v_page_count > 500
           or v_stroke_count > 2000
           or v_page_count <> (v_handwriting_checkpoint ->> 'pageCount')::integer
           or v_stroke_count <> (v_handwriting_checkpoint ->> 'strokeCount')::integer
           or exists (
               select 1
                 from pg_catalog.jsonb_each(v_handwriting_checkpoint -> 'drawings') drawing_page
                 cross join lateral pg_catalog.jsonb_array_elements(drawing_page.value) drawing_path
                where pg_catalog.jsonb_typeof(drawing_path) is distinct from 'string'
                   or pg_catalog.length(drawing_path #>> '{}') > 32768
           ) then
            raise exception 'invalid attempt session handwriting bounds';
        end if;
    end if;

    select * into v_session
      from public.omr_attempt_sessions attempt_session
     where attempt_session.id = pg_catalog.btrim(p_session_id)
     for update;
    v_now := pg_catalog.clock_timestamp();
    if not found
       or v_session.organization_id is distinct from pg_catalog.btrim(p_organization_id)
       or v_session.owner_student_id is distinct from pg_catalog.btrim(p_owner_student_id) then
        raise exception 'attempt session not owned';
    end if;
    if v_session.status <> 'in_progress' then
        return query select
            v_session.id, v_session.status, v_session.revision, v_session.lease_epoch,
            v_session.started_at, v_session.deadline_at, v_now, v_session.answers,
            v_session.sub_question_answers, v_session.progress_payload, v_session.allowed_question_ids,
            v_session.submitted_attempt_id;
        return;
    end if;

    for v_answer_key, v_answer_value in select key, value from pg_catalog.jsonb_each(p_answers)
    loop
        if v_answer_key !~ '^[1-9][0-9]*$'
           or v_answer_key::integer <> all(v_session.allowed_question_ids)
           or pg_catalog.jsonb_typeof(v_answer_value) <> 'number'
           or (v_answer_value #>> '{}')::numeric not in (1, 2, 3, 4, 5) then
            raise exception 'attempt session answer invalid';
        end if;
    end loop;
    for v_sub_answer_key in select key from pg_catalog.jsonb_each(p_sub_question_answers)
    loop
        if v_sub_answer_key !~ '^[1-9][0-9]*$'
           or v_sub_answer_key::integer <> all(v_session.allowed_question_ids) then
            raise exception 'attempt session sub-question answer invalid';
        end if;
    end loop;
    if p_progress_payload ? 'currentQuestionId'
       and (pg_catalog.jsonb_typeof(p_progress_payload -> 'currentQuestionId') is distinct from 'number'
            or (p_progress_payload ->> 'currentQuestionId') !~ '^[1-9][0-9]*$'
            or (p_progress_payload ->> 'currentQuestionId')::integer <> all(v_session.allowed_question_ids)) then
        raise exception 'invalid attempt session current question';
    end if;

    if v_session.deadline_at <= v_now
       and (not coalesce(p_final_checkpoint, false)
            or v_session.deadline_at + interval '30 seconds' < v_now) then
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
    if v_session.lease_epoch is distinct from p_expected_lease_epoch
       or v_session.lease_token_hash is distinct from pg_catalog.btrim(p_lease_token_hash)
       or (v_session.lease_expires_at <= v_now and not coalesce(p_final_checkpoint, false)) then
        raise exception 'attempt session lease conflict';
    end if;

    -- Omitting an over-budget generation must not erase the last safe one.
    v_effective_progress := p_progress_payload;
    if v_handwriting_checkpoint is null
       and v_session.progress_payload -> 'handwritingCheckpoint' is not null then
        v_effective_progress := v_effective_progress || pg_catalog.jsonb_build_object(
            'handwritingCheckpoint', v_session.progress_payload -> 'handwritingCheckpoint'
        );
    end if;

    if v_session.revision is distinct from p_expected_revision then
        v_idempotent_final_replay := coalesce(p_final_checkpoint, false)
            and v_session.revision = p_expected_revision + 1
            and v_session.answers is not distinct from p_answers
            and v_session.sub_question_answers is not distinct from p_sub_question_answers
            and v_session.progress_payload is not distinct from v_effective_progress;
        if not v_idempotent_final_replay then
            raise exception 'attempt session revision conflict';
        end if;
    end if;

    if v_idempotent_final_replay then
        update public.omr_attempt_sessions
           set last_heartbeat_at = v_now,
               lease_expires_at = v_now + pg_catalog.make_interval(secs => v_lease_seconds),
               updated_at = v_now
         where id = v_session.id
         returning * into v_session;
    else
        update public.omr_attempt_sessions as attempt_session
           set answers = p_answers,
               sub_question_answers = p_sub_question_answers,
               progress_payload = v_effective_progress,
               revision = attempt_session.revision + 1,
               last_heartbeat_at = v_now,
               lease_expires_at = v_now + pg_catalog.make_interval(secs => v_lease_seconds),
               updated_at = v_now
         where id = v_session.id
         returning * into v_session;
    end if;

    return query select
        v_session.id, v_session.status, v_session.revision, v_session.lease_epoch,
        v_session.started_at, v_session.deadline_at, v_now, v_session.answers,
        v_session.sub_question_answers, v_session.progress_payload, v_session.allowed_question_ids,
        v_session.submitted_attempt_id;
end;
$$;

comment on function public.omr_checkpoint_attempt_session_v1(
    text,text,text,bigint,bigint,text,jsonb,jsonb,jsonb,integer,boolean
) is 'attempt-checkpoint-null-cas:202608060016;secure-submission-outbox-replay:202608060028;handwriting-takeover-checkpoint:202608060031';

revoke all on function public.omr_checkpoint_attempt_session_v1(
    text,text,text,bigint,bigint,text,jsonb,jsonb,jsonb,integer,boolean
) from public, anon, authenticated;
grant execute on function public.omr_checkpoint_attempt_session_v1(
    text,text,text,bigint,bigint,text,jsonb,jsonb,jsonb,integer,boolean
) to service_role;

commit;
