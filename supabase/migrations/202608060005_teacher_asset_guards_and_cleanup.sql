begin;

-- Storage deletion is an external side effect. Keep the immutable bucket/path
-- in a service-only outbox before canonical metadata can be replaced or
-- cascaded away, then let a bounded worker claim it with a renewable lease.
create table if not exists public.omr_remote_asset_cleanup_queue (
    id bigint generated always as identity primary key,
    organization_id text not null,
    exam_id text,
    asset_kind text,
    source_type text not null check (source_type in ('upload_intent', 'remote_asset')),
    source_id text not null,
    storage_bucket text not null check (storage_bucket = 'omr-private-assets'),
    object_path text not null,
    byte_size bigint not null default 52428800
        check (byte_size > 0 and byte_size <= 52428800),
    reason text not null check (reason in ('expired_upload', 'exam_deleted', 'asset_replaced')),
    status text not null default 'pending'
        check (status in ('pending', 'leased', 'done', 'dead')),
    attempts integer not null default 0 check (attempts between 0 and 10),
    available_at timestamptz not null default now(),
    lease_owner text,
    lease_until timestamptz,
    last_error text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    completed_at timestamptz,
    constraint omr_remote_asset_cleanup_path_check check (
        object_path like ('organizations/' || organization_id || '/%')
        and position('..' in object_path) = 0
        and position(chr(92) in object_path) = 0
    ),
    constraint omr_remote_asset_cleanup_lease_check check (
        (status = 'leased' and lease_owner is not null and lease_until is not null)
        or (status <> 'leased' and lease_owner is null and lease_until is null)
    ),
    constraint omr_remote_asset_cleanup_object_uidx unique (storage_bucket, object_path)
);

create index if not exists omr_remote_asset_cleanup_claim_idx
    on public.omr_remote_asset_cleanup_queue (status, available_at, lease_until, id)
    where status in ('pending', 'leased');

alter table public.omr_remote_asset_cleanup_queue enable row level security;
alter table public.omr_remote_asset_cleanup_queue force row level security;
revoke all on table public.omr_remote_asset_cleanup_queue from public, anon, authenticated;
grant select, insert, update, delete on table public.omr_remote_asset_cleanup_queue to service_role;
grant usage, select on sequence public.omr_remote_asset_cleanup_queue_id_seq to service_role;

