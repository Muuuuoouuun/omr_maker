\set ON_ERROR_STOP on

-- Committed fixtures are visible to the two independent dblink sessions.
insert into public.omr_organizations (id, name, plan, metadata) values
    ('pilot_org_aaaaaaaaaaaaaaaaaaaaaaaa', 'Kakao Race A', 'free', '{}'::jsonb),
    ('pilot_org_bbbbbbbbbbbbbbbbbbbbbbbb', 'Kakao Race B', 'free', '{}'::jsonb);

insert into public.omr_teacher_accounts (
    id, email, display_name, password_hash, status, email_verified_at,
    session_generation
) values
    ('teacher_9999999999999999', 'kakao-race-a@example.test', 'Race A',
     'pbkdf2-sha256:120000:0123456789abcdef0123456789abcdef:' || repeat('a', 64),
     'active', pg_catalog.clock_timestamp(), 31),
    ('teacher_8888888888888888', 'kakao-race-b@example.test', 'Race B',
     'pbkdf2-sha256:120000:0123456789abcdef0123456789abcdef:' || repeat('b', 64),
     'active', pg_catalog.clock_timestamp(), 32);

insert into public.omr_organization_members (
    organization_id, user_id, email, display_name, role, status
) values
    ('pilot_org_aaaaaaaaaaaaaaaaaaaaaaaa', 'teacher_9999999999999999', 'kakao-race-a@example.test', 'Race A', 'owner', 'active'),
    ('pilot_org_bbbbbbbbbbbbbbbbbbbbbbbb', 'teacher_8888888888888888', 'kakao-race-b@example.test', 'Race B', 'owner', 'active');

insert into public.omr_teacher_profiles (organization_id, user_id, display_name, status) values
    ('pilot_org_aaaaaaaaaaaaaaaaaaaaaaaa', 'teacher_9999999999999999', 'Race A', 'active'),
    ('pilot_org_bbbbbbbbbbbbbbbbbbbbbbbb', 'teacher_8888888888888888', 'Race B', 'active');

insert into public.omr_pilot_plan_grants (
    id, idempotency_key_hash, request_hash, organization_id, account_id,
    plan, expires_at, state
) values
    ('pilot_grant_999999999999999999999999', repeat('6', 64), repeat('a', 64),
     'pilot_org_aaaaaaaaaaaaaaaaaaaaaaaa', 'teacher_9999999999999999', 'pro',
     pg_catalog.clock_timestamp() + interval '1 day', 'active'),
    ('pilot_grant_888888888888888888888888', repeat('7', 64), repeat('b', 64),
     'pilot_org_bbbbbbbbbbbbbbbbbbbbbbbb', 'teacher_8888888888888888', 'pro',
     pg_catalog.clock_timestamp() + interval '1 day', 'active');

insert into public.omr_exams (
    id, organization_id, title, payload, created_by_user_id,
    created_at, updated_at, archived
) values
    ('kakao-race-exam-a', 'pilot_org_aaaaaaaaaaaaaaaaaaaaaaaa', 'Race Exam A',
     '{"id":"kakao-race-exam-a"}'::jsonb, 'teacher_9999999999999999',
     pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(), false),
    ('kakao-race-exam-b', 'pilot_org_bbbbbbbbbbbbbbbbbbbbbbbb', 'Race Exam B',
     '{"id":"kakao-race-exam-b"}'::jsonb, 'teacher_8888888888888888',
     pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp(), false);

select extensions.dblink_connect(
    'kakao_race_a',
    'host=127.0.0.1 port=' || pg_catalog.inet_server_port()
        || ' dbname=' || pg_catalog.current_database()
        || ' user=' || current_user
        || ' password=' || :'kakao_dblink_password'
);
select extensions.dblink_connect(
    'kakao_race_b',
    'host=127.0.0.1 port=' || pg_catalog.inet_server_port()
        || ' dbname=' || pg_catalog.current_database()
        || ' user=' || current_user
        || ' password=' || :'kakao_dblink_password'
);

