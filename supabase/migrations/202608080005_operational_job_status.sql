begin;

create sequence public.omr_operational_job_run_sequence
    as bigint
    minvalue 1
    maxvalue 9007199254740991
    start with 1
    increment by 1
    no cycle;
revoke all on sequence public.omr_operational_job_run_sequence
    from public, anon, authenticated, service_role;

create table public.omr_operational_job_status (
    job_key text primary key,
    status text not null,
    last_attempt_at timestamptz not null,
    last_success_at timestamptz,
    dead_count integer not null,
    build_sha text not null,
    failure_category text,
    latest_started_sequence bigint not null,
    latest_completed_sequence bigint,
    active_lease_started_at timestamptz,
    active_lease_until timestamptz,
    constraint omr_operational_job_status_job_key_check check (
        pg_catalog.octet_length(job_key) between 1 and 64 and job_key = 'asset_gc'
    ),
    constraint omr_operational_job_status_status_check check (status in ('healthy', 'failed')),
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
    constraint omr_operational_job_status_dead_count_check check (dead_count between 0 and 1000000),
    constraint omr_operational_job_status_build_sha_check check (build_sha ~ '^[a-f0-9]{40}$'),
    constraint omr_operational_job_status_failure_category_check check (
        failure_category is null or failure_category ~ '^[a-z][a-z0-9_]{0,63}$'
    ),
    constraint omr_operational_job_status_sequence_check check (
        latest_started_sequence between 1 and 9007199254740991
        and (
            latest_completed_sequence is null
            or (
                latest_completed_sequence between 1 and 9007199254740991
                and latest_completed_sequence <= latest_started_sequence
            )
        )
    ),
    constraint omr_operational_job_status_lease_check check (
        (
            status = 'failed'
            and failure_category = 'run_incomplete'
            and latest_completed_sequence is distinct from latest_started_sequence
            and active_lease_started_at is not null
            and pg_catalog.isfinite(active_lease_started_at)
            and active_lease_until is not null
            and pg_catalog.isfinite(active_lease_until)
            and active_lease_started_at <= last_attempt_at
            and active_lease_until = active_lease_started_at + interval '15 minutes'
        )
        or (
            failure_category is distinct from 'run_incomplete'
            and active_lease_started_at is null
            and active_lease_until is null
        )
    ),
    constraint omr_operational_job_status_state_check check (
        (
            status = 'healthy'
            and last_success_at is not null
            and dead_count = 0
            and failure_category is null
            and latest_completed_sequence = latest_started_sequence
        )
        or (status = 'failed' and failure_category is not null)
    )
);

alter table public.omr_operational_job_status enable row level security;
alter table public.omr_operational_job_status force row level security;
revoke all on table public.omr_operational_job_status
    from public, anon, authenticated, service_role;

-- The deployment is bounded to <=100 users. This exact non-unique partial
-- status index makes the durable dead-backlog count cheap, while the SHARE
-- table lock in completion preserves correctness against concurrent remedies.
create index omr_remote_asset_cleanup_dead_idx
    on public.omr_remote_asset_cleanup_queue (status)
    where status = 'dead';

