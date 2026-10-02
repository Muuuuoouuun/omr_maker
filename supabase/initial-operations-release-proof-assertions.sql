\set ON_ERROR_STOP on

\if :{?release_proof_phase}
\else
\echo missing release_proof_phase
\quit
\endif

select :'release_proof_phase' = 'boundary_asserted' as is_boundary_phase \gset
\if :is_boundary_phase
begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';
do $release_proof_boundary_phase$
begin
    if public.omr_service_readiness_v1() ->> 'ready' is distinct from 'true'
       or pg_catalog.has_schema_privilege('anon', 'public', 'USAGE')
       or pg_catalog.has_schema_privilege('authenticated', 'public', 'USAGE') then
        raise exception 'production boundary phase was not asserted';
    end if;
end
$release_proof_boundary_phase$;
commit;
\echo OMR_INITIAL_OPS_ROLLBACK_PHASE_V1 {"schemaVersion":1,"ordinal":1,"phase":"boundary_asserted"}
\quit
\endif

select :'release_proof_phase' = 'rollback_asserted' as is_rollback_phase \gset
\if :is_rollback_phase
begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';
do $release_proof_rollback_phase$
begin
    if not pg_catalog.has_schema_privilege('anon', 'public', 'USAGE')
       or not pg_catalog.has_schema_privilege('authenticated', 'public', 'USAGE')
       or not pg_catalog.has_table_privilege('authenticated', 'public.omr_exams', 'SELECT') then
        raise exception 'rollback phase did not restore the exact browser access contract';
    end if;
end
$release_proof_rollback_phase$;
commit;
\echo OMR_INITIAL_OPS_ROLLBACK_PHASE_V1 {"schemaVersion":1,"ordinal":2,"phase":"rollback_asserted"}
\quit
\endif

select :'release_proof_phase' = 'reapplied' as is_reapplied_phase \gset
\if :is_reapplied_phase
begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';
do $release_proof_reapplied_phase$
begin
    if public.omr_service_readiness_v1() ->> 'ready' is distinct from 'true'
       or pg_catalog.has_schema_privilege('anon', 'public', 'USAGE')
       or pg_catalog.has_schema_privilege('authenticated', 'public', 'USAGE') then
        raise exception 'production boundary was not restored after rollback';
    end if;
end
$release_proof_reapplied_phase$;
commit;
\echo OMR_INITIAL_OPS_ROLLBACK_PHASE_V1 {"schemaVersion":1,"ordinal":3,"phase":"reapplied"}
\quit
\endif

select :'release_proof_phase' = 'final_asserted' as is_final_phase \gset
\if :is_final_phase
\else
\echo unknown release_proof_phase
\quit
\endif

begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

-- release-proof-assertion:provisioning_entitlement_operator_provision
set local role service_role;
do $release_proof_operator_provision$
declare
    v_result jsonb;
begin
    v_result := public.omr_provision_pilot_teacher_v1(
        'Release Proof School', 'release-proof-teacher@example.test',
        'Release Proof Teacher',
        'pbkdf2-sha256:120000:' || repeat('a', 32) || ':' || repeat('b', 64),
        'pro', pg_catalog.clock_timestamp() + interval '7 days',
        'operator:release-proof', 'release_proof',
        'prov_' || repeat('A', 32)
    );
    if v_result ->> 'replayed' is distinct from 'false'
       or v_result ->> 'plan' is distinct from 'pro'
       or coalesce(v_result ->> 'accountId' ~ '^teacher_[a-f0-9]{16}$', false) is not true
       or coalesce(v_result ->> 'organizationId' ~ '^pilot_org_[a-f0-9]{24}$', false) is not true
       or coalesce(v_result ->> 'grantId' ~ '^pilot_grant_[a-f0-9]{24}$', false) is not true then
        raise exception 'operator provisioning did not create the canonical identity graph';
    end if;
    perform pg_catalog.set_config('omr.release_proof_account_id', v_result ->> 'accountId', false);
    perform pg_catalog.set_config('omr.release_proof_organization_id', v_result ->> 'organizationId', false);
    perform pg_catalog.set_config('omr.release_proof_grant_id', v_result ->> 'grantId', false);
end
$release_proof_operator_provision$;
reset role;
\echo OMR_INITIAL_OPS_RELEASE_PROOF_V1 {"schemaVersion":1,"ordinal":1,"proofId":"provisioning_entitlement_operator_provision"}

-- release-proof-assertion:provisioning_entitlement_provision_audit
create function pg_temp.release_proof_reject_provision_audit()
returns trigger language plpgsql as $release_proof_trigger$
begin
    if new.action = 'operator.pilot_teacher_provisioned'
       and new.actor_user_id = 'operator:release-proof-forced-audit' then
        raise exception 'release_proof_forced_audit_failure';
    end if;
    return new;
end
$release_proof_trigger$;
create trigger omr_release_proof_reject_provision_audit
before insert on public.omr_audit_logs
for each row execute function pg_temp.release_proof_reject_provision_audit();
do $release_proof_provision_audit$
declare
    v_before jsonb;
    v_after jsonb;
    v_failed boolean := false;
begin
    if not exists (
        select 1
          from public.omr_audit_logs audit
         where audit.organization_id = pg_catalog.current_setting('omr.release_proof_organization_id')
           and audit.actor_user_id = 'operator:release-proof'
           and audit.action = 'operator.pilot_teacher_provisioned'
           and audit.entity_type = 'pilot_plan_grant'
           and audit.entity_id = pg_catalog.current_setting('omr.release_proof_grant_id')
           and audit.metadata ->> 'reason' is not distinct from 'release_proof'
           and audit.metadata ->> 'beforePlan' is not distinct from 'free'
           and audit.metadata ->> 'afterPlan' is not distinct from 'pro'
           and audit.metadata ->> 'beforeSessionGeneration' is not distinct from '0'
           and audit.metadata ->> 'afterSessionGeneration' is not distinct from '1'
           and not (audit.metadata ? 'email')
           and not (audit.metadata ? 'passwordHash')
    ) then
        raise exception 'operator provisioning audit is missing, unsafe, or non-canonical';
    end if;
    select pg_catalog.jsonb_build_object(
        'organizations', (select pg_catalog.count(*) from public.omr_organizations),
        'accounts', (select pg_catalog.count(*) from public.omr_teacher_accounts),
        'members', (select pg_catalog.count(*) from public.omr_organization_members),
        'profiles', (select pg_catalog.count(*) from public.omr_teacher_profiles),
        'grants', (select pg_catalog.count(*) from public.omr_pilot_plan_grants),
        'audits', (select pg_catalog.count(*) from public.omr_audit_logs)
    ) into v_before;
    begin
        perform public.omr_provision_pilot_teacher_v1(
            'Forced Audit School', 'release-proof-forced-audit@example.test', 'Forced Audit Teacher',
            'pbkdf2-sha256:120000:' || repeat('d', 32) || ':' || repeat('e', 64),
            'pro', pg_catalog.clock_timestamp() + interval '1 day',
            'operator:release-proof-forced-audit', 'forced_audit_rollback',
            'prov_' || repeat('D', 32)
        );
    exception when others then
        if sqlerrm is distinct from 'release_proof_forced_audit_failure' then raise; end if;
        v_failed := true;
    end;
    select pg_catalog.jsonb_build_object(
        'organizations', (select pg_catalog.count(*) from public.omr_organizations),
        'accounts', (select pg_catalog.count(*) from public.omr_teacher_accounts),
        'members', (select pg_catalog.count(*) from public.omr_organization_members),
        'profiles', (select pg_catalog.count(*) from public.omr_teacher_profiles),
        'grants', (select pg_catalog.count(*) from public.omr_pilot_plan_grants),
        'audits', (select pg_catalog.count(*) from public.omr_audit_logs)
    ) into v_after;
    if not v_failed or v_after is distinct from v_before
       or exists (select 1 from public.omr_teacher_accounts
                   where email = 'release-proof-forced-audit@example.test') then
        raise exception 'forced audit failure did not roll back the complete provisioning graph';
    end if;
end
$release_proof_provision_audit$;
drop trigger omr_release_proof_reject_provision_audit on public.omr_audit_logs;
\echo OMR_INITIAL_OPS_RELEASE_PROOF_V1 {"schemaVersion":1,"ordinal":2,"proofId":"provisioning_entitlement_provision_audit"}

-- release-proof-assertion:provisioning_entitlement_pilot_grant
set local role service_role;
do $release_proof_pilot_grant$
declare
    v_login jsonb;
    v_session jsonb;
begin
    v_login := public.omr_lookup_provisioned_teacher_login_v1(
        'release-proof-teacher@example.test'
    );
    v_session := public.omr_validate_provisioned_teacher_session_v1(
        pg_catalog.current_setting('omr.release_proof_account_id'), 1,
        pg_catalog.current_setting('omr.release_proof_organization_id')
    );
    if v_login ->> 'accountId' is distinct from pg_catalog.current_setting('omr.release_proof_account_id')
       or v_login ->> 'organizationId' is distinct from pg_catalog.current_setting('omr.release_proof_organization_id')
       or v_login ->> 'memberRole' is distinct from 'owner'
       or v_login ->> 'plan' is distinct from 'pro'
       or v_session ->> 'plan' is distinct from 'pro'
       or v_session ->> 'memberRole' is distinct from 'owner'
       or public.omr_lookup_teacher_account_v1('release-proof-teacher@example.test') is not null then
        raise exception 'pilot entitlement was not authoritative at login and session validation';
    end if;
end
$release_proof_pilot_grant$;
reset role;
do $release_proof_pilot_expiry_and_supersede$
declare
    v_grant_id text := pg_catalog.current_setting('omr.release_proof_grant_id');
    v_account_id text := pg_catalog.current_setting('omr.release_proof_account_id');
    v_organization_id text := pg_catalog.current_setting('omr.release_proof_organization_id');
    v_expires_at timestamptz;
    v_effective jsonb;
begin
    select expires_at into strict v_expires_at
      from public.omr_pilot_plan_grants where id = v_grant_id;
    update public.omr_pilot_plan_grants
       set created_at = pg_catalog.clock_timestamp() - interval '2 days',
           expires_at = pg_catalog.clock_timestamp() - interval '1 day',
           updated_at = pg_catalog.clock_timestamp()
     where id = v_grant_id;
    v_effective := public.omr_validate_provisioned_teacher_session_v1(
        v_account_id, 1, v_organization_id
    );
    if v_effective ->> 'plan' is distinct from 'free' or v_effective -> 'grantExpiresAt' is distinct from 'null'::jsonb then
        raise exception 'expired pilot grant did not fall back to free';
    end if;
    update public.omr_pilot_plan_grants
       set state = 'superseded', superseded_at = pg_catalog.clock_timestamp(),
           expires_at = v_expires_at, updated_at = pg_catalog.clock_timestamp()
     where id = v_grant_id;
    v_effective := public.omr_validate_provisioned_teacher_session_v1(
        v_account_id, 1, v_organization_id
    );
    if v_effective ->> 'plan' is distinct from 'free' or v_effective -> 'grantExpiresAt' is distinct from 'null'::jsonb then
        raise exception 'superseded pilot grant did not fall back to free';
    end if;
    update public.omr_pilot_plan_grants
       set state = 'active', superseded_at = null, expires_at = v_expires_at,
           updated_at = pg_catalog.clock_timestamp()
     where id = v_grant_id;
