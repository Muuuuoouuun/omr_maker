\set ON_ERROR_STOP on

-- Created after the production profile under the single migration owner. Its
-- effective grants prove future public functions inherit the intended defaults.
create or replace function public.omr_default_acl_probe_v1()
returns text
language sql
set search_path = ''
as $$
    select 'server-only'::text
$$;

do $$
begin
    if not exists (
        select 1
          from pg_default_acl default_acl
         where default_acl.defaclrole = 'postgres'::regrole
           and default_acl.defaclnamespace = 0
           and default_acl.defaclobjtype = 'f'
    ) or exists (
        select 1
          from pg_default_acl default_acl
          cross join lateral aclexplode(default_acl.defaclacl) privilege
         where default_acl.defaclrole = 'postgres'::regrole
           and default_acl.defaclnamespace = 0
           and default_acl.defaclobjtype = 'f'
           and privilege.grantee = 0
           and privilege.privilege_type = 'EXECUTE'
    ) then
        raise exception 'pg_default_acl retained PUBLIC function execute';
    end if;

    if not exists (
        select 1
          from pg_default_acl default_acl
          cross join lateral aclexplode(default_acl.defaclacl) privilege
         where default_acl.defaclrole = 'postgres'::regrole
           and default_acl.defaclnamespace = 'public'::regnamespace
           and default_acl.defaclobjtype = 'f'
           and privilege.grantee = 'service_role'::regrole
           and privilege.privilege_type = 'EXECUTE'
    ) then
        raise exception 'pg_default_acl lost service_role public function execute';
    end if;

    if not exists (
        select 1
          from pg_default_acl default_acl
          cross join lateral aclexplode(default_acl.defaclacl) privilege
         where default_acl.defaclrole = 'postgres'::regrole
           and default_acl.defaclnamespace = 'public'::regnamespace
           and default_acl.defaclobjtype = 'r'
           and privilege.grantee = 'service_role'::regrole
           and privilege.privilege_type = 'INSERT'
    ) or not exists (
        select 1
          from pg_default_acl default_acl
          cross join lateral aclexplode(default_acl.defaclacl) privilege
         where default_acl.defaclrole = 'postgres'::regrole
           and default_acl.defaclnamespace = 'public'::regnamespace
           and default_acl.defaclobjtype = 'S'
           and privilege.grantee = 'service_role'::regrole
           and privilege.privilege_type = 'USAGE'
    ) then
        raise exception 'pg_default_acl lost service_role public table or sequence privilege';
    end if;

    if exists (
        select 1
          from pg_default_acl default_acl
          cross join lateral aclexplode(default_acl.defaclacl) privilege
         where default_acl.defaclrole = 'postgres'::regrole
           and default_acl.defaclnamespace = 'public'::regnamespace
           and privilege.grantee in ('anon'::regrole, 'authenticated'::regrole)
    ) then
        raise exception 'pg_default_acl granted a public object privilege to a browser role';
    end if;

    if has_function_privilege(
        'anon',
        'public.omr_default_acl_probe_v1()',
        'EXECUTE'
    ) or has_function_privilege(
        'authenticated',
        'public.omr_default_acl_probe_v1()',
        'EXECUTE'
    ) then
        raise exception 'browser role executed a default-ACL probe function';
    end if;
    if not has_function_privilege(
        'service_role',
        'public.omr_default_acl_probe_v1()',
        'EXECUTE'
    ) then
        raise exception 'service_role could not execute the default-ACL probe function';
    end if;

    if has_schema_privilege('anon', 'public', 'usage')
        or has_schema_privilege('authenticated', 'public', 'usage')
    then
        raise exception 'browser roles unexpectedly retain public schema usage';
    end if;
    if not has_schema_privilege('service_role', 'public', 'usage') then
        raise exception 'service_role lost public schema usage';
    end if;

    if exists (
        select 1
          from pg_class relation
          join pg_namespace namespace on namespace.oid = relation.relnamespace
         where namespace.nspname = 'public'
           and relation.relkind in ('r', 'p')
           and relation.relname like 'omr\_%' escape '\'
           and (
               has_table_privilege('anon', relation.oid, 'SELECT')
               or has_table_privilege('anon', relation.oid, 'INSERT')
               or has_table_privilege('anon', relation.oid, 'UPDATE')
               or has_table_privilege('anon', relation.oid, 'DELETE')
               or has_table_privilege('authenticated', relation.oid, 'SELECT')
               or has_table_privilege('authenticated', relation.oid, 'INSERT')
               or has_table_privilege('authenticated', relation.oid, 'UPDATE')
               or has_table_privilege('authenticated', relation.oid, 'DELETE')
           )
    ) then
        raise exception 'browser roles unexpectedly retain an OMR table privilege';
    end if;

    if exists (
        select 1
          from pg_class relation
          join pg_namespace namespace on namespace.oid = relation.relnamespace
         where namespace.nspname = 'public'
           and relation.relkind in ('r', 'p')
           and relation.relname like 'omr\_%' escape '\'
           and relation.relname not in (
               'omr_rate_limit_buckets',
               'omr_exam_mutations',
               'omr_feedback_mutations',
               'omr_initial_ops_metrics',
               'omr_exam_entry_invites',
               'omr_teacher_accounts',
                'omr_teacher_account_tokens',
                'omr_teacher_notification_states',
                'omr_operational_job_status'
           )
           and (
               not has_table_privilege('service_role', relation.oid, 'SELECT')
               or not has_table_privilege('service_role', relation.oid, 'INSERT')
               or not has_table_privilege('service_role', relation.oid, 'UPDATE')
               or not has_table_privilege('service_role', relation.oid, 'DELETE')
           )
    ) then
        raise exception 'service_role lost an OMR table privilege';
    end if;
     if has_table_privilege(
        'service_role', 'public.omr_rate_limit_buckets',
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
    ) or has_table_privilege(
        'service_role', 'public.omr_exam_mutations',
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
    ) or has_table_privilege(
        'service_role', 'public.omr_feedback_mutations',
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
    ) then
        raise exception 'service_role bypassed an RPC-only OMR state table';
    end if;
    if has_table_privilege(
        'service_role', 'public.omr_initial_ops_metrics',
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
    ) or has_table_privilege(
        'service_role', 'public.omr_teacher_accounts',
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
    ) or has_table_privilege(
        'service_role', 'public.omr_teacher_account_tokens',
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
    ) or has_table_privilege(
         'service_role', 'public.omr_teacher_notification_states',
         'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
     ) or has_table_privilege(
         'service_role', 'public.omr_operational_job_status',
         'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
     ) then
         raise exception 'service_role bypassed a private operations or teacher-auth table';
    end if;

    if exists (
        select 1
          from pg_class relation
          join pg_namespace namespace on namespace.oid = relation.relnamespace
         where namespace.nspname = 'public'
           and relation.relkind = 'S'
           and (
               has_sequence_privilege('anon', relation.oid, 'USAGE')
               or has_sequence_privilege('anon', relation.oid, 'SELECT')
               or has_sequence_privilege('anon', relation.oid, 'UPDATE')
               or has_sequence_privilege('authenticated', relation.oid, 'USAGE')
               or has_sequence_privilege('authenticated', relation.oid, 'SELECT')
               or has_sequence_privilege('authenticated', relation.oid, 'UPDATE')
           )
    ) then
        raise exception 'browser roles unexpectedly retain an OMR sequence privilege';
    end if;

    if exists (
        select 1
          from pg_proc routine
          join pg_namespace namespace on namespace.oid = routine.pronamespace
         where namespace.nspname = 'public'
           and (
               has_function_privilege('anon', routine.oid, 'EXECUTE')
               or has_function_privilege('authenticated', routine.oid, 'EXECUTE')
           )
    ) then
        raise exception 'browser roles unexpectedly retain a public function privilege';
    end if;

    if exists (
        select 1
          from pg_proc routine
         join pg_namespace namespace on namespace.oid = routine.pronamespace
         where namespace.nspname = 'public'
           and not has_function_privilege('service_role', routine.oid, 'EXECUTE')
           and pg_catalog.format(
               '%s(%s)', routine.proname,
               pg_catalog.oidvectortypes(routine.proargtypes)
           ) not in (
               'omr_save_exam_plan_unlocked_v1(jsonb, jsonb)',
               'omr_save_roster_plan_unlocked_v1(text, jsonb, jsonb, jsonb, jsonb)',
               'omr_save_roster_unlocked_v1(text, jsonb, jsonb, jsonb, jsonb)',
               'omr_save_roster_v1(text, jsonb, jsonb, jsonb, jsonb)',
               'omr_enqueue_remote_asset_cleanup_v1(text, text, text, text, text, text, text, text)',
               'omr_enqueue_exam_asset_cleanup_v1(text, text, text[], text)',
               'omr_remote_assets_enqueue_cleanup_v1()',
               'omr_exams_enqueue_asset_cleanup_v1()',
               'omr_mark_exam_reservation_durable_v1()',
               'omr_teacher_force_finish_fingerprint_v1(bigint, jsonb, jsonb, integer[], jsonb)',
               'omr_advance_teacher_session_on_disable_v1()',
               'omr_initial_ops_operation_v1(text, text, text, text, text, text, jsonb)',
               'omr_initial_ops_reserve_upload_v1(text, text, text, text, text, text, bigint)',
               'omr_prepare_teacher_asset_upload_v6_snapshot(jsonb)',
               'omr_save_exam_v6_snapshot(jsonb, jsonb, jsonb, text)',
               'omr_save_exam_v10_snapshot(jsonb, jsonb, jsonb, text)',
               'omr_release_plan_usage_v10_snapshot(text, text, date, text)',
               'omr_normalize_exam_save_request_v10(jsonb)',
               'omr_service_readiness_v4_snapshot()',
               'omr_service_readiness_v5_snapshot()',
               'omr_service_readiness_v6_snapshot()',
               'omr_service_readiness_v7_snapshot()',
               'omr_service_readiness_v10_snapshot()',
               'omr_ack_remote_asset_cleanup_v1(text, text)',
               'omr_fail_remote_asset_cleanup_v1(text, text, text)',
               'omr_save_exam_v1(jsonb, jsonb, jsonb, text)',
               'omr_save_feedback_v1(text, jsonb)',
               'omr_return_feedback_v1(text, text, timestamp with time zone)',
               'omr_save_feedback_v12_snapshot(text, jsonb)',
               'omr_return_feedback_v12_snapshot(text, text, timestamp with time zone)',
               'omr_assert_targeted_assignment_scope_v1(text, text, text, text, text, text, integer[])',
               'omr_validate_targeted_attempt_session_v1()',
               'omr_validate_targeted_attempt_v1()',
               'omr_guard_targeted_exam_access_v1()'
           )
    ) then
        raise exception 'service_role lost a public function execute privilege';
    end if;

    if exists (
        select 1
          from pg_policies policy
         where policy.schemaname = 'public'
           and policy.tablename like 'omr\_%' escape '\'
    ) then
        raise exception 'production server boundary left an alpha or browser policy';
    end if;

    if exists (
        select 1
          from pg_class relation
          join pg_namespace namespace on namespace.oid = relation.relnamespace
         where namespace.nspname = 'public'
           and relation.relkind in ('r', 'p')
           and relation.relname like 'omr\_%' escape '\'
           and (not relation.relrowsecurity or not relation.relforcerowsecurity)
    ) then
        raise exception 'production server boundary must ENABLE and FORCE RLS on every OMR table';
    end if;

    if to_regclass('storage.objects') is null
        or to_regclass('storage.buckets') is null
    then
        raise exception 'live production boundary requires Storage relation fixtures';
    end if;
    if (
        select count(*)
          from pg_class relation
          join pg_namespace namespace on namespace.oid = relation.relnamespace
         where namespace.nspname = 'storage'
           and relation.relname in ('objects', 'buckets')
           and relation.relowner = 'supabase_storage_admin'::regrole
    ) <> 2 then
        raise exception 'Storage relation owner drifted from supabase_storage_admin';
    end if;
    if not exists (
        select 1
          from pg_roles
         where rolname = 'service_role'
           and rolbypassrls
    ) then
        raise exception 'service_role lost Storage RLS bypass';
    end if;

    if (
        select count(*)
          from pg_policies policy
         where policy.schemaname = 'storage'
           and (
               (
                   policy.tablename = 'objects'
                   and policy.policyname = 'OMR private assets server-only objects'
                   and policy.qual = '(bucket_id <> ''omr-private-assets''::text)'
                   and policy.with_check = '(bucket_id <> ''omr-private-assets''::text)'
               )
               or (
                   policy.tablename = 'buckets'
                   and policy.policyname = 'OMR private assets server-only buckets'
                   and policy.qual = '(id <> ''omr-private-assets''::text)'
                   and policy.with_check = '(id <> ''omr-private-assets''::text)'
               )
           )
           and policy.permissive = 'RESTRICTIVE'
           and policy.cmd = 'ALL'
           and policy.roles @> array['anon', 'authenticated']::name[]
           and policy.roles <@ array['anon', 'authenticated']::name[]
           and cardinality(policy.roles) = 2
    ) <> 2 then
        raise exception 'OMR restrictive Storage policy contract mismatch';
    end if;
    if exists (
        select 1
          from pg_policies policy
         where policy.schemaname = 'storage'
           and policy.policyname = 'OMR private assets alpha access'
    ) then
        raise exception 'production server boundary left the alpha OMR Storage policy';
    end if;
    if (
        select count(*)
          from pg_policies policy
         where policy.schemaname = 'storage'
           and (
               (
                   policy.tablename = 'objects'
                   and policy.policyname = 'Third-party browser object access'
               )
               or (
                   policy.tablename = 'buckets'
                   and policy.policyname = 'Third-party browser bucket access'
               )
           )
           and policy.permissive = 'PERMISSIVE'
           and policy.cmd = 'ALL'
           and policy.qual = 'true'
           and policy.with_check = 'true'
           and policy.roles @> array['anon', 'authenticated']::name[]
           and policy.roles <@ array['anon', 'authenticated']::name[]
           and cardinality(policy.roles) = 2
    ) <> 2 then
        raise exception 'unrelated third-party Storage policy was changed';
    end if;

    if not exists (
        select 1
          from pg_class relation
          join pg_namespace namespace on namespace.oid = relation.relnamespace
         where namespace.nspname = 'public'
           and relation.relname = 'omr_remote_assets'
           and relation.relforcerowsecurity
    ) then
        raise exception 'remote asset registry must FORCE RLS';
    end if;
    if not exists (
        select 1
          from pg_class relation
          join pg_namespace namespace on namespace.oid = relation.relnamespace
         where namespace.nspname = 'public'
           and relation.relname = 'omr_student_start_credentials'
           and relation.relforcerowsecurity
    ) then
        raise exception 'student credential registry must FORCE RLS';
    end if;
    if not exists (
        select 1 from storage.buckets
         where id = 'omr-private-assets'
           and public = false
    ) then
        raise exception 'private remote asset bucket was not provisioned';
    end if;
end
$$;

set role service_role;

insert into storage.buckets (id, name, public)
values ('third-party-browser-assets', 'third-party-browser-assets', false)
on conflict (id) do update
set name = excluded.name,
    public = excluded.public;

insert into storage.objects (bucket_id, name)
values
    ('omr-private-assets', 'target-browser-denial-seed'),
    ('third-party-browser-assets', 'third-party-visible-seed')
on conflict (bucket_id, name) do nothing;

reset role;

insert into public.omr_organizations (id, name) values
    ('live-org-a', 'Live Org A'),
    ('live-org-b', 'Live Org B');

insert into public.omr_organization_members (
    organization_id, user_id, role, status
) values
    ('live-org-a', '11111111-1111-4111-8111-111111111111', 'owner', 'active'),
    ('live-org-b', '22222222-2222-4222-8222-222222222222', 'owner', 'active');

insert into public.omr_exams (
    id, organization_id, title, payload, created_at, updated_at
) values
    ('live-exam-a', 'live-org-a', 'Org A Exam', '{"id":"live-exam-a","title":"Org A Exam","questions":[],"createdAt":"2026-07-14T00:00:00.000Z"}', now(), now()),
    ('live-exam-b', 'live-org-b', 'Org B Exam', '{"id":"live-exam-b","title":"Org B Exam","questions":[],"createdAt":"2026-07-14T00:00:00.000Z"}', now(), now());

set role authenticated;

do $$
declare
    affected_rows integer;
    probe_name text;
begin
    begin
        perform 1 from public.omr_exams;
        raise exception 'authenticated SELECT unexpectedly reached canonical tables';
    exception when insufficient_privilege then null;
    end;
    begin
        insert into public.omr_exams (
            id, organization_id, title, payload, created_at, updated_at
        ) values (
            'live-auth-forbidden', 'live-org-a', 'Forbidden', '{}', now(), now()
        );
        raise exception 'authenticated INSERT unexpectedly reached canonical tables';
    exception when insufficient_privilege then null;
    end;
    begin
        update public.omr_exams set title = title where id = 'live-exam-a';
        raise exception 'authenticated UPDATE unexpectedly reached canonical tables';
    exception when insufficient_privilege then null;
    end;
    begin
        delete from public.omr_exams where id = 'live-exam-a';
        raise exception 'authenticated DELETE unexpectedly reached canonical tables';
    exception when insufficient_privilege then null;
    end;
    begin
        perform public.omr_default_acl_probe_v1();
        raise exception 'browser role executed a default-ACL probe function';
    exception when insufficient_privilege then null;
    end;
    if exists (
        select 1
          from storage.objects
         where bucket_id = 'omr-private-assets'
    ) or exists (
        select 1
          from storage.buckets
         where id = 'omr-private-assets'
    ) then
        raise exception 'authenticated target Storage SELECT unexpectedly succeeded';
    end if;
    begin
        insert into storage.objects (bucket_id, name)
        values ('omr-private-assets', 'authenticated-forbidden');
        raise exception 'authenticated target Storage INSERT unexpectedly succeeded';
    exception when insufficient_privilege then null;
    end;
    begin
        insert into storage.buckets (id, name, public)
        values ('omr-private-assets', 'authenticated-forbidden', false);
        raise exception 'authenticated target Storage bucket INSERT unexpectedly succeeded';
    exception when insufficient_privilege then null;
    end;

    update storage.objects
       set name = name
     where bucket_id = 'omr-private-assets';
    get diagnostics affected_rows = row_count;
    if affected_rows <> 0 then
        raise exception 'authenticated target Storage UPDATE unexpectedly succeeded';
    end if;
    delete from storage.objects
     where bucket_id = 'omr-private-assets';
    get diagnostics affected_rows = row_count;
    if affected_rows <> 0 then
        raise exception 'authenticated target Storage DELETE unexpectedly succeeded';
    end if;
    update storage.buckets
       set name = name
     where id = 'omr-private-assets';
    get diagnostics affected_rows = row_count;
    if affected_rows <> 0 then
        raise exception 'authenticated target Storage bucket UPDATE unexpectedly succeeded';
    end if;
    delete from storage.buckets where id = 'omr-private-assets';
    get diagnostics affected_rows = row_count;
    if affected_rows <> 0 then
        raise exception 'authenticated target Storage bucket DELETE unexpectedly succeeded';
    end if;

    if not exists (
        select 1 from storage.buckets where id = 'third-party-browser-assets'
    ) or not exists (
        select 1
          from storage.objects
         where bucket_id = 'third-party-browser-assets'
           and name = 'third-party-visible-seed'
    ) then
        raise exception 'other-bucket Storage policy no longer permits browser access';
    end if;
    insert into storage.objects (bucket_id, name)
    values ('third-party-browser-assets', 'authenticated-other-bucket-probe')
    returning name into probe_name;
    update storage.objects
       set name = 'authenticated-other-bucket-probe-updated'
     where bucket_id = 'third-party-browser-assets'
       and name = 'authenticated-other-bucket-probe'
    returning name into probe_name;
    if probe_name is distinct from 'authenticated-other-bucket-probe-updated' then
        raise exception 'other-bucket Storage policy no longer permits browser access';
    end if;
    delete from storage.objects
     where bucket_id = 'third-party-browser-assets'
       and name = 'authenticated-other-bucket-probe-updated';
    get diagnostics affected_rows = row_count;
    if affected_rows <> 1 then
        raise exception 'other-bucket Storage policy no longer permits browser access';
    end if;
end
$$;

reset role;
set role anon;

do $$
declare
    affected_rows integer;
    probe_name text;
begin
    begin
        perform 1 from public.omr_exams;
        raise exception 'anon SELECT unexpectedly reached canonical tables';
    exception when insufficient_privilege then null;
    end;
    begin
        insert into public.omr_exams (
            id, organization_id, title, payload, created_at, updated_at
        ) values (
            'live-anon-forbidden', 'live-org-a', 'Forbidden', '{}', now(), now()
        );
        raise exception 'anon INSERT unexpectedly reached canonical tables';
    exception when insufficient_privilege then null;
    end;
    begin
        update public.omr_exams set title = title where id = 'live-exam-a';
        raise exception 'anon UPDATE unexpectedly reached canonical tables';
    exception when insufficient_privilege then null;
    end;
    begin
        delete from public.omr_exams where id = 'live-exam-a';
        raise exception 'anon DELETE unexpectedly reached canonical tables';
    exception when insufficient_privilege then null;
    end;
    begin
        perform public.omr_default_acl_probe_v1();
        raise exception 'browser role executed a default-ACL probe function';
    exception when insufficient_privilege then null;
    end;
    if exists (
        select 1
          from storage.objects
         where bucket_id = 'omr-private-assets'
    ) or exists (
        select 1
          from storage.buckets
         where id = 'omr-private-assets'
    ) then
        raise exception 'anon target Storage SELECT unexpectedly succeeded';
    end if;
    begin
        insert into storage.objects (bucket_id, name)
        values ('omr-private-assets', 'anon-forbidden');
        raise exception 'anon target Storage INSERT unexpectedly succeeded';
    exception when insufficient_privilege then null;
    end;
    begin
        insert into storage.buckets (id, name, public)
        values ('omr-private-assets', 'anon-forbidden', false);
        raise exception 'anon target Storage bucket INSERT unexpectedly succeeded';
    exception when insufficient_privilege then null;
    end;

    update storage.objects
       set name = name
     where bucket_id = 'omr-private-assets';
    get diagnostics affected_rows = row_count;
    if affected_rows <> 0 then
        raise exception 'anon target Storage UPDATE unexpectedly succeeded';
    end if;
    delete from storage.objects
     where bucket_id = 'omr-private-assets';
    get diagnostics affected_rows = row_count;
    if affected_rows <> 0 then
        raise exception 'anon target Storage DELETE unexpectedly succeeded';
    end if;
    update storage.buckets
       set name = name
     where id = 'omr-private-assets';
    get diagnostics affected_rows = row_count;
    if affected_rows <> 0 then
        raise exception 'anon target Storage bucket UPDATE unexpectedly succeeded';
    end if;
    delete from storage.buckets where id = 'omr-private-assets';
    get diagnostics affected_rows = row_count;
    if affected_rows <> 0 then
        raise exception 'anon target Storage bucket DELETE unexpectedly succeeded';
    end if;

    if not exists (
        select 1 from storage.buckets where id = 'third-party-browser-assets'
    ) or not exists (
        select 1
          from storage.objects
         where bucket_id = 'third-party-browser-assets'
           and name = 'third-party-visible-seed'
    ) then
        raise exception 'other-bucket Storage policy no longer permits browser access';
    end if;
    insert into storage.objects (bucket_id, name)
    values ('third-party-browser-assets', 'anon-other-bucket-probe')
    returning name into probe_name;
    update storage.objects
       set name = 'anon-other-bucket-probe-updated'
     where bucket_id = 'third-party-browser-assets'
       and name = 'anon-other-bucket-probe'
    returning name into probe_name;
    if probe_name is distinct from 'anon-other-bucket-probe-updated' then
        raise exception 'other-bucket Storage policy no longer permits browser access';
    end if;
    delete from storage.objects
     where bucket_id = 'third-party-browser-assets'
       and name = 'anon-other-bucket-probe-updated';
    get diagnostics affected_rows = row_count;
    if affected_rows <> 1 then
        raise exception 'other-bucket Storage policy no longer permits browser access';
    end if;
end
$$;

reset role;

set role service_role;

do $$
declare
    probe_name text;
begin
    if public.omr_default_acl_probe_v1() is distinct from 'server-only' then
        raise exception 'service_role could not execute the default-ACL probe function';
    end if;

    insert into storage.objects (bucket_id, name)
    values ('omr-private-assets', 'service-role-storage-probe')
    returning name into probe_name;
    if probe_name is distinct from 'service-role-storage-probe' then
        raise exception 'service_role Storage CRUD probe failed';
    end if;

    select name
      into probe_name
      from storage.objects
     where bucket_id = 'omr-private-assets'
       and name = 'service-role-storage-probe';
    if probe_name is distinct from 'service-role-storage-probe' then
        raise exception 'service_role Storage CRUD probe failed';
    end if;

    update storage.objects
       set name = 'service-role-storage-probe-updated'
     where bucket_id = 'omr-private-assets'
       and name = 'service-role-storage-probe'
    returning name into probe_name;
    if probe_name is distinct from 'service-role-storage-probe-updated' then
        raise exception 'service_role Storage CRUD probe failed';
    end if;

    delete from storage.objects
     where bucket_id = 'omr-private-assets'
       and name = 'service-role-storage-probe-updated'
    returning name into probe_name;
    if probe_name is distinct from 'service-role-storage-probe-updated' then
        raise exception 'service_role Storage CRUD probe failed';
    end if;
end
$$;

reset role;

