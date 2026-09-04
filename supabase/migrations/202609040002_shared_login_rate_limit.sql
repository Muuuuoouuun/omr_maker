begin;

create table if not exists public.omr_auth_rate_limits (
    limiter_key text primary key,
    failed_count integer not null default 0 check (failed_count >= 0),
    first_failed_at timestamptz not null default now(),
    locked_until timestamptz,
    updated_at timestamptz not null default now()
);

alter table public.omr_auth_rate_limits enable row level security;
alter table public.omr_auth_rate_limits force row level security;
revoke all on public.omr_auth_rate_limits from public, anon, authenticated;

create or replace function public.omr_check_login_rate_limit_v1(
    p_keys text[],
    p_window_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_now timestamptz := now();
    v_locked_until timestamptz;
begin
    if coalesce(pg_catalog.array_length(p_keys, 1), 0) = 0
       or p_window_seconds is null
       or p_window_seconds <= 0 then
        raise exception 'invalid login rate limit payload';
    end if;

    delete from public.omr_auth_rate_limits row
     where row.limiter_key = any(p_keys)
       and coalesce(row.locked_until, '-infinity'::timestamptz) <= v_now
       and row.first_failed_at <= v_now - pg_catalog.make_interval(secs => p_window_seconds);

    select max(row.locked_until) into v_locked_until
      from public.omr_auth_rate_limits row
     where row.limiter_key = any(p_keys)
       and row.locked_until > v_now;

    return jsonb_build_object(
        'allowed', v_locked_until is null,
        'retry_after_ms', case when v_locked_until is null then 0
            else ceil(extract(epoch from (v_locked_until - v_now)) * 1000)::bigint end
    );
end;
$$;

create or replace function public.omr_record_login_failure_v1(
    p_keys text[],
    p_max_failures integer,
    p_window_seconds integer,
    p_lockout_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_now timestamptz := now();
    v_key text;
    v_failed_count integer;
    v_first_failed_at timestamptz;
begin
    if coalesce(pg_catalog.array_length(p_keys, 1), 0) = 0
       or p_max_failures <= 0
       or p_window_seconds <= 0
       or p_lockout_seconds <= 0 then
        raise exception 'invalid login rate limit payload';
    end if;

    foreach v_key in array p_keys loop
        if nullif(btrim(v_key), '') is null then
            continue;
        end if;

        insert into public.omr_auth_rate_limits (limiter_key, failed_count, first_failed_at, updated_at)
        values (v_key, 0, v_now, v_now)
        on conflict (limiter_key) do nothing;

        select row.failed_count, row.first_failed_at
          into v_failed_count, v_first_failed_at
          from public.omr_auth_rate_limits row
         where row.limiter_key = v_key
         for update;

        if not found or v_first_failed_at <= v_now - pg_catalog.make_interval(secs => p_window_seconds) then
            v_failed_count := 1;
            v_first_failed_at := v_now;
        else
            v_failed_count := v_failed_count + 1;
        end if;

        insert into public.omr_auth_rate_limits (
            limiter_key, failed_count, first_failed_at, locked_until, updated_at
        ) values (
            v_key,
            v_failed_count,
            v_first_failed_at,
            case when v_failed_count >= p_max_failures
                then v_now + pg_catalog.make_interval(secs => p_lockout_seconds)
                else null end,
            v_now
        )
        on conflict (limiter_key) do update set
            failed_count = excluded.failed_count,
            first_failed_at = excluded.first_failed_at,
            locked_until = excluded.locked_until,
            updated_at = excluded.updated_at;
    end loop;

    return jsonb_build_object('recorded', true);
end;
$$;

create or replace function public.omr_clear_login_rate_limit_v1(p_keys text[])
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
    if coalesce(pg_catalog.array_length(p_keys, 1), 0) = 0 then
        raise exception 'invalid login rate limit payload';
    end if;
    delete from public.omr_auth_rate_limits row where row.limiter_key = any(p_keys);
    return jsonb_build_object('cleared', true);
end;
$$;

revoke all on function public.omr_check_login_rate_limit_v1(text[], integer) from public, anon, authenticated;
revoke all on function public.omr_record_login_failure_v1(text[], integer, integer, integer) from public, anon, authenticated;
revoke all on function public.omr_clear_login_rate_limit_v1(text[]) from public, anon, authenticated;
grant execute on function public.omr_check_login_rate_limit_v1(text[], integer) to service_role;
grant execute on function public.omr_record_login_failure_v1(text[], integer, integer, integer) to service_role;
grant execute on function public.omr_clear_login_rate_limit_v1(text[]) to service_role;

commit;
