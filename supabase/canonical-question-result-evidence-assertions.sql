\set ON_ERROR_STOP on

\if :{?canonical_evidence_contention_verified}
\else
\echo 'canonical evidence contention verification was not provided'
\quit 3
\endif
\if :canonical_evidence_contention_verified
\else
\echo 'canonical evidence contention verification did not pass'
\quit 3
\endif

-- Exercise the two production writers at the maximum canonical question
-- count. Deferred validation is forced before each timer stops so the bound
-- includes the authoritative parent/child seal, not only row insertion.
set track_functions = 'all';
select pg_catalog.pg_stat_reset();

begin;

insert into public.omr_organizations(id,name,plan)
values ('canonical-evidence-live-org','Canonical Evidence Live Org','pro');

insert into public.omr_student_profiles(id,organization_id,display_name,status)
values ('canonical-evidence-live-student','canonical-evidence-live-org','Canonical Student','active');

insert into public.omr_classes(id,organization_id,name)
values ('canonical-evidence-live-class','canonical-evidence-live-org','Canonical Class');

insert into public.omr_exams(id,organization_id,title,payload,created_at,updated_at)
values (
    'canonical-evidence-submit-exam','canonical-evidence-live-org','Submit 500',
    '{"id":"canonical-evidence-submit-exam","organizationId":"canonical-evidence-live-org","title":"Submit 500","accessConfig":{"type":"public"},"questions":[]}'::jsonb,
    '2026-08-10T00:00:00Z','2026-08-10T00:00:00Z'
), (
    'canonical-evidence-compact-exam','canonical-evidence-live-org','Compact 500',
    pg_catalog.jsonb_build_object(
        'id','canonical-evidence-compact-exam',
        'organizationId','canonical-evidence-live-org',
        'title','Compact 500',
        'accessConfig',pg_catalog.jsonb_build_object('type','public'),
        'createdAt','2026-08-10T00:00:00.000Z',
        'updatedAt','2026-08-10T00:00:00.000Z',
        'questions',(
            select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                'id',question_id,'number',question_id,'answer',1,'choices',5,
                'score',1,'tags',pg_catalog.jsonb_build_object('concept','bounded')
            ) order by question_id)
            from pg_catalog.generate_series(1,500) question_id
        )
    ),
    '2026-08-10T00:00:00Z','2026-08-10T00:00:00Z'
);

do $submit_500$
declare
    v_rows jsonb;
    v_database_rows jsonb;
    v_attempt_payload jsonb;
    v_started_at timestamptz;
    v_elapsed interval;
