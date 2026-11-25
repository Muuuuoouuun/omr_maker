-- The live verifier runs this last on its disposable database. Autocommit is
-- intentional: each RPC below must run without the previous RPC's plan proof.
create temporary table retake_case (
    exam text primary key, org text, assn text, gen bigint, opened jsonb,
    saved jsonb, prepared jsonb, attempt jsonb, results jsonb, receipt jsonb,
    base_record jsonb, base_results jsonb
);
do $$
declare
    owner jsonb;
    org text;
    exam text;
    assignment jsonb;
begin
    owner := public.omr_provision_pilot_teacher_v1(
        'Synthetic continuation QA','retake-continuation@example.test','Synthetic owner',
        'pbkdf2-sha256:120000:'||repeat('a',32)||':'||repeat('b',64),'pro',now()+interval '1 day',
        'operator:assertions','retake_continuation_test','prov_'||repeat('R',40));
    org := owner->>'organizationId';
    insert into public.omr_student_profiles(id,organization_id,display_name)
    values ('continuation-student',org,'Synthetic student');
    insert into public.omr_classes(id,organization_id,name) values ('continuation-class',org,'Synthetic class');
    insert into public.omr_class_students(class_id,organization_id,student_profile_id,enrollment_status)
    values ('continuation-class',org,'continuation-student','active');
    foreach exam in array array['continuation-public','continuation-targeted'] loop
        insert into public.omr_exams(id,organization_id,class_id,title,payload,created_at,updated_at)
        values (exam,org,'continuation-class',exam,
                '{"questions":[{"id":1,"number":1,"answer":2,"score":1}],"accessConfig":{"type":"public"}}',now(),now());
        insert into public.omr_attempts(id,organization_id,exam_id,student_id,student_name,identity_type,
                    status,score,total_score,score_percent,payload,started_at,finished_at)
        values (exam||'-base',org,exam,'continuation-student','Synthetic student','registered',
                'completed',0,1,0,'{"answers":{"1":1}}',now(),now());
        insert into public.omr_question_results(id,organization_id,exam_id,attempt_id,student_id,student_name,
                    identity_type,question_id,question_number,selected_answer,correct_answer,status,
                    is_correct,is_wrong,is_unanswered,score,earned_score,finished_at,payload)
        values (exam||'-wrong',org,exam,exam||'-base','continuation-student','Synthetic student',
                'registered',1,1,1,2,'wrong',false,true,false,1,0,now(),'{}');
        if exam='continuation-targeted' then
            assignment := public.omr_assign_students_v2('account',owner->>'accountId',1,org,owner->>'accountId','owner',exam,
                            array['continuation-student'],'retake',0,'continuation-assignment-op');
            if assignment->>'status' is distinct from 'saved' then raise exception 'target fixture unavailable: %',assignment->>'status'; end if;
        end if;
        insert into retake_case(exam,org,assn,gen) values(exam,org,assignment->>'assignmentId',(assignment->>'revision')::bigint);
    end loop;
end $$;

update retake_case c set opened=public.omr_open_attempt_session_v3(
    c.exam||'-session',c.org,c.exam,c.assn,c.gen,'continuation-student','Synthetic student','registered',
    c.exam||'-submission',c.exam||'-retry',c.exam||'-base','wrong',array[1],array[1],
    (select e.updated_at from public.omr_exams e where e.id=c.exam),'{}',600,null,repeat('a',64),null,120);

update retake_case c set base_record=(select to_jsonb(a) from public.omr_attempts a where a.id=c.exam||'-base'),
    base_results=(select jsonb_agg(to_jsonb(q) order by q.question_id) from public.omr_question_results q where q.attempt_id=c.exam||'-base');
-- Simulate a teacher closing the assignment while a student's tab is open.
-- VM/DB time does not need to be changed. The case is rolled back after denial.
do $$
declare c retake_case%rowtype;
begin
    select * into strict c from retake_case where assn is not null;
    begin
        update public.omr_assignments set status='closed' where id=c.assn;
        perform public.omr_checkpoint_attempt_session_v2(c.exam||'-session',c.org,c.exam,'continuation-student',c.assn,c.gen,
            (c.opened->>'revision')::bigint,(c.opened->>'lease_epoch')::bigint,repeat('a',64),'{"1":2}','{}','{}',120,false);
        raise exception 'closed assignment accepted';
    exception when raise_exception then if sqlerrm <> 'attempt session exam unavailable' then raise; end if; end;
    begin
        update public.omr_class_students set enrollment_status='inactive' where class_id='continuation-class' and student_profile_id='continuation-student';
        perform public.omr_checkpoint_attempt_session_v2(c.exam||'-session',c.org,c.exam,'continuation-student',c.assn,c.gen,
            (c.opened->>'revision')::bigint,(c.opened->>'lease_epoch')::bigint,repeat('a',64),'{"1":2}','{}','{}',120,false);
        raise exception 'inactive roster accepted';
    exception when raise_exception then if sqlerrm <> 'targeted assignment roster inactive' then raise; end if; end;
end $$;

-- Shorten only this disposable pilot's grant, then let the database clock
-- pass its expiry. Existing session completion and new admission must diverge.
update public.omr_pilot_plan_grants set expires_at=clock_timestamp()+interval '400 milliseconds'
 where organization_id=(select min(org) from retake_case);
select pg_sleep(greatest(0,extract(epoch from (g.expires_at-clock_timestamp())))+0.05)
 from public.omr_pilot_plan_grants g where g.organization_id=(select min(org) from retake_case);
