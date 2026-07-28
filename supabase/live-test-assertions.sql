\set ON_ERROR_STOP on

grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update, delete on all tables in schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to service_role;

do $$
begin
    if not exists (
        select 1
          from pg_class relation
          join pg_namespace namespace on namespace.oid = relation.relnamespace
         where namespace.nspname = 'public'
           and relation.relname = 'omr_remote_assets'
           and relation.relforcerowsecurity
    ) then
        raise exception 'remote asset registry must FORCE RLS';
    end if;
    if not exists (
        select 1
          from pg_class relation
          join pg_namespace namespace on namespace.oid = relation.relnamespace
         where namespace.nspname = 'public'
           and relation.relname = 'omr_student_start_credentials'
           and relation.relforcerowsecurity
    ) then
        raise exception 'student credential registry must FORCE RLS';
    end if;
    if not exists (
        select 1 from storage.buckets
         where id = 'omr-private-assets'
           and public = false
    ) then
        raise exception 'private remote asset bucket was not provisioned';
    end if;
end
$$;

insert into public.omr_organizations (id, name) values
    ('live-org-a', 'Live Org A'),
    ('live-org-b', 'Live Org B');

insert into public.omr_organization_members (
    organization_id, user_id, role, status
) values
    ('live-org-a', '11111111-1111-4111-8111-111111111111', 'owner', 'active'),
    ('live-org-b', '22222222-2222-4222-8222-222222222222', 'owner', 'active');

insert into public.omr_exams (
    id, organization_id, title, payload, created_at, updated_at
) values
    ('live-exam-a', 'live-org-a', 'Org A Exam', '{"id":"live-exam-a","title":"Org A Exam","questions":[],"createdAt":"2026-07-14T00:00:00.000Z"}', now(), now()),
    ('live-exam-b', 'live-org-b', 'Org B Exam', '{"id":"live-exam-b","title":"Org B Exam","questions":[],"createdAt":"2026-07-14T00:00:00.000Z"}', now(), now());

set role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);

do $$
declare
    visible_exam_count integer;
begin
    select count(*) into visible_exam_count from public.omr_exams;
    if visible_exam_count <> 1 then
        raise exception 'teacher A must see exactly one organization exam, saw %', visible_exam_count;
    end if;
end
$$;

insert into public.omr_exams (
    id, organization_id, title, payload, created_at, updated_at
) values (
    'live-exam-a-created', 'live-org-a', 'Teacher A Exam',
    '{"id":"live-exam-a-created","title":"Teacher A Exam","questions":[],"createdAt":"2026-07-14T00:00:00.000Z"}',
    now(), now()
);

do $$
begin
    begin
        insert into public.omr_exams (
            id, organization_id, title, payload, created_at, updated_at
        ) values (
            'live-cross-org-write', 'live-org-b', 'Forbidden',
            '{"id":"live-cross-org-write","title":"Forbidden","questions":[],"createdAt":"2026-07-14T00:00:00.000Z"}',
            now(), now()
        );
        raise exception 'cross-organization insert unexpectedly succeeded';
    exception
        when insufficient_privilege then null;
    end;
end
$$;

reset role;
set role anon;

do $$
declare
    visible_exam_count integer;
begin
    select count(*) into visible_exam_count from public.omr_exams;
    if visible_exam_count <> 0 then
        raise exception 'anonymous role must not read canonical exams, saw %', visible_exam_count;
    end if;
end
$$;

reset role;

