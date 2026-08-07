\set ON_ERROR_STOP on

begin;

insert into public.omr_organizations (id, name, plan)
values ('compact-force-org', 'Compact Force Org', 'pro');

insert into public.omr_student_profiles (
    id, organization_id, display_name, status
) values (
    'compact-force-student', 'compact-force-org', 'Compact Student', 'active'
), (
    'compact-force-student-2', 'compact-force-org', 'Compact Student 2', 'active'
);

insert into public.omr_classes (id, organization_id, name)
values ('compact-force-class', 'compact-force-org', 'Compact Class');

insert into public.omr_exams (
    id, organization_id, title, payload, created_at, updated_at
) values (
    'compact-force-exam', 'compact-force-org', 'Compact Force Exam',
    '{
      "id":"compact-force-exam",
      "organizationId":"compact-force-org",
      "title":"Compact Force Exam",
      "createdAt":"2026-08-07T00:00:00.000Z",
      "updatedAt":"2026-08-07T00:01:00.000Z",
      "questions":[
        {"id":1,"number":1,"answer":2,"choices":5,"score":4,"tags":{"concept":"fractions"}},
        {"id":2,"number":2,"answer":3,"choices":5,"score":6},
        {"id":3,"number":3,"answer":2,"choices":5,"score":5},
        {"id":4,"number":4,"choices":5,"score":2}
      ]
    }'::jsonb,
    now(), now()
);

-- A reusable organization-level exam intentionally has no exam.class_id or
-- payload.classId. Assigning it to a class must not make the locked exam
-- snapshot invalid; assignment class controls attempt ownership only.
insert into public.omr_assignments (
    id, organization_id, exam_id, class_id, title, status
) values (
    'compact-force-assignment', 'compact-force-org', 'compact-force-exam',
    'compact-force-class', 'Compact Class Assignment', 'open'
);

insert into public.omr_attempt_sessions (
    id, organization_id, exam_id, owner_student_id, student_name,
    identity_type, scope_key, submission_id, attempt_id,
    allowed_question_ids, grading_snapshot, answers, sub_question_answers,
    status, started_at, deadline_at, last_heartbeat_at, revision,
    lease_epoch, lease_token_hash, lease_expires_at
) values (
    'compact-force-session', 'compact-force-org', 'compact-force-exam',
    'compact-force-student', 'Compact Student', 'registered', 'base',
    'compact-force-ticket', 'compact-force-attempt', array[1,2,3,4],
    (select payload from public.omr_exams where id = 'compact-force-exam'),
    '{"1":2,"2":1}'::jsonb,
    '{"1":{"reason":{"schemaVersion":1,"body":"because","reviewStatus":"needs_review"}}}'::jsonb,
    'in_progress', now() - interval '10 minutes', now() + interval '1 hour',
    now(), 7, 1, 'compact-force-lease', now() + interval '1 minute'
), (
    'compact-force-session-2', 'compact-force-org', 'compact-force-exam',
    'compact-force-student-2', 'Compact Student 2', 'registered', 'base',
    'compact-force-ticket-2', 'compact-force-attempt-2', array[1,2,3,4],
    (select payload from public.omr_exams where id = 'compact-force-exam'),
    '{"1":2}'::jsonb, '{}'::jsonb,
    'in_progress', now() - interval '10 minutes', now() + interval '1 hour',
    now(), 3, 1, 'compact-force-lease-2', now() + interval '1 minute'
);

update public.omr_attempt_sessions
   set assignment_id = 'compact-force-assignment'
 where id = 'compact-force-session-2';

do $$
declare
    v_fingerprint text;
    v_prepared jsonb;
    v_payload jsonb;
    v_retry jsonb;
