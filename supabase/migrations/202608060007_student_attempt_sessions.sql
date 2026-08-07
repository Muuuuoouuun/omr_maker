-- Durable, server-authoritative student solve sessions for multi-device resume.
-- Browser roles never touch this table or its RPCs. The Next.js server verifies
-- signed student identity and calls these functions with the service role.

begin;

-- Keep cleanup objects metered until the external delete is acknowledged. The
-- default conservatively covers rows created by the previous schema version;
-- every trigger/outbox path below records the exact immutable object size.
alter table public.omr_remote_asset_cleanup_queue
    add column if not exists byte_size bigint not null default 52428800;
alter table public.omr_remote_asset_cleanup_queue
    drop constraint if exists omr_remote_asset_cleanup_byte_size_check;
alter table public.omr_remote_asset_cleanup_queue
    add constraint omr_remote_asset_cleanup_byte_size_check
    check (byte_size > 0 and byte_size <= 52428800);

create or replace function public.omr_enqueue_remote_asset_cleanup_v1(
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

revoke all on function public.omr_enqueue_remote_asset_cleanup_v1(text,text,text,text,text,text,text,text)
    from public, anon, authenticated, service_role;

create table if not exists public.omr_attempt_sessions (
    id text primary key,
    organization_id text not null references public.omr_organizations(id) on delete cascade,
    exam_id text not null references public.omr_exams(id) on delete cascade,
    assignment_id text references public.omr_assignments(id) on delete set null,
    owner_student_id text not null,
    student_name text not null,
    identity_type text not null check (identity_type in ('guest', 'temporary', 'registered')),
    scope_key text not null,
    submission_id text not null,
    attempt_id text not null,
    retake_source_attempt_id text references public.omr_attempts(id) on delete restrict,
    retake_mode text check (retake_mode in ('wrong', 'similar', 'custom')),
    allowed_question_ids integer[] not null,
    exam_updated_at timestamptz,
    grading_snapshot jsonb not null,
    answers jsonb not null default '{}'::jsonb,
    sub_question_answers jsonb not null default '{}'::jsonb,
    progress_payload jsonb not null default '{}'::jsonb,
    status text not null default 'in_progress'
        check (status in ('in_progress', 'submitted', 'expired')),
    started_at timestamptz not null,
    deadline_at timestamptz not null,
    last_heartbeat_at timestamptz not null,
    revision bigint not null default 1 check (revision > 0),
    lease_epoch bigint not null default 1 check (lease_epoch > 0),
    lease_token_hash text not null,
    lease_expires_at timestamptz not null,
    submitted_attempt_id text references public.omr_attempts(id) on delete set null,
    submitted_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (submission_id),
    unique (attempt_id),
    constraint omr_attempt_sessions_question_ids_check check (
        cardinality(allowed_question_ids) between 1 and 500
    ),
    constraint omr_attempt_sessions_time_check check (
        deadline_at > started_at and deadline_at <= started_at + interval '12 hours'
    ),
    constraint omr_attempt_sessions_payload_shapes_check check (
        jsonb_typeof(grading_snapshot) = 'object'
        and jsonb_typeof(answers) = 'object'
        and jsonb_typeof(sub_question_answers) = 'object'
        and jsonb_typeof(progress_payload) = 'object'
    ),
    constraint omr_attempt_sessions_retake_shape_check check (
        (retake_source_attempt_id is null and retake_mode is null)
        or (retake_source_attempt_id is not null and retake_mode is not null)
    ),
    constraint omr_attempt_sessions_submission_shape_check check (
        (status = 'submitted' and submitted_attempt_id is not null and submitted_at is not null)
        or (status <> 'submitted' and submitted_attempt_id is null and submitted_at is null)
    )
);

alter table public.omr_attempt_sessions enable row level security;
alter table public.omr_attempt_sessions force row level security;
revoke all on public.omr_attempt_sessions from public, anon, authenticated;

create index if not exists omr_attempt_sessions_active_owner_idx
    on public.omr_attempt_sessions (
        organization_id, owner_student_id, exam_id, status, updated_at desc, id
    )
    where status = 'in_progress';

create unique index if not exists omr_attempt_sessions_one_active_scope_idx
    on public.omr_attempt_sessions (organization_id, exam_id, owner_student_id, scope_key)
    where status = 'in_progress';

create index if not exists omr_attempt_sessions_active_lease_idx
    on public.omr_attempt_sessions (status, lease_expires_at, id)
    where status = 'in_progress';

create index if not exists omr_attempt_sessions_assignment_owner_idx
    on public.omr_attempt_sessions (assignment_id, owner_student_id, status)
    where assignment_id is not null;

-- Keep the legacy ticket attachment compatible with durable submissions while
-- making plan entitlement authoritative at attach time. The server action first
-- proves signed-student/session ownership; this RPC rechecks the terminal attempt
-- and organization plan atomically with the canonical payload mutation.
create or replace function public.omr_attach_attempt_handwriting_v1(
    p_ticket_id text,
    p_asset_id text,
    p_ref jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_attempt public.omr_attempts%rowtype;
    v_session public.omr_attempt_sessions%rowtype;
    v_asset public.omr_remote_assets%rowtype;
    v_plan text;
begin
    if nullif(pg_catalog.btrim(p_ticket_id), '') is null
       or nullif(pg_catalog.btrim(p_asset_id), '') is null
       or pg_catalog.jsonb_typeof(p_ref) is distinct from 'object' then
        raise exception 'invalid handwriting attachment';
    end if;
    select * into v_attempt from public.omr_attempts attempt
     where attempt.ticket_id = pg_catalog.btrim(p_ticket_id)
       and attempt.id = 'attempt_' || pg_catalog.btrim(p_ticket_id)
       and attempt.status = 'completed'
     for update;
    if not found then raise exception 'attempt ticket not found'; end if;

    select pg_catalog.lower(organization.plan) into v_plan
      from public.omr_organizations organization
     where organization.id = v_attempt.organization_id
     for share;
    if v_plan not in ('pro', 'academy') then
        raise exception 'handwriting archive plan denied';
    end if;
    select * into v_asset
      from public.omr_remote_assets asset
         where asset.id = pg_catalog.btrim(p_asset_id)
           and asset.organization_id = v_attempt.organization_id
           and asset.attempt_id = v_attempt.id
           and asset.kind = 'attempt_handwriting'
     for update;
    if not found then raise exception 'handwriting asset scope mismatch'; end if;

    select * into v_session
      from public.omr_attempt_sessions attempt_session
     where attempt_session.submission_id = pg_catalog.btrim(p_ticket_id)
       and attempt_session.submitted_attempt_id = v_attempt.id
       and attempt_session.status = 'submitted';
    if found and pg_catalog.btrim(p_asset_id) !~ (
        '^asset_handwriting_' || pg_catalog.md5(v_session.id)
        || '_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ) then
        raise exception 'handwriting asset is not canonical for session';
    end if;
    perform 1
      from public.omr_remote_asset_cleanup_queue queue
     where queue.storage_bucket = v_asset.storage_bucket
       and queue.object_path = v_asset.object_path
     for update;
    if found then raise exception 'handwriting cleanup in progress'; end if;
    if p_ref ->> 'store' is distinct from 'remote'
       or p_ref ->> 'key' is distinct from pg_catalog.btrim(p_asset_id)
       or p_ref ->> 'organizationId' is distinct from v_attempt.organization_id
       or p_ref ->> 'kind' is distinct from 'attempt_handwriting'
       or p_ref ->> 'attemptId' is distinct from v_attempt.id then
        raise exception 'handwriting reference scope mismatch';
    end if;

    update public.omr_attempts attempt
       set payload = pg_catalog.jsonb_set(
           pg_catalog.jsonb_set(
               pg_catalog.jsonb_set(attempt.payload, '{drawingsRef}', p_ref, true),
               '{handwritingArchived}', 'true'::jsonb, true
           ),
           '{handwritingPlan}', pg_catalog.to_jsonb(v_plan), true
       )
     where attempt.id = v_attempt.id
     returning * into v_attempt;
    delete from public.omr_remote_asset_cleanup_queue queue
     where queue.source_type = 'remote_asset'
       and queue.source_id = pg_catalog.btrim(p_asset_id)
       and queue.organization_id = v_attempt.organization_id;
    return v_attempt.payload;
end;
$$;

revoke all on function public.omr_attach_attempt_handwriting_v1(text,text,jsonb)
    from public, anon, authenticated;
grant execute on function public.omr_attach_attempt_handwriting_v1(text,text,jsonb)
    to service_role;

-- Reserve exactly one active immutable handwriting object per submitted session.
-- Registry insertion is the allocation boundary: an organization-wide advisory
-- lock makes the total-byte cap race-safe before Storage receives any bytes.
create function public.omr_prepare_attempt_handwriting_asset_v1(
    p_session_id text,
    p_asset jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_session public.omr_attempt_sessions%rowtype;
    v_attempt public.omr_attempts%rowtype;
    v_asset public.omr_remote_assets%rowtype;
    v_stored public.omr_remote_assets%rowtype;
    v_plan text;
    v_storage_bytes bigint;
    v_storage_cap bigint;
    v_canonical_asset_id text;
    v_canonical_path text;
    v_stored_found boolean;
begin
    if nullif(pg_catalog.btrim(p_session_id), '') is null
       or pg_catalog.jsonb_typeof(p_asset) is distinct from 'object' then
        raise exception 'invalid handwriting reservation';
    end if;
    select * into v_session from public.omr_attempt_sessions attempt_session
     where attempt_session.id = pg_catalog.btrim(p_session_id)
       and attempt_session.status = 'submitted'
     for update;
    if not found then raise exception 'submitted attempt session not found'; end if;
    select * into v_attempt from public.omr_attempts attempt
     where attempt.id = v_session.submitted_attempt_id
       and attempt.organization_id = v_session.organization_id
       and attempt.status = 'completed'
     for update;
    if not found then raise exception 'submitted attempt not found'; end if;

    select * into v_asset
      from pg_catalog.jsonb_populate_record(null::public.omr_remote_assets, p_asset);
    v_canonical_asset_id := v_asset.id;
    v_canonical_path := 'organizations/' || v_session.organization_id
        || '/attempts/' || v_attempt.id || '/handwriting/'
        || v_canonical_asset_id || '.json';
    if v_canonical_asset_id !~ (
           '^asset_handwriting_' || pg_catalog.md5(v_session.id)
           || '_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       )
       or v_asset.organization_id is distinct from v_session.organization_id
       or v_asset.kind is distinct from 'attempt_handwriting'
       or v_asset.exam_id is not null
       or v_asset.attempt_id is distinct from v_attempt.id
       or v_asset.storage_bucket is distinct from 'omr-private-assets'
       or v_asset.object_path is distinct from v_canonical_path
       or v_asset.mime_type is distinct from 'application/json'
       or v_asset.byte_size is null or v_asset.byte_size not between 1 and 10485760
       or v_asset.sha256_hex is null or v_asset.sha256_hex !~ '^[a-f0-9]{64}$' then
        raise exception 'invalid canonical handwriting asset';
    end if;

    select pg_catalog.lower(organization.plan) into v_plan
      from public.omr_organizations organization
     where organization.id = v_session.organization_id
     for share;
    if v_plan = 'pro' then v_storage_cap := 2147483648;
    elsif v_plan = 'academy' then v_storage_cap := 10737418240;
    else raise exception 'handwriting archive plan denied';
    end if;

    perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(v_session.organization_id, 604006)
    );
    select * into v_stored from public.omr_remote_assets asset
     where asset.organization_id = v_session.organization_id
       and asset.attempt_id = v_attempt.id
       and asset.kind = 'attempt_handwriting'
     order by asset.created_at, asset.id
     limit 1
     for update;
    v_stored_found := found;
    perform 1
      from public.omr_remote_asset_cleanup_queue queue
     where queue.storage_bucket = 'omr-private-assets'
       and queue.object_path = v_canonical_path
     for update;
    if found then
        return pg_catalog.jsonb_build_object(
            'status', 'cleanup_pending',
            'objectRequired', false
        );
    end if;
    if v_stored_found then
        if v_stored.organization_id is distinct from v_asset.organization_id
           or v_stored.kind is distinct from v_asset.kind
           or v_stored.attempt_id is distinct from v_asset.attempt_id
           or v_stored.mime_type is distinct from v_asset.mime_type
           or v_stored.byte_size is distinct from v_asset.byte_size
           or v_stored.sha256_hex is distinct from v_asset.sha256_hex then
            raise exception 'handwriting reservation belongs to another payload';
        end if;
        return pg_catalog.jsonb_build_object(
            'status', case when v_attempt.payload #>> '{drawingsRef,key}' = v_stored.id
                then 'attached' else 'reserved' end,
            'objectRequired', false,
            'asset', pg_catalog.to_jsonb(v_stored)
        );
    end if;
    if nullif(v_attempt.payload #>> '{drawingsRef,key}', '') is not null then
        raise exception 'attempt handwriting is already archived';
    end if;

    select coalesce(sum(reserved.byte_size), 0)::bigint into v_storage_bytes
      from (
          select item.object_path, max(item.byte_size)::bigint as byte_size
            from (
                select asset.object_path, asset.byte_size
                  from public.omr_remote_assets asset
                 where asset.organization_id = v_session.organization_id
                union
                select intent.object_path, intent.byte_size
                  from public.omr_remote_asset_upload_intents intent
                 where intent.organization_id = v_session.organization_id
                   and intent.status in ('pending', 'uploaded', 'finalized')
                   and intent.expires_at > now()
                union
                select queue.object_path, queue.byte_size
                  from public.omr_remote_asset_cleanup_queue queue
                 where queue.organization_id = v_session.organization_id
                   and queue.status in ('pending', 'leased', 'dead')
            ) item
           group by item.object_path
      ) reserved;
    if v_storage_bytes + v_asset.byte_size > v_storage_cap then
        raise exception 'organization remote asset storage limit exceeded';
    end if;

    insert into public.omr_remote_assets (
        id, organization_id, kind, exam_id, attempt_id, storage_bucket,
        object_path, mime_type, byte_size, sha256_hex, original_name,
        created_by_user_id, created_at, updated_at
    ) values (
        v_canonical_asset_id, v_session.organization_id, 'attempt_handwriting',
        null, v_attempt.id, 'omr-private-assets', v_canonical_path,
        'application/json', v_asset.byte_size, v_asset.sha256_hex,
        v_asset.original_name, null, now(), now()
    ) returning * into v_stored;
    return pg_catalog.jsonb_build_object(
        'status', 'reserved', 'objectRequired', true,
        'asset', pg_catalog.to_jsonb(v_stored)
    );
end;
$$;

revoke all on function public.omr_prepare_attempt_handwriting_asset_v1(text,jsonb)
    from public, anon, authenticated;
grant execute on function public.omr_prepare_attempt_handwriting_asset_v1(text,jsonb)
    to service_role;

create function public.omr_discard_attempt_handwriting_asset_v1(
    p_session_id text,
    p_asset_id text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_session public.omr_attempt_sessions%rowtype;
    v_attempt public.omr_attempts%rowtype;
    v_deleted integer;
begin
    select * into v_session from public.omr_attempt_sessions attempt_session
     where attempt_session.id = pg_catalog.btrim(p_session_id)
       and attempt_session.status = 'submitted'
     for update;
    if not found or pg_catalog.btrim(p_asset_id) !~ (
        '^asset_handwriting_' || pg_catalog.md5(v_session.id)
        || '_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    ) then
        return false;
    end if;
    select * into v_attempt from public.omr_attempts attempt
     where attempt.id = v_session.submitted_attempt_id
       and attempt.organization_id = v_session.organization_id
     for update;
    if not found or v_attempt.payload #>> '{drawingsRef,key}' = pg_catalog.btrim(p_asset_id) then
        return false;
    end if;
    delete from public.omr_remote_assets asset
     where asset.id = pg_catalog.btrim(p_asset_id)
       and asset.organization_id = v_session.organization_id
       and asset.attempt_id = v_attempt.id
       and asset.kind = 'attempt_handwriting';
    get diagnostics v_deleted = row_count;
    return v_deleted = 1;
end;
$$;

revoke all on function public.omr_discard_attempt_handwriting_asset_v1(text,text)
    from public, anon, authenticated;
grant execute on function public.omr_discard_attempt_handwriting_asset_v1(text,text)
    to service_role;

-- A worker id is operational metadata, not a lease nonce. Keep legacy overloads
-- as denied compatibility stubs so the v6 readiness evidence remains readable,
-- while every mutating worker transition requires the monotonically incremented
-- queue attempt returned by claim.
create or replace function public.omr_ack_remote_asset_cleanup_v1(
    p_cleanup_id text,
    p_worker_id text
)
returns boolean language sql security definer set search_path = ''
as 'select false';
create or replace function public.omr_fail_remote_asset_cleanup_v1(
    p_cleanup_id text,
    p_worker_id text,
    p_error text
)
returns boolean language sql security definer set search_path = ''
as 'select false';
revoke all on function public.omr_ack_remote_asset_cleanup_v1(text,text)
    from public, anon, authenticated;
grant execute on function public.omr_ack_remote_asset_cleanup_v1(text,text)
    to service_role;
revoke all on function public.omr_fail_remote_asset_cleanup_v1(text,text,text)
    from public, anon, authenticated;
grant execute on function public.omr_fail_remote_asset_cleanup_v1(text,text,text)
    to service_role;

-- Storage deletion is outside the database transaction, so a claimed job must
-- be revalidated immediately before the worker removes its immutable path. A
-- handwriting generation path cannot be reused or attached while its queue
-- row exists; this RPC cancels a handed-out stale job if canonical state won the
-- race before deletion began.
create function public.omr_authorize_remote_asset_cleanup_delete_v1(
    p_cleanup_id text,
    p_worker_id text,
    p_expected_attempt integer
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
       and queue.attempts = p_expected_attempt
       and queue.lease_until > now()
     for update;
    if not found then return false; end if;

    if v_queue.asset_kind = 'attempt_handwriting'
       and (
           exists (
               select 1 from public.omr_remote_assets asset
                where asset.id = v_queue.source_id
                  and asset.organization_id = v_queue.organization_id
                  and asset.storage_bucket = v_queue.storage_bucket
                  and asset.object_path = v_queue.object_path
                  and asset.kind = 'attempt_handwriting'
           )
           or exists (
               select 1 from public.omr_attempts attempt
                where attempt.organization_id = v_queue.organization_id
                  and attempt.status = 'completed'
                  and attempt.payload #>> '{drawingsRef,key}' = v_queue.source_id
           )
       ) then
        delete from public.omr_remote_asset_cleanup_queue queue
         where queue.id = v_queue.id;
        return false;
    end if;
    return true;
end;
$$;

revoke all on function public.omr_authorize_remote_asset_cleanup_delete_v1(text,text,integer)
    from public, anon, authenticated;
grant execute on function public.omr_authorize_remote_asset_cleanup_delete_v1(text,text,integer)
    to service_role;

create function public.omr_ack_remote_asset_cleanup_v1(
    p_cleanup_id text,
    p_worker_id text,
    p_expected_attempt integer
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
       and queue.attempts = p_expected_attempt
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

revoke all on function public.omr_ack_remote_asset_cleanup_v1(text,text,integer)
    from public, anon, authenticated;
grant execute on function public.omr_ack_remote_asset_cleanup_v1(text,text,integer)
    to service_role;

create function public.omr_fail_remote_asset_cleanup_v1(
    p_cleanup_id text,
    p_worker_id text,
    p_expected_attempt integer,
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
       and queue.attempts = p_expected_attempt
     for update;
    if not found then return false; end if;

    update public.omr_remote_asset_cleanup_queue queue
       set status = case when v_attempts >= 10 then 'dead' else 'pending' end,
           available_at = now() + least(
               interval '1 hour',
               interval '5 seconds' * power(2, greatest(v_attempts - 1, 0))
           ),
           lease_owner = null,
           lease_until = null,
           last_error = pg_catalog.left(coalesce(p_error, 'cleanup failed'), 500),
           updated_at = now()
     where queue.id::text = p_cleanup_id;
    return true;
end;
$$;

revoke all on function public.omr_fail_remote_asset_cleanup_v1(text,text,integer,text)
    from public, anon, authenticated;
grant execute on function public.omr_fail_remote_asset_cleanup_v1(text,text,integer,text)
    to service_role;

-- A teacher may replace an exam PDF while students are still solving the
-- immutable snapshot. Do not lease either snapshot asset for deletion until
-- every referencing session is terminal.
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

    -- Abandoned browsers cannot leave immutable snapshot assets pinned forever.
    -- The same submit grace used by the durable submit boundary is respected.
    update public.omr_attempt_sessions attempt_session
       set status = 'expired', updated_at = now()
     where attempt_session.status = 'in_progress'
       and attempt_session.deadline_at + interval '30 seconds' < now();

    -- A browser or worker can disappear after the quota reservation but before
    -- attachment. Recover those bounded reservations after two hours; the
    -- existing BEFORE DELETE trigger durably enqueues the immutable object path.
    delete from public.omr_remote_assets asset
     where asset.kind = 'attempt_handwriting'
       and asset.created_at <= now() - interval '2 hours'
       and not exists (
           select 1 from public.omr_attempts attempt
            where attempt.organization_id = asset.organization_id
              and attempt.id = asset.attempt_id
              and attempt.status = 'completed'
              and attempt.payload #>> '{drawingsRef,key}' = asset.id
       );

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
         for update skip locked limit p_limit
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

revoke all on function public.omr_claim_remote_asset_cleanup_v1(text,integer,integer)
    from public, anon, authenticated;
grant execute on function public.omr_claim_remote_asset_cleanup_v1(text,integer,integer)
    to service_role;

create or replace function public.omr_open_attempt_session_v1(
    p_session_id text,
    p_organization_id text,
    p_exam_id text,
    p_assignment_id text,
    p_owner_student_id text,
    p_student_name text,
    p_identity_type text,
    p_submission_id text,
    p_attempt_id text,
    p_retake_source_attempt_id text,
    p_retake_mode text,
    p_requested_question_ids integer[],
    p_exam_question_ids integer[],
    p_exam_updated_at timestamptz,
    p_grading_snapshot jsonb,
    p_duration_seconds integer,
    p_exam_ends_at timestamptz,
    p_new_lease_token_hash text,
    p_current_lease_token_hash text,
    p_lease_seconds integer
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
    grading_snapshot jsonb,
    submitted_attempt_id text,
    lease_acquired boolean,
    lease_token_rotated boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_now timestamptz := clock_timestamp();
    v_session public.omr_attempt_sessions%rowtype;
    v_source public.omr_attempts%rowtype;
    v_allowed integer[];
    v_requested integer[];
    v_exam_ids integer[];
    v_scope_key text;
    v_assignment_id text := nullif(btrim(p_assignment_id), '');
    v_max_attempts integer;
    v_used_attempts integer;
    v_active_reservations integer;
    v_deadline timestamptz;
    v_lease_seconds integer := least(greatest(coalesce(p_lease_seconds, 45), 30), 120);
    v_lease_acquired boolean := false;
    v_lease_token_rotated boolean := false;
    v_exact_submission boolean := false;
    v_canonical_exam_updated_at timestamptz;
begin
    if nullif(btrim(p_session_id), '') is null
       or nullif(btrim(p_organization_id), '') is null
       or nullif(btrim(p_exam_id), '') is null
       or nullif(btrim(p_owner_student_id), '') is null
       or nullif(btrim(p_student_name), '') is null
       or nullif(btrim(p_submission_id), '') is null
       or nullif(btrim(p_attempt_id), '') is null
       or nullif(btrim(p_new_lease_token_hash), '') is null
       or length(p_session_id) > 256
       or length(p_organization_id) > 256
       or length(p_exam_id) > 256
       or length(p_owner_student_id) > 256
       or length(p_student_name) > 300
       or length(p_submission_id) > 256
       or length(p_attempt_id) > 256
       or length(p_new_lease_token_hash) > 256
       or p_identity_type not in ('guest', 'temporary', 'registered')
       or jsonb_typeof(p_grading_snapshot) is distinct from 'object'
       or pg_column_size(p_grading_snapshot) > 1048576
       or coalesce(p_duration_seconds, 0) <= 0
       or p_duration_seconds > 43200 then
        raise exception 'invalid attempt session open';
    end if;

    select array_agg(question_id order by question_id) into v_exam_ids
      from (
          select distinct question_id
            from unnest(coalesce(p_exam_question_ids, '{}'::integer[])) question_id
           where question_id > 0
      ) ids;
    if coalesce(cardinality(v_exam_ids), 0) = 0 or cardinality(v_exam_ids) > 500 then
        raise exception 'invalid attempt session question scope';
    end if;

    select exam.updated_at into v_canonical_exam_updated_at
      from public.omr_exams exam
     where exam.id = btrim(p_exam_id)
       and exam.organization_id = btrim(p_organization_id)
       and not exam.archived
     for share;
    if not found then
        raise exception 'attempt session exam unavailable';
    end if;
    if p_exam_updated_at is null
       or p_exam_updated_at is distinct from v_canonical_exam_updated_at then
        raise exception 'attempt session exam revision stale';
    end if;

    if p_exam_ends_at is not null and p_exam_ends_at <= v_now then
        raise exception 'attempt session exam ended';
    end if;
    v_deadline := least(
        v_now + make_interval(secs => p_duration_seconds),
        coalesce(p_exam_ends_at, v_now + make_interval(secs => p_duration_seconds))
    );
    if v_deadline <= v_now then
        raise exception 'attempt session deadline invalid';
    end if;

    if nullif(btrim(p_retake_source_attempt_id), '') is null then
        if nullif(btrim(p_retake_mode), '') is not null then
            raise exception 'attempt session retake scope invalid';
        end if;
        v_allowed := v_exam_ids;
        v_scope_key := 'base';
    else
        if p_retake_mode not in ('wrong', 'similar', 'custom') then
            raise exception 'attempt session retake scope invalid';
        end if;
        select * into v_source
          from public.omr_attempts source
         where source.id = btrim(p_retake_source_attempt_id)
         for share;
        if not found
           or v_source.organization_id is distinct from btrim(p_organization_id)
           or v_source.exam_id is distinct from btrim(p_exam_id)
           or v_source.student_id is distinct from btrim(p_owner_student_id) then
            raise exception 'retake source attempt is not owned by student';
        end if;
        if v_source.status is distinct from 'completed' then
            raise exception 'retake source attempt is not completed';
        end if;
        if v_assignment_id is not null
           and v_assignment_id is distinct from v_source.assignment_id then
            raise exception 'attempt session assignment invalid';
        end if;
        v_assignment_id := v_source.assignment_id;

        if p_retake_mode = 'wrong' then
            select array_agg(result.question_id order by result.question_id) into v_allowed
              from public.omr_question_results result
             where result.attempt_id = v_source.id
               and result.status in ('wrong', 'unanswered')
               and result.question_id = any(v_exam_ids);
        else
            select array_agg(question_id order by question_id) into v_requested
              from (
                  select distinct question_id
                    from unnest(coalesce(p_requested_question_ids, '{}'::integer[])) question_id
                   where question_id > 0
              ) ids;
            if coalesce(cardinality(v_requested), 0) = 0
               or cardinality(v_requested) > 500
               or not v_requested <@ v_exam_ids then
                raise exception 'attempt session retake questions invalid';
            end if;
            v_allowed := v_requested;
        end if;
        if coalesce(cardinality(v_allowed), 0) = 0 then
            raise exception 'attempt session retake has no eligible questions';
        end if;
        v_scope_key := 'retake:' || pg_catalog.md5(
            v_source.id || ':' || p_retake_mode || ':' || array_to_string(v_allowed, ',')
        );
    end if;

    -- Capacity is shared across base and retake scopes, so every new open for an
    -- assignment/student takes the same lock before the narrower scope lock.
    if v_assignment_id is not null then
        perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
            btrim(p_organization_id) || ':assignment:' || v_assignment_id || ':'
            || btrim(p_owner_student_id),
            0
        ));
        select assignment.max_attempts into v_max_attempts
          from public.omr_assignments assignment
         where assignment.id = v_assignment_id
           and assignment.organization_id = btrim(p_organization_id)
           and assignment.exam_id = btrim(p_exam_id)
         for share;
        if not found then
            raise exception 'attempt session assignment invalid';
        end if;
    end if;

    -- The active-only unique owner/scope index is the final guard; this transaction
    -- lock makes the common concurrent-open path deterministic rather than
    -- surfacing a unique-violation to one device.
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        btrim(p_organization_id) || ':' || btrim(p_exam_id) || ':'
        || btrim(p_owner_student_id) || ':' || v_scope_key,
        0
    ));

    -- A repeated submission id is a response-loss retry. Resolve it before the
    -- active-scope lookup and before enforcing a new-attempt cap.
    select * into v_session
      from public.omr_attempt_sessions attempt_session
     where attempt_session.submission_id = btrim(p_submission_id)
     for update;
    if found then
        v_exact_submission := true;
        if v_session.organization_id is distinct from btrim(p_organization_id)
           or v_session.exam_id is distinct from btrim(p_exam_id)
           or v_session.owner_student_id is distinct from btrim(p_owner_student_id)
           or v_session.scope_key is distinct from v_scope_key
           or v_session.assignment_id is distinct from v_assignment_id
           or v_session.attempt_id is distinct from btrim(p_attempt_id) then
            raise exception 'invalid attempt session idempotency scope';
        end if;
    else
        select * into v_session
          from public.omr_attempt_sessions attempt_session
         where attempt_session.organization_id = btrim(p_organization_id)
           and attempt_session.exam_id = btrim(p_exam_id)
           and attempt_session.owner_student_id = btrim(p_owner_student_id)
           and attempt_session.scope_key = v_scope_key
           and attempt_session.status = 'in_progress'
         for update;
    end if;

    if found then
        if v_session.status = 'in_progress' and v_session.deadline_at <= v_now then
            update public.omr_attempt_sessions
               set status = 'expired', updated_at = v_now
             where id = v_session.id
             returning * into v_session;
            -- A new submission id may begin a later attempt after the stale
            -- active row has become terminal. Exact retries keep their result.
            if not v_exact_submission then
                v_session := null;
            end if;
        elsif v_session.status = 'in_progress' then
            if v_session.lease_token_hash = nullif(btrim(p_current_lease_token_hash), '') then
                update public.omr_attempt_sessions
                   set lease_expires_at = v_now + make_interval(secs => v_lease_seconds),
                       last_heartbeat_at = v_now,
                       updated_at = v_now
                 where id = v_session.id
                returning * into v_session;
                v_lease_acquired := true;
            elsif v_session.lease_expires_at <= v_now then
                update public.omr_attempt_sessions as attempt_session
                   set lease_token_hash = btrim(p_new_lease_token_hash),
                       lease_epoch = attempt_session.lease_epoch + 1,
                       revision = attempt_session.revision + 1,
                       lease_expires_at = v_now + make_interval(secs => v_lease_seconds),
                       last_heartbeat_at = v_now,
                       updated_at = v_now
                 where id = v_session.id
                 returning * into v_session;
                v_lease_acquired := true;
                v_lease_token_rotated := true;
            end if;
        end if;
    end if;

    if v_session.id is null then
        if v_assignment_id is not null then
            update public.omr_attempt_sessions attempt_session
               set status = 'expired', updated_at = v_now
             where attempt_session.assignment_id = v_assignment_id
               and attempt_session.organization_id = btrim(p_organization_id)
               and attempt_session.owner_student_id = btrim(p_owner_student_id)
               and attempt_session.status = 'in_progress'
               and attempt_session.deadline_at <= v_now;
            select count(*)::integer into v_used_attempts
              from public.omr_attempts attempt
             where attempt.assignment_id = v_assignment_id
               and attempt.organization_id = btrim(p_organization_id)
                and attempt.student_id = btrim(p_owner_student_id)
                and attempt.status = 'completed';
            select count(*)::integer into v_active_reservations
              from public.omr_attempt_sessions attempt_session
             where attempt_session.assignment_id = v_assignment_id
               and attempt_session.organization_id = btrim(p_organization_id)
               and attempt_session.owner_student_id = btrim(p_owner_student_id)
               and attempt_session.status = 'in_progress';
            if v_used_attempts + v_active_reservations >= v_max_attempts then
                raise exception 'attempt session max_attempts exceeded';
            end if;
        end if;
        insert into public.omr_attempt_sessions (
            id, organization_id, exam_id, assignment_id, owner_student_id,
            student_name, identity_type, scope_key, submission_id, attempt_id,
            retake_source_attempt_id, retake_mode, allowed_question_ids,
            exam_updated_at, grading_snapshot, started_at, deadline_at,
            last_heartbeat_at, lease_token_hash, lease_expires_at
        ) values (
            btrim(p_session_id), btrim(p_organization_id), btrim(p_exam_id), v_assignment_id,
            btrim(p_owner_student_id), btrim(p_student_name), p_identity_type, v_scope_key,
            btrim(p_submission_id), btrim(p_attempt_id), nullif(btrim(p_retake_source_attempt_id), ''),
            nullif(btrim(p_retake_mode), ''), v_allowed, p_exam_updated_at, p_grading_snapshot,
            v_now, v_deadline, v_now, btrim(p_new_lease_token_hash),
            v_now + make_interval(secs => v_lease_seconds)
        ) returning * into v_session;
        v_lease_acquired := true;
        v_lease_token_rotated := true;
    end if;

    return query select
        v_session.id, v_session.status, v_session.revision, v_session.lease_epoch,
        v_session.started_at, v_session.deadline_at, v_now, v_session.answers,
        v_session.sub_question_answers, v_session.progress_payload, v_session.allowed_question_ids,
        v_session.grading_snapshot,
        v_session.submitted_attempt_id, v_lease_acquired, v_lease_token_rotated;
end;
$$;

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
    v_now timestamptz := clock_timestamp();
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
    for v_answer_key, v_answer_value in select key, value from jsonb_each(p_answers)
    loop
        if v_answer_key !~ '^[1-9][0-9]*$'
           or v_answer_key::integer <> all(coalesce((
               select scoped_session.allowed_question_ids
                 from public.omr_attempt_sessions scoped_session
                where scoped_session.id = btrim(p_session_id)
           ), '{}'::integer[]))
           or jsonb_typeof(v_answer_value) <> 'number'
           or (v_answer_value #>> '{}')::numeric not in (1, 2, 3, 4, 5) then
            raise exception 'attempt session answer invalid';
        end if;
    end loop;
    for v_sub_answer_key in select key from jsonb_each(p_sub_question_answers)
    loop
        if v_sub_answer_key !~ '^[1-9][0-9]*$'
           or v_sub_answer_key::integer <> all(coalesce((
               select scoped_session.allowed_question_ids
                 from public.omr_attempt_sessions scoped_session
                where scoped_session.id = btrim(p_session_id)
           ), '{}'::integer[])) then
            raise exception 'attempt session sub-question answer invalid';
        end if;
    end loop;

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

create or replace function public.omr_heartbeat_attempt_session_v1(
    p_session_id text,
    p_organization_id text,
    p_owner_student_id text,
    p_expected_lease_epoch bigint,
    p_lease_token_hash text,
    p_lease_seconds integer
)
returns table (
    session_id text,
    status text,
    revision bigint,
    lease_epoch bigint,
    deadline_at timestamptz,
    server_now timestamptz,
    submitted_attempt_id text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_now timestamptz := clock_timestamp();
    v_session public.omr_attempt_sessions%rowtype;
    v_lease_seconds integer := least(greatest(coalesce(p_lease_seconds, 45), 30), 120);
begin
    select * into v_session
      from public.omr_attempt_sessions attempt_session
     where attempt_session.id = btrim(p_session_id)
     for update;
    if not found
       or v_session.organization_id is distinct from btrim(p_organization_id)
       or v_session.owner_student_id is distinct from btrim(p_owner_student_id) then
        raise exception 'attempt session not owned';
    end if;
    if v_session.status <> 'in_progress' then
        return query select v_session.id, v_session.status, v_session.revision,
            v_session.lease_epoch, v_session.deadline_at, v_now, v_session.submitted_attempt_id;
        return;
    end if;
    if v_session.deadline_at + interval '30 seconds' < v_now then
        update public.omr_attempt_sessions
           set status = 'expired', updated_at = v_now
         where id = v_session.id
         returning * into v_session;
    elsif v_session.deadline_at <= v_now then
        -- Final-submit grace: report the active row without extending its lease.
        -- The dedicated final checkpoint may persist the last answers, but an
        -- ordinary heartbeat cannot prolong control beyond the canonical lease.
        null;
    elsif v_session.lease_epoch <> p_expected_lease_epoch
       or v_session.lease_token_hash <> btrim(p_lease_token_hash)
       or v_session.lease_expires_at <= v_now then
        raise exception 'attempt session lease conflict';
    else
        update public.omr_attempt_sessions
           set last_heartbeat_at = v_now,
               lease_expires_at = v_now + make_interval(secs => v_lease_seconds),
               updated_at = v_now
         where id = v_session.id
         returning * into v_session;
    end if;
    return query select v_session.id, v_session.status, v_session.revision,
        v_session.lease_epoch, v_session.deadline_at, v_now, v_session.submitted_attempt_id;
end;
$$;

create or replace function public.omr_takeover_attempt_session_v1(
    p_session_id text,
    p_organization_id text,
    p_owner_student_id text,
    p_expected_revision bigint,
    p_expected_lease_epoch bigint,
    p_new_lease_token_hash text,
    p_lease_seconds integer
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
    v_now timestamptz := clock_timestamp();
    v_session public.omr_attempt_sessions%rowtype;
    v_lease_seconds integer := least(greatest(coalesce(p_lease_seconds, 45), 30), 120);
begin
    if nullif(btrim(p_new_lease_token_hash), '') is null then
        raise exception 'attempt session lease token required';
    end if;
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
    if v_session.deadline_at <= v_now then
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
    if v_session.revision <> p_expected_revision
       or v_session.lease_epoch <> p_expected_lease_epoch then
        raise exception 'attempt session revision conflict';
    end if;
    update public.omr_attempt_sessions as attempt_session
       set lease_token_hash = btrim(p_new_lease_token_hash),
           lease_epoch = attempt_session.lease_epoch + 1,
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

create or replace function public.omr_prepare_attempt_session_submit_v1(
    p_session_id text,
    p_organization_id text,
    p_owner_student_id text,
    p_expected_revision bigint,
    p_expected_lease_epoch bigint,
    p_lease_token_hash text
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
    allowed_question_ids integer[],
    grading_snapshot jsonb,
    submission_id text,
    attempt_id text,
    assignment_id text,
    retake_source_attempt_id text,
    retake_mode text,
    progress_payload jsonb,
    submitted_attempt_id text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_now timestamptz := clock_timestamp();
    v_session public.omr_attempt_sessions%rowtype;
begin
    select * into v_session
      from public.omr_attempt_sessions attempt_session
     where attempt_session.id = btrim(p_session_id)
     for update;
    if not found
       or v_session.organization_id is distinct from btrim(p_organization_id)
       or v_session.owner_student_id is distinct from btrim(p_owner_student_id) then
        raise exception 'attempt session not owned';
    end if;
    if v_session.status = 'in_progress' then
        if v_session.deadline_at + interval '30 seconds' < v_now then
            update public.omr_attempt_sessions
               set status = 'expired', updated_at = v_now
             where id = v_session.id
             returning * into v_session;
        else
            if v_session.revision <> p_expected_revision then raise exception 'attempt session revision conflict'; end if;
            if v_session.lease_epoch <> p_expected_lease_epoch
               or v_session.lease_token_hash <> btrim(p_lease_token_hash)
               or v_session.lease_expires_at <= v_now then
                raise exception 'attempt session lease conflict';
            end if;
        end if;
    end if;
    return query select
        v_session.id, v_session.status, v_session.revision, v_session.lease_epoch,
        v_session.started_at, v_session.deadline_at, v_now, v_session.answers,
        v_session.sub_question_answers, v_session.allowed_question_ids,
        v_session.grading_snapshot, v_session.submission_id, v_session.attempt_id,
        v_session.assignment_id, v_session.retake_source_attempt_id, v_session.retake_mode,
        v_session.progress_payload, v_session.submitted_attempt_id;
end;
$$;

create or replace function public.omr_commit_attempt_session_submit_v1(
    p_session_id text,
    p_organization_id text,
    p_owner_student_id text,
    p_expected_revision bigint,
    p_expected_lease_epoch bigint,
    p_lease_token_hash text,
    p_attempt jsonb,
    p_question_results jsonb
)
returns table (payload jsonb, result_status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_now timestamptz := clock_timestamp();
    v_session public.omr_attempt_sessions%rowtype;
    v_attempt public.omr_attempts%rowtype;
    v_payload jsonb;
    v_result_ids integer[];
    v_canonical_attempt jsonb;
begin
    if jsonb_typeof(p_attempt) is distinct from 'object'
       or jsonb_typeof(p_question_results) is distinct from 'array'
       or pg_column_size(p_attempt) > 1048576
       or pg_column_size(p_question_results) > 1048576
       or jsonb_array_length(p_question_results) > 500 then
        raise exception 'invalid attempt session submission';
    end if;
    select * into v_session
      from public.omr_attempt_sessions attempt_session
     where attempt_session.id = btrim(p_session_id)
     for update;
    if not found
       or v_session.organization_id is distinct from btrim(p_organization_id)
       or v_session.owner_student_id is distinct from btrim(p_owner_student_id) then
        raise exception 'attempt session not owned';
    end if;
    if v_session.status = 'submitted' then
        return query select attempt.payload, 'submitted'::text
          from public.omr_attempts attempt
         where attempt.id = v_session.submitted_attempt_id;
        return;
    end if;
    if v_session.status <> 'in_progress' then raise exception 'attempt session is not active'; end if;
    if v_session.deadline_at + interval '30 seconds' < v_now then
        update public.omr_attempt_sessions
           set status = 'expired', updated_at = v_now
         where id = v_session.id;
        return query select null::jsonb, 'expired'::text;
        return;
    end if;
    if v_session.revision <> p_expected_revision then raise exception 'attempt session revision conflict'; end if;
    if v_session.lease_epoch <> p_expected_lease_epoch
       or v_session.lease_token_hash <> btrim(p_lease_token_hash)
       or v_session.lease_expires_at <= v_now then
        raise exception 'attempt session lease conflict';
    end if;

    select * into v_attempt from jsonb_populate_record(null::public.omr_attempts, p_attempt);
    if v_attempt.id is distinct from v_session.attempt_id
       or v_attempt.organization_id is distinct from v_session.organization_id
       or v_attempt.exam_id is distinct from v_session.exam_id
       or v_attempt.student_id is distinct from v_session.owner_student_id
       or v_attempt.assignment_id is distinct from v_session.assignment_id
       or v_attempt.status is distinct from 'completed'
       or v_attempt.retake_source_attempt_id is distinct from v_session.retake_source_attempt_id
       or v_attempt.retake_mode is distinct from v_session.retake_mode
       or v_attempt.retake_question_ids is distinct from (case
            when v_session.retake_source_attempt_id is null then '{}'::integer[]
            else v_session.allowed_question_ids
          end)
       or v_attempt.payload->'answers' is distinct from v_session.answers then
        raise exception 'attempt session canonical submission mismatch';
    end if;

    if exists (
        select 1
          from jsonb_array_elements(p_question_results) result
         where jsonb_typeof(result) is distinct from 'object'
            or (result->>'attempt_id') is distinct from v_session.attempt_id
            or coalesce(result->>'question_id', '') !~ '^[1-9][0-9]*$'
    ) then
        raise exception 'attempt session question result mismatch';
    end if;
    select array_agg(question_id order by question_id) into v_result_ids
      from (
          select distinct (result->>'question_id')::integer question_id
            from jsonb_array_elements(p_question_results) result
      ) ids;
    if jsonb_array_length(p_question_results) <> cardinality(v_session.allowed_question_ids)
       or v_result_ids is distinct from v_session.allowed_question_ids then
        raise exception 'attempt session question result scope mismatch';
    end if;

    v_canonical_attempt := p_attempt || pg_catalog.jsonb_build_object(
        'ticket_id', v_session.submission_id
    );
    select submitted.payload into v_payload
      from public.omr_submit_session_attempt_v1(v_canonical_attempt, p_question_results) submitted;
    if v_payload is null then raise exception 'attempt session canonical submission failed'; end if;

    update public.omr_attempt_sessions
       set status = 'submitted',
           submitted_attempt_id = v_session.attempt_id,
           submitted_at = v_now,
           updated_at = v_now
     where id = v_session.id;
    return query select v_payload, 'submitted'::text;
end;
$$;

revoke all on function public.omr_open_attempt_session_v1(
    text,text,text,text,text,text,text,text,text,text,text,integer[],integer[],timestamptz,jsonb,integer,timestamptz,text,text,integer
) from public, anon, authenticated;
grant execute on function public.omr_open_attempt_session_v1(
    text,text,text,text,text,text,text,text,text,text,text,integer[],integer[],timestamptz,jsonb,integer,timestamptz,text,text,integer
) to service_role;

revoke all on function public.omr_checkpoint_attempt_session_v1(
    text,text,text,bigint,bigint,text,jsonb,jsonb,jsonb,integer,boolean
) from public, anon, authenticated;
grant execute on function public.omr_checkpoint_attempt_session_v1(
    text,text,text,bigint,bigint,text,jsonb,jsonb,jsonb,integer,boolean
) to service_role;

revoke all on function public.omr_heartbeat_attempt_session_v1(
    text,text,text,bigint,text,integer
) from public, anon, authenticated;
grant execute on function public.omr_heartbeat_attempt_session_v1(
    text,text,text,bigint,text,integer
) to service_role;

revoke all on function public.omr_takeover_attempt_session_v1(
    text,text,text,bigint,bigint,text,integer
) from public, anon, authenticated;
grant execute on function public.omr_takeover_attempt_session_v1(
    text,text,text,bigint,bigint,text,integer
) to service_role;

revoke all on function public.omr_prepare_attempt_session_submit_v1(
    text,text,text,bigint,bigint,text
) from public, anon, authenticated;
grant execute on function public.omr_prepare_attempt_session_submit_v1(
    text,text,text,bigint,bigint,text
) to service_role;

revoke all on function public.omr_commit_attempt_session_submit_v1(
    text,text,text,bigint,bigint,text,jsonb,jsonb
) from public, anon, authenticated;
grant execute on function public.omr_commit_attempt_session_submit_v1(
    text,text,text,bigint,bigint,text,jsonb,jsonb
) to service_role;

-- Version the deployment probe without discarding any v6 evidence. The v6
-- exact-table check predates omr_attempt_sessions, so canonical FORCE RLS is
-- recomputed across every OMR table and the six service-only RPCs are added as
-- explicit continuity evidence.
alter function public.omr_service_readiness_v1()
    rename to omr_service_readiness_v7_snapshot;
revoke all on function public.omr_service_readiness_v7_snapshot()
    from public, anon, authenticated;
grant execute on function public.omr_service_readiness_v7_snapshot()
    to service_role;

create function public.omr_service_readiness_v1()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_previous jsonb;
    v_canonical_tables_force_rls boolean;
    v_attempt_sessions_ready boolean;
    v_server_gateway_capabilities_ready boolean;
    v_ready boolean;
begin
    v_previous := public.omr_service_readiness_v7_snapshot();

    with expected(table_name) as (
        values
            ('omr_organizations'), ('omr_plan_usage'), ('omr_plan_usage_reservations'),
            ('omr_user_profiles'), ('omr_organization_members'), ('omr_teacher_profiles'),
            ('omr_student_profiles'), ('omr_student_start_credentials'), ('omr_classes'),
            ('omr_roster_invites'), ('omr_class_teachers'), ('omr_class_students'),
            ('omr_materials'), ('omr_exams'), ('omr_exam_questions'),
            ('omr_exam_materials'), ('omr_assignments'), ('omr_assignment_targets'),
            ('omr_attempts'), ('omr_question_results'), ('omr_assignment_submissions'),
            ('omr_attempt_feedback'), ('omr_kakao_candidate_reviews'),
            ('omr_kakao_dispatch_logs'), ('omr_comments'), ('omr_audit_logs'),
            ('omr_remote_assets'), ('omr_remote_asset_upload_intents'),
            ('omr_remote_asset_cleanup_queue'), ('omr_attempt_sessions')
    ), actual(table_name, row_security, force_row_security) as (
        select relation.relname::text, relation.relrowsecurity, relation.relforcerowsecurity
          from pg_catalog.pg_class relation
          join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
         where namespace.nspname = 'public'
           and relation.relkind in ('r', 'p')
           and relation.relname like 'omr\_%' escape '\'
    )
    select not exists (select table_name from expected except select table_name from actual)
       and not exists (select table_name from actual except select table_name from expected)
       and not exists (select 1 from actual where not row_security or not force_row_security)
      into v_canonical_tables_force_rls;

    v_attempt_sessions_ready :=
        pg_catalog.to_regclass('public.omr_attempt_sessions') is not null
        and pg_catalog.to_regclass('public.omr_attempt_sessions_one_active_scope_idx') is not null
        and pg_catalog.to_regclass('public.omr_attempt_sessions_active_lease_idx') is not null
        and pg_catalog.to_regprocedure(
            'public.omr_open_attempt_session_v1(text,text,text,text,text,text,text,text,text,text,text,integer[],integer[],timestamp with time zone,jsonb,integer,timestamp with time zone,text,text,integer)'
        ) is not null
        and pg_catalog.to_regprocedure(
            'public.omr_checkpoint_attempt_session_v1(text,text,text,bigint,bigint,text,jsonb,jsonb,jsonb,integer,boolean)'
        ) is not null
        and pg_catalog.to_regprocedure(
            'public.omr_heartbeat_attempt_session_v1(text,text,text,bigint,text,integer)'
        ) is not null
        and pg_catalog.to_regprocedure(
            'public.omr_takeover_attempt_session_v1(text,text,text,bigint,bigint,text,integer)'
        ) is not null
        and pg_catalog.to_regprocedure(
            'public.omr_prepare_attempt_session_submit_v1(text,text,text,bigint,bigint,text)'
        ) is not null
        and pg_catalog.to_regprocedure(
            'public.omr_commit_attempt_session_submit_v1(text,text,text,bigint,bigint,text,jsonb,jsonb)'
        ) is not null
        and pg_catalog.to_regprocedure(
            'public.omr_prepare_attempt_handwriting_asset_v1(text,jsonb)'
        ) is not null
        and pg_catalog.to_regprocedure(
            'public.omr_discard_attempt_handwriting_asset_v1(text,text)'
        ) is not null
        and pg_catalog.to_regprocedure(
            'public.omr_authorize_remote_asset_cleanup_delete_v1(text,text,integer)'
        ) is not null
        and pg_catalog.to_regprocedure(
            'public.omr_ack_remote_asset_cleanup_v1(text,text,integer)'
        ) is not null
        and pg_catalog.to_regprocedure(
            'public.omr_fail_remote_asset_cleanup_v1(text,text,integer,text)'
        ) is not null
        and not pg_catalog.has_table_privilege('anon', 'public.omr_attempt_sessions', 'SELECT')
        and not pg_catalog.has_table_privilege('authenticated', 'public.omr_attempt_sessions', 'SELECT')
        and not exists (
            select 1
              from pg_catalog.pg_proc routine
              join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
             where namespace.nspname = 'public'
               and routine.proname in (
                   'omr_open_attempt_session_v1',
                   'omr_checkpoint_attempt_session_v1',
                   'omr_heartbeat_attempt_session_v1',
                   'omr_takeover_attempt_session_v1',
                   'omr_prepare_attempt_session_submit_v1',
                   'omr_commit_attempt_session_submit_v1',
                   'omr_prepare_attempt_handwriting_asset_v1',
                   'omr_discard_attempt_handwriting_asset_v1',
                   'omr_authorize_remote_asset_cleanup_delete_v1',
                   'omr_ack_remote_asset_cleanup_v1',
                   'omr_fail_remote_asset_cleanup_v1'
               )
               and (
                   not pg_catalog.has_function_privilege('service_role', routine.oid, 'EXECUTE')
                   or pg_catalog.has_function_privilege('anon', routine.oid, 'EXECUTE')
                   or pg_catalog.has_function_privilege('authenticated', routine.oid, 'EXECUTE')
               )
        );

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
        ('omr_ack_remote_asset_cleanup_v1', 'text, text, integer'),
        ('omr_fail_remote_asset_cleanup_v1', 'text, text, text'),
        ('omr_fail_remote_asset_cleanup_v1', 'text, text, integer, text'),
        ('omr_authorize_remote_asset_cleanup_delete_v1', 'text, text, integer'),
        ('omr_authorize_teacher_asset_finalize_v1', 'text, text, text, jsonb'),
        ('omr_open_attempt_session_v1', 'text, text, text, text, text, text, text, text, text, text, text, integer[], integer[], timestamp with time zone, jsonb, integer, timestamp with time zone, text, text, integer'),
        ('omr_checkpoint_attempt_session_v1', 'text, text, text, bigint, bigint, text, jsonb, jsonb, jsonb, integer, boolean'),
        ('omr_heartbeat_attempt_session_v1', 'text, text, text, bigint, text, integer'),
        ('omr_takeover_attempt_session_v1', 'text, text, text, bigint, bigint, text, integer'),
        ('omr_prepare_attempt_session_submit_v1', 'text, text, text, bigint, bigint, text'),
        ('omr_commit_attempt_session_submit_v1', 'text, text, text, bigint, bigint, text, jsonb, jsonb'),
        ('omr_prepare_attempt_handwriting_asset_v1', 'text, jsonb'),
        ('omr_discard_attempt_handwriting_asset_v1', 'text, text')
    ), actual(name, args) as (
        select routine.proname::text, pg_catalog.oidvectortypes(routine.proargtypes)
          from pg_catalog.pg_proc routine
          join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
         where namespace.nspname = 'public' and routine.prokind = 'f'
           and routine.proname in (select expected.name from expected)
    )
    select v_attempt_sessions_ready
       and not exists (select name, args from expected except select name, args from actual)
       and not exists (select name, args from actual except select name, args from expected)
      into v_server_gateway_capabilities_ready;
    v_ready := v_canonical_tables_force_rls
        and v_server_gateway_capabilities_ready
        and not exists (
            select 1
              from pg_catalog.jsonb_each(v_previous
                  - 'version' - 'ready' - 'canonicalTablesForceRls'
                  - 'serverGatewayCapabilitiesReady') item
             where item.value is distinct from 'true'::jsonb
        );

    return (v_previous - 'version' - 'ready' - 'canonicalTablesForceRls'
            - 'serverGatewayCapabilitiesReady')
        || pg_catalog.jsonb_build_object(
            'version', '202608060007',
            'canonicalTablesForceRls', v_canonical_tables_force_rls,
            'serverGatewayCapabilitiesReady', v_server_gateway_capabilities_ready,
            'studentAttemptSessionsReady', v_attempt_sessions_ready,
            'ready', v_ready
        );
end;
$$;

revoke all on function public.omr_service_readiness_v1()
    from public, anon, authenticated;
grant execute on function public.omr_service_readiness_v1()
    to service_role;

commit;
