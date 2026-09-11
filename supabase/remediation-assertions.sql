\set ON_ERROR_STOP on
begin;

insert into public.omr_organizations(id,name,plan) values ('teacher_remediation','Remediation QA','pro');
insert into public.omr_teacher_accounts(id,email,display_name,password_hash,status,email_verified_at,session_generation)
values ('teacher_1234567890abcdef','remediation@example.test','Teacher','pbkdf2-sha256:120000:0123456789abcdef0123456789abcdef:'||repeat('a',64),'active',now(),1);
insert into public.omr_organization_members(organization_id,user_id,email,display_name,role,status)
values ('teacher_remediation','teacher_1234567890abcdef','remediation@example.test','Teacher','teacher','active');
insert into public.omr_teacher_profiles(organization_id,user_id,display_name,status)
values ('teacher_remediation','teacher_1234567890abcdef','Teacher','active');
insert into public.omr_classes(id,organization_id,name) values ('rm-class','teacher_remediation','A반'),('rm-other-class','teacher_remediation','B반');
insert into public.omr_class_teachers(class_id,organization_id,teacher_user_id,class_role)
values ('rm-class','teacher_remediation','teacher_1234567890abcdef','lead');
insert into public.omr_student_profiles(id,organization_id,display_name,status) values ('rm-student','teacher_remediation','학생','active');
insert into public.omr_class_students(class_id,organization_id,student_profile_id)
values ('rm-class','teacher_remediation','rm-student'),('rm-other-class','teacher_remediation','rm-student');
insert into public.omr_exams(id,organization_id,title,payload,created_at,updated_at)
values ('rm-exam','teacher_remediation','수학','{"id":"rm-exam","title":"수학","accessConfig":{"type":"public"},"questions":[]}',now(),now());
insert into public.omr_assignments(id,organization_id,exam_id,class_id,title,access_mode,status)
values ('rm-assignment','teacher_remediation','rm-exam','rm-class','수학','targeted','open');
insert into public.omr_assignment_targets(id,assignment_id,organization_id,target_type,target_id,student_profile_id)
values ('rm-target','rm-assignment','teacher_remediation','student','rm-student','rm-student');

