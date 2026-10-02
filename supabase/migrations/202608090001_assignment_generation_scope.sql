-- Bind every targeted student attempt to the immutable assignment revision
-- that authorized it. Existing assignment-only history is intentionally not
-- backfilled: it remains reviewable, but cannot become a current solve scope.

begin;

alter table public.omr_attempt_sessions add column if not exists assignment_revision bigint;
alter table public.omr_attempts add column if not exists assignment_revision bigint;

do $$
begin
    if not exists (
        select 1 from pg_catalog.pg_constraint
         where conname = 'omr_attempt_sessions_assignment_revision_positive'
    ) then
        alter table public.omr_attempt_sessions
            add constraint omr_attempt_sessions_assignment_revision_positive
            check (assignment_revision is null or assignment_revision > 0) not valid;
    end if;
    if not exists (
        select 1 from pg_catalog.pg_constraint
         where conname = 'omr_attempts_assignment_revision_positive'
    ) then
        alter table public.omr_attempts
            add constraint omr_attempts_assignment_revision_positive
            check (assignment_revision is null or assignment_revision > 0) not valid;
    end if;
end
$$;

create index if not exists omr_attempt_sessions_assignment_generation_idx
    on public.omr_attempt_sessions (
        organization_id, assignment_id, assignment_revision, owner_student_id,
        exam_id, status, updated_at desc, id
    ) where assignment_id is not null and assignment_revision is not null;
create index if not exists omr_attempts_assignment_generation_idx
    on public.omr_attempts (
        organization_id, assignment_id, assignment_revision, student_id,
        exam_id, status, finished_at desc, id
    ) where assignment_id is not null and assignment_revision is not null;

create or replace function public.omr_lock_current_assignment_generation_v1(
    p_organization_id text,
    p_exam_id text,
    p_assignment_id text,
    p_assignment_revision bigint
)
returns public.omr_assignments
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
set lock_timeout = '2s'
as $$
declare
    v_assignment public.omr_assignments%rowtype;
begin
    if nullif(pg_catalog.btrim(p_organization_id), '') is null
       or nullif(pg_catalog.btrim(p_exam_id), '') is null
       or nullif(pg_catalog.btrim(p_assignment_id), '') is null
       or p_assignment_revision is null or p_assignment_revision <= 0 then
        raise exception 'legacy targeted assignment generation missing';
    end if;
    -- Same transaction lock and seed as teacher save/clear. It is acquired
    -- before assignment and exam row locks and held through the session insert.
    perform pg_catalog.pg_advisory_xact_lock_shared(pg_catalog.hashtextextended(
        pg_catalog.btrim(p_assignment_id), 608032
    ));
    select assignment_row.* into v_assignment
      from public.omr_assignments assignment_row
     where assignment_row.organization_id = pg_catalog.btrim(p_organization_id)
       and assignment_row.exam_id = pg_catalog.btrim(p_exam_id)
       and assignment_row.id = pg_catalog.btrim(p_assignment_id)
       and assignment_row.access_mode = 'targeted'
     for share;
    if not found or v_assignment.revision is distinct from p_assignment_revision then
        raise exception 'assignment generation stale';
    end if;
    return v_assignment;
end;
$$;

revoke all on function public.omr_lock_current_assignment_generation_v1(text,text,text,bigint)
    from public, anon, authenticated, service_role;

