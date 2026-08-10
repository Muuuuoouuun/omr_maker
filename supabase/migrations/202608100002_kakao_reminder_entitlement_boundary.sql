begin;

set local lock_timeout = '2s';

lock table public.omr_kakao_candidate_reviews in access exclusive mode;
lock table public.omr_kakao_dispatch_logs in access exclusive mode;

do $kakao_owner_and_overload_preflight$
begin
    if not exists (
        select 1
          from pg_catalog.pg_roles owner_role
         where owner_role.rolname = 'postgres'
           and (owner_role.rolsuper or owner_role.rolbypassrls)
    ) then
        raise exception 'Kakao reminder definer must bypass forced RLS';
    end if;
    if exists (
        select 1
          from pg_catalog.pg_proc routine
          join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
         where namespace.nspname = 'public'
           and routine.proname in (
               'omr_save_kakao_candidate_review_v1',
               'omr_save_kakao_simulation_dispatch_v1',
               'omr_kakao_reminder_legacy_inventory_v1',
               'omr_quarantine_kakao_reminder_legacy_v1',
               'omr_kakao_reminder_entitlement_ready_v1'
           )
    ) then
        raise exception 'Kakao reminder RPC overload preflight failed';
    end if;
end
$kakao_owner_and_overload_preflight$;

alter table public.omr_kakao_candidate_reviews
    add column if not exists entitlement_state text not null default 'legacy_unreconciled';
alter table public.omr_kakao_dispatch_logs
    add column if not exists entitlement_state text not null default 'legacy_unreconciled';

alter table public.omr_kakao_candidate_reviews
    add constraint omr_kakao_candidate_reviews_entitlement_state_check
    check (entitlement_state in ('legacy_unreconciled', 'validated_legacy', 'quarantined', 'trusted'));
alter table public.omr_kakao_dispatch_logs
    add constraint omr_kakao_dispatch_logs_entitlement_state_check
    check (entitlement_state in ('legacy_unreconciled', 'validated_legacy', 'quarantined', 'trusted'));

create table public.omr_kakao_reminder_legacy_quarantine (
    source_table text not null check (
        source_table in ('omr_kakao_candidate_reviews', 'omr_kakao_dispatch_logs')
    ),
    source_id text not null,
    organization_id text,
    row_snapshot jsonb not null,
    reason text not null,
    inventoried_at timestamptz not null default pg_catalog.clock_timestamp(),
    primary key (source_table, source_id)
);
comment on table public.omr_kakao_reminder_legacy_quarantine is
    'Kakao legacy forensic evidence is retained until explicit operator deletion; no TTL or automatic purge applies.';
alter table public.omr_kakao_reminder_legacy_quarantine enable row level security;
alter table public.omr_kakao_reminder_legacy_quarantine force row level security;
create policy "Kakao reminder quarantine service read"
    on public.omr_kakao_reminder_legacy_quarantine
    for select
    to service_role
    using (current_user = 'service_role');
revoke all on table public.omr_kakao_reminder_legacy_quarantine
    from public, anon, authenticated, service_role;
grant select on table public.omr_kakao_reminder_legacy_quarantine to service_role;

create index omr_kakao_candidate_reviews_unreconciled_idx
    on public.omr_kakao_candidate_reviews (id)
    where entitlement_state = 'legacy_unreconciled';
create index omr_kakao_dispatch_logs_unreconciled_idx
    on public.omr_kakao_dispatch_logs (id)
    where entitlement_state = 'legacy_unreconciled';

-- Existing rows are never inferred to have paid-plan provenance. Rows whose
-- tenant/exam linkage is objectively self-consistent are preserved read-only as
-- validated legacy evidence; they are never mutable through the new RPCs.
update public.omr_kakao_candidate_reviews review
   set entitlement_state = 'validated_legacy'
  from public.omr_exams exam
 where review.entitlement_state = 'legacy_unreconciled'
   and review.organization_id is not null
   and exam.id = review.exam_id
   and exam.organization_id = review.organization_id
   and review.channel = 'kakao'
   and nullif(pg_catalog.btrim(review.id), '') is not null
   and pg_catalog.octet_length(review.id) <= 256
   and review.target_count between 0 and 100
   and pg_catalog.cardinality(review.student_ids) = review.target_count
   and pg_catalog.cardinality(review.student_names) = review.target_count
   and pg_catalog.cardinality(review.group_names) <= 100
   and pg_catalog.cardinality(review.region_names) <= 100
   and nullif(pg_catalog.btrim(review.title), '') is not null
   and pg_catalog.octet_length(review.title) <= 512
   and nullif(pg_catalog.btrim(review.message_preview), '') is not null
   and pg_catalog.octet_length(review.message_preview) <= 4096
   and nullif(pg_catalog.btrim(review.reviewed_by_user_id), '') is not null;

