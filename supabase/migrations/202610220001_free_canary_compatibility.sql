-- The QA Free provisioning RPC records expiring owner provenance, while the
-- effective-plan reader intentionally returns a Free envelope with null grant
-- ID and expiry. Accept that envelope only with the same live grant, exact
-- owner/account/profile binding, and a qa_free_org provisioning audit. Paid
-- canaries retain their exact effective grant ID and expiry checks.
begin;

create or replace function public.omr_probe_provisioned_teacher_canary_v1(
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
               and (
                   (
                       grant_row.plan in ('pro', 'academy')
                       and effective.value ->> 'grantId' = grant_row.id
                       and effective.value ->> 'expiresAt' = pg_catalog.to_char(
                           grant_row.expires_at at time zone 'UTC',
                           'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
                       )
                   ) or (
                       -- Free provenance is still an active, audited grant,
                       -- but the effective-plan envelope exposes no paid grant.
                       grant_row.plan = 'free'
                       and effective.value -> 'grantId' = 'null'::jsonb
                       and effective.value -> 'expiresAt' = 'null'::jsonb
                   )
               )
               and (select pg_catalog.count(*)
                      from public.omr_audit_logs audit
                     where audit.organization_id = member.organization_id
                       and audit.action = 'operator.pilot_teacher_provisioned'
                       and audit.entity_type = 'pilot_plan_grant'
                       and audit.entity_id = grant_row.id
                       and audit.metadata ->> 'grantId' = grant_row.id
                       and audit.metadata ->> 'afterPlan' = grant_row.plan
                       and (
                           grant_row.plan <> 'free'
                           or audit.metadata ->> 'reason' = 'qa_free_org'
                       )
                       and audit.metadata ->> 'afterSessionGeneration' = account.session_generation::text
                       and audit.metadata ->> 'expiresAt' = pg_catalog.to_char(
                           grant_row.expires_at at time zone 'UTC',
                           'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
                       )) = 1
        )
    )
$$;

alter function public.omr_probe_provisioned_teacher_canary_v1(text) owner to postgres;
revoke all on function public.omr_probe_provisioned_teacher_canary_v1(text)
    from public, anon, authenticated;
grant execute on function public.omr_probe_provisioned_teacher_canary_v1(text) to service_role;

-- Preserve the public canary contract marker used by the readiness verifier.
comment on function public.omr_probe_provisioned_teacher_canary_v1(text)
    is 'side-effect-free exact provisioned teacher release canary:202608080007';

-- Existing deployments already have the production boundary's exact function
-- fingerprint. Advance only that pin, preserving every other readiness check.
-- Fresh installs apply the matching production boundary after all migrations.
do $canary_readiness_fingerprint$
declare
    v_old_hash constant text := '0302d984bd9f280d887ff17d7953f1e3346b36631ed0bc40ef2e55be5a61cb4e';
    v_new_hash constant text := 'ce443ff814669bed63aa3e2bce01cb7ebd9b6d33d45973fbed2e9f06307c2a42';
    v_definition text;
    v_old_count integer;
    v_new_count integer;
begin
    if pg_catalog.encode(extensions.digest(pg_catalog.pg_get_functiondef(
        'public.omr_probe_provisioned_teacher_canary_v1(text)'::pg_catalog.regprocedure
    ), 'sha256'), 'hex') is distinct from v_new_hash then
        raise exception 'unexpected Free canary function fingerprint';
    end if;

    v_definition := pg_catalog.pg_get_functiondef(
        'public.omr_service_readiness_v1()'::pg_catalog.regprocedure
    );
    if pg_catalog.strpos(v_definition, 'v_provisioned_teacher_login_ready') > 0 then
        v_old_count := (pg_catalog.length(v_definition)
            - pg_catalog.length(pg_catalog.replace(v_definition, v_old_hash, ''))) / 64;
        v_new_count := (pg_catalog.length(v_definition)
            - pg_catalog.length(pg_catalog.replace(v_definition, v_new_hash, ''))) / 64;
        if v_old_count = 1 and v_new_count = 0 then
            execute pg_catalog.replace(v_definition, v_old_hash, v_new_hash);
        elsif v_old_count <> 0 or v_new_count <> 1 then
            raise exception 'unexpected provisioned canary readiness fingerprint';
        end if;
    end if;
end
$canary_readiness_fingerprint$;

commit;