end
$release_proof_pilot_expiry_and_supersede$;
\echo OMR_INITIAL_OPS_RELEASE_PROOF_V1 {"schemaVersion":1,"ordinal":3,"proofId":"provisioning_entitlement_pilot_grant"}

-- release-proof-assertion:provisioning_entitlement_student_batch
insert into public.omr_classes (id, organization_id, name, status, metadata)
values (
    'release-proof-class', pg_catalog.current_setting('omr.release_proof_organization_id'),
    'Release Proof Class', 'active', '{}'::jsonb
);
insert into public.omr_student_profiles (
    id, organization_id, display_name, external_id, status, metadata
) values
    ('release-proof-student-a', pg_catalog.current_setting('omr.release_proof_organization_id'),
     'Release Student A', 'RELEASE-A', 'active', '{}'::jsonb),
    ('release-proof-student-b', pg_catalog.current_setting('omr.release_proof_organization_id'),
     'Release Student B', 'RELEASE-B', 'active', '{}'::jsonb);
insert into public.omr_class_students (
    class_id, organization_id, student_profile_id, enrollment_status
) values
    ('release-proof-class', pg_catalog.current_setting('omr.release_proof_organization_id'),
     'release-proof-student-a', 'active'),
    ('release-proof-class', pg_catalog.current_setting('omr.release_proof_organization_id'),
     'release-proof-student-b', 'active');
set local role service_role;
do $release_proof_student_batch$
declare
    v_result jsonb;
begin
    v_result := public.omr_issue_student_start_code_batch_v1(
        'account', pg_catalog.current_setting('omr.release_proof_account_id'), 1,
        pg_catalog.current_setting('omr.release_proof_organization_id'),
        pg_catalog.current_setting('omr.release_proof_account_id'),
        pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object(
                'studentId', 'release-proof-student-b',
                'verifier', 'pbkdf2-sha256:120000:' || repeat('2', 32) || ':' || repeat('b', 64)
            ),
            pg_catalog.jsonb_build_object(
                'studentId', 'release-proof-student-a',
                'verifier', 'pbkdf2-sha256:120000:' || repeat('1', 32) || ':' || repeat('a', 64)
            )
        ),
        'batch_' || repeat('B', 32)
    );
    if v_result ->> 'status' is distinct from 'issued'
       or v_result ->> 'count' is distinct from '2'
       or v_result -> 'studentIds'
          is distinct from '["release-proof-student-a","release-proof-student-b"]'::jsonb then
        raise exception 'student credential batch was not atomic and deterministically ordered';
    end if;
end
$release_proof_student_batch$;
reset role;
do $release_proof_student_batch_adversarial_transcript$
declare
    v_generation_001 integer;
    v_generation_002 integer;
    v_generation_103 integer;
begin
    -- live-test-assertions.sql already executed the exact current RPC for the
    -- empty/zero-student, 101, duplicate, foreign, inactive, mixed-invalid,
    -- 100-student, already_applied, idempotency_conflict, forced audit
    -- rollback, and generation exhausted all-or-none paths. Bind its durable
    -- terminal state before this proof marker can be emitted.
    select credential_generation into strict v_generation_001
      from public.omr_student_start_credentials
     where organization_id = 'teacher_task6batch'
       and student_profile_id = 'task6-student-001';
    select credential_generation into strict v_generation_002
      from public.omr_student_start_credentials
     where organization_id = 'teacher_task6batch'
       and student_profile_id = 'task6-student-002';
    select credential_generation into strict v_generation_103
      from public.omr_student_start_credentials
     where organization_id = 'teacher_task6batch'
       and student_profile_id = 'task6-student-103';
    if (select pg_catalog.count(*) from public.omr_student_start_credentials
         where organization_id = 'teacher_task6batch') is distinct from 105
       or exists (
           select 1 from pg_catalog.generate_series(1, 100) number
           left join public.omr_student_start_credentials credential
             on credential.organization_id = 'teacher_task6batch'
            and credential.student_profile_id =
                'task6-student-' || pg_catalog.lpad(number::text, 3, '0')
          where credential.student_profile_id is null
       )
       or v_generation_001 is distinct from 2147483646
       or v_generation_002 is distinct from 1
       or v_generation_103 is distinct from 3
       or exists (
           select 1 from public.omr_student_credential_batch_receipts
            where organization_id = 'teacher_task6batch'
              and idempotency_key_hash in (
                  pg_catalog.encode(extensions.digest('batch_' || repeat('H', 32), 'sha256'), 'hex'),
                  pg_catalog.encode(extensions.digest('batch_' || repeat('J', 32), 'sha256'), 'hex')
              )
       )
       or exists (
           select 1 from public.omr_audit_logs
            where organization_id = 'teacher_task6batch'
              and metadata::text ~ '(task6-student|pbkdf2|batch_)'
       ) then
        raise exception 'strong student batch transcript did not preserve exact bounded all-or-none state';
    end if;
end
$release_proof_student_batch_adversarial_transcript$;
\echo OMR_INITIAL_OPS_RELEASE_PROOF_V1 {"schemaVersion":1,"ordinal":4,"proofId":"provisioning_entitlement_student_batch"}

-- release-proof-witness:provisioning_entitlement_one_time_secret_nonpersistence
set local role service_role;
do $release_proof_one_time_secret_nonpersistence$
declare
    v_result jsonb;
begin
    v_result := public.omr_issue_student_start_code_batch_v1(
        'account', pg_catalog.current_setting('omr.release_proof_account_id'), 1,
        pg_catalog.current_setting('omr.release_proof_organization_id'),
        pg_catalog.current_setting('omr.release_proof_account_id'),
        pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object(
                'studentId', 'release-proof-student-a',
                'verifier', 'pbkdf2-sha256:120000:' || repeat('f', 32) || ':' || repeat('f', 64)
            ),
            pg_catalog.jsonb_build_object(
                'studentId', 'release-proof-student-b',
                'verifier', 'pbkdf2-sha256:120000:' || repeat('e', 32) || ':' || repeat('e', 64)
            )
        ),
        'batch_' || repeat('B', 32)
    );
    if v_result ->> 'status' is distinct from 'already_applied'
       or v_result ? 'verifier' or v_result ? 'startCode' or v_result ? 'password'
       or exists (
           select 1 from information_schema.columns
            where table_schema = 'public'
              and table_name in ('omr_student_start_credentials', 'omr_student_credential_batch_receipts')
              and column_name in ('start_code', 'raw_code', 'verifier', 'idempotency_key')
       )
       or pg_catalog.has_table_privilege(
           'service_role', 'public.omr_student_start_credentials',
           'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
       )
       or pg_catalog.has_table_privilege(
           'service_role', 'public.omr_student_credential_batch_receipts',
           'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
       ) then
        raise exception 'one-time credential boundary returned or persisted recoverable secrets';
    end if;
    begin
        update public.omr_student_start_credentials
           set credential_generation = credential_generation
         where organization_id = pg_catalog.current_setting('omr.release_proof_organization_id');
        raise exception 'service role directly mutated verifier storage';
    exception when insufficient_privilege then null;
    end;
end
$release_proof_one_time_secret_nonpersistence$;
reset role;
do $release_proof_one_time_redaction_state$
begin
    if exists (
        select 1 from public.omr_student_credential_batch_receipts
         where organization_id = pg_catalog.current_setting('omr.release_proof_organization_id')
           and (idempotency_key_hash !~ '^[a-f0-9]{64}$'
                or request_fingerprint !~ '^[a-f0-9]{64}$'
                or state is distinct from 'applied')
    ) or exists (
        select 1 from public.omr_audit_logs
         where organization_id = pg_catalog.current_setting('omr.release_proof_organization_id')
           and action = 'student_start_code_batch_issued'
           and metadata::text ~ '(pbkdf2|batch_|start.?code|verifier)'
    ) then
        raise exception 'credential receipt or audit retained recoverable verifier or start code material';
    end if;
end
$release_proof_one_time_redaction_state$;
\echo OMR_INITIAL_OPS_RELEASE_WITNESS_V1 {"schemaVersion":1,"ordinal":1,"witnessId":"provisioning_entitlement_one_time_secret_nonpersistence"}

-- release-proof-assertion:provisioning_entitlement_credential_rotation
set local role service_role;
do $release_proof_credential_rotation$
declare
    v_old_a text;
    v_old_b text;
    v_result jsonb;
    v_new record;
    v_rotated_count integer := 0;
begin
    select account_id into strict v_old_a
      from public.omr_student_start_credentials
     where organization_id = pg_catalog.current_setting('omr.release_proof_organization_id')
       and student_profile_id = 'release-proof-student-a';
    select account_id into strict v_old_b
      from public.omr_student_start_credentials
     where organization_id = pg_catalog.current_setting('omr.release_proof_organization_id')
       and student_profile_id = 'release-proof-student-b';
    v_result := public.omr_issue_student_start_code_batch_v1(
        'account', pg_catalog.current_setting('omr.release_proof_account_id'), 1,
        pg_catalog.current_setting('omr.release_proof_organization_id'),
        pg_catalog.current_setting('omr.release_proof_account_id'),
        pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object('studentId', 'release-proof-student-a',
                'verifier', 'pbkdf2-sha256:120000:' || repeat('3', 32) || ':' || repeat('c', 64)),
            pg_catalog.jsonb_build_object('studentId', 'release-proof-student-b',
                'verifier', 'pbkdf2-sha256:120000:' || repeat('4', 32) || ':' || repeat('d', 64))
        ),
        'batch_' || repeat('C', 32)
    );
    if v_result ->> 'status' is distinct from 'issued' then
        raise exception 'credential rotation batch did not commit';
    end if;
    for v_new in
        select student_profile_id, account_id, credential_generation
          from public.omr_student_start_credentials
         where organization_id = pg_catalog.current_setting('omr.release_proof_organization_id')
         order by student_profile_id collate "C"
    loop
        v_rotated_count := v_rotated_count + 1;
        if v_new.credential_generation is distinct from 2
           or public.omr_validate_student_session_v1(
               v_new.account_id, pg_catalog.current_setting('omr.release_proof_organization_id'),
               v_new.student_profile_id, 2
           ) is not true then
            raise exception 'rotated credential generation is not authoritative';
        end if;
    end loop;
    if v_rotated_count is distinct from 2
       or public.omr_validate_student_session_v1(
           v_old_a, pg_catalog.current_setting('omr.release_proof_organization_id'),
           'release-proof-student-a', 1) is true
       or public.omr_validate_student_session_v1(
           v_old_b, pg_catalog.current_setting('omr.release_proof_organization_id'),
           'release-proof-student-b', 1) is true then
        raise exception 'credential rotation revived an old account incarnation';
    end if;