do $$
begin
    if has_function_privilege('anon', 'public.omr_submit_attempt_v1(text,jsonb,jsonb)', 'execute') then
        raise exception 'anon unexpectedly has attempt RPC execute privilege';
    end if;
    if has_function_privilege('authenticated', 'public.omr_submit_attempt_v1(text,jsonb,jsonb)', 'execute') then
        raise exception 'authenticated unexpectedly has attempt RPC execute privilege';
    end if;
    if not has_function_privilege('service_role', 'public.omr_submit_attempt_v1(text,jsonb,jsonb)', 'execute') then
        raise exception 'service_role must have attempt RPC execute privilege';
    end if;
    if has_function_privilege('anon', 'public.omr_submit_session_attempt_v1(jsonb,jsonb)', 'execute')
        or has_function_privilege('authenticated', 'public.omr_submit_session_attempt_v1(jsonb,jsonb)', 'execute')
    then
        raise exception 'browser roles unexpectedly have session attempt RPC execute privilege';
    end if;
    if not has_function_privilege('service_role', 'public.omr_submit_session_attempt_v1(jsonb,jsonb)', 'execute') then
        raise exception 'service_role must have session attempt RPC execute privilege';
    end if;
    if has_function_privilege('anon', 'public.omr_claim_guest_attempts_v1(text,text,text,text,text,text,text[])', 'execute')
        or has_function_privilege('authenticated', 'public.omr_claim_guest_attempts_v1(text,text,text,text,text,text,text[])', 'execute')
    then
        raise exception 'browser roles unexpectedly have guest claim RPC execute privilege';
    end if;
    if not has_function_privilege('service_role', 'public.omr_claim_guest_attempts_v1(text,text,text,text,text,text,text[])', 'execute') then
        raise exception 'service_role must have guest claim RPC execute privilege';
    end if;
    if has_function_privilege('anon', 'public.omr_save_remote_asset_metadata_v1(jsonb)', 'execute')
        or has_function_privilege('authenticated', 'public.omr_save_remote_asset_metadata_v1(jsonb)', 'execute')
    then
        raise exception 'browser roles unexpectedly have remote asset metadata RPC execute privilege';
    end if;
    if not has_function_privilege('service_role', 'public.omr_save_remote_asset_metadata_v1(jsonb)', 'execute') then
        raise exception 'service_role must have remote asset metadata RPC execute privilege';
    end if;
    if has_function_privilege('anon', 'public.omr_prepare_teacher_asset_upload_v1(jsonb)', 'execute')
        or has_function_privilege('authenticated', 'public.omr_prepare_teacher_asset_upload_v1(jsonb)', 'execute')
        or has_function_privilege('anon', 'public.omr_finalize_teacher_asset_upload_v1(text,text,text,jsonb)', 'execute')
        or has_function_privilege('authenticated', 'public.omr_finalize_teacher_asset_upload_v1(text,text,text,jsonb)', 'execute')
    then
        raise exception 'browser roles unexpectedly have teacher upload lifecycle RPC execute privilege';
    end if;
    if not has_function_privilege('service_role', 'public.omr_prepare_teacher_asset_upload_v1(jsonb)', 'execute')
        or not has_function_privilege('service_role', 'public.omr_finalize_teacher_asset_upload_v1(text,text,text,jsonb)', 'execute')
    then
        raise exception 'service_role must have teacher upload lifecycle RPC execute privilege';
    end if;
    if pg_catalog.to_regprocedure('public.omr_mark_feedback_opened(text,timestamptz)') is not null then
        raise exception 'legacy unscoped feedback RPC still exists';
    end if;
    if has_function_privilege('anon', 'public.omr_save_exam_v2(jsonb,jsonb,jsonb,text,bigint,text)', 'execute')
        or has_function_privilege('authenticated', 'public.omr_save_exam_v2(jsonb,jsonb,jsonb,text,bigint,text)', 'execute')
    then
        raise exception 'browser roles unexpectedly have teacher exam RPC execute privilege';
    end if;
    if not has_function_privilege('service_role', 'public.omr_save_exam_v2(jsonb,jsonb,jsonb,text,bigint,text)', 'execute') then
        raise exception 'service_role must have teacher exam RPC execute privilege';
    end if;
    if has_function_privilege('service_role', 'public.omr_save_exam_v1(jsonb,jsonb,jsonb,text)', 'execute')
        or has_function_privilege('service_role', 'public.omr_save_exam_v10_snapshot(jsonb,jsonb,jsonb,text)', 'execute')
        or has_function_privilege('service_role', 'public.omr_release_plan_usage_v10_snapshot(text,text,date,text)', 'execute')
        or has_function_privilege('service_role', 'public.omr_normalize_exam_save_request_v10(jsonb)', 'execute')
    then
        raise exception 'service_role unexpectedly reached a blind or private exam gateway';
    end if;
    if has_function_privilege('anon', 'public.omr_delete_exam_v1(text,text)', 'execute')
        or has_function_privilege('authenticated', 'public.omr_delete_exam_v1(text,text)', 'execute')
    then
        raise exception 'browser roles unexpectedly have teacher exam delete RPC execute privilege';
    end if;
    if not has_function_privilege('service_role', 'public.omr_delete_exam_v1(text,text)', 'execute') then
        raise exception 'service_role must have teacher exam delete RPC execute privilege';
    end if;
    if has_function_privilege('anon', 'public.omr_attach_attempt_handwriting_v1(text,text,jsonb)', 'execute')
        or has_function_privilege('authenticated', 'public.omr_attach_attempt_handwriting_v1(text,text,jsonb)', 'execute')
    then
        raise exception 'browser roles unexpectedly have handwriting RPC execute privilege';
    end if;
    if pg_catalog.to_regprocedure('public.omr_teacher_update_attempt_v1(text,jsonb,jsonb)') is not null then
        raise exception 'legacy broad teacher attempt RPC still exists';
    end if;
    if has_function_privilege('anon', 'public.omr_answer_attempt_question_v1(text,text,text,text,text,text,text)', 'execute')
        or has_function_privilege('authenticated', 'public.omr_answer_attempt_question_v1(text,text,text,text,text,text,text)', 'execute')
        or has_function_privilege('anon', 'public.omr_set_subquestion_review_v1(text,text,text,text,text,text,text)', 'execute')
        or has_function_privilege('authenticated', 'public.omr_set_subquestion_review_v1(text,text,text,text,text,text,text)', 'execute')
        or has_function_privilege('anon', 'public.omr_force_finish_attempts_v1(text,text[],timestamptz,text,text,text,jsonb)', 'execute')
        or has_function_privilege('authenticated', 'public.omr_force_finish_attempts_v1(text,text[],timestamptz,text,text,text,jsonb)', 'execute')
    then
        raise exception 'browser roles unexpectedly have scoped teacher attempt RPC execute privilege';
    end if;
    if not has_function_privilege('service_role', 'public.omr_answer_attempt_question_v1(text,text,text,text,text,text,text)', 'execute')
        or not has_function_privilege('service_role', 'public.omr_set_subquestion_review_v1(text,text,text,text,text,text,text)', 'execute')
        or not has_function_privilege('service_role', 'public.omr_force_finish_attempts_v1(text,text[],timestamptz,text,text,text,jsonb)', 'execute')
    then
        raise exception 'service_role must have scoped teacher attempt RPC execute privilege';
    end if;
    if has_function_privilege('anon', 'public.omr_upsert_student_attempt_question_v1(text,text,text,bigint,text,text)', 'execute')
        or has_function_privilege('authenticated', 'public.omr_upsert_student_attempt_question_v1(text,text,text,bigint,text,text)', 'execute')
    then
        raise exception 'browser roles unexpectedly have student question RPC execute privilege';
    end if;
    if not has_function_privilege('service_role', 'public.omr_upsert_student_attempt_question_v1(text,text,text,bigint,text,text)', 'execute') then
        raise exception 'service_role must have student question RPC execute privilege';
    end if;
    if has_function_privilege('anon', 'public.omr_load_roster_v2(text)', 'execute')
        or has_function_privilege('authenticated', 'public.omr_load_roster_v2(text)', 'execute')
        or has_function_privilege('anon', 'public.omr_save_roster_v2(text,jsonb,jsonb,jsonb,jsonb,bigint)', 'execute')
        or has_function_privilege('authenticated', 'public.omr_save_roster_v2(text,jsonb,jsonb,jsonb,jsonb,bigint)', 'execute')
    then
        raise exception 'browser roles unexpectedly have teacher roster RPC execute privilege';
    end if;
    if has_function_privilege('service_role', 'public.omr_save_roster_v1(text,jsonb,jsonb,jsonb,jsonb)', 'execute')
        or not has_function_privilege('service_role', 'public.omr_load_roster_v2(text)', 'execute')
        or not has_function_privilege('service_role', 'public.omr_save_roster_v2(text,jsonb,jsonb,jsonb,jsonb,bigint)', 'execute')
    then
        raise exception 'service_role roster CAS privilege boundary is invalid';
    end if;
    if has_function_privilege('anon', 'public.omr_save_feedback_v1(text,jsonb)', 'execute')
        or has_function_privilege('authenticated', 'public.omr_save_feedback_v1(text,jsonb)', 'execute')
        or has_function_privilege('anon', 'public.omr_return_feedback_v1(text,text,timestamp with time zone)', 'execute')
        or has_function_privilege('authenticated', 'public.omr_return_feedback_v1(text,text,timestamp with time zone)', 'execute')
        or has_function_privilege('anon', 'public.omr_save_feedback_v3(text,jsonb,bigint,text)', 'execute')
        or has_function_privilege('authenticated', 'public.omr_save_feedback_v3(text,jsonb,bigint,text)', 'execute')
        or has_function_privilege('anon', 'public.omr_return_feedback_v3(text,text,bigint,text)', 'execute')
        or has_function_privilege('authenticated', 'public.omr_return_feedback_v3(text,text,bigint,text)', 'execute')
        or has_function_privilege('anon', 'public.omr_mark_feedback_opened_v2(text,text,text,timestamp with time zone)', 'execute')
        or has_function_privilege('authenticated', 'public.omr_mark_feedback_opened_v2(text,text,text,timestamp with time zone)', 'execute')
    then
        raise exception 'browser roles unexpectedly have feedback RPC execute privilege';
    end if;
    if has_function_privilege('service_role', 'public.omr_save_feedback_v1(text,jsonb)', 'execute')
        or has_function_privilege('service_role', 'public.omr_return_feedback_v1(text,text,timestamp with time zone)', 'execute')
        or not has_function_privilege('service_role', 'public.omr_save_feedback_v2(text,jsonb,bigint,text)', 'execute')
        or not has_function_privilege('service_role', 'public.omr_return_feedback_v2(text,text,bigint,text)', 'execute')
        or not has_function_privilege('service_role', 'public.omr_save_feedback_v3(text,jsonb,bigint,text)', 'execute')
        or not has_function_privilege('service_role', 'public.omr_return_feedback_v3(text,text,bigint,text)', 'execute')
        or not has_function_privilege('service_role', 'public.omr_mark_feedback_opened_v2(text,text,text,timestamp with time zone)', 'execute')
    then
        raise exception 'service_role must have feedback RPC execute privilege';
    end if;
    if has_function_privilege('anon', 'public.omr_service_readiness_v1()', 'execute')
        or has_function_privilege('authenticated', 'public.omr_service_readiness_v1()', 'execute')
    then
        raise exception 'browser roles unexpectedly have readiness RPC execute privilege';
    end if;
    if not has_function_privilege('service_role', 'public.omr_service_readiness_v1()', 'execute') then
        raise exception 'service_role must have readiness RPC execute privilege';
    end if;
    if has_function_privilege('anon', 'public.omr_production_boundary_preflight_v1()', 'execute')
        or has_function_privilege('authenticated', 'public.omr_production_boundary_preflight_v1()', 'execute')
        or has_function_privilege('anon', 'public.omr_assert_production_boundary_preflight_v1()', 'execute')
        or has_function_privilege('authenticated', 'public.omr_assert_production_boundary_preflight_v1()', 'execute')
    then
        raise exception 'browser roles unexpectedly have production-boundary preflight execute privilege';
    end if;
    if not has_function_privilege('service_role', 'public.omr_production_boundary_preflight_v1()', 'execute')
        or not has_function_privilege('service_role', 'public.omr_assert_production_boundary_preflight_v1()', 'execute')
    then
        raise exception 'service_role must have production-boundary preflight execute privilege';
    end if;
end
$$;

set role service_role;

-- Durable limiter semantics: a rejected consume can be compensated exactly
-- once, and refunding an absent bucket is idempotent. This exercises the RPC
-- while direct service-role table access remains revoked.
do $$
declare
    v_bucket text := repeat('9', 64);
    v_result jsonb;
begin
    perform public.omr_consume_rate_limit_v1(v_bucket, 'success', 1, 60, 0);
    v_result := public.omr_consume_rate_limit_v1(v_bucket, 'consume', 1, 60, 0);
    if v_result ->> 'allowed' <> 'true' then
        raise exception 'durable rate limiter rejected the first consume: %', v_result;
    end if;
    v_result := public.omr_consume_rate_limit_v1(v_bucket, 'consume', 1, 60, 0);
    if v_result ->> 'allowed' <> 'false' then
        raise exception 'durable rate limiter ignored the configured limit: %', v_result;
    end if;
    v_result := public.omr_consume_rate_limit_v1(v_bucket, 'refund', 1, 60, 0);
    if v_result ->> 'allowed' <> 'true' then
        raise exception 'durable rate limiter refund failed: %', v_result;
    end if;
    v_result := public.omr_consume_rate_limit_v1(v_bucket, 'check', 1, 60, 0);
    if v_result ->> 'allowed' <> 'true' then
        raise exception 'durable rate limiter refund did not restore capacity: %', v_result;
    end if;
    v_result := public.omr_consume_rate_limit_v1(v_bucket, 'refund', 1, 60, 0);
    if v_result ->> 'allowed' <> 'true' then
        raise exception 'durable rate limiter missing-bucket refund was not idempotent: %', v_result;
    end if;
end
$$;

select public.omr_save_roster_v2(
    'live-org-a',
    '[{"id":"live-class-a","organization_id":"live-org-a","name":"A반","status":"active","metadata":{}}]',
    '[{"id":"live-student-a","organization_id":"live-org-a","display_name":"학생 A","external_id":"A-001","status":"active","metadata":{}}]',
    '[{"class_id":"live-class-a","organization_id":"live-org-a","student_profile_id":"live-student-a","enrollment_status":"active"}]',
    '[{"id":"live-invite-a","organization_id":"live-org-a","email":"invite@example.com","sent_at":"2026-07-14T00:00:00.000Z","status":"pending"}]',
    coalesce((select (metadata->>'rosterRevision')::bigint from public.omr_organizations where id = 'live-org-a'), 0)
);

do $$
begin
    if not exists (
        select 1 from public.omr_class_students
         where organization_id = 'live-org-a'
           and class_id = 'live-class-a'
           and student_profile_id = 'live-student-a'
           and enrollment_status = 'active'
    ) then
        raise exception 'teacher roster RPC did not persist the canonical enrollment';
    end if;
end
$$;

insert into public.omr_student_start_credentials (
    organization_id, student_profile_id, start_code_hash
) values (
    'live-org-a', 'live-student-a',
    'pbkdf2-sha256:10000:07070707070707070707070707070707:8de12bc47d04bf0f520b627acee8c21c74b064b9f30fc943efaf7b2788e45e94'
);

select public.omr_save_roster_v2(
    'live-org-a',
    '[{"id":"live-class-a","organization_id":"live-org-a","name":"A반","status":"active","metadata":{}}]',
    '[]',
    '[]',
    '[{"id":"live-invite-a","organization_id":"live-org-a","email":"invite@example.com","sent_at":"2026-07-14T00:00:00.000Z","status":"pending"}]',
    coalesce((select (metadata->>'rosterRevision')::bigint from public.omr_organizations where id = 'live-org-a'), 0)
);

do $$
begin
    if exists (
        select 1 from public.omr_student_start_credentials
         where organization_id = 'live-org-a'
           and student_profile_id = 'live-student-a'
    ) then
        raise exception 'issue-first serialized outcome retained a credential';
    end if;
end
$$;

do $$
begin
    begin
        insert into public.omr_student_start_credentials (
            organization_id, student_profile_id, start_code_hash
        ) values (
            'live-org-a', 'live-student-a',
            'pbkdf2-sha256:10000:08080808080808080808080808080808:9df12bc47d04bf0f520b627acee8c21c74b064b9f30fc943efaf7b2788e45e95'
        );
        raise exception 'post-withdraw service-role credential mutation unexpectedly succeeded';
    exception
        when check_violation then null;
    end;
end
$$;

select public.omr_save_roster_v2(
    'live-org-a',
    '[{"id":"live-class-a","organization_id":"live-org-a","name":"A반","status":"active","metadata":{}}]',
    '[{"id":"live-student-a","organization_id":"live-org-a","display_name":"학생 A 재등록","external_id":"A-001","status":"active","metadata":{}}]',
    '[{"class_id":"live-class-a","organization_id":"live-org-a","student_profile_id":"live-student-a","enrollment_status":"active"}]',
    '[{"id":"live-invite-a","organization_id":"live-org-a","email":"invite@example.com","sent_at":"2026-07-14T00:00:00.000Z","status":"pending"}]',
    coalesce((select (metadata->>'rosterRevision')::bigint from public.omr_organizations where id = 'live-org-a'), 0)
);

do $$
begin
    if exists (
        select 1 from public.omr_student_start_credentials
         where organization_id = 'live-org-a'
           and student_profile_id = 'live-student-a'
    ) then
        raise exception 're-adding a deterministic student id resurrected the old start credential';
    end if;
end
$$;

select public.omr_save_roster_v2(
    'live-org-a',
    '[{"id":"live-class-a","organization_id":"live-org-a","name":"A반","status":"active","metadata":{}}]',
    '[]',
    '[]',
    '[{"id":"live-invite-a","organization_id":"live-org-a","email":"invite@example.com","sent_at":"2026-07-14T00:00:00.000Z","status":"pending"}]',
    coalesce((select (metadata->>'rosterRevision')::bigint from public.omr_organizations where id = 'live-org-a'), 0)
);

do $$
begin
    begin
        insert into public.omr_student_start_credentials (
            organization_id, student_profile_id, start_code_hash
        ) values (
            'live-org-a', 'live-student-a',
            'pbkdf2-sha256:10000:09090909090909090909090909090909:adf12bc47d04bf0f520b627acee8c21c74b064b9f30fc943efaf7b2788e45e96'
        );
        raise exception 'withdraw-first serialized outcome accepted a credential';
    exception
        when check_violation then null;
    end;
end
$$;

select public.omr_save_roster_v2(
    'live-org-a',
    '[{"id":"live-class-a","organization_id":"live-org-a","name":"A반","status":"active","metadata":{}}]',
    '[{"id":"live-student-a","organization_id":"live-org-a","display_name":"학생 A 재등록","external_id":"A-001","status":"active","metadata":{}}]',
    '[{"class_id":"live-class-a","organization_id":"live-org-a","student_profile_id":"live-student-a","enrollment_status":"active"}]',
    '[{"id":"live-invite-a","organization_id":"live-org-a","email":"invite@example.com","sent_at":"2026-07-14T00:00:00.000Z","status":"pending"}]',
    coalesce((select (metadata->>'rosterRevision')::bigint from public.omr_organizations where id = 'live-org-a'), 0)
);

insert into public.omr_classes (id, organization_id, name) values
    ('live-class-b', 'live-org-b', 'B반');
insert into public.omr_student_profiles (id, organization_id, display_name) values
    ('live-student-b', 'live-org-b', '학생 B');

do $$
begin
    begin
        perform public.omr_save_roster_v2(
            'live-org-a',
            '[]',
            '[]',
            '[{"class_id":"live-class-b","organization_id":"live-org-a","student_profile_id":"live-student-b","enrollment_status":"active"}]',
            '[]',
            coalesce((select (metadata->>'rosterRevision')::bigint from public.omr_organizations where id = 'live-org-a'), 0)
        );
        raise exception 'cross-organization roster enrollment unexpectedly succeeded';
    exception
        when raise_exception then
            if sqlerrm = 'cross-organization roster enrollment unexpectedly succeeded' then
                raise;
            end if;
    end;

    if not exists (
        select 1 from public.omr_class_students
         where organization_id = 'live-org-a'
           and class_id = 'live-class-a'
           and student_profile_id = 'live-student-a'
           and enrollment_status = 'active'
    ) then
        raise exception 'failed roster RPC did not roll back its partial changes';
    end if;
end
$$;

insert into public.omr_attempts (
    id, organization_id, exam_id, student_name, student_id, identity_type,
    payload, started_at, finished_at
) values (
    'live-guest-attempt-a', 'live-org-a', 'live-exam-a', 'Guest A',
    'guest:live-guest-a', 'guest',
    '{
        "id":"live-guest-attempt-a",
        "guestId":"live-guest-a",
        "studentId":"guest:live-guest-a",
        "custom":{"preserved":true},
        "questionResults":[{
            "questionId":1,
            "studentId":"guest:live-guest-a",
            "status":"wrong",
            "analytics":{"skill":"fraction"}
        }]
    }',
    '2026-07-28T00:00:00.000Z', '2026-07-28T00:10:00.000Z'
);

insert into public.omr_question_results (
    id, organization_id, attempt_id, exam_id, student_name, student_id,
    identity_type, question_id, question_number, status, finished_at, payload
) values (
    'live-guest-attempt-a:1', 'live-org-a', 'live-guest-attempt-a',
    'live-exam-a', 'Guest A', 'guest:live-guest-a', 'guest', 1, 1, 'wrong',
    '2026-07-28T00:10:00.000Z',
    '{"questionId":1,"studentId":"guest:live-guest-a","analytics":{"skill":"fraction"}}'
);

do $$
declare
    acknowledged text[];
    attempt_payload jsonb;
    result_payload jsonb;
begin
    select public.omr_claim_guest_attempts_v1(
        'live-guest-a',
        'live-student-a',
        'live-org-a',
        'live-class-a',
        '학생 A',
        'A반',
        array['live-guest-attempt-a', 'live-local-only-a']
    ) into acknowledged;

    if acknowledged is distinct from array['live-guest-attempt-a']::text[] then
        raise exception 'guest claim must ACK only canonical attempt ids, got %', acknowledged;
    end if;

    select payload into attempt_payload
      from public.omr_attempts
     where id = 'live-guest-attempt-a';
    select payload into result_payload
      from public.omr_question_results
     where id = 'live-guest-attempt-a:1';

    if attempt_payload->>'studentId' <> 'live-student-a'
        or attempt_payload ? 'guestId'
        or attempt_payload#>>'{questionResults,0,studentId}' <> 'live-student-a'
        or attempt_payload#>>'{questionResults,0,analytics,skill}' <> 'fraction'
        or attempt_payload#>>'{custom,preserved}' <> 'true'
    then
        raise exception 'guest claim did not preserve and rewrite nested attempt payload: %', attempt_payload;
    end if;
    if result_payload->>'studentId' <> 'live-student-a'
        or result_payload#>>'{analytics,skill}' <> 'fraction'
    then
        raise exception 'guest claim did not preserve and rewrite result payload: %', result_payload;
    end if;

    select public.omr_claim_guest_attempts_v1(
        'live-guest-a',
        'live-student-a',
        'live-org-a',
        'live-class-a',
        '학생 A',
        'A반',
        array['live-guest-attempt-a']
    ) into acknowledged;
    if acknowledged is distinct from array['live-guest-attempt-a']::text[] then
        raise exception 'guest claim retry must remain idempotently acknowledged';
    end if;
end
$$;

update public.omr_student_profiles
   set user_id = '33333333-3333-4333-8333-333333333333'
 where id = 'live-student-a'
   and organization_id = 'live-org-a';

insert into public.omr_assignments (
    id, organization_id, exam_id, class_id, title, access_mode, status
) values (
    'live-assignment-a', 'live-org-a', 'live-exam-a', 'live-class-a',
    'Live Assignment', 'class', 'open'
);

insert into public.omr_assignment_submissions (
    id, organization_id, assignment_id, exam_id, student_profile_id,
    student_user_id, status, score, total_score
) values (
    'live-submission-a', 'live-org-a', 'live-assignment-a', 'live-exam-a',
    'live-student-a', '33333333-3333-4333-8333-333333333333',
    'graded', 1, 1
);

reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', '33333333-3333-4333-8333-333333333333', false);

do $$
begin
    begin
        update public.omr_assignment_submissions
           set score = 999,
               status = 'submitted'
         where id = 'live-submission-a';
        raise exception 'authenticated assignment submission UPDATE unexpectedly succeeded';
    exception when insufficient_privilege then null;
    end;
end
$$;

reset role;

-- Historical aggregate tests below predate the revision protocol. Route them
-- through a test-only adapter that supplies the current revision and a fresh
-- mutation id; the dedicated CAS assertion file tests stale writes and replay
-- semantics directly. Browser roles never receive this adapter.
create function public.omr_live_save_exam_v2(
    p_exam jsonb,
    p_questions jsonb,
    p_teacher_asset_intent_ids jsonb default '[]'::jsonb,
    p_asset_actor_user_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_expected_revision bigint;
begin
    select exam.revision into v_expected_revision
      from public.omr_exams exam
     where exam.id = p_exam->>'id'
       and exam.organization_id = p_exam->>'organization_id';
    return public.omr_save_exam_v2(
        p_exam,
        p_questions,
        p_teacher_asset_intent_ids,
        p_asset_actor_user_id,
        coalesce(v_expected_revision, 0),
        'live-legacy-' || pg_catalog.md5(
            pg_catalog.clock_timestamp()::text || ':'
            || coalesce(p_exam->>'id', '') || ':'
            || pg_catalog.txid_current()::text
        )
    );
end;
$$;
revoke all on function public.omr_live_save_exam_v2(jsonb,jsonb,jsonb,text)
    from public, anon, authenticated;
grant execute on function public.omr_live_save_exam_v2(jsonb,jsonb,jsonb,text)
    to service_role;

create function public.omr_live_enqueue_cleanup_v1(
    p_organization_id text,
    p_exam_id text,
    p_asset_kind text,
    p_source_table text,
    p_source_id text,
    p_storage_bucket text,
    p_object_path text,
    p_reason text
)
returns void
language sql
security definer
set search_path = ''
as $$
    select public.omr_enqueue_remote_asset_cleanup_v1(
        p_organization_id, p_exam_id, p_asset_kind, p_source_table,
        p_source_id, p_storage_bucket, p_object_path, p_reason
    )
$$;
revoke all on function public.omr_live_enqueue_cleanup_v1(text,text,text,text,text,text,text,text)
    from public, anon, authenticated;
grant execute on function public.omr_live_enqueue_cleanup_v1(text,text,text,text,text,text,text,text)
    to service_role;

set role service_role;

do $$
begin
    if not exists (
        select 1
          from public.omr_assignment_submissions
         where id = 'live-submission-a'
           and score = 1
           and status = 'graded'
    ) then
        raise exception 'authenticated assignment submission denial mutated canonical gradebook row';
    end if;
end
$$;

select public.omr_live_save_exam_v2(
    '{
        "id":"live-exam-gateway",
        "organization_id":"live-org-a",
        "title":"Gateway Exam",
        "payload":{"id":"live-exam-gateway","title":"Gateway Exam","questions":[{"id":1,"number":1,"answer":2,"score":1}],"createdAt":"2026-07-14T00:00:00.000Z"},
        "created_by_user_id":"11111111-1111-4111-8111-111111111111",
        "created_at":"2026-07-14T00:00:00.000Z",
        "updated_at":"2026-07-14T00:00:00.000Z",
        "archived":false
    }',
    '[{
        "id":"live-exam-gateway:1",
        "organization_id":"live-org-a",
        "exam_id":"live-exam-gateway",
        "question_id":1,
        "question_number":1,
        "canonical_question_id":"live-exam-gateway:1",
        "choices":5,
        "correct_answer":2,
        "score":1,
        "payload":{"id":1,"number":1,"answer":2,"score":1},
        "updated_at":"2026-07-14T00:00:00.000Z"
    }]'
);

do $$
begin
    if (select count(*) from public.omr_exams where id = 'live-exam-gateway') <> 1
        or (select count(*) from public.omr_exam_questions where exam_id = 'live-exam-gateway') <> 1
    then
        raise exception 'teacher exam RPC did not persist the canonical aggregate';
    end if;

    begin
        perform public.omr_live_save_exam_v2(
            '{
                "id":"live-exam-rollback",
                "organization_id":"live-org-a",
                "title":"Rollback Exam",
                "payload":{"id":"live-exam-rollback","title":"Rollback Exam","questions":[],"createdAt":"2026-07-14T00:00:00.000Z"},
                "created_at":"2026-07-14T00:00:00.000Z",
                "updated_at":"2026-07-14T00:00:00.000Z"
            }',
            '[{"exam_id":"wrong-exam","organization_id":"live-org-a"}]'
        );
        raise exception 'cross-scope teacher save unexpectedly succeeded';
    exception
        when raise_exception then
            if sqlerrm = 'cross-scope teacher save unexpectedly succeeded' then
                raise;
            end if;
    end;

    if exists (select 1 from public.omr_exams where id = 'live-exam-rollback') then
        raise exception 'failed teacher RPC left a partial exam';
    end if;

    begin
        perform public.omr_live_save_exam_v2(
            '{
                "id":"live-exam-b",
                "organization_id":"live-org-a",
                "title":"Cross-org takeover",
                "payload":{"id":"live-exam-b","title":"Cross-org takeover","questions":[]},
                "updated_at":"2026-07-14T00:00:00.000Z"
            }',
            '[]'
        );
        raise exception 'cross-organization exam identifier takeover unexpectedly succeeded';
    exception
        when raise_exception then
            if sqlerrm = 'cross-organization exam identifier takeover unexpectedly succeeded' then
                raise;
            end if;
    end;

    if not exists (
        select 1 from public.omr_exams
         where id = 'live-exam-b'
           and organization_id = 'live-org-b'
           and title = 'Org B Exam'
    ) then
        raise exception 'failed cross-organization save mutated the existing exam';
    end if;
end
$$;

select * from public.omr_submit_attempt_v1(
    'live-ticket-1',
    '{
        "id":"attempt_live-ticket-1",
        "organization_id":"live-org-a",
        "exam_id":"live-exam-a",
        "student_name":"Live Student",
        "student_id":"live-student-owner",
        "status":"completed",
        "score":1,
        "total_score":1,
        "score_percent":100,
        "retake_question_ids":[],
        "payload":{"id":"attempt_live-ticket-1","examId":"live-exam-a","studentName":"Live Student","score":1,"totalScore":1,"startedAt":"2026-07-14T00:00:00.000Z","finishedAt":"2026-07-14T00:01:00.000Z"},
        "started_at":"2026-07-14T00:00:00.000Z",
        "finished_at":"2026-07-14T00:01:00.000Z"
    }',
    '[{
        "id":"attempt_live-ticket-1:1",
        "organization_id":"live-org-a",
        "attempt_id":"attempt_live-ticket-1",
        "exam_id":"live-exam-a",
        "student_name":"Live Student",
        "student_id":"live-student-owner",
        "question_id":1,
        "question_number":1,
        "mistake_types":[],
        "prerequisites":[],
        "status":"correct",
        "is_correct":true,
        "is_wrong":false,
        "is_unanswered":false,
        "score":1,
        "earned_score":1,
        "finished_at":"2026-07-14T00:01:00.000Z",
        "payload":{"questionId":1,"status":"correct"},
        "created_at":"2026-07-14T00:01:00.000Z",
        "updated_at":"2026-07-14T00:01:00.000Z"
    }]'
);

select * from public.omr_submit_attempt_v1(
    'live-ticket-1',
    '{
        "id":"attempt_live-ticket-1",
        "organization_id":"live-org-a",
        "exam_id":"live-exam-a",
        "student_name":"Live Student",
        "student_id":"live-student-owner",
        "status":"completed",
        "score":1,
        "total_score":1,
        "score_percent":100,
        "retake_question_ids":[],
        "payload":{"id":"attempt_live-ticket-1","examId":"live-exam-a","studentName":"Live Student","score":1,"totalScore":1,"startedAt":"2026-07-14T00:00:00.000Z","finishedAt":"2026-07-14T00:01:00.000Z"},
        "started_at":"2026-07-14T00:00:00.000Z",
        "finished_at":"2026-07-14T00:01:00.000Z"
    }',
    '[]'
);