do $$
begin
    if has_function_privilege('anon', 'public.omr_submit_attempt_v1(text,jsonb,jsonb)', 'execute') then
        raise exception 'anon unexpectedly has attempt RPC execute privilege';
    end if;
    if has_function_privilege('authenticated', 'public.omr_submit_attempt_v1(text,jsonb,jsonb)', 'execute') then
        raise exception 'authenticated unexpectedly has attempt RPC execute privilege';
    end if;
    if not has_function_privilege('service_role', 'public.omr_submit_attempt_v1(text,jsonb,jsonb)', 'execute') then
        raise exception 'service_role must have attempt RPC execute privilege';
    end if;
    if has_function_privilege('anon', 'public.omr_submit_session_attempt_v1(jsonb,jsonb)', 'execute')
        or has_function_privilege('authenticated', 'public.omr_submit_session_attempt_v1(jsonb,jsonb)', 'execute')
    then
        raise exception 'browser roles unexpectedly have session attempt RPC execute privilege';
    end if;
    if not has_function_privilege('service_role', 'public.omr_submit_session_attempt_v1(jsonb,jsonb)', 'execute') then
        raise exception 'service_role must have session attempt RPC execute privilege';
    end if;
    if has_function_privilege('anon', 'public.omr_claim_guest_attempts_v1(text,text,text,text,text,text,text[])', 'execute')
        or has_function_privilege('authenticated', 'public.omr_claim_guest_attempts_v1(text,text,text,text,text,text,text[])', 'execute')
    then
        raise exception 'browser roles unexpectedly have guest claim RPC execute privilege';
    end if;
    if not has_function_privilege('service_role', 'public.omr_claim_guest_attempts_v1(text,text,text,text,text,text,text[])', 'execute') then
        raise exception 'service_role must have guest claim RPC execute privilege';
    end if;
    if has_function_privilege('anon', 'public.omr_save_remote_asset_metadata_v1(jsonb)', 'execute')
        or has_function_privilege('authenticated', 'public.omr_save_remote_asset_metadata_v1(jsonb)', 'execute')
    then
        raise exception 'browser roles unexpectedly have remote asset metadata RPC execute privilege';
    end if;
    if not has_function_privilege('service_role', 'public.omr_save_remote_asset_metadata_v1(jsonb)', 'execute') then
        raise exception 'service_role must have remote asset metadata RPC execute privilege';
    end if;
    if pg_catalog.to_regprocedure('public.omr_mark_feedback_opened(text,timestamptz)') is not null then
        raise exception 'legacy unscoped feedback RPC still exists';
    end if;
    if has_function_privilege('anon', 'public.omr_save_exam_v1(jsonb,jsonb)', 'execute')
        or has_function_privilege('authenticated', 'public.omr_save_exam_v1(jsonb,jsonb)', 'execute')
    then
        raise exception 'browser roles unexpectedly have teacher exam RPC execute privilege';
    end if;
    if not has_function_privilege('service_role', 'public.omr_save_exam_v1(jsonb,jsonb)', 'execute') then
        raise exception 'service_role must have teacher exam RPC execute privilege';
    end if;
    if has_function_privilege('anon', 'public.omr_delete_exam_v1(text,text)', 'execute')
        or has_function_privilege('authenticated', 'public.omr_delete_exam_v1(text,text)', 'execute')
    then
        raise exception 'browser roles unexpectedly have teacher exam delete RPC execute privilege';
    end if;
    if not has_function_privilege('service_role', 'public.omr_delete_exam_v1(text,text)', 'execute') then
        raise exception 'service_role must have teacher exam delete RPC execute privilege';
    end if;
    if has_function_privilege('anon', 'public.omr_attach_attempt_handwriting_v1(text,text,jsonb)', 'execute')
        or has_function_privilege('authenticated', 'public.omr_attach_attempt_handwriting_v1(text,text,jsonb)', 'execute')
    then
        raise exception 'browser roles unexpectedly have handwriting RPC execute privilege';
    end if;
    if pg_catalog.to_regprocedure('public.omr_teacher_update_attempt_v1(text,jsonb,jsonb)') is not null then
        raise exception 'legacy broad teacher attempt RPC still exists';
    end if;
    if has_function_privilege('anon', 'public.omr_answer_attempt_question_v1(text,text,text,text,text,text,text)', 'execute')
        or has_function_privilege('authenticated', 'public.omr_answer_attempt_question_v1(text,text,text,text,text,text,text)', 'execute')
        or has_function_privilege('anon', 'public.omr_set_subquestion_review_v1(text,text,text,text,text,text,text)', 'execute')
        or has_function_privilege('authenticated', 'public.omr_set_subquestion_review_v1(text,text,text,text,text,text,text)', 'execute')
        or has_function_privilege('anon', 'public.omr_force_finish_attempts_v1(text,text[],timestamptz,text,text,text,jsonb)', 'execute')
        or has_function_privilege('authenticated', 'public.omr_force_finish_attempts_v1(text,text[],timestamptz,text,text,text,jsonb)', 'execute')
    then
        raise exception 'browser roles unexpectedly have scoped teacher attempt RPC execute privilege';
    end if;
    if not has_function_privilege('service_role', 'public.omr_answer_attempt_question_v1(text,text,text,text,text,text,text)', 'execute')
        or not has_function_privilege('service_role', 'public.omr_set_subquestion_review_v1(text,text,text,text,text,text,text)', 'execute')
        or not has_function_privilege('service_role', 'public.omr_force_finish_attempts_v1(text,text[],timestamptz,text,text,text,jsonb)', 'execute')
    then
        raise exception 'service_role must have scoped teacher attempt RPC execute privilege';
    end if;
    if has_function_privilege('anon', 'public.omr_save_roster_v1(text,jsonb,jsonb,jsonb,jsonb)', 'execute')
        or has_function_privilege('authenticated', 'public.omr_save_roster_v1(text,jsonb,jsonb,jsonb,jsonb)', 'execute')
    then
        raise exception 'browser roles unexpectedly have teacher roster RPC execute privilege';
    end if;
    if not has_function_privilege('service_role', 'public.omr_save_roster_v1(text,jsonb,jsonb,jsonb,jsonb)', 'execute') then
        raise exception 'service_role must have teacher roster RPC execute privilege';
    end if;
    if has_function_privilege('anon', 'public.omr_save_feedback_v1(text,jsonb)', 'execute')
        or has_function_privilege('authenticated', 'public.omr_save_feedback_v1(text,jsonb)', 'execute')
        or has_function_privilege('anon', 'public.omr_return_feedback_v1(text,text,timestamp with time zone)', 'execute')
        or has_function_privilege('authenticated', 'public.omr_return_feedback_v1(text,text,timestamp with time zone)', 'execute')
        or has_function_privilege('anon', 'public.omr_mark_feedback_opened_v2(text,text,text,timestamp with time zone)', 'execute')
        or has_function_privilege('authenticated', 'public.omr_mark_feedback_opened_v2(text,text,text,timestamp with time zone)', 'execute')
    then
        raise exception 'browser roles unexpectedly have feedback RPC execute privilege';
    end if;
    if not has_function_privilege('service_role', 'public.omr_save_feedback_v1(text,jsonb)', 'execute')
        or not has_function_privilege('service_role', 'public.omr_return_feedback_v1(text,text,timestamp with time zone)', 'execute')
        or not has_function_privilege('service_role', 'public.omr_mark_feedback_opened_v2(text,text,text,timestamp with time zone)', 'execute')
    then
        raise exception 'service_role must have feedback RPC execute privilege';
    end if;
    if has_function_privilege('anon', 'public.omr_service_readiness_v1()', 'execute')
        or has_function_privilege('authenticated', 'public.omr_service_readiness_v1()', 'execute')
    then
        raise exception 'browser roles unexpectedly have readiness RPC execute privilege';
    end if;
    if not has_function_privilege('service_role', 'public.omr_service_readiness_v1()', 'execute') then
        raise exception 'service_role must have readiness RPC execute privilege';
    end if;
    if has_function_privilege('anon', 'public.omr_production_boundary_preflight_v1()', 'execute')
        or has_function_privilege('authenticated', 'public.omr_production_boundary_preflight_v1()', 'execute')
        or has_function_privilege('anon', 'public.omr_assert_production_boundary_preflight_v1()', 'execute')
        or has_function_privilege('authenticated', 'public.omr_assert_production_boundary_preflight_v1()', 'execute')
    then
        raise exception 'browser roles unexpectedly have production-boundary preflight execute privilege';
    end if;
    if not has_function_privilege('service_role', 'public.omr_production_boundary_preflight_v1()', 'execute')
        or not has_function_privilege('service_role', 'public.omr_assert_production_boundary_preflight_v1()', 'execute')
    then
        raise exception 'service_role must have production-boundary preflight execute privilege';
    end if;
end
$$;

set role service_role;

select public.omr_save_roster_v1(
    'live-org-a',
    '[{"id":"live-class-a","organization_id":"live-org-a","name":"A반","status":"active","metadata":{}}]',
    '[{"id":"live-student-a","organization_id":"live-org-a","display_name":"학생 A","external_id":"A-001","status":"active","metadata":{}}]',
    '[{"class_id":"live-class-a","organization_id":"live-org-a","student_profile_id":"live-student-a","enrollment_status":"active"}]',
    '[{"id":"live-invite-a","organization_id":"live-org-a","email":"invite@example.com","sent_at":"2026-07-14T00:00:00.000Z","status":"pending"}]'
);

do $$
begin
    if not exists (
        select 1 from public.omr_class_students
         where organization_id = 'live-org-a'
           and class_id = 'live-class-a'
           and student_profile_id = 'live-student-a'
           and enrollment_status = 'active'
    ) then
        raise exception 'teacher roster RPC did not persist the canonical enrollment';
    end if;
end
$$;

insert into public.omr_student_start_credentials (
    organization_id, student_profile_id, start_code_hash
) values (
    'live-org-a', 'live-student-a',
    'pbkdf2-sha256:10000:07070707070707070707070707070707:8de12bc47d04bf0f520b627acee8c21c74b064b9f30fc943efaf7b2788e45e94'
);

select public.omr_save_roster_v1(
    'live-org-a',
    '[{"id":"live-class-a","organization_id":"live-org-a","name":"A반","status":"active","metadata":{}}]',
    '[]',
    '[]',
    '[{"id":"live-invite-a","organization_id":"live-org-a","email":"invite@example.com","sent_at":"2026-07-14T00:00:00.000Z","status":"pending"}]'
);

do $$
begin
    if exists (
        select 1 from public.omr_student_start_credentials
         where organization_id = 'live-org-a'
           and student_profile_id = 'live-student-a'
    ) then
        raise exception 'issue-first serialized outcome retained a credential';
    end if;
end
$$;

