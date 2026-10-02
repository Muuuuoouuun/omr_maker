begin;

do $$
begin
    if pg_catalog.to_regprocedure('extensions.gen_random_bytes(integer)') is null then
        raise exception 'pgcrypto extensions.gen_random_bytes(integer) is required';
    end if;
end
$$;

alter table public.omr_student_profiles
    add column credential_generation integer not null default 1,
    add constraint omr_student_profiles_credential_generation_check
        check (credential_generation between 1 and 2147483646);

create table public.omr_student_credential_epochs (
    organization_id text not null references public.omr_organizations(id) on delete cascade,
    student_profile_id text not null,
    account_id text not null,
    credential_generation integer not null,
    created_at timestamptz not null default pg_catalog.clock_timestamp(),
    updated_at timestamptz not null default pg_catalog.clock_timestamp(),
    primary key (organization_id, student_profile_id),
    constraint omr_student_credential_epochs_account_id_unique unique (account_id),
    constraint omr_student_credential_epochs_account_id_check
        check (account_id ~ '^student_credential_[a-f0-9]{32}$'),
    constraint omr_student_credential_epochs_generation_check
        check (credential_generation between 1 and 2147483646),
    constraint omr_student_credential_epochs_updated_check
        check (updated_at >= created_at)
);

comment on table public.omr_student_credential_epochs is
    'RPC-only monotonic student credential incarnation ledger. It intentionally survives profile and credential row replacement.';

alter table public.omr_student_credential_epochs enable row level security;
alter table public.omr_student_credential_epochs force row level security;
revoke all on table public.omr_student_credential_epochs
    from public, anon, authenticated, service_role;

insert into public.omr_student_credential_epochs (
    organization_id,
    student_profile_id,
    account_id,
    credential_generation
)
select credential.organization_id,
       credential.student_profile_id,
       'student_credential_' || pg_catalog.encode(extensions.gen_random_bytes(16), 'hex'),
       1
  from public.omr_student_start_credentials credential;

alter table public.omr_student_start_credentials
    add column account_id text,
    add column credential_generation integer not null default 1;

update public.omr_student_start_credentials credential
   set account_id = epoch.account_id,
       credential_generation = epoch.credential_generation
  from public.omr_student_credential_epochs epoch
 where epoch.organization_id = credential.organization_id
   and epoch.student_profile_id = credential.student_profile_id;

alter table public.omr_student_start_credentials
    alter column account_id set not null,
    add constraint omr_student_start_credentials_account_id_unique unique (account_id),
    add constraint omr_student_start_credentials_account_id_check
        check (account_id ~ '^student_credential_[a-f0-9]{32}$'),
    add constraint omr_student_start_credentials_generation_check
        check (credential_generation between 1 and 2147483646);

update public.omr_student_profiles student
   set credential_generation = epoch.credential_generation
  from public.omr_student_credential_epochs epoch
 where epoch.organization_id = student.organization_id
   and epoch.student_profile_id = student.id;

create function public.omr_guard_student_profile_generation_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
set lock_timeout = '2s'
as $$
declare
    v_generation integer;
begin
    if new.credential_generation is not distinct from old.credential_generation then
        return new;
    end if;
    select epoch.credential_generation into v_generation
      from public.omr_student_credential_epochs epoch
     where epoch.organization_id = old.organization_id
       and epoch.student_profile_id = old.id
     for update;
    if v_generation is null or new.credential_generation is distinct from v_generation then
        raise exception 'student profile credential generation mismatch'
            using errcode = '23514';
    end if;
    return new;
end;
$$;

comment on function public.omr_guard_student_profile_generation_v1() is
    'Prevents direct profile generation drift from the RPC-only credential epoch ledger.';
alter function public.omr_guard_student_profile_generation_v1() owner to postgres;
revoke all on function public.omr_guard_student_profile_generation_v1()
    from public, anon, authenticated, service_role;

create trigger omr_student_profile_generation_guard
    before update of credential_generation on public.omr_student_profiles
    for each row
    execute function public.omr_guard_student_profile_generation_v1();

alter function public.omr_guard_student_credential_mutation_v1()
    rename to omr_guard_student_credential_mutation_v8_snapshot;

