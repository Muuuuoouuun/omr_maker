begin;

-- A handwriting object is uploaded outside PostgreSQL between prepare and
-- attach. Bind that durable reservation to the exact entitlement snapshot so
-- a replacement grant cannot revive an expired upload capability.
alter table public.omr_remote_assets
    add column handwriting_reservation_source text,
    add column handwriting_reservation_grant_id text
        references public.omr_pilot_plan_grants(id) on delete restrict,
    add column handwriting_reservation_expires_at timestamp with time zone;

alter table public.omr_remote_assets
    add constraint omr_remote_assets_handwriting_reservation_source_check
        check (handwriting_reservation_source is null
            or handwriting_reservation_source in ('pilot', 'legacy')),
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
                    or (handwriting_reservation_source = 'legacy'
                        and handwriting_reservation_grant_id is null)
                )
            )
        );

create index omr_remote_assets_handwriting_reservation_expiry_idx
    on public.omr_remote_assets (handwriting_reservation_expires_at, id)
    where kind = 'attempt_handwriting'
      and handwriting_reservation_expires_at is not null;

create unique index omr_remote_assets_one_handwriting_per_attempt_uidx
    on public.omr_remote_assets (organization_id, attempt_id)
    where kind = 'attempt_handwriting';

-- Normalize only already-attached pre-008 refs whose immutable registry scope
-- exactly matches the completed attempt. This preserves cutover replay without
-- trusting browser-supplied name, timestamps or extra JSON fields.
update public.omr_attempts attempt
   set payload = pg_catalog.jsonb_set(
       attempt.payload,
       '{drawingsRef}',
       pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
           'store', 'remote',
           'key', asset.id,
           'organizationId', asset.organization_id,
           'kind', 'attempt_handwriting',
           'attemptId', asset.attempt_id,
           'name', asset.original_name,
           'mimeType', asset.mime_type,
           'size', asset.byte_size,
           'updatedAt', pg_catalog.to_char(
               asset.updated_at at time zone 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
           )
       )),
       true
   )
  from public.omr_remote_assets asset
 where attempt.status = 'completed'
   and asset.kind = 'attempt_handwriting'
   and asset.organization_id = attempt.organization_id
   and asset.attempt_id = attempt.id
   and attempt.payload #>> '{drawingsRef,key}' = asset.id
   and attempt.payload #>> '{drawingsRef,organizationId}' = asset.organization_id
   and attempt.payload #>> '{drawingsRef,attemptId}' = asset.attempt_id
   and attempt.payload #>> '{drawingsRef,kind}' = 'attempt_handwriting';

-- Locks and validates the complete provisioned identity graph. This function
-- intentionally does not authorize a paid plan: receipt-bearing callers must
-- validate identity before replay, then authorize the current plan only for a
-- new mutation.
create function public.omr_lock_provisioned_teacher_identity_v1(
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
       or v_member.role <> 'owner'
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
       ) then
        return null;
    end if;

    return pg_catalog.jsonb_build_object(
        'accountId', v_account.id,
        'sessionGeneration', v_account.session_generation,
        'organizationId', v_member.organization_id,
        'memberRole', v_member.role
    );
end;
$$;

-- Called only after identity was locked in this transaction. It binds any
-- current effective paid grant to the exact account and organization. Expired
-- or fully superseded provenance remains a valid identity but resolves free.
create function public.omr_authorize_effective_teacher_plan_v1(
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
       )
       or not exists (
           select 1
             from public.omr_organization_members member
            where member.user_id = p_account_id
              and member.organization_id = p_organization_id
              and member.status = 'active'
              and member.role = 'owner'
       )
       or not exists (
           select 1
             from public.omr_pilot_plan_grants provenance_grant
            where provenance_grant.account_id = p_account_id
              and provenance_grant.organization_id = p_organization_id
       ) then
        return null;
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
       and grant_row.account_id = p_account_id
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