do $$
begin
    begin
        insert into public.omr_student_start_credentials (
            organization_id, student_profile_id, start_code_hash
        ) values (
            'live-org-a', 'live-student-a',
            'pbkdf2-sha256:10000:08080808080808080808080808080808:9df12bc47d04bf0f520b627acee8c21c74b064b9f30fc943efaf7b2788e45e95'
        );
        raise exception 'post-withdraw service-role credential mutation unexpectedly succeeded';
    exception
        when check_violation then null;
    end;
end
$$;

select public.omr_save_roster_v1(
    'live-org-a',
    '[{"id":"live-class-a","organization_id":"live-org-a","name":"A반","status":"active","metadata":{}}]',
    '[{"id":"live-student-a","organization_id":"live-org-a","display_name":"학생 A 재등록","external_id":"A-001","status":"active","metadata":{}}]',
    '[{"class_id":"live-class-a","organization_id":"live-org-a","student_profile_id":"live-student-a","enrollment_status":"active"}]',
    '[{"id":"live-invite-a","organization_id":"live-org-a","email":"invite@example.com","sent_at":"2026-07-14T00:00:00.000Z","status":"pending"}]'
);

do $$
begin
    if exists (
        select 1 from public.omr_student_start_credentials
         where organization_id = 'live-org-a'
           and student_profile_id = 'live-student-a'
    ) then
        raise exception 're-adding a deterministic student id resurrected the old start credential';
    end if;
end
$$;

select public.omr_save_roster_v1(
    'live-org-a',
    '[{"id":"live-class-a","organization_id":"live-org-a","name":"A반","status":"active","metadata":{}}]',
    '[]',
    '[]',
    '[{"id":"live-invite-a","organization_id":"live-org-a","email":"invite@example.com","sent_at":"2026-07-14T00:00:00.000Z","status":"pending"}]'
);

do $$
begin
    begin
        insert into public.omr_student_start_credentials (
            organization_id, student_profile_id, start_code_hash
        ) values (
            'live-org-a', 'live-student-a',
            'pbkdf2-sha256:10000:09090909090909090909090909090909:adf12bc47d04bf0f520b627acee8c21c74b064b9f30fc943efaf7b2788e45e96'
        );
        raise exception 'withdraw-first serialized outcome accepted a credential';
    exception
        when check_violation then null;
    end;
end
$$;

select public.omr_save_roster_v1(
    'live-org-a',
    '[{"id":"live-class-a","organization_id":"live-org-a","name":"A반","status":"active","metadata":{}}]',
    '[{"id":"live-student-a","organization_id":"live-org-a","display_name":"학생 A 재등록","external_id":"A-001","status":"active","metadata":{}}]',
    '[{"class_id":"live-class-a","organization_id":"live-org-a","student_profile_id":"live-student-a","enrollment_status":"active"}]',
    '[{"id":"live-invite-a","organization_id":"live-org-a","email":"invite@example.com","sent_at":"2026-07-14T00:00:00.000Z","status":"pending"}]'
);

insert into public.omr_classes (id, organization_id, name) values
    ('live-class-b', 'live-org-b', 'B반');
insert into public.omr_student_profiles (id, organization_id, display_name) values
    ('live-student-b', 'live-org-b', '학생 B');

do $$
begin
    begin
        perform public.omr_save_roster_v1(
            'live-org-a',
            '[]',
            '[]',
            '[{"class_id":"live-class-b","organization_id":"live-org-a","student_profile_id":"live-student-b","enrollment_status":"active"}]',
            '[]'
        );
        raise exception 'cross-organization roster enrollment unexpectedly succeeded';
    exception
        when raise_exception then
            if sqlerrm = 'cross-organization roster enrollment unexpectedly succeeded' then
                raise;
            end if;
    end;

    if not exists (
        select 1 from public.omr_class_students
         where organization_id = 'live-org-a'
           and class_id = 'live-class-a'
           and student_profile_id = 'live-student-a'
           and enrollment_status = 'active'
    ) then
        raise exception 'failed roster RPC did not roll back its partial changes';
    end if;
end
$$;

insert into public.omr_attempts (
    id, organization_id, exam_id, student_name, student_id, identity_type,
    payload, started_at, finished_at
) values (
    'live-guest-attempt-a', 'live-org-a', 'live-exam-a', 'Guest A',
    'guest:live-guest-a', 'guest',
    '{
        "id":"live-guest-attempt-a",
        "guestId":"live-guest-a",
        "studentId":"guest:live-guest-a",
        "custom":{"preserved":true},
        "questionResults":[{
            "questionId":1,
            "studentId":"guest:live-guest-a",
            "status":"wrong",
            "analytics":{"skill":"fraction"}
        }]
    }',
    '2026-07-28T00:00:00.000Z', '2026-07-28T00:10:00.000Z'
);

insert into public.omr_question_results (
    id, organization_id, attempt_id, exam_id, student_name, student_id,
    identity_type, question_id, question_number, status, finished_at, payload
) values (
    'live-guest-attempt-a:1', 'live-org-a', 'live-guest-attempt-a',
    'live-exam-a', 'Guest A', 'guest:live-guest-a', 'guest', 1, 1, 'wrong',
    '2026-07-28T00:10:00.000Z',
    '{"questionId":1,"studentId":"guest:live-guest-a","analytics":{"skill":"fraction"}}'
);

do $$
declare
    acknowledged text[];
    attempt_payload jsonb;
    result_payload jsonb;
begin
    select public.omr_claim_guest_attempts_v1(
        'live-guest-a',
        'live-student-a',
        'live-org-a',
        'live-class-a',
        '학생 A',
        'A반',
        array['live-guest-attempt-a', 'live-local-only-a']
    ) into acknowledged;

    if acknowledged is distinct from array['live-guest-attempt-a']::text[] then
        raise exception 'guest claim must ACK only canonical attempt ids, got %', acknowledged;
    end if;

    select payload into attempt_payload
      from public.omr_attempts
     where id = 'live-guest-attempt-a';
    select payload into result_payload
      from public.omr_question_results
     where id = 'live-guest-attempt-a:1';

    if attempt_payload->>'studentId' <> 'live-student-a'
        or attempt_payload ? 'guestId'
        or attempt_payload#>>'{questionResults,0,studentId}' <> 'live-student-a'
        or attempt_payload#>>'{questionResults,0,analytics,skill}' <> 'fraction'
        or attempt_payload#>>'{custom,preserved}' <> 'true'
    then
        raise exception 'guest claim did not preserve and rewrite nested attempt payload: %', attempt_payload;
    end if;
    if result_payload->>'studentId' <> 'live-student-a'
        or result_payload#>>'{analytics,skill}' <> 'fraction'
    then
        raise exception 'guest claim did not preserve and rewrite result payload: %', result_payload;
    end if;

    select public.omr_claim_guest_attempts_v1(
        'live-guest-a',
        'live-student-a',
        'live-org-a',
        'live-class-a',
        '학생 A',
        'A반',
        array['live-guest-attempt-a']
    ) into acknowledged;
    if acknowledged is distinct from array['live-guest-attempt-a']::text[] then
        raise exception 'guest claim retry must remain idempotently acknowledged';
    end if;
