-- Local PostgreSQL regression: imported/deduplicated response IDs remain reviewable.
-- All synthetic fixture rows and reviews are rolled back.
begin;

insert into public.omr_organizations(id, name)
values ('review-identity-org', 'Review identity fixture'), ('review-identity-other-org', 'Other fixture');
insert into public.omr_classes(id, organization_id, name)
values ('review-identity-class', 'review-identity-org', 'Synthetic class');
insert into public.omr_class_teachers(class_id, organization_id, teacher_user_id, class_role)
values ('review-identity-class', 'review-identity-org', 'review-identity-teacher', 'grader');
insert into public.omr_exams(id, organization_id, class_id, title, payload, created_at, updated_at)
values ('review-identity-exam', 'review-identity-org', 'review-identity-class', 'Synthetic exam',
    '{"id":"review-identity-exam","questions":[]}'::jsonb, clock_timestamp(), clock_timestamp());
insert into public.omr_attempts(id, organization_id, class_id, exam_id, student_name, status, payload, started_at, finished_at)
values ('review-identity-attempt', 'review-identity-org', 'review-identity-class', 'review-identity-exam', 'Synthetic student', 'in_progress',
    jsonb_build_object(
        'id', 'review-identity-attempt', 'examId', 'review-identity-exam', 'status', 'in_progress',
        'score', 5, 'totalScore', 5, 'answers', jsonb_build_object('7', 2),
        'subQuestionAnswers', jsonb_build_object('7', jsonb_build_object(
            repeat('a', 100) || '-2', jsonb_build_object('schemaVersion', 1, 'body', 'Deduplicated response', 'reviewStatus', 'needs_review'),
            repeat('b', 256), jsonb_build_object('schemaVersion', 1, 'body', 'Boundary response', 'reviewStatus', 'needs_review'),
            'reason:stage:2', jsonb_build_object('schemaVersion', 1, 'body', 'Colon response', 'reviewStatus', 'needs_review'),
            ':leading:trailing:', jsonb_build_object('schemaVersion', 1, 'body', 'More colons', 'reviewStatus', 'needs_review'),
            'a:b,{c}."__proto__"]', jsonb_build_object('schemaVersion', 1, 'body', 'Literal path response', 'reviewStatus', 'needs_review'),
            '__proto__', jsonb_build_object('schemaVersion', 1, 'body', 'Reserved literal key', 'reviewStatus', 'needs_review'),
            'reason', jsonb_build_object('schemaVersion', 1, 'body', 'Untouched sibling', 'reviewStatus', 'needs_review')
        ))
    ), clock_timestamp(), clock_timestamp());

set local role service_role;
do $review_identity_assertions$
declare
    v_id text;
    v_invalid text;
    v_before jsonb;
    v_updated jsonb;
    v_replayed jsonb;
    v_rejected boolean;
    v_cases integer := 0;
    v_signature constant text := 'public.omr_set_subquestion_review_v1(text,text,text,text,text,text,text)';
