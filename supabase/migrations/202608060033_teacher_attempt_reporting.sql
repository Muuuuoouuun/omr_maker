begin;

-- Exact keyset support for the completed-only export. The equality scope
-- columns come first and both ordering columns match the descending cursor.
create index if not exists omr_attempts_org_completed_finished_desc_idx
    on public.omr_attempts (organization_id, finished_at desc, id desc)
    where status = 'completed';
create index if not exists omr_attempts_org_exam_completed_finished_desc_idx
    on public.omr_attempts (organization_id, exam_id, finished_at desc, id desc)
    where status = 'completed';

-- Exact reporting stays separate from the recent-attempt screen projection.
-- This RPC returns only fixed-size scalar aggregates and therefore does not
-- inherit the 2,000-row UI ceiling.
drop function if exists public.omr_teacher_attempt_aggregate_v1(text, text, timestamptz, timestamptz);
create function public.omr_teacher_attempt_aggregate_v1(
    p_organization_id text,
    p_exam_id text default null,
    p_period_start timestamptz default null,
    p_period_end timestamptz default null
)
returns table (
    total_attempt_count bigint,
    completed_attempt_count bigint,
    in_progress_attempt_count bigint,
    base_attempt_count bigint,
    completed_base_attempt_count bigint,
    distinct_student_count bigint,
    completed_base_score_percent_sum numeric,
    completed_base_average_score_percent numeric,
    period_attempt_count bigint,
    period_handwriting_archive_count bigint,
    period_handwriting_question_count bigint,
    period_handwriting_stroke_count bigint,
    snapshot_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
    if nullif(pg_catalog.btrim(p_organization_id), '') is null
       or pg_catalog.octet_length(p_organization_id) > 128 then
        raise exception 'invalid organization scope';
    end if;
    if p_exam_id is not null and (
        nullif(pg_catalog.btrim(p_exam_id), '') is null
        or pg_catalog.octet_length(p_exam_id) > 256
    ) then
        raise exception 'invalid exam scope';
    end if;
    if (p_period_start is null) <> (p_period_end is null)
       or (
           p_period_start is not null
           and (
               p_period_end <= p_period_start
               or p_period_end - p_period_start > interval '366 days'
           )
       ) then
        raise exception 'invalid reporting period';
    end if;

    return query
    with scoped as materialized (
        select
            attempt.id,
            attempt.status,
            attempt.score_percent,
            attempt.retake_source_attempt_id,
            attempt.student_profile_id,
            attempt.student_id,
            attempt.finished_at,
            coalesce(
                nullif(attempt.student_profile_id, ''),
                nullif(attempt.student_id, ''),
                'attempt:' || attempt.id
            ) as student_scope_key
          from public.omr_attempts attempt
         where attempt.organization_id = pg_catalog.btrim(p_organization_id)
           and (p_exam_id is null or attempt.exam_id = pg_catalog.btrim(p_exam_id))
    ),
    -- Apply the bounded reporting period before detoasting/parsing handwriting
    -- JSON. Billing reads no historical payload outside the requested window.
    period_scoped as materialized (
        select
            case
                when pg_catalog.jsonb_typeof(attempt.payload -> 'handwritingArchived') = 'boolean'
                    then (attempt.payload ->> 'handwritingArchived')::boolean
                else false
            end as handwriting_archived,
            case
                when pg_catalog.jsonb_typeof(attempt.payload -> 'questionDrawings') = 'array'
                     and pg_catalog.jsonb_array_length(attempt.payload -> 'questionDrawings') > 0
                    then pg_catalog.jsonb_array_length(attempt.payload -> 'questionDrawings')::bigint
                when attempt.payload #>> '{handwriting,summary,questionCount}' ~ '^[0-9]{1,12}$'
                    then (attempt.payload #>> '{handwriting,summary,questionCount}')::bigint
                else 0::bigint
            end as handwriting_question_count,
            case
                when attempt.payload ->> 'drawingStrokeCount' ~ '^[0-9]{1,12}$'
                    then (attempt.payload ->> 'drawingStrokeCount')::bigint
                when attempt.payload #>> '{handwriting,summary,strokeCount}' ~ '^[0-9]{1,12}$'
                    then (attempt.payload #>> '{handwriting,summary,strokeCount}')::bigint
                else 0::bigint
            end as handwriting_stroke_count
          from public.omr_attempts attempt
         where attempt.organization_id = pg_catalog.btrim(p_organization_id)
           and (p_exam_id is null or attempt.exam_id = pg_catalog.btrim(p_exam_id))
           and p_period_start is not null
           and attempt.finished_at >= p_period_start
           and attempt.finished_at < p_period_end
    ),
    period_totals as (
        select
            count(*)::bigint as attempt_count,
            count(*) filter (where period_scoped.handwriting_archived)::bigint
                as handwriting_archive_count,
            coalesce(sum(period_scoped.handwriting_question_count) filter (
                where period_scoped.handwriting_archived
            ), 0::numeric)::bigint as handwriting_question_count,
            coalesce(sum(period_scoped.handwriting_stroke_count) filter (
                where period_scoped.handwriting_archived
            ), 0::numeric)::bigint as handwriting_stroke_count
          from period_scoped
    )
    select
        count(*)::bigint as total_attempt_count,
        count(*) filter (where scoped.status = 'completed')::bigint,
        count(*) filter (where scoped.status = 'in_progress')::bigint,
        count(*) filter (where scoped.retake_source_attempt_id is null)::bigint,
        count(*) filter (
            where scoped.status = 'completed'
              and scoped.retake_source_attempt_id is null
        )::bigint,
        count(distinct scoped.student_scope_key)::bigint,
        coalesce(sum(scoped.score_percent) filter (
            where scoped.status = 'completed'
              and scoped.retake_source_attempt_id is null
        ), 0::numeric),
        coalesce(avg(scoped.score_percent) filter (
            where scoped.status = 'completed'
              and scoped.retake_source_attempt_id is null
        ), 0::numeric),
        (select period_totals.attempt_count from period_totals),
        (select period_totals.handwriting_archive_count from period_totals),
        (select period_totals.handwriting_question_count from period_totals),
        (select period_totals.handwriting_stroke_count from period_totals),
        statement_timestamp()
      from scoped;
end;
$$;

-- A statistics CSV must be internally consistent even while late handwriting
-- metadata or back-dated submissions arrive. Return the aggregate and bounded
-- completed rows from one STABLE statement snapshot as a single JSON value;
-- PostgREST therefore sees one row rather than applying its table-row ceiling.
drop function if exists public.omr_teacher_attempt_export_v1(text, text, integer);
create function public.omr_teacher_attempt_export_v1(
    p_organization_id text,
    p_exam_id text default null,
    p_limit integer default 5000
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    v_result jsonb;
begin
    if nullif(pg_catalog.btrim(p_organization_id), '') is null
       or pg_catalog.octet_length(p_organization_id) > 128 then
        raise exception 'invalid organization scope';
    end if;
    if p_exam_id is not null and (
        nullif(pg_catalog.btrim(p_exam_id), '') is null
        or pg_catalog.octet_length(p_exam_id) > 256
    ) then
        raise exception 'invalid exam scope';
    end if;
    if p_limit is null or p_limit < 1 or p_limit > 5000 then
        raise exception 'invalid export limit';
    end if;

    with aggregate_scoped as materialized (
        select
            attempt.id,
            attempt.status,
            attempt.score_percent,
            attempt.retake_source_attempt_id,
            coalesce(
                nullif(attempt.student_profile_id, ''),
                nullif(attempt.student_id, ''),
                'attempt:' || attempt.id
            ) as student_scope_key
          from public.omr_attempts attempt
         where attempt.organization_id = pg_catalog.btrim(p_organization_id)
           and (p_exam_id is null or attempt.exam_id = pg_catalog.btrim(p_exam_id))
    ),
    summary as (
        select
            count(*)::bigint as total_attempt_count,
            count(*) filter (where status = 'completed')::bigint as completed_attempt_count,
            count(*) filter (where status = 'in_progress')::bigint as in_progress_attempt_count,
            count(*) filter (where retake_source_attempt_id is null)::bigint as base_attempt_count,
            count(*) filter (
                where status = 'completed' and retake_source_attempt_id is null
            )::bigint as completed_base_attempt_count,
            count(distinct student_scope_key)::bigint as distinct_student_count,
            coalesce(sum(score_percent) filter (
                where status = 'completed' and retake_source_attempt_id is null
            ), 0::numeric) as completed_base_score_percent_sum,
            coalesce(avg(score_percent) filter (
                where status = 'completed' and retake_source_attempt_id is null
            ), 0::numeric) as completed_base_average_score_percent
          from aggregate_scoped
    ),
    bounded as materialized (
        select
            attempt.id as attempt_id,
            attempt.exam_id,
            pg_catalog.md5(
                pg_catalog.btrim(p_organization_id) || ':' || coalesce(
                    nullif(attempt.student_profile_id, ''),
                    nullif(attempt.student_id, ''),
                    'attempt:' || attempt.id
                )
            ) as student_scope_hash,
            attempt.status,
            attempt.score_percent,
            attempt.retake_source_attempt_id is not null as is_retake,
            case
                when pg_catalog.jsonb_typeof(attempt.payload -> 'handwritingArchived') = 'boolean'
                    then (attempt.payload ->> 'handwritingArchived')::boolean
                else false
            end as handwriting_archived,
            case
                when pg_catalog.jsonb_typeof(attempt.payload -> 'questionDrawings') = 'array'
                     and pg_catalog.jsonb_array_length(attempt.payload -> 'questionDrawings') > 0
                    then pg_catalog.jsonb_array_length(attempt.payload -> 'questionDrawings')::bigint
                when attempt.payload #>> '{handwriting,summary,questionCount}' ~ '^[0-9]{1,12}$'
                    then (attempt.payload #>> '{handwriting,summary,questionCount}')::bigint
                else 0::bigint
            end as handwriting_question_count,
            case
                when attempt.payload ->> 'drawingStrokeCount' ~ '^[0-9]{1,12}$'
                    then (attempt.payload ->> 'drawingStrokeCount')::bigint
                when attempt.payload #>> '{handwriting,summary,strokeCount}' ~ '^[0-9]{1,12}$'
                    then (attempt.payload #>> '{handwriting,summary,strokeCount}')::bigint
                else 0::bigint
            end as handwriting_stroke_count,
            attempt.started_at,
            attempt.finished_at
          from public.omr_attempts attempt
         where attempt.organization_id = pg_catalog.btrim(p_organization_id)
           and (p_exam_id is null or attempt.exam_id = pg_catalog.btrim(p_exam_id))
           and attempt.status = 'completed'
         order by attempt.finished_at desc, attempt.id desc
         limit p_limit + 1
    ),
    exported as (
        select
            count(*)::bigint as row_count,
            coalesce(
                pg_catalog.jsonb_agg(
                    pg_catalog.to_jsonb(bounded)
                    order by bounded.finished_at desc, bounded.attempt_id desc
                ),
                '[]'::jsonb
            ) as rows
          from bounded
    )
    select pg_catalog.jsonb_build_object(
        'status', case when exported.row_count > p_limit then 'capacity_exceeded' else 'loaded' end,
        'aggregate', pg_catalog.jsonb_build_object(
            'total_attempt_count', summary.total_attempt_count,
            'completed_attempt_count', summary.completed_attempt_count,
            'in_progress_attempt_count', summary.in_progress_attempt_count,
            'base_attempt_count', summary.base_attempt_count,
            'completed_base_attempt_count', summary.completed_base_attempt_count,
            'distinct_student_count', summary.distinct_student_count,
            'completed_base_score_percent_sum', summary.completed_base_score_percent_sum,
            'completed_base_average_score_percent', summary.completed_base_average_score_percent,
            'period_attempt_count', 0,
            'period_handwriting_archive_count', 0,
            'period_handwriting_question_count', 0,
            'period_handwriting_stroke_count', 0,
            'snapshot_at', pg_catalog.statement_timestamp()
        ),
        'rowCount', exported.row_count,
        'rows', case when exported.row_count > p_limit then '[]'::jsonb else exported.rows end
    )
      into v_result
      from summary cross join exported;
    return v_result;
end;
$$;

-- Export pages intentionally contain no name, profile id, answer body,
-- question-result JSON, or handwriting body. The dashboard exporter joins the
-- exam id to its already-authorized exam catalogue and reuses serializeCsvRows
-- for formula-injection neutralization of titles and labels.
drop function if exists public.omr_teacher_attempt_export_page_v1(text, text, timestamptz, timestamptz, text, integer);
create function public.omr_teacher_attempt_export_page_v1(
    p_organization_id text,
    p_exam_id text,
    p_snapshot_at timestamptz,
    p_after_finished_at timestamptz default null,
    p_after_id text default null,
    p_limit integer default 250
)
returns table (
    attempt_id text,
    exam_id text,
    student_scope_hash text,
    status text,
    score_percent numeric,
    is_retake boolean,
    handwriting_archived boolean,
    handwriting_question_count bigint,
    handwriting_stroke_count bigint,
    started_at timestamptz,
    finished_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
    if nullif(pg_catalog.btrim(p_organization_id), '') is null
       or pg_catalog.octet_length(p_organization_id) > 128 then
        raise exception 'invalid organization scope';
    end if;
    if p_exam_id is not null and (
        nullif(pg_catalog.btrim(p_exam_id), '') is null
        or pg_catalog.octet_length(p_exam_id) > 256
    ) then
        raise exception 'invalid exam scope';
    end if;
    if p_snapshot_at is null or p_snapshot_at > statement_timestamp() + interval '5 minutes' then
        raise exception 'invalid export snapshot';
    end if;
    if p_limit is null or p_limit < 1 or p_limit > 500 then
        raise exception 'invalid export page size';
    end if;
    if (p_after_finished_at is null) <> (p_after_id is null)
       or (
           p_after_id is not null
           and (
               nullif(pg_catalog.btrim(p_after_id), '') is null
               or pg_catalog.octet_length(p_after_id) > 256
           )
       ) then
        raise exception 'invalid export cursor';
    end if;

    return query
    select
        attempt.id,
        attempt.exam_id,
        pg_catalog.md5(
            pg_catalog.btrim(p_organization_id) || ':' || coalesce(
                nullif(attempt.student_profile_id, ''),
                nullif(attempt.student_id, ''),
                'attempt:' || attempt.id
            )
        ),
        attempt.status,
        attempt.score_percent,
        attempt.retake_source_attempt_id is not null,
        case
            when pg_catalog.jsonb_typeof(attempt.payload -> 'handwritingArchived') = 'boolean'
                then (attempt.payload ->> 'handwritingArchived')::boolean
            else false
        end,
        case
            when pg_catalog.jsonb_typeof(attempt.payload -> 'questionDrawings') = 'array'
                 and pg_catalog.jsonb_array_length(attempt.payload -> 'questionDrawings') > 0
                then pg_catalog.jsonb_array_length(attempt.payload -> 'questionDrawings')::bigint
            when attempt.payload #>> '{handwriting,summary,questionCount}' ~ '^[0-9]{1,12}$'
                then (attempt.payload #>> '{handwriting,summary,questionCount}')::bigint
            else 0::bigint
        end,
        case
            when attempt.payload ->> 'drawingStrokeCount' ~ '^[0-9]{1,12}$'
                then (attempt.payload ->> 'drawingStrokeCount')::bigint
            when attempt.payload #>> '{handwriting,summary,strokeCount}' ~ '^[0-9]{1,12}$'
                then (attempt.payload #>> '{handwriting,summary,strokeCount}')::bigint
            else 0::bigint
        end,
        attempt.started_at,
        attempt.finished_at
     from public.omr_attempts attempt
     where attempt.organization_id = pg_catalog.btrim(p_organization_id)
       and (p_exam_id is null or attempt.exam_id = pg_catalog.btrim(p_exam_id))
       and attempt.status = 'completed'
       and attempt.finished_at <= p_snapshot_at
       and (
           p_after_finished_at is null
           or (attempt.finished_at, attempt.id) < (p_after_finished_at, p_after_id)
       )
     order by attempt.finished_at desc, attempt.id desc
     limit p_limit;
end;
$$;

revoke all on function public.omr_teacher_attempt_aggregate_v1(text, text, timestamptz, timestamptz)
    from public, anon, authenticated;
revoke all on function public.omr_teacher_attempt_export_v1(text, text, integer)
    from public, anon, authenticated;
revoke all on function public.omr_teacher_attempt_export_page_v1(text, text, timestamptz, timestamptz, text, integer)
    from public, anon, authenticated;
grant execute on function public.omr_teacher_attempt_aggregate_v1(text, text, timestamptz, timestamptz)
    to service_role;
grant execute on function public.omr_teacher_attempt_export_v1(text, text, integer)
    to service_role;
grant execute on function public.omr_teacher_attempt_export_page_v1(text, text, timestamptz, timestamptz, text, integer)
    to service_role;

commit;