create or replace function public.omr_guard_assignment_generation_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_session public.omr_attempt_sessions%rowtype;
begin
    if tg_table_name = 'omr_attempts'
       and tg_op = 'UPDATE'
       and old.status = 'completed'
       and old.assignment_id is null
       and new.assignment_id is not null then
        -- historical assignment adoption is disabled
        return old;
    end if;
    if new.assignment_id is null then
        if new.assignment_revision is not null then
            raise exception 'assignment generation pair invalid';
        end if;
        if tg_op = 'UPDATE' and old.assignment_id is not null then
            raise exception 'assignment generation is immutable';
        end if;
        return new;
    end if;

    if tg_table_name = 'omr_attempt_sessions' then
        if tg_op = 'UPDATE'
           and old.assignment_id is not null
           and old.assignment_revision is null then
            -- Legacy rows are review-only. Cleanup may only terminalize an
            -- in-progress row as expired; submitted rows remain submitted.
            if new.assignment_id is distinct from old.assignment_id
               or new.assignment_revision is distinct from old.assignment_revision
               or new.exam_id is distinct from old.exam_id
               or new.organization_id is distinct from old.organization_id
               or new.owner_student_id is distinct from old.owner_student_id
               or new.student_name is distinct from old.student_name
               or new.identity_type is distinct from old.identity_type
               or new.scope_key is distinct from old.scope_key
               or new.submission_id is distinct from old.submission_id
               or new.attempt_id is distinct from old.attempt_id
               or new.retake_source_attempt_id is distinct from old.retake_source_attempt_id
               or new.retake_mode is distinct from old.retake_mode
               or new.allowed_question_ids is distinct from old.allowed_question_ids
               or new.exam_updated_at is distinct from old.exam_updated_at
               or new.grading_snapshot is distinct from old.grading_snapshot
               or new.answers is distinct from old.answers
               or new.sub_question_answers is distinct from old.sub_question_answers
               or new.progress_payload is distinct from old.progress_payload
               or new.started_at is distinct from old.started_at
               or new.deadline_at is distinct from old.deadline_at
               or new.last_heartbeat_at is distinct from old.last_heartbeat_at
               or new.revision is distinct from old.revision
               or new.lease_epoch is distinct from old.lease_epoch
               or new.lease_token_hash is distinct from old.lease_token_hash
               or new.lease_expires_at is distinct from old.lease_expires_at
               or new.submitted_attempt_id is distinct from old.submitted_attempt_id
               or new.submitted_at is distinct from old.submitted_at
               or not (
                    new.status is not distinct from old.status
                    or (old.status = 'in_progress' and new.status = 'expired')
                    or (old.status = 'submitted' and new.status = 'submitted')
               ) then
                raise exception 'legacy targeted assignment generation missing';
            end if;
            return new;
        end if;
        if new.assignment_revision is null then
            raise exception 'legacy targeted assignment generation missing';
        end if;
        if tg_op = 'UPDATE' then
            if (new.organization_id, new.exam_id, new.assignment_id, new.assignment_revision)
                is distinct from
               (old.organization_id, old.exam_id, old.assignment_id, old.assignment_revision) then
                raise exception 'assignment generation is immutable';
            end if;
            -- Canonical mutation RPCs already hold assignment -> exam -> session.
            -- Never reverse that order from a session-row UPDATE trigger.
            return new;
        end if;
        perform public.omr_lock_current_assignment_generation_v1(
            new.organization_id, new.exam_id, new.assignment_id, new.assignment_revision
        );
        return new;
    end if;

    -- omr_attempts: derive the generation only from its durable session. A
    -- caller cannot manufacture a targeted attempt by copying an assignment id.
    if tg_op = 'UPDATE'
       and old.assignment_id is not null
       and old.assignment_revision is null then
        -- Old completed targeted attempts remain readable history. They may not
        -- be adopted, regraded, relabelled, or have payload/PII/times rewritten.
        if old.status is distinct from 'completed'
           or new.status is distinct from old.status
           or new.assignment_id is distinct from old.assignment_id
           or new.assignment_revision is distinct from old.assignment_revision
           or new.organization_id is distinct from old.organization_id
           or new.exam_id is distinct from old.exam_id
           or new.student_id is distinct from old.student_id
           or new.student_name is distinct from old.student_name
           or new.identity_type is distinct from old.identity_type
           or new.score is distinct from old.score
           or new.total_score is distinct from old.total_score
           or new.score_percent is distinct from old.score_percent
           or new.payload is distinct from old.payload
           or new.started_at is distinct from old.started_at
           or new.finished_at is distinct from old.finished_at
           or new.retake_source_attempt_id is distinct from old.retake_source_attempt_id
           or new.retake_mode is distinct from old.retake_mode
           or new.ticket_id is distinct from old.ticket_id
           or new.class_id is distinct from old.class_id
           or new.student_profile_id is distinct from old.student_profile_id
           or new.group_id is distinct from old.group_id
           or new.group_name is distinct from old.group_name
           or new.region_id is distinct from old.region_id
           or new.region_name is distinct from old.region_name
           or new.retake_question_ids is distinct from old.retake_question_ids
           or new.merged_from_guest_id is distinct from old.merged_from_guest_id
           or new.merged_at is distinct from old.merged_at then
            raise exception 'legacy targeted assignment generation missing';
        end if;
        return new;
    end if;
    if tg_op = 'UPDATE'
       and old.status = 'completed'
       and old.assignment_revision is not null then
        -- The session is intentionally garbage-collected before the attempt.
        -- Follow-up grading/report/feedback writes may change mutable result
        -- fields, but can never rewrite the durable assignment binding.
        if new.status is distinct from old.status
           or new.organization_id is distinct from old.organization_id
           or new.exam_id is distinct from old.exam_id
           or new.student_id is distinct from old.student_id
           or new.identity_type is distinct from old.identity_type
           or new.assignment_id is distinct from old.assignment_id
           or new.assignment_revision is distinct from old.assignment_revision
           or new.retake_source_attempt_id is distinct from old.retake_source_attempt_id
           or new.retake_mode is distinct from old.retake_mode then
            raise exception 'completed attempt assignment generation is immutable';
        end if;
        return new;
    end if;
    if new.assignment_revision is null then
        select * into v_session
          from public.omr_attempt_sessions attempt_session
         where attempt_session.attempt_id = new.id
           and attempt_session.organization_id = new.organization_id
           and attempt_session.exam_id = new.exam_id
           and attempt_session.assignment_id = new.assignment_id
         for share;
        if not found or v_session.assignment_revision is null then
            raise exception 'legacy targeted assignment generation missing';
        end if;
        new.assignment_revision := v_session.assignment_revision;
    end if;
    if tg_op = 'UPDATE' and old.assignment_revision is not null
       and (new.assignment_id, new.assignment_revision)
           is distinct from (old.assignment_id, old.assignment_revision) then
        raise exception 'assignment generation is immutable';
    end if;
    select * into v_session
      from public.omr_attempt_sessions attempt_session
     where attempt_session.attempt_id = new.id
       and attempt_session.organization_id = new.organization_id
       and attempt_session.exam_id = new.exam_id
       and attempt_session.owner_student_id = new.student_id
       and attempt_session.identity_type = new.identity_type
       and attempt_session.retake_source_attempt_id is not distinct from new.retake_source_attempt_id
       and attempt_session.retake_mode is not distinct from new.retake_mode
     for share;
    if not found
       or v_session.assignment_id is distinct from new.assignment_id
       or v_session.assignment_revision is distinct from new.assignment_revision then
        raise exception 'attempt session assignment generation mismatch';
    end if;
    if tg_op = 'INSERT' or old.status <> 'completed' then
        perform public.omr_lock_current_assignment_generation_v1(
            new.organization_id, new.exam_id, new.assignment_id, new.assignment_revision
        );
    end if;
    return new;
