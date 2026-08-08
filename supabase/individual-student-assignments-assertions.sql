begin;

insert into public.omr_organizations (id, name)
values
    ('individual-test-org', 'Individual assignment test'),
    ('individual-test-other-org', 'Other organization');

insert into public.omr_organization_members (organization_id, user_id, role, status)
values ('individual-test-org', 'individual-test-teacher', 'teacher', 'active');

insert into public.omr_student_profiles (id, organization_id, display_name, status)
values
    ('individual-test-student', 'individual-test-org', 'Target student', 'active'),
    ('individual-test-nontarget', 'individual-test-org', 'Non-target student', 'active'),
    ('individual-test-cross-org', 'individual-test-other-org', 'Cross-org student', 'active');

insert into public.omr_classes (id, organization_id, name, status)
values
    ('individual-test-class', 'individual-test-org', 'Target class', 'active'),
    ('individual-test-other-class', 'individual-test-other-org', 'Other class', 'active');

insert into public.omr_class_students (
    class_id, organization_id, student_profile_id, enrollment_status
) values
    ('individual-test-class', 'individual-test-org', 'individual-test-student', 'active'),
    ('individual-test-class', 'individual-test-org', 'individual-test-nontarget', 'active'),
    ('individual-test-other-class', 'individual-test-other-org', 'individual-test-cross-org', 'active');

insert into public.omr_exams (
    id, organization_id, class_id, title, payload, created_by_user_id,
    created_at, updated_at, archived
) values
    (
        'individual-test-exam', 'individual-test-org', 'individual-test-class', 'Targeted exam',
        '{"accessConfig":{"type":"public"},"questions":[{"id":1,"number":1,"answer":2}]}'::jsonb,
        'individual-test-teacher', now(), now(), false
    ),
    (
        'individual-test-other-exam', 'individual-test-org', 'individual-test-class', 'Other exam',
        '{"accessConfig":{"type":"public"},"questions":[{"id":1,"number":1,"answer":2}]}'::jsonb,
        'individual-test-teacher', now(), now(), false
    );

do $$
declare
    v_result jsonb;
    v_assignment_id text;
    v_rejected boolean;
    v_visible integer;