create function public.omr_enqueue_remote_asset_cleanup_v1(
    p_organization_id text,
    p_exam_id text,
    p_asset_kind text,
    p_source_type text,
    p_source_id text,
    p_storage_bucket text,
    p_object_path text,
    p_reason text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_byte_size bigint;
begin
    select asset.byte_size into v_byte_size
      from public.omr_remote_assets asset
     where p_source_type = 'remote_asset'
       and asset.id = p_source_id
       and asset.organization_id = p_organization_id
       and asset.storage_bucket = p_storage_bucket
       and asset.object_path = p_object_path;
    if not found then
        select intent.byte_size into v_byte_size
          from public.omr_remote_asset_upload_intents intent
         where intent.id = p_source_id
           and intent.organization_id = p_organization_id
           and intent.storage_bucket = p_storage_bucket
           and intent.object_path = p_object_path;
    end if;
    if v_byte_size is null or v_byte_size not between 1 and 52428800 then
        raise exception 'cleanup asset byte size unavailable';
    end if;

    insert into public.omr_remote_asset_cleanup_queue (
        organization_id, exam_id, asset_kind, source_type, source_id,
        storage_bucket, object_path, byte_size, reason
    ) values (
        p_organization_id, p_exam_id, p_asset_kind, p_source_type, p_source_id,
        p_storage_bucket, p_object_path, v_byte_size, p_reason
    )
    on conflict (storage_bucket, object_path) do update set
        byte_size = excluded.byte_size;
end;
$$;

revoke all on function public.omr_enqueue_remote_asset_cleanup_v1(text, text, text, text, text, text, text, text)
    from public, anon, authenticated, service_role;

create function public.omr_enqueue_exam_asset_cleanup_v1(
    p_organization_id text,
    p_exam_id text,
    p_keep_asset_ids text[],
    p_reason text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_asset record;
    v_intent record;
begin
    for v_asset in
        select asset.*
          from public.omr_remote_assets asset
         where asset.organization_id = p_organization_id
           and asset.exam_id = p_exam_id
           and not (asset.id = any(coalesce(p_keep_asset_ids, '{}'::text[])))
         for update
    loop
        perform public.omr_enqueue_remote_asset_cleanup_v1(
            v_asset.organization_id, v_asset.exam_id, v_asset.kind,
            'remote_asset', v_asset.id, v_asset.storage_bucket,
            v_asset.object_path, p_reason
        );
    end loop;

    for v_intent in
        select intent.*
          from public.omr_remote_asset_upload_intents intent
         where intent.organization_id = p_organization_id
           and intent.exam_id = p_exam_id
           and intent.status in ('pending', 'uploaded', 'finalized')
           and not (intent.id = any(coalesce(p_keep_asset_ids, '{}'::text[])))
         for update
    loop
        perform public.omr_enqueue_remote_asset_cleanup_v1(
            v_intent.organization_id, v_intent.exam_id, v_intent.kind,
            'upload_intent', v_intent.id, v_intent.storage_bucket,
            v_intent.object_path, p_reason
        );
    end loop;

    delete from public.omr_remote_assets asset
     where asset.organization_id = p_organization_id
       and asset.exam_id = p_exam_id
       and not (asset.id = any(coalesce(p_keep_asset_ids, '{}'::text[])));

    update public.omr_remote_asset_upload_intents intent
       set status = 'expired', updated_at = now()
     where intent.organization_id = p_organization_id
       and intent.exam_id = p_exam_id
       and intent.status in ('pending', 'uploaded', 'finalized')
       and not (intent.id = any(coalesce(p_keep_asset_ids, '{}'::text[])));
end;
$$;

revoke all on function public.omr_enqueue_exam_asset_cleanup_v1(text, text, text[], text)
    from public, anon, authenticated, service_role;

create function public.omr_remote_assets_enqueue_cleanup_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    perform public.omr_enqueue_remote_asset_cleanup_v1(
        old.organization_id, old.exam_id, old.kind, 'remote_asset', old.id,
        old.storage_bucket, old.object_path,
        case when pg_catalog.pg_trigger_depth() > 1 then 'exam_deleted' else 'asset_replaced' end
    );
    return old;
end;
$$;

revoke all on function public.omr_remote_assets_enqueue_cleanup_v1()
    from public, anon, authenticated, service_role;
drop trigger if exists omr_remote_assets_enqueue_cleanup on public.omr_remote_assets;
create trigger omr_remote_assets_enqueue_cleanup
    before delete on public.omr_remote_assets
    for each row execute function public.omr_remote_assets_enqueue_cleanup_v1();

create function public.omr_exams_enqueue_asset_cleanup_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_keep_ids text[] := '{}'::text[];
begin
    if tg_op = 'UPDATE' then
        select coalesce(pg_catalog.array_agg(ref ->> 'key'), '{}'::text[])
          into v_keep_ids
          from (
              values (new.payload -> 'pdfDataRef'), (new.payload -> 'answerKeyPdfRef')
          ) refs(ref)
         where pg_catalog.jsonb_typeof(ref) = 'object'
           and ref ->> 'store' = 'remote'
           and nullif(ref ->> 'key', '') is not null;

        perform public.omr_enqueue_exam_asset_cleanup_v1(
            old.organization_id, old.id, v_keep_ids, 'asset_replaced'
        );
        return new;
    end if;

    perform public.omr_enqueue_exam_asset_cleanup_v1(
        old.organization_id, old.id, '{}'::text[], 'exam_deleted'
    );
    return old;
end;
$$;

revoke all on function public.omr_exams_enqueue_asset_cleanup_v1()
    from public, anon, authenticated, service_role;
drop trigger if exists omr_exams_enqueue_asset_cleanup on public.omr_exams;
create trigger omr_exams_enqueue_asset_cleanup
    before update of payload or delete on public.omr_exams
    for each row execute function public.omr_exams_enqueue_asset_cleanup_v1();

-- Prepare is the resource-allocation boundary, so authorization and quota
-- reservation must be checked here as well as in the Server Action. A single
-- advisory transaction lock makes the count/byte limits race-safe.
create or replace function public.omr_prepare_teacher_asset_upload_v1(
    p_upload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_upload public.omr_remote_asset_upload_intents%rowtype;
    v_stored public.omr_remote_asset_upload_intents%rowtype;
    v_plan text;
    v_period_start date;
    v_active_count integer;
    v_active_bytes bigint;
begin
    if pg_catalog.jsonb_typeof(p_upload) is distinct from 'object' then
        raise exception 'invalid teacher upload intent';
    end if;
    select * into v_upload
      from pg_catalog.jsonb_populate_record(null::public.omr_remote_asset_upload_intents, p_upload);

    if nullif(pg_catalog.btrim(v_upload.id), '') is null
       or nullif(pg_catalog.btrim(v_upload.organization_id), '') is null
       or nullif(pg_catalog.btrim(v_upload.exam_id), '') is null
       or nullif(pg_catalog.btrim(v_upload.kind), '') is null
       or nullif(pg_catalog.btrim(v_upload.created_by_user_id), '') is null
       or nullif(pg_catalog.btrim(v_upload.idempotency_key), '') is null
       or nullif(pg_catalog.btrim(v_upload.object_path), '') is null
       or v_upload.expires_at is null then
        raise exception 'invalid teacher upload intent';
    end if;

    if not exists (
        select 1
          from public.omr_organization_members member
         where member.organization_id = v_upload.organization_id
           and member.user_id = v_upload.created_by_user_id
           and member.status = 'active'
           and member.role in ('owner', 'admin', 'teacher', 'assistant')
    ) then
        raise exception 'teacher upload scope denied';
    end if;

    select organization.plan into v_plan
      from public.omr_organizations organization
     where organization.id = v_upload.organization_id;
    if v_plan is null then
        raise exception 'teacher upload scope denied';
    end if;
    if exists (
        select 1 from public.omr_exams exam
         where exam.id = v_upload.exam_id
           and exam.organization_id is distinct from v_upload.organization_id
    ) then
        raise exception 'teacher upload scope denied';
    end if;
    if not exists (select 1 from public.omr_exams exam where exam.id = v_upload.exam_id)
       and v_plan = 'free' then
        v_period_start := pg_catalog.date_trunc(
            'month', pg_catalog.timezone('Asia/Seoul', now())
        )::date;
        if not exists (
            select 1
              from public.omr_plan_usage_reservations reservation
             where reservation.organization_id = v_upload.organization_id
               and reservation.metric = 'exams'
               and reservation.period_start = v_period_start
               and reservation.resource_key = 'exam:' || v_upload.exam_id
               and reservation.amount = 1
        ) then
            raise exception 'teacher upload exam reservation required';
        end if;
    end if;

    -- Acquire the actor/org lock before the narrower exam/kind lock everywhere,
    -- so aggregate limits cannot be raced or deadlocked by parallel exams.
    perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
            v_upload.organization_id || chr(31) || v_upload.created_by_user_id,
            604005
        )
    );
    perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
            v_upload.organization_id || chr(31) || v_upload.created_by_user_id
            || chr(31) || v_upload.exam_id || chr(31) || v_upload.kind,
            604005
        )
    );

    select * into v_stored
      from public.omr_remote_asset_upload_intents intent
     where intent.organization_id = v_upload.organization_id
       and intent.created_by_user_id = v_upload.created_by_user_id
       and intent.idempotency_key = v_upload.idempotency_key
     for update;
    if found then
        if v_stored.id is distinct from v_upload.id
           or v_stored.exam_id is distinct from v_upload.exam_id
           or v_stored.kind is distinct from v_upload.kind
           or v_stored.object_path is distinct from v_upload.object_path
           or v_stored.mime_type is distinct from v_upload.mime_type
           or v_stored.byte_size is distinct from v_upload.byte_size
           or v_stored.sha256_hex is distinct from v_upload.sha256_hex
           or v_stored.original_name is distinct from v_upload.original_name then
            raise exception 'upload idempotency key belongs to another request';
        end if;
        if v_stored.status = 'expired' or v_stored.expires_at <= now() then
            raise exception 'teacher upload intent expired; use a fresh idempotency key';
        end if;
        return pg_catalog.to_jsonb(v_stored);
    end if;

    update public.omr_remote_asset_upload_intents intent
       set status = 'expired', updated_at = now()
     where intent.organization_id = v_upload.organization_id
       and intent.created_by_user_id = v_upload.created_by_user_id
       and intent.exam_id = v_upload.exam_id
       and intent.kind = v_upload.kind
       and intent.status in ('pending', 'uploaded')
       and intent.expires_at <= now();

    if (select count(*) from public.omr_remote_asset_upload_intents intent
         where intent.organization_id = v_upload.organization_id
           and intent.created_by_user_id = v_upload.created_by_user_id
           and intent.created_at >= now() - interval '1 minute') >= 12 then
        raise exception 'teacher upload prepare rate exceeded';
    end if;

    select count(*)::integer, coalesce(sum(intent.byte_size), 0)::bigint
      into v_active_count, v_active_bytes
      from public.omr_remote_asset_upload_intents intent
     where intent.organization_id = v_upload.organization_id
       and intent.created_by_user_id = v_upload.created_by_user_id
       and intent.status in ('pending', 'uploaded')
       and intent.expires_at > now();
    if v_active_count >= 8 or v_active_bytes + v_upload.byte_size > 209715200 then
        raise exception 'teacher upload active intent limit exceeded';
    end if;

    select count(*)::integer, coalesce(sum(intent.byte_size), 0)::bigint
      into v_active_count, v_active_bytes
      from public.omr_remote_asset_upload_intents intent
     where intent.organization_id = v_upload.organization_id
       and intent.created_by_user_id = v_upload.created_by_user_id
       and intent.exam_id = v_upload.exam_id
       and intent.kind = v_upload.kind
       and intent.status in ('pending', 'uploaded')
       and intent.expires_at > now();
    if v_active_count >= 3 or v_active_bytes + v_upload.byte_size > 104857600 then
        raise exception 'teacher upload active intent limit exceeded';
    end if;

    insert into public.omr_remote_asset_upload_intents (
        id, organization_id, exam_id, kind, created_by_user_id,
        idempotency_key, storage_bucket, object_path, mime_type, byte_size,
        sha256_hex, original_name, status, expires_at, created_at, updated_at
    ) values (
        v_upload.id, v_upload.organization_id, v_upload.exam_id, v_upload.kind,
        v_upload.created_by_user_id, v_upload.idempotency_key,
        coalesce(v_upload.storage_bucket, 'omr-private-assets'),
        v_upload.object_path, v_upload.mime_type, v_upload.byte_size,
        v_upload.sha256_hex, v_upload.original_name, 'pending',
        v_upload.expires_at, now(), now()
    ) returning * into v_stored;
    return pg_catalog.to_jsonb(v_stored);
