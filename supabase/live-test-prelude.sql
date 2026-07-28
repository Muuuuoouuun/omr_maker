\set ON_ERROR_STOP on

do $$
begin
    create role anon noinherit;
exception when duplicate_object then null;
end
$$;

do $$
begin
    create role authenticated noinherit;
exception when duplicate_object then null;
end
$$;

do $$
begin
    create role service_role noinherit bypassrls;
exception when duplicate_object then null;
end
$$;

do $$
begin
    create role supabase_storage_admin noinherit bypassrls;
exception when duplicate_object then null;
end
$$;

-- Hosted Supabase keeps Storage entities under this managed owner. PostgreSQL
-- grants SET permission by default for a role membership; spell it out so the
-- verifier models the production policy-installation phase exactly.
grant supabase_storage_admin to postgres with set true;

create schema if not exists auth;

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

create schema if not exists storage authorization supabase_storage_admin;

create table if not exists storage.buckets (
    id text primary key,
    name text not null,
    public boolean not null default false,
    file_size_limit bigint,
    allowed_mime_types text[]
);

-- Minimal PostgreSQL-compatible surface for the Supabase-managed object table.
-- The production project already owns this table; the local verifier creates
-- only the common columns used by the server-boundary attack probes.
create table if not exists storage.objects (
    id uuid primary key default gen_random_uuid(),
    bucket_id text not null references storage.buckets(id) on delete cascade,
    name text not null,
    owner uuid,
    metadata jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (bucket_id, name)
);

alter schema storage owner to supabase_storage_admin;
alter table storage.buckets owner to supabase_storage_admin;
alter table storage.objects owner to supabase_storage_admin;

alter table storage.buckets enable row level security;
alter table storage.objects enable row level security;

set role supabase_storage_admin;

grant usage on schema storage to anon, authenticated, service_role;
grant select, insert, update, delete on storage.buckets, storage.objects
    to anon, authenticated, service_role;

drop policy if exists "OMR private assets alpha access" on storage.objects;
create policy "OMR private assets alpha access"
    on storage.objects
    for all
    to anon, authenticated
    using (bucket_id = 'omr-private-assets')
    with check (bucket_id = 'omr-private-assets');

-- These unrelated policies prove the production profile only narrows the OMR
-- bucket and leaves other Storage consumers unchanged.
drop policy if exists "Third-party browser object access" on storage.objects;
create policy "Third-party browser object access"
    on storage.objects
    for all
    to anon, authenticated
    using (true)
    with check (true);

drop policy if exists "Third-party browser bucket access" on storage.buckets;
create policy "Third-party browser bucket access"
    on storage.buckets
    for all
    to anon, authenticated
    using (true)
    with check (true);

reset role;
