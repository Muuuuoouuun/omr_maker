-- Synthetic fixtures only. No external delivery; every row is rolled back.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

create function pg_temp.recovery_invocation(
    p_org text,p_admin text,p_email text,p_display text,p_verifier text,
    p_plan text default 'academy',p_mode text default 'legacy_recovery',
    p_reason text default 'legacy_owner_recovery',p_key text default 'prov_LLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLLL'
)returns text language sql as $$
    select format('select public.omr_recover_legacy_organization_v1(%L,%L,%L,%L,%L,%L,%L,%L,%L,%L)',
        p_org,p_admin,p_email,p_display,p_verifier,p_plan,p_mode,'operator:recovery-assert',p_reason,p_key)
$$;

create function pg_temp.recovery_state()returns jsonb language sql as $$
    select jsonb_build_array(
        (select md5(coalesce(jsonb_agg(to_jsonb(t)order by to_jsonb(t)::text),'[]'::jsonb)::text)from public.omr_teacher_accounts t),
        (select md5(coalesce(jsonb_agg(to_jsonb(t)order by to_jsonb(t)::text),'[]'::jsonb)::text)from public.omr_organizations t),
        (select md5(coalesce(jsonb_agg(to_jsonb(t)order by to_jsonb(t)::text),'[]'::jsonb)::text)from public.omr_organization_members t),
        (select md5(coalesce(jsonb_agg(to_jsonb(t)order by to_jsonb(t)::text),'[]'::jsonb)::text)from public.omr_teacher_profiles t),
        (select md5(coalesce(jsonb_agg(to_jsonb(t)order by to_jsonb(t)::text),'[]'::jsonb)::text)from public.omr_audit_logs t),
        (select md5(coalesce(jsonb_agg(to_jsonb(t)order by to_jsonb(t)::text),'[]'::jsonb)::text)from public.omr_teacher_account_tokens t),
        (select md5(coalesce(jsonb_agg(to_jsonb(t)order by to_jsonb(t)::text),'[]'::jsonb)::text)from omr_internal.legacy_organization_recoveries t)
    )
$$;

create function pg_temp.expect_recovery_refused_after(p_mutation text,p_invocation text,p_case text)
returns void language plpgsql as $$
declare before_state jsonb; result jsonb; refused boolean:=false;
begin
    begin
        if p_mutation<>''then execute p_mutation;end if;
        before_state:=pg_temp.recovery_state();
        begin execute p_invocation into result;exception when others then refused:=true;end;
        if not refused and result->>'status'='provisioned'then
            raise exception 'recovery accepted invalid synthetic case: %',p_case;
        end if;
        if pg_temp.recovery_state()is distinct from before_state then
            raise exception 'rejected recovery mutated data: %',p_case;
        end if;
        raise exception using errcode='ZL001',message='rollback synthetic mutation';
    exception when sqlstate 'ZL001'then null;
    end;
end
$$;

