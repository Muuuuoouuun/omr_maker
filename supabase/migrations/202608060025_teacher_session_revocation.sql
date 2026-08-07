-- Revoke all account-backed teacher sessions after password reset/disable.
-- Browser roles retain no direct account-table privileges. Protected server
-- requests call the narrow boolean validation RPC with the service role.

alter table public.omr_teacher_accounts
    add column if not exists session_generation bigint not null default 1;

do $$
begin
    if not exists (
        select 1
        from pg_catalog.pg_constraint
        where conname = 'omr_teacher_accounts_session_generation_check'
          and conrelid = 'public.omr_teacher_accounts'::regclass
    ) then
        alter table public.omr_teacher_accounts
            add constraint omr_teacher_accounts_session_generation_check
            check (session_generation between 1 and 9007199254740991);
    end if;
end;
$$;

-- Any active -> non-active transition permanently advances the generation, so
-- re-enabling an account cannot revive cookies issued before it was disabled.
create or replace function public.omr_advance_teacher_session_on_disable_v1()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
    if old.status = 'active' and new.status <> 'active' then
        if old.session_generation >= 9007199254740991 then
            raise exception 'teacher session generation exhausted';
        end if;
        new.session_generation := old.session_generation + 1;
    end if;
    return new;
end;
$$;

drop trigger if exists omr_teacher_accounts_advance_session_on_disable
    on public.omr_teacher_accounts;
create trigger omr_teacher_accounts_advance_session_on_disable
before update of status on public.omr_teacher_accounts
for each row
execute function public.omr_advance_teacher_session_on_disable_v1();

revoke all on function public.omr_advance_teacher_session_on_disable_v1() from public, anon, authenticated, service_role;

-- PostgreSQL cannot change a RETURNS TABLE shape with CREATE OR REPLACE.
revoke all on function public.omr_lookup_teacher_account_v1(text) from public, anon, authenticated, service_role;
drop function public.omr_lookup_teacher_account_v1(text);
create function public.omr_lookup_teacher_account_v1(p_identifier text)
returns table (
    id text,
    email text,
    display_name text,
    password_hash text,
    status text,
    session_generation bigint
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
    select account.id,
           account.email,
           account.display_name,
           account.password_hash,
           account.status,
           account.session_generation
    from public.omr_teacher_accounts account
    where account.status = 'active'
      and account.email = lower(btrim(p_identifier))
    limit 1
$$;

create or replace function public.omr_complete_teacher_password_reset_v1(
    p_token_hash text,
    p_password_hash text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
    v_token_id text;
    v_account_id text;
begin
    select id, account_id into v_token_id, v_account_id
    from public.omr_teacher_account_tokens
    where token_hash = p_token_hash
      and purpose = 'password_reset'
      and consumed_at is null
      and expires_at > now()
    for update skip locked;
    if v_token_id is null then return false; end if;

    update public.omr_teacher_accounts
    set password_hash = p_password_hash,
        session_generation = session_generation + 1,
        updated_at = now()
    where id = v_account_id and status = 'active'
      and session_generation < 9007199254740991;
    if not found then return false; end if;

    update public.omr_teacher_account_tokens
    set consumed_at = now()
    where id = v_token_id and consumed_at is null;
    return found;
end;
$$;

create or replace function public.omr_validate_teacher_session_v1(
    p_account_id text,
    p_session_generation bigint
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
    select exists (
        select 1
        from public.omr_teacher_accounts account
        where account.id = p_account_id
          and account.status = 'active'
          and account.session_generation = p_session_generation
    )
$$;

revoke all on function public.omr_lookup_teacher_account_v1(text) from public, anon, authenticated;
revoke all on function public.omr_complete_teacher_password_reset_v1(text, text) from public, anon, authenticated;
revoke all on function public.omr_validate_teacher_session_v1(text, bigint) from public, anon, authenticated;
grant execute on function public.omr_lookup_teacher_account_v1(text) to service_role;
grant execute on function public.omr_complete_teacher_password_reset_v1(text, text) to service_role;
grant execute on function public.omr_validate_teacher_session_v1(text, bigint) to service_role;
