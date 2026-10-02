-- Operator-provisioned academy teacher members (migration 202610020001).
-- Runs inside one transaction and rolls back so later suites see no fixture rows.
begin;

set local role service_role;
do $pilot_org_teacher_assertions$
declare
    v_owner_hash constant text := 'pbkdf2-sha256:120000:' || pg_catalog.repeat('a', 32) || ':' || pg_catalog.repeat('b', 64);
    v_teacher_hash constant text := 'pbkdf2-sha256:120000:' || pg_catalog.repeat('c', 32) || ':' || pg_catalog.repeat('d', 64);
    v_rotated_hash constant text := 'pbkdf2-sha256:120000:' || pg_catalog.repeat('e', 32) || ':' || pg_catalog.repeat('f', 64);
    v_expires_at constant timestamptz := pg_catalog.date_trunc('second', pg_catalog.clock_timestamp()) + interval '30 days';
    v_owner jsonb;
    v_teacher jsonb;
    v_replay jsonb;
    v_rotated jsonb;
    v_other_owner jsonb;
    v_login jsonb;
    v_session jsonb;
    v_owner_login jsonb;
    v_org text;
    v_teacher_id text;
    v_rejected boolean;
begin
    v_owner := public.omr_provision_pilot_teacher_v1(
        '테스트 학원', 'pilot-owner@example.test', '원장 1', v_owner_hash,
        'academy', v_expires_at, 'operator:assertions', 'pilot_org_teacher_test',
        'prov_' || pg_catalog.repeat('O', 40)
    );
    v_org := v_owner ->> 'organizationId';

    v_teacher := public.omr_provision_pilot_org_teacher_v1(
        v_org, 'Pilot-Teacher@Example.test ', '교사 1', v_teacher_hash,
        'operator:assertions', 'pilot_org_teacher_test', 'prov_' || pg_catalog.repeat('T', 40)
    );
    v_teacher_id := v_teacher ->> 'accountId';
    if v_teacher ->> 'organizationId' is distinct from v_org
       or v_teacher_id !~ '^teacher_[a-f0-9]{16}$'
       or v_teacher ->> 'provisionId' !~ '^pilot_member_[a-f0-9]{24}$'
       or v_teacher ->> 'memberRole' is distinct from 'teacher'
       or v_teacher ->> 'replayed' is distinct from 'false' then
        raise exception 'teacher member provisioning returned an unexpected envelope: %', v_teacher;
    end if;

    -- Exact replay returns the stored receipt without another write.
    v_replay := public.omr_provision_pilot_org_teacher_v1(
        v_org, 'pilot-teacher@example.test', '교사 1', v_teacher_hash,
        'operator:assertions', 'pilot_org_teacher_test', 'prov_' || pg_catalog.repeat('T', 40)
    );
    if v_replay - 'replayed' is distinct from v_teacher - 'replayed'
       or v_replay ->> 'replayed' is distinct from 'true' then
        raise exception 'teacher member replay drifted: % vs %', v_replay, v_teacher;
    end if;

    -- A reused key with a different request, or an owner-ledger key, conflicts.
    v_rejected := false;
    begin
        perform public.omr_provision_pilot_org_teacher_v1(
            v_org, 'pilot-teacher@example.test', '교사 이름 변경', v_teacher_hash,
            'operator:assertions', 'pilot_org_teacher_test', 'prov_' || pg_catalog.repeat('T', 40)
        );
    exception when others then
        v_rejected := sqlerrm = 'idempotency_conflict';
    end;
    if not v_rejected then raise exception 'teacher member key reuse was not rejected'; end if;
    v_rejected := false;
    begin
        perform public.omr_provision_pilot_org_teacher_v1(
            v_org, 'other-teacher@example.test', '교사 2', v_teacher_hash,
            'operator:assertions', 'pilot_org_teacher_test', 'prov_' || pg_catalog.repeat('O', 40)
        );
    exception when others then
        v_rejected := sqlerrm = 'idempotency_conflict';
    end;
    if not v_rejected then raise exception 'owner-ledger key was reused for a teacher member'; end if;

    -- Provisioned login binds the member to the owner's academy plan.
    v_login := public.omr_lookup_provisioned_teacher_login_v1('pilot-teacher@example.test');
    if v_login ->> 'accountId' is distinct from v_teacher_id
       or v_login ->> 'memberRole' is distinct from 'teacher'
       or v_login ->> 'organizationId' is distinct from v_org
       or v_login ->> 'organizationName' is distinct from '테스트 학원'
       or v_login ->> 'displayName' is distinct from '교사 1'
       or v_login ->> 'passwordHash' is distinct from v_teacher_hash
       or (v_login ->> 'sessionGeneration')::bigint <> 1
       or v_login ->> 'plan' is distinct from 'academy'
       or v_login ->> 'grantExpiresAt' is distinct from v_owner ->> 'expiresAt' then
        raise exception 'teacher member login lookup drifted: %', v_login;
    end if;
    v_owner_login := public.omr_lookup_provisioned_teacher_login_v1('pilot-owner@example.test');
    if v_owner_login ->> 'memberRole' is distinct from 'owner'
       or v_owner_login ->> 'plan' is distinct from 'academy' then
        raise exception 'owner login regressed: %', v_owner_login;
    end if;

    v_session := public.omr_validate_provisioned_teacher_session_v1(v_teacher_id, 1, v_org);
    if v_session ->> 'memberRole' is distinct from 'teacher'
       or v_session ->> 'plan' is distinct from 'academy' then
        raise exception 'teacher member session validation drifted: %', v_session;
    end if;
    if public.omr_validate_provisioned_teacher_session_v1(v_teacher_id, 2, v_org) is not null
       or public.omr_validate_provisioned_teacher_session_v1(
           v_teacher_id, 1, 'pilot_org_' || pg_catalog.repeat('0', 24)
       ) is not null then
        raise exception 'teacher member session accepted a stale generation or foreign org';
    end if;

    -- Legacy self-service gateways never see a member-ledger account.
    if public.omr_lookup_teacher_account_v1('pilot-teacher@example.test') is not null
       or public.omr_validate_teacher_session_v1(v_teacher_id, 1)
       or public.omr_begin_teacher_password_reset_v1(
           'teacher_token_' || pg_catalog.repeat('a', 24), 'pilot-teacher@example.test',
           pg_catalog.repeat('a', 64), pg_catalog.clock_timestamp() + interval '1 hour'
       ) then
        raise exception 'legacy self-service gateway accepted a pilot member';
    end if;

    -- Owner-only and cross-org shapes are never adopted by member provisioning.
    v_rejected := false;
    begin
        perform public.omr_provision_pilot_org_teacher_v1(
            v_org, 'pilot-owner@example.test', '원장 1', v_teacher_hash,
            'operator:assertions', 'pilot_org_teacher_test', 'prov_' || pg_catalog.repeat('A', 40)
        );
    exception when others then
        v_rejected := sqlerrm = 'provisioning_conflict';
    end;
    if not v_rejected then raise exception 'member provisioning adopted the owner account'; end if;
    v_rejected := false;
    begin
        perform public.omr_provision_pilot_teacher_v1(
            '테스트 학원', 'pilot-teacher@example.test', '교사 1', v_owner_hash,
            'academy', v_expires_at, 'operator:assertions', 'pilot_org_teacher_test',
            'prov_' || pg_catalog.repeat('B', 40)
        );
    exception when others then
        v_rejected := sqlerrm = 'provisioning_conflict';
    end;
    if not v_rejected then raise exception 'owner provisioning adopted a teacher member'; end if;
    v_rejected := false;
    begin
        perform public.omr_provision_pilot_org_teacher_v1(
            'pilot_org_' || pg_catalog.repeat('0', 24), 'orphan-teacher@example.test', '교사 3',
            v_teacher_hash, 'operator:assertions', 'pilot_org_teacher_test',
            'prov_' || pg_catalog.repeat('C', 40)
        );
    exception when others then
        v_rejected := sqlerrm = 'provisioning_conflict';
    end;
    if not v_rejected then raise exception 'member provisioning accepted an unknown organization'; end if;
    v_other_owner := public.omr_provision_pilot_teacher_v1(
        '다른 학원', 'pilot-owner-2@example.test', '원장 2', v_owner_hash,
        'pro', v_expires_at, 'operator:assertions', 'pilot_org_teacher_test',
        'prov_' || pg_catalog.repeat('P', 40)
    );
    v_rejected := false;
    begin
        perform public.omr_provision_pilot_org_teacher_v1(
            v_other_owner ->> 'organizationId', 'pilot-teacher@example.test', '교사 1',
            v_teacher_hash, 'operator:assertions', 'pilot_org_teacher_test',
            'prov_' || pg_catalog.repeat('D', 40)
        );
    exception when others then
        v_rejected := sqlerrm = 'provisioning_conflict';
    end;
    if not v_rejected then raise exception 'member provisioning moved a teacher across academies'; end if;
    v_rejected := false;
    begin
        perform public.omr_provision_pilot_org_teacher_v1(
            v_org, 'pilot-teacher@example.test', '교사 일', v_teacher_hash,
            'operator:assertions', 'pilot_org_teacher_test', 'prov_' || pg_catalog.repeat('E', 40)
        );
    exception when others then
        v_rejected := sqlerrm = 'provisioning_conflict';
    end;
    if not v_rejected then raise exception 'member provisioning renamed an existing teacher'; end if;

    -- Re-issue with a new key rotates the password and revokes old sessions.
    v_rotated := public.omr_provision_pilot_org_teacher_v1(
        v_org, 'pilot-teacher@example.test', '교사 1', v_rotated_hash,
        'operator:assertions', 'pilot_org_teacher_rotate', 'prov_' || pg_catalog.repeat('R', 40)
    );
    if v_rotated ->> 'accountId' is distinct from v_teacher_id
       or v_rotated ->> 'provisionId' = v_teacher ->> 'provisionId'
       or v_rotated ->> 'replayed' is distinct from 'false'
       or public.omr_validate_provisioned_teacher_session_v1(v_teacher_id, 1, v_org) is not null
       or public.omr_validate_provisioned_teacher_session_v1(v_teacher_id, 2, v_org) is null
       or public.omr_lookup_provisioned_teacher_login_v1('pilot-teacher@example.test') ->> 'passwordHash'
           is distinct from v_rotated_hash then
        raise exception 'teacher member rotation did not revoke the prior generation: %', v_rotated;
    end if;
    -- The original receipt still replays after rotation without another write.
    v_replay := public.omr_provision_pilot_org_teacher_v1(
        v_org, 'pilot-teacher@example.test', '교사 1', v_teacher_hash,
        'operator:assertions', 'pilot_org_teacher_test', 'prov_' || pg_catalog.repeat('T', 40)
    );
    if v_replay ->> 'replayed' is distinct from 'true'
       or public.omr_lookup_provisioned_teacher_login_v1('pilot-teacher@example.test') ->> 'passwordHash'
           is distinct from v_rotated_hash then
        raise exception 'stale receipt replay rewrote the rotated credential';
    end if;

    -- A teacher session mutates the shared academy workspace.
    perform public.omr_save_roster_v3(
        'account', v_teacher_id, 2, v_teacher_id, v_org,
        pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
            'id', 'pilot-member-class', 'organization_id', v_org, 'name', '교사반',
            'status', 'active', 'metadata', '{}'::jsonb
        )),
        '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, null
    );
    if not exists (
        select 1 from public.omr_classes class_row
         where class_row.organization_id = v_org and class_row.id = 'pilot-member-class'
    ) then
        raise exception 'teacher member roster write did not reach the academy workspace';
    end if;
    v_rejected := false;
    begin
        perform public.omr_save_roster_v3(
            'account', v_teacher_id, 1, v_teacher_id, v_org,
            '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, null
        );
    exception when others then
        v_rejected := true;
    end;
    if not v_rejected then raise exception 'revoked teacher member generation could still mutate'; end if;

