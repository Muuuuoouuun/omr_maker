-- Synthetic PostgreSQL fixtures only; every row and helper is rolled back.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

create function pg_temp.expect_canary_rejected_after(
    p_account_id text, p_mutation text, p_case text
)
returns void language plpgsql as $helper$
begin
    begin
        execute p_mutation;
        if public.omr_probe_provisioned_teacher_canary_v1(p_account_id) ->> 'ready'
           is distinct from 'false' then
            raise exception 'canary accepted invalid synthetic case: %', p_case;
        end if;
        raise exception using errcode = 'ZC001', message = 'rollback synthetic mutation';
    exception when sqlstate 'ZC001' then null;
    end;
end
$helper$;

do $canary_regressions$
declare
    password_hash text := 'pbkdf2-sha256:120000:' || repeat('a',32) || ':' || repeat('b',64);
    expiry timestamptz := clock_timestamp() + interval '1 day';
    free_owner jsonb;
    pro_owner jsonb;
    academy_owner jsonb;
    member jsonb;
    effective jsonb;
    account_id text;
    free_id text;
    free_org text;
    grant_id text;
    before_state jsonb;
    after_state jsonb;
    signature text := 'public.omr_probe_provisioned_teacher_canary_v1(text)';
begin
    if has_function_privilege('anon',signature,'EXECUTE')
       or has_function_privilege('authenticated',signature,'EXECUTE')
       or not has_function_privilege('service_role',signature,'EXECUTE') then
        raise exception 'provisioned canary execute boundary drift';
    end if;

    free_owner := public.omr_provision_qa_free_owner_v1(
        'Canary Synthetic Free','canary-free@example.test','Synthetic Free owner',password_hash,
        'free',expiry,'operator:canary-assert','qa_free_org','prov_' || repeat('C',40));
    pro_owner := public.omr_provision_pilot_teacher_v1(
        'Canary Synthetic Pro','canary-pro@example.test','Synthetic Pro owner',password_hash,
        'pro',expiry,'operator:canary-assert','canary_regression','prov_' || repeat('D',40));
    academy_owner := public.omr_provision_pilot_teacher_v1(
        'Canary Synthetic Academy','canary-academy@example.test','Synthetic Academy owner',password_hash,
        'academy',expiry,'operator:canary-assert','canary_regression','prov_' || repeat('E',40));
    free_id := free_owner->>'accountId';
    free_org := free_owner->>'organizationId';
    grant_id := free_owner->>'grantId';

    foreach account_id in array array[free_id,pro_owner->>'accountId',academy_owner->>'accountId'] loop
        if public.omr_probe_provisioned_teacher_canary_v1(account_id)->>'ready' is distinct from 'true' then
            raise exception 'active provisioned Free/paid owner failed canary';
        end if;
    end loop;
    effective := public.omr_read_effective_workspace_plan_v1(free_org);
    if effective->>'plan' is distinct from 'free'
       or effective->'grantId' is distinct from 'null'::jsonb
       or effective->'expiresAt' is distinct from 'null'::jsonb then
        raise exception 'Free canary repair exposed a paid entitlement envelope';
    end if;
    member := public.omr_provision_pilot_org_teacher_v1(
        free_org,'canary-member@example.test','Synthetic teacher',password_hash,
        'operator:canary-assert','canary_member','prov_' || repeat('K',40));
    if public.omr_probe_provisioned_teacher_canary_v1(member->>'accountId')->>'ready' is distinct from 'false'
       or public.omr_probe_provisioned_teacher_canary_v1(null)->>'ready' is distinct from 'false'
       or public.omr_probe_provisioned_teacher_canary_v1('teacher_invalid')->>'ready' is distinct from 'false'
       or public.omr_probe_provisioned_teacher_canary_v1('teacher_0000000000000000')->>'ready' is distinct from 'false' then
        raise exception 'canary accepted a member, malformed, missing or null identity';
    end if;

    insert into public.omr_organizations(id,name) values('canary-extra-org','Synthetic extra scope');
    perform pg_temp.expect_canary_rejected_after(free_id,
        format('update public.omr_audit_logs set metadata=jsonb_set(metadata,''{reason}'',''"unrelated_reason"''::jsonb) where entity_id=%L',grant_id),
        'Free grant without qa_free_org audit provenance');
    perform pg_temp.expect_canary_rejected_after(free_id,
        format('update public.omr_audit_logs set metadata=metadata-''reason'' where entity_id=%L',grant_id),
        'Free grant without audit reason');
    perform pg_temp.expect_canary_rejected_after(free_id,
        format('delete from public.omr_audit_logs where entity_id=%L',grant_id),
        'missing canonical audit');
    perform pg_temp.expect_canary_rejected_after(free_id,
        format('insert into public.omr_audit_logs(id,organization_id,actor_user_id,action,entity_type,entity_id,metadata,created_at) select ''audit_canary_duplicate'',organization_id,actor_user_id,action,entity_type,entity_id,metadata,created_at from public.omr_audit_logs where entity_id=%L',grant_id),
        'duplicate matching audit');
    perform pg_temp.expect_canary_rejected_after(free_id,
        format('update public.omr_audit_logs set metadata=jsonb_set(metadata,''{afterSessionGeneration}'',''2''::jsonb) where entity_id=%L',grant_id),
        'audit session generation mismatch');
    perform pg_temp.expect_canary_rejected_after(free_id,
        format('update public.omr_organization_members set email=''canary-mismatch@example.test'' where user_id=%L',free_id),
        'membership email mismatch');
    perform pg_temp.expect_canary_rejected_after(free_id,
        format('update public.omr_organization_members set role=''teacher'' where user_id=%L',free_id),
        'non-owner membership');
    perform pg_temp.expect_canary_rejected_after(free_id,
        format('update public.omr_organization_members set status=''suspended'' where user_id=%L',free_id),
        'inactive membership');
    perform pg_temp.expect_canary_rejected_after(free_id,
        format('update public.omr_teacher_profiles set display_name=''Mismatched synthetic profile'' where user_id=%L',free_id),
        'profile display name mismatch');
    perform pg_temp.expect_canary_rejected_after(free_id,
        format('update public.omr_teacher_profiles set status=''inactive'' where user_id=%L',free_id),
        'inactive profile');
    perform pg_temp.expect_canary_rejected_after(free_id,
        format('insert into public.omr_organization_members(organization_id,user_id,role) values(''canary-extra-org'',%L,''owner'')',free_id),
        'extra membership');
    perform pg_temp.expect_canary_rejected_after(free_id,
        format('insert into public.omr_teacher_profiles(organization_id,user_id,display_name) values(''canary-extra-org'',%L,''Synthetic Free owner'')',free_id),
        'extra profile');
    perform pg_temp.expect_canary_rejected_after(free_id,
        format('update public.omr_teacher_accounts set status=''disabled'' where id=%L',free_id),
        'disabled account');
    perform pg_temp.expect_canary_rejected_after(free_id,
        format('update public.omr_organizations set plan=''academy'' where id=%L',free_org),
        'denormalized paid organization plan');
    perform pg_temp.expect_canary_rejected_after(free_id,
        format('update public.omr_pilot_plan_grants set state=''superseded'',superseded_at=clock_timestamp(),updated_at=clock_timestamp() where id=%L',grant_id),
        'superseded Free provenance');
    perform pg_temp.expect_canary_rejected_after(free_id,
        format('with changed as(update public.omr_pilot_plan_grants set expires_at=created_at+interval ''1 microsecond'' where id=%L returning id,expires_at) update public.omr_audit_logs a set metadata=jsonb_set(metadata,''{expiresAt}'',to_jsonb(to_char(changed.expires_at at time zone ''UTC'',''YYYY-MM-DD"T"HH24:MI:SS.US"Z"''))) from changed where a.entity_id=changed.id',grant_id),
        'expired Free provenance with matching audit expiry');
    perform pg_temp.expect_canary_rejected_after(free_id,
        format('update public.omr_pilot_plan_grants set account_id=%L where id=%L',pro_owner->>'accountId',grant_id),
        'provenance bound to another account');
    perform pg_temp.expect_canary_rejected_after(free_id,
        format('insert into public.omr_pilot_plan_grants(id,idempotency_key_hash,request_hash,organization_id,account_id,plan,expires_at) values(''pilot_grant_cccccccccccccccccccccccc'',repeat(''c'',64),repeat(''d'',64),''canary-extra-org'',%L,''free'',clock_timestamp()+interval ''1 day'')',free_id),
        'multiple active account grants');

    -- The paid path must still match its exact effective grant and audit.
    perform pg_temp.expect_canary_rejected_after(pro_owner->>'accountId',
        format('update public.omr_audit_logs set metadata=jsonb_set(metadata,''{grantId}'',''"pilot_grant_000000000000000000000000"''::jsonb) where entity_id=%L',pro_owner->>'grantId'),
        'paid audit grant identity mismatch');
    perform pg_temp.expect_canary_rejected_after(academy_owner->>'accountId',
        format('update public.omr_audit_logs set metadata=jsonb_set(metadata,''{afterPlan}'',''"free"''::jsonb) where entity_id=%L',academy_owner->>'grantId'),
        'paid audit plan mismatch');

    select jsonb_build_array(
        (select md5(jsonb_agg(to_jsonb(t)order by to_jsonb(t)::text)::text)from public.omr_teacher_accounts t),
        (select md5(jsonb_agg(to_jsonb(t)order by to_jsonb(t)::text)::text)from public.omr_pilot_plan_grants t),
        (select md5(jsonb_agg(to_jsonb(t)order by to_jsonb(t)::text)::text)from public.omr_audit_logs t)
    ) into before_state;
    perform public.omr_probe_provisioned_teacher_canary_v1(free_id);
    perform public.omr_probe_provisioned_teacher_canary_v1(pro_owner->>'accountId');
    perform public.omr_probe_provisioned_teacher_canary_v1(academy_owner->>'accountId');
    select jsonb_build_array(
        (select md5(jsonb_agg(to_jsonb(t)order by to_jsonb(t)::text)::text)from public.omr_teacher_accounts t),
        (select md5(jsonb_agg(to_jsonb(t)order by to_jsonb(t)::text)::text)from public.omr_pilot_plan_grants t),
        (select md5(jsonb_agg(to_jsonb(t)order by to_jsonb(t)::text)::text)from public.omr_audit_logs t)
    ) into after_state;
    if after_state is distinct from before_state then raise exception 'canary mutated identity, provenance or audit rows';end if;
    perform set_config('omr.canary_assert_free',free_id,true);
    perform set_config('omr.canary_assert_pro',pro_owner->>'accountId',true);
    perform set_config('omr.canary_assert_academy',academy_owner->>'accountId',true);
