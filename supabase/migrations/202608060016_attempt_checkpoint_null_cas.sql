begin;

-- Runtime callers can still send NULL despite the TypeScript contract. In
-- PostgreSQL, `value <> NULL` evaluates to NULL rather than TRUE, so reject
-- missing CAS tokens before acquiring a lock and compare locked values with
-- NULL-safe semantics as a second line of defense.
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
    v_lease_seconds integer := least(greatest(coalesce(p_lease_seconds, 45), 30), 120);
begin
    if p_expected_revision is null
       or p_expected_lease_epoch is null
       or p_expected_revision < 1
       or p_expected_lease_epoch < 1
       or jsonb_typeof(p_answers) is distinct from 'object'
       or jsonb_typeof(p_sub_question_answers) is distinct from 'object'
       or jsonb_typeof(p_progress_payload) is distinct from 'object'
       or pg_column_size(p_answers) > 65536
       or pg_column_size(p_sub_question_answers) > 524288
       or pg_column_size(p_progress_payload) > 524288
       or (select count(*) from jsonb_object_keys(p_answers)) > 500 then
        raise exception 'invalid attempt session checkpoint';
    end if;

    select * into v_session
      from public.omr_attempt_sessions attempt_session
     where attempt_session.id = btrim(p_session_id)
     for update;
    v_now := pg_catalog.clock_timestamp();
    if not found
       or v_session.organization_id is distinct from btrim(p_organization_id)
       or v_session.owner_student_id is distinct from btrim(p_owner_student_id) then
        raise exception 'attempt session not owned';
    end if;
    if v_session.status <> 'in_progress' then raise exception 'attempt session is not active'; end if;

    for v_answer_key, v_answer_value in select key, value from jsonb_each(p_answers)
    loop
        if v_answer_key !~ '^[1-9][0-9]*$'
           or v_answer_key::integer <> all(v_session.allowed_question_ids)
           or jsonb_typeof(v_answer_value) <> 'number'
           or (v_answer_value #>> '{}')::numeric not in (1, 2, 3, 4, 5) then
            raise exception 'attempt session answer invalid';
        end if;
    end loop;
    for v_sub_answer_key in select key from jsonb_each(p_sub_question_answers)
    loop
        if v_sub_answer_key !~ '^[1-9][0-9]*$'
           or v_sub_answer_key::integer <> all(v_session.allowed_question_ids) then
            raise exception 'attempt session sub-question answer invalid';
        end if;
    end loop;

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
    if v_session.revision is distinct from p_expected_revision then
        raise exception 'attempt session revision conflict';
    end if;
    if v_session.lease_epoch is distinct from p_expected_lease_epoch
       or v_session.lease_token_hash is distinct from btrim(p_lease_token_hash)
       or v_session.lease_expires_at <= v_now then
        raise exception 'attempt session lease conflict';
    end if;

    update public.omr_attempt_sessions as attempt_session
       set answers = p_answers,
           sub_question_answers = p_sub_question_answers,
           progress_payload = p_progress_payload,
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

comment on function public.omr_checkpoint_attempt_session_v1(
    text,text,text,bigint,bigint,text,jsonb,jsonb,jsonb,integer,boolean
) is 'attempt-checkpoint-null-cas:202608060016';

revoke all on function public.omr_checkpoint_attempt_session_v1(
    text,text,text,bigint,bigint,text,jsonb,jsonb,jsonb,integer,boolean
) from public, anon, authenticated;
grant execute on function public.omr_checkpoint_attempt_session_v1(
    text,text,text,bigint,bigint,text,jsonb,jsonb,jsonb,integer,boolean
) to service_role;

commit;
