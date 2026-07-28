begin;

create or replace function public.omr_claim_guest_attempts_v1(
    p_guest_id text,
    p_student_profile_id text,
    p_organization_id text,
    p_class_id text,
    p_student_name text,
    p_group_name text,
    p_attempt_ids text[]
)
returns text[]
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    acknowledged_attempt_ids text[] := '{}'::text[];
    merged_timestamp timestamptz := now();
begin
    if nullif(btrim(p_guest_id), '') is null
        or nullif(btrim(p_student_profile_id), '') is null
        or nullif(btrim(p_organization_id), '') is null
        or nullif(btrim(p_class_id), '') is null then
        raise exception 'invalid guest claim scope' using errcode = '22023';
    end if;

    if not exists (
        select 1
        from public.omr_student_profiles profile
        join public.omr_class_students enrollment
          on enrollment.organization_id = profile.organization_id
         and enrollment.student_profile_id = profile.id
        join public.omr_classes class
          on class.organization_id = enrollment.organization_id
         and class.id = enrollment.class_id
        where profile.organization_id = p_organization_id
          and profile.id = p_student_profile_id
          and coalesce(profile.status, 'active') = 'active'
          and enrollment.class_id = p_class_id
          and enrollment.enrollment_status = 'active'
          and class.status = 'active'
    ) then
        raise exception 'student claim scope denied' using errcode = '42501';
    end if;

    perform attempt.id
    from public.omr_attempts attempt
    where attempt.organization_id = p_organization_id
      and attempt.student_id = 'guest:' || p_guest_id
      and attempt.identity_type = 'guest'
      and (
          coalesce(array_length(p_attempt_ids, 1), 0) = 0
          or attempt.id = any(p_attempt_ids)
      )
    for update;

    update public.omr_attempts attempt
    set student_profile_id = p_student_profile_id,
        student_id = p_student_profile_id,
        class_id = p_class_id,
        student_name = p_student_name,
        group_id = p_class_id,
        group_name = p_group_name,
        identity_type = 'temporary',
        merged_from_guest_id = coalesce(attempt.merged_from_guest_id, p_guest_id),
        merged_at = coalesce(attempt.merged_at, merged_timestamp),
        payload = (
            coalesce(attempt.payload, '{}'::jsonb)
            - 'guestId'
        ) || jsonb_build_object(
            'studentId', p_student_profile_id,
            'studentProfileId', p_student_profile_id,
            'studentName', p_student_name,
            'classId', p_class_id,
            'groupId', p_class_id,
            'groupName', p_group_name,
            'identityType', 'temporary',
            'mergedFromGuestId', p_guest_id,
            'mergedAt', coalesce(attempt.merged_at, merged_timestamp)
        ) || case
            when jsonb_typeof(attempt.payload->'questionResults') = 'array' then
                jsonb_build_object(
                    'questionResults',
                    (
                        select coalesce(
                            jsonb_agg(
                                (question_result - 'guestId') || jsonb_build_object(
                                    'studentId', p_student_profile_id,
                                    'studentProfileId', p_student_profile_id,
                                    'studentName', p_student_name,
                                    'groupId', p_class_id,
                                    'groupName', p_group_name,
                                    'identityType', 'temporary'
                                )
                                order by ordinal
                            ),
                            '[]'::jsonb
                        )
                        from jsonb_array_elements(attempt.payload->'questionResults')
                            with ordinality as nested(question_result, ordinal)
                    )
                )
            else '{}'::jsonb
        )
    where attempt.organization_id = p_organization_id
      and attempt.student_id = 'guest:' || p_guest_id
      and attempt.identity_type = 'guest'
      and (
          coalesce(array_length(p_attempt_ids, 1), 0) = 0
          or attempt.id = any(p_attempt_ids)
      );

    if coalesce(array_length(p_attempt_ids, 1), 0) > 0 then
        select coalesce(array_agg(attempt.id order by attempt.id), '{}'::text[])
        into acknowledged_attempt_ids
        from public.omr_attempts attempt
        where attempt.organization_id = p_organization_id
          and attempt.id = any(p_attempt_ids)
          and attempt.student_id = p_student_profile_id
          and attempt.merged_from_guest_id = p_guest_id;
    end if;

    update public.omr_question_results result
    set student_profile_id = p_student_profile_id,
        student_id = p_student_profile_id,
        class_id = p_class_id,
        student_name = p_student_name,
        group_id = p_class_id,
        group_name = p_group_name,
        identity_type = 'temporary',
        payload = (
            coalesce(result.payload, '{}'::jsonb)
            - 'guestId'
        ) || jsonb_build_object(
            'studentId', p_student_profile_id,
            'studentProfileId', p_student_profile_id,
            'studentName', p_student_name,
            'classId', p_class_id,
            'groupId', p_class_id,
            'groupName', p_group_name,
            'identityType', 'temporary'
        )
    where result.organization_id = p_organization_id
      and result.student_id = 'guest:' || p_guest_id
      and result.identity_type = 'guest'
      and (
          coalesce(array_length(p_attempt_ids, 1), 0) = 0
          or result.attempt_id = any(p_attempt_ids)
      );

    return acknowledged_attempt_ids;
end;
$$;

revoke all on function public.omr_claim_guest_attempts_v1(
    text, text, text, text, text, text, text[]
) from public, anon, authenticated;
grant execute on function public.omr_claim_guest_attempts_v1(
    text, text, text, text, text, text, text[]
) to service_role;

commit;