-- Use the production canonical writer; do not disable evidence/immutability triggers.
create function pg_temp.rm_attempt(token text,source_id text,correct boolean,finished timestamptz,class_id text default 'rm-class',question_count integer default 2)
returns void language plpgsql as $$
declare rows jsonb; database_rows jsonb; payload jsonb; parent jsonb; attempt_id text:='attempt_'||token;
begin
    set constraints all deferred;
    select jsonb_agg(j order by q),jsonb_agg(jsonb_build_object(
        'id',attempt_id||':'||q,'organization_id','teacher_remediation','attempt_id',attempt_id,'class_id',class_id,
        'exam_id','rm-exam','assignment_id','rm-assignment','assignment_revision',1,'student_name','학생','student_id','rm-student','student_profile_id','rm-student','identity_type','registered',
        'question_id',q,'question_number',q,'canonical_question_id','rm-exam:'||q,'label','Q'||q,
        'mistake_types','[]'::jsonb,'prerequisites','[]'::jsonb,'selected_answer',case when correct then 1 else 2 end,
        'correct_answer',1,'status',case when correct then 'correct' else 'wrong' end,'is_correct',correct,'is_wrong',not correct,
        'is_unanswered',false,'score',1,'earned_score',case when correct then 1 else 0 end,
        'finished_at',finished,'payload',j,'created_at',finished,'updated_at',finished) order by q)
    into rows,database_rows from (select q,jsonb_build_object(
        'schemaVersion',1,'attemptId',attempt_id,'examId','rm-exam','examTitle','수학','organizationId','teacher_remediation','classId',class_id,'assignmentId','rm-assignment','assignmentRevision',1,
        'studentProfileId','rm-student','studentName','학생','studentId','rm-student','identityType','registered',
        'questionId',q,'questionNumber',q,'canonicalQuestionId','rm-exam:'||q,'label','Q'||q,
        'score',1,'earnedScore',case when correct then 1 else 0 end,'selectedAnswer',case when correct then 1 else 2 end,'correctAnswer',1,
        'status',case when correct then 'correct' else 'wrong' end,'isCorrect',correct,'isWrong',not correct,'isUnanswered',false,
        'mistakeTypes','[]'::jsonb,'prerequisites','[]'::jsonb,'finishedAt',finished) j from generate_series(1,question_count) q) data;
    payload:=jsonb_build_object('id',attempt_id,'examId','rm-exam','examTitle','수학','organizationId','teacher_remediation',
        'classId',class_id,'assignmentId','rm-assignment','assignmentRevision',1,'studentProfileId','rm-student','studentId','rm-student','studentName','학생','identityType','registered',
        'status','completed','startedAt',finished-interval '5 minutes','finishedAt',finished,'questionResults',rows,
        'score',case when correct then question_count else 0 end,'totalScore',question_count);
    parent:=jsonb_build_object('id',attempt_id,'organization_id','teacher_remediation','class_id',class_id,'student_profile_id','rm-student',
        'exam_id','rm-exam','assignment_id','rm-assignment','assignment_revision',1,'student_name','학생','student_id','rm-student','identity_type','registered','status','completed',
        'score',case when correct then question_count else 0 end,'total_score',question_count,'score_percent',case when correct then 100 else 0 end,
        'retake_source_attempt_id',source_id,'retake_mode',case when source_id is not null then 'wrong' else null end,
        'retake_question_ids',case when source_id is null then '[]'::jsonb else (select jsonb_agg(q) from generate_series(1,question_count) q) end,
        'payload',payload,'started_at',finished-interval '5 minutes','finished_at',finished);
        perform public.omr_set_effective_plan_transaction_proof_v1('teacher_remediation',
            public.omr_read_teacher_mutation_plan_v1('legacy_account','teacher_1234567890abcdef','teacher_remediation','teacher_1234567890abcdef'));
        if source_id is not null then
            update public.omr_assignment_targets set retake_source_attempt_id=source_id,retake_question_ids=array[1,2] where id='rm-target';
        end if;
        insert into public.omr_attempt_sessions(id,organization_id,exam_id,assignment_id,assignment_revision,owner_student_id,student_name,identity_type,
            scope_key,submission_id,attempt_id,retake_source_attempt_id,retake_mode,allowed_question_ids,grading_snapshot,
            started_at,deadline_at,last_heartbeat_at,lease_token_hash,lease_expires_at)
        values(token,'teacher_remediation','rm-exam','rm-assignment',1,'rm-student','학생','registered',
            token,token,attempt_id,source_id,case when source_id is null then null else 'wrong' end,(select array_agg(q) from generate_series(1,question_count) q),'{}',
            finished-interval '5 minutes',finished+interval '1 hour',finished,repeat('a',64),finished+interval '1 hour');
    perform public.omr_submit_attempt_v1(token,parent,database_rows);
    set constraints all immediate;
    if not public.omr_canonical_attempt_child_evidence_matches_v1(attempt_id) then raise exception 'invalid fixture evidence'; end if;
end;
$$;
select pg_temp.rm_attempt('rm-source',null,false,now()-interval '3 days');
select pg_temp.rm_attempt('rm-other',null,false,now()-interval '3 days','rm-other-class');
select pg_temp.rm_attempt('rm-extra',null,false,now()-interval '3 days');
set constraints all immediate;

do $$
declare
    org constant text:='teacher_remediation'; actor constant text:='teacher_1234567890abcdef';
    result jsonb; item public.omr_remediation_cases%rowtype; view jsonb; command jsonb; previous_key text;