do $$
begin
    if (select count(*) from public.omr_attempts where ticket_id = 'live-ticket-1') <> 1 then
        raise exception 'attempt RPC is not idempotent';
    end if;
    if (select count(*) from public.omr_question_results where attempt_id = 'attempt_live-ticket-1') <> 1 then
        raise exception 'question results were duplicated or lost';
    end if;
end
$$;

select * from public.omr_submit_session_attempt_v1(
    (select to_jsonb(attempt) from public.omr_attempts attempt where id = 'attempt_live-ticket-1'),
    (select coalesce(jsonb_agg(to_jsonb(result)), '[]'::jsonb)
       from public.omr_question_results result
      where attempt_id = 'attempt_live-ticket-1')
);

do $$
begin
    begin
        perform public.omr_submit_attempt_v1(
            'live-ticket-rollback',
            '{
                "id":"attempt_live-ticket-rollback",
                "organization_id":"live-org-a",
                "exam_id":"live-exam-a",
                "student_name":"Rollback Student",
                "status":"completed",
                "score":0,
                "total_score":1,
                "score_percent":0,
                "retake_question_ids":[],
                "payload":{},
                "started_at":"2026-07-14T00:00:00.000Z",
                "finished_at":"2026-07-14T00:01:00.000Z"
            }',
            '[{"attempt_id":"wrong-attempt","exam_id":"live-exam-a","organization_id":"live-org-a"}]'
        );
        raise exception 'invalid result scope unexpectedly succeeded';
    exception
        when raise_exception then
            if sqlerrm = 'invalid result scope unexpectedly succeeded' then
                raise;
            end if;
    end;

    if exists (select 1 from public.omr_attempts where ticket_id = 'live-ticket-rollback') then
        raise exception 'failed RPC left a partial attempt row';
    end if;

    begin
        perform public.omr_submit_attempt_v1(
            'live-ticket-null-results',
            '{
                "id":"attempt_live-ticket-null-results",
                "organization_id":"live-org-a",
                "exam_id":"live-exam-a",
                "student_name":"Null Results Student",
                "status":"completed",
                "score":0,
                "total_score":1,
                "score_percent":0,
                "retake_question_ids":[],
                "payload":{},
                "started_at":"2026-07-14T00:00:00.000Z",
                "finished_at":"2026-07-14T00:01:00.000Z"
            }',
            null::jsonb
        );
        raise exception 'null question-result payload unexpectedly succeeded';
    exception
        when raise_exception then
            if sqlerrm = 'null question-result payload unexpectedly succeeded' then
                raise;
            end if;
    end;

    if exists (select 1 from public.omr_attempts where ticket_id = 'live-ticket-null-results') then
        raise exception 'rejected null result payload left a partial attempt row';
    end if;
end
$$;

update public.omr_attempts
   set status = 'in_progress',
       class_id = 'live-class-a',
       score = 0,
       total_score = 0,
       score_percent = 0,
       payload = payload || '{
           "status":"in_progress",
           "classId":"live-class-a",
           "answers":{"1":2},
           "score":0,
           "totalScore":0,
           "questionResults":[
               {"questionId":1,"questionNumber":1},
               {"questionId":2,"questionNumber":2}
           ],
           "studentQuestions":[
               {
                   "questionId":1,
                   "questionNumber":1,
                   "body":"왜 정답인가요?",
                   "createdAt":"2026-07-14T00:01:00.000Z",
                   "status":"queued"
               },
               {
                   "questionId":2,
                   "questionNumber":2,
                   "body":"보존할 질문",
                   "createdAt":"2026-07-14T00:00:00.000Z",
                   "status":"answered",
                   "answer":{"body":"보존할 답변","createdAt":"2026-07-14T00:00:30.000Z"}
               }
           ],
           "subQuestionAnswers":{
               "1":{
                   "reason":{
                       "schemaVersion":1,
                       "body":"근거",
                       "reviewStatus":"needs_review"
                   }
               }
           }
       }'::jsonb
 where id = 'attempt_live-ticket-1'
   and organization_id = 'live-org-a';

insert into public.omr_class_teachers (
    class_id, organization_id, teacher_user_id, class_role
) values
    ('live-class-a', 'live-org-a', 'live-teacher-assigned', 'grader'),
    ('live-class-b', 'live-org-b', 'live-teacher-cross-class', 'grader');

do $$
declare
    v_unrelated_question jsonb;
begin
    select item
      into v_unrelated_question
      from public.omr_attempts attempt,
           pg_catalog.jsonb_array_elements(attempt.payload -> 'studentQuestions') item
     where attempt.id = 'attempt_live-ticket-1'
       and item ->> 'questionId' = '2';

    perform public.omr_upsert_student_attempt_question_v1(
        'live-org-a',
        'live-student-owner',
        'attempt_live-ticket-1',
        1,
        '왜 정답인가요?',
        'live-question-mutation-1'
    );
    if (select item
          from public.omr_attempts attempt,
               pg_catalog.jsonb_array_elements(attempt.payload -> 'studentQuestions') item
         where attempt.id = 'attempt_live-ticket-1'
           and item ->> 'questionId' = '2') is distinct from v_unrelated_question
    then
        raise exception 'student question mutation changed an unrelated question';
    end if;

    begin
        perform public.omr_upsert_student_attempt_question_v1(
            'live-org-a',
            'other-student',
            'attempt_live-ticket-1',
            1,
            '소유권 위반',
            'live-question-cross-owner'
        );
        raise exception 'cross-owner student question unexpectedly succeeded';
    exception
        when raise_exception then
            if sqlerrm = 'cross-owner student question unexpectedly succeeded' then
                raise;
            end if;
    end;
end
$$;

do $$
begin
    begin
        perform public.omr_answer_attempt_question_v1(
            'live-org-a',
            'attempt_live-ticket-1',
            '1',
            'unassigned',
            'live-teacher-unassigned',
            'teacher',
            '미배정 교사'
        );
        raise exception 'unassigned teacher mutation unexpectedly succeeded';
    exception
        when raise_exception then
            if sqlerrm = 'unassigned teacher mutation unexpectedly succeeded' then
                raise;
            end if;
    end;
    begin
        perform public.omr_answer_attempt_question_v1(
            'live-org-a',
            'attempt_live-ticket-1',
            '1',
            'cross class',
            'live-teacher-cross-class',
            'teacher',
            '다른 반 교사'
        );
        raise exception 'cross-class teacher mutation unexpectedly succeeded';
    exception
        when raise_exception then
            if sqlerrm = 'cross-class teacher mutation unexpectedly succeeded' then
                raise;
            end if;
    end;
end
$$;

select * from public.omr_answer_attempt_question_v1(
    'live-org-a',
    'attempt_live-ticket-1',
    '1',
    '첫 답변',
    'live-teacher-assigned',
    'teacher',
    '담당 교사'
);

do $$
begin
    perform public.omr_upsert_student_attempt_question_v1(
        'live-org-a',
        'live-student-owner',
        'attempt_live-ticket-1',
        1,
        '왜 정답인가요?',
        'live-question-mutation-1'
    );
    if (select item #>> '{answer,body}'
          from public.omr_attempts attempt,
               pg_catalog.jsonb_array_elements(attempt.payload -> 'studentQuestions') item
         where attempt.id = 'attempt_live-ticket-1'
           and item ->> 'questionId' = '1') <> '첫 답변'
    then
        raise exception 'student question retry lost the concurrent teacher answer';
    end if;
end
$$;

do $$
declare
    v_answered_at jsonb;
begin
    select payload #> '{studentQuestions,0,answer,createdAt}'
      into v_answered_at
      from public.omr_attempts
     where id = 'attempt_live-ticket-1';

    perform public.omr_answer_attempt_question_v1(
        'live-org-a',
        'attempt_live-ticket-1',
        '1',
        '첫 답변',
        'live-teacher-assigned',
        'teacher',
        '담당 교사'
    );
    if (select payload #> '{studentQuestions,0,answer,createdAt}'
          from public.omr_attempts
         where id = 'attempt_live-ticket-1') is distinct from v_answered_at
    then
        raise exception 'answer retry changed the authoritative timestamp';
    end if;
    if (select payload #>> '{studentQuestions,0,answer,body}'
          from public.omr_attempts
         where id = 'attempt_live-ticket-1') <> '첫 답변'
    then
        raise exception 'scoped answer RPC did not update the selected question';
    end if;
    if (select payload #>> '{studentQuestions,0,answer,teacherName}'
          from public.omr_attempts
         where id = 'attempt_live-ticket-1') <> '담당 교사'
    then
        raise exception 'scoped answer RPC did not persist trusted attribution';
    end if;
    begin
        perform public.omr_answer_attempt_question_v1(
            'live-org-b',
            'attempt_live-ticket-1',
            '1',
            'cross organization',
            '22222222-2222-4222-8222-222222222222',
            'owner',
            'Org B Owner'
        );
        raise exception 'cross-organization teacher answer unexpectedly succeeded';
    exception
        when raise_exception then
            if sqlerrm = 'cross-organization teacher answer unexpectedly succeeded' then
                raise;
            end if;
    end;
end
$$;

update public.omr_class_teachers
   set class_role = 'viewer'
 where class_id = 'live-class-a'
   and teacher_user_id = 'live-teacher-assigned';
do $$
begin
    begin
        perform public.omr_answer_attempt_question_v1(
            'live-org-a',
            'attempt_live-ticket-1',
            '1',
            'downgraded role',
            'live-teacher-assigned',
            'teacher',
            '담당 교사'
        );
        raise exception 'role downgrade did not revoke teacher attempt mutation';
    exception
        when raise_exception then
            if sqlerrm = 'role downgrade did not revoke teacher attempt mutation' then
                raise;
            end if;
    end;
end
$$;
update public.omr_class_teachers
   set class_role = 'grader'
 where class_id = 'live-class-a'
   and teacher_user_id = 'live-teacher-assigned';

select * from public.omr_set_subquestion_review_v1(
    'live-org-a',
    'attempt_live-ticket-1',
    '1:reason',
    'reviewed',
    'live-teacher-assigned',
    'teacher',
    '담당 교사'
);

update public.omr_exams
   set payload = '{
       "id":"live-exam-a",
       "organizationId":"live-org-a",
       "title":"Org A Exam",
       "questions":[
           {"id":1,"number":1,"answer":2,"score":4,"choices":5},
           {"id":2,"number":2,"answer":3,"score":6,"choices":5}
       ],
       "createdAt":"2026-07-14T00:00:00.000Z"
   }'::jsonb,
       updated_at = '2026-07-14T00:01:30.000Z'
 where id = 'live-exam-a'
   and organization_id = 'live-org-a';

select * from public.omr_force_finish_attempts_v1(
    'live-org-a',
    array['attempt_live-ticket-1'],
    '2026-07-14T00:02:00.000Z',
    'live-teacher-assigned',
    'teacher',
    '담당 교사',
    jsonb_build_array(jsonb_build_object(
        'attempt_id', 'attempt_live-ticket-1',
        'expected_answers', '{"1":2}'::jsonb,
        'expected_is_retake', false,
        'expected_retake_question_ids', '[]'::jsonb,
        'expected_exam_updated_at', '2026-07-14T00:01:30.000Z',
        'score', 4,
        'total_score', 10,
        'question_results', '[
            {"questionId":1,"questionNumber":1,"status":"correct","score":4,"earnedScore":4},
            {"questionId":2,"questionNumber":2,"status":"unanswered","score":6,"earnedScore":0}
        ]'::jsonb,
        'question_result_rows', '[
            {
                "id":"attempt_live-ticket-1:1",
                "organization_id":"live-org-a",
                "class_id":"live-class-a",
                "attempt_id":"attempt_live-ticket-1",
                "exam_id":"live-exam-a",
                "student_name":"Live Student",
                "student_id":"live-student-owner",
                "question_id":1,
                "question_number":1,
                "mistake_types":[],
                "prerequisites":[],
                "selected_answer":2,
                "correct_answer":2,
                "status":"correct",
                "is_correct":true,
                "is_wrong":false,
                "is_unanswered":false,
                "score":4,
                "earned_score":4,
                "finished_at":"2026-07-14T00:02:00.000Z",
                "payload":{"questionId":1,"status":"correct"},
                "created_at":"2026-07-14T00:02:00.000Z",
                "updated_at":"2026-07-14T00:02:00.000Z"
            },
            {
                "id":"attempt_live-ticket-1:2",
                "organization_id":"live-org-a",
                "class_id":"live-class-a",
                "attempt_id":"attempt_live-ticket-1",
                "exam_id":"live-exam-a",
                "student_name":"Live Student",
                "student_id":"live-student-owner",
                "question_id":2,
                "question_number":2,
                "mistake_types":[],
                "prerequisites":[],
                "correct_answer":3,
                "status":"unanswered",
                "is_correct":false,
                "is_wrong":false,
                "is_unanswered":true,
                "score":6,
                "earned_score":0,
                "finished_at":"2026-07-14T00:02:00.000Z",
                "payload":{"questionId":2,"status":"unanswered"},
                "created_at":"2026-07-14T00:02:00.000Z",
                "updated_at":"2026-07-14T00:02:00.000Z"
            }
        ]'::jsonb
    ))
);

do $$
declare
    v_first_finished_at timestamptz;
begin
    if (select status from public.omr_attempts where id = 'attempt_live-ticket-1') <> 'completed' then
        raise exception 'force finish did not complete the selected attempt';
    end if;
    if (select score from public.omr_attempts where id = 'attempt_live-ticket-1') <> 4
        or (select total_score from public.omr_attempts where id = 'attempt_live-ticket-1') <> 10
    then
        raise exception 'force finish did not persist canonical grading';
    end if;
    if (select student_id from public.omr_attempts where id = 'attempt_live-ticket-1') <> 'live-student-owner' then
        raise exception 'scoped teacher mutation changed the canonical student';
    end if;
    if (select count(*) from public.omr_question_results where attempt_id = 'attempt_live-ticket-1') <> 2
        or (select status from public.omr_question_results where id = 'attempt_live-ticket-1:1') <> 'correct'
        or (select status from public.omr_question_results where id = 'attempt_live-ticket-1:2') <> 'unanswered'
    then
        raise exception 'force finish did not replace canonical question results';
    end if;
    if (select payload #>> '{subQuestionAnswers,1,reason,reviewStatus}'
          from public.omr_attempts
         where id = 'attempt_live-ticket-1') <> 'reviewed'
    then
        raise exception 'subquestion review RPC did not update the selected response';
    end if;
    if (select payload #>> '{subQuestionAnswers,1,reason,reviewedBy}'
          from public.omr_attempts
         where id = 'attempt_live-ticket-1') <> '담당 교사'
    then
        raise exception 'subquestion review RPC did not persist trusted attribution';
    end if;

    select finished_at into v_first_finished_at
      from public.omr_attempts
     where id = 'attempt_live-ticket-1';
    perform public.omr_force_finish_attempts_v1(
        'live-org-a',
        array['attempt_live-ticket-1'],
        '2026-07-14T00:03:00.000Z',
        'live-teacher-assigned',
        'teacher',
        '담당 교사',
        jsonb_build_array(jsonb_build_object(
            'attempt_id', 'attempt_live-ticket-1',
            'expected_answers', '{"1":2}'::jsonb,
            'expected_is_retake', false,
            'expected_retake_question_ids', '[]'::jsonb,
            'expected_exam_updated_at', '2026-07-14T00:01:30.000Z',
            'score', 0,
            'total_score', 0,
            'question_results', '[]'::jsonb,
            'question_result_rows', '[]'::jsonb
        ))
    );
    if (select finished_at from public.omr_attempts where id = 'attempt_live-ticket-1') is distinct from v_first_finished_at
        or (select score from public.omr_attempts where id = 'attempt_live-ticket-1') <> 4
        or (select count(*) from public.omr_question_results where attempt_id = 'attempt_live-ticket-1') <> 2
    then
        raise exception 'force finish retry changed canonical completion';
    end if;
end
$$;

update public.omr_attempts
   set student_profile_id = 'live-student-a'
 where id = 'attempt_live-ticket-1'
   and organization_id = 'live-org-a';

-- Workspace bootstrap can update display metadata but never canonical billing.
update public.omr_organizations set plan = 'pro' where id = 'live-org-a';
select public.omr_bootstrap_workspace_organization_v1(
    'live-org-a', 'Renamed live org', '{"source":"live-bootstrap"}', now()
);
do $$
begin
    if (select plan from public.omr_organizations where id = 'live-org-a') <> 'pro' then
        raise exception 'workspace bootstrap overwrote a paid plan';
    end if;
    if pg_catalog.to_regclass('public.omr_feedback_mutations_created_idx') is null
       or pg_catalog.to_regclass('public.omr_feedback_mutations_org_kind_created_idx') is null then
        raise exception 'feedback mutation retention indexes are missing';
    end if;
end
$$;

-- Core text feedback remains available on Free, including return and read
-- receipt. Markup drawings and annotated-PDF policy remain paid boundaries.
update public.omr_organizations set plan = 'free' where id = 'live-org-a';
do $$
begin
    perform public.omr_save_feedback_v3(
        'live-org-a',
        '{"id":"feedback:free-core","organization_id":"live-org-a","attempt_id":"attempt_live-ticket-1","exam_id":"live-exam-a","student_profile_id":"live-student-a","status":"draft","summary":"Free core feedback","question_comments":[{"id":"free-c1","questionId":1,"questionNumber":1,"body":"Review this answer","visibility":"student_visible"}],"download_policy":{"allowStudentDownload":false,"allowAnnotatedPdfDownload":false,"watermarkStudentName":true},"payload":{"id":"feedback:free-core","attemptId":"attempt_live-ticket-1","examId":"live-exam-a","studentProfileId":"live-student-a","status":"draft","summary":"Free core feedback","questionComments":[{"id":"free-c1","questionId":1,"questionNumber":1,"body":"Review this answer","visibility":"student_visible"}],"downloadPolicy":{"allowStudentDownload":false,"allowAnnotatedPdfDownload":false,"watermarkStudentName":true},"delivery":{"notificationStatus":"not_queued","notificationChannel":"in_app","openCount":0},"createdAt":"2026-07-14T00:02:00.000Z","updatedAt":"2026-07-14T00:02:00.000Z"},"created_at":"2026-07-14T00:02:00.000Z","updated_at":"2026-07-14T00:02:00.000Z"}',
        0,
        'live-free-core-save'
    );
    if not exists (
        select 1 from public.omr_attempt_feedback
         where id = 'feedback:free-core'
           and summary = 'Free core feedback'
           and question_comments #>> '{0,body}' = 'Review this answer'
           and revision = 1
    ) then
        raise exception 'free core feedback save did not persist bounded text and comments';
    end if;

    perform public.omr_return_feedback_v3(
        'live-org-a', 'feedback:free-core', 1, 'live-free-core-return'
    );
    if not exists (
        select 1 from public.omr_attempt_feedback
         where id = 'feedback:free-core' and status = 'returned'
           and revision = 2 and notification_status = 'queued'
    ) then
        raise exception 'free core feedback return did not queue the in-app notification';
    end if;

    perform public.omr_mark_feedback_opened_v2(
        'live-org-a', 'live-student-a', 'feedback:free-core', '2026-07-14T00:02:30.000Z'
    );
    if not exists (
        select 1 from public.omr_attempt_feedback
         where id = 'feedback:free-core' and open_count = 1
           and first_opened_at = '2026-07-14T00:02:30.000Z'
    ) then
        raise exception 'free core feedback read receipt was not persisted';
    end if;

    delete from public.omr_attempt_feedback where id = 'feedback:free-core';

    begin
        perform public.omr_save_feedback_v3(
            'live-org-a',
            '{"id":"feedback:free-markup-denied","organization_id":"live-org-a","attempt_id":"attempt_live-ticket-1","exam_id":"live-exam-a","student_profile_id":"live-student-a","status":"draft","markup_drawings":{"1":["M 0 0 L 1 1"]},"download_policy":{"allowAnnotatedPdfDownload":false},"payload":{}}',
            0,
            'live-free-markup-denied'
        );
        raise exception 'free feedback markup unexpectedly succeeded';
    exception when raise_exception then
        if sqlerrm = 'free feedback markup unexpectedly succeeded' then raise; end if;
        if sqlerrm <> 'plan entitlement required' then raise; end if;
    end;

    begin
        perform public.omr_save_feedback_v3(
            'live-org-a',
            '{"id":"feedback:free-annotated-denied","organization_id":"live-org-a","attempt_id":"attempt_live-ticket-1","exam_id":"live-exam-a","student_profile_id":"live-student-a","status":"draft","download_policy":{"allowAnnotatedPdfDownload":true},"payload":{}}',
            0,
            'live-free-annotated-denied'
        );
        raise exception 'free annotated PDF policy unexpectedly succeeded';
    exception when raise_exception then
        if sqlerrm = 'free annotated PDF policy unexpectedly succeeded' then raise; end if;
        if sqlerrm <> 'plan entitlement required' then raise; end if;
    end;

    if exists (
        select 1 from public.omr_attempt_feedback
         where id in ('feedback:free-markup-denied', 'feedback:free-annotated-denied')
    ) then
        raise exception 'free premium feedback denial persisted a row';
    end if;
end
$$;

update public.omr_organizations set plan = 'pro' where id = 'live-org-a';

-- The database boundary rejects a single oversized vector path before creating
-- canonical feedback or an idempotency receipt.
do $$
begin
    begin
        perform public.omr_save_feedback_v2(
            'live-org-a',
            pg_catalog.jsonb_build_object(
                'id', 'feedback:oversized-denied',
                'organization_id', 'live-org-a',
                'attempt_id', 'attempt_live-ticket-1',
                'exam_id', 'live-exam-a',
                'student_profile_id', 'live-student-a',
                'status', 'draft',
                'markup_drawings', pg_catalog.jsonb_build_object(
                    '1', pg_catalog.jsonb_build_array(pg_catalog.repeat('M', 65537))
                ),
                'payload', '{}'::jsonb
            ),
            0,
            'live-feedback-oversized-denied'
        );
        raise exception 'oversized feedback markup unexpectedly succeeded';
    exception when raise_exception then
        if sqlerrm = 'oversized feedback markup unexpectedly succeeded' then raise; end if;
        if sqlerrm <> 'feedback markup shape exceeds limit' then raise; end if;
    end;
end
$$;

reset role;
do $$
begin
    if exists (
        select 1 from public.omr_attempt_feedback where id = 'feedback:oversized-denied'
    ) or exists (
        select 1 from public.omr_feedback_mutations
         where mutation_id = 'live-feedback-oversized-denied'
    ) then
        raise exception 'oversized feedback markup crossed the canonical boundary';
    end if;
end
$$;
set role service_role;

select public.omr_save_feedback_v2(
    'live-org-a',
    '{
        "id":"feedback:attempt_live-ticket-1",
        "organization_id":"live-org-a",
        "attempt_id":"attempt_live-ticket-1",
        "exam_id":"live-exam-a",
        "student_profile_id":"live-student-a",
        "teacher_user_id":"11111111-1111-4111-8111-111111111111",
        "status":"draft",
        "summary":"Live feedback",
        "question_comments":[{"id":"c1","questionId":1,"questionNumber":1,"body":"Review","visibility":"student_visible"}],
        "markup_drawings":{"1":["M 0 0 L 1 1"]},
        "download_policy":{"allowStudentDownload":false,"allowAnnotatedPdfDownload":false,"watermarkStudentName":true},
        "notification_status":"not_queued",
        "notification_channel":"in_app",
        "open_count":0,
        "payload":{"id":"feedback:attempt_live-ticket-1","attemptId":"attempt_live-ticket-1","examId":"live-exam-a","studentProfileId":"live-student-a","status":"draft","questionComments":[],"downloadPolicy":{"allowStudentDownload":false,"allowAnnotatedPdfDownload":false,"watermarkStudentName":true},"delivery":{"notificationStatus":"not_queued","notificationChannel":"in_app","openCount":0},"createdAt":"2026-07-14T00:02:00.000Z","updatedAt":"2026-07-14T00:02:00.000Z"},
        "created_at":"2026-07-14T00:02:00.000Z",
        "updated_at":"2026-07-14T00:02:00.000Z"
    }',
    0,
    'live-feedback-save-1'
);

do $$
declare
    v_replayed jsonb;
begin
    v_replayed := public.omr_save_feedback_v2(
        'live-org-a',
        '{
            "id":"feedback:attempt_live-ticket-1",
            "organization_id":"live-org-a",
            "attempt_id":"attempt_live-ticket-1",
            "exam_id":"live-exam-a",
            "student_profile_id":"live-student-a",
            "teacher_user_id":"11111111-1111-4111-8111-111111111111",
            "status":"draft",
            "summary":"Live feedback",
            "question_comments":[{"id":"c1","questionId":1,"questionNumber":1,"body":"Review","visibility":"student_visible"}],
            "markup_drawings":{"1":["M 0 0 L 1 1"]},
            "download_policy":{"allowStudentDownload":false,"allowAnnotatedPdfDownload":false,"watermarkStudentName":true},
            "notification_status":"not_queued",
            "notification_channel":"in_app",
            "open_count":0,
            "payload":{"id":"feedback:attempt_live-ticket-1","attemptId":"attempt_live-ticket-1","examId":"live-exam-a","studentProfileId":"live-student-a","status":"draft","questionComments":[],"downloadPolicy":{"allowStudentDownload":false,"allowAnnotatedPdfDownload":false,"watermarkStudentName":true},"delivery":{"notificationStatus":"not_queued","notificationChannel":"in_app","openCount":0},"createdAt":"2026-07-14T00:02:00.000Z","updatedAt":"2099-01-01T00:00:00.000Z"},
            "created_at":"2026-07-14T00:02:00.000Z",
            "updated_at":"2099-01-01T00:00:00.000Z"
        }',
        0,
        'live-feedback-save-1'
    );
    if v_replayed ->> 'status' <> 'saved'
       or (v_replayed ->> 'revision')::bigint <> 1 then
        raise exception 'feedback save response-loss replay was not idempotent';
    end if;
end
$$;

reset role;
do $$
begin
    if exists (
        select 1 from public.omr_feedback_mutations mutation
         where mutation.organization_id = 'live-org-a'
           and mutation.mutation_kind = 'save'
           and mutation.mutation_id = 'live-feedback-save-1'
           and mutation.response #> '{feedback,markup_drawings}' is not null
    ) then
        raise exception 'feedback receipt duplicated markup drawings';
    end if;
end
$$;
set role service_role;

do $$
begin
    if not exists (
        select 1 from public.omr_attempt_feedback
         where id = 'feedback:attempt_live-ticket-1'
           and organization_id = 'live-org-a'
           and student_profile_id = 'live-student-a'
           and status = 'draft'
           and revision = 1
           and markup_drawings #>> '{1,0}' = 'M 0 0 L 1 1'
    ) then
        raise exception 'feedback save RPC did not persist the scoped draft';
    end if;

    begin
        perform public.omr_save_feedback_v2(
            'live-org-b',
            '{"id":"feedback:cross-org","organization_id":"live-org-b","attempt_id":"attempt_live-ticket-1","exam_id":"live-exam-a","student_profile_id":"live-student-a","status":"draft","payload":{}}',
            0,
            'live-feedback-cross-org'
        );
        raise exception 'cross-organization feedback save unexpectedly succeeded';
    exception
        when raise_exception then
            if sqlerrm = 'cross-organization feedback save unexpectedly succeeded' then
                raise;
            end if;
    end;
end
$$;

select public.omr_return_feedback_v2(
    'live-org-a',
    'feedback:attempt_live-ticket-1',
    1,
    'live-feedback-return-1'
);

do $$
declare
    v_replayed jsonb;
begin
    v_replayed := public.omr_return_feedback_v2(
        'live-org-a', 'feedback:attempt_live-ticket-1', 1, 'live-feedback-return-1'
    );
    if v_replayed ->> 'status' <> 'returned'
       or (v_replayed ->> 'revision')::bigint <> 2 then
        raise exception 'feedback return response-loss replay was not idempotent';
    end if;
end
$$;

do $$
declare
    wrong_student_result public.omr_attempt_feedback;
