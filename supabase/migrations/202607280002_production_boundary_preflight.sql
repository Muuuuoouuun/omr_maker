-- Fail closed before the production server-only boundary is applied.
--
-- The diagnostic function intentionally returns only counts and at most ten
-- deterministic category/ordinal pairs. It does not expose source identifiers,
-- profile names, contact details, credential hashes, or payload content.

create or replace function public.omr_production_boundary_preflight_v1()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
with
null_organization_violations(entity, row_id) as (
    select 'class', class_row.id
      from public.omr_classes class_row
     where class_row.organization_id is null
    union
    select 'exam', exam.id
      from public.omr_exams exam
     where exam.organization_id is null
    union
    select 'exam_question', question.id
      from public.omr_exam_questions question
     where question.organization_id is null
    union
    select 'attempt', attempt.id
      from public.omr_attempts attempt
     where attempt.organization_id is null
    union
    select 'question_result', result.id
      from public.omr_question_results result
     where result.organization_id is null
    union
    select
        'class_student_membership',
        concat_ws(':', student_membership.class_id, student_membership.student_profile_id)
      from public.omr_class_students student_membership
     where student_membership.organization_id is null
        or student_membership.class_id is null
        or student_membership.student_profile_id is null
    union
    select
        'class_teacher_membership',
        concat_ws(':', teacher_membership.class_id, teacher_membership.teacher_user_id)
      from public.omr_class_teachers teacher_membership
     where teacher_membership.organization_id is null
        or teacher_membership.class_id is null
        or teacher_membership.teacher_user_id is null
),
orphan_violations(entity, row_id) as (
    select 'class', class_row.id
      from public.omr_classes class_row
     where class_row.organization_id is not null
       and not exists (
           select 1
             from public.omr_organizations organization_row
            where organization_row.id = class_row.organization_id
       )
    union
    select 'exam', exam.id
      from public.omr_exams exam
     where (
         exam.organization_id is not null
         and not exists (
             select 1
               from public.omr_organizations organization_row
              where organization_row.id = exam.organization_id
         )
     ) or (
         exam.class_id is not null
         and not exists (
             select 1
               from public.omr_classes class_row
              where class_row.id = exam.class_id
         )
     )
    union
    select 'exam_question', question.id
      from public.omr_exam_questions question
     where not exists (
         select 1
           from public.omr_exams exam
          where exam.id = question.exam_id
     ) or (
         question.organization_id is not null
         and not exists (
             select 1
               from public.omr_organizations organization_row
              where organization_row.id = question.organization_id
         )
     ) or (
         question.class_id is not null
         and not exists (
             select 1
               from public.omr_classes class_row
              where class_row.id = question.class_id
         )
     )
    union
    select 'attempt', attempt.id
      from public.omr_attempts attempt
     where not exists (
         select 1
           from public.omr_exams exam
          where exam.id = attempt.exam_id
     ) or (
         attempt.organization_id is not null
         and not exists (
             select 1
               from public.omr_organizations organization_row
              where organization_row.id = attempt.organization_id
         )
     ) or (
         attempt.class_id is not null
         and not exists (
             select 1
               from public.omr_classes class_row
              where class_row.id = attempt.class_id
         )
     ) or (
         attempt.assignment_id is not null
         and not exists (
             select 1
               from public.omr_assignments assignment
              where assignment.id = attempt.assignment_id
         )
     ) or (
         attempt.student_profile_id is not null
         and not exists (
             select 1
               from public.omr_student_profiles student
              where student.id = attempt.student_profile_id
         )
     )
    union
    -- Question results are immutable historical snapshots. Supported exam
    -- replacement may remove current question rows while submitted results
    -- retain their attempt/exam/scope facts.
    select 'question_result', result.id
      from public.omr_question_results result
     where not exists (
         select 1
           from public.omr_attempts attempt
          where attempt.id = result.attempt_id
     ) or not exists (
         select 1
           from public.omr_exams exam
          where exam.id = result.exam_id
     ) or (
         result.organization_id is not null
         and not exists (
             select 1
               from public.omr_organizations organization_row
              where organization_row.id = result.organization_id
         )
     ) or (
         result.class_id is not null
         and not exists (
             select 1
               from public.omr_classes class_row
              where class_row.id = result.class_id
         )
     ) or (
         result.assignment_id is not null
         and not exists (
             select 1
               from public.omr_assignments assignment
              where assignment.id = result.assignment_id
         )
     ) or (
         result.student_profile_id is not null
         and not exists (
             select 1
              from public.omr_student_profiles student
             where student.id = result.student_profile_id
         )
     )
    union
    select
        'class_student_membership',
        student_membership.class_id || ':' || student_membership.student_profile_id
      from public.omr_class_students student_membership
     where not exists (
         select 1
           from public.omr_organizations organization_row
          where organization_row.id = student_membership.organization_id
     ) or not exists (
         select 1
           from public.omr_classes class_row
          where class_row.id = student_membership.class_id
     ) or not exists (
         select 1
           from public.omr_student_profiles student
          where student.id = student_membership.student_profile_id
     )
    union
    select
        'class_teacher_membership',
        teacher_membership.class_id || ':' || teacher_membership.teacher_user_id
      from public.omr_class_teachers teacher_membership
     where not exists (
         select 1
           from public.omr_organizations organization_row
          where organization_row.id = teacher_membership.organization_id
     ) or not exists (
         select 1
           from public.omr_classes class_row
          where class_row.id = teacher_membership.class_id
     ) or not exists (
         select 1
           from public.omr_teacher_profiles exact_teacher_profile
          where exact_teacher_profile.organization_id = teacher_membership.organization_id
            and exact_teacher_profile.user_id = teacher_membership.teacher_user_id
     ) or not exists (
         select 1
           from public.omr_organization_members exact_organization_member
          where exact_organization_member.organization_id = teacher_membership.organization_id
            and exact_organization_member.user_id = teacher_membership.teacher_user_id
     ) or (
         exists (
             select 1
               from public.omr_teacher_profiles exact_active_teacher_profile
              where exact_active_teacher_profile.organization_id = teacher_membership.organization_id
                and exact_active_teacher_profile.user_id = teacher_membership.teacher_user_id
                and exact_active_teacher_profile.status = 'active'
         )
         and not exists (
             select 1
               from public.omr_organization_members exact_active_organization_member
              where exact_active_organization_member.organization_id = teacher_membership.organization_id
                and exact_active_organization_member.user_id = teacher_membership.teacher_user_id
                and exact_active_organization_member.status = 'active'
         )
     )
    union
    select 'student_profile', student.id
      from public.omr_student_profiles student
     where not exists (
         select 1
           from public.omr_organizations organization_row
          where organization_row.id = student.organization_id
     )
    union
    select 'teacher_profile', teacher.organization_id || ':' || teacher.user_id
      from public.omr_teacher_profiles teacher
     where not exists (
         select 1
           from public.omr_organizations organization_row
          where organization_row.id = teacher.organization_id
     ) or not exists (
         select 1
           from public.omr_organization_members member
          where member.organization_id = teacher.organization_id
            and member.user_id = teacher.user_id
     ) or (
         teacher.status = 'active'
         and not exists (
             select 1
               from public.omr_organization_members active_member
              where active_member.organization_id = teacher.organization_id
                and active_member.user_id = teacher.user_id
                and active_member.status = 'active'
         )
     )
    union
    select 'organization_member', member.organization_id || ':' || member.user_id
      from public.omr_organization_members member
     where not exists (
         select 1
           from public.omr_organizations organization_row
          where organization_row.id = member.organization_id
     )
    union
    select 'student_credential', credential.organization_id || ':' || credential.student_profile_id
      from public.omr_student_start_credentials credential
     where not exists (
         select 1
           from public.omr_organizations organization_row
          where organization_row.id = credential.organization_id
     ) or not exists (
         select 1
           from public.omr_student_profiles student
          where student.id = credential.student_profile_id
     )
),
cross_organization_violations(entity, row_id) as (
    select 'exam', exam.id
      from public.omr_exams exam
      join public.omr_classes class_row
        on class_row.id = exam.class_id
     where exam.organization_id is distinct from class_row.organization_id
    union
    select 'exam_question', question.id
      from public.omr_exam_questions question
      join public.omr_exams exam
        on exam.id = question.exam_id
      left join public.omr_classes class_row
        on class_row.id = question.class_id
     where question.organization_id is distinct from exam.organization_id
        or (
            question.class_id is not null
            and question.organization_id is distinct from class_row.organization_id
        )
    union
    select 'attempt', attempt.id
      from public.omr_attempts attempt
      join public.omr_exams exam
        on exam.id = attempt.exam_id
      left join public.omr_classes class_row
        on class_row.id = attempt.class_id
      left join public.omr_assignments assignment
        on assignment.id = attempt.assignment_id
      left join public.omr_student_profiles student
        on student.id = attempt.student_profile_id
     where attempt.organization_id is distinct from exam.organization_id
        or (
            attempt.class_id is not null
            and attempt.organization_id is distinct from class_row.organization_id
        )
        or (
            attempt.assignment_id is not null
            and attempt.organization_id is distinct from assignment.organization_id
        )
        or (
            attempt.student_profile_id is not null
            and attempt.organization_id is distinct from student.organization_id
        )
    union
    select 'question_result', result.id
      from public.omr_question_results result
      join public.omr_attempts attempt
        on attempt.id = result.attempt_id
      join public.omr_exams exam
        on exam.id = result.exam_id
      left join public.omr_classes class_row
        on class_row.id = result.class_id
      left join public.omr_assignments assignment
        on assignment.id = result.assignment_id
      left join public.omr_student_profiles student
        on student.id = result.student_profile_id
     where result.organization_id is distinct from attempt.organization_id
        or result.organization_id is distinct from exam.organization_id
        or result.exam_id is distinct from attempt.exam_id
        or (
            result.class_id is not null
            and result.organization_id is distinct from class_row.organization_id
        )
        or (
            result.assignment_id is not null
            and result.organization_id is distinct from assignment.organization_id
        )
        or (
            result.student_profile_id is not null
            and result.organization_id is distinct from student.organization_id
        )
    union
    select
        'class_student_membership',
        student_membership.class_id || ':' || student_membership.student_profile_id
      from public.omr_class_students student_membership
      join public.omr_classes class_row
        on class_row.id = student_membership.class_id
      join public.omr_student_profiles student
        on student.id = student_membership.student_profile_id
     where student_membership.organization_id is distinct from class_row.organization_id
        or student_membership.organization_id is distinct from student.organization_id
    union
    select
        'class_teacher_membership',
        teacher_membership.class_id || ':' || teacher_membership.teacher_user_id
      from public.omr_class_teachers teacher_membership
      join public.omr_classes class_row
        on class_row.id = teacher_membership.class_id
     where teacher_membership.organization_id is distinct from class_row.organization_id
        or (
            not exists (
                select 1
                  from public.omr_teacher_profiles exact_teacher_profile
                 where exact_teacher_profile.organization_id = teacher_membership.organization_id
                   and exact_teacher_profile.user_id = teacher_membership.teacher_user_id
            )
            and exists (
                select 1
                  from public.omr_teacher_profiles other_teacher_profile
                 where other_teacher_profile.organization_id <> teacher_membership.organization_id
                   and other_teacher_profile.user_id = teacher_membership.teacher_user_id
                   and other_teacher_profile.status = 'active'
            )
        )
        or (
            not exists (
                select 1
                  from public.omr_organization_members exact_organization_member
                 where exact_organization_member.organization_id = teacher_membership.organization_id
                   and exact_organization_member.user_id = teacher_membership.teacher_user_id
            )
            and exists (
                select 1
                  from public.omr_organization_members other_organization_member
                 where other_organization_member.organization_id <> teacher_membership.organization_id
                   and other_organization_member.user_id = teacher_membership.teacher_user_id
                   and other_organization_member.status = 'active'
            )
        )
    union
    select 'teacher_profile', teacher.organization_id || ':' || teacher.user_id
      from public.omr_teacher_profiles teacher
      join public.omr_organization_members member
        on member.user_id = teacher.user_id
     where member.organization_id <> teacher.organization_id
       and not exists (
            select 1
              from public.omr_organization_members same_scope_member
             where same_scope_member.organization_id = teacher.organization_id
               and same_scope_member.user_id = teacher.user_id
       )
    union
    select 'student_credential', credential.organization_id || ':' || credential.student_profile_id
      from public.omr_student_start_credentials credential
      join public.omr_student_profiles student
        on student.id = credential.student_profile_id
     where credential.organization_id <> student.organization_id
),
credential_hash_raw_parts as (
    select
        student.organization_id,
        student.id as student_profile_id,
        student.status,
        credential.start_code_hash,
        btrim(coalesce(credential.start_code_hash, '')) as encoded_hash,
        cardinality(string_to_array(btrim(coalesce(credential.start_code_hash, '')), ':')) as part_count,
        split_part(btrim(coalesce(credential.start_code_hash, '')), ':', 1) as algorithm,
        split_part(btrim(coalesce(credential.start_code_hash, '')), ':', 2) as raw_iterations,
        split_part(btrim(coalesce(credential.start_code_hash, '')), ':', 3) as salt_hex,
        split_part(btrim(coalesce(credential.start_code_hash, '')), ':', 4) as hash_hex
      from public.omr_student_profiles student
      left join public.omr_student_start_credentials credential
        on credential.organization_id = student.organization_id
       and credential.student_profile_id = student.id
),
credential_hash_parts as (
    select
        credential_hash_raw_parts.*,
        coalesce(
            nullif(ltrim(credential_hash_raw_parts.raw_iterations, '0'), ''),
            '0'
        ) as normalized_iterations
      from credential_hash_raw_parts
),
credential_hash_validity as (
    select
        credential_hash_parts.*,
        coalesce(
            credential_hash_parts.start_code_hash is not null
            and length(credential_hash_parts.encoded_hash) <= 512
            and credential_hash_parts.part_count = 4
            and credential_hash_parts.algorithm = 'pbkdf2-sha256'
            and credential_hash_parts.raw_iterations ~ '^[0-9]+$'
            and case
                when credential_hash_parts.raw_iterations ~ '^[0-9]+$'
                    and length(credential_hash_parts.normalized_iterations) <= 7
                then credential_hash_parts.normalized_iterations::numeric between 10000 and 1000000
                else false
            end
            and credential_hash_parts.salt_hex ~* '^[a-f0-9]+$'
            and length(credential_hash_parts.salt_hex) between 32 and 128
            and length(credential_hash_parts.salt_hex) % 2 = 0
            and credential_hash_parts.hash_hex ~* '^[a-f0-9]{64}$'
            and length(credential_hash_parts.hash_hex) % 2 = 0,
            false
        ) as is_valid
      from credential_hash_parts
),
students_without_credentials(entity, row_id) as (
    select
        'student_profile',
        credential_hash_validity.organization_id || ':' || credential_hash_validity.student_profile_id
      from credential_hash_validity
     where credential_hash_validity.status in ('invited', 'active')
       and not credential_hash_validity.is_valid
),
null_organization_sample as (
    select
        entity,
        row_number() over (partition by entity order by row_id) as ordinal
      from null_organization_violations
     order by entity, row_id
     limit 10
),
orphan_sample as (
    select
        entity,
        row_number() over (partition by entity order by row_id) as ordinal
      from orphan_violations
     order by entity, row_id
     limit 10
),
cross_organization_sample as (
    select
        entity,
        row_number() over (partition by entity order by row_id) as ordinal
      from cross_organization_violations
     order by entity, row_id
     limit 10
),
students_without_credentials_sample as (
    select
        entity,
        row_number() over (partition by entity order by row_id) as ordinal
      from students_without_credentials
     order by entity, row_id
     limit 10
)
select jsonb_build_object(
    'null_organization_rows',
        (select count(*) from null_organization_violations),
    'orphan_rows',
        (select count(*) from orphan_violations),
    'cross_organization_rows',
        (select count(*) from cross_organization_violations),
    'students_without_credentials',
        (select count(*) from students_without_credentials),
    'samples',
        jsonb_build_object(
            'null_organization_rows',
                coalesce(
                    (
                        select jsonb_agg(
                            jsonb_build_object('category', entity, 'ordinal', ordinal)
                            order by entity, ordinal
                        )
                          from null_organization_sample
                    ),
                    '[]'::jsonb
                ),
            'orphan_rows',
                coalesce(
                    (
                        select jsonb_agg(
                            jsonb_build_object('category', entity, 'ordinal', ordinal)
                            order by entity, ordinal
                        )
                          from orphan_sample
                    ),
                    '[]'::jsonb
                ),
            'cross_organization_rows',
                coalesce(
                    (
                        select jsonb_agg(
                            jsonb_build_object('category', entity, 'ordinal', ordinal)
                            order by entity, ordinal
                        )
                          from cross_organization_sample
                    ),
                    '[]'::jsonb
                ),
            'students_without_credentials',
                coalesce(
                    (
                        select jsonb_agg(
                            jsonb_build_object('category', entity, 'ordinal', ordinal)
                            order by entity, ordinal
                        )
                          from students_without_credentials_sample
                    ),
                    '[]'::jsonb
                )
        )
);
$$;