end
$$;

update public.omr_student_profiles
   set user_id = '33333333-3333-4333-8333-333333333333'
 where id = 'live-student-a'
   and organization_id = 'live-org-a';

insert into public.omr_assignments (
    id, organization_id, exam_id, class_id, title, access_mode, status
) values (
    'live-assignment-a', 'live-org-a', 'live-exam-a', 'live-class-a',
    'Live Assignment', 'class', 'open'
);

insert into public.omr_assignment_submissions (
    id, organization_id, assignment_id, exam_id, student_profile_id,
    student_user_id, status, score, total_score
) values (
    'live-submission-a', 'live-org-a', 'live-assignment-a', 'live-exam-a',
    'live-student-a', '33333333-3333-4333-8333-333333333333',
    'graded', 1, 1
);

reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', '33333333-3333-4333-8333-333333333333', false);

do $$
begin
    update public.omr_assignment_submissions
       set score = 999,
           status = 'graded'
     where id = 'live-submission-a';
    if found then
        raise exception 'student unexpectedly mutated a canonical gradebook row';
    end if;
end
$$;

reset role;
set role service_role;

select public.omr_save_exam_v1(
    '{
        "id":"live-exam-gateway",
        "organization_id":"live-org-a",
        "title":"Gateway Exam",
        "payload":{"id":"live-exam-gateway","title":"Gateway Exam","questions":[{"id":1,"number":1,"answer":2,"score":1}],"createdAt":"2026-07-14T00:00:00.000Z"},
        "created_by_user_id":"11111111-1111-4111-8111-111111111111",
        "created_at":"2026-07-14T00:00:00.000Z",
        "updated_at":"2026-07-14T00:00:00.000Z",
        "archived":false
    }',
    '[{
        "id":"live-exam-gateway:1",
        "organization_id":"live-org-a",
        "exam_id":"live-exam-gateway",
        "question_id":1,
        "question_number":1,
        "canonical_question_id":"live-exam-gateway:1",
        "choices":5,
        "correct_answer":2,
        "score":1,
        "payload":{"id":1,"number":1,"answer":2,"score":1},
        "updated_at":"2026-07-14T00:00:00.000Z"
    }]'
);

do $$
begin
    if (select count(*) from public.omr_exams where id = 'live-exam-gateway') <> 1
        or (select count(*) from public.omr_exam_questions where exam_id = 'live-exam-gateway') <> 1
    then
        raise exception 'teacher exam RPC did not persist the canonical aggregate';
    end if;

    begin
        perform public.omr_save_exam_v1(
            '{
                "id":"live-exam-rollback",
                "organization_id":"live-org-a",
                "title":"Rollback Exam",
                "payload":{"id":"live-exam-rollback","title":"Rollback Exam","questions":[],"createdAt":"2026-07-14T00:00:00.000Z"},
                "created_at":"2026-07-14T00:00:00.000Z",
                "updated_at":"2026-07-14T00:00:00.000Z"
            }',
            '[{"exam_id":"wrong-exam","organization_id":"live-org-a"}]'
        );
        raise exception 'cross-scope teacher save unexpectedly succeeded';
    exception
        when raise_exception then
            if sqlerrm = 'cross-scope teacher save unexpectedly succeeded' then
                raise;
            end if;
    end;

    if exists (select 1 from public.omr_exams where id = 'live-exam-rollback') then
        raise exception 'failed teacher RPC left a partial exam';
    end if;

    begin
        perform public.omr_save_exam_v1(
            '{
                "id":"live-exam-b",
                "organization_id":"live-org-a",
                "title":"Cross-org takeover",
                "payload":{"id":"live-exam-b","title":"Cross-org takeover","questions":[]},
                "updated_at":"2026-07-14T00:00:00.000Z"
            }',
            '[]'
        );
        raise exception 'cross-organization exam identifier takeover unexpectedly succeeded';
    exception
        when raise_exception then
            if sqlerrm = 'cross-organization exam identifier takeover unexpectedly succeeded' then
                raise;
            end if;
    end;

    if not exists (
        select 1 from public.omr_exams
         where id = 'live-exam-b'
           and organization_id = 'live-org-b'
           and title = 'Org B Exam'
    ) then
        raise exception 'failed cross-organization save mutated the existing exam';
    end if;
end
$$;

select * from public.omr_submit_attempt_v1(
    'live-ticket-1',
    '{
        "id":"attempt_live-ticket-1",
        "organization_id":"live-org-a",
        "exam_id":"live-exam-a",
        "student_name":"Live Student",
        "student_id":"live-student-owner",
        "status":"completed",
        "score":1,
        "total_score":1,
        "score_percent":100,
        "retake_question_ids":[],
        "payload":{"id":"attempt_live-ticket-1","examId":"live-exam-a","studentName":"Live Student","score":1,"totalScore":1,"startedAt":"2026-07-14T00:00:00.000Z","finishedAt":"2026-07-14T00:01:00.000Z"},
        "started_at":"2026-07-14T00:00:00.000Z",
        "finished_at":"2026-07-14T00:01:00.000Z"
    }',
    '[{
        "id":"attempt_live-ticket-1:1",
        "organization_id":"live-org-a",
        "attempt_id":"attempt_live-ticket-1",
        "exam_id":"live-exam-a",
        "student_name":"Live Student",
        "student_id":"live-student-owner",
        "question_id":1,
        "question_number":1,
        "mistake_types":[],
        "prerequisites":[],
        "status":"correct",
        "is_correct":true,
        "is_wrong":false,
        "is_unanswered":false,
        "score":1,
        "earned_score":1,
        "finished_at":"2026-07-14T00:01:00.000Z",
        "payload":{"questionId":1,"status":"correct"},
        "created_at":"2026-07-14T00:01:00.000Z",
        "updated_at":"2026-07-14T00:01:00.000Z"
    }]'
);

select * from public.omr_submit_attempt_v1(
    'live-ticket-1',
    '{
        "id":"attempt_live-ticket-1",
        "organization_id":"live-org-a",
        "exam_id":"live-exam-a",
        "student_name":"Live Student",
        "student_id":"live-student-owner",
        "status":"completed",
        "score":1,
        "total_score":1,
        "score_percent":100,
        "retake_question_ids":[],
        "payload":{"id":"attempt_live-ticket-1","examId":"live-exam-a","studentName":"Live Student","score":1,"totalScore":1,"startedAt":"2026-07-14T00:00:00.000Z","finishedAt":"2026-07-14T00:01:00.000Z"},
        "started_at":"2026-07-14T00:00:00.000Z",
        "finished_at":"2026-07-14T00:01:00.000Z"
    }',
    '[]'
);

do $$
begin
    if (select count(*) from public.omr_attempts where ticket_id = 'live-ticket-1') <> 1 then
        raise exception 'attempt RPC is not idempotent';
    end if;
    if (select count(*) from public.omr_question_results where attempt_id = 'attempt_live-ticket-1') <> 1 then
        raise exception 'question results were duplicated or lost';
    end if;
end
$$;