select extensions.dblink_send_query(
    'kakao_race_a',
    $race_a$
    do $worker$
    declare v_result jsonb;
    begin
        v_result := public.omr_save_kakao_candidate_review_v1(
            'account', 'teacher_9999999999999999', 31,
            'pilot_org_aaaaaaaaaaaaaaaaaaaaaaaa', 'teacher_9999999999999999',
            jsonb_build_object(
                'id', 'kakao:race:same-review', 'examId', 'kakao-race-exam-a',
                'candidateKind', 'missing_exam', 'status', 'ready',
                'title', 'Race A', 'targetCount', 1,
                'studentIds', jsonb_build_array('race-student-a'),
                'studentNames', jsonb_build_array('학생 A'),
                'groupNames', '[]'::jsonb, 'regionNames', '[]'::jsonb,
                'messagePreview', 'Race A reminder', 'reason', null,
                'href', '/dashboard?exam=kakao-race-exam-a'
            )
        );
        if v_result ->> 'status' <> 'saved' then
            raise exception 'race A review failed: %', v_result;
        end if;
        perform pg_sleep(1);
    end
    $worker$;
    $race_a$
);
select pg_catalog.pg_sleep(0.1);

do $review_race_assertion$
declare v_result jsonb;
begin
    select result into v_result
      from extensions.dblink(
          'kakao_race_b',
          $$select public.omr_save_kakao_candidate_review_v1(
              'account', 'teacher_8888888888888888', 32,
              'pilot_org_bbbbbbbbbbbbbbbbbbbbbbbb', 'teacher_8888888888888888',
              jsonb_build_object(
                  'id', 'kakao:race:same-review', 'examId', 'kakao-race-exam-b',
                  'candidateKind', 'missing_exam', 'status', 'ready',
                  'title', 'Race B', 'targetCount', 1,
                  'studentIds', jsonb_build_array('race-student-b'),
                  'studentNames', jsonb_build_array('학생 B'),
                  'groupNames', '[]'::jsonb, 'regionNames', '[]'::jsonb,
                  'messagePreview', 'Race B reminder', 'reason', null,
                  'href', '/dashboard?exam=kakao-race-exam-b'
              )
          )$$
      ) result(result jsonb);
    if v_result ->> 'status' <> 'unauthorized' then
        raise exception 'cross-tenant absent review ID race was not denied: %', v_result;
    end if;
end
$review_race_assertion$;

select status from extensions.dblink_get_result('kakao_race_a') result(status text);

do $review_row_assertion$
begin
    if (select pg_catalog.count(*) from public.omr_kakao_candidate_reviews
         where id = 'kakao:race:same-review') <> 1
       or not exists (
           select 1 from public.omr_kakao_candidate_reviews
            where id = 'kakao:race:same-review'
              and organization_id = 'pilot_org_aaaaaaaaaaaaaaaaaaaaaaaa'
              and exam_id = 'kakao-race-exam-a'
              and entitlement_state = 'trusted'
       ) then
        raise exception 'same review ID race overwrote tenant scope';
    end if;
end
$review_row_assertion$;

-- The dispatch identifier is global too. Give tenant B its own exact trusted
-- review, then race both tenants for one previously absent dispatch ID.
do $seed_race_b_review$
declare v_result jsonb;
begin
    select result into v_result
      from extensions.dblink(
          'kakao_race_b',
          $$select public.omr_save_kakao_candidate_review_v1(
              'account', 'teacher_8888888888888888', 32,
              'pilot_org_bbbbbbbbbbbbbbbbbbbbbbbb', 'teacher_8888888888888888',
              jsonb_build_object(
                  'id', 'kakao:race:review-b', 'examId', 'kakao-race-exam-b',
                  'candidateKind', 'missing_exam', 'status', 'ready',
                  'title', 'Race B dispatch', 'targetCount', 1,
                  'studentIds', jsonb_build_array('race-student-b'),
                  'studentNames', jsonb_build_array('학생 B'),
                  'groupNames', '[]'::jsonb, 'regionNames', '[]'::jsonb,
                  'messagePreview', 'Race B reminder', 'reason', null,
                  'href', '/dashboard?exam=kakao-race-exam-b'
              )
          )$$
      ) result(result jsonb);
    if v_result ->> 'status' <> 'saved' then
        raise exception 'race B review seed failed: %', v_result;
    end if;
