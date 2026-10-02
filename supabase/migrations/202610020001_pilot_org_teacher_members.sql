begin;

-- Operator-provisioned non-owner teachers inside an existing pilot academy.
--
-- The academy owner keeps sole plan-grant provenance (omr_pilot_plan_grants).
-- A teacher member never holds a grant of its own: its provenance is this
-- RPC-only ledger, and its effective plan is the owner's organization grant.
-- Every identity gateway that previously accepted only the provisioned owner
-- now accepts exactly one of two disjoint shapes:
--   owner   : role 'owner'   + grant provenance (unchanged behaviour)
--   teacher : role 'teacher' + member-ledger provenance + no grant at all,
--             inside an organization whose grants name exactly one owner.
create table public.omr_pilot_member_provisions (
    id text primary key,
    idempotency_key_hash text not null,
    request_hash text not null,
    organization_id text not null references public.omr_organizations(id) on delete cascade,
    account_id text not null references public.omr_teacher_accounts(id) on delete cascade,
    member_role text not null,
    created_at timestamptz not null default pg_catalog.statement_timestamp(),
    constraint omr_pilot_member_provisions_id_check check (id ~ '^pilot_member_[a-f0-9]{24}$'),
    constraint omr_pilot_member_provisions_idempotency_hash_check check (idempotency_key_hash ~ '^[a-f0-9]{64}$'),
    constraint omr_pilot_member_provisions_request_hash_check check (request_hash ~ '^[a-f0-9]{64}$'),
    constraint omr_pilot_member_provisions_idempotency_hash_unique unique (idempotency_key_hash),
    constraint omr_pilot_member_provisions_organization_check check (organization_id ~ '^pilot_org_[a-f0-9]{24}$'),
    constraint omr_pilot_member_provisions_role_check check (member_role = 'teacher')
);

create index omr_pilot_member_provisions_account_idx
    on public.omr_pilot_member_provisions (account_id, organization_id, created_at desc, id);
create index omr_pilot_member_provisions_organization_idx
    on public.omr_pilot_member_provisions (organization_id, created_at desc, id);

alter table public.omr_pilot_member_provisions enable row level security;
alter table public.omr_pilot_member_provisions force row level security;
revoke all on table public.omr_pilot_member_provisions
    from public, anon, authenticated, service_role;