update public.omr_kakao_dispatch_logs dispatch
   set entitlement_state = 'validated_legacy'
  from public.omr_kakao_candidate_reviews review,
       public.omr_exams exam
 where dispatch.entitlement_state = 'legacy_unreconciled'
   and dispatch.organization_id is not null
   and dispatch.review_id is not null
   and dispatch.exam_id is not null
   and review.id = dispatch.review_id
   and review.organization_id = dispatch.organization_id
   and review.exam_id = dispatch.exam_id
   and review.entitlement_state in ('trusted', 'validated_legacy')
   and exam.id = dispatch.exam_id
   and exam.organization_id = dispatch.organization_id
   and dispatch.channel = 'kakao'
   and dispatch.provider = 'simulation'
   and dispatch.target_count = review.target_count
   and dispatch.student_ids = review.student_ids
   and dispatch.message_preview = review.message_preview;

insert into public.omr_kakao_reminder_legacy_quarantine (
    source_table, source_id, organization_id, row_snapshot, reason
)
select 'omr_kakao_candidate_reviews', review.id, review.organization_id,
       pg_catalog.to_jsonb(review), 'ambiguous tenant, exam, or legacy provenance'
  from public.omr_kakao_candidate_reviews review
 where review.entitlement_state = 'legacy_unreconciled'
on conflict (source_table, source_id) do nothing;

insert into public.omr_kakao_reminder_legacy_quarantine (
    source_table, source_id, organization_id, row_snapshot, reason
)
select 'omr_kakao_dispatch_logs', dispatch.id, dispatch.organization_id,
       pg_catalog.to_jsonb(dispatch), 'ambiguous review, exam, tenant, or legacy provenance'
  from public.omr_kakao_dispatch_logs dispatch
 where dispatch.entitlement_state = 'legacy_unreconciled'
on conflict (source_table, source_id) do nothing;

alter table public.omr_kakao_candidate_reviews
    add constraint omr_kakao_candidate_reviews_trusted_scope_check
    check (
        entitlement_state <> 'trusted'
        or (organization_id is not null and reviewed_by_user_id is not null)
    ) not valid;
alter table public.omr_kakao_candidate_reviews
    validate constraint omr_kakao_candidate_reviews_trusted_scope_check;
alter table public.omr_kakao_dispatch_logs
    add constraint omr_kakao_dispatch_logs_trusted_scope_check
    check (
        entitlement_state <> 'trusted'
        or (
            organization_id is not null
            and review_id is not null
            and exam_id is not null
            and provider = 'simulation'
        )
    ) not valid;
alter table public.omr_kakao_dispatch_logs
    validate constraint omr_kakao_dispatch_logs_trusted_scope_check;

-- New trusted dispatches keep immutable review/exam bindings. NOT VALID avoids
-- rejecting preserved ambiguous legacy rows while enforcing every later write.
alter table public.omr_kakao_dispatch_logs
    drop constraint if exists omr_kakao_dispatch_logs_review_id_fkey,
    drop constraint if exists omr_kakao_dispatch_logs_exam_id_fkey;
alter table public.omr_kakao_dispatch_logs
    add constraint omr_kakao_dispatch_logs_review_id_fkey
        foreign key (review_id) references public.omr_kakao_candidate_reviews(id)
        on delete restrict not valid,
    add constraint omr_kakao_dispatch_logs_exam_id_fkey
        foreign key (exam_id) references public.omr_exams(id)
        on delete restrict not valid;

alter table public.omr_kakao_candidate_reviews enable row level security;
alter table public.omr_kakao_candidate_reviews force row level security;
alter table public.omr_kakao_dispatch_logs enable row level security;
alter table public.omr_kakao_dispatch_logs force row level security;
drop policy if exists "OMR Kakao candidate reviews are publicly writable"
    on public.omr_kakao_candidate_reviews;
drop policy if exists "OMR Kakao dispatch logs are publicly writable"
    on public.omr_kakao_dispatch_logs;
drop policy if exists "prod kakao reviews write by staff"
    on public.omr_kakao_candidate_reviews;
drop policy if exists "prod kakao logs write by staff"
    on public.omr_kakao_dispatch_logs;
drop policy if exists "Kakao reminder source reviews service read"
    on public.omr_kakao_candidate_reviews;
create policy "Kakao reminder source reviews service read"
    on public.omr_kakao_candidate_reviews
    for select
    to service_role
    using (entitlement_state in ('trusted', 'validated_legacy'));
drop policy if exists "Kakao reminder source dispatches service read"
    on public.omr_kakao_dispatch_logs;
create policy "Kakao reminder source dispatches service read"
    on public.omr_kakao_dispatch_logs
    for select
    to service_role
    using (entitlement_state in ('trusted', 'validated_legacy'));

