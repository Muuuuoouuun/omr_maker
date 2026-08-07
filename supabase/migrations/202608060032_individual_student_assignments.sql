begin;

-- One targeted assignment per exam is edited with a server revision. Student
-- identities remain normalized in target rows; no roster list is copied into
-- exam accessConfig, assignment metadata, or a share URL.
alter table public.omr_assignments
    add column if not exists revision bigint not null default 1;
alter table public.omr_assignments
    add column if not exists assignment_mode text not null default 'base';
alter table public.omr_assignments
    add column if not exists last_mutation_id text;
alter table public.omr_assignments
    add column if not exists last_mutation_fingerprint text;

do $$
begin
    if not exists (
        select 1 from pg_catalog.pg_constraint
         where conname = 'omr_assignments_revision_check'
           and conrelid = 'public.omr_assignments'::regclass
    ) then
        alter table public.omr_assignments
            add constraint omr_assignments_revision_check check (revision > 0);
    end if;
    if not exists (
        select 1 from pg_catalog.pg_constraint
         where conname = 'omr_assignments_mode_check'
           and conrelid = 'public.omr_assignments'::regclass
    ) then
        alter table public.omr_assignments
            add constraint omr_assignments_mode_check check (assignment_mode in ('base', 'retake'));
    end if;
end;
$$;

alter table public.omr_assignment_targets
    add column if not exists retake_source_attempt_id text
        references public.omr_attempts(id) on delete restrict;
alter table public.omr_assignment_targets
    add column if not exists retake_question_ids integer[] not null default '{}'::integer[];

do $$
begin
    if not exists (
        select 1 from pg_catalog.pg_constraint
         where conname = 'omr_assignment_targets_retake_shape_check'
           and conrelid = 'public.omr_assignment_targets'::regclass
    ) then
        alter table public.omr_assignment_targets
            add constraint omr_assignment_targets_retake_shape_check check (
                (retake_source_attempt_id is null and cardinality(retake_question_ids) = 0)
                or (retake_source_attempt_id is not null and cardinality(retake_question_ids) between 1 and 500)
            );
    end if;
end;
$$;

create unique index if not exists omr_assignments_targeted_exam_idx
    on public.omr_assignments (organization_id, exam_id)
    where access_mode = 'targeted' and status <> 'archived';
create index if not exists omr_assignment_targets_active_student_idx
    on public.omr_assignment_targets (organization_id, student_profile_id, assignment_id)
    include (retake_source_attempt_id, retake_question_ids)
    where target_type = 'student' and status = 'active';
-- PostgreSQL does not index the referencing side of a foreign key. This keeps
-- retake-source RESTRICT checks and source-attempt lookups off a full scan.
create index if not exists omr_assignment_targets_retake_source_idx
    on public.omr_assignment_targets (retake_source_attempt_id)
    where retake_source_attempt_id is not null;
create index if not exists omr_attempts_assignment_student_completed_idx
    on public.omr_attempts (organization_id, assignment_id, student_id, finished_at desc, id desc)
    where status = 'completed' and assignment_id is not null;
-- Retake creation always filters by org + exam + student and chooses the most
-- recent completed base attempt. Equality columns precede the keyset order.
create index if not exists omr_attempts_student_exam_base_completed_idx
    on public.omr_attempts (
        organization_id, exam_id, student_id, finished_at desc, id desc
    ) include (assignment_id)
    where status = 'completed' and retake_source_attempt_id is null;

