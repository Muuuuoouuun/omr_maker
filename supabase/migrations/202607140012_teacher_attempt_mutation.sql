begin;

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
          from jsonb_to_recordset(p_question_results) as results(
              attempt_id text,
              exam_id text,
              organization_id text
          )
         where results.attempt_id is distinct from v_existing.id
            or results.exam_id is distinct from v_existing.exam_id
            or results.organization_id is distinct from trim(p_organization_id)
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

    if jsonb_array_length(p_question_results) > 0 then
        delete from public.omr_question_results
         where attempt_id = v_existing.id
           and organization_id = trim(p_organization_id);

        insert into public.omr_question_results
        select *
          from jsonb_populate_recordset(
              null::public.omr_question_results,
              p_question_results
          );
    end if;

    return query select v_stored.payload;
end;
$$;

revoke all on function public.omr_teacher_update_attempt_v1(text, jsonb, jsonb) from public;
revoke all on function public.omr_teacher_update_attempt_v1(text, jsonb, jsonb) from anon;
revoke all on function public.omr_teacher_update_attempt_v1(text, jsonb, jsonb) from authenticated;
grant execute on function public.omr_teacher_update_attempt_v1(text, jsonb, jsonb) to service_role;

commit;