begin
    select pg_catalog.jsonb_agg(row_payload order by question_id),
           pg_catalog.jsonb_agg(
               pg_catalog.jsonb_build_object(
                   'id','attempt_canonical-evidence-submit-ticket:' || question_id,
                   'organization_id','canonical-evidence-live-org',
                   'attempt_id','attempt_canonical-evidence-submit-ticket',
                   'exam_id','canonical-evidence-submit-exam',
                   'student_name','Canonical Student',
                   'student_id','canonical-evidence-live-student',
                   'student_profile_id','canonical-evidence-live-student',
                   'identity_type','registered',
                   'question_id',question_id,
                   'question_number',question_id,
                   'canonical_question_id','canonical-evidence-submit-exam:' || question_id,
                   'label','Q' || question_id,
                   'mistake_types','[]'::jsonb,
                   'prerequisites','[]'::jsonb,
                   'selected_answer',1,
                   'correct_answer',1,
                   'status','correct',
                   'is_correct',true,
                   'is_wrong',false,
                   'is_unanswered',false,
                   'score',1,
                   'earned_score',1,
                   'finished_at','2026-08-10T00:10:00.000Z',
                   'payload',row_payload,
                   'created_at','2026-08-10T00:10:00.000Z',
                   'updated_at','2026-08-10T00:10:00.000Z'
               ) order by question_id
           )
      into v_rows,v_database_rows
      from (
          select question_id,pg_catalog.jsonb_build_object(
              'schemaVersion',1,
              'attemptId','attempt_canonical-evidence-submit-ticket',
              'examId','canonical-evidence-submit-exam',
              'examTitle','Submit 500',
              'organizationId','canonical-evidence-live-org',
              'studentProfileId','canonical-evidence-live-student',
              'studentName','Canonical Student',
              'studentId','canonical-evidence-live-student',
              'identityType','registered',
              'questionId',question_id,
              'questionNumber',question_id,
              'canonicalQuestionId','canonical-evidence-submit-exam:' || question_id,
              'label','Q' || question_id,
              'score',1,
              'earnedScore',1,
              'selectedAnswer',1,
              'correctAnswer',1,
              'status','correct',
              'isCorrect',true,
              'isWrong',false,
              'isUnanswered',false,
              'mistakeTypes','[]'::jsonb,
              'prerequisites','[]'::jsonb,
              'passagePdfRegions',case when question_id=1 then
                  '[{"page":1,"x":1.000001,"y":0,"width":1,"height":1}]'::jsonb
                  else '[]'::jsonb end,
              'finishedAt','2026-08-10T00:10:00.000Z'
          ) row_payload
          from pg_catalog.generate_series(1,500) question_id
      ) generated;

    v_attempt_payload := pg_catalog.jsonb_build_object(
        'id','attempt_canonical-evidence-submit-ticket',
        'examId','canonical-evidence-submit-exam',
        'organizationId','canonical-evidence-live-org',
        'studentProfileId','canonical-evidence-live-student',
        'studentId','canonical-evidence-live-student',
        'identityType','registered',
        'studentName','Canonical Student',
        'startedAt','2026-08-10T00:00:00.000Z',
        'finishedAt','2026-08-10T00:10:00.000Z',
        'score',500,
        'totalScore',500,
        'status','completed',
        'questionResults',v_rows
    );

    set constraints omr_internal.omr_canonical_evidence_dirty_attempt_finalize_v1 deferred;
    v_started_at := pg_catalog.clock_timestamp();
    perform public.omr_submit_attempt_v1(
        'canonical-evidence-submit-ticket',
        pg_catalog.jsonb_build_object(
            'id','attempt_canonical-evidence-submit-ticket',
            'organization_id','canonical-evidence-live-org',
            'student_profile_id','canonical-evidence-live-student',
            'exam_id','canonical-evidence-submit-exam',
            'student_name','Canonical Student',
            'student_id','canonical-evidence-live-student',
            'identity_type','registered',
            'status','completed','score',500,'total_score',500,'score_percent',100,
            'retake_question_ids','[]'::jsonb,'payload',v_attempt_payload,
            'started_at','2026-08-10T00:00:00.000Z',
            'finished_at','2026-08-10T00:10:00.000Z'
        ),
        v_database_rows
    );
    set constraints omr_internal.omr_canonical_evidence_dirty_attempt_finalize_v1 immediate;
    v_elapsed := pg_catalog.clock_timestamp()-v_started_at;
    if v_elapsed >= interval '15 seconds' then
        raise exception '500-row submit exceeded 15 seconds: %',v_elapsed;
    end if;
    raise notice 'canonical evidence 500-row submit wall time: %',v_elapsed;
    if (select pg_catalog.count(*) from public.omr_question_results
         where attempt_id='attempt_canonical-evidence-submit-ticket') <> 500
       or not public.omr_canonical_attempt_child_evidence_matches_v1(
            'attempt_canonical-evidence-submit-ticket'
       ) then
        raise exception '500-row submit did not preserve the authoritative seal';
    end if;

    -- Deleting one child makes the embedded/child sets diverge. The deferred
    -- finalizer must reject and roll back the whole nested transaction.
    begin
        set constraints omr_internal.omr_canonical_evidence_dirty_attempt_finalize_v1 deferred;
        delete from public.omr_question_results
         where attempt_id='attempt_canonical-evidence-submit-ticket' and question_id=500;
        set constraints omr_internal.omr_canonical_evidence_dirty_attempt_finalize_v1 immediate;
        raise exception 'canonical attempt child evidence mismatch was not rejected';
    exception when others then
        if sqlerrm is distinct from 'canonical attempt child evidence mismatch' then raise; end if;
    end;
    if (select pg_catalog.count(*) from public.omr_question_results
         where attempt_id='attempt_canonical-evidence-submit-ticket') <> 500 then
        raise exception 'canonical mismatch did not roll back the entire mutation';
    end if;
end
$submit_500$;