create function public.omr_kakao_reminder_legacy_inventory_v1()
returns jsonb
language sql
security definer
set search_path = ''
set statement_timeout = '2s'
as $$
    select pg_catalog.jsonb_build_object(
        'reviewUnreconciled', (
            select pg_catalog.count(*) from public.omr_kakao_candidate_reviews
             where entitlement_state = 'legacy_unreconciled'
        ),
        'dispatchUnreconciled', (
            select pg_catalog.count(*) from public.omr_kakao_dispatch_logs
             where entitlement_state = 'legacy_unreconciled'
        ),
        'reviewValidatedLegacy', (
            select pg_catalog.count(*) from public.omr_kakao_candidate_reviews
             where entitlement_state = 'validated_legacy'
        ),
        'dispatchValidatedLegacy', (
            select pg_catalog.count(*) from public.omr_kakao_dispatch_logs
             where entitlement_state = 'validated_legacy'
        ),
        'quarantineInventory', (
            select pg_catalog.count(*) from public.omr_kakao_reminder_legacy_quarantine
        )
    )
$$;

create function public.omr_quarantine_kakao_reminder_legacy_v1(p_confirmation text)
returns jsonb
language plpgsql
security invoker
set search_path = ''
set statement_timeout = '5s'
set lock_timeout = '2s'
as $$
declare
    v_reviews bigint;
    v_dispatches bigint;
begin
    if current_user is distinct from 'postgres'
       or p_confirmation is distinct from 'quarantine_untrusted_kakao_reminder_rows' then
        raise exception using errcode = '42501',
            message = 'explicit postgres Kakao legacy reconciliation required';
    end if;
    lock table public.omr_kakao_candidate_reviews in access exclusive mode;
    lock table public.omr_kakao_dispatch_logs in access exclusive mode;
    update public.omr_kakao_candidate_reviews
       set entitlement_state = 'quarantined'
     where entitlement_state = 'legacy_unreconciled';
    get diagnostics v_reviews = row_count;
    update public.omr_kakao_dispatch_logs
       set entitlement_state = 'quarantined'
     where entitlement_state = 'legacy_unreconciled';
    get diagnostics v_dispatches = row_count;
    return pg_catalog.jsonb_build_object(
        'status', 'quarantined',
        'reviewCount', v_reviews,
        'dispatchCount', v_dispatches
    );
end
$$;

create function public.omr_kakao_reminder_entitlement_ready_v1()
returns boolean
language sql
security definer
set search_path = ''
set statement_timeout = '2s'
as $$
    select not exists (
        select 1 from public.omr_kakao_candidate_reviews
         where entitlement_state = 'legacy_unreconciled'
    ) and not exists (
        select 1 from public.omr_kakao_dispatch_logs
         where entitlement_state = 'legacy_unreconciled'
    )
$$;

alter function public.omr_kakao_reminder_legacy_inventory_v1() owner to postgres;
alter function public.omr_quarantine_kakao_reminder_legacy_v1(text) owner to postgres;
alter function public.omr_kakao_reminder_entitlement_ready_v1() owner to postgres;

revoke all on function public.omr_kakao_reminder_legacy_inventory_v1()
    from public, anon, authenticated, service_role;
grant execute on function public.omr_kakao_reminder_legacy_inventory_v1()
    to service_role;
revoke all on function public.omr_quarantine_kakao_reminder_legacy_v1(text)
    from public, anon, authenticated, service_role;
revoke all on function public.omr_kakao_reminder_entitlement_ready_v1()
    from public, anon, authenticated, service_role;
grant execute on function public.omr_kakao_reminder_entitlement_ready_v1()
    to service_role;

comment on function public.omr_kakao_reminder_legacy_inventory_v1()
    is 'kakao-reminder-entitlement:202608100002:legacy-inventory-counts';
comment on function public.omr_quarantine_kakao_reminder_legacy_v1(text)
    is 'kakao-reminder-entitlement:202608100002:explicit-postgres-quarantine';
comment on function public.omr_kakao_reminder_entitlement_ready_v1()
    is 'kakao-reminder-entitlement:202608100002:readiness';

