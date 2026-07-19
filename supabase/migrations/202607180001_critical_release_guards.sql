-- Enforce paid-plan limits at the canonical write boundary. Client preflight
-- remains useful feedback, but these wrappers protect direct server/RPC calls
-- and keep usage-ledger changes in the same transaction as the data write.

alter function public.omr_save_exam_v1(jsonb, jsonb)
    rename to omr_save_exam_plan_unlocked_v1;
revoke all on function public.omr_save_exam_plan_unlocked_v1(jsonb, jsonb)
    from public, anon, authenticated, service_role;

create function public.omr_save_exam_v1(
    p_exam jsonb,
    p_questions jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_exam public.omr_exams%rowtype;
    v_plan text;
    v_is_new boolean;
    v_has_subquestions boolean := false;
    v_period_start date;
    v_period_start_at timestamptz;
    v_period_end_at timestamptz;
    v_observed_used integer;
    v_allowed boolean;
begin
    if jsonb_typeof(p_exam) is distinct from 'object' then
        raise exception 'exam must be an object';
    end if;
    if jsonb_typeof(p_questions) is distinct from 'array' then
        raise exception 'questions must be an array';
    end if;

    select * into v_exam
      from jsonb_populate_record(null::public.omr_exams, p_exam);
    if nullif(btrim(v_exam.id), '') is null
       or nullif(btrim(v_exam.organization_id), '') is null
       or v_exam.payload is null then
        raise exception 'invalid canonical exam';
    end if;

    select organization.plan into v_plan
      from public.omr_organizations organization
     where organization.id = v_exam.organization_id;
    if v_plan is null then
        raise exception 'exam organization does not exist';
    end if;

    if jsonb_typeof(v_exam.payload->'questions') = 'array' then
        select exists (
            select 1
              from jsonb_array_elements(v_exam.payload->'questions') question
             where jsonb_typeof(question->'subQuestions') = 'array'
               and jsonb_array_length(question->'subQuestions') > 0
        ) into v_has_subquestions;
    end if;
    if v_plan = 'free' and v_has_subquestions then
        raise exception 'plan entitlement required';
    end if;

    select not exists (
        select 1 from public.omr_exams exam where exam.id = v_exam.id
    ) into v_is_new;

    if v_is_new and v_plan = 'free' then
        v_period_start := date_trunc('month', pg_catalog.timezone('Asia/Seoul', now()))::date;
        v_period_start_at := v_period_start::timestamp at time zone 'Asia/Seoul';
        v_period_end_at := (v_period_start + interval '1 month')::timestamp at time zone 'Asia/Seoul';

        select count(*)::integer into v_observed_used
          from public.omr_exams exam
         where exam.organization_id = v_exam.organization_id
           and exam.created_at >= v_period_start_at
           and exam.created_at < v_period_end_at;

        select reservation.allowed into v_allowed
          from public.omr_reserve_plan_usage(
              v_exam.organization_id,
              'exams',
              v_period_start,
              'exam:' || v_exam.id,
              1,
              v_observed_used,
              5
          ) reservation;
        if not coalesce(v_allowed, false) then
            raise exception 'plan exam limit exceeded';
        end if;
    end if;

    return public.omr_save_exam_plan_unlocked_v1(p_exam, p_questions);
end;
$$;

revoke all on function public.omr_save_exam_v1(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.omr_save_exam_v1(jsonb, jsonb) to service_role;

alter function public.omr_save_roster_v1(text, jsonb, jsonb, jsonb, jsonb)
    rename to omr_save_roster_plan_unlocked_v1;
revoke all on function public.omr_save_roster_plan_unlocked_v1(text, jsonb, jsonb, jsonb, jsonb)
    from public, anon, authenticated, service_role;

create function public.omr_save_roster_v1(
    p_organization_id text,
    p_classes jsonb,
    p_students jsonb,
    p_enrollments jsonb,
    p_invites jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_plan text;
    v_limit integer;
    v_student_ids text[];
    v_observed_used integer;
    v_allowed boolean;
begin
    if nullif(btrim(p_organization_id), '') is null then
        raise exception 'organization_id is required';
    end if;
    if jsonb_typeof(p_students) is distinct from 'array' then
        raise exception 'students must be an array';
    end if;

    select organization.plan into v_plan
      from public.omr_organizations organization
     where organization.id = btrim(p_organization_id);
    if v_plan is null then
        raise exception 'roster organization does not exist';
    end if;

    if v_plan in ('free', 'pro') then
        v_limit := case when v_plan = 'free' then 30 else 300 end;
        select coalesce(
            array_agg(distinct btrim(item->>'id'))
                filter (where nullif(btrim(item->>'id'), '') is not null),
            array[]::text[]
        ) into v_student_ids
          from jsonb_array_elements(p_students) item;

        select count(*)::integer into v_observed_used
          from public.omr_student_profiles student
         where student.organization_id = btrim(p_organization_id)
           and student.status in ('invited', 'active', 'inactive');

        select usage.allowed into v_allowed
          from public.omr_sync_student_plan_usage(
              btrim(p_organization_id),
              v_student_ids,
              v_observed_used,
              v_limit
          ) usage;
        if not coalesce(v_allowed, false) then
            raise exception 'plan student limit exceeded';
        end if;
    end if;

    return public.omr_save_roster_plan_unlocked_v1(
        p_organization_id, p_classes, p_students, p_enrollments, p_invites
    );
end;
$$;

revoke all on function public.omr_save_roster_v1(text, jsonb, jsonb, jsonb, jsonb)
    from public, anon, authenticated;
grant execute on function public.omr_save_roster_v1(text, jsonb, jsonb, jsonb, jsonb)
    to service_role;
