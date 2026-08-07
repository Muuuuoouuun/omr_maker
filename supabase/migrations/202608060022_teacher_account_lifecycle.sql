-- Private teacher account lifecycle. Browser roles never access these rows;
-- server actions use the service role through the narrow RPCs below.

create table if not exists public.omr_teacher_accounts (
    id text primary key check (id ~ '^teacher_[a-z0-9]{16}$'),
    email text not null unique,
    display_name text not null check (char_length(btrim(display_name)) between 1 and 80),
    password_hash text not null check (
        password_hash ~ '^pbkdf2-sha256:120000:[a-f0-9]{32}:[a-f0-9]{64}$'
    ),
    status text not null default 'pending' check (status in ('pending', 'active', 'disabled')),
    email_verified_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    check (email = lower(btrim(email))),
    check (char_length(email) between 3 and 254)
);

create table if not exists public.omr_teacher_account_tokens (
    id text primary key check (id ~ '^teacher_token_[a-z0-9]{24}$'),
    account_id text not null references public.omr_teacher_accounts(id) on delete cascade,
    purpose text not null check (purpose in ('email_verify', 'password_reset')),
    token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
    expires_at timestamptz not null,
    consumed_at timestamptz,
    created_at timestamptz not null default now(),
    check (expires_at > created_at)
);

create index if not exists omr_teacher_account_tokens_account_purpose_idx
    on public.omr_teacher_account_tokens (account_id, purpose, created_at desc)
    where consumed_at is null;

alter table public.omr_teacher_accounts enable row level security;
alter table public.omr_teacher_accounts force row level security;
alter table public.omr_teacher_account_tokens enable row level security;
alter table public.omr_teacher_account_tokens force row level security;

revoke all on table public.omr_teacher_accounts from public, anon, authenticated, service_role;
revoke all on table public.omr_teacher_account_tokens from public, anon, authenticated, service_role;

create or replace function public.omr_begin_teacher_signup_v1(
    p_account_id text,
    p_token_id text,
    p_email text,
    p_display_name text,
    p_password_hash text,
    p_token_hash text,
    p_expires_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
    v_account_id text;
begin
    if p_account_id !~ '^teacher_[a-z0-9]{16}$'
        or p_token_id !~ '^teacher_token_[a-z0-9]{24}$'
        or p_email <> lower(btrim(p_email))
        or char_length(p_email) not between 3 and 254
        or char_length(btrim(p_display_name)) not between 1 and 80
        or p_password_hash !~ '^pbkdf2-sha256:120000:[a-f0-9]{32}:[a-f0-9]{64}$'
        or p_token_hash !~ '^[a-f0-9]{64}$'
        or p_expires_at <= now()
    then
        return false;
    end if;

    insert into public.omr_teacher_accounts (
        id, email, display_name, password_hash, status, created_at, updated_at
    ) values (
        p_account_id, p_email, btrim(p_display_name), p_password_hash, 'pending', now(), now()
    ) on conflict (email) do update
        set display_name = excluded.display_name,
            password_hash = excluded.password_hash,
            updated_at = now()
        where omr_teacher_accounts.status = 'pending'
    returning id into v_account_id;

    if v_account_id is null then return false; end if;

    update public.omr_teacher_account_tokens
    set consumed_at = now()
    where account_id = v_account_id
      and purpose = 'email_verify'
      and consumed_at is null;

    insert into public.omr_teacher_account_tokens (
        id, account_id, purpose, token_hash, expires_at, created_at
    ) values (
        p_token_id, v_account_id, 'email_verify', p_token_hash, p_expires_at, now()
    );
    return true;
end;
$$;

create or replace function public.omr_begin_teacher_password_reset_v1(
    p_token_id text,
    p_email text,
    p_token_hash text,
    p_expires_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
    v_account_id text;
begin
    if p_token_id !~ '^teacher_token_[a-z0-9]{24}$'
        or p_email <> lower(btrim(p_email))
        or p_token_hash !~ '^[a-f0-9]{64}$'
        or p_expires_at <= now()
    then
        return false;
    end if;

    select id into v_account_id
    from public.omr_teacher_accounts
    where email = p_email and status = 'active'
    limit 1;
    if v_account_id is null then return false; end if;

    update public.omr_teacher_account_tokens
    set consumed_at = now()
    where account_id = v_account_id
      and purpose = 'password_reset'
      and consumed_at is null;

    insert into public.omr_teacher_account_tokens (
        id, account_id, purpose, token_hash, expires_at, created_at
    ) values (
        p_token_id, v_account_id, 'password_reset', p_token_hash, p_expires_at, now()
    );
    return true;
end;
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
    set password_hash = p_password_hash, updated_at = now()
    where id = v_account_id and status = 'active';
    if not found then return false; end if;

    update public.omr_teacher_account_tokens
    set consumed_at = now()
    where id = v_token_id and consumed_at is null;
    return found;
end;
$$;

create or replace function public.omr_verify_teacher_email_v1(p_token_hash text)
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
      and purpose = 'email_verify'
      and consumed_at is null
      and expires_at > now()
    for update skip locked;
    if v_token_id is null then return false; end if;

    update public.omr_teacher_accounts
    set status = 'active', email_verified_at = now(), updated_at = now()
    where id = v_account_id and status = 'pending';
    if not found then return false; end if;

    update public.omr_teacher_account_tokens
    set consumed_at = now()
    where id = v_token_id and consumed_at is null;
    return found;
end;
$$;

create or replace function public.omr_lookup_teacher_account_v1(p_identifier text)
returns table (
    id text,
    email text,
    display_name text,
    password_hash text,
    status text
)
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
    select account.id, account.email, account.display_name, account.password_hash, account.status
    from public.omr_teacher_accounts account
    where account.status = 'active'
      and account.email = lower(btrim(p_identifier))
    limit 1
$$;

revoke all on function public.omr_begin_teacher_signup_v1(text, text, text, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.omr_begin_teacher_password_reset_v1(text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.omr_complete_teacher_password_reset_v1(text, text) from public, anon, authenticated;
revoke all on function public.omr_verify_teacher_email_v1(text) from public, anon, authenticated;
revoke all on function public.omr_lookup_teacher_account_v1(text) from public, anon, authenticated;
grant execute on function public.omr_begin_teacher_signup_v1(text, text, text, text, text, text, timestamptz) to service_role;
grant execute on function public.omr_begin_teacher_password_reset_v1(text, text, text, timestamptz) to service_role;
grant execute on function public.omr_complete_teacher_password_reset_v1(text, text) to service_role;
grant execute on function public.omr_verify_teacher_email_v1(text) to service_role;
grant execute on function public.omr_lookup_teacher_account_v1(text) to service_role;
