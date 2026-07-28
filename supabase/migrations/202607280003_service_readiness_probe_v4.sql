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
    v_scoped_rpc_catalog_ready boolean := false;
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
              from information_schema.role_column_grants grant_row
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
               and (
                   pg_catalog.has_table_privilege(
                       'anon',
                       relation.oid,
                       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
                   )
                   or pg_catalog.has_any_column_privilege(
                       'anon',
                       relation.oid,
                       'SELECT,INSERT,UPDATE,REFERENCES'
                   )
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
              from information_schema.role_column_grants grant_row
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
               and (
                   pg_catalog.has_table_privilege(
                       'authenticated',
                       relation.oid,
                       'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
                   )
                   or pg_catalog.has_any_column_privilege(
                       'authenticated',
                       relation.oid,
                       'SELECT,INSERT,UPDATE,REFERENCES'
                   )
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

    with expected_canonical_tables(table_name) as (
        values
            ('omr_organizations'),
            ('omr_plan_usage'),
            ('omr_plan_usage_reservations'),
            ('omr_user_profiles'),
            ('omr_organization_members'),
            ('omr_teacher_profiles'),
            ('omr_student_profiles'),
            ('omr_student_start_credentials'),
            ('omr_classes'),
            ('omr_roster_invites'),
            ('omr_class_teachers'),
            ('omr_class_students'),
            ('omr_materials'),
            ('omr_exams'),
            ('omr_exam_questions'),
            ('omr_exam_materials'),
            ('omr_assignments'),
            ('omr_assignment_targets'),
            ('omr_attempts'),
            ('omr_question_results'),
            ('omr_assignment_submissions'),
            ('omr_attempt_feedback'),
            ('omr_kakao_candidate_reviews'),
            ('omr_kakao_dispatch_logs'),
            ('omr_comments'),
            ('omr_audit_logs'),
            ('omr_remote_assets')
    ),
    actual_canonical_tables(table_name, row_security, force_row_security) as (
        select
            relation.relname::text,
            relation.relrowsecurity,
            relation.relforcerowsecurity
          from pg_catalog.pg_class relation
          join pg_catalog.pg_namespace namespace
            on namespace.oid = relation.relnamespace
         where namespace.nspname = 'public'
           and relation.relkind in ('r', 'p')
           and relation.relname like 'omr\_%' escape '\'
    )
    select
        not exists (
            select table_name
              from expected_canonical_tables
            except
            select table_name
              from actual_canonical_tables
        )
        and not exists (
            select table_name
              from actual_canonical_tables
            except
            select table_name
              from expected_canonical_tables
        )
        and not exists (
            select 1
              from actual_canonical_tables
             where not row_security
                or not force_row_security
        )
      into v_canonical_tables_force_rls;

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

    with expected_scoped_rpcs(routine_name, identity_arguments) as (
        values
            (
                'omr_answer_attempt_question_v1',
                'text, text, text, text, text, text, text'
            ),
            (
                'omr_set_subquestion_review_v1',
                'text, text, text, text, text, text, text'
            ),
            (
                'omr_force_finish_attempts_v1',
                'text, text[], timestamp with time zone, text, text, text, jsonb'
            )
    ),
    actual_scoped_rpcs(routine_name, identity_arguments) as (
        select
            routine.proname::text,
            pg_catalog.oidvectortypes(routine.proargtypes)
          from pg_catalog.pg_proc routine
          join pg_catalog.pg_namespace namespace
            on namespace.oid = routine.pronamespace
         where namespace.nspname = 'public'
           and routine.proname in (
               'omr_answer_attempt_question_v1',
               'omr_set_subquestion_review_v1',
               'omr_force_finish_attempts_v1'
           )
    )
    select
        not exists (
            select routine_name, identity_arguments
              from expected_scoped_rpcs
            except
            select routine_name, identity_arguments
              from actual_scoped_rpcs
        )
        and not exists (
            select routine_name, identity_arguments
              from actual_scoped_rpcs
            except
            select routine_name, identity_arguments
              from expected_scoped_rpcs
        )
      into v_scoped_rpc_catalog_ready;

    v_scoped_rpc_privileges_ready :=
        v_scoped_rpc_catalog_ready
        and pg_catalog.to_regprocedure(
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

    v_legacy_broad_rpcs_removed := not exists (
        select 1
          from pg_catalog.pg_proc routine
          join pg_catalog.pg_namespace namespace
            on namespace.oid = routine.pronamespace
         where namespace.nspname = 'public'
           and routine.proname in (
               'omr_teacher_update_attempt_v1',
               'omr_mark_feedback_opened'
           )
    );

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