end;
$$;

revoke all on function public.omr_prepare_teacher_asset_upload_v1(jsonb) from public, anon, authenticated;
grant execute on function public.omr_prepare_teacher_asset_upload_v1(jsonb) to service_role;

create function public.omr_claim_remote_asset_cleanup_v1(
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

    with dead_candidates as materialized (
        select queue.id
          from public.omr_remote_asset_cleanup_queue queue
         where queue.status = 'leased'
           and queue.attempts >= 10
           and queue.lease_until <= now()
         order by queue.lease_until, queue.id
         for update skip locked
         limit p_limit
    )
    update public.omr_remote_asset_cleanup_queue queue
       set status = 'dead', lease_owner = null, lease_until = null,
           updated_at = now()
      from dead_candidates candidate
     where queue.id = candidate.id;

    with expired_candidates as materialized (
        select intent.id
          from public.omr_remote_asset_upload_intents intent
         where intent.status in ('pending', 'uploaded')
           and intent.expires_at <= now()
         order by intent.expires_at, intent.id
         for update skip locked
         limit p_limit
    ), queued as (
        insert into public.omr_remote_asset_cleanup_queue (
            organization_id, exam_id, asset_kind, source_type, source_id,
            storage_bucket, object_path, byte_size, reason
        )
        select intent.organization_id, intent.exam_id, intent.kind,
               'upload_intent', intent.id, intent.storage_bucket,
               intent.object_path, intent.byte_size, 'expired_upload'
          from public.omr_remote_asset_upload_intents intent
          join expired_candidates candidate on candidate.id = intent.id
        on conflict (storage_bucket, object_path) do nothing
        returning id
    )
    update public.omr_remote_asset_upload_intents intent
       set status = 'expired', updated_at = now()
      from expired_candidates candidate
     where intent.id = candidate.id
       and (select count(*) from queued) >= 0;

    with candidates as (
        select queue.id
          from public.omr_remote_asset_cleanup_queue queue
         where queue.attempts < 10
           and queue.available_at <= now()
           and (queue.status = 'pending' or (
               queue.status = 'leased' and queue.lease_until <= now()
           ))
         order by queue.available_at, queue.id
         for update skip locked
         limit p_limit
    ), claimed as (
        update public.omr_remote_asset_cleanup_queue queue
           set status = 'leased', attempts = queue.attempts + 1,
               lease_owner = pg_catalog.btrim(p_worker_id),
               lease_until = now() + pg_catalog.make_interval(secs => p_lease_seconds),
               updated_at = now()
          from candidates
         where queue.id = candidates.id
        returning queue.*
    )
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(claimed) order by claimed.id), '[]'::jsonb)
      into v_claimed from claimed;
    return v_claimed;
