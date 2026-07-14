begin;

alter table public.omr_attempts
    add column if not exists ticket_id text;

create unique index if not exists omr_attempts_ticket_id_unique_idx
    on public.omr_attempts (ticket_id)
    where ticket_id is not null;

create or replace function public.omr_submit_attempt_v1(
    p_ticket_id text,
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
    v_inserted boolean := false;
begin
    if nullif(trim(p_ticket_id), '') is null then
        raise exception 'ticket_id is required';
    end if;
    if jsonb_typeof(p_attempt) is distinct from 'object' then
        raise exception 'attempt must be an object';
    end if;
    if jsonb_typeof(p_question_results) is distinct from 'array' then
        raise exception 'question_results must be an array';
    end if;

    select *
      into v_attempt
      from jsonb_populate_record(null::public.omr_attempts, p_attempt);
    v_attempt.ticket_id := trim(p_ticket_id);

    if v_attempt.id <> 'attempt_' || trim(p_ticket_id) then
        raise exception 'attempt id does not match ticket';
    end if;
    if nullif(trim(v_attempt.organization_id), '') is null then
        raise exception 'organization_id is required';
    end if;
    if not exists (
        select 1
          from public.omr_exams exams
         where exams.id = v_attempt.exam_id
           and exams.organization_id = v_attempt.organization_id
    ) then
        raise exception 'exam organization mismatch';
    end if;
    if exists (
        select 1
          from jsonb_to_recordset(p_question_results) as results(
              attempt_id text,
              exam_id text,
              organization_id text
          )
         where results.attempt_id is distinct from v_attempt.id
            or results.exam_id is distinct from v_attempt.exam_id
            or results.organization_id is distinct from v_attempt.organization_id
    ) then
        raise exception 'question result scope mismatch';
    end if;

    insert into public.omr_attempts
    select (v_attempt).*
    on conflict (ticket_id) where ticket_id is not null do nothing
    returning * into v_stored;

    if found then
        v_inserted := true;
    else
        select *
          into v_stored
          from public.omr_attempts
         where ticket_id = trim(p_ticket_id);
    end if;

    if v_inserted then
        insert into public.omr_question_results
        select *
          from jsonb_populate_recordset(null::public.omr_question_results, p_question_results);
    end if;

    return query select v_stored.payload;
end;
$$;

revoke all on function public.omr_submit_attempt_v1(text, jsonb, jsonb) from public;
revoke all on function public.omr_submit_attempt_v1(text, jsonb, jsonb) from anon;
revoke all on function public.omr_submit_attempt_v1(text, jsonb, jsonb) from authenticated;
grant execute on function public.omr_submit_attempt_v1(text, jsonb, jsonb) to service_role;

commit;
