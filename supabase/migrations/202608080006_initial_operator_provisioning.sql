begin;

do $$
begin
    if pg_catalog.to_regprocedure('extensions.digest(text,text)') is null
       or pg_catalog.to_regprocedure('extensions.gen_random_bytes(integer)') is null then
        raise exception 'operator provisioning requires pgcrypto in extensions schema';
    end if;
end
$$;

-- Canonical, RPC-only ledger for operator-issued time-bounded pilot access.
-- It stores only irreversible request/idempotency digests and opaque IDs.
create table public.omr_pilot_plan_grants (
    id text primary key,
    idempotency_key_hash text not null,
    request_hash text not null,
    organization_id text not null references public.omr_organizations(id) on delete cascade,
    account_id text not null references public.omr_teacher_accounts(id) on delete cascade,
    plan text not null,
    expires_at timestamptz not null,
    state text not null default 'active',
    superseded_at timestamptz,
    created_at timestamptz not null default pg_catalog.statement_timestamp(),
    updated_at timestamptz not null default pg_catalog.statement_timestamp(),
    constraint omr_pilot_plan_grants_id_check check (id ~ '^pilot_grant_[a-f0-9]{24}$'),
    constraint omr_pilot_plan_grants_idempotency_hash_check check (idempotency_key_hash ~ '^[a-f0-9]{64}$'),
    constraint omr_pilot_plan_grants_request_hash_check check (request_hash ~ '^[a-f0-9]{64}$'),
    constraint omr_pilot_plan_grants_idempotency_hash_unique unique (idempotency_key_hash),
    constraint omr_pilot_plan_grants_plan_check check (plan in ('pro', 'academy')),
    constraint omr_pilot_plan_grants_state_check check (state in ('active', 'superseded')),
    constraint omr_pilot_plan_grants_expiry_check check (
        pg_catalog.isfinite(expires_at) and expires_at > created_at
    ),
    constraint omr_pilot_plan_grants_superseded_check check (
        (state = 'active' and superseded_at is null)
        or (
            state = 'superseded'
            and pg_catalog.isfinite(superseded_at)
            and superseded_at >= created_at
        )
    ),
    constraint omr_pilot_plan_grants_updated_check check (updated_at >= created_at)
);

create unique index omr_pilot_plan_grants_one_current_org_idx
    on public.omr_pilot_plan_grants (organization_id)
    where state = 'active' and superseded_at is null;
create index omr_pilot_plan_grants_effective_idx
    on public.omr_pilot_plan_grants (organization_id, expires_at desc, id)
    where state = 'active' and superseded_at is null;
create index omr_pilot_plan_grants_account_idx
    on public.omr_pilot_plan_grants (account_id, created_at desc, id);

alter table public.omr_pilot_plan_grants enable row level security;
alter table public.omr_pilot_plan_grants force row level security;
revoke all on table public.omr_pilot_plan_grants
    from public, anon, authenticated, service_role;