create function pg_temp.expect_recovery_runtime_denied_after(
    p_mutation text,p_org text,p_account text,p_email text,p_case text
)returns void language plpgsql as $$
declare call text; result jsonb; calls text[];
begin
    begin
        execute p_mutation;
        calls:=array[
            format('select public.omr_lookup_provisioned_teacher_login_v1(%L)',p_email),
            format('select public.omr_validate_provisioned_teacher_session_v1(%L,1,%L)',p_account,p_org),
            format('select public.omr_lock_provisioned_teacher_identity_v1(%L,1,%L)',p_account,p_org),
            format('select public.omr_read_effective_workspace_plan_v1(%L)',p_org),
            format('select public.omr_read_effective_organization_plan_v1(%L)',p_org),
            format('select public.omr_authorize_effective_teacher_plan_v1(%L,%L)',p_account,p_org),
            format('select public.omr_read_teacher_mutation_plan_v1(''account'',%L,%L,%L)',p_account,p_org,p_account),
            format('select public.omr_lock_legacy_teacher_identity_v1(%L,1,%L,%L)',p_account,p_org,p_account),
            format('select public.omr_read_legacy_teacher_plan_v1(%L,%L,%L)',p_account,p_org,p_account),
            format('select public.omr_lookup_teacher_account_v1(%L)',p_email)
        ];
        foreach call in array calls loop
            result:=null;
            begin execute call into result;exception when others then result:=null;end;
            if result is not null then raise exception 'recovery runtime accepted invalid case %',p_case;end if;
        end loop;
        if public.omr_validate_teacher_session_v1(p_account,1)is distinct from false
           or public.omr_begin_teacher_password_reset_v1('teacher_token_'||repeat('r',24),p_email,
               repeat('f',64),clock_timestamp()+interval '30 minutes')is distinct from false
           or public.omr_complete_teacher_password_reset_v1(repeat('e',64),
               'pbkdf2-sha256:120000:'||repeat('e',32)||':'||repeat('f',64))is distinct from false then
            raise exception 'invalid recovery entered legacy self-service: %',p_case;
        end if;
        result:=public.omr_issue_student_start_code_batch_v1('account',p_account,1,p_org,p_account,
            jsonb_build_array(jsonb_build_object('studentId','recovery-synthetic-student','verifier',
                'pbkdf2-sha256:120000:'||repeat('c',32)||':'||repeat('d',64))),
            'batch_'||repeat('R',40));
        if result->>'status'is distinct from 'unauthorized'then
            raise exception 'invalid recovery retained student mutation capability: %',p_case;
        end if;
        raise exception using errcode='ZL001',message='rollback synthetic mutation';
    exception when sqlstate 'ZL001'then null;
    end;
end
$$;

do $legacy_recovery_regressions$
declare
    org text:='teacher_recovery01';
    old_admin text:='teacher_oldadmin01';
    email text:='legacy-recovery-admin@example.test';
    display_name text:='Synthetic legacy admin';
    verifier text:='pbkdf2-sha256:120000:'||repeat('a',32)||':'||repeat('b',64);
    invocation text;
    recovered jsonb;
    replay jsonb;
    identity jsonb;
    effective jsonb;
    actor text;
    before_state jsonb;
    old_rows jsonb;
    account_row jsonb;
    signature text:='public.omr_recover_legacy_organization_v1(text,text,text,text,text,text,text,text,text,text)';
