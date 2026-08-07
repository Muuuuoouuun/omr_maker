begin;

alter table public.omr_plan_usage_reservations
    add column if not exists expires_at timestamptz;

-- Existing saved exams are durable usage. Only provisional/orphan exam keys
-- receive a lease. AI/student rows remain NULL so this migration cannot
-- silently refund completed AI work or disturb the roster ledger.
update public.omr_plan_usage_reservations reservation
   set expires_at = case
       when exists (
           select 1 from public.omr_exams exam
            where exam.organization_id = reservation.organization_id
              and exam.id = pg_catalog.substr(reservation.resource_key, 6)
       ) then null
       else now() + interval '2 hours'
   end
 where reservation.metric = 'exams'
   and reservation.resource_key like 'exam:%';

create index if not exists omr_plan_usage_exam_reservation_expiry_idx
    on public.omr_plan_usage_reservations
        (organization_id, period_start, expires_at, resource_key)
    where metric = 'exams' and expires_at is not null;

create index if not exists omr_remote_asset_upload_intents_cleanup_eligibility_idx
    on public.omr_remote_asset_upload_intents (expires_at, id)
    where status in ('pending', 'uploaded', 'finalized', 'expired');

create or replace function public.omr_reserve_plan_usage(
    p_organization_id text,
    p_metric text,
    p_period_start date,
    p_resource_key text,
    p_amount integer,
    p_observed_used integer,
    p_limit integer
)
returns table(allowed boolean, used integer, idempotent boolean)
language plpgsql
security invoker
set search_path = ''
as $$
declare
    v_used integer;
    v_released integer := 0;
    v_actual_exam_floor integer := 0;
    v_existing boolean := false;
begin
    if p_organization_id is null or pg_catalog.btrim(p_organization_id) = ''
        or p_resource_key is null or pg_catalog.btrim(p_resource_key) = ''
        or p_metric not in ('exams', 'aiRecognition')
        or p_amount is null or p_amount <= 0
        or p_observed_used is null or p_observed_used < 0
        or p_limit is null or p_limit < 0 then
        raise exception 'invalid plan usage reservation';
    end if;

    insert into public.omr_plan_usage (organization_id, metric, period_start, used, updated_at)
    values (p_organization_id, p_metric, p_period_start, p_observed_used, now())
    on conflict (organization_id, metric, period_start)
    do update set used = greatest(public.omr_plan_usage.used, excluded.used),
                  updated_at = now();

    perform usage.used
      from public.omr_plan_usage usage
     where usage.organization_id = p_organization_id
       and usage.metric = p_metric
       and usage.period_start = p_period_start
     for update;

    perform 1
      from public.omr_plan_usage_reservations reservation
     where reservation.organization_id = p_organization_id
       and reservation.metric = p_metric
       and reservation.period_start = p_period_start
       and reservation.resource_key = p_resource_key
     for update;
    v_existing := found;

    if p_metric = 'exams' then
        with expired_candidates as materialized (
            select reservation.organization_id, reservation.metric,
                   reservation.period_start, reservation.resource_key
              from public.omr_plan_usage_reservations reservation
             where reservation.organization_id = p_organization_id
               and reservation.metric = 'exams'
               and reservation.period_start = p_period_start
               and reservation.resource_key <> p_resource_key
               and reservation.expires_at <= now()
               and not exists (
                   select 1 from public.omr_exams exam
                    where exam.organization_id = reservation.organization_id
                      and exam.id = pg_catalog.substr(reservation.resource_key, 6)
               )
             order by reservation.expires_at, reservation.resource_key
             for update skip locked
             limit 50
        ), deleted as (
            delete from public.omr_plan_usage_reservations reservation
             using expired_candidates candidate
             where reservation.organization_id = candidate.organization_id
               and reservation.metric = candidate.metric
               and reservation.period_start = candidate.period_start
               and reservation.resource_key = candidate.resource_key
            returning reservation.amount
        )
        select coalesce(sum(deleted.amount), 0)::integer
          into v_released from deleted;

        select count(*)::integer into v_actual_exam_floor
          from public.omr_exams exam
         where exam.organization_id = p_organization_id
           and exam.created_at >= p_period_start::timestamp at time zone 'Asia/Seoul'
           and exam.created_at < (p_period_start + interval '1 month')::timestamp at time zone 'Asia/Seoul';

        update public.omr_plan_usage usage
           set used = greatest(v_actual_exam_floor, usage.used - v_released),
               updated_at = now()
         where usage.organization_id = p_organization_id
           and usage.metric = 'exams'
           and usage.period_start = p_period_start;
    end if;

    select usage.used into v_used
      from public.omr_plan_usage usage
     where usage.organization_id = p_organization_id
       and usage.metric = p_metric
       and usage.period_start = p_period_start;

    if v_existing then
        if p_metric = 'exams' then
            update public.omr_plan_usage_reservations reservation
               set expires_at = case when exists (
                   select 1 from public.omr_exams exam
                    where exam.organization_id = p_organization_id
                      and exam.id = pg_catalog.substr(p_resource_key, 6)
               ) then null else now() + interval '2 hours' end
             where reservation.organization_id = p_organization_id
               and reservation.metric = p_metric
               and reservation.period_start = p_period_start
               and reservation.resource_key = p_resource_key;
        end if;
        return query select true, v_used, true;
        return;
    end if;

    if v_used + p_amount > p_limit then
        return query select false, v_used, false;
        return;
    end if;

    insert into public.omr_plan_usage_reservations (
        organization_id, metric, period_start, resource_key, amount, expires_at
    ) values (
        p_organization_id, p_metric, p_period_start, p_resource_key, p_amount,
        case when p_metric = 'exams' then now() + interval '2 hours' else null end
    );

    update public.omr_plan_usage usage
       set used = usage.used + p_amount, updated_at = now()
     where usage.organization_id = p_organization_id
       and usage.metric = p_metric
       and usage.period_start = p_period_start
    returning usage.used into v_used;

    return query select true, v_used, false;