create function public.omr_guard_student_credential_mutation_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
set lock_timeout = '2s'
as $$
declare
    v_profile public.omr_student_profiles%rowtype;
    v_epoch public.omr_student_credential_epochs%rowtype;
begin
    select student.* into v_profile
      from public.omr_student_profiles student
     where student.organization_id = new.organization_id
       and student.id = new.student_profile_id
     for update;
    if not found or v_profile.status not in ('invited', 'active') then
        raise exception 'student credential requires an active profile'
            using errcode = '23514';
    end if;

    select epoch.* into v_epoch
      from public.omr_student_credential_epochs epoch
     where epoch.organization_id = new.organization_id
       and epoch.student_profile_id = new.student_profile_id
     for update;
    if not found and tg_op = 'INSERT' and new.account_id is null then
        insert into public.omr_student_credential_epochs (
            organization_id, student_profile_id, account_id,
            credential_generation, created_at, updated_at
        ) values (
            new.organization_id,
            new.student_profile_id,
            'student_credential_' || pg_catalog.encode(extensions.gen_random_bytes(16), 'hex'),
            v_profile.credential_generation,
            pg_catalog.clock_timestamp(),
            pg_catalog.clock_timestamp()
        ) returning * into v_epoch;
        new.account_id := v_epoch.account_id;
        new.credential_generation := v_epoch.credential_generation;
    end if;
    if not found
       or new.account_id is distinct from v_epoch.account_id
       or new.credential_generation is distinct from v_epoch.credential_generation
       or new.credential_generation is distinct from v_profile.credential_generation then
        raise exception 'student credential incarnation mismatch'
            using errcode = '23514';
    end if;
    return new;
end;
$$;

comment on function public.omr_guard_student_credential_mutation_v1() is
    'Rejects credential writes not bound to the current durable student credential incarnation.';
alter function public.omr_guard_student_credential_mutation_v1() owner to postgres;
revoke all on function public.omr_guard_student_credential_mutation_v1()
    from public, anon, authenticated, service_role;
revoke all on function public.omr_guard_student_credential_mutation_v8_snapshot()
    from public, anon, authenticated, service_role;

drop trigger omr_student_credential_active_profile_guard
    on public.omr_student_start_credentials;
create trigger omr_student_credential_active_profile_guard
    before insert or update on public.omr_student_start_credentials
    for each row
    execute function public.omr_guard_student_credential_mutation_v1();

alter function public.omr_revoke_withdrawn_student_credential_v1()
    rename to omr_revoke_withdrawn_student_credential_v8_snapshot;

create function public.omr_revoke_student_session_on_status_v2()
returns trigger
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
set lock_timeout = '2s'
as $$
declare
    v_generation integer;
    v_account_id text;
begin
    if old.status in ('invited', 'active')
       and new.status not in ('invited', 'active') then
        insert into public.omr_student_credential_epochs (
            organization_id, student_profile_id, account_id,
            credential_generation, created_at, updated_at
        ) values (
            old.organization_id,
            old.id,
            'student_credential_' || pg_catalog.encode(extensions.gen_random_bytes(16), 'hex'),
            1,
            pg_catalog.clock_timestamp(),
            pg_catalog.clock_timestamp()
        )
        on conflict (organization_id, student_profile_id) do update
           set account_id = 'student_credential_' || pg_catalog.encode(extensions.gen_random_bytes(16), 'hex'),
               credential_generation = public.omr_student_credential_epochs.credential_generation + 1,
               updated_at = pg_catalog.clock_timestamp()
         where public.omr_student_credential_epochs.credential_generation < 2147483646
        returning credential_generation, account_id into v_generation, v_account_id;
        if v_generation is null or v_account_id is null then
            raise exception 'student credential generation exhausted';
        end if;
        new.credential_generation := v_generation;
        delete from public.omr_student_start_credentials credential
         where credential.organization_id = old.organization_id
           and credential.student_profile_id = old.id;
    end if;
    return new;
end;
$$;

comment on function public.omr_revoke_student_session_on_status_v2() is
    'Advances the durable credential incarnation and removes the verifier on student deactivation.';
alter function public.omr_revoke_student_session_on_status_v2() owner to postgres;
revoke all on function public.omr_revoke_student_session_on_status_v2()
    from public, anon, authenticated, service_role;