begin
    if has_function_privilege('anon',signature,'EXECUTE')
       or has_function_privilege('authenticated',signature,'EXECUTE')
       or not has_function_privilege('service_role',signature,'EXECUTE')then
        raise exception 'recovery operator RPC ACL drift';
    end if;
    if has_table_privilege('service_role','omr_internal.legacy_organization_recoveries','SELECT,INSERT,UPDATE,DELETE')
       or has_table_privilege('anon','omr_internal.legacy_organization_recoveries','SELECT,INSERT,UPDATE,DELETE')
       or has_table_privilege('authenticated','omr_internal.legacy_organization_recoveries','SELECT,INSERT,UPDATE,DELETE')then
        raise exception 'private recovery registry direct privileges leaked';
    end if;
    insert into public.omr_organizations(id,name,plan)values(org,'Synthetic legacy Academy','academy'),
        ('teacher_recovery02','Other synthetic legacy scope','free');
    insert into public.omr_user_profiles(user_id,email,display_name)values(old_admin,email,display_name);
    insert into public.omr_organization_members(organization_id,user_id,email,display_name,role)
        values(org,old_admin,email,display_name,'admin'),
        ('teacher_recovery02',old_admin,email,display_name,'owner');
    insert into public.omr_teacher_profiles(organization_id,user_id,display_name)
        values(org,old_admin,display_name),('teacher_recovery02',old_admin,display_name);
    insert into public.omr_exams(id,organization_id,title,payload,created_by_user_id,created_at,updated_at)
        select 'recovery-synthetic-exam-'||n,org,'Synthetic existing exam',
            jsonb_build_object('id','recovery-synthetic-exam-'||n,'questions','[]'::jsonb),old_admin,now(),now()
        from generate_series(1,4)n;
    old_rows:=jsonb_build_array(
        (select to_jsonb(t)from public.omr_organizations t where id=org),
        (select jsonb_agg(to_jsonb(t)order by organization_id)from public.omr_organization_members t where user_id=old_admin),
        (select jsonb_agg(to_jsonb(t)order by organization_id)from public.omr_teacher_profiles t where user_id=old_admin),
        (select jsonb_agg(to_jsonb(t)order by id)from public.omr_exams t where organization_id=org)
    );
    invocation:=pg_temp.recovery_invocation(org,old_admin,email,display_name,verifier);

    perform pg_temp.expect_recovery_refused_after('',
        pg_temp.recovery_invocation('teacher_recovery02',old_admin,email,display_name,verifier),'wrong organization');
    perform pg_temp.expect_recovery_refused_after('',
        pg_temp.recovery_invocation(org,'teacher_wrongadmin',email,display_name,verifier),'wrong source admin');
    perform pg_temp.expect_recovery_refused_after('',
        pg_temp.recovery_invocation(org,old_admin,'unbound-admin@example.test',display_name,verifier),'unbound source email');
    perform pg_temp.expect_recovery_refused_after('',
        pg_temp.recovery_invocation(org,old_admin,email,display_name,verifier,'free'),'wrong plan');
    perform pg_temp.expect_recovery_refused_after('',
        pg_temp.recovery_invocation(org,old_admin,email,display_name,verifier,'academy','permanent_demo'),'wrong mode');
    perform pg_temp.expect_recovery_refused_after('',
        pg_temp.recovery_invocation(org,old_admin,email,display_name,verifier,'academy','legacy_recovery','other_reason'),'wrong audit reason');
    perform pg_temp.expect_recovery_refused_after(
        format('update public.omr_teacher_profiles set status=''inactive''where organization_id=%L and user_id=%L',org,old_admin),
        invocation,'inactive source admin profile');
    perform pg_temp.expect_recovery_refused_after(
        format('update public.omr_user_profiles set email=''mismatch@example.test''where user_id=%L',old_admin),
        invocation,'source user email mismatch');
    perform pg_temp.expect_recovery_refused_after(
        format('insert into public.omr_teacher_accounts(id,email,display_name,password_hash,status)values(''teacher_dddddddddddddddd'',%L,%L,%L,''active'')',email,display_name,verifier),
        invocation,'existing account email conflict');
    perform pg_temp.expect_recovery_refused_after(
        format('insert into public.omr_organization_members(organization_id,user_id,role)values(%L,''teacher_otherowner'',''owner'')',org),
        invocation,'existing owner conflict');

    execute invocation into recovered;
    actor:=recovered->>'accountId';
    if recovered->>'status'is distinct from 'provisioned'or recovered->>'organizationId'is distinct from org
       or recovered->>'memberRole'is distinct from 'owner'or recovered->>'plan'is distinct from 'academy'
       or recovered->>'entitlementMode'is distinct from 'legacy_recovery'
       or recovered->>'replayed'is distinct from 'false'or actor!~'^teacher_[a-f0-9]{16}$'
       or(select count(*)from jsonb_object_keys(recovered))<>7 then
        raise exception 'legacy recovery result contract mismatch';
    end if;
    if(select count(*)from public.omr_organization_members where user_id=actor)<>1
       or(select count(*)from public.omr_teacher_profiles where user_id=actor)<>1
       or(select count(*)from public.omr_organization_members where user_id=old_admin)<>2 then
        raise exception 'recovery rekeyed old admin or created ambiguous new owner scope';
    end if;
    before_state:=pg_temp.recovery_state();
    execute invocation into replay;
    if replay-'replayed'is distinct from recovered-'replayed'or replay->>'replayed'is distinct from 'true'
       or pg_temp.recovery_state()is distinct from before_state then
        raise exception 'recovery replay rotated identity or repeated audit';
    end if;
    if old_rows is distinct from jsonb_build_array(
        (select to_jsonb(t)from public.omr_organizations t where id=org),
        (select jsonb_agg(to_jsonb(t)order by organization_id)from public.omr_organization_members t where user_id=old_admin),
        (select jsonb_agg(to_jsonb(t)order by organization_id)from public.omr_teacher_profiles t where user_id=old_admin),
        (select jsonb_agg(to_jsonb(t)order by id)from public.omr_exams t where organization_id=org))then
        raise exception 'recovery changed original organization, memberships, profiles or four exams';
    end if;
    identity:=public.omr_lookup_provisioned_teacher_login_v1(email);
    if identity->>'accountId'is distinct from actor or identity->>'organizationId'is distinct from org
       or identity->>'plan'is distinct from 'academy'or identity->>'memberRole'is distinct from 'owner'
       or identity->>'entitlementMode'is distinct from 'legacy_recovery'
       or identity->'grantExpiresAt'is distinct from 'null'::jsonb
       or identity->>'passwordHash'is distinct from verifier
       or(select count(*)from jsonb_object_keys(identity))<>11
       or identity-array['accountId','email','displayName','passwordHash','sessionGeneration','organizationId','organizationName','memberRole','plan','grantExpiresAt','entitlementMode']is distinct from '{}'::jsonb then
        raise exception 'recovered owner login binding failed';
    end if;
    identity:=public.omr_validate_provisioned_teacher_session_v1(actor,1,org);
    if identity->>'accountId'is distinct from actor or identity->>'entitlementMode'is distinct from 'legacy_recovery'
       or identity->'grantExpiresAt'is distinct from 'null'::jsonb
       or(select count(*)from jsonb_object_keys(identity))<>8
       or identity-array['accountId','sessionGeneration','organizationId','organizationName','memberRole','plan','grantExpiresAt','entitlementMode']is distinct from '{}'::jsonb then
        raise exception 'recovered owner request-time validation failed';
    end if;
    if public.omr_validate_provisioned_teacher_session_v1(actor,2,org)is not null
       or public.omr_validate_provisioned_teacher_session_v1(actor,1,'teacher_recovery02')is not null
       or public.omr_lookup_teacher_account_v1(email)is not null
       or public.omr_validate_teacher_session_v1(actor,1)is distinct from false then
        raise exception 'recovered owner escaped its generation/scope or entered legacy self-service';
    end if;
    effective:=public.omr_read_effective_workspace_plan_v1(org);
    if effective->>'plan'is distinct from 'academy'or effective->>'entitlementMode'is distinct from 'legacy_recovery'
       or effective->'grantId'is distinct from 'null'::jsonb or effective->'expiresAt'is distinct from 'null'::jsonb
       or(select count(*)from jsonb_object_keys(effective))<>5
       or effective-array['organizationId','plan','grantId','expiresAt','entitlementMode']is distinct from '{}'::jsonb then
        raise exception 'permanent Academy workspace entitlement failed';
    end if;
    effective:=public.omr_read_teacher_mutation_plan_v1('account',actor,org,actor);
    if effective->>'source'is distinct from 'legacy'or effective->>'plan'is distinct from 'academy'then
        raise exception 'recovery did not preserve the existing legacy transaction-proof contract';
    end if;
    perform public.omr_set_effective_plan_transaction_proof_v1(org,effective);
    perform public.omr_assert_effective_plan_transaction_proof_v1(org,true);
    insert into public.omr_student_profiles(id,organization_id,display_name,status)
        values('recovery-synthetic-student',org,'Synthetic student','active');
    effective:=public.omr_issue_student_start_code_batch_v1('account',actor,1,org,actor,
        jsonb_build_array(jsonb_build_object('studentId','recovery-synthetic-student','verifier',
            'pbkdf2-sha256:120000:'||repeat('c',32)||':'||repeat('d',64))),
        'batch_'||repeat('R',40));
    if effective->>'status'is distinct from 'issued'then
        raise exception 'recovered owner student credential mutation was rejected';
    end if;
    -- A valid existing token must remain unusable by recovered identities even
    -- when their registry is revoked, damaged or removed.
    insert into public.omr_teacher_account_tokens(id,account_id,purpose,token_hash,expires_at,created_at)
        values('teacher_token_'||repeat('e',24),actor,'password_reset',repeat('e',64),
            clock_timestamp()+interval '30 minutes',clock_timestamp());

    -- The reviewed old admin is issuance evidence, not a second live owner.
    -- Later changes to that separate identity must not silently revoke recovery.
    begin
        update public.omr_organization_members set status='removed'
            where organization_id=org and user_id=old_admin;
        update public.omr_teacher_profiles set status='inactive'
            where organization_id=org and user_id=old_admin;
        if public.omr_validate_provisioned_teacher_session_v1(actor,1,org)->>'plan'is distinct from 'academy'then
            raise exception 'recovery remained dependent on the old admin live status';
        end if;
        raise exception using errcode='ZL001',message='rollback synthetic old-admin change';
    exception when sqlstate 'ZL001'then null;
    end;

    perform pg_temp.expect_recovery_runtime_denied_after(
        format('update omr_internal.legacy_organization_recoveries set state=''revoked'',revoked_at=clock_timestamp()where organization_id=%L',org),
        org,actor,email,'revoked recovery cannot fall back to nominal Academy or replay student capability');
    perform pg_temp.expect_recovery_runtime_denied_after(
        format('delete from omr_internal.legacy_organization_recoveries where organization_id=%L',org),
        org,actor,email,'missing registry cannot fall back while recovery audit remains');
    perform pg_temp.expect_recovery_refused_after(
        format('delete from omr_internal.legacy_organization_recoveries where organization_id=%L',org),
        invocation,'missing registry cannot replay or provision a second owner');
    perform pg_temp.expect_recovery_runtime_denied_after(
        format('update public.omr_teacher_accounts set status=''disabled''where id=%L',actor),org,actor,email,'disabled owner');
    perform pg_temp.expect_recovery_runtime_denied_after(
        format('update public.omr_organization_members set role=''teacher''where user_id=%L',actor),org,actor,email,'owner role downgrade');
    perform pg_temp.expect_recovery_runtime_denied_after(
        format('insert into public.omr_organization_members(organization_id,user_id,role)values(''teacher_recovery02'',%L,''teacher'')',actor),
        org,actor,email,'extra owner membership');
    perform pg_temp.expect_recovery_runtime_denied_after(
        format('insert into public.omr_teacher_profiles(organization_id,user_id,display_name)values(''teacher_recovery02'',%L,%L)',actor,display_name),
        org,actor,email,'extra owner profile');
    perform pg_temp.expect_recovery_runtime_denied_after(
        format('update public.omr_teacher_profiles set display_name=''Tampered owner''where user_id=%L',actor),
        org,actor,email,'profile binding mismatch');
    perform pg_temp.expect_recovery_runtime_denied_after(
        format('update omr_internal.legacy_organization_recoveries set source_admin_user_id=''teacher_wrongadmin''where organization_id=%L',org),
        org,actor,email,'tampered registry source binding');
    perform pg_temp.expect_recovery_runtime_denied_after(
        format('delete from public.omr_audit_logs where id=(select audit_id from omr_internal.legacy_organization_recoveries where organization_id=%L)',org),
        org,actor,email,'missing recovery audit');
    perform pg_temp.expect_recovery_runtime_denied_after(
        format('update public.omr_audit_logs set metadata=jsonb_set(metadata,''{plan}'',''"free"''::jsonb) where id=(select audit_id from omr_internal.legacy_organization_recoveries where organization_id=%L)',org),
        org,actor,email,'tampered recovery audit');
    perform pg_temp.expect_recovery_runtime_denied_after(
        format('insert into public.omr_audit_logs(id,organization_id,actor_user_id,action,entity_type,entity_id,metadata,created_at) select ''audit_recovery_duplicate'',organization_id,actor_user_id,action,entity_type,entity_id,metadata,created_at from public.omr_audit_logs where id=(select audit_id from omr_internal.legacy_organization_recoveries where organization_id=%L)',org),
        org,actor,email,'duplicate recovery provenance audit');
    perform set_config('omr.recovery_assert_account',actor,true);
    perform set_config('omr.recovery_assert_org',org,true);
    perform set_config('omr.recovery_assert_email',email,true);
end
$legacy_recovery_regressions$;

set local role service_role;
do $recovery_service_role$
begin
    if public.omr_lookup_provisioned_teacher_login_v1(current_setting('omr.recovery_assert_email'))->>'entitlementMode'
       is distinct from 'legacy_recovery'
       or public.omr_validate_provisioned_teacher_session_v1(current_setting('omr.recovery_assert_account'),1,
          current_setting('omr.recovery_assert_org'))->>'plan'is distinct from 'academy'then
        raise exception 'recovery service-role caller failed';
    end if;
end
$recovery_service_role$;
reset role;
rollback;