create function public.omr_read_effective_workspace_plan_v1(
    p_organization_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
declare
    v_grant public.omr_pilot_plan_grants%rowtype;
begin
    if p_organization_id is null
       or pg_catalog.octet_length(p_organization_id) not between 1 and 128
       or not exists (
           select 1 from public.omr_organizations organization
            where organization.id = p_organization_id
       ) then
        raise exception 'invalid_workspace';
    end if;

    select grant_row.* into v_grant
       from public.omr_pilot_plan_grants grant_row
     where grant_row.organization_id = p_organization_id
       and grant_row.state = 'active'
       and grant_row.superseded_at is null
       and grant_row.expires_at > pg_catalog.clock_timestamp()
     order by grant_row.expires_at desc, grant_row.id
     limit 1;

    if not found then
        return pg_catalog.jsonb_build_object(
            'organizationId', p_organization_id,
            'plan', 'free',
            'grantId', null,
            'expiresAt', null
        );
    end if;
    return pg_catalog.jsonb_build_object(
        'organizationId', v_grant.organization_id,
        'plan', v_grant.plan,
        'grantId', v_grant.id,
        'expiresAt', pg_catalog.to_char(
            v_grant.expires_at at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        )
    );
end;
$$;

create function public.omr_provision_pilot_teacher_v1(
    p_organization_name text,
    p_email text,
    p_display_name text,
    p_password_hash text,
    p_plan text,
    p_expires_at timestamptz,
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
    v_organization_name text := pg_catalog.btrim(p_organization_name);
    v_email text := pg_catalog.lower(pg_catalog.btrim(p_email));
    v_display_name text := pg_catalog.btrim(p_display_name);
    v_plan text := pg_catalog.lower(pg_catalog.btrim(p_plan));
    v_actor text := pg_catalog.btrim(p_actor);
    v_reason text := pg_catalog.btrim(p_reason);
    v_idempotency_key_hash text;
    v_request_hash text;
    v_request jsonb;
    v_existing_grant public.omr_pilot_plan_grants%rowtype;
    v_account public.omr_teacher_accounts%rowtype;
    v_organization public.omr_organizations%rowtype;
    v_member public.omr_organization_members%rowtype;
    v_profile public.omr_teacher_profiles%rowtype;
    v_membership_count integer;
    v_profile_count integer;
    v_organization_id text;
    v_account_id text;
    v_grant_id text;
    v_audit_id text;
    v_before_plan text := 'free';
    v_before_generation bigint := 0;
    v_after_generation bigint := 1;
begin
    if p_organization_name is null
       or pg_catalog.char_length(v_organization_name) not between 1 and 120
       or pg_catalog.octet_length(v_organization_name) > 360
       or v_organization_name ~ '[[:cntrl:]]'
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
       or p_plan is null
       or v_plan not in ('pro', 'academy')
       or p_expires_at is null
       or not pg_catalog.isfinite(p_expires_at)
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
    v_request := pg_catalog.jsonb_build_object(
        'organizationName', v_organization_name,
        'email', v_email,
        'displayName', v_display_name,
        'passwordHash', p_password_hash,
        'plan', v_plan,
        'expiresAtEpochMicros',
            (extract(epoch from p_expires_at) * 1000000)::bigint,
        'actor', v_actor,
        'reason', v_reason
    );
    v_request_hash := pg_catalog.encode(
        extensions.digest(v_request::text, 'sha256'),
        'hex'
    );

    -- Key first resolves exact replay/conflict before any mutable table write.
    perform pg_catalog.pg_advisory_xact_lock(20260808, pg_catalog.hashtext(v_idempotency_key_hash));
    select grant_row.* into v_existing_grant
      from public.omr_pilot_plan_grants grant_row
     where grant_row.idempotency_key_hash = v_idempotency_key_hash
     for update;
    if found then
        if v_existing_grant.request_hash is distinct from v_request_hash then
            raise exception 'idempotency_conflict';
        end if;
        return pg_catalog.jsonb_build_object(
            'organizationId', v_existing_grant.organization_id,
            'accountId', v_existing_grant.account_id,
            'grantId', v_existing_grant.id,
            'plan', v_existing_grant.plan,
            'expiresAt', pg_catalog.to_char(
                v_existing_grant.expires_at at time zone 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ),
            'replayed', true
        );
    end if;

    -- A stored receipt remains replayable after its grant expires. Temporal
    -- admission applies only to a new request, after replay/conflict resolution.
    v_now := pg_catalog.clock_timestamp();
    if p_expires_at <= v_now
       or p_expires_at > v_now + interval '366 days' then
        raise exception 'invalid_provisioning_request';
    end if;

    -- A second lock serializes distinct keys targeting the same missing email.
    perform pg_catalog.pg_advisory_xact_lock(20260808, pg_catalog.hashtext(v_email));
    lock table public.omr_organization_members in share row exclusive mode;
    lock table public.omr_teacher_profiles in share row exclusive mode;
    select account.* into v_account
      from public.omr_teacher_accounts account
     where account.email = v_email
     for update;

    -- The account lookup may have waited behind a distinct idempotency key.
    -- Refresh the write timestamp so supersession never predates the row it
    -- replaces, and refuse a grant that expired while waiting for locks.
    v_now := pg_catalog.clock_timestamp();
    if p_expires_at <= v_now then
        raise exception 'invalid_provisioning_request';
    end if;

    if found then
        if v_account.status is distinct from 'active'
           or v_account.display_name is distinct from v_display_name
           or v_account.session_generation >= 9007199254740991 then
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
        if v_member.role is distinct from 'owner'
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
        if v_profile.organization_id is distinct from v_member.organization_id
           or v_profile.display_name is distinct from v_display_name
           or v_profile.status is distinct from 'active' then
            raise exception 'provisioning_conflict';
        end if;
        select organization.* into strict v_organization
          from public.omr_organizations organization
         where organization.id = v_member.organization_id
         for update;
        if v_organization.name is distinct from v_organization_name then
            raise exception 'provisioning_conflict';
        end if;
        v_organization_id := v_organization.id;
        if v_organization.plan is distinct from 'free' then
            -- Pilot provisioning must never layer over a billing-managed plan.
            raise exception 'provisioning_conflict';
        end if;
        select grant_row.plan into v_before_plan
         from public.omr_pilot_plan_grants grant_row
         where grant_row.organization_id = v_organization_id
           and grant_row.state = 'active'
           and grant_row.superseded_at is null
           and grant_row.expires_at > v_now
         order by grant_row.expires_at desc, grant_row.id
         limit 1;
        v_before_plan := coalesce(v_before_plan, 'free');

        update public.omr_teacher_accounts account
           set password_hash = p_password_hash,
               session_generation = account.session_generation + 1,
               updated_at = v_now
         where account.id = v_account_id;
        update public.omr_teacher_account_tokens
           set consumed_at = v_now
         where account_id = v_account_id and consumed_at is null;
    else
        v_organization_id := 'pilot_org_' || pg_catalog.encode(extensions.gen_random_bytes(12), 'hex');
        v_account_id := 'teacher_' || pg_catalog.encode(extensions.gen_random_bytes(8), 'hex');
        insert into public.omr_organizations (
            id, name, plan, metadata, created_at, updated_at
        ) values (
            v_organization_id, v_organization_name, 'free', '{}'::jsonb, v_now, v_now
        );
        insert into public.omr_teacher_accounts (
            id, email, display_name, password_hash, status, email_verified_at,
            session_generation, created_at, updated_at
        ) values (
            v_account_id, v_email, v_display_name, p_password_hash, 'active', v_now,
            1, v_now, v_now
        );
        insert into public.omr_organization_members (
            organization_id, user_id, email, display_name, role, status,
            created_at, updated_at
        ) values (
            v_organization_id, v_account_id, v_email, v_display_name, 'owner', 'active',
            v_now, v_now
        );
        insert into public.omr_teacher_profiles (
            organization_id, user_id, display_name, subjects, status,
            metadata, created_at, updated_at
        ) values (
            v_organization_id, v_account_id, v_display_name, '{}'::text[], 'active',
            '{}'::jsonb, v_now, v_now
        );
    end if;

    update public.omr_pilot_plan_grants
       set state = 'superseded', superseded_at = v_now, updated_at = v_now
     where organization_id = v_organization_id
       and state = 'active' and superseded_at is null;

    v_grant_id := 'pilot_grant_' || pg_catalog.encode(extensions.gen_random_bytes(12), 'hex');
    insert into public.omr_pilot_plan_grants (
        id, idempotency_key_hash, request_hash, organization_id, account_id,
        plan, expires_at, created_at, updated_at
    ) values (
        v_grant_id, v_idempotency_key_hash, v_request_hash, v_organization_id,
        v_account_id, v_plan, p_expires_at, v_now, v_now
    ) on conflict (idempotency_key_hash) do nothing;
    if not found then
        raise exception 'provisioning_serialization_failure';
    end if;

    -- Fail closed until Task3 wires every login/paid gateway through
    -- omr_read_effective_workspace_plan_v1. The denormalized legacy plan must
    -- remain free, so an omitted entitlement read cannot bypass pilot expiry.
    update public.omr_organizations
       set plan = 'free', updated_at = v_now
     where id = v_organization_id and plan = 'free';
    if not found then
        raise exception 'provisioning_conflict';
    end if;

    v_audit_id := 'audit_pilot_' || pg_catalog.encode(extensions.gen_random_bytes(12), 'hex');
    insert into public.omr_audit_logs (
        id, organization_id, actor_user_id, action, entity_type, entity_id,
        metadata, created_at
    ) values (
        v_audit_id, v_organization_id, v_actor, 'operator.pilot_teacher_provisioned',
        'pilot_plan_grant', v_grant_id,
        pg_catalog.jsonb_build_object(
            'reason', v_reason,
            'beforePlan', v_before_plan,
            'afterPlan', v_plan,
            'expiresAt', pg_catalog.to_char(
                p_expires_at at time zone 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ),
            'grantId', v_grant_id,
            'beforeSessionGeneration', v_before_generation,
            'afterSessionGeneration', v_after_generation
        ),
        v_now
    );

    return pg_catalog.jsonb_build_object(
        'organizationId', v_organization_id,
        'accountId', v_account_id,
        'grantId', v_grant_id,
        'plan', v_plan,
        'expiresAt', pg_catalog.to_char(
            p_expires_at at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        ),
        'replayed', false
    );
end;
$$;

alter function public.omr_provision_pilot_teacher_v1(
    text,text,text,text,text,timestamptz,text,text,text
) owner to postgres;
alter function public.omr_read_effective_workspace_plan_v1(text) owner to postgres;

revoke all on function public.omr_provision_pilot_teacher_v1(
    text,text,text,text,text,timestamptz,text,text,text
) from public, anon, authenticated;
revoke all on function public.omr_read_effective_workspace_plan_v1(text)
    from public, anon, authenticated;
grant execute on function public.omr_provision_pilot_teacher_v1(
    text,text,text,text,text,timestamptz,text,text,text
) to service_role;
grant execute on function public.omr_read_effective_workspace_plan_v1(text) to service_role;

comment on table public.omr_pilot_plan_grants is
    'RPC-only digest ledger for time-bounded pilot plan grants; contains no teacher PII or credential material.';
comment on function public.omr_provision_pilot_teacher_v1(
    text,text,text,text,text,timestamptz,text,text,text
) is 'atomic-operator-pilot-teacher-provisioning:202608080006';
comment on function public.omr_read_effective_workspace_plan_v1(text)
    is 'expiry-safe-effective-workspace-plan-read:202608080006; mandatory for provisioned login and paid-plan gateways from Task3';

commit;
