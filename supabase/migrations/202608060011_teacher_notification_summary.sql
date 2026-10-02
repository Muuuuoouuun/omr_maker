begin;

-- Queue metadata is reduced when an attempt payload changes, rather than
-- expanding up to 2,000 JSON payloads on every notification poll. Invalid or
-- oversized timestamps produce a null version so the server fails closed.
create or replace function public.omr_notification_timestamp_epoch_v1(p_value text)
returns text
language plpgsql
immutable
parallel safe
strict
set search_path = ''
as $$
declare
    v_timestamp timestamptz;
begin
    if pg_catalog.octet_length(p_value) > 64
       or p_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$' then
        return null;
    end if;
    v_timestamp := p_value::timestamptz;
    return ((extract(epoch from v_timestamp) * 1000000)::numeric(30, 0))::text;
exception when others then
    return null;
end;
$$;

create or replace function public.omr_queued_student_question_count_v1(p_payload jsonb)
returns integer
language sql
immutable
parallel safe
set search_path = ''
as $$
    select case when count(*) > 2147483647 then 2147483647 else count(*)::integer end
      from pg_catalog.jsonb_array_elements(
          public.omr_student_question_summaries_v1(p_payload)
      ) as question(note)
     where question.note ->> 'status' = 'queued';
$$;

create or replace function public.omr_queued_student_question_version_v1(p_payload jsonb)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
    with queued as (
        select
            pg_catalog.left(question.note ->> 'questionId', 32) as question_id,
            public.omr_notification_timestamp_epoch_v1(
                question.note ->> 'createdAt'
            ) as created_epoch
          from pg_catalog.jsonb_array_elements(
              public.omr_student_question_summaries_v1(p_payload)
          ) as question(note)
         where question.note ->> 'status' = 'queued'
    )
    select case
        when count(*) = 0 then 'none'
        when count(created_epoch) <> count(*) then null
        else pg_catalog.md5(
            max(created_epoch) || ':' ||
            pg_catalog.string_agg(
                question_id || ':' || created_epoch,
                ',' order by question_id, created_epoch
            )
        )
    end
      from queued;
$$;

alter table public.omr_attempts
    add column if not exists queued_student_question_count integer
        generated always as (
            public.omr_queued_student_question_count_v1(payload)
        ) stored,
    add column if not exists queued_student_question_version text
        generated always as (
            public.omr_queued_student_question_version_v1(payload)
        ) stored;

create index if not exists omr_attempts_notification_summary_idx
    on public.omr_attempts (organization_id, status, finished_at desc, id)
    include (queued_student_question_count, queued_student_question_version);

drop function if exists public.omr_teacher_notification_summary_v1(text);
create function public.omr_teacher_notification_summary_v1(
    p_organization_id text
)
returns table (
    recent_completed_attempt_count bigint,
    queued_student_question_count bigint,
    recent_event_version text,
    queued_event_version text
)
language sql
stable
security definer
set search_path = ''
as $$
    with scoped as materialized (
        select
            attempt.id,
            attempt.status,
            attempt.finished_at,
            attempt.queued_student_question_count,
            attempt.queued_student_question_version
          from public.omr_attempts attempt
         where attempt.organization_id = p_organization_id
           and p_organization_id is not null
           and pg_catalog.btrim(p_organization_id) <> ''
         order by attempt.id
         limit 2001
    ), totals as (
        select
            count(*) as bounded_attempt_count,
            count(*) filter (
                where scoped.status = 'completed'
                  and scoped.finished_at >= now() - interval '24 hours'
            )::bigint as recent_count,
            coalesce(sum(scoped.queued_student_question_count), 0)::bigint as queued_count,
            count(*) filter (
                where scoped.queued_student_question_count > 0
                  and scoped.queued_student_question_version is null
            ) as invalid_queue_versions
          from scoped
    )
    select
        totals.recent_count,
        totals.queued_count,
        case
            when totals.bounded_attempt_count > 2000 then null
            when totals.recent_count = 0 then 'none'
            else (
                select pg_catalog.md5(
                    pg_catalog.left(recent.id, 128) || ':' ||
                    (extract(epoch from recent.finished_at) * 1000000)::numeric(30, 0)::text
                )
                  from scoped recent
                 where recent.status = 'completed'
                   and recent.finished_at >= now() - interval '24 hours'
                 order by recent.finished_at desc, recent.id desc
                 limit 1
            )
        end as recent_event_version,
        case
            when totals.bounded_attempt_count > 2000 then null
            when totals.queued_count = 0 then 'none'
            when totals.invalid_queue_versions > 0 then null
            else pg_catalog.md5((
                select pg_catalog.string_agg(
                    pg_catalog.left(queued.id, 128) || ':' || queued.queued_student_question_version,
                    ',' order by queued.id
                )
                  from scoped queued
                 where queued.queued_student_question_count > 0
            ))
        end as queued_event_version
      from totals;
$$;

revoke all on function public.omr_notification_timestamp_epoch_v1(text)
    from public, anon, authenticated;
revoke all on function public.omr_queued_student_question_count_v1(jsonb)
    from public, anon, authenticated;
revoke all on function public.omr_queued_student_question_version_v1(jsonb)
    from public, anon, authenticated;
revoke all on function public.omr_teacher_notification_summary_v1(text)
    from public, anon, authenticated;
grant execute on function public.omr_teacher_notification_summary_v1(text)
    to service_role;

commit;
