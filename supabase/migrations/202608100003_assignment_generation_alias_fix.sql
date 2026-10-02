begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

-- Deploy-safe correction for PL/pgSQL record names that collided with SQL
-- aliases in the already-deployed 202608090001 assignment generation migration.
create or replace function public.omr_open_attempt_session_v3(
    p_session_id text,
    p_organization_id text,
    p_exam_id text,
    p_assignment_id text,
    p_assignment_revision bigint,
    p_owner_student_id text,
    p_student_name text,
    p_identity_type text,
    p_submission_id text,
    p_attempt_id text,
    p_retake_source_attempt_id text,
    p_retake_mode text,
    p_requested_question_ids integer[],
    p_exam_question_ids integer[],
    p_exam_updated_at timestamptz,
    p_grading_snapshot jsonb,
    p_duration_seconds integer,
    p_exam_ends_at timestamptz,
    p_new_lease_token_hash text,
    p_current_lease_token_hash text,
    p_lease_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
set lock_timeout = '2s'
as $$
declare
    v_now timestamptz;
    v_session public.omr_attempt_sessions%rowtype;
    v_source public.omr_attempts%rowtype;
    v_assignment public.omr_assignments%rowtype;
    v_exam public.omr_exams%rowtype;
    v_effective jsonb;
    v_assignment_id text := nullif(pg_catalog.btrim(p_assignment_id), '');
    v_exam_ids integer[];
    v_requested integer[];
    v_allowed integer[];
    v_scope_key text;
    v_max_attempts integer;
    v_used_attempts integer;
    v_active_reservations integer;
    v_deadline timestamptz;
    v_exam_start_text text;
    v_exam_end_text text;
    v_exam_start timestamptz;
    v_exam_end timestamptz;
    v_lease_seconds integer := least(greatest(coalesce(p_lease_seconds, 45), 30), 120);
    v_exact_submission boolean := false;
    v_lease_acquired boolean := false;
    v_lease_token_rotated boolean := false;
begin
    if nullif(pg_catalog.btrim(p_session_id), '') is null
       or nullif(pg_catalog.btrim(p_organization_id), '') is null
       or nullif(pg_catalog.btrim(p_exam_id), '') is null
       or nullif(pg_catalog.btrim(p_owner_student_id), '') is null
       or nullif(pg_catalog.btrim(p_submission_id), '') is null
       or nullif(pg_catalog.btrim(p_attempt_id), '') is null
       or nullif(pg_catalog.btrim(p_new_lease_token_hash), '') is null
       or nullif(pg_catalog.btrim(p_student_name), '') is null
       or p_identity_type not in ('guest', 'temporary', 'registered')
       or pg_catalog.jsonb_typeof(p_grading_snapshot) is distinct from 'object'
       or pg_catalog.pg_column_size(p_grading_snapshot) > 1048576
       or coalesce(p_duration_seconds, 0) not between 1 and 43200
       or (v_assignment_id is null) is distinct from (p_assignment_revision is null)
       or (p_assignment_revision is not null and p_assignment_revision <= 0) then
        raise exception 'invalid attempt session open';
    end if;

    -- Exact submitted response-loss replay is read-only, canonical, and is
    -- resolved before checking whether the assignment has since advanced.
    select * into v_session
      from public.omr_attempt_sessions attempt_session
     where attempt_session.id = pg_catalog.btrim(p_session_id)
       and attempt_session.organization_id = pg_catalog.btrim(p_organization_id)
       and attempt_session.exam_id = pg_catalog.btrim(p_exam_id)
       and attempt_session.owner_student_id = pg_catalog.btrim(p_owner_student_id)
       and attempt_session.submission_id = pg_catalog.btrim(p_submission_id)
       and attempt_session.attempt_id = pg_catalog.btrim(p_attempt_id)
       and attempt_session.assignment_id is not distinct from v_assignment_id
       and attempt_session.assignment_revision is not distinct from p_assignment_revision
       and attempt_session.status = 'submitted'
       and exists (
           select 1 from public.omr_attempts attempt
            where attempt.id=attempt_session.submitted_attempt_id
              and attempt.id=pg_catalog.btrim(p_attempt_id)
              and attempt.organization_id=attempt_session.organization_id
              and attempt.exam_id=attempt_session.exam_id
              and attempt.student_id=attempt_session.owner_student_id
              and attempt.identity_type=attempt_session.identity_type
              and attempt.assignment_id is not distinct from attempt_session.assignment_id
              and attempt.assignment_revision is not distinct from attempt_session.assignment_revision
              and attempt.retake_source_attempt_id is not distinct from attempt_session.retake_source_attempt_id
              and attempt.retake_mode is not distinct from attempt_session.retake_mode
              and attempt.status='completed'
       );
    if found then
        return pg_catalog.jsonb_build_object(
            'session_id', v_session.id, 'exam_id', v_session.exam_id,
            'assignment_id', v_session.assignment_id, 'status', v_session.status,
            'revision', v_session.revision, 'lease_epoch', v_session.lease_epoch,
            'started_at', v_session.started_at, 'deadline_at', v_session.deadline_at,
            'server_now', pg_catalog.clock_timestamp(), 'answers', '{}'::jsonb,
            'sub_question_answers', '{}'::jsonb, 'progress_payload', '{}'::jsonb,
            'allowed_question_ids', v_session.allowed_question_ids,
            'grading_snapshot', '{}'::jsonb,
            'submitted_attempt_id', v_session.submitted_attempt_id,
            'assignment_revision', v_session.assignment_revision,
            'lease_acquired', false, 'lease_token_rotated', false
        );
    end if;

    -- Retake insertion is guarded by an expiry-bearing transaction proof.
    -- Acquire the effective-plan topology before any assignment/exam/session
    -- domain locks; submitted response-loss replay above remains read-only.
    if nullif(pg_catalog.btrim(p_retake_source_attempt_id), '') is not null then
        v_effective := public.omr_prove_effective_organization_plan_v1(
            pg_catalog.btrim(p_organization_id)
        );
        if v_effective ->> 'plan' not in ('pro', 'academy') then
            raise exception 'effective plan denies retake session';
        end if;
    end if;

    if v_assignment_id is not null then
        perform pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended(
            v_assignment_id, 608032
        ));
        select * into v_assignment
          from public.omr_assignments assignment_row
         where assignment_row.organization_id = pg_catalog.btrim(p_organization_id)
           and assignment_row.exam_id = pg_catalog.btrim(p_exam_id)
           and assignment_row.id = v_assignment_id
           and assignment_row.access_mode = 'targeted'
         for share;
        if not found or v_assignment.revision is distinct from p_assignment_revision then
            raise exception 'assignment generation stale';
        end if;
    end if;
    select * into v_exam
      from public.omr_exams exam_row
     where exam_row.organization_id = pg_catalog.btrim(p_organization_id)
       and exam_row.id = pg_catalog.btrim(p_exam_id)
       and not exam_row.archived
     for share;
    if not found or p_exam_updated_at is distinct from v_exam.updated_at then
        raise exception 'attempt session exam unavailable';
    end if;
    v_now := pg_catalog.clock_timestamp();

    -- The locked exam payload is the only lifecycle authority. The caller's
    -- end timestamp is retained solely as an exact stale-request check.
    v_exam_start_text := nullif(pg_catalog.btrim(v_exam.payload ->> 'startAt'), '');
    v_exam_end_text := nullif(pg_catalog.btrim(v_exam.payload ->> 'endAt'), '');
    if (v_exam_start_text is not null and v_exam_start_text !~
            '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$')
       or (v_exam_end_text is not null and v_exam_end_text !~
            '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$') then
        raise exception 'attempt session exam lifecycle invalid';
    end if;
    begin
        v_exam_start := case when v_exam_start_text is null then null
            else v_exam_start_text::timestamptz end;
        v_exam_end := case when v_exam_end_text is null then null
            else v_exam_end_text::timestamptz end;
    exception when others then
        raise exception 'attempt session exam lifecycle invalid';
    end;
    if v_exam_start is not null and v_exam_end is not null
       and v_exam_start >= v_exam_end then
        raise exception 'attempt session exam lifecycle invalid';
    end if;
    if p_exam_ends_at is distinct from v_exam_end then
        raise exception 'attempt session exam lifecycle stale';
    end if;
    if v_exam_start is not null and v_now < v_exam_start then
        raise exception 'attempt session exam not started';
    end if;
    if v_exam_end is not null and v_now >= v_exam_end then
        raise exception 'attempt session exam ended';
    end if;

    select pg_catalog.array_agg(question_id order by question_id) into v_exam_ids
      from (select distinct question_id
              from pg_catalog.unnest(coalesce(p_exam_question_ids, '{}'::integer[])) question_id
             where question_id > 0) ids;
    if coalesce(pg_catalog.cardinality(v_exam_ids), 0) not between 1 and 500 then
        raise exception 'invalid attempt session question scope';
    end if;
    if nullif(pg_catalog.btrim(p_retake_source_attempt_id), '') is null then
        if nullif(pg_catalog.btrim(p_retake_mode), '') is not null then
            raise exception 'attempt session retake scope invalid';
        end if;
        v_allowed := v_exam_ids;
        v_scope_key := 'base';
    else
        if p_retake_mode not in ('wrong', 'similar', 'custom') then
            raise exception 'attempt session retake scope invalid';
        end if;
        select * into v_source
          from public.omr_attempts source
         where source.id = pg_catalog.btrim(p_retake_source_attempt_id)
           and source.organization_id = pg_catalog.btrim(p_organization_id)
           and source.exam_id = pg_catalog.btrim(p_exam_id)
           and source.student_id = pg_catalog.btrim(p_owner_student_id)
           and source.status = 'completed'
         for share;
        if not found then raise exception 'retake source attempt is not owned by student'; end if;
        if p_retake_mode = 'wrong' then
            select pg_catalog.array_agg(result.question_id order by result.question_id) into v_allowed
              from public.omr_question_results result
             where result.attempt_id = v_source.id
               and result.status in ('wrong', 'unanswered')
               and result.question_id = any(v_exam_ids);
        else
            select pg_catalog.array_agg(question_id order by question_id) into v_requested
              from (select distinct question_id
                      from pg_catalog.unnest(coalesce(p_requested_question_ids, '{}'::integer[])) question_id
                     where question_id > 0) ids;
            if coalesce(pg_catalog.cardinality(v_requested), 0) not between 1 and 500
               or not v_requested <@ v_exam_ids then
                raise exception 'attempt session retake questions invalid';
            end if;
            v_allowed := v_requested;
        end if;
        if coalesce(pg_catalog.cardinality(v_allowed), 0) = 0 then
            raise exception 'attempt session retake has no eligible questions';
        end if;
        v_scope_key := 'retake:' || pg_catalog.md5(
            pg_catalog.jsonb_build_array(v_source.id, p_retake_mode, v_allowed)::text
        );
    end if;
    if v_assignment_id is not null then
        v_scope_key := 'assignment-generation:' || pg_catalog.md5(
            pg_catalog.jsonb_build_array(v_assignment_id, p_assignment_revision, v_scope_key)::text
        );
        v_max_attempts := v_assignment.max_attempts;
    end if;

    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        pg_catalog.jsonb_build_array(
            pg_catalog.btrim(p_organization_id), pg_catalog.btrim(p_exam_id),
            pg_catalog.btrim(p_owner_student_id), v_scope_key
        )::text, 0
    ));

    select * into v_session
      from public.omr_attempt_sessions attempt_session
     where attempt_session.submission_id = pg_catalog.btrim(p_submission_id)
     for update;
    if found then
        v_exact_submission := true;
        if v_session.id is distinct from pg_catalog.btrim(p_session_id)
           or v_session.organization_id is distinct from pg_catalog.btrim(p_organization_id)
           or v_session.exam_id is distinct from pg_catalog.btrim(p_exam_id)
           or v_session.owner_student_id is distinct from pg_catalog.btrim(p_owner_student_id)
           or v_session.scope_key is distinct from v_scope_key
           or v_session.assignment_id is distinct from v_assignment_id
           or v_session.assignment_revision is distinct from p_assignment_revision
           or v_session.attempt_id is distinct from pg_catalog.btrim(p_attempt_id) then
            raise exception 'invalid attempt session idempotency scope';
        end if;
    else
        select * into v_session
          from public.omr_attempt_sessions attempt_session
         where attempt_session.organization_id = pg_catalog.btrim(p_organization_id)
           and attempt_session.exam_id = pg_catalog.btrim(p_exam_id)
           and attempt_session.owner_student_id = pg_catalog.btrim(p_owner_student_id)
           and attempt_session.scope_key = v_scope_key
           and attempt_session.assignment_id is not distinct from v_assignment_id
           and attempt_session.assignment_revision is not distinct from p_assignment_revision
           and attempt_session.status = 'in_progress'
         for update;
    end if;

    -- The per-student advisory/session locks can wait. Refresh the authoritative
    -- clock before either resuming a lease or creating a new session.
    v_now := pg_catalog.clock_timestamp();
    if v_exam_start is not null and v_now < v_exam_start then
        raise exception 'attempt session exam not started';
    end if;
    if v_exam_end is not null and v_now >= v_exam_end then
        raise exception 'attempt session exam ended';
    end if;

    if found and v_session.status = 'in_progress' and v_session.deadline_at <= v_now then
        update public.omr_attempt_sessions
           set status = 'expired', updated_at = v_now
         where id = v_session.id returning * into v_session;
        if not v_exact_submission then v_session := null; end if;
    elsif found and v_session.status = 'in_progress' then
        if v_session.lease_token_hash = nullif(pg_catalog.btrim(p_current_lease_token_hash), '') then
            update public.omr_attempt_sessions
               set lease_expires_at = v_now + pg_catalog.make_interval(secs => v_lease_seconds),
                   last_heartbeat_at = v_now, updated_at = v_now
             where id = v_session.id returning * into v_session;
            v_lease_acquired := true;
        elsif v_session.lease_expires_at <= v_now then
            update public.omr_attempt_sessions attempt_session
               set lease_token_hash = pg_catalog.btrim(p_new_lease_token_hash),
                   lease_epoch = attempt_session.lease_epoch + 1,
                   revision = attempt_session.revision + 1,
                   lease_expires_at = v_now + pg_catalog.make_interval(secs => v_lease_seconds),
                   last_heartbeat_at = v_now, updated_at = v_now
             where id = v_session.id returning * into v_session;
            v_lease_acquired := true;
            v_lease_token_rotated := true;
        end if;
    end if;

    if v_session.id is null then
        v_deadline := least(
            v_now + pg_catalog.make_interval(secs => p_duration_seconds),
            coalesce(v_exam_end, v_now + pg_catalog.make_interval(secs => p_duration_seconds))
        );
        if v_assignment_id is not null then
            update public.omr_attempt_sessions attempt_session
               set status = 'expired', updated_at = v_now
             where attempt_session.organization_id = pg_catalog.btrim(p_organization_id)
               and attempt_session.assignment_id = v_assignment_id
               and attempt_session.assignment_revision = p_assignment_revision
               and attempt_session.owner_student_id = pg_catalog.btrim(p_owner_student_id)
               and attempt_session.status = 'in_progress'
               and attempt_session.deadline_at <= v_now;
            select count(*)::integer into v_used_attempts
              from public.omr_attempts attempt
             where attempt.organization_id = pg_catalog.btrim(p_organization_id)
               and attempt.assignment_id = v_assignment_id
               and attempt.assignment_revision = p_assignment_revision
               and attempt.student_id = pg_catalog.btrim(p_owner_student_id)
               and attempt.status = 'completed';
            select count(*)::integer into v_active_reservations
              from public.omr_attempt_sessions attempt_session
             where attempt_session.organization_id = pg_catalog.btrim(p_organization_id)
               and attempt_session.assignment_id = v_assignment_id
               and attempt_session.assignment_revision = p_assignment_revision
               and attempt_session.owner_student_id = pg_catalog.btrim(p_owner_student_id)
               and attempt_session.status = 'in_progress';
            if v_used_attempts + v_active_reservations >= v_max_attempts then
                raise exception 'attempt session max_attempts exceeded';
            end if;
        end if;
        insert into public.omr_attempt_sessions (
            id, organization_id, exam_id, assignment_id, assignment_revision,
            owner_student_id, student_name, identity_type, scope_key,
            submission_id, attempt_id, retake_source_attempt_id, retake_mode,
            allowed_question_ids, exam_updated_at, grading_snapshot, started_at,
            deadline_at, last_heartbeat_at, lease_token_hash, lease_expires_at
        ) values (
            pg_catalog.btrim(p_session_id), pg_catalog.btrim(p_organization_id),
            pg_catalog.btrim(p_exam_id), v_assignment_id, p_assignment_revision,
            pg_catalog.btrim(p_owner_student_id), pg_catalog.btrim(p_student_name),
            p_identity_type, v_scope_key, pg_catalog.btrim(p_submission_id),
            pg_catalog.btrim(p_attempt_id), nullif(pg_catalog.btrim(p_retake_source_attempt_id), ''),
            nullif(pg_catalog.btrim(p_retake_mode), ''), v_allowed, p_exam_updated_at,
            p_grading_snapshot, v_now, v_deadline, v_now,
            pg_catalog.btrim(p_new_lease_token_hash),
            v_now + pg_catalog.make_interval(secs => v_lease_seconds)
        ) returning * into v_session;
        v_lease_acquired := true;
        v_lease_token_rotated := true;
    end if;

    return pg_catalog.jsonb_build_object(
        'session_id', v_session.id, 'exam_id', v_session.exam_id,
        'assignment_id', v_session.assignment_id, 'status', v_session.status,
        'revision', v_session.revision, 'lease_epoch', v_session.lease_epoch,
        'started_at', v_session.started_at, 'deadline_at', v_session.deadline_at,
        'server_now', v_now, 'answers', v_session.answers,
        'sub_question_answers', v_session.sub_question_answers,
        'progress_payload', v_session.progress_payload,
        'allowed_question_ids', v_session.allowed_question_ids,
        'grading_snapshot', v_session.grading_snapshot,
        'submitted_attempt_id', v_session.submitted_attempt_id,
        'assignment_revision', v_session.assignment_revision,
        'lease_acquired', v_lease_acquired, 'lease_token_rotated', v_lease_token_rotated
    );
