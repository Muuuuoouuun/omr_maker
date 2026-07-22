begin;

create or replace function public.omr_save_feedback_v1(
    p_organization_id text,
    p_feedback jsonb
)
returns public.omr_attempt_feedback
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_feedback public.omr_attempt_feedback%rowtype;
    v_attempt public.omr_attempts%rowtype;
    v_stored public.omr_attempt_feedback%rowtype;
begin
    if nullif(trim(p_organization_id), '') is null then
        raise exception 'organization_id is required';
    end if;
    if jsonb_typeof(p_feedback) is distinct from 'object' then
        raise exception 'feedback must be an object';
    end if;

    select * into v_feedback
      from jsonb_populate_record(null::public.omr_attempt_feedback, p_feedback);

    if v_feedback.organization_id is distinct from trim(p_organization_id) then
        raise exception 'feedback organization mismatch';
    end if;
    if v_feedback.status is distinct from 'draft' then
        raise exception 'feedback save only accepts drafts';
    end if;

    select * into v_attempt
      from public.omr_attempts
     where id = v_feedback.attempt_id
       and organization_id = trim(p_organization_id)
     for update;

    if not found then
        raise exception 'attempt is outside teacher organization';
    end if;
    if v_feedback.exam_id is distinct from v_attempt.exam_id then
        raise exception 'feedback exam mismatch';
    end if;
    if v_feedback.student_profile_id is distinct from v_attempt.student_profile_id then
        raise exception 'feedback student mismatch';
    end if;

    insert into public.omr_attempt_feedback (
        id, organization_id, attempt_id, exam_id, student_profile_id,
        teacher_user_id, status, summary, question_comments, markup,
        markup_drawings, download_policy, notification_status,
        notification_channel, notified_at, first_opened_at, last_opened_at,
        open_count, returned_at, payload, created_at, updated_at
    ) values (
        v_feedback.id, trim(p_organization_id), v_feedback.attempt_id,
        v_feedback.exam_id, v_feedback.student_profile_id,
        v_feedback.teacher_user_id, 'draft', v_feedback.summary,
        coalesce(v_feedback.question_comments, '[]'::jsonb), v_feedback.markup,
        v_feedback.markup_drawings,
        coalesce(v_feedback.download_policy, '{}'::jsonb),
        'not_queued', 'in_app', null, null, null, 0, null,
        v_feedback.payload || jsonb_build_object(
            'organizationId', trim(p_organization_id),
            'status', 'draft',
            'returnedAt', null,
            'delivery', jsonb_build_object(
                'notificationStatus', 'not_queued',
                'notificationChannel', 'in_app',
                'openCount', 0
            )
        ),
        coalesce(v_feedback.created_at, now()),
        coalesce(v_feedback.updated_at, now())
    )
    on conflict (attempt_id) do update set
        teacher_user_id = excluded.teacher_user_id,
        status = 'draft',
        summary = excluded.summary,
        question_comments = excluded.question_comments,
        markup = excluded.markup,
        markup_drawings = case
            when p_feedback ? 'markup_drawings' then excluded.markup_drawings
            else public.omr_attempt_feedback.markup_drawings
        end,
        download_policy = excluded.download_policy,
        notification_status = 'not_queued',
        notification_channel = 'in_app',
        notified_at = null,
        first_opened_at = null,
        last_opened_at = null,
        open_count = 0,
        returned_at = null,
        payload = excluded.payload,
        updated_at = excluded.updated_at
    where public.omr_attempt_feedback.organization_id = trim(p_organization_id)
      and public.omr_attempt_feedback.attempt_id = v_attempt.id
      and public.omr_attempt_feedback.id = v_feedback.id
    returning * into v_stored;

    if v_stored.id is null then
        raise exception 'feedback conflict is outside teacher organization';
    end if;
    return v_stored;
end;
$$;

revoke all on function public.omr_save_feedback_v1(text, jsonb) from public, anon, authenticated;
grant execute on function public.omr_save_feedback_v1(text, jsonb) to service_role;

commit;
