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
$$;
alter function public.omr_lookup_teacher_account_v1(text) owner to postgres;
revoke all on function public.omr_lookup_teacher_account_v1(text)
    from public, anon, authenticated;
grant execute on function public.omr_lookup_teacher_account_v1(text) to service_role;

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
                 pg_catalog.count(*) over (partition by member.user_id) as active_membership_count
            from public.omr_organization_members member
           where member.status = 'active'
      ) member on member.user_id = account.id
      join (
          select profile.*,
                 pg_catalog.count(*) over (partition by profile.user_id) as active_profile_count
            from public.omr_teacher_profiles profile
           where profile.status = 'active'
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
       and member.active_membership_count = 1
       and profile.active_profile_count = 1
       and member.organization_id ~ '^pilot_org_[a-f0-9]{24}$';

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
                 pg_catalog.count(*) over (partition by member.user_id) as active_membership_count
            from public.omr_organization_members member
           where member.status = 'active'
      ) member on member.user_id = account.id
      join (
          select profile.*,
                 pg_catalog.count(*) over (partition by profile.user_id) as active_profile_count
            from public.omr_teacher_profiles profile
           where profile.status = 'active'
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
       and member.active_membership_count = 1
       and profile.active_profile_count = 1;

    return v_result;
end;
$$;

alter function public.omr_lookup_provisioned_teacher_login_v1(text) owner to postgres;
alter function public.omr_validate_provisioned_teacher_session_v1(text,bigint,text) owner to postgres;

revoke all on function public.omr_lookup_provisioned_teacher_login_v1(text)
    from public, anon, authenticated;
revoke all on function public.omr_validate_provisioned_teacher_session_v1(text,bigint,text)
    from public, anon, authenticated;
grant execute on function public.omr_lookup_provisioned_teacher_login_v1(text) to service_role;
grant execute on function public.omr_validate_provisioned_teacher_session_v1(text,bigint,text) to service_role;

comment on function public.omr_lookup_provisioned_teacher_login_v1(text)
    is 'exact provisioned teacher login binding:202608080007';
comment on function public.omr_validate_provisioned_teacher_session_v1(text,bigint,text)
    is 'request-time provisioned teacher binding and entitlement validation:202608080007';
comment on function public.omr_lookup_teacher_account_v1(text)
    is 'exact legacy self-service teacher account lookup envelope:202608080007';

commit;