select * from public.omr_submit_session_attempt_v1(
    (select to_jsonb(attempt) from public.omr_attempts attempt where id = 'attempt_live-ticket-1'),
    (select coalesce(jsonb_agg(to_jsonb(result)), '[]'::jsonb)
       from public.omr_question_results result
      where attempt_id = 'attempt_live-ticket-1')
);

do $$
begin
    begin
        perform public.omr_submit_attempt_v1(
            'live-ticket-rollback',
            '{
                "id":"attempt_live-ticket-rollback",
                "organization_id":"live-org-a",
                "exam_id":"live-exam-a",
                "student_name":"Rollback Student",
                "status":"completed",
                "score":0,
                "total_score":1,
                "score_percent":0,
                "retake_question_ids":[],
                "payload":{},
                "started_at":"2026-07-14T00:00:00.000Z",
                "finished_at":"2026-07-14T00:01:00.000Z"
            }',
            '[{"attempt_id":"wrong-attempt","exam_id":"live-exam-a","organization_id":"live-org-a"}]'
        );
        raise exception 'invalid result scope unexpectedly succeeded';
    exception
        when raise_exception then
            if sqlerrm = 'invalid result scope unexpectedly succeeded' then
                raise;
            end if;
    end;

    if exists (select 1 from public.omr_attempts where ticket_id = 'live-ticket-rollback') then
        raise exception 'failed RPC left a partial attempt row';
    end if;

    begin
        perform public.omr_submit_attempt_v1(
            'live-ticket-null-results',
            '{
                "id":"attempt_live-ticket-null-results",
                "organization_id":"live-org-a",
                "exam_id":"live-exam-a",
                "student_name":"Null Results Student",
                "status":"completed",
                "score":0,
                "total_score":1,
                "score_percent":0,
                "retake_question_ids":[],
                "payload":{},
                "started_at":"2026-07-14T00:00:00.000Z",
                "finished_at":"2026-07-14T00:01:00.000Z"
            }',
            null::jsonb
        );
        raise exception 'null question-result payload unexpectedly succeeded';
    exception
        when raise_exception then
            if sqlerrm = 'null question-result payload unexpectedly succeeded' then
                raise;
            end if;
    end;

    if exists (select 1 from public.omr_attempts where ticket_id = 'live-ticket-null-results') then
        raise exception 'rejected null result payload left a partial attempt row';
    end if;
end
$$;

update public.omr_attempts
   set status = 'in_progress',
       class_id = 'live-class-a',
       score = 0,
       total_score = 0,
       score_percent = 0,
       payload = payload || '{
           "status":"in_progress",
           "classId":"live-class-a",
           "answers":{"1":2},
           "score":0,
           "totalScore":0,
           "questionResults":[],
           "studentQuestions":[{
               "questionId":1,
               "questionNumber":1,
               "body":"왜 정답인가요?",
               "createdAt":"2026-07-14T00:01:00.000Z",
               "status":"queued"
           }],
           "subQuestionAnswers":{
               "1":{
                   "reason":{
                       "schemaVersion":1,
                       "body":"근거",
                       "reviewStatus":"needs_review"
                   }
               }
           }
       }'::jsonb
 where id = 'attempt_live-ticket-1'
   and organization_id = 'live-org-a';

insert into public.omr_class_teachers (
    class_id, organization_id, teacher_user_id, class_role
) values
    ('live-class-a', 'live-org-a', 'live-teacher-assigned', 'grader'),
    ('live-class-b', 'live-org-b', 'live-teacher-cross-class', 'grader');

do $$
begin
    begin
        perform public.omr_answer_attempt_question_v1(
            'live-org-a',
            'attempt_live-ticket-1',
            '1',
            'unassigned',
            'live-teacher-unassigned',
            'teacher',
            '미배정 교사'
        );
        raise exception 'unassigned teacher mutation unexpectedly succeeded';
    exception
        when raise_exception then
            if sqlerrm = 'unassigned teacher mutation unexpectedly succeeded' then
                raise;
            end if;
    end;
    begin
        perform public.omr_answer_attempt_question_v1(
            'live-org-a',
            'attempt_live-ticket-1',
            '1',
            'cross class',
            'live-teacher-cross-class',
            'teacher',
            '다른 반 교사'
        );
        raise exception 'cross-class teacher mutation unexpectedly succeeded';
    exception
        when raise_exception then
            if sqlerrm = 'cross-class teacher mutation unexpectedly succeeded' then
                raise;
            end if;
    end;
end
$$;

select * from public.omr_answer_attempt_question_v1(
    'live-org-a',
    'attempt_live-ticket-1',
    '1',
    '첫 답변',
    'live-teacher-assigned',
    'teacher',
    '담당 교사'
);

do $$
declare
    v_answered_at jsonb;
begin
    select payload #> '{studentQuestions,0,answer,createdAt}'
      into v_answered_at
      from public.omr_attempts
     where id = 'attempt_live-ticket-1';

    perform public.omr_answer_attempt_question_v1(
        'live-org-a',
        'attempt_live-ticket-1',
        '1',
        '첫 답변',
        'live-teacher-assigned',
        'teacher',
        '담당 교사'
    );
    if (select payload #> '{studentQuestions,0,answer,createdAt}'
          from public.omr_attempts
         where id = 'attempt_live-ticket-1') is distinct from v_answered_at
    then
        raise exception 'answer retry changed the authoritative timestamp';
    end if;
    if (select payload #>> '{studentQuestions,0,answer,body}'
          from public.omr_attempts
         where id = 'attempt_live-ticket-1') <> '첫 답변'
    then
        raise exception 'scoped answer RPC did not update the selected question';
    end if;
    if (select payload #>> '{studentQuestions,0,answer,teacherName}'
          from public.omr_attempts
         where id = 'attempt_live-ticket-1') <> '담당 교사'
    then
        raise exception 'scoped answer RPC did not persist trusted attribution';
    end if;
    begin
        perform public.omr_answer_attempt_question_v1(
            'live-org-b',
            'attempt_live-ticket-1',
            '1',
            'cross organization',
            '22222222-2222-4222-8222-222222222222',
            'owner',
            'Org B Owner'
        );
        raise exception 'cross-organization teacher answer unexpectedly succeeded';
    exception
        when raise_exception then
            if sqlerrm = 'cross-organization teacher answer unexpectedly succeeded' then
                raise;
            end if;
    end;
end
$$;

update public.omr_class_teachers
   set class_role = 'viewer'
 where class_id = 'live-class-a'
   and teacher_user_id = 'live-teacher-assigned';
do $$
begin
    begin
        perform public.omr_answer_attempt_question_v1(
            'live-org-a',
            'attempt_live-ticket-1',
            '1',
            'downgraded role',
            'live-teacher-assigned',
            'teacher',
            '담당 교사'
        );
        raise exception 'role downgrade did not revoke teacher attempt mutation';
    exception
        when raise_exception then
            if sqlerrm = 'role downgrade did not revoke teacher attempt mutation' then
                raise;
            end if;
    end;
end
$$;
update public.omr_class_teachers
   set class_role = 'grader'
 where class_id = 'live-class-a'
   and teacher_user_id = 'live-teacher-assigned';

