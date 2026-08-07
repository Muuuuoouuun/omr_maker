begin;

alter table public.omr_exams
    add column if not exists revision bigint not null default 1;

do $$
begin
    if not exists (
        select 1 from pg_catalog.pg_constraint constraint_row
         where constraint_row.conrelid = 'public.omr_exams'::pg_catalog.regclass
           and constraint_row.conname = 'omr_exams_revision_positive'
    ) then
        alter table public.omr_exams
            add constraint omr_exams_revision_positive check (revision > 0);
    end if;
end;
$$;

create table if not exists public.omr_exam_mutations (
    organization_id text not null,
    exam_id text not null references public.omr_exams(id) on delete cascade,
    mutation_id text not null,
    request_hash text not null check (request_hash ~ '^[0-9a-f]{32}$'),
    expected_revision bigint not null check (expected_revision >= 0),
    committed_revision bigint not null check (committed_revision > 0),
    result jsonb not null,
    created_at timestamptz not null default now(),
    primary key (organization_id, exam_id, mutation_id)
);

create index if not exists omr_exam_mutations_created_idx
    on public.omr_exam_mutations (created_at, organization_id, exam_id);

alter table public.omr_exam_mutations enable row level security;
alter table public.omr_exam_mutations force row level security;
revoke all on table public.omr_exam_mutations from public, anon, authenticated;

-- The v6 wrapper contains the audited asset-intent locking, plan check,
-- canonical write, promotion, and cleanup race guards. Keep it private and
-- invoke it only after the new CAS protocol has serialized the exam key.
alter function public.omr_save_exam_v1(jsonb, jsonb, jsonb, text)
    rename to omr_save_exam_v10_snapshot;
revoke all on function public.omr_save_exam_v10_snapshot(jsonb, jsonb, jsonb, text)
    from public, anon, authenticated, service_role;

-- Fail closed for an old application instance rather than letting it perform
-- a blind last-write-wins update after this migration is installed.
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
    raise exception 'exam save protocol upgrade required';
end;
$$;

revoke all on function public.omr_save_exam_v1(jsonb, jsonb, jsonb, text)
    from public, anon, authenticated;
grant execute on function public.omr_save_exam_v1(jsonb, jsonb, jsonb, text)
    to service_role;

-- Remote asset registry timestamps can advance when the same upload intent is
-- promoted by a committed save. They do not change the referenced object, so
-- exclude them recursively from replay identity while retaining every stable
-- scope, kind, object, size, and content field.
create function public.omr_normalize_exam_save_request_v10(p_value jsonb)
returns jsonb
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
    v_result jsonb;
begin
    if pg_catalog.jsonb_typeof(p_value) = 'object' then
        select coalesce(
            pg_catalog.jsonb_object_agg(
                item.key,
                public.omr_normalize_exam_save_request_v10(item.value)
            ),
            '{}'::jsonb
        ) into v_result
          from pg_catalog.jsonb_each(p_value) item
         where not (
             p_value ->> 'store' = 'remote'
             and pg_catalog.jsonb_typeof(p_value -> 'key') = 'string'
             and pg_catalog.jsonb_typeof(p_value -> 'kind') = 'string'
             and item.key = 'updatedAt'
         );
        return v_result;
    end if;
    if pg_catalog.jsonb_typeof(p_value) = 'array' then
        select coalesce(
            pg_catalog.jsonb_agg(
                public.omr_normalize_exam_save_request_v10(item.value)
                order by item.ordinality
            ),
            '[]'::jsonb
        ) into v_result
          from pg_catalog.jsonb_array_elements(p_value) with ordinality item(value, ordinality);
        return v_result;
    end if;
    return p_value;
end;
$$;

revoke all on function public.omr_normalize_exam_save_request_v10(jsonb)
    from public, anon, authenticated, service_role;