begin
    -- First assignment must also stop on an assignment-id-null session that was
    -- opened while the exam still had broad access.
    insert into public.omr_attempt_sessions (
        id, organization_id, exam_id, assignment_id, owner_student_id,
        student_name, identity_type, scope_key, submission_id, attempt_id,
        allowed_question_ids, exam_updated_at, grading_snapshot, status,
        started_at, deadline_at, last_heartbeat_at, revision, lease_epoch,
        lease_token_hash, lease_expires_at
    )
    select
        'individual-test-active-session', 'individual-test-org', exam.id, null,
        'individual-test-student', 'Target student', 'registered', 'base',
        'individual-test-active-submission', 'individual-test-active-attempt',
        array[1], exam.updated_at, '{}'::jsonb, 'in_progress', now(),
        now() + interval '1 hour', now(), 1, 1, 'individual-test-lease',
        now() + interval '1 minute'
      from public.omr_exams exam
     where exam.id = 'individual-test-other-exam';
    v_result := public.omr_assign_students_v1(
        'individual-test-org', 'individual-test-teacher', 'teacher',
        'individual-test-other-exam', array['individual-test-student'],
        'base', 0, 'individual-test-active-block'
    );
    if v_result ->> 'status' <> 'active_sessions'
       or exists (
           select 1 from public.omr_assignments assignment
            where assignment.exam_id = 'individual-test-other-exam'
       )
       or exists (
           select 1 from public.omr_exams exam
            where exam.id = 'individual-test-other-exam'
              and exam.payload #>> '{accessConfig,type}' <> 'public'
       ) then
        raise exception 'first assignment did not fail atomically on active exam session: %', v_result;
    end if;
    delete from public.omr_attempt_sessions where id = 'individual-test-active-session';

    -- Public/group submissions may predate the atomic targeted transition. This
    -- row is later adopted only when a paid retake assignment is saved.
    insert into public.omr_attempts (
        id, organization_id, class_id, assignment_id, student_profile_id,
        exam_id, student_name, student_id, identity_type, status,
        score, total_score, score_percent, retake_question_ids,
        payload, started_at, finished_at
    ) values (
        'individual-test-base-attempt', 'individual-test-org', 'individual-test-class',
        null, 'individual-test-student', 'individual-test-exam',
        'Target student', 'individual-test-student', 'registered', 'completed',
        0, 1, 0, '{}'::integer[], '{"status":"completed"}'::jsonb,
        now() - interval '10 minutes', now() - interval '5 minutes'
    );
    insert into public.omr_question_results (
        id, organization_id, class_id, assignment_id, student_profile_id,
        attempt_id, exam_id, student_name, student_id, identity_type,
        question_id, question_number, selected_answer, correct_answer,
        status, is_correct, is_wrong, is_unanswered, score, earned_score,
        finished_at, payload
    ) values (
        'individual-test-result', 'individual-test-org', 'individual-test-class',
        null, 'individual-test-student', 'individual-test-base-attempt',
        'individual-test-exam', 'Target student', 'individual-test-student', 'registered',
        1, 1, 1, 2, 'wrong', false, true, false, 1, 0, now(), '{}'::jsonb
    );

    v_result := public.omr_assign_students_v1(
        'individual-test-org', 'individual-test-teacher', 'teacher',
        'individual-test-exam', array['individual-test-student'],
        'base', 0, 'individual-test-base-save'
    );
    if v_result ->> 'status' <> 'saved'
       or (v_result ->> 'revision')::bigint <> 1
       or (v_result ->> 'targetCount')::integer <> 1 then
        raise exception 'base targeted save failed: %', v_result;
    end if;
    v_assignment_id := v_result ->> 'assignmentId';
    if not exists (
        select 1 from public.omr_exams exam
         where exam.id = 'individual-test-exam'
           and exam.payload #>> '{accessConfig,type}' = 'targeted'
    ) then
        raise exception 'assignment did not atomically switch exam to targeted';
    end if;

    insert into public.omr_attempt_sessions (
        id, organization_id, exam_id, assignment_id, owner_student_id,
        student_name, identity_type, scope_key, submission_id, attempt_id,
        allowed_question_ids, exam_updated_at, grading_snapshot, status,
        started_at, deadline_at, last_heartbeat_at, revision, lease_epoch,
        lease_token_hash, lease_expires_at
    )
    select
        'individual-test-edit-session', 'individual-test-org', exam.id, v_assignment_id,
        'individual-test-student', 'Target student', 'registered', 'base',
        'individual-test-edit-submission', 'individual-test-edit-attempt',
        array[1], exam.updated_at, '{}'::jsonb, 'in_progress', now(),
        now() + interval '1 hour', now(), 1, 1, 'individual-test-edit-lease',
        now() + interval '1 minute'
      from public.omr_exams exam
     where exam.id = 'individual-test-exam';
    v_result := public.omr_assign_students_v1(
        'individual-test-org', 'individual-test-teacher', 'teacher',
        'individual-test-exam', array['individual-test-student'],
        'base', 1, 'individual-test-edit-block'
    );
    if v_result ->> 'status' <> 'active_sessions' then
        raise exception 'assignment edit did not stop on active exam session: %', v_result;
    end if;
    delete from public.omr_attempt_sessions where id = 'individual-test-edit-session';

    v_result := public.omr_resolve_student_assignment_v1(
        'individual-test-org', 'individual-test-student', 'registered', '', '',
        v_assignment_id, 'individual-test-exam'
    );
    if v_result ->> 'status' <> 'authorized' or v_result ->> 'mode' <> 'base' then
        raise exception 'target student base resolve failed: %', v_result;
    end if;

    v_result := public.omr_resolve_student_assignment_v1(
        'individual-test-org', 'individual-test-nontarget', 'registered', '', '',
        v_assignment_id, 'individual-test-exam'
    );
    if v_result ->> 'status' <> 'denied' then
        raise exception 'non-target student was authorized: %', v_result;
    end if;

    v_result := public.omr_resolve_student_assignment_v1(
        'individual-test-org', 'individual-test-student', 'guest', '', '',
        v_assignment_id, 'individual-test-exam'
    );
    if v_result ->> 'status' <> 'denied' then
        raise exception 'guest was authorized: %', v_result;
    end if;

    v_result := public.omr_resolve_student_assignment_v1(
        'individual-test-other-org', 'individual-test-cross-org', 'registered', '', '',
        v_assignment_id, 'individual-test-exam'
    );
    if v_result ->> 'status' <> 'denied' then
        raise exception 'cross-org student was authorized: %', v_result;
    end if;

    v_result := public.omr_resolve_student_assignment_v1(
        'individual-test-org', 'individual-test-student', null, '', '',
        v_assignment_id, 'individual-test-exam'
    );
    if v_result ->> 'status' <> 'denied' then
        raise exception 'null identity was authorized: %', v_result;
    end if;

    v_rejected := false;
    begin
        insert into public.omr_attempts (
            id, organization_id, assignment_id, exam_id, student_name, student_id,
            identity_type, status, payload, started_at, finished_at
        ) values (
            'individual-test-null-assignment-attempt', 'individual-test-org', null,
            'individual-test-exam', 'Target student', 'individual-test-student',
            'registered', 'completed', '{}'::jsonb, now(), now()
        );
    exception when others then
        if sqlerrm = 'targeted exam requires assignment' then v_rejected := true; else raise; end if;
    end;
    if not v_rejected then raise exception 'targeted attempt without assignment was accepted'; end if;

    v_rejected := false;
    begin
        insert into public.omr_attempt_sessions (
            id, organization_id, exam_id, assignment_id, owner_student_id,
            student_name, identity_type, scope_key, submission_id, attempt_id,
            allowed_question_ids, exam_updated_at, grading_snapshot, status,
            started_at, deadline_at, last_heartbeat_at, revision, lease_epoch,
            lease_token_hash, lease_expires_at
        )
        select
            'individual-test-null-assignment-session', 'individual-test-org', exam.id, null,
            'individual-test-student', 'Target student', 'registered', 'base',
            'individual-test-null-assignment-submission', 'individual-test-null-assignment-session-attempt',
            array[1], exam.updated_at, '{}'::jsonb, 'in_progress', now(),
            now() + interval '1 hour', now(), 1, 1, 'individual-test-null-assignment-lease',
            now() + interval '1 minute'
          from public.omr_exams exam
         where exam.id = 'individual-test-exam';
    exception when others then
        if sqlerrm = 'targeted exam requires assignment' then v_rejected := true; else raise; end if;
    end;
    if not v_rejected then raise exception 'targeted session without assignment was accepted'; end if;

    v_rejected := false;
    begin
        insert into public.omr_attempts (
            id, organization_id, assignment_id, exam_id, student_name, student_id,
            identity_type, status, payload, started_at, finished_at
        ) values (
            'individual-test-null-identity-attempt', 'individual-test-org', v_assignment_id,
            'individual-test-exam', 'Target student', 'individual-test-student',
            null, 'completed', '{}'::jsonb, now(), now()
        );
    exception when others then
        if sqlerrm = 'attempt identity type invalid' then v_rejected := true; else raise; end if;
    end;
    if not v_rejected then raise exception 'null attempt identity was accepted'; end if;

    update public.omr_classes set status = 'archived' where id = 'individual-test-class';
    select pg_catalog.count(*)::integer into v_visible
      from public.omr_list_student_assignments_v1(
          'individual-test-org', 'individual-test-student', 'registered', '', ''
      ) listed
     where listed.assignment_id = v_assignment_id;
    if v_visible <> 0 then raise exception 'inactive-class assignment remained listed'; end if;
    v_result := public.omr_resolve_student_assignment_v1(
        'individual-test-org', 'individual-test-student', 'registered', '', '',
        v_assignment_id, 'individual-test-exam'
    );
    if v_result ->> 'status' <> 'denied' then
        raise exception 'inactive-class assignment resolved: %', v_result;
    end if;
    v_rejected := false;
    begin
        insert into public.omr_attempts (
            id, organization_id, assignment_id, exam_id, student_name, student_id,
            identity_type, status, payload, started_at, finished_at
        ) values (
            'individual-test-inactive-class-attempt', 'individual-test-org', v_assignment_id,
            'individual-test-exam', 'Target student', 'individual-test-student',
            'registered', 'completed', '{}'::jsonb, now(), now()
        );
    exception when others then
        if sqlerrm = 'targeted assignment roster inactive' then v_rejected := true; else raise; end if;
    end;
    if not v_rejected then raise exception 'inactive-class targeted attempt was accepted'; end if;
    update public.omr_classes set status = 'active' where id = 'individual-test-class';

    select public.omr_assign_students_v1(
        'individual-test-org', 'individual-test-teacher', 'teacher',
        'individual-test-exam',
        array(select 'overflow-' || n::text from generate_series(1, 101) n),
        'base', 1, 'individual-test-overflow'
    ) into v_result;
    if v_result ->> 'status' <> 'invalid_request' then
        raise exception '101-target request was not rejected: %', v_result;
    end if;

    -- Free is not allowed to create or write a retake even if the application
    -- accidentally exposes the premium action.
    v_result := public.omr_assign_students_v1(
        'individual-test-org', 'individual-test-teacher', 'teacher',
        'individual-test-exam', array['individual-test-student'],
        'retake', 1, 'individual-test-free-retake'
    );
    if v_result ->> 'status' <> 'plan_denied' then
        raise exception 'free retake assignment was not denied: %', v_result;
    end if;
    v_rejected := false;
    begin
        insert into public.omr_attempts (
            id, organization_id, class_id, assignment_id, student_profile_id,
            exam_id, student_name, student_id, identity_type, status,
            retake_source_attempt_id, retake_mode, retake_question_ids,
            payload, started_at, finished_at
        ) values (
            'individual-test-free-retake-attempt', 'individual-test-org', 'individual-test-class',
            v_assignment_id, 'individual-test-student', 'individual-test-exam',
            'Target student', 'individual-test-student', 'registered', 'completed',
            'individual-test-base-attempt', 'wrong', array[1], '{}'::jsonb, now(), now()
        );
    exception when others then
        if sqlerrm = 'free plan denies retake' then v_rejected := true; else raise; end if;
    end;
    if not v_rejected then raise exception 'free retake attempt write was accepted'; end if;

    update public.omr_organizations set plan = 'pro' where id = 'individual-test-org';
    -- Phase C requires the paid retake capability to be proven before the
    -- legacy body reaches its adoption trigger. Production callers use the
    -- v2 boundary; this direct postgres assertion only preserves the original
    -- historical behavior fixture.
    perform public.omr_set_effective_plan_transaction_proof_v1(
        'individual-test-org',
        pg_catalog.jsonb_build_object(
            'organizationId', 'individual-test-org',
            'plan', 'pro',
            'grantId', 'historical-direct-postgres-fixture',
            'expiresAt', pg_catalog.to_char(
                (pg_catalog.clock_timestamp() + interval '1 hour') at time zone 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            )
        )
    );

    v_result := public.omr_assign_students_v1(
        'individual-test-org', 'individual-test-teacher', 'teacher',
        'individual-test-exam', array['individual-test-student'],
        'retake', 1, 'individual-test-retake-save'
    );
    if v_result ->> 'status' <> 'saved'
       or v_result ->> 'mode' <> 'retake'
       or (v_result ->> 'revision')::bigint <> 2 then
        raise exception 'retake targeted save failed: %', v_result;
    end if;
    if not exists (
        select 1 from public.omr_attempts attempt
         where attempt.id = 'individual-test-base-attempt'
           and attempt.assignment_id = v_assignment_id
           and attempt.payload ->> 'assignmentId' = v_assignment_id
    ) then
        raise exception 'historical base attempt was not atomically adopted';
    end if;

    v_result := public.omr_resolve_student_assignment_v1(
        'individual-test-org', 'individual-test-student', 'registered', '', '',
        v_assignment_id, 'individual-test-exam'
    );
    if v_result ->> 'status' <> 'authorized'
       or v_result ->> 'mode' <> 'retake'
       or v_result ->> 'sourceAttemptId' <> 'individual-test-base-attempt'
       or v_result -> 'questionIds' <> '[1]'::jsonb then
        raise exception 'target student retake resolve failed: %', v_result;
    end if;

    v_rejected := false;
    begin
        insert into public.omr_attempts (
            id, organization_id, assignment_id, exam_id, student_name, student_id,
            identity_type, status, payload, started_at, finished_at
        ) values (
            'individual-test-garbage-attempt', 'individual-test-org', 'garbage-assignment',
            'individual-test-exam', 'Target student', 'individual-test-student',
            'registered', 'completed', '{}'::jsonb, now(), now()
        );
    exception when others then
        v_rejected := true;
    end;
    if not v_rejected then raise exception 'garbage assignment attempt was accepted'; end if;

    v_rejected := false;
    begin
        insert into public.omr_attempts (
            id, organization_id, assignment_id, exam_id, student_name, student_id,
            identity_type, status, payload, started_at, finished_at
        ) values (
            'individual-test-wrong-exam-attempt', 'individual-test-org', v_assignment_id,
            'individual-test-other-exam', 'Target student', 'individual-test-student',
            'registered', 'completed', '{}'::jsonb, now(), now()
        );
    exception when others then
        v_rejected := true;
    end;
    if not v_rejected then raise exception 'mismatched-exam assignment attempt was accepted'; end if;

    v_rejected := false;
    begin
        update public.omr_exams
           set payload = jsonb_set(payload, '{accessConfig,type}', '"public"'::jsonb)
         where id = 'individual-test-exam';
    exception when others then
        v_rejected := true;
    end;
    if not v_rejected then raise exception 'active targeted exam was downgraded to public'; end if;

    v_result := public.omr_clear_student_assignment_v1(
        'individual-test-org', 'individual-test-teacher', 'teacher',
        'individual-test-exam', 2, 'public', '{}'::text[], 'individual-test-clear-public'
    );
    if v_result ->> 'status' <> 'cleared'
       or (v_result ->> 'revision')::bigint <> 3
       or v_result ->> 'accessType' <> 'public'
       or not exists (
           select 1 from public.omr_assignments assignment
            where assignment.id = v_assignment_id and assignment.status = 'archived'
       )
       or exists (
           select 1 from public.omr_assignment_targets target
            where target.assignment_id = v_assignment_id and target.status = 'active'
       )
       or not exists (
           select 1 from public.omr_exams exam
            where exam.id = 'individual-test-exam'
              and exam.payload -> 'accessConfig' = '{"type":"public"}'::jsonb
       ) then
        raise exception 'atomic public clear failed: %', v_result;
    end if;
    v_result := public.omr_clear_student_assignment_v1(
        'individual-test-org', 'individual-test-teacher', 'teacher',
        'individual-test-exam', 2, 'public', '{}'::text[], 'individual-test-clear-public'
    );
    if v_result ->> 'status' <> 'cleared' or v_result ->> 'idempotent' <> 'true' then
        raise exception 'clear retry was not idempotent: %', v_result;
    end if;

    v_result := public.omr_assign_students_v1(
        'individual-test-org', 'individual-test-teacher', 'teacher',
        'individual-test-exam', array['individual-test-student'],
        'base', 0, 'individual-test-reactivate'
    );
    if v_result ->> 'status' <> 'saved'
       or (v_result ->> 'revision')::bigint <> 4 then
        raise exception 'archived assignment did not reactivate: %', v_result;
    end if;
    v_result := public.omr_clear_student_assignment_v1(
        'individual-test-org', 'individual-test-teacher', 'teacher',
        'individual-test-exam', 4, 'group', array['individual-test-class'],
        'individual-test-clear-group'
    );
    if v_result ->> 'status' <> 'cleared'
       or v_result ->> 'accessType' <> 'group'
       or not exists (
           select 1 from public.omr_exams exam
            where exam.id = 'individual-test-exam'
              and exam.payload -> 'accessConfig'
                  = '{"type":"group","groupIds":["individual-test-class"]}'::jsonb
       ) then
        raise exception 'atomic group clear failed: %', v_result;
    end if;
end;
$$;

do $$
begin
    if pg_catalog.has_function_privilege(
        'service_role',
        'public.omr_assign_students_v1(text,text,text,text,text[],text,bigint,text)',
        'EXECUTE'
    ) or pg_catalog.has_function_privilege(
        'service_role',
        'public.omr_clear_student_assignment_v1(text,text,text,text,bigint,text,text[],text)',
        'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role',
        'public.omr_assign_students_v2(text,text,bigint,text,text,text,text,text[],text,bigint,text)',
        'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role',
        'public.omr_clear_student_assignment_v2(text,text,bigint,text,text,text,text,bigint,text,text[],text)',
        'EXECUTE'
    ) then
        raise exception 'targeted assignment boundary is not v2-only';
    end if;
end
$$;

rollback;