revoke all on function public.omr_production_boundary_preflight_v1()
    from public, anon, authenticated;
grant execute on function public.omr_production_boundary_preflight_v1()
    to service_role;

create or replace function public.omr_assert_production_boundary_preflight_v1()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    diagnostics jsonb;
    safe_counts jsonb;
begin
    diagnostics := public.omr_production_boundary_preflight_v1();
    safe_counts := diagnostics - 'samples';

    if (diagnostics->>'null_organization_rows')::bigint <> 0
        or (diagnostics->>'orphan_rows')::bigint <> 0
        or (diagnostics->>'cross_organization_rows')::bigint <> 0
        or (diagnostics->>'students_without_credentials')::bigint <> 0
    then
        raise exception 'production boundary preflight failed: %', safe_counts
            using
                errcode = '23514',
                detail = 'Repair every reported row before applying the production server-only boundary.',
                hint = 'Use the service-role preflight categories to repair violations, then rerun the gate.';
    end if;

    return diagnostics;
end;
$$;

revoke all on function public.omr_assert_production_boundary_preflight_v1()
    from public, anon, authenticated;
grant execute on function public.omr_assert_production_boundary_preflight_v1()
    to service_role;

-- Applying this migration to an existing database is itself the deployment
-- gate. Empty/new databases pass; dirty production datasets fail atomically.
do $$
begin
    perform public.omr_assert_production_boundary_preflight_v1();
end;
$$;