do $$
declare c retake_case%rowtype;
begin
    select * into strict c from retake_case where assn is null;
    if public.omr_read_effective_organization_plan_v1(c.org)->>'plan' is distinct from 'free'
        then raise exception 'pilot did not expire'; end if;
    begin
        perform public.omr_open_attempt_session_v3(c.exam||'-new',c.org,c.exam,c.assn,c.gen,'continuation-student',
            'Synthetic student','registered','new-submission','new-attempt',c.exam||'-base','wrong',array[1],array[1],
            (select updated_at from public.omr_exams where id=c.exam),'{}',600,null,repeat('b',64),null,120);
        raise exception 'expired grant admitted new retake';
    exception when raise_exception then if sqlerrm <> 'effective plan denies retake session' then raise; end if; end;
end $$;
update retake_case c set saved=public.omr_checkpoint_attempt_session_v2(
    c.exam||'-session',c.org,c.exam,'continuation-student',c.assn,c.gen,(c.opened->>'revision')::bigint,
    (c.opened->>'lease_epoch')::bigint,repeat('a',64),'{"1":2}','{}','{}',120,true);
update retake_case c set prepared=public.omr_prepare_attempt_session_submit_v2(
    c.exam||'-session',c.org,c.exam,'continuation-student',c.assn,c.gen,(c.saved->>'revision')::bigint,
    (c.saved->>'lease_epoch')::bigint,repeat('a',64));

-- The grading gateway normally supplies these canonical rows.
do $$
declare c retake_case%rowtype; q jsonb; payload jsonb; row jsonb; score_row jsonb; t timestamptz:=now();
begin
    for c in select * from retake_case loop
        if c.saved->'answers' is distinct from '{"1":2}'::jsonb or
           c.prepared->'answers' is distinct from c.saved->'answers' then raise exception 'checkpoint lost answers'; end if;
        q := jsonb_build_object('schemaVersion',1,'attemptId',c.exam||'-retry','examId',c.exam,'examTitle',c.exam,
            'organizationId',c.org,'classId','continuation-class','assignmentId',c.assn,'assignmentRevision',c.gen,
            'studentName','Synthetic student','studentId','continuation-student','identityType','registered',
            'questionId',1,'questionNumber',1,'canonicalQuestionId',c.exam||':1','label','Q1',
            'selectedAnswer',2,'correctAnswer',2,'status','correct','isCorrect',true,'isWrong',false,
            'isUnanswered',false,'score',1,'earnedScore',1,'finishedAt',t);
        payload := jsonb_build_object('id',c.exam||'-retry','examId',c.exam,'examTitle',c.exam,'organizationId',c.org,
            'assignmentId',c.assn,'assignmentRevision',c.gen,'studentId','continuation-student',
            'studentName','Synthetic student','identityType','registered','status','completed','score',1,'totalScore',1,
            'startedAt',t,'finishedAt',t,'answers',c.saved->'answers','questionResults',jsonb_build_array(q));
        row := jsonb_build_object('id',c.exam||'-retry','organization_id',c.org,'exam_id',c.exam,
            'assignment_id',c.assn,'assignment_revision',c.gen,'student_id','continuation-student',
            'student_name','Synthetic student','identity_type','registered','status','completed','score',1,
            'total_score',1,'score_percent',100,'retake_source_attempt_id',c.exam||'-base','retake_mode','wrong',
            'retake_question_ids',array[1],'started_at',t,'finished_at',t,'payload',payload);
        score_row := jsonb_build_object('id',c.exam||'-result','organization_id',c.org,'exam_id',c.exam,
            'class_id','continuation-class','assignment_id',c.assn,'assignment_revision',c.gen,'attempt_id',c.exam||'-retry',
            'student_id','continuation-student','student_name','Synthetic student','identity_type','registered',
            'question_id',1,'question_number',1,'canonical_question_id',c.exam||':1','label','Q1','status','correct',
            'is_correct',true,'is_wrong',false,'is_unanswered',false,'selected_answer',2,'correct_answer',2,
            'mistake_types',array[]::text[],'prerequisites',array[]::text[],
            'score',1,'earned_score',1,'finished_at',t,'created_at',t,'updated_at',t,'payload',q);
        update retake_case set attempt=row,results=jsonb_build_array(score_row) where exam=c.exam;
    end loop;
end $$;

update retake_case c set receipt=public.omr_commit_attempt_session_submit_v2(
    c.exam||'-session',c.org,c.exam,'continuation-student',c.assn,c.gen,(c.saved->>'revision')::bigint,
    (c.saved->>'lease_epoch')::bigint,repeat('a',64),c.attempt,c.results);
do $$
declare c retake_case%rowtype; replay jsonb;
begin
    for c in select * from retake_case loop
        replay := public.omr_commit_attempt_session_submit_v2(c.exam||'-session',c.org,c.exam,'continuation-student',
            c.assn,c.gen,(c.saved->>'revision')::bigint,(c.saved->>'lease_epoch')::bigint,repeat('a',64),c.attempt,c.results);
        if c.receipt->>'result_status' is distinct from 'submitted' or replay->'payload' is distinct from c.receipt->'payload'
           or (select count(*) from public.omr_attempts a where a.exam_id=c.exam) <> 2
           or (select to_jsonb(a) from public.omr_attempts a where a.id=c.exam||'-base') is distinct from c.base_record
           or (select jsonb_agg(to_jsonb(q) order by q.question_id) from public.omr_question_results q where q.attempt_id=c.exam||'-base') is distinct from c.base_results
           or not exists (select 1 from public.omr_attempts a where a.id=c.exam||'-retry' and a.score=1 and a.retake_source_attempt_id=c.exam||'-base')
        then raise exception 'retake receipt or original changed for %',c.exam; end if;
    end loop;
end $$;