create or replace function public.omr_assign_students_v1(
    p_organization_id text,
    p_actor_user_id text,
    p_actor_role text,
    p_exam_id text,
    p_target_student_ids text[],
    p_mode text,
    p_expected_revision bigint,
    p_mutation_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_assignment public.omr_assignments%rowtype;
    v_exam public.omr_exams%rowtype;
    v_target_ids text[];
    v_assignment_id text;
    v_fingerprint text;
    v_valid_targets integer;
    v_retake_ready integer;
    v_target_count integer;
    v_plan text;
    v_assignment_exists boolean := false;
    v_reactivate boolean := false;
begin
    if nullif(pg_catalog.btrim(p_organization_id), '') is null
       or nullif(pg_catalog.btrim(p_actor_user_id), '') is null
       or nullif(pg_catalog.btrim(p_exam_id), '') is null
       or nullif(pg_catalog.btrim(p_mutation_id), '') is null
       or pg_catalog.length(p_organization_id) > 256
       or pg_catalog.length(p_actor_user_id) > 256
       or pg_catalog.length(p_exam_id) > 256
       or pg_catalog.length(p_mutation_id) > 256
       or p_mode not in ('base', 'retake')
       or p_expected_revision is null or p_expected_revision < 0
       or pg_catalog.cardinality(p_target_student_ids) not between 1 and 100
       or exists (
           select 1 from pg_catalog.unnest(p_target_student_ids) raw_id
            where nullif(pg_catalog.btrim(raw_id), '') is null
               or pg_catalog.length(raw_id) > 256
       ) then
        return pg_catalog.jsonb_build_object('status', 'invalid_request');
    end if;

    select pg_catalog.array_agg(target_id order by target_id)
      into v_target_ids
      from (
          select distinct pg_catalog.btrim(raw_id) as target_id
            from pg_catalog.unnest(p_target_student_ids) raw_id
      ) normalized;
    if pg_catalog.cardinality(v_target_ids) not between 1 and 100 then
        return pg_catalog.jsonb_build_object('status', 'invalid_request');
    end if;

    if p_actor_role not in ('owner', 'admin', 'teacher', 'assistant')
       or not exists (
           select 1
             from public.omr_organization_members member
            where member.organization_id = pg_catalog.btrim(p_organization_id)
              and member.user_id = pg_catalog.btrim(p_actor_user_id)
              and member.status = 'active'
              and member.role = p_actor_role
              and member.role in ('owner', 'admin', 'teacher', 'assistant')
       ) then
        return pg_catalog.jsonb_build_object('status', 'unauthorized');
    end if;

    select organization.plan into v_plan
      from public.omr_organizations organization
     where organization.id = pg_catalog.btrim(p_organization_id);
    if not found then
        return pg_catalog.jsonb_build_object('status', 'invalid_request');
    end if;
    if p_mode = 'retake' and v_plan = 'free' then
        return pg_catalog.jsonb_build_object('status', 'plan_denied');
    end if;

    v_assignment_id := 'assignment_targeted_' || pg_catalog.md5(
        pg_catalog.btrim(p_organization_id) || ':' || pg_catalog.btrim(p_exam_id)
    );
    v_fingerprint := pg_catalog.md5(
        pg_catalog.btrim(p_organization_id) || ':' || pg_catalog.btrim(p_actor_user_id)
        || ':' || pg_catalog.btrim(p_exam_id) || ':' || p_mode || ':'
        || pg_catalog.array_to_string(v_target_ids, ',') || ':' || p_expected_revision::text
    );
    -- Both assign and clear take the same advisory lock, then the exam row, then
    -- the deterministic assignment row. This serializes access-mode changes and
    -- keeps the lock order stable across both RPCs.
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_assignment_id, 608032));

    select * into v_exam
      from public.omr_exams exam
     where exam.organization_id = pg_catalog.btrim(p_organization_id)
       and exam.id = pg_catalog.btrim(p_exam_id)
       and exam.archived = false
     for update;
    if not found then
        return pg_catalog.jsonb_build_object('status', 'invalid_request');
    end if;
    if coalesce(v_exam.payload #>> '{accessConfig,type}', 'public') not in ('public', 'group', 'targeted') then
        return pg_catalog.jsonb_build_object('status', 'invalid_request');
    end if;

    select pg_catalog.count(distinct student.id)::integer into v_valid_targets
      from public.omr_student_profiles student
     where student.organization_id = pg_catalog.btrim(p_organization_id)
       and student.id = any(v_target_ids)
       and student.status = 'active'
       and exists (
           select 1
             from public.omr_class_students enrollment
             join public.omr_classes class
               on class.id = enrollment.class_id
              and class.organization_id = enrollment.organization_id
              and class.status = 'active'
            where enrollment.organization_id = student.organization_id
              and enrollment.student_profile_id = student.id
              and enrollment.enrollment_status = 'active'
       );
    if v_valid_targets is distinct from pg_catalog.cardinality(v_target_ids) then
        return pg_catalog.jsonb_build_object('status', 'invalid_targets');
    end if;

    select * into v_assignment
      from public.omr_assignments assignment
     where assignment.id = v_assignment_id
       and assignment.organization_id = pg_catalog.btrim(p_organization_id)
       and assignment.exam_id = pg_catalog.btrim(p_exam_id)
       and assignment.access_mode = 'targeted'
     for update;
    v_assignment_exists := found;
    v_reactivate := v_assignment_exists and v_assignment.status = 'archived';

    if v_assignment_exists
       and not v_reactivate
       and v_assignment.last_mutation_id = pg_catalog.btrim(p_mutation_id) then
        if v_assignment.last_mutation_fingerprint is distinct from v_fingerprint then
            return pg_catalog.jsonb_build_object('status', 'mutation_conflict');
        end if;
        select pg_catalog.count(*)::integer into v_target_count
          from public.omr_assignment_targets target
         where target.assignment_id = v_assignment.id
           and target.organization_id = v_assignment.organization_id
           and target.target_type = 'student'
           and target.status = 'active';
        return pg_catalog.jsonb_build_object(
            'status', 'saved', 'assignmentId', v_assignment.id,
            'revision', v_assignment.revision, 'targetCount', v_target_count,
            'mode', v_assignment.assignment_mode, 'idempotent', true
        );
    end if;

    if not v_assignment_exists then
        if p_expected_revision <> 0 then
            return pg_catalog.jsonb_build_object('status', 'revision_conflict', 'currentRevision', 0);
        end if;
    elsif v_reactivate then
        if p_expected_revision <> 0 then
            return pg_catalog.jsonb_build_object(
                'status', 'revision_conflict', 'currentRevision', v_assignment.revision
            );
        end if;
    else
        if v_assignment.revision is distinct from p_expected_revision then
            return pg_catalog.jsonb_build_object(
                'status', 'revision_conflict', 'currentRevision', v_assignment.revision
            );
        end if;
    end if;

    -- Check the whole exam scope, including assignment_id-null sessions created
    -- while the exam was still public/group. This applies to first assignment,
    -- edits, and reactivation after a clear.
    if exists (
        select 1 from public.omr_attempt_sessions attempt_session
         where attempt_session.organization_id = v_exam.organization_id
           and attempt_session.exam_id = v_exam.id
           and attempt_session.status = 'in_progress'
    ) then
        return pg_catalog.jsonb_build_object('status', 'active_sessions');
    end if;

    if p_mode = 'retake' then
        select pg_catalog.count(*)::integer into v_retake_ready
          from pg_catalog.unnest(v_target_ids) target_id
         where exists (
             select 1
               from public.omr_attempts source
              where source.organization_id = pg_catalog.btrim(p_organization_id)
                and source.exam_id = pg_catalog.btrim(p_exam_id)
                and source.student_id = target_id
                and source.status = 'completed'
                and source.retake_source_attempt_id is null
                and (source.assignment_id is null or source.assignment_id = v_assignment_id)
                and exists (
                    select 1 from public.omr_question_results result
                     where result.attempt_id = source.id
                       and result.status in ('wrong', 'unanswered')
                )
         );
        if v_retake_ready is distinct from pg_catalog.cardinality(v_target_ids) then
            return pg_catalog.jsonb_build_object('status', 'retake_unavailable');
        end if;
    end if;

    -- The exam access mode and normalized assignment rows are changed in this
    -- single function invocation, so callers cannot leave an exposed targeted
    -- assignment behind after an application-level second step fails.
    update public.omr_exams exam
       set payload = coalesce(exam.payload, '{}'::jsonb)
           || pg_catalog.jsonb_build_object(
               'accessConfig', pg_catalog.jsonb_build_object('type', 'targeted')
           ),
           updated_at = pg_catalog.now()
     where exam.organization_id = v_exam.organization_id
       and exam.id = v_exam.id;

    if not v_assignment_exists then
        insert into public.omr_assignments (
            id, organization_id, exam_id, title, access_mode, status,
            max_attempts, time_limit_min, created_by_user_id, metadata,
            revision, assignment_mode, last_mutation_id, last_mutation_fingerprint,
            opens_at, closes_at, created_at, updated_at
        ) values (
            v_assignment_id, pg_catalog.btrim(p_organization_id), v_exam.id,
            v_exam.title, 'targeted', 'open',
            case when p_mode = 'retake' then 2 else 1 end,
            case when (v_exam.payload ->> 'durationMin') ~ '^[0-9]+$'
                then (v_exam.payload ->> 'durationMin')::integer else null end,
            pg_catalog.btrim(p_actor_user_id),
            pg_catalog.jsonb_build_object('source', 'individual_student_assignment'),
            1, p_mode, pg_catalog.btrim(p_mutation_id), v_fingerprint,
            case when (v_exam.payload ->> 'startAt') ~ '^\\d{4}-\\d{2}-\\d{2}T'
                then (v_exam.payload ->> 'startAt')::timestamptz else null end,
            case when (v_exam.payload ->> 'endAt') ~ '^\\d{4}-\\d{2}-\\d{2}T'
                then (v_exam.payload ->> 'endAt')::timestamptz else null end,
            pg_catalog.now(), pg_catalog.now()
        ) returning * into v_assignment;
    else
        update public.omr_assignments assignment
           set title = v_exam.title,
               status = 'open',
               assignment_mode = p_mode,
               max_attempts = case when p_mode = 'retake' then 2 else 1 end,
               revision = assignment.revision + 1,
               last_mutation_id = pg_catalog.btrim(p_mutation_id),
               last_mutation_fingerprint = v_fingerprint,
               updated_at = pg_catalog.now()
         where assignment.id = v_assignment_id
        returning * into v_assignment;
    end if;

    delete from public.omr_assignment_targets target
     where target.assignment_id = v_assignment_id
       and target.organization_id = pg_catalog.btrim(p_organization_id)
       and target.target_type = 'student';

    if p_mode = 'base' then
        insert into public.omr_assignment_targets (
            id, assignment_id, organization_id, target_type, target_id,
            student_profile_id, status, retake_source_attempt_id, retake_question_ids
        )
        select v_assignment_id || ':student:' || pg_catalog.md5(target_id),
               v_assignment_id, pg_catalog.btrim(p_organization_id), 'student', target_id,
               target_id, 'active', null, '{}'::integer[]
          from pg_catalog.unnest(v_target_ids) target_id;
    else
        insert into public.omr_assignment_targets (
            id, assignment_id, organization_id, target_type, target_id,
            student_profile_id, status, retake_source_attempt_id, retake_question_ids
        )
        select v_assignment_id || ':student:' || pg_catalog.md5(target_id),
               v_assignment_id, pg_catalog.btrim(p_organization_id), 'student', target_id,
               target_id, 'active', source.id, source.question_ids
          from pg_catalog.unnest(v_target_ids) target_id
          cross join lateral (
              select attempt.id,
                     pg_catalog.array_agg(result.question_id order by result.question_id) as question_ids
                from public.omr_attempts attempt
                join public.omr_question_results result on result.attempt_id = attempt.id
               where attempt.organization_id = pg_catalog.btrim(p_organization_id)
                 and attempt.exam_id = pg_catalog.btrim(p_exam_id)
                 and attempt.student_id = target_id
                 and attempt.status = 'completed'
                 and attempt.retake_source_attempt_id is null
                 and (attempt.assignment_id is null or attempt.assignment_id = v_assignment_id)
                 and result.status in ('wrong', 'unanswered')
               group by attempt.id, attempt.finished_at
               order by attempt.finished_at desc, attempt.id desc
               limit 1
          ) source;

        -- Public/group distribution historically left assignment_id null. Adopt
        -- that exact owned base attempt into the new targeted gradebook scope so
        -- the existing durable-session max-attempt and retake-source invariants
        -- remain true without weakening them for unrelated assignments.
        update public.omr_attempts attempt
           set assignment_id = v_assignment_id,
               payload = attempt.payload || pg_catalog.jsonb_build_object('assignmentId', v_assignment_id)
          from public.omr_assignment_targets target
         where target.assignment_id = v_assignment_id
           and target.retake_source_attempt_id = attempt.id
           and attempt.organization_id = pg_catalog.btrim(p_organization_id)
           and attempt.exam_id = pg_catalog.btrim(p_exam_id)
           and attempt.student_id = target.student_profile_id
           and attempt.status = 'completed'
           and attempt.retake_source_attempt_id is null
           and attempt.assignment_id is null;
        update public.omr_question_results result
           set assignment_id = v_assignment_id
          from public.omr_assignment_targets target
         where target.assignment_id = v_assignment_id
           and target.retake_source_attempt_id = result.attempt_id
           and result.organization_id = pg_catalog.btrim(p_organization_id)
           and result.exam_id = pg_catalog.btrim(p_exam_id)
           and result.student_id = target.student_profile_id;
    end if;

    select pg_catalog.count(*)::integer into v_target_count
      from public.omr_assignment_targets target
     where target.assignment_id = v_assignment_id
       and target.organization_id = pg_catalog.btrim(p_organization_id)
       and target.target_type = 'student'
       and target.status = 'active';
    if v_target_count is distinct from pg_catalog.cardinality(v_target_ids) then
        raise exception 'individual assignment target write mismatch';
    end if;
    return pg_catalog.jsonb_build_object(
        'status', 'saved', 'assignmentId', v_assignment_id,
        'revision', v_assignment.revision, 'targetCount', v_target_count, 'mode', p_mode
    );
end;
$$;

revoke all on function public.omr_assign_students_v1(text,text,text,text,text[],text,bigint,text)
    from public, anon, authenticated;
grant execute on function public.omr_assign_students_v1(text,text,text,text,text[],text,bigint,text)
    to service_role;

create or replace function public.omr_clear_student_assignment_v1(
    p_organization_id text,
    p_actor_user_id text,
    p_actor_role text,
    p_exam_id text,
    p_expected_revision bigint,
    p_access_type text,
    p_group_ids text[],
    p_mutation_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_assignment public.omr_assignments%rowtype;
    v_exam public.omr_exams%rowtype;
    v_assignment_id text;
    v_group_ids text[] := '{}'::text[];
    v_fingerprint text;
    v_valid_groups integer;
    v_access_config jsonb;
begin
    if nullif(pg_catalog.btrim(p_organization_id), '') is null
       or nullif(pg_catalog.btrim(p_actor_user_id), '') is null
       or nullif(pg_catalog.btrim(p_exam_id), '') is null
       or nullif(pg_catalog.btrim(p_mutation_id), '') is null
       or pg_catalog.length(p_organization_id) > 256
       or pg_catalog.length(p_actor_user_id) > 256
       or pg_catalog.length(p_exam_id) > 256
       or pg_catalog.length(p_mutation_id) > 256
       or p_expected_revision is null or p_expected_revision < 1
       or p_access_type not in ('public', 'group') then
        return pg_catalog.jsonb_build_object('status', 'invalid_request');
    end if;
    if p_actor_role not in ('owner', 'admin', 'teacher', 'assistant')
       or not exists (
           select 1 from public.omr_organization_members member
            where member.organization_id = pg_catalog.btrim(p_organization_id)
              and member.user_id = pg_catalog.btrim(p_actor_user_id)
              and member.status = 'active'
              and member.role = p_actor_role
              and member.role in ('owner', 'admin', 'teacher', 'assistant')
       ) then
        return pg_catalog.jsonb_build_object('status', 'unauthorized');
    end if;

    if p_access_type = 'public' then
        if pg_catalog.cardinality(coalesce(p_group_ids, '{}'::text[])) <> 0 then
            return pg_catalog.jsonb_build_object('status', 'invalid_request');
        end if;
    else
        if pg_catalog.cardinality(p_group_ids) not between 1 and 100
           or exists (
               select 1 from pg_catalog.unnest(p_group_ids) raw_id
                where nullif(pg_catalog.btrim(raw_id), '') is null
                   or pg_catalog.length(raw_id) > 256
           ) then
            return pg_catalog.jsonb_build_object('status', 'invalid_request');
        end if;
        select pg_catalog.array_agg(group_id order by group_id)
          into v_group_ids
          from (
              select distinct pg_catalog.btrim(raw_id) as group_id
                from pg_catalog.unnest(p_group_ids) raw_id
          ) normalized;
        if pg_catalog.cardinality(v_group_ids) not between 1 and 100 then
            return pg_catalog.jsonb_build_object('status', 'invalid_request');
        end if;
        select pg_catalog.count(*)::integer into v_valid_groups
          from public.omr_classes class
         where class.organization_id = pg_catalog.btrim(p_organization_id)
           and class.id = any(v_group_ids)
           and class.status = 'active';
        if v_valid_groups is distinct from pg_catalog.cardinality(v_group_ids) then
            return pg_catalog.jsonb_build_object('status', 'invalid_groups');
        end if;
    end if;

    v_assignment_id := 'assignment_targeted_' || pg_catalog.md5(
        pg_catalog.btrim(p_organization_id) || ':' || pg_catalog.btrim(p_exam_id)
    );
    v_fingerprint := pg_catalog.md5(
        pg_catalog.btrim(p_organization_id) || ':' || pg_catalog.btrim(p_actor_user_id)
        || ':' || pg_catalog.btrim(p_exam_id) || ':' || p_access_type || ':'
        || pg_catalog.array_to_string(v_group_ids, ',') || ':' || p_expected_revision::text
    );
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_assignment_id, 608032));

    select * into v_exam
      from public.omr_exams exam
     where exam.organization_id = pg_catalog.btrim(p_organization_id)
       and exam.id = pg_catalog.btrim(p_exam_id)
       and exam.archived = false
     for update;
    if not found then
        return pg_catalog.jsonb_build_object('status', 'invalid_request');
    end if;
    select * into v_assignment
      from public.omr_assignments assignment
     where assignment.id = v_assignment_id
       and assignment.organization_id = v_exam.organization_id
       and assignment.exam_id = v_exam.id
       and assignment.access_mode = 'targeted'
     for update;
    if not found then
        return pg_catalog.jsonb_build_object('status', 'not_found');
    end if;

    if v_assignment.last_mutation_id = pg_catalog.btrim(p_mutation_id) then
        if v_assignment.last_mutation_fingerprint is distinct from v_fingerprint then
            return pg_catalog.jsonb_build_object('status', 'mutation_conflict');
        end if;
        if v_assignment.status = 'archived'
           and v_exam.payload #>> '{accessConfig,type}' = p_access_type
           and (
               p_access_type = 'public'
               or v_exam.payload #> '{accessConfig,groupIds}' = pg_catalog.to_jsonb(v_group_ids)
           ) then
            return pg_catalog.jsonb_build_object(
                'status', 'cleared', 'assignmentId', v_assignment.id,
                'revision', v_assignment.revision, 'accessType', p_access_type,
                'idempotent', true
            );
        end if;
        return pg_catalog.jsonb_build_object('status', 'mutation_conflict');
    end if;
    if v_assignment.status = 'archived'
       or v_assignment.revision is distinct from p_expected_revision then
        return pg_catalog.jsonb_build_object(
            'status', 'revision_conflict', 'currentRevision', v_assignment.revision
        );
    end if;
    if exists (
        select 1 from public.omr_attempt_sessions attempt_session
         where attempt_session.organization_id = v_exam.organization_id
           and attempt_session.exam_id = v_exam.id
           and attempt_session.status = 'in_progress'
    ) then
        return pg_catalog.jsonb_build_object('status', 'active_sessions');
    end if;

    update public.omr_assignment_targets target
       set status = 'removed'
     where target.assignment_id = v_assignment.id
       and target.organization_id = v_assignment.organization_id
       and target.status <> 'removed';
    update public.omr_assignments assignment
       set status = 'archived',
           revision = assignment.revision + 1,
           last_mutation_id = pg_catalog.btrim(p_mutation_id),
           last_mutation_fingerprint = v_fingerprint,
           updated_at = pg_catalog.now()
     where assignment.id = v_assignment.id
    returning * into v_assignment;

    v_access_config := case when p_access_type = 'group'
        then pg_catalog.jsonb_build_object(
            'type', 'group', 'groupIds', pg_catalog.to_jsonb(v_group_ids)
        )
        else pg_catalog.jsonb_build_object('type', 'public')
    end;
    -- Archive first so the targeted-access trigger permits this broad transition.
    -- Both changes still commit or roll back as one function statement.
    update public.omr_exams exam
       set payload = coalesce(exam.payload, '{}'::jsonb)
           || pg_catalog.jsonb_build_object('accessConfig', v_access_config),
           updated_at = pg_catalog.now()
     where exam.organization_id = v_exam.organization_id
       and exam.id = v_exam.id;

    return pg_catalog.jsonb_build_object(
        'status', 'cleared', 'assignmentId', v_assignment.id,
        'revision', v_assignment.revision, 'accessType', p_access_type
    );
