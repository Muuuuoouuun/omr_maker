-- Synthetic local PG17 fixtures only. The transaction rolls back every row.
begin;
do $$
declare
    hash text := 'pbkdf2-sha256:120000:' || repeat('a',32) || ':' || repeat('b',64);
    expiry timestamptz := clock_timestamp() + interval '1 day';
    owner jsonb;
    replay jsonb;
    login jsonb;
    effective jsonb;
    member jsonb;
    rejected boolean;
    sig text := 'public.omr_provision_qa_free_owner_v1(text,text,text,text,text,timestamptz,text,text,text)';
begin
    if has_function_privilege('anon', sig, 'EXECUTE')
       or has_function_privilege('authenticated', sig, 'EXECUTE')
       or not has_function_privilege('service_role', sig, 'EXECUTE') then
        raise exception 'Free QA ACL drift';
    end if;
    owner := public.omr_provision_qa_free_owner_v1(
        'Synthetic QA Free', 'qa-free-synthetic@example.test', 'Synthetic owner', hash,
        'free', expiry, 'operator:assertions', 'qa_free_org', 'prov_' || repeat('F',40));
    effective := public.omr_read_effective_workspace_plan_v1(owner->>'organizationId');
    if owner->>'plan' is distinct from 'free'
       or effective->>'plan' is distinct from 'free'
       or effective->>'grantId' is not null
       or effective->>'expiresAt' is not null then
        raise exception 'Free QA plan drift';
    end if;
    login := public.omr_lookup_provisioned_teacher_login_v1('qa-free-synthetic@example.test');
    if login->>'memberRole' is distinct from 'owner' or login->>'plan' is distinct from 'free'
       or login->>'grantExpiresAt' is not null then
        raise exception 'Free QA login drift';
    end if;
    replay := public.omr_provision_qa_free_owner_v1(
        'Synthetic QA Free', 'qa-free-synthetic@example.test', 'Synthetic owner', hash,
        'free', expiry, 'operator:assertions', 'qa_free_org', 'prov_' || repeat('F',40));
    if replay - 'replayed' is distinct from owner - 'replayed'
       or replay->>'replayed' is distinct from 'true' then
        raise exception 'Free QA replay drift';
    end if;
    rejected := false;
    begin
        perform public.omr_provision_qa_free_owner_v1(
            'Synthetic QA Free', 'qa-free-synthetic@example.test', 'Synthetic owner', hash,
            'free', expiry, 'operator:assertions', 'qa_free_org', 'prov_' || repeat('G',40));
    exception when others then rejected := sqlerrm = 'provisioning_conflict'; end;
    if not rejected then raise exception 'Free QA overwrote an existing account'; end if;
    if (select session_generation from public.omr_teacher_accounts where id=owner->>'accountId') <> 1 then
        raise exception 'Free QA conflict rotated a session';
    end if;
    member := public.omr_provision_pilot_org_teacher_v1(
        owner->>'organizationId', 'qa-free-member-synthetic@example.test', 'Synthetic teacher', hash,
        'operator:assertions', 'qa_free_member', 'prov_' || repeat('J',40));
    login := public.omr_lookup_provisioned_teacher_login_v1('qa-free-member-synthetic@example.test');
    if login->>'memberRole' is distinct from 'teacher' or login->>'plan' is distinct from 'free' then
        raise exception 'Free QA member did not inherit the Free plan';
    end if;
    effective := public.omr_authorize_effective_teacher_plan_v1(member->>'accountId', owner->>'organizationId');
    if effective->>'plan' is distinct from 'free' or effective->>'grantId' is not null then
        raise exception 'Free QA member received paid transaction proof';
    end if;
    rejected := false;
    begin
        perform public.omr_provision_qa_free_owner_v1(
            'Synthetic QA Free', 'qa-paid-synthetic@example.test', 'Synthetic owner', hash,
            'academy', expiry, 'operator:assertions', 'qa_free_org', 'prov_' || repeat('H',40));
    exception when others then rejected := sqlerrm = 'invalid_provisioning_request'; end;
    if not rejected then raise exception 'Free QA issued a paid plan'; end if;
    rejected := false;
    begin
        perform public.omr_provision_qa_free_owner_v1(
            'Synthetic QA Free', 'qa-reason-synthetic@example.test', 'Synthetic owner', hash,
            'free', expiry, 'operator:assertions', 'initial_pilot', 'prov_' || repeat('I',40));
    exception when others then rejected := sqlerrm = 'invalid_provisioning_request'; end;
    if not rejected then raise exception 'Free QA accepted a general provisioning reason'; end if;
end $$;
rollback;
