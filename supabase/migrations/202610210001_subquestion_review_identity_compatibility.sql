-- Keep imported/deduplicated subquestion identities compatible with student
-- answers. The first colon separates the numeric parent ID; every later
-- character belongs to the subquestion ID and is used as one text[] path key.
begin;

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
        or length(v_subquestion_id) > 256
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

revoke all on function public.omr_set_subquestion_review_v1(text, text, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.omr_set_subquestion_review_v1(text, text, text, text, text, text, text) to service_role;

commit;
