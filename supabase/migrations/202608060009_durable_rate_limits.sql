begin;

-- Cross-process, hashed-bucket rate limiting for server actions.
create table if not exists public.omr_rate_limit_buckets (
    bucket_hash text primary key check (bucket_hash ~ '^[a-f0-9]{64}$'),
    window_started_at timestamptz not null,
    request_count integer not null check (request_count >= 0),
    locked_until timestamptz,
    expires_at timestamptz not null
);

create index if not exists omr_rate_limit_buckets_expires_idx
    on public.omr_rate_limit_buckets (expires_at, bucket_hash);

alter table public.omr_rate_limit_buckets enable row level security;
alter table public.omr_rate_limit_buckets force row level security;

revoke all on table public.omr_rate_limit_buckets from public, anon, authenticated, service_role;

create or replace function public.omr_consume_rate_limit_v1(
    p_bucket_hash text,
    p_operation text,
    p_limit integer,
    p_window_seconds integer,
    p_lockout_seconds integer default 0
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_now timestamptz := pg_catalog.clock_timestamp();
    v_window interval;
    v_lockout interval;
    v_started timestamptz;
    v_count integer;
    v_locked_until timestamptz;
    v_expires_at timestamptz;
    v_retry_ms integer := 0;
begin
    if p_bucket_hash is null or p_operation is null or p_limit is null
        or p_window_seconds is null or p_lockout_seconds is null
        or p_bucket_hash !~ '^[a-f0-9]{64}$'
        or p_operation not in ('check', 'consume', 'failure', 'success', 'refund')
        or p_limit < 1 or p_limit > 10000
        or p_window_seconds < 1 or p_window_seconds > 86400
        or p_lockout_seconds < 0 or p_lockout_seconds > 604800 then
        raise exception 'invalid rate limit request';
    end if;

    -- Bounded opportunistic cleanup keeps stale buckets from accumulating.
    with stale as (
        select ctid
        from public.omr_rate_limit_buckets
        where expires_at <= v_now
        order by expires_at
        limit 128
        for update skip locked
    )
    delete from public.omr_rate_limit_buckets
    where ctid in (select ctid from stale);

    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_bucket_hash, 0));
    v_window := pg_catalog.make_interval(secs => p_window_seconds);
    v_lockout := pg_catalog.make_interval(secs => p_lockout_seconds);

    if p_operation = 'success' then
        delete from public.omr_rate_limit_buckets where bucket_hash = p_bucket_hash;
        return pg_catalog.jsonb_build_object('allowed', true, 'retry_after_ms', 0);
    end if;

    select window_started_at, request_count, locked_until, expires_at
    into v_started, v_count, v_locked_until, v_expires_at
    from public.omr_rate_limit_buckets
    where bucket_hash = p_bucket_hash
    for update;

    if p_operation = 'refund' then
        if not found or v_started + v_window <= v_now or v_count <= 1 then
            delete from public.omr_rate_limit_buckets where bucket_hash = p_bucket_hash;
        else
            v_count := v_count - 1;
            update public.omr_rate_limit_buckets
               set request_count = v_count
             where bucket_hash = p_bucket_hash;
        end if;
        return pg_catalog.jsonb_build_object('allowed', true, 'retry_after_ms', 0);
    end if;

    if not found or v_started + v_window <= v_now then
        v_started := v_now;
        v_count := 0;
        v_locked_until := null;
    end if;

    if v_locked_until is not null and v_locked_until > v_now then
        v_retry_ms := (case when v_locked_until <= v_now then 0 else pg_catalog.floor(pg_catalog.date_part('epoch', v_locked_until - v_now) * 1000) end)::integer;
        return pg_catalog.jsonb_build_object('allowed', false, 'retry_after_ms', v_retry_ms);
    end if;

    if p_operation = 'check' and v_count >= p_limit then
        v_retry_ms := (case when v_started + v_window <= v_now then 0 else pg_catalog.floor(pg_catalog.date_part('epoch', (v_started + v_window) - v_now) * 1000) end)::integer;
        return pg_catalog.jsonb_build_object('allowed', false, 'retry_after_ms', v_retry_ms);
    end if;
    if p_operation = 'check' then
        return pg_catalog.jsonb_build_object('allowed', true, 'retry_after_ms', 0);
    end if;

    if p_operation = 'consume' and v_count >= p_limit then
        v_retry_ms := (case when v_started + v_window <= v_now then 0 else pg_catalog.floor(pg_catalog.date_part('epoch', (v_started + v_window) - v_now) * 1000) end)::integer;
        return pg_catalog.jsonb_build_object('allowed', false, 'retry_after_ms', v_retry_ms);
    end if;

    v_count := v_count + 1;
    if p_operation = 'failure' and v_count >= p_limit and p_lockout_seconds > 0 then
        v_locked_until := v_now + v_lockout;
    end if;
    v_expires_at := case
        when v_locked_until is not null and v_locked_until > v_started + v_window then v_locked_until
        else v_started + v_window
    end;

    insert into public.omr_rate_limit_buckets (
        bucket_hash, window_started_at, request_count, locked_until, expires_at
    ) values (
        p_bucket_hash, v_started, v_count, v_locked_until, v_expires_at
    ) on conflict (bucket_hash) do update set
        window_started_at = excluded.window_started_at,
        request_count = excluded.request_count,
        locked_until = excluded.locked_until,
        expires_at = excluded.expires_at;

    if v_locked_until is not null and v_locked_until > v_now then
        return pg_catalog.jsonb_build_object(
            'allowed', false,
            'retry_after_ms', (case when v_locked_until <= v_now then 0 else pg_catalog.floor(pg_catalog.date_part('epoch', v_locked_until - v_now) * 1000) end)::integer
        );
    end if;
    return pg_catalog.jsonb_build_object('allowed', true, 'retry_after_ms', 0);
end;
$$;

revoke all on function public.omr_consume_rate_limit_v1(text, text, integer, integer, integer) from public, anon, authenticated, service_role;
grant execute on function public.omr_consume_rate_limit_v1(text, text, integer, integer, integer) to service_role;

commit;