end
$release_proof_credential_rotation$;
reset role;
\echo OMR_INITIAL_OPS_RELEASE_PROOF_V1 {"schemaVersion":1,"ordinal":5,"proofId":"provisioning_entitlement_credential_rotation"}

-- release-proof-assertion:provisioning_entitlement_session_revocation
insert into public.omr_teacher_accounts (
    id, email, display_name, password_hash, status, email_verified_at, session_generation
) values (
    'teacher_eeeeeeeeeeeeeeee', 'release-proof-revocation@example.test',
    'Release Revocation Teacher',
    'pbkdf2-sha256:120000:' || repeat('5', 32) || ':' || repeat('5', 64),
    'active', pg_catalog.clock_timestamp(), 1
);
set local role service_role;
do $release_proof_session_revocation_before$
begin
    if public.omr_validate_teacher_session_v1('teacher_eeeeeeeeeeeeeeee', 1) is not true then
        raise exception 'revocation fixture did not begin with an active session';
    end if;
end
$release_proof_session_revocation_before$;
reset role;
update public.omr_teacher_accounts set status = 'disabled'
 where id = 'teacher_eeeeeeeeeeeeeeee';
set local role service_role;
do $release_proof_session_revocation_after$
begin
    if public.omr_validate_teacher_session_v1('teacher_eeeeeeeeeeeeeeee', 1) is true then
        raise exception 'disabled account retained a previously issued session';
    end if;
end
$release_proof_session_revocation_after$;
reset role;
\echo OMR_INITIAL_OPS_RELEASE_PROOF_V1 {"schemaVersion":1,"ordinal":6,"proofId":"provisioning_entitlement_session_revocation"}

-- release-proof-assertion:provisioning_entitlement_invite_lifecycle
insert into public.omr_exams (
    id, organization_id, class_id, title, payload, created_by_user_id, created_at, updated_at
) values (
    'release-proof-exam', pg_catalog.current_setting('omr.release_proof_organization_id'),
    'release-proof-class', 'Release Proof Exam',
    '{"id":"release-proof-exam","title":"Release Proof Exam","questions":[],"accessConfig":{"type":"group","groupIds":["release-proof-class"]}}'::jsonb,
    pg_catalog.current_setting('omr.release_proof_account_id'),
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp()
);
set local role service_role;
do $release_proof_invite_lifecycle$
declare
    v_issued jsonb;
    v_rotated jsonb;
    v_resolved jsonb;
    v_revoked jsonb;
begin
    v_issued := public.omr_rotate_exam_entry_invite_v1(
        pg_catalog.current_setting('omr.release_proof_organization_id'),
        'release-proof-exam', pg_catalog.current_setting('omr.release_proof_account_id'),
        repeat('8', 64), pg_catalog.clock_timestamp() + interval '1 day'
    );
    v_resolved := public.omr_resolve_exam_entry_invite_v1(repeat('8', 64), 'release-proof-exam');
    if public.omr_resolve_exam_entry_invite_v1(repeat('9', 64), 'release-proof-exam')
          ->> 'status' is distinct from 'invalid'
       or public.omr_resolve_exam_entry_invite_v1(repeat('8', 64), 'release-proof-other-exam')
          ->> 'status' is distinct from 'invalid' then
        raise exception 'wrong token or wrong exam resolved an invite';
    end if;
    v_rotated := public.omr_rotate_exam_entry_invite_v1(
        pg_catalog.current_setting('omr.release_proof_organization_id'),
        'release-proof-exam', pg_catalog.current_setting('omr.release_proof_account_id'),
        repeat('7', 64), pg_catalog.clock_timestamp() + interval '1 day'
    );
    if v_rotated #>> '{metadata,generation}' is distinct from '2'
       or public.omr_resolve_exam_entry_invite_v1(repeat('8', 64), 'release-proof-exam')
          ->> 'status' is distinct from 'invalid'
       or public.omr_resolve_exam_entry_invite_v1(repeat('7', 64), 'release-proof-exam')
          ->> 'status' is distinct from 'resolved' then
        raise exception 'rotation did not make the old token bearer invalid';
    end if;
    v_revoked := public.omr_revoke_exam_entry_invite_v1(
        pg_catalog.current_setting('omr.release_proof_organization_id'),
        'release-proof-exam', pg_catalog.current_setting('omr.release_proof_account_id')
    );
    if v_issued ->> 'status' is distinct from 'issued'
       or v_issued #>> '{metadata,generation}' is distinct from '1'
       or v_issued ? 'token' or v_issued ? 'tokenHash'
       or v_resolved ->> 'status' is distinct from 'resolved'
       or v_resolved -> 'groupIds' is distinct from '["release-proof-class"]'::jsonb
       or v_revoked ->> 'status' is distinct from 'revoked'
       or public.omr_resolve_exam_entry_invite_v1(repeat('7', 64), 'release-proof-exam')
          ->> 'status' is distinct from 'invalid' then
        raise exception 'exam invite issue, resolution, redaction, or revocation drifted';
    end if;
end
$release_proof_invite_lifecycle$;
reset role;
\echo OMR_INITIAL_OPS_RELEASE_PROOF_V1 {"schemaVersion":1,"ordinal":7,"proofId":"provisioning_entitlement_invite_lifecycle"}

-- release-proof-assertion:provisioning_entitlement_assignment_binding
set local role service_role;
do $release_proof_assignment_binding$
declare
    v_saved jsonb;
    v_listed jsonb;
    v_resolved jsonb;
    v_denied jsonb;
    v_opened jsonb;
    v_exam_updated_at timestamptz;
    v_wrong_revision_rejected boolean := false;
    v_stale_rejected boolean := false;
begin
    v_saved := public.omr_assign_students_v2(
        'account', pg_catalog.current_setting('omr.release_proof_account_id'), 1,
        pg_catalog.current_setting('omr.release_proof_organization_id'),
        pg_catalog.current_setting('omr.release_proof_account_id'), 'owner',
        'release-proof-exam', array['release-proof-student-a'],
        'base', 0, 'release-proof-assignment-mutation'
    );
    v_resolved := public.omr_resolve_student_assignment_v2(
        pg_catalog.current_setting('omr.release_proof_organization_id'),
        'release-proof-student-a', 'temporary',
        'release-proof-class', 'Release Proof Class',
        v_saved ->> 'assignmentId', (v_saved ->> 'revision')::bigint,
        'release-proof-exam'
    );
    v_listed := public.omr_list_student_assignments_v2(
        pg_catalog.current_setting('omr.release_proof_organization_id'),
        'release-proof-student-a', 'temporary',
        'release-proof-class', 'Release Proof Class'
    );
    v_denied := public.omr_resolve_student_assignment_v2(
        pg_catalog.current_setting('omr.release_proof_organization_id'),
        'release-proof-student-b', 'temporary',
        'release-proof-class', 'Release Proof Class',
        v_saved ->> 'assignmentId', (v_saved ->> 'revision')::bigint,
        'release-proof-exam'
    );
    begin
        perform public.omr_resolve_student_assignment_v2(
            pg_catalog.current_setting('omr.release_proof_organization_id'),
            'release-proof-student-a', 'temporary',
            'release-proof-class', 'Release Proof Class',
            v_saved ->> 'assignmentId', (v_saved ->> 'revision')::bigint + 1,
            'release-proof-exam'
        );
    exception when others then
        if sqlerrm is distinct from 'assignment generation stale' then raise; end if;
        v_wrong_revision_rejected := true;
    end;
    select updated_at into strict v_exam_updated_at
      from public.omr_exams where id = 'release-proof-exam';
    begin
        perform public.omr_open_attempt_session_v3(
            'release-proof-stale-session',
            pg_catalog.current_setting('omr.release_proof_organization_id'),
            'release-proof-exam', v_saved ->> 'assignmentId',
            (v_saved ->> 'revision')::bigint + 1,
            'release-proof-student-a', 'Release Student A', 'temporary',
            'release-proof-stale-submission', 'release-proof-stale-attempt',
            null, null, '{}'::integer[], array[1], v_exam_updated_at,
            '{}'::jsonb, 600, null, repeat('a', 64), null, 45
        );
    exception when others then
        if sqlerrm is distinct from 'assignment generation stale' then raise; end if;
        v_stale_rejected := true;
    end;
    v_opened := public.omr_open_attempt_session_v3(
        'release-proof-session',
        pg_catalog.current_setting('omr.release_proof_organization_id'),
        'release-proof-exam', v_saved ->> 'assignmentId',
        (v_saved ->> 'revision')::bigint,
        'release-proof-student-a', 'Release Student A', 'temporary',
        'release-proof-submission', 'release-proof-attempt',
        null, null, '{}'::integer[], array[1], v_exam_updated_at,
        '{}'::jsonb, 600, null, repeat('b', 64), null, 45
    );
    if v_saved ->> 'status' is distinct from 'saved'
       or v_saved ->> 'revision' is distinct from '1'
       or v_saved ->> 'targetCount' is distinct from '1'
       or v_resolved ->> 'status' is distinct from 'authorized'
       or v_resolved ->> 'assignmentRevision' is distinct from '1'
       or v_resolved ->> 'examId' is distinct from 'release-proof-exam'
       or v_denied ->> 'status' is distinct from 'denied'
       or not v_wrong_revision_rejected
       or not v_stale_rejected
       or not exists (
           select 1 from pg_catalog.jsonb_array_elements(v_listed -> 'assignments') listed
            where listed ->> 'assignment_id' is not distinct from v_saved ->> 'assignmentId'
              and listed ->> 'assignment_revision' is not distinct from v_saved ->> 'revision'
       )
       or v_opened ->> 'status' is distinct from 'in_progress'
       or v_opened ->> 'assignment_id' is distinct from v_saved ->> 'assignmentId'
       or v_opened ->> 'assignment_revision' is distinct from v_saved ->> 'revision' then
        raise exception 'assignment list/resolve/open v3 wrong-revision or non-target state mismatch: %',
            pg_catalog.jsonb_build_object(
                'savedStatus', v_saved ->> 'status',
                'savedRevision', v_saved ->> 'revision',
                'savedTargetCount', v_saved ->> 'targetCount',
                'resolvedStatus', v_resolved ->> 'status',
                'resolvedRevision', v_resolved ->> 'assignmentRevision',
                'deniedStatus', v_denied ->> 'status',
                'wrongRevisionRejected', v_wrong_revision_rejected,
                'staleOpenRejected', v_stale_rejected,
                'listedExact', exists (
                    select 1 from pg_catalog.jsonb_array_elements(v_listed -> 'assignments') listed
                     where listed ->> 'assignment_id' is not distinct from v_saved ->> 'assignmentId'
                       and listed ->> 'assignment_revision' is not distinct from v_saved ->> 'revision'
                ),
                'openStatus', v_opened ->> 'status',
                'openAssignmentId', v_opened ->> 'assignment_id',
                'openAssignmentRevision', v_opened ->> 'assignment_revision'
            );
    end if;
    perform pg_catalog.set_config('omr.release_proof_assignment_id', v_saved ->> 'assignmentId', false);
    perform pg_catalog.set_config('omr.release_proof_assignment_revision', v_saved ->> 'revision', false);
    perform pg_catalog.set_config('omr.release_proof_session_revision', v_opened ->> 'revision', false);
    perform pg_catalog.set_config('omr.release_proof_session_lease_epoch', v_opened ->> 'lease_epoch', false);