revoke all on function public.omr_revoke_withdrawn_student_credential_v8_snapshot()
    from public, anon, authenticated, service_role;

drop trigger omr_student_profile_credential_revocation
    on public.omr_student_profiles;
create trigger omr_student_profile_credential_revocation
    before update of status on public.omr_student_profiles
    for each row
    execute function public.omr_revoke_student_session_on_status_v2();

create function public.omr_revoke_student_session_on_delete_v2()
returns trigger
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
set lock_timeout = '2s'
as $$
declare
    v_generation integer;
begin
    -- The parent organization and its epoch ledger are both cascading away;
    -- creating a tombstone here would violate the already-deleted parent FK.
    if not exists (
        select 1 from public.omr_organizations organization
         where organization.id = old.organization_id
    ) then
        return old;
    end if;
    insert into public.omr_student_credential_epochs (
        organization_id, student_profile_id, account_id,
        credential_generation, created_at, updated_at
    ) values (
        old.organization_id,
        old.id,
        'student_credential_' || pg_catalog.encode(extensions.gen_random_bytes(16), 'hex'),
        1,
        pg_catalog.clock_timestamp(),
        pg_catalog.clock_timestamp()
    )
    on conflict (organization_id, student_profile_id) do update
       set account_id = 'student_credential_' || pg_catalog.encode(extensions.gen_random_bytes(16), 'hex'),
           credential_generation = public.omr_student_credential_epochs.credential_generation + 1,
           updated_at = pg_catalog.clock_timestamp()
     where public.omr_student_credential_epochs.credential_generation < 2147483646
    returning credential_generation into v_generation;
    if v_generation is null then
        raise exception 'student credential generation exhausted';
    end if;
    delete from public.omr_student_start_credentials credential
     where credential.organization_id = old.organization_id
       and credential.student_profile_id = old.id;
    return old;
end;
$$;

comment on function public.omr_revoke_student_session_on_delete_v2() is
    'Preserves a non-reusable credential tombstone before a student profile is deleted.';
alter function public.omr_revoke_student_session_on_delete_v2() owner to postgres;
revoke all on function public.omr_revoke_student_session_on_delete_v2()
    from public, anon, authenticated, service_role;

create trigger omr_student_profile_session_revocation_on_delete
    before delete on public.omr_student_profiles
    for each row
    execute function public.omr_revoke_student_session_on_delete_v2();

create function public.omr_rotate_student_start_credential_v1(
    p_session_authority text,
    p_account_id text,
    p_session_generation bigint,
    p_organization_id text,
    p_actor_user_id text,
    p_student_id text,
    p_start_code_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
set lock_timeout = '2s'
as $$
declare
    v_identity jsonb;
    v_profile public.omr_student_profiles%rowtype;
    v_account_id text;
    v_generation integer;
begin
    if nullif(pg_catalog.btrim(p_organization_id), '') is null
       or nullif(pg_catalog.btrim(p_student_id), '') is null
       or pg_catalog.length(p_organization_id) > 256
       or pg_catalog.length(p_student_id) > 256
       or p_start_code_hash is null
       or p_start_code_hash !~ '^pbkdf2-sha256:120000:[a-f0-9]{32}:[a-f0-9]{64}$' then
        return pg_catalog.jsonb_build_object('status', 'invalid_request');
    end if;

    perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('omr_roster:' || pg_catalog.btrim(p_organization_id), 0)
    );
    v_identity := public.omr_lock_teacher_mutation_identity_v1(
        p_session_authority,
        p_account_id,
        p_session_generation,
        pg_catalog.btrim(p_organization_id),
        p_actor_user_id
    );
    if v_identity is null
       or v_identity ->> 'memberRole' not in ('owner', 'admin', 'teacher', 'assistant') then
        return pg_catalog.jsonb_build_object('status', 'unauthorized');
    end if;

    select student.* into v_profile
      from public.omr_student_profiles student
     where student.organization_id = pg_catalog.btrim(p_organization_id)
       and student.id = pg_catalog.btrim(p_student_id)
     for update;
    if not found or v_profile.status not in ('invited', 'active') then
        return pg_catalog.jsonb_build_object('status', 'student_unavailable');
    end if;

    insert into public.omr_student_credential_epochs (
        organization_id, student_profile_id, account_id,
        credential_generation, created_at, updated_at
    ) values (
        v_profile.organization_id,
        v_profile.id,
        'student_credential_' || pg_catalog.encode(extensions.gen_random_bytes(16), 'hex'),
        1,
        pg_catalog.clock_timestamp(),
        pg_catalog.clock_timestamp()
    )
    on conflict (organization_id, student_profile_id) do update
       set account_id = 'student_credential_' || pg_catalog.encode(extensions.gen_random_bytes(16), 'hex'),
           credential_generation = public.omr_student_credential_epochs.credential_generation + 1,
           updated_at = pg_catalog.clock_timestamp()
     where public.omr_student_credential_epochs.credential_generation < 2147483646
    returning account_id, credential_generation into v_account_id, v_generation;
    if v_account_id is null or v_generation is null then
        raise exception 'student credential generation exhausted';
    end if;

    update public.omr_student_profiles student
       set credential_generation = v_generation,
           updated_at = pg_catalog.clock_timestamp()
     where student.organization_id = v_profile.organization_id
       and student.id = v_profile.id;

    insert into public.omr_student_start_credentials (
        organization_id, student_profile_id, start_code_hash,
        account_id, credential_generation, updated_at
    ) values (
        v_profile.organization_id, v_profile.id, p_start_code_hash,
        v_account_id, v_generation, pg_catalog.clock_timestamp()
    )
    on conflict (organization_id, student_profile_id) do update
       set start_code_hash = excluded.start_code_hash,
           account_id = excluded.account_id,
           credential_generation = excluded.credential_generation,
           updated_at = excluded.updated_at;

    return pg_catalog.jsonb_build_object(
        'status', 'rotated',
        'studentId', v_profile.id,
        'credentialGeneration', v_generation
    );
