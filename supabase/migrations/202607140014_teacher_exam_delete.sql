begin;

create or replace function public.omr_delete_exam_v1(
    p_organization_id text,
    p_exam_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_exists boolean;
begin
    if nullif(btrim(p_organization_id), '') is null or nullif(btrim(p_exam_id), '') is null then
        raise exception 'invalid exam delete request';
    end if;

    select exists (
        select 1 from public.omr_exams exam
        where exam.id = p_exam_id and exam.organization_id = p_organization_id
        for update
    ) into v_exists;
    if not v_exists then return jsonb_build_object('deleted', false); end if;

    delete from public.omr_question_results result
    using public.omr_attempts attempt
    where result.attempt_id = attempt.id
      and attempt.exam_id = p_exam_id
      and attempt.organization_id = p_organization_id;

    delete from public.omr_attempts attempt
    where attempt.exam_id = p_exam_id and attempt.organization_id = p_organization_id;

    delete from public.omr_exam_questions question
    where question.exam_id = p_exam_id and question.organization_id = p_organization_id;

    delete from public.omr_exams exam
    where exam.id = p_exam_id and exam.organization_id = p_organization_id;

    return jsonb_build_object('deleted', true);
end;
$$;

revoke all on function public.omr_delete_exam_v1(text, text) from public, anon, authenticated;
grant execute on function public.omr_delete_exam_v1(text, text) to service_role;

commit;