select * from public.omr_set_subquestion_review_v1(
    'live-org-a',
    'attempt_live-ticket-1',
    '1:reason',
    'reviewed',
    'live-teacher-assigned',
    'teacher',
    '담당 교사'
);

update public.omr_exams
   set payload = '{
       "id":"live-exam-a",
       "organizationId":"live-org-a",
       "title":"Org A Exam",
       "questions":[
           {"id":1,"number":1,"answer":2,"score":4,"choices":5},
           {"id":2,"number":2,"answer":3,"score":6,"choices":5}
       ],
       "createdAt":"2026-07-14T00:00:00.000Z"
   }'::jsonb,
       updated_at = '2026-07-14T00:01:30.000Z'
 where id = 'live-exam-a'
   and organization_id = 'live-org-a';

select * from public.omr_force_finish_attempts_v1(
    'live-org-a',
    array['attempt_live-ticket-1'],
    '2026-07-14T00:02:00.000Z',
    'live-teacher-assigned',
    'teacher',
    '담당 교사',
    jsonb_build_array(jsonb_build_object(
        'attempt_id', 'attempt_live-ticket-1',
        'expected_answers', '{"1":2}'::jsonb,
        'expected_is_retake', false,
        'expected_retake_question_ids', '[]'::jsonb,
        'expected_exam_updated_at', '2026-07-14T00:01:30.000Z',
        'score', 4,
        'total_score', 10,
        'question_results', '[
            {"questionId":1,"questionNumber":1,"status":"correct","score":4,"earnedScore":4},
            {"questionId":2,"questionNumber":2,"status":"unanswered","score":6,"earnedScore":0}
        ]'::jsonb,
        'question_result_rows', '[
            {
                "id":"attempt_live-ticket-1:1",
                "organization_id":"live-org-a",
                "class_id":"live-class-a",
                "attempt_id":"attempt_live-ticket-1",
                "exam_id":"live-exam-a",
                "student_name":"Live Student",
                "student_id":"live-student-owner",
                "question_id":1,
                "question_number":1,
                "mistake_types":[],
                "prerequisites":[],
                "selected_answer":2,
                "correct_answer":2,
                "status":"correct",
                "is_correct":true,
                "is_wrong":false,
                "is_unanswered":false,
                "score":4,
                "earned_score":4,
                "finished_at":"2026-07-14T00:02:00.000Z",
                "payload":{"questionId":1,"status":"correct"},
                "created_at":"2026-07-14T00:02:00.000Z",
                "updated_at":"2026-07-14T00:02:00.000Z"
            },
            {
                "id":"attempt_live-ticket-1:2",
                "organization_id":"live-org-a",
                "class_id":"live-class-a",
                "attempt_id":"attempt_live-ticket-1",
                "exam_id":"live-exam-a",
                "student_name":"Live Student",
                "student_id":"live-student-owner",
                "question_id":2,
                "question_number":2,
                "mistake_types":[],
                "prerequisites":[],
                "correct_answer":3,
                "status":"unanswered",
                "is_correct":false,
                "is_wrong":false,
                "is_unanswered":true,
                "score":6,
                "earned_score":0,
                "finished_at":"2026-07-14T00:02:00.000Z",
                "payload":{"questionId":2,"status":"unanswered"},
                "created_at":"2026-07-14T00:02:00.000Z",
                "updated_at":"2026-07-14T00:02:00.000Z"
            }
        ]'::jsonb
    ))
);

do $$
declare
    v_first_finished_at timestamptz;
begin
    if (select status from public.omr_attempts where id = 'attempt_live-ticket-1') <> 'completed' then
        raise exception 'force finish did not complete the selected attempt';
    end if;
    if (select score from public.omr_attempts where id = 'attempt_live-ticket-1') <> 4
        or (select total_score from public.omr_attempts where id = 'attempt_live-ticket-1') <> 10
    then
        raise exception 'force finish did not persist canonical grading';
    end if;
    if (select student_id from public.omr_attempts where id = 'attempt_live-ticket-1') <> 'live-student-owner' then
        raise exception 'scoped teacher mutation changed the canonical student';
    end if;
    if (select count(*) from public.omr_question_results where attempt_id = 'attempt_live-ticket-1') <> 2
        or (select status from public.omr_question_results where id = 'attempt_live-ticket-1:1') <> 'correct'
        or (select status from public.omr_question_results where id = 'attempt_live-ticket-1:2') <> 'unanswered'
    then
        raise exception 'force finish did not replace canonical question results';
    end if;
    if (select payload #>> '{subQuestionAnswers,1,reason,reviewStatus}'
          from public.omr_attempts
         where id = 'attempt_live-ticket-1') <> 'reviewed'
    then
        raise exception 'subquestion review RPC did not update the selected response';
    end if;
    if (select payload #>> '{subQuestionAnswers,1,reason,reviewedBy}'
          from public.omr_attempts
         where id = 'attempt_live-ticket-1') <> '담당 교사'
    then
        raise exception 'subquestion review RPC did not persist trusted attribution';
    end if;

    select finished_at into v_first_finished_at
      from public.omr_attempts
     where id = 'attempt_live-ticket-1';
    perform public.omr_force_finish_attempts_v1(
        'live-org-a',
        array['attempt_live-ticket-1'],
        '2026-07-14T00:03:00.000Z',
        'live-teacher-assigned',
        'teacher',
        '담당 교사',
        jsonb_build_array(jsonb_build_object(
            'attempt_id', 'attempt_live-ticket-1',
            'expected_answers', '{"1":2}'::jsonb,
            'expected_is_retake', false,
            'expected_retake_question_ids', '[]'::jsonb,
            'expected_exam_updated_at', '2026-07-14T00:01:30.000Z',
            'score', 0,
            'total_score', 0,
            'question_results', '[]'::jsonb,
            'question_result_rows', '[]'::jsonb
        ))
    );
    if (select finished_at from public.omr_attempts where id = 'attempt_live-ticket-1') is distinct from v_first_finished_at
        or (select score from public.omr_attempts where id = 'attempt_live-ticket-1') <> 4
        or (select count(*) from public.omr_question_results where attempt_id = 'attempt_live-ticket-1') <> 2
    then
        raise exception 'force finish retry changed canonical completion';
    end if;
end
$$;

update public.omr_attempts
   set student_profile_id = 'live-student-a'
 where id = 'attempt_live-ticket-1'
   and organization_id = 'live-org-a';

select public.omr_save_feedback_v1(
    'live-org-a',
    '{
        "id":"feedback:attempt_live-ticket-1",
        "organization_id":"live-org-a",
        "attempt_id":"attempt_live-ticket-1",
        "exam_id":"live-exam-a",
        "student_profile_id":"live-student-a",
        "teacher_user_id":"11111111-1111-4111-8111-111111111111",
        "status":"draft",
        "summary":"Live feedback",
        "question_comments":[{"id":"c1","questionId":1,"questionNumber":1,"body":"Review","visibility":"student_visible"}],
        "markup_drawings":{"1":["M 0 0 L 1 1"]},
        "download_policy":{"allowStudentDownload":false,"allowAnnotatedPdfDownload":false,"watermarkStudentName":true},
        "notification_status":"not_queued",
        "notification_channel":"in_app",
        "open_count":0,
        "payload":{"id":"feedback:attempt_live-ticket-1","attemptId":"attempt_live-ticket-1","examId":"live-exam-a","studentProfileId":"live-student-a","status":"draft","questionComments":[],"downloadPolicy":{"allowStudentDownload":false,"allowAnnotatedPdfDownload":false,"watermarkStudentName":true},"delivery":{"notificationStatus":"not_queued","notificationChannel":"in_app","openCount":0},"createdAt":"2026-07-14T00:02:00.000Z","updatedAt":"2026-07-14T00:02:00.000Z"},
        "created_at":"2026-07-14T00:02:00.000Z",
        "updated_at":"2026-07-14T00:02:00.000Z"
    }'
);