insert into public.omr_attempt_sessions(
    id,organization_id,exam_id,owner_student_id,student_name,identity_type,
    scope_key,submission_id,attempt_id,allowed_question_ids,grading_snapshot,
    answers,sub_question_answers,status,started_at,deadline_at,last_heartbeat_at,
    revision,lease_epoch,lease_token_hash,lease_expires_at
)
select
    'canonical-evidence-compact-session','canonical-evidence-live-org',exam.id,
    'canonical-evidence-live-student','Canonical Student','registered','base',
    'canonical-evidence-compact-ticket','canonical-evidence-compact-attempt',
    (select pg_catalog.array_agg(question_id order by question_id)
       from pg_catalog.generate_series(1,500) question_id),
    exam.payload,'{}'::jsonb,'{}'::jsonb,'in_progress',
    pg_catalog.now()-interval '10 minutes',pg_catalog.now()+interval '1 hour',
    pg_catalog.now(),1,1,'canonical-evidence-compact-lease',
    pg_catalog.now()+interval '1 minute'
from public.omr_exams exam where exam.id='canonical-evidence-compact-exam';

do $compact_500$
declare
    v_fingerprint text;
    v_started_at timestamptz;
    v_elapsed interval;
begin
    select public.omr_teacher_force_finish_fingerprint_v1(
        revision,answers,sub_question_answers,allowed_question_ids,grading_snapshot
    ) into v_fingerprint
    from public.omr_attempt_sessions where id='canonical-evidence-compact-session';

    set constraints omr_internal.omr_canonical_evidence_dirty_attempt_finalize_v1 deferred;
    v_started_at := pg_catalog.clock_timestamp();
    perform public.omr_force_finish_attempt_sessions_compact_v2(
        'canonical-evidence-live-org',array['canonical-evidence-compact-session'],
        pg_catalog.now(),'canonical-evidence-live-owner','owner','Canonical Owner',
        pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
            'session_id','canonical-evidence-compact-session',
            'expected_revision',1,
            'expected_fingerprint',v_fingerprint
        ))
    );
    set constraints omr_internal.omr_canonical_evidence_dirty_attempt_finalize_v1 immediate;
    v_elapsed := pg_catalog.clock_timestamp()-v_started_at;
    if v_elapsed >= interval '15 seconds' then
        raise exception '500-row compact exceeded 15 seconds: %',v_elapsed;
    end if;
    raise notice 'canonical evidence 500-row compact wall time: %',v_elapsed;
    if (select pg_catalog.count(*) from public.omr_question_results
         where attempt_id='canonical-evidence-compact-attempt') <> 500
       or not public.omr_canonical_attempt_child_evidence_matches_v1(
            'canonical-evidence-compact-attempt'
       ) then
        raise exception '500-row compact did not preserve the authoritative seal';
    end if;
end
$compact_500$;

do $canonical_json_parity$
begin
    perform public.omr_assert_canonical_question_result_json_v1(
        '[{"passagePdfRegions":[{"page":1,"x":1.000001,"y":0,"width":1,"height":1}]}]'::jsonb,0
    );
    if public.omr_canonical_json_text_v1('1.000001'::jsonb)
       is distinct from '["omr:canonical-number:micro6:v1","1000001"]' then
        raise exception 'micro6 canonical boundary drifted';
    end if;
    if public.omr_canonical_json_text_v1('-0'::jsonb)
       is distinct from '["omr:canonical-number:micro6:v1","0"]' then
        raise exception 'negative zero canonical boundary drifted';
    end if;
    begin
        perform public.omr_canonical_json_text_v1('0.0000001'::jsonb);
        raise exception 'canonical micro7 was accepted';
    exception when others then
        if sqlerrm is distinct from 'canonical number exceeds micro6 precision' then raise; end if;
    end;
    begin
        perform public.omr_assert_canonical_question_result_json_v1(
            (select pg_catalog.jsonb_agg(value) from pg_catalog.generate_series(1,501) value),0
        );
        raise exception 'canonical json array exceeds 500 was not rejected';
    exception when others then
        if sqlerrm is distinct from 'canonical json array exceeds 500' then raise; end if;
    end;
    begin
        perform public.omr_assert_canonical_question_result_json_v1(
            '[[[[[[0]]]]]]'::jsonb,0
        );
        raise exception 'canonical json depth exceeds 5 was not rejected';
    exception when others then
        if sqlerrm is distinct from 'canonical json depth exceeds 5' then raise; end if;
    end;
end
$canonical_json_parity$;

rollback;

select pg_catalog.pg_stat_force_next_flush();
do $seal_call_count$
declare
    v_calls bigint;
begin
    select calls into v_calls from pg_catalog.pg_stat_user_functions
     where schemaname='public' and funcname='omr_finalize_canonical_attempt_evidence_dirty_v1';
    if v_calls is distinct from 2::bigint then
        raise exception 'canonical parent seal count drifted, expected 2, got %',v_calls;
    end if;
end
$seal_call_count$;

reset track_functions;