begin
    if has_function_privilege('anon', v_signature, 'execute')
        or has_function_privilege('authenticated', v_signature, 'execute')
        or not has_function_privilege('service_role', v_signature, 'execute') then
        raise exception 'subquestion review identity migration changed execute privileges';
    end if;

    foreach v_id in array array[
        repeat('a', 100) || '-2', repeat('b', 256), 'reason:stage:2',
        ':leading:trailing:', 'a:b,{c}."__proto__"]', '__proto__'
    ] loop
        select payload into v_before from public.omr_attempts where id = 'review-identity-attempt';
        select mutation.payload into v_updated from public.omr_set_subquestion_review_v1(
            'review-identity-org', 'review-identity-attempt', '7:' || v_id, 'reviewed',
            'review-identity-teacher', 'teacher', 'Synthetic grader'
        ) mutation;
        if v_updated #>> array['subQuestionAnswers', '7', v_id, 'reviewStatus'] is distinct from 'reviewed'
            or v_updated #>> array['subQuestionAnswers', '7', v_id, 'reviewedBy'] is distinct from 'Synthetic grader'
            or v_updated #> array['subQuestionAnswers', '7', v_id, 'reviewedAt'] is null
            or v_updated #> array['subQuestionAnswers', '7', v_id, 'body'] is distinct from v_before #> array['subQuestionAnswers', '7', v_id, 'body']
            or (v_updated - 'subQuestionAnswers') is distinct from (v_before - 'subQuestionAnswers')
            or ((v_updated #> '{subQuestionAnswers,7}') - v_id) is distinct from ((v_before #> '{subQuestionAnswers,7}') - v_id) then
            raise exception 'review did not stay on the exact subquestion identity (length %)', length(v_id);
        end if;
        select mutation.payload into v_replayed from public.omr_set_subquestion_review_v1(
            'review-identity-org', 'review-identity-attempt', '7:' || v_id, 'reviewed',
            'review-identity-teacher', 'teacher', 'Synthetic grader'
        ) mutation;
        if v_replayed is distinct from v_updated then
            raise exception 'same-status review replay changed attribution or timestamps';
        end if;
        select mutation.payload into v_updated from public.omr_set_subquestion_review_v1(
            'review-identity-org', 'review-identity-attempt', '7:' || v_id, 'needs_review',
            'review-identity-teacher', 'teacher', 'Synthetic grader'
        ) mutation;
        if v_updated #> array['subQuestionAnswers', '7', v_id] is distinct from v_before #> array['subQuestionAnswers', '7', v_id] then
            raise exception 'review reset did not restore the original student answer';
        end if;
        v_cases := v_cases + 1;
    end loop;

    foreach v_invalid in array array['7:' || repeat('c', 257), '7:', ':reason', 'invalid:reason', 'reason'] loop
        v_rejected := false;
        begin
            perform public.omr_set_subquestion_review_v1(
                'review-identity-org', 'review-identity-attempt', v_invalid, 'reviewed',
                'review-identity-teacher', 'teacher', 'Synthetic grader'
            );
        exception when raise_exception then
            v_rejected := sqlerrm = 'invalid subquestion review mutation';
        end;
        if not v_rejected then raise exception 'invalid or oversize review identity was not rejected'; end if;
    end loop;

    select payload into v_before from public.omr_attempts where id = 'review-identity-attempt';
    v_rejected := false;
    begin
        perform public.omr_set_subquestion_review_v1(
            'review-identity-other-org', 'review-identity-attempt', '7:reason', 'reviewed',
            'review-identity-teacher', 'owner', 'Synthetic outsider'
        );
    exception when raise_exception then
        v_rejected := sqlerrm = 'attempt organization mismatch';
    end;
    if not v_rejected then raise exception 'cross-organization subquestion review was not denied'; end if;
    v_rejected := false;
    begin
        perform public.omr_set_subquestion_review_v1(
            'review-identity-org', 'review-identity-attempt', '7:reason', 'reviewed',
            'unassigned-teacher', 'teacher', 'Synthetic outsider'
        );
    exception when raise_exception then
        v_rejected := sqlerrm = 'attempt class assignment denied';
    end;
    if not v_rejected then raise exception 'unassigned subquestion reviewer was not denied'; end if;
    if (select payload from public.omr_attempts where id = 'review-identity-attempt') is distinct from v_before then
        raise exception 'denied subquestion review changed the attempt';
    end if;
    raise notice 'OMR_SUBQUESTION_REVIEW_IDENTITY_V1 success_cases=% bounds=pass exact_path=pass idempotency=pass reset=pass acl=pass organization=pass class_assignment=pass', v_cases;
end;
$review_identity_assertions$;

-- Assignment administration is intentionally unavailable to service_role.
-- Apply this fixture-only downgrade as the migration owner, then call the RPC
-- again using exactly the service-role execution path under test.
reset role;
update public.omr_class_teachers set class_role = 'viewer'
  where class_id = 'review-identity-class' and teacher_user_id = 'review-identity-teacher';
set local role service_role;
do $review_identity_downgrade$
declare
    v_before jsonb;
    v_rejected boolean := false;
begin
    select payload into v_before from public.omr_attempts where id = 'review-identity-attempt';
    begin
        perform public.omr_set_subquestion_review_v1(
            'review-identity-org', 'review-identity-attempt', '7:reason', 'reviewed',
            'review-identity-teacher', 'teacher', 'Synthetic downgraded reviewer'
        );
    exception when raise_exception then
        v_rejected := sqlerrm = 'attempt class assignment denied';
    end;
    if not v_rejected then raise exception 'class role downgrade did not deny subquestion review'; end if;
    if (select payload from public.omr_attempts where id = 'review-identity-attempt') is distinct from v_before then
        raise exception 'denied subquestion review changed the attempt';
    end if;
    raise notice 'OMR_SUBQUESTION_REVIEW_IDENTITY_V1 class_role_downgrade=pass';
end;
$review_identity_downgrade$;
rollback;