end
$release_proof_assignment_binding$;
reset role;
\echo OMR_INITIAL_OPS_RELEASE_PROOF_V1 {"schemaVersion":1,"ordinal":8,"proofId":"provisioning_entitlement_assignment_binding"}

-- release-proof-assertion:provisioning_entitlement_account_recovery
set local role service_role;
do $release_proof_account_recovery$
declare
    v_expiry timestamptz := pg_catalog.clock_timestamp() + interval '8 days';
    v_replacement jsonb;
    v_replayed jsonb;
    v_account_id text := pg_catalog.current_setting('omr.release_proof_account_id');
    v_organization_id text := pg_catalog.current_setting('omr.release_proof_organization_id');
begin
    v_replacement := public.omr_provision_pilot_teacher_v1(
        'Release Proof School', 'release-proof-teacher@example.test', 'Release Proof Teacher',
        'pbkdf2-sha256:120000:' || repeat('6', 32) || ':' || repeat('7', 64),
        'pro', v_expiry, 'operator:release-proof-recovery', 'account_recovery',
        'prov_' || repeat('C', 32)
    );
    v_replayed := public.omr_provision_pilot_teacher_v1(
        'Release Proof School', 'release-proof-teacher@example.test', 'Release Proof Teacher',
        'pbkdf2-sha256:120000:' || repeat('6', 32) || ':' || repeat('7', 64),
        'pro', v_expiry, 'operator:release-proof-recovery', 'account_recovery',
        'prov_' || repeat('C', 32)
    );
    if v_replacement ->> 'replayed' is distinct from 'false'
       or v_replayed ->> 'replayed' is distinct from 'true'
       or v_replacement ->> 'accountId' is distinct from v_account_id
       or v_replacement ->> 'organizationId' is distinct from v_organization_id
       or public.omr_validate_provisioned_teacher_session_v1(v_account_id, 1, v_organization_id) is not null
       or public.omr_validate_provisioned_teacher_session_v1(v_account_id, 2, v_organization_id) is null then
        raise exception 'provisioned account recovery did not replace credentials, revoke generation, and replay';
    end if;
end
$release_proof_account_recovery$;
reset role;
do $release_proof_account_recovery_server_state$
declare
    v_account_id text := pg_catalog.current_setting('omr.release_proof_account_id');
    v_organization_id text := pg_catalog.current_setting('omr.release_proof_organization_id');
    v_session_generation bigint;
begin
    select account.session_generation into strict v_session_generation
      from public.omr_teacher_accounts account
     where account.id = v_account_id;
    if v_session_generation is distinct from 2
       or (select pg_catalog.count(*) from public.omr_pilot_plan_grants
         where account_id = v_account_id and state = 'active' and superseded_at is null) is distinct from 1
       or (select pg_catalog.count(*) from public.omr_pilot_plan_grants
            where account_id = v_account_id and state = 'superseded' and superseded_at is not null) is distinct from 1
       or not exists (
           select 1 from public.omr_audit_logs
            where organization_id = v_organization_id
              and actor_user_id = 'operator:release-proof-recovery'
              and action = 'operator.pilot_teacher_provisioned'
       ) then
        raise exception 'provisioned account recovery did not supersede its old grant and append its audit';
    end if;
end
$release_proof_account_recovery_server_state$;
create function pg_temp.release_proof_reject_recovery_audit()
returns trigger language plpgsql as $release_proof_recovery_trigger$
begin
    if new.action = 'operator.pilot_teacher_provisioned'
       and new.actor_user_id = 'operator:release-proof-recovery-forced-audit' then
        raise exception 'release_proof_recovery_forced_audit_failure';
    end if;
    return new;
end
$release_proof_recovery_trigger$;
create trigger omr_release_proof_reject_recovery_audit
before insert on public.omr_audit_logs
for each row execute function pg_temp.release_proof_reject_recovery_audit();
create temporary table release_proof_recovery_snapshot (state jsonb not null) on commit drop;
insert into release_proof_recovery_snapshot (state)
select pg_catalog.jsonb_build_object(
        'account', (select pg_catalog.to_jsonb(account) from public.omr_teacher_accounts account
                     where id = pg_catalog.current_setting('omr.release_proof_account_id')),
        'grants', (select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(grant_row) order by id)
                    from public.omr_pilot_plan_grants grant_row
                   where account_id = pg_catalog.current_setting('omr.release_proof_account_id')),
        'audits', (select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(audit) order by id)
                    from public.omr_audit_logs audit
                   where organization_id = pg_catalog.current_setting('omr.release_proof_organization_id'))
) ;
set local role service_role;
do $release_proof_account_recovery_forced_audit$
begin
    begin
        perform public.omr_provision_pilot_teacher_v1(
            'Release Proof School', 'release-proof-teacher@example.test', 'Release Proof Teacher',
            'pbkdf2-sha256:120000:' || repeat('8', 32) || ':' || repeat('9', 64),
            'academy', pg_catalog.clock_timestamp() + interval '9 days',
            'operator:release-proof-recovery-forced-audit', 'recovery_forced_audit_rollback',
            'prov_' || repeat('E', 32)
        );
        raise exception 'release_proof_recovery_forced_audit_unexpected_success';
    exception when others then
        if sqlerrm = 'release_proof_recovery_forced_audit_unexpected_success' then raise; end if;
        if sqlerrm is distinct from 'release_proof_recovery_forced_audit_failure' then raise; end if;
    end;
end
$release_proof_account_recovery_forced_audit$;
reset role;
do $release_proof_account_recovery_audit_rollback$
declare
    v_after jsonb;
begin
    select pg_catalog.jsonb_build_object(
        'account', (select pg_catalog.to_jsonb(account) from public.omr_teacher_accounts account
                     where id = pg_catalog.current_setting('omr.release_proof_account_id')),
        'grants', (select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(grant_row) order by id)
                    from public.omr_pilot_plan_grants grant_row
                   where account_id = pg_catalog.current_setting('omr.release_proof_account_id')),
        'audits', (select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(audit) order by id)
                    from public.omr_audit_logs audit
                   where organization_id = pg_catalog.current_setting('omr.release_proof_organization_id'))
    ) into v_after;
    if v_after is distinct from (select state from release_proof_recovery_snapshot) then
        raise exception 'forced audit failure changed recovery password hash, session_generation, grants, or audit graph';
    end if;
end
$release_proof_account_recovery_audit_rollback$;
drop trigger omr_release_proof_reject_recovery_audit on public.omr_audit_logs;
\echo OMR_INITIAL_OPS_RELEASE_PROOF_V1 {"schemaVersion":1,"ordinal":9,"proofId":"provisioning_entitlement_account_recovery"}

-- release-proof-assertion:data_integrity_isolation_tenant_isolation
insert into public.omr_organizations (id, name, plan, metadata)
values ('release-proof-other-org', 'Release Other Tenant', 'free', '{}'::jsonb);
insert into public.omr_classes (id, organization_id, name, status, metadata)
values ('release-proof-other-class', 'release-proof-other-org', 'Other Class', 'active', '{}'::jsonb);
insert into public.omr_exams (
    id, organization_id, class_id, title, payload, created_at, updated_at
) values (
    'release-proof-other-exam', 'release-proof-other-org', 'release-proof-other-class',
    'Other Exam',
    '{"id":"release-proof-other-exam","accessConfig":{"type":"group","groupIds":["release-proof-other-class"]}}'::jsonb,
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp()
);
set local role service_role;
do $release_proof_tenant_isolation$
declare
    v_result jsonb;
begin
    v_result := public.omr_rotate_exam_entry_invite_v1(
        'release-proof-other-org', 'release-proof-other-exam',
        pg_catalog.current_setting('omr.release_proof_account_id'),
        repeat('a', 64), pg_catalog.clock_timestamp() + interval '1 day'
    );
    if v_result ->> 'status' is distinct from 'unauthorized' then
        raise exception 'cross-tenant invite mutation was not denied';
    end if;
end
$release_proof_tenant_isolation$;
reset role;
do $release_proof_tenant_isolation_server_state$
begin
    if exists (
           select 1 from public.omr_exam_entry_invites
            where organization_id = 'release-proof-other-org'
              and exam_id = 'release-proof-other-exam'
       ) or exists (
           select 1
             from pg_catalog.pg_class relation
             join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
            where namespace.nspname = 'public'
              and relation.relname in ('omr_organizations', 'omr_exams', 'omr_assignments')
              and (not relation.relrowsecurity or not relation.relforcerowsecurity)
       ) then
        raise exception 'cross-tenant mutation or canonical FORCE RLS boundary failed';
    end if;
end
$release_proof_tenant_isolation_server_state$;
\echo OMR_INITIAL_OPS_RELEASE_PROOF_V1 {"schemaVersion":1,"ordinal":10,"proofId":"data_integrity_isolation_tenant_isolation"}

-- release-proof-assertion:data_integrity_isolation_canonical_acl
set local role authenticated;
do $release_proof_canonical_acl$
begin
    begin
        perform 1 from public.omr_exams limit 1;
        raise exception 'authenticated role read a canonical table';
    exception when insufficient_privilege then null;
    end;
    begin
        perform public.omr_assign_students_v2(
            'account', 'forbidden', 1, 'forbidden', 'forbidden', 'owner',
            'forbidden', array['forbidden'], 'base', 0, 'forbidden'
        );
        raise exception 'authenticated role executed a server mutation RPC';
    exception when insufficient_privilege then null;
    end;