end;
$$;

revoke all on function public.omr_reserve_plan_usage(text, text, date, text, integer, integer, integer)
    from public, anon, authenticated;
grant execute on function public.omr_reserve_plan_usage(text, text, date, text, integer, integer, integer)
    to service_role;

-- Any canonical insert/update makes a matching provisional reservation
-- durable in the same transaction. Explicit release remains the only way to
-- remove a durable reservation deliberately.
create or replace function public.omr_mark_exam_reservation_durable_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    update public.omr_plan_usage_reservations reservation
       set expires_at = null
     where reservation.organization_id = new.organization_id
       and reservation.metric = 'exams'
       and reservation.resource_key = 'exam:' || new.id;
    return new;
end;
$$;

revoke all on function public.omr_mark_exam_reservation_durable_v1()
    from public, anon, authenticated, service_role;
drop trigger if exists omr_exams_mark_reservation_durable on public.omr_exams;
create trigger omr_exams_mark_reservation_durable
    after insert or update on public.omr_exams
    for each row execute function public.omr_mark_exam_reservation_durable_v1();

-- Preserve paid-plan behavior: Pro/Academy do not create quota reservations.
-- Free provisional exams require a currently active lease; a canonical exam
-- row always authorizes its own subsequent asset replacement.
alter function public.omr_prepare_teacher_asset_upload_v1(jsonb)
    rename to omr_prepare_teacher_asset_upload_v6_snapshot;
revoke all on function public.omr_prepare_teacher_asset_upload_v6_snapshot(jsonb)
    from public, anon, authenticated, service_role;

