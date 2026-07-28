begin;

-- Runtime release gate for the server-only data plane. This probe reports only
-- fixed boolean capabilities: it never returns preflight samples, row ids, or
-- other tenant data.
create or replace function public.omr_service_readiness_v1()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_expected_canonical_table_count constant integer := 27;
    v_browser_schema_privileges_denied boolean := false;
    v_anon_table_privileges_denied boolean := false;
    v_authenticated_table_privileges_denied boolean := false;
    v_browser_sequence_privileges_denied boolean := false;
    v_browser_function_privileges_denied boolean := false;
    v_alpha_policies_absent boolean := false;
    v_canonical_tables_force_rls boolean := false;
    v_canonical_policies_absent boolean := false;
    v_organization_backfill_ready boolean := false;
    v_service_role_privileges_ready boolean := false;
    v_scoped_rpc_privileges_ready boolean := false;
    v_hosted_storage_boundary_ready boolean := false;
    v_server_gateway_capabilities_ready boolean := false;
    v_query_path_indexes_ready boolean := false;
    v_legacy_broad_rpcs_removed boolean := false;
    v_preflight jsonb;
    v_ready boolean;
begin
    v_browser_schema_privileges_denied :=
        not pg_catalog.has_schema_privilege('anon', 'public', 'USAGE')
        and not pg_catalog.has_schema_privilege('anon', 'public', 'CREATE')
        and not pg_catalog.has_schema_privilege(
            'authenticated',
            'public',
            'USAGE'
        )
        and not pg_catalog.has_schema_privilege(
            'authenticated',
            'public',
            'CREATE'
        );

    -- information_schema proves direct grants are absent. The has_* checks
    -- additionally cover PUBLIC and inherited effective privileges.
    v_anon_table_privileges_denied :=
        not exists (
            select 1
              from information_schema.role_table_grants grant_row
             where grant_row.grantee = 'anon'
               and grant_row.table_schema = 'public'
               and grant_row.table_name like 'omr\_%' escape '\'
        )
        and not exists (
            select 1
              from pg_catalog.pg_class relation
              join pg_catalog.pg_namespace namespace
                on namespace.oid = relation.relnamespace
             where namespace.nspname = 'public'
               and relation.relkind in ('r', 'p')
               and relation.relname like 'omr\_%' escape '\'
               and pg_catalog.has_table_privilege(
                   'anon',
                   relation.oid,
                   'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
               )
        );

    v_authenticated_table_privileges_denied :=
        not exists (
            select 1
              from information_schema.role_table_grants grant_row
             where grant_row.grantee = 'authenticated'
               and grant_row.table_schema = 'public'
               and grant_row.table_name like 'omr\_%' escape '\'
        )
        and not exists (
            select 1
              from pg_catalog.pg_class relation
              join pg_catalog.pg_namespace namespace
                on namespace.oid = relation.relnamespace
             where namespace.nspname = 'public'
               and relation.relkind in ('r', 'p')
               and relation.relname like 'omr\_%' escape '\'
               and pg_catalog.has_table_privilege(
                   'authenticated',
                   relation.oid,
                   'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
               )
        );

    v_browser_sequence_privileges_denied :=
        not exists (
            select 1
              from information_schema.role_usage_grants grant_row
             where grant_row.grantee in ('anon', 'authenticated')
               and grant_row.object_schema = 'public'
               and grant_row.object_type = 'SEQUENCE'
        )
        and not exists (
            select 1
              from pg_catalog.pg_class relation
              join pg_catalog.pg_namespace namespace
                on namespace.oid = relation.relnamespace
             where namespace.nspname = 'public'
               and relation.relkind = 'S'
               and (
                   pg_catalog.has_sequence_privilege(
                       'anon',
                       relation.oid,
                       'USAGE,SELECT,UPDATE'
                   )
                   or pg_catalog.has_sequence_privilege(
                       'authenticated',
                       relation.oid,
                       'USAGE,SELECT,UPDATE'
                   )
               )
        );

    v_browser_function_privileges_denied :=
        not exists (
            select 1
              from information_schema.routine_privileges grant_row
             where grant_row.grantee in ('anon', 'authenticated')
               and grant_row.specific_schema = 'public'
               and grant_row.privilege_type = 'EXECUTE'
        )
        and not exists (
            select 1
              from pg_catalog.pg_proc routine
              join pg_catalog.pg_namespace namespace
                on namespace.oid = routine.pronamespace
             where namespace.nspname = 'public'
               and (
                   pg_catalog.has_function_privilege(
                       'anon',
                       routine.oid,
                       'EXECUTE'
                   )
                   or pg_catalog.has_function_privilege(
                       'authenticated',
                       routine.oid,
                       'EXECUTE'
                   )
               )
        );

    v_canonical_tables_force_rls :=
        (
            select count(*)
              from pg_catalog.pg_class relation
              join pg_catalog.pg_namespace namespace
                on namespace.oid = relation.relnamespace
             where namespace.nspname = 'public'
               and relation.relkind in ('r', 'p')
               and relation.relname like 'omr\_%' escape '\'
        ) = v_expected_canonical_table_count
        and not exists (
            select 1
              from pg_catalog.pg_class relation
              join pg_catalog.pg_namespace namespace
                on namespace.oid = relation.relnamespace
             where namespace.nspname = 'public'
               and relation.relkind in ('r', 'p')
               and relation.relname like 'omr\_%' escape '\'
               and (
                   not relation.relrowsecurity
                   or not relation.relforcerowsecurity
               )
        );

    v_canonical_policies_absent := not exists (
        select 1
          from pg_catalog.pg_policies policy
         where policy.schemaname = 'public'
           and policy.tablename like 'omr\_%' escape '\'
    );
    v_alpha_policies_absent :=
        v_canonical_policies_absent
        and not exists (
            select 1
              from pg_catalog.pg_policies policy
             where policy.schemaname = 'storage'
               and policy.policyname = 'OMR private assets alpha access'
        );

    begin
        v_preflight := public.omr_production_boundary_preflight_v1();
        v_organization_backfill_ready :=
            pg_catalog.jsonb_typeof(v_preflight) = 'object'
            and v_preflight @> jsonb_build_object(
                'null_organization_rows', 0,
                'orphan_rows', 0,
                'cross_organization_rows', 0,
                'students_without_credentials', 0
            );
    exception
        when others then
            v_organization_backfill_ready := false;
    end;

    v_service_role_privileges_ready :=
        exists (
            select 1
              from pg_catalog.pg_roles role_row
             where role_row.rolname = 'service_role'
               and role_row.rolbypassrls
        )
        and pg_catalog.has_schema_privilege(
            'service_role',
            'public',
            'USAGE'
        )
        and not exists (
            select 1
              from pg_catalog.pg_class relation
              join pg_catalog.pg_namespace namespace
                on namespace.oid = relation.relnamespace
             where namespace.nspname = 'public'
               and relation.relkind in ('r', 'p')
               and relation.relname like 'omr\_%' escape '\'
               and (
                   not pg_catalog.has_table_privilege(
                       'service_role',
                       relation.oid,
                       'SELECT'
                   )
                   or not pg_catalog.has_table_privilege(
                       'service_role',
                       relation.oid,
                       'INSERT'
                   )
                   or not pg_catalog.has_table_privilege(
                       'service_role',
                       relation.oid,
                       'UPDATE'
                   )
                   or not pg_catalog.has_table_privilege(
                       'service_role',
                       relation.oid,
                       'DELETE'
                   )
               )
        )
        and not exists (
            select 1
              from pg_catalog.pg_class relation
              join pg_catalog.pg_namespace namespace
                on namespace.oid = relation.relnamespace
             where namespace.nspname = 'public'
               and relation.relkind = 'S'
               and (
                   not pg_catalog.has_sequence_privilege(
                       'service_role',
                       relation.oid,
                       'USAGE'
                   )
                   or not pg_catalog.has_sequence_privilege(
                       'service_role',
                       relation.oid,
                       'SELECT'
                   )
                   or not pg_catalog.has_sequence_privilege(
                       'service_role',
                       relation.oid,
                       'UPDATE'
                   )
               )
        )
        and not exists (
            select 1
              from pg_catalog.pg_proc routine
              join pg_catalog.pg_namespace namespace
                on namespace.oid = routine.pronamespace
             where namespace.nspname = 'public'
               and not pg_catalog.has_function_privilege(
                   'service_role',
                   routine.oid,
                   'EXECUTE'
               )
        );

    v_scoped_rpc_privileges_ready :=
        pg_catalog.to_regprocedure(
            'public.omr_answer_attempt_question_v1(text,text,text,text,text,text,text)'
        ) is not null
        and pg_catalog.to_regprocedure(
            'public.omr_set_subquestion_review_v1(text,text,text,text,text,text,text)'
        ) is not null
        and pg_catalog.to_regprocedure(
            'public.omr_force_finish_attempts_v1(text,text[],timestamptz,text,text,text,jsonb)'
        ) is not null
        and pg_catalog.has_function_privilege(
            'service_role',
            'public.omr_answer_attempt_question_v1(text,text,text,text,text,text,text)',
            'EXECUTE'
        )
        and pg_catalog.has_function_privilege(
            'service_role',
            'public.omr_set_subquestion_review_v1(text,text,text,text,text,text,text)',
            'EXECUTE'
        )
        and pg_catalog.has_function_privilege(
            'service_role',
            'public.omr_force_finish_attempts_v1(text,text[],timestamptz,text,text,text,jsonb)',
            'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
            'anon',
            'public.omr_answer_attempt_question_v1(text,text,text,text,text,text,text)',
            'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
            'authenticated',
            'public.omr_answer_attempt_question_v1(text,text,text,text,text,text,text)',
            'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
            'anon',
            'public.omr_set_subquestion_review_v1(text,text,text,text,text,text,text)',
            'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
            'authenticated',
            'public.omr_set_subquestion_review_v1(text,text,text,text,text,text,text)',
            'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
            'anon',
            'public.omr_force_finish_attempts_v1(text,text[],timestamptz,text,text,text,jsonb)',
            'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
            'authenticated',
            'public.omr_force_finish_attempts_v1(text,text[],timestamptz,text,text,text,jsonb)',
            'EXECUTE'
        );

    v_hosted_storage_boundary_ready :=
        pg_catalog.to_regclass('storage.objects') is not null
        and pg_catalog.to_regclass('storage.buckets') is not null
        and (
            select count(*)
              from pg_catalog.pg_class relation
              join pg_catalog.pg_namespace namespace
                on namespace.oid = relation.relnamespace
             where namespace.nspname = 'storage'
               and relation.relname in ('objects', 'buckets')
               and relation.relowner = 'supabase_storage_admin'::regrole
               and relation.relrowsecurity
        ) = 2
        and (
            select count(*)
              from pg_catalog.pg_policies policy
             where policy.schemaname = 'storage'
               and (
                   (
                       policy.tablename = 'objects'
                       and policy.policyname =
                           'OMR private assets server-only objects'
                       and policy.qual =
                           '(bucket_id <> ''omr-private-assets''::text)'
                       and policy.with_check =
                           '(bucket_id <> ''omr-private-assets''::text)'
                   )
                   or (
                       policy.tablename = 'buckets'
                       and policy.policyname =
                           'OMR private assets server-only buckets'
                       and policy.qual =
                           '(id <> ''omr-private-assets''::text)'
                       and policy.with_check =
                           '(id <> ''omr-private-assets''::text)'
                   )
               )
               and policy.permissive = 'RESTRICTIVE'
               and policy.cmd = 'ALL'
               and policy.roles @>
                   array['anon', 'authenticated']::name[]
               and policy.roles <@
                   array['anon', 'authenticated']::name[]
               and pg_catalog.cardinality(policy.roles) = 2
        ) = 2
        and exists (
            select 1
              from storage.buckets bucket
             where bucket.id = 'omr-private-assets'
               and bucket.public = false
        );

    v_server_gateway_capabilities_ready :=
        pg_catalog.to_regprocedure(
            'public.omr_submit_attempt_v1(text,jsonb,jsonb)'
        ) is not null
        and pg_catalog.to_regprocedure(
            'public.omr_submit_session_attempt_v1(jsonb,jsonb)'
        ) is not null
        and pg_catalog.to_regprocedure(
            'public.omr_save_exam_v1(jsonb,jsonb)'
        ) is not null
        and pg_catalog.to_regprocedure(
            'public.omr_delete_exam_v1(text,text)'
        ) is not null
        and pg_catalog.to_regprocedure(
            'public.omr_save_roster_v1(text,jsonb,jsonb,jsonb,jsonb)'
        ) is not null
        and pg_catalog.to_regprocedure(
            'public.omr_attach_attempt_handwriting_v1(text,text,jsonb)'
        ) is not null
        and pg_catalog.to_regprocedure(
            'public.omr_save_feedback_v1(text,jsonb)'
        ) is not null
        and pg_catalog.to_regprocedure(
            'public.omr_return_feedback_v1(text,text,timestamptz)'
        ) is not null
        and pg_catalog.to_regprocedure(
            'public.omr_mark_feedback_opened_v2(text,text,text,timestamptz)'
        ) is not null
        and pg_catalog.to_regprocedure(
            'public.omr_save_remote_asset_metadata_v1(jsonb)'
        ) is not null
        and pg_catalog.to_regprocedure(
            'public.omr_claim_guest_attempts_v1(text,text,text,text,text,text,text[])'
        ) is not null;

    v_query_path_indexes_ready :=
        pg_catalog.to_regclass(
            'public.omr_exams_org_updated_id_idx'
        ) is not null
        and pg_catalog.to_regclass(
            'public.omr_attempts_org_finished_id_idx'
        ) is not null
        and pg_catalog.to_regclass(
            'public.omr_attempts_org_exam_finished_id_idx'
        ) is not null
        and pg_catalog.to_regclass(
            'public.omr_attempts_owner_finished_id_idx'
        ) is not null
        and pg_catalog.to_regclass(
            'public.omr_feedback_student_returned_idx'
        ) is not null;

    v_legacy_broad_rpcs_removed :=
        pg_catalog.to_regprocedure(
            'public.omr_teacher_update_attempt_v1(text,jsonb,jsonb)'
        ) is null
        and pg_catalog.to_regprocedure(
            'public.omr_mark_feedback_opened(text,timestamptz)'
        ) is null
        and pg_catalog.to_regprocedure(
            'public.omr_answer_attempt_question_v1(text,text,text,text)'
        ) is null
        and pg_catalog.to_regprocedure(
            'public.omr_set_subquestion_review_v1(text,text,text,text)'
        ) is null
        and pg_catalog.to_regprocedure(
            'public.omr_force_finish_attempts_v1(text,text[],timestamptz)'
        ) is null;

    v_ready :=
        v_browser_schema_privileges_denied
        and v_anon_table_privileges_denied
        and v_authenticated_table_privileges_denied
        and v_browser_sequence_privileges_denied
        and v_browser_function_privileges_denied
        and v_alpha_policies_absent
        and v_canonical_tables_force_rls
        and v_canonical_policies_absent
        and v_organization_backfill_ready
        and v_service_role_privileges_ready
        and v_scoped_rpc_privileges_ready
        and v_hosted_storage_boundary_ready
        and v_server_gateway_capabilities_ready
        and v_query_path_indexes_ready
        and v_legacy_broad_rpcs_removed;

    return pg_catalog.jsonb_build_object(
        'version', '202607280003',
        'browserSchemaPrivilegesDenied',
            v_browser_schema_privileges_denied,
        'anonTablePrivilegesDenied',
            v_anon_table_privileges_denied,
        'authenticatedCanonicalPrivilegesDenied',
            v_authenticated_table_privileges_denied,
        'browserSequencePrivilegesDenied',
            v_browser_sequence_privileges_denied,
        'browserFunctionPrivilegesDenied',
            v_browser_function_privileges_denied,
        'alphaPoliciesAbsent',
            v_alpha_policies_absent,
        'canonicalTablesForceRls',
            v_canonical_tables_force_rls,
        'canonicalPoliciesAbsent',
            v_canonical_policies_absent,
        'organizationBackfillReady',
            v_organization_backfill_ready,
        'serviceRolePrivilegesReady',
            v_service_role_privileges_ready,
        'scopedRpcPrivilegesReady',
            v_scoped_rpc_privileges_ready,
        'hostedStorageBoundaryReady',
            v_hosted_storage_boundary_ready,
        'serverGatewayCapabilitiesReady',
            v_server_gateway_capabilities_ready,
        'queryPathIndexesReady',
            v_query_path_indexes_ready,
        'legacyBroadRpcsRemoved',
            v_legacy_broad_rpcs_removed,
        'ready', v_ready
    );
end;
$$;

revoke all on function public.omr_service_readiness_v1() from public, anon, authenticated;
grant execute on function public.omr_service_readiness_v1() to service_role;

commit;
