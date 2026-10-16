-- Explicit permanent QA demo organizations. No promotion of existing organizations,
-- no paid billing change, and no session/upload TTL extension.
begin;
create table public.omr_demo_organizations (
    id text primary key references public.omr_organizations(id) on delete restrict,
    owner_account_id text not null unique references public.omr_teacher_accounts(id) on delete restrict,
    plan text not null check (plan in ('free','pro','academy')),
    entitlement_mode text not null check (entitlement_mode = 'permanent_demo'),
    state text not null default 'active' check (state in ('active','revoked')),
    created_at timestamptz not null default clock_timestamp(),
    revoked_at timestamptz,
    check (id ~ '^demo_org_[a-f0-9]{24}$'),
    check ((state='active' and revoked_at is null) or (state='revoked' and revoked_at is not null))
);
create table public.omr_demo_provisions (
    idempotency_key_hash text primary key check (idempotency_key_hash ~ '^[a-f0-9]{64}$'),
    request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
    organization_id text not null references public.omr_demo_organizations(id) on delete restrict,
    account_id text not null unique references public.omr_teacher_accounts(id) on delete restrict,
    member_role text not null check (member_role in ('owner','teacher')),
    created_at timestamptz not null default clock_timestamp()
);
alter table public.omr_demo_organizations enable row level security;
alter table public.omr_demo_organizations force row level security;
alter table public.omr_demo_provisions enable row level security;
alter table public.omr_demo_provisions force row level security;
revoke all on table public.omr_demo_organizations, public.omr_demo_provisions from public, anon, authenticated, service_role;

-- Lock the entire demo identity graph in deterministic account order before the
-- organization/registry. SHARE topology locks also exclude membership insert drift.
create function public.omr_lock_demo_identity_v1(p_account_id text,p_generation bigint,p_org text)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='5s' set lock_timeout='2s'
as $$
declare a public.omr_teacher_accounts%rowtype; d public.omr_demo_organizations%rowtype;
    member public.omr_organization_members%rowtype; org_name text;
begin
    if p_org is null or p_org !~ '^demo_org_[a-f0-9]{24}$' or p_account_id is null
       or p_account_id !~ '^teacher_[a-f0-9]{16}$' or p_generation is null or p_generation < 1 then return null; end if;
    lock table public.omr_organization_members in share mode;
    lock table public.omr_teacher_profiles in share mode;
    perform account.id from public.omr_teacher_accounts account
      where account.id in (select x.user_id from public.omr_organization_members x where x.organization_id=p_org)
      order by account.id for update;
    select * into a from public.omr_teacher_accounts where id=p_account_id;
    if not found or a.status <> 'active' or a.session_generation <> p_generation then return null; end if;
    select name into org_name from public.omr_organizations where id=p_org and plan='free' for update;
    if not found then return null; end if;
    select * into d from public.omr_demo_organizations where id=p_org for update;
    if not found or d.state <> 'active' or d.entitlement_mode <> 'permanent_demo' then return null; end if;
    if (select count(*) from public.omr_organization_members where user_id=p_account_id) <> 1
       or (select count(*) from public.omr_teacher_profiles where user_id=p_account_id) <> 1 then return null; end if;
    select * into member from public.omr_organization_members where user_id=p_account_id and organization_id=p_org;
    if not found or member.status <> 'active' or member.role not in ('owner','teacher')
       or member.email is distinct from a.email or member.display_name is distinct from a.display_name
       or not exists (select 1 from public.omr_teacher_profiles p where p.user_id=a.id and p.organization_id=p_org
         and p.status='active' and p.display_name=a.display_name)
       or not exists (select 1 from public.omr_demo_provisions p where p.account_id=a.id and p.organization_id=p_org and p.member_role=member.role)
       or exists (select 1 from public.omr_pilot_plan_grants p where p.account_id=a.id or p.organization_id=p_org)
       or exists (select 1 from public.omr_pilot_member_provisions p where p.account_id=a.id) then return null; end if;
    if (member.role='owner') is distinct from (a.id=d.owner_account_id) then return null; end if;
    -- A member cannot inherit an entitlement from a broken/suspended owner graph.
    if (select count(*) from public.omr_organization_members where user_id=d.owner_account_id) <> 1
       or (select count(*) from public.omr_teacher_profiles where user_id=d.owner_account_id) <> 1
       or not exists (select 1 from public.omr_teacher_accounts o
         join public.omr_organization_members x on x.user_id=o.id and x.organization_id=p_org
         join public.omr_teacher_profiles p on p.user_id=o.id and p.organization_id=p_org
         join public.omr_demo_provisions v on v.account_id=o.id and v.organization_id=p_org and v.member_role='owner'
         where o.id=d.owner_account_id and o.status='active' and x.role='owner' and x.status='active'
           and p.status='active' and x.email=o.email and x.display_name=o.display_name and p.display_name=o.display_name)
       or (select count(*) from public.omr_organization_members where organization_id=p_org and role='owner') <> 1 then return null; end if;
    return jsonb_build_object('accountId',a.id,'sessionGeneration',a.session_generation,
      'organizationId',p_org,'organizationName',org_name,'memberRole',member.role,
      'plan',d.plan,'grantExpiresAt',null,'entitlementMode','permanent_demo');
end $$;

create function public.omr_read_demo_plan_v1(p_org text)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='5s' set lock_timeout='2s'
as $$
declare owner_id text; gen bigint; identity jsonb;
begin
    select d.owner_account_id,a.session_generation into owner_id,gen from public.omr_demo_organizations d
      join public.omr_teacher_accounts a on a.id=d.owner_account_id where d.id=p_org;
    identity := public.omr_lock_demo_identity_v1(owner_id,gen,p_org);
    if identity is null then return null; end if;
    return jsonb_build_object('organizationId',p_org,'plan',identity->>'plan','grantId',null,
      'expiresAt',null,'entitlementMode','permanent_demo');
