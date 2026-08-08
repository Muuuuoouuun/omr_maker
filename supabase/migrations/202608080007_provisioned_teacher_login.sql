begin;

-- The legacy self-service lookup used RETURNS TABLE, which PostgREST exposes as
-- an array. Replace it in-place with one exact JSONB object so the gateway does
-- not need a permissive first-row normalization branch.
drop function public.omr_lookup_teacher_account_v1(text);
create function public.omr_lookup_teacher_account_v1(p_identifier text)
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
$$;
alter function public.omr_lookup_teacher_account_v1(text) owner to postgres;
revoke all on function public.omr_lookup_teacher_account_v1(text)
    from public, anon, authenticated;
grant execute on function public.omr_lookup_teacher_account_v1(text) to service_role;

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
       );
    if not found then return false; end if;

    update public.omr_teacher_account_tokens
       set consumed_at = pg_catalog.clock_timestamp()
     where id = v_token_id and consumed_at is null;
    return found;
end;
$$;

create function public.omr_lookup_provisioned_teacher_login_v1(
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
       and member.role = 'owner'
       and profile.status = 'active'
       and member.email = account.email
       and member.display_name = account.display_name
       and profile.display_name = account.display_name
       and member.total_membership_count = 1
       and profile.total_profile_count = 1
       and member.organization_id ~ '^pilot_org_[a-f0-9]{24}$'
       and exists (
           select 1
             from public.omr_pilot_plan_grants provenance_grant
            where provenance_grant.account_id = account.id
              and provenance_grant.organization_id = member.organization_id
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
                  and effective_grant.account_id = account.id
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

create function public.omr_validate_provisioned_teacher_session_v1(
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
       and member.role = 'owner'
       and profile.status = 'active'
       and member.email = account.email
       and member.display_name = account.display_name
       and profile.display_name = account.display_name
       and member.total_membership_count = 1
       and profile.total_profile_count = 1
       and exists (
           select 1
             from public.omr_pilot_plan_grants provenance_grant
            where provenance_grant.account_id = account.id
              and provenance_grant.organization_id = member.organization_id
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
                  and effective_grant.account_id = account.id
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

create function public.omr_probe_provisioned_teacher_canary_v1(
    p_account_id text
)
returns jsonb
language sql
stable
security definer
set search_path = ''
set statement_timeout = '5s'
set lock_timeout = '2s'
as $$
    select pg_catalog.jsonb_build_object(
        'ready',
        p_account_id is not null
        and p_account_id ~ '^teacher_[a-f0-9]{16}$'
        and exists (
            select 1
              from public.omr_teacher_accounts account
              join public.omr_organization_members member
                on member.user_id = account.id
              join public.omr_teacher_profiles profile
                on profile.user_id = account.id
               and profile.organization_id = member.organization_id
              join public.omr_organizations organization
                on organization.id = member.organization_id
              join public.omr_pilot_plan_grants grant_row
                on grant_row.account_id = account.id
               and grant_row.organization_id = member.organization_id
              cross join lateral (
                  select public.omr_read_effective_workspace_plan_v1(member.organization_id) as value
              ) effective
             where account.id = p_account_id
               and account.status = 'active'
               and member.status = 'active'
               and member.role = 'owner'
               and member.email = account.email
               and member.display_name = account.display_name
               and member.organization_id ~ '^pilot_org_[a-f0-9]{24}$'
               and profile.status = 'active'
               and profile.display_name = account.display_name
               and organization.plan = 'free'
               and grant_row.state = 'active'
               and grant_row.superseded_at is null
               and grant_row.expires_at > pg_catalog.clock_timestamp()
               and (select pg_catalog.count(*)
                      from public.omr_organization_members total_member
                     where total_member.user_id = account.id) = 1
               and (select pg_catalog.count(*)
                      from public.omr_teacher_profiles total_profile
                     where total_profile.user_id = account.id) = 1
               and (select pg_catalog.count(*)
                      from public.omr_pilot_plan_grants active_grant
                     where active_grant.account_id = account.id
                       and active_grant.state = 'active'
                       and active_grant.superseded_at is null) = 1
               and effective.value ->> 'organizationId' = member.organization_id
               and effective.value ->> 'plan' = grant_row.plan
               and effective.value ->> 'grantId' = grant_row.id
               and effective.value ->> 'expiresAt' = pg_catalog.to_char(
                   grant_row.expires_at at time zone 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
               )
               and (select pg_catalog.count(*)
                      from public.omr_audit_logs audit
                     where audit.organization_id = member.organization_id
                       and audit.action = 'operator.pilot_teacher_provisioned'
                       and audit.entity_type = 'pilot_plan_grant'
                       and audit.entity_id = grant_row.id
                       and audit.metadata ->> 'grantId' = grant_row.id
                       and audit.metadata ->> 'afterPlan' = grant_row.plan
                       and audit.metadata ->> 'afterSessionGeneration' = account.session_generation::text
                       and audit.metadata ->> 'expiresAt' = pg_catalog.to_char(
                           grant_row.expires_at at time zone 'UTC',
                           'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
                       )) = 1
        )
    )
$$;

alter function public.omr_validate_teacher_session_v1(text,bigint) owner to postgres;
alter function public.omr_begin_teacher_password_reset_v1(text,text,text,timestamptz) owner to postgres;
alter function public.omr_complete_teacher_password_reset_v1(text,text) owner to postgres;
alter function public.omr_lookup_provisioned_teacher_login_v1(text) owner to postgres;
alter function public.omr_validate_provisioned_teacher_session_v1(text,bigint,text) owner to postgres;
alter function public.omr_probe_provisioned_teacher_canary_v1(text) owner to postgres;

revoke all on function public.omr_validate_teacher_session_v1(text,bigint)
    from public, anon, authenticated;
revoke all on function public.omr_begin_teacher_password_reset_v1(text,text,text,timestamptz)
    from public, anon, authenticated;
revoke all on function public.omr_complete_teacher_password_reset_v1(text,text)
    from public, anon, authenticated;
revoke all on function public.omr_lookup_provisioned_teacher_login_v1(text)
    from public, anon, authenticated;
revoke all on function public.omr_validate_provisioned_teacher_session_v1(text,bigint,text)
    from public, anon, authenticated;
revoke all on function public.omr_probe_provisioned_teacher_canary_v1(text)
    from public, anon, authenticated;
grant execute on function public.omr_validate_teacher_session_v1(text,bigint) to service_role;
grant execute on function public.omr_begin_teacher_password_reset_v1(text,text,text,timestamptz) to service_role;
grant execute on function public.omr_complete_teacher_password_reset_v1(text,text) to service_role;
grant execute on function public.omr_lookup_provisioned_teacher_login_v1(text) to service_role;
grant execute on function public.omr_validate_provisioned_teacher_session_v1(text,bigint,text) to service_role;
grant execute on function public.omr_probe_provisioned_teacher_canary_v1(text) to service_role;

comment on function public.omr_lookup_provisioned_teacher_login_v1(text)
    is 'exact provisioned teacher login binding:202608080007';
comment on function public.omr_validate_provisioned_teacher_session_v1(text,bigint,text)
    is 'request-time provisioned teacher binding and entitlement validation:202608080007';
comment on function public.omr_lookup_teacher_account_v1(text)
    is 'exact legacy self-service teacher account lookup envelope:202608080007';
comment on function public.omr_validate_teacher_session_v1(text,bigint)
    is 'legacy self-service session validation excluding pilot provenance:202608080007';
comment on function public.omr_begin_teacher_password_reset_v1(text,text,text,timestamptz)
    is 'legacy self-service password-reset ingress excluding pilot provenance:202608080007';
comment on function public.omr_complete_teacher_password_reset_v1(text,text)
    is 'legacy self-service password-reset completion excluding pilot provenance:202608080007';
comment on function public.omr_probe_provisioned_teacher_canary_v1(text)
    is 'side-effect-free exact provisioned teacher release canary:202608080007';

commit;