end;
$$;
revoke all on function public.omr_clear_student_assignment_v1(text,text,text,text,bigint,text,text[],text)
    from public, anon, authenticated;
grant execute on function public.omr_clear_student_assignment_v1(text,text,text,text,bigint,text,text[],text)
    to service_role;

create or replace function public.omr_load_teacher_student_assignment_v1(
    p_organization_id text,
    p_actor_user_id text,
    p_actor_role text,
    p_exam_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_assignment public.omr_assignments%rowtype;
    v_target_ids text[];
begin
    if p_actor_role not in ('owner', 'admin', 'teacher', 'assistant')
       or not exists (
           select 1 from public.omr_organization_members member
            where member.organization_id = pg_catalog.btrim(p_organization_id)
              and member.user_id = pg_catalog.btrim(p_actor_user_id)
              and member.status = 'active'
              and member.role = p_actor_role
       ) then return pg_catalog.jsonb_build_object('status', 'unauthorized'); end if;
    select * into v_assignment from public.omr_assignments assignment
     where assignment.organization_id = pg_catalog.btrim(p_organization_id)
       and assignment.exam_id = pg_catalog.btrim(p_exam_id)
       and assignment.access_mode = 'targeted'
       and assignment.status <> 'archived';
    if not found then return pg_catalog.jsonb_build_object('status', 'not_found'); end if;
    select pg_catalog.array_agg(target.student_profile_id order by target.student_profile_id)
      into v_target_ids from public.omr_assignment_targets target
     where target.assignment_id = v_assignment.id
       and target.organization_id = v_assignment.organization_id
       and target.target_type = 'student' and target.status = 'active';
    return pg_catalog.jsonb_build_object(
        'status', 'loaded', 'assignmentId', v_assignment.id,
        'revision', v_assignment.revision, 'mode', v_assignment.assignment_mode,
        'targetStudentIds', coalesce(v_target_ids, '{}'::text[])
    );
end;
$$;
revoke all on function public.omr_load_teacher_student_assignment_v1(text,text,text,text)
    from public, anon, authenticated;
grant execute on function public.omr_load_teacher_student_assignment_v1(text,text,text,text)
    to service_role;

create or replace function public.omr_list_student_assignments_v1(
    p_organization_id text,
    p_owner_student_id text,
    p_identity_type text,
    p_group_id text,
    p_group_name text
)
returns table (
    assignment_id text,
    assignment_mode text,
    retake_source_attempt_id text,
    retake_question_ids integer[],
    id text,
    title text,
    created_at timestamptz,
    updated_at timestamptz,
    archived boolean,
    duration_min integer,
    start_at text,
    end_at text,
    access_type text
)
language sql
security definer
set search_path = ''
as $$
    with visible as (
        select null::text as assignment_id, null::text as assignment_mode,
               null::text as retake_source_attempt_id, '{}'::integer[] as retake_question_ids,
               exam.id, exam.title, exam.created_at, exam.updated_at, exam.archived,
               case when (exam.payload ->> 'durationMin') ~ '^[0-9]+$'
                   then (exam.payload ->> 'durationMin')::integer else null end as duration_min,
               exam.payload ->> 'startAt' as start_at, exam.payload ->> 'endAt' as end_at,
               case when exam.payload #>> '{accessConfig,type}' = 'group' then 'group' else 'public' end as access_type
          from public.omr_exams exam
         where p_identity_type in ('guest', 'temporary', 'registered')
           and exam.organization_id = pg_catalog.btrim(p_organization_id)
           and not exam.archived
           and coalesce(exam.payload #>> '{accessConfig,type}', 'public') in ('public', 'group')
           and not exists (
               select 1 from public.omr_assignments targeted
                where targeted.organization_id = exam.organization_id
                  and targeted.exam_id = exam.id
                  and targeted.access_mode = 'targeted'
                  and targeted.status <> 'archived'
           )
           and (
               exam.payload #>> '{accessConfig,type}' is distinct from 'group'
               or (
                   p_identity_type <> 'guest'
                   and exists (
                       select 1 from pg_catalog.jsonb_array_elements_text(
                           coalesce(exam.payload #> '{accessConfig,groupIds}', '[]'::jsonb)
                       ) group_value
                        where group_value = pg_catalog.btrim(p_group_id)
                           or group_value = pg_catalog.btrim(p_group_name)
                   )
               )
           )
        union all
        select assignment.id, assignment.assignment_mode,
               target.retake_source_attempt_id, target.retake_question_ids,
               exam.id, exam.title, exam.created_at, exam.updated_at, exam.archived,
               case when (exam.payload ->> 'durationMin') ~ '^[0-9]+$'
                   then (exam.payload ->> 'durationMin')::integer else null end,
               exam.payload ->> 'startAt', exam.payload ->> 'endAt', 'targeted'
          from public.omr_assignment_targets target
          join public.omr_assignments assignment
            on assignment.id = target.assignment_id
           and assignment.organization_id = target.organization_id
           and assignment.access_mode = 'targeted'
           and assignment.status in ('scheduled', 'open')
          join public.omr_exams exam
            on exam.id = assignment.exam_id
           and exam.organization_id = assignment.organization_id
           and not exam.archived
         where p_identity_type in ('temporary', 'registered')
           and target.organization_id = pg_catalog.btrim(p_organization_id)
           and target.student_profile_id = pg_catalog.btrim(p_owner_student_id)
           and target.target_type = 'student' and target.status = 'active'
           and exists (
               select 1 from public.omr_student_profiles student
                where student.organization_id = target.organization_id
                  and student.id = target.student_profile_id
                  and student.status = 'active'
           )
           and exists (
               select 1
                 from public.omr_class_students enrollment
                 join public.omr_classes class
                   on class.id = enrollment.class_id
                  and class.organization_id = enrollment.organization_id
                  and class.status = 'active'
                where enrollment.organization_id = target.organization_id
                  and enrollment.student_profile_id = target.student_profile_id
                  and enrollment.enrollment_status = 'active'
           )
    )
    select * from visible
     order by updated_at desc, id, assignment_id nulls first
     limit 101
$$;
revoke all on function public.omr_list_student_assignments_v1(text,text,text,text,text)
    from public, anon, authenticated;
grant execute on function public.omr_list_student_assignments_v1(text,text,text,text,text)
    to service_role;

create or replace function public.omr_resolve_student_assignment_v1(
    p_organization_id text,
    p_owner_student_id text,
    p_identity_type text,
    p_group_id text,
    p_group_name text,
    p_assignment_id text,
    p_exam_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_assignment public.omr_assignments%rowtype;
    v_target public.omr_assignment_targets%rowtype;
begin
    if p_identity_type is null or p_identity_type not in ('temporary', 'registered') then
        return pg_catalog.jsonb_build_object('status', 'denied');
    end if;
    select * into v_assignment
      from public.omr_assignments assignment
     where assignment.id = pg_catalog.btrim(p_assignment_id)
       and assignment.organization_id = pg_catalog.btrim(p_organization_id)
       and assignment.exam_id = pg_catalog.btrim(p_exam_id)
       and assignment.access_mode = 'targeted'
       and assignment.status in ('scheduled', 'open');
    if not found then return pg_catalog.jsonb_build_object('status', 'denied'); end if;
    select * into v_target
      from public.omr_assignment_targets target
     where target.assignment_id = v_assignment.id
       and target.organization_id = v_assignment.organization_id
       and target.target_type = 'student'
       and target.status = 'active'
       and target.student_profile_id = pg_catalog.btrim(p_owner_student_id);
    if not found
       or not exists (
           select 1 from public.omr_student_profiles student
            where student.organization_id = v_assignment.organization_id
              and student.id = v_target.student_profile_id
              and student.status = 'active'
       )
       or not exists (
           select 1
             from public.omr_class_students enrollment
             join public.omr_classes class
               on class.id = enrollment.class_id
              and class.organization_id = enrollment.organization_id
              and class.status = 'active'
            where enrollment.organization_id = v_assignment.organization_id
              and enrollment.student_profile_id = v_target.student_profile_id
              and enrollment.enrollment_status = 'active'
       ) then return pg_catalog.jsonb_build_object('status', 'denied'); end if;
    return pg_catalog.jsonb_build_object(
        'status', 'authorized', 'assignmentId', v_assignment.id,
        'examId', v_assignment.exam_id, 'mode', v_assignment.assignment_mode,
        'sourceAttemptId', v_target.retake_source_attempt_id,
        'questionIds', v_target.retake_question_ids
    );
end;
$$;
revoke all on function public.omr_resolve_student_assignment_v1(text,text,text,text,text,text,text)
    from public, anon, authenticated;
grant execute on function public.omr_resolve_student_assignment_v1(text,text,text,text,text,text,text)
    to service_role;

create or replace function public.omr_assert_targeted_assignment_scope_v1(
    p_organization_id text,
    p_exam_id text,
    p_assignment_id text,
    p_owner_student_id text,
    p_identity_type text,
    p_retake_source_attempt_id text,
    p_retake_question_ids integer[]
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_assignment public.omr_assignments%rowtype;
    v_target public.omr_assignment_targets%rowtype;
    v_actual_question_ids integer[];
    v_exam public.omr_exams%rowtype;
begin
    if nullif(pg_catalog.btrim(p_retake_source_attempt_id), '') is not null
       and exists (
           select 1 from public.omr_organizations organization
            where organization.id = pg_catalog.btrim(p_organization_id)
              and organization.plan = 'free'
       ) then
        raise exception 'free plan denies retake';
    end if;
    select * into v_exam
      from public.omr_exams exam
     where exam.organization_id = pg_catalog.btrim(p_organization_id)
       and exam.id = pg_catalog.btrim(p_exam_id);
    if nullif(pg_catalog.btrim(p_assignment_id), '') is null then
        if found and coalesce(v_exam.payload #>> '{accessConfig,type}', 'public') = 'targeted' then
            raise exception 'targeted exam requires assignment';
        end if;
        return;
    end if;
    select * into v_assignment from public.omr_assignments assignment
     where assignment.id = pg_catalog.btrim(p_assignment_id)
       and assignment.organization_id = pg_catalog.btrim(p_organization_id)
       and assignment.exam_id = pg_catalog.btrim(p_exam_id);
    if not found then raise exception 'assignment organization or exam invalid'; end if;
    -- Existing class/code assignments keep their legacy checks. Only an exact
    -- existing, organization+exam-bound non-targeted assignment may bypass the
    -- student-target guard; a garbage id cannot.
    if v_assignment.access_mode <> 'targeted' then return; end if;
    if p_identity_type is null
       or p_identity_type not in ('temporary', 'registered') then
        raise exception 'attempt identity type invalid';
    end if;
    select * into v_target from public.omr_assignment_targets target
     where target.assignment_id = pg_catalog.btrim(p_assignment_id)
       and target.organization_id = pg_catalog.btrim(p_organization_id)
       and target.student_profile_id = pg_catalog.btrim(p_owner_student_id)
       and target.target_type = 'student' and target.status = 'active';
    if not found then raise exception 'targeted assignment is not owned by student'; end if;
    if not exists (
        select 1 from public.omr_student_profiles student
         where student.organization_id = v_target.organization_id
           and student.id = v_target.student_profile_id
           and student.status = 'active'
    ) or not exists (
        select 1
          from public.omr_class_students enrollment
          join public.omr_classes class
            on class.id = enrollment.class_id
           and class.organization_id = enrollment.organization_id
           and class.status = 'active'
         where enrollment.organization_id = v_target.organization_id
           and enrollment.student_profile_id = v_target.student_profile_id
           and enrollment.enrollment_status = 'active'
    ) then raise exception 'targeted assignment roster inactive'; end if;
    if v_target.retake_source_attempt_id is null then
        if nullif(pg_catalog.btrim(p_retake_source_attempt_id), '') is not null then
            raise exception 'targeted assignment retake scope invalid';
        end if;
    else
        if v_target.retake_source_attempt_id is distinct from nullif(pg_catalog.btrim(p_retake_source_attempt_id), '')
           or v_target.retake_question_ids is distinct from coalesce(p_retake_question_ids, '{}'::integer[]) then
            raise exception 'targeted assignment retake scope invalid';
        end if;
        if not exists (
            select 1 from public.omr_attempts source
             where source.id = v_target.retake_source_attempt_id
               and source.organization_id = v_assignment.organization_id
               and source.exam_id = v_assignment.exam_id
               and (source.assignment_id is null or source.assignment_id = v_assignment.id)
               and source.student_id = v_target.student_profile_id
               and source.status = 'completed'
               and source.retake_source_attempt_id is null
        ) then raise exception 'targeted assignment retake source invalid'; end if;
        select pg_catalog.array_agg(result.question_id order by result.question_id)
          into v_actual_question_ids from public.omr_question_results result
         where result.attempt_id = v_target.retake_source_attempt_id
           and result.status in ('wrong', 'unanswered');
        if v_actual_question_ids is distinct from v_target.retake_question_ids then
            raise exception 'targeted assignment retake questions stale';
        end if;
    end if;
end;
$$;
revoke all on function public.omr_assert_targeted_assignment_scope_v1(text,text,text,text,text,text,integer[])
    from public, anon, authenticated, service_role;

create or replace function public.omr_validate_targeted_attempt_session_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    perform public.omr_assert_targeted_assignment_scope_v1(
        new.organization_id, new.exam_id, new.assignment_id, new.owner_student_id, new.identity_type,
        new.retake_source_attempt_id, new.allowed_question_ids
    );
    return new;
end;
$$;
revoke all on function public.omr_validate_targeted_attempt_session_v1()
    from public, anon, authenticated, service_role;
drop trigger if exists omr_attempt_session_target_guard on public.omr_attempt_sessions;
create trigger omr_attempt_session_target_guard
    before insert or update on public.omr_attempt_sessions
    for each row execute function public.omr_validate_targeted_attempt_session_v1();

create or replace function public.omr_validate_targeted_attempt_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    -- Retake creation may adopt one historical public/group base attempt into
    -- the exact assignment selected for it. Permit only that assignment/payload
    -- binding update; every substantive attempt field must remain unchanged.
    if tg_op = 'UPDATE'
       and old.assignment_id is null
       and new.assignment_id is not null
       and new.identity_type in ('temporary', 'registered')
       and new.organization_id is not distinct from old.organization_id
       and new.exam_id is not distinct from old.exam_id
       and new.student_id is not distinct from old.student_id
       and new.student_profile_id is not distinct from old.student_profile_id
       and new.identity_type is not distinct from old.identity_type
       and new.status is not distinct from old.status
       and new.score is not distinct from old.score
       and new.total_score is not distinct from old.total_score
       and new.score_percent is not distinct from old.score_percent
       and new.retake_source_attempt_id is not distinct from old.retake_source_attempt_id
       and new.retake_question_ids is not distinct from old.retake_question_ids
       and new.started_at is not distinct from old.started_at
       and new.finished_at is not distinct from old.finished_at
       and new.payload = old.payload || pg_catalog.jsonb_build_object('assignmentId', new.assignment_id)
       and exists (
           select 1
             from public.omr_assignments assignment
             join public.omr_assignment_targets target
               on target.assignment_id = assignment.id
              and target.organization_id = assignment.organization_id
              and target.target_type = 'student'
              and target.status = 'active'
            where assignment.id = new.assignment_id
              and assignment.organization_id = new.organization_id
              and assignment.exam_id = new.exam_id
              and assignment.access_mode = 'targeted'
              and assignment.status in ('scheduled', 'open')
              and target.student_profile_id = new.student_id
              and target.retake_source_attempt_id = new.id
              and exists (
                  select 1 from public.omr_organizations organization
                   where organization.id = new.organization_id
                     and organization.plan <> 'free'
              )
       ) then
        return new;
    end if;
    perform public.omr_assert_targeted_assignment_scope_v1(
        new.organization_id, new.exam_id, new.assignment_id, new.student_id, new.identity_type,
        new.retake_source_attempt_id, new.retake_question_ids
    );
    return new;
end;
$$;
revoke all on function public.omr_validate_targeted_attempt_v1()
    from public, anon, authenticated, service_role;
drop trigger if exists omr_attempt_target_guard on public.omr_attempts;
create trigger omr_attempt_target_guard
    before insert or update on public.omr_attempts
    for each row execute function public.omr_validate_targeted_attempt_v1();

-- Once a targeted assignment exists, an exam cannot be downgraded to a broad
-- access mode while that assignment remains active. This prevents a direct
-- exam URL from bypassing the normalized target rows.
create or replace function public.omr_guard_targeted_exam_access_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    if coalesce(new.payload #>> '{accessConfig,type}', 'public') <> 'targeted'
       and exists (
           select 1 from public.omr_assignments assignment
            where assignment.organization_id = new.organization_id
              and assignment.exam_id = new.id
              and assignment.access_mode = 'targeted'
              and assignment.status <> 'archived'
       ) then
        raise exception 'active targeted assignment requires targeted exam access';
    end if;
    return new;
end;
$$;
revoke all on function public.omr_guard_targeted_exam_access_v1()
    from public, anon, authenticated, service_role;
drop trigger if exists omr_exam_targeted_access_guard on public.omr_exams;
create trigger omr_exam_targeted_access_guard
    before update of payload on public.omr_exams
    for each row execute function public.omr_guard_targeted_exam_access_v1();

commit;
