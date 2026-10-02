begin;

-- The load gate now exercises the exact RPC/table paths used by production.
-- Keep the fixture RPC solely for isolated seed/cleanup and make cleanup cover
-- pending upload intents created through the production upload path.
create or replace function public.omr_initial_ops_fixture_v1(
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
    v_suffix text;
    v_now timestamptz := clock_timestamp();
    v_questions jsonb;
    v_object_paths jsonb := '[]'::jsonb;
    v_reserved_paths text[] := '{}'::text[];
    v_cleanup_paths text[] := '{}'::text[];
    v_exam_updated_at timestamptz;
begin
    if p_run_id is null or p_run_id !~ '^[a-z0-9][a-z0-9-]{7,63}$'
       or p_run_challenge_hash !~ '^[a-f0-9]{64}$' then
        raise exception 'invalid initial operations run';
    end if;
    v_suffix := substr(encode(extensions.digest(p_run_id, 'sha256'), 'hex'), 1, 16);
    if p_organization_id <> 'teacher_' || v_suffix or p_exam_id <> 'initial_ops_exam_' || v_suffix then
        raise exception 'invalid initial operations scope';
    end if;
    if p_action = 'cleanup' then
        update public.omr_initial_ops_metrics
           set state = 'cleaning', updated_at = v_now
         where run_id = p_run_id
           and challenge_hash = p_run_challenge_hash
           and state in ('active', 'cleaning')
        returning upload_object_paths into v_reserved_paths;
        if not found then raise exception 'initial operations challenge mismatch'; end if;
    end if;

    if p_action = 'create' then
        insert into public.omr_organizations (id, name, plan, metadata, created_at, updated_at)
        values (p_organization_id, 'Initial Operations ' || v_suffix, 'academy',
                jsonb_build_object('initialOperationsRunId', p_run_id), v_now, v_now)
        on conflict (id) do nothing;

        insert into public.omr_organization_members (
            organization_id, user_id, display_name, role, status, created_at, updated_at
        )
        select p_organization_id, member.user_id, member.display_name, member.role,
               'active', v_now, v_now
          from (
              select 'initial_ops_' || v_suffix as user_id,
                     'Initial Operations Owner' as display_name,
                     'owner' as role
              union all
              select 'uploader_' || v_suffix || '_' || lpad(uploader_id::text, 2, '0'),
                     'Load Uploader ' || lpad(uploader_id::text, 2, '0'),
                     'teacher'
                from generate_series(1, 10) uploader_id
          ) member
        on conflict (organization_id, user_id) do nothing;

        select jsonb_agg(jsonb_build_object(
            'id', question_id,
            'number', question_id,
            'label', 'Q' || question_id,
            'score', 1,
            'answer', ((question_id - 1) % 5) + 1,
            'choices', 5
        ) order by question_id)
        into v_questions
        from generate_series(1, 45) question_id;

        insert into public.omr_exams (
            id, organization_id, title, payload, created_by_user_id,
            created_at, updated_at, archived
        ) values (
            p_exam_id, p_organization_id, 'Initial Operations 100-user exam',
            jsonb_build_object(
                'id', p_exam_id, 'title', 'Initial Operations 100-user exam',
                'organizationId', p_organization_id, 'questions', v_questions,
                'createdAt', v_now, 'updatedAt', v_now, 'durationMin', 60,
                'archived', false, 'accessConfig', jsonb_build_object('type', 'public')
            ), 'initial_ops_' || v_suffix, v_now, v_now, false
        ) on conflict (id) do nothing;

        select exam.updated_at into v_exam_updated_at
          from public.omr_exams exam
         where exam.id = p_exam_id and exam.organization_id = p_organization_id;
        if v_exam_updated_at is null then raise exception 'initial operations fixture exam missing'; end if;

        insert into public.omr_exam_questions (
            id, organization_id, exam_id, question_id, question_number,
            canonical_question_id, label, choices, correct_answer, score,
            payload, created_at, updated_at
        )
        select p_exam_id || ':q:' || question_id, p_organization_id, p_exam_id,
               question_id, question_id, p_exam_id || ':' || question_id,
               'Q' || question_id, 5, ((question_id - 1) % 5) + 1, 1,
               jsonb_build_object(
                   'id', question_id, 'number', question_id, 'label', 'Q' || question_id,
                   'score', 1, 'answer', ((question_id - 1) % 5) + 1, 'choices', 5
               ), v_now, v_now
          from generate_series(1, 45) question_id
        on conflict (id) do nothing;

        insert into public.omr_initial_ops_metrics (run_id, challenge_hash)
        values (p_run_id, p_run_challenge_hash)
        on conflict (run_id) do nothing;
        if not exists (
            select 1 from public.omr_initial_ops_metrics
             where run_id = p_run_id and challenge_hash = p_run_challenge_hash
        ) then
            raise exception 'initial operations challenge mismatch';
        end if;
        return jsonb_build_object(
            'status', 'created', 'organizationId', p_organization_id, 'examId', p_exam_id,
            'examUpdatedAt', v_exam_updated_at
        );
    elsif p_action = 'cleanup' then
        select coalesce(array_agg(object_path order by object_path), '{}'::text[])
          into v_cleanup_paths
          from (
              select asset.object_path
                from public.omr_remote_assets asset
               where asset.organization_id = p_organization_id
              union
              select intent.object_path
                from public.omr_remote_asset_upload_intents intent
               where intent.organization_id = p_organization_id
              union
              select unnest(v_reserved_paths)
          ) cleanup_paths;
        v_object_paths := to_jsonb(v_cleanup_paths);
        update public.omr_initial_ops_metrics
           set upload_object_paths = v_cleanup_paths, updated_at = v_now
         where run_id = p_run_id and challenge_hash = p_run_challenge_hash and state = 'cleaning';
        delete from public.omr_question_results where organization_id = p_organization_id;
        delete from public.omr_attempt_sessions where organization_id = p_organization_id;
        delete from public.omr_attempts where organization_id = p_organization_id;
        delete from public.omr_remote_assets where organization_id = p_organization_id;
        delete from public.omr_remote_asset_upload_intents where organization_id = p_organization_id;
        delete from public.omr_exams where id = p_exam_id and organization_id = p_organization_id;
        delete from public.omr_remote_asset_cleanup_queue where organization_id = p_organization_id;
        delete from public.omr_organizations where id = p_organization_id;
        return jsonb_build_object(
            'status', 'cleanup_pending', 'objectPaths', v_object_paths,
            'remaining', jsonb_build_object(
                'sessions', (select count(*) from public.omr_attempt_sessions where organization_id = p_organization_id),
                'attempts', (select count(*) from public.omr_attempts where organization_id = p_organization_id),
                'assets', (select count(*) from public.omr_remote_assets where organization_id = p_organization_id),
                'uploadIntents', (select count(*) from public.omr_remote_asset_upload_intents where organization_id = p_organization_id),
                'cleanupQueue', (select count(*) from public.omr_remote_asset_cleanup_queue where organization_id = p_organization_id),
                'members', (select count(*) from public.omr_organization_members where organization_id = p_organization_id),
                'objects', jsonb_array_length(v_object_paths)
            )
        );
    elsif p_action = 'finalize_cleanup' then
        if exists (
            select 1 from public.omr_attempt_sessions where organization_id = p_organization_id
            union all select 1 from public.omr_attempts where organization_id = p_organization_id
            union all select 1 from public.omr_remote_assets where organization_id = p_organization_id
            union all select 1 from public.omr_remote_asset_upload_intents where organization_id = p_organization_id
            union all select 1 from public.omr_remote_asset_cleanup_queue where organization_id = p_organization_id
        ) then
            raise exception 'initial operations cleanup is incomplete';
        end if;
        delete from public.omr_initial_ops_metrics
         where run_id = p_run_id and challenge_hash = p_run_challenge_hash and state = 'cleaning';
        if not found then raise exception 'initial operations cleanup tombstone missing'; end if;
        delete from public.omr_organizations where id = p_organization_id;
        return jsonb_build_object(
            'status', 'cleaned',
            'remaining', jsonb_build_object(
                'sessions', 0, 'attempts', 0, 'assets', 0, 'uploadIntents', 0,
                'cleanupQueue', 0, 'members', 0, 'objects', 0
            )
        );
    end if;
    raise exception 'invalid initial operations action';
end;
$$;

-- Each snapshot always exposes one stable row per required production path.
-- The evidence bundler subtracts the before snapshot from the after snapshot,
-- and readiness fails closed unless every call delta is positive.
drop function if exists public.omr_initial_ops_database_snapshot_v1(text,text,text,text);

create or replace function public.omr_initial_ops_database_snapshot_v1(
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
    v_suffix text;
    v_rows jsonb;
    v_inventory jsonb;
    v_deadlocks bigint;
    v_stats_reset timestamptz;
    v_locktimeouts bigint;
begin
    if p_phase not in ('before', 'after') then
        raise exception 'invalid initial operations database phase';
    end if;
    v_suffix := substr(encode(extensions.digest(p_run_id, 'sha256'), 'hex'), 1, 16);
    if p_organization_id <> 'teacher_' || v_suffix or p_exam_id <> 'initial_ops_exam_' || v_suffix then
        raise exception 'invalid initial operations scope';
    end if;
    if not exists (
        select 1 from public.omr_initial_ops_metrics
         where run_id = p_run_id and challenge_hash = p_run_challenge_hash
    ) then
        raise exception 'initial operations challenge mismatch';
    end if;
    select deadlocks into v_deadlocks
      from pg_catalog.pg_stat_database where datname = current_database();
    if p_phase = 'before' then
        perform extensions.pg_stat_statements_reset(
            0,
            (select oid from pg_catalog.pg_database where datname = current_database()),
            0,
            false
        );
    end if;
    select stats_reset into v_stats_reset
      from extensions.pg_stat_statements_info;
    select lock_timeouts into v_locktimeouts
      from public.omr_initial_ops_metrics where run_id = p_run_id;

    with required(workload_path, query_pattern) as (
        values
            ('rpc:omr_open_attempt_session_v1', '%omr_open_attempt_session_v1%'),
            ('rpc:omr_checkpoint_attempt_session_v1', '%omr_checkpoint_attempt_session_v1%'),
            ('rpc:omr_heartbeat_attempt_session_v1', '%omr_heartbeat_attempt_session_v1%'),
            ('rpc:omr_prepare_attempt_session_submit_v1', '%omr_prepare_attempt_session_submit_v1%'),
            ('rpc:omr_commit_attempt_session_submit_v1', '%omr_commit_attempt_session_submit_v1%'),
            ('rpc:omr_list_active_attempt_sessions_v1', '%omr_list_active_attempt_sessions_v1%'),
            ('table:omr_remote_assets', '%from%omr_remote_assets%'),
            ('rpc:omr_prepare_teacher_asset_upload_v1', '%omr_prepare_teacher_asset_upload_v1%'),
            ('rpc:omr_authorize_teacher_asset_finalize_v1', '%omr_authorize_teacher_asset_finalize_v1%'),
            ('rpc:omr_finalize_teacher_asset_upload_v1', '%omr_finalize_teacher_asset_upload_v1%')
    ), aggregated as (
        select required.workload_path,
               coalesce(sum(stats.calls), 0)::bigint as calls,
               coalesce(max(stats.max_exec_time), 0)::double precision as maximum_execution_ms
          from required
          left join extensions.pg_stat_statements stats
            on stats.dbid = (select oid from pg_catalog.pg_database where datname = current_database())
           and stats.query ilike required.query_pattern
         group by required.workload_path
    )
    select jsonb_agg(jsonb_build_object(
        'workloadPath', workload_path,
        'fingerprint', encode(extensions.digest(workload_path, 'sha256'), 'hex'),
        'calls', calls,
        'maximumExecutionMs', maximum_execution_ms
    ) order by workload_path)
      into v_rows
      from aggregated;

    select coalesce(jsonb_agg(jsonb_build_object(
        'idempotencyKey', payload->>'submissionId',
        'attemptId', id,
        'receiptHash', payload->>'initialOperationsReceiptHash'
    ) order by id), '[]'::jsonb)
      into v_inventory
      from public.omr_attempts
     where organization_id = p_organization_id and exam_id = p_exam_id;
    return jsonb_build_object(
        'status', 'ok', 'kind', 'databaseWindow', 'instrumentation', 'pg_stat_statements',
        'productionWorkloadPaths', jsonb_build_array(
            'rpc:omr_open_attempt_session_v1',
            'rpc:omr_checkpoint_attempt_session_v1',
            'rpc:omr_heartbeat_attempt_session_v1',
            'rpc:omr_prepare_attempt_session_submit_v1',
            'rpc:omr_commit_attempt_session_submit_v1',
            'rpc:omr_list_active_attempt_sessions_v1',
            'table:omr_remote_assets',
            'rpc:omr_prepare_teacher_asset_upload_v1',
            'rpc:omr_authorize_teacher_asset_finalize_v1',
            'rpc:omr_finalize_teacher_asset_upload_v1'
        ),
        'statsResetAt', v_stats_reset, 'capturedAt', clock_timestamp(),
        'counters', jsonb_build_object('deadlocks', coalesce(v_deadlocks, 0), 'lockTimeouts', coalesce(v_locktimeouts, 0)),
        'rows', v_rows, 'attemptInventory', v_inventory,
        'counts', jsonb_build_object(
            'sessions', (select count(*) from public.omr_attempt_sessions where organization_id = p_organization_id),
            'attempts', (select count(*) from public.omr_attempts where organization_id = p_organization_id),
            'questionResults', (select count(*) from public.omr_question_results where organization_id = p_organization_id),
            'assets', (select count(*) from public.omr_remote_assets where organization_id = p_organization_id)
        )
    );
exception when undefined_table or undefined_column then
    return jsonb_build_object('status', 'unavailable');
end;
$$;

revoke all on function public.omr_initial_ops_fixture_v1(text,text,text,text,text) from public, anon, authenticated;
revoke all on function public.omr_initial_ops_database_snapshot_v1(text,text,text,text,text) from public, anon, authenticated;
grant execute on function public.omr_initial_ops_fixture_v1(text,text,text,text,text) to service_role;
grant execute on function public.omr_initial_ops_database_snapshot_v1(text,text,text,text,text) to service_role;

comment on function public.omr_initial_ops_fixture_v1(text,text,text,text,text)
    is 'initial-operations-production-coverage:202608060026';
comment on function public.omr_initial_ops_database_snapshot_v1(text,text,text,text,text)
    is 'initial-operations-production-coverage:202608060026';

-- Canned workload RPCs remain only for rollback compatibility; the staging
-- service role can no longer execute them after this migration.
revoke execute on function public.omr_initial_ops_operation_v1(text,text,text,text,text,text,jsonb) from service_role;
revoke execute on function public.omr_initial_ops_reserve_upload_v1(text,text,text,text,text,text,bigint) from service_role;

commit;