begin
    select public.omr_mark_feedback_opened_v2(
        'live-org-a', 'live-student-b', 'feedback:attempt_live-ticket-1', '2026-07-14T00:04:00.000Z'
    ) into wrong_student_result;
    if wrong_student_result is not null then
        raise exception 'another student unexpectedly opened feedback';
    end if;
    if (select open_count from public.omr_attempt_feedback where id = 'feedback:attempt_live-ticket-1') <> 0 then
        raise exception 'wrong-student open attempt mutated feedback';
    end if;

    perform public.omr_mark_feedback_opened_v2(
        'live-org-a', 'live-student-a', 'feedback:attempt_live-ticket-1', '2026-07-14T00:05:00.000Z'
    );
    if not exists (
        select 1 from public.omr_attempt_feedback
         where id = 'feedback:attempt_live-ticket-1'
           and status = 'returned'
           and notification_status = 'sent'
           and revision = 2
           and open_count = 1
           and first_opened_at = '2026-07-14T00:05:00.000Z'
    ) then
        raise exception 'student-scoped feedback open receipt was not persisted';
    end if;

    -- A stale save after return must report conflict and preserve the returned
    -- record, including delivery/read receipts.
    if public.omr_save_feedback_v2(
        'live-org-a',
        '{"id":"feedback:attempt_live-ticket-1","organization_id":"live-org-a","attempt_id":"attempt_live-ticket-1","exam_id":"live-exam-a","student_profile_id":"live-student-a","status":"draft","summary":"stale overwrite","payload":{}}',
        1,
        'live-feedback-stale-save'
    ) ->> 'status' <> 'revision_conflict' then
        raise exception 'stale feedback save did not return revision conflict';
    end if;
    if not exists (
        select 1 from public.omr_attempt_feedback
         where id = 'feedback:attempt_live-ticket-1'
           and status = 'returned' and revision = 2
           and summary = 'Live feedback' and open_count = 1
           and first_opened_at = '2026-07-14T00:05:00.000Z'
    ) then
        raise exception 'stale feedback save damaged the returned learning record';
    end if;
end
$$;

-- Downgrade keeps the already-returned learning record readable and exact
-- response-loss replays stable. Terminal returned rows remain immutable.
update public.omr_organizations set plan = 'free' where id = 'live-org-a';
do $$
declare
    replayed_return jsonb;
begin
    if not exists (
        select 1 from public.omr_attempt_feedback
         where id = 'feedback:attempt_live-ticket-1' and status = 'returned'
    ) then
        raise exception 'downgrade hid or removed returned feedback';
    end if;
    replayed_return := public.omr_return_feedback_v2(
        'live-org-a', 'feedback:attempt_live-ticket-1', 1, 'live-feedback-return-1'
    );
    if replayed_return ->> 'status' <> 'returned'
       or (replayed_return ->> 'revision')::bigint <> 2 then
        raise exception 'downgrade blocked a committed feedback receipt replay';
    end if;
    if public.omr_return_feedback_v3(
        'live-org-a', 'feedback:attempt_live-ticket-1', 2, 'live-return-after-downgrade'
    ) ->> 'status' <> 'revision_conflict' then
        raise exception 'downgrade bypassed returned feedback immutability';
    end if;
end
$$;

update public.omr_organizations set plan = 'pro' where id = 'live-org-a';

select public.omr_save_remote_asset_metadata_v1(
    '{
        "id":"live-handwriting-asset",
        "organization_id":"live-org-a",
        "kind":"attempt_handwriting",
        "attempt_id":"attempt_live-ticket-1",
        "storage_bucket":"omr-private-assets",
        "object_path":"organizations/live-org-a/attempts/attempt_live-ticket-1/handwriting/live-handwriting-asset.json",
        "mime_type":"application/json",
        "byte_size":2,
        "sha256_hex":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "created_at":"2026-07-14T00:04:00.000Z",
        "updated_at":"2026-07-14T00:04:00.000Z"
    }'
);

select public.omr_attach_attempt_handwriting_v1(
    'live-ticket-1',
    'live-handwriting-asset',
    '{"store":"remote","key":"live-handwriting-asset","organizationId":"live-org-a","kind":"attempt_handwriting","attemptId":"attempt_live-ticket-1"}'
);

update public.omr_organizations set plan = 'free' where id = 'live-org-a';

do $$
declare
    first_prepare jsonb;
    retried_prepare jsonb;
    finalized jsonb;
    first_expiry timestamptz;
    direct_exam jsonb;
begin
    begin
        perform public.omr_prepare_teacher_asset_upload_v1(
            pg_catalog.jsonb_build_object(
                'id', 'asset_direct_no_reservation',
                'organization_id', 'live-org-a',
                'exam_id', 'live-direct-exam',
                'kind', 'problem_pdf',
                'created_by_user_id', '11111111-1111-4111-8111-111111111111',
                'idempotency_key', 'direct-no-reservation-0001',
                'storage_bucket', 'omr-private-assets',
                'object_path', 'organizations/live-org-a/exams/live-direct-exam/problem/asset_direct_no_reservation.pdf',
                'mime_type', 'application/pdf',
                'byte_size', 123,
                'sha256_hex', repeat('a', 64),
                'expires_at', now() + interval '90 minutes'
            )
        );
        raise exception 'unreserved free teacher upload unexpectedly prepared';
    exception when raise_exception then
        if sqlerrm is distinct from 'teacher upload exam reservation required' then
            raise;
        end if;
    end;

    perform public.omr_reserve_plan_usage(
        'live-org-a', 'exams',
        pg_catalog.date_trunc('month', pg_catalog.timezone('Asia/Seoul', now()))::date,
        'exam:live-direct-exam', 1, 0, 5
    );
    if not exists (
        select 1 from public.omr_plan_usage_reservations reservation
         where reservation.organization_id = 'live-org-a'
           and reservation.metric = 'exams'
           and reservation.resource_key = 'exam:live-direct-exam'
           and reservation.expires_at > now()
    ) then
        raise exception 'new free exam reservation did not receive a lease';
    end if;
    update public.omr_plan_usage_reservations reservation
       set expires_at = now() - interval '1 second'
     where reservation.organization_id = 'live-org-a'
       and reservation.metric = 'exams'
       and reservation.resource_key = 'exam:live-direct-exam';
    begin
        perform public.omr_prepare_teacher_asset_upload_v1(
            pg_catalog.jsonb_build_object(
                'id', 'asset_direct_expired_lease',
                'organization_id', 'live-org-a', 'exam_id', 'live-direct-exam',
                'kind', 'problem_pdf',
                'created_by_user_id', '11111111-1111-4111-8111-111111111111',
                'idempotency_key', 'direct-expired-lease-0001',
                'storage_bucket', 'omr-private-assets',
                'object_path', 'organizations/live-org-a/exams/live-direct-exam/problem/asset_direct_expired_lease.pdf',
                'mime_type', 'application/pdf', 'byte_size', 123,
                'sha256_hex', repeat('a', 64),
                'expires_at', now() + interval '90 minutes'
            )
        );
        raise exception 'expired free exam reservation unexpectedly authorized upload';
    exception when raise_exception then
        if sqlerrm is distinct from 'teacher upload exam reservation required' then raise; end if;
    end;
    perform public.omr_reserve_plan_usage(
        'live-org-a', 'exams',
        pg_catalog.date_trunc('month', pg_catalog.timezone('Asia/Seoul', now()))::date,
        'exam:live-direct-exam', 1, 0, 5
    );
    if not exists (
        select 1 from public.omr_plan_usage_reservations reservation
         where reservation.organization_id = 'live-org-a'
           and reservation.metric = 'exams'
           and reservation.resource_key = 'exam:live-direct-exam'
           and reservation.expires_at > now()
    ) then
        raise exception 'idempotent free exam reauthorization did not renew its lease';
    end if;

    begin
        perform public.omr_prepare_teacher_asset_upload_v1(
            pg_catalog.jsonb_build_object(
                'id', 'asset_direct_scope_denied',
                'organization_id', 'live-org-a',
                'exam_id', 'live-direct-exam',
                'kind', 'problem_pdf',
                'created_by_user_id', 'not-an-active-member',
                'idempotency_key', 'direct-scope-denied-0001',
                'storage_bucket', 'omr-private-assets',
                'object_path', 'organizations/live-org-a/exams/live-direct-exam/problem/asset_direct_scope_denied.pdf',
                'mime_type', 'application/pdf',
                'byte_size', 123,
                'sha256_hex', repeat('a', 64),
                'expires_at', now() + interval '90 minutes'
            )
        );
        raise exception 'non-member teacher upload unexpectedly prepared';
    exception when raise_exception then
        if sqlerrm is distinct from 'teacher upload scope denied' then
            raise;
        end if;
    end;

    first_prepare := public.omr_prepare_teacher_asset_upload_v1(
        pg_catalog.jsonb_build_object(
            'id', 'asset_direct_problem',
            'organization_id', 'live-org-a',
            'exam_id', 'live-direct-exam',
            'kind', 'problem_pdf',
            'created_by_user_id', '11111111-1111-4111-8111-111111111111',
            'idempotency_key', 'direct-problem-idempotency-0001',
            'storage_bucket', 'omr-private-assets',
            'object_path', 'organizations/live-org-a/exams/live-direct-exam/problem/asset_direct_problem.pdf',
            'mime_type', 'application/pdf',
            'byte_size', 123,
            'sha256_hex', repeat('b', 64),
            'original_name', 'problem.pdf',
            'expires_at', now() + interval '90 minutes'
        )
    );
    first_expiry := (first_prepare ->> 'expires_at')::timestamptz;

    if exists (select 1 from public.omr_exams where id = 'live-direct-exam') then
        raise exception 'teacher upload prepare exposed a provisional exam skeleton';
    end if;

    retried_prepare := public.omr_prepare_teacher_asset_upload_v1(
        pg_catalog.jsonb_build_object(
            'id', 'asset_direct_problem',
            'organization_id', 'live-org-a',
            'exam_id', 'live-direct-exam',
            'kind', 'problem_pdf',
            'created_by_user_id', '11111111-1111-4111-8111-111111111111',
            'idempotency_key', 'direct-problem-idempotency-0001',
            'storage_bucket', 'omr-private-assets',
            'object_path', 'organizations/live-org-a/exams/live-direct-exam/problem/asset_direct_problem.pdf',
            'mime_type', 'application/pdf',
            'byte_size', 123,
            'sha256_hex', repeat('b', 64),
            'original_name', 'problem.pdf',
            'expires_at', now() + interval '30 minutes'
        )
    );
    if (retried_prepare ->> 'id') is distinct from 'asset_direct_problem'
       or (retried_prepare ->> 'expires_at')::timestamptz is distinct from first_expiry then
        raise exception 'teacher upload prepare retry changed stable intent identity or expiry';
    end if;

    begin
        perform public.omr_prepare_teacher_asset_upload_v1(
            pg_catalog.jsonb_build_object(
                'id', 'asset_direct_problem_changed',
                'organization_id', 'live-org-a',
                'exam_id', 'live-direct-exam',
                'kind', 'problem_pdf',
                'created_by_user_id', '11111111-1111-4111-8111-111111111111',
                'idempotency_key', 'direct-problem-idempotency-0001',
                'storage_bucket', 'omr-private-assets',
                'object_path', 'organizations/live-org-a/exams/live-direct-exam/problem/asset_direct_problem_changed.pdf',
                'mime_type', 'application/pdf',
                'byte_size', 124,
                'sha256_hex', repeat('c', 64),
                'expires_at', now() + interval '90 minutes'
            )
        );
        raise exception 'teacher upload idempotency collision unexpectedly succeeded';
    exception when raise_exception then
        if sqlerrm = 'teacher upload idempotency collision unexpectedly succeeded' then
            raise;
        end if;
    end;

    begin
        perform public.omr_authorize_teacher_asset_finalize_v1(
            'live-org-a',
            '11111111-1111-4111-8111-111111111111',
            'asset_direct_problem',
            pg_catalog.jsonb_build_object(
                'exam_id', 'live-direct-exam', 'kind', 'problem_pdf',
                'storage_bucket', 'omr-private-assets',
                'object_path', 'organizations/live-org-a/exams/live-direct-exam/problem/asset_direct_problem.pdf',
                'mime_type', 'application/pdf', 'byte_size', 123,
                'sha256_hex', repeat('b', 64)
            )
        );
        begin
            perform public.omr_authorize_teacher_asset_finalize_v1(
                'live-org-a', 'wrong-actor', 'asset_direct_problem',
                pg_catalog.jsonb_build_object(
                    'exam_id', 'live-direct-exam', 'kind', 'problem_pdf',
                    'storage_bucket', 'omr-private-assets',
                    'object_path', 'organizations/live-org-a/exams/live-direct-exam/problem/asset_direct_problem.pdf',
                    'mime_type', 'application/pdf', 'byte_size', 123,
                    'sha256_hex', repeat('b', 64)
                )
            );
            raise exception 'cross-actor finalize preauthorization unexpectedly succeeded';
        exception when raise_exception then
            if sqlerrm is distinct from 'teacher upload scope denied' then raise; end if;
        end;

        perform public.omr_finalize_teacher_asset_upload_v1(
            'live-org-a',
            'asset_direct_problem',
            '11111111-1111-4111-8111-111111111111',
            pg_catalog.jsonb_build_object(
                'storage_bucket', 'omr-private-assets',
                'object_path', 'organizations/live-org-a/exams/live-direct-exam/problem/asset_direct_problem.pdf',
                'mime_type', 'application/pdf',
                'byte_size', 122,
                'sha256_hex', repeat('b', 64)
            )
        );
        raise exception 'mismatched teacher upload observation unexpectedly finalized';
    exception when raise_exception then
        if sqlerrm = 'mismatched teacher upload observation unexpectedly finalized' then
            raise;
        end if;
    end;
    if (select status from public.omr_remote_asset_upload_intents where id = 'asset_direct_problem') <> 'pending' then
        raise exception 'failed teacher upload finalization changed intent status';
    end if;

    finalized := public.omr_finalize_teacher_asset_upload_v1(
        'live-org-a',
        'asset_direct_problem',
        '11111111-1111-4111-8111-111111111111',
        pg_catalog.jsonb_build_object(
            'storage_bucket', 'omr-private-assets',
            'object_path', 'organizations/live-org-a/exams/live-direct-exam/problem/asset_direct_problem.pdf',
            'mime_type', 'application/pdf',
            'byte_size', 123,
            'sha256_hex', repeat('b', 64)
        )
    );
    if finalized ->> 'status' <> 'uploaded' then
        raise exception 'matching teacher upload observation did not finalize upload';
    end if;

    -- A response-loss retry is read-equivalent and does not create another row.
    perform public.omr_finalize_teacher_asset_upload_v1(
        'live-org-a',
        'asset_direct_problem',
        '11111111-1111-4111-8111-111111111111',
        pg_catalog.jsonb_build_object(
            'storage_bucket', 'omr-private-assets',
            'object_path', 'organizations/live-org-a/exams/live-direct-exam/problem/asset_direct_problem.pdf',
            'mime_type', 'application/pdf',
            'byte_size', 123,
            'sha256_hex', repeat('b', 64)
        )
    );

    direct_exam := pg_catalog.jsonb_build_object(
        'id', 'live-direct-exam',
        'organization_id', 'live-org-a',
        'title', 'Direct Upload Exam',
        'created_by_user_id', 'collaborating-exam-author',
        'payload', pg_catalog.jsonb_build_object(
            'id', 'live-direct-exam',
            'title', 'Direct Upload Exam',
            'questions', '[]'::jsonb,
            'pdfDataRef', pg_catalog.jsonb_build_object(
                'store', 'remote',
                'key', 'asset_direct_problem',
                'organizationId', 'live-org-a',
                'kind', 'problem_pdf',
                'examId', 'live-direct-exam',
                'mimeType', 'application/pdf',
                'size', 123
            )
        )
    );

    begin
        perform public.omr_live_save_exam_v2(
            direct_exam, '[]'::jsonb, '["asset_direct_problem"]'::jsonb,
            'wrong-upload-actor'
        );
        raise exception 'another actor unexpectedly promoted a pending teacher asset';
    exception when raise_exception then
        if sqlerrm = 'another actor unexpectedly promoted a pending teacher asset' then
            raise;
        end if;
    end;
    begin
        perform public.omr_live_save_exam_v2(
            direct_exam, '[]'::jsonb, '[]'::jsonb,
            '11111111-1111-4111-8111-111111111111'
        );
        raise exception 'remote PDF ref omission unexpectedly saved';
    exception when raise_exception then
        if sqlerrm = 'remote PDF ref omission unexpectedly saved' then
            raise;
        end if;
    end;
    if exists (select 1 from public.omr_exams where id = 'live-direct-exam') then
        raise exception 'failed teacher asset binding left a partial exam';
    end if;

    perform public.omr_live_save_exam_v2(
        pg_catalog.jsonb_build_object(
            'id', 'live-direct-exam',
            'organization_id', 'live-org-a',
            'title', 'Direct Upload Exam',
            'created_by_user_id', 'collaborating-exam-author',
            'payload', pg_catalog.jsonb_build_object(
                'id', 'live-direct-exam',
                'title', 'Direct Upload Exam',
                'questions', '[]'::jsonb,
                'pdfDataRef', pg_catalog.jsonb_build_object(
                    'store', 'remote',
                    'key', 'asset_direct_problem',
                    'organizationId', 'live-org-a',
                    'kind', 'problem_pdf',
                    'examId', 'live-direct-exam',
                    'mimeType', 'application/pdf',
                    'size', 123
                )
            )
        ),
        '[]'::jsonb,
        '["asset_direct_problem"]'::jsonb,
        '11111111-1111-4111-8111-111111111111'
    );

    if not exists (
        select 1
          from public.omr_exams exam
          join public.omr_remote_assets asset
            on asset.exam_id = exam.id and asset.organization_id = exam.organization_id
          join public.omr_remote_asset_upload_intents intent on intent.id = asset.id
         where exam.id = 'live-direct-exam'
           and asset.id = 'asset_direct_problem'
           and asset.kind = 'problem_pdf'
           and intent.status = 'finalized'
           and intent.finalized_at is not null
    ) then
        raise exception 'canonical exam save did not atomically promote teacher upload';
    end if;
    if not exists (
        select 1 from public.omr_plan_usage_reservations reservation
         where reservation.organization_id = 'live-org-a'
           and reservation.metric = 'exams'
           and reservation.resource_key = 'exam:live-direct-exam'
           and reservation.expires_at is null
    ) then
        raise exception 'canonical exam save did not make its reservation durable';
    end if;

    -- A response-loss retry remains authorized after promotion, but only while
    -- exact authoritative asset metadata exists and cleanup has not started.
    perform public.omr_authorize_teacher_asset_finalize_v1(
        'live-org-a', '11111111-1111-4111-8111-111111111111',
        'asset_direct_problem',
        pg_catalog.jsonb_build_object(
            'exam_id', 'live-direct-exam', 'kind', 'problem_pdf',
            'storage_bucket', 'omr-private-assets',
            'object_path', 'organizations/live-org-a/exams/live-direct-exam/problem/asset_direct_problem.pdf',
            'mime_type', 'application/pdf', 'byte_size', 123,
            'sha256_hex', repeat('b', 64)
        )
    );

    -- Save response loss is safe: the finalized registry ref is accepted and
    -- no duplicate asset row is created.
    perform public.omr_live_save_exam_v2(
        pg_catalog.jsonb_build_object(
            'id', 'live-direct-exam',
            'organization_id', 'live-org-a',
            'title', 'Direct Upload Exam',
            'created_by_user_id', 'collaborating-exam-author',
            'payload', pg_catalog.jsonb_build_object(
                'id', 'live-direct-exam',
                'title', 'Direct Upload Exam',
                'questions', '[]'::jsonb,
                'pdfDataRef', pg_catalog.jsonb_build_object(
                    'store', 'remote',
                    'key', 'asset_direct_problem',
                    'organizationId', 'live-org-a',
                    'kind', 'problem_pdf',
                    'examId', 'live-direct-exam',
                    'mimeType', 'application/pdf',
                    'size', 123
                )
            )
        ),
        '[]'::jsonb,
        '["asset_direct_problem"]'::jsonb,
        '11111111-1111-4111-8111-111111111111'
    );
    if (select count(*) from public.omr_remote_assets where id = 'asset_direct_problem') <> 1 then
        raise exception 'canonical exam save retry duplicated a promoted asset';
    end if;

    begin
        perform public.omr_live_save_exam_v2(
            pg_catalog.jsonb_build_object(
                'id', 'live-inline-pdf-exam',
                'organization_id', 'live-org-a',
                'title', 'Inline PDF Rejected',
                'payload', pg_catalog.jsonb_build_object(
                    'id', 'live-inline-pdf-exam',
                    'title', 'Inline PDF Rejected',
                    'questions', '[]'::jsonb,
                    'pdfData', 'data:application/pdf;base64,JVBERi0x'
                )
            ),
            '[]'::jsonb
        );
        raise exception 'inline PDF canonical payload unexpectedly saved';
    exception when raise_exception then
        if sqlerrm = 'inline PDF canonical payload unexpectedly saved' then
            raise;
        end if;
    end;
    if exists (select 1 from public.omr_exams where id = 'live-inline-pdf-exam') then
        raise exception 'rejected inline PDF payload left a partial exam';
    end if;

    perform public.omr_prepare_teacher_asset_upload_v1(
        pg_catalog.jsonb_build_object(
            'id', 'asset_expired_retry',
            'organization_id', 'live-org-a',
            'exam_id', 'live-exam-a',
            'kind', 'answer_key_pdf',
            'created_by_user_id', '11111111-1111-4111-8111-111111111111',
            'idempotency_key', 'direct-expired-idempotency-0001',
            'storage_bucket', 'omr-private-assets',
            'object_path', 'organizations/live-org-a/exams/live-exam-a/answer-key/asset_expired_retry.pdf',
            'mime_type', 'application/pdf',
            'byte_size', 22,
            'sha256_hex', repeat('d', 64),
            'expires_at', now() + interval '60 minutes'
        )
    );
    update public.omr_remote_asset_upload_intents
       set status = 'expired'
     where id = 'asset_expired_retry';
    begin
        perform public.omr_prepare_teacher_asset_upload_v1(
            pg_catalog.jsonb_build_object(
                'id', 'asset_expired_retry',
                'organization_id', 'live-org-a',
                'exam_id', 'live-exam-a',
                'kind', 'answer_key_pdf',
                'created_by_user_id', '11111111-1111-4111-8111-111111111111',
                'idempotency_key', 'direct-expired-idempotency-0001',
                'storage_bucket', 'omr-private-assets',
                'object_path', 'organizations/live-org-a/exams/live-exam-a/answer-key/asset_expired_retry.pdf',
                'mime_type', 'application/pdf',
                'byte_size', 22,
                'sha256_hex', repeat('d', 64),
                'expires_at', now() + interval '90 minutes'
            )
        );
        raise exception 'expired idempotency key unexpectedly refreshed';
    exception when raise_exception then
        if sqlerrm = 'expired idempotency key unexpectedly refreshed' then
            raise;
        end if;
    end;
end
$$;

insert into public.omr_organizations (id, name, plan)
values ('live-org-pro-upload', 'Live Pro Upload Org', 'pro');
insert into public.omr_organization_members (organization_id, user_id, role, status)
values ('live-org-pro-upload', 'live-pro-upload-teacher', 'teacher', 'active');

do $$
declare
    prepared jsonb;
    v_period_start date := pg_catalog.date_trunc(
        'month', pg_catalog.timezone('Asia/Seoul', now())
    )::date;
    actual_floor integer;
begin
    prepared := public.omr_prepare_teacher_asset_upload_v1(
        pg_catalog.jsonb_build_object(
            'id', 'paid_asset_without_reservation',
            'organization_id', 'live-org-pro-upload',
            'exam_id', 'paid-new-exam', 'kind', 'problem_pdf',
            'created_by_user_id', 'live-pro-upload-teacher',
            'idempotency_key', 'paid-no-reservation-0001',
            'storage_bucket', 'omr-private-assets',
            'object_path', 'organizations/live-org-pro-upload/exams/paid-new-exam/problem/paid_asset_without_reservation.pdf',
            'mime_type', 'application/pdf', 'byte_size', 10,
            'sha256_hex', repeat('6', 64), 'expires_at', now() + interval '1 hour'
        )
    );
    if prepared ->> 'id' is distinct from 'paid_asset_without_reservation' then
        raise exception 'paid plan upload without a quota reservation was rejected';
    end if;

    select count(*)::integer into actual_floor
      from public.omr_exams exam
     where exam.organization_id = 'live-org-b'
       and exam.created_at >= v_period_start::timestamp at time zone 'Asia/Seoul'
       and exam.created_at < (v_period_start + interval '1 month')::timestamp at time zone 'Asia/Seoul';
    insert into public.omr_plan_usage (organization_id, metric, period_start, used)
    values ('live-org-b', 'exams', v_period_start, actual_floor + 1)
    on conflict (organization_id, metric, period_start)
    do update set used = excluded.used;
    insert into public.omr_plan_usage_reservations (
        organization_id, metric, period_start, resource_key, amount, expires_at
    ) values
        ('live-org-b', 'exams', v_period_start, 'exam:live-exam-b', 1, null),
        ('live-org-b', 'exams', v_period_start, 'exam:expired-orphan-b', 1, now() - interval '1 minute')
    on conflict (organization_id, metric, period_start, resource_key)
    do update set expires_at = excluded.expires_at;

    perform public.omr_reserve_plan_usage(
        'live-org-b', 'exams', v_period_start, 'exam:live-exam-b', 1, actual_floor, 5
    );
    if exists (
        select 1 from public.omr_plan_usage_reservations
         where organization_id = 'live-org-b' and metric = 'exams'
           and period_start = v_period_start and resource_key = 'exam:expired-orphan-b'
    ) then
        raise exception 'expired orphan exam reservation was not reclaimed';
    end if;
    if (select used from public.omr_plan_usage
         where organization_id = 'live-org-b' and metric = 'exams'
           and omr_plan_usage.period_start = v_period_start) < actual_floor then
        raise exception 'reservation cleanup reduced usage below the canonical exam floor';
    end if;

    perform public.omr_reserve_plan_usage(
        'live-org-b', 'aiRecognition', v_period_start, 'ai:durable-live', 1, 0, 10
    );
    if (select expires_at from public.omr_plan_usage_reservations
         where organization_id = 'live-org-b' and metric = 'aiRecognition'
           and resource_key = 'ai:durable-live') is not null then
        raise exception 'AI reservation unexpectedly inherited provisional exam expiry';
    end if;
end
$$;

-- Database-local abuse limits cannot be bypassed with fabricated exam ids.
insert into public.omr_organization_members (organization_id, user_id, role, status)
values
    ('live-org-a', 'live-upload-rate-actor', 'assistant', 'active'),
    ('live-org-a', 'live-upload-active-actor', 'teacher', 'active');

do $$
declare
    index_value integer;
begin
    for index_value in 1..12 loop
        insert into public.omr_remote_asset_upload_intents (
            id, organization_id, exam_id, kind, created_by_user_id,
            idempotency_key, storage_bucket, object_path, mime_type, byte_size,
            sha256_hex, status, created_at, expires_at, finalized_at
        ) values (
            'rate_asset_' || index_value, 'live-org-a', 'rate_exam_' || index_value,
            'problem_pdf', 'live-upload-rate-actor', 'rate-idempotency-' || index_value,
            'omr-private-assets',
            'organizations/live-org-a/exams/rate_exam_' || index_value || '/problem/rate_asset_' || index_value || '.pdf',
            'application/pdf', 1, repeat('e', 64), 'finalized',
            now() - interval '30 seconds', now() - interval '10 seconds',
            now() - interval '20 seconds'
        );
    end loop;
    begin
        perform public.omr_prepare_teacher_asset_upload_v1(pg_catalog.jsonb_build_object(
            'id', 'rate_asset_rejected', 'organization_id', 'live-org-a',
            'exam_id', 'live-exam-a', 'kind', 'problem_pdf',
            'created_by_user_id', 'live-upload-rate-actor',
            'idempotency_key', 'rate-idempotency-rejected',
            'storage_bucket', 'omr-private-assets',
            'object_path', 'organizations/live-org-a/exams/live-exam-a/problem/rate_asset_rejected.pdf',
            'mime_type', 'application/pdf', 'byte_size', 1,
            'sha256_hex', repeat('e', 64), 'expires_at', now() + interval '1 hour'
        ));
        raise exception 'teacher upload prepare rate limit unexpectedly accepted';
    exception when raise_exception then
        if sqlerrm is distinct from 'teacher upload prepare rate exceeded' then raise; end if;
    end;

    for index_value in 1..8 loop
        insert into public.omr_remote_asset_upload_intents (
            id, organization_id, exam_id, kind, created_by_user_id,
            idempotency_key, storage_bucket, object_path, mime_type, byte_size,
            sha256_hex, status, expires_at
        ) values (
            'active_asset_' || index_value, 'live-org-a', 'active_exam_' || index_value,
            'problem_pdf', 'live-upload-active-actor', 'active-idempotency-' || index_value,
            'omr-private-assets',
            'organizations/live-org-a/exams/active_exam_' || index_value || '/problem/active_asset_' || index_value || '.pdf',
            'application/pdf', 1, repeat('f', 64), 'pending', now() + interval '1 hour'
        );
    end loop;
    begin
        perform public.omr_prepare_teacher_asset_upload_v1(pg_catalog.jsonb_build_object(
            'id', 'active_asset_rejected', 'organization_id', 'live-org-a',
            'exam_id', 'live-exam-a', 'kind', 'answer_key_pdf',
            'created_by_user_id', 'live-upload-active-actor',
            'idempotency_key', 'active-idempotency-rejected',
            'storage_bucket', 'omr-private-assets',
            'object_path', 'organizations/live-org-a/exams/live-exam-a/answer-key/active_asset_rejected.pdf',
            'mime_type', 'application/pdf', 'byte_size', 1,
            'sha256_hex', repeat('f', 64), 'expires_at', now() + interval '1 hour'
        ));
        raise exception 'teacher upload global active limit unexpectedly accepted';
    exception when raise_exception then
        if sqlerrm is distinct from 'teacher upload active intent limit exceeded' then raise; end if;
    end;
