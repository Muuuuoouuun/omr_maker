\set ON_ERROR_STOP on
begin;

insert into public.omr_organizations(id,name,plan) values
('pilot_org_123456789012345678901234','Reminder QA','free'), ('reminder-foreign','Foreign','free');
insert into public.omr_teacher_accounts(id,email,display_name,password_hash,status,email_verified_at,session_generation)
values ('teacher_1234567890123456','reminder@example.test','Teacher','pbkdf2-sha256:120000:0123456789abcdef0123456789abcdef:' || repeat('a',64),'active',now(),1);
insert into public.omr_organization_members(organization_id,user_id,email,display_name,role,status)
values ('pilot_org_123456789012345678901234','teacher_1234567890123456','reminder@example.test','Teacher','owner','active');
insert into public.omr_teacher_profiles(organization_id,user_id,display_name,status)
values ('pilot_org_123456789012345678901234','teacher_1234567890123456','Teacher','active');
insert into public.omr_pilot_plan_grants(id,idempotency_key_hash,request_hash,organization_id,account_id,plan,expires_at,state)
values ('pilot_grant_123456789012345678901234',repeat('9',64),repeat('8',64),'pilot_org_123456789012345678901234','teacher_1234567890123456','pro',now()+interval '1 day','active');
insert into public.omr_classes(id,organization_id,name) values ('reminder-class','pilot_org_123456789012345678901234','A반');
insert into public.omr_student_profiles(id,organization_id,display_name) values
('reminder-due','pilot_org_123456789012345678901234','미제출'),
('reminder-submitted','pilot_org_123456789012345678901234','제출'),
('reminder-disabled','pilot_org_123456789012345678901234','수신 중지'),
('reminder-foreign-student','reminder-foreign','다른 교실');
insert into public.omr_class_students(class_id,organization_id,student_profile_id)
select 'reminder-class',organization_id,id from public.omr_student_profiles where id in ('reminder-due','reminder-submitted','reminder-disabled');
insert into public.omr_reminder_contacts(organization_id,student_profile_id,phone,enabled)
select organization_id,id,'01012345678',id <> 'reminder-disabled' from public.omr_student_profiles where id like 'reminder-%';
insert into public.omr_exams(id,organization_id,title,payload,created_at,updated_at)
values ('reminder-exam','pilot_org_123456789012345678901234','수학',jsonb_build_object(
    'id','reminder-exam','startAt',to_char(now()-interval '1 day','YYYY-MM-DD"T"HH24:MI:SS.USOF'),
    'endAt',to_char(now()+interval '30 minutes','YYYY-MM-DD"T"HH24:MI:SS.USOF'),
    'accessConfig',jsonb_build_object('type','group','groupIds',jsonb_build_array('reminder-class'))),now(),now());
insert into public.omr_attempts(id,organization_id,exam_id,student_profile_id,student_id,student_name,status,payload,started_at,finished_at)
values ('reminder-completed','pilot_org_123456789012345678901234','reminder-exam','reminder-submitted','reminder-submitted','제출','completed','{}',now()-interval '1 hour',now());

do $$
declare
    org constant text := 'pilot_org_123456789012345678901234';
    teacher constant text := 'teacher_1234567890123456';
    settings jsonb := '{"op":"save_settings","settings":{"examId":"reminder-exam","enabled":true,"channel":"kakao","beforeMinutes":60,"overdueMinutes":60,"quietStart":0,"quietEnd":0}}';
    result jsonb; job jsonb; n integer; v_assignment_id text;