end;
$$;

create or replace function public.omr_guard_historical_question_assignment_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    if old.assignment_id is null and new.assignment_id is not null then
        -- historical assignment adoption is disabled; the source history stays
        -- in its original scope while a new retake uses the current generation.
        return old;
    end if;
    return new;
end;
$$;

revoke all on function public.omr_guard_historical_question_assignment_v1()
    from public, anon, authenticated, service_role;

drop trigger if exists omr_question_results_historical_assignment_guard on public.omr_question_results;
create trigger omr_question_results_historical_assignment_guard
before update of assignment_id on public.omr_question_results
for each row execute function public.omr_guard_historical_question_assignment_v1();

revoke all on function public.omr_guard_assignment_generation_v1()
    from public, anon, authenticated, service_role;

drop trigger if exists omr_attempt_sessions_assignment_generation_guard on public.omr_attempt_sessions;
create trigger omr_attempt_sessions_assignment_generation_guard
before insert or update on public.omr_attempt_sessions
for each row execute function public.omr_guard_assignment_generation_v1();
drop trigger if exists omr_attempts_assignment_generation_guard on public.omr_attempts;
create trigger omr_attempts_assignment_generation_guard
before insert or update on public.omr_attempts
for each row execute function public.omr_guard_assignment_generation_v1();

