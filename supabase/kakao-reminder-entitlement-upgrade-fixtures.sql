\set ON_ERROR_STOP on

-- This file is applied immediately before 202608100002. It intentionally uses
-- the pre-boundary schema: no entitlement_state column or Kakao RPC exists yet.
insert into public.omr_organizations (id, name, plan, metadata) values
    ('kakao-upgrade-valid-org', 'Kakao valid legacy', 'academy', '{}'::jsonb),
    ('kakao-upgrade-ambiguous-org', 'Kakao ambiguous legacy', 'academy', '{}'::jsonb);

insert into public.omr_exams (
    id, organization_id, title, payload, created_at, updated_at, archived
) values
    ('kakao-upgrade-valid-exam', 'kakao-upgrade-valid-org', 'Valid legacy exam',
     '{"id":"kakao-upgrade-valid-exam"}'::jsonb,
     pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(), false),
    ('kakao-upgrade-ambiguous-exam', 'kakao-upgrade-ambiguous-org', 'Ambiguous legacy exam',
     '{"id":"kakao-upgrade-ambiguous-exam"}'::jsonb,
     pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(), false);

insert into public.omr_kakao_candidate_reviews (
    id, organization_id, exam_id, candidate_kind, channel, status, title,
    target_count, student_ids, student_names, group_names, region_names,
    message_preview, reason, href, reviewed_by_user_id, payload,
    reviewed_at, updated_at
) values
    (
        'kakao:upgrade:valid-review', 'kakao-upgrade-valid-org',
        'kakao-upgrade-valid-exam', 'missing_exam', 'kakao', 'ready',
        'Validated legacy review', 1, array['legacy-student-safe'], array['학생 안전'],
        '{}'::text[], '{}'::text[], 'Validated legacy payload', null,
        '/dashboard?exam=kakao-upgrade-valid-exam', 'legacy-operator',
        '{"fixture":"valid-preserve-v1"}'::jsonb,
        pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp()
    ),
    (
        'kakao:upgrade:ambiguous-review', null,
        'kakao-upgrade-ambiguous-exam', 'missing_exam', 'kakao', 'ready',
        'Ambiguous legacy review', 1, array['legacy-student-ambiguous'], array['학생 보존'],
        '{}'::text[], '{}'::text[], 'Ambiguous legacy payload', null,
        '/dashboard?exam=kakao-upgrade-ambiguous-exam', 'legacy-operator',
        '{"fixture":"ambiguous-preserve-v1","opaque":"must-survive"}'::jsonb,
        pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp()
    );

insert into public.omr_kakao_dispatch_logs (
    id, organization_id, review_id, exam_id, channel, provider, status,
    target_count, student_ids, message_preview, provider_message_id,
    error_message, payload, created_at, sent_at
) values
    (
        'kakao:upgrade:valid-dispatch', 'kakao-upgrade-valid-org',
        'kakao:upgrade:valid-review', 'kakao-upgrade-valid-exam', 'kakao',
        'simulation', 'sent', 1, array['legacy-student-safe'],
        'Validated legacy payload', 'legacy-provider-safe', null,
        '{"fixture":"valid-dispatch-preserve-v1"}'::jsonb,
        pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp()
    ),
    (
        'kakao:upgrade:ambiguous-dispatch', 'kakao-upgrade-ambiguous-org',
        'kakao:upgrade:ambiguous-review', 'kakao-upgrade-ambiguous-exam', 'kakao',
        'simulation', 'queued', 1, array['legacy-student-ambiguous'],
        'Ambiguous legacy payload', null, null,
        '{"fixture":"ambiguous-dispatch-preserve-v1"}'::jsonb,
        pg_catalog.clock_timestamp(), null
    );