begin
    result := public.omr_manage_reminders_v1('account',teacher,99,org,teacher,settings);
    if result ->> 'status' <> 'unauthorized' then raise exception 'stale session accepted'; end if;
    result := public.omr_manage_reminders_v1('account',teacher,1,'reminder-foreign',teacher,settings);
    if result ->> 'status' <> 'unauthorized' then raise exception 'foreign workspace accepted'; end if;
    result := public.omr_manage_reminders_v1('account',teacher,1,org,teacher,settings);
    if result ->> 'status' <> 'saved' then raise exception 'settings save failed: %',result; end if;
    result := public.omr_manage_reminders_v1('account',teacher,1,org,teacher,'{"op":"save_contact","studentId":"reminder-foreign-student","phone":"01011112222","enabled":true}');
    if result ->> 'status' <> 'invalid_request' then raise exception 'cross-org contact accepted'; end if;
    result := public.omr_manage_reminders_v1('account',teacher,1,org,teacher,'{"op":"load"}');
    if result ->> 'status' <> 'loaded' or jsonb_array_length(result #> '{dashboard,contacts}') <> 3 then raise exception 'dashboard isolation failed: %',result; end if;
    result := public.omr_manage_reminders_v1('account',teacher,1,org,teacher,'{"op":"preview","examId":"reminder-exam"}');
    if (result ->> 'total')::int <> 2 then raise exception 'preview must include two events for only the missing enabled student: %',result; end if;
    select count(*) into n from public.omr_reminder_candidates_v1(org,null,true);
    if n <> 1 then raise exception 'due filtering failed: %',n; end if;
    job := public.omr_claim_reminder_v1(org,'dry_run',array['kakao']);
    if job #>> '{candidate,studentId}' <> 'reminder-due' then raise exception 'wrong reminder target: %',job; end if;
    if public.omr_claim_reminder_v1(org,'dry_run',array['kakao']) is not null then raise exception 'duplicate preview claimed'; end if;
    job := public.omr_claim_reminder_v1(org,'live',array['kakao']);
    if job is null then raise exception 'dry-run incorrectly consumed live reminder'; end if;
    if not public.omr_finish_reminder_v1(org,(job ->> 'id')::uuid,'accepted','Gtest',null) then raise exception 'finish rejected'; end if;
    if public.omr_finish_reminder_v1(org,(job ->> 'id')::uuid,'failed',null,'override') then raise exception 'terminal status overwritten'; end if;
    if public.omr_claim_reminder_v1(org,'live',array['kakao']) is not null then raise exception 'duplicate live send claimed'; end if;

    insert into public.omr_exams(id,organization_id,title,payload,created_at,updated_at)
    select 'reminder-targeted',org,'개별 과제',payload || '{"id":"reminder-targeted"}'::jsonb,now(),now()
    from public.omr_exams where id='reminder-exam';
    result := public.omr_assign_students_v2('account',teacher,1,org,teacher,'owner',
        'reminder-targeted',array['reminder-due'],'base',0,'reminder-targeted-create');
    if result ->> 'status' <> 'saved' then raise exception 'target assignment fixture failed: %',result; end if;
    v_assignment_id := result ->> 'assignmentId';
    update public.omr_assignments a set due_at=now()+interval '15 minutes' where a.id=v_assignment_id;
    result := public.omr_manage_reminders_v1('account',teacher,1,org,teacher,
        jsonb_set(jsonb_set(settings,'{settings,examId}','"reminder-targeted"'),'{settings,channel}','"sms"'));
    if result ->> 'status' <> 'saved' then raise exception 'targeted settings failed: %',result; end if;
    select count(*) into n from public.omr_reminder_candidates_v1(org,'reminder-targeted',true)
    where candidate ->> 'studentId'='reminder-due' and candidate ->> 'assignmentId'=v_assignment_id
      and (candidate ->> 'assignmentRevision')::int=1 and (candidate ->> 'deadline')::timestamptz=now()+interval '15 minutes';
    if n <> 1 then raise exception 'targeted recipient, version or assignment deadline mismatch'; end if;
    update public.omr_assignment_targets t set status='paused' where t.assignment_id=v_assignment_id;
    if exists(select 1 from public.omr_reminder_candidates_v1(org,'reminder-targeted',true)) then raise exception 'paused assignment target included'; end if;
    update public.omr_reminder_settings set enabled=false where exam_id='reminder-targeted';

    -- A changed deadline forms a new event, then authoritative state changes suppress it.
    update public.omr_exams set payload = jsonb_set(payload,'{endAt}',to_jsonb(to_char(now()+interval '25 minutes','YYYY-MM-DD"T"HH24:MI:SS.USOF'))) where id='reminder-exam';
    update public.omr_reminder_settings set quiet_start=extract(hour from now() at time zone 'Asia/Seoul')::int,
        quiet_end=(extract(hour from now() at time zone 'Asia/Seoul')::int+1)%24 where exam_id='reminder-exam';
    if public.omr_claim_reminder_v1(org,'live',array['kakao']) is not null then raise exception 'quiet hours ignored'; end if;
    update public.omr_reminder_settings set quiet_start=0,quiet_end=0 where exam_id='reminder-exam';
    update public.omr_reminder_contacts set enabled=false where student_profile_id='reminder-due';
    if public.omr_claim_reminder_v1(org,'live',array['kakao']) is not null then raise exception 'opt-out ignored'; end if;
    update public.omr_reminder_contacts set enabled=true where student_profile_id='reminder-due';
    update public.omr_teacher_accounts set session_generation=2 where id=teacher;
    if public.omr_claim_reminder_v1(org,'live',array['kakao']) is not null then raise exception 'revoked session sent'; end if;
    update public.omr_teacher_accounts set session_generation=1 where id=teacher;
    update public.omr_reminder_settings set enabled=true where exam_id='reminder-exam';
    update public.omr_pilot_plan_grants set state='superseded',superseded_at=clock_timestamp() where account_id=teacher;
    if public.omr_claim_reminder_v1(org,'live',array['kakao']) is not null then raise exception 'expired entitlement sent'; end if;
    result := public.omr_manage_reminders_v1('account',teacher,1,org,teacher,settings);
    if result ->> 'status' <> 'plan_denied' then raise exception 'free plan enabled reminder'; end if;
    result := public.omr_manage_reminders_v1('account',teacher,1,org,teacher,jsonb_set(settings,'{settings,enabled}','false'));
    if result ->> 'status' <> 'saved' then raise exception 'free plan cannot stop reminders'; end if;

    update public.omr_reminder_settings set enabled=true where exam_id='reminder-exam';
    update public.omr_exams set payload=jsonb_set(payload,'{endAt}',to_jsonb(to_char(now()-interval '2 hours','YYYY-MM-DD"T"HH24:MI:SS.USOF'))) where id='reminder-exam';
    select count(*) into n from public.omr_reminder_candidates_v1(org,null,true) where candidate ->> 'kind'='overdue';
    if n <> 1 then raise exception 'overdue reminder missing'; end if;
    select count(*) into n from public.omr_reminder_candidates_v1(org,null,true) where candidate ->> 'kind'='before_deadline';
    if n <> 0 then raise exception 'expired pre-deadline reminder leaked'; end if;
    update public.omr_exams set payload=jsonb_set(payload,'{endAt}',to_jsonb(to_char(now()-interval '3 days','YYYY-MM-DD"T"HH24:MI:SS.USOF'))) where id='reminder-exam';
    if exists(select 1 from public.omr_reminder_candidates_v1(org,null,true)) then raise exception 'stale overdue reminders sent'; end if;
    update public.omr_exams set payload=jsonb_set(payload,'{endAt}','"invalid-date"') where id='reminder-exam';
    if exists(select 1 from public.omr_reminder_candidates_v1(org,null,false)) then raise exception 'invalid date accepted'; end if;
end;
$$;

do $$
declare role_name text; table_name text; routine text;
begin
    foreach role_name in array array['anon','authenticated'] loop
        foreach table_name in array array['omr_reminder_contacts','omr_reminder_settings','omr_reminder_deliveries'] loop
            if has_table_privilege(role_name,'public.'||table_name,'select,insert,update,delete') then raise exception 'browser table privilege leaked'; end if;
        end loop;
        foreach routine in array array['omr_manage_reminders_v1(text,text,bigint,text,text,jsonb)','omr_claim_reminder_v1(text,text,text[])','omr_reminder_candidates_v1(text,text,boolean)','omr_finish_reminder_v1(text,uuid,text,text,text)'] loop
            if has_function_privilege(role_name,'public.'||routine,'execute') then raise exception 'browser RPC privilege leaked'; end if;
        end loop;
    end loop;
end;
$$;
rollback;
