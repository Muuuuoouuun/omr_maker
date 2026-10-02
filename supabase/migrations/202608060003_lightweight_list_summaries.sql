begin;

-- Migration 002 is immutable history, but exam duplication is not part of the
-- initial release. Upgrades must remove the retired lifecycle RPCs.
drop function if exists public.omr_create_exam_clone_target_v1(text, text, text, text, text);
drop function if exists public.omr_cleanup_exam_clone_target_v1(text, text, text);

drop index if exists public.omr_attempts_owner_id_idx;
create index omr_attempts_owner_id_idx
    on public.omr_attempts (organization_id, student_id, id);

-- List reads need question state and timestamps for dashboard counts and
-- notifications, but never the student's or teacher's free-text bodies.
create or replace function public.omr_student_question_summaries_v1(p_payload jsonb)
returns jsonb
language sql immutable parallel safe
set search_path = ''
as $$
    select coalesce(
        jsonb_agg(
            jsonb_strip_nulls(jsonb_build_object(
                'questionId', note -> 'questionId',
                'questionNumber', note -> 'questionNumber',
                'body', '',
                'createdAt', case
                    when jsonb_typeof(note -> 'createdAt') = 'string' then note ->> 'createdAt'
                    else ''
                end,
                'status', case when note ->> 'status' = 'answered' then 'answered' else 'queued' end,
                'answer', case
                    when jsonb_typeof(note -> 'answer') = 'object' then
                        jsonb_strip_nulls(jsonb_build_object(
                            'body', '',
                            'createdAt', case
                                when jsonb_typeof(note #> '{answer,createdAt}') = 'string'
                                    then note #>> '{answer,createdAt}'
                                else ''
                            end
                        ))
                    else null
                end
            )) order by ordinal
        ),
        '[]'::jsonb
    )
    from jsonb_array_elements(
        case
            when jsonb_typeof(p_payload -> 'studentQuestions') = 'array'
                then p_payload -> 'studentQuestions'
            else '[]'::jsonb
        end
    ) with ordinality as questions(note, ordinal)
    where jsonb_typeof(note) = 'object'
      and jsonb_typeof(note -> 'questionId') = 'number'
      and jsonb_typeof(note -> 'questionNumber') = 'number';
$$;

-- Teacher list analytics need only bounded scalar metadata. Authoring prose,
-- sub-questions, crop coordinates, and asset references never enter this DTO.
create or replace function public.omr_exam_question_summaries_v1(p_payload jsonb)
returns jsonb
language sql immutable parallel safe
set search_path = ''
as $$
    select coalesce(
        jsonb_agg(
            jsonb_strip_nulls(jsonb_build_object(
                'id', case when jsonb_typeof(question -> 'id') = 'number' then question -> 'id' else null end,
                'number', case when jsonb_typeof(question -> 'number') = 'number' then question -> 'number' else null end,
                'label', case when jsonb_typeof(question -> 'label') = 'string' then question ->> 'label' else null end,
                'score', case when jsonb_typeof(question -> 'score') = 'number' then question -> 'score' else null end,
                'answer', case when jsonb_typeof(question -> 'answer') = 'number' then question -> 'answer' else null end,
                'choices', case when jsonb_typeof(question -> 'choices') = 'number' then question -> 'choices' else null end,
                'tags', case
                    when jsonb_typeof(question -> 'tags') = 'object' then
                        jsonb_strip_nulls(jsonb_build_object(
                            'subject', case when jsonb_typeof(question #> '{tags,subject}') = 'string' then question #>> '{tags,subject}' else null end,
                            'unit', case when jsonb_typeof(question #> '{tags,unit}') = 'string' then question #>> '{tags,unit}' else null end,
                            'concept', case when jsonb_typeof(question #> '{tags,concept}') = 'string' then question #>> '{tags,concept}' else null end,
                            'skill', case when jsonb_typeof(question #> '{tags,skill}') = 'string' then question #>> '{tags,skill}' else null end,
                            'difficulty', case when jsonb_typeof(question #> '{tags,difficulty}') = 'string' then question #>> '{tags,difficulty}' else null end,
                            'cognitiveLevel', case when jsonb_typeof(question #> '{tags,cognitiveLevel}') = 'string' then question #>> '{tags,cognitiveLevel}' else null end,
                            'source', case when jsonb_typeof(question #> '{tags,source}') = 'string' then question #>> '{tags,source}' else null end,
                            'expectedTimeSec', case when jsonb_typeof(question #> '{tags,expectedTimeSec}') = 'number' then question #> '{tags,expectedTimeSec}' else null end,
                            'mistakeTypes', case
                                when jsonb_typeof(question #> '{tags,mistakeTypes}') = 'array' then (
                                    select coalesce(jsonb_agg(item order by ordinal), '[]'::jsonb)
                                      from jsonb_array_elements(question #> '{tags,mistakeTypes}') with ordinality as elements(item, ordinal)
                                     where jsonb_typeof(item) = 'string'
                                )
                                else null
                            end,
                            'prerequisites', case
                                when jsonb_typeof(question #> '{tags,prerequisites}') = 'array' then (
                                    select coalesce(jsonb_agg(item order by ordinal), '[]'::jsonb)
                                      from jsonb_array_elements(question #> '{tags,prerequisites}') with ordinality as elements(item, ordinal)
                                     where jsonb_typeof(item) = 'string'
                                )
                                else null
                            end
                        ))
                    else null
                end
            )) order by ordinal
        ),
        '[]'::jsonb
    )
    from jsonb_array_elements(
        case
            when jsonb_typeof(p_payload -> 'questions') = 'array'
                then p_payload -> 'questions'
            else '[]'::jsonb
        end
    ) with ordinality as questions(question, ordinal)
    where jsonb_typeof(question) = 'object'
      and jsonb_typeof(question -> 'id') = 'number'
      and jsonb_typeof(question -> 'number') = 'number';
$$;

alter table public.omr_attempts
    add column if not exists student_question_summaries jsonb generated always as
        (public.omr_student_question_summaries_v1(payload)) stored;

alter table public.omr_exams
    add column if not exists question_summaries jsonb generated always as
        (public.omr_exam_question_summaries_v1(payload)) stored;

-- Generated columns participate in a table's composite row type. Recreate the
-- two submission RPCs with an explicit writable-column list so they never try
-- to assign the generated summary during INSERT.
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

    select * into v_attempt
      from jsonb_populate_record(null::public.omr_attempts, p_attempt);
    v_attempt.ticket_id := trim(p_ticket_id);

    if v_attempt.id <> 'attempt_' || trim(p_ticket_id) then
        raise exception 'attempt id does not match ticket';
    end if;
    if nullif(trim(v_attempt.organization_id), '') is null then
        raise exception 'organization_id is required';
    end if;
    if not exists (
        select 1 from public.omr_exams exams
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

    insert into public.omr_attempts (
        id, ticket_id, organization_id, class_id, assignment_id,
        student_profile_id, exam_id, student_name, student_id, group_id,
        group_name, region_id, region_name, identity_type, status, score,
        total_score, score_percent, retake_source_attempt_id, retake_mode,
        retake_question_ids, merged_from_guest_id, merged_at, payload,
        started_at, finished_at
    ) values (
        v_attempt.id, v_attempt.ticket_id, v_attempt.organization_id,
        v_attempt.class_id, v_attempt.assignment_id, v_attempt.student_profile_id,
        v_attempt.exam_id, v_attempt.student_name, v_attempt.student_id,
        v_attempt.group_id, v_attempt.group_name, v_attempt.region_id,
        v_attempt.region_name, v_attempt.identity_type, v_attempt.status,
        v_attempt.score, v_attempt.total_score, v_attempt.score_percent,
        v_attempt.retake_source_attempt_id, v_attempt.retake_mode,
        v_attempt.retake_question_ids, v_attempt.merged_from_guest_id,
        v_attempt.merged_at, v_attempt.payload, v_attempt.started_at,
        v_attempt.finished_at
    )
    on conflict (ticket_id) where ticket_id is not null do nothing
    returning * into v_stored;

    if found then
        v_inserted := true;
    else
        select * into v_stored
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

create or replace function public.omr_submit_session_attempt_v1(
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
begin
    if jsonb_typeof(p_attempt) is distinct from 'object' then
        raise exception 'attempt must be an object';
    end if;
    if jsonb_typeof(p_question_results) is distinct from 'array' then
        raise exception 'question_results must be an array';
    end if;

    select * into v_attempt
      from jsonb_populate_record(null::public.omr_attempts, p_attempt);

    if nullif(btrim(v_attempt.id), '') is null
       or nullif(btrim(v_attempt.organization_id), '') is null
       or nullif(btrim(v_attempt.exam_id), '') is null
       or nullif(btrim(v_attempt.student_id), '') is null
       or v_attempt.payload is null then
        raise exception 'invalid canonical attempt';
    end if;
    if not exists (
        select 1 from public.omr_exams exam
         where exam.id = v_attempt.exam_id
           and exam.organization_id = v_attempt.organization_id
    ) then
        raise exception 'exam organization mismatch';
    end if;
    if exists (
        select 1
          from jsonb_to_recordset(p_question_results) as result(
              attempt_id text,
              exam_id text,
              organization_id text,
              student_id text
          )
         where result.attempt_id is distinct from v_attempt.id
            or result.exam_id is distinct from v_attempt.exam_id
            or result.organization_id is distinct from v_attempt.organization_id
            or result.student_id is distinct from v_attempt.student_id
    ) then
        raise exception 'question result scope mismatch';
    end if;

    insert into public.omr_attempts (
        id, ticket_id, organization_id, class_id, assignment_id,
        student_profile_id, exam_id, student_name, student_id, group_id,
        group_name, region_id, region_name, identity_type, status, score,
        total_score, score_percent, retake_source_attempt_id, retake_mode,
        retake_question_ids, merged_from_guest_id, merged_at, payload,
        started_at, finished_at
    ) values (
        v_attempt.id, v_attempt.ticket_id, v_attempt.organization_id,
        v_attempt.class_id, v_attempt.assignment_id, v_attempt.student_profile_id,
        v_attempt.exam_id, v_attempt.student_name, v_attempt.student_id,
        v_attempt.group_id, v_attempt.group_name, v_attempt.region_id,
        v_attempt.region_name, v_attempt.identity_type, v_attempt.status,
        v_attempt.score, v_attempt.total_score, v_attempt.score_percent,
        v_attempt.retake_source_attempt_id, v_attempt.retake_mode,
        v_attempt.retake_question_ids, v_attempt.merged_from_guest_id,
        v_attempt.merged_at, v_attempt.payload, v_attempt.started_at,
        v_attempt.finished_at
    )
    on conflict (id) do nothing
    returning * into v_stored;

    if not found then
        select * into v_stored
          from public.omr_attempts
         where id = v_attempt.id
         for update;
        if v_stored.organization_id is distinct from v_attempt.organization_id
           or v_stored.exam_id is distinct from v_attempt.exam_id
           or v_stored.student_id is distinct from v_attempt.student_id
           or v_stored.student_profile_id is distinct from v_attempt.student_profile_id then
            raise exception 'attempt identifier belongs to another owner';
        end if;
    end if;

    insert into public.omr_question_results
    select *
      from jsonb_populate_recordset(
          null::public.omr_question_results,
          p_question_results
      )
    on conflict (attempt_id, question_id) do nothing;

    return query select v_stored.payload;
end;
$$;

-- The generated exam summary changes omr_exams' composite row type. Keep the
-- canonical save on explicit writable columns so generated values are always
-- computed by PostgreSQL while preserving the scoped conflict guard.
create or replace function public.omr_save_exam_plan_unlocked_v1(
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
    v_stored public.omr_exams%rowtype;
begin
    if jsonb_typeof(p_exam) is distinct from 'object' then
        raise exception 'exam must be an object';
    end if;
    if jsonb_typeof(p_questions) is distinct from 'array' then
        raise exception 'questions must be an array';
    end if;
    select * into v_exam
      from jsonb_populate_record(null::public.omr_exams, p_exam);
    if nullif(trim(v_exam.id), '') is null
       or nullif(trim(v_exam.organization_id), '') is null
       or nullif(trim(v_exam.title), '') is null
       or v_exam.payload is null then
        raise exception 'invalid canonical exam';
    end if;
    if exists (
        select 1
          from jsonb_to_recordset(p_questions) as question(
              exam_id text,
              organization_id text
          )
         where question.exam_id is distinct from v_exam.id
            or question.organization_id is distinct from v_exam.organization_id
    ) then
        raise exception 'exam question scope mismatch';
    end if;

    insert into public.omr_exams (
        id, organization_id, class_id, title, payload, created_by_user_id,
        created_at, updated_at, archived
    ) values (
        v_exam.id, v_exam.organization_id, v_exam.class_id, v_exam.title,
        v_exam.payload, v_exam.created_by_user_id,
        coalesce(v_exam.created_at, now()), coalesce(v_exam.updated_at, now()),
        coalesce(v_exam.archived, false)
    )
    on conflict (id) do update set
        class_id = excluded.class_id,
        title = excluded.title,
        payload = excluded.payload,
        created_by_user_id = excluded.created_by_user_id,
        updated_at = excluded.updated_at,
        archived = excluded.archived
    where public.omr_exams.organization_id = excluded.organization_id
    returning * into v_stored;

    if not found then
        raise exception 'exam identifier belongs to another organization';
    end if;

    delete from public.omr_exam_questions where exam_id = v_exam.id;
    insert into public.omr_exam_questions (
        id, organization_id, class_id, exam_id, question_id, question_number,
        canonical_question_id, label, subject, unit, concept, skill, source,
        difficulty, cognitive_level, mistake_types, prerequisites,
        expected_time_sec, choices, correct_answer, score, pdf_page,
        pdf_location, pdf_region, has_pdf_region, asset_status, image_asset_ref,
        payload, created_at, updated_at
    )
    select
        question.id, question.organization_id, question.class_id,
        question.exam_id, question.question_id, question.question_number,
        question.canonical_question_id, question.label, question.subject,
        question.unit, question.concept, question.skill, question.source,
        question.difficulty, question.cognitive_level,
        coalesce(question.mistake_types, '{}'::text[]),
        coalesce(question.prerequisites, '{}'::text[]),
        question.expected_time_sec, coalesce(question.choices, 5),
        question.correct_answer, coalesce(question.score, 0), question.pdf_page,
        question.pdf_location, question.pdf_region,
        coalesce(question.has_pdf_region, false),
        coalesce(question.asset_status, 'metadata_only'),
        question.image_asset_ref, question.payload,
        coalesce(question.created_at, now()), coalesce(question.updated_at, now())
      from jsonb_populate_recordset(
          null::public.omr_exam_questions,
          p_questions
      ) as question;

    return v_stored.payload;
end;
$$;

-- Preserve the plan/idempotency wrapper while routing its write through the
-- explicit-column implementation above.
create or replace function public.omr_save_exam_v1(
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

revoke all on function public.omr_student_question_summaries_v1(jsonb) from public, anon, authenticated;
grant execute on function public.omr_student_question_summaries_v1(jsonb) to service_role;
revoke all on function public.omr_exam_question_summaries_v1(jsonb) from public, anon, authenticated;
grant execute on function public.omr_exam_question_summaries_v1(jsonb) to service_role;
revoke all on function public.omr_submit_attempt_v1(text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.omr_submit_attempt_v1(text, jsonb, jsonb) to service_role;
revoke all on function public.omr_submit_session_attempt_v1(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.omr_submit_session_attempt_v1(jsonb, jsonb) to service_role;
revoke all on function public.omr_save_exam_plan_unlocked_v1(jsonb, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.omr_save_exam_v1(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.omr_save_exam_v1(jsonb, jsonb) to service_role;

commit;