end
$release_proof_canonical_acl$;
reset role;
\echo OMR_INITIAL_OPS_RELEASE_PROOF_V1 {"schemaVersion":1,"ordinal":11,"proofId":"data_integrity_isolation_canonical_acl"}

-- release-proof-assertion:data_integrity_isolation_submission_replay
set local role service_role;
do $release_proof_submission_replay$
declare
    v_organization_id text := pg_catalog.current_setting('omr.release_proof_organization_id');
    v_assignment_id text := pg_catalog.current_setting('omr.release_proof_assignment_id');
    v_assignment_revision bigint := pg_catalog.current_setting('omr.release_proof_assignment_revision')::bigint;
    v_session_revision bigint := pg_catalog.current_setting('omr.release_proof_session_revision')::bigint;
    v_lease_epoch bigint := pg_catalog.current_setting('omr.release_proof_session_lease_epoch')::bigint;
    v_finished_at timestamptz := pg_catalog.clock_timestamp();
    v_attempt jsonb;
    v_results jsonb;
    v_question_payload jsonb;
    v_first jsonb;
    v_replay jsonb;
    v_submitted_attempt_id text;
begin
    -- The exact assignment-aware session was opened above through
    -- public.omr_open_attempt_session_v3 before either v2 commit/replay.
    v_question_payload := pg_catalog.jsonb_build_object(
        'schemaVersion', 1, 'attemptId', 'release-proof-attempt',
        'examId', 'release-proof-exam', 'examTitle', 'Release Proof Exam',
        'organizationId', v_organization_id, 'classId', 'release-proof-class',
        'assignmentId', v_assignment_id, 'assignmentRevision', v_assignment_revision,
        'studentProfileId', 'release-proof-student-a',
        'studentName', 'Release Student A', 'studentId', 'release-proof-student-a',
        'groupId', 'release-proof-class', 'groupName', 'Release Proof Class',
        'identityType', 'temporary', 'questionId', 1, 'questionNumber', 1,
        'canonicalQuestionId', 'release-proof-exam:1', 'label', 'Q1',
        'score', 1, 'earnedScore', 1, 'selectedAnswer', 1, 'correctAnswer', 1,
        'status', 'correct', 'isCorrect', true, 'isWrong', false,
        'isUnanswered', false, 'finishedAt', v_finished_at
    );
    v_attempt := pg_catalog.jsonb_build_object(
        'id', 'release-proof-attempt', 'organization_id', v_organization_id,
        'class_id', 'release-proof-class', 'assignment_id', v_assignment_id,
        'assignment_revision', v_assignment_revision,
        'student_profile_id', 'release-proof-student-a', 'exam_id', 'release-proof-exam',
        'student_name', 'Release Student A', 'student_id', 'release-proof-student-a',
        'group_id', 'release-proof-class', 'group_name', 'Release Proof Class',
        'identity_type', 'temporary', 'status', 'completed',
        'score', 1, 'total_score', 1, 'score_percent', 100,
        'retake_question_ids', pg_catalog.to_jsonb('{}'::integer[]),
        'payload', pg_catalog.jsonb_build_object(
            'id', 'release-proof-attempt', 'examId', 'release-proof-exam',
            'examTitle', 'Release Proof Exam', 'organizationId', v_organization_id,
            'classId', 'release-proof-class', 'assignmentId', v_assignment_id,
            'assignmentRevision', v_assignment_revision,
            'studentProfileId', 'release-proof-student-a',
            'studentName', 'Release Student A', 'studentId', 'release-proof-student-a',
            'groupId', 'release-proof-class', 'groupName', 'Release Proof Class',
            'identityType', 'temporary', 'status', 'completed',
            'score', 1, 'totalScore', 1,
            'startedAt', v_finished_at - interval '1 minute', 'finishedAt', v_finished_at,
            'answers', '{}'::jsonb,
            'questionResults', pg_catalog.jsonb_build_array(v_question_payload)
        ),
        'started_at', v_finished_at - interval '1 minute', 'finished_at', v_finished_at
    );
    v_results := pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'id', 'release-proof-attempt:1', 'organization_id', v_organization_id,
        'class_id', 'release-proof-class', 'assignment_id', v_assignment_id,
        'assignment_revision', v_assignment_revision,
        'student_profile_id', 'release-proof-student-a',
        'attempt_id', 'release-proof-attempt', 'exam_id', 'release-proof-exam',
        'student_name', 'Release Student A', 'student_id', 'release-proof-student-a',
        'group_id', 'release-proof-class', 'group_name', 'Release Proof Class',
        'identity_type', 'temporary', 'question_id', 1, 'question_number', 1,
        'canonical_question_id', 'release-proof-exam:1', 'label', 'Q1',
        'mistake_types', pg_catalog.to_jsonb('{}'::text[]),
        'prerequisites', pg_catalog.to_jsonb('{}'::text[]),
        'selected_answer', 1, 'correct_answer', 1,
        'status', 'correct', 'is_correct', true, 'is_wrong', false,
        'is_unanswered', false, 'score', 1, 'earned_score', 1,
        'finished_at', v_finished_at,
        'created_at', v_finished_at, 'updated_at', v_finished_at,
        'payload', v_question_payload
    ));
    v_first := public.omr_commit_attempt_session_submit_v2(
        'release-proof-session', v_organization_id, 'release-proof-exam',
        'release-proof-student-a', v_assignment_id, v_assignment_revision,
        v_session_revision, v_lease_epoch, repeat('b', 64), v_attempt, v_results
    );
    v_replay := public.omr_commit_attempt_session_submit_v2(
        'release-proof-session', v_organization_id, 'release-proof-exam',
        'release-proof-student-a', v_assignment_id, v_assignment_revision,
        v_session_revision, v_lease_epoch, repeat('b', 64), v_attempt, v_results
    );
    select submitted_attempt_id into strict v_submitted_attempt_id
      from public.omr_attempt_sessions
     where id = 'release-proof-session';
    if v_first ->> 'result_status' is distinct from 'submitted'
       or v_replay ->> 'result_status' is distinct from 'submitted'
       or v_first -> 'payload' is distinct from v_replay -> 'payload'
       or (select pg_catalog.count(*) from public.omr_attempts
         where id = 'release-proof-attempt') is distinct from 1
       or (select pg_catalog.count(*) from public.omr_question_results
            where attempt_id = 'release-proof-attempt') is distinct from 1
       or v_submitted_attempt_id is distinct from 'release-proof-attempt' then
        raise exception 'exact submission replay duplicated or lost canonical rows';
    end if;
    perform pg_catalog.set_config(
        'omr.release_proof_attempt_payload', (v_first -> 'payload')::text, true
    );
end
$release_proof_submission_replay$;
reset role;
\echo OMR_INITIAL_OPS_RELEASE_PROOF_V1 {"schemaVersion":1,"ordinal":12,"proofId":"data_integrity_isolation_submission_replay"}

-- End the fixture transaction before the real concurrent quota calls. In
-- particular, no earlier release-proof write may retain a table lock that
-- serializes or times out the two independently committed dblink sessions.
commit;

begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

-- release-proof-assertion:data_integrity_isolation_quota_atomicity
do $release_proof_quota_atomicity$
declare
    v_left jsonb;
    v_right jsonb;
    v_sent integer;
    v_used integer;
    v_period date := pg_catalog.date_trunc(
        'month', pg_catalog.clock_timestamp() at time zone 'Asia/Seoul'
    )::date;
    v_query text;
begin
    -- Seed a committed pro tenant at 4,999 so two actual service_role RPC
    -- transactions race for the single remaining slot.
    perform extensions.dblink_connect(
        'release-proof-quota-seed',
        'host=127.0.0.1 port=' || current_setting('port') || ' dbname=' || current_database()
            || ' user=postgres password=omr-live-test-password connect_timeout=5'
    );
    perform extensions.dblink_exec('release-proof-quota-seed', $remote$set statement_timeout = '20s'$remote$);
    perform extensions.dblink_exec('release-proof-quota-seed', $remote$set lock_timeout = '2s'$remote$);
    perform extensions.dblink_exec(
        'release-proof-quota-seed',
        pg_catalog.format(
            'update public.omr_organizations set plan=%L where id=%L;'
            || 'insert into public.omr_plan_usage(organization_id,metric,period_start,used,updated_at) '
            || 'values(%L,%L,%L,4999,clock_timestamp()) '
            || 'on conflict(organization_id,metric,period_start) do update set used=4999,updated_at=excluded.updated_at;'
            || 'delete from public.omr_plan_usage_reservations where organization_id=%L and metric=%L '
            || 'and resource_key in (%L,%L)',
            'pro', 'teacher_task6batch', 'teacher_task6batch', 'aiRecognition', v_period,
            'teacher_task6batch', 'aiRecognition',
            'ai:40000000-0000-4000-8000-000000000004',
            'ai:50000000-0000-4000-8000-000000000005'
        )
    );
    perform extensions.dblink_disconnect('release-proof-quota-seed');
    perform extensions.dblink_connect(
        'release-proof-quota-left',
        'host=127.0.0.1 port=' || current_setting('port') || ' dbname=' || current_database()
            || ' user=postgres password=omr-live-test-password connect_timeout=5'
    );
    perform extensions.dblink_connect(
        'release-proof-quota-right',
        'host=127.0.0.1 port=' || current_setting('port') || ' dbname=' || current_database()
            || ' user=postgres password=omr-live-test-password connect_timeout=5'
    );
    perform extensions.dblink_exec('release-proof-quota-left', $remote$set statement_timeout = '20s'$remote$);
    perform extensions.dblink_exec('release-proof-quota-left', $remote$set lock_timeout = '2s'$remote$);
    perform extensions.dblink_exec('release-proof-quota-right', $remote$set statement_timeout = '20s'$remote$);
    perform extensions.dblink_exec('release-proof-quota-right', $remote$set lock_timeout = '2s'$remote$);
    perform extensions.dblink_exec('release-proof-quota-left', 'set role service_role');
    perform extensions.dblink_exec('release-proof-quota-right', 'set role service_role');
    v_query := pg_catalog.format(
        'select public.omr_reserve_plan_usage_v2(%L,%L,7,%L,%L,%L,%L)::text',
        'legacy_account', 'teacher_6666666666666666', 'teacher_task6batch',
        'teacher_task6batch', 'aiRecognition',
        'ai:40000000-0000-4000-8000-000000000004'
    );
    v_sent := extensions.dblink_send_query('release-proof-quota-left', v_query);
    v_query := pg_catalog.format(
        'select public.omr_reserve_plan_usage_v2(%L,%L,7,%L,%L,%L,%L)::text',
        'legacy_account', 'teacher_6666666666666666', 'teacher_task6batch',
        'teacher_task6batch', 'aiRecognition',
        'ai:50000000-0000-4000-8000-000000000005'
    );
    v_sent := extensions.dblink_send_query('release-proof-quota-right', v_query);
    select result::jsonb into strict v_left
      from extensions.dblink_get_result('release-proof-quota-left') result(result text);
    select result::jsonb into strict v_right
      from extensions.dblink_get_result('release-proof-quota-right') result(result text);
    perform extensions.dblink_disconnect('release-proof-quota-left');
    perform extensions.dblink_disconnect('release-proof-quota-right');
    select used into strict v_used
      from public.omr_plan_usage
     where organization_id = 'teacher_task6batch'
       and metric = 'aiRecognition' and period_start = v_period;
    if (select pg_catalog.count(*) from pg_catalog.unnest(array[
            v_left ->> 'allowed', v_right ->> 'allowed'
        ]) allowed where allowed = 'true') is distinct from 1
       or (select pg_catalog.count(*) from pg_catalog.unnest(array[
            v_left ->> 'allowed', v_right ->> 'allowed'
        ]) allowed where allowed = 'false') is distinct from 1
       or v_used is distinct from 5000
       or (select pg_catalog.count(*) from public.omr_plan_usage_reservations
            where organization_id = 'teacher_task6batch'
              and metric = 'aiRecognition'
              and resource_key in (
                  'ai:40000000-0000-4000-8000-000000000004',
                  'ai:50000000-0000-4000-8000-000000000005'
              )) is distinct from 1 then
        raise exception 'concurrent near-limit quota race did not serialize to exactly one reservation';
    end if;