create function public.omr_prepare_teacher_asset_upload_v1(p_upload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_organization_id text;
    v_exam_id text;
    v_actor_user_id text;
    v_upload_id text;
    v_idempotency_key text;
    v_upload_byte_size bigint;
    v_plan text;
    v_actor_object_count integer;
    v_actor_byte_size bigint;
    v_organization_object_count integer;
    v_organization_byte_size bigint;
    v_global_object_count integer;
    v_global_byte_size bigint;
    v_active_count integer;
    v_active_bytes bigint;
    v_is_retry boolean;
begin
    if pg_catalog.jsonb_typeof(p_upload) is distinct from 'object' then
        raise exception 'invalid teacher upload intent';
    end if;
    v_organization_id := p_upload ->> 'organization_id';
    v_exam_id := p_upload ->> 'exam_id';
    v_actor_user_id := p_upload ->> 'created_by_user_id';
    v_upload_id := p_upload ->> 'id';
    v_idempotency_key := p_upload ->> 'idempotency_key';
    begin
        v_upload_byte_size := (p_upload ->> 'byte_size')::bigint;
    exception when others then
        raise exception 'invalid teacher upload intent';
    end;
    select organization.plan into v_plan
      from public.omr_organizations organization
     where organization.id = v_organization_id;

    if v_plan = 'free'
       and not exists (
           select 1 from public.omr_exams exam
            where exam.id = v_exam_id
              and exam.organization_id = v_organization_id
       )
       and not exists (
           select 1 from public.omr_plan_usage_reservations reservation
            where reservation.organization_id = v_organization_id
              and reservation.metric = 'exams'
              and reservation.period_start = pg_catalog.date_trunc(
                  'month', pg_catalog.timezone('Asia/Seoul', now())
              )::date
              and reservation.resource_key = 'exam:' || v_exam_id
              and reservation.amount = 1
              and reservation.expires_at > now()
       ) then
        raise exception 'teacher upload exam reservation required';
    end if;

    -- Serialize global, organization, then actor admission windows in one fixed
    -- order. The v5 snapshot later reacquires the actor lock and narrower
    -- exam/kind lock; advisory transaction locks are reentrant per transaction.
    perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('omr:teacher-upload-global', 604006)
    );
    perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(v_organization_id, 604006)
    );
    perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
            v_organization_id || chr(31) || v_actor_user_id, 604005
        )
    );

    select exists (
        select 1 from public.omr_remote_asset_upload_intents intent
         where intent.id = v_upload_id
           and intent.organization_id = v_organization_id
           and intent.created_by_user_id = v_actor_user_id
           and intent.idempotency_key = v_idempotency_key
    ) into v_is_retry;

    if not v_is_retry then
        select count(*)::integer, coalesce(sum(item.byte_size), 0)::bigint
          into v_actor_object_count, v_actor_byte_size
          from (
              select intent.id, intent.byte_size
                from public.omr_remote_asset_upload_intents intent
               where intent.organization_id = v_organization_id
                 and intent.created_by_user_id = v_actor_user_id
                 and intent.created_at >= now() - interval '24 hours'
              union
              select asset.id, asset.byte_size
                from public.omr_remote_assets asset
               where asset.organization_id = v_organization_id
                 and asset.created_by_user_id = v_actor_user_id
                 and asset.created_at >= now() - interval '24 hours'
          ) item;

        select count(*)::integer, coalesce(sum(item.byte_size), 0)::bigint
          into v_organization_object_count, v_organization_byte_size
          from (
              select intent.id, intent.byte_size
                from public.omr_remote_asset_upload_intents intent
               where intent.organization_id = v_organization_id
                 and intent.created_at >= now() - interval '24 hours'
              union
              select asset.id, asset.byte_size
                from public.omr_remote_assets asset
               where asset.organization_id = v_organization_id
                 and asset.created_at >= now() - interval '24 hours'
          ) item;

        select count(*)::integer, coalesce(sum(item.byte_size), 0)::bigint
          into v_global_object_count, v_global_byte_size
          from (
              select intent.id, intent.byte_size
                from public.omr_remote_asset_upload_intents intent
               where intent.created_at >= now() - interval '24 hours'
              union
              select asset.id, asset.byte_size
                from public.omr_remote_assets asset
               where asset.created_at >= now() - interval '24 hours'
          ) item;

        if v_actor_object_count >= 20
           or v_actor_byte_size + v_upload_byte_size > 1073741824
           or v_organization_object_count >= 100
           or v_organization_byte_size + v_upload_byte_size > 5368709120
           or v_global_object_count >= 100
           or v_global_byte_size + v_upload_byte_size > 5368709120 then
        raise exception 'teacher upload admission window exceeded';
        end if;

        select count(*)::integer, coalesce(sum(intent.byte_size), 0)::bigint
          into v_active_count, v_active_bytes
          from public.omr_remote_asset_upload_intents intent
         where intent.organization_id = v_organization_id
           and intent.created_by_user_id = v_actor_user_id
           and intent.expires_at > now()
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
           );
        if v_active_count >= 8 or v_active_bytes + v_upload_byte_size > 209715200 then
            raise exception 'teacher upload active intent limit exceeded';
        end if;
    end if;

    return public.omr_prepare_teacher_asset_upload_v6_snapshot(p_upload);
