begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function public.omr_validate_targeted_attempt_session_v1()
returns trigger
language plpgsql security definer
set search_path = ''
set statement_timeout = '5s'
set lock_timeout = '2s'
as $$
declare
    -- Only these columns change in checkpoint, lease, expiry and submit RPCs.
    -- Future columns default to immutable during a retake.
    original_scope public.omr_attempt_sessions%rowtype;
begin
    if tg_op = 'UPDATE' and old.retake_source_attempt_id is not null then
        original_scope := new;
        original_scope.updated_at := old.updated_at;
        if old.status <> 'in_progress' and original_scope is distinct from old then
            raise exception 'attempt session retake scope invalid';
        end if;
        original_scope.answers := old.answers;
        original_scope.sub_question_answers := old.sub_question_answers;
        original_scope.progress_payload := old.progress_payload;
        original_scope.revision := old.revision;
        original_scope.lease_token_hash := old.lease_token_hash;
        original_scope.lease_epoch := old.lease_epoch;
        original_scope.lease_expires_at := old.lease_expires_at;
        original_scope.last_heartbeat_at := old.last_heartbeat_at;
        original_scope.status := old.status;
        original_scope.submitted_at := old.submitted_at;
        original_scope.submitted_attempt_id := old.submitted_attempt_id;
        if original_scope is distinct from old
           or (new.status = 'submitted' and new.submitted_attempt_id is distinct from old.attempt_id) then
            raise exception 'attempt session retake scope invalid';
        end if;
        -- Creation checked the paid grant. Current student/target scope and
        -- the RPC's generation, deadline, lease and CAS still apply on every save.
        if new.status <> 'expired' and (
            not exists (select 1 from public.omr_exams e
                         where e.id = new.exam_id and e.organization_id = new.organization_id and not e.archived)
            or (new.assignment_id is not null and not exists (
                select 1 from public.omr_assignments a
                 where a.id = new.assignment_id and a.organization_id = new.organization_id
                   and a.exam_id = new.exam_id and a.revision = new.assignment_revision
                   and a.status in ('scheduled', 'open')
            ))
        ) then raise exception 'attempt session exam unavailable'; end if;
    elsif new.retake_source_attempt_id is not null then
        if tg_op <> 'INSERT' then raise exception 'attempt session retake scope invalid'; end if;
        perform public.omr_assert_effective_plan_transaction_proof_v1(new.organization_id, true);
    end if;
    perform public.omr_assert_targeted_assignment_scope_v1(
        new.organization_id, new.exam_id, new.assignment_id,
        new.owner_student_id, new.identity_type, new.retake_source_attempt_id, new.allowed_question_ids
    );
    return new;
end;
$$;

create or replace function public.omr_validate_targeted_attempt_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
set lock_timeout = '2s'
as $$
begin
    -- Preserve the historical adoption guard. The later generation guard
    -- keeps completed base attempts bound to their original assignment.
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
       ) then
        perform public.omr_assert_effective_plan_transaction_proof_v1(
            new.organization_id, true
        );
        return new;
    end if;
    -- Submission/force-finish is a continuation of a durable retake session
    -- whose creation was authorized by the paid proof. It may finish after
    -- natural grant expiry, but cannot invent a retake without that exact
    -- owner/session binding.
    if nullif(pg_catalog.btrim(new.retake_source_attempt_id), '') is not null
       and not exists (
           select 1 from public.omr_attempt_sessions attempt_session
            where attempt_session.attempt_id = new.id
              and attempt_session.organization_id = new.organization_id
              and attempt_session.exam_id = new.exam_id
              and attempt_session.assignment_id is not distinct from new.assignment_id
              -- submit_session_attempt_v1 leaves the SQL revision to the
              -- subsequent assignment-generation trigger, which derives it
              -- from this exact session. Match any revision already supplied.
              and (new.assignment_revision is null or attempt_session.assignment_revision = new.assignment_revision)
              and (new.assignment_id is null or attempt_session.assignment_revision is not null)
              and attempt_session.identity_type = new.identity_type
              and attempt_session.retake_mode = new.retake_mode
              and attempt_session.owner_student_id = new.student_id
              and attempt_session.retake_source_attempt_id = new.retake_source_attempt_id
              and attempt_session.allowed_question_ids = new.retake_question_ids
              and attempt_session.status in ('in_progress', 'submitted')
       ) then
        raise exception 'free plan denies retake';
    end if;
    perform public.omr_assert_targeted_assignment_scope_v1(
        new.organization_id, new.exam_id, new.assignment_id,
        new.student_id, new.identity_type,
        new.retake_source_attempt_id, new.retake_question_ids
    );
    return new;
end;
$$;

-- On a fresh install production-server-boundary.sql installs the attestation
-- later. Upgrade an already installed boundary only from its known definition.
do $upgrade$
declare
    definition text := pg_catalog.pg_get_functiondef('public.omr_service_readiness_v1()'::regprocedure);
    fingerprint text;
begin
    if pg_catalog.strpos(definition, 'v_provisioned_teacher_login_ready') > 0 then
        fingerprint := pg_catalog.encode(extensions.digest(definition, 'sha256'), 'hex');
        if fingerprint = 'c340f3787fedc9238992c6f3d7b91bea201db17fa00bcadb8cb7cfc717680635' then
            execute pg_catalog.replace(definition,
                'a5681e53ecbc749fc3b8e30bce20f189af8594648eaa1b6b4886e9f603bca487',
                '3c83faddf176a52992cb6d6acc4f1b317b406f470a1a599a6a14fc904950b47d');
        elsif fingerprint <> '08b8f6221019c00e66dee26dc934e7f6d42b1535790daf980f3c575eb68d4e94' then
            raise exception 'unexpected retake continuation readiness fingerprint';
        end if;
    end if;
end $upgrade$;

commit;