end
$seed_race_b_review$;

select extensions.dblink_connect(
    'kakao_dispatch_a',
    'host=127.0.0.1 port=' || pg_catalog.inet_server_port()
        || ' dbname=' || pg_catalog.current_database()
        || ' user=' || current_user
        || ' password=' || :'kakao_dblink_password'
);

select extensions.dblink_send_query(
    'kakao_dispatch_a',
    $dispatch_race_a$
    do $worker$
    declare v_result jsonb;
    begin
        v_result := public.omr_save_kakao_simulation_dispatch_v1(
            'account', 'teacher_9999999999999999', 31,
            'pilot_org_aaaaaaaaaaaaaaaaaaaaaaaa', 'teacher_9999999999999999',
            jsonb_build_object(
                'id', 'kakao:race:same-dispatch',
                'reviewId', 'kakao:race:same-review',
                'examId', 'kakao-race-exam-a',
                'status', 'queued',
                'providerMessageId', null,
                'errorMessage', null
            )
        );
        if v_result ->> 'status' <> 'saved' then
            raise exception 'race A dispatch failed: %', v_result;
        end if;
        perform pg_sleep(1);
    end
    $worker$;
    $dispatch_race_a$
);
select pg_catalog.pg_sleep(0.1);

do $dispatch_race_assertion$
declare v_result jsonb;
begin
    select result into v_result
      from extensions.dblink(
          'kakao_race_b',
          $$select public.omr_save_kakao_simulation_dispatch_v1(
              'account', 'teacher_8888888888888888', 32,
              'pilot_org_bbbbbbbbbbbbbbbbbbbbbbbb', 'teacher_8888888888888888',
              jsonb_build_object(
                  'id', 'kakao:race:same-dispatch',
                  'reviewId', 'kakao:race:review-b',
                  'examId', 'kakao-race-exam-b',
                  'status', 'queued',
                  'providerMessageId', null,
                  'errorMessage', null
              )
          )$$
      ) result(result jsonb);
    if v_result ->> 'status' <> 'unauthorized' then
        raise exception 'cross-tenant absent dispatch ID race was not denied: %', v_result;
    end if;
end
$dispatch_race_assertion$;

select status from extensions.dblink_get_result('kakao_dispatch_a') result(status text);

do $dispatch_row_assertion$
begin
    if (select pg_catalog.count(*) from public.omr_kakao_dispatch_logs
         where id = 'kakao:race:same-dispatch') <> 1
       or not exists (
           select 1 from public.omr_kakao_dispatch_logs
            where id = 'kakao:race:same-dispatch'
              and organization_id = 'pilot_org_aaaaaaaaaaaaaaaaaaaaaaaa'
              and review_id = 'kakao:race:same-review'
              and exam_id = 'kakao-race-exam-a'
              and entitlement_state = 'trusted'
       ) then
        raise exception 'same dispatch ID race overwrote tenant scope';
    end if;
end
$dispatch_row_assertion$;

select extensions.dblink_disconnect('kakao_dispatch_a');
select extensions.dblink_disconnect('kakao_race_a');
select extensions.dblink_disconnect('kakao_race_b');

delete from public.omr_kakao_dispatch_logs where id = 'kakao:race:same-dispatch';
delete from public.omr_kakao_candidate_reviews
 where id in ('kakao:race:same-review', 'kakao:race:review-b');
delete from public.omr_exams where id in ('kakao-race-exam-a', 'kakao-race-exam-b');
delete from public.omr_pilot_plan_grants where id in (
    'pilot_grant_999999999999999999999999',
    'pilot_grant_888888888888888888888888'
);
delete from public.omr_teacher_profiles where user_id in ('teacher_9999999999999999', 'teacher_8888888888888888');
delete from public.omr_organization_members where user_id in ('teacher_9999999999999999', 'teacher_8888888888888888');
delete from public.omr_teacher_accounts where id in ('teacher_9999999999999999', 'teacher_8888888888888888');
delete from public.omr_organizations where id in (
    'pilot_org_aaaaaaaaaaaaaaaaaaaaaaaa',
    'pilot_org_bbbbbbbbbbbbbbbbbbbbbbbb'
);