end
$$;

-- The between-drain ceiling is global as well as actor/org scoped. Spread the
-- fixture across organizations so neither organization alone reaches 100.
do $$
begin
    begin
        insert into public.omr_organizations (id, name, plan) values
            ('live-global-window-a', 'Global Window A', 'pro'),
            ('live-global-window-b', 'Global Window B', 'pro'),
            ('live-global-window-c', 'Global Window C', 'pro');
        insert into public.omr_organization_members (
            organization_id, user_id, role, status
        ) values (
            'live-global-window-c', 'live-global-window-actor', 'teacher', 'active'
        );
        insert into public.omr_remote_asset_upload_intents (
            id, organization_id, exam_id, kind, created_by_user_id,
            idempotency_key, storage_bucket, object_path, mime_type, byte_size,
            sha256_hex, status, expires_at, finalized_at
        )
        select
            'global_window_asset_' || item,
            case when item <= 50 then 'live-global-window-a' else 'live-global-window-b' end,
            'global_window_exam_' || item, 'problem_pdf',
            'global-window-seed-' || ((item - 1) / 10),
            'global-window-idempotency-' || item, 'omr-private-assets',
            'organizations/'
                || case when item <= 50 then 'live-global-window-a' else 'live-global-window-b' end
                || '/exams/global_window_exam_' || item
                || '/problem/global_window_asset_' || item || '.pdf',
            'application/pdf', 1, repeat('6', 64), 'finalized',
            now() + interval '1 hour', now()
          from pg_catalog.generate_series(1, 100) item;

        begin
            perform public.omr_prepare_teacher_asset_upload_v1(
                pg_catalog.jsonb_build_object(
                    'id', 'global_window_rejected',
                    'organization_id', 'live-global-window-c',
                    'exam_id', 'global-window-new-exam', 'kind', 'problem_pdf',
                    'created_by_user_id', 'live-global-window-actor',
                    'idempotency_key', 'global-window-rejected-0001',
                    'storage_bucket', 'omr-private-assets',
                    'object_path', 'organizations/live-global-window-c/exams/global-window-new-exam/problem/global_window_rejected.pdf',
                    'mime_type', 'application/pdf', 'byte_size', 1,
                    'sha256_hex', repeat('6', 64),
                    'expires_at', now() + interval '1 hour'
                )
            );
            raise exception 'global admission window unexpectedly accepted object 101';
        exception when raise_exception then
            if sqlerrm is distinct from 'teacher upload admission window exceeded' then
                raise;
            end if;
        end;
        raise exception using errcode = 'P1060', message = 'rollback global admission fixture';
    exception when sqlstate 'P1060' then null;
    end;
end
$$;

insert into public.omr_organizations (id, name, plan)
values ('live-org-upload-window', 'Live Upload Window Org', 'pro');
insert into public.omr_organization_members (organization_id, user_id, role, status)
values
    ('live-org-upload-window', 'live-window-actor', 'teacher', 'active'),
    ('live-org-upload-window', 'live-window-org-actor', 'assistant', 'active');
insert into public.omr_remote_asset_upload_intents (
    id, organization_id, exam_id, kind, created_by_user_id,
    idempotency_key, storage_bucket, object_path, mime_type, byte_size,
    sha256_hex, status, expires_at, finalized_at
)
select
    'window_asset_' || item,
    'live-org-upload-window', 'window_exam_' || item, 'problem_pdf',
    case when item <= 20 then 'live-window-actor' else 'window-seed-' || item end,
    'window-idempotency-' || item, 'omr-private-assets',
    'organizations/live-org-upload-window/exams/window_exam_' || item
        || '/problem/window_asset_' || item || '.pdf',
    'application/pdf', 1, repeat('5', 64), 'finalized',
    now() + interval '1 hour', now()
from pg_catalog.generate_series(1, 100) item;

do $$
begin
    begin
        perform public.omr_prepare_teacher_asset_upload_v1(pg_catalog.jsonb_build_object(
            'id', 'window_actor_rejected', 'organization_id', 'live-org-upload-window',
            'exam_id', 'window-new-actor-exam', 'kind', 'problem_pdf',
            'created_by_user_id', 'live-window-actor',
            'idempotency_key', 'window-actor-rejected-0001',
            'storage_bucket', 'omr-private-assets',
            'object_path', 'organizations/live-org-upload-window/exams/window-new-actor-exam/problem/window_actor_rejected.pdf',
            'mime_type', 'application/pdf', 'byte_size', 1,
            'sha256_hex', repeat('5', 64), 'expires_at', now() + interval '1 hour'
        ));
        raise exception 'actor admission window unexpectedly accepted object 21';
    exception when raise_exception then
        if sqlerrm is distinct from 'teacher upload admission window exceeded' then raise; end if;
    end;
    begin
        perform public.omr_prepare_teacher_asset_upload_v1(pg_catalog.jsonb_build_object(
            'id', 'window_org_rejected', 'organization_id', 'live-org-upload-window',
            'exam_id', 'window-new-org-exam', 'kind', 'answer_key_pdf',
            'created_by_user_id', 'live-window-org-actor',
            'idempotency_key', 'window-org-rejected-0001',
            'storage_bucket', 'omr-private-assets',
            'object_path', 'organizations/live-org-upload-window/exams/window-new-org-exam/answer-key/window_org_rejected.pdf',
            'mime_type', 'application/pdf', 'byte_size', 1,
            'sha256_hex', repeat('5', 64), 'expires_at', now() + interval '1 hour'
        ));
        raise exception 'organization admission window unexpectedly accepted object 101';
    exception when raise_exception then
        if sqlerrm is distinct from 'teacher upload admission window exceeded' then raise; end if;
    end;
end
$$;

do $$
declare
    claimed jsonb;
    cleanup_id text;