end;
$$;

create function public.omr_ack_remote_asset_cleanup_v1(
    p_cleanup_id text,
    p_worker_id text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_queue public.omr_remote_asset_cleanup_queue%rowtype;
begin
    select * into v_queue
      from public.omr_remote_asset_cleanup_queue queue
     where queue.id::text = p_cleanup_id
       and queue.status = 'leased'
       and queue.lease_owner = pg_catalog.btrim(p_worker_id)
     for update;
    if not found then return false; end if;

    delete from public.omr_remote_assets asset
     where asset.storage_bucket = v_queue.storage_bucket
       and asset.object_path = v_queue.object_path;
    delete from public.omr_remote_asset_upload_intents intent
     where intent.storage_bucket = v_queue.storage_bucket
       and intent.object_path = v_queue.object_path
       and intent.status = 'expired';
    update public.omr_remote_asset_cleanup_queue queue
       set status = 'done', lease_owner = null, lease_until = null,
           completed_at = now(), updated_at = now(), last_error = null
     where queue.id = v_queue.id;
    return true;
end;
$$;

create function public.omr_fail_remote_asset_cleanup_v1(
    p_cleanup_id text,
    p_worker_id text,
    p_error text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_attempts integer;
begin
    select queue.attempts into v_attempts
      from public.omr_remote_asset_cleanup_queue queue
     where queue.id::text = p_cleanup_id
       and queue.status = 'leased'
       and queue.lease_owner = pg_catalog.btrim(p_worker_id)
     for update;
    if not found then return false; end if;

    update public.omr_remote_asset_cleanup_queue queue
       set status = case when v_attempts >= 10 then 'dead' else 'pending' end,
           available_at = now() + least(interval '1 hour', interval '5 seconds' * power(2, greatest(v_attempts - 1, 0))),
           lease_owner = null, lease_until = null,
           last_error = left(coalesce(p_error, 'cleanup failed'), 500),
           updated_at = now()
     where queue.id::text = p_cleanup_id;
    return true;
end;
$$;

revoke all on function public.omr_claim_remote_asset_cleanup_v1(text, integer, integer) from public, anon, authenticated;
grant execute on function public.omr_claim_remote_asset_cleanup_v1(text, integer, integer) to service_role;
revoke all on function public.omr_ack_remote_asset_cleanup_v1(text, text) from public, anon, authenticated;
grant execute on function public.omr_ack_remote_asset_cleanup_v1(text, text) to service_role;
revoke all on function public.omr_fail_remote_asset_cleanup_v1(text, text, text) from public, anon, authenticated;
grant execute on function public.omr_fail_remote_asset_cleanup_v1(text, text, text) to service_role;

-- Keep deletion explicit for auditability; the exam trigger also covers any
-- future service-only deletion path that bypasses this RPC.
create or replace function public.omr_delete_exam_v1(
    p_organization_id text,
    p_exam_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_exists boolean;
begin
    if nullif(pg_catalog.btrim(p_organization_id), '') is null
       or nullif(pg_catalog.btrim(p_exam_id), '') is null then
        raise exception 'invalid exam delete request';
    end if;
    select exists (
        select 1 from public.omr_exams exam
         where exam.id = p_exam_id and exam.organization_id = p_organization_id
         for update
    ) into v_exists;
    if not v_exists then return pg_catalog.jsonb_build_object('deleted', false); end if;

    perform public.omr_enqueue_exam_asset_cleanup_v1(
        p_organization_id, p_exam_id, '{}'::text[], 'exam_deleted'
    );
    delete from public.omr_question_results result
    using public.omr_attempts attempt
     where result.attempt_id = attempt.id
       and attempt.exam_id = p_exam_id and attempt.organization_id = p_organization_id;
    delete from public.omr_attempts attempt
     where attempt.exam_id = p_exam_id and attempt.organization_id = p_organization_id;
    delete from public.omr_exam_questions question
     where question.exam_id = p_exam_id and question.organization_id = p_organization_id;
    delete from public.omr_exams exam
     where exam.id = p_exam_id and exam.organization_id = p_organization_id;
    return pg_catalog.jsonb_build_object('deleted', true);
end;
$$;

revoke all on function public.omr_delete_exam_v1(text, text) from public, anon, authenticated;
grant execute on function public.omr_delete_exam_v1(text, text) to service_role;

alter function public.omr_service_readiness_v1()
    rename to omr_service_readiness_v5_snapshot;
revoke all on function public.omr_service_readiness_v5_snapshot() from public, anon, authenticated;
grant execute on function public.omr_service_readiness_v5_snapshot() to service_role;

create function public.omr_service_readiness_v1()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_previous jsonb;
    v_canonical_tables_force_rls boolean;
    v_server_gateway_capabilities_ready boolean;
    v_cleanup_ready boolean;
    v_ready boolean;
begin
    v_previous := public.omr_service_readiness_v5_snapshot();

    with expected(table_name) as (values
        ('omr_organizations'), ('omr_plan_usage'), ('omr_plan_usage_reservations'),
        ('omr_user_profiles'), ('omr_organization_members'), ('omr_teacher_profiles'),
        ('omr_student_profiles'), ('omr_student_start_credentials'), ('omr_classes'),
        ('omr_roster_invites'), ('omr_class_teachers'), ('omr_class_students'),
        ('omr_materials'), ('omr_exams'), ('omr_exam_questions'), ('omr_exam_materials'),
        ('omr_assignments'), ('omr_assignment_targets'), ('omr_attempts'),
        ('omr_question_results'), ('omr_assignment_submissions'), ('omr_attempt_feedback'),
        ('omr_kakao_candidate_reviews'), ('omr_kakao_dispatch_logs'), ('omr_comments'),
        ('omr_audit_logs'), ('omr_remote_assets'), ('omr_remote_asset_upload_intents'),
        ('omr_remote_asset_cleanup_queue')
    ), actual(table_name, rls, force_rls) as (
        select relation.relname::text, relation.relrowsecurity, relation.relforcerowsecurity
          from pg_catalog.pg_class relation
          join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
         where namespace.nspname = 'public' and relation.relkind in ('r', 'p')
           and relation.relname like 'omr\_%' escape '\'
    )
    select not exists (select table_name from expected except select table_name from actual)
       and not exists (select table_name from actual except select table_name from expected)
       and not exists (select 1 from actual where not rls or not force_rls)
      into v_canonical_tables_force_rls;

    with expected(name, args) as (values
        ('omr_submit_attempt_v1', 'text, jsonb, jsonb'),
        ('omr_submit_session_attempt_v1', 'jsonb, jsonb'),
        ('omr_save_exam_v1', 'jsonb, jsonb, jsonb, text'),
        ('omr_delete_exam_v1', 'text, text'),
        ('omr_save_roster_v1', 'text, jsonb, jsonb, jsonb, jsonb'),
        ('omr_attach_attempt_handwriting_v1', 'text, text, jsonb'),
        ('omr_save_feedback_v1', 'text, jsonb'),
        ('omr_return_feedback_v1', 'text, text, timestamp with time zone'),
        ('omr_mark_feedback_opened_v2', 'text, text, text, timestamp with time zone'),
        ('omr_save_remote_asset_metadata_v1', 'jsonb'),
        ('omr_claim_guest_attempts_v1', 'text, text, text, text, text, text, text[]'),
        ('omr_prepare_teacher_asset_upload_v1', 'jsonb'),
        ('omr_finalize_teacher_asset_upload_v1', 'text, text, text, jsonb'),
        ('omr_claim_remote_asset_cleanup_v1', 'text, integer, integer'),
        ('omr_ack_remote_asset_cleanup_v1', 'text, text'),
        ('omr_fail_remote_asset_cleanup_v1', 'text, text, text')
    ), actual(name, args) as (
        select routine.proname::text, pg_catalog.oidvectortypes(routine.proargtypes)
          from pg_catalog.pg_proc routine
          join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
         where namespace.nspname = 'public' and routine.prokind = 'f'
           and routine.proname in (select expected.name from expected)
    )
    select not exists (select name, args from expected except select name, args from actual)
       and not exists (select name, args from actual except select name, args from expected)
      into v_server_gateway_capabilities_ready;

    v_cleanup_ready :=
        pg_catalog.to_regclass('public.omr_remote_asset_cleanup_queue') is not null
        and pg_catalog.to_regclass('public.omr_remote_asset_cleanup_claim_idx') is not null
        and pg_catalog.to_regprocedure('public.omr_claim_remote_asset_cleanup_v1(text,integer,integer)') is not null
        and pg_catalog.to_regprocedure('public.omr_ack_remote_asset_cleanup_v1(text,text)') is not null
        and pg_catalog.to_regprocedure('public.omr_fail_remote_asset_cleanup_v1(text,text,text)') is not null
        and pg_catalog.has_function_privilege('service_role', 'public.omr_claim_remote_asset_cleanup_v1(text,integer,integer)', 'EXECUTE')
        and pg_catalog.has_function_privilege('service_role', 'public.omr_ack_remote_asset_cleanup_v1(text,text)', 'EXECUTE')
        and pg_catalog.has_function_privilege('service_role', 'public.omr_fail_remote_asset_cleanup_v1(text,text,text)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('anon', 'public.omr_claim_remote_asset_cleanup_v1(text,integer,integer)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('authenticated', 'public.omr_claim_remote_asset_cleanup_v1(text,integer,integer)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('anon', 'public.omr_ack_remote_asset_cleanup_v1(text,text)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('authenticated', 'public.omr_ack_remote_asset_cleanup_v1(text,text)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('anon', 'public.omr_fail_remote_asset_cleanup_v1(text,text,text)', 'EXECUTE')
        and not pg_catalog.has_function_privilege('authenticated', 'public.omr_fail_remote_asset_cleanup_v1(text,text,text)', 'EXECUTE');

    v_ready :=
        v_previous ->> 'browserSchemaPrivilegesDenied' = 'true'
        and v_previous ->> 'anonTablePrivilegesDenied' = 'true'
        and v_previous ->> 'authenticatedCanonicalPrivilegesDenied' = 'true'
        and v_previous ->> 'browserSequencePrivilegesDenied' = 'true'
        and v_previous ->> 'browserFunctionPrivilegesDenied' = 'true'
        and v_previous ->> 'alphaPoliciesAbsent' = 'true'
        and v_canonical_tables_force_rls
        and v_previous ->> 'canonicalPoliciesAbsent' = 'true'
        and v_previous ->> 'organizationBackfillReady' = 'true'
        and v_previous ->> 'serviceRolePrivilegesReady' = 'true'
        and v_previous ->> 'scopedRpcPrivilegesReady' = 'true'
        and v_previous ->> 'hostedStorageBoundaryReady' = 'true'
        and v_server_gateway_capabilities_ready
        and v_previous ->> 'queryPathIndexesReady' = 'true'
        and v_previous ->> 'legacyBroadRpcsRemoved' = 'true'
        and v_previous ->> 'directUploadIntentLifecycleReady' = 'true'
        and v_cleanup_ready;

    return (v_previous - 'version' - 'canonicalTablesForceRls'
        - 'serverGatewayCapabilitiesReady' - 'ready')
        || pg_catalog.jsonb_build_object(
            'version', '202608060005',
            'canonicalTablesForceRls', v_canonical_tables_force_rls,
            'serverGatewayCapabilitiesReady', v_server_gateway_capabilities_ready,
            'teacherUploadCleanupQueueReady', v_cleanup_ready,
            'ready', v_ready
        );
end;
$$;

revoke all on function public.omr_service_readiness_v1() from public, anon, authenticated;
grant execute on function public.omr_service_readiness_v1() to service_role;

commit;
