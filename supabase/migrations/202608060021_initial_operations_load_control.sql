-- Service-role-only primitives for the explicitly enabled, physically isolated
-- initial-operations staging load gate. The HTTP boundary applies the staging
-- secret/environment checks; these functions independently fence every row to
-- the SHA-derived run fixture.

create table if not exists public.omr_initial_ops_metrics (
    run_id text primary key,
    challenge_hash text not null check (challenge_hash ~ '^[a-f0-9]{64}$'),
    state text not null default 'active' check (state in ('active', 'cleaning')),
    upload_object_paths text[] not null default '{}'::text[],
    upload_reserved_bytes bigint not null default 0
        check (upload_reserved_bytes between 0 and 524288000),
    lock_timeouts bigint not null default 0 check (lock_timeouts >= 0),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
alter table public.omr_initial_ops_metrics enable row level security;
alter table public.omr_initial_ops_metrics force row level security;
revoke all on public.omr_initial_ops_metrics from public, anon, authenticated;
grant all on public.omr_initial_ops_metrics to service_role;

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
            'status', 'created', 'organizationId', p_organization_id, 'examId', p_exam_id
        );
    elsif p_action = 'cleanup' then
        select coalesce(jsonb_agg(object_path order by object_path), '[]'::jsonb)
          into v_object_paths
          from (
              select asset.object_path
                from public.omr_remote_assets asset
               where asset.organization_id = p_organization_id
              union
              select unnest(v_reserved_paths)
          ) cleanup_paths;
        delete from public.omr_question_results where organization_id = p_organization_id;
        delete from public.omr_attempt_sessions where organization_id = p_organization_id;
        delete from public.omr_attempts where organization_id = p_organization_id;
        delete from public.omr_remote_assets where organization_id = p_organization_id;
        delete from public.omr_exams where id = p_exam_id and organization_id = p_organization_id;
        delete from public.omr_initial_ops_metrics where run_id = p_run_id;
        delete from public.omr_organizations where id = p_organization_id;
        return jsonb_build_object(
            'status', 'cleaned', 'objectPaths', v_object_paths,
            'remaining', jsonb_build_object(
                'sessions', (select count(*) from public.omr_attempt_sessions where organization_id = p_organization_id),
                'attempts', (select count(*) from public.omr_attempts where organization_id = p_organization_id),
                'assets', (select count(*) from public.omr_remote_assets where organization_id = p_organization_id),
                'objects', jsonb_array_length(v_object_paths)
            )
        );
    end if;
    raise exception 'invalid initial operations action';
end;
$$;

