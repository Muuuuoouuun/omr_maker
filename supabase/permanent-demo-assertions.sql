begin;
do $$
declare hash text:='pbkdf2-sha256:120000:'||repeat('a',32)||':'||repeat('b',64);
    variant text; variant_owner jsonb; variant_member jsonb; variant_plan jsonb;
    owner jsonb; member jsonb; login jsonb; plan jsonb; replay jsonb; rejected boolean; mode text:='permanent_demo';
begin
    foreach variant in array array['free','academy'] loop
      variant_owner:=public.omr_provision_demo_account_v1('Synthetic permanent QA '||variant,null,'permanent-'||variant||'-owner@example.test','Synthetic owner',hash,variant,'owner',mode,'operator:assertions','qa_permanent_demo','prov_'||repeat(case when variant='free' then 'F' else 'A' end,40));
      variant_member:=public.omr_provision_demo_account_v1(null,variant_owner->>'organizationId','permanent-'||variant||'-member@example.test','Synthetic teacher',hash,null,'teacher',mode,'operator:assertions','qa_permanent_demo','prov_'||repeat(case when variant='free' then 'G' else 'B' end,40));
      variant_plan:=public.omr_read_teacher_mutation_plan_v1('account',variant_member->>'accountId',variant_owner->>'organizationId',variant_member->>'accountId');
      if variant_plan->>'plan' <> variant or variant_plan->>'expiresAt' is not null or variant_plan->>'entitlementMode' <> mode then raise exception 'demo three-plan inheritance drift'; end if;
      perform public.omr_set_effective_plan_transaction_proof_v1(variant_owner->>'organizationId',variant_plan);
      perform public.omr_assert_effective_plan_transaction_proof_v1(variant_owner->>'organizationId',false);
      if variant='free' then
        rejected:=false;
        begin perform public.omr_assert_effective_plan_transaction_proof_v1(variant_owner->>'organizationId',true);
        exception when others then rejected:=true; end;
        if not rejected then raise exception 'free demo obtained paid proof'; end if;
      else
        perform public.omr_assert_effective_plan_transaction_proof_v1(variant_owner->>'organizationId',true);
      end if;
    end loop;
    owner:=public.omr_provision_demo_account_v1('Synthetic permanent QA Pro',null,'permanent-owner@example.test','Synthetic owner',hash,'pro','owner',mode,'operator:assertions','qa_permanent_demo','prov_'||repeat('D',40));
    if owner->>'organizationId' !~ '^demo_org_[a-f0-9]{24}$' or owner->>'plan' <> 'pro' then raise exception 'demo owner drift'; end if;
    login:=public.omr_lookup_provisioned_teacher_login_v1('permanent-owner@example.test');
    if login->>'memberRole' <> 'owner' or login->>'entitlementMode' <> mode or login->>'plan' <> 'pro' or login->>'grantExpiresAt' is not null then raise exception 'demo login drift'; end if;
    if public.omr_lookup_teacher_account_v1('permanent-owner@example.test') is not null
       or public.omr_validate_teacher_session_v1(owner->>'accountId',1) then raise exception 'demo escaped through legacy lookup'; end if;
    replay:=public.omr_provision_demo_account_v1('Synthetic permanent QA Pro',null,'permanent-owner@example.test','Synthetic owner',hash,'pro','owner',mode,'operator:assertions','qa_permanent_demo','prov_'||repeat('D',40));
    if replay->>'replayed' <> 'true' or replay->>'accountId' is distinct from owner->>'accountId' then raise exception 'demo replay drift'; end if;
    rejected:=false;
    begin
      perform public.omr_provision_demo_account_v1('Different synthetic QA',null,'permanent-owner@example.test','Synthetic owner',hash,'academy','owner',mode,'operator:assertions','qa_permanent_demo','prov_'||repeat('E',40));
    exception when others then rejected:=sqlerrm='provisioning_conflict'; end;
    if not rejected then raise exception 'demo overwrote existing email'; end if;
    rejected:=false;
    begin
      perform public.omr_provision_demo_account_v1(null,'teacher_1234567','other@example.test','Synthetic teacher',hash,null,'teacher',mode,'operator:assertions','qa_permanent_demo','prov_'||repeat('P',40));
    exception when others then rejected:=sqlerrm='invalid_provisioning_request'; end;
    if not rejected then raise exception 'demo promoted ordinary organization'; end if;
    member:=public.omr_provision_demo_account_v1(null,owner->>'organizationId','permanent-member@example.test','Synthetic teacher',hash,null,'teacher',mode,'operator:assertions','qa_permanent_demo','prov_'||repeat('M',40));
    login:=public.omr_lookup_provisioned_teacher_login_v1('permanent-member@example.test');
    if login->>'memberRole' <> 'teacher' or login->>'plan' <> 'pro' or login->>'grantExpiresAt' is not null then raise exception 'demo member inheritance drift'; end if;
    if public.omr_validate_provisioned_teacher_session_v1(member->>'accountId',2,owner->>'organizationId') is not null then raise exception 'demo generation bypass'; end if;
    plan:=public.omr_read_teacher_mutation_plan_v1('account',member->>'accountId',owner->>'organizationId',member->>'accountId');
    if plan->>'source' <> 'demo' or plan->>'entitlementMode' <> mode or plan->>'expiresAt' is not null then raise exception 'demo mutation plan drift'; end if;
    perform public.omr_set_effective_plan_transaction_proof_v1(owner->>'organizationId',plan);
    perform public.omr_assert_effective_plan_transaction_proof_v1(owner->>'organizationId',true);
    if exists(select 1 from public.omr_pilot_plan_grants where organization_id=owner->>'organizationId') then raise exception 'demo fabricated a paid pilot grant'; end if;
    if public.omr_read_teacher_mutation_plan_v1('account',member->>'accountId','demo_org_'||repeat('0',24),member->>'accountId') is not null then raise exception 'demo crossed org scope'; end if;
    if not public.omr_revoke_demo_organization_v1(owner->>'organizationId',mode,'operator:assertions','qa_demo_retired') then raise exception 'demo revocation failed'; end if;
    if public.omr_lookup_provisioned_teacher_login_v1('permanent-owner@example.test') is not null
      or public.omr_validate_provisioned_teacher_session_v1(member->>'accountId',1,owner->>'organizationId') is not null
      or public.omr_read_effective_workspace_plan_v1(owner->>'organizationId') is not null then raise exception 'revoked demo stayed active'; end if;
    rejected:=false;
    begin perform public.omr_assert_effective_plan_transaction_proof_v1(owner->>'organizationId',true);
    exception when others then rejected:=sqlerrm='effective plan transaction proof required'; end;
    if not rejected then raise exception 'revoked demo reused a proof'; end if;
    if not exists(select 1 from public.omr_audit_logs where organization_id=owner->>'organizationId' and action='operator.demo_organization_revoked') then raise exception 'demo revocation not audited'; end if;
    if has_table_privilege('service_role','public.omr_demo_organizations','INSERT,UPDATE,DELETE')
      or has_table_privilege('anon','public.omr_demo_provisions','SELECT')
      or has_function_privilege('authenticated','public.omr_provision_demo_account_v1(text,text,text,text,text,text,text,text,text,text,text)','EXECUTE') then raise exception 'demo ACL drift'; end if;
end $$;
rollback;