create function public.omr_begin_operational_job_run_v1(
    p_job_key text,
    p_build_sha text
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
    v_run_sequence bigint;
    v_job_status public.omr_operational_job_status%rowtype;
    v_now timestamptz;
    v_started_at timestamptz;
begin
    if p_job_key is distinct from 'asset_gc'
       or p_build_sha is null
       or p_build_sha !~ '^[a-f0-9]{40}$' then
        raise exception 'invalid operational job run';
    end if;

    -- The 15-minute job lease covers the cleanup queue's bounded 900-second
    -- lease, the provider's 60-second timeout, and the route's 55-second drain.
    -- Lock the durable job row before issuing a generation so only one caller
    -- can be admitted while that lease remains active.
    perform pg_catalog.pg_advisory_xact_lock(20260808, 5);
    v_now := pg_catalog.clock_timestamp();
    select job_status.*
      into v_job_status
      from public.omr_operational_job_status job_status
     where job_status.job_key = p_job_key
     for update;
    if found
       and v_job_status.failure_category = 'run_incomplete'
       and v_job_status.active_lease_until > v_now then
        return pg_catalog.jsonb_build_object(
            'admitted', false,
            'busy', true,
            'runSequence', null
        );
    end if;

    v_run_sequence := pg_catalog.nextval('public.omr_operational_job_run_sequence'::pg_catalog.regclass);
    v_started_at := case
        when v_job_status.job_key is null then v_now
        else greatest(
            v_now,
            v_job_status.last_attempt_at + interval '1 microsecond'
        )
    end;
    lock table public.omr_remote_asset_cleanup_queue in share mode;
    select pg_catalog.count(*)::bigint
      into v_dead_count
      from public.omr_remote_asset_cleanup_queue cleanup
     where cleanup.status = 'dead';
    if v_dead_count > 1000000 then
        raise exception 'operational cleanup backlog exceeds bounded status';
    end if;

    insert into public.omr_operational_job_status as current_status (
        job_key, status, last_attempt_at, last_success_at, dead_count,
        build_sha, failure_category, latest_started_sequence, latest_completed_sequence,
        active_lease_started_at, active_lease_until
    ) values (
        p_job_key, 'failed', v_started_at, null, v_dead_count::integer,
        p_build_sha, 'run_incomplete', v_run_sequence, null,
        v_now, v_now + interval '15 minutes'
    )
    on conflict (job_key) do update
        set status = 'failed',
            last_attempt_at = v_started_at,
            last_success_at = current_status.last_success_at,
            dead_count = v_dead_count::integer,
            build_sha = p_build_sha,
            failure_category = 'run_incomplete',
            latest_started_sequence = v_run_sequence,
            latest_completed_sequence = current_status.latest_completed_sequence,
            active_lease_started_at = v_now,
            active_lease_until = v_now + interval '15 minutes';

    return pg_catalog.jsonb_build_object(
        'admitted', true,
        'busy', false,
        'runSequence', v_run_sequence
    );
end;
$$;

create function public.omr_complete_operational_job_run_v1(
    p_job_key text,
    p_run_sequence bigint,
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
    v_applied boolean := false;
    v_duplicate boolean := false;
    v_superseded boolean := false;
    v_dead_count bigint;
    v_effective_status text;
    v_effective_failure_category text;
    v_job_status public.omr_operational_job_status%rowtype;
    v_recorded_at timestamptz;
begin
    if p_job_key is distinct from 'asset_gc'
       or p_run_sequence is null or p_run_sequence not between 1 and 9007199254740991
       or p_status not in ('healthy', 'failed')
       or p_build_sha is null or p_build_sha !~ '^[a-f0-9]{40}$'
       or (p_status = 'healthy' and p_failure_category is not null)
       or (
           p_status = 'failed'
           and (p_failure_category is null or p_failure_category !~ '^[a-z][a-z0-9_]{0,63}$')
       ) then
        raise exception 'invalid operational job completion';
    end if;

    perform pg_catalog.pg_advisory_xact_lock(20260808, 5);
    select job_status.*
      into v_job_status
      from public.omr_operational_job_status job_status
     where job_status.job_key = p_job_key
     for update;
    if not found then
        raise exception 'operational job run was not begun';
    end if;

    lock table public.omr_remote_asset_cleanup_queue in share mode;
    select pg_catalog.count(*)::bigint
      into v_dead_count
      from public.omr_remote_asset_cleanup_queue cleanup
     where cleanup.status = 'dead';
    if v_dead_count > 1000000 then
        raise exception 'operational cleanup backlog exceeds bounded status';
    end if;

    v_recorded_at := pg_catalog.clock_timestamp();
    v_effective_status := case when v_dead_count > 0 then 'failed' else p_status end;
    v_effective_failure_category := case
        when v_dead_count > 0 and p_status = 'healthy' then 'dead_backlog'
        else p_failure_category
    end;

    if p_run_sequence = v_job_status.latest_started_sequence then
        if v_job_status.latest_completed_sequence = p_run_sequence then
            if p_build_sha is distinct from v_job_status.build_sha
               or v_effective_status is distinct from v_job_status.status
               or v_effective_failure_category is distinct from v_job_status.failure_category then
                raise exception 'operational job completion conflict';
            end if;
            v_duplicate := true;
        else
            if p_build_sha is distinct from v_job_status.build_sha
               or v_job_status.status is distinct from 'failed'
               or v_job_status.failure_category is distinct from 'run_incomplete'
               or v_job_status.active_lease_started_at is null
               or v_job_status.active_lease_until is null
               or v_job_status.active_lease_until <= v_recorded_at then
                raise exception 'operational job completion conflict';
            end if;
            if v_recorded_at <= v_job_status.last_attempt_at then
                v_recorded_at := v_job_status.last_attempt_at + interval '1 microsecond';
            end if;
            update public.omr_operational_job_status
               set status = v_effective_status,
                   last_attempt_at = v_recorded_at,
                   last_success_at = case
                       when v_effective_status = 'healthy' then v_recorded_at
                       else last_success_at
                   end,
                   dead_count = v_dead_count::integer,
                   failure_category = v_effective_failure_category,
                   latest_completed_sequence = p_run_sequence,
                   active_lease_started_at = null,
                   active_lease_until = null
             where job_key = p_job_key
             returning * into strict v_job_status;
            v_applied := true;
        end if;
    elsif p_run_sequence > v_job_status.latest_started_sequence then
        raise exception 'operational job run sequence was not begun';
    else
        v_superseded := true;
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
        end,
        'latestStartedSequence', v_job_status.latest_started_sequence,
        'latestCompletedSequence', v_job_status.latest_completed_sequence,
        'runSequence', p_run_sequence,
        'applied', v_applied,
        'superseded', v_superseded,
        'duplicate', v_duplicate
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
    select job_status.* into v_job_status
      from public.omr_operational_job_status job_status
     where job_status.job_key = p_job_key;
    if not found then return null; end if;
    select pg_catalog.count(*)::bigint into v_dead_count
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
        end,
        'latestStartedSequence', v_job_status.latest_started_sequence,
        'latestCompletedSequence', v_job_status.latest_completed_sequence
    );
end;
$$;

revoke all on function public.omr_begin_operational_job_run_v1(text,text)
    from public, anon, authenticated;
revoke all on function public.omr_complete_operational_job_run_v1(text,bigint,text,text,text)
    from public, anon, authenticated;
revoke all on function public.omr_read_operational_job_status_v1(text)
    from public, anon, authenticated;
grant execute on function public.omr_begin_operational_job_run_v1(text,text) to service_role;
grant execute on function public.omr_complete_operational_job_run_v1(text,bigint,text,text,text) to service_role;
grant execute on function public.omr_read_operational_job_status_v1(text) to service_role;

comment on table public.omr_operational_job_status is
    'Bounded server-only operational job heartbeat state without raw errors or tenant identifiers.';
comment on function public.omr_begin_operational_job_run_v1(text,text)
    is 'monotonic-operational-job-run-begin:202608080005';
comment on function public.omr_complete_operational_job_run_v1(text,bigint,text,text,text)
    is 'generation-fenced-operational-job-run-complete:202608080005';
comment on function public.omr_read_operational_job_status_v1(text)
    is 'bounded-operational-job-heartbeat-read:202608080005';

commit;