do $$
begin
    if not exists (
        select 1 from public.omr_attempt_feedback
         where id = 'feedback:attempt_live-ticket-1'
           and organization_id = 'live-org-a'
           and student_profile_id = 'live-student-a'
           and status = 'draft'
           and markup_drawings #>> '{1,0}' = 'M 0 0 L 1 1'
    ) then
        raise exception 'feedback save RPC did not persist the scoped draft';
    end if;

    begin
        perform public.omr_save_feedback_v1(
            'live-org-b',
            '{"id":"feedback:cross-org","organization_id":"live-org-b","attempt_id":"attempt_live-ticket-1","exam_id":"live-exam-a","student_profile_id":"live-student-a","status":"draft","payload":{}}'
        );
        raise exception 'cross-organization feedback save unexpectedly succeeded';
    exception
        when raise_exception then
            if sqlerrm = 'cross-organization feedback save unexpectedly succeeded' then
                raise;
            end if;
    end;
end
$$;

select public.omr_return_feedback_v1(
    'live-org-a',
    'feedback:attempt_live-ticket-1',
    '2026-07-14T00:03:00.000Z'
);

do $$
declare
    wrong_student_result public.omr_attempt_feedback;
begin
    select public.omr_mark_feedback_opened_v2(
        'live-org-a', 'live-student-b', 'feedback:attempt_live-ticket-1', '2026-07-14T00:04:00.000Z'
    ) into wrong_student_result;
    if wrong_student_result is not null then
        raise exception 'another student unexpectedly opened feedback';
    end if;
    if (select open_count from public.omr_attempt_feedback where id = 'feedback:attempt_live-ticket-1') <> 0 then
        raise exception 'wrong-student open attempt mutated feedback';
    end if;

    perform public.omr_mark_feedback_opened_v2(
        'live-org-a', 'live-student-a', 'feedback:attempt_live-ticket-1', '2026-07-14T00:05:00.000Z'
    );
    if not exists (
        select 1 from public.omr_attempt_feedback
         where id = 'feedback:attempt_live-ticket-1'
           and status = 'returned'
           and notification_status = 'sent'
           and open_count = 1
           and first_opened_at = '2026-07-14T00:05:00.000Z'
    ) then
        raise exception 'student-scoped feedback open receipt was not persisted';
    end if;
end
$$;

select public.omr_save_remote_asset_metadata_v1(
    '{
        "id":"live-handwriting-asset",
        "organization_id":"live-org-a",
        "kind":"attempt_handwriting",
        "attempt_id":"attempt_live-ticket-1",
        "storage_bucket":"omr-private-assets",
        "object_path":"organizations/live-org-a/attempts/attempt_live-ticket-1/handwriting/live-handwriting-asset.json",
        "mime_type":"application/json",
        "byte_size":2,
        "sha256_hex":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "created_at":"2026-07-14T00:04:00.000Z",
        "updated_at":"2026-07-14T00:04:00.000Z"
    }'
);

select public.omr_attach_attempt_handwriting_v1(
    'live-ticket-1',
    'live-handwriting-asset',
    '{"store":"remote","key":"live-handwriting-asset","organizationId":"live-org-a","kind":"attempt_handwriting","attemptId":"attempt_live-ticket-1"}'
);

do $$
begin
    if not exists (
        select 1 from public.omr_attempts
         where ticket_id = 'live-ticket-1'
           and payload #>> '{drawingsRef,key}' = 'live-handwriting-asset'
           and payload ->> 'handwritingArchived' = 'true'
    ) then
        raise exception 'handwriting attachment was not persisted on the official attempt';
    end if;
end
$$;