end;
$$;

create or replace function public.omr_lock_attempt_session_generation_v1(
    p_session_id text,
    p_organization_id text,
    p_exam_id text,
    p_owner_student_id text,
    p_assignment_id text,
    p_assignment_revision bigint
)
returns public.omr_attempt_sessions
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
set lock_timeout = '2s'
as $$
declare
    v_snapshot public.omr_attempt_sessions%rowtype;
    v_session public.omr_attempt_sessions%rowtype;
    v_assignment public.omr_assignments%rowtype;
    v_exam public.omr_exams%rowtype;
    v_assignment_id text := nullif(pg_catalog.btrim(p_assignment_id), '');
begin
    -- The first read obtains lock coordinates only. Exact ownership and scope
    -- are rechecked after advisory -> assignment -> exam -> session locks.
    select * into v_snapshot
      from public.omr_attempt_sessions attempt_session
     where attempt_session.id = pg_catalog.btrim(p_session_id)
       and attempt_session.organization_id = pg_catalog.btrim(p_organization_id)
       and attempt_session.exam_id = pg_catalog.btrim(p_exam_id)
       and attempt_session.owner_student_id = pg_catalog.btrim(p_owner_student_id)
       and attempt_session.assignment_id is not distinct from v_assignment_id
       and attempt_session.assignment_revision is not distinct from p_assignment_revision;
    if not found or (v_assignment_id is null) is distinct from (p_assignment_revision is null) then
        raise exception 'attempt session assignment generation mismatch';
    end if;
    if v_assignment_id is not null then
        if p_assignment_revision is null then
            raise exception 'legacy targeted assignment generation missing';
        end if;
        perform pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended(v_assignment_id, 608032));
        select * into v_assignment
          from public.omr_assignments assignment_row
         where assignment_row.id = v_assignment_id
           and assignment_row.organization_id = pg_catalog.btrim(p_organization_id)
           and assignment_row.exam_id = v_snapshot.exam_id
           and assignment_row.revision = p_assignment_revision
         for share;
        if not found then raise exception 'assignment generation stale'; end if;
    end if;
    select * into v_exam
      from public.omr_exams exam_row
     where exam_row.id = pg_catalog.btrim(p_exam_id)
       and exam_row.organization_id = pg_catalog.btrim(p_organization_id)
     for share;
    if not found then raise exception 'attempt session exam unavailable'; end if;
    select * into v_session
      from public.omr_attempt_sessions attempt_session
     where attempt_session.id = pg_catalog.btrim(p_session_id)
       and attempt_session.organization_id = pg_catalog.btrim(p_organization_id)
       and attempt_session.owner_student_id = pg_catalog.btrim(p_owner_student_id)
       and attempt_session.exam_id = pg_catalog.btrim(p_exam_id)
       and attempt_session.assignment_id is not distinct from v_assignment_id
       and attempt_session.assignment_revision is not distinct from p_assignment_revision
     for update;
    if not found then raise exception 'attempt session assignment generation mismatch'; end if;
    return v_session;
