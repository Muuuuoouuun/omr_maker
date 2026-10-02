begin;

-- Storage bytes are uploaded by the browser with a server-minted signed token.
-- This service-only ledger makes prepare/finalize retries deterministic without
-- creating a provisional exam row or mutating Supabase-managed Storage tables.
create table if not exists public.omr_remote_asset_upload_intents (
    id text primary key,
    organization_id text not null references public.omr_organizations(id) on delete cascade,
    exam_id text not null,
    kind text not null,
    created_by_user_id text not null,
    idempotency_key text not null,
    storage_bucket text not null default 'omr-private-assets',
    object_path text not null,
    mime_type text not null,
    byte_size bigint not null,
    sha256_hex text not null,
    original_name text,
    status text not null default 'pending',
    expires_at timestamptz not null,
    uploaded_at timestamptz,
    finalized_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint omr_remote_asset_upload_intents_kind_check
        check (kind in ('problem_pdf', 'answer_key_pdf')),
    constraint omr_remote_asset_upload_intents_status_check
        check (status in ('pending', 'uploaded', 'finalized', 'expired')),
    constraint omr_remote_asset_upload_intents_id_check
        check (id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
    constraint omr_remote_asset_upload_intents_exam_id_check
        check (exam_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
    constraint omr_remote_asset_upload_intents_actor_check
        check (btrim(created_by_user_id) <> '' and length(created_by_user_id) <= 200),
    constraint omr_remote_asset_upload_intents_idempotency_check
        check (btrim(idempotency_key) <> '' and length(idempotency_key) <= 200),
    constraint omr_remote_asset_upload_intents_bucket_check
        check (storage_bucket = 'omr-private-assets'),
    constraint omr_remote_asset_upload_intents_mime_check
        check (mime_type = 'application/pdf'),
    constraint omr_remote_asset_upload_intents_size_check
        check (byte_size > 0 and byte_size <= 52428800),
    constraint omr_remote_asset_upload_intents_sha_check
        check (sha256_hex ~ '^[a-f0-9]{64}$'),
    constraint omr_remote_asset_upload_intents_expiry_check
        check (expires_at > created_at and expires_at <= created_at + interval '2 hours'),
    constraint omr_remote_asset_upload_intents_path_check check (
        object_path = (
            'organizations/' || organization_id || '/exams/' || exam_id
            || case
                when kind = 'problem_pdf' then '/problem/'
                else '/answer-key/'
            end
            || id || '.pdf'
        )
        and position('..' in object_path) = 0
        and position(chr(92) in object_path) = 0
    ),
    constraint omr_remote_asset_upload_intents_idempotency_uidx
        unique (organization_id, created_by_user_id, idempotency_key),
    constraint omr_remote_asset_upload_intents_object_path_uidx
        unique (storage_bucket, object_path)
);

create index omr_remote_asset_upload_intents_gc_idx
    on public.omr_remote_asset_upload_intents (status, expires_at, id)
    where status in ('pending', 'uploaded');

create index omr_remote_asset_upload_intents_exam_idx
    on public.omr_remote_asset_upload_intents
        (organization_id, exam_id, status, kind, id);

alter table public.omr_remote_asset_upload_intents enable row level security;
alter table public.omr_remote_asset_upload_intents force row level security;
revoke all on table public.omr_remote_asset_upload_intents from public, anon, authenticated;
grant select, insert, update, delete on table public.omr_remote_asset_upload_intents to service_role;

comment on table public.omr_remote_asset_upload_intents is
    'Service-only direct-upload lifecycle. Storage object verification happens in the application before finalize.';

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
begin
    if pg_catalog.jsonb_typeof(p_upload) is distinct from 'object' then
        raise exception 'upload must be an object';
    end if;

    select * into v_upload
      from pg_catalog.jsonb_populate_record(
          null::public.omr_remote_asset_upload_intents,
          p_upload
      );

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
          from public.omr_organizations organization
         where organization.id = v_upload.organization_id
    ) then
        raise exception 'upload organization does not exist';
    end if;
    if exists (
        select 1
          from public.omr_exams exam
         where exam.id = v_upload.exam_id
           and exam.organization_id is distinct from v_upload.organization_id
    ) then
        raise exception 'upload exam identifier belongs to another organization';
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
    )
    on conflict (organization_id, created_by_user_id, idempotency_key)
    do update set updated_at = public.omr_remote_asset_upload_intents.updated_at
    where public.omr_remote_asset_upload_intents.id = excluded.id
      and public.omr_remote_asset_upload_intents.exam_id = excluded.exam_id
      and public.omr_remote_asset_upload_intents.kind = excluded.kind
      and public.omr_remote_asset_upload_intents.storage_bucket = excluded.storage_bucket
      and public.omr_remote_asset_upload_intents.object_path = excluded.object_path
      and public.omr_remote_asset_upload_intents.mime_type = excluded.mime_type
      and public.omr_remote_asset_upload_intents.byte_size = excluded.byte_size
      and public.omr_remote_asset_upload_intents.sha256_hex = excluded.sha256_hex
      and public.omr_remote_asset_upload_intents.original_name is not distinct from excluded.original_name
    returning * into v_stored;

    if not found then
        raise exception 'upload idempotency key belongs to another request';
    end if;
    if v_stored.status = 'expired' or v_stored.expires_at <= now() then
        raise exception 'teacher upload intent expired; use a fresh idempotency key';
    end if;

    return pg_catalog.to_jsonb(v_stored);