end
$canary_regressions$;

set local role service_role;
do $service_role_canary$
begin
    if public.omr_probe_provisioned_teacher_canary_v1(current_setting('omr.canary_assert_free'))->>'ready' is distinct from 'true'
       or public.omr_probe_provisioned_teacher_canary_v1(current_setting('omr.canary_assert_pro'))->>'ready' is distinct from 'true'
       or public.omr_probe_provisioned_teacher_canary_v1(current_setting('omr.canary_assert_academy'))->>'ready' is distinct from 'true' then
        raise exception 'service-role Free/paid canary failed';
    end if;
end
$service_role_canary$;
reset role;

set local role anon;
do $anon_canary_denied$
begin
    begin
        perform public.omr_probe_provisioned_teacher_canary_v1(current_setting('omr.canary_assert_free'));
        raise exception 'anon executed provisioned canary';
    exception when insufficient_privilege then null;
    end;
end
$anon_canary_denied$;
reset role;

set local role authenticated;
do $authenticated_canary_denied$
begin
    begin
        perform public.omr_probe_provisioned_teacher_canary_v1(current_setting('omr.canary_assert_free'));
        raise exception 'authenticated executed provisioned canary';
    exception when insufficient_privilege then null;
    end;
end
$authenticated_canary_denied$;
reset role;

rollback;
