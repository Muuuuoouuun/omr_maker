begin;

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
        or v_exam.payload is null
    then
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

    if exists (
        select 1
          from public.omr_exams existing
         where existing.id = v_exam.id
           and existing.organization_id is distinct from v_exam.organization_id
    ) then
        raise exception 'exam identifier belongs to another organization';
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
        organization_id = excluded.organization_id,
        class_id = excluded.class_id,
        title = excluded.title,
        payload = excluded.payload,
        created_by_user_id = excluded.created_by_user_id,
        updated_at = excluded.updated_at,
        archived = excluded.archived;

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

    return v_exam.payload;
end;
$$;

revoke all on function public.omr_save_exam_v1(jsonb, jsonb) from public;
revoke all on function public.omr_save_exam_v1(jsonb, jsonb) from anon;
revoke all on function public.omr_save_exam_v1(jsonb, jsonb) from authenticated;
grant execute on function public.omr_save_exam_v1(jsonb, jsonb) to service_role;

commit;