-- Student-owned mutations have no teacher cookie. Derive the sole provisioned
-- owner from immutable ledger provenance, then use the same lock-backed graph
-- and effective-plan validation as teacher mutations.
create function public.omr_read_effective_organization_plan_v1(
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

-- A trigger cannot safely acquire the topology table locks after domain rows
-- are already locked. Top-level mutations therefore acquire the graph first
-- and place a transaction-local, expiry-bearing proof. Triggers only consume
-- this proof and recheck wall-clock expiry; the private setters are never
-- executable by service_role.
create function public.omr_set_effective_plan_transaction_proof_v1(
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

create function public.omr_prove_effective_organization_plan_v1(
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
begin
    v_effective := public.omr_read_effective_organization_plan_v1(p_organization_id);
    if v_effective is null then
        raise exception 'effective organization plan unavailable';
    end if;
    perform public.omr_set_effective_plan_transaction_proof_v1(
        p_organization_id, v_effective
    );
    return v_effective;
end;
$$;

create function public.omr_assert_effective_plan_transaction_proof_v1(
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

-- Explicit non-production self-service compatibility. Legacy account sessions
-- use the hash-derived workspace actor created by the bootstrap path. They are
-- accepted only outside the pilot namespace and only when the account has no
-- pilot-ledger provenance whatsoever.
create function public.omr_lock_legacy_teacher_identity_v1(
    p_account_id text,
    p_session_generation bigint,
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
declare
    v_account public.omr_teacher_accounts%rowtype;
    v_member public.omr_organization_members%rowtype;
    v_profile public.omr_teacher_profiles%rowtype;
    v_organization public.omr_organizations%rowtype;
    v_membership_count integer;
    v_profile_count integer;
begin
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
$$;

create function public.omr_read_legacy_teacher_plan_v1(
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
declare
    v_plan text;
begin
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
$$;

create function public.omr_lock_teacher_mutation_identity_v1(
    p_session_authority text,
    p_account_id text,
    p_session_generation bigint,
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
    if p_session_authority = 'account' then
        if p_actor_user_id is distinct from p_account_id then
            return null;
        end if;
        return public.omr_lock_provisioned_teacher_identity_v1(
            p_account_id, p_session_generation, p_organization_id
        );
    end if;
    if p_session_authority = 'legacy_account' then
        return public.omr_lock_legacy_teacher_identity_v1(
            p_account_id, p_session_generation, p_organization_id, p_actor_user_id
        );
    end if;
    return null;
end;
$$;

create function public.omr_read_teacher_mutation_plan_v1(
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

create function public.omr_assign_students_v2(
    p_session_authority text,
    p_account_id text,
    p_session_generation bigint,
    p_organization_id text,
    p_actor_user_id text,
    p_actor_role text,
    p_exam_id text,
    p_target_student_ids text[],
    p_mode text,
    p_expected_revision bigint,
    p_mutation_id text
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
    v_effective jsonb;
    v_assignment public.omr_assignments%rowtype;
    v_exam public.omr_exams%rowtype;
    v_target_ids text[];
    v_assignment_id text;
    v_fingerprint text;
    v_valid_targets integer;
    v_retake_ready integer;
    v_target_count integer;
    v_plan text;
    v_assignment_exists boolean := false;
    v_reactivate boolean := false;
begin
    if nullif(pg_catalog.btrim(p_organization_id), '') is null
       or nullif(pg_catalog.btrim(p_actor_user_id), '') is null
       or nullif(pg_catalog.btrim(p_exam_id), '') is null
       or nullif(pg_catalog.btrim(p_mutation_id), '') is null
       or pg_catalog.length(p_organization_id) > 256
       or pg_catalog.length(p_actor_user_id) > 256
       or pg_catalog.length(p_exam_id) > 256
       or pg_catalog.length(p_mutation_id) > 256
       or p_mode not in ('base', 'retake')
       or p_expected_revision is null or p_expected_revision < 0
       or pg_catalog.cardinality(p_target_student_ids) not between 1 and 100
       or exists (
           select 1 from pg_catalog.unnest(p_target_student_ids) raw_id
            where nullif(pg_catalog.btrim(raw_id), '') is null
               or pg_catalog.length(raw_id) > 256
       ) then
        return pg_catalog.jsonb_build_object('status', 'invalid_request');
    end if;
    v_identity := public.omr_lock_teacher_mutation_identity_v1(
        p_session_authority, p_account_id, p_session_generation,
        pg_catalog.btrim(p_organization_id), p_actor_user_id
    );
    if v_identity is null or v_identity ->> 'memberRole' is distinct from p_actor_role then
        return pg_catalog.jsonb_build_object('status', 'unauthorized');
    end if;

    select pg_catalog.array_agg(target_id order by target_id)
      into v_target_ids
      from (
          select distinct pg_catalog.btrim(raw_id) as target_id
            from pg_catalog.unnest(p_target_student_ids) raw_id
      ) normalized;
    if pg_catalog.cardinality(v_target_ids) not between 1 and 100 then
        return pg_catalog.jsonb_build_object('status', 'invalid_request');
    end if;

    if p_actor_role not in ('owner', 'admin', 'teacher', 'assistant')
       or not exists (
           select 1
             from public.omr_organization_members member
            where member.organization_id = pg_catalog.btrim(p_organization_id)
              and member.user_id = pg_catalog.btrim(p_actor_user_id)
              and member.status = 'active'
              and member.role = p_actor_role
              and member.role in ('owner', 'admin', 'teacher', 'assistant')
       ) then
        return pg_catalog.jsonb_build_object('status', 'unauthorized');
    end if;

    v_assignment_id := 'assignment_targeted_' || pg_catalog.md5(
        pg_catalog.btrim(p_organization_id) || ':' || pg_catalog.btrim(p_exam_id)
    );
    v_fingerprint := pg_catalog.md5(
        pg_catalog.btrim(p_organization_id) || ':' || pg_catalog.btrim(p_actor_user_id)
        || ':' || pg_catalog.btrim(p_exam_id) || ':' || p_mode || ':'
        || pg_catalog.array_to_string(v_target_ids, ',') || ':' || p_expected_revision::text
    );
    -- Both assign and clear take the same advisory lock, then the exam row, then
    -- the deterministic assignment row. The assignment receipt is checked
    -- before mutable exam/roster state so an exact committed response-loss
    -- retry remains replayable after later domain drift.
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_assignment_id, 608032));

    select * into v_assignment
      from public.omr_assignments assignment
     where assignment.id = v_assignment_id
       and assignment.organization_id = pg_catalog.btrim(p_organization_id)
       and assignment.exam_id = pg_catalog.btrim(p_exam_id)
       and assignment.access_mode = 'targeted'
     for update;
    v_assignment_exists := found;
    v_reactivate := v_assignment_exists and v_assignment.status = 'archived';

    if v_assignment_exists
       and not v_reactivate
       and v_assignment.last_mutation_id = pg_catalog.btrim(p_mutation_id) then
        if v_assignment.last_mutation_fingerprint is distinct from v_fingerprint then
            return pg_catalog.jsonb_build_object('status', 'mutation_conflict');
        end if;
        return pg_catalog.jsonb_build_object(
            'status', 'saved', 'assignmentId', v_assignment.id,
            'revision', v_assignment.revision,
            'targetCount', pg_catalog.cardinality(v_target_ids),
            'mode', v_assignment.assignment_mode, 'idempotent', true
        );
    end if;

    select * into v_exam
      from public.omr_exams exam
     where exam.organization_id = pg_catalog.btrim(p_organization_id)
       and exam.id = pg_catalog.btrim(p_exam_id)
       and exam.archived = false
     for update;
    if not found then
        return pg_catalog.jsonb_build_object('status', 'invalid_request');
    end if;
    if coalesce(v_exam.payload #>> '{accessConfig,type}', 'public') not in ('public', 'group', 'targeted') then
        return pg_catalog.jsonb_build_object('status', 'invalid_request');
    end if;

    select pg_catalog.count(distinct student.id)::integer into v_valid_targets
      from public.omr_student_profiles student
     where student.organization_id = pg_catalog.btrim(p_organization_id)
       and student.id = any(v_target_ids)
       and student.status = 'active'
       and exists (
           select 1
             from public.omr_class_students enrollment
             join public.omr_classes class
               on class.id = enrollment.class_id
              and class.organization_id = enrollment.organization_id
              and class.status = 'active'
            where enrollment.organization_id = student.organization_id
              and enrollment.student_profile_id = student.id
              and enrollment.enrollment_status = 'active'
       );
    if v_valid_targets is distinct from pg_catalog.cardinality(v_target_ids) then
        return pg_catalog.jsonb_build_object('status', 'invalid_targets');
    end if;

    if not v_assignment_exists then
        if p_expected_revision <> 0 then
            return pg_catalog.jsonb_build_object('status', 'revision_conflict', 'currentRevision', 0);
        end if;
    elsif v_reactivate then
        if p_expected_revision <> 0 then
            return pg_catalog.jsonb_build_object(
                'status', 'revision_conflict', 'currentRevision', v_assignment.revision
            );
        end if;
    else
        if v_assignment.revision is distinct from p_expected_revision then
            return pg_catalog.jsonb_build_object(
                'status', 'revision_conflict', 'currentRevision', v_assignment.revision
            );
        end if;
    end if;

    -- Check the whole exam scope, including assignment_id-null sessions created
    -- while the exam was still public/group. This applies to first assignment,
    -- edits, and reactivation after a clear.
    if exists (
        select 1 from public.omr_attempt_sessions attempt_session
         where attempt_session.organization_id = v_exam.organization_id
           and attempt_session.exam_id = v_exam.id
           and attempt_session.status = 'in_progress'
    ) then
        return pg_catalog.jsonb_build_object('status', 'active_sessions');
    end if;

    if p_mode = 'retake' then
        select pg_catalog.count(*)::integer into v_retake_ready
          from pg_catalog.unnest(v_target_ids) target_id
         where exists (
             select 1
               from public.omr_attempts source
              where source.organization_id = pg_catalog.btrim(p_organization_id)
                and source.exam_id = pg_catalog.btrim(p_exam_id)
                and source.student_id = target_id
                and source.status = 'completed'
                and source.retake_source_attempt_id is null
                and (source.assignment_id is null or source.assignment_id = v_assignment_id)
                and exists (
                    select 1 from public.omr_question_results result
                     where result.attempt_id = source.id
                       and result.status in ('wrong', 'unanswered')
                )
         );
        if v_retake_ready is distinct from pg_catalog.cardinality(v_target_ids) then
            return pg_catalog.jsonb_build_object('status', 'retake_unavailable');
        end if;

        -- This is the final no-write boundary for a new premium retake. Read the
        -- effective grant only after every replay/conflict/readiness exit and
        -- immediately before the first exam/assignment mutation below.
        v_effective := public.omr_read_teacher_mutation_plan_v1(
            p_session_authority, p_account_id,
            pg_catalog.btrim(p_organization_id), p_actor_user_id
        );
        if v_effective is null then
            return pg_catalog.jsonb_build_object('status', 'unauthorized');
        end if;
        v_plan := v_effective ->> 'plan';
        if v_plan not in ('pro', 'academy') then
            return pg_catalog.jsonb_build_object('status', 'plan_denied');
        end if;
        perform public.omr_set_effective_plan_transaction_proof_v1(
            pg_catalog.btrim(p_organization_id), v_effective
        );
    end if;

    -- The exam access mode and normalized assignment rows are changed in this
    -- single function invocation, so callers cannot leave an exposed targeted
    -- assignment behind after an application-level second step fails.
    update public.omr_exams exam
       set payload = coalesce(exam.payload, '{}'::jsonb)
           || pg_catalog.jsonb_build_object(
               'accessConfig', pg_catalog.jsonb_build_object('type', 'targeted')
           ),
           updated_at = pg_catalog.now()
     where exam.organization_id = v_exam.organization_id
       and exam.id = v_exam.id;

    if not v_assignment_exists then
        insert into public.omr_assignments (
            id, organization_id, exam_id, title, access_mode, status,
            max_attempts, time_limit_min, created_by_user_id, metadata,
            revision, assignment_mode, last_mutation_id, last_mutation_fingerprint,
            opens_at, closes_at, created_at, updated_at
        ) values (
            v_assignment_id, pg_catalog.btrim(p_organization_id), v_exam.id,
            v_exam.title, 'targeted', 'open',
            case when p_mode = 'retake' then 2 else 1 end,
            case when (v_exam.payload ->> 'durationMin') ~ '^[0-9]+$'
                then (v_exam.payload ->> 'durationMin')::integer else null end,
            pg_catalog.btrim(p_actor_user_id),
            pg_catalog.jsonb_build_object('source', 'individual_student_assignment'),
            1, p_mode, pg_catalog.btrim(p_mutation_id), v_fingerprint,
            case when (v_exam.payload ->> 'startAt') ~ '^\\d{4}-\\d{2}-\\d{2}T'
                then (v_exam.payload ->> 'startAt')::timestamptz else null end,
            case when (v_exam.payload ->> 'endAt') ~ '^\\d{4}-\\d{2}-\\d{2}T'
                then (v_exam.payload ->> 'endAt')::timestamptz else null end,
            pg_catalog.now(), pg_catalog.now()
        ) returning * into v_assignment;
    else
        update public.omr_assignments assignment
           set title = v_exam.title,
               status = 'open',
               assignment_mode = p_mode,
               max_attempts = case when p_mode = 'retake' then 2 else 1 end,
               revision = assignment.revision + 1,
               last_mutation_id = pg_catalog.btrim(p_mutation_id),
               last_mutation_fingerprint = v_fingerprint,
               updated_at = pg_catalog.now()
         where assignment.id = v_assignment_id
        returning * into v_assignment;
    end if;

    delete from public.omr_assignment_targets target
     where target.assignment_id = v_assignment_id
       and target.organization_id = pg_catalog.btrim(p_organization_id)
       and target.target_type = 'student';

    if p_mode = 'base' then
        insert into public.omr_assignment_targets (
            id, assignment_id, organization_id, target_type, target_id,
            student_profile_id, status, retake_source_attempt_id, retake_question_ids
        )
        select v_assignment_id || ':student:' || pg_catalog.md5(target_id),
               v_assignment_id, pg_catalog.btrim(p_organization_id), 'student', target_id,
               target_id, 'active', null, '{}'::integer[]
          from pg_catalog.unnest(v_target_ids) target_id;
    else
        insert into public.omr_assignment_targets (
            id, assignment_id, organization_id, target_type, target_id,
            student_profile_id, status, retake_source_attempt_id, retake_question_ids
        )
        select v_assignment_id || ':student:' || pg_catalog.md5(target_id),
               v_assignment_id, pg_catalog.btrim(p_organization_id), 'student', target_id,
               target_id, 'active', source.id, source.question_ids
          from pg_catalog.unnest(v_target_ids) target_id
          cross join lateral (
              select attempt.id,
                     pg_catalog.array_agg(result.question_id order by result.question_id) as question_ids
                from public.omr_attempts attempt
                join public.omr_question_results result on result.attempt_id = attempt.id
               where attempt.organization_id = pg_catalog.btrim(p_organization_id)
                 and attempt.exam_id = pg_catalog.btrim(p_exam_id)
                 and attempt.student_id = target_id
                 and attempt.status = 'completed'
                 and attempt.retake_source_attempt_id is null
                 and (attempt.assignment_id is null or attempt.assignment_id = v_assignment_id)
                 and result.status in ('wrong', 'unanswered')
               group by attempt.id, attempt.finished_at
               order by attempt.finished_at desc, attempt.id desc
               limit 1
          ) source;

        -- Public/group distribution historically left assignment_id null. Adopt
        -- that exact owned base attempt into the new targeted gradebook scope so
        -- the existing durable-session max-attempt and retake-source invariants
        -- remain true without weakening them for unrelated assignments.
        update public.omr_attempts attempt
           set assignment_id = v_assignment_id,
               payload = attempt.payload || pg_catalog.jsonb_build_object('assignmentId', v_assignment_id)
          from public.omr_assignment_targets target
         where target.assignment_id = v_assignment_id
           and target.retake_source_attempt_id = attempt.id
           and attempt.organization_id = pg_catalog.btrim(p_organization_id)
           and attempt.exam_id = pg_catalog.btrim(p_exam_id)
           and attempt.student_id = target.student_profile_id
           and attempt.status = 'completed'
           and attempt.retake_source_attempt_id is null
           and attempt.assignment_id is null;
        update public.omr_question_results result
           set assignment_id = v_assignment_id
          from public.omr_assignment_targets target
         where target.assignment_id = v_assignment_id
           and target.retake_source_attempt_id = result.attempt_id
           and result.organization_id = pg_catalog.btrim(p_organization_id)
           and result.exam_id = pg_catalog.btrim(p_exam_id)
           and result.student_id = target.student_profile_id;
    end if;

    select pg_catalog.count(*)::integer into v_target_count
      from public.omr_assignment_targets target
     where target.assignment_id = v_assignment_id
       and target.organization_id = pg_catalog.btrim(p_organization_id)
       and target.target_type = 'student'
       and target.status = 'active';
    if v_target_count is distinct from pg_catalog.cardinality(v_target_ids) then
        raise exception 'individual assignment target write mismatch';
    end if;
    return pg_catalog.jsonb_build_object(
        'status', 'saved', 'assignmentId', v_assignment_id,
        'revision', v_assignment.revision, 'targetCount', v_target_count, 'mode', p_mode
    );
end;
$$;

create function public.omr_clear_student_assignment_v2(
    p_session_authority text,
    p_account_id text,
    p_session_generation bigint,
    p_organization_id text,
    p_actor_user_id text,
    p_actor_role text,
    p_exam_id text,
    p_expected_revision bigint,
    p_access_type text,
    p_group_ids text[],
    p_mutation_id text
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
    v_assignment public.omr_assignments%rowtype;
    v_exam public.omr_exams%rowtype;
    v_assignment_id text;
    v_group_ids text[] := '{}'::text[];
    v_fingerprint text;
    v_valid_groups integer;
    v_access_config jsonb;
begin
    if nullif(pg_catalog.btrim(p_organization_id), '') is null
       or nullif(pg_catalog.btrim(p_actor_user_id), '') is null
       or nullif(pg_catalog.btrim(p_exam_id), '') is null
       or nullif(pg_catalog.btrim(p_mutation_id), '') is null
       or pg_catalog.length(p_organization_id) > 256
       or pg_catalog.length(p_actor_user_id) > 256
       or pg_catalog.length(p_exam_id) > 256
       or pg_catalog.length(p_mutation_id) > 256
       or p_expected_revision is null or p_expected_revision < 1
       or p_access_type not in ('public', 'group') then
        return pg_catalog.jsonb_build_object('status', 'invalid_request');
    end if;
    v_identity := public.omr_lock_teacher_mutation_identity_v1(
        p_session_authority, p_account_id, p_session_generation,
        pg_catalog.btrim(p_organization_id), p_actor_user_id
    );
    if v_identity is null or v_identity ->> 'memberRole' is distinct from p_actor_role then
        return pg_catalog.jsonb_build_object('status', 'unauthorized');
    end if;
    if p_actor_role not in ('owner', 'admin', 'teacher', 'assistant')
       or not exists (
           select 1 from public.omr_organization_members member
            where member.organization_id = pg_catalog.btrim(p_organization_id)
              and member.user_id = pg_catalog.btrim(p_actor_user_id)
              and member.status = 'active'
              and member.role = p_actor_role
              and member.role in ('owner', 'admin', 'teacher', 'assistant')
       ) then
        return pg_catalog.jsonb_build_object('status', 'unauthorized');
    end if;

    if p_access_type = 'public' then
        if pg_catalog.cardinality(coalesce(p_group_ids, '{}'::text[])) <> 0 then
            return pg_catalog.jsonb_build_object('status', 'invalid_request');
        end if;
    else
        if pg_catalog.cardinality(p_group_ids) not between 1 and 100
           or exists (
               select 1 from pg_catalog.unnest(p_group_ids) raw_id
                where nullif(pg_catalog.btrim(raw_id), '') is null
                   or pg_catalog.length(raw_id) > 256
           ) then
            return pg_catalog.jsonb_build_object('status', 'invalid_request');
        end if;
        select pg_catalog.array_agg(group_id order by group_id)
          into v_group_ids
          from (
              select distinct pg_catalog.btrim(raw_id) as group_id
                from pg_catalog.unnest(p_group_ids) raw_id
          ) normalized;
        if pg_catalog.cardinality(v_group_ids) not between 1 and 100 then
            return pg_catalog.jsonb_build_object('status', 'invalid_request');
        end if;
    end if;

    v_assignment_id := 'assignment_targeted_' || pg_catalog.md5(
        pg_catalog.btrim(p_organization_id) || ':' || pg_catalog.btrim(p_exam_id)
    );
    v_fingerprint := pg_catalog.md5(
        pg_catalog.btrim(p_organization_id) || ':' || pg_catalog.btrim(p_actor_user_id)
        || ':' || pg_catalog.btrim(p_exam_id) || ':' || p_access_type || ':'
        || pg_catalog.array_to_string(v_group_ids, ',') || ':' || p_expected_revision::text
    );
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_assignment_id, 608032));

    select * into v_assignment
      from public.omr_assignments assignment
     where assignment.id = v_assignment_id
       and assignment.organization_id = pg_catalog.btrim(p_organization_id)
       and assignment.exam_id = pg_catalog.btrim(p_exam_id)
       and assignment.access_mode = 'targeted'
     for update;
    if not found then
        return pg_catalog.jsonb_build_object('status', 'not_found');
    end if;
    if v_assignment.last_mutation_id = pg_catalog.btrim(p_mutation_id) then
        if v_assignment.last_mutation_fingerprint is distinct from v_fingerprint then
            return pg_catalog.jsonb_build_object('status', 'mutation_conflict');
        end if;
        return pg_catalog.jsonb_build_object(
            'status', 'cleared', 'assignmentId', v_assignment.id,
            'revision', v_assignment.revision, 'accessType', p_access_type,
            'idempotent', true
        );
    end if;

    if p_access_type = 'group' then
        select pg_catalog.count(*)::integer into v_valid_groups
          from public.omr_classes class
         where class.organization_id = pg_catalog.btrim(p_organization_id)
           and class.id = any(v_group_ids)
           and class.status = 'active';
        if v_valid_groups is distinct from pg_catalog.cardinality(v_group_ids) then
            return pg_catalog.jsonb_build_object('status', 'invalid_groups');
        end if;
    end if;

    select * into v_exam
      from public.omr_exams exam
     where exam.organization_id = pg_catalog.btrim(p_organization_id)
       and exam.id = pg_catalog.btrim(p_exam_id)
       and exam.archived = false
     for update;
    if not found then
        return pg_catalog.jsonb_build_object('status', 'invalid_request');
    end if;
    if v_assignment.status = 'archived'
       or v_assignment.revision is distinct from p_expected_revision then
        return pg_catalog.jsonb_build_object(
            'status', 'revision_conflict', 'currentRevision', v_assignment.revision
        );
    end if;
    if exists (
        select 1 from public.omr_attempt_sessions attempt_session
         where attempt_session.organization_id = v_exam.organization_id
           and attempt_session.exam_id = v_exam.id
           and attempt_session.status = 'in_progress'
    ) then
        return pg_catalog.jsonb_build_object('status', 'active_sessions');
    end if;

    update public.omr_assignment_targets target
       set status = 'removed'
     where target.assignment_id = v_assignment.id
       and target.organization_id = v_assignment.organization_id
       and target.status <> 'removed';
    update public.omr_assignments assignment
       set status = 'archived',
           revision = assignment.revision + 1,
           last_mutation_id = pg_catalog.btrim(p_mutation_id),
           last_mutation_fingerprint = v_fingerprint,
           updated_at = pg_catalog.now()
     where assignment.id = v_assignment.id
    returning * into v_assignment;

    v_access_config := case when p_access_type = 'group'
        then pg_catalog.jsonb_build_object(
            'type', 'group', 'groupIds', pg_catalog.to_jsonb(v_group_ids)
        )
        else pg_catalog.jsonb_build_object('type', 'public')
    end;
    -- Archive first so the targeted-access trigger permits this broad transition.
    -- Both changes still commit or roll back as one function statement.
    update public.omr_exams exam
       set payload = coalesce(exam.payload, '{}'::jsonb)
           || pg_catalog.jsonb_build_object('accessConfig', v_access_config),
           updated_at = pg_catalog.now()
     where exam.organization_id = v_exam.organization_id
       and exam.id = v_exam.id;

    return pg_catalog.jsonb_build_object(
        'status', 'cleared', 'assignmentId', v_assignment.id,
        'revision', v_assignment.revision, 'accessType', p_access_type
    );
end;
$$;

-- Student attempt triggers have no teacher cookie. They derive the exact
-- provisioned owner from ledger provenance and enforce the effective plan in
-- the same transaction as the attempt/session write.
create or replace function public.omr_assert_targeted_assignment_scope_v1(
    p_organization_id text,
    p_exam_id text,
    p_assignment_id text,
    p_owner_student_id text,
    p_identity_type text,
    p_retake_source_attempt_id text,
    p_retake_question_ids integer[]
)
returns void
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
set lock_timeout = '2s'
as $$
declare
    v_assignment public.omr_assignments%rowtype;
    v_target public.omr_assignment_targets%rowtype;
    v_actual_question_ids integer[];
    v_exam public.omr_exams%rowtype;
begin
    select * into v_exam
      from public.omr_exams exam
     where exam.organization_id = pg_catalog.btrim(p_organization_id)
       and exam.id = pg_catalog.btrim(p_exam_id);
    if nullif(pg_catalog.btrim(p_assignment_id), '') is null then
        if found and coalesce(v_exam.payload #>> '{accessConfig,type}', 'public') = 'targeted' then
            raise exception 'targeted exam requires assignment';
        end if;
        return;
    end if;
    select * into v_assignment from public.omr_assignments assignment
     where assignment.id = pg_catalog.btrim(p_assignment_id)
       and assignment.organization_id = pg_catalog.btrim(p_organization_id)
       and assignment.exam_id = pg_catalog.btrim(p_exam_id);
    if not found then raise exception 'assignment organization or exam invalid'; end if;
    if v_assignment.access_mode <> 'targeted' then return; end if;
    if p_identity_type is null or p_identity_type not in ('temporary', 'registered') then
        raise exception 'attempt identity type invalid';
    end if;
    select * into v_target from public.omr_assignment_targets target
     where target.assignment_id = pg_catalog.btrim(p_assignment_id)
       and target.organization_id = pg_catalog.btrim(p_organization_id)
       and target.student_profile_id = pg_catalog.btrim(p_owner_student_id)
       and target.target_type = 'student' and target.status = 'active';
    if not found then raise exception 'targeted assignment is not owned by student'; end if;
    if not exists (
        select 1 from public.omr_student_profiles student
         where student.organization_id = v_target.organization_id
           and student.id = v_target.student_profile_id
           and student.status = 'active'
    ) or not exists (
        select 1
          from public.omr_class_students enrollment
          join public.omr_classes class
            on class.id = enrollment.class_id
           and class.organization_id = enrollment.organization_id
           and class.status = 'active'
         where enrollment.organization_id = v_target.organization_id
           and enrollment.student_profile_id = v_target.student_profile_id
           and enrollment.enrollment_status = 'active'
    ) then raise exception 'targeted assignment roster inactive'; end if;
    if v_target.retake_source_attempt_id is null then
        if nullif(pg_catalog.btrim(p_retake_source_attempt_id), '') is not null then
            raise exception 'targeted assignment retake scope invalid';
        end if;
    else
        if v_target.retake_source_attempt_id is distinct from nullif(pg_catalog.btrim(p_retake_source_attempt_id), '')
           or v_target.retake_question_ids is distinct from coalesce(p_retake_question_ids, '{}'::integer[]) then
            raise exception 'targeted assignment retake scope invalid';
        end if;
        if not exists (
            select 1 from public.omr_attempts source
             where source.id = v_target.retake_source_attempt_id
               and source.organization_id = v_assignment.organization_id
               and source.exam_id = v_assignment.exam_id
               and (source.assignment_id is null or source.assignment_id = v_assignment.id)
               and source.student_id = v_target.student_profile_id
               and source.status = 'completed'
               and source.retake_source_attempt_id is null
        ) then raise exception 'targeted assignment retake source invalid'; end if;
        select pg_catalog.array_agg(result.question_id order by result.question_id)
          into v_actual_question_ids from public.omr_question_results result
         where result.attempt_id = v_target.retake_source_attempt_id
           and result.status in ('wrong', 'unanswered');
        if v_actual_question_ids is distinct from v_target.retake_question_ids then
            raise exception 'targeted assignment retake questions stale';
        end if;
    end if;
end;
$$;

create or replace function public.omr_validate_targeted_attempt_session_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
set lock_timeout = '2s'
as $$
begin
    if nullif(pg_catalog.btrim(new.retake_source_attempt_id), '') is not null then
        perform public.omr_assert_effective_plan_transaction_proof_v1(
            new.organization_id, true
        );
    end if;
    perform public.omr_assert_targeted_assignment_scope_v1(
        new.organization_id, new.exam_id, new.assignment_id,
        new.owner_student_id, new.identity_type,
        new.retake_source_attempt_id, new.allowed_question_ids
    );
    return new;
end;
$$;

create or replace function public.omr_validate_targeted_attempt_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
set lock_timeout = '2s'
as $$
begin
    -- A retake may adopt one historical public/group base attempt into the
    -- exact targeted assignment, but only while the current effective plan is
    -- paid. The plan is read in this trigger transaction, never from org.plan.
    if tg_op = 'UPDATE'
       and old.assignment_id is null
       and new.assignment_id is not null
       and new.identity_type in ('temporary', 'registered')
       and new.organization_id is not distinct from old.organization_id
       and new.exam_id is not distinct from old.exam_id
       and new.student_id is not distinct from old.student_id
       and new.student_profile_id is not distinct from old.student_profile_id
       and new.identity_type is not distinct from old.identity_type
       and new.status is not distinct from old.status
       and new.score is not distinct from old.score
       and new.total_score is not distinct from old.total_score
       and new.score_percent is not distinct from old.score_percent
       and new.retake_source_attempt_id is not distinct from old.retake_source_attempt_id
       and new.retake_question_ids is not distinct from old.retake_question_ids
       and new.started_at is not distinct from old.started_at
       and new.finished_at is not distinct from old.finished_at
       and new.payload = old.payload || pg_catalog.jsonb_build_object('assignmentId', new.assignment_id)
       and exists (
           select 1
             from public.omr_assignments assignment
             join public.omr_assignment_targets target
               on target.assignment_id = assignment.id
              and target.organization_id = assignment.organization_id
              and target.target_type = 'student'
              and target.status = 'active'
            where assignment.id = new.assignment_id
              and assignment.organization_id = new.organization_id
              and assignment.exam_id = new.exam_id
              and assignment.access_mode = 'targeted'
              and assignment.status in ('scheduled', 'open')
              and target.student_profile_id = new.student_id
              and target.retake_source_attempt_id = new.id
       ) then
        perform public.omr_assert_effective_plan_transaction_proof_v1(
            new.organization_id, true
        );
        return new;
    end if;
    -- Submission/force-finish is a continuation of a durable retake session
    -- whose creation was authorized by the paid proof. It may finish after
    -- natural grant expiry, but cannot invent a retake without that exact
    -- owner/session binding.
    if nullif(pg_catalog.btrim(new.retake_source_attempt_id), '') is not null
       and not exists (
           select 1 from public.omr_attempt_sessions attempt_session
            where attempt_session.attempt_id = new.id
              and attempt_session.organization_id = new.organization_id
              and attempt_session.exam_id = new.exam_id
              and attempt_session.assignment_id = new.assignment_id
              and attempt_session.owner_student_id = new.student_id
              and attempt_session.retake_source_attempt_id = new.retake_source_attempt_id
              and attempt_session.allowed_question_ids = new.retake_question_ids
              and attempt_session.status in ('in_progress', 'submitted')
       ) then
        raise exception 'free plan denies retake';
    end if;
    perform public.omr_assert_targeted_assignment_scope_v1(
        new.organization_id, new.exam_id, new.assignment_id,
        new.student_id, new.identity_type,
        new.retake_source_attempt_id, new.retake_question_ids
    );
    return new;
end;
$$;

create function public.omr_open_attempt_session_v2(
    p_session_id text,
    p_organization_id text,
    p_exam_id text,
    p_assignment_id text,
    p_owner_student_id text,
    p_student_name text,
    p_identity_type text,
    p_submission_id text,
    p_attempt_id text,
    p_retake_source_attempt_id text,
    p_retake_mode text,
    p_requested_question_ids integer[],
    p_exam_question_ids integer[],
    p_exam_updated_at timestamptz,
    p_grading_snapshot jsonb,
    p_duration_seconds integer,
    p_exam_ends_at timestamptz,
    p_new_lease_token_hash text,
    p_current_lease_token_hash text,
    p_lease_seconds integer
)
returns table (
    session_id text,
    status text,
    revision bigint,
    lease_epoch bigint,
    started_at timestamptz,
    deadline_at timestamptz,
    server_now timestamptz,
    answers jsonb,
    sub_question_answers jsonb,
    progress_payload jsonb,
    allowed_question_ids integer[],
    grading_snapshot jsonb,
    submitted_attempt_id text,
    lease_acquired boolean,
    lease_token_rotated boolean
)
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
set lock_timeout = '2s'
as $$
declare
    v_effective jsonb;
begin
    -- Acquire topology/grant locks before the legacy implementation takes any
    -- exam, assignment, student, or session locks. The BEFORE trigger consumes
    -- this proof and rechecks its exact expiry at insertion time.
    if nullif(pg_catalog.btrim(p_retake_source_attempt_id), '') is not null then
        v_effective := public.omr_prove_effective_organization_plan_v1(
            pg_catalog.btrim(p_organization_id)
        );
        if v_effective ->> 'plan' not in ('pro', 'academy') then
            raise exception 'effective plan denies retake session';
        end if;
    end if;
    return query select * from public.omr_open_attempt_session_v1(
        p_session_id, p_organization_id, p_exam_id, p_assignment_id,
        p_owner_student_id, p_student_name, p_identity_type, p_submission_id,
        p_attempt_id, p_retake_source_attempt_id, p_retake_mode,
        p_requested_question_ids, p_exam_question_ids, p_exam_updated_at,
        p_grading_snapshot, p_duration_seconds, p_exam_ends_at,
        p_new_lease_token_hash, p_current_lease_token_hash, p_lease_seconds
    );
end;
$$;

create function public.omr_prepare_teacher_asset_upload_v2(
    p_session_authority text,
    p_account_id text,
    p_session_generation bigint,
    p_organization_id text,
    p_actor_user_id text,
    p_upload jsonb
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
    v_effective jsonb;
    v_upload public.omr_remote_asset_upload_intents%rowtype;
    v_stored public.omr_remote_asset_upload_intents%rowtype;
    v_grant_expires_at timestamptz;
    v_capped_expires_at timestamptz;
    v_count integer;
    v_bytes bigint;
begin
    if pg_catalog.jsonb_typeof(p_upload) is distinct from 'object' then
        raise exception 'invalid teacher upload intent';
    end if;
    select * into v_upload
      from pg_catalog.jsonb_populate_record(
          null::public.omr_remote_asset_upload_intents, p_upload
      );
    if nullif(pg_catalog.btrim(v_upload.id), '') is null
       or nullif(pg_catalog.btrim(v_upload.organization_id), '') is null
       or nullif(pg_catalog.btrim(v_upload.exam_id), '') is null
       or v_upload.organization_id is distinct from pg_catalog.btrim(p_organization_id)
       or v_upload.kind not in ('problem_pdf', 'answer_key_pdf')
       or v_upload.created_by_user_id is distinct from p_actor_user_id
       or nullif(pg_catalog.btrim(v_upload.idempotency_key), '') is null
       or v_upload.storage_bucket is distinct from 'omr-private-assets'
       or v_upload.mime_type is distinct from 'application/pdf'
       or v_upload.byte_size is null or v_upload.byte_size not between 1 and 52428800
       or v_upload.sha256_hex is null or v_upload.sha256_hex !~ '^[a-f0-9]{64}$'
       or v_upload.expires_at is null or v_upload.expires_at <= pg_catalog.clock_timestamp()
       or v_upload.object_path is distinct from (
            'organizations/' || v_upload.organization_id || '/exams/' || v_upload.exam_id || '/'
            || case when v_upload.kind = 'problem_pdf' then 'problem' else 'answer-key' end
            || '/' || v_upload.id || '.pdf'
       ) then
        raise exception 'invalid teacher upload intent';
    end if;
    v_identity := public.omr_lock_teacher_mutation_identity_v1(
        p_session_authority, p_account_id, p_session_generation,
        pg_catalog.btrim(p_organization_id), p_actor_user_id
    );
    if v_identity is null then raise exception 'teacher mutation unauthorized'; end if;
    if exists (
        select 1 from public.omr_exams exam
         where exam.id = v_upload.exam_id
           and exam.organization_id is distinct from v_upload.organization_id
    ) then
        raise exception 'upload exam identifier belongs to another organization';
    end if;

    perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('omr:teacher-upload-global', 604006)
    );
    perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(v_upload.organization_id, 604006)
    );
    perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
            v_upload.organization_id || pg_catalog.chr(31) || p_actor_user_id, 604005
        )
    );
    perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
            v_upload.organization_id || pg_catalog.chr(31) || p_actor_user_id
            || pg_catalog.chr(31) || v_upload.exam_id || pg_catalog.chr(31) || v_upload.kind,
            604005
        )
    );

    select * into v_stored
      from public.omr_remote_asset_upload_intents intent
     where intent.organization_id = v_upload.organization_id
       and intent.created_by_user_id = p_actor_user_id
       and intent.idempotency_key = v_upload.idempotency_key
     for update;
    if found then
        if v_stored.id is distinct from v_upload.id
           or v_stored.exam_id is distinct from v_upload.exam_id
           or v_stored.kind is distinct from v_upload.kind
           or v_stored.storage_bucket is distinct from v_upload.storage_bucket
           or v_stored.object_path is distinct from v_upload.object_path
           or v_stored.mime_type is distinct from v_upload.mime_type
           or v_stored.byte_size is distinct from v_upload.byte_size
           or v_stored.sha256_hex is distinct from v_upload.sha256_hex
           or v_stored.original_name is distinct from v_upload.original_name then
            raise exception 'upload idempotency key belongs to another request';
        end if;
        if v_stored.status = 'finalized'
           and exists (
               select 1 from public.omr_remote_assets asset
                where asset.id = v_stored.id
                  and asset.organization_id = v_stored.organization_id
                  and asset.exam_id = v_stored.exam_id
                  and asset.kind = v_stored.kind
                  and asset.storage_bucket = v_stored.storage_bucket
                  and asset.object_path = v_stored.object_path
                  and asset.mime_type = v_stored.mime_type
                  and asset.byte_size = v_stored.byte_size
                  and asset.sha256_hex = v_stored.sha256_hex
           ) then
            return pg_catalog.to_jsonb(v_stored)
                || pg_catalog.jsonb_build_object('capabilityReplay', true);
        end if;
        if v_stored.status not in ('pending', 'uploaded')
           or v_stored.expires_at <= pg_catalog.clock_timestamp() then
            raise exception 'teacher upload intent expired; use a fresh idempotency key';
        end if;
        v_effective := public.omr_read_teacher_mutation_plan_v1(
            p_session_authority, p_account_id, v_upload.organization_id, p_actor_user_id
        );
        if v_effective is null or v_effective ->> 'plan' not in ('pro', 'academy') then
            raise exception 'teacher upload plan entitlement required';
        end if;
        if nullif(v_effective ->> 'grantExpiresAt', '') is not null then
            v_grant_expires_at := (v_effective ->> 'grantExpiresAt')::timestamptz;
        elsif nullif(v_effective ->> 'expiresAt', '') is not null then
            v_grant_expires_at := (v_effective ->> 'expiresAt')::timestamptz;
        end if;
        if v_effective ->> 'source' = 'pilot'
           and (v_grant_expires_at is null
                or v_grant_expires_at < pg_catalog.clock_timestamp() + interval '2 hours') then
            raise exception 'teacher upload grant shorter than signed upload capability';
        end if;
        if v_grant_expires_at is not null and v_stored.expires_at > v_grant_expires_at then
            raise exception 'teacher upload intent exceeds grant expiry';
        end if;
        if v_stored.expires_at <= pg_catalog.clock_timestamp() then
            raise exception 'teacher upload plan entitlement expired';
        end if;
        return pg_catalog.to_jsonb(v_stored);
    end if;

    update public.omr_remote_asset_upload_intents intent
       set status = 'expired', updated_at = pg_catalog.now()
     where intent.organization_id = v_upload.organization_id
       and intent.created_by_user_id = p_actor_user_id
       and intent.status in ('pending', 'uploaded')
       and intent.expires_at <= pg_catalog.clock_timestamp();

    select pg_catalog.count(*)::integer, coalesce(pg_catalog.sum(item.byte_size), 0)::bigint
      into v_count, v_bytes
      from (
          select intent.id, intent.byte_size
            from public.omr_remote_asset_upload_intents intent
           where intent.organization_id = v_upload.organization_id
             and intent.created_by_user_id = p_actor_user_id
             and intent.created_at >= pg_catalog.now() - interval '24 hours'
          union
          select asset.id, asset.byte_size
            from public.omr_remote_assets asset
           where asset.organization_id = v_upload.organization_id
             and asset.created_by_user_id = p_actor_user_id
             and asset.created_at >= pg_catalog.now() - interval '24 hours'
      ) item;
    if v_count >= 20 or v_bytes + v_upload.byte_size > 1073741824 then
        raise exception 'teacher upload admission window exceeded';
    end if;
    select pg_catalog.count(*)::integer, coalesce(pg_catalog.sum(item.byte_size), 0)::bigint
      into v_count, v_bytes
      from (
          select intent.id, intent.byte_size
            from public.omr_remote_asset_upload_intents intent
           where intent.organization_id = v_upload.organization_id
             and intent.created_at >= pg_catalog.now() - interval '24 hours'
          union
          select asset.id, asset.byte_size
            from public.omr_remote_assets asset
           where asset.organization_id = v_upload.organization_id
             and asset.created_at >= pg_catalog.now() - interval '24 hours'
      ) item;
    if v_count >= 100 or v_bytes + v_upload.byte_size > 5368709120 then
        raise exception 'teacher upload admission window exceeded';
    end if;
    select pg_catalog.count(*)::integer, coalesce(pg_catalog.sum(item.byte_size), 0)::bigint
      into v_count, v_bytes
      from (
          select intent.id, intent.byte_size
            from public.omr_remote_asset_upload_intents intent
           where intent.created_at >= pg_catalog.now() - interval '24 hours'
          union
          select asset.id, asset.byte_size
            from public.omr_remote_assets asset
           where asset.created_at >= pg_catalog.now() - interval '24 hours'
      ) item;
    if v_count >= 100 or v_bytes + v_upload.byte_size > 5368709120 then
        raise exception 'teacher upload admission window exceeded';
    end if;

    select pg_catalog.count(*)::integer into v_count
      from public.omr_remote_asset_upload_intents intent
     where intent.organization_id = v_upload.organization_id
       and intent.created_by_user_id = p_actor_user_id
       and intent.created_at >= pg_catalog.now() - interval '1 minute';
    if v_count >= 12 then raise exception 'teacher upload prepare rate exceeded'; end if;
    select pg_catalog.count(*)::integer, coalesce(pg_catalog.sum(intent.byte_size), 0)::bigint
      into v_count, v_bytes
      from public.omr_remote_asset_upload_intents intent
     where intent.organization_id = v_upload.organization_id
       and intent.created_by_user_id = p_actor_user_id
       and intent.status in ('pending', 'uploaded')
       and intent.expires_at > pg_catalog.clock_timestamp();
    if v_count >= 8 or v_bytes + v_upload.byte_size > 209715200 then
        raise exception 'teacher upload active intent limit exceeded';
    end if;
    select pg_catalog.count(*)::integer, coalesce(pg_catalog.sum(intent.byte_size), 0)::bigint
      into v_count, v_bytes
      from public.omr_remote_asset_upload_intents intent
     where intent.organization_id = v_upload.organization_id
       and intent.created_by_user_id = p_actor_user_id
       and intent.exam_id = v_upload.exam_id
       and intent.kind = v_upload.kind
       and intent.status in ('pending', 'uploaded')
       and intent.expires_at > pg_catalog.clock_timestamp();
    if v_count >= 3 or v_bytes + v_upload.byte_size > 104857600 then
        raise exception 'teacher upload active intent limit exceeded';
    end if;

    -- The effective read is the final no-write boundary. A pilot org's forged
    -- organizations.plan is never consulted.
    v_effective := public.omr_read_teacher_mutation_plan_v1(
        p_session_authority, p_account_id, v_upload.organization_id, p_actor_user_id
    );
    if v_effective is null or v_effective ->> 'plan' not in ('pro', 'academy') then
        raise exception 'teacher upload plan entitlement required';
    end if;
    if nullif(v_effective ->> 'grantExpiresAt', '') is not null then
        v_grant_expires_at := (v_effective ->> 'grantExpiresAt')::timestamptz;
    elsif nullif(v_effective ->> 'expiresAt', '') is not null then
        v_grant_expires_at := (v_effective ->> 'expiresAt')::timestamptz;
    end if;
    if v_effective ->> 'source' = 'pilot'
       and (v_grant_expires_at is null
            or v_grant_expires_at < pg_catalog.clock_timestamp() + interval '2 hours') then
        raise exception 'teacher upload grant shorter than signed upload capability';
    end if;
    v_capped_expires_at := case when v_grant_expires_at is null
        then pg_catalog.least(v_upload.expires_at, pg_catalog.now() + interval '2 hours')
        else pg_catalog.least(
            v_upload.expires_at,
            pg_catalog.now() + interval '2 hours',
            v_grant_expires_at
        )
    end;
    if v_capped_expires_at <= pg_catalog.clock_timestamp() then
        raise exception 'teacher upload plan entitlement expired';
    end if;
    insert into public.omr_remote_asset_upload_intents (
        id, organization_id, exam_id, kind, created_by_user_id,
        idempotency_key, storage_bucket, object_path, mime_type, byte_size,
        sha256_hex, original_name, status, expires_at, created_at, updated_at
    ) values (
        v_upload.id, v_upload.organization_id, v_upload.exam_id, v_upload.kind,
        p_actor_user_id, v_upload.idempotency_key, v_upload.storage_bucket,
        v_upload.object_path, v_upload.mime_type, v_upload.byte_size,
        v_upload.sha256_hex, v_upload.original_name, 'pending',
        v_capped_expires_at, pg_catalog.now(), pg_catalog.now()
    ) returning * into v_stored;
    return pg_catalog.to_jsonb(v_stored);
end;
$$;

create function public.omr_authorize_teacher_asset_finalize_v2(
    p_session_authority text,
    p_account_id text,
    p_session_generation bigint,
    p_actor_user_id text,
    p_organization_id text,
    p_upload_id text,
    p_declaration jsonb
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
    v_effective jsonb;
    v_intent public.omr_remote_asset_upload_intents%rowtype;
    v_byte_size bigint;
    v_grant_expires_at timestamptz;
begin
    v_identity := public.omr_lock_teacher_mutation_identity_v1(
        p_session_authority, p_account_id, p_session_generation,
        pg_catalog.btrim(p_organization_id), p_actor_user_id
    );
    if v_identity is null then raise exception 'teacher mutation unauthorized'; end if;
    if pg_catalog.jsonb_typeof(p_declaration) is distinct from 'object' then
        raise exception 'teacher upload scope denied';
    end if;
    begin v_byte_size := (p_declaration ->> 'byte_size')::bigint;
    exception when others then raise exception 'teacher upload scope denied'; end;
    select intent.* into v_intent
      from public.omr_remote_asset_upload_intents intent
     where intent.id = pg_catalog.btrim(p_upload_id)
       and intent.organization_id = pg_catalog.btrim(p_organization_id)
       and intent.created_by_user_id = p_actor_user_id
       and intent.exam_id = p_declaration ->> 'exam_id'
       and intent.kind = p_declaration ->> 'kind'
       and intent.storage_bucket = p_declaration ->> 'storage_bucket'
       and intent.object_path = p_declaration ->> 'object_path'
       and intent.mime_type = p_declaration ->> 'mime_type'
       and intent.byte_size = v_byte_size
       and intent.sha256_hex = p_declaration ->> 'sha256_hex'
     for update;
    if not found then raise exception 'teacher upload scope denied'; end if;
    if v_intent.status = 'finalized'
       and exists (
           select 1 from public.omr_remote_assets asset
            where asset.id = v_intent.id
              and asset.organization_id = v_intent.organization_id
              and asset.exam_id = v_intent.exam_id
              and asset.kind = v_intent.kind
              and asset.storage_bucket = v_intent.storage_bucket
              and asset.object_path = v_intent.object_path
              and asset.mime_type = v_intent.mime_type
              and asset.byte_size = v_intent.byte_size
              and asset.sha256_hex = v_intent.sha256_hex
       ) and not exists (
           select 1 from public.omr_remote_asset_cleanup_queue queue
            where queue.storage_bucket = v_intent.storage_bucket
              and queue.object_path = v_intent.object_path
       ) then
        return pg_catalog.to_jsonb(v_intent)
            || pg_catalog.jsonb_build_object('capabilityReplay', true);
    end if;
    if v_intent.status not in ('pending', 'uploaded')
       or v_intent.expires_at <= pg_catalog.clock_timestamp() then
        raise exception 'teacher upload scope denied';
    end if;
    v_effective := public.omr_read_teacher_mutation_plan_v1(
        p_session_authority, p_account_id, v_intent.organization_id, p_actor_user_id
    );
    if v_effective is null or v_effective ->> 'plan' not in ('pro', 'academy') then
        raise exception 'teacher upload plan entitlement required';
    end if;
    if nullif(v_effective ->> 'grantExpiresAt', '') is not null then
        v_grant_expires_at := (v_effective ->> 'grantExpiresAt')::timestamptz;
    elsif nullif(v_effective ->> 'expiresAt', '') is not null then
        v_grant_expires_at := (v_effective ->> 'expiresAt')::timestamptz;
    end if;
    if v_grant_expires_at is not null and v_intent.expires_at > v_grant_expires_at then
        raise exception 'teacher upload intent exceeds grant expiry';
    end if;
    return pg_catalog.to_jsonb(v_intent);
end;
$$;

create function public.omr_finalize_teacher_asset_upload_v2(
    p_session_authority text,
    p_account_id text,
    p_session_generation bigint,
    p_actor_user_id text,
    p_organization_id text,
    p_upload_id text,
    p_observation jsonb
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
    v_effective jsonb;
    v_intent public.omr_remote_asset_upload_intents%rowtype;
    v_asset public.omr_remote_assets%rowtype;
    v_bytes bigint;
    v_grant_expires_at timestamptz;
begin
    v_identity := public.omr_lock_teacher_mutation_identity_v1(
        p_session_authority, p_account_id, p_session_generation,
        pg_catalog.btrim(p_organization_id), p_actor_user_id
    );
    if v_identity is null then raise exception 'teacher mutation unauthorized'; end if;
    if pg_catalog.jsonb_typeof(p_observation) is distinct from 'object' then
        raise exception 'invalid teacher upload finalization';
    end if;
    begin v_bytes := (p_observation ->> 'byte_size')::bigint;
    exception when others then raise exception 'storage observation mismatch'; end;
    select * into v_intent
      from public.omr_remote_asset_upload_intents intent
     where intent.id = pg_catalog.btrim(p_upload_id)
       and intent.organization_id = pg_catalog.btrim(p_organization_id)
       and intent.created_by_user_id = p_actor_user_id
     for update;
    if not found then raise exception 'teacher upload intent is outside actor scope'; end if;
    if v_intent.status = 'finalized' then
        select asset.* into v_asset from public.omr_remote_assets asset
         where asset.id = v_intent.id
           and asset.organization_id = v_intent.organization_id
           and asset.exam_id = v_intent.exam_id
           and asset.kind = v_intent.kind
           and asset.storage_bucket = v_intent.storage_bucket
           and asset.object_path = v_intent.object_path
           and asset.mime_type = v_intent.mime_type
           and asset.byte_size = v_intent.byte_size
           and asset.sha256_hex = v_intent.sha256_hex;
        if not found then raise exception 'finalized teacher asset missing'; end if;
        return pg_catalog.to_jsonb(v_asset)
            || pg_catalog.jsonb_build_object('capabilityReplay', true);
    end if;
    if v_intent.status not in ('pending', 'uploaded')
       or v_intent.expires_at <= pg_catalog.clock_timestamp() then
        raise exception 'teacher upload intent expired';
    end if;
    v_effective := public.omr_read_teacher_mutation_plan_v1(
        p_session_authority, p_account_id, v_intent.organization_id, p_actor_user_id
    );
    if v_effective is null or v_effective ->> 'plan' not in ('pro', 'academy') then
        raise exception 'teacher upload plan entitlement required';
    end if;
    if nullif(v_effective ->> 'grantExpiresAt', '') is not null then
        v_grant_expires_at := (v_effective ->> 'grantExpiresAt')::timestamptz;
    elsif nullif(v_effective ->> 'expiresAt', '') is not null then
        v_grant_expires_at := (v_effective ->> 'expiresAt')::timestamptz;
    end if;
    if v_grant_expires_at is not null and v_intent.expires_at > v_grant_expires_at then
        raise exception 'teacher upload intent exceeds grant expiry';
    end if;
    if p_observation ->> 'storage_bucket' is distinct from v_intent.storage_bucket
       or p_observation ->> 'object_path' is distinct from v_intent.object_path
       or p_observation ->> 'mime_type' is distinct from v_intent.mime_type
       or v_bytes is distinct from v_intent.byte_size
       or p_observation ->> 'sha256_hex' is distinct from v_intent.sha256_hex then
        raise exception 'storage observation mismatch';
    end if;
    if v_intent.status = 'pending' then
        update public.omr_remote_asset_upload_intents intent
           set status = 'uploaded', uploaded_at = pg_catalog.now(), updated_at = pg_catalog.now()
         where intent.id = v_intent.id
        returning * into v_intent;
    end if;
    return pg_catalog.to_jsonb(v_intent);
end;
$$;

create function public.omr_prepare_attempt_handwriting_asset_v2(
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
    if v_source = 'legacy' and (
        v_grant_id is not null or v_grant_expires_at is not null
    ) then raise exception 'handwriting archive legacy plan invalid'; end if;
    if v_source not in ('pilot', 'legacy') then
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
           or (v_source = 'legacy'
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

create function public.omr_attach_attempt_handwriting_v2(
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
       or (v_source = 'legacy' and (
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

-- Expired unattached handwriting reservations are no longer protected by the
-- general seven-day submitted-session crash-recovery hold. Deleting the
-- metadata fires the immutable cleanup outbox trigger before the canonical row
-- disappears; attached refs remain durable forever.
alter function public.omr_claim_remote_asset_cleanup_v1(text,integer,integer)
    rename to omr_claim_remote_asset_cleanup_v8_snapshot;

create function public.omr_claim_remote_asset_cleanup_v1(
    p_worker_id text,
    p_limit integer default 50,
    p_lease_seconds integer default 60
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '10s'
set lock_timeout = '2s'
as $$
begin
    if nullif(pg_catalog.btrim(p_worker_id), '') is null
       or length(p_worker_id) > 128
       or p_limit is null or p_limit not between 1 and 100
       or p_lease_seconds is null or p_lease_seconds not between 15 and 900 then
        raise exception 'invalid remote asset cleanup claim';
    end if;
    with expired_handwriting_candidates as materialized (
        select asset.id
         from public.omr_remote_assets asset
         where asset.kind = 'attempt_handwriting'
           and (
               asset.handwriting_reservation_expires_at
                    <= pg_catalog.clock_timestamp()
               or (
                   asset.handwriting_reservation_source is null
                   and asset.handwriting_reservation_grant_id is null
                   and asset.handwriting_reservation_expires_at is null
               )
               or (
                   asset.handwriting_reservation_source = 'pilot'
                   and not exists (
                       select 1
                         from public.omr_pilot_plan_grants grant_row
                        where grant_row.id = asset.handwriting_reservation_grant_id
                          and grant_row.organization_id = asset.organization_id
                          and grant_row.state = 'active'
                          and grant_row.superseded_at is null
                          and grant_row.expires_at > pg_catalog.clock_timestamp()
                   )
               )
           )
           and not exists (
               select 1
                 from public.omr_attempts attempt
                where attempt.organization_id = asset.organization_id
                  and attempt.id = asset.attempt_id
                  and attempt.status = 'completed'
                  and attempt.payload #>> '{drawingsRef,key}' = asset.id
                  and attempt.payload #>> '{drawingsRef,organizationId}'
                        = asset.organization_id
                  and attempt.payload #>> '{drawingsRef,attemptId}' = asset.attempt_id
           )
         order by asset.handwriting_reservation_expires_at nulls first, asset.id
         for update skip locked
         limit p_limit
    )
    delete from public.omr_remote_assets asset
     using expired_handwriting_candidates candidate
     where asset.id = candidate.id;

    return public.omr_claim_remote_asset_cleanup_v8_snapshot(
        p_worker_id, p_limit, p_lease_seconds
    );
end;
$$;

create function public.omr_reserve_plan_usage_v2(
    p_session_authority text,
    p_account_id text,
    p_session_generation bigint,
    p_organization_id text,
    p_actor_user_id text,
    p_metric text,
    p_resource_key text
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
    v_effective jsonb;
    v_period_start date;
    v_limit integer;
    v_observed integer;
    v_aggregate_used integer := 0;
    v_existing boolean := false;
    v_result record;
begin
    if nullif(pg_catalog.btrim(p_organization_id), '') is null
       or nullif(pg_catalog.btrim(p_account_id), '') is null
       or nullif(pg_catalog.btrim(p_actor_user_id), '') is null
       or p_metric is null or p_metric not in ('exams', 'aiRecognition')
       or nullif(pg_catalog.btrim(p_resource_key), '') is null
       or length(p_resource_key) > 256
       or (p_metric = 'exams' and p_resource_key !~ '^exam:[A-Za-z0-9._:-]{1,200}$')
       or (p_metric = 'aiRecognition' and p_resource_key !~ '^ai:[A-Fa-f0-9-]{36}$') then
        raise exception 'invalid plan usage reservation';
    end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        p_organization_id || pg_catalog.chr(31) || p_metric
            || pg_catalog.chr(31) || pg_catalog.btrim(p_resource_key),
        608008
    ));
    v_identity := public.omr_lock_teacher_mutation_identity_v1(
        p_session_authority, p_account_id, p_session_generation,
        p_organization_id, p_actor_user_id
    );
    if v_identity is null then raise exception 'teacher session unauthorized'; end if;
    v_effective := public.omr_read_teacher_mutation_plan_v1(
        p_session_authority, p_account_id, p_organization_id, p_actor_user_id
    );
    if v_effective is null then raise exception 'effective plan unavailable'; end if;
    v_period_start := pg_catalog.date_trunc(
        'month', pg_catalog.clock_timestamp() at time zone 'Asia/Seoul'
    )::date;
    v_limit := case
        when p_metric = 'exams' and v_effective ->> 'plan' = 'free' then 5
        when p_metric = 'aiRecognition' and v_effective ->> 'plan' = 'free' then 100
        when p_metric = 'aiRecognition' and v_effective ->> 'plan' = 'pro' then 5000
        else 2147483647
    end;
    if p_metric = 'exams' then
        select pg_catalog.count(*)::integer into v_observed
          from public.omr_exams exam
         where exam.organization_id = p_organization_id
           and exam.created_at >= v_period_start::timestamp at time zone 'Asia/Seoul'
           and exam.created_at < (v_period_start + interval '1 month')::timestamp at time zone 'Asia/Seoul';
    else
        select coalesce(usage.used, 0)::integer into v_observed
          from public.omr_plan_usage usage
         where usage.organization_id = p_organization_id
           and usage.metric = p_metric
           and usage.period_start = v_period_start
         for update;
        if not found then v_observed := 0; end if;
    end if;
    select coalesce(usage.used, 0)::integer into v_aggregate_used
      from public.omr_plan_usage usage
     where usage.organization_id = p_organization_id
       and usage.metric = p_metric
       and usage.period_start = v_period_start
     for update;
    if not found then v_aggregate_used := 0; end if;
    perform reservation.resource_key
      from public.omr_plan_usage_reservations reservation
     where reservation.organization_id = p_organization_id
       and reservation.metric = p_metric
       and reservation.period_start = v_period_start
       and reservation.resource_key = pg_catalog.btrim(p_resource_key)
     for update;
    v_existing := found;
    -- A paid-era reservation is not a receipt. Reauthorization after expiry or
    -- downgrade must satisfy the current limit before the historical worker is
    -- allowed to renew it.
    if greatest(v_observed, v_aggregate_used) > v_limit then
        return pg_catalog.jsonb_build_object(
            'allowed', false, 'used', greatest(v_observed, v_aggregate_used),
            'idempotent', v_existing
        );
    end if;
    select * into v_result
      from public.omr_reserve_plan_usage(
          p_organization_id, p_metric, v_period_start,
          pg_catalog.btrim(p_resource_key), 1, v_observed, v_limit
      );
    return pg_catalog.jsonb_build_object(
        'allowed', v_result.allowed,
        'used', v_result.used,
        'idempotent', v_result.idempotent
    );
end;
$$;

create function public.omr_release_plan_usage_v2(
    p_session_authority text,
    p_account_id text,
    p_session_generation bigint,
    p_organization_id text,
    p_actor_user_id text,
    p_metric text,
    p_resource_key text
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
    v_period_start date;
    v_period_count integer;
    v_exam_id text;
    v_used integer := 0;
    v_result record;
begin
    if nullif(pg_catalog.btrim(p_organization_id), '') is null
       or nullif(pg_catalog.btrim(p_account_id), '') is null
       or nullif(pg_catalog.btrim(p_actor_user_id), '') is null
       or p_metric is null or p_metric not in ('exams', 'aiRecognition')
       or nullif(pg_catalog.btrim(p_resource_key), '') is null
       or length(p_resource_key) > 256
       or (p_metric = 'exams' and p_resource_key !~ '^exam:[A-Za-z0-9._:-]{1,200}$')
       or (p_metric = 'aiRecognition' and p_resource_key !~ '^ai:[A-Fa-f0-9-]{36}$') then
        raise exception 'invalid plan usage release';
    end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        p_organization_id || pg_catalog.chr(31) || p_metric
            || pg_catalog.chr(31) || pg_catalog.btrim(p_resource_key),
        608008
    ));
    v_identity := public.omr_lock_teacher_mutation_identity_v1(
        p_session_authority, p_account_id, p_session_generation,
        p_organization_id, p_actor_user_id
    );
    if v_identity is null then raise exception 'teacher session unauthorized'; end if;
    perform reservation.period_start
      from public.omr_plan_usage_reservations reservation
     where reservation.organization_id = p_organization_id
       and reservation.metric = p_metric
       and reservation.resource_key = pg_catalog.btrim(p_resource_key)
     order by reservation.period_start
     for update;
    select pg_catalog.count(*)::integer, pg_catalog.min(reservation.period_start)
      into v_period_count, v_period_start
      from public.omr_plan_usage_reservations reservation
     where reservation.organization_id = p_organization_id
       and reservation.metric = p_metric
       and reservation.resource_key = pg_catalog.btrim(p_resource_key);
    if v_period_count > 1 then raise exception 'ambiguous plan usage release'; end if;
    if v_period_count = 0 then
        return pg_catalog.jsonb_build_object('released', false, 'used', 0);
    end if;
    -- A quota reservation is only provisional until the canonical exam row
    -- exists. Response-loss compensation must never refund a committed exam.
    if p_metric = 'exams' then
        v_exam_id := pg_catalog.substr(pg_catalog.btrim(p_resource_key), 6);
        perform exam.id
          from public.omr_exams exam
         where exam.organization_id = p_organization_id
           and exam.id = v_exam_id
         for update;
        if found then
            select coalesce(usage.used, 0)::integer
              into v_used
              from public.omr_plan_usage usage
             where usage.organization_id = p_organization_id
               and usage.metric = p_metric
               and usage.period_start = v_period_start
             for update;
            if not found then v_used := 0; end if;
            return pg_catalog.jsonb_build_object('released', false, 'used', v_used);
        end if;
    end if;
    select * into v_result from public.omr_release_plan_usage(
        p_organization_id, p_metric, v_period_start,
        pg_catalog.btrim(p_resource_key)
    );
    return pg_catalog.jsonb_build_object(
        'released', v_result.released,
        'used', v_result.used
    );
end;
$$;

create function public.omr_sync_student_plan_usage_v2(
    p_session_authority text,
    p_account_id text,
    p_session_generation bigint,
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
declare
    v_identity jsonb;
    v_effective jsonb;
    v_limit integer;
    v_resource_keys text[];
    v_observed integer;
    v_result record;
begin
    if nullif(pg_catalog.btrim(p_organization_id), '') is null
       or nullif(pg_catalog.btrim(p_account_id), '') is null
       or nullif(pg_catalog.btrim(p_actor_user_id), '') is null then
        raise exception 'invalid student usage synchronization';
    end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        p_organization_id || pg_catalog.chr(31) || 'students', 608008
    ));
    v_identity := public.omr_lock_teacher_mutation_identity_v1(
        p_session_authority, p_account_id, p_session_generation,
        p_organization_id, p_actor_user_id
    );
    if v_identity is null then raise exception 'teacher session unauthorized'; end if;
    v_effective := public.omr_read_teacher_mutation_plan_v1(
        p_session_authority, p_account_id, p_organization_id, p_actor_user_id
    );
    if v_effective is null then raise exception 'effective plan unavailable'; end if;
    v_limit := case v_effective ->> 'plan'
        when 'free' then 30 when 'pro' then 300 else 2147483647 end;
    select coalesce(pg_catalog.array_agg(profile.id order by profile.id), '{}'::text[]),
           pg_catalog.count(*)::integer
      into v_resource_keys, v_observed
      from public.omr_student_profiles profile
     where profile.organization_id = p_organization_id
       and profile.status in ('invited', 'active', 'inactive');
    select * into v_result from public.omr_sync_student_plan_usage(
        p_organization_id, v_resource_keys, v_observed, 2147483647
    );
    return pg_catalog.jsonb_build_object(
        'allowed', v_observed <= v_limit, 'used', v_result.used
    );
end;
$$;

create function public.omr_save_feedback_effective_worker_v4(
    p_organization_id text,
    p_feedback jsonb,
    p_expected_revision bigint,
    p_mutation_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
set lock_timeout = '2s'
as $$
declare
    v_request_hash text;
    v_hash_feedback jsonb;
    v_markup_strokes bigint;
    v_receipt public.omr_feedback_mutations%rowtype;
    v_feedback public.omr_attempt_feedback%rowtype;
    v_attempt public.omr_attempts%rowtype;
    v_current public.omr_attempt_feedback%rowtype;
    v_stored public.omr_attempt_feedback%rowtype;
    v_response jsonb;
    v_now timestamptz := clock_timestamp();
begin
    if nullif(trim(p_organization_id), '') is null
       or nullif(trim(p_mutation_id), '') is null
       or p_expected_revision is null
       or p_expected_revision < 0
       or jsonb_typeof(p_feedback) is distinct from 'object' then
        raise exception 'invalid feedback mutation';
    end if;

    if pg_catalog.octet_length((p_feedback - 'markup_drawings')::text) > 262144 then
        raise exception 'feedback metadata exceeds limit';
    end if;
    if p_feedback ? 'markup_drawings'
       and p_feedback -> 'markup_drawings' is distinct from 'null'::jsonb then
        if pg_catalog.jsonb_typeof(p_feedback -> 'markup_drawings') is distinct from 'object'
           or pg_catalog.octet_length((p_feedback -> 'markup_drawings')::text) > 5242880 then
            raise exception 'feedback markup exceeds limit';
        end if;
        if exists (
               select 1
                 from pg_catalog.jsonb_each(p_feedback -> 'markup_drawings') page
                where pg_catalog.jsonb_typeof(page.value) is distinct from 'array'
           ) then
            raise exception 'feedback markup shape exceeds limit';
        end if;
        if (select count(*) from pg_catalog.jsonb_each(p_feedback -> 'markup_drawings')) > 500
           or exists (
               select 1
                 from pg_catalog.jsonb_each(p_feedback -> 'markup_drawings') page
                where page.key !~ '^[1-9][0-9]{0,3}$'
                   or pg_catalog.jsonb_array_length(page.value) > 20000
           ) then
            raise exception 'feedback markup shape exceeds limit';
        end if;
        select coalesce(sum(pg_catalog.jsonb_array_length(page.value)), 0)::bigint
          into v_markup_strokes
          from pg_catalog.jsonb_each(p_feedback -> 'markup_drawings') page;
        if v_markup_strokes > 20000
           or exists (
               select 1
                 from pg_catalog.jsonb_each(p_feedback -> 'markup_drawings') page
                 cross join lateral pg_catalog.jsonb_array_elements(page.value) stroke(value)
                where pg_catalog.jsonb_typeof(stroke.value) is distinct from 'string'
                   or pg_catalog.octet_length(stroke.value #>> '{}') > 65536
           ) then
            raise exception 'feedback markup shape exceeds limit';
        end if;
    end if;

    v_hash_feedback := p_feedback - 'updated_at';
    if pg_catalog.jsonb_typeof(v_hash_feedback -> 'payload') = 'object' then
        v_hash_feedback := pg_catalog.jsonb_set(
            v_hash_feedback,
            '{payload}',
            (v_hash_feedback -> 'payload') - 'updatedAt',
            false
        );
    end if;
    v_request_hash := md5(jsonb_build_object(
        'organizationId', trim(p_organization_id),
        'feedback', v_hash_feedback,
        'expectedRevision', p_expected_revision
    )::text);

    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        trim(p_organization_id) || chr(31) || 'feedback-save' || chr(31) || trim(p_mutation_id),
        604012
    ));
    select * into v_receipt
      from public.omr_feedback_mutations
     where organization_id = trim(p_organization_id)
       and mutation_kind = 'save'
       and mutation_id = trim(p_mutation_id)
     for update;
    if found then
        if v_receipt.request_hash is distinct from v_request_hash then
            raise exception 'mutation_conflict';
        end if;
        return v_receipt.response;
    end if;


    select * into v_feedback
      from jsonb_populate_record(null::public.omr_attempt_feedback, p_feedback);
    if v_feedback.organization_id is distinct from trim(p_organization_id)
       or v_feedback.status is distinct from 'draft' then
        raise exception 'feedback scope or status mismatch';
    end if;

    select * into v_attempt
      from public.omr_attempts
     where id = v_feedback.attempt_id
       and organization_id = trim(p_organization_id)
     for update;
    if not found then
        raise exception 'attempt is outside teacher organization';
    end if;
    if v_feedback.exam_id is distinct from v_attempt.exam_id
       or v_feedback.student_profile_id is distinct from v_attempt.student_profile_id then
        raise exception 'feedback attempt mismatch';
    end if;

    select * into v_current
      from public.omr_attempt_feedback
     where attempt_id = v_feedback.attempt_id
       and organization_id = trim(p_organization_id)
     for update;

    if found and (
        v_current.id is distinct from v_feedback.id
        or v_current.revision is distinct from p_expected_revision
        or v_current.status is distinct from 'draft'
    ) then
        return jsonb_build_object(
            'status', 'revision_conflict',
            'currentRevision', v_current.revision,
            'currentStatus', v_current.status,
            'updatedAt', v_current.updated_at
        );
    elsif not found and p_expected_revision <> 0 then
        return jsonb_build_object(
            'status', 'revision_conflict',
            'currentRevision', 0,
            'currentStatus', 'missing'
        );
    end if;

    if v_current.id is null then
        insert into public.omr_attempt_feedback (
            id, organization_id, attempt_id, exam_id, student_profile_id,
            teacher_user_id, status, revision, summary, question_comments,
            markup, markup_drawings, download_policy, notification_status,
            notification_channel, notified_at, first_opened_at, last_opened_at,
            open_count, returned_at, payload, created_at, updated_at
        ) values (
            v_feedback.id, trim(p_organization_id), v_feedback.attempt_id,
            v_feedback.exam_id, v_feedback.student_profile_id,
            v_feedback.teacher_user_id, 'draft', 1, v_feedback.summary,
            coalesce(v_feedback.question_comments, '[]'::jsonb), v_feedback.markup,
            v_feedback.markup_drawings, coalesce(v_feedback.download_policy, '{}'::jsonb),
            'not_queued', 'in_app', null, null, null, 0, null,
            coalesce(v_feedback.payload, '{}'::jsonb) || jsonb_build_object(
                'organizationId', trim(p_organization_id), 'status', 'draft',
                'revision', 1, 'updatedAt', v_now
            ),
            coalesce(v_feedback.created_at, v_now), v_now
        ) returning * into v_stored;
    else
        update public.omr_attempt_feedback
           set teacher_user_id = v_feedback.teacher_user_id,
               summary = v_feedback.summary,
               question_comments = coalesce(v_feedback.question_comments, '[]'::jsonb),
               markup = v_feedback.markup,
               markup_drawings = case when p_feedback ? 'markup_drawings'
                   then v_feedback.markup_drawings else markup_drawings end,
               download_policy = coalesce(v_feedback.download_policy, '{}'::jsonb),
               revision = v_current.revision + 1,
               payload = coalesce(v_feedback.payload, '{}'::jsonb) || jsonb_build_object(
                   'organizationId', trim(p_organization_id), 'status', v_current.status,
                   'revision', v_current.revision + 1, 'updatedAt', v_now,
                   'returnedAt', v_current.returned_at,
                   'delivery', jsonb_build_object(
                       'notificationStatus', v_current.notification_status,
                       'notificationChannel', v_current.notification_channel,
                       'notifiedAt', v_current.notified_at,
                       'firstOpenedAt', v_current.first_opened_at,
                       'lastOpenedAt', v_current.last_opened_at,
                       'openCount', v_current.open_count
                   )
               ),
               updated_at = v_now
         where id = v_current.id
           and revision = p_expected_revision
           and status = 'draft'
        returning * into v_stored;
    end if;

    v_response := jsonb_build_object(
        'status', 'saved', 'revision', v_stored.revision,
        'updatedAt', v_stored.updated_at,
        'feedback', to_jsonb(v_stored) - 'markup_drawings'
    );
    if pg_catalog.octet_length(v_response::text) > 262144 then
        raise exception 'feedback receipt exceeds limit';
    end if;
    insert into public.omr_feedback_mutations (
        organization_id, mutation_kind, mutation_id, request_hash, response
    ) values (
        trim(p_organization_id), 'save', trim(p_mutation_id), v_request_hash, v_response
    );
    delete from public.omr_feedback_mutations receipt
      using (
          select old_receipt.organization_id, old_receipt.mutation_kind, old_receipt.mutation_id
            from public.omr_feedback_mutations old_receipt
           where old_receipt.created_at < v_now - interval '90 days'
           order by old_receipt.created_at, old_receipt.organization_id,
                    old_receipt.mutation_kind, old_receipt.mutation_id
           limit 128
           for update skip locked
      ) expired
     where receipt.organization_id = expired.organization_id
       and receipt.mutation_kind = expired.mutation_kind
       and receipt.mutation_id = expired.mutation_id;
    delete from public.omr_feedback_mutations receipt
      using (
          select old_receipt.organization_id, old_receipt.mutation_kind, old_receipt.mutation_id
            from public.omr_feedback_mutations old_receipt
           where old_receipt.organization_id = trim(p_organization_id)
             and old_receipt.mutation_kind = 'save'
           order by old_receipt.created_at desc, old_receipt.mutation_id desc
           offset 100 limit 128
           for update skip locked
      ) excess
     where receipt.organization_id = excess.organization_id
       and receipt.mutation_kind = excess.mutation_kind
       and receipt.mutation_id = excess.mutation_id;
    return v_response;
end;
$$;

create function public.omr_save_feedback_v4(
    p_session_authority text,
    p_account_id text,
    p_session_generation bigint,
    p_actor_user_id text,
    p_organization_id text,
    p_feedback jsonb,
    p_expected_revision bigint,
    p_mutation_id text
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
    v_effective jsonb;
    v_plan text;
    v_requires_premium boolean := false;
    v_request_hash text;
    v_hash_feedback jsonb;
    v_markup_strokes bigint;
    v_receipt public.omr_feedback_mutations%rowtype;
    v_feedback public.omr_attempt_feedback%rowtype;
    v_attempt public.omr_attempts%rowtype;
    v_current public.omr_attempt_feedback%rowtype;
    v_stored public.omr_attempt_feedback%rowtype;
    v_response jsonb;
    v_now timestamptz := clock_timestamp();
begin
    if nullif(trim(p_organization_id), '') is null
       or nullif(trim(p_mutation_id), '') is null
       or p_expected_revision is null
       or p_expected_revision < 0
       or pg_catalog.jsonb_typeof(p_feedback) is distinct from 'object' then
        raise exception 'invalid feedback mutation';
    end if;
    v_identity := public.omr_lock_teacher_mutation_identity_v1(
        p_session_authority, p_account_id, p_session_generation,
        pg_catalog.btrim(p_organization_id), p_actor_user_id
    );
    if v_identity is null then
        raise exception 'teacher mutation unauthorized';
    end if;

    if pg_catalog.octet_length((p_feedback - 'markup_drawings')::text) > 262144 then
        raise exception 'feedback metadata exceeds limit';
    end if;
    if p_feedback ? 'markup_drawings'
       and p_feedback -> 'markup_drawings' is distinct from 'null'::jsonb then
        if pg_catalog.jsonb_typeof(p_feedback -> 'markup_drawings') is distinct from 'object'
           or pg_catalog.octet_length((p_feedback -> 'markup_drawings')::text) > 5242880 then
            raise exception 'feedback markup exceeds limit';
        end if;
        if exists (
               select 1
                 from pg_catalog.jsonb_each(p_feedback -> 'markup_drawings') page
                where pg_catalog.jsonb_typeof(page.value) is distinct from 'array'
           ) then
            raise exception 'feedback markup shape exceeds limit';
        end if;
        if (select count(*) from pg_catalog.jsonb_each(p_feedback -> 'markup_drawings')) > 500
           or exists (
               select 1
                 from pg_catalog.jsonb_each(p_feedback -> 'markup_drawings') page
                where page.key !~ '^[1-9][0-9]{0,3}$'
                   or pg_catalog.jsonb_array_length(page.value) > 20000
           ) then
            raise exception 'feedback markup shape exceeds limit';
        end if;
        select coalesce(sum(pg_catalog.jsonb_array_length(page.value)), 0)::bigint
          into v_markup_strokes
          from pg_catalog.jsonb_each(p_feedback -> 'markup_drawings') page;
        if v_markup_strokes > 20000
           or exists (
               select 1
                 from pg_catalog.jsonb_each(p_feedback -> 'markup_drawings') page
                 cross join lateral pg_catalog.jsonb_array_elements(page.value) stroke(value)
                where pg_catalog.jsonb_typeof(stroke.value) is distinct from 'string'
                   or pg_catalog.octet_length(stroke.value #>> '{}') > 65536
           ) then
            raise exception 'feedback markup shape exceeds limit';
        end if;
    end if;

    select * into v_feedback
      from pg_catalog.jsonb_populate_record(null::public.omr_attempt_feedback, p_feedback);
    if v_feedback.organization_id is distinct from trim(p_organization_id)
       or v_feedback.teacher_user_id is distinct from p_actor_user_id
       or v_feedback.status is distinct from 'draft' then
        raise exception 'feedback scope or status mismatch';
    end if;
    if pg_catalog.octet_length(coalesce(v_feedback.summary, '')) > 32768 then
        raise exception 'feedback summary exceeds limit';
    end if;
    if pg_catalog.jsonb_typeof(coalesce(v_feedback.question_comments, '[]'::jsonb)) is distinct from 'array'
       or pg_catalog.jsonb_array_length(coalesce(v_feedback.question_comments, '[]'::jsonb)) > 500 then
        raise exception 'feedback comments exceed limit';
    end if;
    if exists (
        select 1
          from pg_catalog.jsonb_array_elements(coalesce(v_feedback.question_comments, '[]'::jsonb)) item(value)
         where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
            or pg_catalog.jsonb_typeof(item.value -> 'body') is distinct from 'string'
            or pg_catalog.octet_length(item.value ->> 'body') > 4096
    ) then
        raise exception 'feedback comments exceed limit';
    end if;

    v_hash_feedback := p_feedback - 'updated_at';
    if pg_catalog.jsonb_typeof(v_hash_feedback -> 'payload') = 'object' then
        v_hash_feedback := pg_catalog.jsonb_set(
            v_hash_feedback,
            '{payload}',
            (v_hash_feedback -> 'payload') - 'updatedAt',
            false
        );
    end if;
    v_request_hash := md5(pg_catalog.jsonb_build_object(
        'organizationId', trim(p_organization_id),
        'feedback', v_hash_feedback,
        'expectedRevision', p_expected_revision
    )::text);

    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        trim(p_organization_id) || chr(31) || 'feedback-save' || chr(31) || trim(p_mutation_id),
        604027
    ));
    select * into v_receipt
      from public.omr_feedback_mutations
     where organization_id = trim(p_organization_id)
       and mutation_kind = 'save'
       and mutation_id = trim(p_mutation_id)
     for update;
    if found then
        if v_receipt.request_hash is distinct from v_request_hash then
            raise exception 'mutation_conflict';
        end if;
        return v_receipt.response;
    end if;

    -- Preserve the established organization -> attempt -> feedback lock order.
    -- Core saves do not inspect this value; only premium changes below do.
    select * into v_attempt
      from public.omr_attempts
     where id = v_feedback.attempt_id
       and organization_id = trim(p_organization_id)
     for update;
    if not found then
        raise exception 'attempt is outside teacher organization';
    end if;
    if v_feedback.exam_id is distinct from v_attempt.exam_id
       or v_feedback.student_profile_id is distinct from v_attempt.student_profile_id then
        raise exception 'feedback attempt mismatch';
    end if;

    select * into v_current
      from public.omr_attempt_feedback
     where attempt_id = v_feedback.attempt_id
       and organization_id = trim(p_organization_id)
     for update;

    if found and (
        v_current.id is distinct from v_feedback.id
        or v_current.revision is distinct from p_expected_revision
        or v_current.status is distinct from 'draft'
    ) then
        return pg_catalog.jsonb_build_object(
            'status', 'revision_conflict',
            'currentRevision', v_current.revision,
            'currentStatus', v_current.status,
            'updatedAt', v_current.updated_at
        );
    elsif not found and p_expected_revision <> 0 then
        return pg_catalog.jsonb_build_object(
            'status', 'revision_conflict',
            'currentRevision', 0,
            'currentStatus', 'missing'
        );
    end if;

    if v_current.id is null then
        v_requires_premium := v_feedback.markup is not null
            or (p_feedback ? 'markup_drawings' and v_feedback.markup_drawings is not null)
            or coalesce(v_feedback.download_policy -> 'allowAnnotatedPdfDownload', 'false'::jsonb) = 'true'::jsonb
            or coalesce(v_feedback.payload #> '{downloadPolicy,allowAnnotatedPdfDownload}', 'false'::jsonb) = 'true'::jsonb
            or (v_feedback.payload ? 'markup' and v_feedback.payload -> 'markup' is distinct from 'null'::jsonb);
    else
        v_requires_premium := v_feedback.markup is distinct from v_current.markup
            or (p_feedback ? 'markup_drawings'
                and v_feedback.markup_drawings is distinct from v_current.markup_drawings)
            or (
                coalesce(v_feedback.download_policy -> 'allowAnnotatedPdfDownload', 'false'::jsonb) = 'true'::jsonb
                and coalesce(v_feedback.download_policy -> 'allowAnnotatedPdfDownload', 'false'::jsonb)
                    is distinct from coalesce(v_current.download_policy -> 'allowAnnotatedPdfDownload', 'false'::jsonb)
            )
            or (
                coalesce(v_feedback.payload #> '{downloadPolicy,allowAnnotatedPdfDownload}', 'false'::jsonb) = 'true'::jsonb
                and coalesce(v_feedback.payload #> '{downloadPolicy,allowAnnotatedPdfDownload}', 'false'::jsonb)
                    is distinct from coalesce(v_current.payload #> '{downloadPolicy,allowAnnotatedPdfDownload}', 'false'::jsonb)
            )
            or v_feedback.payload -> 'markup' is distinct from v_current.payload -> 'markup';
    end if;

    if v_requires_premium then
        v_effective := public.omr_read_teacher_mutation_plan_v1(
            p_session_authority, p_account_id,
            pg_catalog.btrim(p_organization_id), p_actor_user_id
        );
        if v_effective is null then
            raise exception 'teacher mutation unauthorized';
        end if;
        v_plan := v_effective ->> 'plan';
        if v_plan is null or v_plan not in ('pro', 'academy') then
            raise exception 'plan entitlement required';
        end if;
        return public.omr_save_feedback_effective_worker_v4(
            p_organization_id,
            p_feedback,
            p_expected_revision,
            p_mutation_id
        );
    end if;

    if v_current.id is null then
        insert into public.omr_attempt_feedback (
            id, organization_id, attempt_id, exam_id, student_profile_id,
            teacher_user_id, status, revision, summary, question_comments,
            markup, markup_drawings, download_policy, notification_status,
            notification_channel, notified_at, first_opened_at, last_opened_at,
            open_count, returned_at, payload, created_at, updated_at
        ) values (
            v_feedback.id, trim(p_organization_id), v_feedback.attempt_id,
            v_feedback.exam_id, v_feedback.student_profile_id,
            v_feedback.teacher_user_id, 'draft', 1, v_feedback.summary,
            coalesce(v_feedback.question_comments, '[]'::jsonb), null, null,
            coalesce(v_feedback.download_policy, '{}'::jsonb),
            'not_queued', 'in_app', null, null, null, 0, null,
            coalesce(v_feedback.payload, '{}'::jsonb) || pg_catalog.jsonb_build_object(
                'organizationId', trim(p_organization_id), 'status', 'draft',
                'revision', 1, 'updatedAt', v_now,
                'downloadPolicy', coalesce(v_feedback.download_policy, '{}'::jsonb)
            ),
            coalesce(v_feedback.created_at, v_now), v_now
        ) returning * into v_stored;
    else
        update public.omr_attempt_feedback
           set teacher_user_id = v_feedback.teacher_user_id,
               summary = v_feedback.summary,
               question_comments = coalesce(v_feedback.question_comments, '[]'::jsonb),
               markup = v_current.markup,
               markup_drawings = v_current.markup_drawings,
               download_policy = coalesce(v_feedback.download_policy, '{}'::jsonb),
               revision = v_current.revision + 1,
               payload = coalesce(v_feedback.payload, '{}'::jsonb) || pg_catalog.jsonb_build_object(
                   'organizationId', trim(p_organization_id), 'status', v_current.status,
                   'revision', v_current.revision + 1, 'updatedAt', v_now,
                   'returnedAt', v_current.returned_at,
                   'downloadPolicy', coalesce(v_feedback.download_policy, '{}'::jsonb),
                   'delivery', pg_catalog.jsonb_build_object(
                       'notificationStatus', v_current.notification_status,
                       'notificationChannel', v_current.notification_channel,
                       'notifiedAt', v_current.notified_at,
                       'firstOpenedAt', v_current.first_opened_at,
                       'lastOpenedAt', v_current.last_opened_at,
                       'openCount', v_current.open_count
                   )
               ),
               updated_at = v_now
         where id = v_current.id
           and revision = p_expected_revision
           and status = 'draft'
        returning * into v_stored;
    end if;

    v_response := pg_catalog.jsonb_build_object(
        'status', 'saved', 'revision', v_stored.revision,
        'updatedAt', v_stored.updated_at,
        'feedback', to_jsonb(v_stored) - 'markup_drawings'
    );
    if pg_catalog.octet_length(v_response::text) > 262144 then
        raise exception 'feedback receipt exceeds limit';
    end if;
    insert into public.omr_feedback_mutations (
        organization_id, mutation_kind, mutation_id, request_hash, response
    ) values (
        trim(p_organization_id), 'save', trim(p_mutation_id), v_request_hash, v_response
    );
    delete from public.omr_feedback_mutations receipt
      using (
          select old_receipt.organization_id, old_receipt.mutation_kind, old_receipt.mutation_id
            from public.omr_feedback_mutations old_receipt
           where old_receipt.created_at < v_now - interval '90 days'
           order by old_receipt.created_at, old_receipt.organization_id,
                    old_receipt.mutation_kind, old_receipt.mutation_id
           limit 128
           for update skip locked
      ) expired
     where receipt.organization_id = expired.organization_id
       and receipt.mutation_kind = expired.mutation_kind
       and receipt.mutation_id = expired.mutation_id;
    delete from public.omr_feedback_mutations receipt
      using (
          select old_receipt.organization_id, old_receipt.mutation_kind, old_receipt.mutation_id
            from public.omr_feedback_mutations old_receipt
           where old_receipt.organization_id = trim(p_organization_id)
             and old_receipt.mutation_kind = 'save'
           order by old_receipt.created_at desc, old_receipt.mutation_id desc
           offset 100 limit 128
           for update skip locked
      ) excess
     where receipt.organization_id = excess.organization_id
       and receipt.mutation_kind = excess.mutation_kind
       and receipt.mutation_id = excess.mutation_id;
    return v_response;
end;
$$;

create function public.omr_return_feedback_v4(
    p_session_authority text,
    p_account_id text,
    p_session_generation bigint,
    p_actor_user_id text,
    p_organization_id text,
    p_feedback_id text,
    p_expected_revision bigint,
    p_mutation_id text
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
    v_request_hash text;
    v_receipt public.omr_feedback_mutations%rowtype;
    v_current public.omr_attempt_feedback%rowtype;
    v_stored public.omr_attempt_feedback%rowtype;
    v_response jsonb;
    v_now timestamptz := clock_timestamp();
begin
    if nullif(trim(p_organization_id), '') is null
       or nullif(trim(p_feedback_id), '') is null
       or nullif(trim(p_mutation_id), '') is null
       or p_expected_revision is null or p_expected_revision < 1 then
        raise exception 'invalid feedback return mutation';
    end if;
    v_identity := public.omr_lock_teacher_mutation_identity_v1(
        p_session_authority, p_account_id, p_session_generation,
        pg_catalog.btrim(p_organization_id), p_actor_user_id
    );
    if v_identity is null then
        raise exception 'teacher mutation unauthorized';
    end if;

    v_request_hash := md5(pg_catalog.jsonb_build_object(
        'organizationId', trim(p_organization_id),
        'feedbackId', trim(p_feedback_id),
        'expectedRevision', p_expected_revision
    )::text);
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        trim(p_organization_id) || chr(31) || 'feedback-return' || chr(31) || trim(p_mutation_id),
        604027
    ));
    select * into v_receipt
      from public.omr_feedback_mutations
     where organization_id = trim(p_organization_id)
       and mutation_kind = 'return'
       and mutation_id = trim(p_mutation_id)
     for update;
    if found then
        if v_receipt.request_hash is distinct from v_request_hash then
            raise exception 'mutation_conflict';
        end if;
        return v_receipt.response;
    end if;

    select * into v_current
      from public.omr_attempt_feedback
     where id = trim(p_feedback_id)
       and organization_id = trim(p_organization_id)
     for update;
    if not found then
        return pg_catalog.jsonb_build_object(
            'status', 'revision_conflict', 'currentRevision', 0, 'currentStatus', 'missing'
        );
    end if;
    if v_current.revision is distinct from p_expected_revision
       or v_current.status is distinct from 'draft' then
        return pg_catalog.jsonb_build_object(
            'status', 'revision_conflict',
            'currentRevision', v_current.revision,
            'currentStatus', v_current.status,
            'updatedAt', v_current.updated_at
        );
    end if;

    update public.omr_attempt_feedback
       set status = 'returned',
           revision = v_current.revision + 1,
           notification_status = 'queued',
           notification_channel = 'in_app',
           notified_at = coalesce(notified_at, v_now),
           returned_at = coalesce(returned_at, v_now),
           updated_at = v_now,
           payload = coalesce(payload, '{}'::jsonb) || pg_catalog.jsonb_build_object(
               'status', 'returned', 'revision', v_current.revision + 1,
               'returnedAt', coalesce(returned_at, v_now), 'updatedAt', v_now,
               'delivery', coalesce(payload->'delivery', '{}'::jsonb) || pg_catalog.jsonb_build_object(
                   'notificationStatus', 'queued', 'notificationChannel', 'in_app',
                   'notifiedAt', coalesce(notified_at, v_now)
               )
           )
     where id = v_current.id
       and revision = p_expected_revision
       and status = 'draft'
    returning * into v_stored;

    if pg_catalog.octet_length((to_jsonb(v_stored) - 'markup_drawings')::text) > 262144 then
        raise exception 'feedback metadata exceeds limit';
    end if;
    v_response := pg_catalog.jsonb_build_object(
        'status', 'returned', 'revision', v_stored.revision,
        'updatedAt', v_stored.updated_at,
        'feedback', to_jsonb(v_stored) - 'markup_drawings'
    );
    if pg_catalog.octet_length(v_response::text) > 262144 then
        raise exception 'feedback receipt exceeds limit';
    end if;
    insert into public.omr_feedback_mutations (
        organization_id, mutation_kind, mutation_id, request_hash, response
    ) values (
        trim(p_organization_id), 'return', trim(p_mutation_id), v_request_hash, v_response
    );
    delete from public.omr_feedback_mutations receipt
      using (
          select old_receipt.organization_id, old_receipt.mutation_kind, old_receipt.mutation_id
            from public.omr_feedback_mutations old_receipt
           where old_receipt.created_at < v_now - interval '90 days'
           order by old_receipt.created_at, old_receipt.organization_id,
                    old_receipt.mutation_kind, old_receipt.mutation_id
           limit 128
           for update skip locked
      ) expired
     where receipt.organization_id = expired.organization_id
       and receipt.mutation_kind = expired.mutation_kind
       and receipt.mutation_id = expired.mutation_id;
    delete from public.omr_feedback_mutations receipt
      using (
          select old_receipt.organization_id, old_receipt.mutation_kind, old_receipt.mutation_id
            from public.omr_feedback_mutations old_receipt
           where old_receipt.organization_id = trim(p_organization_id)
             and old_receipt.mutation_kind = 'return'
           order by old_receipt.created_at desc, old_receipt.mutation_id desc
           offset 100 limit 128
           for update skip locked
      ) excess
     where receipt.organization_id = excess.organization_id
       and receipt.mutation_kind = excess.mutation_kind
       and receipt.mutation_id = excess.mutation_id;
    return v_response;
end;
$$;

create function public.omr_save_exam_effective_worker_v3(
    p_session_authority text,
    p_account_id text,
    p_actor_user_id text,
    p_organization_id text,
    p_exam jsonb,
    p_questions jsonb,
    p_teacher_asset_intent_ids jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
set lock_timeout = '2s'
as $$
declare
    v_exam public.omr_exams%rowtype;
    v_effective jsonb;
    v_plan text;
    v_is_new boolean;
    v_has_subquestions boolean := false;
    v_period_start date;
    v_period_start_at timestamptz;
    v_period_end_at timestamptz;
    v_observed_used integer;
    v_aggregate_used integer := 0;
    v_allowed boolean;
    v_saved jsonb;
    v_remote_ref_count integer;
begin
    if pg_catalog.jsonb_typeof(p_exam) is distinct from 'object'
       or pg_catalog.jsonb_typeof(p_questions) is distinct from 'array'
       or pg_catalog.jsonb_typeof(p_teacher_asset_intent_ids) is distinct from 'array'
       or pg_catalog.jsonb_array_length(p_teacher_asset_intent_ids) > 2
       or exists (
           select 1 from pg_catalog.jsonb_array_elements(p_teacher_asset_intent_ids) item
            where pg_catalog.jsonb_typeof(item) is distinct from 'string'
       ) then
        raise exception 'invalid exam save mutation';
    end if;
    select * into v_exam
      from pg_catalog.jsonb_populate_record(null::public.omr_exams, p_exam);
    if nullif(pg_catalog.btrim(v_exam.id), '') is null
       or v_exam.organization_id is distinct from p_organization_id
       or v_exam.created_by_user_id is distinct from p_actor_user_id
       or v_exam.payload is null
       or v_exam.payload ? 'pdfData'
       or v_exam.payload ? 'answerKeyPdf' then
        raise exception 'invalid canonical exam';
    end if;
    if (
        select pg_catalog.count(*)
          from pg_catalog.jsonb_array_elements_text(p_teacher_asset_intent_ids) item
    ) <> (
        select pg_catalog.count(distinct item)
          from pg_catalog.jsonb_array_elements_text(p_teacher_asset_intent_ids) item
    ) then
        raise exception 'duplicate teacher asset intent id';
    end if;

    select pg_catalog.count(*)::integer into v_remote_ref_count
      from (
          values
              ('problem_pdf'::text, v_exam.payload -> 'pdfDataRef'),
              ('answer_key_pdf'::text, v_exam.payload -> 'answerKeyPdfRef')
      ) expected(kind, ref)
     where pg_catalog.jsonb_typeof(expected.ref) = 'object'
       and expected.ref ->> 'store' = 'remote';
    if v_remote_ref_count <> pg_catalog.jsonb_array_length(p_teacher_asset_intent_ids)
       or exists (
           select 1
             from pg_catalog.jsonb_array_elements_text(p_teacher_asset_intent_ids) supplied(value)
            where not exists (
                select 1
                  from (values
                      ('problem_pdf'::text, v_exam.payload -> 'pdfDataRef'),
                      ('answer_key_pdf'::text, v_exam.payload -> 'answerKeyPdfRef')
                  ) expected(kind, ref)
                 where pg_catalog.jsonb_typeof(expected.ref) = 'object'
                   and expected.ref ->> 'store' = 'remote'
                   and expected.ref ->> 'key' = supplied.value
            )
       )
       or exists (
           select 1
             from (values
                 ('problem_pdf'::text, v_exam.payload -> 'pdfDataRef'),
                 ('answer_key_pdf'::text, v_exam.payload -> 'answerKeyPdfRef')
             ) expected(kind, ref)
            where pg_catalog.jsonb_typeof(expected.ref) = 'object'
              and expected.ref ->> 'store' = 'remote'
              and (
                  nullif(expected.ref ->> 'key', '') is null
                  or expected.ref ->> 'organizationId' is distinct from p_organization_id
                  or expected.ref ->> 'examId' is distinct from v_exam.id
                  or expected.ref ->> 'kind' is distinct from expected.kind
                  or expected.ref ->> 'mimeType' is distinct from 'application/pdf'
                  or pg_catalog.jsonb_typeof(expected.ref -> 'size') is distinct from 'number'
              )
       ) then
        raise exception 'teacher asset refs do not match supplied intent ids';
    end if;

    perform intent.id
      from public.omr_remote_asset_upload_intents intent
     where intent.id in (
         select value from pg_catalog.jsonb_array_elements_text(p_teacher_asset_intent_ids)
     )
     order by intent.id
     for update;
    perform asset.id
      from public.omr_remote_assets asset
     where asset.id in (
         select value from pg_catalog.jsonb_array_elements_text(p_teacher_asset_intent_ids)
     )
     order by asset.id
     for update;

    if exists (
        select 1
          from (values
              ('problem_pdf'::text, v_exam.payload -> 'pdfDataRef'),
              ('answer_key_pdf'::text, v_exam.payload -> 'answerKeyPdfRef')
          ) expected(kind, ref)
         where pg_catalog.jsonb_typeof(expected.ref) = 'object'
           and expected.ref ->> 'store' = 'remote'
           and not exists (
               select 1
                 from public.omr_remote_assets asset
                where asset.id = expected.ref ->> 'key'
                  and asset.organization_id = p_organization_id
                  and asset.exam_id = v_exam.id
                  and asset.kind = expected.kind
                  and asset.storage_bucket = 'omr-private-assets'
                  and asset.mime_type = 'application/pdf'
                  and pg_catalog.to_jsonb(asset.byte_size) = expected.ref -> 'size'
           )
           and not exists (
               select 1
                 from public.omr_remote_asset_upload_intents intent
                where intent.id = expected.ref ->> 'key'
                  and intent.organization_id = p_organization_id
                  and intent.exam_id = v_exam.id
                  and intent.kind = expected.kind
                  and intent.created_by_user_id = p_actor_user_id
                  and intent.storage_bucket = 'omr-private-assets'
                  and intent.mime_type = 'application/pdf'
                  and pg_catalog.to_jsonb(intent.byte_size) = expected.ref -> 'size'
                  and intent.status in ('uploaded', 'finalized')
                  and (intent.status = 'finalized' or intent.expires_at > pg_catalog.clock_timestamp())
           )
    )
       or exists (
           select 1
             from pg_catalog.jsonb_array_elements_text(p_teacher_asset_intent_ids) supplied(value)
             join public.omr_remote_asset_upload_intents intent on intent.id = supplied.value
            where intent.status = 'expired'
               or exists (
                   select 1 from public.omr_remote_asset_cleanup_queue queue
                    where queue.source_id = intent.id
                       or (queue.storage_bucket = intent.storage_bucket
                           and queue.object_path = intent.object_path)
               )
               or (
                   intent.expires_at <= pg_catalog.clock_timestamp()
                   and (
                       intent.status in ('pending', 'uploaded')
                       or (intent.status = 'finalized' and not exists (
                           select 1 from public.omr_exams exam
                            where exam.organization_id = intent.organization_id
                              and exam.id = intent.exam_id
                              and ((intent.kind = 'problem_pdf' and exam.payload #>> '{pdfDataRef,key}' = intent.id)
                                   or (intent.kind = 'answer_key_pdf' and exam.payload #>> '{answerKeyPdfRef,key}' = intent.id))
                       ))
                   )
               )
       ) then
        raise exception 'teacher asset intent is not ready';
    end if;

    -- This is the first effective-plan read on the no-receipt path, after all
    -- supplied storage rows are locked and immediately before plan-sensitive
    -- canonical writes.
    v_effective := public.omr_read_teacher_mutation_plan_v1(
        p_session_authority, p_account_id, p_organization_id, p_actor_user_id
    );
    if v_effective is null then
        raise exception 'teacher mutation unauthorized';
    end if;
    v_plan := v_effective ->> 'plan';
    if v_plan not in ('free', 'pro', 'academy') then
        raise exception 'teacher mutation unauthorized';
    end if;
    if v_plan = 'free'
       and pg_catalog.jsonb_array_length(p_teacher_asset_intent_ids) > 0 then
        raise exception 'plan entitlement required';
    end if;

    if pg_catalog.jsonb_typeof(v_exam.payload -> 'questions') = 'array' then
        select exists (
            select 1 from pg_catalog.jsonb_array_elements(v_exam.payload -> 'questions') question
             where pg_catalog.jsonb_typeof(question -> 'subQuestions') = 'array'
               and pg_catalog.jsonb_array_length(question -> 'subQuestions') > 0
        ) into v_has_subquestions;
    end if;
    if v_plan = 'free' and v_has_subquestions then
        raise exception 'plan entitlement required';
    end if;
    select not exists (
        select 1 from public.omr_exams exam where exam.id = v_exam.id
    ) into v_is_new;
    if v_is_new and v_plan = 'free' then
        v_period_start := pg_catalog.date_trunc(
            'month', pg_catalog.timezone('Asia/Seoul', pg_catalog.clock_timestamp())
        )::date;
        v_period_start_at := v_period_start::timestamp at time zone 'Asia/Seoul';
        v_period_end_at := (v_period_start + interval '1 month')::timestamp at time zone 'Asia/Seoul';
        select pg_catalog.count(*)::integer into v_observed_used
          from public.omr_exams exam
         where exam.organization_id = p_organization_id
           and exam.created_at >= v_period_start_at
           and exam.created_at < v_period_end_at;
        select coalesce(usage.used, 0)::integer into v_aggregate_used
          from public.omr_plan_usage usage
         where usage.organization_id = p_organization_id
           and usage.metric = 'exams'
           and usage.period_start = v_period_start
         for update;
        if not found then v_aggregate_used := 0; end if;
        if greatest(v_observed_used, v_aggregate_used) > 5 then
            raise exception 'plan exam limit exceeded';
        end if;
        select reservation.allowed into v_allowed
          from public.omr_reserve_plan_usage(
              p_organization_id, 'exams', v_period_start,
              'exam:' || v_exam.id, 1, v_observed_used, 5
          ) reservation;
        if not coalesce(v_allowed, false) then
            raise exception 'plan exam limit exceeded';
        end if;
    end if;

    v_saved := public.omr_save_exam_plan_unlocked_v1(p_exam, p_questions);
    insert into public.omr_remote_assets (
        id, organization_id, kind, exam_id, attempt_id, storage_bucket,
        object_path, mime_type, byte_size, sha256_hex, original_name,
        created_by_user_id, created_at, updated_at
    )
    select intent.id, intent.organization_id, intent.kind, intent.exam_id, null,
           intent.storage_bucket, intent.object_path, intent.mime_type,
           intent.byte_size, intent.sha256_hex, intent.original_name,
           intent.created_by_user_id, intent.created_at, pg_catalog.now()
      from public.omr_remote_asset_upload_intents intent
     where intent.id in (
         select value from pg_catalog.jsonb_array_elements_text(p_teacher_asset_intent_ids)
     )
    on conflict (id) do nothing;
    if exists (
        select 1
          from public.omr_remote_asset_upload_intents intent
          left join public.omr_remote_assets asset on asset.id = intent.id
         where intent.id in (
             select value from pg_catalog.jsonb_array_elements_text(p_teacher_asset_intent_ids)
         )
           and (asset.id is null
                or asset.organization_id is distinct from intent.organization_id
                or asset.exam_id is distinct from intent.exam_id
                or asset.kind is distinct from intent.kind
                or asset.storage_bucket is distinct from intent.storage_bucket
                or asset.object_path is distinct from intent.object_path
                or asset.mime_type is distinct from intent.mime_type
                or asset.byte_size is distinct from intent.byte_size
                or asset.sha256_hex is distinct from intent.sha256_hex)
    ) then
        raise exception 'teacher asset identifier belongs to another scope';
    end if;
    update public.omr_remote_asset_upload_intents intent
       set status = 'finalized',
           finalized_at = coalesce(intent.finalized_at, pg_catalog.now()),
           updated_at = pg_catalog.now()
     where intent.id in (
         select value from pg_catalog.jsonb_array_elements_text(p_teacher_asset_intent_ids)
     );
    return v_saved;
end;
$$;

create function public.omr_save_exam_v3(
    p_session_authority text,
    p_account_id text,
    p_session_generation bigint,
    p_actor_user_id text,
    p_exam jsonb,
    p_questions jsonb,
    p_teacher_asset_intent_ids jsonb,
    p_expected_revision bigint,
    p_mutation_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
set lock_timeout = '2s'
as $$
declare
    v_exam public.omr_exams%rowtype;
    v_current public.omr_exams%rowtype;
    v_existing_mutation public.omr_exam_mutations%rowtype;
    v_identity jsonb;
    v_request_exam jsonb;
    v_request_questions jsonb;
    v_request_hash text;
    v_saved jsonb;
    v_committed_revision bigint;
    v_committed_at timestamptz;
    v_committed_at_text text;
    v_result jsonb;
begin
    if pg_catalog.jsonb_typeof(p_exam) is distinct from 'object'
       or pg_catalog.jsonb_typeof(p_questions) is distinct from 'array'
       or pg_catalog.jsonb_typeof(p_teacher_asset_intent_ids) is distinct from 'array'
       or p_expected_revision is null or p_expected_revision < 0
       or nullif(pg_catalog.btrim(p_mutation_id), '') is null
       or pg_catalog.length(p_mutation_id) > 128 then
        raise exception 'invalid exam save mutation';
    end if;
    select * into v_exam
      from pg_catalog.jsonb_populate_record(null::public.omr_exams, p_exam);
    if nullif(pg_catalog.btrim(v_exam.id), '') is null
       or v_exam.organization_id is distinct from pg_catalog.btrim(v_exam.organization_id)
       or v_exam.organization_id is distinct from p_exam ->> 'organization_id'
       or v_exam.created_by_user_id is distinct from p_actor_user_id
       or v_exam.payload is null then
        raise exception 'invalid canonical exam';
    end if;

    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        v_exam.organization_id || pg_catalog.chr(31) || v_exam.id,
        610010
    ));
    v_identity := public.omr_lock_teacher_mutation_identity_v1(
        p_session_authority, p_account_id, p_session_generation,
        v_exam.organization_id, p_actor_user_id
    );
    if v_identity is null then
        raise exception 'teacher mutation unauthorized';
    end if;

    v_request_exam := public.omr_normalize_exam_save_request_v10(
        (p_exam - 'created_at' - 'updated_at')
        || pg_catalog.jsonb_build_object(
            'payload', (v_exam.payload - 'createdAt' - 'updatedAt' - 'revision')
        )
    );
    select coalesce(pg_catalog.jsonb_agg(
        public.omr_normalize_exam_save_request_v10(item.value - 'created_at' - 'updated_at')
        order by item.ordinality
    ), '[]'::jsonb) into v_request_questions
      from pg_catalog.jsonb_array_elements(p_questions) with ordinality item(value, ordinality);
    v_request_hash := pg_catalog.md5(
        p_expected_revision::text || pg_catalog.chr(31)
        || v_request_exam::text || pg_catalog.chr(31)
        || v_request_questions::text || pg_catalog.chr(31)
        || p_teacher_asset_intent_ids::text || pg_catalog.chr(31)
        || pg_catalog.btrim(p_actor_user_id)
    );

    select mutation.* into v_existing_mutation
      from public.omr_exam_mutations mutation
     where mutation.organization_id = v_exam.organization_id
       and mutation.exam_id = v_exam.id
       and mutation.mutation_id = pg_catalog.btrim(p_mutation_id)
     for update;
    if found then
        if v_existing_mutation.request_hash = v_request_hash then
            return v_existing_mutation.result;
        end if;
        select exam.* into v_current from public.omr_exams exam
         where exam.id = v_exam.id for update;
        return pg_catalog.jsonb_build_object(
            'status', 'mutation_conflict',
            'currentRevision', coalesce(v_current.revision, 0),
            'updatedAt', case when v_current.id is null then null else pg_catalog.to_char(
                v_current.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
            ) end
        );
    end if;
    select exam.* into v_current from public.omr_exams exam
     where exam.id = v_exam.id for update;
    if found and v_current.organization_id is distinct from v_exam.organization_id then
        raise exception 'exam identifier belongs to another organization';
    end if;
    if (p_expected_revision = 0 and v_current.id is not null)
       or (p_expected_revision > 0 and v_current.id is null)
       or (v_current.id is not null and v_current.revision <> p_expected_revision) then
        return pg_catalog.jsonb_build_object(
            'status', 'revision_conflict',
            'currentRevision', coalesce(v_current.revision, 0),
            'updatedAt', case when v_current.id is null then null else pg_catalog.to_char(
                v_current.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
            ) end
        );
    end if;

    v_committed_at := pg_catalog.now();
    v_committed_at_text := pg_catalog.to_char(
        v_committed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    );
    v_saved := public.omr_save_exam_effective_worker_v3(
        p_session_authority, p_account_id, p_actor_user_id,
        v_exam.organization_id,
        pg_catalog.jsonb_set(p_exam, '{updated_at}', pg_catalog.to_jsonb(v_committed_at), true),
        p_questions,
        p_teacher_asset_intent_ids
    );
    v_committed_revision := p_expected_revision + 1;
    update public.omr_exams exam
       set revision = v_committed_revision,
           updated_at = v_committed_at,
           payload = pg_catalog.jsonb_set(
               pg_catalog.jsonb_set(exam.payload, '{revision}', pg_catalog.to_jsonb(v_committed_revision), true),
               '{updatedAt}', pg_catalog.to_jsonb(v_committed_at_text), true
           )
     where exam.id = v_exam.id and exam.organization_id = v_exam.organization_id
    returning exam.payload into v_saved;
    if not found then raise exception 'canonical exam save disappeared'; end if;
    v_result := pg_catalog.jsonb_build_object(
        'status', 'saved', 'exam', v_saved,
        'revision', v_committed_revision, 'updatedAt', v_committed_at_text
    );
    insert into public.omr_exam_mutations (
        organization_id, exam_id, mutation_id, request_hash,
        expected_revision, committed_revision, result, created_at
    ) values (
        v_exam.organization_id, v_exam.id, pg_catalog.btrim(p_mutation_id),
        v_request_hash, p_expected_revision, v_committed_revision, v_result, v_committed_at
    );
    with expired_candidates as materialized (
        select mutation.organization_id, mutation.exam_id, mutation.mutation_id
          from public.omr_exam_mutations mutation
         where mutation.created_at < pg_catalog.now() - interval '90 days'
         order by mutation.created_at, mutation.organization_id, mutation.exam_id, mutation.mutation_id
         for update skip locked limit 100
    )
    delete from public.omr_exam_mutations mutation using expired_candidates candidate
     where mutation.organization_id = candidate.organization_id
       and mutation.exam_id = candidate.exam_id
       and mutation.mutation_id = candidate.mutation_id;
    return v_result;
end;
$$;

create function public.omr_save_roster_v3(
    p_session_authority text,
    p_account_id text,
    p_session_generation bigint,
    p_actor_user_id text,
    p_organization_id text,
    p_classes jsonb,
    p_students jsonb,
    p_enrollments jsonb,
    p_invites jsonb,
    p_expected_revision bigint
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
    v_effective jsonb;
    v_plan text;
    v_limit integer;
    v_student_ids text[];
    v_observed_used integer;
    v_allowed boolean;
    v_current_revision bigint;
    v_result jsonb;
begin
    if nullif(pg_catalog.btrim(p_organization_id), '') is null
       or pg_catalog.jsonb_typeof(p_students) is distinct from 'array' then
        raise exception 'invalid roster mutation';
    end if;

    -- Match bootstrap and roster lock order before locking the identity graph.
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
    if v_identity is null then
        raise exception 'teacher mutation unauthorized';
    end if;
    v_effective := public.omr_read_teacher_mutation_plan_v1(
        p_session_authority,
        p_account_id,
        pg_catalog.btrim(p_organization_id),
        p_actor_user_id
    );
    if v_effective is null then
        raise exception 'teacher mutation unauthorized';
    end if;
    v_plan := v_effective ->> 'plan';

    select case
               when coalesce(organization.metadata->>'rosterRevision', '') ~ '^[0-9]+$'
                   then (organization.metadata->>'rosterRevision')::bigint
               else 0
           end
      into v_current_revision
      from public.omr_organizations organization
     where organization.id = pg_catalog.btrim(p_organization_id)
     for update;
    if not found then
        raise exception 'roster organization does not exist';
    end if;
    if (p_expected_revision is null and v_current_revision <> 0)
       or (p_expected_revision is not null and p_expected_revision <> v_current_revision) then
        raise exception 'roster revision conflict'
            using errcode = '40001';
    end if;

    if v_plan in ('free', 'pro') then
        v_limit := case when v_plan = 'free' then 30 else 300 end;
        select coalesce(
            pg_catalog.array_agg(distinct pg_catalog.btrim(item->>'id'))
                filter (where nullif(pg_catalog.btrim(item->>'id'), '') is not null),
            array[]::text[]
        ) into v_student_ids
          from pg_catalog.jsonb_array_elements(p_students) item;
        select pg_catalog.count(*)::integer into v_observed_used
          from public.omr_student_profiles student
         where student.organization_id = pg_catalog.btrim(p_organization_id)
           and student.status in ('invited', 'active', 'inactive');
        select usage.allowed into v_allowed
          from public.omr_sync_student_plan_usage(
              pg_catalog.btrim(p_organization_id),
              v_student_ids,
              v_observed_used,
              v_limit
          ) usage;
        if not coalesce(v_allowed, false) then
            raise exception 'plan student limit exceeded';
        end if;
    end if;

    v_result := public.omr_save_roster_plan_unlocked_v1(
        p_organization_id,
        p_classes,
        p_students,
        p_enrollments,
        p_invites
    );
    update public.omr_organizations organization
       set metadata = pg_catalog.jsonb_set(
               coalesce(organization.metadata, '{}'::jsonb),
               '{rosterRevision}',
               pg_catalog.to_jsonb(v_current_revision + 1),
               true
           ),
           updated_at = pg_catalog.now()
     where organization.id = pg_catalog.btrim(p_organization_id);
    return v_result || pg_catalog.jsonb_build_object('revision', v_current_revision + 1);
end;
$$;

-- Keep the 100-user operational gate on the same Phase C RPCs as production.
-- The historical fixture is retained as a private worker; the public wrapper
-- adds one exact no-ledger legacy account graph and returns only its safe
-- mutation identity. Cleanup removes that account after the worker has removed
-- the organization/member/profile graph.
alter function public.omr_initial_ops_fixture_v1(text,text,text,text,text)
    rename to omr_initial_ops_fixture_v26_snapshot;
alter function public.omr_initial_ops_database_snapshot_v1(text,text,text,text,text)
    rename to omr_initial_ops_database_snapshot_v26_snapshot;

create function public.omr_initial_ops_fixture_v1(
    p_action text,
    p_run_id text,
    p_run_challenge_hash text,
    p_organization_id text,
    p_exam_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '30s'
set lock_timeout = '5s'
as $$
declare
    v_result jsonb;
    v_suffix text;
    v_teacher_id text;
    v_email text;
    v_display_name constant text := 'Initial Operations Phase C Teacher';
    v_now timestamptz := pg_catalog.clock_timestamp();
begin
    v_suffix := pg_catalog.substr(
        pg_catalog.encode(extensions.digest(p_run_id, 'sha256'), 'hex'), 1, 16
    );
    v_teacher_id := 'teacher_' || v_suffix;
    v_email := 'initial-ops-' || v_suffix || '@example.invalid';
    v_result := public.omr_initial_ops_fixture_v26_snapshot(
        p_action, p_run_id, p_run_challenge_hash, p_organization_id, p_exam_id
    );

    if p_action = 'create' then
        insert into public.omr_teacher_accounts (
            id, email, display_name, password_hash, status,
            email_verified_at, session_generation, created_at, updated_at
        ) values (
            v_teacher_id, v_email, v_display_name,
            'pbkdf2-sha256:120000:' || pg_catalog.repeat('0', 32)
                || ':' || pg_catalog.repeat('0', 64),
            'active', v_now, 1, v_now, v_now
        ) on conflict (id) do nothing;
        insert into public.omr_organization_members (
            organization_id, user_id, email, display_name, role, status,
            created_at, updated_at
        ) values (
            p_organization_id, v_teacher_id, v_email, v_display_name,
            'owner', 'active', v_now, v_now
        ) on conflict (organization_id, user_id) do nothing;
        insert into public.omr_teacher_profiles (
            organization_id, user_id, display_name, status, metadata,
            created_at, updated_at
        ) values (
            p_organization_id, v_teacher_id, v_display_name, 'active',
            pg_catalog.jsonb_build_object('initialOperationsRunId', p_run_id),
            v_now, v_now
        ) on conflict (organization_id, user_id) do nothing;

        if not exists (
            select 1 from public.omr_teacher_accounts account
             where account.id = v_teacher_id
               and account.email = v_email
               and account.display_name = v_display_name
               and account.status = 'active'
               and account.session_generation = 1
        ) or (select pg_catalog.count(*) from public.omr_organization_members member
               where member.user_id = v_teacher_id) <> 1
          or not exists (
            select 1 from public.omr_organization_members member
             where member.organization_id = p_organization_id
               and member.user_id = v_teacher_id
               and member.email = v_email
               and member.display_name = v_display_name
               and member.role = 'owner' and member.status = 'active'
        ) or (select pg_catalog.count(*) from public.omr_teacher_profiles profile
               where profile.user_id = v_teacher_id) <> 1
          or not exists (
            select 1 from public.omr_teacher_profiles profile
             where profile.organization_id = p_organization_id
               and profile.user_id = v_teacher_id
               and profile.display_name = v_display_name
               and profile.status = 'active'
        ) or exists (
            select 1 from public.omr_pilot_plan_grants grant_row
             where grant_row.account_id = v_teacher_id
                or grant_row.organization_id = p_organization_id
        ) then
            raise exception 'initial operations Phase C teacher identity drift';
        end if;
        return v_result || pg_catalog.jsonb_build_object(
            'teacherIdentity', pg_catalog.jsonb_build_object(
                'sessionAuthority', 'legacy_account',
                'accountId', v_teacher_id,
                'accountSessionGeneration', 1,
                'actorUserId', v_teacher_id
            )
        );
    end if;

    if p_action in ('cleanup', 'finalize_cleanup') then
        delete from public.omr_teacher_accounts account
         where account.id = v_teacher_id
           and account.email = v_email
           and account.display_name = v_display_name
           and not exists (
               select 1 from public.omr_pilot_plan_grants grant_row
                where grant_row.account_id = account.id
           );
    end if;
    return v_result;
end;
$$;

create function public.omr_initial_ops_database_snapshot_v1(
    p_run_id text,
    p_run_challenge_hash text,
    p_organization_id text,
    p_exam_id text,
    p_phase text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '30s'
set lock_timeout = '5s'
as $$
declare
    v_result jsonb;
    v_rows jsonb;
    v_paths jsonb;
begin
    v_result := public.omr_initial_ops_database_snapshot_v26_snapshot(
        p_run_id, p_run_challenge_hash, p_organization_id, p_exam_id, p_phase
    );
    if v_result ->> 'status' is distinct from 'ok' then
        return v_result;
    end if;
    with required(workload_path, query_pattern) as (values
        ('rpc:omr_open_attempt_session_v2', '%omr_open_attempt_session_v2%'),
        ('rpc:omr_checkpoint_attempt_session_v1', '%omr_checkpoint_attempt_session_v1%'),
        ('rpc:omr_heartbeat_attempt_session_v1', '%omr_heartbeat_attempt_session_v1%'),
        ('rpc:omr_prepare_attempt_session_submit_v1', '%omr_prepare_attempt_session_submit_v1%'),
        ('rpc:omr_commit_attempt_session_submit_v1', '%omr_commit_attempt_session_submit_v1%'),
        ('rpc:omr_list_active_attempt_sessions_v1', '%omr_list_active_attempt_sessions_v1%'),
        ('table:omr_remote_assets', '%from%omr_remote_assets%'),
        ('rpc:omr_prepare_teacher_asset_upload_v2', '%omr_prepare_teacher_asset_upload_v2%'),
        ('rpc:omr_authorize_teacher_asset_finalize_v2', '%omr_authorize_teacher_asset_finalize_v2%'),
        ('rpc:omr_finalize_teacher_asset_upload_v2', '%omr_finalize_teacher_asset_upload_v2%')
    ), aggregated as (
        select required.workload_path,
               coalesce(pg_catalog.sum(stats.calls), 0)::bigint as calls,
               coalesce(pg_catalog.max(stats.max_exec_time), 0)::double precision as maximum_execution_ms
          from required
          left join extensions.pg_stat_statements stats
            on stats.dbid = (select oid from pg_catalog.pg_database where datname = pg_catalog.current_database())
           and stats.query ilike required.query_pattern
         group by required.workload_path
    )
    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
               'workloadPath', workload_path,
               'fingerprint', pg_catalog.encode(extensions.digest(workload_path, 'sha256'), 'hex'),
               'calls', calls,
               'maximumExecutionMs', maximum_execution_ms
           ) order by workload_path),
           pg_catalog.jsonb_agg(workload_path order by workload_path)
      into v_rows, v_paths
      from aggregated;
    return pg_catalog.jsonb_set(
        pg_catalog.jsonb_set(v_result, '{rows}', v_rows, true),
        '{productionWorkloadPaths}', v_paths, true
    );
end;
$$;

alter function public.omr_lock_provisioned_teacher_identity_v1(text,bigint,text) owner to postgres;
alter function public.omr_authorize_effective_teacher_plan_v1(text,text) owner to postgres;
alter function public.omr_read_effective_organization_plan_v1(text) owner to postgres;
alter function public.omr_set_effective_plan_transaction_proof_v1(text,jsonb) owner to postgres;
alter function public.omr_prove_effective_organization_plan_v1(text) owner to postgres;
alter function public.omr_assert_effective_plan_transaction_proof_v1(text,boolean) owner to postgres;
alter function public.omr_lock_legacy_teacher_identity_v1(text,bigint,text,text) owner to postgres;
alter function public.omr_read_legacy_teacher_plan_v1(text,text,text) owner to postgres;
alter function public.omr_lock_teacher_mutation_identity_v1(text,text,bigint,text,text) owner to postgres;
alter function public.omr_read_teacher_mutation_plan_v1(text,text,text,text) owner to postgres;
alter function public.omr_save_roster_v3(text,text,bigint,text,text,jsonb,jsonb,jsonb,jsonb,bigint) owner to postgres;
alter function public.omr_save_exam_effective_worker_v3(text,text,text,text,jsonb,jsonb,jsonb) owner to postgres;
alter function public.omr_save_exam_v3(text,text,bigint,text,jsonb,jsonb,jsonb,bigint,text) owner to postgres;
alter function public.omr_save_feedback_effective_worker_v4(text,jsonb,bigint,text) owner to postgres;
alter function public.omr_save_feedback_v4(text,text,bigint,text,text,jsonb,bigint,text) owner to postgres;
alter function public.omr_return_feedback_v4(text,text,bigint,text,text,text,bigint,text) owner to postgres;
alter function public.omr_assign_students_v2(text,text,bigint,text,text,text,text,text[],text,bigint,text) owner to postgres;
alter function public.omr_clear_student_assignment_v2(text,text,bigint,text,text,text,text,bigint,text,text[],text) owner to postgres;
alter function public.omr_assert_targeted_assignment_scope_v1(text,text,text,text,text,text,integer[]) owner to postgres;
alter function public.omr_validate_targeted_attempt_session_v1() owner to postgres;
alter function public.omr_validate_targeted_attempt_v1() owner to postgres;
alter function public.omr_open_attempt_session_v2(text,text,text,text,text,text,text,text,text,text,text,integer[],integer[],timestamp with time zone,jsonb,integer,timestamp with time zone,text,text,integer) owner to postgres;
alter function public.omr_prepare_teacher_asset_upload_v2(text,text,bigint,text,text,jsonb) owner to postgres;
alter function public.omr_authorize_teacher_asset_finalize_v2(text,text,bigint,text,text,text,jsonb) owner to postgres;
alter function public.omr_finalize_teacher_asset_upload_v2(text,text,bigint,text,text,text,jsonb) owner to postgres;
alter function public.omr_prepare_attempt_handwriting_asset_v2(text,text,text,jsonb) owner to postgres;
alter function public.omr_attach_attempt_handwriting_v2(text,text,text,text,text) owner to postgres;
alter function public.omr_claim_remote_asset_cleanup_v1(text,integer,integer) owner to postgres;
alter function public.omr_claim_remote_asset_cleanup_v8_snapshot(text,integer,integer) owner to postgres;
alter function public.omr_reserve_plan_usage_v2(text,text,bigint,text,text,text,text) owner to postgres;
alter function public.omr_release_plan_usage_v2(text,text,bigint,text,text,text,text) owner to postgres;
alter function public.omr_sync_student_plan_usage_v2(text,text,bigint,text,text) owner to postgres;
alter function public.omr_initial_ops_fixture_v26_snapshot(text,text,text,text,text) owner to postgres;
alter function public.omr_initial_ops_database_snapshot_v26_snapshot(text,text,text,text,text) owner to postgres;
alter function public.omr_initial_ops_fixture_v1(text,text,text,text,text) owner to postgres;
alter function public.omr_initial_ops_database_snapshot_v1(text,text,text,text,text) owner to postgres;

revoke all on function public.omr_lock_provisioned_teacher_identity_v1(text,bigint,text)
    from public, anon, authenticated, service_role;
revoke all on function public.omr_authorize_effective_teacher_plan_v1(text,text)
    from public, anon, authenticated, service_role;
revoke all on function public.omr_read_effective_organization_plan_v1(text)
    from public, anon, authenticated, service_role;
revoke all on function public.omr_set_effective_plan_transaction_proof_v1(text,jsonb)
    from public, anon, authenticated, service_role;
revoke all on function public.omr_prove_effective_organization_plan_v1(text)
    from public, anon, authenticated, service_role;
revoke all on function public.omr_assert_effective_plan_transaction_proof_v1(text,boolean)
    from public, anon, authenticated, service_role;
revoke all on function public.omr_lock_legacy_teacher_identity_v1(text,bigint,text,text)
    from public, anon, authenticated, service_role;
revoke all on function public.omr_read_legacy_teacher_plan_v1(text,text,text)
    from public, anon, authenticated, service_role;
revoke all on function public.omr_lock_teacher_mutation_identity_v1(text,text,bigint,text,text)
    from public, anon, authenticated, service_role;
revoke all on function public.omr_read_teacher_mutation_plan_v1(text,text,text,text)
    from public, anon, authenticated, service_role;
revoke all on function public.omr_initial_ops_fixture_v26_snapshot(text,text,text,text,text)
    from public, anon, authenticated, service_role;
revoke all on function public.omr_initial_ops_database_snapshot_v26_snapshot(text,text,text,text,text)
    from public, anon, authenticated, service_role;
revoke all on function public.omr_initial_ops_fixture_v1(text,text,text,text,text)
    from public, anon, authenticated;
grant execute on function public.omr_initial_ops_fixture_v1(text,text,text,text,text)
    to service_role;
revoke all on function public.omr_initial_ops_database_snapshot_v1(text,text,text,text,text)
    from public, anon, authenticated;
grant execute on function public.omr_initial_ops_database_snapshot_v1(text,text,text,text,text)
    to service_role;
revoke all on function public.omr_save_roster_v3(text,text,bigint,text,text,jsonb,jsonb,jsonb,jsonb,bigint)
    from public, anon, authenticated;
grant execute on function public.omr_save_roster_v3(text,text,bigint,text,text,jsonb,jsonb,jsonb,jsonb,bigint)
    to service_role;
revoke all on function public.omr_save_roster_v2(text,jsonb,jsonb,jsonb,jsonb,bigint)
    from public, anon, authenticated, service_role;
revoke all on function public.omr_save_roster_v1(text,jsonb,jsonb,jsonb,jsonb)
    from public, anon, authenticated, service_role;
revoke all on function public.omr_save_roster_plan_unlocked_v1(text,jsonb,jsonb,jsonb,jsonb)
    from public, anon, authenticated, service_role;
revoke all on function public.omr_save_roster_unlocked_v1(text,jsonb,jsonb,jsonb,jsonb)
    from public, anon, authenticated, service_role;
revoke all on function public.omr_save_exam_effective_worker_v3(text,text,text,text,jsonb,jsonb,jsonb)
    from public, anon, authenticated, service_role;
revoke all on function public.omr_save_exam_v3(text,text,bigint,text,jsonb,jsonb,jsonb,bigint,text)
    from public, anon, authenticated;
grant execute on function public.omr_save_exam_v3(text,text,bigint,text,jsonb,jsonb,jsonb,bigint,text)
    to service_role;
revoke all on function public.omr_save_exam_v2(jsonb,jsonb,jsonb,text,bigint,text)
    from public, anon, authenticated, service_role;
revoke execute on function public.omr_save_exam_v1(jsonb,jsonb,jsonb,text)
    from service_role;
revoke all on function public.omr_save_exam_v10_snapshot(jsonb,jsonb,jsonb,text)
    from public, anon, authenticated, service_role;
revoke all on function public.omr_save_exam_v6_snapshot(jsonb,jsonb,jsonb,text)
    from public, anon, authenticated, service_role;
revoke all on function public.omr_save_exam_plan_unlocked_v1(jsonb,jsonb)
    from public, anon, authenticated, service_role;
revoke all on function public.omr_save_feedback_effective_worker_v4(text,jsonb,bigint,text)
    from public, anon, authenticated, service_role;
revoke all on function public.omr_save_feedback_v4(text,text,bigint,text,text,jsonb,bigint,text)
    from public, anon, authenticated;
grant execute on function public.omr_save_feedback_v4(text,text,bigint,text,text,jsonb,bigint,text)
    to service_role;
revoke all on function public.omr_return_feedback_v4(text,text,bigint,text,text,text,bigint,text)
    from public, anon, authenticated;
grant execute on function public.omr_return_feedback_v4(text,text,bigint,text,text,text,bigint,text)
    to service_role;
revoke all on function public.omr_save_feedback_v3(text,jsonb,bigint,text)
    from public, anon, authenticated, service_role;
revoke all on function public.omr_return_feedback_v3(text,text,bigint,text)
    from public, anon, authenticated, service_role;
revoke all on function public.omr_save_feedback_v2(text,jsonb,bigint,text)
    from public, anon, authenticated, service_role;
revoke all on function public.omr_return_feedback_v2(text,text,bigint,text)
    from public, anon, authenticated, service_role;
revoke all on function public.omr_save_feedback_v1(text,jsonb)
    from public, anon, authenticated, service_role;
revoke all on function public.omr_return_feedback_v1(text,text,timestamptz)
    from public, anon, authenticated, service_role;
revoke all on function public.omr_assign_students_v2(text,text,bigint,text,text,text,text,text[],text,bigint,text)
    from public, anon, authenticated;
grant execute on function public.omr_assign_students_v2(text,text,bigint,text,text,text,text,text[],text,bigint,text)
    to service_role;
revoke all on function public.omr_clear_student_assignment_v2(text,text,bigint,text,text,text,text,bigint,text,text[],text)
    from public, anon, authenticated;
grant execute on function public.omr_clear_student_assignment_v2(text,text,bigint,text,text,text,text,bigint,text,text[],text)
    to service_role;
revoke all on function public.omr_assign_students_v1(text,text,text,text,text[],text,bigint,text)
    from public, anon, authenticated, service_role;
revoke all on function public.omr_clear_student_assignment_v1(text,text,text,text,bigint,text,text[],text)
    from public, anon, authenticated, service_role;
revoke all on function public.omr_assert_targeted_assignment_scope_v1(text,text,text,text,text,text,integer[])
    from public, anon, authenticated, service_role;
revoke all on function public.omr_validate_targeted_attempt_session_v1()
    from public, anon, authenticated, service_role;
revoke all on function public.omr_validate_targeted_attempt_v1()
    from public, anon, authenticated, service_role;
revoke all on function public.omr_open_attempt_session_v2(text,text,text,text,text,text,text,text,text,text,text,integer[],integer[],timestamp with time zone,jsonb,integer,timestamp with time zone,text,text,integer)
    from public, anon, authenticated;
grant execute on function public.omr_open_attempt_session_v2(text,text,text,text,text,text,text,text,text,text,text,integer[],integer[],timestamp with time zone,jsonb,integer,timestamp with time zone,text,text,integer)
    to service_role;
revoke all on function public.omr_open_attempt_session_v1(text,text,text,text,text,text,text,text,text,text,text,integer[],integer[],timestamp with time zone,jsonb,integer,timestamp with time zone,text,text,integer)
    from public, anon, authenticated, service_role;
revoke all on function public.omr_prepare_teacher_asset_upload_v2(text,text,bigint,text,text,jsonb)
    from public, anon, authenticated;
grant execute on function public.omr_prepare_teacher_asset_upload_v2(text,text,bigint,text,text,jsonb)
    to service_role;
revoke all on function public.omr_authorize_teacher_asset_finalize_v2(text,text,bigint,text,text,text,jsonb)
    from public, anon, authenticated;
grant execute on function public.omr_authorize_teacher_asset_finalize_v2(text,text,bigint,text,text,text,jsonb)
    to service_role;
revoke all on function public.omr_finalize_teacher_asset_upload_v2(text,text,bigint,text,text,text,jsonb)
    from public, anon, authenticated;
grant execute on function public.omr_finalize_teacher_asset_upload_v2(text,text,bigint,text,text,text,jsonb)
    to service_role;
revoke all on function public.omr_prepare_attempt_handwriting_asset_v2(text,text,text,jsonb)
    from public, anon, authenticated;
grant execute on function public.omr_prepare_attempt_handwriting_asset_v2(text,text,text,jsonb)
    to service_role;
revoke all on function public.omr_attach_attempt_handwriting_v2(text,text,text,text,text)
    from public, anon, authenticated;
grant execute on function public.omr_attach_attempt_handwriting_v2(text,text,text,text,text)
    to service_role;
revoke all on function public.omr_claim_remote_asset_cleanup_v1(text,integer,integer)
    from public, anon, authenticated;
grant execute on function public.omr_claim_remote_asset_cleanup_v1(text,integer,integer)
    to service_role;
revoke all on function public.omr_claim_remote_asset_cleanup_v8_snapshot(text,integer,integer)
    from public, anon, authenticated, service_role;
revoke all on function public.omr_reserve_plan_usage_v2(text,text,bigint,text,text,text,text)
    from public, anon, authenticated;
grant execute on function public.omr_reserve_plan_usage_v2(text,text,bigint,text,text,text,text)
    to service_role;
revoke all on function public.omr_release_plan_usage_v2(text,text,bigint,text,text,text,text)
    from public, anon, authenticated;
grant execute on function public.omr_release_plan_usage_v2(text,text,bigint,text,text,text,text)
    to service_role;
revoke all on function public.omr_sync_student_plan_usage_v2(text,text,bigint,text,text)
    from public, anon, authenticated;
grant execute on function public.omr_sync_student_plan_usage_v2(text,text,bigint,text,text)
    to service_role;
revoke all on function public.omr_reserve_plan_usage(text,text,date,text,integer,integer,integer)
    from public, anon, authenticated, service_role;
revoke all on function public.omr_release_plan_usage(text,text,date,text)
    from public, anon, authenticated, service_role;
revoke all on function public.omr_release_plan_usage_v10_snapshot(text,text,date,text)
    from public, anon, authenticated, service_role;
revoke all on function public.omr_sync_student_plan_usage(text,text[],integer,integer)
    from public, anon, authenticated, service_role;
revoke all on function public.omr_prepare_teacher_asset_upload_v1(jsonb)
    from public, anon, authenticated, service_role;
revoke all on function public.omr_prepare_teacher_asset_upload_v6_snapshot(jsonb)
    from public, anon, authenticated, service_role;
revoke all on function public.omr_authorize_teacher_asset_finalize_v1(text,text,text,jsonb)
    from public, anon, authenticated, service_role;
revoke all on function public.omr_finalize_teacher_asset_upload_v1(text,text,text,jsonb)
    from public, anon, authenticated, service_role;
revoke all on function public.omr_prepare_attempt_handwriting_asset_v1(text,jsonb)
    from public, anon, authenticated, service_role;
revoke all on function public.omr_attach_attempt_handwriting_v1(text,text,jsonb)
    from public, anon, authenticated, service_role;
revoke all on function public.omr_save_remote_asset_metadata_v1(jsonb)
    from public, anon, authenticated, service_role;
revoke all on table public.omr_remote_assets from service_role;
revoke all on table public.omr_remote_asset_upload_intents from service_role;
revoke all on table public.omr_remote_asset_cleanup_queue from service_role;
revoke all on table public.omr_plan_usage from service_role;
revoke all on table public.omr_plan_usage_reservations from service_role;
grant select on table public.omr_remote_assets to service_role;
grant select on table public.omr_remote_asset_upload_intents to service_role;
grant select on table public.omr_remote_asset_cleanup_queue to service_role;
grant select on table public.omr_plan_usage to service_role;
grant select on table public.omr_plan_usage_reservations to service_role;
revoke all on sequence public.omr_remote_asset_cleanup_queue_id_seq from service_role;

-- Recreated trigger helpers and the historical cleanup snapshot are part of
-- the Phase C authorization graph. Bound them exactly like the other private
-- workers so catalog attestation cannot accept an unbounded implementation.
alter function public.omr_claim_remote_asset_cleanup_v8_snapshot(text,integer,integer)
    set statement_timeout = '10s';
alter function public.omr_claim_remote_asset_cleanup_v8_snapshot(text,integer,integer)
    set lock_timeout = '2s';
alter function public.omr_guard_targeted_exam_access_v1()
    set statement_timeout = '5s';
alter function public.omr_guard_targeted_exam_access_v1()
    set lock_timeout = '2s';

comment on function public.omr_lock_provisioned_teacher_identity_v1(text,bigint,text)
    is 'Private lock-backed exact provisioned teacher identity validator for Phase C mutations.';
comment on function public.omr_authorize_effective_teacher_plan_v1(text,text)
    is 'Private current effective workspace plan reader bound to the locked provisioned account and organization.';
comment on function public.omr_read_effective_organization_plan_v1(text)
    is 'Private student-path effective plan reader derived from exact provisioned organization ownership.';
comment on function public.omr_set_effective_plan_transaction_proof_v1(text,jsonb)
    is 'Private transaction-local effective plan proof setter for lock-safe paid student triggers.';
comment on function public.omr_prove_effective_organization_plan_v1(text)
    is 'Private pre-domain-lock effective organization plan prover.';
comment on function public.omr_assert_effective_plan_transaction_proof_v1(text,boolean)
    is 'Private trigger-safe transaction proof and wall-clock expiry assertion.';
comment on function public.omr_lock_legacy_teacher_identity_v1(text,bigint,text,text)
    is 'Private exact no-pilot-ledger legacy account and bootstrap-workspace validator.';
comment on function public.omr_read_legacy_teacher_plan_v1(text,text,text)
    is 'Private self-service-only workspace plan reader, never valid for pilot provenance.';
comment on function public.omr_lock_teacher_mutation_identity_v1(text,text,bigint,text,text)
    is 'Private exact authority dispatcher for provisioned and explicit no-ledger legacy teacher mutations.';
comment on function public.omr_read_teacher_mutation_plan_v1(text,text,text,text)
    is 'Private plan dispatcher that never lets pilot provenance fall back to the legacy organization plan.';
comment on function public.omr_save_roster_v3(text,text,bigint,text,text,jsonb,jsonb,jsonb,jsonb,bigint)
    is 'Account-session-bound roster CAS with same-transaction effective student-plan enforcement.';
comment on function public.omr_save_exam_effective_worker_v3(text,text,text,text,jsonb,jsonb,jsonb)
    is 'Private exact asset promotion and effective-plan exam writer, callable only after receipt miss.';
comment on function public.omr_save_exam_v3(text,text,bigint,text,jsonb,jsonb,jsonb,bigint,text)
    is 'Account-session-bound exam CAS with identity-before-replay and effective-plan-before-write ordering.';
comment on function public.omr_save_feedback_effective_worker_v4(text,jsonb,bigint,text)
    is 'Private premium feedback worker called only after current effective paid-plan authorization.';
comment on function public.omr_save_feedback_v4(text,text,bigint,text,text,jsonb,bigint,text)
    is 'Account-session-bound feedback save with identity-before-replay and plan-before-premium-write ordering.';
comment on function public.omr_return_feedback_v4(text,text,bigint,text,text,text,bigint,text)
    is 'Account-session-bound feedback return with identity-before-replay ordering.';
comment on function public.omr_assign_students_v2(text,text,bigint,text,text,text,text,text[],text,bigint,text)
    is 'Account-session-bound individual assignment mutation with effective-plan retake enforcement.';
comment on function public.omr_clear_student_assignment_v2(text,text,bigint,text,text,text,text,bigint,text,text[],text)
    is 'Account-session-bound individual assignment clear mutation.';
comment on function public.omr_open_attempt_session_v2(text,text,text,text,text,text,text,text,text,text,text,integer[],integer[],timestamp with time zone,jsonb,integer,timestamp with time zone,text,text,integer)
    is 'Student attempt-session open with pre-domain-lock effective paid-plan proof for retakes.';
comment on function public.omr_prepare_teacher_asset_upload_v2(text,text,bigint,text,text,jsonb)
    is 'Account-session-bound teacher upload prepare with current effective plan, bounded admission and grant-capped intent expiry.';
comment on function public.omr_authorize_teacher_asset_finalize_v2(text,text,bigint,text,text,text,jsonb)
    is 'Account-session-bound pre-Storage teacher asset finalization authorization.';
comment on function public.omr_finalize_teacher_asset_upload_v2(text,text,bigint,text,text,text,jsonb)
    is 'Account-session-bound post-Storage teacher asset observation finalization.';
comment on function public.omr_prepare_attempt_handwriting_asset_v2(text,text,text,jsonb)
    is 'Student session-bound handwriting reservation with pre-domain-lock effective plan enforcement.';
comment on function public.omr_attach_attempt_handwriting_v2(text,text,text,text,text)
    is 'Student session-bound handwriting attachment with current effective plan enforcement.';
comment on function public.omr_claim_remote_asset_cleanup_v1(text,integer,integer)
    is 'Cleanup claim boundary that immediately enqueues expired unattached handwriting reservations.';
comment on function public.omr_claim_remote_asset_cleanup_v8_snapshot(text,integer,integer)
    is 'Private historical cleanup worker snapshot called only by the Phase C cleanup boundary.';
comment on function public.omr_reserve_plan_usage_v2(text,text,bigint,text,text,text,text)
    is 'Account-session-bound quota reservation using canonical period, usage and current effective plan limits.';
comment on function public.omr_release_plan_usage_v2(text,text,bigint,text,text,text,text)
    is 'Account-session-bound idempotent provisional quota release; canonical exams remain durable.';
comment on function public.omr_sync_student_plan_usage_v2(text,text,bigint,text,text)
    is 'Account-session-bound student quota synchronization derived only from canonical profiles.';
comment on function public.omr_initial_ops_fixture_v26_snapshot(text,text,text,text,text)
    is 'Private historical initial-operations fixture worker called only by the Phase C identity wrapper.';
comment on function public.omr_initial_ops_database_snapshot_v26_snapshot(text,text,text,text,text)
    is 'Private historical initial-operations database snapshot worker called only by the Phase C coverage wrapper.';
comment on function public.omr_initial_ops_fixture_v1(text,text,text,text,text)
    is 'initial-operations-phase-c-identity-and-production-coverage:202608080008';
comment on function public.omr_initial_ops_database_snapshot_v1(text,text,text,text,text)
    is 'initial-operations-phase-c-identity-and-production-coverage:202608080008';
comment on function public.omr_assert_targeted_assignment_scope_v1(text,text,text,text,text,text,integer[])
    is 'Private immutable targeted-assignment scope assertion consuming only transaction-local plan proof.';
comment on function public.omr_validate_targeted_attempt_session_v1()
    is 'Private targeted attempt-session trigger guarded by a pre-domain-lock effective-plan proof.';
comment on function public.omr_validate_targeted_attempt_v1()
    is 'Private targeted attempt trigger guarded by a pre-domain-lock effective-plan proof.';
comment on function public.omr_guard_targeted_exam_access_v1()
    is 'Private targeted exam trigger guard with no caller-controlled entitlement input.';

commit;
