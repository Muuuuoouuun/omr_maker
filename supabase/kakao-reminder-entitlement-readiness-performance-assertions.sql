\set ON_ERROR_STOP on

begin;

insert into public.omr_organizations (id, name, plan, metadata)
values ('kakao-readiness-perf-org', 'Kakao readiness performance', 'academy', '{}'::jsonb);
insert into public.omr_exams (
    id, organization_id, title, payload, created_at, updated_at, archived
) values (
    'kakao-readiness-perf-exam', 'kakao-readiness-perf-org', 'Readiness performance',
    '{"id":"kakao-readiness-perf-exam"}'::jsonb,
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(), false
);

insert into public.omr_kakao_candidate_reviews (
    id, organization_id, exam_id, candidate_kind, channel, status, title,
    target_count, student_ids, student_names, group_names, region_names,
    message_preview, reviewed_by_user_id, payload, reviewed_at, updated_at,
    entitlement_state
)
select 'kakao:readiness:review:' || series::text,
       'kakao-readiness-perf-org', 'kakao-readiness-perf-exam', 'missing_exam',
       'kakao', 'ready', 'Ready ' || series::text, 0, '{}'::text[], '{}'::text[],
       '{}'::text[], '{}'::text[], 'Ready', 'readiness-operator', '{}'::jsonb,
       pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(), 'trusted'
  from pg_catalog.generate_series(1, 20000) series;
insert into public.omr_kakao_candidate_reviews (
    id, organization_id, exam_id, candidate_kind, channel, status, title,
    target_count, student_ids, student_names, group_names, region_names,
    message_preview, reviewed_by_user_id, payload, reviewed_at, updated_at,
    entitlement_state
) values (
    'kakao:readiness:review:unresolved', null, 'kakao-readiness-perf-exam',
    'missing_exam', 'kakao', 'ready', 'Unresolved', 0, '{}'::text[], '{}'::text[],
    '{}'::text[], '{}'::text[], 'Unresolved', 'readiness-operator', '{}'::jsonb,
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(), 'legacy_unreconciled'
);

insert into public.omr_kakao_dispatch_logs (
    id, organization_id, review_id, exam_id, channel, provider, status,
    target_count, student_ids, message_preview, payload, created_at,
    entitlement_state
)
select 'kakao:readiness:dispatch:' || series::text,
       'kakao-readiness-perf-org', 'kakao:readiness:review:1',
       'kakao-readiness-perf-exam', 'kakao', 'simulation', 'queued', 0,
       '{}'::text[], 'Ready', '{}'::jsonb, pg_catalog.clock_timestamp(), 'trusted'
  from pg_catalog.generate_series(1, 20000) series;
insert into public.omr_kakao_dispatch_logs (
    id, organization_id, review_id, exam_id, channel, provider, status,
    target_count, student_ids, message_preview, payload, created_at,
    entitlement_state
) values (
    'kakao:readiness:dispatch:unresolved', 'kakao-readiness-perf-org',
    'kakao:readiness:review:unresolved', 'kakao-readiness-perf-exam', 'kakao',
    'simulation', 'queued', 0, '{}'::text[], 'Unresolved', '{}'::jsonb,
    pg_catalog.clock_timestamp(), 'legacy_unreconciled'
);

analyze public.omr_kakao_candidate_reviews;
analyze public.omr_kakao_dispatch_logs;

do $kakao_readiness_index_plan$
declare
    review_plan json;
    dispatch_plan json;
begin
    execute $query$
        explain (analyze, buffers, format json)
        select 1 from public.omr_kakao_candidate_reviews
         where entitlement_state = 'legacy_unreconciled' limit 1
    $query$ into review_plan;
    execute $query$
        explain (analyze, buffers, format json)
        select 1 from public.omr_kakao_dispatch_logs
         where entitlement_state = 'legacy_unreconciled' limit 1
    $query$ into dispatch_plan;
    if review_plan::text not like '%omr_kakao_candidate_reviews_unreconciled_idx%'
       or review_plan::text like '%Seq Scan%'
       or dispatch_plan::text not like '%omr_kakao_dispatch_logs_unreconciled_idx%'
       or dispatch_plan::text like '%Seq Scan%'
       or (review_plan #>> '{0,Execution Time}')::numeric >= 100
       or (dispatch_plan #>> '{0,Execution Time}')::numeric >= 100
       or public.omr_kakao_reminder_entitlement_ready_v1() then
        raise exception 'Kakao unresolved readiness did not use bounded partial-index probes: %, %',
            review_plan, dispatch_plan;
    end if;
end
$kakao_readiness_index_plan$;

update public.omr_kakao_dispatch_logs
   set entitlement_state = 'quarantined'
 where entitlement_state = 'legacy_unreconciled';
update public.omr_kakao_candidate_reviews
   set entitlement_state = 'quarantined'
 where entitlement_state = 'legacy_unreconciled';

do $kakao_readiness_after_quarantine$
begin
    if not public.omr_kakao_reminder_entitlement_ready_v1() then
        raise exception 'Kakao readiness did not recover after indexed quarantine';
    end if;
end
$kakao_readiness_after_quarantine$;

rollback;