create function public.omr_save_exam_v2(
    p_exam jsonb,
    p_questions jsonb,
    p_teacher_asset_intent_ids jsonb,
    p_asset_actor_user_id text,
    p_expected_revision bigint,
    p_mutation_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_exam public.omr_exams%rowtype;
    v_current public.omr_exams%rowtype;
    v_existing_mutation public.omr_exam_mutations%rowtype;
    v_request_exam jsonb;
    v_request_questions jsonb;
    v_request_hash text;
    v_saved jsonb;
    v_committed_revision bigint;
    v_committed_at timestamptz;
    v_committed_at_text text;
    v_result jsonb;
begin
    if pg_catalog.jsonb_typeof(p_exam) is distinct from 'object'
       or pg_catalog.jsonb_typeof(p_questions) is distinct from 'array'
       or pg_catalog.jsonb_typeof(p_teacher_asset_intent_ids) is distinct from 'array'
       or p_expected_revision is null or p_expected_revision < 0
       or nullif(pg_catalog.btrim(p_mutation_id), '') is null
       or length(p_mutation_id) > 128 then
        raise exception 'invalid exam save mutation';
    end if;

    select * into v_exam
      from pg_catalog.jsonb_populate_record(null::public.omr_exams, p_exam);
    if nullif(pg_catalog.btrim(v_exam.id), '') is null
       or nullif(pg_catalog.btrim(v_exam.organization_id), '') is null
       or v_exam.payload is null then
        raise exception 'invalid canonical exam';
    end if;

    -- Client clock fields and the previous revision are not semantic authoring
    -- content. Ignoring them makes a response-loss retry stable even if the UI
    -- reconstructs the same draft with a fresh local timestamp.
    v_request_exam := public.omr_normalize_exam_save_request_v10(
        (p_exam - 'created_at' - 'updated_at')
        || pg_catalog.jsonb_build_object(
            'payload', (v_exam.payload - 'createdAt' - 'updatedAt' - 'revision')
        )
    );
    select coalesce(
        pg_catalog.jsonb_agg(
            public.omr_normalize_exam_save_request_v10(
                item.value - 'created_at' - 'updated_at'
            )
            order by item.ordinality
        ),
        '[]'::jsonb
    ) into v_request_questions
      from pg_catalog.jsonb_array_elements(p_questions) with ordinality item(value, ordinality);
    v_request_hash := pg_catalog.md5(
        p_expected_revision::text || chr(31)
        || v_request_exam::text || chr(31)
        || v_request_questions::text || chr(31)
        || p_teacher_asset_intent_ids::text || chr(31)
        || coalesce(pg_catalog.btrim(p_asset_actor_user_id), '')
    );

    -- A row does not exist for a new exam, so use an exam-key transaction lock
    -- to make expectedRevision=0 genuinely insert-only under concurrency.
    perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
            v_exam.organization_id || chr(31) || v_exam.id,
            610010
        )
    );

    select mutation.* into v_existing_mutation
      from public.omr_exam_mutations mutation
     where mutation.organization_id = v_exam.organization_id
       and mutation.exam_id = v_exam.id
       and mutation.mutation_id = pg_catalog.btrim(p_mutation_id)
     for update;
    if found then
        if v_existing_mutation.request_hash = v_request_hash then
            return v_existing_mutation.result;
        end if;
        select exam.* into v_current
          from public.omr_exams exam
         where exam.id = v_exam.id
         for update;
        return pg_catalog.jsonb_build_object(
            'status', 'mutation_conflict',
            'currentRevision', coalesce(v_current.revision, 0),
            'updatedAt', case when v_current.id is null then null else
                pg_catalog.to_char(
                    v_current.updated_at at time zone 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                ) end
        );
    end if;

    select exam.* into v_current
      from public.omr_exams exam
     where exam.id = v_exam.id
     for update;
    if found and v_current.organization_id is distinct from v_exam.organization_id then
        raise exception 'exam identifier belongs to another organization';
    end if;

    if (p_expected_revision = 0 and v_current.id is not null)
       or (p_expected_revision > 0 and v_current.id is null)
       or (v_current.id is not null and v_current.revision <> p_expected_revision) then
        return pg_catalog.jsonb_build_object(
            'status', 'revision_conflict',
            'currentRevision', coalesce(v_current.revision, 0),
            'updatedAt', case when v_current.id is null then null else
                pg_catalog.to_char(
                    v_current.updated_at at time zone 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
                ) end
        );
    end if;

    v_committed_at := now();
    v_committed_at_text := pg_catalog.to_char(
        v_committed_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    );
    v_saved := public.omr_save_exam_v10_snapshot(
        pg_catalog.jsonb_set(p_exam, '{updated_at}', pg_catalog.to_jsonb(v_committed_at), true),
        p_questions,
        p_teacher_asset_intent_ids,
        p_asset_actor_user_id
    );

    v_committed_revision := p_expected_revision + 1;
    update public.omr_exams exam
       set revision = v_committed_revision,
           updated_at = v_committed_at,
           payload = pg_catalog.jsonb_set(
               pg_catalog.jsonb_set(exam.payload, '{revision}', pg_catalog.to_jsonb(v_committed_revision), true),
               '{updatedAt}', pg_catalog.to_jsonb(v_committed_at_text), true
           )
     where exam.id = v_exam.id
       and exam.organization_id = v_exam.organization_id
    returning exam.payload into v_saved;
    if not found then
        raise exception 'canonical exam save disappeared';
    end if;

    v_result := pg_catalog.jsonb_build_object(
        'status', 'saved',
        'exam', v_saved,
        'revision', v_committed_revision,
        'updatedAt', v_committed_at_text
    );
    insert into public.omr_exam_mutations (
        organization_id, exam_id, mutation_id, request_hash,
        expected_revision, committed_revision, result, created_at
    ) values (
        v_exam.organization_id, v_exam.id, pg_catalog.btrim(p_mutation_id),
        v_request_hash, p_expected_revision, v_committed_revision, v_result,
        v_committed_at
    );

    -- Keep replay receipts for the operational retry horizon, then amortize
    -- cleanup across successful saves without an unbounded table scan/delete.
    with expired_candidates as materialized (
        select mutation.organization_id, mutation.exam_id, mutation.mutation_id
          from public.omr_exam_mutations mutation
         where mutation.created_at < now() - interval '90 days'
         order by mutation.created_at, mutation.organization_id,
                  mutation.exam_id, mutation.mutation_id
         for update skip locked
         limit 100
    )
    delete from public.omr_exam_mutations mutation
     using expired_candidates candidate
     where mutation.organization_id = candidate.organization_id
       and mutation.exam_id = candidate.exam_id
       and mutation.mutation_id = candidate.mutation_id;

    return v_result;