begin
    command:=jsonb_build_object('op','assign','sourceAttemptIds',jsonb_build_array('attempt_rm-source'),'dueAt',now()+interval '1 day');
    result:=public.omr_manage_remediation_v1('legacy_account',actor,99,org,actor,command);
    if result->>'status'<>'unauthorized' then raise exception 'stale session admitted'; end if;
    result:=public.omr_manage_remediation_v1('legacy_account',actor,1,org,actor,'{"op":"load"}');
    if result->>'status'<>'loaded' or jsonb_array_length(result#>'{dashboard,candidates}')<>2 then raise exception 'class scoped candidates failed: %',result; end if;
    result:=public.omr_manage_remediation_v1('legacy_account',actor,1,org,actor,command);
    if result->>'status'<>'saved' then raise exception 'assignment failed: %',result; end if;
    perform public.omr_manage_remediation_v1('legacy_account',actor,1,org,actor,command||jsonb_build_object('dueAt',now()+interval '2 days'));
    if (select count(*) from public.omr_audit_logs where organization_id=org)<>1
       or (select due_at from public.omr_remediation_cases where source_attempt_id='attempt_rm-source')<>now()+interval '1 day' then raise exception 'duplicate assignment changed history or deadline'; end if;
    result:=public.omr_manage_remediation_v1('legacy_account',actor,1,org,actor,command||'{"sourceAttemptIds":["attempt_rm-extra","attempt_rm-other"]}');
    if result->>'status'<>'unauthorized' or exists(select 1 from public.omr_remediation_cases where source_attempt_id='attempt_rm-extra') then raise exception 'mixed-scope batch was not atomic'; end if;
    if public.omr_manage_remediation_v1('legacy_account',actor,1,org,actor,command||'{"sourceAttemptIds":[]}')->>'status'<>'invalid_request' then raise exception 'empty batch admitted'; end if;
    select * into item from public.omr_remediation_cases where source_attempt_id='attempt_rm-source';
    view:=public.omr_remediation_case_view_v1(item,actor,'teacher');
    command:=jsonb_build_object('op','confirm','sourceAttemptId',item.source_attempt_id,'expectedRevision',1,'evidenceKey',view->>'evidenceKey','note','풀이 설명을 직접 확인함');
    if public.omr_manage_remediation_v1('legacy_account',actor,1,org,actor,command)->>'status'<>'not_ready' then raise exception 'uncorrected case confirmed'; end if;
    update public.omr_remediation_cases set due_at=now()-interval '1 hour' where source_attempt_id=item.source_attempt_id returning * into item;
    if public.omr_remediation_case_view_v1(item,actor,'teacher')->>'state'<>'overdue' then raise exception 'overdue not surfaced'; end if;
    perform pg_temp.rm_attempt('rm-correct',item.source_attempt_id,true,now()-interval '1 day');
    view:=public.omr_remediation_case_view_v1(item,actor,'teacher');
    if view->>'state'<>'awaiting_review' then raise exception 'correct answers auto-completed or missing: %',view; end if;
    if public.omr_manage_remediation_v1('legacy_account',actor,1,org,actor,command)->>'status'<>'conflict' then raise exception 'stale evidence accepted'; end if;
    command:=command||jsonb_build_object('evidenceKey',view->>'evidenceKey'); previous_key:=view->>'evidenceKey';
    if public.omr_manage_remediation_v1('legacy_account',actor,1,org,actor,command)->>'status'<>'saved' then raise exception 'confirmation failed'; end if;
    if public.omr_manage_remediation_v1('legacy_account',actor,1,org,actor,command)->>'status'<>'conflict' then raise exception 'stale revision accepted'; end if;
    select * into item from public.omr_remediation_cases where source_attempt_id=item.source_attempt_id;
    if public.omr_remediation_case_view_v1(item,actor,'teacher')->>'state'<>'confirmed' then raise exception 'confirmation not visible'; end if;
    perform pg_temp.rm_attempt('rm-regression',item.source_attempt_id,false,now());
    view:=public.omr_remediation_case_view_v1(item,actor,'teacher');
    if view->>'state'<>'recheck' or view->>'correctedCount'<>'0' or view->>'evidenceKey'=previous_key then raise exception 'latest per-question regression hidden: %',view; end if;
    command:=command||jsonb_build_object('op','pause','expectedRevision',item.revision,'evidenceKey',view->>'evidenceKey','note','다음 수업에서 확인 예정');
    if public.omr_manage_remediation_v1('legacy_account',actor,1,org,actor,command)->>'status'<>'saved' then raise exception 'pause failed'; end if;
    command:=command||jsonb_build_object('op','resume','expectedRevision',item.revision+1,'note','');
    if public.omr_manage_remediation_v1('legacy_account',actor,1,org,actor,command)->>'status'<>'saved' then raise exception 'resume failed'; end if;
    result:=public.omr_student_remediation_v1(org,'rm-student');
    if jsonb_array_length(result)<>1 or (result->0) ? 'note' or (result->0) ? 'evidenceKey' then raise exception 'student DTO boundary failed'; end if;
    if public.omr_student_remediation_v1(org,'other')<>'[]'::jsonb or public.omr_student_remediation_v1('other','rm-student')<>'[]'::jsonb then raise exception 'student isolation failed'; end if;
    update public.omr_class_students set enrollment_status='transferred' where class_id='rm-class';
    select * into item from public.omr_remediation_cases where source_attempt_id='attempt_rm-source';
    view:=public.omr_remediation_case_view_v1(item,actor,'teacher');
    if view->>'state'<>'handoff' or view->>'canManage'<>'false' then raise exception 'transfer silently completed'; end if;
    update public.omr_class_students set enrollment_status='active' where class_id='rm-class';
    delete from public.omr_class_teachers where class_id='rm-class';
    result:=public.omr_manage_remediation_v1('legacy_account',actor,1,org,actor,'{"op":"load"}');
    if jsonb_array_length(result#>'{dashboard,cases}')<>0 then raise exception 'revoked class remained visible'; end if;
    if public.omr_manage_remediation_v1('legacy_account',actor,1,org,actor,command)->>'status'<>'unauthorized' then raise exception 'revoked class mutation accepted'; end if;
    update public.omr_organization_members set role='admin' where organization_id=org;
    update public.omr_organizations set plan='free' where id=org;
    if public.omr_manage_remediation_v1('legacy_account',actor,1,org,actor,command)->>'status'<>'plan_denied' then raise exception 'free plan mutation accepted'; end if;
    if public.omr_manage_remediation_v1('legacy_account',actor,1,org,actor,'{"op":"load"}')->>'status'<>'loaded' then raise exception 'downgrade lost history'; end if;
end;
$$;

do $$
declare role_name text; routine text;
begin
    foreach role_name in array array['anon','authenticated'] loop
        if has_table_privilege(role_name,'public.omr_remediation_cases','select,insert,update,delete') then raise exception 'browser table privilege leaked'; end if;
        foreach routine in array array['omr_manage_remediation_v1(text,text,bigint,text,text,jsonb)','omr_student_remediation_v1(text,text)',
            'omr_remediation_progress_v1(text)','omr_remediation_allowed_v1(text,text,text,text,boolean)','omr_remediation_case_view_v1(public.omr_remediation_cases,text,text)'] loop
            if has_function_privilege(role_name,'public.'||routine,'execute') then raise exception 'browser RPC privilege leaked'; end if;
        end loop;
    end loop;
    if has_table_privilege('service_role','public.omr_remediation_cases','insert,update,delete,truncate') then raise exception 'direct mutation bypass'; end if;
    if has_function_privilege('service_role','public.omr_remediation_progress_v1(text)','execute') then raise exception 'internal RPC bypass'; end if;
end;
$$;
rollback;