create function public.omr_save_kakao_candidate_review_v1(
    p_session_authority text,
    p_account_id text,
    p_session_generation bigint,
    p_organization_id text,
    p_actor_user_id text,
    p_review jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
set lock_timeout = '2s'
as $$
declare
    v_identity jsonb;
    v_effective jsonb;
    v_plan text;
    v_exam public.omr_exams%rowtype;
    v_existing public.omr_kakao_candidate_reviews%rowtype;
    v_id text;
    v_exam_id text;
    v_candidate_kind text;
    v_status text;
    v_title text;
    v_target_count integer;
    v_student_ids text[];
    v_student_names text[];
    v_group_names text[];
    v_region_names text[];
    v_message_preview text;
    v_reason text;
    v_href text;
    v_now timestamptz;
begin
    if p_review is null
       or pg_catalog.jsonb_typeof(p_review) is distinct from 'object'
       or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(p_review)) <> 13
       or not p_review ?& array[
           'id', 'examId', 'candidateKind', 'status', 'title', 'targetCount',
           'studentIds', 'studentNames', 'groupNames', 'regionNames',
           'messagePreview', 'reason', 'href'
       ]
       or pg_catalog.octet_length(p_review::text) > 65536
       or pg_catalog.jsonb_typeof(p_review -> 'id') is distinct from 'string'
       or pg_catalog.jsonb_typeof(p_review -> 'examId') is distinct from 'string'
       or pg_catalog.jsonb_typeof(p_review -> 'candidateKind') is distinct from 'string'
       or pg_catalog.jsonb_typeof(p_review -> 'status') is distinct from 'string'
       or pg_catalog.jsonb_typeof(p_review -> 'title') is distinct from 'string'
       or pg_catalog.jsonb_typeof(p_review -> 'targetCount') is distinct from 'number'
       or pg_catalog.jsonb_typeof(p_review -> 'studentIds') is distinct from 'array'
       or pg_catalog.jsonb_typeof(p_review -> 'studentNames') is distinct from 'array'
       or pg_catalog.jsonb_typeof(p_review -> 'groupNames') is distinct from 'array'
       or pg_catalog.jsonb_typeof(p_review -> 'regionNames') is distinct from 'array'
       or pg_catalog.jsonb_typeof(p_review -> 'messagePreview') is distinct from 'string'
       or pg_catalog.jsonb_typeof(p_review -> 'reason') not in ('string', 'null')
       or pg_catalog.jsonb_typeof(p_review -> 'href') not in ('string', 'null') then
        return pg_catalog.jsonb_build_object('status', 'invalid_request');
    end if;

    v_id := p_review ->> 'id';
    v_exam_id := p_review ->> 'examId';
    v_candidate_kind := p_review ->> 'candidateKind';
    v_status := p_review ->> 'status';
    v_title := p_review ->> 'title';
    v_message_preview := p_review ->> 'messagePreview';
    v_reason := p_review ->> 'reason';
    v_href := p_review ->> 'href';

    if v_id is distinct from pg_catalog.btrim(v_id)
       or nullif(v_id, '') is null
       or pg_catalog.octet_length(v_id) > 256
       or v_exam_id is distinct from pg_catalog.btrim(v_exam_id)
       or nullif(v_exam_id, '') is null
       or pg_catalog.octet_length(v_exam_id) > 256
       or v_candidate_kind not in (
           'missing_exam', 'retake_recommendation', 'class_retake_recommendation'
       )
       or v_status not in ('ready', 'hold', 'excluded')
       or v_title is distinct from pg_catalog.btrim(v_title)
       or nullif(v_title, '') is null
       or pg_catalog.octet_length(v_title) > 512
       or v_message_preview is distinct from pg_catalog.btrim(v_message_preview)
       or nullif(v_message_preview, '') is null
       or pg_catalog.octet_length(v_message_preview) > 4096
       or (v_reason is not null and (
           v_reason is distinct from pg_catalog.btrim(v_reason)
           or nullif(v_reason, '') is null
           or pg_catalog.octet_length(v_reason) > 2048
       ))
       or (v_href is not null and (
           v_href is distinct from pg_catalog.btrim(v_href)
           or pg_catalog.left(v_href, 1) <> '/'
           or pg_catalog.left(v_href, 2) = '//'
           or pg_catalog.strpos(v_href, E'\\') > 0
           or v_href ~ '[[:space:][:cntrl:]]'
           or pg_catalog.octet_length(v_href) > 2048
       ))
       or (p_review ->> 'targetCount') !~ '^(0|[1-9][0-9]{0,2})$' then
        return pg_catalog.jsonb_build_object('status', 'invalid_request');
    end if;
    v_target_count := (p_review ->> 'targetCount')::integer;
    if v_target_count > 100
       or pg_catalog.jsonb_array_length(p_review -> 'studentIds') <> v_target_count
       or pg_catalog.jsonb_array_length(p_review -> 'studentNames') <> v_target_count
       or pg_catalog.jsonb_array_length(p_review -> 'groupNames') > 100
       or pg_catalog.jsonb_array_length(p_review -> 'regionNames') > 100
       or exists (
           select 1
             from pg_catalog.jsonb_array_elements(p_review -> 'studentIds') item
            where pg_catalog.jsonb_typeof(item) is distinct from 'string'
               or nullif(pg_catalog.btrim(item #>> '{}'), '') is null
               or item #>> '{}' is distinct from pg_catalog.btrim(item #>> '{}')
               or pg_catalog.octet_length(item #>> '{}') > 256
       )
       or exists (
           select 1
             from pg_catalog.jsonb_array_elements(p_review -> 'studentNames') item
            where pg_catalog.jsonb_typeof(item) is distinct from 'string'
               or nullif(pg_catalog.btrim(item #>> '{}'), '') is null
               or item #>> '{}' is distinct from pg_catalog.btrim(item #>> '{}')
               or pg_catalog.octet_length(item #>> '{}') > 256
       )
       or exists (
           select 1
             from pg_catalog.jsonb_array_elements(
                 (p_review -> 'groupNames') || (p_review -> 'regionNames')
             ) item
            where pg_catalog.jsonb_typeof(item) is distinct from 'string'
               or nullif(pg_catalog.btrim(item #>> '{}'), '') is null
               or item #>> '{}' is distinct from pg_catalog.btrim(item #>> '{}')
               or pg_catalog.octet_length(item #>> '{}') > 256
       )
       or (
           select pg_catalog.count(*)
             from pg_catalog.jsonb_array_elements_text(p_review -> 'studentIds') item
       ) <> (
           select pg_catalog.count(distinct item)
             from pg_catalog.jsonb_array_elements_text(p_review -> 'studentIds') item
       ) then
        return pg_catalog.jsonb_build_object('status', 'invalid_request');
    end if;

    select coalesce(pg_catalog.array_agg(value order by ordinal), '{}'::text[])
      into v_student_ids
      from pg_catalog.jsonb_array_elements_text(p_review -> 'studentIds')
           with ordinality item(value, ordinal);
    select coalesce(pg_catalog.array_agg(value order by ordinal), '{}'::text[])
      into v_student_names
      from pg_catalog.jsonb_array_elements_text(p_review -> 'studentNames')
           with ordinality item(value, ordinal);
    select coalesce(pg_catalog.array_agg(value order by ordinal), '{}'::text[])
      into v_group_names
      from pg_catalog.jsonb_array_elements_text(p_review -> 'groupNames')
           with ordinality item(value, ordinal);
    select coalesce(pg_catalog.array_agg(value order by ordinal), '{}'::text[])
      into v_region_names
      from pg_catalog.jsonb_array_elements_text(p_review -> 'regionNames')
           with ordinality item(value, ordinal);

    v_identity := public.omr_lock_teacher_mutation_identity_v1(
        p_session_authority, p_account_id, p_session_generation,
        p_organization_id, p_actor_user_id
    );
    if v_identity is null
       or v_identity ->> 'organizationId' is distinct from p_organization_id
       or v_identity ->> 'memberRole' not in ('owner', 'admin', 'teacher', 'assistant') then
        return pg_catalog.jsonb_build_object('status', 'unauthorized');
    end if;
    if not public.omr_kakao_reminder_entitlement_ready_v1() then
        return pg_catalog.jsonb_build_object('status', 'legacy_reconciliation_required');
    end if;

    select exam.* into v_exam
      from public.omr_exams exam
     where exam.id = v_exam_id
     for update;
    if not found or v_exam.organization_id is distinct from p_organization_id then
        return pg_catalog.jsonb_build_object('status', 'unauthorized');
    end if;

    perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('omr_kakao_review:' || v_id, 0)
    );
    select review.* into v_existing
      from public.omr_kakao_candidate_reviews review
     where review.id = v_id
     for update;
    if found and (
        v_existing.organization_id is distinct from p_organization_id
        or v_existing.exam_id is distinct from v_exam_id
        or v_existing.candidate_kind is distinct from v_candidate_kind
    ) then
        -- Marker kept stable for migration/static and production diagnostics:
        -- review id scope conflict.
        if v_existing.organization_id is distinct from p_organization_id then
            return pg_catalog.jsonb_build_object('status', 'unauthorized');
        end if;
        return pg_catalog.jsonb_build_object('status', 'scope_conflict');
    end if;
    if found and v_existing.entitlement_state is distinct from 'trusted' then
        return pg_catalog.jsonb_build_object('status', 'scope_conflict');
    end if;
    v_effective := public.omr_read_teacher_mutation_plan_v1(
        p_session_authority, p_account_id, p_organization_id, p_actor_user_id
    );
    if v_effective is null then
        return pg_catalog.jsonb_build_object('status', 'unauthorized');
    end if;
    v_plan := v_effective ->> 'plan';
    if v_plan not in ('pro', 'academy') then
        return pg_catalog.jsonb_build_object('status', 'plan_denied');
    end if;
    perform public.omr_set_effective_plan_transaction_proof_v1(
        p_organization_id, v_effective
    );
    perform public.omr_assert_effective_plan_transaction_proof_v1(
        p_organization_id, true
    );

    v_now := pg_catalog.clock_timestamp();
    insert into public.omr_kakao_candidate_reviews (
        id, organization_id, exam_id, candidate_kind, channel, status, title,
        target_count, student_ids, student_names, group_names, region_names,
        message_preview, reason, href, reviewed_by_user_id, payload,
        reviewed_at, updated_at, entitlement_state
    ) values (
        v_id, p_organization_id, v_exam_id, v_candidate_kind, 'kakao', v_status,
        v_title, v_target_count, v_student_ids, v_student_names, v_group_names,
        v_region_names, v_message_preview, v_reason, v_href, p_actor_user_id,
        pg_catalog.jsonb_build_object(
            'schemaVersion', 1,
            'source', 'teacher_kakao_review',
            'actorUserId', p_actor_user_id
        ),
        v_now, v_now, 'trusted'
    )
    on conflict (id) do update
       set status = excluded.status,
           title = excluded.title,
           target_count = excluded.target_count,
           student_ids = excluded.student_ids,
           student_names = excluded.student_names,
           group_names = excluded.group_names,
           region_names = excluded.region_names,
           message_preview = excluded.message_preview,
           reason = excluded.reason,
           href = excluded.href,
           reviewed_by_user_id = excluded.reviewed_by_user_id,
           payload = excluded.payload,
           reviewed_at = excluded.reviewed_at,
           updated_at = excluded.updated_at;

    return pg_catalog.jsonb_build_object('status', 'saved');
end;
$$;

create function public.omr_save_kakao_simulation_dispatch_v1(
    p_session_authority text,
    p_account_id text,
    p_session_generation bigint,
    p_organization_id text,
    p_actor_user_id text,
    p_dispatch jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
set lock_timeout = '2s'
as $$
declare
    v_identity jsonb;
    v_effective jsonb;
    v_plan text;
    v_exam public.omr_exams%rowtype;
    v_review public.omr_kakao_candidate_reviews%rowtype;
    v_dispatch public.omr_kakao_dispatch_logs%rowtype;
    v_id text;
    v_review_id text;
    v_exam_id text;
    v_status text;
    v_provider_message_id text;
    v_error_message text;
    v_now timestamptz;
    v_payload jsonb;
begin
    if p_dispatch is null
       or pg_catalog.jsonb_typeof(p_dispatch) is distinct from 'object'
       or (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(p_dispatch)) <> 6
       or not p_dispatch ?& array[
           'id', 'reviewId', 'examId', 'status', 'providerMessageId', 'errorMessage'
       ]
       or pg_catalog.octet_length(p_dispatch::text) > 8192
       or pg_catalog.jsonb_typeof(p_dispatch -> 'id') is distinct from 'string'
       or pg_catalog.jsonb_typeof(p_dispatch -> 'reviewId') is distinct from 'string'
       or pg_catalog.jsonb_typeof(p_dispatch -> 'examId') is distinct from 'string'
       or pg_catalog.jsonb_typeof(p_dispatch -> 'status') is distinct from 'string'
       or pg_catalog.jsonb_typeof(p_dispatch -> 'providerMessageId') not in ('string', 'null')
       or pg_catalog.jsonb_typeof(p_dispatch -> 'errorMessage') not in ('string', 'null') then
        return pg_catalog.jsonb_build_object('status', 'invalid_request');
    end if;

    v_id := p_dispatch ->> 'id';
    v_review_id := p_dispatch ->> 'reviewId';
    v_exam_id := p_dispatch ->> 'examId';
    v_status := p_dispatch ->> 'status';
    v_provider_message_id := p_dispatch ->> 'providerMessageId';
    v_error_message := p_dispatch ->> 'errorMessage';
    if v_id is distinct from pg_catalog.btrim(v_id)
       or nullif(v_id, '') is null
       or pg_catalog.octet_length(v_id) > 256
       or v_review_id is distinct from pg_catalog.btrim(v_review_id)
       or nullif(v_review_id, '') is null
       or pg_catalog.octet_length(v_review_id) > 256
       or v_exam_id is distinct from pg_catalog.btrim(v_exam_id)
       or nullif(v_exam_id, '') is null
       or pg_catalog.octet_length(v_exam_id) > 256
       or v_status not in ('queued', 'sent', 'failed', 'cancelled', 'skipped')
       or (v_provider_message_id is not null and (
           v_provider_message_id is distinct from pg_catalog.btrim(v_provider_message_id)
           or nullif(v_provider_message_id, '') is null
           or pg_catalog.octet_length(v_provider_message_id) > 512
       ))
       or (v_error_message is not null and (
           v_error_message is distinct from pg_catalog.btrim(v_error_message)
           or nullif(v_error_message, '') is null
           or pg_catalog.octet_length(v_error_message) > 2048
       ))
       or (v_status = 'queued' and (
           v_provider_message_id is not null or v_error_message is not null
       ))
       or (v_status = 'sent' and (
           v_provider_message_id is null or v_error_message is not null
       ))
       or (v_status = 'failed' and (
           v_provider_message_id is not null or v_error_message is null
       ))
       or (v_status in ('cancelled', 'skipped') and v_provider_message_id is not null) then
        return pg_catalog.jsonb_build_object('status', 'invalid_request');
    end if;

    v_identity := public.omr_lock_teacher_mutation_identity_v1(
        p_session_authority, p_account_id, p_session_generation,
        p_organization_id, p_actor_user_id
    );
    if v_identity is null
       or v_identity ->> 'organizationId' is distinct from p_organization_id
       or v_identity ->> 'memberRole' not in ('owner', 'admin', 'teacher', 'assistant') then
        return pg_catalog.jsonb_build_object('status', 'unauthorized');
    end if;
    if not public.omr_kakao_reminder_entitlement_ready_v1() then
        return pg_catalog.jsonb_build_object('status', 'legacy_reconciliation_required');
    end if;

    select exam.* into v_exam
      from public.omr_exams exam
     where exam.id = v_exam_id
     for update;
    if not found or v_exam.organization_id is distinct from p_organization_id then
        return pg_catalog.jsonb_build_object('status', 'unauthorized');
    end if;

    perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('omr_kakao_review:' || v_review_id, 0)
    );
    select review.* into v_review
      from public.omr_kakao_candidate_reviews review
     where review.id = v_review_id
     for update;
    if not found then
        return pg_catalog.jsonb_build_object('status', 'not_found');
    end if;
    if v_review.organization_id is distinct from p_organization_id then
        return pg_catalog.jsonb_build_object('status', 'unauthorized');
    end if;
    if v_review.exam_id is distinct from v_exam_id
       or v_review.entitlement_state is distinct from 'trusted' then
        return pg_catalog.jsonb_build_object('status', 'scope_conflict');
    end if;

    perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('omr_kakao_dispatch:' || v_id, 0)
    );
    select dispatch.* into v_dispatch
      from public.omr_kakao_dispatch_logs dispatch
     where dispatch.id = v_id
     for update;
    if found and (
        v_dispatch.organization_id is distinct from p_organization_id
        or v_dispatch.review_id is distinct from v_review_id
        or v_dispatch.exam_id is distinct from v_exam_id
        or v_dispatch.provider is distinct from 'simulation'
    ) then
        -- Marker kept stable for migration/static and production diagnostics:
        -- dispatch id scope conflict.
        if v_dispatch.organization_id is distinct from p_organization_id then
            return pg_catalog.jsonb_build_object('status', 'unauthorized');
        end if;
        return pg_catalog.jsonb_build_object('status', 'scope_conflict');
    end if;
    if found and v_dispatch.entitlement_state is distinct from 'trusted' then
        return pg_catalog.jsonb_build_object('status', 'scope_conflict');
    end if;

    v_effective := public.omr_read_teacher_mutation_plan_v1(
        p_session_authority, p_account_id, p_organization_id, p_actor_user_id
    );
    if v_effective is null then
        return pg_catalog.jsonb_build_object('status', 'unauthorized');
    end if;
    v_plan := v_effective ->> 'plan';
    if v_plan not in ('pro', 'academy') then
        return pg_catalog.jsonb_build_object('status', 'plan_denied');
    end if;
    perform public.omr_set_effective_plan_transaction_proof_v1(
        p_organization_id, v_effective
    );
    perform public.omr_assert_effective_plan_transaction_proof_v1(
        p_organization_id, true
    );

    -- The locked review remains the current dispatch authorization source.
    -- Holding or excluding it revokes both queue creation and terminal writes.
    if v_review.status <> 'ready' then
        return pg_catalog.jsonb_build_object('status', 'invalid_transition');
    end if;

    if v_dispatch.id is null then
        if p_dispatch ->> 'status' <> 'queued' or v_review.status <> 'ready' then
            return pg_catalog.jsonb_build_object('status', 'invalid_transition');
        end if;
        v_now := pg_catalog.clock_timestamp();
        v_payload := pg_catalog.jsonb_build_object(
            'schemaVersion', 1,
            'source', 'kakao_simulation_dispatch',
            'actorUserId', p_actor_user_id,
            'log', pg_catalog.jsonb_build_object(
                'id', v_id,
                'reviewId', v_review_id,
                'examId', v_exam_id,
                'channel', 'kakao',
                'provider', 'simulation',
                'status', 'queued',
                'targetCount', v_review.target_count,
                'studentIds', pg_catalog.to_jsonb(v_review.student_ids),
                'studentNames', pg_catalog.to_jsonb(v_review.student_names),
                'messagePreview', v_review.message_preview,
                'createdAt', v_now
            )
        );
        insert into public.omr_kakao_dispatch_logs (
            id, organization_id, review_id, exam_id, channel, provider, status,
            target_count, student_ids, message_preview, provider_message_id,
            error_message, payload, created_at, sent_at, entitlement_state
        ) values (
            v_id, p_organization_id, v_review_id, v_exam_id, 'kakao', 'simulation',
            'queued', v_review.target_count, v_review.student_ids,
            v_review.message_preview, null, null, v_payload, v_now, null, 'trusted'
        );
        return pg_catalog.jsonb_build_object('status', 'saved');
    end if;

    if v_dispatch.status = v_status then
        if v_dispatch.provider_message_id is not distinct from v_provider_message_id
           and v_dispatch.error_message is not distinct from v_error_message then
            return pg_catalog.jsonb_build_object('status', 'saved');
        end if;
        return pg_catalog.jsonb_build_object('status', 'invalid_transition');
    end if;
    if v_dispatch.status <> 'queued' or v_status = 'queued' then
        return pg_catalog.jsonb_build_object('status', 'invalid_transition');
    end if;

    v_now := pg_catalog.clock_timestamp();
    v_payload := pg_catalog.jsonb_build_object(
        'schemaVersion', 1,
        'source', 'kakao_simulation_dispatch',
        'actorUserId', p_actor_user_id,
        'log', pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
            'id', v_dispatch.id,
            'reviewId', v_dispatch.review_id,
            'examId', v_dispatch.exam_id,
            'channel', 'kakao',
            'provider', 'simulation',
            'status', v_status,
            'targetCount', v_dispatch.target_count,
            'studentIds', pg_catalog.to_jsonb(v_dispatch.student_ids),
            'studentNames', pg_catalog.to_jsonb(v_review.student_names),
            'messagePreview', v_dispatch.message_preview,
            'providerMessageId', v_provider_message_id,
            'errorMessage', v_error_message,
            'createdAt', v_dispatch.created_at,
            'sentAt', case when v_status = 'sent' then v_now else null end
        ))
    );
    update public.omr_kakao_dispatch_logs dispatch
       set status = v_status,
           provider_message_id = v_provider_message_id,
           error_message = v_error_message,
           payload = v_payload,
           sent_at = case when v_status = 'sent' then v_now else null end
     where dispatch.id = v_dispatch.id;
    return pg_catalog.jsonb_build_object('status', 'saved');
end;
$$;

alter function public.omr_save_kakao_candidate_review_v1(text,text,bigint,text,text,jsonb)
    owner to postgres;
alter function public.omr_save_kakao_simulation_dispatch_v1(text,text,bigint,text,text,jsonb)
    owner to postgres;

do $kakao_rpc_acl$
declare
    routine record;
begin
    for routine in
        select procedure_row.oid, procedure_row.prokind, namespace.nspname,
               procedure_row.proname,
               pg_catalog.pg_get_function_identity_arguments(procedure_row.oid) as identity_args
          from pg_catalog.pg_proc procedure_row
          join pg_catalog.pg_namespace namespace on namespace.oid = procedure_row.pronamespace
         where namespace.nspname = 'public'
           and procedure_row.proname in (
               'omr_save_kakao_candidate_review_v1',
               'omr_save_kakao_simulation_dispatch_v1'
           )
    loop
        execute pg_catalog.format(
            'revoke all on %s %I.%I(%s) from public, anon, authenticated, service_role',
            case when routine.prokind = 'p' then 'procedure' else 'function' end,
            routine.nspname, routine.proname, routine.identity_args
        );
    end loop;
end
$kakao_rpc_acl$;

revoke all on function public.omr_save_kakao_candidate_review_v1(text,text,bigint,text,text,jsonb)
    from public, anon, authenticated, service_role;
grant execute on function public.omr_save_kakao_candidate_review_v1(text,text,bigint,text,text,jsonb)
    to service_role;
revoke all on function public.omr_save_kakao_simulation_dispatch_v1(text,text,bigint,text,text,jsonb)
    from public, anon, authenticated, service_role;
grant execute on function public.omr_save_kakao_simulation_dispatch_v1(text,text,bigint,text,text,jsonb)
    to service_role;

revoke all on table public.omr_kakao_candidate_reviews
    from public, anon, authenticated, service_role;
revoke all on table public.omr_kakao_dispatch_logs
    from public, anon, authenticated, service_role;
grant select on table public.omr_kakao_candidate_reviews to service_role;
grant select on table public.omr_kakao_dispatch_logs to service_role;

comment on function public.omr_save_kakao_candidate_review_v1(text,text,bigint,text,text,jsonb)
    is 'kakao-reminder-entitlement:202608100002:candidate-review';
comment on function public.omr_save_kakao_simulation_dispatch_v1(text,text,bigint,text,text,jsonb)
    is 'kakao-reminder-entitlement:202608100002:simulation-dispatch';

commit;
