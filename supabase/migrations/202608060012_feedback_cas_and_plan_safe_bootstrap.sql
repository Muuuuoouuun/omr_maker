begin;

create function public.omr_bootstrap_workspace_organization_v1(
    p_organization_id text,
    p_name text,
    p_metadata jsonb,
    p_updated_at timestamptz
)
returns public.omr_organizations
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_organization public.omr_organizations%rowtype;
begin
    if nullif(trim(p_organization_id), '') is null then
        raise exception 'organization_id is required';
    end if;

    insert into public.omr_organizations (id, name, plan, metadata, created_at, updated_at)
    values (
        trim(p_organization_id),
        coalesce(nullif(trim(p_name), ''), trim(p_organization_id)),
        'free',
        coalesce(p_metadata, '{}'::jsonb),
        coalesce(p_updated_at, now()),
        coalesce(p_updated_at, now())
    )
    on conflict (id) do update set
        name = excluded.name,
        metadata = excluded.metadata,
        updated_at = excluded.updated_at
    returning * into v_organization;

    return v_organization;
end;
$$;

alter table public.omr_attempt_feedback
    add column if not exists revision bigint not null default 1;

alter table public.omr_attempt_feedback
    drop constraint if exists omr_attempt_feedback_revision_positive;
alter table public.omr_attempt_feedback
    add constraint omr_attempt_feedback_revision_positive check (revision > 0);

create table if not exists public.omr_feedback_mutations (
    organization_id text not null references public.omr_organizations(id) on delete cascade,
    mutation_kind text not null check (mutation_kind in ('save', 'return')),
    mutation_id text not null,
    request_hash text not null,
    response jsonb not null,
    created_at timestamptz not null default now(),
    primary key (organization_id, mutation_kind, mutation_id)
);

create index if not exists omr_feedback_mutations_created_idx
    on public.omr_feedback_mutations (created_at, organization_id, mutation_kind, mutation_id);
create index if not exists omr_feedback_mutations_org_kind_created_idx
    on public.omr_feedback_mutations (
        organization_id, mutation_kind, created_at desc, mutation_id desc
    );

alter table public.omr_feedback_mutations enable row level security;
alter table public.omr_feedback_mutations force row level security;
revoke all on table public.omr_feedback_mutations from public, anon, authenticated, service_role;

alter function public.omr_save_feedback_v1(text, jsonb)
    rename to omr_save_feedback_v12_snapshot;
alter function public.omr_return_feedback_v1(text, text, timestamptz)
    rename to omr_return_feedback_v12_snapshot;

create function public.omr_save_feedback_v1(
    p_organization_id text,
    p_feedback jsonb
)
returns public.omr_attempt_feedback
language plpgsql
security definer
set search_path = ''
as $$
begin
    raise exception 'feedback save protocol upgrade required';
end;
$$;

create function public.omr_return_feedback_v1(
    p_organization_id text,
    p_feedback_id text,
    p_returned_at timestamptz default now()
)
returns public.omr_attempt_feedback
language plpgsql
security definer
set search_path = ''
as $$
begin
    raise exception 'feedback return protocol upgrade required';
end;
$$;