end $$;

-- New owner requests create a new demo namespace. Member requests name an already
-- active demo registry entry. Neither path rotates or overwrites existing accounts.
create function public.omr_provision_demo_account_v1(p_org_name text,p_org_id text,p_email text,p_display text,
    p_verifier text,p_plan text,p_role text,p_mode text,p_actor text,p_reason text,p_key text)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='10s' set lock_timeout='3s'
as $$
declare v_email text:=lower(btrim(p_email)); v_display text:=btrim(p_display); v_org_id text;
    v_account_id text; v_key_hash text; v_request_hash text; v_prior public.omr_demo_provisions%rowtype; result jsonb;
begin
    if p_mode is distinct from 'permanent_demo' or p_reason is distinct from 'qa_permanent_demo'
      or p_role is null or p_role not in ('owner','teacher') or p_actor is null
      or p_actor !~ '^operator:[a-z0-9][a-z0-9._-]{0,63}$'
      or p_email is null or length(v_email) not between 3 and 254 or octet_length(v_email)>254
      or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
      or p_display is null or length(v_display) not between 1 and 80 or octet_length(v_display)>240 or v_display ~ '[[:cntrl:]]'
      or p_verifier is null or p_verifier !~ '^pbkdf2-sha256:120000:[a-f0-9]{32}:[a-f0-9]{64}$'
      or p_key is null or p_key !~ '^prov_[A-Za-z0-9_-]{32,123}$' then raise exception 'invalid_provisioning_request'; end if;
    if p_role='owner' then
      if p_org_id is not null or p_org_name is null or length(btrim(p_org_name)) not between 1 and 120
        or octet_length(btrim(p_org_name))>360 or p_org_name ~ '[[:cntrl:]]'
        or p_plan is null or p_plan not in ('free','pro','academy') then raise exception 'invalid_provisioning_request'; end if;
    elsif p_org_name is not null or p_plan is not null or p_org_id is null or p_org_id !~ '^demo_org_[a-f0-9]{24}$' then
      raise exception 'invalid_provisioning_request';
    end if;
    v_key_hash := encode(extensions.digest(p_key,'sha256'),'hex');
    v_request_hash := encode(extensions.digest(jsonb_build_object('orgName',btrim(p_org_name),'orgId',p_org_id,
      'email',v_email,'display',v_display,'verifier',p_verifier,'plan',p_plan,'role',p_role,'mode',p_mode,
      'actor',p_actor,'reason',p_reason)::text,'sha256'),'hex');
    perform pg_advisory_xact_lock(20261003,hashtext(v_key_hash));
    select * into v_prior from public.omr_demo_provisions where idempotency_key_hash=v_key_hash for update;
    if found then
      if v_prior.request_hash is distinct from v_request_hash then raise exception 'idempotency_conflict'; end if;
      return jsonb_build_object('organizationId',v_prior.organization_id,'accountId',v_prior.account_id,
        'memberRole',v_prior.member_role,'plan',(select plan from public.omr_demo_organizations where id=v_prior.organization_id),
        'entitlementMode','permanent_demo','replayed',true);
    end if;
    perform pg_advisory_xact_lock(20260808,hashtext(v_email));
    lock table public.omr_organization_members in share row exclusive mode;
    lock table public.omr_teacher_profiles in share row exclusive mode;
    if exists (select 1 from public.omr_teacher_accounts where omr_teacher_accounts.email=v_email) then
      raise exception 'provisioning_conflict'; end if;
    if p_role='teacher' and public.omr_read_demo_plan_v1(p_org_id) is null then raise exception 'provisioning_conflict'; end if;
    v_account_id := 'teacher_'||encode(extensions.gen_random_bytes(8),'hex');
    if p_role='owner' then
      perform pg_advisory_xact_lock(20261003,hashtext(btrim(p_org_name)));
      if exists (select 1 from public.omr_organizations where name=btrim(p_org_name)) then raise exception 'provisioning_conflict'; end if;
      v_org_id := 'demo_org_'||encode(extensions.gen_random_bytes(12),'hex');
      insert into public.omr_organizations(id,name,plan,metadata) values(v_org_id,btrim(p_org_name),'free','{}'::jsonb);
    else v_org_id := p_org_id; end if;
    insert into public.omr_teacher_accounts(id,email,display_name,password_hash,status,email_verified_at,session_generation)
      values(v_account_id,v_email,v_display,p_verifier,'active',clock_timestamp(),1);
    if p_role='owner' then
      insert into public.omr_demo_organizations(id,owner_account_id,plan,entitlement_mode)
        values(v_org_id,v_account_id,p_plan,'permanent_demo');
    end if;
    insert into public.omr_organization_members(organization_id,user_id,email,display_name,role,status)
      values(v_org_id,v_account_id,v_email,v_display,p_role,'active');
    insert into public.omr_teacher_profiles(organization_id,user_id,display_name,subjects,status)
      values(v_org_id,v_account_id,v_display,'{}'::text[],'active');
    insert into public.omr_demo_provisions(idempotency_key_hash,request_hash,organization_id,account_id,member_role)
      values(v_key_hash,v_request_hash,v_org_id,v_account_id,p_role);
    insert into public.omr_audit_logs(id,organization_id,actor_user_id,action,entity_type,entity_id,metadata)
      values('audit_'||encode(extensions.gen_random_bytes(12),'hex'),v_org_id,p_actor,'operator.demo_account_provisioned',
        'demo_account',v_account_id,jsonb_build_object('memberRole',p_role,'plan',(select plan from public.omr_demo_organizations where id=v_org_id),
        'entitlementMode','permanent_demo','reason',p_reason));
    return jsonb_build_object('organizationId',v_org_id,'accountId',v_account_id,'memberRole',p_role,
      'plan',(select plan from public.omr_demo_organizations where id=v_org_id),'entitlementMode','permanent_demo','replayed',false);