exception when others then
    if 'release-proof-quota-seed' = any(coalesce(extensions.dblink_get_connections(), '{}'::text[])) then
        perform extensions.dblink_disconnect('release-proof-quota-seed');
    end if;
    if 'release-proof-quota-left' = any(coalesce(extensions.dblink_get_connections(), '{}'::text[])) then
        perform extensions.dblink_cancel_query('release-proof-quota-left');
        perform extensions.dblink_disconnect('release-proof-quota-left');
    end if;
    if 'release-proof-quota-right' = any(coalesce(extensions.dblink_get_connections(), '{}'::text[])) then
        perform extensions.dblink_cancel_query('release-proof-quota-right');
        perform extensions.dblink_disconnect('release-proof-quota-right');
    end if;
    raise;
end
$release_proof_quota_atomicity$;
\echo OMR_INITIAL_OPS_RELEASE_PROOF_V1 {"schemaVersion":1,"ordinal":13,"proofId":"data_integrity_isolation_quota_atomicity"}

-- release-proof-assertion:data_integrity_isolation_receipt_replay
set local role service_role;
do $release_proof_receipt_replay$
declare
    v_organization_id text := pg_catalog.current_setting('omr.release_proof_organization_id');
    v_assignment_id text := pg_catalog.current_setting('omr.release_proof_assignment_id');
    v_assignment_revision bigint := pg_catalog.current_setting('omr.release_proof_assignment_revision')::bigint;
    v_before jsonb;
    v_after jsonb;
    v_attempt jsonb;
    v_results jsonb;
    v_response_loss jsonb;
    v_receipt jsonb;
begin
    -- This response-loss receipt belongs to the exact session established by
    -- public.omr_open_attempt_session_v3, never to the credential batch RPC.
    select pg_catalog.jsonb_build_object(
        'session', (select pg_catalog.to_jsonb(session) from public.omr_attempt_sessions session
                     where id = 'release-proof-session'),
        'attempt', (select pg_catalog.to_jsonb(attempt) from public.omr_attempts attempt
                     where id = 'release-proof-attempt'),
        'results', (select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(result) order by question_id)
                      from public.omr_question_results result
                     where attempt_id = 'release-proof-attempt')
    ) into v_before;
    select pg_catalog.to_jsonb(attempt) into strict v_attempt
      from public.omr_attempts attempt where id = 'release-proof-attempt';
    select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(result) order by question_id)
      into v_results
      from public.omr_question_results result where attempt_id = 'release-proof-attempt';
    -- Model response loss: both retries use the exact assignment-aware v2
    -- receipt path and must return the same canonical payload read-only.
    v_response_loss := public.omr_commit_attempt_session_submit_v2(
        'release-proof-session', v_organization_id, 'release-proof-exam',
        'release-proof-student-a', v_assignment_id, v_assignment_revision,
        pg_catalog.current_setting('omr.release_proof_session_revision')::bigint,
        pg_catalog.current_setting('omr.release_proof_session_lease_epoch')::bigint,
        repeat('b', 64), v_attempt, v_results
    );
    v_receipt := public.omr_commit_attempt_session_submit_v2(
        'release-proof-session', v_organization_id, 'release-proof-exam',
        'release-proof-student-a', v_assignment_id, v_assignment_revision,
        pg_catalog.current_setting('omr.release_proof_session_revision')::bigint,
        pg_catalog.current_setting('omr.release_proof_session_lease_epoch')::bigint,
        repeat('b', 64), v_attempt, v_results
    );
    select pg_catalog.jsonb_build_object(
        'session', (select pg_catalog.to_jsonb(session) from public.omr_attempt_sessions session
                     where id = 'release-proof-session'),
        'attempt', (select pg_catalog.to_jsonb(attempt) from public.omr_attempts attempt
                     where id = 'release-proof-attempt'),
        'results', (select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(result) order by question_id)
                      from public.omr_question_results result
                     where attempt_id = 'release-proof-attempt')
    ) into v_after;
    if v_response_loss ->> 'result_status' is distinct from 'submitted'
       or v_receipt ->> 'result_status' is distinct from 'submitted'
       or v_response_loss -> 'payload' is distinct from v_receipt -> 'payload'
       or v_before is distinct from v_after then
        raise exception 'committed assignment-aware submission receipt replay mutated canonical state or payload';
    end if;
end
$release_proof_receipt_replay$;
reset role;
\echo OMR_INITIAL_OPS_RELEASE_PROOF_V1 {"schemaVersion":1,"ordinal":14,"proofId":"data_integrity_isolation_receipt_replay"}

-- release-proof-assertion:data_integrity_isolation_session_generation
set local role service_role;
do $release_proof_session_generation$
declare
    v_organization_id text := pg_catalog.current_setting('omr.release_proof_organization_id');
    v_assignment_id text := pg_catalog.current_setting('omr.release_proof_assignment_id');
    v_advanced jsonb;
    v_submitted_replay jsonb;
    v_current_open jsonb;
    v_checkpoint jsonb;
    v_exam_updated_at timestamptz;
    v_stale_open_rejected boolean := false;
    v_wrong_commit_rejected boolean := false;
begin
    v_advanced := public.omr_assign_students_v2(
        'account', pg_catalog.current_setting('omr.release_proof_account_id'), 2,
        v_organization_id, pg_catalog.current_setting('omr.release_proof_account_id'), 'owner',
        'release-proof-exam', array['release-proof-student-a'],
        'base', 1, 'release-proof-assignment-generation-2'
    );
    select updated_at into strict v_exam_updated_at
      from public.omr_exams where id = 'release-proof-exam';
    v_submitted_replay := public.omr_open_attempt_session_v3(
        'release-proof-session', v_organization_id, 'release-proof-exam',
        v_assignment_id, 1, 'release-proof-student-a', 'Release Student A', 'temporary',
        'release-proof-submission', 'release-proof-attempt', null, null,
        '{}'::integer[], array[1], v_exam_updated_at, '{}'::jsonb, 600, null,
        repeat('c', 64), repeat('b', 64), 45
    );
    begin
        perform public.omr_open_attempt_session_v3(
            'release-proof-stale-after-advance', v_organization_id, 'release-proof-exam',
            v_assignment_id, 1, 'release-proof-student-a', 'Release Student A', 'temporary',
            'release-proof-stale-after-advance-submission', 'release-proof-stale-after-advance-attempt',
            null, null, '{}'::integer[], array[1], v_exam_updated_at,
            '{}'::jsonb, 600, null, repeat('d', 64), null, 45
        );
    exception when others then
        if sqlerrm is distinct from 'assignment generation stale' then raise; end if;
        v_stale_open_rejected := true;
    end;
    begin
        perform public.omr_commit_attempt_session_submit_v2(
            'release-proof-session', v_organization_id, 'release-proof-exam',
            'release-proof-student-a', v_assignment_id, 2,
            1, 1, repeat('b', 64), '{}'::jsonb, '[]'::jsonb
        );
    exception when others then
        if sqlerrm is distinct from 'attempt session not owned' then raise; end if;
        v_wrong_commit_rejected := true;
    end;
    if v_advanced ->> 'status' is distinct from 'saved'
       or v_advanced ->> 'revision' is distinct from '2'
       or v_submitted_replay ->> 'status' is distinct from 'submitted'
       or v_submitted_replay ->> 'submitted_attempt_id' is distinct from 'release-proof-attempt'
       or v_submitted_replay ->> 'assignment_revision' is distinct from '1'
       or not v_stale_open_rejected or not v_wrong_commit_rejected then
        raise exception 'assignment_revision session generation did not preserve response replay and stale fencing';
    end if;
    v_current_open := public.omr_open_attempt_session_v3(
        'release-proof-current-session', v_organization_id, 'release-proof-exam',
        v_assignment_id, 2, 'release-proof-student-a', 'Release Student A', 'temporary',
        'release-proof-current-submission', 'release-proof-current-attempt', null, null,
        '{}'::integer[], array[1], v_exam_updated_at, '{}'::jsonb, 600, null,
        repeat('d', 64), null, 45
    );
    v_checkpoint := public.omr_checkpoint_attempt_session_v2(
        'release-proof-current-session', v_organization_id, 'release-proof-exam',
        'release-proof-student-a', v_assignment_id, 2,
        (v_current_open ->> 'revision')::bigint,
        (v_current_open ->> 'lease_epoch')::bigint,
        repeat('d', 64), '{"1":2}'::jsonb, '{}'::jsonb,
        '{"currentQuestionId":1}'::jsonb, 45, false
    );
    if v_checkpoint ->> 'assignment_revision' is distinct from '2'
       or v_checkpoint ->> 'revision' is not distinct from v_current_open ->> 'revision'
       or v_checkpoint ->> 'lease_epoch' is distinct from v_current_open ->> 'lease_epoch' then
        raise exception 'current checkpoint v2 did not advance revision under exact lease tuple';
    end if;
    perform pg_catalog.set_config(
        'omr.release_proof_current_session_revision', v_checkpoint ->> 'revision', true
    );
    perform pg_catalog.set_config(
        'omr.release_proof_current_session_lease_epoch', v_checkpoint ->> 'lease_epoch', true
    );