create function public.omr_provision_pilot_org_teacher_v1(
    p_organization_id text,
    p_email text,
    p_display_name text,
    p_password_hash text,
    p_actor text,
    p_reason text,
    p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '10s'
set lock_timeout = '3s'
as $$
declare
    v_now timestamptz := pg_catalog.statement_timestamp();
    v_organization_id text := pg_catalog.lower(pg_catalog.btrim(p_organization_id));
    v_email text := pg_catalog.lower(pg_catalog.btrim(p_email));
    v_display_name text := pg_catalog.btrim(p_display_name);
    v_actor text := pg_catalog.btrim(p_actor);
    v_reason text := pg_catalog.btrim(p_reason);
    v_idempotency_key_hash text;
    v_request_hash text;
    v_existing public.omr_pilot_member_provisions%rowtype;
    v_account public.omr_teacher_accounts%rowtype;
    v_member public.omr_organization_members%rowtype;
    v_profile public.omr_teacher_profiles%rowtype;
    v_owner_count integer;
    v_owner_id text;
    v_membership_count integer;
    v_profile_count integer;
    v_account_id text;
    v_provision_id text;
    v_audit_id text;
    v_before_generation bigint := 0;
    v_after_generation bigint := 1;
begin
    if p_organization_id is null
       or v_organization_id !~ '^pilot_org_[a-f0-9]{24}$'
       or p_email is null
       or pg_catalog.char_length(v_email) not between 3 and 254
       or pg_catalog.octet_length(v_email) > 254
       or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
       or p_display_name is null
       or pg_catalog.char_length(v_display_name) not between 1 and 80
       or pg_catalog.octet_length(v_display_name) > 240
       or v_display_name ~ '[[:cntrl:]]'
       or p_password_hash is null
       or p_password_hash !~ '^pbkdf2-sha256:120000:[a-f0-9]{32}:[a-f0-9]{64}$'
       or p_actor is null
       or pg_catalog.char_length(v_actor) not between 10 and 73
       or pg_catalog.octet_length(v_actor) > 73
       or v_actor !~ '^operator:[a-z0-9][a-z0-9._-]{0,63}$'
       or p_reason is null
       or pg_catalog.char_length(v_reason) not between 1 and 64
       or pg_catalog.octet_length(v_reason) > 64
       or v_reason !~ '^[a-z][a-z0-9_]{0,63}$'
       or p_idempotency_key is null
       or pg_catalog.octet_length(p_idempotency_key) not between 37 and 128
       or p_idempotency_key !~ '^prov_[A-Za-z0-9_-]{32,123}$' then
        raise exception 'invalid_provisioning_request';
    end if;

    v_idempotency_key_hash := pg_catalog.encode(
        extensions.digest(p_idempotency_key, 'sha256'),
        'hex'
    );
    v_request_hash := pg_catalog.encode(
        extensions.digest(pg_catalog.jsonb_build_object(
            'kind', 'pilot_org_teacher',
            'organizationId', v_organization_id,
            'email', v_email,
            'displayName', v_display_name,
            'passwordHash', p_password_hash,
            'memberRole', 'teacher',
            'actor', v_actor,
            'reason', v_reason
        )::text, 'sha256'),
        'hex'
    );

    -- Same key lock domain as owner provisioning: a key is single-use across
    -- both ledgers, and exact replay resolves before any mutable write.
    perform pg_catalog.pg_advisory_xact_lock(20260808, pg_catalog.hashtext(v_idempotency_key_hash));
    if exists (
        select 1 from public.omr_pilot_plan_grants grant_row
         where grant_row.idempotency_key_hash = v_idempotency_key_hash
    ) then
        raise exception 'idempotency_conflict';
    end if;
    select provision.* into v_existing
      from public.omr_pilot_member_provisions provision
     where provision.idempotency_key_hash = v_idempotency_key_hash
     for update;
    if found then
        if v_existing.request_hash is distinct from v_request_hash then
            raise exception 'idempotency_conflict';
        end if;
        return pg_catalog.jsonb_build_object(
            'organizationId', v_existing.organization_id,
            'accountId', v_existing.account_id,
            'provisionId', v_existing.id,
            'memberRole', v_existing.member_role,
            'replayed', true
        );
    end if;

    -- Same lock order as owner provisioning: email, topology tables, account,
    -- then organization and its grant rows.
    perform pg_catalog.pg_advisory_xact_lock(20260808, pg_catalog.hashtext(v_email));
    lock table public.omr_organization_members in share row exclusive mode;
    lock table public.omr_teacher_profiles in share row exclusive mode;
    select account.* into v_account
      from public.omr_teacher_accounts account
     where account.email = v_email
     for update;
    v_now := pg_catalog.clock_timestamp();

    perform organization.id
      from public.omr_organizations organization
     where organization.id = v_organization_id
     for update;
    if not found then
        raise exception 'provisioning_conflict';
    end if;
    perform grant_row.id
      from public.omr_pilot_plan_grants grant_row
     where grant_row.organization_id = v_organization_id
     order by grant_row.id
     for update;
    select pg_catalog.count(distinct grant_row.account_id)::integer,
           pg_catalog.min(grant_row.account_id)
      into v_owner_count, v_owner_id
      from public.omr_pilot_plan_grants grant_row
     where grant_row.organization_id = v_organization_id;
    -- Members join only an academy whose provisioned owner is still intact.
    if v_owner_count <> 1
       or not exists (
           select 1
             from public.omr_organization_members owner_member
             join public.omr_teacher_accounts owner_account
               on owner_account.id = owner_member.user_id
            where owner_member.organization_id = v_organization_id
              and owner_member.user_id = v_owner_id
              and owner_member.role = 'owner'
              and owner_member.status = 'active'
              and owner_account.status = 'active'
       ) then
        raise exception 'provisioning_conflict';
    end if;

    if v_account.id is not null then
        -- Re-issuing an existing member rotates its password and revokes every
        -- outstanding session. Any other account shape is never adopted.
        if v_account.status is distinct from 'active'
           or v_account.display_name is distinct from v_display_name
           or v_account.session_generation >= 9007199254740991
           or exists (
               select 1 from public.omr_pilot_plan_grants grant_row
                where grant_row.account_id = v_account.id
           )
           or not exists (
               select 1 from public.omr_pilot_member_provisions provision
                where provision.account_id = v_account.id
                  and provision.organization_id = v_organization_id
           )
           or exists (
               select 1 from public.omr_pilot_member_provisions provision
                where provision.account_id = v_account.id
                  and provision.organization_id <> v_organization_id
           ) then
            raise exception 'provisioning_conflict';
        end if;
        v_account_id := v_account.id;
        v_before_generation := v_account.session_generation;
        v_after_generation := v_before_generation + 1;

        select pg_catalog.count(*)::integer into v_membership_count
          from public.omr_organization_members member
         where member.user_id = v_account_id;
        if v_membership_count <> 1 then
            raise exception 'provisioning_conflict';
        end if;
        select member.* into strict v_member
          from public.omr_organization_members member
         where member.user_id = v_account_id
         for update;
        if v_member.organization_id is distinct from v_organization_id
           or v_member.role is distinct from 'teacher'
           or v_member.status is distinct from 'active'
           or v_member.email is distinct from v_email
           or v_member.display_name is distinct from v_display_name then
            raise exception 'provisioning_conflict';
        end if;
        select pg_catalog.count(*)::integer into v_profile_count
          from public.omr_teacher_profiles profile
         where profile.user_id = v_account_id;
        if v_profile_count <> 1 then
            raise exception 'provisioning_conflict';
        end if;
        select profile.* into strict v_profile
          from public.omr_teacher_profiles profile
         where profile.user_id = v_account_id
         for update;
        if v_profile.organization_id is distinct from v_organization_id
           or v_profile.display_name is distinct from v_display_name
           or v_profile.status is distinct from 'active' then
            raise exception 'provisioning_conflict';
        end if;

        update public.omr_teacher_accounts account
           set password_hash = p_password_hash,
               session_generation = account.session_generation + 1,
               updated_at = v_now
         where account.id = v_account_id;
        update public.omr_teacher_account_tokens
           set consumed_at = v_now
         where account_id = v_account_id and consumed_at is null;
    else
        v_account_id := 'teacher_' || pg_catalog.encode(extensions.gen_random_bytes(8), 'hex');
        insert into public.omr_teacher_accounts (
            id, email, display_name, password_hash, status, email_verified_at,
            session_generation, created_at, updated_at
        ) values (
            v_account_id, v_email, v_display_name, p_password_hash, 'active', v_now,
            1, v_now, v_now
        );
        insert into public.omr_organization_members (
            organization_id, user_id, email, display_name, role, status,
            invited_by_user_id, created_at, updated_at
        ) values (
            v_organization_id, v_account_id, v_email, v_display_name, 'teacher', 'active',
            v_owner_id, v_now, v_now
        );
        insert into public.omr_teacher_profiles (
            organization_id, user_id, display_name, subjects, status,
            metadata, created_at, updated_at
        ) values (
            v_organization_id, v_account_id, v_display_name, '{}'::text[], 'active',
            '{}'::jsonb, v_now, v_now
        );
    end if;

    v_provision_id := 'pilot_member_' || pg_catalog.encode(extensions.gen_random_bytes(12), 'hex');
    insert into public.omr_pilot_member_provisions (
        id, idempotency_key_hash, request_hash, organization_id, account_id,
        member_role, created_at
    ) values (
        v_provision_id, v_idempotency_key_hash, v_request_hash, v_organization_id,
        v_account_id, 'teacher', v_now
    ) on conflict (idempotency_key_hash) do nothing;
    if not found then
        raise exception 'provisioning_serialization_failure';
    end if;

    v_audit_id := 'audit_pilot_' || pg_catalog.encode(extensions.gen_random_bytes(12), 'hex');
    insert into public.omr_audit_logs (
        id, organization_id, actor_user_id, action, entity_type, entity_id,
        metadata, created_at
    ) values (
        v_audit_id, v_organization_id, v_actor, 'operator.pilot_org_teacher_provisioned',
        'pilot_member_provision', v_provision_id,
        pg_catalog.jsonb_build_object(
            'reason', v_reason,
            'memberRole', 'teacher',
            'provisionId', v_provision_id,
            'beforeSessionGeneration', v_before_generation,
            'afterSessionGeneration', v_after_generation
        ),
        v_now
    );

    return pg_catalog.jsonb_build_object(
        'organizationId', v_organization_id,
        'accountId', v_account_id,
        'provisionId', v_provision_id,
        'memberRole', 'teacher',
        'replayed', false
    );
end;
$$;

-- Legacy self-service gateways exclude member-ledger provenance exactly as
-- they already exclude owner grant provenance.
create or replace function public.omr_lookup_teacher_account_v1(p_identifier text)
returns jsonb
language sql
stable
security definer
set search_path = ''
set statement_timeout = '5s'
set lock_timeout = '2s'
as $$
    select pg_catalog.jsonb_build_object(
        'id', account.id,
        'email', account.email,
        'display_name', account.display_name,
        'password_hash', account.password_hash,
        'status', account.status,
        'session_generation', account.session_generation
    )
     from public.omr_teacher_accounts account
     where account.status = 'active'
       and account.email = pg_catalog.lower(pg_catalog.btrim(p_identifier))
       and not exists (
           select 1
             from public.omr_pilot_plan_grants grant_row
            where grant_row.account_id = account.id
       )
       and not exists (
           select 1
             from public.omr_pilot_member_provisions provision
            where provision.account_id = account.id
       )
$$;

create or replace function public.omr_validate_teacher_session_v1(
    p_account_id text,
    p_session_generation bigint
)
returns boolean
language sql
stable
security definer
set search_path = ''
set statement_timeout = '5s'
set lock_timeout = '2s'
as $$
    select exists (
        select 1
          from public.omr_teacher_accounts account
         where account.id = p_account_id
           and account.status = 'active'
           and account.session_generation = p_session_generation
           and not exists (
               select 1
                 from public.omr_pilot_plan_grants grant_row
                where grant_row.account_id = account.id
           )
           and not exists (
               select 1
                 from public.omr_pilot_member_provisions provision
                where provision.account_id = account.id
           )
    )
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
set search_path = ''
set statement_timeout = '5s'
set lock_timeout = '2s'
as $$
declare
    v_account_id text;
begin
    if p_token_id is null
       or p_email is null
       or p_token_hash is null
       or p_expires_at is null
       or p_token_id !~ '^teacher_token_[a-z0-9]{24}$'
       or p_email <> pg_catalog.lower(pg_catalog.btrim(p_email))
       or p_token_hash !~ '^[a-f0-9]{64}$'
       or p_expires_at <= pg_catalog.clock_timestamp() then
        return false;
    end if;

    perform pg_catalog.pg_advisory_xact_lock(20260808, pg_catalog.hashtext(p_email));
    select account.id into v_account_id
      from public.omr_teacher_accounts account
     where account.email = p_email
       and account.status = 'active'
     for update;
    if v_account_id is null
       or p_expires_at <= pg_catalog.clock_timestamp()
       or exists (
           select 1
             from public.omr_pilot_plan_grants grant_row
            where grant_row.account_id = v_account_id
       )
       or exists (
           select 1
             from public.omr_pilot_member_provisions provision
            where provision.account_id = v_account_id
       ) then return false; end if;

    update public.omr_teacher_account_tokens
       set consumed_at = pg_catalog.clock_timestamp()
     where account_id = v_account_id
       and purpose = 'password_reset'
       and consumed_at is null;

    insert into public.omr_teacher_account_tokens (
        id, account_id, purpose, token_hash, expires_at, created_at
    ) values (
        p_token_id, v_account_id, 'password_reset', p_token_hash,
        p_expires_at, pg_catalog.clock_timestamp()
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
set search_path = ''
set statement_timeout = '5s'
set lock_timeout = '2s'
as $$
declare
    v_email text;
    v_token_id text;
    v_account_id text;
begin
    if p_token_hash is null
       or p_token_hash !~ '^[a-f0-9]{64}$'
       or p_password_hash is null
       or p_password_hash !~ '^pbkdf2-sha256:120000:[a-f0-9]{32}:[a-f0-9]{64}$' then
        return false;
    end if;

    select account.email into v_email
      from public.omr_teacher_account_tokens token_row
      join public.omr_teacher_accounts account on account.id = token_row.account_id
     where token_row.token_hash = p_token_hash
       and token_row.purpose = 'password_reset'
       and token_row.consumed_at is null
       and token_row.expires_at > pg_catalog.clock_timestamp();
    if v_email is null then return false; end if;

    perform pg_catalog.pg_advisory_xact_lock(20260808, pg_catalog.hashtext(v_email));
    select token_row.id, token_row.account_id into v_token_id, v_account_id
      from public.omr_teacher_account_tokens token_row
     where token_row.token_hash = p_token_hash
       and token_row.purpose = 'password_reset'
       and token_row.consumed_at is null
       and token_row.expires_at > pg_catalog.clock_timestamp()
     for update skip locked;
    if v_token_id is null then return false; end if;

    update public.omr_teacher_accounts account
       set password_hash = p_password_hash,
           session_generation = account.session_generation + 1,
           updated_at = pg_catalog.clock_timestamp()
     where account.id = v_account_id
       and account.status = 'active'
       and account.session_generation < 9007199254740991
       and not exists (
           select 1
             from public.omr_pilot_plan_grants grant_row
            where grant_row.account_id = account.id
       )
       and not exists (
           select 1
             from public.omr_pilot_member_provisions provision
            where provision.account_id = account.id
       );
    if not found then return false; end if;

    update public.omr_teacher_account_tokens
       set consumed_at = pg_catalog.clock_timestamp()
     where id = v_token_id and consumed_at is null;
    return found;
end;
$$;

create or replace function public.omr_lookup_provisioned_teacher_login_v1(
    p_identifier text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
set lock_timeout = '2s'
as $$
declare
    v_identifier text := pg_catalog.lower(pg_catalog.btrim(p_identifier));
    v_result jsonb;
begin
    if p_identifier is null
       or pg_catalog.octet_length(v_identifier) not between 3 and 254
       or v_identifier !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
        return null;
    end if;

    select pg_catalog.jsonb_build_object(
        'accountId', account.id,
        'email', account.email,
        'displayName', account.display_name,
        'passwordHash', account.password_hash,
        'sessionGeneration', account.session_generation,
        'organizationId', member.organization_id,
        'organizationName', organization.name,
        'memberRole', member.role,
        'plan', effective.value ->> 'plan',
        'grantExpiresAt', effective.value -> 'expiresAt'
    ) into v_result
      from public.omr_teacher_accounts account
      join (
          select member.*,
                 pg_catalog.count(*) over (partition by member.user_id) as total_membership_count
            from public.omr_organization_members member
      ) member on member.user_id = account.id
      join (
          select profile.*,
                 pg_catalog.count(*) over (partition by profile.user_id) as total_profile_count
            from public.omr_teacher_profiles profile
      ) profile
        on profile.user_id = account.id
       and profile.organization_id = member.organization_id
      join public.omr_organizations organization
        on organization.id = member.organization_id
      cross join lateral (
          select public.omr_read_effective_workspace_plan_v1(member.organization_id) as value
      ) effective
     where account.status = 'active'
       and account.email = v_identifier
       and member.status = 'active'
       and member.role in ('owner', 'teacher')
       and profile.status = 'active'
       and member.email = account.email
       and member.display_name = account.display_name
       and profile.display_name = account.display_name
       and member.total_membership_count = 1
       and profile.total_profile_count = 1
       and member.organization_id ~ '^pilot_org_[a-f0-9]{24}$'
       and (
           (
               member.role = 'owner'
               and exists (
                   select 1
                     from public.omr_pilot_plan_grants provenance_grant
                    where provenance_grant.account_id = account.id
                      and provenance_grant.organization_id = member.organization_id
               )
           )
           or (
               member.role = 'teacher'
               and exists (
                   select 1
                     from public.omr_pilot_member_provisions provision
                    where provision.account_id = account.id
                      and provision.organization_id = member.organization_id
               )
               and not exists (
                   select 1
                     from public.omr_pilot_member_provisions provision
                    where provision.account_id = account.id
                      and provision.organization_id <> member.organization_id
               )
               and not exists (
                   select 1
                     from public.omr_pilot_plan_grants own_grant
                    where own_grant.account_id = account.id
               )
               and (
                   select pg_catalog.count(distinct org_grant.account_id)
                     from public.omr_pilot_plan_grants org_grant
                    where org_grant.organization_id = member.organization_id
               ) = 1
           )
       )
       and (
           (
               effective.value ->> 'grantId' is null
               and effective.value ->> 'plan' = 'free'
               and effective.value -> 'expiresAt' = 'null'::jsonb
           )
           or exists (
               select 1
                 from public.omr_pilot_plan_grants effective_grant
                where effective_grant.id = effective.value ->> 'grantId'
                  and (
                      (member.role = 'owner' and effective_grant.account_id = account.id)
                      or (
                          member.role = 'teacher'
                          and exists (
                              select 1
                                from public.omr_organization_members owner_member
                               where owner_member.organization_id = member.organization_id
                                 and owner_member.user_id = effective_grant.account_id
                                 and owner_member.role = 'owner'
                                 and owner_member.status = 'active'
                          )
                      )
                  )
                  and effective_grant.organization_id = member.organization_id
                  and effective_grant.state = 'active'
                  and effective_grant.superseded_at is null
                  and effective_grant.expires_at > pg_catalog.clock_timestamp()
                  and effective_grant.plan = effective.value ->> 'plan'
                  and effective.value ->> 'expiresAt' = pg_catalog.to_char(
                      effective_grant.expires_at at time zone 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
                  )
           )
       );

    return v_result;
end;
$$;

create or replace function public.omr_validate_provisioned_teacher_session_v1(
    p_account_id text,
    p_session_generation bigint,
    p_organization_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
set lock_timeout = '2s'
as $$
declare
    v_result jsonb;
begin
    if p_account_id is null
       or p_account_id !~ '^teacher_[a-f0-9]{16}$'
       or p_session_generation is null
       or p_session_generation not between 1 and 9007199254740991
       or p_organization_id is null
       or p_organization_id !~ '^pilot_org_[a-f0-9]{24}$' then
        return null;
    end if;

    select pg_catalog.jsonb_build_object(
        'accountId', account.id,
        'sessionGeneration', account.session_generation,
        'organizationId', member.organization_id,
        'organizationName', organization.name,
        'memberRole', member.role,
        'plan', effective.value ->> 'plan',
        'grantExpiresAt', effective.value -> 'expiresAt'
    ) into v_result
      from public.omr_teacher_accounts account
      join (
          select member.*,
                 pg_catalog.count(*) over (partition by member.user_id) as total_membership_count
            from public.omr_organization_members member
      ) member on member.user_id = account.id
      join (
          select profile.*,
                 pg_catalog.count(*) over (partition by profile.user_id) as total_profile_count
            from public.omr_teacher_profiles profile
      ) profile
        on profile.user_id = account.id
       and profile.organization_id = member.organization_id
      join public.omr_organizations organization
        on organization.id = member.organization_id
      cross join lateral (
          select public.omr_read_effective_workspace_plan_v1(member.organization_id) as value
      ) effective
     where account.status = 'active'
       and account.id = p_account_id
       and account.session_generation = p_session_generation
       and member.organization_id = p_organization_id
       and member.status = 'active'
       and member.role in ('owner', 'teacher')
       and profile.status = 'active'
       and member.email = account.email
       and member.display_name = account.display_name
       and profile.display_name = account.display_name
       and member.total_membership_count = 1
       and profile.total_profile_count = 1
       and (
           (
               member.role = 'owner'
               and exists (
                   select 1
                     from public.omr_pilot_plan_grants provenance_grant
                    where provenance_grant.account_id = account.id
                      and provenance_grant.organization_id = member.organization_id
               )
           )
           or (
               member.role = 'teacher'
               and exists (
                   select 1
                     from public.omr_pilot_member_provisions provision
                    where provision.account_id = account.id
                      and provision.organization_id = member.organization_id
               )
               and not exists (
                   select 1
                     from public.omr_pilot_member_provisions provision
                    where provision.account_id = account.id
                      and provision.organization_id <> member.organization_id
               )
               and not exists (
                   select 1
                     from public.omr_pilot_plan_grants own_grant
                    where own_grant.account_id = account.id
               )
               and (
                   select pg_catalog.count(distinct org_grant.account_id)
                     from public.omr_pilot_plan_grants org_grant
                    where org_grant.organization_id = member.organization_id
               ) = 1
           )
       )
       and (
           (
               effective.value ->> 'grantId' is null
               and effective.value ->> 'plan' = 'free'
               and effective.value -> 'expiresAt' = 'null'::jsonb
           )
           or exists (
               select 1
                 from public.omr_pilot_plan_grants effective_grant
                where effective_grant.id = effective.value ->> 'grantId'
                  and (
                      (member.role = 'owner' and effective_grant.account_id = account.id)
                      or (
                          member.role = 'teacher'
                          and exists (
                              select 1
                                from public.omr_organization_members owner_member
                               where owner_member.organization_id = member.organization_id
                                 and owner_member.user_id = effective_grant.account_id
                                 and owner_member.role = 'owner'
                                 and owner_member.status = 'active'
                          )
                      )
                  )
                  and effective_grant.organization_id = member.organization_id
                  and effective_grant.state = 'active'
                  and effective_grant.superseded_at is null
                  and effective_grant.expires_at > pg_catalog.clock_timestamp()
                  and effective_grant.plan = effective.value ->> 'plan'
                  and effective.value ->> 'expiresAt' = pg_catalog.to_char(
                      effective_grant.expires_at at time zone 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
                  )
           )
       );

    return v_result;
end;
$$;

-- Locks and validates the complete provisioned identity graph. The owner
-- branch is unchanged; the teacher branch shares the same lock order.
create or replace function public.omr_lock_provisioned_teacher_identity_v1(
    p_account_id text,
    p_session_generation bigint,
    p_organization_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
set lock_timeout = '2s'
as $$
declare
    v_account public.omr_teacher_accounts%rowtype;
    v_member public.omr_organization_members%rowtype;
    v_profile public.omr_teacher_profiles%rowtype;
    v_organization public.omr_organizations%rowtype;
    v_membership_count integer;
    v_profile_count integer;
    v_provenance_count integer;
    v_owner_count integer;
begin
    if p_account_id is null
       or p_account_id !~ '^teacher_[a-f0-9]{16}$'
       or p_session_generation is null
       or p_session_generation not between 1 and 9007199254740991
       or p_organization_id is null
       or p_organization_id !~ '^pilot_org_[a-f0-9]{24}$' then
        return null;
    end if;

    -- Prevent a concurrent second membership/profile INSERT from appearing
    -- after the exact-total count. Table locks precede account row locks so
    -- every Phase C caller shares one deadlock-free order.
    lock table public.omr_organization_members in share mode;
    lock table public.omr_teacher_profiles in share mode;

    -- One stable row order is shared by every Phase C mutation: account, every
    -- membership row, every profile row, organization, then every grant row
    -- that could affect either the account or the organization.
    select account.* into v_account
      from public.omr_teacher_accounts account
     where account.id = p_account_id
     for update;
    if not found
       or v_account.status <> 'active'
       or v_account.session_generation <> p_session_generation then
        return null;
    end if;

    perform member.organization_id
      from public.omr_organization_members member
     where member.user_id = p_account_id
     order by member.organization_id
     for update;
    select pg_catalog.count(*)::integer into v_membership_count
      from public.omr_organization_members member
     where member.user_id = p_account_id;
    select member.* into v_member
      from public.omr_organization_members member
     where member.user_id = p_account_id
       and member.organization_id = p_organization_id;
    if v_membership_count <> 1
       or not found
       or v_member.status <> 'active'
       or v_member.role not in ('owner', 'teacher')
       or v_member.email is distinct from v_account.email
       or v_member.display_name is distinct from v_account.display_name then
        return null;
    end if;

    perform profile.organization_id
      from public.omr_teacher_profiles profile
     where profile.user_id = p_account_id
     order by profile.organization_id
     for update;
    select pg_catalog.count(*)::integer into v_profile_count
      from public.omr_teacher_profiles profile
     where profile.user_id = p_account_id;
    select profile.* into v_profile
      from public.omr_teacher_profiles profile
     where profile.user_id = p_account_id
       and profile.organization_id = p_organization_id;
    if v_profile_count <> 1
       or not found
       or v_profile.status <> 'active'
       or v_profile.display_name is distinct from v_account.display_name then
        return null;
    end if;

    select organization.* into v_organization
      from public.omr_organizations organization
     where organization.id = p_organization_id
     for update;
    if not found then
        return null;
    end if;

    perform grant_row.id
      from public.omr_pilot_plan_grants grant_row
     where grant_row.account_id = p_account_id
        or grant_row.organization_id = p_organization_id
     order by grant_row.id
     for update;

    if v_member.role = 'owner' then
        select pg_catalog.count(*)::integer into v_provenance_count
          from public.omr_pilot_plan_grants grant_row
         where grant_row.account_id = p_account_id
           and grant_row.organization_id = p_organization_id;
        if v_provenance_count < 1
           or exists (
               select 1
                 from public.omr_pilot_plan_grants grant_row
                where (grant_row.account_id = p_account_id
                       or grant_row.organization_id = p_organization_id)
                  and (grant_row.account_id is distinct from p_account_id
                       or grant_row.organization_id is distinct from p_organization_id)
           )
           or exists (
               select 1
                 from public.omr_pilot_member_provisions provision
                where provision.account_id = p_account_id
           ) then
            return null;
        end if;
    else
        -- A teacher member holds no grant; the organization's grants must
        -- name exactly one owner, and its ledger provenance must be this org.
        select pg_catalog.count(distinct grant_row.account_id)::integer into v_owner_count
          from public.omr_pilot_plan_grants grant_row
         where grant_row.organization_id = p_organization_id;
        if v_owner_count <> 1
           or exists (
               select 1
                 from public.omr_pilot_plan_grants grant_row
                where grant_row.account_id = p_account_id
           )
           or not exists (
               select 1
                 from public.omr_pilot_member_provisions provision
                where provision.account_id = p_account_id
                  and provision.organization_id = p_organization_id
           )
           or exists (
               select 1
                 from public.omr_pilot_member_provisions provision
                where provision.account_id = p_account_id
                  and provision.organization_id <> p_organization_id
           ) then
            return null;
        end if;
    end if;

    return pg_catalog.jsonb_build_object(
        'accountId', v_account.id,
        'sessionGeneration', v_account.session_generation,
        'organizationId', v_member.organization_id,
        'memberRole', v_member.role
    );
end;
$$;

-- Called only after identity was locked in this transaction. An owner's plan
-- binds to its own grant; a teacher member's plan binds to the sole owner's
-- organization grant. Expired or superseded provenance resolves free.
create or replace function public.omr_authorize_effective_teacher_plan_v1(
    p_account_id text,
    p_organization_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
set lock_timeout = '2s'
as $$
declare
    v_effective jsonb;
    v_grant public.omr_pilot_plan_grants%rowtype;
    v_role text;
    v_plan_account_id text;
    v_owner_count integer;
begin
    if p_account_id is null
       or p_account_id !~ '^teacher_[a-f0-9]{16}$'
       or p_organization_id is null
       or p_organization_id !~ '^pilot_org_[a-f0-9]{24}$'
       or not exists (
           select 1
             from public.omr_teacher_accounts account
            where account.id = p_account_id
              and account.status = 'active'
       ) then
        return null;
    end if;

    select member.role into v_role
      from public.omr_organization_members member
     where member.user_id = p_account_id
       and member.organization_id = p_organization_id
       and member.status = 'active'
       and member.role in ('owner', 'teacher');
    if not found then
        return null;
    end if;

    if v_role = 'owner' then
        if not exists (
               select 1
                 from public.omr_pilot_plan_grants provenance_grant
                where provenance_grant.account_id = p_account_id
                  and provenance_grant.organization_id = p_organization_id
           ) then
            return null;
        end if;
        v_plan_account_id := p_account_id;
    else
        select pg_catalog.count(distinct grant_row.account_id)::integer,
               pg_catalog.min(grant_row.account_id)
          into v_owner_count, v_plan_account_id
          from public.omr_pilot_plan_grants grant_row
         where grant_row.organization_id = p_organization_id;
        if v_owner_count <> 1
           or exists (
               select 1
                 from public.omr_pilot_plan_grants grant_row
                where grant_row.account_id = p_account_id
           )
           or not exists (
               select 1
                 from public.omr_pilot_member_provisions provision
                where provision.account_id = p_account_id
                  and provision.organization_id = p_organization_id
           )
           or not exists (
               select 1
                 from public.omr_organization_members owner_member
                where owner_member.user_id = v_plan_account_id
                  and owner_member.organization_id = p_organization_id
                  and owner_member.status = 'active'
                  and owner_member.role = 'owner'
           ) then
            return null;
        end if;
    end if;

    v_effective := public.omr_read_effective_workspace_plan_v1(p_organization_id);
    if v_effective ->> 'organizationId' is distinct from p_organization_id then
        return null;
    end if;
    if v_effective ->> 'grantId' is null then
        if v_effective ->> 'plan' = 'free'
           and v_effective -> 'expiresAt' = 'null'::jsonb then
            return v_effective;
        end if;
        return null;
    end if;

    select grant_row.* into v_grant
      from public.omr_pilot_plan_grants grant_row
     where grant_row.id = v_effective ->> 'grantId'
       and grant_row.account_id = v_plan_account_id
       and grant_row.organization_id = p_organization_id
       and grant_row.state = 'active'
       and grant_row.superseded_at is null
       and grant_row.expires_at > pg_catalog.clock_timestamp()
       and grant_row.plan = v_effective ->> 'plan'
     for update;
    if not found
       or v_effective ->> 'expiresAt' is distinct from pg_catalog.to_char(
           v_grant.expires_at at time zone 'UTC',
           'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
       ) then
        return null;
    end if;
    return v_effective;
end;
$$;

alter function public.omr_provision_pilot_org_teacher_v1(
    text,text,text,text,text,text,text
) owner to postgres;
revoke all on function public.omr_provision_pilot_org_teacher_v1(
    text,text,text,text,text,text,text
) from public, anon, authenticated;
grant execute on function public.omr_provision_pilot_org_teacher_v1(
    text,text,text,text,text,text,text
) to service_role;

comment on table public.omr_pilot_member_provisions is
    'RPC-only digest ledger for operator-provisioned pilot academy teacher members; contains no PII or credential material.';
comment on function public.omr_provision_pilot_org_teacher_v1(
    text,text,text,text,text,text,text
) is 'atomic-operator-pilot-org-teacher-provisioning:202610020001';

commit;