create or replace function public.omr_list_student_assignments_v2(
    p_organization_id text,
    p_owner_student_id text,
    p_identity_type text,
    p_group_id text,
    p_group_name text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_assignments jsonb;
    v_server_now timestamptz;
begin
    -- v1 applies LIMIT 101 before this bounded aggregate (capacity + 1).
    select coalesce(pg_catalog.jsonb_agg(
        pg_catalog.to_jsonb(listed)
        || pg_catalog.jsonb_build_object(
            'assignment_revision', assignment.revision,
            'assignmentRevision', assignment.revision
        ) order by listed.updated_at desc, listed.id, listed.assignment_id nulls first
    ), '[]'::jsonb)
      into v_assignments
      from public.omr_list_student_assignments_v1(
          p_organization_id, p_owner_student_id, p_identity_type, p_group_id, p_group_name
      ) listed
      left join public.omr_assignments assignment
        on assignment.organization_id = pg_catalog.btrim(p_organization_id)
       and assignment.id = listed.assignment_id;
    v_server_now := pg_catalog.clock_timestamp();
    return pg_catalog.jsonb_build_object(
        'serverNow', v_server_now,
        'assignments', v_assignments
    );
end;
$$;

create or replace function public.omr_resolve_student_assignment_v2(
    p_organization_id text,
    p_owner_student_id text,
    p_identity_type text,
    p_group_id text,
    p_group_name text,
    p_assignment_id text,
    p_assignment_revision bigint,
    p_exam_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    assignment public.omr_assignments%rowtype;
    v_payload jsonb;
    v_source public.omr_attempts%rowtype;
begin
    assignment := public.omr_lock_current_assignment_generation_v1(
        p_organization_id, p_exam_id, p_assignment_id, p_assignment_revision
    );
    if assignment.revision is distinct from p_assignment_revision then
        return pg_catalog.jsonb_build_object('status', 'denied');
    end if;
    v_payload := public.omr_resolve_student_assignment_v1(
        p_organization_id, p_owner_student_id, p_identity_type, p_group_id,
        p_group_name, p_assignment_id, p_exam_id
    );
    if v_payload ->> 'status' is distinct from 'authorized' then return v_payload; end if;
    if v_payload ->> 'mode' = 'retake' then
        select * into v_source
          from public.omr_attempts attempt
         where attempt.id = v_payload ->> 'sourceAttemptId'
           and attempt.organization_id = pg_catalog.btrim(p_organization_id)
           and attempt.exam_id = pg_catalog.btrim(p_exam_id)
           and attempt.student_id = pg_catalog.btrim(p_owner_student_id)
           and attempt.status = 'completed';
        if not found then raise exception 'retake source attempt is not owned by student'; end if;
    end if;
    return v_payload || pg_catalog.jsonb_build_object(
        'assignmentRevision', p_assignment_revision
    );
end;
$$;

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
    assignment public.omr_assignments%rowtype;
    exam public.omr_exams%rowtype;
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
        select * into assignment
          from public.omr_assignments assignment
         where assignment.organization_id = pg_catalog.btrim(p_organization_id)
           and assignment.exam_id = pg_catalog.btrim(p_exam_id)
           and assignment.id = v_assignment_id
           and assignment.access_mode = 'targeted'
         for share;
        if not found or assignment.revision is distinct from p_assignment_revision then
            raise exception 'assignment generation stale';
        end if;
    end if;
    select * into exam
      from public.omr_exams exam
     where exam.organization_id = pg_catalog.btrim(p_organization_id)
       and exam.id = pg_catalog.btrim(p_exam_id)
       and not exam.archived
     for share;
    if not found or p_exam_updated_at is distinct from exam.updated_at then
        raise exception 'attempt session exam unavailable';
    end if;
    v_now := pg_catalog.clock_timestamp();

    -- The locked exam payload is the only lifecycle authority. The caller's
    -- end timestamp is retained solely as an exact stale-request check.
    v_exam_start_text := nullif(pg_catalog.btrim(exam.payload ->> 'startAt'), '');
    v_exam_end_text := nullif(pg_catalog.btrim(exam.payload ->> 'endAt'), '');
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
        v_max_attempts := assignment.max_attempts;
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
    assignment public.omr_assignments%rowtype;
    exam public.omr_exams%rowtype;
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
        select * into assignment
          from public.omr_assignments assignment
         where assignment.id = v_assignment_id
           and assignment.organization_id = pg_catalog.btrim(p_organization_id)
           and assignment.exam_id = v_snapshot.exam_id
           and assignment.revision = p_assignment_revision
         for share;
        if not found then raise exception 'assignment generation stale'; end if;
    end if;
    select * into exam
      from public.omr_exams exam
     where exam.id = pg_catalog.btrim(p_exam_id)
       and exam.organization_id = pg_catalog.btrim(p_organization_id)
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

create or replace function public.omr_exact_submitted_attempt_session_v1(
    p_session_id text,p_organization_id text,p_exam_id text,p_owner_student_id text,
    p_assignment_id text,p_assignment_revision bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare v_session public.omr_attempt_sessions%rowtype;
begin
    select * into v_session from public.omr_attempt_sessions session
     where session.id=pg_catalog.btrim(p_session_id)
       and session.organization_id=pg_catalog.btrim(p_organization_id)
       and session.exam_id=pg_catalog.btrim(p_exam_id)
       and session.owner_student_id=pg_catalog.btrim(p_owner_student_id)
       and session.assignment_id is not distinct from nullif(pg_catalog.btrim(p_assignment_id),'')
       and session.assignment_revision is not distinct from p_assignment_revision
       and session.status='submitted'
       and (session.assignment_id is null or session.assignment_revision is not null)
       and exists (
           select 1 from public.omr_attempts attempt
            where attempt.id=session.submitted_attempt_id
              and attempt.id=session.attempt_id
              and attempt.organization_id=session.organization_id
              and attempt.exam_id=session.exam_id
              and attempt.student_id=session.owner_student_id
              and attempt.identity_type=session.identity_type
              and attempt.assignment_id is not distinct from session.assignment_id
              and attempt.assignment_revision is not distinct from session.assignment_revision
              and attempt.retake_source_attempt_id is not distinct from session.retake_source_attempt_id
              and attempt.retake_mode is not distinct from session.retake_mode
              and attempt.status='completed'
       );
    if not found then return null; end if;
    return pg_catalog.jsonb_build_object(
        'session_id',v_session.id,'exam_id',v_session.exam_id,
        'assignment_id',v_session.assignment_id,'assignment_revision',v_session.assignment_revision,
        'status',v_session.status,'revision',v_session.revision,'lease_epoch',v_session.lease_epoch,
        'started_at',v_session.started_at,'deadline_at',v_session.deadline_at,
        'server_now',pg_catalog.clock_timestamp(),'answers','{}'::jsonb,
        'sub_question_answers','{}'::jsonb,'progress_payload','{}'::jsonb,
        'allowed_question_ids',v_session.allowed_question_ids,
        'submitted_attempt_id',v_session.submitted_attempt_id
    );
end
$$;

revoke all on function public.omr_exact_submitted_attempt_session_v1(text,text,text,text,text,bigint)
    from public, anon, authenticated, service_role;

create or replace function public.omr_checkpoint_attempt_session_v2(
    p_session_id text, p_organization_id text, p_exam_id text, p_owner_student_id text,
    p_assignment_id text, p_assignment_revision bigint,
    p_expected_revision bigint, p_expected_lease_epoch bigint,
    p_lease_token_hash text, p_answers jsonb, p_sub_question_answers jsonb,
    p_progress_payload jsonb, p_lease_seconds integer, p_final_checkpoint boolean
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_session public.omr_attempt_sessions%rowtype; v_result jsonb;
begin
    v_result := public.omr_exact_submitted_attempt_session_v1(
        p_session_id,p_organization_id,p_exam_id,p_owner_student_id,p_assignment_id,p_assignment_revision);
    if v_result is not null then return v_result; end if;
    v_session := public.omr_lock_attempt_session_generation_v1(
        p_session_id,p_organization_id,p_exam_id,p_owner_student_id,p_assignment_id,p_assignment_revision);
    select pg_catalog.to_jsonb(saved) into v_result from public.omr_checkpoint_attempt_session_v1(
        p_session_id,p_organization_id,p_owner_student_id,p_expected_revision,p_expected_lease_epoch,
        p_lease_token_hash,p_answers,p_sub_question_answers,p_progress_payload,p_lease_seconds,p_final_checkpoint) saved;
    return v_result || pg_catalog.jsonb_build_object(
        'exam_id',v_session.exam_id,'assignment_id',v_session.assignment_id,
        'assignment_revision',v_session.assignment_revision
    );
end $$;

create or replace function public.omr_heartbeat_attempt_session_v2(
    p_session_id text, p_organization_id text, p_exam_id text, p_owner_student_id text,
    p_assignment_id text, p_assignment_revision bigint,
    p_expected_lease_epoch bigint, p_lease_token_hash text, p_lease_seconds integer
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_session public.omr_attempt_sessions%rowtype; v_result jsonb;
begin
    v_result := public.omr_exact_submitted_attempt_session_v1(
        p_session_id,p_organization_id,p_exam_id,p_owner_student_id,p_assignment_id,p_assignment_revision);
    if v_result is not null then return v_result; end if;
    v_session := public.omr_lock_attempt_session_generation_v1(
        p_session_id,p_organization_id,p_exam_id,p_owner_student_id,p_assignment_id,p_assignment_revision);
    select pg_catalog.to_jsonb(saved) into v_result from public.omr_heartbeat_attempt_session_v1(
        p_session_id,p_organization_id,p_owner_student_id,p_expected_lease_epoch,p_lease_token_hash,p_lease_seconds) saved;
    return v_result || pg_catalog.jsonb_build_object(
        'exam_id',v_session.exam_id,'assignment_id',v_session.assignment_id,
        'assignment_revision',v_session.assignment_revision
    );
end $$;

create or replace function public.omr_takeover_attempt_session_v2(
    p_session_id text, p_organization_id text, p_exam_id text, p_owner_student_id text,
    p_assignment_id text, p_assignment_revision bigint,
    p_expected_revision bigint, p_expected_lease_epoch bigint,
    p_new_lease_token_hash text, p_lease_seconds integer
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_session public.omr_attempt_sessions%rowtype; v_result jsonb;
begin
    v_result := public.omr_exact_submitted_attempt_session_v1(
        p_session_id,p_organization_id,p_exam_id,p_owner_student_id,p_assignment_id,p_assignment_revision);
    if v_result is not null then return v_result; end if;
    v_session := public.omr_lock_attempt_session_generation_v1(
        p_session_id,p_organization_id,p_exam_id,p_owner_student_id,p_assignment_id,p_assignment_revision);
    select pg_catalog.to_jsonb(saved) into v_result from public.omr_takeover_attempt_session_v1(
        p_session_id,p_organization_id,p_owner_student_id,p_expected_revision,p_expected_lease_epoch,
        p_new_lease_token_hash,p_lease_seconds) saved;
    return v_result || pg_catalog.jsonb_build_object(
        'exam_id',v_session.exam_id,'assignment_id',v_session.assignment_id,
        'assignment_revision',v_session.assignment_revision
    );
end $$;

create or replace function public.omr_prepare_attempt_session_submit_v2(
    p_session_id text, p_organization_id text, p_exam_id text, p_owner_student_id text,
    p_assignment_id text, p_assignment_revision bigint,
    p_expected_revision bigint, p_expected_lease_epoch bigint, p_lease_token_hash text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare attempt_session public.omr_attempt_sessions%rowtype; v_result jsonb;
begin
    v_result := public.omr_exact_submitted_attempt_session_v1(
        p_session_id,p_organization_id,p_exam_id,p_owner_student_id,p_assignment_id,p_assignment_revision);
    if v_result is not null then return v_result; end if;
    select * into attempt_session from public.omr_attempt_sessions s
     where s.id=pg_catalog.btrim(p_session_id)
       and s.organization_id=pg_catalog.btrim(p_organization_id)
       and s.exam_id=pg_catalog.btrim(p_exam_id)
       and s.owner_student_id=pg_catalog.btrim(p_owner_student_id)
       and s.assignment_id is not distinct from nullif(pg_catalog.btrim(p_assignment_id),'')
       and s.assignment_revision is not distinct from p_assignment_revision;
    if not found then raise exception 'attempt session not owned'; end if;
    -- Submitted response-loss replay is historical, but never exposes answers
    -- or grading_snapshot and only follows exact owner/session identity.
    if attempt_session.status = 'submitted' then
        raise exception 'attempt session submitted replay mismatch';
    end if;
    attempt_session := public.omr_lock_attempt_session_generation_v1(
        p_session_id,p_organization_id,p_exam_id,p_owner_student_id,p_assignment_id,p_assignment_revision);
    select pg_catalog.to_jsonb(prepared) into v_result from public.omr_prepare_attempt_session_submit_v1(
        p_session_id,p_organization_id,p_owner_student_id,p_expected_revision,p_expected_lease_epoch,p_lease_token_hash) prepared;
    return v_result || pg_catalog.jsonb_build_object(
        'exam_id',attempt_session.exam_id,'assignment_id',attempt_session.assignment_id,
        'assignment_revision',attempt_session.assignment_revision
    );
end $$;

create or replace function public.omr_commit_attempt_session_submit_v2(
    p_session_id text, p_organization_id text, p_exam_id text, p_owner_student_id text,
    p_assignment_id text, p_assignment_revision bigint,
    p_expected_revision bigint, p_expected_lease_epoch bigint,
    p_lease_token_hash text, p_attempt jsonb, p_question_results jsonb
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare attempt_session public.omr_attempt_sessions%rowtype; attempt public.omr_attempts%rowtype; v_result jsonb;
begin
    v_result := public.omr_exact_submitted_attempt_session_v1(
        p_session_id,p_organization_id,p_exam_id,p_owner_student_id,p_assignment_id,p_assignment_revision);
    if v_result is not null then
        select * into attempt
          from public.omr_attempts stored_attempt
         where stored_attempt.id = v_result ->> 'submitted_attempt_id'
           and stored_attempt.organization_id = pg_catalog.btrim(p_organization_id)
           and stored_attempt.exam_id = pg_catalog.btrim(p_exam_id)
           and stored_attempt.student_id = pg_catalog.btrim(p_owner_student_id)
           and stored_attempt.assignment_id is not distinct from nullif(pg_catalog.btrim(p_assignment_id), '')
           and stored_attempt.assignment_revision is not distinct from p_assignment_revision
           and stored_attempt.status = 'completed';
        if not found then
            raise exception 'attempt session submitted replay mismatch';
        end if;
        return pg_catalog.jsonb_build_object(
            'payload', attempt.payload,
            'result_status', 'submitted'
        );
    end if;
    select * into attempt_session from public.omr_attempt_sessions s
     where s.id=pg_catalog.btrim(p_session_id)
       and s.organization_id=pg_catalog.btrim(p_organization_id)
       and s.exam_id=pg_catalog.btrim(p_exam_id)
       and s.owner_student_id=pg_catalog.btrim(p_owner_student_id)
       and s.assignment_id is not distinct from nullif(pg_catalog.btrim(p_assignment_id),'')
       and s.assignment_revision is not distinct from p_assignment_revision;
    if not found then raise exception 'attempt session not owned'; end if;
    if attempt_session.status = 'submitted' then
        raise exception 'attempt session submitted replay mismatch';
    end if;
    attempt_session := public.omr_lock_attempt_session_generation_v1(
        p_session_id,p_organization_id,p_exam_id,p_owner_student_id,p_assignment_id,p_assignment_revision);
    attempt := pg_catalog.jsonb_populate_record(null::public.omr_attempts,p_attempt);
    if attempt.id is distinct from attempt_session.attempt_id
       or attempt.organization_id is distinct from attempt_session.organization_id
       or attempt.exam_id is distinct from attempt_session.exam_id
       or attempt.student_id is distinct from attempt_session.owner_student_id
       or attempt.identity_type is distinct from attempt_session.identity_type
       or attempt.retake_source_attempt_id is distinct from attempt_session.retake_source_attempt_id
       or attempt.retake_mode is distinct from attempt_session.retake_mode
       or attempt.assignment_id is distinct from attempt_session.assignment_id
       or attempt.assignment_revision is distinct from attempt_session.assignment_revision then
        raise exception 'attempt session canonical submission mismatch';
    end if;
    select pg_catalog.to_jsonb(committed) into v_result from public.omr_commit_attempt_session_submit_v1(
        p_session_id,p_organization_id,p_owner_student_id,p_expected_revision,p_expected_lease_epoch,
        p_lease_token_hash,p_attempt,p_question_results) committed;
    select * into attempt from public.omr_attempts a
     where a.id=attempt_session.attempt_id
       and a.organization_id=attempt_session.organization_id
       and a.exam_id=attempt_session.exam_id
       and a.student_id=attempt_session.owner_student_id;
    if not found
       or attempt.assignment_id is distinct from attempt_session.assignment_id
       or attempt.assignment_revision is distinct from attempt_session.assignment_revision
       or attempt.retake_source_attempt_id is distinct from attempt_session.retake_source_attempt_id
       or attempt.retake_mode is distinct from attempt_session.retake_mode then
        raise exception 'attempt session assignment generation mismatch';
    end if;
    return v_result;
end $$;

create or replace function public.omr_list_active_attempt_sessions_v2(
    p_organization_id text,p_actor_user_id text,p_member_role text,p_exam_id text,p_limit integer
)
returns jsonb language sql stable security definer set search_path = '' as $$
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(active)
        || pg_catalog.jsonb_build_object('assignment_revision',session.assignment_revision)), '[]'::jsonb)
      from public.omr_list_active_attempt_sessions_v1(
          p_organization_id,p_exam_id,p_actor_user_id,p_member_role,p_limit
      ) active
      join public.omr_attempt_sessions session on session.id=active.session_id
     where session.assignment_id is null or exists (
         select 1 from public.omr_assignments assignment
          where assignment.id=session.assignment_id
            and assignment.organization_id=session.organization_id
            and assignment.exam_id=session.exam_id
            and assignment.revision=session.assignment_revision
     )
$$;

create or replace function public.omr_resolve_legacy_attempt_session_scope_v1(
    p_session_id text,p_organization_id text,p_owner_student_id text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
declare v_session public.omr_attempt_sessions%rowtype;
begin
    if nullif(pg_catalog.btrim(p_session_id), '') is null
       or nullif(pg_catalog.btrim(p_organization_id), '') is null
       or nullif(pg_catalog.btrim(p_owner_student_id), '') is null then
        raise exception 'invalid legacy attempt session recovery';
    end if;
    select * into v_session
      from public.omr_attempt_sessions session
     where session.id = pg_catalog.btrim(p_session_id)
       and session.organization_id = pg_catalog.btrim(p_organization_id)
       and session.owner_student_id = pg_catalog.btrim(p_owner_student_id);
    if not found then return pg_catalog.jsonb_build_object('status','not_found'); end if;
    if v_session.assignment_id is not null then
        return pg_catalog.jsonb_build_object('status','targeted');
    end if;
    return pg_catalog.jsonb_build_object('status','resolved','examId',v_session.exam_id);
end;
$$;

revoke all on function public.omr_resolve_legacy_attempt_session_scope_v1(text,text,text)
    from public, anon, authenticated;
grant execute on function public.omr_resolve_legacy_attempt_session_scope_v1(text,text,text)
    to service_role;

create or replace function public.omr_prepare_teacher_force_finish_sessions_compact_v2(
    p_organization_id text,p_session_ids text[],p_actor_user_id text,p_member_role text
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_result jsonb; v_count integer;
begin
    if p_session_ids is null or pg_catalog.cardinality(p_session_ids) not between 1 and 100 then
        raise exception 'invalid compact teacher force finish prepare';
    end if;
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(prepared)
        || pg_catalog.jsonb_build_object(
            'assignment_id',session.assignment_id,
            'assignment_revision',session.assignment_revision
        ) order by requested.position), '[]'::jsonb), count(*)::integer
      into v_result,v_count
      from public.omr_prepare_teacher_force_finish_sessions_compact_v1(
          p_organization_id,p_session_ids,p_actor_user_id,p_member_role
      ) prepared
      join public.omr_attempt_sessions session on session.id=prepared.session_id
      join pg_catalog.unnest(p_session_ids) with ordinality requested(session_id,position)
        on requested.session_id=prepared.session_id
     where session.assignment_id is null or exists (
         select 1 from public.omr_assignments assignment
          where assignment.id=session.assignment_id
            and assignment.organization_id=session.organization_id
            and assignment.exam_id=session.exam_id
            and assignment.revision=session.assignment_revision
     );
    if v_count is distinct from pg_catalog.cardinality(p_session_ids) then
        raise exception 'legacy targeted assignment generation missing';
    end if;
    return v_result;
end
$$;

create or replace function public.omr_force_finish_attempt_sessions_compact_v2(
    p_organization_id text,p_session_ids text[],p_finished_at timestamptz,
    p_actor_user_id text,p_member_role text,p_actor_label text,p_expectations jsonb
)
returns table(payload jsonb)
language plpgsql security definer set search_path = '' as $$
declare
    v_assignment record;
    v_exam record;
    v_session public.omr_attempt_sessions%rowtype;
    v_finished jsonb;
    v_finished_count integer;
    v_postcondition_count integer;
begin
    if p_session_ids is null or pg_catalog.cardinality(p_session_ids) not between 1 and 100 then
        raise exception 'invalid compact teacher force finish sessions';
    end if;
    select count(*)::integer into v_postcondition_count
      from public.omr_attempt_sessions session
     where session.id=any(p_session_ids)
       and session.organization_id=pg_catalog.btrim(p_organization_id)
       and (
           session.assignment_id is null
           or exists (
               select 1 from public.omr_assignments assignment
                where assignment.id=session.assignment_id
                  and assignment.organization_id=session.organization_id
                  and assignment.exam_id=session.exam_id
                  and assignment.revision=session.assignment_revision
           )
       );
    if v_postcondition_count is distinct from pg_catalog.cardinality(p_session_ids) then
        raise exception 'legacy targeted assignment generation missing';
    end if;
    -- Match teacher assignment save/clear lock order for every requested row:
    -- advisory assignment -> assignment -> exam -> session.
    for v_assignment in
        select distinct session.assignment_id
          from public.omr_attempt_sessions session
         where session.id=any(p_session_ids) and session.assignment_id is not null
         order by session.assignment_id
    loop
        perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_assignment.assignment_id,608032));
    end loop;
    for v_assignment in
        select assignment.id
          from public.omr_attempt_sessions session
          join public.omr_assignments assignment
            on assignment.id=session.assignment_id
           and assignment.organization_id=session.organization_id
           and assignment.exam_id=session.exam_id
           and assignment.revision=session.assignment_revision
         where session.id=any(p_session_ids) and session.assignment_id is not null
         order by assignment.id
         for share of assignment
    loop null; end loop;
    for v_exam in
        select exam.id
          from public.omr_attempt_sessions session
          join public.omr_exams exam
            on exam.id=session.exam_id and exam.organization_id=session.organization_id
         where session.id=any(p_session_ids)
         order by exam.id
         for share of exam
    loop null; end loop;
    for v_session in
        select session.* from public.omr_attempt_sessions session
         where session.id=any(p_session_ids)
         order by session.id for update
    loop null; end loop;
    if exists (
        select 1 from public.omr_attempt_sessions session
         where session.id=any(p_session_ids)
           and session.assignment_id is not null
           and session.assignment_revision is null
    ) then raise exception 'legacy targeted assignment generation missing'; end if;

    select coalesce(pg_catalog.jsonb_agg(result.payload),'[]'::jsonb),count(*)::integer
      into v_finished,v_finished_count
      from public.omr_force_finish_attempt_sessions_compact_v1(
            p_organization_id,p_session_ids,p_finished_at,p_actor_user_id,p_member_role,p_actor_label,p_expectations
        ) result;
    if v_finished_count is distinct from pg_catalog.cardinality(p_session_ids) then
        raise exception 'teacher force finish incomplete';
    end if;
    update public.omr_attempts attempt
       set payload = attempt.payload || pg_catalog.jsonb_build_object(
           'assignmentId',session.assignment_id,
           'assignmentRevision',session.assignment_revision
       )
      from public.omr_attempt_sessions session
     where session.id=any(p_session_ids)
       and attempt.id=session.attempt_id
       and session.assignment_id is not null
       and attempt.assignment_id is not distinct from session.assignment_id
       and attempt.assignment_revision is not distinct from session.assignment_revision;
    select count(*)::integer into v_postcondition_count
      from public.omr_attempt_sessions session
      join public.omr_attempts attempt
        on attempt.id=session.attempt_id
       and attempt.organization_id=session.organization_id
       and attempt.exam_id=session.exam_id
       and attempt.student_id=session.owner_student_id
       and attempt.assignment_id is not distinct from session.assignment_id
       and attempt.assignment_revision is not distinct from session.assignment_revision
       and attempt.retake_source_attempt_id is not distinct from session.retake_source_attempt_id
       and attempt.retake_mode is not distinct from session.retake_mode
     where session.id=any(p_session_ids)
       and session.status='submitted'
       and (
           session.assignment_id is null
           or (
               attempt.payload ->> 'assignmentId' is not distinct from session.assignment_id
               and attempt.payload ->> 'assignmentRevision' is not distinct from session.assignment_revision::text
           )
       );
    if v_postcondition_count is distinct from pg_catalog.cardinality(p_session_ids) then
        raise exception 'attempt session assignment generation mismatch';
    end if;
    return query
    select attempt.payload
      from pg_catalog.unnest(p_session_ids) with ordinality requested(session_id,position)
      join public.omr_attempt_sessions session on session.id=requested.session_id
      join public.omr_attempts attempt on attempt.id=session.attempt_id
     order by requested.position;
end $$;

-- Public/group and older-generation history is never adopted into a later
-- targeted generation. It remains review-only; the new session/attempt carries
-- the current assignment revision without mutating the source.

create or replace function public.omr_initial_ops_database_snapshot_v1(
    p_run_id text,
    p_run_challenge_hash text,
    p_organization_id text,
    p_exam_id text,
    p_phase text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '30s'
set lock_timeout = '5s'
as $$
declare
    v_result jsonb;
    v_rows jsonb;
    v_paths jsonb;
begin
    v_result := public.omr_initial_ops_database_snapshot_v26_snapshot(
        p_run_id, p_run_challenge_hash, p_organization_id, p_exam_id, p_phase
    );
    if v_result ->> 'status' is distinct from 'ok' then
        return v_result;
    end if;
    with required(workload_path, query_pattern) as (values
        ('rpc:omr_open_attempt_session_v3', '%omr_open_attempt_session_v3%'),
        ('rpc:omr_checkpoint_attempt_session_v2', '%omr_checkpoint_attempt_session_v2%'),
        ('rpc:omr_heartbeat_attempt_session_v2', '%omr_heartbeat_attempt_session_v2%'),
        ('rpc:omr_prepare_attempt_session_submit_v2', '%omr_prepare_attempt_session_submit_v2%'),
        ('rpc:omr_commit_attempt_session_submit_v2', '%omr_commit_attempt_session_submit_v2%'),
        ('rpc:omr_list_active_attempt_sessions_v2', '%omr_list_active_attempt_sessions_v2%'),
        ('table:omr_remote_assets', '%from%omr_remote_assets%'),
        ('rpc:omr_prepare_teacher_asset_upload_v2', '%omr_prepare_teacher_asset_upload_v2%'),
        ('rpc:omr_authorize_teacher_asset_finalize_v2', '%omr_authorize_teacher_asset_finalize_v2%'),
        ('rpc:omr_finalize_teacher_asset_upload_v2', '%omr_finalize_teacher_asset_upload_v2%')
    ), aggregated as (
        select required.workload_path,
               coalesce(pg_catalog.sum(stats.calls), 0)::bigint as calls,
               coalesce(pg_catalog.max(stats.max_exec_time), 0)::double precision as maximum_execution_ms
          from required
          left join extensions.pg_stat_statements stats
            on stats.dbid = (select oid from pg_catalog.pg_database where datname = pg_catalog.current_database())
           and stats.query ilike required.query_pattern
         group by required.workload_path
    )
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               'workloadPath', workload_path,
               'fingerprint', pg_catalog.encode(extensions.digest(workload_path, 'sha256'), 'hex'),
               'calls', calls,
               'maximumExecutionMs', maximum_execution_ms
           ) order by workload_path),
           pg_catalog.jsonb_agg(workload_path order by workload_path)
      into v_rows, v_paths
      from aggregated;
    return pg_catalog.jsonb_set(
        pg_catalog.jsonb_set(v_result, '{rows}', v_rows, true),
        '{productionWorkloadPaths}', v_paths, true
    );
end;
$$;

do $$
declare signature text;
begin
    foreach signature in array array[
        'omr_list_student_assignments_v2(text,text,text,text,text)',
        'omr_resolve_student_assignment_v2(text,text,text,text,text,text,bigint,text)',
        'omr_open_attempt_session_v3(text,text,text,text,bigint,text,text,text,text,text,text,text,integer[],integer[],timestamptz,jsonb,integer,timestamptz,text,text,integer)',
        'omr_checkpoint_attempt_session_v2(text,text,text,text,text,bigint,bigint,bigint,text,jsonb,jsonb,jsonb,integer,boolean)',
        'omr_heartbeat_attempt_session_v2(text,text,text,text,text,bigint,bigint,text,integer)',
        'omr_takeover_attempt_session_v2(text,text,text,text,text,bigint,bigint,bigint,text,integer)',
        'omr_prepare_attempt_session_submit_v2(text,text,text,text,text,bigint,bigint,bigint,text)',
        'omr_commit_attempt_session_submit_v2(text,text,text,text,text,bigint,bigint,bigint,text,jsonb,jsonb)',
        'omr_list_active_attempt_sessions_v2(text,text,text,text,integer)',
        'omr_resolve_legacy_attempt_session_scope_v1(text,text,text)',
        'omr_prepare_teacher_force_finish_sessions_compact_v2(text,text[],text,text)',
        'omr_force_finish_attempt_sessions_compact_v2(text,text[],timestamptz,text,text,text,jsonb)'
    ] loop
        execute pg_catalog.format('revoke all on function public.%s from public, anon, authenticated',signature);
        execute pg_catalog.format('grant execute on function public.%s to service_role',signature);
    end loop;
end $$;

comment on function public.omr_open_attempt_session_v3(
    text,text,text,text,bigint,text,text,text,text,text,text,text,integer[],integer[],timestamptz,jsonb,integer,timestamptz,text,text,integer
) is 'assignment-generation-scope:202608090001; exact replay before current-generation validation';

commit;