insert into public.omr_student_start_credentials (
    organization_id, student_profile_id, start_code_hash
) values
    (
        'live-org-a',
        'live-student-a',
        'pbkdf2-sha256:10000:0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    ),
    (
        'live-org-b',
        'live-student-b',
        'pbkdf2-sha256:10000:0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    )
on conflict (organization_id, student_profile_id) do update
set start_code_hash = excluded.start_code_hash,
    updated_at = now();

insert into public.omr_organization_members (
    organization_id, user_id, role, status
) values
    ('live-org-a', 'live-teacher-assigned', 'teacher', 'active'),
    ('live-org-b', 'live-teacher-cross-class', 'teacher', 'active')
on conflict (organization_id, user_id) do update
set role = excluded.role,
    status = excluded.status,
    updated_at = now();

insert into public.omr_teacher_profiles (
    organization_id, user_id, display_name, status
) values
    ('live-org-a', 'live-teacher-assigned', '담당 교사', 'active'),
    ('live-org-b', 'live-teacher-cross-class', '다른 반 교사', 'active')
on conflict (organization_id, user_id) do update
set display_name = excluded.display_name,
    status = excluded.status,
    updated_at = now();

insert into public.omr_exam_questions (
    id, organization_id, class_id, exam_id, question_id, question_number,
    canonical_question_id, choices, correct_answer, score, payload, updated_at
) values
    (
        'live-exam-a:1', 'live-org-a', 'live-class-a', 'live-exam-a', 1, 1,
        'live-exam-a:1', 5, 2, 4, '{"id":1,"number":1,"answer":2,"score":4}', now()
    ),
    (
        'live-exam-a:2', 'live-org-a', 'live-class-a', 'live-exam-a', 2, 2,
        'live-exam-a:2', 5, 3, 6, '{"id":2,"number":2,"answer":3,"score":6}', now()
    )
on conflict (exam_id, question_id) do update
set organization_id = excluded.organization_id,
    class_id = excluded.class_id,
    canonical_question_id = excluded.canonical_question_id,
    correct_answer = excluded.correct_answer,
    score = excluded.score,
    payload = excluded.payload,
    updated_at = excluded.updated_at;

do $$
declare
    diagnostics jsonb;
    candidate_hash text;
    original_hash text;
begin
    select start_code_hash
      into original_hash
      from public.omr_student_start_credentials
     where organization_id = 'live-org-a'
       and student_profile_id = 'live-student-a';

    update public.omr_student_start_credentials
       set start_code_hash =
           'pbkdf2-sha256:00010000:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
     where organization_id = 'live-org-a'
       and student_profile_id = 'live-student-a';
    diagnostics := public.omr_production_boundary_preflight_v1();
    if (diagnostics->>'students_without_credentials')::bigint <> 0 then
        raise exception 'uppercase PBKDF2 credential was rejected';
    end if;

    foreach candidate_hash in array array[
        'pbkdf2-sha256:9999:' || repeat('a', 32) || ':' || repeat('b', 64),
        'pbkdf2-sha256:1000001:' || repeat('a', 32) || ':' || repeat('b', 64),
        'pbkdf2-sha256:999999999999999999999999:' || repeat('a', 32) || ':' || repeat('b', 64),
        'pbkdf2-sha256:10000:' || repeat('a', 33) || ':' || repeat('b', 64),
        'pbkdf2-sha256:10000:' || repeat('a', 129) || ':' || repeat('b', 64),
        'pbkdf2-sha256:10000:' || repeat('a', 130) || ':' || repeat('b', 64),
        'pbkdf2-sha256:10000:' || repeat('a', 32) || ':' || repeat('b', 63),
        'pbkdf2-sha512:10000:' || repeat('a', 32) || ':' || repeat('b', 64),
        'pbkdf2-sha256:10000:' || repeat('a', 32) || ':' || repeat('b', 64) || ':extra'
    ]
    loop
        update public.omr_student_start_credentials
           set start_code_hash = candidate_hash
         where organization_id = 'live-org-a'
           and student_profile_id = 'live-student-a';
        diagnostics := public.omr_production_boundary_preflight_v1();
        if (diagnostics->>'students_without_credentials')::bigint <> 1 then
            raise exception 'unsafe PBKDF2 boundary fixture was accepted';
        end if;
    end loop;

    execute 'alter table public.omr_student_start_credentials alter column start_code_hash drop not null';
    update public.omr_student_start_credentials
       set start_code_hash = null
     where organization_id = 'live-org-a'
       and student_profile_id = 'live-student-a';
    diagnostics := public.omr_production_boundary_preflight_v1();
    if (diagnostics->>'students_without_credentials')::bigint <> 1 then
        raise exception 'NULL PBKDF2 boundary fixture was accepted';
    end if;
    update public.omr_student_start_credentials
       set start_code_hash = original_hash
     where organization_id = 'live-org-a'
       and student_profile_id = 'live-student-a';
    execute 'alter table public.omr_student_start_credentials alter column start_code_hash set not null';
end
$$;

do $$
declare
    diagnostics jsonb;
begin
    insert into public.omr_class_students (
        class_id, organization_id, student_profile_id, enrollment_status
    ) values (
        'live-class-b', 'live-org-a', 'live-student-a', 'active'
    );
    diagnostics := public.omr_production_boundary_preflight_v1();
    if (diagnostics->>'cross_organization_rows')::bigint < 1 then
        raise exception 'class-student cross-organization fixture was not detected';
    end if;
    delete from public.omr_class_students
     where class_id = 'live-class-b'
       and student_profile_id = 'live-student-a';

    insert into public.omr_class_teachers (
        class_id, organization_id, teacher_user_id, class_role
    ) values (
        'live-class-a', 'live-org-a', 'live-teacher-cross-class', 'grader'
    );
    diagnostics := public.omr_production_boundary_preflight_v1();
    if (diagnostics->>'orphan_rows')::bigint < 1
        or (diagnostics->>'cross_organization_rows')::bigint < 1
    then
        raise exception 'class-teacher exact membership fixture was not detected';
    end if;
    delete from public.omr_class_teachers
     where class_id = 'live-class-a'
       and teacher_user_id = 'live-teacher-cross-class';
end
$$;

do $$
declare
    diagnostics jsonb;
    assert_message text;
begin
    insert into public.omr_question_results (
        id, organization_id, class_id, attempt_id, exam_id,
        student_name, question_id, question_number, status,
        is_correct, is_wrong, is_unanswered, score, earned_score,
        finished_at, payload
    ) values (
        'raw-live-private-result-id',
        'live-org-a',
        'live-class-a',
        'attempt_live-ticket-1',
        'live-exam-a',
        '김학생',
        999,
        999,
        'ungraded',
        false,
        false,
        false,
        0,
        0,
        now(),
        '{}'
    );

    diagnostics := public.omr_production_boundary_preflight_v1();
    if (diagnostics->>'orphan_rows')::bigint < 1 then
        raise exception 'missing exam-question result fixture was not detected';
    end if;
    if diagnostics::text like '%김학생%'
        or diagnostics::text like '%raw-live-private-result-id%'
    then
        raise exception 'preflight diagnostics exposed 김학생 or a raw row identifier';
    end if;

    begin
        perform public.omr_assert_production_boundary_preflight_v1();
        raise exception 'missing exam-question preflight fixture unexpectedly passed';
    exception
        when check_violation then
            assert_message := sqlerrm;
            if assert_message like '%김학생%'
                or assert_message like '%raw-live-private-result-id%'
            then
                raise exception 'preflight exception exposed 김학생 or a raw row identifier';
            end if;
    end;

    delete from public.omr_question_results
     where id = 'raw-live-private-result-id';
end
$$;

do $$
declare
    diagnostics jsonb;
begin
    diagnostics := public.omr_production_boundary_preflight_v1();
    if (diagnostics->>'null_organization_rows')::bigint <> 0
        or (diagnostics->>'orphan_rows')::bigint <> 0
        or (diagnostics->>'cross_organization_rows')::bigint <> 0
        or (diagnostics->>'students_without_credentials')::bigint <> 0
    then
        raise exception 'preflight must report zero organization-integrity violations: %', diagnostics;
    end if;

    begin
        insert into public.omr_attempts (
            id, organization_id, exam_id, student_name, identity_type,
            payload, started_at, finished_at
        ) values (
            'raw-live-private-attempt-id',
            'live-org-a',
            'live-exam-b',
            '김학생',
            'temporary',
            '{"id":"raw-live-private-attempt-id"}',
            '2026-07-14T00:00:00.000Z',
            '2026-07-14T00:01:00.000Z'
        );

        diagnostics := public.omr_production_boundary_preflight_v1();
        if diagnostics::text like '%김학생%'
            or diagnostics::text like '%raw-live-private-attempt-id%'
        then
            raise exception 'preflight diagnostics exposed 김학생 or a raw row identifier';
        end if;
        perform public.omr_assert_production_boundary_preflight_v1();
        raise exception 'cross-organization preflight fixture unexpectedly passed';
    exception
        when check_violation then
            if sqlerrm not like 'production boundary preflight failed:%' then
                raise;
            end if;
            if sqlerrm like '%김학생%'
                or sqlerrm like '%raw-live-private-attempt-id%'
            then
                raise exception 'preflight exception exposed 김학생 or a raw row identifier';
            end if;
    end;

    if exists (
        select 1
          from public.omr_attempts
         where id = 'raw-live-private-attempt-id'
    ) then
        raise exception 'failed preflight fixture was not rolled back';
    end if;
end
$$;

do $$
declare
    readiness jsonb;
begin
    readiness := public.omr_service_readiness_v1();
    if readiness->>'version' <> '202607140018' or readiness->>'ready' <> 'true' then
        raise exception 'live readiness probe did not confirm the complete production data plane: %', readiness;
    end if;
end
$$;

reset role;

select 'OMR live PostgreSQL verification passed' as result;
