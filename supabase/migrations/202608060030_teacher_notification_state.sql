begin;

-- Per-teacher interaction state for deterministic, server-derived in-app
-- notification ids. The underlying table is RPC-only so a publishable browser
-- credential cannot enumerate user activity or forge another teacher's state.
create table if not exists public.omr_teacher_notification_states (
    organization_id text not null references public.omr_organizations(id) on delete cascade,
    teacher_user_id text not null,
    notification_id text not null,
    read_at timestamptz not null,
    dismissed_at timestamptz,
    updated_at timestamptz not null,
    expires_at timestamptz not null,
    primary key (organization_id, teacher_user_id, notification_id),
    constraint omr_teacher_notification_states_organization_check check (
        pg_catalog.octet_length(organization_id) between 1 and 128
        and organization_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
    ),
    constraint omr_teacher_notification_states_user_check check (
        pg_catalog.octet_length(teacher_user_id) between 1 and 128
        and teacher_user_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
    ),
    constraint omr_teacher_notification_states_id_check check (
        pg_catalog.octet_length(notification_id) <= 96
        and notification_id ~ '^auto-(recent-exams|student-questions):[0-9]{1,16}:[a-f0-9]{32}$'
    ),
    constraint omr_teacher_notification_states_dismissed_check check (
        dismissed_at is null or dismissed_at >= read_at
    ),
    constraint omr_teacher_notification_states_expiry_check check (
        expires_at > updated_at and expires_at <= updated_at + interval '14 days'
    )
);

create index if not exists omr_teacher_notification_states_expiry_idx
    on public.omr_teacher_notification_states (expires_at, organization_id, teacher_user_id);

alter table public.omr_teacher_notification_states enable row level security;
alter table public.omr_teacher_notification_states force row level security;

revoke all on table public.omr_teacher_notification_states
    from public, anon, authenticated, service_role;

create or replace function public.omr_load_teacher_notification_state_v1(
    p_organization_id text,
    p_teacher_user_id text,
    p_notification_ids text[]
)
returns table (
    notification_id text,
    read_at timestamptz,
    dismissed_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
    if p_organization_id is null
       or pg_catalog.octet_length(p_organization_id) not between 1 and 128
       or p_organization_id !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
       or p_teacher_user_id is null
       or pg_catalog.octet_length(p_teacher_user_id) not between 1 and 128
       or p_teacher_user_id !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
       or p_notification_ids is null
       or pg_catalog.cardinality(p_notification_ids) > 16
       or exists (
            select 1
              from pg_catalog.unnest(p_notification_ids) requested(notification_id)
             where requested.notification_id is null
                or pg_catalog.octet_length(requested.notification_id) > 96
                or requested.notification_id !~ '^auto-(recent-exams|student-questions):[0-9]{1,16}:[a-f0-9]{32}$'
       )
       or (
            select count(distinct requested.notification_id)
              from pg_catalog.unnest(p_notification_ids) requested(notification_id)
       ) <> pg_catalog.cardinality(p_notification_ids) then
        raise exception 'invalid teacher notification state request';
    end if;

    return query
    select state.notification_id, state.read_at, state.dismissed_at
      from public.omr_teacher_notification_states state
     where state.organization_id = p_organization_id
       and state.teacher_user_id = p_teacher_user_id
       and state.notification_id = any(p_notification_ids)
       and state.expires_at > pg_catalog.statement_timestamp()
     order by pg_catalog.array_position(p_notification_ids, state.notification_id);
end;
$$;

create or replace function public.omr_mutate_teacher_notification_state_v1(
    p_organization_id text,
    p_teacher_user_id text,
    p_operation text,
    p_notification_ids text[]
)
returns table (
    notification_id text,
    read_at timestamptz,
    dismissed_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
    v_now timestamptz := pg_catalog.clock_timestamp();
begin
    if p_organization_id is null
       or pg_catalog.octet_length(p_organization_id) not between 1 and 128
       or p_organization_id !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
       or p_teacher_user_id is null
       or pg_catalog.octet_length(p_teacher_user_id) not between 1 and 128
       or p_teacher_user_id !~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$'
       or p_operation not in ('mark_read', 'dismiss')
       or p_notification_ids is null
       or pg_catalog.cardinality(p_notification_ids) < 1
       or pg_catalog.cardinality(p_notification_ids) > 16
       or exists (
            select 1
              from pg_catalog.unnest(p_notification_ids) requested(notification_id)
             where requested.notification_id is null
                or pg_catalog.octet_length(requested.notification_id) > 96
                or requested.notification_id !~ '^auto-(recent-exams|student-questions):[0-9]{1,16}:[a-f0-9]{32}$'
       )
       or (
            select count(distinct requested.notification_id)
              from pg_catalog.unnest(p_notification_ids) requested(notification_id)
       ) <> pg_catalog.cardinality(p_notification_ids) then
        raise exception 'invalid teacher notification state mutation';
    end if;

    -- Serialize the scope so concurrent tabs cannot race the retention cap.
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        p_organization_id || pg_catalog.chr(31) || p_teacher_user_id,
        0
    ));

    -- Bounded opportunistic global cleanup plus an exact per-user cap keeps
    -- storage bounded even when notification event versions change frequently.
    with stale as (
        select state.ctid
          from public.omr_teacher_notification_states state
         where state.expires_at <= v_now
         order by state.expires_at
         limit 128
         for update skip locked
    )
    delete from public.omr_teacher_notification_states state
     where state.ctid in (select stale.ctid from stale);

    insert into public.omr_teacher_notification_states (
        organization_id,
        teacher_user_id,
        notification_id,
        read_at,
        dismissed_at,
        updated_at,
        expires_at
    )
    select
        p_organization_id,
        p_teacher_user_id,
        requested.notification_id,
        v_now,
        case when p_operation = 'dismiss' then v_now else null end,
        v_now,
        v_now + interval '14 days'
      from pg_catalog.unnest(p_notification_ids) requested(notification_id)
    on conflict on constraint omr_teacher_notification_states_pkey do update set
        read_at = coalesce(public.omr_teacher_notification_states.read_at, excluded.read_at),
        dismissed_at = coalesce(public.omr_teacher_notification_states.dismissed_at, excluded.dismissed_at),
        updated_at = excluded.updated_at,
        expires_at = excluded.expires_at;

    with retained as (
        select state.ctid
          from public.omr_teacher_notification_states state
         where state.organization_id = p_organization_id
           and state.teacher_user_id = p_teacher_user_id
         order by state.updated_at desc, state.notification_id
         limit 64
    )
    delete from public.omr_teacher_notification_states state
     where state.organization_id = p_organization_id
       and state.teacher_user_id = p_teacher_user_id
       and state.ctid not in (select retained.ctid from retained);

    return query
    select state.notification_id, state.read_at, state.dismissed_at
      from public.omr_teacher_notification_states state
     where state.organization_id = p_organization_id
       and state.teacher_user_id = p_teacher_user_id
       and state.notification_id = any(p_notification_ids)
       and state.expires_at > v_now
     order by pg_catalog.array_position(p_notification_ids, state.notification_id);
end;
$$;

revoke all on function public.omr_load_teacher_notification_state_v1(text,text,text[])
    from public, anon, authenticated, service_role;
revoke all on function public.omr_mutate_teacher_notification_state_v1(text,text,text,text[])
    from public, anon, authenticated, service_role;
grant execute on function public.omr_load_teacher_notification_state_v1(text,text,text[])
    to service_role;
grant execute on function public.omr_mutate_teacher_notification_state_v1(text,text,text,text[])
    to service_role;

commit;