create function public.omr_save_feedback_v2(
    p_organization_id text,
    p_feedback jsonb,
    p_expected_revision bigint,
    p_mutation_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_plan text;
    v_request_hash text;
    v_hash_feedback jsonb;
    v_markup_strokes bigint;
    v_receipt public.omr_feedback_mutations%rowtype;
    v_feedback public.omr_attempt_feedback%rowtype;
    v_attempt public.omr_attempts%rowtype;
    v_current public.omr_attempt_feedback%rowtype;
    v_stored public.omr_attempt_feedback%rowtype;
    v_response jsonb;
    v_now timestamptz := clock_timestamp();
begin
    if nullif(trim(p_organization_id), '') is null
       or nullif(trim(p_mutation_id), '') is null
       or p_expected_revision is null
       or p_expected_revision < 0
       or jsonb_typeof(p_feedback) is distinct from 'object' then
        raise exception 'invalid feedback mutation';
    end if;

    if pg_catalog.octet_length((p_feedback - 'markup_drawings')::text) > 262144 then
        raise exception 'feedback metadata exceeds limit';
    end if;
    if p_feedback ? 'markup_drawings'
       and p_feedback -> 'markup_drawings' is distinct from 'null'::jsonb then
        if pg_catalog.jsonb_typeof(p_feedback -> 'markup_drawings') is distinct from 'object'
           or pg_catalog.octet_length((p_feedback -> 'markup_drawings')::text) > 5242880 then
            raise exception 'feedback markup exceeds limit';
        end if;
        if exists (
               select 1
                 from pg_catalog.jsonb_each(p_feedback -> 'markup_drawings') page
                where pg_catalog.jsonb_typeof(page.value) is distinct from 'array'
           ) then
            raise exception 'feedback markup shape exceeds limit';
        end if;
        if (select count(*) from pg_catalog.jsonb_each(p_feedback -> 'markup_drawings')) > 500
           or exists (
               select 1
                 from pg_catalog.jsonb_each(p_feedback -> 'markup_drawings') page
                where page.key !~ '^[1-9][0-9]{0,3}$'
                   or pg_catalog.jsonb_array_length(page.value) > 20000
           ) then
            raise exception 'feedback markup shape exceeds limit';
        end if;
        select coalesce(sum(pg_catalog.jsonb_array_length(page.value)), 0)::bigint
          into v_markup_strokes
          from pg_catalog.jsonb_each(p_feedback -> 'markup_drawings') page;
        if v_markup_strokes > 20000
           or exists (
               select 1
                 from pg_catalog.jsonb_each(p_feedback -> 'markup_drawings') page
                 cross join lateral pg_catalog.jsonb_array_elements(page.value) stroke(value)
                where pg_catalog.jsonb_typeof(stroke.value) is distinct from 'string'
                   or pg_catalog.octet_length(stroke.value #>> '{}') > 65536
           ) then
            raise exception 'feedback markup shape exceeds limit';
        end if;
    end if;

    v_hash_feedback := p_feedback - 'updated_at';
    if pg_catalog.jsonb_typeof(v_hash_feedback -> 'payload') = 'object' then
        v_hash_feedback := pg_catalog.jsonb_set(
            v_hash_feedback,
            '{payload}',
            (v_hash_feedback -> 'payload') - 'updatedAt',
            false
        );
    end if;
    v_request_hash := md5(jsonb_build_object(
        'organizationId', trim(p_organization_id),
        'feedback', v_hash_feedback,
        'expectedRevision', p_expected_revision
    )::text);

    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        trim(p_organization_id) || chr(31) || 'feedback-save' || chr(31) || trim(p_mutation_id),
        604012
    ));
    select * into v_receipt
      from public.omr_feedback_mutations
     where organization_id = trim(p_organization_id)
       and mutation_kind = 'save'
       and mutation_id = trim(p_mutation_id)
     for update;
    if found then
        if v_receipt.request_hash is distinct from v_request_hash then
            raise exception 'mutation_conflict';
        end if;
        return v_receipt.response;
    end if;

    select organization.plan into v_plan
      from public.omr_organizations organization
     where organization.id = trim(p_organization_id)
     for share;
    if v_plan is null or v_plan not in ('pro', 'academy') then
        raise exception 'plan entitlement required';
    end if;

    select * into v_feedback
      from jsonb_populate_record(null::public.omr_attempt_feedback, p_feedback);
    if v_feedback.organization_id is distinct from trim(p_organization_id)
       or v_feedback.status is distinct from 'draft' then
        raise exception 'feedback scope or status mismatch';
    end if;

    select * into v_attempt
      from public.omr_attempts
     where id = v_feedback.attempt_id
       and organization_id = trim(p_organization_id)
     for update;
    if not found then
        raise exception 'attempt is outside teacher organization';
    end if;
    if v_feedback.exam_id is distinct from v_attempt.exam_id
       or v_feedback.student_profile_id is distinct from v_attempt.student_profile_id then
        raise exception 'feedback attempt mismatch';
    end if;

    select * into v_current
      from public.omr_attempt_feedback
     where attempt_id = v_feedback.attempt_id
       and organization_id = trim(p_organization_id)
     for update;

    if found and (
        v_current.id is distinct from v_feedback.id
        or v_current.revision is distinct from p_expected_revision
        or v_current.status is distinct from 'draft'
    ) then
        return jsonb_build_object(
            'status', 'revision_conflict',
            'currentRevision', v_current.revision,
            'currentStatus', v_current.status,
            'updatedAt', v_current.updated_at
        );
    elsif not found and p_expected_revision <> 0 then
        return jsonb_build_object(
            'status', 'revision_conflict',
            'currentRevision', 0,
            'currentStatus', 'missing'
        );
    end if;

    if v_current.id is null then
        insert into public.omr_attempt_feedback (
            id, organization_id, attempt_id, exam_id, student_profile_id,
            teacher_user_id, status, revision, summary, question_comments,
            markup, markup_drawings, download_policy, notification_status,
            notification_channel, notified_at, first_opened_at, last_opened_at,
            open_count, returned_at, payload, created_at, updated_at
        ) values (
            v_feedback.id, trim(p_organization_id), v_feedback.attempt_id,
            v_feedback.exam_id, v_feedback.student_profile_id,
            v_feedback.teacher_user_id, 'draft', 1, v_feedback.summary,
            coalesce(v_feedback.question_comments, '[]'::jsonb), v_feedback.markup,
            v_feedback.markup_drawings, coalesce(v_feedback.download_policy, '{}'::jsonb),
            'not_queued', 'in_app', null, null, null, 0, null,
            coalesce(v_feedback.payload, '{}'::jsonb) || jsonb_build_object(
                'organizationId', trim(p_organization_id), 'status', 'draft',
                'revision', 1, 'updatedAt', v_now
            ),
            coalesce(v_feedback.created_at, v_now), v_now
        ) returning * into v_stored;
    else
        update public.omr_attempt_feedback
           set teacher_user_id = v_feedback.teacher_user_id,
               summary = v_feedback.summary,
               question_comments = coalesce(v_feedback.question_comments, '[]'::jsonb),
               markup = v_feedback.markup,
               markup_drawings = case when p_feedback ? 'markup_drawings'
                   then v_feedback.markup_drawings else markup_drawings end,
               download_policy = coalesce(v_feedback.download_policy, '{}'::jsonb),
               revision = v_current.revision + 1,
               payload = coalesce(v_feedback.payload, '{}'::jsonb) || jsonb_build_object(
                   'organizationId', trim(p_organization_id), 'status', v_current.status,
                   'revision', v_current.revision + 1, 'updatedAt', v_now,
                   'returnedAt', v_current.returned_at,
                   'delivery', jsonb_build_object(
                       'notificationStatus', v_current.notification_status,
                       'notificationChannel', v_current.notification_channel,
                       'notifiedAt', v_current.notified_at,
                       'firstOpenedAt', v_current.first_opened_at,
                       'lastOpenedAt', v_current.last_opened_at,
                       'openCount', v_current.open_count
                   )
               ),
               updated_at = v_now
         where id = v_current.id
           and revision = p_expected_revision
           and status = 'draft'
        returning * into v_stored;
    end if;

    v_response := jsonb_build_object(
        'status', 'saved', 'revision', v_stored.revision,
        'updatedAt', v_stored.updated_at,
        'feedback', to_jsonb(v_stored) - 'markup_drawings'
    );
    if pg_catalog.octet_length(v_response::text) > 262144 then
        raise exception 'feedback receipt exceeds limit';
    end if;
    insert into public.omr_feedback_mutations (
        organization_id, mutation_kind, mutation_id, request_hash, response
    ) values (
        trim(p_organization_id), 'save', trim(p_mutation_id), v_request_hash, v_response
    );
    delete from public.omr_feedback_mutations receipt
      using (
          select old_receipt.organization_id, old_receipt.mutation_kind, old_receipt.mutation_id
            from public.omr_feedback_mutations old_receipt
           where old_receipt.created_at < v_now - interval '90 days'
           order by old_receipt.created_at, old_receipt.organization_id,
                    old_receipt.mutation_kind, old_receipt.mutation_id
           limit 128
           for update skip locked
      ) expired
     where receipt.organization_id = expired.organization_id
       and receipt.mutation_kind = expired.mutation_kind
       and receipt.mutation_id = expired.mutation_id;
    delete from public.omr_feedback_mutations receipt
      using (
          select old_receipt.organization_id, old_receipt.mutation_kind, old_receipt.mutation_id
            from public.omr_feedback_mutations old_receipt
           where old_receipt.organization_id = trim(p_organization_id)
             and old_receipt.mutation_kind = 'save'
           order by old_receipt.created_at desc, old_receipt.mutation_id desc
           offset 100 limit 128
           for update skip locked
      ) excess
     where receipt.organization_id = excess.organization_id
       and receipt.mutation_kind = excess.mutation_kind
       and receipt.mutation_id = excess.mutation_id;
    return v_response;