end;
$pilot_org_teacher_assertions$;

-- Private identity helpers (not service_role executable): exercise as owner.
reset role;
do $pilot_org_teacher_private$
declare
    v_org text;
    v_teacher_id text;
    v_owner_id text;
    v_identity jsonb;
    v_plan jsonb;
begin
    select member.organization_id, member.user_id into v_org, v_teacher_id
      from public.omr_organization_members member
     where member.email = 'pilot-teacher@example.test';
    select member.user_id into v_owner_id
      from public.omr_organization_members member
     where member.email = 'pilot-owner@example.test';

    if (select pg_catalog.count(*) from public.omr_audit_logs audit
         where audit.organization_id = v_org
           and audit.action = 'operator.pilot_org_teacher_provisioned') <> 2
       or (select pg_catalog.count(*) from public.omr_pilot_member_provisions provision
            where provision.account_id = v_teacher_id) <> 2 then
        raise exception 'teacher member provisioning audit trail drifted';
    end if;

    v_identity := public.omr_lock_provisioned_teacher_identity_v1(v_teacher_id, 2, v_org);
    if v_identity ->> 'memberRole' is distinct from 'teacher'
       or v_identity ->> 'accountId' is distinct from v_teacher_id then
        raise exception 'teacher member identity lock drifted: %', v_identity;
    end if;
    if public.omr_lock_provisioned_teacher_identity_v1(v_owner_id, 1, v_org) ->> 'memberRole'
       is distinct from 'owner' then
        raise exception 'owner identity lock regressed';
    end if;
    v_plan := public.omr_authorize_effective_teacher_plan_v1(v_teacher_id, v_org);
    if v_plan ->> 'plan' is distinct from 'academy' or v_plan ->> 'grantId' is null then
        raise exception 'teacher member plan did not resolve to the academy grant: %', v_plan;
    end if;
    if (public.omr_probe_provisioned_teacher_canary_v1(v_owner_id) ->> 'ready') <> 'true'
       or (public.omr_probe_provisioned_teacher_canary_v1(v_teacher_id) ->> 'ready') <> 'false' then
        raise exception 'release canary must stay owner-only';
    end if;

    -- Expiring the owner's grant downgrades every member to free, not to null.
    update public.omr_pilot_plan_grants
       set state = 'superseded', superseded_at = pg_catalog.clock_timestamp(),
           updated_at = pg_catalog.clock_timestamp()
     where organization_id = v_org;
    v_plan := public.omr_authorize_effective_teacher_plan_v1(v_teacher_id, v_org);
    if v_plan ->> 'plan' is distinct from 'free'
       or public.omr_lookup_provisioned_teacher_login_v1('pilot-teacher@example.test') ->> 'plan'
          is distinct from 'free' then
        raise exception 'teacher member plan did not follow the owner grant expiry: %', v_plan;
    end if;

    -- A suspended member, or one whose owner lost the academy, cannot sign in.
    update public.omr_organization_members
       set status = 'suspended'
     where user_id = v_teacher_id;
    if public.omr_lookup_provisioned_teacher_login_v1('pilot-teacher@example.test') is not null
       or public.omr_lock_provisioned_teacher_identity_v1(v_teacher_id, 2, v_org) is not null then
        raise exception 'suspended teacher member still authenticated';
    end if;
end;
$pilot_org_teacher_private$;

rollback;