end $$;

create function public.omr_revoke_demo_organization_v1(p_org text,p_mode text,p_actor text,p_reason text)
returns boolean language plpgsql security definer set search_path='' set statement_timeout='5s' set lock_timeout='2s'
as $$
begin
    if p_org is null or p_org !~ '^demo_org_[a-f0-9]{24}$' or p_mode is distinct from 'permanent_demo'
       or p_actor is null or p_actor !~ '^operator:[a-z0-9][a-z0-9._-]{0,63}$'
       or p_reason is null or p_reason !~ '^[a-z][a-z0-9_]{0,63}$' then raise exception 'invalid_provisioning_request'; end if;
    perform id from public.omr_organizations where id=p_org for update;
    update public.omr_demo_organizations set state='revoked',revoked_at=clock_timestamp() where id=p_org and state='active';
    if not found then return false; end if;
    insert into public.omr_audit_logs(id,organization_id,actor_user_id,action,entity_type,entity_id,metadata)
      values('audit_'||encode(extensions.gen_random_bytes(12),'hex'),p_org,p_actor,'operator.demo_organization_revoked',
        'demo_organization',p_org,jsonb_build_object('reason',p_reason,'entitlementMode','permanent_demo'));
    return true;
end $$;


create or replace function public.omr_read_effective_workspace_plan_v1(
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
    if p_organization_id ~ '^demo_org_[a-f0-9]{24}$' then return public.omr_read_demo_plan_v1(p_organization_id); end if;
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

    if not found or v_grant.plan = 'free' then
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
    demo_a public.omr_teacher_accounts%rowtype; demo_org text;
begin
    select a.* into demo_a from public.omr_teacher_accounts a
      where a.email=lower(btrim(p_identifier)) and exists(select 1 from public.omr_demo_provisions d where d.account_id=a.id);
    if found then
      select organization_id into demo_org from public.omr_demo_provisions where account_id=demo_a.id;
      v_result := public.omr_lock_demo_identity_v1(demo_a.id,demo_a.session_generation,demo_org);
      if v_result is null then return null; end if;
      return v_result || jsonb_build_object('email',demo_a.email,'displayName',demo_a.display_name,'passwordHash',demo_a.password_hash);
    end if;
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
    if p_organization_id ~ '^demo_org_[a-f0-9]{24}$' then return public.omr_lock_demo_identity_v1(p_account_id,p_session_generation,p_organization_id); end if;
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
    if p_organization_id ~ '^demo_org_[a-f0-9]{24}$' then return public.omr_lock_demo_identity_v1(p_account_id,p_session_generation,p_organization_id); end if;
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
    if p_organization_id ~ '^demo_org_[a-f0-9]{24}$' then
      if public.omr_lock_demo_identity_v1(p_account_id,(select session_generation from public.omr_teacher_accounts where id=p_account_id),p_organization_id) is null then return null; end if;
      return public.omr_read_demo_plan_v1(p_organization_id);
    end if;
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

create or replace function public.omr_read_effective_organization_plan_v1(
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
    v_account_id text;
    v_session_generation bigint;
    v_candidate_count integer;
    v_identity jsonb;
    v_legacy_plan text;
begin
    if p_organization_id ~ '^demo_org_[a-f0-9]{24}$' then return public.omr_read_demo_plan_v1(p_organization_id) || jsonb_build_object('source','demo'); end if;
    if p_organization_id is null then
        return null;
    end if;
    if p_organization_id ~ '^(default|teacher_[a-z0-9]{7,16})$' then
        if exists (
            select 1 from public.omr_pilot_plan_grants grant_row
             where grant_row.organization_id = p_organization_id
        ) then
            return null;
        end if;
        select organization.plan into v_legacy_plan
          from public.omr_organizations organization
         where organization.id = p_organization_id
         for update;
        if not found or v_legacy_plan not in ('free', 'pro', 'academy') then
            return null;
        end if;
        return pg_catalog.jsonb_build_object(
            'organizationId', p_organization_id,
            'plan', v_legacy_plan,
            'grantId', null,
            'expiresAt', null,
            'source', 'legacy'
        );
    end if;
    if p_organization_id !~ '^pilot_org_[a-f0-9]{24}$' then
        return null;
    end if;

    select pg_catalog.count(distinct grant_row.account_id)::integer,
           pg_catalog.min(grant_row.account_id)
      into v_candidate_count, v_account_id
      from public.omr_pilot_plan_grants grant_row
     where grant_row.organization_id = p_organization_id;
    if v_candidate_count <> 1 then
        return null;
    end if;
    select account.session_generation into v_session_generation
      from public.omr_teacher_accounts account
     where account.id = v_account_id;
    if not found then
        return null;
    end if;

    v_identity := public.omr_lock_provisioned_teacher_identity_v1(
        v_account_id,
        v_session_generation,
        p_organization_id
    );
    if v_identity is null then
        return null;
    end if;
    -- The identity helper has now locked the organization and every grant row
    -- that can affect it. Recompute the candidate set under those locks so a
    -- concurrent historical/expired grant for another account cannot turn the
    -- pre-lock candidate into an ambiguous organization unnoticed.
    select pg_catalog.count(distinct grant_row.account_id)::integer,
           pg_catalog.min(grant_row.account_id)
      into v_candidate_count, v_account_id
      from public.omr_pilot_plan_grants grant_row
     where grant_row.organization_id = p_organization_id;
    if v_candidate_count <> 1
       or v_identity ->> 'accountId' is distinct from v_account_id then
        return null;
    end if;
    return public.omr_authorize_effective_teacher_plan_v1(
        v_account_id,
        p_organization_id
    ) || pg_catalog.jsonb_build_object('source', 'pilot');
end;
$$;

create or replace function public.omr_read_teacher_mutation_plan_v1(
    p_session_authority text,
    p_account_id text,
    p_organization_id text,
    p_actor_user_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
set lock_timeout = '2s'
as $$
begin
    if p_session_authority='account' and p_organization_id ~ '^demo_org_[a-f0-9]{24}$' then
      if p_actor_user_id is distinct from p_account_id then return null; end if;
      return public.omr_authorize_effective_teacher_plan_v1(p_account_id,p_organization_id) || jsonb_build_object('source','demo');
    end if;
    if p_session_authority = 'account' then
        if p_actor_user_id is distinct from p_account_id then
            return null;
        end if;
        return public.omr_authorize_effective_teacher_plan_v1(
            p_account_id, p_organization_id
        ) || pg_catalog.jsonb_build_object('source', 'pilot');
    end if;
    if p_session_authority = 'legacy_account' then
        return public.omr_read_legacy_teacher_plan_v1(
            p_account_id, p_organization_id, p_actor_user_id
        ) || pg_catalog.jsonb_build_object('source', 'legacy');
    end if;
    return null;
end;
$$;

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
     where not exists(select 1 from public.omr_demo_provisions d where d.account_id=account.id) and account.status = 'active'
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
         where not exists(select 1 from public.omr_demo_provisions d where d.account_id=account.id) and account.id = p_account_id
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
    if exists(select 1 from public.omr_demo_provisions d where d.account_id=v_account_id) or v_account_id is null
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
    if v_email is null or exists(select 1 from public.omr_demo_provisions d join public.omr_teacher_accounts a on a.id=d.account_id where a.email=v_email) then return false; end if;

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

create or replace function public.omr_set_effective_plan_transaction_proof_v1(
    p_organization_id text,
    p_effective jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
set lock_timeout = '2s'
as $$
declare
    v_plan text;
    v_expires_at text;
    v_source text;
begin
    if p_effective ->> 'source' = 'demo' then
      if p_effective - 'source' is distinct from public.omr_read_demo_plan_v1(p_organization_id)
         or p_effective ->> 'entitlementMode' is distinct from 'permanent_demo'
         or p_effective ->> 'plan' not in ('free','pro','academy') then raise exception 'effective plan transaction proof invalid'; end if;
      perform set_config('omr.phase_c_effective_plan_proof',
        (p_effective || jsonb_build_object('transactionId',txid_current()::text))::text,true);
      return;
    end if;
    v_plan := p_effective ->> 'plan';
    v_expires_at := p_effective ->> 'expiresAt';
    v_source := p_effective ->> 'source';
    if p_effective is null
       or pg_catalog.jsonb_typeof(p_effective) is distinct from 'object'
       or p_effective ->> 'organizationId' is distinct from p_organization_id
       or v_plan not in ('free', 'pro', 'academy')
       or v_source not in ('pilot', 'legacy')
       or (v_source = 'legacy' and (
            p_organization_id !~ '^(default|teacher_[a-z0-9]{7,16})$'
            or p_effective ->> 'grantId' is not null
            or p_effective -> 'expiresAt' is distinct from 'null'::jsonb
       ))
       or (v_source = 'pilot' and v_plan = 'free' and (
            p_effective ->> 'grantId' is not null
            or p_effective -> 'expiresAt' is distinct from 'null'::jsonb
       ))
       or (v_source = 'pilot' and v_plan in ('pro', 'academy') and (
            nullif(p_effective ->> 'grantId', '') is null
            or nullif(v_expires_at, '') is null
            or v_expires_at::timestamptz <= pg_catalog.clock_timestamp()
       )) then
        raise exception 'effective plan transaction proof invalid';
    end if;
    perform pg_catalog.set_config(
        'omr.phase_c_effective_plan_proof',
        pg_catalog.jsonb_build_object(
            'organizationId', p_organization_id,
            'source', v_source,
            'plan', v_plan,
            'expiresAt', case when v_expires_at is null then null else v_expires_at end,
            'transactionId', pg_catalog.txid_current()::text
        )::text,
        true
    );
end;
$$;

create or replace function public.omr_assert_effective_plan_transaction_proof_v1(
    p_organization_id text,
    p_require_paid boolean
)
returns void
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
set lock_timeout = '2s'
as $$
declare
    v_proof jsonb;
    v_plan text;
    v_expires_at text;
    v_source text;
begin
    begin
        v_proof := pg_catalog.current_setting(
            'omr.phase_c_effective_plan_proof', true
        )::jsonb;
    exception when others then
        raise exception 'effective plan transaction proof required';
    end;
    if v_proof ->> 'source' = 'demo' then
      if v_proof ->> 'transactionId' is distinct from txid_current()::text
         or v_proof - 'source' - 'transactionId' is distinct from public.omr_read_demo_plan_v1(p_organization_id)
         or v_proof ->> 'entitlementMode' is distinct from 'permanent_demo'
         or v_proof ->> 'plan' not in ('free','pro','academy')
         or (coalesce(p_require_paid,false) and v_proof ->> 'plan' not in ('pro','academy')) then
          raise exception 'effective plan transaction proof required'; end if;
      return;
    end if;
    v_plan := v_proof ->> 'plan';
    v_expires_at := v_proof ->> 'expiresAt';
    v_source := v_proof ->> 'source';
    if v_proof ->> 'organizationId' is distinct from p_organization_id
       or v_proof ->> 'transactionId' is distinct from pg_catalog.txid_current()::text
       or v_source not in ('pilot', 'legacy')
       or v_plan not in ('free', 'pro', 'academy')
       or (coalesce(p_require_paid, false) and (
            v_plan not in ('pro', 'academy')
            or (v_source = 'pilot' and (
                nullif(v_expires_at, '') is null
                or v_expires_at::timestamptz <= pg_catalog.clock_timestamp()
            ))
       )) then
        raise exception 'effective plan transaction proof required';
    end if;
end;
$$;

create or replace function public.omr_prepare_attempt_handwriting_asset_v2(
    p_session_id text,
    p_organization_id text,
    p_owner_student_id text,
    p_asset jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
set lock_timeout = '2s'
as $$
declare
    v_preflight_organization_id text;
    v_effective jsonb;
    v_session public.omr_attempt_sessions%rowtype;
    v_attempt public.omr_attempts%rowtype;
    v_asset public.omr_remote_assets%rowtype;
    v_stored public.omr_remote_assets%rowtype;
    v_storage_bytes bigint;
    v_storage_cap bigint;
    v_canonical_asset_id text;
    v_canonical_path text;
    v_cleanup_path text;
    v_stored_found boolean;
    v_source text;
    v_grant_id text;
    v_grant_expires_at timestamp with time zone;
    v_reservation_expires_at timestamp with time zone;
    v_created_at timestamp with time zone;
    v_ref jsonb;
begin
    if nullif(pg_catalog.btrim(p_session_id), '') is null
       or nullif(pg_catalog.btrim(p_organization_id), '') is null
       or nullif(pg_catalog.btrim(p_owner_student_id), '') is null
       or pg_catalog.jsonb_typeof(p_asset) is distinct from 'object' then
        raise exception 'invalid handwriting reservation';
    end if;
    -- Preflight without a row lock, then acquire topology/grant locks before
    -- session/attempt/asset domain locks. The locked reread below detects drift.
    select attempt_session.organization_id into v_preflight_organization_id
     from public.omr_attempt_sessions attempt_session
     where attempt_session.id = pg_catalog.btrim(p_session_id)
       and attempt_session.organization_id = pg_catalog.btrim(p_organization_id)
       and attempt_session.owner_student_id = pg_catalog.btrim(p_owner_student_id)
       and attempt_session.status = 'submitted';
    if not found then raise exception 'submitted attempt session not found'; end if;
    v_effective := public.omr_read_effective_organization_plan_v1(
        v_preflight_organization_id
    );
    if v_effective is null then
        raise exception 'handwriting archive topology denied';
    end if;
    select * into v_session from public.omr_attempt_sessions attempt_session
     where attempt_session.id = pg_catalog.btrim(p_session_id)
       and attempt_session.organization_id = v_preflight_organization_id
       and attempt_session.owner_student_id = pg_catalog.btrim(p_owner_student_id)
       and attempt_session.status = 'submitted'
     for update;
    if not found then raise exception 'submitted attempt session drifted'; end if;
    select * into v_attempt from public.omr_attempts attempt
     where attempt.id = v_session.submitted_attempt_id
       and attempt.organization_id = v_session.organization_id
       and attempt.student_id = v_session.owner_student_id
       and attempt.status = 'completed'
     for update;
    if not found then raise exception 'submitted attempt not found'; end if;

    select * into v_asset
      from pg_catalog.jsonb_populate_record(null::public.omr_remote_assets, p_asset);
    v_canonical_asset_id := v_asset.id;
    v_canonical_path := 'organizations/' || v_session.organization_id
        || '/attempts/' || v_attempt.id || '/handwriting/'
        || v_canonical_asset_id || '.json';
    if v_canonical_asset_id !~ (
           '^asset_handwriting_' || pg_catalog.md5(v_session.id)
           || '_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       )
       or v_asset.organization_id is distinct from v_session.organization_id
       or v_asset.kind is distinct from 'attempt_handwriting'
       or v_asset.exam_id is not null
       or v_asset.attempt_id is distinct from v_attempt.id
       or v_asset.storage_bucket is distinct from 'omr-private-assets'
       or v_asset.object_path is distinct from v_canonical_path
       or v_asset.mime_type is distinct from 'application/json'
       or v_asset.byte_size is null or v_asset.byte_size not between 1 and 10485760
       or v_asset.sha256_hex is null or v_asset.sha256_hex !~ '^[a-f0-9]{64}$' then
        raise exception 'invalid canonical handwriting asset';
    end if;

    perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(v_session.organization_id, 604006)
    );
    select * into v_stored from public.omr_remote_assets asset
     where asset.organization_id = v_session.organization_id
       and asset.attempt_id = v_attempt.id
       and asset.kind = 'attempt_handwriting'
     order by asset.created_at, asset.id
     limit 1
     for update;
    v_stored_found := found;
    v_cleanup_path := case when v_stored_found
        then v_stored.object_path else v_canonical_path end;
    perform 1 from public.omr_remote_asset_cleanup_queue queue
     where queue.storage_bucket = 'omr-private-assets'
       and queue.object_path = v_cleanup_path
     for update;
    if found then
        return pg_catalog.jsonb_build_object(
            'status', 'cleanup_pending', 'objectRequired', false
        );
    end if;
    if v_stored_found then
        if v_stored.organization_id is distinct from v_asset.organization_id
           or v_stored.kind is distinct from v_asset.kind
           or v_stored.attempt_id is distinct from v_asset.attempt_id
           or v_stored.mime_type is distinct from v_asset.mime_type
           or v_stored.byte_size is distinct from v_asset.byte_size
           or v_stored.sha256_hex is distinct from v_asset.sha256_hex
           or v_stored.original_name is distinct from v_asset.original_name then
            raise exception 'handwriting reservation belongs to another payload';
        end if;
        v_ref := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
            'store', 'remote',
            'key', v_stored.id,
            'organizationId', v_stored.organization_id,
            'kind', 'attempt_handwriting',
            'attemptId', v_stored.attempt_id,
            'name', v_stored.original_name,
            'mimeType', v_stored.mime_type,
            'size', v_stored.byte_size,
            'updatedAt', pg_catalog.to_char(
                v_stored.updated_at at time zone 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            )
        ));
        if v_attempt.payload -> 'drawingsRef' = v_ref
           and v_attempt.payload ->> 'handwritingArchived' = 'true' then
            return pg_catalog.jsonb_build_object(
                'status', 'attached', 'objectRequired', false,
                'asset', pg_catalog.to_jsonb(v_stored),
                'drawingsRef', v_ref
            );
        end if;
    end if;

    if v_effective is null or v_effective ->> 'plan' not in ('pro', 'academy') then
        raise exception 'handwriting archive plan denied';
    end if;
    v_source := v_effective ->> 'source';
    v_grant_id := nullif(v_effective ->> 'grantId', '');
    v_grant_expires_at := nullif(v_effective ->> 'expiresAt', '')::timestamptz;
    if v_source = 'pilot' and (
        v_grant_id is null or v_grant_expires_at is null
        or v_grant_expires_at <= pg_catalog.clock_timestamp()
    ) then raise exception 'handwriting archive plan expired'; end if;
    if v_source in ('legacy','demo') and (
        v_grant_id is not null or v_grant_expires_at is not null
    ) then raise exception 'handwriting archive legacy plan invalid'; end if;
    if v_source not in ('pilot', 'legacy', 'demo') then
        raise exception 'handwriting archive plan source invalid';
    end if;
    v_storage_cap := case when v_effective ->> 'plan' = 'pro'
        then 2147483648 else 10737418240 end;

    if v_stored_found then
        if v_stored.handwriting_reservation_source is distinct from v_source
           or v_stored.handwriting_reservation_expires_at is null
           or v_stored.handwriting_reservation_expires_at <= pg_catalog.clock_timestamp()
           or (v_source = 'pilot' and (
               v_stored.handwriting_reservation_grant_id is distinct from v_grant_id
               or v_stored.handwriting_reservation_expires_at > v_grant_expires_at
           ))
           or (v_source in ('legacy','demo')
               and v_stored.handwriting_reservation_grant_id is not null) then
            raise exception 'handwriting reservation expired or superseded';
        end if;
        return pg_catalog.jsonb_build_object(
            'status', 'reserved',
            'objectRequired', false,
            'asset', pg_catalog.to_jsonb(v_stored)
        );
    end if;
    if nullif(v_attempt.payload #>> '{drawingsRef,key}', '') is not null then
        raise exception 'attempt handwriting is already archived';
    end if;
    select coalesce(pg_catalog.sum(reserved.byte_size), 0)::bigint into v_storage_bytes
      from (
          select item.object_path, pg_catalog.max(item.byte_size)::bigint as byte_size
            from (
                select asset.object_path, asset.byte_size
                  from public.omr_remote_assets asset
                 where asset.organization_id = v_session.organization_id
                union
                select intent.object_path, intent.byte_size
                  from public.omr_remote_asset_upload_intents intent
                 where intent.organization_id = v_session.organization_id
                   and intent.status in ('pending', 'uploaded', 'finalized')
                   and intent.expires_at > pg_catalog.now()
                union
                select queue.object_path, queue.byte_size
                  from public.omr_remote_asset_cleanup_queue queue
                 where queue.organization_id = v_session.organization_id
                   and queue.status in ('pending', 'leased', 'dead')
            ) item
           group by item.object_path
      ) reserved;
    if v_storage_bytes + v_asset.byte_size > v_storage_cap then
        raise exception 'organization remote asset storage limit exceeded';
    end if;
    v_created_at := pg_catalog.clock_timestamp();
    v_reservation_expires_at := v_created_at + interval '15 minutes';
    if v_source = 'pilot' then
        v_reservation_expires_at := least(
            v_reservation_expires_at,
            (v_effective ->> 'expiresAt')::timestamptz
        );
    end if;
    -- This is the last entitlement/time check before the durable reservation.
    if v_reservation_expires_at <= pg_catalog.clock_timestamp()
       or (v_source = 'pilot'
           and v_grant_expires_at <= pg_catalog.clock_timestamp()) then
        raise exception 'handwriting archive plan expired';
    end if;
    insert into public.omr_remote_assets (
        id, organization_id, kind, exam_id, attempt_id, storage_bucket,
        object_path, mime_type, byte_size, sha256_hex, original_name,
        created_by_user_id, created_at, updated_at,
        handwriting_reservation_source, handwriting_reservation_grant_id,
        handwriting_reservation_expires_at
    ) values (
        v_canonical_asset_id, v_session.organization_id, 'attempt_handwriting',
        null, v_attempt.id, 'omr-private-assets', v_canonical_path,
        'application/json', v_asset.byte_size, v_asset.sha256_hex,
        v_asset.original_name, null, v_created_at, v_created_at,
        v_source, v_grant_id, v_reservation_expires_at
    ) returning * into v_stored;
    return pg_catalog.jsonb_build_object(
        'status', 'reserved', 'objectRequired', true,
        'asset', pg_catalog.to_jsonb(v_stored)
    );
end;
$$;

create or replace function public.omr_attach_attempt_handwriting_v2(
    p_session_id text,
    p_organization_id text,
    p_owner_student_id text,
    p_ticket_id text,
    p_asset_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
set lock_timeout = '2s'
as $$
declare
    v_preflight_organization_id text;
    v_effective jsonb;
    v_session public.omr_attempt_sessions%rowtype;
    v_attempt public.omr_attempts%rowtype;
    v_asset public.omr_remote_assets%rowtype;
    v_ref jsonb;
    v_source text;
    v_grant_id text;
    v_grant_expires_at timestamp with time zone;
begin
    if nullif(pg_catalog.btrim(p_session_id), '') is null
       or nullif(pg_catalog.btrim(p_ticket_id), '') is null
       or nullif(pg_catalog.btrim(p_asset_id), '') is null
       or nullif(pg_catalog.btrim(p_organization_id), '') is null
       or nullif(pg_catalog.btrim(p_owner_student_id), '') is null then
        raise exception 'invalid handwriting attachment';
    end if;
    select attempt_session.organization_id into v_preflight_organization_id
     from public.omr_attempt_sessions attempt_session
     where attempt_session.id = pg_catalog.btrim(p_session_id)
       and attempt_session.organization_id = pg_catalog.btrim(p_organization_id)
       and attempt_session.owner_student_id = pg_catalog.btrim(p_owner_student_id)
       and attempt_session.submission_id = pg_catalog.btrim(p_ticket_id)
       and attempt_session.status = 'submitted';
    if not found then raise exception 'submitted attempt session not found'; end if;
    v_effective := public.omr_read_effective_organization_plan_v1(
        v_preflight_organization_id
    );
    if v_effective is null then
        raise exception 'handwriting archive topology denied';
    end if;
    select * into v_session from public.omr_attempt_sessions attempt_session
     where attempt_session.id = pg_catalog.btrim(p_session_id)
       and attempt_session.organization_id = v_preflight_organization_id
       and attempt_session.owner_student_id = pg_catalog.btrim(p_owner_student_id)
       and attempt_session.submission_id = pg_catalog.btrim(p_ticket_id)
       and attempt_session.status = 'submitted'
     for update;
    if not found then raise exception 'submitted attempt session drifted'; end if;
    select * into v_attempt from public.omr_attempts attempt
     where attempt.id = v_session.submitted_attempt_id
       and attempt.organization_id = v_session.organization_id
       and attempt.student_id = v_session.owner_student_id
       and attempt.ticket_id = pg_catalog.btrim(p_ticket_id)
       and attempt.id = 'attempt_' || pg_catalog.btrim(p_ticket_id)
       and attempt.status = 'completed'
     for update;
    if not found then raise exception 'attempt ticket not found'; end if;
    if pg_catalog.btrim(p_asset_id) !~ (
        '^asset_handwriting_' || pg_catalog.md5(v_session.id)
        || '_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ) then raise exception 'handwriting asset is not canonical for session'; end if;
    select * into v_asset from public.omr_remote_assets asset
     where asset.id = pg_catalog.btrim(p_asset_id)
       and asset.organization_id = v_attempt.organization_id
       and asset.attempt_id = v_attempt.id
       and asset.kind = 'attempt_handwriting'
     for update;
    if not found then raise exception 'handwriting asset scope mismatch'; end if;
    perform 1 from public.omr_remote_asset_cleanup_queue queue
     where queue.storage_bucket = v_asset.storage_bucket
       and queue.object_path = v_asset.object_path
     for update;
    if found then raise exception 'handwriting cleanup in progress'; end if;
    v_ref := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'store', 'remote',
        'key', v_asset.id,
        'organizationId', v_asset.organization_id,
        'kind', 'attempt_handwriting',
        'attemptId', v_asset.attempt_id,
        'name', v_asset.original_name,
        'mimeType', v_asset.mime_type,
        'size', v_asset.byte_size,
        'updatedAt', pg_catalog.to_char(
            v_asset.updated_at at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        )
    ));
    if v_attempt.payload -> 'drawingsRef' = v_ref
       and v_attempt.payload ->> 'handwritingArchived' = 'true' then
        return v_attempt.payload;
    end if;

    if v_effective is null or v_effective ->> 'plan' not in ('pro', 'academy') then
        raise exception 'handwriting archive plan denied';
    end if;
    v_source := v_effective ->> 'source';
    v_grant_id := nullif(v_effective ->> 'grantId', '');
    v_grant_expires_at := nullif(v_effective ->> 'expiresAt', '')::timestamptz;
    if v_asset.handwriting_reservation_source is distinct from v_source
       or v_asset.handwriting_reservation_expires_at is null
       or v_asset.handwriting_reservation_expires_at <= pg_catalog.clock_timestamp()
       or (v_source = 'pilot' and (
           v_grant_id is null
           or v_grant_expires_at is null
           or v_grant_expires_at <= pg_catalog.clock_timestamp()
           or v_asset.handwriting_reservation_grant_id is distinct from v_grant_id
           or v_asset.handwriting_reservation_expires_at > v_grant_expires_at
       ))
       or (v_source in ('legacy','demo') and (
           v_grant_id is not null
           or v_grant_expires_at is not null
           or v_asset.handwriting_reservation_grant_id is not null
       )) then
        raise exception 'handwriting reservation expired or superseded';
    end if;
    -- Wall-clock can advance while the object is inspected. Recheck at the
    -- write boundary; the entitlement graph/grant rows remain locked.
    if v_asset.handwriting_reservation_expires_at <= pg_catalog.clock_timestamp()
       or (v_source = 'pilot'
           and v_grant_expires_at <= pg_catalog.clock_timestamp()) then
        raise exception 'handwriting reservation expired or superseded';
    end if;
    update public.omr_attempts attempt
       set payload = pg_catalog.jsonb_set(
           pg_catalog.jsonb_set(
               pg_catalog.jsonb_set(attempt.payload, '{drawingsRef}', v_ref, true),
               '{handwritingArchived}', 'true'::jsonb, true
           ),
           '{handwritingPlan}', pg_catalog.to_jsonb(v_effective ->> 'plan'), true
       )
     where attempt.id = v_attempt.id
    returning * into v_attempt;
    delete from public.omr_remote_asset_cleanup_queue queue
     where queue.source_type = 'remote_asset'
       and queue.source_id = v_asset.id
       and queue.organization_id = v_attempt.organization_id;
    return v_attempt.payload;
end;
$$;

alter table public.omr_remote_assets drop constraint omr_remote_assets_handwriting_reservation_source_check, drop constraint omr_remote_assets_handwriting_reservation_shape_check;
alter table public.omr_remote_assets
    add constraint omr_remote_assets_handwriting_reservation_source_check
        check (handwriting_reservation_source is null
            or handwriting_reservation_source in ('pilot', 'legacy', 'demo')),
    add constraint omr_remote_assets_handwriting_reservation_shape_check
        check (
            (handwriting_reservation_source is null
                and handwriting_reservation_grant_id is null
                and handwriting_reservation_expires_at is null)
            or (
                kind = 'attempt_handwriting'
                and handwriting_reservation_expires_at is not null
                and handwriting_reservation_expires_at > created_at
                and handwriting_reservation_expires_at
                    <= created_at + interval '15 minutes'
                and (
                    (handwriting_reservation_source = 'pilot'
                        and handwriting_reservation_grant_id is not null)
                    or (handwriting_reservation_source in ('legacy','demo')
                        and handwriting_reservation_grant_id is null)
                )
            )
        );



alter function public.omr_lock_demo_identity_v1(text,bigint,text) owner to postgres;
revoke all on function public.omr_lock_demo_identity_v1(text,bigint,text) from public,anon,authenticated,service_role;
alter function public.omr_read_demo_plan_v1(text) owner to postgres;
revoke all on function public.omr_read_demo_plan_v1(text) from public,anon,authenticated,service_role;
alter function public.omr_provision_demo_account_v1(text,text,text,text,text,text,text,text,text,text,text) owner to postgres;
revoke all on function public.omr_provision_demo_account_v1(text,text,text,text,text,text,text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.omr_provision_demo_account_v1(text,text,text,text,text,text,text,text,text,text,text) to service_role;
alter function public.omr_revoke_demo_organization_v1(text,text,text,text) owner to postgres;
revoke all on function public.omr_revoke_demo_organization_v1(text,text,text,text) from public,anon,authenticated;
grant execute on function public.omr_revoke_demo_organization_v1(text,text,text,text) to service_role;
alter function public.omr_read_effective_workspace_plan_v1(text) owner to postgres;
revoke all on function public.omr_read_effective_workspace_plan_v1(text) from public,anon,authenticated;
alter function public.omr_lookup_provisioned_teacher_login_v1(text) owner to postgres;
revoke all on function public.omr_lookup_provisioned_teacher_login_v1(text) from public,anon,authenticated;
alter function public.omr_validate_provisioned_teacher_session_v1(text,bigint,text) owner to postgres;
revoke all on function public.omr_validate_provisioned_teacher_session_v1(text,bigint,text) from public,anon,authenticated;
alter function public.omr_lock_provisioned_teacher_identity_v1(text,bigint,text) owner to postgres;
revoke all on function public.omr_lock_provisioned_teacher_identity_v1(text,bigint,text) from public,anon,authenticated;
alter function public.omr_authorize_effective_teacher_plan_v1(text,text) owner to postgres;
revoke all on function public.omr_authorize_effective_teacher_plan_v1(text,text) from public,anon,authenticated;
alter function public.omr_read_effective_organization_plan_v1(text) owner to postgres;
revoke all on function public.omr_read_effective_organization_plan_v1(text) from public,anon,authenticated;
alter function public.omr_read_teacher_mutation_plan_v1(text,text,text,text) owner to postgres;
revoke all on function public.omr_read_teacher_mutation_plan_v1(text,text,text,text) from public,anon,authenticated;
alter function public.omr_lookup_teacher_account_v1(text) owner to postgres;
revoke all on function public.omr_lookup_teacher_account_v1(text) from public,anon,authenticated;
alter function public.omr_validate_teacher_session_v1(text,bigint) owner to postgres;
revoke all on function public.omr_validate_teacher_session_v1(text,bigint) from public,anon,authenticated;
alter function public.omr_begin_teacher_password_reset_v1(text,text,text,timestamptz) owner to postgres;
revoke all on function public.omr_begin_teacher_password_reset_v1(text,text,text,timestamptz) from public,anon,authenticated;
alter function public.omr_complete_teacher_password_reset_v1(text,text) owner to postgres;
revoke all on function public.omr_complete_teacher_password_reset_v1(text,text) from public,anon,authenticated;
alter function public.omr_set_effective_plan_transaction_proof_v1(text,jsonb) owner to postgres;
revoke all on function public.omr_set_effective_plan_transaction_proof_v1(text,jsonb) from public,anon,authenticated;
alter function public.omr_assert_effective_plan_transaction_proof_v1(text,boolean) owner to postgres;
revoke all on function public.omr_assert_effective_plan_transaction_proof_v1(text,boolean) from public,anon,authenticated;
alter function public.omr_prepare_attempt_handwriting_asset_v2(text,text,text,jsonb) owner to postgres;
revoke all on function public.omr_prepare_attempt_handwriting_asset_v2(text,text,text,jsonb) from public,anon,authenticated;
alter function public.omr_attach_attempt_handwriting_v2(text,text,text,text,text) owner to postgres;
revoke all on function public.omr_attach_attempt_handwriting_v2(text,text,text,text,text) from public,anon,authenticated;

commit;
