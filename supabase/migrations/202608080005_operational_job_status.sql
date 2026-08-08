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

-- Asset-GC is globally bounded to the initial <=100-user deployment. This
-- partial index keeps the exact durable dead-backlog count index-only without
-- weakening the table lock that makes the status snapshot correct.
create index if not exists omr_remote_asset_cleanup_dead_idx
    on public.omr_remote_asset_cleanup_queue (id)
    where status = 'dead';

create function public.omr_record_operational_job_status_v1(
    p_job_key text,
    p_status text,
    p_build_sha text,
    p_failure_category text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
set lock_timeout = '2s'
as $$
declare
    v_dead_count bigint;
    v_effective_status text;
    v_effective_failure_category text;
    v_job_status public.omr_operational_job_status%rowtype;
    v_previous_attempt_at timestamptz;
    v_recorded_at timestamptz;
begin
    if p_job_key is distinct from 'asset_gc'
       or p_status not in ('healthy', 'failed')
       or p_build_sha is null
       or p_build_sha !~ '^[a-f0-9]{40}$'
       or (
           p_status = 'healthy'
           and p_failure_category is not null
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

    -- Serialize same-job invocations before assigning DB time. Client clocks
    -- never participate in ordering, and a clock regression still advances by
    -- one microsecond. Keep the queue lock for a transactionally exact backlog.
    perform pg_catalog.pg_advisory_xact_lock(20260808, 5);
    lock table public.omr_remote_asset_cleanup_queue in share mode;
    select job_status.last_attempt_at
      into v_previous_attempt_at
      from public.omr_operational_job_status job_status
     where job_status.job_key = p_job_key;
    v_recorded_at := pg_catalog.clock_timestamp();
    if v_previous_attempt_at is not null
       and v_recorded_at <= v_previous_attempt_at then
        v_recorded_at := v_previous_attempt_at + interval '1 microsecond';
    end if;
    select pg_catalog.count(*)::bigint
      into v_dead_count
      from public.omr_remote_asset_cleanup_queue cleanup
     where cleanup.status = 'dead';
    if v_dead_count > 1000000 then
        raise exception 'operational cleanup backlog exceeds bounded status';
    end if;
    v_effective_status := case
        when v_dead_count > 0 then 'failed'
        else p_status
    end;
    v_effective_failure_category := case
        when v_dead_count > 0 and p_status = 'healthy' then 'dead_backlog'
        else p_failure_category
    end;

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
        v_effective_status,
        v_recorded_at,
        case when v_effective_status = 'healthy' then v_recorded_at else null end,
        v_dead_count::integer,
        p_build_sha,
        v_effective_failure_category
    )
    on conflict (job_key) do update
        set status = excluded.status,
            last_attempt_at = v_recorded_at,
            last_success_at = case
                when excluded.status = 'healthy' then v_recorded_at
                else current_status.last_success_at
            end,
            dead_count = excluded.dead_count,
            build_sha = excluded.build_sha,
            failure_category = excluded.failure_category;

    select job_status.*
      into strict v_job_status
      from public.omr_operational_job_status job_status
     where job_status.job_key = p_job_key;
    return pg_catalog.jsonb_build_object(
        'status', case when v_dead_count > 0 then 'failed' else v_job_status.status end,
        'lastAttemptAt', v_job_status.last_attempt_at,
        'lastSuccessAt', v_job_status.last_success_at,
        'deadCount', v_dead_count,
        'buildSha', v_job_status.build_sha,
        'failureCategory', case
            when v_dead_count > 0 and v_job_status.status = 'healthy' then 'dead_backlog'
            else v_job_status.failure_category
        end
    );
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
    v_job_status public.omr_operational_job_status%rowtype;
    v_dead_count bigint;
begin
    if p_job_key is distinct from 'asset_gc' then
        raise exception 'invalid operational job key';
    end if;

    select job_status.*
      into v_job_status
      from public.omr_operational_job_status job_status
     where job_status.job_key = p_job_key;
    if not found then
        return null;
    end if;
    select pg_catalog.count(*)::bigint
      into v_dead_count
      from public.omr_remote_asset_cleanup_queue cleanup
     where cleanup.status = 'dead';
    if v_dead_count > 1000000 then
        raise exception 'operational cleanup backlog exceeds bounded status';
    end if;
    return pg_catalog.jsonb_build_object(
        'status', case when v_dead_count > 0 then 'failed' else v_job_status.status end,
        'lastAttemptAt', v_job_status.last_attempt_at,
        'lastSuccessAt', v_job_status.last_success_at,
        'deadCount', v_dead_count,
        'buildSha', v_job_status.build_sha,
        'failureCategory', case
            when v_dead_count > 0 and v_job_status.status = 'healthy' then 'dead_backlog'
            else v_job_status.failure_category
        end
    );
end;
$$;

revoke all on function public.omr_record_operational_job_status_v1(
    text, text, text, text
) from public, anon, authenticated;
revoke all on function public.omr_read_operational_job_status_v1(text)
    from public, anon, authenticated;
grant execute on function public.omr_record_operational_job_status_v1(
    text, text, text, text
) to service_role;
grant execute on function public.omr_read_operational_job_status_v1(text)
    to service_role;

comment on table public.omr_operational_job_status is
    'Bounded server-only operational job heartbeat state without raw errors or tenant identifiers.';
comment on function public.omr_record_operational_job_status_v1(text,text,text,text)
    is 'monotonic-operational-job-heartbeat:202608080005';
comment on function public.omr_read_operational_job_status_v1(text)
    is 'bounded-operational-job-heartbeat-read:202608080005';

commit;