end;
$$;

create or replace function public.omr_finalize_teacher_asset_upload_v1(
    p_organization_id text,
    p_upload_id text,
    p_created_by_user_id text,
    p_observation jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_intent public.omr_remote_asset_upload_intents%rowtype;
    v_bucket text;
    v_path text;
    v_mime text;
    v_bytes bigint;
    v_sha text;
begin
    if nullif(pg_catalog.btrim(p_organization_id), '') is null
       or nullif(pg_catalog.btrim(p_upload_id), '') is null
       or nullif(pg_catalog.btrim(p_created_by_user_id), '') is null
       or pg_catalog.jsonb_typeof(p_observation) is distinct from 'object' then
        raise exception 'invalid teacher upload finalization';
    end if;

    v_bucket := p_observation ->> 'storage_bucket';
    v_path := p_observation ->> 'object_path';
    v_mime := p_observation ->> 'mime_type';
    begin
        v_bytes := (p_observation ->> 'byte_size')::bigint;
    exception when invalid_text_representation or numeric_value_out_of_range then
        raise exception 'storage observation mismatch';
    end;
    v_sha := p_observation ->> 'sha256_hex';

    select * into v_intent
      from public.omr_remote_asset_upload_intents intent
     where intent.id = pg_catalog.btrim(p_upload_id)
       and intent.organization_id = pg_catalog.btrim(p_organization_id)
       and intent.created_by_user_id = pg_catalog.btrim(p_created_by_user_id)
     for update;
    if not found then
        raise exception 'teacher upload intent is outside actor scope';
    end if;
    if v_intent.status = 'expired' or (
        v_intent.status in ('pending', 'uploaded') and v_intent.expires_at <= now()
    ) then
        raise exception 'teacher upload intent expired';
    end if;
    if v_bucket is distinct from v_intent.storage_bucket
       or v_path is distinct from v_intent.object_path
       or v_mime is distinct from v_intent.mime_type
       or v_bytes is distinct from v_intent.byte_size
       or v_sha is distinct from v_intent.sha256_hex then
        raise exception 'storage observation mismatch';
    end if;

    if v_intent.status = 'pending' then
        update public.omr_remote_asset_upload_intents intent
           set status = 'uploaded', uploaded_at = now(), updated_at = now()
         where intent.id = v_intent.id
        returning * into v_intent;
    end if;

    return pg_catalog.to_jsonb(v_intent);
end;
$$;

revoke all on function public.omr_prepare_teacher_asset_upload_v1(jsonb) from public, anon, authenticated;
grant execute on function public.omr_prepare_teacher_asset_upload_v1(jsonb) to service_role;
revoke all on function public.omr_finalize_teacher_asset_upload_v1(text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.omr_finalize_teacher_asset_upload_v1(text, text, text, jsonb) to service_role;

-- PostgreSQL cannot change a function signature with CREATE OR REPLACE. The
-- default keeps existing two-argument callers working while direct-upload
-- callers pass the third intent-id array.
drop function public.omr_save_exam_v1(jsonb, jsonb);

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
declare
    v_exam public.omr_exams%rowtype;
    v_plan text;
    v_is_new boolean;
    v_has_subquestions boolean := false;
    v_period_start date;
    v_period_start_at timestamptz;
    v_period_end_at timestamptz;
    v_observed_used integer;
    v_allowed boolean;
    v_saved jsonb;
    v_remote_ref_count integer;
begin
    if pg_catalog.jsonb_typeof(p_exam) is distinct from 'object' then
        raise exception 'exam must be an object';
    end if;
    if pg_catalog.jsonb_typeof(p_questions) is distinct from 'array' then
        raise exception 'questions must be an array';
    end if;
    if pg_catalog.jsonb_typeof(p_teacher_asset_intent_ids) is distinct from 'array'
       or pg_catalog.jsonb_array_length(p_teacher_asset_intent_ids) > 2
       or exists (
           select 1
             from pg_catalog.jsonb_array_elements(p_teacher_asset_intent_ids) item
            where pg_catalog.jsonb_typeof(item) is distinct from 'string'
       ) then
        raise exception 'teacher asset intent ids must be a string array of at most two items';
    end if;

    select * into v_exam
      from pg_catalog.jsonb_populate_record(null::public.omr_exams, p_exam);
    if nullif(pg_catalog.btrim(v_exam.id), '') is null
       or nullif(pg_catalog.btrim(v_exam.organization_id), '') is null
       or v_exam.payload is null then
        raise exception 'invalid canonical exam';
    end if;

    if v_exam.payload ? 'pdfData' or v_exam.payload ? 'answerKeyPdf' then
        raise exception 'inline PDF data is forbidden in canonical exam payload';
    end if;
    if pg_catalog.jsonb_array_length(p_teacher_asset_intent_ids) > 0
       and nullif(pg_catalog.btrim(p_asset_actor_user_id), '') is null then
        raise exception 'asset actor is required';
    end if;

    if (
        select count(*)
          from pg_catalog.jsonb_array_elements_text(p_teacher_asset_intent_ids) item
    ) <> (
        select count(distinct item)
          from pg_catalog.jsonb_array_elements_text(p_teacher_asset_intent_ids) item
    ) then
        raise exception 'duplicate teacher asset intent id';
    end if;

    -- The supplied ids are exactly the two possible remote PDF refs. This
    -- prevents an uploaded object from being promoted under an unrelated
    -- canonical payload and prevents an unregistered ref from being smuggled
    -- into the exam JSON.
    select count(*)::integer into v_remote_ref_count
      from (
          values
              ('problem_pdf'::text, v_exam.payload -> 'pdfDataRef'),
              ('answer_key_pdf'::text, v_exam.payload -> 'answerKeyPdfRef')
      ) expected(kind, ref)
     where pg_catalog.jsonb_typeof(expected.ref) = 'object'
       and expected.ref ->> 'store' = 'remote';

    if v_remote_ref_count <> pg_catalog.jsonb_array_length(p_teacher_asset_intent_ids)
       or exists (
           select 1
             from pg_catalog.jsonb_array_elements_text(p_teacher_asset_intent_ids) supplied(value)
            where not exists (
                select 1
                  from (
                      values
                          ('problem_pdf'::text, v_exam.payload -> 'pdfDataRef'),
                          ('answer_key_pdf'::text, v_exam.payload -> 'answerKeyPdfRef')
                  ) expected(kind, ref)
                 where pg_catalog.jsonb_typeof(expected.ref) = 'object'
                   and expected.ref ->> 'store' = 'remote'
                   and expected.ref ->> 'key' = supplied.value
            )
       )
       or exists (
           select 1
             from (
                 values
                     ('problem_pdf'::text, v_exam.payload -> 'pdfDataRef'),
                     ('answer_key_pdf'::text, v_exam.payload -> 'answerKeyPdfRef')
             ) expected(kind, ref)
            where pg_catalog.jsonb_typeof(expected.ref) = 'object'
              and expected.ref ->> 'store' = 'remote'
              and (
                  nullif(expected.ref ->> 'key', '') is null
                  or expected.ref ->> 'organizationId' is distinct from v_exam.organization_id
                  or expected.ref ->> 'examId' is distinct from v_exam.id
                  or expected.ref ->> 'kind' is distinct from expected.kind
                  or expected.ref ->> 'mimeType' is distinct from 'application/pdf'
                  or pg_catalog.jsonb_typeof(expected.ref -> 'size') is distinct from 'number'
                  or not exists (
                      select 1
                        from pg_catalog.jsonb_array_elements_text(p_teacher_asset_intent_ids) supplied(value)
                       where supplied.value = expected.ref ->> 'key'
                  )
              )
       ) then
        raise exception 'teacher asset refs do not match supplied intent ids';
    end if;

    -- Lock before the canonical write. A concurrent finalize/save cannot move
    -- or reuse an intent between validation and promotion.
    perform 1
      from public.omr_remote_asset_upload_intents intent
     where intent.id in (
         select value
           from pg_catalog.jsonb_array_elements_text(p_teacher_asset_intent_ids)
     )
     for update;

    if exists (
        select 1
          from (
              values
                  ('problem_pdf'::text, v_exam.payload -> 'pdfDataRef'),
                  ('answer_key_pdf'::text, v_exam.payload -> 'answerKeyPdfRef')
          ) expected(kind, ref)
         where pg_catalog.jsonb_typeof(expected.ref) = 'object'
           and expected.ref ->> 'store' = 'remote'
           and not exists (
               select 1
                 from public.omr_remote_assets asset
                where asset.id = expected.ref ->> 'key'
                  and asset.organization_id = v_exam.organization_id
                  and asset.exam_id = v_exam.id
                  and asset.kind = expected.kind
                  and asset.storage_bucket = 'omr-private-assets'
                  and asset.mime_type = 'application/pdf'
                  and pg_catalog.to_jsonb(asset.byte_size) = expected.ref -> 'size'
           )
           and not exists (
               select 1
                 from public.omr_remote_asset_upload_intents intent
                where intent.id = expected.ref ->> 'key'
                  and intent.organization_id = v_exam.organization_id
                  and intent.exam_id = v_exam.id
                  and intent.kind = expected.kind
                  and intent.created_by_user_id = pg_catalog.btrim(p_asset_actor_user_id)
                  and pg_catalog.to_jsonb(intent.byte_size) = expected.ref -> 'size'
                  and intent.status in ('uploaded', 'finalized')
                  and (intent.status = 'finalized' or intent.expires_at > now())
           )
    ) then
        raise exception 'teacher asset intent is not ready';
    end if;

    select organization.plan into v_plan
      from public.omr_organizations organization
     where organization.id = v_exam.organization_id;
    if v_plan is null then
        raise exception 'exam organization does not exist';
    end if;

    if pg_catalog.jsonb_typeof(v_exam.payload -> 'questions') = 'array' then
        select exists (
            select 1
              from pg_catalog.jsonb_array_elements(v_exam.payload -> 'questions') question
             where pg_catalog.jsonb_typeof(question -> 'subQuestions') = 'array'
               and pg_catalog.jsonb_array_length(question -> 'subQuestions') > 0
        ) into v_has_subquestions;
    end if;
    if v_plan = 'free' and v_has_subquestions then
        raise exception 'plan entitlement required';
    end if;

    select not exists (
        select 1 from public.omr_exams exam where exam.id = v_exam.id
    ) into v_is_new;

    if v_is_new and v_plan = 'free' then
        v_period_start := pg_catalog.date_trunc(
            'month', pg_catalog.timezone('Asia/Seoul', now())
        )::date;
        v_period_start_at := v_period_start::timestamp at time zone 'Asia/Seoul';
        v_period_end_at := (v_period_start + interval '1 month')::timestamp at time zone 'Asia/Seoul';

        select count(*)::integer into v_observed_used
          from public.omr_exams exam
         where exam.organization_id = v_exam.organization_id
           and exam.created_at >= v_period_start_at
           and exam.created_at < v_period_end_at;

        select reservation.allowed into v_allowed
          from public.omr_reserve_plan_usage(
              v_exam.organization_id,
              'exams',
              v_period_start,
              'exam:' || v_exam.id,
              1,
              v_observed_used,
              5
          ) reservation;
        if not coalesce(v_allowed, false) then
            raise exception 'plan exam limit exceeded';
        end if;
    end if;

    v_saved := public.omr_save_exam_plan_unlocked_v1(p_exam, p_questions);

    insert into public.omr_remote_assets (
        id, organization_id, kind, exam_id, attempt_id, storage_bucket,
        object_path, mime_type, byte_size, sha256_hex, original_name,
        created_by_user_id, created_at, updated_at
    )
    select
        intent.id, intent.organization_id, intent.kind, intent.exam_id, null,
        intent.storage_bucket, intent.object_path, intent.mime_type,
        intent.byte_size, intent.sha256_hex, intent.original_name,
        intent.created_by_user_id, intent.created_at, now()
      from public.omr_remote_asset_upload_intents intent
     where intent.id in (
         select value
           from pg_catalog.jsonb_array_elements_text(p_teacher_asset_intent_ids)
     )
    on conflict (id) do nothing;

    if exists (
        select 1
          from public.omr_remote_asset_upload_intents intent
          left join public.omr_remote_assets asset on asset.id = intent.id
         where intent.id in (
             select value
               from pg_catalog.jsonb_array_elements_text(p_teacher_asset_intent_ids)
         )
           and (
               asset.id is null
               or asset.organization_id is distinct from intent.organization_id
               or asset.exam_id is distinct from intent.exam_id
               or asset.kind is distinct from intent.kind
               or asset.storage_bucket is distinct from intent.storage_bucket
               or asset.object_path is distinct from intent.object_path
               or asset.mime_type is distinct from intent.mime_type
               or asset.byte_size is distinct from intent.byte_size
               or asset.sha256_hex is distinct from intent.sha256_hex
           )
    ) then
        raise exception 'teacher asset identifier belongs to another scope';
    end if;

    update public.omr_remote_asset_upload_intents intent
       set status = 'finalized', finalized_at = coalesce(finalized_at, now()),
           updated_at = now()
     where intent.id in (
         select value
           from pg_catalog.jsonb_array_elements_text(p_teacher_asset_intent_ids)
     );

    return v_saved;
end;
$$;

revoke all on function public.omr_save_exam_v1(jsonb, jsonb, jsonb, text) from public, anon, authenticated;
grant execute on function public.omr_save_exam_v1(jsonb, jsonb, jsonb, text) to service_role;

-- Preserve the audited v4 checks as a private service-only snapshot and layer
-- the intentional table/RPC catalog expansion on top. This avoids weakening
-- any existing production-boundary drift signal.
alter function public.omr_service_readiness_v1()
    rename to omr_service_readiness_v4_snapshot;
revoke all on function public.omr_service_readiness_v4_snapshot()
    from public, anon, authenticated;
grant execute on function public.omr_service_readiness_v4_snapshot()
    to service_role;

create function public.omr_service_readiness_v1()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_previous jsonb;
    v_canonical_tables_force_rls boolean := false;
    v_server_gateway_capabilities_ready boolean := false;
    v_direct_upload_intent_lifecycle_ready boolean := false;
    v_ready boolean := false;
begin
    v_previous := public.omr_service_readiness_v4_snapshot();

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
            ('omr_remote_assets'),
            ('omr_remote_asset_upload_intents')
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
            select table_name from expected_canonical_tables
            except
            select table_name from actual_canonical_tables
        )
        and not exists (
            select table_name from actual_canonical_tables
            except
            select table_name from expected_canonical_tables
        )
        and not exists (
            select 1 from actual_canonical_tables
             where not row_security or not force_row_security
        )
      into v_canonical_tables_force_rls;

    with expected_server_gateways(routine_name, identity_arguments) as (
        values
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
            ('omr_finalize_teacher_asset_upload_v1', 'text, text, text, jsonb')
    ),
    actual_server_gateways(routine_name, identity_arguments) as (
        select
            routine.proname::text,
            pg_catalog.oidvectortypes(routine.proargtypes)
          from pg_catalog.pg_proc routine
          join pg_catalog.pg_namespace namespace
            on namespace.oid = routine.pronamespace
         where namespace.nspname = 'public'
           and routine.prokind = 'f'
           and routine.proname in (
               'omr_submit_attempt_v1',
               'omr_submit_session_attempt_v1',
               'omr_save_exam_v1',
               'omr_delete_exam_v1',
               'omr_save_roster_v1',
               'omr_attach_attempt_handwriting_v1',
               'omr_save_feedback_v1',
               'omr_return_feedback_v1',
               'omr_mark_feedback_opened_v2',
               'omr_save_remote_asset_metadata_v1',
               'omr_claim_guest_attempts_v1',
               'omr_prepare_teacher_asset_upload_v1',
               'omr_finalize_teacher_asset_upload_v1'
           )
    )
    select
        not exists (
            select routine_name, identity_arguments from expected_server_gateways
            except
            select routine_name, identity_arguments from actual_server_gateways
        )
        and not exists (
            select routine_name, identity_arguments from actual_server_gateways
            except
            select routine_name, identity_arguments from expected_server_gateways
        )
      into v_server_gateway_capabilities_ready;

    v_direct_upload_intent_lifecycle_ready :=
        pg_catalog.to_regclass('public.omr_remote_asset_upload_intents') is not null
        and pg_catalog.to_regclass('public.omr_remote_asset_upload_intents_gc_idx') is not null
        and pg_catalog.to_regclass('public.omr_remote_asset_upload_intents_exam_idx') is not null
        and pg_catalog.to_regprocedure(
            'public.omr_prepare_teacher_asset_upload_v1(jsonb)'
        ) is not null
        and pg_catalog.to_regprocedure(
            'public.omr_finalize_teacher_asset_upload_v1(text,text,text,jsonb)'
        ) is not null
        and pg_catalog.has_function_privilege(
            'service_role',
            'public.omr_prepare_teacher_asset_upload_v1(jsonb)',
            'EXECUTE'
        )
        and pg_catalog.has_function_privilege(
            'service_role',
            'public.omr_finalize_teacher_asset_upload_v1(text,text,text,jsonb)',
            'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
            'anon',
            'public.omr_prepare_teacher_asset_upload_v1(jsonb)',
            'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
            'authenticated',
            'public.omr_prepare_teacher_asset_upload_v1(jsonb)',
            'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
            'anon',
            'public.omr_finalize_teacher_asset_upload_v1(text,text,text,jsonb)',
            'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
            'authenticated',
            'public.omr_finalize_teacher_asset_upload_v1(text,text,text,jsonb)',
            'EXECUTE'
        );

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
        and v_direct_upload_intent_lifecycle_ready;

    return (
        v_previous
        - 'version'
        - 'canonicalTablesForceRls'
        - 'serverGatewayCapabilitiesReady'
        - 'ready'
    ) || pg_catalog.jsonb_build_object(
        'version', '202608060004',
        'canonicalTablesForceRls', v_canonical_tables_force_rls,
        'serverGatewayCapabilitiesReady', v_server_gateway_capabilities_ready,
        'directUploadIntentLifecycleReady', v_direct_upload_intent_lifecycle_ready,
        'ready', v_ready
    );
end;
$$;

revoke all on function public.omr_service_readiness_v1()
    from public, anon, authenticated;
grant execute on function public.omr_service_readiness_v1()
    to service_role;

commit;
