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

create schema if not exists storage;

create table if not exists storage.buckets (
    id text primary key,
    name text not null,
    public boolean not null default false,
    file_size_limit bigint,
    allowed_mime_types text[]
);