end;
$$;

create function public.omr_return_feedback_v2(
    p_organization_id text,
    p_feedback_id text,
    p_expected_revision bigint,
    p_mutation_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_plan text;
    v_request_hash text;
    v_receipt public.omr_feedback_mutations%rowtype;
    v_current public.omr_attempt_feedback%rowtype;
    v_stored public.omr_attempt_feedback%rowtype;
    v_response jsonb;
    v_now timestamptz := clock_timestamp();
begin
    if nullif(trim(p_organization_id), '') is null
       or nullif(trim(p_feedback_id), '') is null
       or nullif(trim(p_mutation_id), '') is null
       or p_expected_revision is null or p_expected_revision < 1 then
        raise exception 'invalid feedback return mutation';
    end if;

    v_request_hash := md5(jsonb_build_object(
        'organizationId', trim(p_organization_id),
        'feedbackId', trim(p_feedback_id),
        'expectedRevision', p_expected_revision
    )::text);
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        trim(p_organization_id) || chr(31) || 'feedback-return' || chr(31) || trim(p_mutation_id),
        604012
    ));
    select * into v_receipt
      from public.omr_feedback_mutations
     where organization_id = trim(p_organization_id)
       and mutation_kind = 'return'
       and mutation_id = trim(p_mutation_id)
     for update;
    if found then
        if v_receipt.request_hash is distinct from v_request_hash then
            raise exception 'mutation_conflict';
        end if;
        return v_receipt.response;
    end if;

    select organization.plan into v_plan
      from public.omr_organizations organization
     where organization.id = trim(p_organization_id)
     for share;
    if v_plan is null or v_plan not in ('pro', 'academy') then
        raise exception 'plan entitlement required';
    end if;

    select * into v_current
      from public.omr_attempt_feedback
     where id = trim(p_feedback_id)
       and organization_id = trim(p_organization_id)
     for update;
    if not found then
        return jsonb_build_object(
            'status', 'revision_conflict', 'currentRevision', 0, 'currentStatus', 'missing'
        );
    end if;
    if v_current.revision is distinct from p_expected_revision
       or v_current.status is distinct from 'draft' then
        return jsonb_build_object(
            'status', 'revision_conflict',
            'currentRevision', v_current.revision,
            'currentStatus', v_current.status,
            'updatedAt', v_current.updated_at
        );
    end if;

    update public.omr_attempt_feedback
       set status = 'returned',
           revision = v_current.revision + 1,
           notification_status = 'queued',
           notification_channel = 'in_app',
           notified_at = coalesce(notified_at, v_now),
           returned_at = coalesce(returned_at, v_now),
           updated_at = v_now,
           payload = coalesce(payload, '{}'::jsonb) || jsonb_build_object(
               'status', 'returned', 'revision', v_current.revision + 1,
               'returnedAt', coalesce(returned_at, v_now), 'updatedAt', v_now,
               'delivery', coalesce(payload->'delivery', '{}'::jsonb) || jsonb_build_object(
                   'notificationStatus', 'queued', 'notificationChannel', 'in_app',
                   'notifiedAt', coalesce(notified_at, v_now)
               )
           )
     where id = v_current.id
       and revision = p_expected_revision
       and status = 'draft'
    returning * into v_stored;

    if pg_catalog.octet_length((to_jsonb(v_stored) - 'markup_drawings')::text) > 262144 then
        raise exception 'feedback metadata exceeds limit';
    end if;

    v_response := jsonb_build_object(
        'status', 'returned', 'revision', v_stored.revision,
        'updatedAt', v_stored.updated_at,
        'feedback', to_jsonb(v_stored) - 'markup_drawings'
    );
    if pg_catalog.octet_length(v_response::text) > 262144 then
        raise exception 'feedback receipt exceeds limit';
    end if;
    insert into public.omr_feedback_mutations (
        organization_id, mutation_kind, mutation_id, request_hash, response
    ) values (
        trim(p_organization_id), 'return', trim(p_mutation_id), v_request_hash, v_response
    );
    delete from public.omr_feedback_mutations receipt
      using (
          select old_receipt.organization_id, old_receipt.mutation_kind, old_receipt.mutation_id
            from public.omr_feedback_mutations old_receipt
           where old_receipt.created_at < v_now - interval '90 days'
           order by old_receipt.created_at, old_receipt.organization_id,
                    old_receipt.mutation_kind, old_receipt.mutation_id
           limit 128
           for update skip locked
      ) expired
     where receipt.organization_id = expired.organization_id
       and receipt.mutation_kind = expired.mutation_kind
       and receipt.mutation_id = expired.mutation_id;
    delete from public.omr_feedback_mutations receipt
      using (
          select old_receipt.organization_id, old_receipt.mutation_kind, old_receipt.mutation_id
            from public.omr_feedback_mutations old_receipt
           where old_receipt.organization_id = trim(p_organization_id)
             and old_receipt.mutation_kind = 'return'
           order by old_receipt.created_at desc, old_receipt.mutation_id desc
           offset 100 limit 128
           for update skip locked
      ) excess
     where receipt.organization_id = excess.organization_id
       and receipt.mutation_kind = excess.mutation_kind
       and receipt.mutation_id = excess.mutation_id;
    return v_response;
end;
$$;

revoke all on function public.omr_bootstrap_workspace_organization_v1(text,text,jsonb,timestamptz) from public, anon, authenticated;
revoke all on function public.omr_save_feedback_v2(text,jsonb,bigint,text) from public, anon, authenticated;
revoke all on function public.omr_return_feedback_v2(text,text,bigint,text) from public, anon, authenticated;
revoke all on function public.omr_save_feedback_v1(text,jsonb) from public, anon, authenticated;
revoke all on function public.omr_return_feedback_v1(text,text,timestamptz) from public, anon, authenticated;
revoke all on function public.omr_save_feedback_v12_snapshot(text,jsonb) from public, anon, authenticated, service_role;
revoke all on function public.omr_return_feedback_v12_snapshot(text,text,timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.omr_bootstrap_workspace_organization_v1(text,text,jsonb,timestamptz) to service_role;
grant execute on function public.omr_save_feedback_v2(text,jsonb,bigint,text) to service_role;
grant execute on function public.omr_return_feedback_v2(text,text,bigint,text) to service_role;
grant execute on function public.omr_save_feedback_v1(text,jsonb) to service_role;
grant execute on function public.omr_return_feedback_v1(text,text,timestamptz) to service_role;

commit;
