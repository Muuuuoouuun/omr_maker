begin;

create index if not exists omr_attempt_sessions_expiry_gc_idx
    on public.omr_attempt_sessions (deadline_at, id)
    where status = 'in_progress';

create index if not exists omr_attempt_sessions_terminal_gc_idx
    on public.omr_attempt_sessions (updated_at, id)
    where status in ('submitted', 'expired');

create index if not exists omr_remote_assets_handwriting_orphan_gc_idx
    on public.omr_remote_assets (created_at, id)
    where kind = 'attempt_handwriting';

create index if not exists omr_remote_asset_cleanup_org_status_idx
    on public.omr_remote_asset_cleanup_queue (organization_id, status, available_at, id)
    where status in ('pending', 'leased', 'dead');

create or replace function public.omr_checkpoint_attempt_session_v1(
    p_session_id text,
    p_organization_id text,
    p_owner_student_id text,
    p_expected_revision bigint,
    p_expected_lease_epoch bigint,
    p_lease_token_hash text,
    p_answers jsonb,
    p_sub_question_answers jsonb,
    p_progress_payload jsonb,
    p_lease_seconds integer,
    p_final_checkpoint boolean
)
returns table (
    session_id text,
    status text,
    revision bigint,
    lease_epoch bigint,
    started_at timestamptz,
    deadline_at timestamptz,
    server_now timestamptz,
    answers jsonb,
    sub_question_answers jsonb,
    progress_payload jsonb,
    allowed_question_ids integer[],
    submitted_attempt_id text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_now timestamptz := pg_catalog.clock_timestamp();
    v_session public.omr_attempt_sessions%rowtype;
    v_answer_key text;
    v_sub_answer_key text;
    v_answer_value jsonb;
    v_lease_seconds integer := least(greatest(coalesce(p_lease_seconds, 45), 30), 120);
begin
    if jsonb_typeof(p_answers) is distinct from 'object'
       or jsonb_typeof(p_sub_question_answers) is distinct from 'object'
       or jsonb_typeof(p_progress_payload) is distinct from 'object'
       or pg_column_size(p_answers) > 65536
       or pg_column_size(p_sub_question_answers) > 524288
       or pg_column_size(p_progress_payload) > 524288
       or (select count(*) from jsonb_object_keys(p_answers)) > 500 then
        raise exception 'invalid attempt session checkpoint';
    end if;

    -- One row lock supplies scope, state, revision, lease and the immutable
    -- allowed question set for the entire checkpoint validation pass.
    select * into v_session
      from public.omr_attempt_sessions attempt_session
     where attempt_session.id = btrim(p_session_id)
     for update;
    if not found
       or v_session.organization_id is distinct from btrim(p_organization_id)
       or v_session.owner_student_id is distinct from btrim(p_owner_student_id) then
        raise exception 'attempt session not owned';
    end if;
    if v_session.status <> 'in_progress' then raise exception 'attempt session is not active'; end if;

    for v_answer_key, v_answer_value in select key, value from jsonb_each(p_answers)
    loop
        if v_answer_key !~ '^[1-9][0-9]*$'
           or v_answer_key::integer <> all(v_session.allowed_question_ids)
           or jsonb_typeof(v_answer_value) <> 'number'
           or (v_answer_value #>> '{}')::numeric not in (1, 2, 3, 4, 5) then
            raise exception 'attempt session answer invalid';
        end if;
    end loop;
    for v_sub_answer_key in select key from jsonb_each(p_sub_question_answers)
    loop
        if v_sub_answer_key !~ '^[1-9][0-9]*$'
           or v_sub_answer_key::integer <> all(v_session.allowed_question_ids) then
            raise exception 'attempt session sub-question answer invalid';
        end if;
    end loop;

    if v_session.deadline_at <= v_now
       and (not coalesce(p_final_checkpoint, false)
            or v_session.deadline_at + interval '30 seconds' < v_now) then
        update public.omr_attempt_sessions
           set status = 'expired', updated_at = v_now
         where id = v_session.id
         returning * into v_session;
        return query select
            v_session.id, v_session.status, v_session.revision, v_session.lease_epoch,
            v_session.started_at, v_session.deadline_at, v_now, v_session.answers,
            v_session.sub_question_answers, v_session.progress_payload, v_session.allowed_question_ids,
            v_session.submitted_attempt_id;
        return;
    end if;
    if v_session.revision <> p_expected_revision then raise exception 'attempt session revision conflict'; end if;
    if v_session.lease_epoch <> p_expected_lease_epoch
       or v_session.lease_token_hash <> btrim(p_lease_token_hash)
       or v_session.lease_expires_at <= v_now then
        raise exception 'attempt session lease conflict';
    end if;

    update public.omr_attempt_sessions as attempt_session
       set answers = p_answers,
           sub_question_answers = p_sub_question_answers,
           progress_payload = p_progress_payload,
           revision = attempt_session.revision + 1,
           last_heartbeat_at = v_now,
           lease_expires_at = v_now + make_interval(secs => v_lease_seconds),
           updated_at = v_now
     where id = v_session.id
     returning * into v_session;

    return query select
        v_session.id, v_session.status, v_session.revision, v_session.lease_epoch,
        v_session.started_at, v_session.deadline_at, v_now, v_session.answers,
        v_session.sub_question_answers, v_session.progress_payload, v_session.allowed_question_ids,
        v_session.submitted_attempt_id;
end;
$$;

create function public.omr_gc_attempt_sessions_v1(
    p_limit integer default 100,
    p_retention_days integer default 7
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_deleted integer;
begin
    if p_limit is null or not (p_limit between 1 and 100)
       or p_retention_days is null or not (p_retention_days between 7 and 90) then
        raise exception 'invalid attempt session GC request';
    end if;

    with terminal_candidates as materialized (
        select attempt_session.id
          from public.omr_attempt_sessions attempt_session
         where attempt_session.status in ('submitted', 'expired')
           and attempt_session.updated_at <= now() - make_interval(days => p_retention_days)
           and (
               attempt_session.status = 'expired'
               or (
                   exists (
                       select 1 from public.omr_attempts attempt
                        where attempt.id = attempt_session.submitted_attempt_id
                          and attempt.organization_id = attempt_session.organization_id
                          and attempt.status = 'completed'
                   )
                   and not exists (
                       select 1 from public.omr_remote_assets asset
                       join public.omr_attempts attempt on attempt.id = asset.attempt_id
                        where asset.organization_id = attempt_session.organization_id
                          and asset.attempt_id = attempt_session.submitted_attempt_id
                          and asset.kind = 'attempt_handwriting'
                          and attempt.payload #>> '{drawingsRef,key}' is distinct from asset.id
                   )
               )
           )
         order by attempt_session.updated_at, attempt_session.id
         for update skip locked
         limit p_limit
    )
    delete from public.omr_attempt_sessions attempt_session
     using terminal_candidates candidate
     where attempt_session.id = candidate.id;
    get diagnostics v_deleted = row_count;
    return v_deleted;
end;
$$;

create function public.omr_requeue_dead_remote_asset_cleanup_v1(
    p_organization_id text,
    p_cleanup_id text,
    p_expected_attempt integer,
    p_operator_id text,
    p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_queue public.omr_remote_asset_cleanup_queue%rowtype;
begin
    if nullif(btrim(p_organization_id), '') is null
       or nullif(btrim(p_cleanup_id), '') is null
       or p_expected_attempt is null or p_expected_attempt not between 1 and 10
       or nullif(btrim(p_operator_id), '') is null or length(p_operator_id) > 128
       or nullif(btrim(p_reason), '') is null or length(p_reason) > 300 then
        raise exception 'invalid dead cleanup requeue';
    end if;

    select * into v_queue
      from public.omr_remote_asset_cleanup_queue queue
     where queue.id::text = btrim(p_cleanup_id)
       and queue.organization_id = btrim(p_organization_id)
       and queue.status = 'dead'
       and queue.attempts = p_expected_attempt
     for update;
    if not found then
        return jsonb_build_object('status', 'conflict');
    end if;

    update public.omr_remote_asset_cleanup_queue queue
       set status = 'pending',
           attempts = 0,
           available_at = now(),
           lease_owner = null,
           lease_until = null,
           last_error = left(
               'operator_requeue:' || btrim(p_operator_id) || ':' || btrim(p_reason),
               500
           ),
           updated_at = now()
     where queue.id = v_queue.id
     returning * into v_queue;

    return jsonb_build_object('status', 'requeued', 'cleanupId', v_queue.id::text);
end;
$$;

create or replace function public.omr_claim_remote_asset_cleanup_v1(
    p_worker_id text,
    p_limit integer default 50,
    p_lease_seconds integer default 60
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_claimed jsonb;
begin
    if nullif(pg_catalog.btrim(p_worker_id), '') is null
       or length(p_worker_id) > 128
       or p_limit is null or p_limit not between 1 and 100
       or p_lease_seconds is null or p_lease_seconds not between 15 and 900 then
        raise exception 'invalid remote asset cleanup claim';
    end if;

    -- Each maintenance family pays at most one caller-selected small batch.
    perform public.omr_gc_attempt_sessions_v1(p_limit, 7);

    with expired_session_candidates as materialized (
        select attempt_session.id
          from public.omr_attempt_sessions attempt_session
         where attempt_session.status = 'in_progress'
           and attempt_session.deadline_at + interval '30 seconds' < now()
         order by attempt_session.deadline_at, attempt_session.id
         for update skip locked
         limit p_limit
    )
    update public.omr_attempt_sessions attempt_session
       set status = 'expired', updated_at = now()
      from expired_session_candidates candidate
     where attempt_session.id = candidate.id;

    -- Preserve a submitted session's handwriting attachment recovery window.
    with orphan_handwriting_candidates as materialized (
        select asset.id
          from public.omr_remote_assets asset
         where asset.kind = 'attempt_handwriting'
           and asset.created_at <= now() - interval '2 hours'
           and not exists (
               select 1 from public.omr_attempts attempt
                where attempt.organization_id = asset.organization_id
                  and attempt.id = asset.attempt_id
                  and attempt.status = 'completed'
                  and attempt.payload #>> '{drawingsRef,key}' = asset.id
           )
           and not exists (
               select 1 from public.omr_attempt_sessions attempt_session
                where attempt_session.organization_id = asset.organization_id
                  and attempt_session.submitted_attempt_id = asset.attempt_id
                  and attempt_session.status = 'submitted'
                  and attempt_session.updated_at > now() - interval '7 days'
           )
         order by asset.created_at, asset.id
         for update skip locked
         limit p_limit
    )
    delete from public.omr_remote_assets asset
     using orphan_handwriting_candidates candidate
     where asset.id = candidate.id;

    with dead_candidates as materialized (
        select queue.id from public.omr_remote_asset_cleanup_queue queue
         where queue.status = 'leased' and queue.attempts >= 10
           and queue.lease_until <= now()
         order by queue.lease_until, queue.id
         for update skip locked
         limit p_limit
    )
    update public.omr_remote_asset_cleanup_queue queue
       set status = 'dead', lease_owner = null, lease_until = null, updated_at = now()
      from dead_candidates candidate where queue.id = candidate.id;

    with expired_intent_candidates as materialized (
        select intent.id
          from public.omr_remote_asset_upload_intents intent
         where intent.expires_at <= now()
           and not exists (
               select 1 from public.omr_attempt_sessions attempt_session
                where attempt_session.organization_id = intent.organization_id
                  and attempt_session.exam_id = intent.exam_id
                  and attempt_session.status = 'in_progress'
                  and (
                      (intent.kind = 'problem_pdf'
                       and attempt_session.grading_snapshot #>> '{pdfDataRef,key}' = intent.id)
                      or (intent.kind = 'answer_key_pdf'
                          and attempt_session.grading_snapshot #>> '{answerKeyPdfRef,key}' = intent.id)
                  )
           )
           and (
               intent.status in ('pending', 'uploaded')
               or (
                   intent.status = 'finalized'
                   and not exists (
                       select 1 from public.omr_exams exam
                        where exam.organization_id = intent.organization_id
                          and exam.id = intent.exam_id
                          and (
                              (intent.kind = 'problem_pdf' and exam.payload #>> '{pdfDataRef,key}' = intent.id)
                              or (intent.kind = 'answer_key_pdf' and exam.payload #>> '{answerKeyPdfRef,key}' = intent.id)
                          )
                   )
               )
           )
         order by intent.expires_at, intent.id
         for update skip locked
         limit p_limit
    ), queued as (
        insert into public.omr_remote_asset_cleanup_queue (
            organization_id, exam_id, asset_kind, source_type, source_id,
            storage_bucket, object_path, byte_size, reason
        )
        select intent.organization_id, intent.exam_id, intent.kind,
               case when asset.id is null then 'upload_intent' else 'remote_asset' end,
               intent.id, intent.storage_bucket,
               intent.object_path, intent.byte_size, 'expired_upload'
          from public.omr_remote_asset_upload_intents intent
          join expired_intent_candidates candidate on candidate.id = intent.id
          left join public.omr_remote_assets asset on asset.id = intent.id
        on conflict (storage_bucket, object_path) do nothing
        returning id
    )
    update public.omr_remote_asset_upload_intents intent
       set status = 'expired', updated_at = now()
      from expired_intent_candidates candidate
     where intent.id = candidate.id and (select count(*) from queued) >= 0;

    with claim_candidates as materialized (
        select queue.id from public.omr_remote_asset_cleanup_queue queue
         where queue.attempts < 10 and queue.available_at <= now()
           and (queue.status = 'pending' or (queue.status = 'leased' and queue.lease_until <= now()))
           and not exists (
               select 1 from public.omr_attempt_sessions attempt_session
                where attempt_session.organization_id = queue.organization_id
                  and attempt_session.exam_id = queue.exam_id
                  and attempt_session.status = 'in_progress'
                  and (
                      (queue.asset_kind = 'problem_pdf'
                       and attempt_session.grading_snapshot #>> '{pdfDataRef,key}' = queue.source_id)
                      or (queue.asset_kind = 'answer_key_pdf'
                          and attempt_session.grading_snapshot #>> '{answerKeyPdfRef,key}' = queue.source_id)
                  )
           )
           and not exists (
               select 1 from public.omr_attempts attempt
                where queue.asset_kind = 'attempt_handwriting'
                  and attempt.organization_id = queue.organization_id
                  and attempt.status = 'completed'
                  and attempt.payload #>> '{drawingsRef,key}' = queue.source_id
           )
         order by queue.available_at, queue.id
         for update skip locked
         limit p_limit
    ), claimed as (
        update public.omr_remote_asset_cleanup_queue queue
           set status = 'leased', attempts = queue.attempts + 1,
               lease_owner = pg_catalog.btrim(p_worker_id),
               lease_until = now() + pg_catalog.make_interval(secs => p_lease_seconds),
               updated_at = now()
          from claim_candidates candidate where queue.id = candidate.id
        returning queue.*
    )
    select coalesce(
        pg_catalog.jsonb_agg(pg_catalog.to_jsonb(claimed) order by claimed.id), '[]'::jsonb
    ) into v_claimed from claimed;
    return v_claimed;
end;
$$;

revoke all on function public.omr_checkpoint_attempt_session_v1(text,text,text,bigint,bigint,text,jsonb,jsonb,jsonb,integer,boolean)
    from public, anon, authenticated;
grant execute on function public.omr_checkpoint_attempt_session_v1(text,text,text,bigint,bigint,text,jsonb,jsonb,jsonb,integer,boolean)
    to service_role;
revoke all on function public.omr_gc_attempt_sessions_v1(integer,integer) from public, anon, authenticated;
grant execute on function public.omr_gc_attempt_sessions_v1(integer,integer) to service_role;
revoke all on function public.omr_requeue_dead_remote_asset_cleanup_v1(text,text,integer,text,text) from public, anon, authenticated;
grant execute on function public.omr_requeue_dead_remote_asset_cleanup_v1(text,text,integer,text,text) to service_role;
revoke all on function public.omr_claim_remote_asset_cleanup_v1(text,integer,integer)
    from public, anon, authenticated;
grant execute on function public.omr_claim_remote_asset_cleanup_v1(text,integer,integer)
    to service_role;

commit;