begin
    begin
        perform public.omr_claim_remote_asset_cleanup_v1('live-cleaner', null, 30);
        raise exception 'null cleanup claim bound unexpectedly accepted';
    exception when raise_exception then
        if sqlerrm is distinct from 'invalid remote asset cleanup claim' then raise; end if;
    end;

    insert into public.omr_remote_asset_cleanup_queue (
        organization_id, exam_id, asset_kind, source_type, source_id,
        storage_bucket, object_path, reason, status, attempts, retry_count,
        lease_owner, lease_until
    ) values (
        'live-org-a', 'dead-lease-exam', 'problem_pdf', 'remote_asset',
        'dead-lease-asset', 'omr-private-assets',
        'organizations/live-org-a/exams/dead-lease-exam/problem/dead-lease-asset.pdf',
        'asset_replaced', 'leased', 10, 10, 'dead-worker', now() - interval '1 minute'
    );

    insert into public.omr_remote_asset_upload_intents (
        id, organization_id, exam_id, kind, created_by_user_id,
        idempotency_key, storage_bucket, object_path, mime_type, byte_size,
        sha256_hex, status, created_at, expires_at
    ) values (
        'expired_gc_asset', 'live-org-a', 'expired_gc_exam', 'problem_pdf',
        '11111111-1111-4111-8111-111111111111', 'expired-gc-idempotency',
        'omr-private-assets',
        'organizations/live-org-a/exams/expired_gc_exam/problem/expired_gc_asset.pdf',
        'application/pdf', 9, repeat('9', 64), 'uploaded',
        now() - interval '2 hours', now() - interval '1 hour'
    );

    claimed := public.omr_claim_remote_asset_cleanup_v1('live-cleaner', 1, 30);
    if (select status from public.omr_remote_asset_cleanup_queue where source_id = 'dead-lease-asset') <> 'dead' then
        raise exception 'exhausted cleanup lease was not quarantined';
    end if;
    if pg_catalog.jsonb_array_length(claimed) <> 1
       or claimed #>> '{0,object_path}' is distinct from
          'organizations/live-org-a/exams/expired_gc_exam/problem/expired_gc_asset.pdf' then
        raise exception 'bounded expiry sweep did not claim the expired upload';
    end if;
    cleanup_id := claimed #>> '{0,id}';
    if public.omr_ack_remote_asset_cleanup_v1(
        cleanup_id, 'wrong-cleaner', (claimed #>> '{0,attempts}')::integer
    ) then
        raise exception 'cleanup ack accepted the wrong lease owner';
    end if;
    if not public.omr_fail_remote_asset_cleanup_v1(
        cleanup_id, 'live-cleaner', (claimed #>> '{0,attempts}')::integer, 'transient'
    ) then
        raise exception 'cleanup failure did not release the lease';
    end if;
    update public.omr_remote_asset_cleanup_queue set available_at = now() - interval '1 second'
     where id::text = cleanup_id;
    claimed := public.omr_claim_remote_asset_cleanup_v1('live-cleaner', 1, 30);
    cleanup_id := claimed #>> '{0,id}';
    if not public.omr_ack_remote_asset_cleanup_v1(
        cleanup_id, 'live-cleaner', (claimed #>> '{0,attempts}')::integer
    ) then
        raise exception 'cleanup ack did not complete the leased item';
    end if;
    if exists (select 1 from public.omr_remote_asset_upload_intents where id = 'expired_gc_asset')
       or exists (select 1 from public.omr_remote_asset_cleanup_queue where id::text = cleanup_id) then
        raise exception 'cleanup ack did not retire metadata and release its path key';
    end if;

    insert into public.omr_remote_asset_upload_intents (
        id, organization_id, exam_id, kind, created_by_user_id,
        idempotency_key, storage_bucket, object_path, mime_type, byte_size,
        sha256_hex, status, created_at, expires_at
    ) values (
        'expired_gc_asset', 'live-org-a', 'expired_gc_exam', 'problem_pdf',
        '11111111-1111-4111-8111-111111111111', 'expired-gc-idempotency-reused',
        'omr-private-assets',
        'organizations/live-org-a/exams/expired_gc_exam/problem/expired_gc_asset.pdf',
        'application/pdf', 9, repeat('8', 64), 'uploaded',
        now() - interval '2 hours', now() - interval '1 hour'
    );
    update public.omr_remote_asset_cleanup_queue
       set available_at = now() + interval '1 hour'
     where source_id <> 'expired_gc_asset' and status = 'pending';
    claimed := public.omr_claim_remote_asset_cleanup_v1('live-cleaner', 1, 30);
    if claimed #>> '{0,object_path}' is distinct from
       'organizations/live-org-a/exams/expired_gc_exam/problem/expired_gc_asset.pdf' then
        raise exception 'completed cleanup tombstone blocked a reused object path';
    end if;
    perform public.omr_ack_remote_asset_cleanup_v1(
        claimed #>> '{0,id}', 'live-cleaner', (claimed #>> '{0,attempts}')::integer
    );
    delete from public.omr_remote_asset_cleanup_queue where source_id = 'dead-lease-asset';
end
$$;

do $$
declare
    claimed jsonb;
begin
    update public.omr_remote_asset_upload_intents intent
       set created_at = now() - interval '3 hours',
           expires_at = now() - interval '1 hour'
     where intent.id = 'asset_direct_problem';

    insert into public.omr_remote_asset_upload_intents (
        id, organization_id, exam_id, kind, created_by_user_id,
        idempotency_key, storage_bucket, object_path, mime_type, byte_size,
        sha256_hex, status, created_at, expires_at, finalized_at
    ) values (
        'unreferenced_finalized_asset', 'live-org-a', 'live-exam-a', 'problem_pdf',
        '11111111-1111-4111-8111-111111111111', 'unreferenced-finalized-0001',
        'omr-private-assets',
        'organizations/live-org-a/exams/live-exam-a/problem/unreferenced_finalized_asset.pdf',
        'application/pdf', 11, repeat('4', 64), 'finalized',
        now() - interval '4 hours', now() - interval '2 hours', now() - interval '2 hours'
    );
    insert into public.omr_remote_assets (
        id, organization_id, kind, exam_id, storage_bucket, object_path,
        mime_type, byte_size, sha256_hex, created_by_user_id
    ) values (
        'unreferenced_finalized_asset', 'live-org-a', 'problem_pdf', 'live-exam-a',
        'omr-private-assets',
        'organizations/live-org-a/exams/live-exam-a/problem/unreferenced_finalized_asset.pdf',
        'application/pdf', 11, repeat('4', 64),
        '11111111-1111-4111-8111-111111111111'
    );

    claimed := public.omr_claim_remote_asset_cleanup_v1('live-finalized-cleaner', 1, 30);
    if claimed #>> '{0,object_path}' is distinct from
          'organizations/live-org-a/exams/live-exam-a/problem/unreferenced_finalized_asset.pdf'
       or (select status from public.omr_remote_asset_upload_intents
            where id = 'unreferenced_finalized_asset') <> 'expired'
       or exists (
           select 1 from public.omr_remote_asset_cleanup_queue
            where source_id = 'asset_direct_problem'
    ) then
        raise exception 'finalized sweep did not isolate only the unreferenced asset';
    end if;

    -- The cleanup sweep holds the same intent-row lock as canonical save. Once
    -- it wins and queues the path, a stale save must not resurrect that asset.
    begin
        perform public.omr_live_save_exam_v2(
            pg_catalog.jsonb_build_object(
                'id', 'live-exam-a', 'organization_id', 'live-org-a',
                'title', 'Stale cleanup save must fail',
                'payload', pg_catalog.jsonb_build_object(
                    'id', 'live-exam-a', 'title', 'Stale cleanup save must fail',
                    'questions', '[]'::jsonb,
                    'pdfDataRef', pg_catalog.jsonb_build_object(
                        'store', 'remote', 'key', 'unreferenced_finalized_asset',
                        'organizationId', 'live-org-a', 'kind', 'problem_pdf',
                        'examId', 'live-exam-a', 'mimeType', 'application/pdf',
                        'size', 11
                    )
                )
            ),
            '[]'::jsonb,
            '["unreferenced_finalized_asset"]'::jsonb,
            '11111111-1111-4111-8111-111111111111'
        );
        raise exception 'stale canonical save resurrected a queued cleanup asset';
    exception when raise_exception then
        if sqlerrm is distinct from 'teacher asset intent is not ready' then raise; end if;
    end;
    perform public.omr_ack_remote_asset_cleanup_v1(
        claimed #>> '{0,id}', 'live-finalized-cleaner',
        (claimed #>> '{0,attempts}')::integer
    );

    -- Legacy registry rows can exist without an upload-intent row. A queue row
    -- for that exact remote asset must still fence canonical promotion.
    insert into public.omr_remote_assets (
        id, organization_id, kind, exam_id, storage_bucket, object_path,
        mime_type, byte_size, sha256_hex, created_by_user_id
    ) values (
        'legacy_queued_remote_asset', 'live-org-a', 'answer_key_pdf', 'live-exam-a',
        'omr-private-assets',
        'organizations/live-org-a/exams/live-exam-a/answer-key/legacy_queued_remote_asset.pdf',
        'application/pdf', 13, repeat('3', 64),
        '11111111-1111-4111-8111-111111111111'
    );
    perform public.omr_live_enqueue_cleanup_v1(
        'live-org-a', 'live-exam-a', 'answer_key_pdf', 'remote_asset',
        'legacy_queued_remote_asset', 'omr-private-assets',
        'organizations/live-org-a/exams/live-exam-a/answer-key/legacy_queued_remote_asset.pdf',
        'asset_replaced'
    );
    begin
        perform public.omr_live_save_exam_v2(
            pg_catalog.jsonb_build_object(
                'id', 'live-exam-a', 'organization_id', 'live-org-a',
                'title', 'Queued legacy asset save must fail',
                'payload', pg_catalog.jsonb_build_object(
                    'id', 'live-exam-a', 'title', 'Queued legacy asset save must fail',
                    'questions', '[]'::jsonb,
                    'answerKeyPdfRef', pg_catalog.jsonb_build_object(
                        'store', 'remote', 'key', 'legacy_queued_remote_asset',
                        'organizationId', 'live-org-a', 'kind', 'answer_key_pdf',
                        'examId', 'live-exam-a', 'mimeType', 'application/pdf',
                        'size', 13
                    )
                )
            ),
            '[]'::jsonb,
            '["legacy_queued_remote_asset"]'::jsonb,
            '11111111-1111-4111-8111-111111111111'
        );
        raise exception 'queued legacy remote asset was promoted without an intent';
    exception when raise_exception then
        if sqlerrm is distinct from 'teacher asset intent is not ready' then raise; end if;
    end;
    update public.omr_remote_asset_cleanup_queue
       set status = 'leased', attempts = attempts + 1,
           lease_owner = 'live-legacy-cleaner',
           lease_until = now() + interval '30 seconds'
     where source_id = 'legacy_queued_remote_asset';
    if not public.omr_ack_remote_asset_cleanup_v1(
        (select id::text from public.omr_remote_asset_cleanup_queue
          where source_id = 'legacy_queued_remote_asset'),
        'live-legacy-cleaner',
        (select attempts from public.omr_remote_asset_cleanup_queue
          where source_id = 'legacy_queued_remote_asset')
    ) then
        raise exception 'queued legacy remote asset cleanup ack failed';
    end if;

    -- Expired intent time does not break a response-loss retry after canonical
    -- promotion while the exact asset remains authoritative.
    perform public.omr_authorize_teacher_asset_finalize_v1(
        'live-org-a', '11111111-1111-4111-8111-111111111111',
        'asset_direct_problem',
        pg_catalog.jsonb_build_object(
            'exam_id', 'live-direct-exam', 'kind', 'problem_pdf',
            'storage_bucket', 'omr-private-assets',
            'object_path', 'organizations/live-org-a/exams/live-direct-exam/problem/asset_direct_problem.pdf',
            'mime_type', 'application/pdf', 'byte_size', 123,
            'sha256_hex', repeat('b', 64)
        )
    );
    perform public.omr_live_enqueue_cleanup_v1(
        'live-org-a', 'live-direct-exam', 'problem_pdf', 'remote_asset',
        'asset_direct_problem', 'omr-private-assets',
        'organizations/live-org-a/exams/live-direct-exam/problem/asset_direct_problem.pdf',
        'asset_replaced'
    );
    begin
        perform public.omr_authorize_teacher_asset_finalize_v1(
            'live-org-a', '11111111-1111-4111-8111-111111111111',
            'asset_direct_problem',
            pg_catalog.jsonb_build_object(
                'exam_id', 'live-direct-exam', 'kind', 'problem_pdf',
                'storage_bucket', 'omr-private-assets',
                'object_path', 'organizations/live-org-a/exams/live-direct-exam/problem/asset_direct_problem.pdf',
                'mime_type', 'application/pdf', 'byte_size', 123,
                'sha256_hex', repeat('b', 64)
            )
        );
        raise exception 'queued finalized asset unexpectedly reauthorized';
    exception when raise_exception then
        if sqlerrm is distinct from 'teacher upload scope denied' then raise; end if;
    end;
    delete from public.omr_remote_asset_cleanup_queue
     where source_id = 'asset_direct_problem';
end
$$;

-- Replacing the canonical refs and deleting an exam both enqueue object paths
-- before the remote registry can cascade away.
do $$
begin
    perform public.omr_live_save_exam_v2(
        pg_catalog.jsonb_build_object(
            'id', 'live-direct-exam', 'organization_id', 'live-org-a',
            'title', 'Direct Upload Exam Without PDF',
            'payload', pg_catalog.jsonb_build_object(
                'id', 'live-direct-exam', 'title', 'Direct Upload Exam Without PDF',
                'questions', '[]'::jsonb
            )
        ),
        '[]'::jsonb, '[]'::jsonb, null
    );
    if exists (select 1 from public.omr_remote_assets where id = 'asset_direct_problem')
       or (select status from public.omr_remote_asset_upload_intents where id = 'asset_direct_problem') <> 'expired'
       or not exists (
           select 1 from public.omr_remote_asset_cleanup_queue
            where source_id = 'asset_direct_problem' and reason = 'asset_replaced'
       ) then
        raise exception 'exam replacement did not queue and retire the obsolete finalized asset';
    end if;

    insert into public.omr_exams (id, organization_id, title, payload, created_at, updated_at)
    values ('live-cleanup-delete-exam', 'live-org-a', 'Cleanup Delete',
        '{"id":"live-cleanup-delete-exam","title":"Cleanup Delete","questions":[]}'::jsonb,
        now(), now());
    insert into public.omr_remote_assets (
        id, organization_id, kind, exam_id, storage_bucket, object_path,
        mime_type, byte_size, sha256_hex
    ) values (
        'live-cleanup-delete-asset', 'live-org-a', 'problem_pdf',
        'live-cleanup-delete-exam', 'omr-private-assets',
        'organizations/live-org-a/exams/live-cleanup-delete-exam/problem/live-cleanup-delete-asset.pdf',
        'application/pdf', 7, repeat('7', 64)
    );
    insert into public.omr_attempts (
        id, organization_id, exam_id, student_name, student_id, identity_type,
        status, payload, started_at, finished_at
    ) values (
        'live-cleanup-delete-attempt', 'live-org-a', 'live-cleanup-delete-exam',
        'Delete Student', 'live-cleanup-delete-student', 'registered', 'completed',
        '{"id":"live-cleanup-delete-attempt"}'::jsonb,
        now() - interval '10 minutes', now()
    );
    insert into public.omr_question_results (
        id, organization_id, attempt_id, exam_id, student_name, student_id,
        identity_type, question_id, question_number, status, finished_at, payload
    ) values (
        'live-cleanup-delete-attempt:1', 'live-org-a', 'live-cleanup-delete-attempt',
        'live-cleanup-delete-exam', 'Delete Student', 'live-cleanup-delete-student',
        'registered', 1, 1, 'correct', now(), '{"questionId":1}'::jsonb
    );
    insert into public.omr_attempt_sessions (
        id, organization_id, exam_id, owner_student_id, student_name,
        identity_type, scope_key, submission_id, attempt_id,
        allowed_question_ids, grading_snapshot, status, started_at, deadline_at,
        last_heartbeat_at, lease_token_hash, lease_expires_at,
        submitted_attempt_id, submitted_at
    ) values (
        'live-cleanup-delete-session', 'live-org-a', 'live-cleanup-delete-exam',
        'live-cleanup-delete-student', 'Delete Student', 'registered', 'base',
        'live-cleanup-delete-ticket', 'live-cleanup-delete-attempt', array[1],
        '{"id":"live-cleanup-delete-exam","questions":[]}'::jsonb,
        'submitted', now() - interval '10 minutes', now() + interval '1 hour',
        now(), 'finished-lease', now(), 'live-cleanup-delete-attempt', now()
    );
    perform public.omr_delete_exam_v1('live-org-a', 'live-cleanup-delete-exam');
    if exists (
        select 1 from public.omr_attempt_sessions
         where id = 'live-cleanup-delete-session'
    ) or exists (
        select 1 from public.omr_attempts
         where id = 'live-cleanup-delete-attempt'
    ) or exists (
        select 1 from public.omr_question_results
         where id = 'live-cleanup-delete-attempt:1'
    ) or exists (
        select 1 from public.omr_exams
         where id = 'live-cleanup-delete-exam'
    ) then
        raise exception 'exam delete left submitted durable-session state behind';
    end if;
    if not exists (
        select 1 from public.omr_remote_asset_cleanup_queue
         where source_id = 'live-cleanup-delete-asset'
           and object_path = 'organizations/live-org-a/exams/live-cleanup-delete-exam/problem/live-cleanup-delete-asset.pdf'
           and reason = 'exam_deleted'
    ) then
        raise exception 'exam delete lost the remote object path before cleanup';
    end if;
end
$$;

do $$
begin
    if not exists (
        select 1 from public.omr_attempts
         where ticket_id = 'live-ticket-1'
           and payload #>> '{drawingsRef,key}' = 'live-handwriting-asset'
           and payload ->> 'handwritingArchived' = 'true'
    ) then
        raise exception 'handwriting attachment was not persisted on the official attempt';
    end if;
end
$$;

insert into public.omr_student_start_credentials (
    organization_id, student_profile_id, start_code_hash
) values
    (
        'live-org-a',
        'live-student-a',
        'pbkdf2-sha256:10000:0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    ),
    (
        'live-org-b',
        'live-student-b',
        'pbkdf2-sha256:10000:0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    )
on conflict (organization_id, student_profile_id) do update
set start_code_hash = excluded.start_code_hash,
    updated_at = now();

insert into public.omr_organization_members (
    organization_id, user_id, role, status
) values
    ('live-org-a', 'live-teacher-assigned', 'teacher', 'active'),
    ('live-org-b', 'live-teacher-cross-class', 'teacher', 'active')
on conflict (organization_id, user_id) do update
set role = excluded.role,
    status = excluded.status,
    updated_at = now();

insert into public.omr_teacher_profiles (
    organization_id, user_id, display_name, status
) values
    ('live-org-a', 'live-teacher-assigned', '담당 교사', 'active'),
    ('live-org-b', 'live-teacher-cross-class', '다른 반 교사', 'active')
on conflict (organization_id, user_id) do update
set display_name = excluded.display_name,
    status = excluded.status,
    updated_at = now();

reset role;

do $$
declare
    diagnostics jsonb;
    candidate_hash text;
    original_hash text;
begin
    select start_code_hash
      into original_hash
      from public.omr_student_start_credentials
     where organization_id = 'live-org-a'
       and student_profile_id = 'live-student-a';

    update public.omr_student_start_credentials
       set start_code_hash =
           'pbkdf2-sha256:00010000:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
     where organization_id = 'live-org-a'
       and student_profile_id = 'live-student-a';
    diagnostics := public.omr_production_boundary_preflight_v1();
    if (diagnostics->>'students_without_credentials')::bigint <> 0 then
        raise exception 'uppercase PBKDF2 credential was rejected';
    end if;

    update public.omr_student_start_credentials
       set start_code_hash =
           'pbkdf2-sha256:' || repeat('0', 395) || '10000:'
           || repeat('a', 32) || ':' || repeat('b', 64)
     where organization_id = 'live-org-a'
       and student_profile_id = 'live-student-a';
    diagnostics := public.omr_production_boundary_preflight_v1();
    if (diagnostics->>'students_without_credentials')::bigint <> 0 then
        raise exception 'maximum-length leading-zero PBKDF2 credential was rejected';
    end if;

    update public.omr_student_start_credentials
       set start_code_hash =
           'pbkdf2-sha256:' || repeat('0', 400) || ':'
           || repeat('a', 32) || ':' || repeat('b', 64)
     where organization_id = 'live-org-a'
       and student_profile_id = 'live-student-a';
    diagnostics := public.omr_production_boundary_preflight_v1();
    if (diagnostics->>'students_without_credentials')::bigint <> 1 then
        raise exception 'all-zero PBKDF2 iteration fixture was accepted';
    end if;

    foreach candidate_hash in array array[
        'pbkdf2-sha256:9999:' || repeat('a', 32) || ':' || repeat('b', 64),
        'pbkdf2-sha256:1000001:' || repeat('a', 32) || ':' || repeat('b', 64),
        'pbkdf2-sha256:999999999999999999999999:' || repeat('a', 32) || ':' || repeat('b', 64),
        'pbkdf2-sha256:10000:' || repeat('a', 33) || ':' || repeat('b', 64),
        'pbkdf2-sha256:10000:' || repeat('a', 129) || ':' || repeat('b', 64),
        'pbkdf2-sha256:10000:' || repeat('a', 130) || ':' || repeat('b', 64),
        'pbkdf2-sha256:10000:' || repeat('a', 32) || ':' || repeat('b', 63),
        'pbkdf2-sha512:10000:' || repeat('a', 32) || ':' || repeat('b', 64),
        'pbkdf2-sha256:10000:' || repeat('a', 32) || ':' || repeat('b', 64) || ':extra'
    ]
    loop
        update public.omr_student_start_credentials
           set start_code_hash = candidate_hash
         where organization_id = 'live-org-a'
           and student_profile_id = 'live-student-a';
        diagnostics := public.omr_production_boundary_preflight_v1();
        if (diagnostics->>'students_without_credentials')::bigint <> 1 then
            raise exception 'unsafe PBKDF2 boundary fixture was accepted';
        end if;
    end loop;

    begin
        update public.omr_student_start_credentials
           set start_code_hash = 'x:' || repeat('9', 500)
         where organization_id = 'live-org-a'
           and student_profile_id = 'live-student-a';
        diagnostics := public.omr_production_boundary_preflight_v1();
        if (diagnostics->>'students_without_credentials')::bigint <> 1 then
            raise exception '500-digit iteration fixture was accepted';
        end if;
    exception
        when others then
            raise exception '500-digit iteration fixture raised instead of returning an invalid count: %', sqlerrm;
    end;

    execute 'alter table public.omr_student_start_credentials alter column start_code_hash drop not null';
    update public.omr_student_start_credentials
       set start_code_hash = null
     where organization_id = 'live-org-a'
       and student_profile_id = 'live-student-a';
    diagnostics := public.omr_production_boundary_preflight_v1();
    if (diagnostics->>'students_without_credentials')::bigint <> 1 then
        raise exception 'NULL PBKDF2 boundary fixture was accepted';
    end if;
    update public.omr_student_start_credentials
       set start_code_hash = original_hash
     where organization_id = 'live-org-a'
       and student_profile_id = 'live-student-a';
    execute 'alter table public.omr_student_start_credentials alter column start_code_hash set not null';
end
$$;

set role service_role;

do $$
declare
    diagnostics jsonb;
begin
    insert into public.omr_class_students (
        class_id, organization_id, student_profile_id, enrollment_status
    ) values (
        'live-class-b', 'live-org-a', 'live-student-a', 'active'
    );
    diagnostics := public.omr_production_boundary_preflight_v1();
    if (diagnostics->>'cross_organization_rows')::bigint < 1 then
        raise exception 'class-student cross-organization fixture was not detected';
    end if;
    delete from public.omr_class_students
     where class_id = 'live-class-b'
       and student_profile_id = 'live-student-a';

    insert into public.omr_class_teachers (
        class_id, organization_id, teacher_user_id, class_role
    ) values (
        'live-class-a', 'live-org-a', 'live-teacher-cross-class', 'grader'
    );
    diagnostics := public.omr_production_boundary_preflight_v1();
    if (diagnostics->>'orphan_rows')::bigint < 1
        or (diagnostics->>'cross_organization_rows')::bigint < 1
    then
        raise exception 'class-teacher exact membership fixture was not detected';
    end if;
    delete from public.omr_class_teachers
     where class_id = 'live-class-a'
       and teacher_user_id = 'live-teacher-cross-class';
end
$$;

reset role;
drop function public.omr_live_save_exam_v2(jsonb,jsonb,jsonb,text);
drop function public.omr_live_enqueue_cleanup_v1(text,text,text,text,text,text,text,text);
set role service_role;

do $$
declare
    diagnostics jsonb;
begin
    insert into public.omr_organization_members (
        organization_id, user_id, role, status
    ) values
        ('live-org-a', 'live-teacher-history-inactive', 'teacher', 'suspended'),
        ('live-org-a', 'live-teacher-history-removed', 'teacher', 'removed'),
        ('live-org-b', 'live-teacher-history-removed', 'teacher', 'active');
    insert into public.omr_teacher_profiles (
        organization_id, user_id, display_name, status
    ) values
        ('live-org-a', 'live-teacher-history-inactive', '이전 교사', 'inactive'),
        ('live-org-a', 'live-teacher-history-removed', '퇴직 교사', 'removed');
    insert into public.omr_class_teachers (
        class_id, organization_id, teacher_user_id, class_role
    ) values
        ('live-class-a', 'live-org-a', 'live-teacher-history-inactive', 'viewer'),
        ('live-class-a', 'live-org-a', 'live-teacher-history-removed', 'viewer');

    diagnostics := public.omr_production_boundary_preflight_v1();
    if (diagnostics->>'orphan_rows')::bigint <> 0 then
        raise exception 'inactive teacher history was treated as an orphan';
    end if;
    if (diagnostics->>'cross_organization_rows')::bigint <> 0 then
        raise exception 'same-scope removed membership created a false cross-organization violation';
    end if;

    delete from public.omr_class_teachers
     where teacher_user_id in ('live-teacher-history-inactive', 'live-teacher-history-removed');
    delete from public.omr_teacher_profiles
     where user_id in ('live-teacher-history-inactive', 'live-teacher-history-removed');
    delete from public.omr_organization_members
     where user_id in ('live-teacher-history-inactive', 'live-teacher-history-removed');

    insert into public.omr_organization_members (
        organization_id, user_id, role, status
    ) values (
        'live-org-a', 'live-teacher-active-misaligned', 'teacher', 'suspended'
    );
    insert into public.omr_teacher_profiles (
        organization_id, user_id, display_name, status
    ) values (
        'live-org-a', 'live-teacher-active-misaligned', '활성 교사', 'active'
    );
    insert into public.omr_class_teachers (
        class_id, organization_id, teacher_user_id, class_role
    ) values (
        'live-class-a', 'live-org-a', 'live-teacher-active-misaligned', 'grader'
    );

    diagnostics := public.omr_production_boundary_preflight_v1();
    if (diagnostics->>'orphan_rows')::bigint < 1 then
        raise exception 'active teacher with inactive membership was accepted';
    end if;

    delete from public.omr_class_teachers
     where teacher_user_id = 'live-teacher-active-misaligned';
    delete from public.omr_teacher_profiles
     where user_id = 'live-teacher-active-misaligned';
    delete from public.omr_organization_members
     where user_id = 'live-teacher-active-misaligned';
end
$$;

do $$
declare
    diagnostics jsonb;
begin
    insert into public.omr_question_results (
        id, organization_id, class_id, attempt_id, exam_id,
        student_name, question_id, question_number, status,
        is_correct, is_wrong, is_unanswered, score, earned_score,
        finished_at, payload
    ) values (
        'live-historical-question-result',
        'live-org-a',
        'live-class-a',
        'attempt_live-ticket-1',
        'live-exam-a',
        'Historical Student',
        999,
        999,
        'ungraded',
        false,
        false,
        false,
        0,
        0,
        now(),
        '{}'
    );

    diagnostics := public.omr_production_boundary_preflight_v1();
    if (diagnostics->>'orphan_rows')::bigint <> 0 then
        raise exception 'historical question-result snapshot was treated as an orphan';
    end if;

    delete from public.omr_question_results
     where id = 'live-historical-question-result';
end
$$;

do $$
declare
    diagnostics jsonb;
begin
    diagnostics := public.omr_production_boundary_preflight_v1();
    if (diagnostics->>'null_organization_rows')::bigint <> 0
        or (diagnostics->>'orphan_rows')::bigint <> 0
        or (diagnostics->>'cross_organization_rows')::bigint <> 0
        or (diagnostics->>'students_without_credentials')::bigint <> 0
    then
        raise exception 'preflight must report zero organization-integrity violations: %', diagnostics;
    end if;

    begin
        insert into public.omr_attempts (
            id, organization_id, exam_id, student_name, identity_type,
            payload, started_at, finished_at
        ) values (
            'raw-live-private-attempt-id',
            'live-org-a',
            'live-exam-b',
            '김학생',
            'temporary',
            '{"id":"raw-live-private-attempt-id"}',
            '2026-07-14T00:00:00.000Z',
            '2026-07-14T00:01:00.000Z'
        );

        diagnostics := public.omr_production_boundary_preflight_v1();
        if diagnostics::text like '%김학생%'
            or diagnostics::text like '%raw-live-private-attempt-id%'
        then
            raise exception 'preflight diagnostics exposed 김학생 or a raw row identifier';
        end if;
        perform public.omr_assert_production_boundary_preflight_v1();
        raise exception 'cross-organization preflight fixture unexpectedly passed';
    exception
        when check_violation then
            if sqlerrm not like 'production boundary preflight failed:%' then
                raise;
            end if;
            if sqlerrm like '%김학생%'
                or sqlerrm like '%raw-live-private-attempt-id%'
            then
                raise exception 'preflight exception exposed 김학생 or a raw row identifier';
            end if;
    end;

    if exists (
        select 1
          from public.omr_attempts
         where id = 'raw-live-private-attempt-id'
    ) then
        raise exception 'failed preflight fixture was not rolled back';
    end if;
end
$$;

do $$
declare
    readiness jsonb;
begin
    begin
        insert into public.omr_remote_asset_upload_intents (
            id, organization_id, exam_id, kind, created_by_user_id,
            idempotency_key, storage_bucket, object_path, mime_type, byte_size,
            sha256_hex, status, created_at, expires_at
        )
        select 'unmaterialized_backlog_asset_' || item, 'live-org-b',
               'unmaterialized_backlog_exam_' || item, 'problem_pdf',
               'unmaterialized-backlog-actor-' || item,
               'unmaterialized-backlog-idempotency-' || item,
               'omr-private-assets',
               'organizations/live-org-b/exams/unmaterialized_backlog_exam_' || item
                   || '/problem/unmaterialized_backlog_asset_' || item || '.pdf',
               'application/pdf', 1, repeat('7', 64), 'uploaded',
               now() - interval '3 hours', now() - interval '2 hours'
          from pg_catalog.generate_series(1, 101) item;
        if exists (
            select 1 from public.omr_remote_asset_cleanup_queue queue
             where queue.source_id like 'unmaterialized_backlog_asset_%'
        ) then
            raise exception 'unmaterialized readiness fixture was already queued';
        end if;
        readiness := public.omr_service_readiness_v1();
        if readiness->>'teacherAssetCleanupBacklogHealthy' <> 'false'
           or readiness->>'ready' <> 'false' then
            raise exception 'v6 readiness ignored cleanup-eligible unmaterialized backlog';
        end if;
        raise exception using errcode = 'P1061', message = 'rollback unmaterialized backlog fixture';
    exception when sqlstate 'P1061' then null;
    end;
end
$$;

do $$
declare
    readiness jsonb;
begin
    readiness := public.omr_service_readiness_v1();
    if readiness->>'version' <> '202608080005'
        or readiness->>'ready' <> 'true'
        or exists (
            select 1
              from jsonb_each(readiness - 'version') item
             where item.key <> 'ready'
               and item.value is distinct from 'true'::jsonb
        )
    then
        raise exception 'v4 readiness probe did not confirm every effective boundary: %', readiness;
    end if;
    if readiness::text like '%김학생%'
        or readiness::text like '%raw-live-private-attempt-id%'
        or readiness ? 'samples'
    then
        raise exception 'v4 readiness probe exposed tenant data';
    end if;
end
$$;

-- Durable attempt sessions: real PostgreSQL continuity, stale-revision CAS,
-- lease enforcement, progress restore, and terminal expiration persistence.
do $$
declare
    exam_updated timestamptz;
    exam_snapshot jsonb;
    opened record;
    checkpointed record;
    resumed record;
    taken_over record;
    prepared record;
    heartbeat_row record;
    claimed jsonb;
    lease_before timestamptz;
begin
    select exam.updated_at, exam.payload into exam_updated, exam_snapshot
      from public.omr_exams exam where exam.id = 'live-exam-a';

    select * into opened from public.omr_open_attempt_session_v1(
        'live-session-continuity', 'live-org-a', 'live-exam-a', '',
        'live-student-a', 'Live Student', 'registered',
        'live-session-ticket', 'live-session-attempt', '', '',
        '{}'::integer[], array[1,2], exam_updated, exam_snapshot,
        600, null, 'lease-hash-1', '', 45
    );
    if opened.status <> 'in_progress' or not opened.lease_acquired then
        raise exception 'durable attempt open failed';
    end if;

    begin
        perform * from public.omr_heartbeat_attempt_session_v1(
            opened.session_id, 'live-org-a', 'live-student-a', null::bigint,
            '   ', 45
        );
        raise exception 'attempt heartbeat accepted an invalid CAS or blank token';
    exception when others then
        if sqlerrm not like '%invalid attempt session expected lease epoch%' then raise; end if;
    end;
    begin
        perform * from public.omr_takeover_attempt_session_v1(
            opened.session_id, 'live-org-a', 'live-student-a', 9007199254740992,
            opened.lease_epoch, 'replacement-hash', 45
        );
        raise exception 'attempt takeover accepted an invalid CAS or blank token';
    exception when others then
        if sqlerrm not like '%invalid attempt session expected revision%' then raise; end if;
    end;
    begin
        perform * from public.omr_prepare_attempt_session_submit_v1(
            opened.session_id, 'live-org-a', 'live-student-a', opened.revision,
            opened.lease_epoch, '   '
        );
        raise exception 'attempt prepare accepted an invalid CAS or blank token';
    exception when others then
        if sqlerrm not like '%attempt session lease token required%' then raise; end if;
    end;
    begin
        perform * from public.omr_commit_attempt_session_submit_v1(
            opened.session_id, 'live-org-a', 'live-student-a', null::bigint,
            opened.lease_epoch, 'lease-hash-1', '{}'::jsonb, '[]'::jsonb
        );
        raise exception 'attempt commit accepted an invalid CAS or blank token';
    exception when others then
        if sqlerrm not like '%invalid attempt session expected revision%' then raise; end if;
    end;

    begin
        perform * from public.omr_checkpoint_attempt_session_v1(
            opened.session_id, 'live-org-a', 'live-student-a', null::bigint,
            opened.lease_epoch, 'lease-hash-1', '{}'::jsonb, '{}'::jsonb,
            '{}'::jsonb, 45, false
        );
        raise exception 'checkpoint accepted a null expected revision';
    exception when others then
        if sqlerrm not like '%invalid attempt session checkpoint%' then raise; end if;
    end;
    begin
        perform * from public.omr_checkpoint_attempt_session_v1(
            opened.session_id, 'live-org-a', 'live-student-a', opened.revision,
            null::bigint, 'lease-hash-1', '{}'::jsonb, '{}'::jsonb,
            '{}'::jsonb, 45, false
        );
        raise exception 'checkpoint accepted a null expected lease epoch';
    exception when others then
        if sqlerrm not like '%invalid attempt session checkpoint%' then raise; end if;
    end;

    select * into checkpointed from public.omr_checkpoint_attempt_session_v1(
        opened.session_id, 'live-org-a', 'live-student-a', opened.revision,
        opened.lease_epoch, 'lease-hash-1', '{"1":2}'::jsonb, '{}'::jsonb,
        pg_catalog.jsonb_build_object(
            'currentQuestionId', 2,
            'handwritingCheckpoint', pg_catalog.jsonb_build_object(
                'schemaVersion', 1,
                'drawings', pg_catalog.jsonb_build_object('1', pg_catalog.jsonb_build_array('M 1 1 L 2 2')),
                'pageCount', 1,
                'strokeCount', 1
            )
        ), 45, false
    );
    if checkpointed.answers <> '{"1":2}'::jsonb
       or checkpointed.progress_payload #>> '{handwritingCheckpoint,drawings,1,0}' <> 'M 1 1 L 2 2' then
        raise exception 'durable attempt checkpoint did not round-trip progress';
    end if;

    select * into resumed from public.omr_open_attempt_session_v1(
        'ignored-retry-session', 'live-org-a', 'live-exam-a', '',
        'live-student-a', 'Live Student', 'registered',
        'live-session-ticket', 'live-session-attempt', '', '',
        '{}'::integer[], array[1,2], exam_updated, exam_snapshot,
        600, null, 'unused-new-hash', 'lease-hash-1', 45
    );
    if not resumed.lease_acquired or resumed.lease_token_rotated
       or resumed.progress_payload #>> '{handwritingCheckpoint,drawings,1,0}' <> 'M 1 1 L 2 2' then
        raise exception 'same-device durable resume failed';
    end if;

    select * into taken_over from public.omr_takeover_attempt_session_v1(
        resumed.session_id, 'live-org-a', 'live-student-a', resumed.revision,
        resumed.lease_epoch, 'replacement-hash', 45
    );
    if taken_over.lease_epoch <> resumed.lease_epoch + 1
       or taken_over.revision <> resumed.revision + 1
       or taken_over.answers <> '{"1":2}'::jsonb
       or taken_over.progress_payload #>> '{handwritingCheckpoint,drawings,1,0}' <> 'M 1 1 L 2 2' then
        raise exception 'takeover did not restore the fenced handwriting generation';
    end if;
    begin
        perform * from public.omr_heartbeat_attempt_session_v1(
            resumed.session_id, 'live-org-a', 'live-student-a', resumed.lease_epoch,
            'lease-hash-1', 45
        );
        raise exception 'old device retained its lease after handwriting takeover';
    exception when others then
        if sqlerrm not like '%lease conflict%' then raise; end if;
    end;
    select * into checkpointed from public.omr_checkpoint_attempt_session_v1(
        taken_over.session_id, 'live-org-a', 'live-student-a', taken_over.revision,
        taken_over.lease_epoch, 'replacement-hash', '{"1":3}'::jsonb, '{}'::jsonb,
        '{"currentQuestionId":1}'::jsonb, 45, false
    );
    if checkpointed.progress_payload #>> '{handwritingCheckpoint,drawings,1,0}' <> 'M 1 1 L 2 2' then
        raise exception 'answer-only checkpoint erased the last safe handwriting generation';
    end if;

    begin
        perform * from public.omr_open_attempt_session_v1(
            'stale-session', 'live-org-a', 'live-exam-a', '',
            'stale-student', 'Stale Student', 'registered',
            'stale-ticket', 'stale-attempt', '', '', '{}'::integer[], array[1,2],
            exam_updated - interval '1 second', exam_snapshot, 600, null,
            'stale-lease', '', 45
        );
        raise exception 'stale exam revision was accepted';
    exception when others then
        if sqlerrm not like '%exam revision stale%' then raise; end if;
    end;

    update public.omr_attempt_sessions set lease_expires_at = now() - interval '1 second'
     where id = opened.session_id;
    begin
        select * into prepared from public.omr_prepare_attempt_session_submit_v1(
            opened.session_id, 'live-org-a', 'live-student-a',
            checkpointed.revision, checkpointed.lease_epoch, 'lease-hash-1'
        );
        raise exception 'expired lease prepared a submission';
    exception when others then
        if sqlerrm not like '%lease conflict%' then raise; end if;
    end;

    select * into opened from public.omr_open_attempt_session_v1(
        'live-session-expiry', 'live-org-a', 'live-exam-a', '',
        'expiry-student', 'Expiry Student', 'registered',
        'expiry-ticket', 'expiry-attempt', '', '', '{}'::integer[], array[1,2],
        exam_updated, exam_snapshot, 600, null, 'expiry-lease', '', 45
    );
    update public.omr_attempt_sessions
       set started_at = now() - interval '10 seconds',
           deadline_at = now() - interval '1 second'
     where id = opened.session_id;
    select * into checkpointed from public.omr_checkpoint_attempt_session_v1(
        opened.session_id, 'live-org-a', 'expiry-student', opened.revision,
        opened.lease_epoch, 'expiry-lease', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 45, false
    );
    if checkpointed.status <> 'expired' or not exists (
        select 1 from public.omr_attempt_sessions
         where id = opened.session_id and status = 'expired'
    ) then
        raise exception 'attempt expiration was not persisted';
    end if;

    select * into opened from public.omr_open_attempt_session_v1(
        'live-session-final-grace', 'live-org-a', 'live-exam-a', '',
        'grace-student', 'Grace Student', 'registered',
        'grace-ticket', 'grace-attempt', '', '', '{}'::integer[], array[1,2],
        exam_updated, exam_snapshot, 600, null, 'grace-lease', '', 45
    );
    update public.omr_attempt_sessions
       set started_at = now() - interval '10 seconds',
           deadline_at = now() - interval '1 second'
     where id = opened.session_id
     returning lease_expires_at into lease_before;
    select * into heartbeat_row from public.omr_heartbeat_attempt_session_v1(
        opened.session_id, 'live-org-a', 'grace-student', opened.lease_epoch,
        'grace-lease', 45
    );
    if heartbeat_row.status <> 'in_progress' or exists (
        select 1 from public.omr_attempt_sessions
         where id = opened.session_id and lease_expires_at is distinct from lease_before
    ) then raise exception 'deadline grace heartbeat mutated the lease'; end if;
    select * into checkpointed from public.omr_checkpoint_attempt_session_v1(
        opened.session_id, 'live-org-a', 'grace-student', opened.revision,
        opened.lease_epoch, 'grace-lease', '{"2":1}'::jsonb, '{}'::jsonb,
        '{"currentQuestionId":2}'::jsonb, 45, true
    );
    if checkpointed.status <> 'in_progress' or checkpointed.answers <> '{"2":1}'::jsonb then
        raise exception 'final checkpoint grace did not preserve final answers';
    end if;

    update public.omr_attempt_sessions
       set grading_snapshot = pg_catalog.jsonb_set(
           grading_snapshot, '{pdfDataRef}',
           '{"store":"remote","kind":"problem_pdf","key":"active-snapshot-problem","organizationId":"live-org-a","examId":"live-exam-a"}'::jsonb,
           true
       )
     where id = opened.session_id;
    insert into public.omr_remote_asset_cleanup_queue (
        organization_id, exam_id, asset_kind, source_type, source_id,
        storage_bucket, object_path, reason
    ) values (
        'live-org-a', 'live-exam-a', 'problem_pdf', 'remote_asset',
        'active-snapshot-problem', 'omr-private-assets',
        'organizations/live-org-a/exams/live-exam-a/problem/active-snapshot-problem.pdf',
        'asset_replaced'
    );
    claimed := public.omr_claim_remote_asset_cleanup_v1('attempt-gc-active', 100, 60);
    if claimed @> '[{"object_path":"organizations/live-org-a/exams/live-exam-a/problem/active-snapshot-problem.pdf"}]'::jsonb then
        raise exception 'active attempt snapshot asset was leased for cleanup';
    end if;
    update public.omr_attempt_sessions
       set started_at = now() - interval '60 seconds',
           deadline_at = now() - interval '31 seconds'
     where id = opened.session_id;
    claimed := public.omr_claim_remote_asset_cleanup_v1('attempt-gc-terminal', 100, 60);
    if not claimed @> '[{"object_path":"organizations/live-org-a/exams/live-exam-a/problem/active-snapshot-problem.pdf"}]'::jsonb
       or not exists (
           select 1 from public.omr_attempt_sessions
            where id = opened.session_id and status = 'expired'
       ) then
        raise exception 'terminal attempt snapshot asset remained cleanup-blocked';
    end if;
end
$$;

-- Durable handwriting uses an immutable UUID generation per reservation. A
-- response-loss retry replays that reservation, a failed attachment can be
-- discarded into the cleanup queue, an attached object is protected, and a
-- crashed two-hour reservation is reaped.
do $$
declare
    exam_snapshot jsonb;
    canonical_id text := 'asset_handwriting_' || pg_catalog.md5('live-handwriting-session')
        || '_11111111-1111-4111-8111-111111111111';
    retry_candidate_id text := 'asset_handwriting_' || pg_catalog.md5('live-handwriting-session')
        || '_33333333-3333-4333-8333-333333333333';
    stale_id text := 'asset_handwriting_' || pg_catalog.md5('live-handwriting-stale-session')
        || '_22222222-2222-4222-8222-222222222222';
    prepared jsonb;
    retried jsonb;
    claimed jsonb;
    cleanup_id text;
    cleanup_attempt integer;
    deletion_authorized boolean;
begin
    update public.omr_organizations set plan = 'pro' where id = 'live-org-a';
    select payload into exam_snapshot from public.omr_exams where id = 'live-exam-a';
    insert into public.omr_attempts (
        id, ticket_id, organization_id, exam_id, student_name, student_id,
        identity_type, status, payload, started_at, finished_at
    ) values
        ('attempt_live-handwriting-ticket', 'live-handwriting-ticket', 'live-org-a',
         'live-exam-a', 'Handwriting Student', 'live-handwriting-student',
         'registered', 'completed', '{"id":"attempt_live-handwriting-ticket"}',
         now() - interval '10 minutes', now()),
        ('attempt_live-handwriting-stale', 'live-handwriting-stale-ticket', 'live-org-a',
         'live-exam-a', 'Stale Handwriting Student', 'live-handwriting-stale-student',
         'registered', 'completed', '{"id":"attempt_live-handwriting-stale"}',
         now() - interval '10 minutes', now());
    insert into public.omr_attempt_sessions (
        id, organization_id, exam_id, owner_student_id, student_name,
        identity_type, scope_key, submission_id, attempt_id,
        allowed_question_ids, grading_snapshot, status, started_at, deadline_at,
        last_heartbeat_at, lease_token_hash, lease_expires_at,
        submitted_attempt_id, submitted_at
    ) values
        ('live-handwriting-session', 'live-org-a', 'live-exam-a',
         'live-handwriting-student', 'Handwriting Student', 'registered', 'base',
         'live-handwriting-ticket', 'attempt_live-handwriting-ticket', array[1],
         exam_snapshot, 'submitted', now() - interval '10 minutes', now() + interval '1 hour',
         now(), 'finished-lease', now(), 'attempt_live-handwriting-ticket', now()),
        ('live-handwriting-stale-session', 'live-org-a', 'live-exam-a',
         'live-handwriting-stale-student', 'Stale Handwriting Student', 'registered', 'base',
         'live-handwriting-stale-ticket', 'attempt_live-handwriting-stale', array[1],
         exam_snapshot, 'submitted', now() - interval '10 minutes', now() + interval '1 hour',
         now(), 'finished-lease', now(), 'attempt_live-handwriting-stale', now());

    prepared := public.omr_prepare_attempt_handwriting_asset_v1(
        'live-handwriting-session', pg_catalog.jsonb_build_object(
            'id', canonical_id, 'organization_id', 'live-org-a',
            'kind', 'attempt_handwriting', 'attempt_id', 'attempt_live-handwriting-ticket',
            'storage_bucket', 'omr-private-assets',
            'object_path', 'organizations/live-org-a/attempts/attempt_live-handwriting-ticket/handwriting/' || canonical_id || '.json',
            'mime_type', 'application/json', 'byte_size', 2,
            'sha256_hex', repeat('a', 64)
        )
    );
    retried := public.omr_prepare_attempt_handwriting_asset_v1(
        'live-handwriting-session', pg_catalog.jsonb_set(
            pg_catalog.jsonb_set(
                prepared -> 'asset', '{id}', pg_catalog.to_jsonb(retry_candidate_id), true
            ),
            '{object_path}',
            pg_catalog.to_jsonb(
                'organizations/live-org-a/attempts/attempt_live-handwriting-ticket/handwriting/'
                || retry_candidate_id || '.json'
            ),
            true
        )
    );
    if prepared ->> 'objectRequired' <> 'true'
       or retried ->> 'objectRequired' <> 'false'
       or prepared #>> '{asset,id}' is distinct from canonical_id then
        raise exception 'handwriting reservation response-loss replay was not idempotent';
    end if;
    if not exists (select 1 from public.omr_remote_assets where id = canonical_id) then
        raise exception 'handwriting reservation metadata disappeared before discard';
    end if;
    perform public.omr_discard_attempt_handwriting_asset_v1(
        'live-handwriting-session', canonical_id
    );
    if exists (select 1 from public.omr_remote_assets where id = canonical_id) then
        raise exception 'failed handwriting attachment reservation was not discarded';
    end if;
    if not exists (
        select 1 from public.omr_remote_asset_cleanup_queue queue
         where queue.source_id = canonical_id
    ) then raise exception 'failed handwriting attachment did not queue orphan cleanup'; end if;

    retried := public.omr_prepare_attempt_handwriting_asset_v1(
        'live-handwriting-session', prepared -> 'asset'
    );
    if retried ->> 'status' is distinct from 'cleanup_pending' then
        raise exception 'handwriting generation path was reused before orphan cleanup';
    end if;
    claimed := public.omr_claim_remote_asset_cleanup_v1('handwriting-aba-worker', 100, 60);
    select item ->> 'id', (item ->> 'attempts')::integer
      into cleanup_id, cleanup_attempt
      from pg_catalog.jsonb_array_elements(claimed) item
     where item ->> 'object_path' = prepared #>> '{asset,object_path}';
    if cleanup_id is null then
        raise exception 'handwriting orphan cleanup was not leased';
    end if;

    -- Reusing the same worker id cannot make an expired attempt-N lease valid
    -- after the queue is claimed again as attempt N+1.
    update public.omr_remote_asset_cleanup_queue
       set attempts = cleanup_attempt + 1,
           lease_owner = 'handwriting-aba-worker',
           lease_until = now() + interval '60 seconds'
     where id::text = cleanup_id;
    deletion_authorized := public.omr_authorize_remote_asset_cleanup_delete_v1(
        cleanup_id, 'handwriting-aba-worker', cleanup_attempt
    );
    if deletion_authorized or not exists (
        select 1 from public.omr_remote_asset_cleanup_queue queue
         where queue.id::text = cleanup_id
    ) then
        raise exception 'expired cleanup attempt was accepted after same-worker re-lease';
    end if;
    cleanup_attempt := cleanup_attempt + 1;

    -- Simulate a pre-fencing server that recreated the generation metadata
    -- after the job was handed to a worker. Reauthorization must cancel that
    -- stale job before the external Storage delete can run.
    perform public.omr_save_remote_asset_metadata_v1(prepared -> 'asset');
    deletion_authorized := public.omr_authorize_remote_asset_cleanup_delete_v1(
        cleanup_id, 'handwriting-aba-worker', cleanup_attempt
    );
    if deletion_authorized or exists (
        select 1 from public.omr_remote_asset_cleanup_queue queue
         where queue.id::text = cleanup_id
    ) then
        raise exception 'handwriting ABA cleanup remained authorized after path recreation';
    end if;
    perform public.omr_attach_attempt_handwriting_v1(
        'live-handwriting-ticket', canonical_id,
        pg_catalog.jsonb_build_object(
            'store','remote','key',canonical_id,'organizationId','live-org-a',
            'kind','attempt_handwriting','attemptId','attempt_live-handwriting-ticket'
        )
    );
    insert into public.omr_remote_asset_cleanup_queue (
        organization_id, asset_kind, source_type, source_id,
        storage_bucket, object_path, reason, available_at
    ) values (
        'live-org-a', 'attempt_handwriting',
        'remote_asset', canonical_id, 'omr-private-assets',
        prepared #>> '{asset,object_path}', 'asset_replaced', now() - interval '10 days'
    ) on conflict (storage_bucket, object_path) do update
        set status = 'pending', available_at = excluded.available_at,
            lease_owner = null, lease_until = null;
    claimed := public.omr_claim_remote_asset_cleanup_v1('handwriting-attached-protection', 100, 60);
    if claimed @> pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
           'object_path', prepared #>> '{asset,object_path}'
       ))
       or not exists (select 1 from public.omr_remote_assets where id = canonical_id) then
        raise exception 'attached handwriting was not protected from cleanup';
    end if;

    prepared := public.omr_prepare_attempt_handwriting_asset_v1(
        'live-handwriting-stale-session', pg_catalog.jsonb_build_object(
            'id', stale_id, 'organization_id', 'live-org-a',
            'kind', 'attempt_handwriting', 'attempt_id', 'attempt_live-handwriting-stale',
            'storage_bucket', 'omr-private-assets',
            'object_path', 'organizations/live-org-a/attempts/attempt_live-handwriting-stale/handwriting/' || stale_id || '.json',
            'mime_type', 'application/json', 'byte_size', 2,
            'sha256_hex', repeat('b', 64)
        )
    );
    update public.omr_remote_assets set created_at = now() - interval '3 hours'
     where id = stale_id;
    perform public.omr_claim_remote_asset_cleanup_v1('handwriting-stale-recovery', 100, 60);
    if not exists (select 1 from public.omr_remote_assets where id = stale_id)
       or exists (
           select 1 from public.omr_remote_asset_cleanup_queue where source_id = stale_id
       ) then raise exception 'handwriting attachment response-loss retention was not preserved'; end if;
    update public.omr_attempt_sessions set updated_at = now() - interval '8 days'
     where id = 'live-handwriting-stale-session';
    update public.omr_remote_assets set created_at = now() - interval '8 days'
     where id = stale_id;
    perform public.omr_claim_remote_asset_cleanup_v1('handwriting-stale-recovery-after-retention', 100, 60);
    if exists (select 1 from public.omr_remote_assets where id = stale_id)
       or not exists (
           select 1 from public.omr_remote_asset_cleanup_queue where source_id = stale_id
       ) then raise exception 'stale handwriting reservation was not recovered after retention'; end if;
    update public.omr_organizations set plan = 'free' where id = 'live-org-a';
end
$$;

-- The optimized checkpoint has one session scan, terminal GC is bounded, dead
-- cleanup requeue is fenced, and opportunistic maintenance never exceeds the
-- caller's validated batch.
insert into public.omr_attempt_sessions (
    id, organization_id, exam_id, owner_student_id, student_name,
    identity_type, scope_key, submission_id, attempt_id,
    allowed_question_ids, grading_snapshot, status, started_at, deadline_at,
    last_heartbeat_at, lease_token_hash, lease_expires_at
)
select 'checkpoint-lock-clock-fixture', 'live-org-a', 'live-exam-a',
       'checkpoint-lock-owner', 'Lock Clock Student', 'registered', 'base',
       'checkpoint-lock-submission', 'checkpoint-lock-attempt', array[1],
       exam.payload, 'in_progress', pg_catalog.clock_timestamp(),
       pg_catalog.clock_timestamp() + interval '1 hour',
       pg_catalog.clock_timestamp(), 'checkpoint-lock-lease',
       pg_catalog.clock_timestamp() + interval '2 seconds'
  from public.omr_exams exam where exam.id = 'live-exam-a';

reset role;
do $$
declare
    v_remote_pid integer;
    v_remote_sleeping boolean := false;
    v_counter integer;
begin
    perform extensions.dblink_connect(
        'checkpoint-lock-clock',
        'host=127.0.0.1 port=' || current_setting('port')
            || ' dbname=' || current_database()
            || ' user=postgres password=omr-live-test-password'
    );
    select remote.pid into v_remote_pid
      from extensions.dblink(
          'checkpoint-lock-clock', 'select pg_backend_pid()'
      ) as remote(pid integer);
    perform extensions.dblink_send_query(
        'checkpoint-lock-clock',
        'select pg_sleep(3) from ('
            || 'select id from public.omr_attempt_sessions '
            || 'where id = ''checkpoint-lock-clock-fixture'' for update'
            || ') locked'
    );
    for v_counter in 1..200 loop
        select activity.wait_event = 'PgSleep'
          into v_remote_sleeping
          from pg_catalog.pg_stat_activity activity
         where activity.pid = v_remote_pid;
        exit when coalesce(v_remote_sleeping, false);
        perform pg_catalog.pg_sleep(0.01);
    end loop;
    if not coalesce(v_remote_sleeping, false)
       or not exists (
           select 1 from public.omr_attempt_sessions
            where id = 'checkpoint-lock-clock-fixture'
              and lease_expires_at > pg_catalog.clock_timestamp()
       ) then
        raise exception 'checkpoint lock wait concurrency fixture was not ready';
    end if;

    begin
        perform * from public.omr_checkpoint_attempt_session_v1(
            'checkpoint-lock-clock-fixture', 'live-org-a', 'checkpoint-lock-owner',
            1, 1, 'checkpoint-lock-lease', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
            45, false
        );
        raise exception 'checkpoint lock wait used a stale clock';
    exception when raise_exception then
        if sqlerrm = 'checkpoint lock wait used a stale clock' then raise; end if;
        if sqlerrm <> 'attempt session lease conflict' then raise; end if;
    end;

    perform * from extensions.dblink_get_result(
        'checkpoint-lock-clock'
    ) as remote_result(slept text);
    perform extensions.dblink_disconnect('checkpoint-lock-clock');
end
$$;

delete from public.omr_attempt_sessions where id = 'checkpoint-lock-clock-fixture';
set role service_role;

do $$
declare
    v_exam_snapshot jsonb;
    v_deleted integer;
    v_requeue jsonb;
    v_claimed jsonb;
    v_cleanup_id text;
    v_checkpoint_definition text;
begin
    v_checkpoint_definition := lower(pg_catalog.pg_get_functiondef(
        'public.omr_checkpoint_attempt_session_v1(text,text,text,bigint,bigint,text,jsonb,jsonb,jsonb,integer,boolean)'::regprocedure
    ));
    if regexp_count(v_checkpoint_definition, 'from public.omr_attempt_sessions') <> 1 then
        raise exception 'checkpoint validation performed more than one session table scan';
    end if;
    if strpos(v_checkpoint_definition, 'v_now := pg_catalog.clock_timestamp();')
       < strpos(v_checkpoint_definition, 'for update;') then
        raise exception 'checkpoint lock wait used a stale clock';
    end if;
    if pg_catalog.to_regclass('public.omr_attempt_sessions_submitted_asset_guard_idx') is null
       or pg_catalog.pg_get_expr(
           (select index_row.indpred from pg_catalog.pg_index index_row
             where index_row.indexrelid = 'public.omr_attempt_sessions_submitted_asset_guard_idx'::regclass),
           'public.omr_attempt_sessions'::regclass
       ) !~ 'status.*submitted' then
        raise exception 'submitted handwriting guard index is missing';
    end if;

    update public.omr_attempt_sessions
       set updated_at = case id
           when 'live-session-expiry' then now() - interval '10 days'
           else now() - interval '9 days'
       end
     where id in ('live-session-expiry', 'live-session-final-grace')
       and status = 'expired';
    v_deleted := public.omr_gc_attempt_sessions_v1(1, 7);
    if v_deleted <> 1 or (
        select count(*) from public.omr_attempt_sessions
         where id in ('live-session-expiry', 'live-session-final-grace')
    ) <> 1 then
        raise exception 'terminal session GC exceeded its batch';
    end if;

    insert into public.omr_remote_asset_cleanup_queue (
        organization_id, asset_kind, source_type, source_id, storage_bucket,
        object_path, byte_size, reason, status, attempts, available_at
    ) values (
        'live-org-a', 'problem_pdf', 'upload_intent', 'dead-requeue-fixture',
        'omr-private-assets',
        'organizations/live-org-a/exams/live-exam-a/problem/dead-requeue-fixture.pdf',
        1, 'expired_upload', 'dead', 10, now() - interval '1 day'
    ) returning id::text into v_cleanup_id;
    if public.omr_requeue_dead_remote_asset_cleanup_v1(
        'live-org-b', v_cleanup_id, 10, 'live-operator', 'retry verified path'
    ) ->> 'status' <> 'conflict'
       or public.omr_requeue_dead_remote_asset_cleanup_v1(
           'live-org-a', v_cleanup_id, 9, 'live-operator', 'retry verified path'
       ) ->> 'status' <> 'conflict' then
        raise exception 'dead cleanup requeue fence failed';
    end if;
    v_requeue := public.omr_requeue_dead_remote_asset_cleanup_v1(
        'live-org-a', v_cleanup_id, 10, 'live-operator', 'retry verified path'
    );
    if v_requeue <> jsonb_build_object('status', 'requeued', 'cleanupId', v_cleanup_id)
       or not exists (
           select 1 from public.omr_remote_asset_cleanup_queue
            where id::text = v_cleanup_id and status = 'pending' and attempts = 11
              and retry_count = 0 and last_error = 'operator_requeue'
       ) then
        raise exception 'dead cleanup requeue fence failed';
    end if;
    if public.omr_requeue_dead_remote_asset_cleanup_v1(
        'live-org-a', v_cleanup_id, 10, 'stale-operator', 'stale replay'
    ) ->> 'status' <> 'conflict' then
        raise exception 'stale dead cleanup requeue crossed the generation fence';
    end if;

    update public.omr_remote_asset_cleanup_queue
       set available_at = now() - interval '30 days'
     where id::text = v_cleanup_id;
    v_claimed := public.omr_claim_remote_asset_cleanup_v1('requeue-generation-worker', 1, 60);
    if v_claimed #>> '{0,id}' is distinct from v_cleanup_id
       or (v_claimed #>> '{0,attempts}')::integer <> 12
       or (select count(*) from pg_catalog.jsonb_object_keys(v_claimed -> 0)) <> 4
       or (v_claimed -> 0) - array['id','attempts','storage_bucket','object_path'] <> '{}'::jsonb then
        raise exception 'cleanup claim leaked internal row metadata';
    end if;
    perform public.omr_fail_remote_asset_cleanup_v1(
        v_cleanup_id, 'requeue-generation-worker', 12, 'live failure code'
    );
    update public.omr_remote_asset_cleanup_queue
       set status = 'dead', retry_count = 10,
           lease_owner = null, lease_until = null
     where id::text = v_cleanup_id;
    if public.omr_requeue_dead_remote_asset_cleanup_v1(
        'live-org-a', v_cleanup_id, 10, 'stale-operator', 'stale replay after dead'
    ) ->> 'status' <> 'conflict'
       or public.omr_requeue_dead_remote_asset_cleanup_v1(
           'live-org-a', v_cleanup_id, 12, 'current-operator', 'approved replay'
       ) ->> 'status' <> 'requeued' then
        raise exception 'stale dead cleanup requeue crossed the generation fence';
    end if;
    if exists (
        select 1 from public.omr_remote_asset_cleanup_queue
         where id::text = v_cleanup_id
           and last_error <> 'operator_requeue'
    ) then
        raise exception 'cleanup operator audit retained raw PII';
    end if;
    delete from public.omr_remote_asset_cleanup_queue where id::text = v_cleanup_id;

    select payload into v_exam_snapshot from public.omr_exams where id = 'live-exam-a';
    insert into public.omr_attempt_sessions (
        id, organization_id, exam_id, owner_student_id, student_name,
        identity_type, scope_key, submission_id, attempt_id,
        allowed_question_ids, grading_snapshot, status, started_at, deadline_at,
        last_heartbeat_at, lease_token_hash, lease_expires_at
    )
    select 'bounded-maintenance-' || item, 'live-org-a', 'live-exam-a',
           'bounded-owner-' || item, 'Bounded Student', 'registered', 'base',
           'bounded-submission-' || item, 'bounded-attempt-' || item,
           array[1], v_exam_snapshot, 'in_progress',
           now() - interval '2 minutes', now() - interval '1 minute',
           now() - interval '2 minutes', 'bounded-lease-' || item,
           now() - interval '1 minute'
      from generate_series(1, 3) item;
    perform public.omr_claim_remote_asset_cleanup_v1('bounded-maintenance-worker', 1, 60);
    if (select count(*) from public.omr_attempt_sessions
         where id like 'bounded-maintenance-%' and status = 'expired') <> 1 then
        raise exception 'cleanup maintenance exceeded its bounded batch';
    end if;
    delete from public.omr_attempt_sessions where id like 'bounded-maintenance-%';
end
$$;

reset role;

-- BEGIN v4 transient readiness drift probes
-- Every injected drift runs in a subtransaction. The sentinel exception rolls
-- it back; a readiness assertion failure uses another SQLSTATE and propagates.
do $$
declare
    readiness jsonb;
begin
    begin
        insert into public.omr_remote_asset_cleanup_queue (
            organization_id, exam_id, asset_kind, source_type, source_id,
            storage_bucket, object_path, reason
        )
        select 'live-org-a', 'backlog-exam-' || item, 'problem_pdf',
               'upload_intent', 'backlog-asset-' || item, 'omr-private-assets',
               'organizations/live-org-a/exams/backlog-exam-' || item
                   || '/problem/backlog-asset-' || item || '.pdf',
               'expired_upload'
          from pg_catalog.generate_series(1, 101) item;
        readiness := public.omr_service_readiness_v1();
        if readiness->>'teacherAssetCleanupBacklogHealthy' <> 'false'
           or readiness->>'ready' <> 'false' then
            raise exception 'v6 readiness accepted cleanup backlog above drain capacity';
        end if;
        raise exception using errcode = 'P1001', message = 'rollback v6 cleanup backlog drift';
    exception when sqlstate 'P1001' then null;
    end;
end
$$;

do $$
declare
    readiness jsonb;
begin
    begin
        grant usage on schema public to anon;
        readiness := public.omr_service_readiness_v1();
        if readiness->>'browserSchemaPrivilegesDenied' <> 'false'
            or readiness->>'ready' <> 'false'
        then
            raise exception 'v4 readiness accepted browser schema usage';
        end if;
        raise exception using errcode = 'P1001', message = 'rollback v4 schema drift';
    exception when sqlstate 'P1001' then null;
    end;
end
$$;

do $$
declare
    readiness jsonb;
begin
    begin
        drop function public.omr_answer_attempt_question_v1(
            text, text, text, text, text, text, text
        );
        execute $statement$
            create procedure public.omr_answer_attempt_question_v1(
                text, text, text, text, text, text, text
            )
            language sql
            as 'select 1'
        $statement$;
        revoke all on procedure public.omr_answer_attempt_question_v1(
            text, text, text, text, text, text, text
        ) from public, anon, authenticated;
        grant execute on procedure public.omr_answer_attempt_question_v1(
            text, text, text, text, text, text, text
        ) to service_role;
        readiness := public.omr_service_readiness_v1();
        if readiness->>'scopedRpcPrivilegesReady' <> 'false'
            or readiness->>'serviceRolePrivilegesReady' <> 'true'
            or readiness->>'browserFunctionPrivilegesDenied' <> 'true'
            or readiness->>'serverGatewayCapabilitiesReady' <> 'true'
            or readiness->>'ready' <> 'false'
        then
            raise exception 'v4 readiness accepted a scoped procedure impostor';
        end if;
        raise exception using errcode = 'P1021', message = 'rollback v4 scoped procedure drift';
    exception when sqlstate 'P1021' then null;
    end;
end
$$;

do $$
declare
    readiness jsonb;
begin
    begin
        execute $statement$
            create function public.omr_save_exam_v1(text)
            returns boolean
            language sql
            as 'select true'
        $statement$;
        readiness := public.omr_service_readiness_v1();
        if readiness->>'serverGatewayCapabilitiesReady' <> 'false'
            or readiness->>'ready' <> 'false'
        then
            raise exception 'v4 readiness accepted an extra server gateway overload';
        end if;
        raise exception using errcode = 'P1020', message = 'rollback v4 gateway overload drift';
    exception when sqlstate 'P1020' then null;
    end;
end
$$;

do $$
declare
    readiness jsonb;
begin
    begin
        drop function public.omr_save_remote_asset_metadata_v1(jsonb);
        execute $statement$
            create procedure public.omr_save_remote_asset_metadata_v1(jsonb)
            language sql
            as 'select 1'
        $statement$;
        revoke all on procedure
            public.omr_save_remote_asset_metadata_v1(jsonb)
            from public, anon, authenticated;
        grant execute on procedure
            public.omr_save_remote_asset_metadata_v1(jsonb)
            to service_role;
        readiness := public.omr_service_readiness_v1();
        if readiness->>'serverGatewayCapabilitiesReady' <> 'false'
            or readiness->>'serviceRolePrivilegesReady' <> 'true'
            or readiness->>'browserFunctionPrivilegesDenied' <> 'true'
            or readiness->>'scopedRpcPrivilegesReady' <> 'true'
            or readiness->>'ready' <> 'false'
        then
            raise exception 'v4 readiness accepted a server gateway procedure impostor';
        end if;
        raise exception using errcode = 'P1022', message = 'rollback v4 gateway procedure drift';
    exception when sqlstate 'P1022' then null;
    end;
end
$$;

do $$
declare
    readiness jsonb;
begin
    begin
        grant select (title) on public.omr_exams to public;
        readiness := public.omr_service_readiness_v1();
        if readiness->>'anonTablePrivilegesDenied' <> 'false'
            or readiness->>'authenticatedCanonicalPrivilegesDenied' <> 'false'
            or readiness->>'ready' <> 'false'
        then
            raise exception 'v4 readiness accepted a PUBLIC column grant';
        end if;
        raise exception using errcode = 'P1012', message = 'rollback v4 PUBLIC column drift';
    exception when sqlstate 'P1012' then null;
    end;
end
$$;

do $$
declare
    readiness jsonb;
begin
    begin
        grant maintain on public.omr_exams to authenticated;
        readiness := public.omr_service_readiness_v1();
        if readiness->>'authenticatedCanonicalPrivilegesDenied' <> 'false'
            or readiness->>'ready' <> 'false'
        then
            raise exception 'v4 readiness accepted a PG17 MAINTAIN grant';
        end if;
        raise exception using errcode = 'P1013', message = 'rollback v4 MAINTAIN drift';
    exception when sqlstate 'P1013' then null;
    end;
end
$$;

do $$
declare
    readiness jsonb;
begin
    begin
        create role omr_v4_browser_parent noinherit;
        alter role authenticated inherit;
        grant omr_v4_browser_parent to authenticated;
        grant select on public.omr_exams to omr_v4_browser_parent;
        readiness := public.omr_service_readiness_v1();
        if readiness->>'authenticatedCanonicalPrivilegesDenied' <> 'false'
            or readiness->>'ready' <> 'false'
        then
            raise exception 'v4 readiness accepted an inherited browser table grant';
        end if;
        raise exception using errcode = 'P1014', message = 'rollback v4 inherited grant drift';
    exception when sqlstate 'P1014' then null;
    end;
end
$$;

do $$
declare
    readiness jsonb;
begin
    begin
        grant create on schema public to authenticated;
        readiness := public.omr_service_readiness_v1();
        if readiness->>'browserSchemaPrivilegesDenied' <> 'false'
            or readiness->>'ready' <> 'false'
        then
            raise exception 'v4 readiness accepted browser schema create';
        end if;
        raise exception using errcode = 'P1011', message = 'rollback v4 schema create drift';
    exception when sqlstate 'P1011' then null;
    end;
end
$$;

do $$
declare
    readiness jsonb;
begin
    begin
        alter table public.omr_comments rename to v4_hidden_comments;
        create table public.omr_replacement_rogue (
            id text primary key
        );
        alter table public.omr_replacement_rogue enable row level security;
        alter table public.omr_replacement_rogue force row level security;
        readiness := public.omr_service_readiness_v1();
        if readiness->>'canonicalTablesForceRls' <> 'false'
            or readiness->>'ready' <> 'false'
        then
            raise exception 'v4 readiness accepted a replacement rogue canonical table';
        end if;
        raise exception using errcode = 'P1015', message = 'rollback v4 canonical allowlist drift';
    exception when sqlstate 'P1015' then null;
    end;
end
$$;

do $$
declare
    readiness jsonb;
begin
    begin
        grant select on public.omr_exams to anon;
        readiness := public.omr_service_readiness_v1();
        if readiness->>'anonTablePrivilegesDenied' <> 'false'
            or readiness->>'ready' <> 'false'
        then
            raise exception 'v4 readiness accepted an anon table grant';
        end if;
        raise exception using errcode = 'P1002', message = 'rollback v4 anon table drift';
    exception when sqlstate 'P1002' then null;
    end;
end
$$;

do $$
declare
    readiness jsonb;
begin
    begin
        execute $statement$
            create function public.omr_answer_attempt_question_v1(text)
            returns boolean
            language sql
            as 'select true'
        $statement$;
        readiness := public.omr_service_readiness_v1();
        if readiness->>'scopedRpcPrivilegesReady' <> 'false'
            or readiness->>'ready' <> 'false'
        then
            raise exception 'v4 readiness accepted an extra scoped RPC overload';
        end if;
        raise exception using errcode = 'P1016', message = 'rollback v4 scoped overload drift';
    exception when sqlstate 'P1016' then null;
    end;
end
$$;

do $$
declare
    readiness jsonb;
begin
    begin
        grant select on public.omr_exams to authenticated;
        readiness := public.omr_service_readiness_v1();
        if readiness->>'authenticatedCanonicalPrivilegesDenied' <> 'false'
            or readiness->>'ready' <> 'false'
        then
            raise exception 'v4 readiness accepted an authenticated table grant';
        end if;
        raise exception using errcode = 'P1003', message = 'rollback v4 authenticated table drift';
    exception when sqlstate 'P1003' then null;
    end;
end
$$;

do $$
declare
    readiness jsonb;
begin
    begin
        create sequence public.omr_v4_readiness_sequence;
        grant usage on sequence public.omr_v4_readiness_sequence to anon;
        readiness := public.omr_service_readiness_v1();
        if readiness->>'browserSequencePrivilegesDenied' <> 'false'
            or readiness->>'ready' <> 'false'
        then
            raise exception 'v4 readiness accepted a browser sequence grant';
        end if;
        raise exception using errcode = 'P1004', message = 'rollback v4 sequence drift';
    exception when sqlstate 'P1004' then null;
    end;
end
$$;

do $$
declare
    readiness jsonb;
begin
    begin
        grant execute on function public.omr_service_readiness_v1() to anon;
        readiness := public.omr_service_readiness_v1();
        if readiness->>'browserFunctionPrivilegesDenied' <> 'false'
            or readiness->>'ready' <> 'false'
        then
            raise exception 'v4 readiness accepted a browser function grant';
        end if;
        raise exception using errcode = 'P1005', message = 'rollback v4 function drift';
    exception when sqlstate 'P1005' then null;
    end;
end
$$;

do $$
declare
    readiness jsonb;
begin
    begin
        create policy "v4 transient canonical policy"
            on public.omr_exams
            for select
            to anon
            using (true);
        readiness := public.omr_service_readiness_v1();
        if readiness->>'canonicalPoliciesAbsent' <> 'false'
            or readiness->>'alphaPoliciesAbsent' <> 'false'
            or readiness->>'ready' <> 'false'
        then
            raise exception 'v4 readiness accepted a canonical policy';
        end if;
        raise exception using errcode = 'P1006', message = 'rollback v4 policy drift';
    exception when sqlstate 'P1006' then null;
    end;
end
$$;

do $$
declare
    readiness jsonb;
begin
    begin
        alter table public.omr_exams no force row level security;
        readiness := public.omr_service_readiness_v1();
        if readiness->>'canonicalTablesForceRls' <> 'false'
            or readiness->>'ready' <> 'false'
        then
            raise exception 'v4 readiness accepted a table without FORCE RLS';
        end if;
        raise exception using errcode = 'P1007', message = 'rollback v4 force RLS drift';
    exception when sqlstate 'P1007' then null;
    end;
end
$$;

do $$
declare
    readiness jsonb;
begin
    begin
        revoke select on public.omr_exams from service_role;
        readiness := public.omr_service_readiness_v1();
        if readiness->>'serviceRolePrivilegesReady' <> 'false'
            or readiness->>'ready' <> 'false'
        then
            raise exception 'v4 readiness accepted missing service-role table access';
        end if;
        raise exception using errcode = 'P1008', message = 'rollback v4 service-role drift';
    exception when sqlstate 'P1008' then null;
    end;
end
$$;

do $$
declare
    readiness jsonb;
begin
    begin
        revoke execute on function public.omr_answer_attempt_question_v1(
            text, text, text, text, text, text, text
        ) from service_role;
        readiness := public.omr_service_readiness_v1();
        if readiness->>'scopedRpcPrivilegesReady' <> 'false'
            or readiness->>'ready' <> 'false'
        then
            raise exception 'v4 readiness accepted missing scoped RPC execute';
        end if;
        raise exception using errcode = 'P1009', message = 'rollback v4 scoped RPC drift';
    exception when sqlstate 'P1009' then null;
    end;
end
$$;

do $$
declare
    readiness jsonb;
begin
    begin
        insert into public.omr_student_profiles (
            id, organization_id, display_name, status
        ) values (
            'v4-student-without-credential',
            'live-org-a',
            'Readiness Fixture',
            'active'
        );
        readiness := public.omr_service_readiness_v1();
        if readiness->>'organizationBackfillReady' <> 'false'
            or readiness->>'ready' <> 'false'
        then
            raise exception 'v4 readiness accepted a failed organization preflight';
        end if;
        raise exception using errcode = 'P1010', message = 'rollback v4 preflight drift';
    exception when sqlstate 'P1010' then null;
    end;
end
$$;

do $$
declare
    readiness jsonb;
begin
    begin
        alter function public.omr_save_exam_v1(jsonb, jsonb, jsonb, text)
            rename to omr_save_exam_v4_transient;
        readiness := public.omr_service_readiness_v1();
        if readiness->>'serverGatewayCapabilitiesReady' <> 'false'
            or readiness->>'ready' <> 'false'
        then
            raise exception 'v4 readiness accepted a missing server gateway';
        end if;
        raise exception using errcode = 'P1017', message = 'rollback v4 gateway drift';
    exception when sqlstate 'P1017' then null;
    end;
end
$$;

do $$
declare
    readiness jsonb;
begin
    begin
        drop index public.omr_exams_org_updated_id_idx;
        readiness := public.omr_service_readiness_v1();
        if readiness->>'queryPathIndexesReady' <> 'false'
            or readiness->>'ready' <> 'false'
        then
            raise exception 'v4 readiness accepted a missing query-path index';
        end if;
        raise exception using errcode = 'P1018', message = 'rollback v4 query index drift';
    exception when sqlstate 'P1018' then null;
    end;
end
$$;

do $$
declare
    readiness jsonb;
begin
    begin
        execute $statement$
            create function public.omr_teacher_update_attempt_v1(text)
            returns boolean
            language sql
            as 'select true'
        $statement$;
        readiness := public.omr_service_readiness_v1();
        if readiness->>'legacyBroadRpcsRemoved' <> 'false'
            or readiness->>'ready' <> 'false'
        then
            raise exception 'v4 readiness accepted a forbidden broad RPC overload';
        end if;
        raise exception using errcode = 'P1019', message = 'rollback v4 legacy RPC drift';
    exception when sqlstate 'P1019' then null;
    end;
end
$$;

-- The removed alpha policy name must remain absent independently of public RLS
-- policy checks and the exact target Storage policies.
begin;
set local role supabase_storage_admin;
create policy "OMR private assets alpha access"
    on storage.objects
    for all
    to anon, authenticated
    using (true)
    with check (true);
reset role;
do $$
declare
    readiness jsonb;
begin
    readiness := public.omr_service_readiness_v1();
    if readiness->>'alphaPoliciesAbsent' <> 'false'
        or readiness->>'canonicalPoliciesAbsent' <> 'true'
        or readiness->>'hostedStorageBoundaryReady' <> 'true'
        or readiness->>'ready' <> 'false'
    then
        raise exception 'v4 readiness accepted a reintroduced Storage alpha policy';
    end if;
end
$$;
rollback;

-- The Storage policy must be changed as Supabase's managed owner.
begin;
set local role supabase_storage_admin;
drop policy "OMR private assets server-only objects" on storage.objects;
reset role;
do $$
declare
    readiness jsonb;
begin
    readiness := public.omr_service_readiness_v1();
    if readiness->>'hostedStorageBoundaryReady' <> 'false'
        or readiness->>'ready' <> 'false'
    then
        raise exception 'v4 readiness accepted a missing target Storage policy';
    end if;
end
$$;
rollback;
-- END v4 transient readiness drift probes

-- List DTO JSON-path projections must keep legacy inline PDF/drawing bodies on
-- the database side while retaining the analytical fields consumed by lists.
do $$
declare
    actual_columns text[];
    actual_predicate text;
begin
    select array_agg(pg_get_indexdef(indexrelid, position, true) order by position)
      into actual_columns
      from pg_index
      cross join lateral generate_series(1, indnkeyatts) as position
     where indexrelid = to_regclass('public.omr_attempts_org_id_idx');
    if actual_columns is distinct from array['organization_id', 'id']::text[] then
        raise exception 'initial list keyset index shape mismatch: omr_attempts_org_id_idx %', actual_columns;
    end if;

    select array_agg(pg_get_indexdef(indexrelid, position, true) order by position)
      into actual_columns
      from pg_index
      cross join lateral generate_series(1, indnkeyatts) as position
     where indexrelid = to_regclass('public.omr_attempts_org_exam_id_idx');
    if actual_columns is distinct from array['organization_id', 'exam_id', 'id']::text[] then
        raise exception 'initial list keyset index shape mismatch: omr_attempts_org_exam_id_idx %', actual_columns;
    end if;

    select array_agg(pg_get_indexdef(indexrelid, position, true) order by position)
      into actual_columns
      from pg_index
      cross join lateral generate_series(1, indnkeyatts) as position
     where indexrelid = to_regclass('public.omr_attempts_owner_id_idx');
    if actual_columns is distinct from array['organization_id', 'student_id', 'id']::text[] then
        raise exception 'initial list keyset index shape mismatch: omr_attempts_owner_id_idx %', actual_columns;
    end if;

    select array_agg(pg_get_indexdef(indexrelid, position, true) order by position),
           max(pg_get_expr(indpred, indrelid))
      into actual_columns, actual_predicate
      from pg_index
      cross join lateral generate_series(1, indnkeyatts) as position
     where indexrelid = to_regclass('public.omr_attempts_student_completed_id_idx');
    if actual_columns is distinct from array['organization_id', 'student_profile_id', 'student_id', 'id']::text[]
       or coalesce(actual_predicate, '') !~ 'status.*completed'
    then
        raise exception 'initial list keyset index shape mismatch: omr_attempts_student_completed_id_idx %, %', actual_columns, actual_predicate;
    end if;
end
$$;

begin;
update public.omr_exams
   set payload = payload || jsonb_build_object(
       'questions', jsonb_build_array(jsonb_build_object(
           'id', 1,
           'number', 1,
           'label', '분수',
           'score', 3,
           'answer', 2,
           'choices', 5,
           'tags', jsonb_build_object(
               'subject', '수학',
               'concept', '유리수',
               'mistakeTypes', jsonb_build_array('부호', 99, jsonb_build_object('secret', 'TAG_NESTED_SECRET'))
           ),
           'explanation', 'EXPLANATION_SECRET_1f2a',
           'subQuestions', jsonb_build_array(jsonb_build_object(
               'prompt', 'PROMPT_SECRET_2b3c',
               'answerGuide', 'GUIDE_SECRET_3c4d',
               'teacherNote', 'NOTE_SECRET_4d5e'
           )),
           'pdfRegion', jsonb_build_object('secret', 'REGION_SECRET_5e6f'),
           'pdfLocation', jsonb_build_object('secret', 'LOCATION_SECRET_6f7a'),
           'imageAssetRef', jsonb_build_object('key', 'ASSET_SECRET_7a8b')
       )),
       'pdfData', repeat('x', 100000),
       'answerKeyPdf', repeat('y', 100000),
       'pdfDataRef', jsonb_build_object('store', 'remote', 'key', 'problem-1')
   )
 where id = 'live-exam-a';

update public.omr_attempts
   set payload = payload || jsonb_build_object(
       'answers', jsonb_build_object('1', 2),
       'guestId', 'live-guest-1',
       'questionResults', jsonb_build_array(jsonb_build_object('questionId', 1)),
       'drawings', jsonb_build_object('1', jsonb_build_array(repeat('M 0 0 ', 10000))),
       'subQuestionAnswers', jsonb_build_object('1', jsonb_build_object('reason', repeat('z', 100000)))
   )
 where id = 'attempt_live-ticket-1';

do $$
declare
    exam_list_dto jsonb;
    attempt_list_dto jsonb;
begin
    select jsonb_build_object(
        'id', id,
        'questions', question_summaries,
        'pdf_data_ref', payload->'pdfDataRef'
    )
      into exam_list_dto
      from public.omr_exams
     where id = 'live-exam-a';

    if exam_list_dto ? 'pdfData'
        or exam_list_dto ? 'answerKeyPdf'
        or octet_length(exam_list_dto::text) >= 10000
    then
        raise exception 'exam list projection retained legacy inline PDF bytes';
    end if;
    if exam_list_dto::text like '%EXPLANATION_SECRET_1f2a%'
       or exam_list_dto::text like '%PROMPT_SECRET_2b3c%'
       or exam_list_dto::text like '%GUIDE_SECRET_3c4d%'
       or exam_list_dto::text like '%NOTE_SECRET_4d5e%'
       or exam_list_dto::text like '%REGION_SECRET_5e6f%'
       or exam_list_dto::text like '%LOCATION_SECRET_6f7a%'
       or exam_list_dto::text like '%ASSET_SECRET_7a8b%'
       or exam_list_dto::text like '%TAG_NESTED_SECRET%'
    then
        raise exception 'exam question list summary leaked secret detail';
    end if;
    if exam_list_dto #>> '{questions,0,id}' <> '1'
       or exam_list_dto #>> '{questions,0,number}' <> '1'
       or exam_list_dto #>> '{questions,0,label}' <> '분수'
       or exam_list_dto #>> '{questions,0,score}' <> '3'
       or exam_list_dto #>> '{questions,0,answer}' <> '2'
       or exam_list_dto #>> '{questions,0,choices}' <> '5'
       or exam_list_dto #>> '{questions,0,tags,subject}' <> '수학'
       or exam_list_dto #>> '{questions,0,tags,concept}' <> '유리수'
       or exam_list_dto #>> '{questions,0,tags,mistakeTypes,0}' <> '부호'
       or jsonb_array_length(exam_list_dto #> '{questions,0,tags,mistakeTypes}') <> 1
    then
        raise exception 'exam question list summary lost required analytics scalars';
    end if;

    select jsonb_build_object(
        'id', id,
        'guest_id', payload->>'guestId',
        'answers', payload->'answers',
        'question_results', payload->'questionResults'
    )
      into attempt_list_dto
      from public.omr_attempts
     where id = 'attempt_live-ticket-1';

    if attempt_list_dto ? 'drawings'
        or attempt_list_dto ? 'subQuestionAnswers'
        or octet_length(attempt_list_dto::text) >= 10000
    then
        raise exception 'attempt list projection retained detail-only payload bytes';
    end if;
    if attempt_list_dto->>'guest_id' <> 'live-guest-1' then
        raise exception 'attempt list projection lost guest ownership metadata';
    end if;
end
$$;
rollback;

begin;
update public.omr_attempts
   set payload = jsonb_set(
       payload,
       '{studentQuestions}',
       '[{
           "questionId":1,
           "questionNumber":1,
           "body":"STUDENT_LIST_SECRET_6f8125",
           "createdAt":"2026-08-06T01:02:03.000Z",
           "status":"answered",
           "answer":{
               "body":"TEACHER_LIST_SECRET_9d47b1",
               "createdAt":"2026-08-06T02:03:04.000Z",
               "teacherName":"담당 교사"
           }
       }]'::jsonb,
       true
   )
 where id = 'attempt_live-ticket-1';

do $$
declare
    summary jsonb;
begin
    select student_question_summaries
      into summary
      from public.omr_attempts
     where id = 'attempt_live-ticket-1';

    if summary::text like '%STUDENT_LIST_SECRET_6f8125%'
       or summary::text like '%TEACHER_LIST_SECRET_9d47b1%'
       or summary #>> '{0,body}' <> ''
       or summary #>> '{0,answer,body}' <> '' then
        raise exception 'student question list summary leaked free text';
    end if;
    if summary #>> '{0,questionId}' <> '1'
       or summary #>> '{0,questionNumber}' <> '1'
       or summary #>> '{0,status}' <> 'answered'
       or summary #>> '{0,createdAt}' <> '2026-08-06T01:02:03.000Z'
       or summary #>> '{0,answer,createdAt}' <> '2026-08-06T02:03:04.000Z'
       or summary #> '{0,answer}' ? 'teacherName' then
        raise exception 'student question list summary lost status or timestamps';
    end if;
    if public.omr_student_question_summaries_v1('{}'::jsonb) <> '[]'::jsonb
       or public.omr_student_question_summaries_v1('{"studentQuestions":{}}'::jsonb) <> '[]'::jsonb then
        raise exception 'student question summary did not safely handle malformed payloads';
    end if;
    if has_function_privilege('anon', 'public.omr_student_question_summaries_v1(jsonb)', 'execute')
       or has_function_privilege('authenticated', 'public.omr_student_question_summaries_v1(jsonb)', 'execute')
       or not has_function_privilege('service_role', 'public.omr_student_question_summaries_v1(jsonb)', 'execute') then
        raise exception 'student question summary helper grants are not server-only';
    end if;
    if has_function_privilege('anon', 'public.omr_exam_question_summaries_v1(jsonb)', 'execute')
       or has_function_privilege('authenticated', 'public.omr_exam_question_summaries_v1(jsonb)', 'execute')
       or not has_function_privilege('service_role', 'public.omr_exam_question_summaries_v1(jsonb)', 'execute') then
        raise exception 'exam question summary helper grants are not server-only';
    end if;
    if public.omr_exam_question_summaries_v1('{}'::jsonb) <> '[]'::jsonb
       or public.omr_exam_question_summaries_v1('{"questions":{}}'::jsonb) <> '[]'::jsonb then
        raise exception 'exam question summary did not safely handle malformed payloads';
    end if;
    if to_regprocedure('public.omr_create_exam_clone_target_v1(text,text,text,text,text)') is not null
       or to_regprocedure('public.omr_cleanup_exam_clone_target_v1(text,text,text)') is not null then
        raise exception 'removed clone lifecycle RPC still exists';
    end if;
end
$$;
rollback;

begin;
insert into public.omr_organizations (id, name) values
    ('live-invite-org-a', 'Invite Org A'),
    ('live-invite-org-b', 'Invite Org B');
insert into public.omr_organization_members (organization_id, user_id, role, status) values
    ('live-invite-org-a', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'teacher', 'active'),
    ('live-invite-org-b', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'teacher', 'active');
insert into public.omr_classes (id, organization_id, name, status) values
    ('live-invite-class-a', 'live-invite-org-a', 'A반', 'active'),
    ('live-invite-class-b', 'live-invite-org-b', 'B반', 'active');
insert into public.omr_exams (id, organization_id, title, payload, created_at, updated_at) values
    ('live-invite-exam-a', 'live-invite-org-a', 'Invite Exam A',
     '{"id":"live-invite-exam-a","title":"Invite Exam A","questions":[{"id":1,"number":1,"answer":1,"score":1}],"accessConfig":{"type":"group","groupIds":["live-invite-class-a"]}}'::jsonb,
     now(), now()),
    ('live-invite-exam-b', 'live-invite-org-b', 'Invite Exam B',
     '{"id":"live-invite-exam-b","title":"Invite Exam B","questions":[{"id":1,"number":1,"answer":1,"score":1}],"accessConfig":{"type":"group","groupIds":["live-invite-class-b"]}}'::jsonb,
     now(), now());

do $$
declare
    issued jsonb;
    resolved jsonb;
begin
    issued := public.omr_rotate_exam_entry_invite_v1(
        'live-invite-org-a', 'live-invite-exam-a',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', repeat('a', 64), now() + interval '1 day'
    );
    if issued->>'status' <> 'issued' then
        raise exception 'opaque exam invite issuance failed';
    end if;
    resolved := public.omr_resolve_exam_entry_invite_v1(repeat('a', 64), 'live-invite-exam-a');
    if resolved->>'status' <> 'resolved'
       or resolved->>'organizationId' <> 'live-invite-org-a'
       or resolved->'groupIds' <> '["live-invite-class-a"]'::jsonb then
        raise exception 'opaque exam invite exact resolution failed';
    end if;
    if public.omr_resolve_exam_entry_invite_v1(repeat('a', 64), 'live-invite-exam-b')->>'status' <> 'invalid'
       or public.omr_resolve_exam_entry_invite_v1(repeat('b', 64), 'live-invite-exam-a')->>'status' <> 'invalid'
       or public.omr_resolve_exam_entry_invite_v1(null, 'live-invite-exam-a')->>'status' <> 'invalid'
       or public.omr_rotate_exam_entry_invite_v1(
           'live-invite-org-a', 'live-invite-exam-a',
           'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', null, now() + interval '1 day'
       )->>'status' <> 'invalid' then
        raise exception 'opaque exam invite accepted a tampered or cross-org scope';
    end if;
    perform public.omr_rotate_exam_entry_invite_v1(
        'live-invite-org-a', 'live-invite-exam-a',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', repeat('c', 64), now() + interval '1 day'
    );
    if public.omr_resolve_exam_entry_invite_v1(repeat('a', 64), 'live-invite-exam-a')->>'status' <> 'invalid'
       or public.omr_resolve_exam_entry_invite_v1(repeat('c', 64), 'live-invite-exam-a')->>'status' <> 'resolved' then
        raise exception 'opaque exam invite rotation did not revoke the prior bearer';
    end if;
    update public.omr_exam_entry_invites
       set created_at = now() - interval '2 seconds',
           expires_at = now() - interval '1 second'
     where token_hash = repeat('c', 64);
    if public.omr_resolve_exam_entry_invite_v1(repeat('c', 64), 'live-invite-exam-a')->>'status' <> 'invalid' then
        raise exception 'opaque exam invite accepted an expired bearer';
    end if;
    if exists (
        select 1 from information_schema.columns
         where table_schema = 'public' and table_name = 'omr_exam_entry_invites'
           and column_name in ('token', 'raw_token', 'invite_token')
    ) then
        raise exception 'opaque exam invite persisted a raw bearer column';
    end if;
    if has_table_privilege('service_role', 'public.omr_exam_entry_invites', 'select,insert,update,delete')
       or has_function_privilege('anon', 'public.omr_resolve_exam_entry_invite_v1(text,text)', 'execute')
       or has_function_privilege('authenticated', 'public.omr_rotate_exam_entry_invite_v1(text,text,text,text,timestamptz)', 'execute')
       or not has_function_privilege('service_role', 'public.omr_resolve_exam_entry_invite_v1(text,text)', 'execute') then
        raise exception 'opaque exam invite server-only grants are unsafe';
    end if;
    if public.omr_service_readiness_v1()->>'examEntryInvitesReady' <> 'true' then
        raise exception 'production readiness did not require opaque exam invites';
    end if;
end
$$;
rollback;

do $$
declare
    readiness jsonb := public.omr_service_readiness_v1();
begin
    if readiness ->> 'individualStudentAssignmentsReady' <> 'true'
       or readiness ->> 'teacherAttemptReportingReady' <> 'true' then
        raise exception 'latest assignment/reporting readiness failed: %', readiness;
    end if;
    if not pg_catalog.has_function_privilege(
        'service_role', 'public.omr_assign_students_v1(text,text,text,text,text[],text,bigint,text)', 'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role', 'public.omr_clear_student_assignment_v1(text,text,text,text,bigint,text,text[],text)', 'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role', 'public.omr_load_teacher_student_assignment_v1(text,text,text,text)', 'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role', 'public.omr_list_student_assignments_v1(text,text,text,text,text)', 'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role', 'public.omr_resolve_student_assignment_v1(text,text,text,text,text,text,text)', 'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role', 'public.omr_teacher_attempt_aggregate_v1(text,text,timestamptz,timestamptz)', 'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role', 'public.omr_teacher_attempt_export_v1(text,text,integer)', 'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role', 'public.omr_teacher_attempt_export_page_v1(text,text,timestamptz,timestamptz,text,integer)', 'EXECUTE'
    ) then
        raise exception 'latest assignment/reporting service gateway grant missing';
    end if;
end
$$;

do $$
declare
    v_columns text[];
    v_first_success timestamptz;
    v_recorded jsonb;
    v_snapshot jsonb;
    v_rejected integer := 0;
begin
    select pg_catalog.array_agg(column_name::text order by ordinal_position)
      into v_columns
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'omr_operational_job_status';
    if v_columns is distinct from array[
        'job_key', 'status', 'last_attempt_at', 'last_success_at',
        'dead_count', 'build_sha', 'failure_category'
    ]::text[] then
        raise exception 'operational job status persisted an unbounded or raw field';
    end if;
    if not exists (
        select 1
          from pg_catalog.pg_class relation
         where relation.oid = 'public.omr_operational_job_status'::pg_catalog.regclass
           and relation.relrowsecurity
           and relation.relforcerowsecurity
    ) then
        raise exception 'operational job status did not FORCE RLS';
    end if;

    if exists (
        select 1
          from pg_catalog.pg_class relation
          cross join lateral pg_catalog.aclexplode(
              coalesce(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
          ) privilege
         where relation.oid = 'public.omr_operational_job_status'::pg_catalog.regclass
           and privilege.grantee = 0
           and privilege.privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
    ) then
        raise exception 'operational job status exposed to public';
    end if;
    if pg_catalog.to_regclass('public.omr_remote_asset_cleanup_dead_idx') is null
       or position(
           'status = ''dead''' in lower(pg_catalog.pg_get_indexdef(
               'public.omr_remote_asset_cleanup_dead_idx'::pg_catalog.regclass
           ))
       ) = 0 then
        raise exception 'operational job dead backlog partial index missing';
    end if;
    if (
        select count(*)
          from pg_catalog.pg_proc routine
          join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
         where namespace.nspname = 'public'
           and routine.proname in (
               'omr_record_operational_job_status_v1',
               'omr_read_operational_job_status_v1'
           )
    ) <> 2 or exists (
        select 1
          from pg_catalog.pg_proc routine
         where routine.oid in (
             'public.omr_record_operational_job_status_v1(text,text,text,text)'::pg_catalog.regprocedure,
             'public.omr_read_operational_job_status_v1(text)'::pg_catalog.regprocedure
         )
           and (
               pg_catalog.pg_get_function_result(routine.oid) <> 'jsonb'
               or not routine.prosecdef
               or pg_catalog.pg_get_userbyid(routine.proowner) <> 'postgres'
               or not coalesce(routine.proconfig, '{}'::text[]) @> array[
                   'search_path=""', 'statement_timeout=5s'
               ]::text[]
               or (
                   routine.proname = 'omr_record_operational_job_status_v1'
                   and not coalesce(routine.proconfig, '{}'::text[])
                       @> array['lock_timeout=2s']::text[]
               )
           )
    ) then
        raise exception 'operational job RPC catalog hardening failed';
    end if;
    if pg_catalog.has_table_privilege(
        'anon', 'public.omr_operational_job_status', 'SELECT,INSERT,UPDATE,DELETE'
    ) then
        raise exception 'operational job status exposed to anon';
    end if;
    if pg_catalog.has_table_privilege(
        'authenticated', 'public.omr_operational_job_status', 'SELECT,INSERT,UPDATE,DELETE'
    ) then
        raise exception 'operational job status exposed to authenticated';
    end if;
    if pg_catalog.has_table_privilege(
        'service_role', 'public.omr_operational_job_status',
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
    ) or not pg_catalog.has_function_privilege(
        'service_role',
        'public.omr_record_operational_job_status_v1(text,text,text,text)',
        'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role', 'public.omr_read_operational_job_status_v1(text)', 'EXECUTE'
    ) then
        raise exception 'operational job status service role boundary failed';
    end if;
    if pg_catalog.has_function_privilege(
        'anon',
        'public.omr_record_operational_job_status_v1(text,text,text,text)',
        'EXECUTE'
    ) or pg_catalog.has_function_privilege(
        'authenticated', 'public.omr_read_operational_job_status_v1(text)', 'EXECUTE'
    ) or exists (
        select 1
          from pg_catalog.pg_proc routine
          cross join lateral pg_catalog.aclexplode(
              coalesce(routine.proacl, pg_catalog.acldefault('f', routine.proowner))
          ) privilege
         where routine.oid in (
             'public.omr_record_operational_job_status_v1(text,text,text,text)'::pg_catalog.regprocedure,
             'public.omr_read_operational_job_status_v1(text)'::pg_catalog.regprocedure
         )
           and privilege.grantee = 0
           and privilege.privilege_type = 'EXECUTE'
    ) then
        raise exception 'operational job status exposed to public';
    end if;

    delete from public.omr_operational_job_status where job_key = 'asset_gc';
    if public.omr_read_operational_job_status_v1('asset_gc') is not null then
        raise exception 'operational job status missing-row read was not null';
    end if;
    v_recorded := public.omr_record_operational_job_status_v1(
        'asset_gc', 'healthy',
        '0123456789abcdef0123456789abcdef01234567', null
    );
    if v_recorded->>'status' <> 'healthy'
       or v_recorded->>'deadCount' <> '0' then
        raise exception 'operational job success did not return authoritative status';
    end if;
    v_first_success := (v_recorded->>'lastSuccessAt')::timestamptz;
    v_recorded := public.omr_record_operational_job_status_v1(
        'asset_gc', 'failed',
        '0123456789abcdef0123456789abcdef01234567', 'cleanup_failed'
    );
    if v_recorded->>'status' <> 'failed'
       or v_recorded->>'failureCategory' <> 'cleanup_failed' then
        raise exception 'operational job failure did not return authoritative status';
    end if;
    v_snapshot := public.omr_read_operational_job_status_v1('asset_gc');
    if v_snapshot->>'status' <> 'failed'
       or (v_snapshot->>'lastSuccessAt')::timestamptz
            is distinct from v_first_success
       or (v_snapshot->>'lastAttemptAt')::timestamptz <= v_first_success
       or v_snapshot->>'deadCount' <> '0' then
        raise exception 'operational job failure advanced last success';
    end if;
    v_recorded := public.omr_record_operational_job_status_v1(
        'asset_gc', 'healthy',
        'ffffffffffffffffffffffffffffffffffffffff', null
    );
    if v_recorded->>'status' <> 'healthy'
       or v_recorded->>'buildSha' <> repeat('f', 40)
       or (v_recorded->>'lastAttemptAt')::timestamptz
            <= (v_snapshot->>'lastAttemptAt')::timestamptz then
        raise exception 'operational job DB ordering did not advance a later invocation';
    end if;
    v_first_success := (v_recorded->>'lastSuccessAt')::timestamptz;
    if (select count(*) from public.omr_operational_job_status where job_key = 'asset_gc') <> 1 then
        raise exception 'operational job upsert created more than one row';
    end if;

    insert into public.omr_remote_asset_cleanup_queue (
        organization_id, source_type, source_id, storage_bucket, object_path,
        reason, status, attempts
    ) values (
        'live-org-a', 'remote_asset', 'operational-dead-fixture',
        'omr-private-assets',
        'organizations/live-org-a/operational-dead-fixture.pdf',
        'asset_replaced', 'dead', 10
    );
    v_recorded := public.omr_record_operational_job_status_v1(
        'asset_gc', 'healthy',
        '0123456789abcdef0123456789abcdef01234567', null
    );
    if v_recorded->>'status' <> 'failed'
       or v_recorded->>'deadCount' <> '1'
       or v_recorded->>'failureCategory' <> 'dead_backlog' then
        raise exception 'operational job clean run did not return durable dead backlog';
    end if;
    v_snapshot := public.omr_read_operational_job_status_v1('asset_gc');
    if v_snapshot->>'status' <> 'failed'
       or v_snapshot->>'deadCount' <> '1'
       or v_snapshot->>'failureCategory' <> 'dead_backlog'
       or (v_snapshot->>'lastSuccessAt')::timestamptz
            is distinct from v_first_success then
        raise exception 'operational job clean run ignored durable dead backlog';
    end if;
    delete from public.omr_remote_asset_cleanup_queue
     where source_id = 'operational-dead-fixture';
    v_recorded := public.omr_record_operational_job_status_v1(
        'asset_gc', 'healthy',
        '0123456789abcdef0123456789abcdef01234567', null
    );
    if v_recorded->>'status' <> 'healthy'
       or v_recorded->>'deadCount' <> '0'
       or v_recorded->>'failureCategory' is not null then
        raise exception 'operational job recovery did not return authoritative status';
    end if;
    v_snapshot := public.omr_read_operational_job_status_v1('asset_gc');
    if v_snapshot->>'status' <> 'healthy'
       or v_snapshot->>'deadCount' <> '0'
       or v_snapshot->>'failureCategory' is not null then
        raise exception 'operational job remained failed after dead backlog remediation';
    end if;

    begin
        perform public.omr_record_operational_job_status_v1(
            'asset_gc', 'healthy',
            'short', null
        );
    exception when others then
        v_rejected := v_rejected + 1;
    end;
    begin
        perform public.omr_record_operational_job_status_v1(
            'asset_gc', 'failed',
            '0123456789abcdef0123456789abcdef01234567', 'Student@example.com'
        );
    exception when others then
        v_rejected := v_rejected + 1;
    end;
    if v_rejected <> 2 then
        raise exception 'operational job status accepted malformed input';
    end if;
    delete from public.omr_operational_job_status where job_key = 'asset_gc';
end
$$;

delete from public.omr_operational_job_status where job_key = 'asset_gc';
do $$
declare
    v_failed jsonb;
    v_healthy jsonb;
    v_final jsonb;
begin
    perform extensions.dblink_connect(
        'operational-job-failed',
        'host=127.0.0.1 port=' || current_setting('port')
            || ' dbname=' || current_database()
            || ' user=postgres password=omr-live-test-password'
    );
    perform extensions.dblink_connect(
        'operational-job-healthy',
        'host=127.0.0.1 port=' || current_setting('port')
            || ' dbname=' || current_database()
            || ' user=postgres password=omr-live-test-password'
    );
    perform extensions.dblink_send_query(
        'operational-job-failed',
        $sql$select public.omr_record_operational_job_status_v1(
            'asset_gc', 'failed',
            '0123456789abcdef0123456789abcdef01234567', 'cleanup_failed'
        )::text$sql$
    );
    perform extensions.dblink_send_query(
        'operational-job-healthy',
        $sql$select public.omr_record_operational_job_status_v1(
            'asset_gc', 'healthy',
            'ffffffffffffffffffffffffffffffffffffffff', null
        )::text$sql$
    );
    select result.recorded::jsonb into v_failed
      from extensions.dblink_get_result('operational-job-failed')
        as result(recorded text);
    select result.recorded::jsonb into v_healthy
      from extensions.dblink_get_result('operational-job-healthy')
        as result(recorded text);
    v_final := public.omr_read_operational_job_status_v1('asset_gc');
    if (v_failed->>'lastAttemptAt')::timestamptz
            = (v_healthy->>'lastAttemptAt')::timestamptz
       or (v_final->>'lastAttemptAt')::timestamptz is distinct from greatest(
            (v_failed->>'lastAttemptAt')::timestamptz,
            (v_healthy->>'lastAttemptAt')::timestamptz
       )
       or (v_final->>'buildSha') is distinct from (case
            when (v_failed->>'lastAttemptAt')::timestamptz
                   > (v_healthy->>'lastAttemptAt')::timestamptz
                then v_failed->>'buildSha'
            else v_healthy->>'buildSha'
       end) then
        raise exception 'operational job concurrent DB ordering was not monotonic';
    end if;
    perform extensions.dblink_disconnect('operational-job-failed');
    perform extensions.dblink_disconnect('operational-job-healthy');
end
$$;
delete from public.omr_operational_job_status where job_key = 'asset_gc';

drop function public.omr_default_acl_probe_v1();

do $$
declare
    v_export jsonb;
begin
    v_export := public.omr_teacher_attempt_export_v1('live-org-a', null, 5000);
    if v_export ->> 'status' <> 'loaded'
       or pg_catalog.jsonb_typeof(v_export -> 'aggregate') <> 'object'
       or pg_catalog.jsonb_typeof(v_export -> 'rows') <> 'array'
       or (v_export #>> '{aggregate,completed_attempt_count}')::bigint
            <> pg_catalog.jsonb_array_length(v_export -> 'rows')::bigint
       or v_export::text ~* 'student_name|student_profile_id|answers|question_results' then
        raise exception 'atomic PII-free attempt export contract failed: %', v_export;
    end if;
end
$$;

select 'OMR live PostgreSQL verification passed' as result;