end
$release_proof_session_generation$;
reset role;
update public.omr_attempt_sessions
   set lease_expires_at = pg_catalog.clock_timestamp() - interval '1 second'
 where id = 'release-proof-current-session';
set local role service_role;
do $release_proof_session_takeover_fencing$
declare
    v_organization_id text := pg_catalog.current_setting('omr.release_proof_organization_id');
    v_assignment_id text := pg_catalog.current_setting('omr.release_proof_assignment_id');
    v_revision bigint := pg_catalog.current_setting('omr.release_proof_current_session_revision')::bigint;
    v_lease_epoch bigint := pg_catalog.current_setting('omr.release_proof_current_session_lease_epoch')::bigint;
    v_takeover jsonb;
    v_current jsonb;
    v_checkpoint_stale_rejected boolean := false;
    v_takeover_stale_rejected boolean := false;
begin
    v_takeover := public.omr_takeover_attempt_session_v2(
        'release-proof-current-session', v_organization_id, 'release-proof-exam',
        'release-proof-student-a', v_assignment_id, 2,
        v_revision, v_lease_epoch, repeat('e', 64), 45
    );
    begin
        perform public.omr_checkpoint_attempt_session_v2(
            'release-proof-current-session', v_organization_id, 'release-proof-exam',
            'release-proof-student-a', v_assignment_id, 2,
            v_revision, v_lease_epoch, repeat('d', 64),
            '{"1":3}'::jsonb, '{}'::jsonb, '{"currentQuestionId":1}'::jsonb, 45, false
        );
    exception when others then
        if sqlerrm not in ('attempt session revision conflict', 'attempt session lease conflict') then raise; end if;
        v_checkpoint_stale_rejected := true;
    end;
    begin
        perform public.omr_takeover_attempt_session_v2(
            'release-proof-current-session', v_organization_id, 'release-proof-exam',
            'release-proof-student-a', v_assignment_id, 2,
            v_revision, v_lease_epoch, repeat('f', 64), 45
        );
    exception when others then
        if sqlerrm is distinct from 'attempt session revision conflict' then raise; end if;
        v_takeover_stale_rejected := true;
    end;
    v_current := public.omr_checkpoint_attempt_session_v2(
        'release-proof-current-session', v_organization_id, 'release-proof-exam',
        'release-proof-student-a', v_assignment_id, 2,
        (v_takeover ->> 'revision')::bigint, (v_takeover ->> 'lease_epoch')::bigint,
        repeat('e', 64), '{"1":4}'::jsonb, '{}'::jsonb,
        '{"currentQuestionId":1}'::jsonb, 45, false
    );
    if (v_takeover ->> 'revision')::bigint is distinct from v_revision + 1
       or (v_takeover ->> 'lease_epoch')::bigint is distinct from v_lease_epoch + 1
       or v_current ->> 'assignment_revision' is distinct from '2'
       or not v_checkpoint_stale_rejected or not v_takeover_stale_rejected then
        raise exception 'checkpoint v2 and takeover v2 did not fence stale revision/lease_epoch/token tuples';
    end if;
end
$release_proof_session_takeover_fencing$;
reset role;
\echo OMR_INITIAL_OPS_RELEASE_PROOF_V1 {"schemaVersion":1,"ordinal":15,"proofId":"data_integrity_isolation_session_generation"}

-- release-proof-assertion:data_integrity_isolation_roster_cas
set local role service_role;
do $release_proof_roster_cas$
declare
    v_before jsonb;
    v_saved jsonb;
    v_loaded jsonb;
    v_actual_enrollments jsonb;
    v_expected_enrollments constant jsonb := '[["release-proof-class","release-proof-student-a","active"],["release-proof-class","release-proof-student-b","active"]]'::jsonb;
    v_conflicted boolean := false;
begin
    v_before := public.omr_load_roster_v2(
        pg_catalog.current_setting('omr.release_proof_organization_id')
    );
    v_saved := public.omr_save_roster_v3(
        'account', pg_catalog.current_setting('omr.release_proof_account_id'), 2,
        pg_catalog.current_setting('omr.release_proof_account_id'),
        pg_catalog.current_setting('omr.release_proof_organization_id'),
        v_before -> 'classes', v_before -> 'students',
        v_before -> 'enrollments', v_before -> 'invites', null
    );
    begin
        perform public.omr_save_roster_v3(
            'account', pg_catalog.current_setting('omr.release_proof_account_id'), 2,
            pg_catalog.current_setting('omr.release_proof_account_id'),
            pg_catalog.current_setting('omr.release_proof_organization_id'),
            '[{"id":"stale-release-class","name":"stale","status":"active","metadata":{}}]'::jsonb,
            '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, 0
        );
    exception when serialization_failure then
        v_conflicted := true;
    end;
    v_loaded := public.omr_load_roster_v2(
        pg_catalog.current_setting('omr.release_proof_organization_id')
    );
    select pg_catalog.jsonb_agg(
               pg_catalog.jsonb_build_array(
                   item ->> 'class_id',
                   item ->> 'student_profile_id',
                   item ->> 'enrollment_status'
               )
               order by item ->> 'class_id',
                        item ->> 'student_profile_id',
                        item ->> 'enrollment_status'
           )
      into strict v_actual_enrollments
      from pg_catalog.jsonb_array_elements(v_loaded -> 'enrollments') item;
    -- roster-snapshot-cas-assertions.sql already exercised the exact
    -- extensions.dblink writer/load lock. This v3-authenticated save binds its
    -- result to the same atomic load contract.
    if v_saved ->> 'revision' is distinct from '1' or not v_conflicted
       or v_loaded ->> 'revision' is distinct from '1'
       or pg_catalog.jsonb_array_length(v_loaded -> 'classes') is distinct from 1
       or not exists (
           select 1 from pg_catalog.jsonb_array_elements(v_loaded -> 'classes') item
            where item ->> 'id' is not distinct from 'release-proof-class'
       )
       or pg_catalog.jsonb_array_length(v_loaded -> 'students') is distinct from 2
       or (select pg_catalog.jsonb_agg(item ->> 'id' order by item ->> 'id')
             from pg_catalog.jsonb_array_elements(v_loaded -> 'students') item)
          is distinct from '["release-proof-student-a","release-proof-student-b"]'::jsonb
       or v_actual_enrollments is distinct from v_expected_enrollments
       or pg_catalog.jsonb_array_length(v_loaded -> 'invites') is distinct from 0 then
        raise exception 'roster compare-and-swap state mismatch: %',
            pg_catalog.jsonb_build_object(
                'savedStatus', v_saved ->> 'status',
                'savedRevision', v_saved ->> 'revision',
                'conflicted', v_conflicted,
                'loadedRevision', v_loaded ->> 'revision',
                'loadedClasses', pg_catalog.jsonb_array_length(v_loaded -> 'classes'),
                'loadedClassIds', (
                    select pg_catalog.jsonb_agg(item ->> 'id' order by item ->> 'id')
                      from pg_catalog.jsonb_array_elements(v_loaded -> 'classes') item
                ),
                'loadedStudents', pg_catalog.jsonb_array_length(v_loaded -> 'students'),
                'loadedStudentIds', (
                    select pg_catalog.jsonb_agg(item ->> 'id' order by item ->> 'id')
                      from pg_catalog.jsonb_array_elements(v_loaded -> 'students') item
                ),
                'loadedEnrollments', pg_catalog.jsonb_array_length(v_loaded -> 'enrollments'),
                'loadedEnrollmentKeys', (
                    select pg_catalog.jsonb_agg(
                               pg_catalog.jsonb_build_array(
                                   item ->> 'class_id', item ->> 'student_profile_id',
                                   item ->> 'enrollment_status'
                               ) order by item ->> 'student_profile_id'
                           )
                      from pg_catalog.jsonb_array_elements(v_loaded -> 'enrollments') item
                ),
                'loadedInvites', pg_catalog.jsonb_array_length(v_loaded -> 'invites')
            );
    end if;
end
$release_proof_roster_cas$;
reset role;
\echo OMR_INITIAL_OPS_RELEASE_PROOF_V1 {"schemaVersion":1,"ordinal":16,"proofId":"data_integrity_isolation_roster_cas"}

-- release-proof-assertion:data_integrity_isolation_question_atomicity
do $release_proof_question_atomicity$
declare
    v_delete_rejected boolean := false;
begin
    if public.omr_canonical_attempt_child_evidence_matches_v1('release-proof-attempt') is not true then
        raise exception 'assignment-aware submission did not preserve the canonical parent/child seal';
    end if;
    begin
        set constraints omr_internal.omr_canonical_evidence_dirty_attempt_finalize_v1 deferred;
        delete from public.omr_question_results
         where attempt_id = 'release-proof-attempt' and question_id = 1;
        set constraints omr_internal.omr_canonical_evidence_dirty_attempt_finalize_v1 immediate;
        raise exception 'canonical delete-child mismatch unexpectedly committed';
    exception when others then
        if sqlerrm is distinct from 'canonical attempt child evidence mismatch' then raise; end if;
        v_delete_rejected := true;
    end;
    if not v_delete_rejected
       or (select pg_catalog.count(*) from public.omr_question_results
            where attempt_id = 'release-proof-attempt') is distinct from 1
       or public.omr_canonical_attempt_child_evidence_matches_v1('release-proof-attempt') is not true
       or coalesce((
           select calls from pg_catalog.pg_stat_user_functions
            where schemaname = 'public'
              and funcname = 'omr_force_finish_attempt_sessions_compact_v2'
       ), 0) < 1 then
        raise exception 'canonical delete-child rollback or compact writer seal witness was absent';
    end if;
end
$release_proof_question_atomicity$;
\echo OMR_INITIAL_OPS_RELEASE_PROOF_V1 {"schemaVersion":1,"ordinal":17,"proofId":"data_integrity_isolation_question_atomicity"}

-- release-proof-assertion:data_integrity_isolation_storage_isolation
set local role service_role;
do $release_proof_storage_service_crud$
declare
    v_name text;
    v_bucket_id text;
    v_bucket_name text;
    v_deleted_bucket_id text;