create or replace function public.omr_initial_ops_reserve_upload_v1(
    p_run_id text,
    p_run_challenge_hash text,
    p_actor_id text,
    p_organization_id text,
    p_exam_id text,
    p_object_path text,
    p_byte_size bigint
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
    v_run public.omr_initial_ops_metrics%rowtype;
begin
    if p_run_id is null or p_run_id !~ '^[a-z0-9][a-z0-9-]{7,63}$'
       or p_run_challenge_hash !~ '^[a-f0-9]{64}$'
       or p_byte_size <> 52428800 then
        raise exception 'invalid initial operations upload reservation';
    end if;
    v_suffix := substr(encode(extensions.digest(p_run_id, 'sha256'), 'hex'), 1, 16);
    if p_organization_id <> 'teacher_' || v_suffix
       or p_exam_id <> 'initial_ops_exam_' || v_suffix
       or p_actor_id !~ ('^uploader_' || v_suffix || '_[0-9]{2}$')
       or p_object_path !~ (
           '^organizations/' || p_organization_id || '/exams/' || p_exam_id
           || '/problem/asset_[a-f0-9]{32}\.pdf$'
       ) then
        raise exception 'invalid initial operations upload scope';
    end if;

    select * into v_run
      from public.omr_initial_ops_metrics
     where run_id = p_run_id
       and challenge_hash = p_run_challenge_hash
     for update;
    if not found or v_run.state <> 'active' then
        raise exception 'initial operations run is not active';
    end if;
    if not exists (
        select 1 from public.omr_exams
         where id = p_exam_id and organization_id = p_organization_id
    ) then
        raise exception 'initial operations fixture missing';
    end if;
    if p_object_path = any(v_run.upload_object_paths) then
        return jsonb_build_object(
            'status', 'reserved', 'idempotent', true,
            'reservedObjects', cardinality(v_run.upload_object_paths),
            'reservedBytes', v_run.upload_reserved_bytes
        );
    end if;
    if cardinality(v_run.upload_object_paths) >= 10
       or v_run.upload_reserved_bytes + p_byte_size > 524288000 then
        raise exception 'initial operations upload quota exceeded';
    end if;

    update public.omr_initial_ops_metrics
       set upload_object_paths = array_append(upload_object_paths, p_object_path),
           upload_reserved_bytes = upload_reserved_bytes + p_byte_size,
           updated_at = clock_timestamp()
     where run_id = p_run_id;
    return jsonb_build_object(
        'status', 'reserved', 'idempotent', false,
        'reservedObjects', cardinality(v_run.upload_object_paths) + 1,
        'reservedBytes', v_run.upload_reserved_bytes + p_byte_size
    );
end;
$$;

create or replace function public.omr_initial_ops_operation_v1(
    p_operation text,
    p_run_id text,
    p_run_challenge_hash text,
    p_actor_id text,
    p_organization_id text,
    p_exam_id text,
    p_payload jsonb
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
    v_session_id text;
    v_attempt_id text;
    v_submission_id text;
    v_exam jsonb;
    v_revision bigint;
    v_receipt jsonb;
    v_receipt_hash text;
begin
    if p_run_id is null or p_run_id !~ '^[a-z0-9][a-z0-9-]{7,63}$'
       or p_run_challenge_hash !~ '^[a-f0-9]{64}$'
       or p_payload is null or jsonb_typeof(p_payload) <> 'object' then
        raise exception 'invalid initial operations request';
    end if;
    v_suffix := substr(encode(extensions.digest(p_run_id, 'sha256'), 'hex'), 1, 16);
    if p_organization_id <> 'teacher_' || v_suffix or p_exam_id <> 'initial_ops_exam_' || v_suffix
       or p_actor_id !~ ('^(student_' || v_suffix || '_[0-9]{3}|poller_' || v_suffix || '_[0-9]{2}|uploader_' || v_suffix || '_[0-9]{2})$') then
        raise exception 'invalid initial operations scope';
    end if;
    if not exists (select 1 from public.omr_exams where id = p_exam_id and organization_id = p_organization_id) then
        raise exception 'initial operations fixture missing';
    end if;
    if not exists (
        select 1 from public.omr_initial_ops_metrics
         where run_id = p_run_id and challenge_hash = p_run_challenge_hash
    ) then
        raise exception 'initial operations challenge mismatch';
    end if;

    if p_operation = 'student-read' then
        select payload into v_exam from public.omr_exams where id = p_exam_id and organization_id = p_organization_id;
        v_session_id := p_run_id || ':session:' || p_actor_id;
        v_attempt_id := p_run_id || ':attempt:' || p_actor_id;
        v_submission_id := p_run_id || ':submission:' || right(p_actor_id, 3);
        insert into public.omr_attempt_sessions (
            id, organization_id, exam_id, owner_student_id, student_name,
            identity_type, scope_key, submission_id, attempt_id,
            allowed_question_ids, exam_updated_at, grading_snapshot,
            started_at, deadline_at, last_heartbeat_at,
            lease_token_hash, lease_expires_at
        ) values (
            v_session_id, p_organization_id, p_exam_id, p_actor_id,
            'Load Student ' || right(p_actor_id, 3), 'temporary', 'initial-ops',
            v_submission_id, v_attempt_id,
            array(select generate_series(1, 45)), v_now, v_exam,
            v_now, v_now + interval '1 hour', v_now,
            encode(extensions.digest(p_run_id || ':' || p_actor_id, 'sha256'), 'hex'),
            v_now + interval '1 hour'
        ) on conflict (id) do nothing;
        return jsonb_build_object('status', 'ok', 'examId', p_exam_id, 'questionCount', 45);
    elsif p_operation = 'checkpoint' then
        update public.omr_attempt_sessions
           set answers = answers || jsonb_build_object(
                   (((revision - 1) % 45) + 1)::text,
                   (((revision - 1) % 5) + 1)
               ),
               progress_payload = jsonb_build_object(
                   'currentQuestionId', ((revision - 1) % 45) + 1,
                   'runId', p_run_id
               ),
               revision = revision + 1,
               updated_at = v_now,
               last_heartbeat_at = v_now
         where id = p_run_id || ':session:' || p_actor_id
           and organization_id = p_organization_id
           and status = 'in_progress'
           and revision = (p_payload->>'revision')::bigint
        returning revision into v_revision;
        if v_revision is null then raise exception 'initial operations revision conflict'; end if;
        return jsonb_build_object('status', 'ok', 'revision', v_revision);
    elsif p_operation = 'heartbeat' then
        update public.omr_attempt_sessions
           set last_heartbeat_at = v_now, updated_at = v_now, lease_expires_at = v_now + interval '1 hour'
         where id = p_run_id || ':session:' || p_actor_id
           and organization_id = p_organization_id and status = 'in_progress'
        returning revision into v_revision;
        if v_revision is null then raise exception 'initial operations session missing'; end if;
        return jsonb_build_object('status', 'ok', 'revision', v_revision);
    elsif p_operation = 'teacher-live-read' then
        return jsonb_build_object(
            'status', 'ok',
            'observedRevisions', coalesce((
                select jsonb_object_agg(owner_student_id, revision order by owner_student_id)
                  from public.omr_attempt_sessions
                 where organization_id = p_organization_id and exam_id = p_exam_id
            ), '{}'::jsonb)
        );
    elsif p_operation = 'teacher-upload-read' then
        return jsonb_build_object(
            'status', 'ok', 'examId', p_exam_id,
            'assetCount', (select count(*) from public.omr_remote_assets where organization_id = p_organization_id and exam_id = p_exam_id)
        );
    elsif p_operation = 'teacher-max-pdf-upload-finalize' then
        if coalesce(p_payload->>'objectPath', '') !~ (
               '^organizations/' || p_organization_id || '/exams/' || p_exam_id || '/problem/asset_[a-f0-9]{32}\.pdf$'
           )
           or coalesce((p_payload->>'byteSize')::bigint, 0) <> 52428800
           or coalesce(p_payload->>'sha256Hex', '') !~ '^[a-f0-9]{64}$'
           or coalesce(p_payload->>'assetId', '') !~ '^asset_[a-f0-9]{32}$' then
            raise exception 'invalid initial operations upload';
        end if;
        insert into public.omr_remote_assets (
            id, organization_id, kind, exam_id, storage_bucket, object_path,
            mime_type, byte_size, sha256_hex, original_name, created_by_user_id,
            created_at, updated_at
        ) values (
            p_payload->>'assetId', p_organization_id, 'problem_pdf', p_exam_id,
            'omr-private-assets', p_payload->>'objectPath', 'application/pdf',
            (p_payload->>'byteSize')::bigint, p_payload->>'sha256Hex',
            p_actor_id || '.pdf', nullif(p_payload->>'createdByUserId', ''), v_now, v_now
        ) on conflict (id) do update set
            updated_at = excluded.updated_at
        where public.omr_remote_assets.organization_id = excluded.organization_id
          and public.omr_remote_assets.object_path = excluded.object_path
          and public.omr_remote_assets.byte_size = excluded.byte_size
          and public.omr_remote_assets.sha256_hex = excluded.sha256_hex;
        return jsonb_build_object('status', 'finalized', 'objectPath', p_payload->>'objectPath');
    elsif p_operation in ('student-submit', 'student-submit-replay') then
        select attempt_id, submission_id into v_attempt_id, v_submission_id
          from public.omr_attempt_sessions
         where id = p_run_id || ':session:' || p_actor_id and organization_id = p_organization_id;
        if v_attempt_id is null then raise exception 'initial operations session missing'; end if;
        v_receipt_hash := encode(extensions.digest(v_attempt_id || chr(31) || v_submission_id, 'sha256'), 'hex');
        insert into public.omr_attempts (
            id, organization_id, exam_id, student_name, student_id, identity_type,
            status, score, total_score, score_percent, payload, started_at, finished_at
        )
        select v_attempt_id, p_organization_id, p_exam_id,
               'Load Student ' || right(p_actor_id, 3), p_actor_id, 'temporary',
               'completed', 45, 45, 100,
               jsonb_build_object(
                   'id', v_attempt_id, 'examId', p_exam_id, 'organizationId', p_organization_id,
                   'studentName', 'Load Student ' || right(p_actor_id, 3), 'studentId', p_actor_id,
                    'identityType', 'temporary', 'submissionId', v_submission_id,
                    'initialOperationsReceiptHash', v_receipt_hash,
                   'answers', answers, 'subQuestionAnswers', '{}'::jsonb,
                   'score', 45, 'totalScore', 45, 'scorePercent', 100,
                   'startedAt', started_at, 'finishedAt', v_now, 'status', 'completed'
               ), started_at, v_now
          from public.omr_attempt_sessions
         where id = p_run_id || ':session:' || p_actor_id
        on conflict (id) do nothing;

        insert into public.omr_question_results (
            id, organization_id, attempt_id, exam_id, student_name, student_id,
            identity_type, question_id, question_number, canonical_question_id,
            selected_answer, correct_answer, status, is_correct, is_wrong,
            is_unanswered, score, earned_score, finished_at, payload, created_at, updated_at
        )
        select v_attempt_id || ':' || question_id, p_organization_id, v_attempt_id, p_exam_id,
               'Load Student ' || right(p_actor_id, 3), p_actor_id, 'temporary',
               question_id, question_id, p_exam_id || ':' || question_id,
               ((question_id - 1) % 5) + 1, ((question_id - 1) % 5) + 1,
               'correct', true, false, false, 1, 1, v_now,
               jsonb_build_object(
                   'schemaVersion', 1, 'attemptId', v_attempt_id, 'examId', p_exam_id,
                   'examTitle', 'Initial Operations 100-user exam', 'organizationId', p_organization_id,
                   'studentName', 'Load Student ' || right(p_actor_id, 3), 'studentId', p_actor_id,
                   'identityType', 'temporary', 'questionId', question_id,
                   'questionNumber', question_id, 'score', 1, 'earnedScore', 1,
                   'selectedAnswer', ((question_id - 1) % 5) + 1,
                   'correctAnswer', ((question_id - 1) % 5) + 1,
                   'status', 'correct', 'isCorrect', true, 'isWrong', false,
                   'isUnanswered', false, 'finishedAt', v_now
               ), v_now, v_now
          from generate_series(1, 45) question_id
        on conflict (id) do nothing;

        update public.omr_attempt_sessions
           set status = 'submitted', submitted_attempt_id = v_attempt_id,
               submitted_at = coalesce(submitted_at, v_now), updated_at = v_now
         where id = p_run_id || ':session:' || p_actor_id
           and organization_id = p_organization_id;
        v_receipt := jsonb_build_object(
            'attemptId', v_attempt_id, 'submissionId', v_submission_id,
            'status', 'submitted', 'score', 45, 'totalScore', 45
        );
        return jsonb_build_object(
            'status', 'submitted', 'attemptId', v_attempt_id,
            'receiptHash', v_receipt_hash, 'receipt', v_receipt
        );
    end if;
    raise exception 'invalid initial operations operation';
exception
    when lock_not_available or query_canceled then
        update public.omr_initial_ops_metrics
           set lock_timeouts = lock_timeouts + 1, updated_at = clock_timestamp()
         where run_id = p_run_id;
        raise;
end;
$$;

create or replace function public.omr_initial_ops_database_snapshot_v1(
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
    v_rows jsonb;
    v_inventory jsonb;
    v_deadlocks bigint;
    v_stats_reset timestamptz;
    v_locktimeouts bigint;
begin
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
    select deadlocks, stats_reset into v_deadlocks, v_stats_reset
      from pg_catalog.pg_stat_database where datname = current_database();
    select lock_timeouts into v_locktimeouts
      from public.omr_initial_ops_metrics where run_id = p_run_id;
    select coalesce(jsonb_agg(jsonb_build_object(
        'fingerprint', encode(extensions.digest(query, 'sha256'), 'hex'),
        'calls', calls::bigint,
        'maximumExecutionMs', max_exec_time
    ) order by max_exec_time desc), '[]'::jsonb)
      into v_rows
      from extensions.pg_stat_statements
     where dbid = (select oid from pg_catalog.pg_database where datname = current_database())
       and query ilike '%omr_initial_ops_%';
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
revoke all on function public.omr_initial_ops_reserve_upload_v1(text,text,text,text,text,text,bigint) from public, anon, authenticated;
revoke all on function public.omr_initial_ops_operation_v1(text,text,text,text,text,text,jsonb) from public, anon, authenticated;
revoke all on function public.omr_initial_ops_database_snapshot_v1(text,text,text,text) from public, anon, authenticated;
grant execute on function public.omr_initial_ops_fixture_v1(text,text,text,text,text) to service_role;
grant execute on function public.omr_initial_ops_reserve_upload_v1(text,text,text,text,text,text,bigint) to service_role;
grant execute on function public.omr_initial_ops_operation_v1(text,text,text,text,text,text,jsonb) to service_role;
grant execute on function public.omr_initial_ops_database_snapshot_v1(text,text,text,text) to service_role;