end;
$$;

revoke all on function public.omr_save_exam_v2(jsonb, jsonb, jsonb, text, bigint, text)
    from public, anon, authenticated;
grant execute on function public.omr_save_exam_v2(jsonb, jsonb, jsonb, text, bigint, text)
    to service_role;

-- A response-loss compensation may race the committed create. Use the same
-- exam-key lock and refuse to release durable canonical usage.
alter function public.omr_release_plan_usage(text, text, date, text)
    rename to omr_release_plan_usage_v10_snapshot;
revoke all on function public.omr_release_plan_usage_v10_snapshot(text, text, date, text)
    from public, anon, authenticated, service_role;

create function public.omr_release_plan_usage(
    p_organization_id text,
    p_metric text,
    p_period_start date,
    p_resource_key text
)
returns table(released boolean, used integer)
language plpgsql
security definer
set search_path = ''
as $$
begin
    if p_metric = 'exams' and p_resource_key like 'exam:%' then
        perform pg_catalog.pg_advisory_xact_lock(
            pg_catalog.hashtextextended(
                p_organization_id || chr(31) || pg_catalog.substr(p_resource_key, 6),
                610010
            )
        );
        if not exists (
        select 1 from public.omr_exams exam
         where exam.organization_id = p_organization_id
           and exam.id = pg_catalog.substr(p_resource_key, 6)
        ) then
            return query select snapshot.released, snapshot.used
              from public.omr_release_plan_usage_v10_snapshot(
                  p_organization_id, p_metric, p_period_start, p_resource_key
              ) snapshot;
            return;
        end if;
        return query
        select false, coalesce(usage.used, 0)
          from public.omr_plan_usage usage
         where usage.organization_id = p_organization_id
           and usage.metric = p_metric
           and usage.period_start = p_period_start;
        if not found then return query select false, 0; end if;
        return;
    end if;

    return query select snapshot.released, snapshot.used
      from public.omr_release_plan_usage_v10_snapshot(
          p_organization_id, p_metric, p_period_start, p_resource_key
      ) snapshot;
end;
$$;

revoke all on function public.omr_release_plan_usage(text, text, date, text)
    from public, anon, authenticated;
grant execute on function public.omr_release_plan_usage(text, text, date, text)
    to service_role;

commit;
