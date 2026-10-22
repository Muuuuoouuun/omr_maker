-- Operator-reviewed recovery preserves legacy organization IDs, data and Storage paths.
-- It creates a separate canonical owner; no existing account is reset or re-keyed.
begin;
do $recovery_new_definition_guard$
declare r record; routine oid;
begin
 for r in select * from (values
('omr_internal.lock_legacy_recovery_identity_v1(text,bigint,text)','1ce8d2528bddccab5dd7df690fafc78dcfc47d7df8c1dde66df98658f829b491'),
('omr_internal.read_legacy_recovery_plan_v1(text)','2a644e039d9b0ab61c73f4f9eb5d69853af32354c82e4103cd6d09bef193258f'),
('public.omr_recover_legacy_organization_v1(text,text,text,text,text,text,text,text,text,text)','bf45db448dba6735abc7143229a002cb9cc1cebe10cda070ff37ab548caae475')
 ) expected(signature,fingerprint) loop
  routine:=pg_catalog.to_regprocedure(r.signature);
  if routine is not null and encode(extensions.digest(pg_catalog.pg_get_functiondef(routine),'sha256'),'hex') is distinct from r.fingerprint then
    raise exception 'unexpected existing recovery function fingerprint: %',r.signature;
  end if;
 end loop;
end
$recovery_new_definition_guard$;
-- Keep audit-backed account tombstones cheap as unrelated audit history grows.
create index if not exists omr_legacy_recovery_audit_owner_idx
    on public.omr_audit_logs ((metadata->>'ownerAccountId'))
    where action='operator.legacy_organization_recovered' and entity_type='legacy_organization_recovery';
create table if not exists omr_internal.legacy_organization_recoveries (
    organization_id text primary key references public.omr_organizations(id) on delete restrict,
    owner_account_id text not null unique references public.omr_teacher_accounts(id) on delete restrict,
    source_admin_user_id text not null,
    idempotency_key_hash text not null unique check (idempotency_key_hash ~ '^[a-f0-9]{64}$'),
    request_hash text not null check (request_hash ~ '^[a-f0-9]{64}$'),
    audit_id text not null unique,
    plan text not null check (plan='academy'),
    entitlement_mode text not null check (entitlement_mode='legacy_recovery'),
    state text not null default 'active' check (state in ('active','revoked')),
    created_at timestamptz not null default clock_timestamp(),
    revoked_at timestamptz,
    check (organization_id ~ '^teacher_[a-z0-9]{7,16}$'),
    check (owner_account_id ~ '^teacher_[a-f0-9]{16}$'),
    check (source_admin_user_id ~ '^teacher_[a-z0-9]{7,16}$'),
    check ((state='active' and revoked_at is null) or (state='revoked' and revoked_at is not null))
);
alter table omr_internal.legacy_organization_recoveries enable row level security;
alter table omr_internal.legacy_organization_recoveries force row level security;
revoke all on table omr_internal.legacy_organization_recoveries from public,anon,authenticated,service_role;

create or replace function omr_internal.lock_legacy_recovery_identity_v1(p_account_id text,p_generation bigint,p_org text)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='5s' set lock_timeout='2s'
as $function$
declare a public.omr_teacher_accounts%rowtype; r omr_internal.legacy_organization_recoveries%rowtype;
    m public.omr_organization_members%rowtype; org_name text;
begin
    if p_org is null or p_org !~ '^teacher_[a-z0-9]{7,16}$' or p_account_id is null
       or p_account_id !~ '^teacher_[a-f0-9]{16}$' or p_generation is null
       or p_generation not between 1 and 9007199254740991 then return null; end if;
    lock table public.omr_organization_members in share mode;
    lock table public.omr_teacher_profiles in share mode;
    select * into a from public.omr_teacher_accounts where id=p_account_id for update;
    if not found or a.status <> 'active' or a.session_generation <> p_generation then return null; end if;
    perform organization_id from public.omr_organization_members where user_id=p_account_id order by organization_id for update;
    perform organization_id from public.omr_teacher_profiles where user_id=p_account_id order by organization_id for update;
    select name into org_name from public.omr_organizations where id=p_org and plan='academy' for update;
    if not found then return null; end if;
    select * into r from omr_internal.legacy_organization_recoveries where organization_id=p_org for update;
    if not found or r.state <> 'active' or r.entitlement_mode <> 'legacy_recovery' or r.plan <> 'academy'
       or r.owner_account_id is distinct from a.id then return null; end if;
    if (select count(*) from public.omr_organization_members where user_id=a.id) <> 1
       or (select count(*) from public.omr_teacher_profiles where user_id=a.id) <> 1
       or (select count(*) from public.omr_organization_members where organization_id=p_org and role='owner') <> 1 then return null; end if;
    select * into m from public.omr_organization_members where user_id=a.id and organization_id=p_org;
    if not found or m.status <> 'active' or m.role <> 'owner'
       or m.email is distinct from a.email or m.display_name is distinct from a.display_name
       or not exists(select 1 from public.omr_teacher_profiles p where p.user_id=a.id and p.organization_id=p_org
                     and p.status='active' and p.display_name=a.display_name)
       or exists(select 1 from public.omr_pilot_plan_grants p where p.account_id=a.id or p.organization_id=p_org)
       or exists(select 1 from public.omr_pilot_member_provisions p where p.account_id=a.id or p.organization_id=p_org)
       or exists(select 1 from public.omr_demo_provisions p where p.account_id=a.id or p.organization_id=p_org)
       or exists(select 1 from public.omr_demo_organizations d where d.owner_account_id=a.id or d.id=p_org) then return null; end if;
    -- An exact operator audit binds this registry to its original recovery. Old
    -- source-admin memberships may later change without changing the new owner.
    if not exists(select 1 from public.omr_audit_logs audit where audit.id=r.audit_id
       and audit.organization_id=p_org and audit.action='operator.legacy_organization_recovered'
       and audit.entity_type='legacy_organization_recovery' and audit.entity_id=p_org
       and audit.actor_user_id ~ '^operator:[a-z0-9][a-z0-9._-]{0,63}$'
       and audit.metadata->>'ownerAccountId'=a.id and audit.metadata->>'sourceAdminUserId'=r.source_admin_user_id
       and audit.metadata->>'plan'='academy' and audit.metadata->>'entitlementMode'='legacy_recovery'
       and audit.metadata->>'reason'='legacy_owner_recovery'
       and audit.metadata->>'idempotencyKeyHash'=r.idempotency_key_hash)
       or (select count(*) from public.omr_audit_logs audit where audit.organization_id=p_org
          and audit.action='operator.legacy_organization_recovered' and audit.entity_type='legacy_organization_recovery'
          and audit.entity_id=p_org and audit.metadata->>'ownerAccountId'=a.id) <> 1 then return null; end if;
    return jsonb_build_object('accountId',a.id,'sessionGeneration',a.session_generation,
       'organizationId',p_org,'organizationName',org_name,'memberRole','owner',
       'plan','academy','grantExpiresAt',null,'entitlementMode','legacy_recovery');
end
$function$;

create or replace function omr_internal.read_legacy_recovery_plan_v1(p_org text)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='5s' set lock_timeout='2s'
as $function$
declare owner_id text; gen bigint; identity jsonb;
begin
    select r.owner_account_id,a.session_generation into owner_id,gen from omr_internal.legacy_organization_recoveries r
      join public.omr_teacher_accounts a on a.id=r.owner_account_id where r.organization_id=p_org;
    identity := omr_internal.lock_legacy_recovery_identity_v1(owner_id,gen,p_org);
    if identity is null then return null; end if;
    return jsonb_build_object('organizationId',p_org,'plan','academy','grantId',null,'expiresAt',null,'entitlementMode','legacy_recovery');
end
$function$;