begin
    select pg_catalog.to_jsonb(prepared) into v_prepared
      from public.omr_prepare_teacher_force_finish_sessions_compact_v1(
          'compact-force-org', array['compact-force-session'],
          'compact-force-owner', 'owner'
      ) prepared;
    if v_prepared ->> 'session_id' is distinct from 'compact-force-session'
       or v_prepared ->> 'organization_id' is distinct from 'compact-force-org'
       or (v_prepared ->> 'revision')::bigint is distinct from 7::bigint
       or coalesce(v_prepared ->> 'grading_fingerprint', '') !~ '^[a-f0-9]{64}$'
       or v_prepared ? 'grading_snapshot'
       or v_prepared ? 'answers' then
        raise exception 'compact prepare leaked grading state: %', v_prepared;
    end if;

    select public.omr_teacher_force_finish_fingerprint_v1(
        revision, answers, sub_question_answers, allowed_question_ids, grading_snapshot
    ) into v_fingerprint
      from public.omr_attempt_sessions
     where id = 'compact-force-session';

    begin
        perform public.omr_force_finish_attempt_sessions_compact_v1(
            'compact-force-org',
            array['compact-force-session'],
            now(),
            'compact-force-owner',
            'owner',
            'Compact Owner',
            pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
                'session_id', 'compact-force-session',
                'expected_revision', 6,
                'expected_fingerprint', v_fingerprint
            ))
        );
        raise exception 'stale compact revision unexpectedly succeeded';
    exception when raise_exception then
        if sqlerrm is distinct from 'stale attempt session grading' then raise; end if;
    end;

    begin
        perform public.omr_force_finish_attempt_sessions_compact_v1(
            'compact-force-org',
            array['compact-force-session', 'compact-force-session-2'],
            now(),
            'compact-force-owner',
            'owner',
            'Compact Owner',
            pg_catalog.jsonb_build_array(
                pg_catalog.jsonb_build_object(
                    'session_id', 'compact-force-session',
                    'expected_revision', 7,
                    'expected_fingerprint', v_fingerprint
                ),
                pg_catalog.jsonb_build_object(
                    'session_id', 'compact-force-session-2',
                    'expected_revision', 3,
                    'expected_fingerprint', repeat('0', 64)
                )
            )
        );
        raise exception 'stale compact CAS unexpectedly succeeded';
    exception when raise_exception then
        if sqlerrm is distinct from 'stale attempt session grading' then raise; end if;
    end;
    if exists (
        select 1 from public.omr_attempts
         where id in ('compact-force-attempt', 'compact-force-attempt-2')
    ) or exists (
        select 1 from public.omr_attempt_sessions
         where id in ('compact-force-session', 'compact-force-session-2')
           and status is distinct from 'in_progress'
    ) then
        raise exception 'failed compact CAS left partial state';
    end if;

    select submitted.payload into v_payload
      from public.omr_force_finish_attempt_sessions_compact_v1(
          'compact-force-org',
          array['compact-force-session'],
          now(),
          'compact-force-owner',
          'owner',
          'Compact Owner',
          pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
              'session_id', 'compact-force-session',
              'expected_revision', 7,
              'expected_fingerprint', v_fingerprint
          ))
      ) submitted;

    if v_payload ->> 'id' is distinct from 'compact-force-attempt'
       or v_payload ->> 'status' is distinct from 'completed'
       or (v_payload ->> 'score')::numeric is distinct from 4::numeric
       or (v_payload ->> 'totalScore')::numeric is distinct from 15::numeric
       or v_payload #>> '{subQuestionAnswers,1,reason,body}' is distinct from 'because'
       or v_payload #>> '{questionResults,0,status}' is distinct from 'correct'
       or v_payload #>> '{questionResults,1,status}' is distinct from 'wrong'
       or v_payload #>> '{questionResults,2,status}' is distinct from 'unanswered'
       or v_payload #>> '{questionResults,3,status}' is distinct from 'ungraded'
       or v_payload #>> '{questionResults,0,concept}' is distinct from 'fractions'
       or (v_payload #>> '{questionResults,0,earnedScore}')::numeric is distinct from 4::numeric then
        raise exception 'compact force finish returned non-canonical payload: %', v_payload;
    end if;
    if (select count(*) from public.omr_question_results
         where attempt_id = 'compact-force-attempt') is distinct from 4::bigint
       or not exists (
           select 1 from public.omr_question_results
            where attempt_id = 'compact-force-attempt'
              and question_id = 1 and status = 'correct'
              and earned_score = 4 and concept = 'fractions'
       )
       or not exists (
           select 1 from public.omr_question_results
            where attempt_id = 'compact-force-attempt'
              and question_id = 2 and status = 'wrong'
              and score = 6 and earned_score = 0
       )
       or not exists (
           select 1 from public.omr_question_results
            where attempt_id = 'compact-force-attempt'
              and question_id = 3 and status = 'unanswered'
              and score = 5 and earned_score = 0
       )
       or not exists (
           select 1 from public.omr_question_results
            where attempt_id = 'compact-force-attempt'
              and question_id = 4 and status = 'ungraded'
              and score = 2 and earned_score = 0
       ) then
        raise exception 'compact force finish normalized result rows drifted';
    end if;

    -- A response-loss retry returns the first completion without regrading or
    -- replacing its canonical timestamp.
    select submitted.payload into v_retry
      from public.omr_force_finish_attempt_sessions_compact_v1(
          'compact-force-org',
          array['compact-force-session'],
          now() + interval '1 minute',
          'compact-force-owner',
          'owner',
          'Compact Owner',
          pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
              'session_id', 'compact-force-session',
              'expected_revision', 7,
              'expected_fingerprint', repeat('0', 64)
          ))
      ) submitted;
    if v_retry is distinct from v_payload then
        raise exception 'compact force finish response-loss retry changed completion';
    end if;
end
$$;

do $$
declare
    v_fingerprint text;
    v_payload jsonb;
begin
    select public.omr_teacher_force_finish_fingerprint_v1(
        revision, answers, sub_question_answers, allowed_question_ids, grading_snapshot
    ) into v_fingerprint
      from public.omr_attempt_sessions
     where id = 'compact-force-session-2';

    select submitted.payload into v_payload
      from public.omr_force_finish_attempt_sessions_compact_v1(
          'compact-force-org',
          array['compact-force-session-2'],
          now(),
          'compact-force-owner',
          'owner',
          'Compact Owner',
          pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
              'session_id', 'compact-force-session-2',
              'expected_revision', 3,
              'expected_fingerprint', v_fingerprint
          ))
      ) submitted;

    if v_payload ->> 'classId' is distinct from 'compact-force-class'
       or v_payload ->> 'assignmentId' is distinct from 'compact-force-assignment'
       or v_payload ->> 'status' is distinct from 'completed' then
        raise exception 'class assignment of reusable exam force-finish drifted: %', v_payload;
    end if;
end
$$;

rollback;
