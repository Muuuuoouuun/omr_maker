begin;

create table public.omr_operational_job_status (
    job_key text primary key,
    status text not null,
    last_attempt_at timestamptz not null,
    last_success_at timestamptz,
    dead_count integer not null,
    build_sha text not null,
    failure_category text,
    constraint omr_operational_job_status_job_key_check check (
        pg_catalog.octet_length(job_key) between 1 and 64
        and job_key = 'asset_gc'
    ),
    constraint omr_operational_job_status_status_check check (
        status in ('healthy', 'failed')
    ),
    constraint omr_operational_job_status_attempt_check check (
        pg_catalog.isfinite(last_attempt_at)
        and last_attempt_at >= timestamptz '2020-01-01 00:00:00+00'
    ),
    constraint omr_operational_job_status_success_check check (
        last_success_at is null
        or (
            pg_catalog.isfinite(last_success_at)
            and last_success_at >= timestamptz '2020-01-01 00:00:00+00'
            and last_success_at <= last_attempt_at
        )
    ),
    constraint omr_operational_job_status_dead_count_check check (
        dead_count between 0 and 1000000
    ),
    constraint omr_operational_job_status_build_sha_check check (
        build_sha ~ '^[a-f0-9]{40}$'
    ),
    constraint omr_operational_job_status_failure_category_check check (
        failure_category is null
        or failure_category ~ '^[a-z][a-z0-9_]{0,63}$'
    ),
    constraint omr_operational_job_status_state_check check (
        (
            status = 'healthy'
            and last_success_at is not null
            and dead_count = 0
            and failure_category is null
        )
        or (
            status = 'failed'
            and failure_category is not null
        )
    )
);

alter table public.omr_operational_job_status enable row level security;
alter table public.omr_operational_job_status force row level security;
revoke all on table public.omr_operational_job_status
    from public, anon, authenticated, service_role;

create function public.omr_record_operational_job_status_v1(
    p_job_key text,
    p_status text,
    p_attempted_at timestamptz,
    p_dead_count integer,
    p_build_sha text,
    p_failure_category text
)
returns boolean
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
set lock_timeout = '2s'
as $$
declare
    v_applied_count integer;
begin
    if p_job_key is distinct from 'asset_gc'
       or p_status not in ('healthy', 'failed')
       or p_attempted_at is null
       or not pg_catalog.isfinite(p_attempted_at)
       or p_attempted_at < timestamptz '2020-01-01 00:00:00+00'
       or p_attempted_at > pg_catalog.clock_timestamp() + interval '5 minutes'
       or p_dead_count is null
       or p_dead_count not between 0 and 1000000
       or p_build_sha is null
       or p_build_sha !~ '^[a-f0-9]{40}$'
       or (
           p_status = 'healthy'
           and (p_dead_count <> 0 or p_failure_category is not null)
       )
       or (
           p_status = 'failed'
           and (
               p_failure_category is null
               or p_failure_category !~ '^[a-z][a-z0-9_]{0,63}$'
           )
       ) then
        raise exception 'invalid operational job status';
    end if;

    insert into public.omr_operational_job_status as current_status (
        job_key,
        status,
        last_attempt_at,
        last_success_at,
        dead_count,
        build_sha,
        failure_category
    ) values (
        p_job_key,
        p_status,
        p_attempted_at,
        case when p_status = 'healthy' then p_attempted_at else null end,
        p_dead_count,
        p_build_sha,
        p_failure_category
    )
    on conflict (job_key) do update
        set status = excluded.status,
            last_attempt_at = excluded.last_attempt_at,
            last_success_at = case
                when excluded.status = 'healthy' then excluded.last_attempt_at
                else current_status.last_success_at
            end,
            dead_count = excluded.dead_count,
            build_sha = excluded.build_sha,
            failure_category = excluded.failure_category
        where excluded.last_attempt_at > current_status.last_attempt_at;

    get diagnostics v_applied_count = row_count;
    return v_applied_count = 1;
end;
$$;

create function public.omr_read_operational_job_status_v1(p_job_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
declare
    v_result jsonb;
begin
    if p_job_key is distinct from 'asset_gc' then
        raise exception 'invalid operational job key';
    end if;

    select pg_catalog.jsonb_build_object(
        'status', job_status.status,
        'lastAttemptAt', job_status.last_attempt_at,
        'lastSuccessAt', job_status.last_success_at,
        'deadCount', job_status.dead_count,
        'buildSha', job_status.build_sha,
        'failureCategory', job_status.failure_category
    )
      into v_result
      from public.omr_operational_job_status job_status
     where job_status.job_key = p_job_key;
    return v_result;
end;
$$;

revoke all on function public.omr_record_operational_job_status_v1(
    text, text, timestamptz, integer, text, text
) from public, anon, authenticated;
revoke all on function public.omr_read_operational_job_status_v1(text)
    from public, anon, authenticated;
grant execute on function public.omr_record_operational_job_status_v1(
    text, text, timestamptz, integer, text, text
) to service_role;
grant execute on function public.omr_read_operational_job_status_v1(text)
    to service_role;

comment on table public.omr_operational_job_status is
    'Bounded server-only operational job heartbeat state without raw errors or tenant identifiers.';
comment on function public.omr_record_operational_job_status_v1(text,text,timestamptz,integer,text,text)
    is 'monotonic-operational-job-heartbeat:202608080005';
comment on function public.omr_read_operational_job_status_v1(text)
    is 'bounded-operational-job-heartbeat-read:202608080005';

commit;
