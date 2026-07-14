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
    if has_function_privilege('anon', 'public.omr_teacher_update_attempt_v1(text,jsonb,jsonb)', 'execute')
        or has_function_privilege('authenticated', 'public.omr_teacher_update_attempt_v1(text,jsonb,jsonb)', 'execute')
    then
        raise exception 'browser roles unexpectedly have teacher attempt RPC execute privilege';
    end if;
    if not has_function_privilege('service_role', 'public.omr_teacher_update_attempt_v1(text,jsonb,jsonb)', 'execute') then
        raise exception 'service_role must have teacher attempt RPC execute privilege';
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

select * from public.omr_teacher_update_attempt_v1(
    'live-org-a',
    '{
        "id":"attempt_live-ticket-1",
        "organization_id":"live-org-a",
        "exam_id":"live-exam-a",
        "status":"completed",
        "score":0,
        "total_score":1,
        "score_percent":0,
        "payload":{"id":"attempt_live-ticket-1","examId":"live-exam-a","studentName":"Live Student","score":0,"totalScore":1,"startedAt":"2026-07-14T00:00:00.000Z","finishedAt":"2026-07-14T00:02:00.000Z"},
        "finished_at":"2026-07-14T00:02:00.000Z"
    }',
    '[]'
);

do $$
begin
    if (select score from public.omr_attempts where id = 'attempt_live-ticket-1') <> 0 then
        raise exception 'teacher attempt RPC did not update the canonical attempt';
    end if;
    begin
        perform public.omr_teacher_update_attempt_v1(
            'live-org-b',
            '{"id":"attempt_live-ticket-1","organization_id":"live-org-b","exam_id":"live-exam-a"}',
            '[]'
        );
        raise exception 'cross-organization teacher attempt update unexpectedly succeeded';
    exception
        when raise_exception then
            if sqlerrm = 'cross-organization teacher attempt update unexpectedly succeeded' then
                raise;
            end if;
    end;
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

insert into public.omr_remote_assets (
    id, organization_id, kind, attempt_id, storage_bucket, object_path,
    mime_type, byte_size, sha256_hex
) values (
    'live-handwriting-asset', 'live-org-a', 'attempt_handwriting',
    'attempt_live-ticket-1', 'omr-private-assets',
    'organizations/live-org-a/attempts/attempt_live-ticket-1/handwriting/live-handwriting-asset.json',
    'application/json', 2,
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
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

do $$
declare
    readiness jsonb;
begin
    readiness := public.omr_service_readiness_v1();
    if readiness->>'version' <> '202607140017' or readiness->>'ready' <> 'true' then
        raise exception 'live readiness probe did not confirm the complete production data plane: %', readiness;
    end if;
end
$$;

reset role;

select 'OMR live PostgreSQL verification passed' as result;