begin
    insert into storage.objects (bucket_id, name)
    values ('omr-private-assets', 'release-proof-service-object')
    returning name into strict v_name;
    select name into strict v_name from storage.objects
     where bucket_id = 'omr-private-assets' and name = 'release-proof-service-object';
    update storage.objects set name = 'release-proof-service-object-updated'
     where bucket_id = 'omr-private-assets' and name = 'release-proof-service-object'
    returning name into strict v_name;
    delete from storage.objects
     where bucket_id = 'omr-private-assets' and name = 'release-proof-service-object-updated'
    returning name into strict v_name;
    insert into storage.buckets (id, name, public)
    values ('release-proof-service-bucket', 'release-proof-service-bucket', false);
    insert into storage.objects (bucket_id, name)
    values ('release-proof-service-bucket', 'release-proof-service-bucket-object');
    update storage.buckets set name = 'release-proof-service-bucket-updated'
     where id = 'release-proof-service-bucket'
    returning id, name into strict v_bucket_id, v_bucket_name;
    delete from storage.objects where bucket_id = 'release-proof-service-bucket';
    delete from storage.buckets where id = 'release-proof-service-bucket'
    returning id into strict v_deleted_bucket_id;
    if v_name is distinct from 'release-proof-service-object-updated'
       or v_bucket_id is distinct from 'release-proof-service-bucket'
       or v_bucket_name is distinct from 'release-proof-service-bucket-updated'
       or v_deleted_bucket_id is distinct from 'release-proof-service-bucket'
       or not exists (
           select 1 from storage.objects
            where bucket_id = 'third-party-browser-assets'
              and name = 'third-party-visible-seed'
       ) then
        raise exception 'service_role storage object/bucket CRUD or unrelated-bucket preservation failed';
    end if;
end
$release_proof_storage_service_crud$;
reset role;

set local role anon;
do $release_proof_storage_anon_denial$
declare
    v_rows integer;
    v_probe_name text;
begin
    if exists (select 1 from storage.objects where bucket_id = 'omr-private-assets')
       or exists (select 1 from storage.buckets where id = 'omr-private-assets')
       or not exists (
           select 1 from storage.objects
            where bucket_id = 'third-party-browser-assets'
              and name = 'third-party-visible-seed'
       ) then
        raise exception 'anon storage reads did not isolate the private OMR bucket';
    end if;
    begin
        insert into storage.objects (bucket_id, name)
        values ('omr-private-assets', 'release-proof-anon-forbidden');
        raise exception 'anon inserted into the private OMR bucket';
    exception when insufficient_privilege then null;
    end;
    begin
        insert into storage.buckets (id, name, public)
        values ('omr-private-assets', 'release-proof-anon-forbidden', false);
        raise exception 'anon inserted the private OMR storage bucket';
    exception when insufficient_privilege then null;
    end;
    update storage.objects set name = name where bucket_id = 'omr-private-assets';
    get diagnostics v_rows = row_count;
    if v_rows is distinct from 0 then raise exception 'anon updated a private storage object'; end if;
    delete from storage.objects where bucket_id = 'omr-private-assets';
    get diagnostics v_rows = row_count;
    if v_rows is distinct from 0 then raise exception 'anon deleted a private storage object'; end if;
    update storage.buckets set name = name where id = 'omr-private-assets';
    get diagnostics v_rows = row_count;
    if v_rows is distinct from 0 then raise exception 'anon updated the private storage bucket'; end if;
    delete from storage.buckets where id = 'omr-private-assets';
    get diagnostics v_rows = row_count;
    if v_rows is distinct from 0 then raise exception 'anon deleted the private storage bucket'; end if;
    insert into storage.objects (bucket_id, name)
    values ('third-party-browser-assets', 'release-proof-anon-other-bucket')
    returning name into strict v_probe_name;
    update storage.objects set name = 'release-proof-anon-other-bucket-updated'
     where bucket_id = 'third-party-browser-assets'
       and name = 'release-proof-anon-other-bucket'
    returning name into strict v_probe_name;
    delete from storage.objects
     where bucket_id = 'third-party-browser-assets'
       and name = 'release-proof-anon-other-bucket-updated';
    get diagnostics v_rows = row_count;
    if v_probe_name is distinct from 'release-proof-anon-other-bucket-updated' or v_rows is distinct from 1 then
        raise exception 'anon unrelated-bucket object CRUD drifted';
    end if;
end
$release_proof_storage_anon_denial$;
reset role;

set local role authenticated;
do $release_proof_storage_authenticated_denial$
declare
    v_rows integer;
    v_probe_name text;
begin
    if exists (select 1 from storage.objects where bucket_id = 'omr-private-assets')
       or exists (select 1 from storage.buckets where id = 'omr-private-assets')
       or not exists (
           select 1 from storage.objects
            where bucket_id = 'third-party-browser-assets'
              and name = 'third-party-visible-seed'
       ) then
        raise exception 'authenticated storage reads did not isolate the private OMR bucket';
    end if;
    begin
        insert into storage.objects (bucket_id, name)
        values ('omr-private-assets', 'release-proof-authenticated-forbidden');
        raise exception 'authenticated inserted into the private OMR bucket';
    exception when insufficient_privilege then null;
    end;
    begin
        insert into storage.buckets (id, name, public)
        values ('omr-private-assets', 'release-proof-authenticated-forbidden', false);
        raise exception 'authenticated inserted the private OMR storage bucket';
    exception when insufficient_privilege then null;
    end;
    update storage.objects set name = name where bucket_id = 'omr-private-assets';
    get diagnostics v_rows = row_count;
    if v_rows is distinct from 0 then raise exception 'authenticated updated a private storage object'; end if;
    delete from storage.objects where bucket_id = 'omr-private-assets';
    get diagnostics v_rows = row_count;
    if v_rows is distinct from 0 then raise exception 'authenticated deleted a private storage object'; end if;
    update storage.buckets set name = name where id = 'omr-private-assets';
    get diagnostics v_rows = row_count;
    if v_rows is distinct from 0 then raise exception 'authenticated updated the private storage bucket'; end if;
    delete from storage.buckets where id = 'omr-private-assets';
    get diagnostics v_rows = row_count;
    if v_rows is distinct from 0 then raise exception 'authenticated deleted the private storage bucket'; end if;
    insert into storage.objects (bucket_id, name)
    values ('third-party-browser-assets', 'release-proof-authenticated-other-bucket')
    returning name into strict v_probe_name;
    update storage.objects set name = 'release-proof-authenticated-other-bucket-updated'
     where bucket_id = 'third-party-browser-assets'
       and name = 'release-proof-authenticated-other-bucket'
    returning name into strict v_probe_name;
    delete from storage.objects
     where bucket_id = 'third-party-browser-assets'
       and name = 'release-proof-authenticated-other-bucket-updated';
    get diagnostics v_rows = row_count;
    if v_probe_name is distinct from 'release-proof-authenticated-other-bucket-updated' or v_rows is distinct from 1 then
        raise exception 'authenticated unrelated-bucket object CRUD drifted';
    end if;
end
$release_proof_storage_authenticated_denial$;
reset role;
\echo OMR_INITIAL_OPS_RELEASE_PROOF_V1 {"schemaVersion":1,"ordinal":18,"proofId":"data_integrity_isolation_storage_isolation"}

-- release-proof-assertion:data_integrity_isolation_rollback_contract
do $release_proof_rollback_contract$
declare
    v_readiness jsonb := public.omr_service_readiness_v1();
    v_required_readiness_keys constant text[] := array[
        'organizationBackfillReady', 'serviceRolePrivilegesReady', 'scopedRpcPrivilegesReady',
        'hostedStorageBoundaryReady', 'serverGatewayCapabilitiesReady', 'queryPathIndexesReady',
        'directUploadIntentLifecycleReady', 'teacherUploadCleanupQueueReady',
        'teacherAssetFinalizePreauthorizationReady', 'examReservationLeaseReady',
        'studentAttemptSessionsReady', 'durableRateLimitsReady', 'examRevisionReady',
        'teacherExamCasReady', 'teacherNotificationSummaryReady', 'teacherNotificationStateReady',
        'feedbackRevisionReady', 'feedbackCasReady', 'sessionCleanupOptimizationReady',
        'feedbackReplayHardeningReady', 'feedbackCoreFreeReady', 'examEntryInvitesReady',
        'sessionCleanupFencingReady', 'attemptCheckpointNullCasReady', 'rosterSnapshotCasReady',
        'attemptMutationCasReady', 'studentQuestionAtomicReady', 'teacherLiveSessionsReady',
        'teacherAccountLifecycleReady', 'initialOperationsLoadControlReady',
        'individualStudentAssignmentsReady', 'teacherAttemptReportingReady',
        'operationalJobStatusReady', 'operatorPilotProvisioningReady',
        'provisionedTeacherLoginReady', 'effectiveWorkspacePlanEnforcementReady',
        'studentSessionGenerationReady', 'studentCredentialBatchReady',
        'canonicalQuestionResultEvidenceReady', 'kakaoReminderEntitlementReady'
    ];
begin
    if pg_catalog.jsonb_typeof(v_readiness) is distinct from 'object'
       or pg_catalog.jsonb_typeof(v_readiness -> 'version') is distinct from 'string'
       or v_readiness ->> 'version' is distinct from '202608090001'
       or not (v_readiness ?& v_required_readiness_keys)
       or (select pg_catalog.count(*) from pg_catalog.jsonb_each(v_readiness) capability(key, value)
            where capability.key ~ 'Ready$') is distinct from pg_catalog.cardinality(v_required_readiness_keys)
       or exists (
           select 1 from pg_catalog.jsonb_each(v_readiness) capability(key, value)
            where capability.key = any(v_required_readiness_keys)
              and (
                  pg_catalog.jsonb_typeof(capability.value) is distinct from 'boolean'
                  or (
                      capability.key is distinct from 'organizationBackfillReady'
                      and capability.value is distinct from 'true'::jsonb
                  )
              )
       )
       or pg_catalog.has_schema_privilege('anon', 'public', 'USAGE')
       or pg_catalog.has_schema_privilege('authenticated', 'public', 'USAGE')
       or not exists (
           select 1
             from pg_catalog.pg_class relation
             join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
            where namespace.nspname = 'public'
              and relation.relname = 'omr_exams'
              and relation.relrowsecurity and relation.relforcerowsecurity
       ) then
        raise exception 'final boundary state did not match rollback/reapply transcript: %',
            pg_catalog.jsonb_build_object(
                'readiness', v_readiness,
                'anonPublicUsage', pg_catalog.has_schema_privilege('anon', 'public', 'USAGE'),
                'authenticatedPublicUsage',
                    pg_catalog.has_schema_privilege('authenticated', 'public', 'USAGE')
            );
    end if;
end
$release_proof_rollback_contract$;
\echo OMR_INITIAL_OPS_RELEASE_PROOF_V1 {"schemaVersion":1,"ordinal":19,"proofId":"data_integrity_isolation_rollback_contract"}
\echo OMR_INITIAL_OPS_ROLLBACK_PHASE_V1 {"schemaVersion":1,"ordinal":4,"phase":"final_asserted"}

rollback;