end;
$$;

revoke all on function public.omr_lock_attempt_session_generation_v1(text,text,text,text,text,bigint)
    from public, anon, authenticated, service_role;

alter function public.omr_open_attempt_session_v3(text,text,text,text,bigint,text,text,text,text,text,text,text,integer[],integer[],timestamptz,jsonb,integer,timestamptz,text,text,integer)
    owner to postgres;
alter function public.omr_lock_attempt_session_generation_v1(text,text,text,text,text,bigint)
    owner to postgres;
revoke all on function public.omr_open_attempt_session_v3(text,text,text,text,bigint,text,text,text,text,text,text,text,integer[],integer[],timestamptz,jsonb,integer,timestamptz,text,text,integer)
    from public, anon, authenticated, service_role;
grant execute on function public.omr_open_attempt_session_v3(text,text,text,text,bigint,text,text,text,text,text,text,text,integer[],integer[],timestamptz,jsonb,integer,timestamptz,text,text,integer)
    to service_role;
revoke all on function public.omr_lock_attempt_session_generation_v1(text,text,text,text,text,bigint)
    from public, anon, authenticated, service_role;
-- assignment-generation-alias-fix:202608100003
-- Preserve the already-attested routine description because it participates
-- in the production readiness digest alongside the corrected function body.
comment on function public.omr_open_attempt_session_v3(text,text,text,text,bigint,text,text,text,text,text,text,text,integer[],integer[],timestamptz,jsonb,integer,timestamptz,text,text,integer)
    is 'assignment-generation-scope:202608090001; exact replay before current-generation validation';

commit;