end;
$$;

comment on function public.omr_rotate_student_start_credential_v1(text,text,bigint,text,text,text,text) is
    'Atomically rotates a student verifier and advances its non-reusable credential incarnation.';
alter function public.omr_rotate_student_start_credential_v1(text,text,bigint,text,text,text,text)
    owner to postgres;
revoke all on function public.omr_rotate_student_start_credential_v1(text,text,bigint,text,text,text,text)
    from public, anon, authenticated;
grant execute on function public.omr_rotate_student_start_credential_v1(text,text,bigint,text,text,text,text)
    to service_role;

create function public.omr_validate_student_session_v1(
    p_account_id text,
    p_organization_id text,
    p_student_id text,
    p_credential_generation integer
)
returns boolean
language sql
stable
security definer
set search_path = ''
set statement_timeout = '5s'
set lock_timeout = '2s'
as $$
    select p_account_id is not null
       and pg_catalog.length(p_account_id) between 1 and 256
       and p_organization_id is not null
       and pg_catalog.length(p_organization_id) between 1 and 256
       and p_student_id is not null
       and pg_catalog.length(p_student_id) between 1 and 256
       and p_credential_generation between 1 and 2147483646
       and exists (
           select 1
             from public.omr_student_profiles student
             join public.omr_student_credential_epochs epoch
               on epoch.organization_id = student.organization_id
              and epoch.student_profile_id = student.id
             join public.omr_student_start_credentials credential
               on credential.organization_id = student.organization_id
              and credential.student_profile_id = student.id
            where student.organization_id = p_organization_id
              and student.id = p_student_id
              and student.status in ('invited', 'active')
              and student.credential_generation = p_credential_generation
              and epoch.account_id = p_account_id
              and epoch.credential_generation = p_credential_generation
              and credential.account_id = p_account_id
              and credential.credential_generation = p_credential_generation
       )
$$;

comment on function public.omr_validate_student_session_v1(text,text,text,integer) is
    'Validates an exact login-eligible invited or active student credential incarnation at request start.';
alter function public.omr_validate_student_session_v1(text,text,text,integer) owner to postgres;
revoke all on function public.omr_validate_student_session_v1(text,text,text,integer)
    from public, anon, authenticated;
grant execute on function public.omr_validate_student_session_v1(text,text,text,integer)
    to service_role;

revoke insert, update, delete, truncate, references, trigger
    on table public.omr_student_start_credentials from service_role;
grant select on table public.omr_student_start_credentials to service_role;

commit;
