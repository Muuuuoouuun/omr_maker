\set ON_ERROR_STOP on

begin;

insert into public.omr_organizations (id, name, plan)
values
    ('notification-summary-org', 'Notification Summary Org', 'free'),
    ('notification-summary-foreign', 'Foreign Notification Org', 'free')
on conflict (id) do nothing;

insert into public.omr_attempts (
    id, organization_id, exam_id, student_name, status,
    payload, started_at, finished_at
)
values
    (
        'notification-summary-recent', 'notification-summary-org', 'summary-exam', '학생 1', 'completed',
        '{"studentQuestions":[
            {"questionId":1,"questionNumber":1,"status":"queued","createdAt":"2026-08-06T01:00:00.000Z"},
            {"questionId":2,"questionNumber":2,"status":"queued","createdAt":"2026-08-06T01:01:00.000Z"},
            {"questionId":3,"questionNumber":3,"status":"answered"}
        ]}'::jsonb,
        now() - interval '2 hours', now() - interval '1 hour'
    ),
    (
        'notification-summary-old', 'notification-summary-org', 'summary-exam', '학생 2', 'completed',
        '{"studentQuestions":[{"questionId":1,"questionNumber":1,"status":"queued","createdAt":"2026-08-05T01:00:00.000Z"}]}'::jsonb,
        now() - interval '27 hours', now() - interval '25 hours'
    ),
    (
        'notification-summary-progress', 'notification-summary-org', 'summary-exam', '학생 3', 'in_progress',
        '{"studentQuestions":[{"questionId":1,"questionNumber":1,"status":"queued","createdAt":"2026-08-06T01:02:00.000Z"}]}'::jsonb,
        now() - interval '30 minutes', now() - interval '10 minutes'
    ),
    (
        'notification-summary-foreign-attempt', 'notification-summary-foreign', 'summary-exam', '학생 4', 'completed',
        '{"studentQuestions":[{"questionId":1,"questionNumber":1,"status":"queued","createdAt":"2026-08-06T01:03:00.000Z"}]}'::jsonb,
        now() - interval '30 minutes', now() - interval '10 minutes'
    );

-- Canonical attempt writes run as service_role in production. Stored generated
-- summary columns must therefore remain writable without reopening them to
-- browser roles.
set local role service_role;
update public.omr_attempts
   set payload = payload
 where id = 'notification-summary-progress';
reset role;

do $$
declare
    v_recent bigint;
    v_queued bigint;
    v_recent_version text;
    v_queued_version text;
    v_previous_recent_version text;
    v_previous_queued_version text;
begin
    select summary.recent_completed_attempt_count, summary.queued_student_question_count,
           summary.recent_event_version, summary.queued_event_version
      into v_recent, v_queued, v_recent_version, v_queued_version
      from public.omr_teacher_notification_summary_v1('notification-summary-org') summary;

    if v_recent is distinct from 1 or v_queued is distinct from 4
       or v_recent_version !~ '^[a-f0-9]{32}$'
       or v_queued_version !~ '^[a-f0-9]{32}$' then
        raise exception 'notification summary organization isolation failed: recent=%, queued=%, recent_version=%, queued_version=%',
            v_recent, v_queued, v_recent_version, v_queued_version;
    end if;
    v_previous_recent_version := v_recent_version;
    v_previous_queued_version := v_queued_version;

    -- Keep each count unchanged while replacing its underlying newest event.
    update public.omr_attempts
       set finished_at = now() - interval '26 hours'
     where id = 'notification-summary-recent';
    insert into public.omr_attempts (
        id, organization_id, exam_id, student_name, status,
        payload, started_at, finished_at
    ) values (
        'notification-summary-recent-replacement', 'notification-summary-org',
        'summary-exam', '학생 5', 'completed', '{"studentQuestions":[]}'::jsonb,
        now() - interval '20 minutes', now() - interval '5 minutes'
    );
    update public.omr_attempts
       set payload = jsonb_set(
           payload,
           '{studentQuestions,0,createdAt}',
           '"2026-08-06T02:00:00.000Z"'::jsonb
       )
     where id = 'notification-summary-progress';

    select summary.recent_completed_attempt_count, summary.queued_student_question_count,
           summary.recent_event_version, summary.queued_event_version
      into v_recent, v_queued, v_recent_version, v_queued_version
      from public.omr_teacher_notification_summary_v1('notification-summary-org') summary;
    if v_recent is distinct from 1 or v_queued is distinct from 4
       or v_recent_version is not distinct from v_previous_recent_version
       or v_queued_version is not distinct from v_previous_queued_version then
        raise exception 'count-preserving replacement did not advance notification versions';
    end if;

    -- Invalid or oversized student timestamps must never become a reusable
    -- notification id. The RPC returns a null opaque version, and the server
    -- gateway rejects the whole summary rather than exposing a stale id.
    update public.omr_attempts
       set payload = jsonb_set(
           payload,
           '{studentQuestions,0,createdAt}',
           to_jsonb(repeat('9', 4096))
       )
     where id = 'notification-summary-old';
    select summary.queued_event_version
      into v_queued_version
      from public.omr_teacher_notification_summary_v1('notification-summary-org') summary;
    if v_queued_version is not null then
        raise exception 'malformed queued timestamp did not fail closed';
    end if;

    select summary.recent_completed_attempt_count, summary.queued_student_question_count,
           summary.recent_event_version, summary.queued_event_version
      into v_recent, v_queued, v_recent_version, v_queued_version
      from public.omr_teacher_notification_summary_v1('notification-summary-missing') summary;
    if v_recent is distinct from 0 or v_queued is distinct from 0
       or v_recent_version is distinct from 'none'
       or v_queued_version is distinct from 'none' then
        raise exception 'empty notification summary must return zero counts';
    end if;

    if pg_catalog.has_function_privilege(
        'anon', 'public.omr_teacher_notification_summary_v1(text)', 'EXECUTE'
    ) or pg_catalog.has_function_privilege(
        'authenticated', 'public.omr_teacher_notification_summary_v1(text)', 'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role', 'public.omr_teacher_notification_summary_v1(text)', 'EXECUTE'
    ) then
        raise exception 'notification summary RPC privileges are not service-only';
    end if;
end;
$$;

drop function public.omr_teacher_notification_summary_v1(text);

do $$
declare
    v_readiness jsonb;
begin
    v_readiness := public.omr_service_readiness_v1();
    if v_readiness ->> 'teacherNotificationSummaryReady' is distinct from 'false'
       or v_readiness ->> 'ready' is distinct from 'false' then
        raise exception 'readiness did not fail closed when migration 011 RPC was absent: %',
            v_readiness;
    end if;
end;
$$;

rollback;