end;
$$;

revoke all on function public.omr_prepare_teacher_asset_upload_v1(jsonb)
    from public, anon, authenticated;
grant execute on function public.omr_prepare_teacher_asset_upload_v1(jsonb)
    to service_role;

create or replace function public.omr_authorize_teacher_asset_finalize_v1(
    p_organization_id text,
    p_created_by_user_id text,
    p_upload_id text,
    p_declaration jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_intent public.omr_remote_asset_upload_intents%rowtype;
    v_byte_size bigint;
begin
    if nullif(pg_catalog.btrim(p_organization_id), '') is null
       or nullif(pg_catalog.btrim(p_created_by_user_id), '') is null
       or nullif(pg_catalog.btrim(p_upload_id), '') is null
       or pg_catalog.jsonb_typeof(p_declaration) is distinct from 'object' then
        raise exception 'teacher upload scope denied';
    end if;
    begin
        v_byte_size := (p_declaration ->> 'byte_size')::bigint;
    exception when others then
        raise exception 'teacher upload scope denied';
    end;

    select intent.* into v_intent
      from public.omr_remote_asset_upload_intents intent
     where intent.id = pg_catalog.btrim(p_upload_id)
       and intent.organization_id = pg_catalog.btrim(p_organization_id)
       and intent.created_by_user_id = pg_catalog.btrim(p_created_by_user_id)
       and intent.exam_id = p_declaration ->> 'exam_id'
       and intent.kind = p_declaration ->> 'kind'
       and intent.storage_bucket = p_declaration ->> 'storage_bucket'
       and intent.object_path = p_declaration ->> 'object_path'
       and intent.mime_type = p_declaration ->> 'mime_type'
       and intent.byte_size = v_byte_size
       and intent.sha256_hex = p_declaration ->> 'sha256_hex'
       and (
           (intent.status in ('pending', 'uploaded') and intent.expires_at > now())
           or (
               intent.status = 'finalized'
               and exists (
                   select 1 from public.omr_remote_assets asset
                    where asset.id = intent.id
                      and asset.organization_id = intent.organization_id
                      and asset.exam_id = intent.exam_id
                      and asset.kind = intent.kind
                      and asset.storage_bucket = intent.storage_bucket
                      and asset.object_path = intent.object_path
                      and asset.mime_type = intent.mime_type
                      and asset.byte_size = intent.byte_size
                      and asset.sha256_hex = intent.sha256_hex
               )
               and not exists (
                   select 1 from public.omr_remote_asset_cleanup_queue queue
                    where queue.storage_bucket = intent.storage_bucket
                      and queue.object_path = intent.object_path
               )
           )
       )
       and exists (
           select 1 from public.omr_organization_members member
            where member.organization_id = intent.organization_id
              and member.user_id = intent.created_by_user_id
              and member.status = 'active'
              and member.role in ('owner', 'admin', 'teacher', 'assistant')
       )
     for update;
    if not found then
        raise exception 'teacher upload scope denied';
    end if;
    return pg_catalog.to_jsonb(v_intent);
end;
$$;

revoke all on function public.omr_authorize_teacher_asset_finalize_v1(text, text, text, jsonb)
    from public, anon, authenticated;
grant execute on function public.omr_authorize_teacher_asset_finalize_v1(text, text, text, jsonb)
    to service_role;

-- Extend the bounded sweep to finalized rows that never became a canonical
-- payload reference. Referenced canonical assets remain durable regardless of
-- the short upload-intent expiry timestamp.
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

    with dead_candidates as materialized (
        select queue.id from public.omr_remote_asset_cleanup_queue queue
         where queue.status = 'leased' and queue.attempts >= 10
           and queue.lease_until <= now()
         order by queue.lease_until, queue.id
         for update skip locked limit p_limit
    )
    update public.omr_remote_asset_cleanup_queue queue
       set status = 'dead', lease_owner = null, lease_until = null, updated_at = now()
      from dead_candidates candidate where queue.id = candidate.id;

    with expired_candidates as materialized (
        select intent.id
          from public.omr_remote_asset_upload_intents intent
         where intent.expires_at <= now()
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
         for update skip locked limit p_limit
    ), queued as (
        insert into public.omr_remote_asset_cleanup_queue (
            organization_id, exam_id, asset_kind, source_type, source_id,
            storage_bucket, object_path, reason
        )
        select intent.organization_id, intent.exam_id, intent.kind,
               case when asset.id is null then 'upload_intent' else 'remote_asset' end,
               intent.id, intent.storage_bucket, intent.object_path, 'expired_upload'
          from public.omr_remote_asset_upload_intents intent
          join expired_candidates candidate on candidate.id = intent.id
          left join public.omr_remote_assets asset on asset.id = intent.id
        on conflict (storage_bucket, object_path) do nothing
        returning id
    )
    update public.omr_remote_asset_upload_intents intent
       set status = 'expired', updated_at = now()
      from expired_candidates candidate
     where intent.id = candidate.id and (select count(*) from queued) >= 0;

    with candidates as (
        select queue.id from public.omr_remote_asset_cleanup_queue queue
         where queue.attempts < 10 and queue.available_at <= now()
           and (queue.status = 'pending' or (queue.status = 'leased' and queue.lease_until <= now()))
         order by queue.available_at, queue.id
         for update skip locked limit p_limit
    ), claimed as (
        update public.omr_remote_asset_cleanup_queue queue
           set status = 'leased', attempts = queue.attempts + 1,
               lease_owner = pg_catalog.btrim(p_worker_id),
               lease_until = now() + pg_catalog.make_interval(secs => p_lease_seconds),
               updated_at = now()
          from candidates where queue.id = candidates.id
        returning queue.*
    )
    select coalesce(
        pg_catalog.jsonb_agg(pg_catalog.to_jsonb(claimed) order by claimed.id), '[]'::jsonb
    ) into v_claimed from claimed;
    return v_claimed;
end;
$$;

revoke all on function public.omr_claim_remote_asset_cleanup_v1(text, integer, integer)
    from public, anon, authenticated;
grant execute on function public.omr_claim_remote_asset_cleanup_v1(text, integer, integer)
    to service_role;

-- A completed delete no longer needs a tombstone: removing the queue row makes
-- the immutable bucket/path key reusable if an object path is recreated later.
create or replace function public.omr_ack_remote_asset_cleanup_v1(
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
    delete from public.omr_remote_asset_cleanup_queue queue
     where queue.id = v_queue.id;
    return true;
end;
$$;

revoke all on function public.omr_ack_remote_asset_cleanup_v1(text, text)
    from public, anon, authenticated;
grant execute on function public.omr_ack_remote_asset_cleanup_v1(text, text)
    to service_role;

-- Canonical promotion and cleanup use the same exact intent-row lock. If save
-- wins, the sweep skips the row and observes the new canonical reference on a
-- later pass. If cleanup wins, save observes expired/queued state and fails
-- before the private v4 implementation can write the canonical payload.
alter function public.omr_save_exam_v1(jsonb, jsonb, jsonb, text)
    rename to omr_save_exam_v6_snapshot;
revoke all on function public.omr_save_exam_v6_snapshot(jsonb, jsonb, jsonb, text)
    from public, anon, authenticated, service_role;

create function public.omr_save_exam_v1(
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
begin
    if pg_catalog.jsonb_typeof(p_teacher_asset_intent_ids) = 'array'
       and not exists (
           select 1
             from pg_catalog.jsonb_array_elements(p_teacher_asset_intent_ids) item
            where pg_catalog.jsonb_typeof(item) is distinct from 'string'
       ) then
        -- Deterministic order also prevents two-asset saves from deadlocking.
        perform intent.id
          from public.omr_remote_asset_upload_intents intent
         where intent.id in (
             select value
               from pg_catalog.jsonb_array_elements_text(p_teacher_asset_intent_ids)
         )
         order by intent.id
         for update;

        if exists (
            select 1
              from pg_catalog.jsonb_array_elements_text(
                  p_teacher_asset_intent_ids
              ) supplied(value)
              join public.omr_remote_asset_upload_intents intent
                on intent.id = supplied.value
             where intent.status = 'expired'
                or exists (
                    select 1 from public.omr_remote_asset_cleanup_queue queue
                     where queue.storage_bucket = intent.storage_bucket
                       and queue.object_path = intent.object_path
                )
                or (
                    intent.expires_at <= now()
                    and (
                        intent.status in ('pending', 'uploaded')
                        or (
                            intent.status = 'finalized'
                            and not exists (
                                select 1 from public.omr_exams exam
                                 where exam.organization_id = intent.organization_id
                                   and exam.id = intent.exam_id
                                   and (
                                       (intent.kind = 'problem_pdf'
                                        and exam.payload #>> '{pdfDataRef,key}' = intent.id)
                                       or (intent.kind = 'answer_key_pdf'
                                           and exam.payload #>> '{answerKeyPdfRef,key}' = intent.id)
                                   )
                            )
                        )
                    )
                )
        ) or exists (
            select 1
              from pg_catalog.jsonb_array_elements_text(
                  p_teacher_asset_intent_ids
              ) supplied(value)
              join public.omr_remote_asset_cleanup_queue queue
                on queue.source_id = supplied.value
        ) or exists (
            select 1
              from pg_catalog.jsonb_array_elements_text(
                  p_teacher_asset_intent_ids
              ) supplied(value)
              join public.omr_remote_assets asset on asset.id = supplied.value
              join public.omr_remote_asset_cleanup_queue queue
                on queue.storage_bucket = asset.storage_bucket
               and queue.object_path = asset.object_path
        ) then
            raise exception 'teacher asset intent is not ready';
        end if;

        -- Legacy registry rows may predate upload intents. Lock them too so a
        -- concurrent delete cannot move between registry and queue checks.
        perform asset.id
          from public.omr_remote_assets asset
         where asset.id in (
             select value
               from pg_catalog.jsonb_array_elements_text(p_teacher_asset_intent_ids)
         )
         order by asset.id
         for update;

        if exists (
            select 1
              from pg_catalog.jsonb_array_elements_text(
                  p_teacher_asset_intent_ids
              ) supplied(value)
              join public.omr_remote_asset_cleanup_queue queue
                on queue.source_id = supplied.value
        ) or exists (
            select 1
              from pg_catalog.jsonb_array_elements_text(
                  p_teacher_asset_intent_ids
              ) supplied(value)
              join public.omr_remote_assets asset on asset.id = supplied.value
              join public.omr_remote_asset_cleanup_queue queue
                on queue.storage_bucket = asset.storage_bucket
               and queue.object_path = asset.object_path
        ) then
            raise exception 'teacher asset intent is not ready';
        end if;
    end if;

    return public.omr_save_exam_v6_snapshot(
        p_exam, p_questions, p_teacher_asset_intent_ids, p_asset_actor_user_id
    );
end;
$$;

revoke all on function public.omr_save_exam_v1(jsonb, jsonb, jsonb, text)
    from public, anon, authenticated;
grant execute on function public.omr_save_exam_v1(jsonb, jsonb, jsonb, text)
    to service_role;

alter function public.omr_service_readiness_v1()
    rename to omr_service_readiness_v6_snapshot;
revoke all on function public.omr_service_readiness_v6_snapshot()
    from public, anon, authenticated;
grant execute on function public.omr_service_readiness_v6_snapshot()
    to service_role;

create function public.omr_service_readiness_v1()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_previous jsonb;
    v_finalize_preauthorization_ready boolean;
    v_reservation_lease_ready boolean;
    v_server_gateway_capabilities_ready boolean;
    v_queued_cleanup_count integer;
    v_unmaterialized_cleanup_count integer;
    v_dead_cleanup_count integer;
    v_cleanup_backlog_healthy boolean;
    v_ready boolean;
begin
    v_previous := public.omr_service_readiness_v6_snapshot();

    v_finalize_preauthorization_ready :=
        pg_catalog.to_regprocedure(
            'public.omr_authorize_teacher_asset_finalize_v1(text,text,text,jsonb)'
        ) is not null
        and pg_catalog.has_function_privilege(
            'service_role',
            'public.omr_authorize_teacher_asset_finalize_v1(text,text,text,jsonb)',
            'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
            'anon',
            'public.omr_authorize_teacher_asset_finalize_v1(text,text,text,jsonb)',
            'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
            'authenticated',
            'public.omr_authorize_teacher_asset_finalize_v1(text,text,text,jsonb)',
            'EXECUTE'
        );

    select exists (
        select 1 from pg_catalog.pg_attribute attribute
         where attribute.attrelid = 'public.omr_plan_usage_reservations'::pg_catalog.regclass
           and attribute.attname = 'expires_at' and not attribute.attisdropped
    )
    and pg_catalog.to_regclass('public.omr_plan_usage_exam_reservation_expiry_idx') is not null
    and pg_catalog.to_regprocedure('public.omr_mark_exam_reservation_durable_v1()') is not null
      into v_reservation_lease_ready;

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
        ('omr_fail_remote_asset_cleanup_v1', 'text, text, text'),
        ('omr_authorize_teacher_asset_finalize_v1', 'text, text, text, jsonb')
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

    select count(*) filter (where queue.status in ('pending', 'leased'))::integer,
           count(*) filter (where queue.status = 'dead')::integer
      into v_queued_cleanup_count, v_dead_cleanup_count
      from public.omr_remote_asset_cleanup_queue queue;

    select count(*)::integer into v_unmaterialized_cleanup_count
      from public.omr_remote_asset_upload_intents intent
     where not exists (
               select 1 from public.omr_remote_asset_cleanup_queue queue
                where queue.storage_bucket = intent.storage_bucket
                  and queue.object_path = intent.object_path
           )
       and (
           intent.status = 'expired'
           or (
               intent.expires_at <= now()
               and (
                   intent.status in ('pending', 'uploaded')
                   or (
                       intent.status = 'finalized'
                       and not exists (
                           select 1 from public.omr_exams exam
                            where exam.organization_id = intent.organization_id
                              and exam.id = intent.exam_id
                              and (
                                  (intent.kind = 'problem_pdf'
                                   and exam.payload #>> '{pdfDataRef,key}' = intent.id)
                                  or (intent.kind = 'answer_key_pdf'
                                      and exam.payload #>> '{answerKeyPdfRef,key}' = intent.id)
                              )
                       )
                   )
               )
           )
       );

    v_cleanup_backlog_healthy :=
        v_queued_cleanup_count + v_unmaterialized_cleanup_count <= 100
        and v_dead_cleanup_count = 0;

    v_ready := v_previous ->> 'ready' = 'true'
        and v_finalize_preauthorization_ready
        and v_reservation_lease_ready
        and v_server_gateway_capabilities_ready
        and v_cleanup_backlog_healthy;

    return (v_previous - 'version' - 'serverGatewayCapabilitiesReady' - 'ready')
        || pg_catalog.jsonb_build_object(
            'version', '202608060006',
            'serverGatewayCapabilitiesReady', v_server_gateway_capabilities_ready,
            'teacherAssetFinalizePreauthorizationReady', v_finalize_preauthorization_ready,
            'examReservationLeaseReady', v_reservation_lease_ready,
            'teacherAssetCleanupBacklogHealthy', v_cleanup_backlog_healthy,
            'ready', v_ready
        );
end;
$$;

revoke all on function public.omr_service_readiness_v1()
    from public, anon, authenticated;
grant execute on function public.omr_service_readiness_v1()
    to service_role;

commit;