create or replace function public.omr_recover_legacy_organization_v1(
 p_organization_id text,p_expected_admin_user_id text,p_email text,p_display_name text,p_password_hash text,
 p_plan text,p_entitlement_mode text,p_actor text,p_reason text,p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='10s' set lock_timeout='3s'
as $function$
declare v_email text:=lower(btrim(p_email)); v_display text:=btrim(p_display_name);
    v_key_hash text; v_request_hash text; v_account_id text; v_audit_id text;
    v_prior omr_internal.legacy_organization_recoveries%rowtype;
begin
    if p_organization_id is null or p_organization_id !~ '^teacher_[a-z0-9]{7,16}$'
       or p_expected_admin_user_id is null or p_expected_admin_user_id !~ '^teacher_[a-z0-9]{7,16}$'
       or p_plan is distinct from 'academy' or p_entitlement_mode is distinct from 'legacy_recovery'
       or p_reason is distinct from 'legacy_owner_recovery' or p_actor is null
       or p_actor !~ '^operator:[a-z0-9][a-z0-9._-]{0,63}$'
       or p_email is null or length(v_email) not between 3 and 254 or octet_length(v_email)>254
       or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
       or p_display_name is null or length(v_display) not between 1 and 80 or octet_length(v_display)>240 or v_display ~ '[[:cntrl:]]'
       or p_password_hash is null or p_password_hash !~ '^pbkdf2-sha256:120000:[a-f0-9]{32}:[a-f0-9]{64}$'
       or p_idempotency_key is null or p_idempotency_key !~ '^prov_[A-Za-z0-9_-]{32,123}$' then raise exception 'invalid_provisioning_request'; end if;
    v_key_hash:=encode(extensions.digest(p_idempotency_key,'sha256'),'hex');
    v_request_hash:=encode(extensions.digest(jsonb_build_object('organizationId',p_organization_id,
      'sourceAdminUserId',p_expected_admin_user_id,'email',v_email,'displayName',v_display,'passwordHash',p_password_hash,
      'plan',p_plan,'entitlementMode',p_entitlement_mode,'actor',p_actor,'reason',p_reason)::text,'sha256'),'hex');
    perform pg_advisory_xact_lock(20261022,hashtext(v_key_hash));
    perform pg_advisory_xact_lock(20260808,hashtext(v_email));
    -- Membership topology is locked before accounts, organization and registry,
    -- matching request-time identity checks; replay does not invert this order.
    lock table public.omr_organization_members in share row exclusive mode;
    lock table public.omr_teacher_profiles in share row exclusive mode;
    select * into v_prior from omr_internal.legacy_organization_recoveries where idempotency_key_hash=v_key_hash;
    if found then
      if v_prior.request_hash is distinct from v_request_hash then raise exception 'idempotency_conflict'; end if;
      if omr_internal.read_legacy_recovery_plan_v1(v_prior.organization_id) is null then raise exception 'provisioning_conflict'; end if;
      return jsonb_build_object('status','provisioned','organizationId',v_prior.organization_id,'accountId',v_prior.owner_account_id,
          'memberRole','owner','plan','academy','entitlementMode','legacy_recovery','replayed',true);
    end if;
    if exists(select 1 from public.omr_teacher_accounts where email=v_email) then raise exception 'provisioning_conflict'; end if;
    perform id from public.omr_organizations where id=p_organization_id and plan='academy' for update;
    if not found or exists(select 1 from public.omr_audit_logs recovery_audit where recovery_audit.organization_id=p_organization_id and recovery_audit.action='operator.legacy_organization_recovered' and recovery_audit.entity_type='legacy_organization_recovery' and recovery_audit.entity_id=p_organization_id) or exists(select 1 from omr_internal.legacy_organization_recoveries where organization_id=p_organization_id)
       or exists(select 1 from public.omr_organization_members where organization_id=p_organization_id and role='owner')
       or exists(select 1 from public.omr_pilot_plan_grants where organization_id=p_organization_id)
       or exists(select 1 from public.omr_pilot_member_provisions where organization_id=p_organization_id)
       or exists(select 1 from public.omr_demo_organizations where id=p_organization_id)
       or exists(select 1 from public.omr_demo_provisions where organization_id=p_organization_id) then raise exception 'provisioning_conflict'; end if;
    perform u.user_id from public.omr_user_profiles u where u.user_id=p_expected_admin_user_id for update;
    if not exists(select 1 from public.omr_organization_members m
       join public.omr_user_profiles u on u.user_id=m.user_id
       join public.omr_teacher_profiles p on p.user_id=m.user_id and p.organization_id=m.organization_id
       where m.organization_id=p_organization_id and m.user_id=p_expected_admin_user_id and m.role='admin'
         and m.status='active' and u.status='active' and p.status='active'
         and lower(btrim(m.email))=v_email and lower(btrim(u.email))=v_email
         and m.display_name=p.display_name) then raise exception 'provisioning_conflict'; end if;
    v_account_id:='teacher_'||encode(extensions.gen_random_bytes(8),'hex');
    v_audit_id:='audit_'||encode(extensions.gen_random_bytes(12),'hex');
    insert into public.omr_teacher_accounts(id,email,display_name,password_hash,status,email_verified_at,session_generation)
      values(v_account_id,v_email,v_display,p_password_hash,'active',clock_timestamp(),1);
    insert into public.omr_organization_members(organization_id,user_id,email,display_name,role,status)
      values(p_organization_id,v_account_id,v_email,v_display,'owner','active');
    insert into public.omr_teacher_profiles(organization_id,user_id,display_name,subjects,status)
      values(p_organization_id,v_account_id,v_display,'{}'::text[],'active');
    insert into public.omr_audit_logs(id,organization_id,actor_user_id,action,entity_type,entity_id,metadata)
      values(v_audit_id,p_organization_id,p_actor,'operator.legacy_organization_recovered','legacy_organization_recovery',p_organization_id,
        jsonb_build_object('ownerAccountId',v_account_id,'sourceAdminUserId',p_expected_admin_user_id,'plan','academy',
          'entitlementMode','legacy_recovery','reason',p_reason,'idempotencyKeyHash',v_key_hash));
    insert into omr_internal.legacy_organization_recoveries(organization_id,owner_account_id,source_admin_user_id,
        idempotency_key_hash,request_hash,audit_id,plan,entitlement_mode)
      values(p_organization_id,v_account_id,p_expected_admin_user_id,v_key_hash,v_request_hash,v_audit_id,'academy','legacy_recovery');
    if omr_internal.read_legacy_recovery_plan_v1(p_organization_id) is null then raise exception 'provisioning_conflict'; end if;
    return jsonb_build_object('status','provisioned','organizationId',p_organization_id,'accountId',v_account_id,
       'memberRole','owner','plan','academy','entitlementMode','legacy_recovery','replayed',false);
end
$function$;
revoke all on function omr_internal.lock_legacy_recovery_identity_v1(text,bigint,text),
  omr_internal.read_legacy_recovery_plan_v1(text) from public,anon,authenticated,service_role;
revoke all on function public.omr_recover_legacy_organization_v1(text,text,text,text,text,text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.omr_recover_legacy_organization_v1(text,text,text,text,text,text,text,text,text,text) to service_role;

-- Refuse silently replacing an unknown deployed implementation; replay is exact.
do $recovery_definition_guard$
declare r record; actual text;
begin
 for r in select * from (values
('public.omr_read_effective_workspace_plan_v1(text)','117c3f5df5cc58a3a69116cbc95176fc7d3263aa9a2d1504ccecf346ac908826','778083d5e37553c1089bacc01839fd64f7fd2fe433d3b8bf11bdbc6f9cbe7201'),
('public.omr_read_effective_organization_plan_v1(text)','dfc7aa28b3ed4b77ef4217f25c369517a6ed65d3fd5b4c84db7df4aa3264347e','fc84aad4097ac2cfc7b15d767471f55bb50dcb80dad3e81239d223a14027fc51'),
('public.omr_lock_provisioned_teacher_identity_v1(text, bigint, text)','675d804493fa77ae2d2005f047d9d94c1709b63ef535ec7459cd0f52245aa0fc','da88b56b78f6a27bda5e38bfc350923e653dd927f4d2a3595183a15b649af7d0'),
('public.omr_validate_provisioned_teacher_session_v1(text, bigint, text)','a17a29edc7161ec12477ceeeacf71be9cfe99b57a12edf005b662e3ec7423ff5','25d78d77d24aff14c38a4d93c5a52e4b6aeb58a5e9e1ef9dbda84514cf341d56'),
('public.omr_authorize_effective_teacher_plan_v1(text, text)','8f499484ea0d2554c33493a5372bc5278dddd7b3e41ca4c3d9a48692ee57c942','67f82ff84b845e835274264bfdf36e3c965b476ca34657a5399e3a260400f3bd'),
('public.omr_read_teacher_mutation_plan_v1(text, text, text, text)','f110b55917d0c3512f0dad1b0316cb3eb32cd9f6ca35aafdf6f38732e80d0667','bd8a94856ae1f95092d58a40fb28c7b2d2f6a43340f7f6ecb532574570229726'),
('public.omr_lookup_provisioned_teacher_login_v1(text)','67a31068f1b3094fc39fbb14fed5b4a68665405e827bae7094e1496eea9790a5','9efc7745af6c20181ce1cc1a219bcb72f8d69c1813c5d3f3d7ad8239a726722c'),
('public.omr_lock_legacy_teacher_identity_v1(text, bigint, text, text)','0c34bd45ef44617958146cdb1c27d20f1bbd2cbb826edafca1a67a5388e0fd09','dfd1f868a9d400608e28056882b642ce4dfaf7c647d8d60ca1c7e6cea59a23c3'),
('public.omr_read_legacy_teacher_plan_v1(text, text, text)','7054b0730fbeffee5fad715bca610ad247af7977ac14447c17f3224d47b3ddd7','13dc0a2af4cd03872822c80a564d3e51aca6b6243daeb67e0b2a6c54f1ef2b25'),
('public.omr_lookup_teacher_account_v1(text)','54789f75c1cf21b39bf023cc18bf288e752058f26506f08d9c53e874b89bd464','943ebd34f874b92c32b80ad32dfa9a8c82d333a38a8a778a563158c664298f06'),
('public.omr_validate_teacher_session_v1(text, bigint)','9ed7e0dc70f70443703c50a8ae6aea25c6079c76a9b13a22ab7e9349cc242bd1','2b07eb8fd3708b470a159ad031d542e78dea0ec19810c8ab478632159a927850'),
('public.omr_begin_teacher_password_reset_v1(text, text, text, timestamp with time zone)','56aaf95ed3cfe82c6cbd0375a1f199e94eb3f95f7c2ec1a257b5ce1add83c616','3b93c38fa98fb897274fc7f6ead886d18eb692d49f542a84c652a6bdf4aa8953'),
('public.omr_complete_teacher_password_reset_v1(text, text)','6dab50aa13601fe31e9d15542245b753c952ec45d57fa809436c94aba640c284','ff66b8dd21859d592db7caac040b883f0b521821af5a0bc6149e528ba000e55c')
 ) v(signature,old_hash,new_hash) loop
  actual:=encode(extensions.digest(pg_get_functiondef(r.signature::regprocedure),'sha256'),'hex');
  if actual not in (r.old_hash,r.new_hash) then raise exception 'unexpected legacy recovery prerequisite fingerprint: %',r.signature; end if;
 end loop;
end
$recovery_definition_guard$;
CREATE OR REPLACE FUNCTION public.omr_read_effective_workspace_plan_v1(p_organization_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '5s'
AS $function$
declare
    v_grant public.omr_pilot_plan_grants%rowtype;
begin
    if exists(select 1 from omr_internal.legacy_organization_recoveries r where r.organization_id=p_organization_id) or exists(select 1 from public.omr_audit_logs recovery_audit where recovery_audit.organization_id=p_organization_id and recovery_audit.action='operator.legacy_organization_recovered' and recovery_audit.entity_type='legacy_organization_recovery' and recovery_audit.entity_id=p_organization_id) then
      return omr_internal.read_legacy_recovery_plan_v1(p_organization_id);
    end if;
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
$function$;

CREATE OR REPLACE FUNCTION public.omr_read_effective_organization_plan_v1(p_organization_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '5s'
 SET lock_timeout TO '2s'
AS $function$
declare
    v_account_id text;
    v_session_generation bigint;
    v_candidate_count integer;
    v_identity jsonb;
    v_legacy_plan text;
begin
    if exists(select 1 from omr_internal.legacy_organization_recoveries r where r.organization_id=p_organization_id) or exists(select 1 from public.omr_audit_logs recovery_audit where recovery_audit.organization_id=p_organization_id and recovery_audit.action='operator.legacy_organization_recovered' and recovery_audit.entity_type='legacy_organization_recovery' and recovery_audit.entity_id=p_organization_id) then
      return omr_internal.read_legacy_recovery_plan_v1(p_organization_id) || jsonb_build_object('source','legacy');
    end if;
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
$function$;

CREATE OR REPLACE FUNCTION public.omr_lock_provisioned_teacher_identity_v1(p_account_id text, p_session_generation bigint, p_organization_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '5s'
 SET lock_timeout TO '2s'
AS $function$
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
    if exists(select 1 from omr_internal.legacy_organization_recoveries r where r.organization_id=p_organization_id) or exists(select 1 from public.omr_audit_logs recovery_audit where recovery_audit.organization_id=p_organization_id and recovery_audit.action='operator.legacy_organization_recovered' and recovery_audit.entity_type='legacy_organization_recovery' and recovery_audit.entity_id=p_organization_id) then
      return omr_internal.lock_legacy_recovery_identity_v1(p_account_id,p_session_generation,p_organization_id);
    end if;
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
$function$;

CREATE OR REPLACE FUNCTION public.omr_validate_provisioned_teacher_session_v1(p_account_id text, p_session_generation bigint, p_organization_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '5s'
 SET lock_timeout TO '2s'
AS $function$
declare
    v_result jsonb;
begin
    if exists(select 1 from omr_internal.legacy_organization_recoveries r where r.organization_id=p_organization_id) or exists(select 1 from public.omr_audit_logs recovery_audit where recovery_audit.organization_id=p_organization_id and recovery_audit.action='operator.legacy_organization_recovered' and recovery_audit.entity_type='legacy_organization_recovery' and recovery_audit.entity_id=p_organization_id) then
      return omr_internal.lock_legacy_recovery_identity_v1(p_account_id,p_session_generation,p_organization_id);
    end if;
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
$function$;

CREATE OR REPLACE FUNCTION public.omr_authorize_effective_teacher_plan_v1(p_account_id text, p_organization_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '5s'
 SET lock_timeout TO '2s'
AS $function$
declare
    v_effective jsonb;
    v_grant public.omr_pilot_plan_grants%rowtype;
    v_role text;
    v_plan_account_id text;
    v_owner_count integer;
begin
    if exists(select 1 from omr_internal.legacy_organization_recoveries r where r.organization_id=p_organization_id) or exists(select 1 from public.omr_audit_logs recovery_audit where recovery_audit.organization_id=p_organization_id and recovery_audit.action='operator.legacy_organization_recovered' and recovery_audit.entity_type='legacy_organization_recovery' and recovery_audit.entity_id=p_organization_id) then
      if omr_internal.lock_legacy_recovery_identity_v1(p_account_id,(select session_generation from public.omr_teacher_accounts where id=p_account_id),p_organization_id) is null then return null; end if;
      return omr_internal.read_legacy_recovery_plan_v1(p_organization_id);
    end if;
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
$function$;

CREATE OR REPLACE FUNCTION public.omr_read_teacher_mutation_plan_v1(p_session_authority text, p_account_id text, p_organization_id text, p_actor_user_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '5s'
 SET lock_timeout TO '2s'
AS $function$
begin
    if exists(select 1 from omr_internal.legacy_organization_recoveries r where r.organization_id=p_organization_id) or exists(select 1 from public.omr_audit_logs recovery_audit where recovery_audit.organization_id=p_organization_id and recovery_audit.action='operator.legacy_organization_recovered' and recovery_audit.entity_type='legacy_organization_recovery' and recovery_audit.entity_id=p_organization_id) then
      if p_session_authority is distinct from 'account' or p_actor_user_id is distinct from p_account_id then return null; end if;
      return public.omr_authorize_effective_teacher_plan_v1(p_account_id,p_organization_id) || jsonb_build_object('source','legacy');
    end if;
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
$function$;

CREATE OR REPLACE FUNCTION public.omr_lookup_provisioned_teacher_login_v1(p_identifier text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '5s'
 SET lock_timeout TO '2s'
AS $function$
declare
    v_identifier text := pg_catalog.lower(pg_catalog.btrim(p_identifier));
    v_result jsonb;
    demo_a public.omr_teacher_accounts%rowtype; demo_org text;
begin
    select a.* into demo_a from public.omr_teacher_accounts a
      where a.email=lower(btrim(p_identifier)) and (exists(select 1 from omr_internal.legacy_organization_recoveries r where r.owner_account_id=a.id) or exists(select 1 from public.omr_audit_logs recovery_audit where recovery_audit.action='operator.legacy_organization_recovered' and recovery_audit.entity_type='legacy_organization_recovery' and recovery_audit.metadata->>'ownerAccountId'=a.id));
    if found then
      select organization_id into demo_org from omr_internal.legacy_organization_recoveries where owner_account_id=demo_a.id;
      v_result := omr_internal.lock_legacy_recovery_identity_v1(demo_a.id,demo_a.session_generation,demo_org);
      if v_result is null then return null; end if;
      return v_result || jsonb_build_object('email',demo_a.email,'displayName',demo_a.display_name,'passwordHash',demo_a.password_hash);
    end if;
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
$function$;

CREATE OR REPLACE FUNCTION public.omr_lock_legacy_teacher_identity_v1(p_account_id text, p_session_generation bigint, p_organization_id text, p_actor_user_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '5s'
 SET lock_timeout TO '2s'
AS $function$
declare
    v_account public.omr_teacher_accounts%rowtype;
    v_member public.omr_organization_members%rowtype;
    v_profile public.omr_teacher_profiles%rowtype;
    v_organization public.omr_organizations%rowtype;
    v_membership_count integer;
    v_profile_count integer;
begin
    if exists(select 1 from omr_internal.legacy_organization_recoveries r where r.organization_id=p_organization_id or r.owner_account_id=p_account_id) or exists(select 1 from public.omr_audit_logs recovery_audit where recovery_audit.organization_id=p_organization_id and recovery_audit.action='operator.legacy_organization_recovered' and recovery_audit.entity_type='legacy_organization_recovery' and recovery_audit.entity_id=p_organization_id) or exists(select 1 from public.omr_audit_logs recovery_audit where recovery_audit.action='operator.legacy_organization_recovered' and recovery_audit.entity_type='legacy_organization_recovery' and recovery_audit.metadata->>'ownerAccountId'=p_account_id) then return null; end if;
    if p_account_id is null
       or p_account_id !~ '^teacher_[a-z0-9]{16}$'
       or p_session_generation is null
       or p_session_generation not between 1 and 9007199254740991
       or p_organization_id is null
       or p_organization_id !~ '^(default|teacher_[a-z0-9]{7,16})$'
       or p_actor_user_id is null
       or p_actor_user_id !~ '^teacher_[a-z0-9]{7,16}$' then
        return null;
    end if;

    lock table public.omr_organization_members in share mode;
    lock table public.omr_teacher_profiles in share mode;

    select account.* into v_account
      from public.omr_teacher_accounts account
     where account.id = p_account_id
     for update;
    if not found
       or v_account.status <> 'active'
       or v_account.session_generation <> p_session_generation
       or exists (
           select 1
             from public.omr_pilot_plan_grants grant_row
            where grant_row.account_id = p_account_id
               or grant_row.organization_id = p_organization_id
       ) then
        return null;
    end if;

    perform member.organization_id
      from public.omr_organization_members member
     where member.user_id = p_actor_user_id
     order by member.organization_id
     for update;
    select pg_catalog.count(*)::integer into v_membership_count
      from public.omr_organization_members member
     where member.user_id = p_actor_user_id;
    select member.* into v_member
      from public.omr_organization_members member
     where member.user_id = p_actor_user_id
       and member.organization_id = p_organization_id;
    if v_membership_count <> 1
       or not found
       or v_member.status <> 'active'
       or v_member.role not in ('owner', 'admin', 'teacher', 'assistant')
       or v_member.email is distinct from v_account.email
       or v_member.display_name is distinct from v_account.display_name then
        return null;
    end if;

    perform profile.organization_id
      from public.omr_teacher_profiles profile
     where profile.user_id = p_actor_user_id
     order by profile.organization_id
     for update;
    select pg_catalog.count(*)::integer into v_profile_count
      from public.omr_teacher_profiles profile
     where profile.user_id = p_actor_user_id;
    select profile.* into v_profile
      from public.omr_teacher_profiles profile
     where profile.user_id = p_actor_user_id
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

    return pg_catalog.jsonb_build_object(
        'accountId', v_account.id,
        'sessionGeneration', v_account.session_generation,
        'organizationId', v_member.organization_id,
        'actorUserId', v_member.user_id,
        'memberRole', v_member.role
    );
end;
$function$;

CREATE OR REPLACE FUNCTION public.omr_read_legacy_teacher_plan_v1(p_account_id text, p_organization_id text, p_actor_user_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '5s'
 SET lock_timeout TO '2s'
AS $function$
declare
    v_plan text;
begin
    if exists(select 1 from omr_internal.legacy_organization_recoveries r where r.organization_id=p_organization_id or r.owner_account_id=p_account_id) or exists(select 1 from public.omr_audit_logs recovery_audit where recovery_audit.organization_id=p_organization_id and recovery_audit.action='operator.legacy_organization_recovered' and recovery_audit.entity_type='legacy_organization_recovery' and recovery_audit.entity_id=p_organization_id) or exists(select 1 from public.omr_audit_logs recovery_audit where recovery_audit.action='operator.legacy_organization_recovered' and recovery_audit.entity_type='legacy_organization_recovery' and recovery_audit.metadata->>'ownerAccountId'=p_account_id) then return null; end if;
    if p_organization_id is null
       or p_organization_id !~ '^(default|teacher_[a-z0-9]{7,16})$'
       or not exists (
           select 1
             from public.omr_teacher_accounts account
            where account.id = p_account_id
              and account.status = 'active'
       )
       or exists (
           select 1
             from public.omr_pilot_plan_grants grant_row
            where grant_row.account_id = p_account_id
               or grant_row.organization_id = p_organization_id
       )
       or not exists (
           select 1
             from public.omr_organization_members member
            where member.organization_id = p_organization_id
              and member.user_id = p_actor_user_id
              and member.status = 'active'
              and member.role in ('owner', 'admin', 'teacher', 'assistant')
       ) then
        return null;
    end if;
    select organization.plan into v_plan
      from public.omr_organizations organization
     where organization.id = p_organization_id;
    if not found or v_plan not in ('free', 'pro', 'academy') then
        return null;
    end if;
    return pg_catalog.jsonb_build_object(
        'organizationId', p_organization_id,
        'plan', v_plan,
        'grantId', null,
        'expiresAt', null
    );
end;
$function$;

CREATE OR REPLACE FUNCTION public.omr_lookup_teacher_account_v1(p_identifier text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '5s'
 SET lock_timeout TO '2s'
AS $function$
    select pg_catalog.jsonb_build_object(
        'id', account.id,
        'email', account.email,
        'display_name', account.display_name,
        'password_hash', account.password_hash,
        'status', account.status,
        'session_generation', account.session_generation
    )
     from public.omr_teacher_accounts account
     where not exists(select 1 from public.omr_audit_logs recovery_audit where recovery_audit.action='operator.legacy_organization_recovered' and recovery_audit.entity_type='legacy_organization_recovery' and recovery_audit.metadata->>'ownerAccountId'=account.id) and not exists(select 1 from omr_internal.legacy_organization_recoveries r where r.owner_account_id=account.id) and not exists(select 1 from public.omr_demo_provisions d where d.account_id=account.id) and account.status = 'active'
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
$function$;

CREATE OR REPLACE FUNCTION public.omr_validate_teacher_session_v1(p_account_id text, p_session_generation bigint)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '5s'
 SET lock_timeout TO '2s'
AS $function$
    select exists (
        select 1
          from public.omr_teacher_accounts account
         where not exists(select 1 from public.omr_audit_logs recovery_audit where recovery_audit.action='operator.legacy_organization_recovered' and recovery_audit.entity_type='legacy_organization_recovery' and recovery_audit.metadata->>'ownerAccountId'=account.id) and not exists(select 1 from omr_internal.legacy_organization_recoveries r where r.owner_account_id=account.id) and not exists(select 1 from public.omr_demo_provisions d where d.account_id=account.id) and account.id = p_account_id
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
$function$;

CREATE OR REPLACE FUNCTION public.omr_begin_teacher_password_reset_v1(p_token_id text, p_email text, p_token_hash text, p_expires_at timestamp with time zone)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '5s'
 SET lock_timeout TO '2s'
AS $function$
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
    if exists(select 1 from public.omr_audit_logs recovery_audit where recovery_audit.action='operator.legacy_organization_recovered' and recovery_audit.entity_type='legacy_organization_recovery' and recovery_audit.metadata->>'ownerAccountId'=v_account_id) or exists(select 1 from omr_internal.legacy_organization_recoveries r where r.owner_account_id=v_account_id) or exists(select 1 from public.omr_demo_provisions d where d.account_id=v_account_id) or v_account_id is null
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
$function$;

CREATE OR REPLACE FUNCTION public.omr_complete_teacher_password_reset_v1(p_token_hash text, p_password_hash text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '5s'
 SET lock_timeout TO '2s'
AS $function$
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
    if v_email is null or exists(select 1 from public.omr_teacher_accounts recovery_account where recovery_account.email=v_email and exists(select 1 from public.omr_audit_logs recovery_audit where recovery_audit.action='operator.legacy_organization_recovered' and recovery_audit.entity_type='legacy_organization_recovery' and recovery_audit.metadata->>'ownerAccountId'=recovery_account.id)) or exists(select 1 from omr_internal.legacy_organization_recoveries r join public.omr_teacher_accounts a on a.id=r.owner_account_id where a.email=v_email) or exists(select 1 from public.omr_demo_provisions d join public.omr_teacher_accounts a on a.id=d.account_id where a.email=v_email) then return false; end if;

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
$function$;


-- Advance an installed production boundary atomically. Fresh migration installs
-- without that boundary keep their existing wrapper until the boundary is applied.
do $recovery_readiness_fingerprint$
declare definition text; fingerprint text;
begin
 definition:=pg_catalog.pg_get_functiondef('public.omr_service_readiness_v1()'::regprocedure);
 if strpos(definition,'v_provisioned_teacher_login_ready')>0 then
  fingerprint:=encode(extensions.digest(definition,'sha256'),'hex');
  if fingerprint='e9b11082e829ee61529952250c7f267a4bdf99019c5c1d417fcafa13437a8182' then
   execute $recovery_readiness_definition$
CREATE OR REPLACE FUNCTION public.omr_service_readiness_v1()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
    v_previous jsonb;
    v_canonical_tables_force_rls boolean;
    v_service_role_privileges_ready boolean;
    v_cleanup_epoch_ready boolean;
    v_operational_job_status_ready boolean;
    v_operator_pilot_provisioning_ready boolean;
    v_provisioned_teacher_login_ready boolean;
    v_attempt_sessions_ready boolean;
    v_durable_rate_limits_ready boolean;
    v_teacher_notification_summary_ready boolean;
    v_teacher_notification_state_ready boolean;
    v_exam_revision_ready boolean;
    v_teacher_exam_cas_ready boolean;
    v_feedback_revision_ready boolean;
    v_feedback_cas_ready boolean;
    v_workspace_bootstrap_plan_safe boolean;
    v_session_cleanup_optimization_ready boolean;
    v_feedback_replay_hardening_ready boolean;
    v_feedback_core_free_ready boolean;
    v_session_cleanup_fencing_ready boolean;
    v_attempt_checkpoint_null_cas_ready boolean;
    v_roster_snapshot_cas_ready boolean;
    v_attempt_mutation_cas_ready boolean;
    v_exam_delete_session_safe boolean;
    v_student_question_atomic_ready boolean;
    v_teacher_live_sessions_ready boolean;
    v_teacher_account_lifecycle_ready boolean;
    v_initial_operations_load_control_ready boolean;
    v_exam_entry_invites_ready boolean;
    v_individual_student_assignments_ready boolean;
    v_teacher_attempt_reporting_ready boolean;
    v_legacy_gateway_catalog_ready boolean;
    v_server_gateway_capabilities_ready boolean;
    v_effective_workspace_plan_enforcement_ready boolean;
    v_student_session_generation_ready boolean;
    v_student_credential_batch_ready boolean;
    v_canonical_question_result_evidence_ready boolean;
    v_assignment_generation_scope_ready boolean;
    v_kakao_reminder_entitlement_ready boolean;
    v_legacy_organization_recovery_ready boolean;
    v_ready boolean;
begin
    v_previous := public.omr_service_readiness_v10_snapshot();

    with expected(table_name) as (values
        ('omr_organizations'), ('omr_plan_usage'), ('omr_plan_usage_reservations'),
        ('omr_user_profiles'), ('omr_organization_members'), ('omr_teacher_profiles'),
        ('omr_student_profiles'), ('omr_student_start_credentials'), ('omr_classes'),
        ('omr_roster_invites'), ('omr_class_teachers'), ('omr_class_students'),
        ('omr_materials'), ('omr_exams'), ('omr_exam_entry_invites'), ('omr_exam_questions'),
        ('omr_exam_materials'), ('omr_assignments'), ('omr_assignment_targets'),
        ('omr_attempts'), ('omr_question_results'), ('omr_assignment_submissions'),
        ('omr_attempt_feedback'), ('omr_kakao_candidate_reviews'),
        ('omr_kakao_dispatch_logs'), ('omr_comments'), ('omr_audit_logs'),
        ('omr_remote_assets'), ('omr_remote_asset_upload_intents'),
        ('omr_remote_asset_cleanup_queue'), ('omr_attempt_sessions'),
        ('omr_rate_limit_buckets'), ('omr_exam_mutations'), ('omr_feedback_mutations'),
        ('omr_initial_ops_metrics'), ('omr_teacher_accounts'), ('omr_teacher_account_tokens'),
        ('omr_teacher_notification_states'), ('omr_operational_job_status'),
        ('omr_pilot_plan_grants'), ('omr_pilot_member_provisions'), ('omr_demo_organizations'), ('omr_demo_provisions'), ('omr_student_credential_epochs'),
        ('omr_student_credential_batch_receipts'),
        ('omr_kakao_reminder_legacy_quarantine'),
        ('omr_reminder_settings'), ('omr_reminder_contacts'), ('omr_reminder_deliveries'), ('omr_remediation_cases')
    ), actual(table_name, row_security, force_row_security) as (
        select relation.relname::text, relation.relrowsecurity, relation.relforcerowsecurity
          from pg_catalog.pg_class relation
          join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
         where namespace.nspname = 'public'
           and relation.relkind in ('r', 'p')
           and relation.relname like 'omr\_%' escape '\'
    )
    select not exists (select table_name from expected except select table_name from actual)
       and not exists (select table_name from actual except select table_name from expected)
       and not exists (select 1 from actual where not row_security or not force_row_security)
      into v_canonical_tables_force_rls;

    -- Ordinary canonical tables remain directly available to the trusted
    -- server. Rate buckets, mutation receipts, load metrics, and teacher
    -- account secrets are RPC-only tables.
    v_service_role_privileges_ready :=
        exists (
            select 1 from pg_catalog.pg_roles role_row
             where role_row.rolname = 'service_role' and role_row.rolbypassrls
        )
        and pg_catalog.has_schema_privilege('service_role', 'public', 'USAGE')
        and pg_catalog.has_table_privilege('service_role', 'public.omr_remediation_cases', 'SELECT')
        and not pg_catalog.has_table_privilege('service_role', 'public.omr_remediation_cases', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
        and not exists (
            select 1
              from pg_catalog.pg_class relation
              join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
             where namespace.nspname = 'public'
               and relation.relkind in ('r', 'p')
               and relation.relname like 'omr\_%' escape '\'
               and relation.relname not in (
                   'omr_rate_limit_buckets', 'omr_exam_mutations', 'omr_feedback_mutations',
                   'omr_exam_entry_invites',
                   'omr_initial_ops_metrics', 'omr_teacher_accounts', 'omr_teacher_account_tokens',
                   'omr_teacher_notification_states', 'omr_operational_job_status',
                   'omr_pilot_plan_grants', 'omr_pilot_member_provisions', 'omr_demo_organizations', 'omr_demo_provisions', 'omr_student_credential_batch_receipts',
                   'omr_student_credential_epochs', 'omr_student_start_credentials',
                   'omr_remote_assets', 'omr_remote_asset_upload_intents',
                   'omr_remote_asset_cleanup_queue', 'omr_plan_usage',
                   'omr_plan_usage_reservations', 'omr_kakao_candidate_reviews',
                   'omr_kakao_dispatch_logs', 'omr_kakao_reminder_legacy_quarantine', 'omr_remediation_cases'
               )
               and (
                   not pg_catalog.has_table_privilege('service_role', relation.oid, 'SELECT')
                   or not pg_catalog.has_table_privilege('service_role', relation.oid, 'INSERT')
                   or not pg_catalog.has_table_privilege('service_role', relation.oid, 'UPDATE')
                   or not pg_catalog.has_table_privilege('service_role', relation.oid, 'DELETE')
               )
        )
        and not pg_catalog.has_table_privilege(
            'service_role', 'public.omr_rate_limit_buckets',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
        )
        and not pg_catalog.has_table_privilege(
            'service_role', 'public.omr_exam_mutations',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
        )
        and not pg_catalog.has_table_privilege(
            'service_role', 'public.omr_feedback_mutations',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
        )
        and not pg_catalog.has_table_privilege(
            'service_role', 'public.omr_exam_entry_invites',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
        )
        and not pg_catalog.has_table_privilege(
            'service_role', 'public.omr_initial_ops_metrics',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
        )
        and not pg_catalog.has_table_privilege(
            'service_role', 'public.omr_teacher_accounts',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
        )
        and not pg_catalog.has_table_privilege(
            'service_role', 'public.omr_teacher_account_tokens',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
        )
        and not pg_catalog.has_table_privilege(
            'service_role', 'public.omr_teacher_notification_states',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
        )
        and not pg_catalog.has_table_privilege(
            'service_role', 'public.omr_operational_job_status',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
        )
        and not pg_catalog.has_table_privilege(
            'service_role', 'public.omr_pilot_plan_grants',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
        )
        and not pg_catalog.has_table_privilege(
            'service_role', 'public.omr_pilot_member_provisions',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
        )
        and not pg_catalog.has_table_privilege(
            'service_role', 'public.omr_student_credential_epochs',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
        )
        and not pg_catalog.has_table_privilege(
            'service_role', 'public.omr_student_credential_batch_receipts',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
        )
        and pg_catalog.has_table_privilege(
            'service_role', 'public.omr_student_start_credentials', 'SELECT'
        )
        and not pg_catalog.has_table_privilege(
            'service_role', 'public.omr_student_start_credentials',
            'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
        )
        and not exists (
            select 1
              from pg_catalog.pg_class relation
              join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
             where namespace.nspname = 'public' and relation.relkind = 'S'
               and relation.relname not in (
                   'omr_operational_job_run_sequence',
                   'omr_remote_asset_cleanup_queue_id_seq'
               )
               and (
                   not pg_catalog.has_sequence_privilege('service_role', relation.oid, 'USAGE')
                   or not pg_catalog.has_sequence_privilege('service_role', relation.oid, 'SELECT')
                   or not pg_catalog.has_sequence_privilege('service_role', relation.oid, 'UPDATE')
               )
        );

    v_operational_job_status_ready :=
        pg_catalog.to_regclass('public.omr_operational_job_status') is not null
        and pg_catalog.to_regclass('public.omr_operational_job_run_sequence') is not null
        and exists (
            select 1
              from pg_catalog.pg_attribute attribute
             where attribute.attrelid = 'public.omr_operational_job_status'::pg_catalog.regclass
               and attribute.attname = 'active_lease_until'
               and not attribute.attisdropped
               and not attribute.attnotnull
               and pg_catalog.format_type(attribute.atttypid, attribute.atttypmod)
                   = 'timestamp with time zone'
        )
        and exists (
            select 1
              from pg_catalog.pg_attribute attribute
             where attribute.attrelid = 'public.omr_operational_job_status'::pg_catalog.regclass
               and attribute.attname = 'active_lease_started_at'
               and not attribute.attisdropped
               and not attribute.attnotnull
               and pg_catalog.format_type(attribute.atttypid, attribute.atttypmod)
                   = 'timestamp with time zone'
        )
        and exists (
            select 1
              from pg_catalog.pg_index index_record
             where index_record.indexrelid = pg_catalog.to_regclass(
                       'public.omr_remote_asset_cleanup_dead_idx'
                   )
               and index_record.indrelid = 'public.omr_remote_asset_cleanup_queue'::pg_catalog.regclass
               and index_record.indisvalid
               and index_record.indisready
               and not index_record.indisunique
               and index_record.indnatts = 1
               and index_record.indnkeyatts = 1
               and pg_catalog.pg_get_indexdef(index_record.indexrelid, 1, true) = 'status'
               and pg_catalog.pg_get_expr(
                   index_record.indpred, index_record.indrelid, true
               ) = 'status = ''dead''::text'
        )
        and pg_catalog.to_regprocedure(
            'public.omr_begin_operational_job_run_v1(text,text)'
        ) is not null
        and pg_catalog.to_regprocedure(
            'public.omr_complete_operational_job_run_v1(text,bigint,text,text,text)'
        ) is not null
        and pg_catalog.to_regprocedure('public.omr_read_operational_job_status_v1(text)') is not null
        and not exists (
            select 1
              from pg_catalog.pg_proc routine
             where routine.oid in (
                 'public.omr_begin_operational_job_run_v1(text,text)'::pg_catalog.regprocedure,
                 'public.omr_complete_operational_job_run_v1(text,bigint,text,text,text)'::pg_catalog.regprocedure,
                 'public.omr_read_operational_job_status_v1(text)'::pg_catalog.regprocedure
             )
               and (
                   routine.prokind <> 'f'
                   or pg_catalog.pg_get_function_result(routine.oid) <> 'jsonb'
                   or not routine.prosecdef
                   or pg_catalog.pg_get_userbyid(routine.proowner) <> 'postgres'
                   or not coalesce(routine.proconfig, '{}'::text[]) @> array[
                       'search_path=""', 'statement_timeout=5s'
                   ]::text[]
                   or (
                       routine.proname <> 'omr_read_operational_job_status_v1'
                       and not coalesce(routine.proconfig, '{}'::text[])
                           @> array['lock_timeout=2s']::text[]
                   )
               )
        )
        and not exists (
            select 1
              from pg_catalog.pg_proc routine
              join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
             where namespace.nspname = 'public'
               and routine.proname in (
                   'omr_begin_operational_job_run_v1',
                   'omr_complete_operational_job_run_v1',
                   'omr_read_operational_job_status_v1'
               )
               and routine.oid not in (
                   'public.omr_begin_operational_job_run_v1(text,text)'::pg_catalog.regprocedure,
                   'public.omr_complete_operational_job_run_v1(text,bigint,text,text,text)'::pg_catalog.regprocedure,
                   'public.omr_read_operational_job_status_v1(text)'::pg_catalog.regprocedure
               )
        )
        and not exists (
            select 1
              from pg_catalog.unnest(array[
                  'public.omr_begin_operational_job_run_v1(text,text)',
                  'public.omr_complete_operational_job_run_v1(text,bigint,text,text,text)',
                  'public.omr_read_operational_job_status_v1(text)'
              ]) signature(value)
             where not pg_catalog.has_function_privilege('service_role', signature.value, 'EXECUTE')
                or pg_catalog.has_function_privilege('anon', signature.value, 'EXECUTE')
                or pg_catalog.has_function_privilege('authenticated', signature.value, 'EXECUTE')
        )
        and not pg_catalog.has_sequence_privilege(
            'service_role', 'public.omr_operational_job_run_sequence', 'USAGE,SELECT,UPDATE'
        )
        and position(
            'nextval' in pg_catalog.pg_get_functiondef(
                'public.omr_begin_operational_job_run_v1(text,text)'::pg_catalog.regprocedure
            )
        ) > 0
        and position(
            'v_job_status.active_lease_until > v_now' in pg_catalog.pg_get_functiondef(
                'public.omr_begin_operational_job_run_v1(text,text)'::pg_catalog.regprocedure
            )
        ) > 0
        and position(
            'interval ''15 minutes''' in pg_catalog.pg_get_functiondef(
                'public.omr_begin_operational_job_run_v1(text,text)'::pg_catalog.regprocedure
            )
        ) > 0
        and position(
            'v_now + interval ''15 minutes''' in pg_catalog.pg_get_functiondef(
                'public.omr_begin_operational_job_run_v1(text,text)'::pg_catalog.regprocedure
            )
        ) > 0
        and position(
            'p_run_sequence = v_job_status.latest_started_sequence' in pg_catalog.pg_get_functiondef(
                'public.omr_complete_operational_job_run_v1(text,bigint,text,text,text)'::pg_catalog.regprocedure
            )
        ) > 0
        and position(
            'active_lease_until = null' in pg_catalog.pg_get_functiondef(
                'public.omr_complete_operational_job_run_v1(text,bigint,text,text,text)'::pg_catalog.regprocedure
            )
        ) > 0
        and position(
            'active_lease_started_at = null' in pg_catalog.pg_get_functiondef(
                'public.omr_complete_operational_job_run_v1(text,bigint,text,text,text)'::pg_catalog.regprocedure
            )
        ) > 0
        and position(
            '''duplicate'', v_duplicate' in pg_catalog.pg_get_functiondef(
                'public.omr_complete_operational_job_run_v1(text,bigint,text,text,text)'::pg_catalog.regprocedure
            )
        ) > 0
        and position(
            'operational job completion conflict' in pg_catalog.pg_get_functiondef(
                'public.omr_complete_operational_job_run_v1(text,bigint,text,text,text)'::pg_catalog.regprocedure
            )
        ) > 0
        and position(
            'lock table public.omr_remote_asset_cleanup_queue in share mode' in pg_catalog.pg_get_functiondef(
                'public.omr_complete_operational_job_run_v1(text,bigint,text,text,text)'::pg_catalog.regprocedure
            )
        ) > 0
        and not exists (
            select 1
              from pg_catalog.pg_class relation
              cross join lateral pg_catalog.aclexplode(
                  coalesce(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
              ) privilege
             where relation.oid in (
                       'public.omr_operational_job_status'::pg_catalog.regclass,
                       'public.omr_operational_job_run_sequence'::pg_catalog.regclass
                   )
               and privilege.grantee = 0
        )
        and not exists (
            select 1
              from pg_catalog.pg_proc routine
              cross join lateral pg_catalog.aclexplode(
                  coalesce(routine.proacl, pg_catalog.acldefault('f', routine.proowner))
              ) privilege
             where routine.oid in (
                 'public.omr_begin_operational_job_run_v1(text,text)'::pg_catalog.regprocedure,
                 'public.omr_complete_operational_job_run_v1(text,bigint,text,text,text)'::pg_catalog.regprocedure,
                 'public.omr_read_operational_job_status_v1(text)'::pg_catalog.regprocedure
             )
               and privilege.privilege_type = 'EXECUTE'
               and privilege.grantee not in (routine.proowner, 'service_role'::pg_catalog.regrole)
        );

    v_cleanup_epoch_ready :=
        pg_catalog.to_regclass('public.omr_remote_asset_cleanup_queue') is not null
        and pg_catalog.to_regclass('public.omr_remote_asset_cleanup_claim_idx') is not null
        and pg_catalog.to_regprocedure('public.omr_claim_remote_asset_cleanup_v1(text,integer,integer)') is not null
        and pg_catalog.to_regprocedure('public.omr_authorize_remote_asset_cleanup_delete_v1(text,text,integer)') is not null
        and pg_catalog.to_regprocedure('public.omr_ack_remote_asset_cleanup_v1(text,text,integer)') is not null
        and pg_catalog.to_regprocedure('public.omr_fail_remote_asset_cleanup_v1(text,text,integer,text)') is not null
        and pg_catalog.has_function_privilege('service_role', 'public.omr_claim_remote_asset_cleanup_v1(text,integer,integer)', 'EXECUTE')
        and pg_catalog.has_function_privilege('service_role', 'public.omr_authorize_remote_asset_cleanup_delete_v1(text,text,integer)', 'EXECUTE')
        and pg_catalog.has_function_privilege('service_role', 'public.omr_ack_remote_asset_cleanup_v1(text,text,integer)', 'EXECUTE')
        and pg_catalog.has_function_privilege('service_role', 'public.omr_fail_remote_asset_cleanup_v1(text,text,integer,text)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('service_role', 'public.omr_ack_remote_asset_cleanup_v1(text,text)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('service_role', 'public.omr_fail_remote_asset_cleanup_v1(text,text,text)', 'EXECUTE')
        and not exists (
            select 1
              from pg_catalog.pg_proc routine
              join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
             where namespace.nspname = 'public'
               and routine.proname in (
                   'omr_claim_remote_asset_cleanup_v1',
                   'omr_authorize_remote_asset_cleanup_delete_v1',
                   'omr_ack_remote_asset_cleanup_v1',
                   'omr_fail_remote_asset_cleanup_v1'
               )
               and (
                   pg_catalog.has_function_privilege('anon', routine.oid, 'EXECUTE')
                   or pg_catalog.has_function_privilege('authenticated', routine.oid, 'EXECUTE')
               )
        );

    v_attempt_sessions_ready :=
        pg_catalog.to_regclass('public.omr_attempt_sessions') is not null
        and pg_catalog.to_regclass('public.omr_attempt_sessions_one_active_scope_idx') is not null
        and pg_catalog.to_regclass('public.omr_attempt_sessions_active_lease_idx') is not null
        and not pg_catalog.has_table_privilege('anon', 'public.omr_attempt_sessions', 'SELECT,INSERT,UPDATE,DELETE')
        and not pg_catalog.has_table_privilege('authenticated', 'public.omr_attempt_sessions', 'SELECT,INSERT,UPDATE,DELETE')
        and not exists (
            select 1
              from pg_catalog.pg_proc routine
              join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
             where namespace.nspname = 'public'
               and routine.proname in (
                   'omr_open_attempt_session_v3', 'omr_checkpoint_attempt_session_v2',
                   'omr_heartbeat_attempt_session_v2', 'omr_takeover_attempt_session_v2',
                   'omr_prepare_attempt_session_submit_v2', 'omr_commit_attempt_session_submit_v2',
                   'omr_prepare_attempt_handwriting_asset_v2', 'omr_discard_attempt_handwriting_asset_v1'
               )
               and (
                   not pg_catalog.has_function_privilege('service_role', routine.oid, 'EXECUTE')
                   or pg_catalog.has_function_privilege('anon', routine.oid, 'EXECUTE')
                   or pg_catalog.has_function_privilege('authenticated', routine.oid, 'EXECUTE')
               )
        )
        and (
            select count(*) from pg_catalog.pg_proc routine
             join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
            where namespace.nspname = 'public'
              and routine.proname in (
                  'omr_open_attempt_session_v3', 'omr_checkpoint_attempt_session_v2',
                  'omr_heartbeat_attempt_session_v2', 'omr_takeover_attempt_session_v2',
                  'omr_prepare_attempt_session_submit_v2', 'omr_commit_attempt_session_submit_v2',
                  'omr_prepare_attempt_handwriting_asset_v2', 'omr_discard_attempt_handwriting_asset_v1'
              )
        ) = 8;

    v_durable_rate_limits_ready :=
        pg_catalog.to_regclass('public.omr_rate_limit_buckets') is not null
        and pg_catalog.to_regclass('public.omr_rate_limit_buckets_expires_idx') is not null
        and pg_catalog.to_regprocedure('public.omr_consume_rate_limit_v1(text,text,integer,integer,integer)') is not null
        and not pg_catalog.has_table_privilege('public', 'public.omr_rate_limit_buckets', 'SELECT,INSERT,UPDATE,DELETE')
        and not pg_catalog.has_table_privilege('anon', 'public.omr_rate_limit_buckets', 'SELECT,INSERT,UPDATE,DELETE')
        and not pg_catalog.has_table_privilege('authenticated', 'public.omr_rate_limit_buckets', 'SELECT,INSERT,UPDATE,DELETE')
        and not pg_catalog.has_table_privilege('service_role', 'public.omr_rate_limit_buckets', 'SELECT,INSERT,UPDATE,DELETE')
        and pg_catalog.has_function_privilege('service_role', 'public.omr_consume_rate_limit_v1(text,text,integer,integer,integer)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('anon', 'public.omr_consume_rate_limit_v1(text,text,integer,integer,integer)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('authenticated', 'public.omr_consume_rate_limit_v1(text,text,integer,integer,integer)', 'EXECUTE');

    v_teacher_notification_summary_ready :=
        pg_catalog.to_regprocedure(
            'public.omr_teacher_notification_summary_v1(text)'
        ) is not null
        and coalesce(pg_catalog.has_function_privilege(
            'service_role',
            pg_catalog.to_regprocedure('public.omr_teacher_notification_summary_v1(text)'),
            'EXECUTE'
        ), false)
        and not coalesce(pg_catalog.has_function_privilege(
            'anon',
            pg_catalog.to_regprocedure('public.omr_teacher_notification_summary_v1(text)'),
            'EXECUTE'
        ), false)
        and not coalesce(pg_catalog.has_function_privilege(
            'authenticated',
            pg_catalog.to_regprocedure('public.omr_teacher_notification_summary_v1(text)'),
            'EXECUTE'
        ), false)
        and (
            select count(*) = 1
              from pg_catalog.pg_proc routine
              join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
             where namespace.nspname = 'public'
               and routine.proname = 'omr_teacher_notification_summary_v1'
               and routine.prokind = 'f'
               and pg_catalog.oidvectortypes(routine.proargtypes) = 'text'
        );

    v_teacher_notification_state_ready :=
        pg_catalog.to_regclass('public.omr_teacher_notification_states') is not null
        and pg_catalog.to_regclass('public.omr_teacher_notification_states_expiry_idx') is not null
        and exists (
            select 1
              from pg_catalog.pg_class relation
             where relation.oid = 'public.omr_teacher_notification_states'::pg_catalog.regclass
               and relation.relrowsecurity
               and relation.relforcerowsecurity
        )
        and not pg_catalog.has_table_privilege(
            'public', 'public.omr_teacher_notification_states',
            'SELECT,INSERT,UPDATE,DELETE'
        )
        and not pg_catalog.has_table_privilege(
            'anon', 'public.omr_teacher_notification_states',
            'SELECT,INSERT,UPDATE,DELETE'
        )
        and not pg_catalog.has_table_privilege(
            'authenticated', 'public.omr_teacher_notification_states',
            'SELECT,INSERT,UPDATE,DELETE'
        )
        and not pg_catalog.has_table_privilege(
            'service_role', 'public.omr_teacher_notification_states',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
        )
        and pg_catalog.to_regprocedure(
            'public.omr_load_teacher_notification_state_v1(text,text,text[])'
        ) is not null
        and pg_catalog.to_regprocedure(
            'public.omr_mutate_teacher_notification_state_v1(text,text,text,text[])'
        ) is not null
        and pg_catalog.has_function_privilege(
            'service_role',
            'public.omr_load_teacher_notification_state_v1(text,text,text[])',
            'EXECUTE'
        )
        and pg_catalog.has_function_privilege(
            'service_role',
            'public.omr_mutate_teacher_notification_state_v1(text,text,text,text[])',
            'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
            'anon',
            'public.omr_load_teacher_notification_state_v1(text,text,text[])',
            'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
            'authenticated',
            'public.omr_mutate_teacher_notification_state_v1(text,text,text,text[])',
            'EXECUTE'
        )
        and (
            select count(*) = 2
              from pg_catalog.pg_proc routine
              join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
             where namespace.nspname = 'public'
               and routine.prokind = 'f'
               and (
                    (routine.proname = 'omr_load_teacher_notification_state_v1'
                     and pg_catalog.oidvectortypes(routine.proargtypes) = 'text, text, text[]')
                    or
                    (routine.proname = 'omr_mutate_teacher_notification_state_v1'
                     and pg_catalog.oidvectortypes(routine.proargtypes) = 'text, text, text, text[]')
               )
        );

    select exists (
        select 1
          from pg_catalog.pg_attribute attribute
          join pg_catalog.pg_attrdef attribute_default
            on attribute_default.adrelid = attribute.attrelid
           and attribute_default.adnum = attribute.attnum
         where attribute.attrelid = 'public.omr_exams'::pg_catalog.regclass
           and attribute.attname = 'revision'
           and not attribute.attisdropped
           and attribute.attnotnull
           and pg_catalog.pg_get_expr(
               attribute_default.adbin, attribute_default.adrelid
           ) = '1'::text
    ) and exists (
        select 1 from pg_catalog.pg_constraint constraint_row
         where constraint_row.conrelid = 'public.omr_exams'::pg_catalog.regclass
           and constraint_row.conname = 'omr_exams_revision_positive'
           and constraint_row.contype = 'c' and constraint_row.convalidated
    ) into v_exam_revision_ready;

    v_teacher_exam_cas_ready :=
        v_exam_revision_ready
        and pg_catalog.to_regclass('public.omr_exam_mutations') is not null
        and not pg_catalog.has_table_privilege('public', 'public.omr_exam_mutations', 'SELECT,INSERT,UPDATE,DELETE')
        and not pg_catalog.has_table_privilege('anon', 'public.omr_exam_mutations', 'SELECT,INSERT,UPDATE,DELETE')
        and not pg_catalog.has_table_privilege('authenticated', 'public.omr_exam_mutations', 'SELECT,INSERT,UPDATE,DELETE')
        and not pg_catalog.has_table_privilege('service_role', 'public.omr_exam_mutations', 'SELECT,INSERT,UPDATE,DELETE')
        and pg_catalog.has_function_privilege('service_role', 'public.omr_save_exam_v3(text,text,bigint,text,jsonb,jsonb,jsonb,bigint,text)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('anon', 'public.omr_save_exam_v3(text,text,bigint,text,jsonb,jsonb,jsonb,bigint,text)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('authenticated', 'public.omr_save_exam_v3(text,text,bigint,text,jsonb,jsonb,jsonb,bigint,text)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('service_role', 'public.omr_save_exam_v2(jsonb,jsonb,jsonb,text,bigint,text)', 'EXECUTE')
        and not coalesce(pg_catalog.has_function_privilege(
            'service_role',
            pg_catalog.to_regprocedure('public.omr_save_exam_v1(jsonb,jsonb,jsonb,text)'),
            'EXECUTE'
        ), false)
        and not pg_catalog.has_function_privilege('service_role', 'public.omr_save_exam_v10_snapshot(jsonb,jsonb,jsonb,text)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('service_role', 'public.omr_release_plan_usage_v10_snapshot(text,text,date,text)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('service_role', 'public.omr_normalize_exam_save_request_v10(jsonb)', 'EXECUTE');

    select exists (
        select 1
          from pg_catalog.pg_attribute attribute
          join pg_catalog.pg_attrdef attribute_default
            on attribute_default.adrelid = attribute.attrelid
           and attribute_default.adnum = attribute.attnum
         where attribute.attrelid = 'public.omr_attempt_feedback'::pg_catalog.regclass
           and attribute.attname = 'revision'
           and not attribute.attisdropped and attribute.attnotnull
           and pg_catalog.pg_get_expr(attribute_default.adbin, attribute_default.adrelid) = '1'::text
    ) and exists (
        select 1 from pg_catalog.pg_constraint constraint_row
         where constraint_row.conrelid = 'public.omr_attempt_feedback'::pg_catalog.regclass
           and constraint_row.conname = 'omr_attempt_feedback_revision_positive'
           and constraint_row.contype = 'c' and constraint_row.convalidated
    ) into v_feedback_revision_ready;

    v_feedback_cas_ready :=
        v_feedback_revision_ready
        and pg_catalog.to_regclass('public.omr_feedback_mutations') is not null
        and not pg_catalog.has_table_privilege('service_role', 'public.omr_feedback_mutations', 'SELECT,INSERT,UPDATE,DELETE')
        and pg_catalog.has_function_privilege('service_role', 'public.omr_save_feedback_v4(text,text,bigint,text,text,jsonb,bigint,text)', 'EXECUTE')
        and pg_catalog.has_function_privilege('service_role', 'public.omr_return_feedback_v4(text,text,bigint,text,text,text,bigint,text)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('anon', 'public.omr_save_feedback_v4(text,text,bigint,text,text,jsonb,bigint,text)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('authenticated', 'public.omr_return_feedback_v4(text,text,bigint,text,text,text,bigint,text)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('service_role', 'public.omr_save_feedback_v2(text,jsonb,bigint,text)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('service_role', 'public.omr_return_feedback_v2(text,text,bigint,text)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('service_role', 'public.omr_save_feedback_v1(text,jsonb)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('service_role', 'public.omr_return_feedback_v1(text,text,timestamptz)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('service_role', 'public.omr_save_feedback_v12_snapshot(text,jsonb)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('service_role', 'public.omr_return_feedback_v12_snapshot(text,text,timestamptz)', 'EXECUTE');

    v_feedback_replay_hardening_ready :=
        pg_catalog.to_regclass('public.omr_feedback_mutations_created_idx') is not null
        and pg_catalog.to_regclass('public.omr_feedback_mutations_org_kind_created_idx') is not null
        and pg_catalog.obj_description(
            'public.omr_save_feedback_v2(text,jsonb,bigint,text)'::pg_catalog.regprocedure,
            'pg_proc'
        ) = 'feedback-replay-hardening:202608060014'
        and pg_catalog.obj_description(
            'public.omr_return_feedback_v2(text,text,bigint,text)'::pg_catalog.regprocedure,
            'pg_proc'
        ) = 'feedback-replay-hardening:202608060014';

    v_feedback_core_free_ready :=
        pg_catalog.to_regprocedure('public.omr_save_feedback_v4(text,text,bigint,text,text,jsonb,bigint,text)') is not null
        and pg_catalog.to_regprocedure('public.omr_return_feedback_v4(text,text,bigint,text,text,text,bigint,text)') is not null
        and pg_catalog.has_function_privilege('service_role', 'public.omr_save_feedback_v4(text,text,bigint,text,text,jsonb,bigint,text)', 'EXECUTE')
        and pg_catalog.has_function_privilege('service_role', 'public.omr_return_feedback_v4(text,text,bigint,text,text,text,bigint,text)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('anon', 'public.omr_save_feedback_v4(text,text,bigint,text,text,jsonb,bigint,text)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('authenticated', 'public.omr_return_feedback_v4(text,text,bigint,text,text,text,bigint,text)', 'EXECUTE')
        and pg_catalog.obj_description(
            'public.omr_save_feedback_v4(text,text,bigint,text,text,jsonb,bigint,text)'::pg_catalog.regprocedure,
            'pg_proc'
        ) = 'Account-session-bound feedback save with identity-before-replay and plan-before-premium-write ordering.'
        and pg_catalog.obj_description(
            'public.omr_return_feedback_v4(text,text,bigint,text,text,text,bigint,text)'::pg_catalog.regprocedure,
            'pg_proc'
        ) = 'Account-session-bound feedback return with identity-before-replay ordering.';

    v_exam_entry_invites_ready :=
        pg_catalog.to_regclass('public.omr_exam_entry_invites') is not null
        and not pg_catalog.has_table_privilege('public', 'public.omr_exam_entry_invites', 'SELECT,INSERT,UPDATE,DELETE')
        and not pg_catalog.has_table_privilege('anon', 'public.omr_exam_entry_invites', 'SELECT,INSERT,UPDATE,DELETE')
        and not pg_catalog.has_table_privilege('authenticated', 'public.omr_exam_entry_invites', 'SELECT,INSERT,UPDATE,DELETE')
        and not pg_catalog.has_table_privilege('service_role', 'public.omr_exam_entry_invites', 'SELECT,INSERT,UPDATE,DELETE')
        and pg_catalog.to_regprocedure('public.omr_get_exam_entry_invite_metadata_v1(text,text,text)') is not null
        and pg_catalog.to_regprocedure('public.omr_revoke_exam_entry_invite_v1(text,text,text)') is not null
        and pg_catalog.has_function_privilege('service_role', 'public.omr_rotate_exam_entry_invite_v1(text,text,text,text,timestamptz)', 'EXECUTE')
        and pg_catalog.has_function_privilege('service_role', 'public.omr_resolve_exam_entry_invite_v1(text,text)', 'EXECUTE')
        and pg_catalog.has_function_privilege('service_role', 'public.omr_get_exam_entry_invite_metadata_v1(text,text,text)', 'EXECUTE')
        and pg_catalog.has_function_privilege('service_role', 'public.omr_revoke_exam_entry_invite_v1(text,text,text)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('anon', 'public.omr_rotate_exam_entry_invite_v1(text,text,text,text,timestamptz)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('authenticated', 'public.omr_resolve_exam_entry_invite_v1(text,text)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('anon', 'public.omr_get_exam_entry_invite_metadata_v1(text,text,text)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('authenticated', 'public.omr_get_exam_entry_invite_metadata_v1(text,text,text)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('anon', 'public.omr_revoke_exam_entry_invite_v1(text,text,text)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('authenticated', 'public.omr_revoke_exam_entry_invite_v1(text,text,text)', 'EXECUTE')
        and pg_catalog.obj_description(
            'public.omr_rotate_exam_entry_invite_v1(text,text,text,text,timestamptz)'::pg_catalog.regprocedure,
            'pg_proc'
        ) = 'opaque-exam-entry-invite:202608060029'
        and pg_catalog.obj_description(
            'public.omr_resolve_exam_entry_invite_v1(text,text)'::pg_catalog.regprocedure,
            'pg_proc'
        ) = 'opaque-exam-entry-invite:202608060029'
        and pg_catalog.obj_description(
            pg_catalog.to_regprocedure('public.omr_get_exam_entry_invite_metadata_v1(text,text,text)'),
            'pg_proc'
        ) = 'metadata-only-exam-entry-invite-lifecycle:202608080011'
        and pg_catalog.obj_description(
            pg_catalog.to_regprocedure('public.omr_revoke_exam_entry_invite_v1(text,text,text)'),
            'pg_proc'
        ) = 'metadata-only-exam-entry-invite-lifecycle:202608080011';

    v_workspace_bootstrap_plan_safe :=
        pg_catalog.to_regprocedure('public.omr_bootstrap_workspace_organization_v1(text,text,jsonb,timestamptz)') is not null
        and pg_catalog.has_function_privilege('service_role', 'public.omr_bootstrap_workspace_organization_v1(text,text,jsonb,timestamptz)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('anon', 'public.omr_bootstrap_workspace_organization_v1(text,text,jsonb,timestamptz)', 'EXECUTE')
        and position(
            'plan = excluded.plan' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_bootstrap_workspace_organization_v1(text,text,jsonb,timestamptz)'::pg_catalog.regprocedure
            ))
        ) = 0;

    v_session_cleanup_optimization_ready :=
        pg_catalog.to_regclass('public.omr_attempt_sessions_expiry_gc_idx') is not null
        and pg_catalog.to_regclass('public.omr_attempt_sessions_terminal_gc_idx') is not null
        and pg_catalog.to_regclass('public.omr_remote_assets_handwriting_orphan_gc_idx') is not null
        and pg_catalog.to_regclass('public.omr_remote_asset_cleanup_org_status_idx') is not null
        and pg_catalog.to_regprocedure('public.omr_gc_attempt_sessions_v1(integer,integer)') is not null
        and pg_catalog.to_regprocedure('public.omr_requeue_dead_remote_asset_cleanup_v1(text,text,integer,text,text)') is not null
        and pg_catalog.has_function_privilege('service_role', 'public.omr_gc_attempt_sessions_v1(integer,integer)', 'EXECUTE')
        and pg_catalog.has_function_privilege('service_role', 'public.omr_requeue_dead_remote_asset_cleanup_v1(text,text,integer,text,text)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('anon', 'public.omr_gc_attempt_sessions_v1(integer,integer)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('authenticated', 'public.omr_gc_attempt_sessions_v1(integer,integer)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('anon', 'public.omr_requeue_dead_remote_asset_cleanup_v1(text,text,integer,text,text)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('authenticated', 'public.omr_requeue_dead_remote_asset_cleanup_v1(text,text,integer,text,text)', 'EXECUTE');

    v_session_cleanup_fencing_ready :=
        pg_catalog.to_regclass('public.omr_attempt_sessions_submitted_asset_guard_idx') is not null
        and exists (
            select 1
              from pg_catalog.pg_attribute attribute
             where attribute.attrelid = 'public.omr_remote_asset_cleanup_queue'::pg_catalog.regclass
               and attribute.attname = 'retry_count'
               and attribute.attnotnull
               and not attribute.attisdropped
        )
        and exists (
            select 1 from pg_catalog.pg_constraint constraint_row
             where constraint_row.conrelid = 'public.omr_remote_asset_cleanup_queue'::pg_catalog.regclass
               and constraint_row.conname = 'omr_remote_asset_cleanup_queue_retry_count_check'
               and constraint_row.contype = 'c' and constraint_row.convalidated
        )
        and position(
            'attempts = queue.attempts + 1' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_requeue_dead_remote_asset_cleanup_v1(text,text,integer,text,text)'::pg_catalog.regprocedure
            ))
        ) > 0
        and position(
            'retry_count = queue.retry_count + 1' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_claim_remote_asset_cleanup_v8_snapshot(text,integer,integer)'::pg_catalog.regprocedure
            ))
        ) > 0
        and position(
            'to_jsonb(claimed)' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_claim_remote_asset_cleanup_v8_snapshot(text,integer,integer)'::pg_catalog.regprocedure
            ))
        ) = 0
        and position(
            'omr_claim_remote_asset_cleanup_v8_snapshot' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_claim_remote_asset_cleanup_v1(text,integer,integer)'::pg_catalog.regprocedure
            ))
        ) > 0
        and position(
            'v_now := pg_catalog.clock_timestamp();' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_checkpoint_attempt_session_v1(text,text,text,bigint,bigint,text,jsonb,jsonb,jsonb,integer,boolean)'::pg_catalog.regprocedure
            ))
        ) > position(
            'for update;' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_checkpoint_attempt_session_v1(text,text,text,bigint,bigint,text,jsonb,jsonb,jsonb,integer,boolean)'::pg_catalog.regprocedure
            ))
        );

    v_attempt_checkpoint_null_cas_ready :=
        pg_catalog.obj_description(
            'public.omr_checkpoint_attempt_session_v1(text,text,text,bigint,bigint,text,jsonb,jsonb,jsonb,integer,boolean)'::pg_catalog.regprocedure,
            'pg_proc'
        ) = 'attempt-checkpoint-null-cas:202608060016;secure-submission-outbox-replay:202608060028;handwriting-takeover-checkpoint:202608060031'
        and position(
            'p_expected_revision is null' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_checkpoint_attempt_session_v1(text,text,text,bigint,bigint,text,jsonb,jsonb,jsonb,integer,boolean)'::pg_catalog.regprocedure
            ))
        ) > 0
        and position(
            'p_expected_lease_epoch is null' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_checkpoint_attempt_session_v1(text,text,text,bigint,bigint,text,jsonb,jsonb,jsonb,integer,boolean)'::pg_catalog.regprocedure
            ))
        ) > 0
        and position(
            'v_session.revision is distinct from p_expected_revision' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_checkpoint_attempt_session_v1(text,text,text,bigint,bigint,text,jsonb,jsonb,jsonb,integer,boolean)'::pg_catalog.regprocedure
            ))
        ) > 0
        and position(
            'v_session.lease_epoch is distinct from p_expected_lease_epoch' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_checkpoint_attempt_session_v1(text,text,text,bigint,bigint,text,jsonb,jsonb,jsonb,integer,boolean)'::pg_catalog.regprocedure
            ))
        ) > 0
        and position(
            'pg_column_size(v_handwriting_checkpoint) > 65536' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_checkpoint_attempt_session_v1(text,text,text,bigint,bigint,text,jsonb,jsonb,jsonb,integer,boolean)'::pg_catalog.regprocedure
            ))
        ) > 0
        and position(
            'v_session.progress_payload -> ''handwritingcheckpoint''' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_checkpoint_attempt_session_v1(text,text,text,bigint,bigint,text,jsonb,jsonb,jsonb,integer,boolean)'::pg_catalog.regprocedure
            ))
        ) > 0;

    v_operator_pilot_provisioning_ready :=
        pg_catalog.to_regclass('public.omr_pilot_plan_grants') is not null
        and pg_catalog.to_regprocedure(
            'public.omr_provision_pilot_teacher_v1(text,text,text,text,text,timestamptz,text,text,text)'
        ) is not null
        and pg_catalog.to_regprocedure(
            'public.omr_read_effective_workspace_plan_v1(text)'
        ) is not null
        and (
            select pg_catalog.count(*) = 2
               and pg_catalog.bool_and(
                   routine.prosecdef
                   and pg_catalog.pg_get_userbyid(routine.proowner) = 'postgres'
                   and routine.prokind = 'f'
                   and pg_catalog.pg_get_function_result(routine.oid) = 'jsonb'
                   and routine.proconfig @> array['search_path=""']::text[]
                   and case
                       when routine.proname = 'omr_provision_pilot_teacher_v1' then
                           routine.proconfig @> array[
                               'statement_timeout=10s', 'lock_timeout=3s'
                           ]::text[]
                       else routine.proconfig @> array['statement_timeout=5s']::text[]
                   end
                   and pg_catalog.has_function_privilege('service_role', routine.oid, 'EXECUTE')
                   and not pg_catalog.has_function_privilege('anon', routine.oid, 'EXECUTE')
                   and not pg_catalog.has_function_privilege('authenticated', routine.oid, 'EXECUTE')
               )
              from pg_catalog.pg_proc routine
              join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
             where namespace.nspname = 'public'
               and routine.proname in (
                   'omr_provision_pilot_teacher_v1',
                   'omr_read_effective_workspace_plan_v1'
               )
        )
        and pg_catalog.obj_description(
            'public.omr_provision_pilot_teacher_v1(text,text,text,text,text,timestamptz,text,text,text)'::pg_catalog.regprocedure,
            'pg_proc'
        ) = 'atomic-operator-pilot-teacher-provisioning:202608080006'
        and pg_catalog.obj_description(
            'public.omr_read_effective_workspace_plan_v1(text)'::pg_catalog.regprocedure,
            'pg_proc'
        ) like 'expiry-safe-effective-workspace-plan-read:202608080006;%'
        -- Exact PG17 catalog attestations prevent semantics-preserving token
        -- spoofing such as `expires_at > clock_timestamp() OR true`.
        and pg_catalog.encode(extensions.digest(pg_catalog.pg_get_functiondef(
            'public.omr_provision_pilot_teacher_v1(text,text,text,text,text,timestamptz,text,text,text)'::pg_catalog.regprocedure
        ), 'sha256'), 'hex') = '282a79ed02c1a3cfc927248cf554ff5ae64eb73b18b8b1f658396d466f884a46'
        and pg_catalog.encode(extensions.digest(pg_catalog.pg_get_functiondef(
            'public.omr_read_effective_workspace_plan_v1(text)'::pg_catalog.regprocedure
        ), 'sha256'), 'hex') = '778083d5e37553c1089bacc01839fd64f7fd2fe433d3b8bf11bdbc6f9cbe7201'
        and exists (
            select 1 from pg_catalog.pg_index index_record
             where index_record.indexrelid = pg_catalog.to_regclass(
                       'public.omr_pilot_plan_grants_one_current_org_idx'
                   )
               and index_record.indrelid = 'public.omr_pilot_plan_grants'::pg_catalog.regclass
               and index_record.indisvalid and index_record.indisready and index_record.indisunique
               and pg_catalog.encode(extensions.digest(
                   pg_catalog.pg_get_indexdef(index_record.indexrelid), 'sha256'
               ), 'hex') = '9e546425eaa75644fb8ee944062da143dad242f4424061910bee2fab4ea07670'
        )
        and exists (
            select 1 from pg_catalog.pg_index index_record
             where index_record.indexrelid = pg_catalog.to_regclass(
                       'public.omr_pilot_plan_grants_idempotency_hash_unique'
                   )
               and index_record.indrelid = 'public.omr_pilot_plan_grants'::pg_catalog.regclass
               and index_record.indisvalid and index_record.indisready and index_record.indisunique
               and pg_catalog.encode(extensions.digest(
                   pg_catalog.pg_get_indexdef(index_record.indexrelid), 'sha256'
               ), 'hex') = 'a28a831abf38473c8a7d6989749d298b2de2c6d7629fb08925c146a5c57e0bc1'
        )
        and (
            select pg_catalog.count(*) = 7
               and pg_catalog.encode(extensions.digest(pg_catalog.string_agg(
                   constraint_record.conname || '='
                       || pg_catalog.pg_get_constraintdef(constraint_record.oid, true),
                   E'\n' order by constraint_record.conname
               ), 'sha256'), 'hex') = '9b6c6c9153157a0f4eef095e5c1bbe3c31103c2322d80e8d306d46e8429f250e'
              from pg_catalog.pg_constraint constraint_record
             where constraint_record.conrelid = 'public.omr_pilot_plan_grants'::pg_catalog.regclass
               and constraint_record.conname in (
                   'omr_pilot_plan_grants_idempotency_hash_check',
                   'omr_pilot_plan_grants_request_hash_check',
                   'omr_pilot_plan_grants_plan_check',
                   'omr_pilot_plan_grants_state_check',
                   'omr_pilot_plan_grants_expiry_check',
                   'omr_pilot_plan_grants_superseded_check',
                   'omr_pilot_plan_grants_updated_check'
               )
        )
        and not pg_catalog.has_table_privilege(
            'service_role', 'public.omr_pilot_plan_grants',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
        )
        -- Academy teacher members: RPC-only ledger plus one audited gateway.
        and pg_catalog.to_regclass('public.omr_pilot_member_provisions') is not null
        and not pg_catalog.has_table_privilege(
            'service_role', 'public.omr_pilot_member_provisions',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
        )
        and exists (
            select 1 from pg_catalog.pg_index index_record
             where index_record.indexrelid = pg_catalog.to_regclass(
                       'public.omr_pilot_member_provisions_idempotency_hash_unique'
                   )
               and index_record.indrelid = 'public.omr_pilot_member_provisions'::pg_catalog.regclass
               and index_record.indisvalid and index_record.indisready and index_record.indisunique
        )
        and exists (
            select 1
              from pg_catalog.pg_proc routine
             where routine.oid = pg_catalog.to_regprocedure(
                       'public.omr_provision_pilot_org_teacher_v1(text,text,text,text,text,text,text)'
                   )
               and routine.prosecdef
               and routine.prokind = 'f'
               and pg_catalog.pg_get_userbyid(routine.proowner) = 'postgres'
               and pg_catalog.pg_get_function_result(routine.oid) = 'jsonb'
               and routine.proconfig @> array[
                   'search_path=""', 'statement_timeout=10s', 'lock_timeout=3s'
               ]::text[]
               and pg_catalog.has_function_privilege('service_role', routine.oid, 'EXECUTE')
               and not pg_catalog.has_function_privilege('anon', routine.oid, 'EXECUTE')
               and not pg_catalog.has_function_privilege('authenticated', routine.oid, 'EXECUTE')
               and pg_catalog.obj_description(routine.oid, 'pg_proc')
                   = 'atomic-operator-pilot-org-teacher-provisioning:202610020001'
               and pg_catalog.encode(extensions.digest(
                   pg_catalog.pg_get_functiondef(routine.oid), 'sha256'
               ), 'hex') = '4be105f115716a0cdc5bad391eee5c4bb1e1c1c12daa81e853ed851004e0a7de'
        );

    -- Pin the QA-only entry point as strictly as the paid provisioning RPC.
    v_operator_pilot_provisioning_ready := v_operator_pilot_provisioning_ready
        and exists (
            select 1 from pg_catalog.pg_proc routine
             where routine.oid = pg_catalog.to_regprocedure(
                 'public.omr_provision_qa_free_owner_v1(text,text,text,text,text,timestamptz,text,text,text)'
             )
               and routine.prosecdef
               and pg_catalog.pg_get_userbyid(routine.proowner) = 'postgres'
               and routine.proconfig @> array['search_path=""', 'statement_timeout=10s', 'lock_timeout=3s']::text[]
               and pg_catalog.has_function_privilege('service_role', routine.oid, 'EXECUTE')
               and not pg_catalog.has_function_privilege('anon', routine.oid, 'EXECUTE')
               and not pg_catalog.has_function_privilege('authenticated', routine.oid, 'EXECUTE')
               and pg_catalog.encode(extensions.digest(pg_catalog.pg_get_functiondef(routine.oid), 'sha256'), 'hex')
                   = '766fb182e56a451f61553fafd0a0a76ec83f4c30486a51e34e7056f54386c7c6'
        );

    -- Permanent demo creation/validation/revocation are separate, exactly attested operator boundaries.
    v_operator_pilot_provisioning_ready := v_operator_pilot_provisioning_ready
        and exists(select 1 from pg_catalog.pg_proc f where f.oid=pg_catalog.to_regprocedure('public.omr_read_demo_plan_v1(text)')
          and f.prosecdef and pg_catalog.pg_get_userbyid(f.proowner)='postgres'
          and f.proconfig @> array['search_path=""']::text[]
          and not pg_catalog.has_function_privilege('anon',f.oid,'EXECUTE')
          and not pg_catalog.has_function_privilege('authenticated',f.oid,'EXECUTE')
          and not pg_catalog.has_function_privilege('service_role',f.oid,'EXECUTE')
          and pg_catalog.encode(extensions.digest(pg_catalog.pg_get_functiondef(f.oid),'sha256'),'hex')='d4d9948707a7afe13507af781cea7765a6b11bd94fb04f5f5efdc5c4ecd06da5')
        and exists(select 1 from pg_catalog.pg_proc f where f.oid=pg_catalog.to_regprocedure('public.omr_lock_demo_identity_v1(text,bigint,text)')
          and f.prosecdef and pg_catalog.pg_get_userbyid(f.proowner)='postgres'
          and f.proconfig @> array['search_path=""']::text[]
          and not pg_catalog.has_function_privilege('anon',f.oid,'EXECUTE')
          and not pg_catalog.has_function_privilege('authenticated',f.oid,'EXECUTE')
          and not pg_catalog.has_function_privilege('service_role',f.oid,'EXECUTE')
          and pg_catalog.encode(extensions.digest(pg_catalog.pg_get_functiondef(f.oid),'sha256'),'hex')='37c358dd0aab50bb0b3569fb17359c0aa9fee69086c1bf0daaf3c26190dc80b2')
        and exists(select 1 from pg_catalog.pg_proc f where f.oid=pg_catalog.to_regprocedure('public.omr_revoke_demo_organization_v1(text,text,text,text)')
          and f.prosecdef and pg_catalog.pg_get_userbyid(f.proowner)='postgres'
          and f.proconfig @> array['search_path=""']::text[]
          and not pg_catalog.has_function_privilege('anon',f.oid,'EXECUTE')
          and not pg_catalog.has_function_privilege('authenticated',f.oid,'EXECUTE')
          and pg_catalog.has_function_privilege('service_role',f.oid,'EXECUTE')
          and pg_catalog.encode(extensions.digest(pg_catalog.pg_get_functiondef(f.oid),'sha256'),'hex')='3ea76d1a97f41b3186797b2bdbb83d08a1d4d8b219f8e90f105e8f8336dfa68b')
        and exists(select 1 from pg_catalog.pg_proc f where f.oid=pg_catalog.to_regprocedure('public.omr_provision_demo_account_v1(text,text,text,text,text,text,text,text,text,text,text)')
          and f.prosecdef and pg_catalog.pg_get_userbyid(f.proowner)='postgres'
          and f.proconfig @> array['search_path=""']::text[]
          and not pg_catalog.has_function_privilege('anon',f.oid,'EXECUTE')
          and not pg_catalog.has_function_privilege('authenticated',f.oid,'EXECUTE')
          and pg_catalog.has_function_privilege('service_role',f.oid,'EXECUTE')
          and pg_catalog.encode(extensions.digest(pg_catalog.pg_get_functiondef(f.oid),'sha256'),'hex')='8026fbf15b5e0ad6eaa6f39651ec559b69e040b6586b49301a84ba652bfe35be')
        and not pg_catalog.has_table_privilege('service_role','public.omr_demo_organizations','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
        and not pg_catalog.has_table_privilege('service_role','public.omr_demo_provisions','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN');

    v_provisioned_teacher_login_ready :=
        pg_catalog.to_regprocedure('public.omr_lookup_teacher_account_v1(text)') is not null
        and pg_catalog.to_regprocedure('public.omr_validate_teacher_session_v1(text,bigint)') is not null
        and pg_catalog.to_regprocedure('public.omr_begin_teacher_password_reset_v1(text,text,text,timestamptz)') is not null
        and pg_catalog.to_regprocedure('public.omr_complete_teacher_password_reset_v1(text,text)') is not null
        and pg_catalog.to_regprocedure('public.omr_lookup_provisioned_teacher_login_v1(text)') is not null
        and pg_catalog.to_regprocedure('public.omr_validate_provisioned_teacher_session_v1(text,bigint,text)') is not null
        and pg_catalog.to_regprocedure('public.omr_probe_provisioned_teacher_canary_v1(text)') is not null
        and (
            select pg_catalog.count(*) = 7
               and pg_catalog.bool_and(
                   routine.prosecdef
                   and routine.prokind = 'f'
                   and (
                       (routine.proname = 'omr_lookup_teacher_account_v1'
                        and pg_catalog.oidvectortypes(routine.proargtypes) = 'text')
                       or
                       (routine.proname = 'omr_validate_teacher_session_v1'
                        and pg_catalog.oidvectortypes(routine.proargtypes) = 'text, bigint')
                       or
                       (routine.proname = 'omr_begin_teacher_password_reset_v1'
                        and pg_catalog.oidvectortypes(routine.proargtypes) = 'text, text, text, timestamp with time zone')
                       or
                       (routine.proname = 'omr_complete_teacher_password_reset_v1'
                        and pg_catalog.oidvectortypes(routine.proargtypes) = 'text, text')
                       or
                       (routine.proname = 'omr_lookup_provisioned_teacher_login_v1'
                        and pg_catalog.oidvectortypes(routine.proargtypes) = 'text')
                       or
                       (routine.proname = 'omr_validate_provisioned_teacher_session_v1'
                        and pg_catalog.oidvectortypes(routine.proargtypes) = 'text, bigint, text')
                       or
                       (routine.proname = 'omr_probe_provisioned_teacher_canary_v1'
                        and pg_catalog.oidvectortypes(routine.proargtypes) = 'text')
                   )
                   and pg_catalog.pg_get_userbyid(routine.proowner) = 'postgres'
                   and (
                       (routine.proname in (
                           'omr_validate_teacher_session_v1',
                           'omr_begin_teacher_password_reset_v1',
                           'omr_complete_teacher_password_reset_v1'
                        ) and pg_catalog.pg_get_function_result(routine.oid) = 'boolean')
                       or
                       (routine.proname not in (
                           'omr_validate_teacher_session_v1',
                           'omr_begin_teacher_password_reset_v1',
                           'omr_complete_teacher_password_reset_v1'
                        ) and pg_catalog.pg_get_function_result(routine.oid) = 'jsonb')
                   )
                   and (
                       routine.proname <> 'omr_probe_provisioned_teacher_canary_v1'
                       or routine.provolatile = 's'
                   )
                   and routine.proconfig @> array[
                       'search_path=""', 'statement_timeout=5s', 'lock_timeout=2s'
                   ]::text[]
                   and pg_catalog.has_function_privilege('service_role', routine.oid, 'EXECUTE')
                   and not pg_catalog.has_function_privilege('anon', routine.oid, 'EXECUTE')
                   and not pg_catalog.has_function_privilege('authenticated', routine.oid, 'EXECUTE')
               )
              from pg_catalog.pg_proc routine
              join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
             where namespace.nspname = 'public'
               and routine.proname in (
                   'omr_lookup_teacher_account_v1',
                   'omr_validate_teacher_session_v1',
                   'omr_begin_teacher_password_reset_v1',
                   'omr_complete_teacher_password_reset_v1',
                   'omr_lookup_provisioned_teacher_login_v1',
                   'omr_validate_provisioned_teacher_session_v1',
                   'omr_probe_provisioned_teacher_canary_v1'
               )
        )
        and pg_catalog.obj_description(
            'public.omr_lookup_teacher_account_v1(text)'::pg_catalog.regprocedure,
            'pg_proc'
        ) = 'exact legacy self-service teacher account lookup envelope:202608080007'
        and pg_catalog.obj_description(
            'public.omr_validate_teacher_session_v1(text,bigint)'::pg_catalog.regprocedure,
            'pg_proc'
        ) = 'legacy self-service session validation excluding pilot provenance:202608080007'
        and pg_catalog.obj_description(
            'public.omr_begin_teacher_password_reset_v1(text,text,text,timestamptz)'::pg_catalog.regprocedure,
            'pg_proc'
        ) = 'legacy self-service password-reset ingress excluding pilot provenance:202608080007'
        and pg_catalog.obj_description(
            'public.omr_complete_teacher_password_reset_v1(text,text)'::pg_catalog.regprocedure,
            'pg_proc'
        ) = 'legacy self-service password-reset completion excluding pilot provenance:202608080007'
        and pg_catalog.obj_description(
            'public.omr_lookup_provisioned_teacher_login_v1(text)'::pg_catalog.regprocedure,
            'pg_proc'
        ) = 'exact provisioned teacher login binding:202608080007'
        and pg_catalog.obj_description(
            'public.omr_validate_provisioned_teacher_session_v1(text,bigint,text)'::pg_catalog.regprocedure,
            'pg_proc'
        ) = 'request-time provisioned teacher binding and entitlement validation:202608080007'
        and pg_catalog.obj_description(
            'public.omr_probe_provisioned_teacher_canary_v1(text)'::pg_catalog.regprocedure,
            'pg_proc'
        ) = 'side-effect-free exact provisioned teacher release canary:202608080007'
        and pg_catalog.encode(extensions.digest(pg_catalog.pg_get_functiondef(
            'public.omr_lookup_teacher_account_v1(text)'::pg_catalog.regprocedure
        ), 'sha256'), 'hex') = '943ebd34f874b92c32b80ad32dfa9a8c82d333a38a8a778a563158c664298f06'
        and pg_catalog.encode(extensions.digest(pg_catalog.pg_get_functiondef(
            'public.omr_validate_teacher_session_v1(text,bigint)'::pg_catalog.regprocedure
        ), 'sha256'), 'hex') = '2b07eb8fd3708b470a159ad031d542e78dea0ec19810c8ab478632159a927850'
        and pg_catalog.encode(extensions.digest(pg_catalog.pg_get_functiondef(
            'public.omr_begin_teacher_password_reset_v1(text,text,text,timestamptz)'::pg_catalog.regprocedure
        ), 'sha256'), 'hex') = '3b93c38fa98fb897274fc7f6ead886d18eb692d49f542a84c652a6bdf4aa8953'
        and pg_catalog.encode(extensions.digest(pg_catalog.pg_get_functiondef(
            'public.omr_complete_teacher_password_reset_v1(text,text)'::pg_catalog.regprocedure
        ), 'sha256'), 'hex') = 'ff66b8dd21859d592db7caac040b883f0b521821af5a0bc6149e528ba000e55c'
        and pg_catalog.encode(extensions.digest(pg_catalog.pg_get_functiondef(
            'public.omr_lookup_provisioned_teacher_login_v1(text)'::pg_catalog.regprocedure
        ), 'sha256'), 'hex') = '9efc7745af6c20181ce1cc1a219bcb72f8d69c1813c5d3f3d7ad8239a726722c'
        and pg_catalog.encode(extensions.digest(pg_catalog.pg_get_functiondef(
            'public.omr_validate_provisioned_teacher_session_v1(text,bigint,text)'::pg_catalog.regprocedure
        ), 'sha256'), 'hex') = '25d78d77d24aff14c38a4d93c5a52e4b6aeb58a5e9e1ef9dbda84514cf341d56'
        and pg_catalog.encode(extensions.digest(pg_catalog.pg_get_functiondef(
            'public.omr_probe_provisioned_teacher_canary_v1(text)'::pg_catalog.regprocedure
        ), 'sha256'), 'hex') = 'ce443ff814669bed63aa3e2bce01cb7ebd9b6d33d45973fbed2e9f06307c2a42';

    v_teacher_live_sessions_ready :=
        pg_catalog.to_regclass('public.omr_attempt_sessions_teacher_live_idx') is not null
        and pg_catalog.to_regprocedure(
            'public.omr_list_active_attempt_sessions_v1(text,text,text,text,integer)'
        ) is not null
        and pg_catalog.to_regprocedure(
            'public.omr_prepare_teacher_force_finish_sessions_v1(text,text[],text,text)'
        ) is not null
        and pg_catalog.to_regprocedure(
            'public.omr_force_finish_attempt_sessions_v1(text,text[],timestamptz,text,text,text,jsonb)'
        ) is not null
        and pg_catalog.to_regprocedure(
            'public.omr_prepare_teacher_force_finish_sessions_compact_v1(text,text[],text,text)'
        ) is not null
        and pg_catalog.to_regprocedure(
            'public.omr_force_finish_attempt_sessions_compact_v1(text,text[],timestamptz,text,text,text,jsonb)'
        ) is not null
        and pg_catalog.to_regprocedure(
            'public.omr_teacher_force_finish_fingerprint_v1(bigint,jsonb,jsonb,integer[],jsonb)'
        ) is not null
        and pg_catalog.obj_description(
            'public.omr_list_active_attempt_sessions_v1(text,text,text,text,integer)'::pg_catalog.regprocedure,
            'pg_proc'
        ) = 'teacher-live-session-projection:202608060020'
        and pg_catalog.obj_description(
            'public.omr_prepare_teacher_force_finish_sessions_v1(text,text[],text,text)'::pg_catalog.regprocedure,
            'pg_proc'
        ) = 'teacher-live-session-force-finish-prepare:202608060023'
        and pg_catalog.obj_description(
            'public.omr_force_finish_attempt_sessions_v1(text,text[],timestamptz,text,text,text,jsonb)'::pg_catalog.regprocedure,
            'pg_proc'
        ) = 'teacher-live-session-force-finish:202608060023'
        and pg_catalog.obj_description(
            'public.omr_prepare_teacher_force_finish_sessions_compact_v1(text,text[],text,text)'::pg_catalog.regprocedure,
            'pg_proc'
        ) = 'teacher-live-session-force-finish-compact-prepare:202608060024'
        and pg_catalog.obj_description(
            'public.omr_force_finish_attempt_sessions_compact_v1(text,text[],timestamptz,text,text,text,jsonb)'::pg_catalog.regprocedure,
            'pg_proc'
        ) = 'teacher-live-session-force-finish-compact:202608060024'
        and pg_catalog.has_function_privilege(
            'service_role',
            'public.omr_list_active_attempt_sessions_v1(text,text,text,text,integer)',
            'EXECUTE'
        )
        and pg_catalog.has_function_privilege(
            'service_role',
            'public.omr_prepare_teacher_force_finish_sessions_v1(text,text[],text,text)',
            'EXECUTE'
        )
        and pg_catalog.has_function_privilege(
            'service_role',
            'public.omr_force_finish_attempt_sessions_v1(text,text[],timestamptz,text,text,text,jsonb)',
            'EXECUTE'
        )
        and pg_catalog.has_function_privilege(
            'service_role',
            'public.omr_prepare_teacher_force_finish_sessions_compact_v1(text,text[],text,text)',
            'EXECUTE'
        )
        and pg_catalog.has_function_privilege(
            'service_role',
            'public.omr_force_finish_attempt_sessions_compact_v1(text,text[],timestamptz,text,text,text,jsonb)',
            'EXECUTE'
        )
        and not exists (
            select 1
              from pg_catalog.pg_proc routine
              join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
             where namespace.nspname = 'public'
               and routine.proname in (
                   'omr_list_active_attempt_sessions_v1',
                   'omr_prepare_teacher_force_finish_sessions_v1',
                   'omr_force_finish_attempt_sessions_v1',
                   'omr_prepare_teacher_force_finish_sessions_compact_v1',
                   'omr_force_finish_attempt_sessions_compact_v1',
                   'omr_teacher_force_finish_fingerprint_v1'
               )
               and (
                   pg_catalog.has_function_privilege('anon', routine.oid, 'EXECUTE')
                   or pg_catalog.has_function_privilege('authenticated', routine.oid, 'EXECUTE')
               )
        )
        and position(
            'grading_snapshot' in lower(pg_catalog.pg_get_function_result(
                'public.omr_list_active_attempt_sessions_v1(text,text,text,text,integer)'::pg_catalog.regprocedure
            ))
        ) = 0
        and position(
            'expected_fingerprint' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_force_finish_attempt_sessions_v1(text,text[],timestamptz,text,text,text,jsonb)'::pg_catalog.regprocedure
            ))
        ) > 0
        and position(
            'with gradings as materialized' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_force_finish_attempt_sessions_v1(text,text[],timestamptz,text,text,text,jsonb)'::pg_catalog.regprocedure
            ))
        ) > 0
        and position(
            'with ordinality' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_force_finish_attempt_sessions_v1(text,text[],timestamptz,text,text,text,jsonb)'::pg_catalog.regprocedure
            ))
        ) > 0
        and not pg_catalog.has_function_privilege(
            'service_role',
            'public.omr_teacher_force_finish_fingerprint_v1(bigint,jsonb,jsonb,integer[],jsonb)',
            'EXECUTE'
        )
        and position(
            'expected_grading_snapshot' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_force_finish_attempt_sessions_v1(text,text[],timestamptz,text,text,text,jsonb)'::pg_catalog.regprocedure
            ))
        ) > 0
        and position(
            'for update' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_force_finish_attempt_sessions_v1(text,text[],timestamptz,text,text,text,jsonb)'::pg_catalog.regprocedure
            ))
        ) > 0
        and position(
            'p_expectations' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_force_finish_attempt_sessions_compact_v1(text,text[],timestamptz,text,text,text,jsonb)'::pg_catalog.regprocedure
            ))
        ) > 0
        and position(
            'with canonical_questions as materialized' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_force_finish_attempt_sessions_compact_v1(text,text[],timestamptz,text,text,text,jsonb)'::pg_catalog.regprocedure
            ))
        ) > 0
        and position(
            'omr_submit_session_attempt_v1' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_force_finish_attempt_sessions_compact_v1(text,text[],timestamptz,text,text,text,jsonb)'::pg_catalog.regprocedure
            ))
        ) > 0;

    v_teacher_account_lifecycle_ready :=
        pg_catalog.to_regclass('public.omr_teacher_accounts') is not null
        and pg_catalog.to_regclass('public.omr_teacher_account_tokens') is not null
        and exists (
            select 1
              from pg_catalog.pg_class relation
             where relation.oid = 'public.omr_teacher_accounts'::pg_catalog.regclass
               and relation.relrowsecurity and relation.relforcerowsecurity
        )
        and exists (
            select 1
              from pg_catalog.pg_class relation
             where relation.oid = 'public.omr_teacher_account_tokens'::pg_catalog.regclass
               and relation.relrowsecurity and relation.relforcerowsecurity
        )
        and not pg_catalog.has_table_privilege(
            'service_role', 'public.omr_teacher_accounts',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
        )
        and not pg_catalog.has_table_privilege(
            'service_role', 'public.omr_teacher_account_tokens',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
        )
        and not pg_catalog.has_table_privilege(
            'anon', 'public.omr_teacher_accounts', 'SELECT,INSERT,UPDATE,DELETE'
        )
        and not pg_catalog.has_table_privilege(
            'authenticated', 'public.omr_teacher_accounts', 'SELECT,INSERT,UPDATE,DELETE'
        )
        and not pg_catalog.has_table_privilege(
            'anon', 'public.omr_teacher_account_tokens', 'SELECT,INSERT,UPDATE,DELETE'
        )
        and not pg_catalog.has_table_privilege(
            'authenticated', 'public.omr_teacher_account_tokens', 'SELECT,INSERT,UPDATE,DELETE'
        )
        and (
            select count(*) = 6
              from pg_catalog.pg_proc routine
              join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
             where namespace.nspname = 'public'
               and routine.proname in (
                   'omr_begin_teacher_signup_v1',
                   'omr_begin_teacher_password_reset_v1',
                   'omr_complete_teacher_password_reset_v1',
                   'omr_verify_teacher_email_v1',
                   'omr_lookup_teacher_account_v1',
                   'omr_validate_teacher_session_v1'
               )
               and pg_catalog.has_function_privilege('service_role', routine.oid, 'EXECUTE')
               and not pg_catalog.has_function_privilege('anon', routine.oid, 'EXECUTE')
               and not pg_catalog.has_function_privilege('authenticated', routine.oid, 'EXECUTE')
        )
        and position(
            'for update skip locked' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_complete_teacher_password_reset_v1(text,text)'::pg_catalog.regprocedure
            ))
        ) > 0
        and position(
            'for update skip locked' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_verify_teacher_email_v1(text)'::pg_catalog.regprocedure
            ))
        ) > 0
        and exists (
            select 1
              from pg_catalog.pg_attribute attribute
             where attribute.attrelid = 'public.omr_teacher_accounts'::pg_catalog.regclass
               and attribute.attname = 'session_generation'
               and attribute.attnotnull
               and not attribute.attisdropped
        )
        and exists (
            select 1
              from pg_catalog.pg_constraint constraint_row
             where constraint_row.conrelid = 'public.omr_teacher_accounts'::pg_catalog.regclass
               and constraint_row.conname = 'omr_teacher_accounts_session_generation_check'
               and constraint_row.contype = 'c'
               and constraint_row.convalidated
        )
        and exists (
            select 1
              from pg_catalog.pg_trigger trigger_row
             where trigger_row.tgrelid = 'public.omr_teacher_accounts'::pg_catalog.regclass
               and trigger_row.tgname = 'omr_teacher_accounts_advance_session_on_disable'
               and not trigger_row.tgisinternal
               and trigger_row.tgenabled <> 'D'
        )
        and position(
            'session_generation = account.session_generation + 1' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_complete_teacher_password_reset_v1(text,text)'::pg_catalog.regprocedure
            ))
        ) > 0
        and position(
            'account.session_generation = p_session_generation' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_validate_teacher_session_v1(text,bigint)'::pg_catalog.regprocedure
            ))
        ) > 0
        and not pg_catalog.has_function_privilege(
            'service_role',
            'public.omr_advance_teacher_session_on_disable_v1()',
            'EXECUTE'
        );

    v_initial_operations_load_control_ready :=
        pg_catalog.to_regclass('public.omr_initial_ops_metrics') is not null
        and exists (
            select 1
              from pg_catalog.pg_class relation
             where relation.oid = 'public.omr_initial_ops_metrics'::pg_catalog.regclass
               and relation.relrowsecurity and relation.relforcerowsecurity
        )
        and not pg_catalog.has_table_privilege(
            'service_role', 'public.omr_initial_ops_metrics',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
        )
        and pg_catalog.to_regprocedure(
            'public.omr_initial_ops_fixture_v1(text,text,text,text,text)'
        ) is not null
        and pg_catalog.to_regprocedure(
            'public.omr_initial_ops_database_snapshot_v1(text,text,text,text,text)'
        ) is not null
        and pg_catalog.obj_description(
            'public.omr_initial_ops_fixture_v1(text,text,text,text,text)'::pg_catalog.regprocedure,
            'pg_proc'
        ) = 'initial-operations-phase-c-identity-and-production-coverage:202608080008'
        and pg_catalog.obj_description(
            'public.omr_initial_ops_database_snapshot_v1(text,text,text,text,text)'::pg_catalog.regprocedure,
            'pg_proc'
        ) = 'initial-operations-phase-c-identity-and-production-coverage:202608080008'
        and pg_catalog.has_function_privilege(
            'service_role', 'public.omr_initial_ops_fixture_v1(text,text,text,text,text)', 'EXECUTE'
        )
        and pg_catalog.has_function_privilege(
            'service_role', 'public.omr_initial_ops_database_snapshot_v1(text,text,text,text,text)', 'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
            'service_role', 'public.omr_initial_ops_reserve_upload_v1(text,text,text,text,text,text,bigint)', 'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
            'service_role', 'public.omr_initial_ops_operation_v1(text,text,text,text,text,text,jsonb)', 'EXECUTE'
        )
        and not exists (
            select 1
              from pg_catalog.pg_proc routine
              join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
             where namespace.nspname = 'public'
               and routine.proname in (
                   'omr_initial_ops_fixture_v1',
                   'omr_initial_ops_reserve_upload_v1',
                   'omr_initial_ops_operation_v1',
                   'omr_initial_ops_database_snapshot_v1'
               )
               and (
                   pg_catalog.has_function_privilege('anon', routine.oid, 'EXECUTE')
                   or pg_catalog.has_function_privilege('authenticated', routine.oid, 'EXECUTE')
               )
        )
        and position(
            'productionworkloadpaths' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_initial_ops_database_snapshot_v1(text,text,text,text,text)'::pg_catalog.regprocedure
            ))
        ) > 0
        and position(
            'omr_open_attempt_session_v3' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_initial_ops_database_snapshot_v1(text,text,text,text,text)'::pg_catalog.regprocedure
            ))
        ) > 0
        and position(
            'omr_finalize_teacher_asset_upload_v2' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_initial_ops_database_snapshot_v1(text,text,text,text,text)'::pg_catalog.regprocedure
            ))
        ) > 0
        and position(
            'query ilike ''%omr_initial_ops_%''' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_initial_ops_database_snapshot_v1(text,text,text,text,text)'::pg_catalog.regprocedure
            ))
        ) = 0
        and position(
            'finalize_cleanup' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_initial_ops_fixture_v1(text,text,text,text,text)'::pg_catalog.regprocedure
            ))
        ) > 0
        and position(
            '''teacheridentity''' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_initial_ops_fixture_v1(text,text,text,text,text)'::pg_catalog.regprocedure
            ))
        ) > 0
        and not pg_catalog.has_function_privilege(
            'service_role',
            'public.omr_initial_ops_fixture_v26_snapshot(text,text,text,text,text)',
            'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
            'service_role',
            'public.omr_initial_ops_database_snapshot_v26_snapshot(text,text,text,text,text)',
            'EXECUTE'
        )
        and (
            select pg_catalog.count(*) = 4
               and encode(extensions.digest(
                    'phase-c-initial-ops-identity-and-v2-paths:202608080008'
                    || pg_catalog.chr(10)
                    || pg_catalog.string_agg(
                        routine.proname || pg_catalog.chr(31)
                        || pg_catalog.pg_get_function_identity_arguments(routine.oid)
                        || pg_catalog.chr(31)
                        || pg_catalog.pg_get_function_result(routine.oid)
                        || pg_catalog.chr(31)
                        || pg_catalog.pg_get_userbyid(routine.proowner)
                        || pg_catalog.chr(31) || routine.prosecdef::text
                        || pg_catalog.chr(31) || routine.provolatile::text
                        || pg_catalog.chr(31)
                        || coalesce(pg_catalog.array_to_string(routine.proconfig, pg_catalog.chr(30)), '')
                        || pg_catalog.chr(31)
                        || coalesce(pg_catalog.obj_description(routine.oid, 'pg_proc'), '')
                        || pg_catalog.chr(31)
                        || pg_catalog.pg_get_functiondef(routine.oid),
                        pg_catalog.chr(10) order by routine.proname
                    ),
                    'sha256'
                ), 'hex') = 'ac8aef94e7e0edd577a4077c4727f44e8af4db6c421796bed385fcc9d48ff576'
              from pg_catalog.pg_proc routine
              join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
             where namespace.nspname = 'public'
               and routine.proname in (
                   'omr_initial_ops_fixture_v1',
                   'omr_initial_ops_database_snapshot_v1',
                   'omr_initial_ops_fixture_v26_snapshot',
                   'omr_initial_ops_database_snapshot_v26_snapshot'
               )
        );

    v_roster_snapshot_cas_ready :=
        pg_catalog.to_regprocedure('public.omr_load_roster_v2(text)') is not null
        and pg_catalog.to_regprocedure(
            'public.omr_save_roster_v3(text,text,bigint,text,text,jsonb,jsonb,jsonb,jsonb,bigint)'
        ) is not null
        and coalesce(pg_catalog.has_function_privilege(
            'service_role',
            pg_catalog.to_regprocedure('public.omr_load_roster_v2(text)'),
            'EXECUTE'
        ), false)
        and coalesce(pg_catalog.has_function_privilege(
            'service_role',
            pg_catalog.to_regprocedure(
                'public.omr_save_roster_v3(text,text,bigint,text,text,jsonb,jsonb,jsonb,jsonb,bigint)'
            ),
            'EXECUTE'
        ), false)
        and not pg_catalog.has_function_privilege('service_role', 'public.omr_save_roster_v1(text,jsonb,jsonb,jsonb,jsonb)', 'EXECUTE')
        and not coalesce(pg_catalog.has_function_privilege(
            'anon', pg_catalog.to_regprocedure('public.omr_load_roster_v2(text)'), 'EXECUTE'
        ), false)
        and not coalesce(pg_catalog.has_function_privilege(
            'authenticated', pg_catalog.to_regprocedure('public.omr_load_roster_v2(text)'), 'EXECUTE'
        ), false)
        and not coalesce(pg_catalog.has_function_privilege(
            'anon',
            pg_catalog.to_regprocedure(
                'public.omr_save_roster_v3(text,text,bigint,text,text,jsonb,jsonb,jsonb,jsonb,bigint)'
            ),
            'EXECUTE'
        ), false)
        and not coalesce(pg_catalog.has_function_privilege(
            'authenticated',
            pg_catalog.to_regprocedure(
                'public.omr_save_roster_v3(text,text,bigint,text,text,jsonb,jsonb,jsonb,jsonb,bigint)'
            ),
            'EXECUTE'
        ), false);

    select count(*) = 4
       and coalesce(bool_and(
            pg_catalog.obj_description(routine.oid, 'pg_proc') = 'attempt-mutation-null-cas:202608060018'
            and position('p_expected_lease_epoch is null' in lower(pg_catalog.pg_get_functiondef(routine.oid))) > 0
            and position('9007199254740991' in lower(pg_catalog.pg_get_functiondef(routine.oid))) > 0
            and position('nullif(pg_catalog.btrim(' in lower(pg_catalog.pg_get_functiondef(routine.oid))) > 0
            and position('v_session.lease_epoch is distinct from p_expected_lease_epoch' in lower(pg_catalog.pg_get_functiondef(routine.oid))) > 0
            and position('p_expected_lease_epoch is null' in lower(pg_catalog.pg_get_functiondef(routine.oid)))
                < position('for update;' in lower(pg_catalog.pg_get_functiondef(routine.oid)))
        ), false)
      into v_attempt_mutation_cas_ready
      from pg_catalog.pg_proc routine
      join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
     where namespace.nspname = 'public'
       and routine.proname in (
           'omr_heartbeat_attempt_session_v1',
           'omr_takeover_attempt_session_v1',
           'omr_prepare_attempt_session_submit_v1',
           'omr_commit_attempt_session_submit_v1'
       );
    v_attempt_mutation_cas_ready := v_attempt_mutation_cas_ready
        and not exists (
            select 1
              from pg_catalog.pg_proc routine
              join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
             where namespace.nspname = 'public'
               and routine.proname in (
                   'omr_takeover_attempt_session_v1',
                   'omr_prepare_attempt_session_submit_v1',
                   'omr_commit_attempt_session_submit_v1'
               )
               and (
                   position('p_expected_revision is null' in lower(pg_catalog.pg_get_functiondef(routine.oid))) = 0
                   or position('v_session.revision is distinct from p_expected_revision' in lower(pg_catalog.pg_get_functiondef(routine.oid))) = 0
                   or position('p_expected_revision is null' in lower(pg_catalog.pg_get_functiondef(routine.oid)))
                        > position('for update;' in lower(pg_catalog.pg_get_functiondef(routine.oid)))
               )
        );

    v_exam_delete_session_safe :=
        pg_catalog.obj_description(
            'public.omr_delete_exam_v1(text,text)'::pg_catalog.regprocedure,
            'pg_proc'
        ) = 'exam-delete-session-safe:202608060018'
        and position(
            'perform public.omr_enqueue_exam_asset_cleanup_v1' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_delete_exam_v1(text,text)'::pg_catalog.regprocedure
            ))
        ) < position(
            'delete from public.omr_attempt_sessions' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_delete_exam_v1(text,text)'::pg_catalog.regprocedure
            ))
        )
        and position(
            'delete from public.omr_attempt_sessions' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_delete_exam_v1(text,text)'::pg_catalog.regprocedure
            ))
        ) < position(
            'delete from public.omr_attempts' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_delete_exam_v1(text,text)'::pg_catalog.regprocedure
            ))
        );

    v_student_question_atomic_ready :=
        pg_catalog.to_regprocedure(
            'public.omr_upsert_student_attempt_question_v1(text,text,text,bigint,text,text)'
        ) is not null
        and pg_catalog.obj_description(
            'public.omr_upsert_student_attempt_question_v1(text,text,text,bigint,text,text)'::pg_catalog.regprocedure,
            'pg_proc'
        ) = 'student-question-atomic:202608060019'
        and pg_catalog.has_function_privilege(
            'service_role',
            'public.omr_upsert_student_attempt_question_v1(text,text,text,bigint,text,text)',
            'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
            'anon',
            'public.omr_upsert_student_attempt_question_v1(text,text,text,bigint,text,text)',
            'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
            'authenticated',
            'public.omr_upsert_student_attempt_question_v1(text,text,text,bigint,text,text)',
            'EXECUTE'
        )
        and position(
            'for update;' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_upsert_student_attempt_question_v1(text,text,text,bigint,text,text)'::pg_catalog.regprocedure
            ))
        ) > 0
        and position(
            'jsonb_set(' in lower(pg_catalog.pg_get_functiondef(
                'public.omr_upsert_student_attempt_question_v1(text,text,text,bigint,text,text)'::pg_catalog.regprocedure
            ))
        ) > 0;

    v_individual_student_assignments_ready :=
        pg_catalog.to_regclass('public.omr_assignments_targeted_exam_idx') is not null
        and pg_catalog.to_regclass('public.omr_assignment_targets_active_student_idx') is not null
        and pg_catalog.to_regclass('public.omr_assignment_targets_retake_source_idx') is not null
        and pg_catalog.to_regclass('public.omr_attempts_student_exam_base_completed_idx') is not null
        and pg_catalog.to_regprocedure(
            'public.omr_assign_students_v2(text,text,bigint,text,text,text,text,text[],text,bigint,text)'
        ) is not null
        and pg_catalog.to_regprocedure(
            'public.omr_clear_student_assignment_v2(text,text,bigint,text,text,text,text,bigint,text,text[],text)'
        ) is not null
        and pg_catalog.to_regprocedure(
            'public.omr_load_teacher_student_assignment_v1(text,text,text,text)'
        ) is not null
        and pg_catalog.to_regprocedure(
            'public.omr_list_student_assignments_v1(text,text,text,text,text)'
        ) is not null
        and pg_catalog.to_regprocedure(
            'public.omr_resolve_student_assignment_v1(text,text,text,text,text,text,text)'
        ) is not null
        and not exists (
            select 1
              from pg_catalog.pg_proc routine
              join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
             where namespace.nspname = 'public'
               and routine.proname in (
                   'omr_assign_students_v2',
                   'omr_clear_student_assignment_v2',
                   'omr_load_teacher_student_assignment_v1',
                   'omr_list_student_assignments_v1',
                   'omr_resolve_student_assignment_v1'
               )
               and (
                   not pg_catalog.has_function_privilege('service_role', routine.oid, 'EXECUTE')
                   or pg_catalog.has_function_privilege('anon', routine.oid, 'EXECUTE')
                   or pg_catalog.has_function_privilege('authenticated', routine.oid, 'EXECUTE')
               )
        )
        and exists (
            select 1 from pg_catalog.pg_trigger trigger_row
             where trigger_row.tgrelid = 'public.omr_attempt_sessions'::pg_catalog.regclass
               and trigger_row.tgname = 'omr_attempt_session_target_guard'
               and trigger_row.tgenabled <> 'D'
               and not trigger_row.tgisinternal
        )
        and exists (
            select 1 from pg_catalog.pg_trigger trigger_row
             where trigger_row.tgrelid = 'public.omr_attempts'::pg_catalog.regclass
               and trigger_row.tgname = 'omr_attempt_target_guard'
               and trigger_row.tgenabled <> 'D'
               and not trigger_row.tgisinternal
        )
        and exists (
            select 1 from pg_catalog.pg_trigger trigger_row
             where trigger_row.tgrelid = 'public.omr_exams'::pg_catalog.regclass
               and trigger_row.tgname = 'omr_exam_targeted_access_guard'
               and trigger_row.tgenabled <> 'D'
               and not trigger_row.tgisinternal
        )
        and not exists (
            select 1
              from pg_catalog.unnest(array[
                  'public.omr_assert_targeted_assignment_scope_v1(text,text,text,text,text,text,integer[])',
                  'public.omr_validate_targeted_attempt_session_v1()',
                  'public.omr_validate_targeted_attempt_v1()',
                  'public.omr_guard_targeted_exam_access_v1()'
              ]) as private_helper(signature)
             where pg_catalog.to_regprocedure(private_helper.signature) is null
                or coalesce(pg_catalog.has_function_privilege(
                    'service_role',
                    pg_catalog.to_regprocedure(private_helper.signature),
                    'EXECUTE'
                ), false)
                or coalesce(pg_catalog.has_function_privilege(
                    'anon',
                    pg_catalog.to_regprocedure(private_helper.signature),
                    'EXECUTE'
                ), false)
                or coalesce(pg_catalog.has_function_privilege(
                    'authenticated',
                    pg_catalog.to_regprocedure(private_helper.signature),
                    'EXECUTE'
                ), false)
        );

    v_teacher_attempt_reporting_ready :=
        pg_catalog.to_regclass('public.omr_attempts_org_completed_finished_desc_idx') is not null
        and pg_catalog.to_regclass('public.omr_attempts_org_exam_completed_finished_desc_idx') is not null
        and pg_catalog.to_regprocedure(
            'public.omr_teacher_attempt_aggregate_v1(text,text,timestamptz,timestamptz)'
        ) is not null
        and pg_catalog.to_regprocedure(
            'public.omr_teacher_attempt_export_page_v1(text,text,timestamptz,timestamptz,text,integer)'
        ) is not null
        and pg_catalog.to_regprocedure(
            'public.omr_teacher_attempt_export_v1(text,text,integer)'
        ) is not null
        and not exists (
            select 1
              from pg_catalog.pg_proc routine
              join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
             where namespace.nspname = 'public'
               and routine.proname in (
                   'omr_teacher_attempt_aggregate_v1',
                   'omr_teacher_attempt_export_v1',
                   'omr_teacher_attempt_export_page_v1'
               )
               and (
                   not pg_catalog.has_function_privilege('service_role', routine.oid, 'EXECUTE')
                   or pg_catalog.has_function_privilege('anon', routine.oid, 'EXECUTE')
                   or pg_catalog.has_function_privilege('authenticated', routine.oid, 'EXECUTE')
               )
        )
        and position(
            '(attempt.finished_at, attempt.id) <' in pg_catalog.pg_get_functiondef(
                'public.omr_teacher_attempt_export_page_v1(text,text,timestamptz,timestamptz,text,integer)'::pg_catalog.regprocedure
            )
        ) > 0
        and position(
            'p_limit > 500' in pg_catalog.pg_get_functiondef(
                'public.omr_teacher_attempt_export_page_v1(text,text,timestamptz,timestamptz,text,integer)'::pg_catalog.regprocedure
            )
        ) > 0
        and position(
            'limit p_limit + 1' in pg_catalog.pg_get_functiondef(
                'public.omr_teacher_attempt_export_v1(text,text,integer)'::pg_catalog.regprocedure
            )
        ) > 0
        and position(
            'jsonb_agg' in pg_catalog.pg_get_functiondef(
                'public.omr_teacher_attempt_export_v1(text,text,integer)'::pg_catalog.regprocedure
            )
        ) > 0;

    with expected(name, args, result, exposure) as (values
        ('omr_save_roster_v3', 'text, text, bigint, text, text, jsonb, jsonb, jsonb, jsonb, bigint', 'jsonb', 'public'),
        ('omr_save_exam_v3', 'text, text, bigint, text, jsonb, jsonb, jsonb, bigint, text', 'jsonb', 'public'),
        ('omr_save_feedback_v4', 'text, text, bigint, text, text, jsonb, bigint, text', 'jsonb', 'public'),
        ('omr_return_feedback_v4', 'text, text, bigint, text, text, text, bigint, text', 'jsonb', 'public'),
        ('omr_assign_students_v2', 'text, text, bigint, text, text, text, text, text[], text, bigint, text', 'jsonb', 'public'),
        ('omr_clear_student_assignment_v2', 'text, text, bigint, text, text, text, text, bigint, text, text[], text', 'jsonb', 'public'),
        ('omr_open_attempt_session_v3', 'text, text, text, text, bigint, text, text, text, text, text, text, text, integer[], integer[], timestamp with time zone, jsonb, integer, timestamp with time zone, text, text, integer', 'jsonb', 'public'),
        ('omr_prepare_teacher_asset_upload_v2', 'text, text, bigint, text, text, jsonb', 'jsonb', 'public'),
        ('omr_authorize_teacher_asset_finalize_v2', 'text, text, bigint, text, text, text, jsonb', 'jsonb', 'public'),
        ('omr_finalize_teacher_asset_upload_v2', 'text, text, bigint, text, text, text, jsonb', 'jsonb', 'public'),
        ('omr_prepare_attempt_handwriting_asset_v2', 'text, text, text, jsonb', 'jsonb', 'public'),
        ('omr_attach_attempt_handwriting_v2', 'text, text, text, text, text', 'jsonb', 'public'),
        ('omr_claim_remote_asset_cleanup_v1', 'text, integer, integer', 'jsonb', 'public'),
        ('omr_reserve_plan_usage_v2', 'text, text, bigint, text, text, text, text', 'jsonb', 'public'),
        ('omr_release_plan_usage_v2', 'text, text, bigint, text, text, text, text', 'jsonb', 'public'),
        ('omr_sync_student_plan_usage_v2', 'text, text, bigint, text, text', 'jsonb', 'public'),
        ('omr_lock_provisioned_teacher_identity_v1', 'text, bigint, text', 'jsonb', 'private'),
        ('omr_authorize_effective_teacher_plan_v1', 'text, text', 'jsonb', 'private'),
        ('omr_read_effective_organization_plan_v1', 'text', 'jsonb', 'private'),
        ('omr_set_effective_plan_transaction_proof_v1', 'text, jsonb', 'void', 'private'),
        ('omr_prove_effective_organization_plan_v1', 'text', 'jsonb', 'private'),
        ('omr_assert_effective_plan_transaction_proof_v1', 'text, boolean', 'void', 'private'),
        ('omr_lock_legacy_teacher_identity_v1', 'text, bigint, text, text', 'jsonb', 'private'),
        ('omr_read_legacy_teacher_plan_v1', 'text, text, text', 'jsonb', 'private'),
        ('omr_lock_teacher_mutation_identity_v1', 'text, text, bigint, text, text', 'jsonb', 'private'),
        ('omr_read_teacher_mutation_plan_v1', 'text, text, text, text', 'jsonb', 'private'),
        ('omr_save_exam_effective_worker_v3', 'text, text, text, text, jsonb, jsonb, jsonb', 'jsonb', 'private'),
        ('omr_save_feedback_effective_worker_v4', 'text, jsonb, bigint, text', 'jsonb', 'private'),
        ('omr_claim_remote_asset_cleanup_v8_snapshot', 'text, integer, integer', 'jsonb', 'private'),
        ('omr_assert_targeted_assignment_scope_v1', 'text, text, text, text, text, text, integer[]', 'void', 'private'),
        ('omr_validate_targeted_attempt_session_v1', '', 'trigger', 'private'),
        ('omr_validate_targeted_attempt_v1', '', 'trigger', 'private'),
        ('omr_guard_targeted_exam_access_v1', '', 'trigger', 'private')
    ), actual(name, args, result, owner_name, security_definer, volatility, config, description, oid, definition) as (
        select routine.proname::text,
               pg_catalog.oidvectortypes(routine.proargtypes),
               pg_catalog.pg_get_function_result(routine.oid),
               owner_role.rolname::text,
               routine.prosecdef,
               routine.provolatile::text,
               routine.proconfig,
               coalesce(pg_catalog.obj_description(routine.oid, 'pg_proc'), ''),
               routine.oid,
               pg_catalog.pg_get_functiondef(routine.oid)
          from pg_catalog.pg_proc routine
          join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
          join pg_catalog.pg_roles owner_role on owner_role.oid = routine.proowner
         where namespace.nspname = 'public'
           and routine.proname in (select expected.name from expected)
    )
    select not exists (select name, args, result from expected except select name, args, result from actual)
       and not exists (select name, args, result from actual except select name, args, result from expected)
       and not exists (
           select 1 from actual join expected using (name, args, result)
            where owner_name <> 'postgres'
               or not security_definer
               or volatility <> 'v'
               or not coalesce(config @> array['search_path=""'], false)
               or not coalesce(config @> array['lock_timeout=2s'], false)
               or not coalesce(config @> array[
                   case when name = 'omr_claim_remote_asset_cleanup_v1'
                             or name = 'omr_claim_remote_asset_cleanup_v8_snapshot'
                        then 'statement_timeout=10s' else 'statement_timeout=5s' end
               ], false)
               or description = ''
               or (exposure = 'public' and not pg_catalog.has_function_privilege('service_role', oid, 'EXECUTE'))
               or (exposure = 'private' and pg_catalog.has_function_privilege('service_role', oid, 'EXECUTE'))
               or pg_catalog.has_function_privilege('anon', oid, 'EXECUTE')
               or pg_catalog.has_function_privilege('authenticated', oid, 'EXECUTE')
       )
       and (
           select pg_catalog.encode(extensions.digest(
               'phase-c-effective-plan-enforcement:202608080008|' || pg_catalog.string_agg(
               name || '|' || args || '|' || result || '|' || owner_name || '|'
                   || security_definer::text || '|' || volatility || '|'
                   || coalesce(pg_catalog.array_to_string(config, ','), '') || '|'
                   || description || '|' || definition,
               E'\n-- phase-c-routine --\n' order by name, args
               ), 'sha256'), 'hex')
             from actual
       ) = 'a5681e53ecbc749fc3b8e30bce20f189af8594648eaa1b6b4886e9f603bca487'
       and not exists (
           select 1 from (values
               ('omr_remote_assets'), ('omr_remote_asset_upload_intents'),
               ('omr_remote_asset_cleanup_queue'), ('omr_plan_usage'),
               ('omr_plan_usage_reservations')
           ) guarded(table_name)
            where not pg_catalog.has_table_privilege(
                    'service_role', 'public.' || guarded.table_name, 'SELECT'
                  )
               or pg_catalog.has_table_privilege(
                    'service_role', 'public.' || guarded.table_name,
                    'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
                  )
       )
       and not pg_catalog.has_sequence_privilege(
           'service_role', 'public.omr_remote_asset_cleanup_queue_id_seq',
           'USAGE,SELECT,UPDATE'
       )
       and pg_catalog.to_regclass('public.omr_remote_assets_handwriting_reservation_expiry_idx') is not null
       and pg_catalog.to_regclass('public.omr_remote_assets_one_handwriting_per_attempt_uidx') is not null
       and position('lock table public.omr_organization_members in share mode' in lower(
           pg_catalog.pg_get_functiondef('public.omr_lock_provisioned_teacher_identity_v1(text,bigint,text)'::pg_catalog.regprocedure)
       )) > 0
       and position('omr_read_teacher_mutation_plan_v1' in lower(
           pg_catalog.pg_get_functiondef('public.omr_save_exam_effective_worker_v3(text,text,text,text,jsonb,jsonb,jsonb)'::pg_catalog.regprocedure)
       )) > 0
       and position('handwriting_reservation_grant_id' in lower(
           pg_catalog.pg_get_functiondef('public.omr_prepare_attempt_handwriting_asset_v2(text,text,text,jsonb)'::pg_catalog.regprocedure)
       )) > 0
       and position('omr_claim_remote_asset_cleanup_v8_snapshot' in lower(
           pg_catalog.pg_get_functiondef('public.omr_claim_remote_asset_cleanup_v1(text,integer,integer)'::pg_catalog.regprocedure)
       )) > 0
      into v_effective_workspace_plan_enforcement_ready;

    v_student_session_generation_ready :=
        pg_catalog.to_regclass('public.omr_student_credential_epochs') is not null
        and exists (
            select 1 from pg_catalog.pg_class relation
             where relation.oid = 'public.omr_student_credential_epochs'::pg_catalog.regclass
               and relation.relrowsecurity and relation.relforcerowsecurity
        )
        and not exists (
            select 1 from (values
                ('omr_student_profiles', 'credential_generation'),
                ('omr_student_start_credentials', 'account_id'),
                ('omr_student_start_credentials', 'credential_generation'),
                ('omr_student_credential_epochs', 'account_id'),
                ('omr_student_credential_epochs', 'credential_generation')
            ) expected(table_name, column_name)
             where not exists (
                 select 1 from pg_catalog.pg_attribute attribute
                  where attribute.attrelid = ('public.' || expected.table_name)::pg_catalog.regclass
                    and attribute.attname = expected.column_name
                    and not attribute.attisdropped
                    and attribute.attnotnull
             )
        )
        and not exists (
            select 1 from (values
                ('omr_student_credential_active_profile_guard', 'omr_student_start_credentials'),
                ('omr_student_profile_credential_revocation', 'omr_student_profiles'),
                ('omr_student_profile_session_revocation_on_delete', 'omr_student_profiles')
                ,('omr_student_profile_generation_guard', 'omr_student_profiles')
            ) expected(trigger_name, table_name)
             where not exists (
                 select 1 from pg_catalog.pg_trigger trigger_row
                  where trigger_row.tgname = expected.trigger_name
                    and trigger_row.tgrelid = ('public.' || expected.table_name)::pg_catalog.regclass
                    and not trigger_row.tgisinternal
                    and trigger_row.tgenabled = 'O'
             )
        )
        and pg_catalog.to_regprocedure(
            'public.omr_validate_student_session_v1(text,text,text,integer)'
        ) is not null
        and pg_catalog.to_regprocedure(
            'public.omr_rotate_student_start_credential_v1(text,text,bigint,text,text,text,text)'
        ) is not null
        and pg_catalog.has_function_privilege(
            'service_role',
            'public.omr_validate_student_session_v1(text,text,text,integer)',
            'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
            'service_role',
            'public.omr_rotate_student_start_credential_v1(text,text,bigint,text,text,text,text)',
            'EXECUTE'
        )
        and not pg_catalog.has_table_privilege(
            'service_role', 'public.omr_student_credential_epochs',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
        )
        and pg_catalog.has_table_privilege(
            'service_role', 'public.omr_student_start_credentials', 'SELECT'
        )
        and not pg_catalog.has_table_privilege(
            'service_role', 'public.omr_student_start_credentials',
            'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
        )
        and not pg_catalog.has_function_privilege(
            'anon', 'public.omr_validate_student_session_v1(text,text,text,integer)', 'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
            'authenticated', 'public.omr_validate_student_session_v1(text,text,text,integer)', 'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
            'anon',
            'public.omr_rotate_student_start_credential_v1(text,text,bigint,text,text,text,text)',
            'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
            'authenticated',
            'public.omr_rotate_student_start_credential_v1(text,text,bigint,text,text,text,text)',
            'EXECUTE'
        );

    v_student_session_generation_ready := v_student_session_generation_ready
        and (
            with expected(name, args, result, volatility, service_callable) as (values
                ('omr_validate_student_session_v1', 'text, text, text, integer', 'boolean', 's', true),
                ('omr_rotate_student_start_credential_v1', 'text, text, bigint, text, text, text, text', 'jsonb', 'v', false),
                ('omr_guard_student_credential_mutation_v1', '', 'trigger', 'v', false),
                ('omr_guard_student_profile_generation_v1', '', 'trigger', 'v', false),
                ('omr_revoke_student_session_on_status_v2', '', 'trigger', 'v', false),
                ('omr_revoke_student_session_on_delete_v2', '', 'trigger', 'v', false)
            ), actual as (
                select routine.proname::text as name,
                       pg_catalog.oidvectortypes(routine.proargtypes) as args,
                       pg_catalog.pg_get_function_result(routine.oid) as result,
                       routine.provolatile::text as volatility,
                       owner_role.rolname::text as owner_name,
                       routine.prosecdef as security_definer,
                       routine.proconfig as config,
                       routine.prokind,
                       routine.oid,
                       coalesce(pg_catalog.obj_description(routine.oid, 'pg_proc'), '') as description,
                       pg_catalog.pg_get_functiondef(routine.oid) as definition
                  from pg_catalog.pg_proc routine
                  join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
                  join pg_catalog.pg_roles owner_role on owner_role.oid = routine.proowner
                 where namespace.nspname = 'public'
                   and routine.proname in (select expected.name from expected)
            )
            select not exists (
                       select name, args, result, volatility from expected
                       except select name, args, result, volatility from actual
                   )
               and not exists (
                       select name, args, result, volatility from actual
                       except select name, args, result, volatility from expected
                   )
               and not exists (
                   select 1 from actual join expected using (name, args, result, volatility)
                    where actual.prokind <> 'f'
                       or actual.owner_name <> 'postgres'
                       or not actual.security_definer
                       or not coalesce(actual.config @> array['search_path=""'], false)
                       or not coalesce(actual.config @> array['statement_timeout=5s'], false)
                       or not coalesce(actual.config @> array['lock_timeout=2s'], false)
                       or actual.description = ''
                       or pg_catalog.has_function_privilege('anon', actual.oid, 'EXECUTE')
                       or pg_catalog.has_function_privilege('authenticated', actual.oid, 'EXECUTE')
                       or pg_catalog.has_function_privilege('service_role', actual.oid, 'EXECUTE')
                            is distinct from expected.service_callable
               )
               and (
                   select pg_catalog.encode(extensions.digest(
                       'student-session-generation-routines:202608080009|'
                       || pg_catalog.string_agg(
                           name || '|' || args || '|' || result || '|' || owner_name || '|'
                               || security_definer::text || '|' || volatility || '|'
                               || coalesce(pg_catalog.array_to_string(config, ','), '') || '|'
                               || description || '|' || definition,
                           E'\n-- task5-routine --\n' order by name, args
                       ), 'sha256'), 'hex'
                   ) from actual
               ) = '94d72f002aefd97ba6eccb13275429027dab16297acdf5be369b1383446d9d4e'
        );
    v_student_session_generation_ready := v_student_session_generation_ready
        and (
            with actual as (
                select trigger_row.tgname::text as trigger_name,
                       relation.relname::text as table_name,
                       routine.proname::text as function_name,
                       trigger_row.tgtype::integer as trigger_type,
                       trigger_row.tgattr::text as trigger_attributes,
                       trigger_row.tgenabled::text as enabled,
                       pg_catalog.pg_get_triggerdef(trigger_row.oid, true) as definition
                  from pg_catalog.pg_trigger trigger_row
                  join pg_catalog.pg_class relation on relation.oid = trigger_row.tgrelid
                  join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
                  join pg_catalog.pg_proc routine on routine.oid = trigger_row.tgfoid
                 where namespace.nspname = 'public'
                   and not trigger_row.tgisinternal
                   and trigger_row.tgname in (
                       'omr_student_credential_active_profile_guard',
                       'omr_student_profile_generation_guard',
                       'omr_student_profile_credential_revocation',
                       'omr_student_profile_session_revocation_on_delete'
                   )
            )
            select pg_catalog.count(*) = 4
               and pg_catalog.encode(extensions.digest(
                       'student-session-generation-triggers:202608080009|'
                       || pg_catalog.string_agg(
                           trigger_name || '|' || table_name || '|' || function_name || '|'
                               || trigger_type::text || '|' || trigger_attributes || '|'
                               || enabled || '|' || definition,
                           E'\n-- task5-trigger --\n' order by trigger_name
                       ), 'sha256'), 'hex'
                   ) = 'a40670f5a70b96c13beae74c6ed073d90e343881f80378a3fc0f80b00411bda0'
              from actual
        );
    v_student_session_generation_ready := v_student_session_generation_ready
        and not exists (
            select 1 from (values
                ('omr_student_profiles_credential_generation_check', 'omr_student_profiles'),
                ('omr_student_start_credentials_account_id_unique', 'omr_student_start_credentials'),
                ('omr_student_start_credentials_account_id_check', 'omr_student_start_credentials'),
                ('omr_student_start_credentials_generation_check', 'omr_student_start_credentials'),
                ('omr_student_credential_epochs_pkey', 'omr_student_credential_epochs'),
                ('omr_student_credential_epochs_account_id_unique', 'omr_student_credential_epochs'),
                ('omr_student_credential_epochs_account_id_check', 'omr_student_credential_epochs'),
                ('omr_student_credential_epochs_generation_check', 'omr_student_credential_epochs'),
                ('omr_student_credential_epochs_updated_check', 'omr_student_credential_epochs')
            ) expected(constraint_name, table_name)
             where not exists (
                 select 1 from pg_catalog.pg_constraint constraint_row
                  where constraint_row.conname = expected.constraint_name
                    and constraint_row.conrelid = ('public.' || expected.table_name)::pg_catalog.regclass
                    and constraint_row.convalidated
             )
        )
        and (
            select pg_catalog.count(*) = 9
               and pg_catalog.encode(extensions.digest(
                   'student-session-generation-constraints:202608080009|'
                   || pg_catalog.string_agg(
                       constraint_row.conname || '|'
                           || pg_catalog.pg_get_constraintdef(constraint_row.oid, true)
                           || '|' || constraint_row.convalidated::text,
                       E'\n-- task5-constraint --\n' order by constraint_row.conname
                   ), 'sha256'), 'hex'
               ) = 'a9c416b4400d68ece9a56ee6a70e73564337905907f800e7c6568cd36286ae5d'
              from pg_catalog.pg_constraint constraint_row
             where constraint_row.conname in (
                 'omr_student_profiles_credential_generation_check',
                 'omr_student_start_credentials_account_id_unique',
                 'omr_student_start_credentials_account_id_check',
                 'omr_student_start_credentials_generation_check',
                 'omr_student_credential_epochs_pkey',
                 'omr_student_credential_epochs_account_id_unique',
                 'omr_student_credential_epochs_account_id_check',
                 'omr_student_credential_epochs_generation_check',
                 'omr_student_credential_epochs_updated_check'
             )
        );
    v_student_session_generation_ready := v_student_session_generation_ready
        and (
            select pg_catalog.count(*) = 3
               and pg_catalog.encode(extensions.digest(
                   'student-session-generation-normalized-indexes:202608080009|'
                   || pg_catalog.string_agg(
                       index_relation.relname || '|' || table_relation.relname || '|'
                           || index_record.indisvalid::text || '|'
                           || index_record.indisready::text || '|'
                           || index_record.indisunique::text || '|'
                           || index_record.indnkeyatts::text || '|'
                           || index_record.indnatts::text || '|'
                           || coalesce((select pg_catalog.string_agg(
                               pg_catalog.pg_get_indexdef(
                                   index_record.indexrelid, ordinal, false
                               ), ',' order by ordinal
                           ) from pg_catalog.generate_series(
                               1, index_record.indnatts
                           ) ordinal), '') || '|'
                           || coalesce(pg_catalog.pg_get_expr(
                               index_record.indpred, index_record.indrelid, false
                           ), ''),
                       E'\n-- task5-normalized-index --\n' order by index_relation.relname
                   ), 'sha256'), 'hex'
               ) = 'f6f207962762adf8fee68ee7371c50a50dc38d9b97eedc140d6c7ad7611e076c'
              from pg_catalog.pg_index index_record
              join pg_catalog.pg_class index_relation
                on index_relation.oid = index_record.indexrelid
              join pg_catalog.pg_class table_relation
                on table_relation.oid = index_record.indrelid
              join pg_catalog.pg_namespace namespace
                on namespace.oid = index_relation.relnamespace
             where namespace.nspname = 'public'
               and index_relation.relname in (
                   'omr_student_start_credentials_account_id_unique',
                   'omr_student_credential_epochs_pkey',
                   'omr_student_credential_epochs_account_id_unique'
               )
        );
    v_student_session_generation_ready := v_student_session_generation_ready
        and not exists (
            select 1
              from public.omr_student_start_credentials credential
              left join public.omr_student_profiles student
                on student.organization_id = credential.organization_id
               and student.id = credential.student_profile_id
              left join public.omr_student_credential_epochs epoch
                on epoch.organization_id = credential.organization_id
               and epoch.student_profile_id = credential.student_profile_id
             where student.id is null or epoch.account_id is null
                or credential.account_id is distinct from epoch.account_id
                or credential.credential_generation is distinct from epoch.credential_generation
                or credential.credential_generation is distinct from student.credential_generation
        )
        and not exists (
            select 1
              from public.omr_student_profiles student
              join public.omr_student_credential_epochs epoch
                on epoch.organization_id = student.organization_id
               and epoch.student_profile_id = student.id
             where student.credential_generation is distinct from epoch.credential_generation
        );

    select
        pg_catalog.to_regclass('public.omr_student_credential_batch_receipts') is not null
        and exists (
            select 1
              from pg_catalog.pg_class relation
              join pg_catalog.pg_roles owner_role on owner_role.oid = relation.relowner
             where relation.oid = 'public.omr_student_credential_batch_receipts'::pg_catalog.regclass
               and relation.relrowsecurity
               and relation.relforcerowsecurity
               and owner_role.rolname = 'postgres'
               and coalesce(pg_catalog.obj_description(relation.oid, 'pg_class'), '') =
                   'RPC-only idempotency receipts for atomic student credential batches. Stores hashes and counts only, never raw codes, verifiers, student identifiers, or idempotency keys.'
        )
        and (
            with expected(name, type_name, not_null, default_expression) as (values
                ('organization_id', 'text', true, ''),
                ('idempotency_key_hash', 'text', true, ''),
                ('request_fingerprint', 'text', true, ''),
                ('student_count', 'integer', true, ''),
                ('state', 'text', true, '''pending''::text'),
                ('created_at', 'timestamp with time zone', true, 'clock_timestamp()'),
                ('applied_at', 'timestamp with time zone', false, '')
            ), actual(name, type_name, not_null, default_expression) as (
                select attribute.attname::text,
                       pg_catalog.format_type(attribute.atttypid, attribute.atttypmod),
                       attribute.attnotnull,
                       coalesce(pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid), '')
                  from pg_catalog.pg_attribute attribute
                  left join pg_catalog.pg_attrdef default_row
                    on default_row.adrelid = attribute.attrelid
                   and default_row.adnum = attribute.attnum
                 where attribute.attrelid =
                       'public.omr_student_credential_batch_receipts'::pg_catalog.regclass
                   and attribute.attnum > 0
                   and not attribute.attisdropped
                   and attribute.attgenerated = ''
                   and attribute.attidentity = ''
            )
            select not exists (select * from expected except select * from actual)
               and not exists (select * from actual except select * from expected)
        )
        and not pg_catalog.has_table_privilege(
            'service_role', 'public.omr_student_credential_batch_receipts',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
        )
        and not pg_catalog.has_table_privilege(
            'anon', 'public.omr_student_credential_batch_receipts',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
        )
        and not pg_catalog.has_table_privilege(
            'authenticated', 'public.omr_student_credential_batch_receipts',
            'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
        )
        and pg_catalog.to_regprocedure(
            'public.omr_issue_student_start_code_batch_v1(text,text,bigint,text,text,jsonb,text)'
        ) is not null
        and pg_catalog.has_function_privilege(
            'service_role',
            'public.omr_issue_student_start_code_batch_v1(text,text,bigint,text,text,jsonb,text)',
            'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
            'anon',
            'public.omr_issue_student_start_code_batch_v1(text,text,bigint,text,text,jsonb,text)',
            'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
            'authenticated',
            'public.omr_issue_student_start_code_batch_v1(text,text,bigint,text,text,jsonb,text)',
            'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
            'service_role',
            'public.omr_rotate_student_start_credential_v1(text,text,bigint,text,text,text,text)',
            'EXECUTE'
        )
        and (
            with expected(name) as (values
                ('omr_student_credential_batch_receipts_pkey'),
                ('omr_student_credential_batch_receipts_organization_id_fkey'),
                ('omr_student_credential_batch_receipts_key_hash_check'),
                ('omr_student_credential_batch_receipts_fingerprint_check'),
                ('omr_student_credential_batch_receipts_count_check'),
                ('omr_student_credential_batch_receipts_state_check'),
                ('omr_student_credential_batch_receipts_applied_check')
            ), actual(name) as (
                select constraint_row.conname::text
                  from pg_catalog.pg_constraint constraint_row
                 where constraint_row.conrelid =
                       'public.omr_student_credential_batch_receipts'::pg_catalog.regclass
                   and constraint_row.convalidated
            )
            select not exists (select name from expected except select name from actual)
               and not exists (select name from actual except select name from expected)
        )
        and exists (
            select 1
              from pg_catalog.pg_index index_row
              join pg_catalog.pg_class index_relation on index_relation.oid = index_row.indexrelid
             where index_row.indrelid =
                   'public.omr_student_credential_batch_receipts'::pg_catalog.regclass
               and index_relation.relname = 'omr_student_credential_batch_receipts_pkey'
               and index_row.indisprimary
               and index_row.indisunique
               and index_row.indisvalid
               and index_row.indisready
               and index_row.indnkeyatts = 2
               and pg_catalog.pg_get_indexdef(index_row.indexrelid) =
                   'CREATE UNIQUE INDEX omr_student_credential_batch_receipts_pkey ON public.omr_student_credential_batch_receipts USING btree (organization_id, idempotency_key_hash)'
        )
        and exists (
            select 1
              from pg_catalog.pg_proc routine
              join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
              join pg_catalog.pg_roles owner_role on owner_role.oid = routine.proowner
             where namespace.nspname = 'public'
               and routine.proname = 'omr_issue_student_start_code_batch_v1'
               and pg_catalog.oidvectortypes(routine.proargtypes) =
                   'text, text, bigint, text, text, jsonb, text'
               and pg_catalog.pg_get_function_result(routine.oid) = 'jsonb'
               and routine.prokind = 'f'
               and routine.provolatile = 'v'
               and routine.prosecdef
               and owner_role.rolname = 'postgres'
               and coalesce(routine.proconfig @> array['search_path=""'], false)
               and coalesce(routine.proconfig @> array['statement_timeout=10s'], false)
               and coalesce(routine.proconfig @> array['lock_timeout=2s'], false)
               and coalesce(pg_catalog.obj_description(routine.oid, 'pg_proc'), '') <> ''
        )
        and (
            select pg_catalog.count(*) = 1
              from pg_catalog.pg_proc routine
              join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
             where namespace.nspname = 'public'
               and routine.proname = 'omr_issue_student_start_code_batch_v1'
        )
        and not exists (
            select 1
              from public.omr_student_credential_batch_receipts receipt
             where receipt.state <> 'applied'
                or receipt.applied_at is null
        )
        and (
            select pg_catalog.encode(extensions.digest(
                'student-credential-batch:202608080010|'
                || pg_catalog.pg_get_functiondef(routine.oid)
                || '|'
                || coalesce(pg_catalog.obj_description(routine.oid, 'pg_proc'), '')
                || '|'
                || (
                    select pg_catalog.string_agg(
                        attribute.attname || '|' ||
                        pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) || '|' ||
                        attribute.attnotnull::text || '|' ||
                        coalesce(pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid), '') || '|' ||
                        attribute.attgenerated::text || '|' || attribute.attidentity::text,
                        E'\n-- task6-column --\n' order by attribute.attnum
                    )
                      from pg_catalog.pg_attribute attribute
                      left join pg_catalog.pg_attrdef default_row
                        on default_row.adrelid = attribute.attrelid
                       and default_row.adnum = attribute.attnum
                     where attribute.attrelid =
                           'public.omr_student_credential_batch_receipts'::pg_catalog.regclass
                       and attribute.attnum > 0
                       and not attribute.attisdropped
                )
                || '|'
                || coalesce(pg_catalog.obj_description(
                    'public.omr_student_credential_batch_receipts'::pg_catalog.regclass,
                    'pg_class'
                ), '')
                || '|postgres|'
                || (
                    select pg_catalog.pg_get_indexdef(index_row.indexrelid)
                        || '|' || index_row.indisprimary::text
                        || '|' || index_row.indisunique::text
                        || '|' || index_row.indisvalid::text
                        || '|' || index_row.indisready::text
                        || '|' || index_row.indnkeyatts::text
                      from pg_catalog.pg_index index_row
                      join pg_catalog.pg_class index_relation
                        on index_relation.oid = index_row.indexrelid
                     where index_row.indrelid =
                           'public.omr_student_credential_batch_receipts'::pg_catalog.regclass
                       and index_relation.relname = 'omr_student_credential_batch_receipts_pkey'
                )
                || '|'
                || (
                    select pg_catalog.string_agg(
                        constraint_row.conname || '|' || pg_catalog.pg_get_constraintdef(constraint_row.oid, true),
                        E'\n-- task6-constraint --\n'
                        order by constraint_row.conname
                    )
                      from pg_catalog.pg_constraint constraint_row
                     where constraint_row.conrelid =
                           'public.omr_student_credential_batch_receipts'::pg_catalog.regclass
                ),
                'sha256'
            ), 'hex')
              from pg_catalog.pg_proc routine
              join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
             where namespace.nspname = 'public'
               and routine.proname = 'omr_issue_student_start_code_batch_v1'
               and pg_catalog.oidvectortypes(routine.proargtypes) =
                   'text, text, bigint, text, text, jsonb, text'
        ) = '03347ee80c1a3be2ef93c57a0da64da25e0b8efbb1cc13b7a0a01bccff423009'
      into v_student_credential_batch_ready;

    -- Keep exact catalog drift detection for the two legacy-named public
    -- gateway families exercised by the long-lived readiness probes. The v1
    -- exam signature is a denied compatibility stub, but an extra overload or
    -- a procedure impostor must still fail deployment readiness.
    with expected(name, args) as (values
        ('omr_save_exam_v1', 'jsonb, jsonb, jsonb, text'),
        ('omr_save_remote_asset_metadata_v1', 'jsonb')
    ), actual(name, args) as (
        select routine.proname::text,
               pg_catalog.oidvectortypes(routine.proargtypes)
          from pg_catalog.pg_proc routine
          join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
         where namespace.nspname = 'public'
           and routine.prokind = 'f'
           and routine.proname in (select expected.name from expected)
    )
    select not exists (select name, args from expected except select name, args from actual)
       and not exists (select name, args from actual except select name, args from expected)
      into v_legacy_gateway_catalog_ready;

    v_assignment_generation_scope_ready :=
        pg_catalog.to_regprocedure('public.omr_list_student_assignments_v2(text,text,text,text,text)') is not null
        and pg_catalog.to_regprocedure('public.omr_resolve_student_assignment_v2(text,text,text,text,text,text,bigint,text)') is not null
        and pg_catalog.to_regprocedure('public.omr_open_attempt_session_v3(text,text,text,text,bigint,text,text,text,text,text,text,text,integer[],integer[],timestamptz,jsonb,integer,timestamptz,text,text,integer)') is not null
        and pg_catalog.to_regprocedure('public.omr_checkpoint_attempt_session_v2(text,text,text,text,text,bigint,bigint,bigint,text,jsonb,jsonb,jsonb,integer,boolean)') is not null
        and pg_catalog.to_regprocedure('public.omr_heartbeat_attempt_session_v2(text,text,text,text,text,bigint,bigint,text,integer)') is not null
        and pg_catalog.to_regprocedure('public.omr_takeover_attempt_session_v2(text,text,text,text,text,bigint,bigint,bigint,text,integer)') is not null
        and pg_catalog.to_regprocedure('public.omr_prepare_attempt_session_submit_v2(text,text,text,text,text,bigint,bigint,bigint,text)') is not null
        and pg_catalog.to_regprocedure('public.omr_commit_attempt_session_submit_v2(text,text,text,text,text,bigint,bigint,bigint,text,jsonb,jsonb)') is not null
        and pg_catalog.to_regprocedure('public.omr_list_active_attempt_sessions_v2(text,text,text,text,integer)') is not null
        and pg_catalog.to_regprocedure('public.omr_resolve_legacy_attempt_session_scope_v1(text,text,text)') is not null
        and pg_catalog.to_regprocedure('public.omr_prepare_teacher_force_finish_sessions_compact_v2(text,text[],text,text)') is not null
        and pg_catalog.to_regprocedure('public.omr_force_finish_attempt_sessions_compact_v2(text,text[],timestamptz,text,text,text,jsonb)') is not null
        and not exists (
            select 1 from pg_catalog.unnest(array[
                'public.omr_list_student_assignments_v2(text,text,text,text,text)',
                'public.omr_resolve_student_assignment_v2(text,text,text,text,text,text,bigint,text)',
                'public.omr_open_attempt_session_v3(text,text,text,text,bigint,text,text,text,text,text,text,text,integer[],integer[],timestamptz,jsonb,integer,timestamptz,text,text,integer)',
                'public.omr_checkpoint_attempt_session_v2(text,text,text,text,text,bigint,bigint,bigint,text,jsonb,jsonb,jsonb,integer,boolean)',
                'public.omr_heartbeat_attempt_session_v2(text,text,text,text,text,bigint,bigint,text,integer)',
                'public.omr_takeover_attempt_session_v2(text,text,text,text,text,bigint,bigint,bigint,text,integer)',
                'public.omr_prepare_attempt_session_submit_v2(text,text,text,text,text,bigint,bigint,bigint,text)',
                'public.omr_commit_attempt_session_submit_v2(text,text,text,text,text,bigint,bigint,bigint,text,jsonb,jsonb)',
                'public.omr_list_active_attempt_sessions_v2(text,text,text,text,integer)',
                'public.omr_resolve_legacy_attempt_session_scope_v1(text,text,text)',
                'public.omr_prepare_teacher_force_finish_sessions_compact_v2(text,text[],text,text)',
                'public.omr_force_finish_attempt_sessions_compact_v2(text,text[],timestamptz,text,text,text,jsonb)'
            ]) signature
            where not pg_catalog.has_function_privilege('service_role',pg_catalog.to_regprocedure(signature),'EXECUTE')
               or pg_catalog.has_function_privilege('anon',pg_catalog.to_regprocedure(signature),'EXECUTE')
               or pg_catalog.has_function_privilege('authenticated',pg_catalog.to_regprocedure(signature),'EXECUTE')
        );

    v_canonical_question_result_evidence_ready :=
        pg_catalog.to_regprocedure('public.omr_canonical_question_result_evidence_ready_v1()') is not null
        and public.omr_canonical_question_result_evidence_ready_v1();

    -- Exact Kakao writes are service-role RPCs; direct DML, browser execution,
    -- overloads, legacy ambiguity, or routine marker drift fail readiness.
    v_kakao_reminder_entitlement_ready :=
        pg_catalog.to_regprocedure(
            'public.omr_save_kakao_candidate_review_v1(text,text,bigint,text,text,jsonb)'
        ) is not null
        and pg_catalog.to_regprocedure(
            'public.omr_save_kakao_simulation_dispatch_v1(text,text,bigint,text,text,jsonb)'
        ) is not null
        and pg_catalog.to_regprocedure('public.omr_kakao_reminder_legacy_inventory_v1()') is not null
        and pg_catalog.to_regprocedure('public.omr_quarantine_kakao_reminder_legacy_v1(text)') is not null
        and pg_catalog.to_regprocedure('public.omr_kakao_reminder_entitlement_ready_v1()') is not null
        and public.omr_kakao_reminder_entitlement_ready_v1()
        and (
            select pg_catalog.count(*) = 5
              from pg_catalog.pg_proc routine
              join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
             where namespace.nspname = 'public'
               and routine.proname in (
                   'omr_save_kakao_candidate_review_v1',
                   'omr_save_kakao_simulation_dispatch_v1',
                   'omr_kakao_reminder_legacy_inventory_v1',
                   'omr_quarantine_kakao_reminder_legacy_v1',
                   'omr_kakao_reminder_entitlement_ready_v1'
               )
        )
        and (
            select pg_catalog.count(*) = 2
              from pg_catalog.pg_proc routine
              join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
              join pg_catalog.pg_roles owner_role on owner_role.oid = routine.proowner
             where namespace.nspname = 'public'
               and routine.proname in (
                   'omr_save_kakao_candidate_review_v1',
                   'omr_save_kakao_simulation_dispatch_v1'
               )
               and routine.prokind = 'f'
               and routine.prosecdef
               and owner_role.rolname = 'postgres'
               and (owner_role.rolsuper or owner_role.rolbypassrls)
               and pg_catalog.oidvectortypes(routine.proargtypes) =
                   'text, text, bigint, text, text, jsonb'
               and pg_catalog.obj_description(routine.oid, 'pg_proc') like
                   'kakao-reminder-entitlement:202608100002:%'
        )
        and (
            select pg_catalog.count(*) = 3
              from pg_catalog.pg_proc routine
              join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
              join pg_catalog.pg_roles owner_role on owner_role.oid = routine.proowner
             where namespace.nspname = 'public'
               and routine.proname in (
                   'omr_kakao_reminder_legacy_inventory_v1',
                   'omr_quarantine_kakao_reminder_legacy_v1',
                   'omr_kakao_reminder_entitlement_ready_v1'
               )
               and routine.prokind = 'f'
               and owner_role.rolname = 'postgres'
               and (owner_role.rolsuper or owner_role.rolbypassrls)
               and pg_catalog.obj_description(routine.oid, 'pg_proc') like
                   'kakao-reminder-entitlement:202608100002:%'
        )
        and not pg_catalog.has_table_privilege(
            'service_role', 'public.omr_kakao_candidate_reviews',
            'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
        )
        and not pg_catalog.has_table_privilege(
            'service_role', 'public.omr_kakao_dispatch_logs',
            'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
        )
        and pg_catalog.to_regclass('public.omr_kakao_reminder_legacy_quarantine') is not null
        and exists (
            select 1
              from pg_catalog.pg_class relation
              join pg_catalog.pg_roles owner_role on owner_role.oid = relation.relowner
             where relation.oid = 'public.omr_kakao_reminder_legacy_quarantine'::pg_catalog.regclass
               and relation.relrowsecurity
               and relation.relforcerowsecurity
               and owner_role.rolname = 'postgres'
               and (owner_role.rolsuper or owner_role.rolbypassrls)
        )
        and pg_catalog.has_table_privilege(
            'service_role', 'public.omr_kakao_reminder_legacy_quarantine', 'SELECT'
        )
        and not pg_catalog.has_table_privilege(
            'service_role', 'public.omr_kakao_reminder_legacy_quarantine',
            'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
        )
        and not exists (
            select 1
              from pg_catalog.pg_policy policy
             where policy.polrelid =
                       'public.omr_kakao_reminder_legacy_quarantine'::pg_catalog.regclass
        )
        and pg_catalog.has_function_privilege(
            'service_role',
            'public.omr_save_kakao_candidate_review_v1(text,text,bigint,text,text,jsonb)',
            'EXECUTE'
        )
        and pg_catalog.has_function_privilege(
            'service_role',
            'public.omr_save_kakao_simulation_dispatch_v1(text,text,bigint,text,text,jsonb)',
            'EXECUTE'
        )
        and pg_catalog.has_function_privilege(
            'service_role', 'public.omr_kakao_reminder_legacy_inventory_v1()', 'EXECUTE'
        )
        and pg_catalog.has_function_privilege(
            'service_role', 'public.omr_kakao_reminder_entitlement_ready_v1()', 'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
            'service_role', 'public.omr_quarantine_kakao_reminder_legacy_v1(text)', 'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
            'anon',
            'public.omr_save_kakao_candidate_review_v1(text,text,bigint,text,text,jsonb)',
            'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
            'authenticated',
            'public.omr_save_kakao_simulation_dispatch_v1(text,text,bigint,text,text,jsonb)',
            'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
            'authenticated',
            'public.omr_save_kakao_candidate_review_v1(text,text,bigint,text,text,jsonb)',
            'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
            'anon',
            'public.omr_save_kakao_simulation_dispatch_v1(text,text,bigint,text,text,jsonb)',
            'EXECUTE'
        )
        and not exists (
            select 1
              from pg_catalog.pg_proc routine
              join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
             where namespace.nspname = 'public'
               and routine.proname in (
                   'omr_kakao_reminder_legacy_inventory_v1',
                   'omr_quarantine_kakao_reminder_legacy_v1',
                   'omr_kakao_reminder_entitlement_ready_v1'
               )
               and (
                   pg_catalog.has_function_privilege('anon', routine.oid, 'EXECUTE')
                   or pg_catalog.has_function_privilege('authenticated', routine.oid, 'EXECUTE')
               )
        );

    -- Exact legacy recovery definitions and private ledger protection are required.
    select exists(select 1 from pg_catalog.pg_class c
        where c.oid=pg_catalog.to_regclass('omr_internal.legacy_organization_recoveries')
          and c.relkind='r' and c.relowner='postgres'::regrole and c.relrowsecurity and c.relforcerowsecurity
          and not exists(select 1 from pg_catalog.pg_policy p where p.polrelid=c.oid)
          and not exists(select 1 from (values ('anon'),('authenticated'),('service_role')) role_name(name)
             where pg_catalog.has_table_privilege(role_name.name,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')))
      and not exists(select 1 from (values ('anon'),('authenticated'),('service_role')) role_name(name)
          where pg_catalog.has_schema_privilege(role_name.name,'omr_internal','USAGE,CREATE'))
      and (select count(*) from pg_catalog.pg_attribute a
          where a.attrelid=pg_catalog.to_regclass('omr_internal.legacy_organization_recoveries')
            and a.attnum>0 and not a.attisdropped)=11
      and not exists(select 1 from (values
          ('organization_id','text',true),('owner_account_id','text',true),('source_admin_user_id','text',true),
          ('idempotency_key_hash','text',true),('request_hash','text',true),('audit_id','text',true),
          ('plan','text',true),('entitlement_mode','text',true),('state','text',true),
          ('created_at','timestamp with time zone',true),('revoked_at','timestamp with time zone',false)
        ) expected(name,type_name,required)
        where not exists(select 1 from pg_catalog.pg_attribute a
          where a.attrelid=pg_catalog.to_regclass('omr_internal.legacy_organization_recoveries')
            and a.attname=expected.name and not a.attisdropped and a.attnotnull=expected.required
            and pg_catalog.format_type(a.atttypid,a.atttypmod)=expected.type_name))
      and (select count(*) from pg_catalog.pg_constraint c
          where c.conrelid=pg_catalog.to_regclass('omr_internal.legacy_organization_recoveries'))=15
      and not exists(select 1 from (values
          ('legacy_organization_recoveries_audit_id_key','UNIQUE (audit_id)'),
          ('legacy_organization_recoveries_check','CHECK ((((state = ''active''::text) AND (revoked_at IS NULL)) OR ((state = ''revoked''::text) AND (revoked_at IS NOT NULL))))'),
          ('legacy_organization_recoveries_entitlement_mode_check','CHECK ((entitlement_mode = ''legacy_recovery''::text))'),
          ('legacy_organization_recoveries_idempotency_key_hash_check','CHECK ((idempotency_key_hash ~ ''^[a-f0-9]{64}$''::text))'),
          ('legacy_organization_recoveries_idempotency_key_hash_key','UNIQUE (idempotency_key_hash)'),
          ('legacy_organization_recoveries_organization_id_check','CHECK ((organization_id ~ ''^teacher_[a-z0-9]{7,16}$''::text))'),
          ('legacy_organization_recoveries_organization_id_fkey','FOREIGN KEY (organization_id) REFERENCES public.omr_organizations(id) ON DELETE RESTRICT'),
          ('legacy_organization_recoveries_owner_account_id_check','CHECK ((owner_account_id ~ ''^teacher_[a-f0-9]{16}$''::text))'),
          ('legacy_organization_recoveries_owner_account_id_fkey','FOREIGN KEY (owner_account_id) REFERENCES public.omr_teacher_accounts(id) ON DELETE RESTRICT'),
          ('legacy_organization_recoveries_owner_account_id_key','UNIQUE (owner_account_id)'),
          ('legacy_organization_recoveries_pkey','PRIMARY KEY (organization_id)'),
          ('legacy_organization_recoveries_plan_check','CHECK ((plan = ''academy''::text))'),
          ('legacy_organization_recoveries_request_hash_check','CHECK ((request_hash ~ ''^[a-f0-9]{64}$''::text))'),
          ('legacy_organization_recoveries_source_admin_user_id_check','CHECK ((source_admin_user_id ~ ''^teacher_[a-z0-9]{7,16}$''::text))'),
          ('legacy_organization_recoveries_state_check','CHECK ((state = ANY (ARRAY[''active''::text, ''revoked''::text])))')
        ) expected(name,definition)
        where not exists(select 1 from pg_catalog.pg_constraint c
          where c.conrelid=pg_catalog.to_regclass('omr_internal.legacy_organization_recoveries')
            and c.conname=expected.name and c.convalidated and not c.condeferrable
            and pg_catalog.pg_get_constraintdef(c.oid)=expected.definition))
      and not exists(select 1 from (values
          ('public.omr_read_effective_workspace_plan_v1(text)','778083d5e37553c1089bacc01839fd64f7fd2fe433d3b8bf11bdbc6f9cbe7201',true),
          ('public.omr_read_effective_organization_plan_v1(text)','fc84aad4097ac2cfc7b15d767471f55bb50dcb80dad3e81239d223a14027fc51',false),
          ('public.omr_lock_provisioned_teacher_identity_v1(text, bigint, text)','da88b56b78f6a27bda5e38bfc350923e653dd927f4d2a3595183a15b649af7d0',false),
          ('public.omr_validate_provisioned_teacher_session_v1(text, bigint, text)','25d78d77d24aff14c38a4d93c5a52e4b6aeb58a5e9e1ef9dbda84514cf341d56',true),
          ('public.omr_authorize_effective_teacher_plan_v1(text, text)','67f82ff84b845e835274264bfdf36e3c965b476ca34657a5399e3a260400f3bd',false),
          ('public.omr_read_teacher_mutation_plan_v1(text, text, text, text)','bd8a94856ae1f95092d58a40fb28c7b2d2f6a43340f7f6ecb532574570229726',false),
          ('public.omr_lookup_provisioned_teacher_login_v1(text)','9efc7745af6c20181ce1cc1a219bcb72f8d69c1813c5d3f3d7ad8239a726722c',true),
          ('public.omr_lock_legacy_teacher_identity_v1(text, bigint, text, text)','dfd1f868a9d400608e28056882b642ce4dfaf7c647d8d60ca1c7e6cea59a23c3',false),
          ('public.omr_read_legacy_teacher_plan_v1(text, text, text)','13dc0a2af4cd03872822c80a564d3e51aca6b6243daeb67e0b2a6c54f1ef2b25',false),
          ('public.omr_lookup_teacher_account_v1(text)','943ebd34f874b92c32b80ad32dfa9a8c82d333a38a8a778a563158c664298f06',true),
          ('public.omr_validate_teacher_session_v1(text, bigint)','2b07eb8fd3708b470a159ad031d542e78dea0ec19810c8ab478632159a927850',true),
          ('public.omr_begin_teacher_password_reset_v1(text, text, text, timestamp with time zone)','3b93c38fa98fb897274fc7f6ead886d18eb692d49f542a84c652a6bdf4aa8953',true),
          ('public.omr_complete_teacher_password_reset_v1(text, text)','ff66b8dd21859d592db7caac040b883f0b521821af5a0bc6149e528ba000e55c',true),
          ('omr_internal.lock_legacy_recovery_identity_v1(text,bigint,text)','1ce8d2528bddccab5dd7df690fafc78dcfc47d7df8c1dde66df98658f829b491',false),
          ('omr_internal.read_legacy_recovery_plan_v1(text)','2a644e039d9b0ab61c73f4f9eb5d69853af32354c82e4103cd6d09bef193258f',false),
          ('public.omr_recover_legacy_organization_v1(text,text,text,text,text,text,text,text,text,text)','bf45db448dba6735abc7143229a002cb9cc1cebe10cda070ff37ab548caae475',true)
        ) expected(signature,fingerprint,service_execute)
        where not exists(select 1 from pg_catalog.pg_proc p where p.oid=pg_catalog.to_regprocedure(expected.signature)
          and p.proowner='postgres'::regrole and p.prosecdef
          and encode(extensions.digest(pg_catalog.pg_get_functiondef(p.oid),'sha256'),'hex')=expected.fingerprint
          and not pg_catalog.has_function_privilege('anon',p.oid,'EXECUTE')
          and not pg_catalog.has_function_privilege('authenticated',p.oid,'EXECUTE')
          and pg_catalog.has_function_privilege('service_role',p.oid,'EXECUTE')=expected.service_execute))
      into v_legacy_organization_recovery_ready;

    v_server_gateway_capabilities_ready := v_legacy_gateway_catalog_ready
        and v_legacy_organization_recovery_ready
        and v_assignment_generation_scope_ready
        and v_student_session_generation_ready
        and v_student_credential_batch_ready
        and v_canonical_question_result_evidence_ready
        and v_kakao_reminder_entitlement_ready
        and v_effective_workspace_plan_enforcement_ready
        and v_roster_snapshot_cas_ready
        and v_cleanup_epoch_ready
        and v_attempt_sessions_ready
        and v_durable_rate_limits_ready
        and v_teacher_exam_cas_ready
        and v_teacher_notification_summary_ready
        and v_teacher_notification_state_ready
        and v_feedback_cas_ready
        and v_feedback_replay_hardening_ready
        and v_feedback_core_free_ready
        and v_exam_entry_invites_ready
        and v_workspace_bootstrap_plan_safe
        and v_session_cleanup_optimization_ready
        and v_session_cleanup_fencing_ready
        and v_attempt_checkpoint_null_cas_ready
        and v_attempt_mutation_cas_ready
        and v_exam_delete_session_safe
        and v_student_question_atomic_ready
        and v_teacher_live_sessions_ready
        and v_teacher_account_lifecycle_ready
        and v_provisioned_teacher_login_ready
        and v_student_session_generation_ready
        and v_effective_workspace_plan_enforcement_ready
        and v_initial_operations_load_control_ready
        and v_individual_student_assignments_ready
        and v_teacher_attempt_reporting_ready;

    v_ready := v_canonical_tables_force_rls
        and v_service_role_privileges_ready
        and v_operational_job_status_ready
        and v_operator_pilot_provisioning_ready
        and v_provisioned_teacher_login_ready
        and v_server_gateway_capabilities_ready
        and not exists (
            select 1
              from pg_catalog.jsonb_each(
                  v_previous - 'version' - 'ready' - 'canonicalTablesForceRls'
                  - 'serviceRolePrivilegesReady' - 'serverGatewayCapabilitiesReady'
                  - 'teacherUploadCleanupQueueReady' - 'studentAttemptSessionsReady'
                  - 'rosterSnapshotCasReady' - 'sessionCleanupFencingReady'
                  - 'directUploadIntentLifecycleReady'
                  - 'teacherAssetFinalizePreauthorizationReady'
                  - 'canonicalQuestionResultEvidenceReady'
              ) item
             where item.value is distinct from 'true'::jsonb
        );

    return (v_previous - 'version' - 'ready' - 'canonicalTablesForceRls'
            - 'serviceRolePrivilegesReady' - 'serverGatewayCapabilitiesReady'
            - 'teacherUploadCleanupQueueReady' - 'studentAttemptSessionsReady')
            - 'rosterSnapshotCasReady' - 'sessionCleanupFencingReady'
            - 'directUploadIntentLifecycleReady'
            - 'teacherAssetFinalizePreauthorizationReady'
            - 'canonicalQuestionResultEvidenceReady'
        || pg_catalog.jsonb_build_object(
            'version', '202608090001',
            'canonicalTablesForceRls', v_canonical_tables_force_rls,
            'serviceRolePrivilegesReady', v_service_role_privileges_ready,
            'serverGatewayCapabilitiesReady', v_server_gateway_capabilities_ready,
            'effectiveWorkspacePlanEnforcementReady', v_effective_workspace_plan_enforcement_ready,
            'studentSessionGenerationReady', v_student_session_generation_ready,
            'studentCredentialBatchReady', v_student_credential_batch_ready,
            'canonicalQuestionResultEvidenceReady', v_canonical_question_result_evidence_ready,
            'kakaoReminderEntitlementReady', v_kakao_reminder_entitlement_ready,
            'operationalJobStatusReady', v_operational_job_status_ready,
            'operatorPilotProvisioningReady', v_operator_pilot_provisioning_ready,
            'provisionedTeacherLoginReady', v_provisioned_teacher_login_ready,
            'teacherUploadCleanupQueueReady', v_cleanup_epoch_ready,
            'studentAttemptSessionsReady', v_attempt_sessions_ready,
            'rosterSnapshotCasReady', v_roster_snapshot_cas_ready,
            'sessionCleanupFencingReady', v_effective_workspace_plan_enforcement_ready,
            'directUploadIntentLifecycleReady', v_effective_workspace_plan_enforcement_ready,
            'teacherAssetFinalizePreauthorizationReady', v_effective_workspace_plan_enforcement_ready,
            'durableRateLimitsReady', v_durable_rate_limits_ready,
            'examRevisionReady', v_exam_revision_ready,
            'teacherExamCasReady', v_teacher_exam_cas_ready,
            'teacherNotificationSummaryReady', v_teacher_notification_summary_ready,
            'teacherNotificationStateReady', v_teacher_notification_state_ready,
            'feedbackRevisionReady', v_feedback_revision_ready,
            'feedbackCasReady', v_feedback_cas_ready,
            'workspaceBootstrapPlanSafe', v_workspace_bootstrap_plan_safe,
            'sessionCleanupOptimizationReady', v_session_cleanup_optimization_ready,
            'feedbackReplayHardeningReady', v_feedback_replay_hardening_ready,
            'feedbackCoreFreeReady', v_feedback_core_free_ready,
            'examEntryInvitesReady', v_exam_entry_invites_ready,
            'attemptCheckpointNullCasReady', v_attempt_checkpoint_null_cas_ready,
            'attemptMutationCasReady', v_attempt_mutation_cas_ready,
            'examDeleteSessionSafe', v_exam_delete_session_safe,
            'studentQuestionAtomicReady', v_student_question_atomic_ready,
            'teacherLiveSessionsReady', v_teacher_live_sessions_ready,
            'teacherAccountLifecycleReady', v_teacher_account_lifecycle_ready,
            'initialOperationsLoadControlReady', v_initial_operations_load_control_ready,
            'individualStudentAssignmentsReady', v_individual_student_assignments_ready,
            'teacherAttemptReportingReady', v_teacher_attempt_reporting_ready,
            'legacyOrganizationRecoveryReady', v_legacy_organization_recovery_ready,
            'ready', v_ready
        );
end;
$function$
$recovery_readiness_definition$;
  elsif fingerprint<>'c340f3787fedc9238992c6f3d7b91bea201db17fa00bcadb8cb7cfc717680635' then
   raise exception 'unexpected legacy recovery readiness fingerprint';
  end if;
 end if;
end
$recovery_readiness_fingerprint$;

commit;
